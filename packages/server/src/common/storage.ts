import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigService } from './config';

/**
 * Persists opaque blobs (sessions, cached tokens, pending QR keys) to a
 * single JSON file. Good enough for a desktop client; swap for SQLite when
 * the data set grows or needs queries.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly file: string;
  private cache: Record<string, unknown> = {};
  private writeTimer: NodeJS.Timeout | null = null;

  constructor(private readonly cfg: ConfigService) {
    this.file = path.join(cfg.storageDir, 'state.json');
    this.load();
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      this.cache = JSON.parse(raw);
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') {
        this.logger.warn(`Failed to load storage: ${e.message}`);
      }
      this.cache = {};
    }
  }

  private scheduleWrite(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      try {
        fs.writeFileSync(this.file, JSON.stringify(this.cache, null, 2));
      } catch (err) {
        this.logger.error(`Failed to write storage: ${(err as Error).message}`);
      }
    }, 200);
  }

  get<T>(key: string): T | undefined {
    return this.cache[key] as T | undefined;
  }

  set(key: string, value: unknown): void {
    this.cache[key] = value;
    this.scheduleWrite();
  }

  delete(key: string): void {
    delete this.cache[key];
    this.scheduleWrite();
  }

  /** Force-flush pending writes. Call before process exit. */
  flushSync(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.cache, null, 2));
    } catch (err) {
      this.logger.error(`Failed to flush storage: ${(err as Error).message}`);
    }
  }
}