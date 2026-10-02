import fs from 'node:fs';
import { Router } from 'express';
import { z } from 'zod';
import { createShareLinkSchema, type FuzzLevel } from '@flil/shared';
import { getDb, nowIso } from '../db.js';
import { ah, ok } from '../http/respond.js';
import { authenticate } from '../http/middleware.js';
import { ctxOf } from '../http/context.js';
import { errors } from '../http/errors.js';
import {
  assertShareScopeMatchesLink,
  createShareLink,
  listAccessLogs,
  listShareLinks,
  logAccess,
  revokeShareLink,
  shareStatus,
  validateShareToken,
} from '../services/share.js';
import { albumItemsDetailed, getSnapshot } from '../services/albums.js';
import { requireInspiration } from '../services/inspirations.js';
import { toInspirationDto } from '../services/serialization.js';
import { shareImageFor, type AssetRow } from '../services/assets.js';

export const shareRouter = Router();
export const publicShareRouter = Router();

shareRouter.use(authenticate());

shareRouter.post(
  '/share-links',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const input = createShareLinkSchema.parse(req.body);
    const link = createShareLink({
      libraryId: ctx.libraryId,
      scope: input.scope,
      scopeId: input.scopeId,
      fuzzLevel: input.fuzzLevel as FuzzLevel,
      expiresInDays: input.expiresInDays,
      password: input.password ?? null,
      userId: req.auth!.id,
    });
    // 明确告知是否发生了强制降级，避免用户误以为用了精确坐标
    ok(
      res,
      {
        id: link.id,
        token: link.token,
        url: `/share/${link.token}`,
        fuzzLevel: link.fuzz_level,
        downgraded: link.fuzz_level !== input.fuzzLevel,
        expiresAt: link.expires_at,
      },
      201,
    );
  }),
);

shareRouter.get(
  '/share-links',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    ok(res, {
      items: listShareLinks(ctx.libraryId).map((l) => ({
        id: l.id,
        scope: l.scope,
        scopeId: l.scope_id,
        token: l.token,
        fuzzLevel: l.fuzz_level,
        hasPassword: Boolean(l.password_hash),
        expiresAt: l.expires_at,
        status: shareStatus(l),
        viewCount: l.view_count,
        createdAt: l.created_at,
      })),
    });
  }),
);

shareRouter.post(
  '/share-links/:id/revoke',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    revokeShareLink(req.params.id, ctx.libraryId);
    ok(res, { revoked: true });
  }),
);

shareRouter.get(
  '/share-links/:id/logs',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    ok(res, { items: listAccessLogs(req.params.id, ctx.libraryId) });
  }),
);

/** 隐私巡检：列出全部有效分享，供"一键巡检/批量撤销"使用（文档 13.6） */
shareRouter.get(
  '/share-links/audit',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const links = listShareLinks(ctx.libraryId);
    ok(res, {
      active: links.filter((l) => shareStatus(l) === 'active').length,
      expired: links.filter((l) => shareStatus(l) === 'expired').length,
      revoked: links.filter((l) => shareStatus(l) === 'revoked').length,
      items: links.map((l) => ({
        id: l.id,
        scope: l.scope,
        fuzzLevel: l.fuzz_level,
        expiresAt: l.expires_at,
        status: shareStatus(l),
        viewCount: l.view_count,
      })),
    });
  }),
);

// ------------------------------------------------------------ 公开分享访问

function passwordFrom(req: { query: unknown; header: (n: string) => string | undefined }): string | null {
  const q = req.query as Record<string, string | undefined>;
  return q.password ?? req.header('x-share-password') ?? null;
}

/**
 * 只读分享视图（无需登录）。
 * 输出中**只有模糊坐标**，并且每次请求都会重新校验撤销与过期（不接受缓存兜底）。
 */
