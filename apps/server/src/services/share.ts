import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { FuzzLevel } from '@flil/shared';
import { getDb, newId, nowIso } from '../db.js';
import { config } from '../config.js';
import { errors } from '../http/errors.js';
import { assertShareFuzzLevel, isShareFuzzLevelAllowed } from './fuzzing.js';

export interface ShareLinkRow {
  id: string;
  library_id: string;
  scope: 'album' | 'inspiration';
  scope_id: string;
  token: string;
  fuzz_level: FuzzLevel;
  password_hash: string | null;
  expires_at: string;
  revoked_at: string | null;
  created_by: string;
  view_count: number;
  created_at: string;
}

/**
 * 归属校验：分享目标必须真实存在、未删除且属于本库。
 * 不做这层检查，调用方就能"用本库身份给别库资源发令牌"，公开页随后按 link.library_id
 * 取数，形成跨库越权读取。对调用方统一返回 404，避免泄露他库资源是否存在。
 */
export function assertShareScopeOwned(
  scope: 'album' | 'inspiration',
  scopeId: string,
  libraryId: string,
): void {
  const db = getDb();
  if (scope === 'album') {
    const row = db
      .prepare('SELECT library_id FROM album WHERE id = ? AND deleted_at IS NULL')
      .get(scopeId) as { library_id: string } | undefined;
    if (!row || row.library_id !== libraryId) throw errors.notFound('画册');
  } else {
    const row = db
      .prepare('SELECT library_id FROM inspiration WHERE id = ? AND deleted_at IS NULL')
      .get(scopeId) as { library_id: string } | undefined;
    if (!row || row.library_id !== libraryId) throw errors.notFound('灵感卡');
  }
}

/**
 * 公开访问侧的归属校验：分享范围必须仍属于链接所在库。
 * 这是纵深防御——即使历史上已存在跨库的 share_link（修复前写入的数据），
 * 公开页也不能把它当作合法链接吐出内容。资源不存在返回 404，存在但不属本库返回 403。
 */
export function assertShareScopeMatchesLink(link: ShareLinkRow): void {
  const db = getDb();
  const table = link.scope === 'album' ? 'album' : 'inspiration';
  const row = db
    .prepare(`SELECT library_id FROM ${table} WHERE id = ? AND deleted_at IS NULL`)
    .get(link.scope_id) as { library_id: string } | undefined;
  if (!row) throw errors.notFound('分享链接');
  if (row.library_id !== link.library_id) throw errors.scopeDenied();
}

export function createShareLink(params: {
  libraryId: string;
  scope: 'album' | 'inspiration';
  scopeId: string;
  fuzzLevel: FuzzLevel;
  expiresInDays: number;
  password?: string | null;
  userId: string;
}): ShareLinkRow {
  if (!config.enableShare) throw errors.badRequest('分享功能已被服务端关闭（ENABLE_SHARE=false）');

  // 创建链路归属校验：禁止用本库身份为他库画册/灵感卡创建分享
  assertShareScopeOwned(params.scope, params.scopeId, params.libraryId);

  // 安全底线：exact / g100 一律强制降级为 g500（不抛错，避免"手填就绕过"）
  const level = assertShareFuzzLevel(params.fuzzLevel);
  const days = Math.min(Math.max(1, params.expiresInDays), config.shareMaxExpireDays);
  const token = crypto.randomBytes(24).toString('base64url');

  const id = newId();
  getDb()
    .prepare(
      `INSERT INTO share_link (id, library_id, scope, scope_id, token, fuzz_level, password_hash,
         expires_at, created_by, view_count, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,0,?)`,
    )
    .run(
      id,
      params.libraryId,
      params.scope,
      params.scopeId,
      token,
      level,
      params.password ? bcrypt.hashSync(params.password, 10) : null,
      new Date(Date.now() + days * 86400000).toISOString(),
      params.userId,
      nowIso(),
    );

  return getDb().prepare('SELECT * FROM share_link WHERE id = ?').get(id) as ShareLinkRow;
}

/** 校验分享令牌：撤销、过期、密码三者都必须校验（文档 13.4） */
export function validateShareToken(token: string, password?: string | null): ShareLinkRow {
  const row = getDb().prepare('SELECT * FROM share_link WHERE token = ?').get(token) as ShareLinkRow | undefined;
  if (!row) throw errors.notFound('分享链接');

  if (row.revoked_at) {
    logAccess(row.id, false, 'revoked');
    throw errors.shareRevoked();
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    logAccess(row.id, false, 'expired');
    throw errors.shareExpired();
  }
  if (row.password_hash) {
    if (!password) {
      logAccess(row.id, false, 'password_required');
      throw errors.sharePasswordRequired();
    }
    if (!bcrypt.compareSync(password, row.password_hash)) {
      logAccess(row.id, false, 'password_wrong');
      throw errors.sharePasswordRequired();
    }
  }
  return row;
}

export function logAccess(shareLinkId: string, allowed: boolean, denyReason?: string): void {
  try {
    const db = getDb();
    db.prepare(
      'INSERT INTO share_access_log (id, share_link_id, ip_hash, user_agent, path, allowed, deny_reason, at) VALUES (?,?,?,?,?,?,?,?)',
    ).run(newId(), shareLinkId, null, null, null, allowed ? 1 : 0, denyReason ?? null, nowIso());
    if (allowed) db.prepare('UPDATE share_link SET view_count = view_count + 1 WHERE id = ?').run(shareLinkId);
  } catch {
    /* 审计失败不影响主流程 */
  }
}

/** 撤销即时生效：接口层每次都会重新读 revoked_at（不接受缓存兜底） */
export function revokeShareLink(id: string, libraryId: string): void {
  const res = getDb()
    .prepare('UPDATE share_link SET revoked_at = ? WHERE id = ? AND library_id = ? AND revoked_at IS NULL')
    .run(nowIso(), id, libraryId);
  if (res.changes === 0) throw errors.notFound('分享链接（可能已被撤销）');
}

export function listShareLinks(libraryId: string): ShareLinkRow[] {
  return getDb()
    .prepare('SELECT * FROM share_link WHERE library_id = ? ORDER BY created_at DESC')
    .all(libraryId) as ShareLinkRow[];
}

export function shareStatus(link: ShareLinkRow): 'active' | 'expired' | 'revoked' {
  if (link.revoked_at) return 'revoked';
  if (new Date(link.expires_at).getTime() < Date.now()) return 'expired';
  return 'active';
}

export function listAccessLogs(shareLinkId: string, libraryId: string): Record<string, unknown>[] {
  const link = getDb().prepare('SELECT library_id FROM share_link WHERE id = ?').get(shareLinkId) as
    | { library_id: string }
    | undefined;
  if (!link || link.library_id !== libraryId) throw errors.notFound('分享链接');
  return getDb()
    .prepare('SELECT * FROM share_access_log WHERE share_link_id = ? ORDER BY at DESC LIMIT 200')
    .all(shareLinkId) as Record<string, unknown>[];
}

export { isShareFuzzLevelAllowed };
