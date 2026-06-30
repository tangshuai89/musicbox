import { Injectable, Logger } from '@nestjs/common';
import { Track } from './music.service';
import { ProviderSession } from '../common/session';

/**
 * Deezer 公共 API 音源。
 *
 * 为什么用 Deezer：
 *   - 完全公开 API（不需要 OAuth、API key、登录态）
 *   - 30s 预览 mp3 公开可用，跟"电台每次放一段"场景天然匹配
 *   - 全球 1 亿+ 曲目，覆盖中文流行/欧美/日韩
 *   - 文档稳定，不会主动反爬
 *
 * 限制：
 *   - 30s 预览（premium 才给完整流，我们走匿名永远只能拿预览）
 *   - preview URL 几小时过期——我们每次播放前现取，不缓存
 *
 * 文档：https://developers.deezer.com/api
 */
interface DeezerTrack {
  id: number;
  title: string;
  title_short?: string;
  duration: number;
  preview: string;
  artist: { id: number; name: string; picture_big?: string };
  album: {
    id: number;
    title: string;
    cover_big?: string;
    cover_medium?: string;
    cover_xl?: string;
  };
}

interface DeezerChartResponse {
  data: DeezerTrack[];
  total: number;
}

/**
 * Known Deezer editorials (curated genre charts).
 *  - 0   = All
 *  - 16  = Asian Music (J-Pop / K-Pop / C-Pop)
 *  - 132 = Pop (international)
 *  - 116 = Rap / Hip Hop
 *  - 152 = Rock
 *  - 113 = Dance
 *  - 165 = R&B
 *  - 98  = Classical
 *  - 129 = Jazz
 */
const DEEZER_EDITORIALS: Record<number, { name: string; region?: string }> = {
  0: { name: 'All' },
  16: { name: '亚洲流行', region: 'Asian · J/K/C-Pop' },
  132: { name: '国际流行', region: 'Pop' },
  116: { name: '说唱' },
  152: { name: '摇滚' },
  113: { name: '舞曲' },
  165: { name: 'R&B' },
  98: { name: '古典' },
  129: { name: '爵士' },
};

/** Preset name -> Deezer editorial id (curated genre chart). */
const DEEZER_EDITORIALS_PRESET: Record<string, number> = {
  all: 132,        // 'International Pop' as a sensible default
  asia: 16,        // Asian Music (J/K/C-Pop)
  pop: 132,
  rap: 116,
  rock: 152,
  dance: 113,
  rnb: 165,
  classical: 98,
  jazz: 129,
};

@Injectable()
export class DeezerMusicProvider {
  private readonly logger = new Logger(DeezerMusicProvider.name);
  private static readonly API = 'https://api.deezer.com';

  isConfigured(_session: ProviderSession | undefined): boolean {
    return true;
  }

  /** Source kind for fetchRadioBatch. */
  static readonly SOURCE_CHART = 'chart' as const;
  static readonly SOURCE_EDITORIAL = 'editorial' as const;

  /** Editorials we expose to the user. */
  static getEditorials(): { id: number; name: string; region?: string }[] {
    return Object.entries(DEEZER_EDITORIALS).map(([id, v]) => ({
      id: Number(id),
      name: v.name,
      region: v.region,
    }));
  }

  /**
   * 取一批电台歌曲。默认走国际流行榜（editorial 132），可用 source 切
   * 到具体榜单（'editorial' 走 /editorial/{id}/charts 包括亚洲流行
   * J-Pop/K-Pop/C-Pop）。
   *
   * @param session  当前会话（未使用，保留签名一致）
   * @param opts.preset  'all' | 'asia' | 'pop' | 'rap' | 'rock' | 'dance' | 'rnb' | 'classical' | 'jazz'
   * @param count        一次性拿多少首
   */
  async fetchRadioBatch(
    _session: ProviderSession,
    preset: string = 'all',
    count = 5,
  ): Promise<Track[]> {
    const editorialId = DEEZER_EDITORIALS_PRESET[preset] ?? 132;
    return this.fetchEditorialCharts(editorialId, count);
  }

  /**
   * Pull a batch of tracks from a Deezer editorial chart
   * (e.g. editorial/16 = Asian Music, editorial/132 = International Pop).
   * These are Deezer's curated rankings, not the user's chart endpoint.
   */
  private async fetchEditorialCharts(
    editorialId: number,
    count: number,
  ): Promise<Track[]> {
    const url = `${DeezerMusicProvider.API}/editorial/${editorialId}/charts?limit=${count}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'QQ-FM-Player/1.0 (Deezer anonymous)' },
    });
    if (!res.ok) {
      throw new Error(`deezer editorial fetch failed: ${res.status}`);
    }
    // Editorial charts response shape: { tracks: { data: [...] }, ... }
    const json = (await res.json()) as { tracks?: { data?: DeezerTrack[] } };
    const data = json.tracks?.data ?? [];
    if (!data.length) {
      throw new Error(`deezer editorial ${editorialId} returned no tracks`);
    }
    return data.map((t) => this.toTrack(t));
  }

  /**
   * Deezer 的 preview URL 已经在 fetchRadioBatch 里给出，但有时效。
   * 这里重新拉一次保证 URL 是新鲜的（防止队列里靠后的歌 preview 过期）。
   */
  async getStreamPath(
    _session: ProviderSession,
    trackId: string,
  ): Promise<string> {
    const res = await fetch(
      `${DeezerMusicProvider.API}/track/${trackId}`,
      {
        headers: { 'User-Agent': 'QQ-FM-Player/1.0 (Deezer anonymous)' },
      },
    );
    if (!res.ok) {
      throw new Error(`deezer track fetch failed: ${res.status}`);
    }
    const json = (await res.json()) as DeezerTrack;
    if (!json.preview) {
      throw new Error('deezer track has no preview url');
    }
    return json.preview;
  }

  private toTrack(t: DeezerTrack): Track {
    return {
      id: String(t.id),
      provider: 'deezer' as const,
      title: t.title_short || t.title,
      artist: t.artist?.name ?? '未知艺人',
      album: t.album?.title ?? '',
      coverUrl: t.album?.cover_xl ?? t.album?.cover_big ?? t.album?.cover_medium ?? '',
      // We give the 30s preview URL directly to the renderer. The deezer
      // CDN URL is hot-linkable and works for ~1 day; for a station that
      // plays 30s clips and then advances, this is plenty.
      audioUrl: t.preview,
      duration: Math.round(t.duration),
      liked: false,
    };
  }
}
