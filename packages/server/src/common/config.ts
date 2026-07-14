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

  readonly rendererBase =
    process.env.RENDERER_BASE ?? 'http://localhost:5173';

  readonly sessionSecret =
    process.env.SESSION_SECRET ?? 'dev-only-secret-change-me';
  readonly sessionTtlMs =
    Number(process.env.SESSION_TTL_MS ?? 30 * 24 * 3600 * 1000);

  readonly storageDir = process.env.STORAGE_DIR ?? path.resolve('.storage');

  // Auto-backup target. On macOS the packaged app resolves this to
  // ~/Library/Application Support/Maestro/backups via the STORAGE_BACKUP_DIR
  // env (set by Electron main); dev falls back to <storageDir>/backups.
  readonly backupDir =
    process.env.STORAGE_BACKUP_DIR ?? path.join(this.storageDir, 'backups');
  readonly backupRetention = Number(process.env.STORAGE_BACKUP_RETENTION ?? 7);

  // QQ 音乐:走内嵌登录窗口捕获 cookie，无需 appid/secret（QQ 互联那套已废弃）

  // 网易云（没有公开 OAuth，用 cookie / 扫码）
  readonly neteaseMusicU = process.env.NETEASE_MUSIC_U ?? '';
  readonly neteaseQrPollIntervalMs = Number(
    process.env.NETEASE_QR_POLL_MS ?? 1500,
  );

  // DeepSeek（AI 推荐引擎，用户自带 Key，仅本地使用，不上传）
  readonly deepSeekApiKey = process.env.DEEPSEEK_API_KEY ?? '';

  constructor() {
    fs.mkdirSync(this.storageDir, { recursive: true });
  }
}