publicShareRouter.get(
  '/share/:token',
  ah(async (req, res) => {
    const link = validateShareToken(req.params.token, passwordFrom(req));
    // 访问链路归属校验：分享范围必须仍属于链接所在库（防修复前遗留的跨库链接）
    assertShareScopeMatchesLink(link);
    const ctx = {
      libraryId: link.library_id,
      role: 'member' as const,
      defaultFuzzLevel: link.fuzz_level as FuzzLevel,
      includePrecise: false,
    };

    if (link.scope === 'album') {
      // 画册本身已由 assertShareScopeMatchesLink 校验；条目在 SQL 层按库过滤，
      // 防止 album_item 中混入（历史脏数据或其他缺陷写入的）他库灵感卡
      const snapshot = getSnapshot(link.scope_id);
      const items = albumItemsDetailed(link.scope_id, ctx);
      logAccess(link.id, true);
      return ok(res, {
        scope: 'album',
        fuzzLevel: link.fuzz_level,
        expiresAt: link.expires_at,
        snapshot,
        items: items.map((i) => ({
          id: i.id,
          title: i.title,
          tags: i.tags,
          fuzz: i.spot?.fuzz ?? null,
          anchor: i.timing?.timeAnchor ?? null,
          assets: i.assets.map((a) => ({ id: a.id, width: a.width, height: a.height, url: `/api/share/${link.token}/assets/${a.id}` })),
        })),
        notice: '内容随时可能失效；地点已按分享级别模糊化。',
      });
    }

    const row = requireInspiration(link.scope_id, link.library_id);
    const dto = toInspirationDto(row, ctx);
    logAccess(link.id, true);
    ok(res, {
      scope: 'inspiration',
      fuzzLevel: link.fuzz_level,
      expiresAt: link.expires_at,
      item: {
        id: dto.id,
        title: dto.title,
        note: dto.note,
        tags: dto.tags,
        fuzz: dto.spot?.fuzz ?? null,
        anchor: dto.timing?.timeAnchor ?? null,
        assets: dto.assets.map((a) => ({ id: a.id, width: a.width, height: a.height, url: `/api/share/${link.token}/assets/${a.id}` })),
      },
      notice: '内容随时可能失效；地点已按分享级别模糊化。',
    });
  }),
);

/** 分享图：二次脱敏（剥离 EXIF）后输出，且每次校验撤销/过期 */
publicShareRouter.get(
  '/share/:token/assets/:assetId',
  ah(async (req, res) => {
    const link = validateShareToken(req.params.token, passwordFrom(req));
    // 图片链路归属校验①：分享范围必须仍属于链接所在库
    assertShareScopeMatchesLink(link);
    const db = getDb();
    const asset = db.prepare('SELECT * FROM asset WHERE id = ?').get(req.params.assetId) as AssetRow | undefined;
    if (!asset) throw errors.notFound('图片');

    // 图片链路归属校验②：图片本身必须属于链接所在库，杜绝跨库 id 碰撞/脏数据被令牌带出
    if (asset.library_id !== link.library_id) {
      logAccess(link.id, false, 'asset_cross_library');
      throw errors.scopeDenied();
    }

    // 越权检查③：该图片必须属于本次分享范围
    let allowed = false;
    if (link.scope === 'inspiration') {
      allowed = asset.inspiration_id === link.scope_id;
    } else {
      allowed = Boolean(
        db
          .prepare(
            `SELECT 1 AS x FROM album_item ai
               JOIN album a ON a.id = ai.album_id
              WHERE ai.album_id = ? AND ai.inspiration_id = ? AND a.library_id = ?`,
          )
          .get(link.scope_id, asset.inspiration_id, link.library_id),
      );
    }
    if (!allowed) {
      logAccess(link.id, false, 'asset_out_of_scope');
      throw errors.scopeDenied();
    }

    const target = await shareImageFor(asset, link.library_id);
    if (!fs.existsSync(target)) throw errors.notFound('图片文件');
    logAccess(link.id, true);
    res.sendFile(target);
  }),
);

publicShareRouter.post(
  '/share/:token/verify',
  ah(async (req, res) => {
    const { password } = z.object({ password: z.string().nullable().optional() }).parse(req.body ?? {});
    const link = validateShareToken(req.params.token, password ?? null);
    ok(res, { ok: true, scope: link.scope, fuzzLevel: link.fuzz_level, expiresAt: link.expires_at });
  }),
);

export { nowIso };
