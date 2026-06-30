import { Injectable } from '@nestjs/common';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Centralised env loading. Everything has a sensible default so the dev
 * experience is "clone → npm install → npm run dev". Production values come
 * from the actual env.
 */
@Injectable()
export class ConfigService {
  readonly port = Number(process.env.PORT ?? 3200);

  readonly rendererOrigins = (process.env.RENDERER_ORIGINS ??
    'http://localhost:5173,http://localhost:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  readonly redirectBase = process.env.REDIRECT_BASE ?? 'http://localhost:3200';
  readonly rendererBase =
    process.env.RENDERER_BASE ?? 'http://localhost:5173';

  readonly sessionSecret =
    process.env.SESSION_SECRET ?? 'dev-only-secret-change-me';
  readonly sessionTtlMs =
    Number(process.env.SESSION_TTL_MS ?? 30 * 24 * 3600 * 1000);

  readonly storageDir = process.env.STORAGE_DIR ?? path.resolve('.storage');

  // QQ 互联
  readonly qqAppId = process.env.QQ_APP_ID ?? '';
  readonly qqAppSecret = process.env.QQ_APP_SECRET ?? '';
  readonly qqRedirectUri =
    process.env.QQ_REDIRECT_URI ??
    `${this.redirectBase}/auth/qq/callback`;

  // 网易云（没有公开 OAuth，用 cookie / 扫码）
  readonly neteaseMusicU = process.env.NETEASE_MUSIC_U ?? '';
  readonly neteaseQrPollIntervalMs = Number(
    process.env.NETEASE_QR_POLL_MS ?? 1500,
  );

  constructor() {
    fs.mkdirSync(this.storageDir, { recursive: true });
  }
}