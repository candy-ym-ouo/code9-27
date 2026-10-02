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
 * 资源归属校验：被分享的 album / inspiration 必须真实存在且属于发起分享的库。
 * 创建、公开访问、图片三条链路都必须调用——只在创建时校验不够，
 * 因为历史上可能已经写入过跨库的非法分享行。
 */
export function assertShareScopeOwned(
  scope: 'album' | 'inspiration',
  scopeId: string,
  libraryId: string,
): void {
  const table = scope === 'album' ? 'album' : 'inspiration';
  const row = getDb()
    .prepare(`SELECT library_id FROM ${table} WHERE id = ? AND deleted_at IS NULL`)
    .get(scopeId) as { library_id: string } | undefined;
  if (!row) throw errors.notFound(scope === 'album' ? '画册' : '灵感卡');
  if (row.library_id !== libraryId) throw errors.scopeDenied();
}

/**
 * 图片归属校验：图片不仅要落在分享范围内，还必须与分享链接属于同一个库，
 * 否则可借"他库画册里恰好引用了本库 asset"之类的错配行越权取图。
 */
export function assertAssetInShareScope(
  asset: { library_id: string; inspiration_id: string },
  link: Pick<ShareLinkRow, 'scope' | 'scope_id' | 'library_id'>,
  db: ReturnType<typeof getDb>,
): boolean {
  if (asset.library_id !== link.library_id) return false;
  if (link.scope === 'inspiration') {
    return asset.inspiration_id === link.scope_id;
  }
  return Boolean(
    db
      .prepare(
        `SELECT 1 AS x
           FROM album_item ai JOIN album a ON a.id = ai.album_id
          WHERE ai.album_id = ? AND ai.inspiration_id = ? AND a.library_id = ? AND a.deleted_at IS NULL`,
      )
      .get(link.scope_id, asset.inspiration_id, link.library_id),
  );
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

  // 归属底线：禁止用本库身份为他库资源创建分享链接
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
  // 每次访问都复核资源归属：历史数据里可能已存在跨库的非法分享行，
  // 撤销/过期之外，资源不属于本库同样必须拒绝（创建、访问、图片三链路一致）。
  assertShareScopeOwned(row.scope, row.scope_id, row.library_id);
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
