import { Injectable, Logger } from '@nestjs/common';
import { type LyricLine } from '../common/lyrics';
import { withTimeout } from '../common/timeout';

const TIMEOUT_MS = 5000;

/**
 * lyrics.ovh —— 公开无鉴权的第三方歌词 API，作为平台源都拿不到歌词时的
 * 最后回退。只提供纯文本（无时间戳），返回的 LyricLine 全部 time=0，
 * 由上层标记 synced=false。
 *
 * 端点：GET https://api.lyrics.ovh/v1/{artist}/{title}
 * 响应：{ lyrics: "line1\nline2..." }，404 表示没收录。
 */
@Injectable()
export class LyricsOvhProvider {
  private readonly logger = new Logger(LyricsOvhProvider.name);

  async getLyrics(artist: string, title: string): Promise<LyricLine[] | null> {
    if (!artist.trim() || !title.trim()) return null;
    const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(artist.trim())}/${encodeURIComponent(title.trim())}`;
    const body = await withTimeout(async () => {
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = (await res.json()) as { lyrics?: string };
      return data.lyrics ?? null;
    }, TIMEOUT_MS);
    if (!body) return null;
    const lines: LyricLine[] = body
      .split(/\r?\n/)
      .map((text) => text.trim())
      .filter((text) => text.length > 0)
      .map((text) => ({ time: 0, text }));
    if (lines.length === 0) return null;
    this.logger.log(`lyrics.ovh hit: ${artist} - ${title} (${lines.length} lines)`);
    return lines;
  }
}
