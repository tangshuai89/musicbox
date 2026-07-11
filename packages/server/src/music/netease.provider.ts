import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { Track } from './music.service';
import { type LyricLine, parseLrc } from '../common/lyrics';
import { ProviderSession } from '../common/session';
import { QqQuality } from './qq.provider';

/**
 * 网易云音乐：私人 FM + 播放 URL + 红心。
 *
 * 2026-07 实测：明文 `/api/*` 端点对服务端直连是放行的（此前认为必须经
 * Electron 内嵌 Chromium 转发 weapi 的结论只适用于加密 weapi 通道）。
 * 因此这里全部走服务端直连 + cookie header，架构大幅简化。
 *
 * 端点：
 *   - 私人 FM:      POST /api/radio/get
 *   - 播放 URL:      POST /api/song/enhance/player/url/v1
 *   - 红心:          POST /api/radio/like?alg=itembased
 *   - 垃圾桶:        POST /api/radio/trash/add
 *
 * 未登录/cookie 过期时接口返回 { code: 301 }。
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

interface NeteaseSong {
  id: number;
  name: string;
  artists?: { id: number; name: string }[];
  album?: { id: number; name: string; picUrl?: string };
  duration?: number;
  alias?: string[];
}

interface RadioResponse {
  code: number;
  data?: NeteaseSong[];
}

interface SongUrlItem {
  id: number;
  url: string | null;
  br: number;
  size: number;
  type?: string;
  level?: string;
  code?: number;
}

interface SongUrlResponse {
  code: number;
  data?: SongUrlItem[];
}

interface NeteaseSearchSong {
  id: number;
  name: string;
  artists?: { id: number; name: string }[];
  album?: { id: number; name: string; picUrl?: string };
  duration?: number;
}

interface NeteaseSearchResponse {
  code: number;
  result?: { songs?: NeteaseSearchSong[] };
}

interface SongDetailV3Response {
  code: number;
  songs?: {
    id: number;
    al?: { id: number; name: string; picUrl?: string };
  }[];
}

/** QQ 音质档位 → 网易云 level。standard→standard，high→exhigh(≈320)，
 * lossless→lossless（无损/hires 需会员，无权限时会回退）。 */
const NETEASE_LEVEL: Record<QqQuality, string> = {
  standard: 'standard',
  high: 'exhigh',
  lossless: 'lossless',
};

@Injectable()
export class NeteaseMusicProvider {
  private readonly logger = new Logger(NeteaseMusicProvider.name);

  isConfigured(session: ProviderSession | undefined): boolean {
    return Boolean(session?.musicU);
  }

  /** 取一批私人 FM 歌曲。 */
  async fetchRadioBatch(
    session: ProviderSession,
    count = 3,
  ): Promise<Track[]> {
    const data = await this.apiCall<RadioResponse>(
      session,
      'https://music.163.com/api/radio/get',
      {},
    );
    if (data.code !== 200) {
      throw new BadRequestException(
        data.code === 301
          ? '网易云登录已过期，请重新扫码登录'
          : `netease radio failed: code=${data.code}`,
      );
    }
    const songs = (data.data ?? []).slice(0, count);
    return songs.map((s) => ({
      id: String(s.id),
      provider: 'netease' as const,
      title: s.name,
      artist: s.artists?.map((a) => a.name).join(' / ') ?? '未知艺人',
      album: s.album?.name ?? '',
      coverUrl: s.album?.picUrl ?? '',
      audioUrl: '', // 由 getStreamPath 在播放时动态获取
      duration: Math.round((s.duration ?? 0) / 1000),
      liked: false,
    }));
  }

  /**
   * 拉取用户的"我喜欢的音乐"歌单完整列表。
   *
   * 实现:
   *  1. POST /api/nuser/account/get → 拿当前用户 uid
   *  2. POST /api/user/playlist?uid=... → 拿用户所有歌单，定位 specialType=5
   *     ("我喜欢的音乐" 在网易云里的特殊类型)，fallback 找名字等于'我喜欢的音乐'
   *  3. POST /api/v6/playlist/detail?id=... → 拿歌单里的 tracks[]
   *
   * 返回最多 maxTracks 条（避免 10k+ 收藏的极端情况把响应撑爆）；track
   * 里的元数据已经够用（id/name/artists/album/duration）所以不再单独
   * 调 song/detail。
   *
   * 失败模式：
   *  - code=301（未登录）→ 返回空数组，由上层决定是提示用户登录还是静默
   *  - 找不到"我喜欢的音乐"歌单 → 返回空数组
   *  - 任一 HTTP 错误 → 包成 BadRequestException 让上层 catch
   */
  async fetchLiked(
    session: ProviderSession,
    maxTracks = 1000,
  ): Promise<Track[]> {
    if (!this.isConfigured(session)) return [];

    // 1. 当前用户 uid
    const account = await this.apiCall<{ account?: { id?: number }; profile?: unknown }>(
      session,
      'https://music.163.com/api/nuser/account/get',
      {},
    );
    const uid = account.account?.id;
    if (!uid) {
      this.logger.warn('netease fetchLiked: no uid from /nuser/account/get');
      return [];
    }

    // 2. 用户歌单列表
    const playlists = await this.apiCall<{
      playlist?: Array<{
        id: number;
        name?: string;
        specialType?: number;
        creator?: { userId?: number };
      }>;
    }>(
      session,
      'https://music.163.com/api/user/playlist',
      { uid: String(uid), limit: '50' },
    );
    const fav = (playlists.playlist ?? []).find(
      (p) =>
        // specialType=5 是"我喜欢的音乐"在网易云里的魔法值
        p.specialType === 5 ||
        (p.name === '我喜欢的音乐' && p.creator?.userId === uid),
    );
    if (!fav) {
      this.logger.warn('netease fetchLiked: no "我喜欢的音乐" playlist found');
      return [];
    }

    // 3. 歌单详情（含完整 tracks 列表）
    const detail = await this.apiCall<{
      playlist?: {
        tracks?: Array<{
          id: number;
          name: string;
          ar?: { id: number; name: string }[];
          al?: { id: number; name: string; picUrl?: string };
          dt?: number;
        }>;
      };
    }>(
      session,
      'https://music.163.com/api/v6/playlist/detail',
      { id: String(fav.id), n: '1000' },
    );
    const tracks = (detail.playlist?.tracks ?? []).slice(0, maxTracks);
    return tracks.map((t) => ({
      id: String(t.id),
      provider: 'netease' as const,
      title: t.name,
      artist: t.ar?.map((a) => a.name).join(' / ') ?? '未知艺人',
      album: t.al?.name ?? '',
      coverUrl: t.al?.picUrl ?? '',
      audioUrl: '',
      duration: Math.round((t.dt ?? 0) / 1000),
      liked: true, // 来源就是"我喜欢的音乐"，全部视为已 ❤
    }));
  }

  /**
   * 按关键词搜索（歌手 / 歌名）。走明文 /api/search/get/web，服务端直连可用。
   * 返回的 audioUrl 交由 music.service 拼成后端代理相对路径。
   */
  async search(
    session: ProviderSession,
    keyword: string,
    count = 30,
  ): Promise<Track[]> {
    const data = await this.apiCall<NeteaseSearchResponse>(
      session,
      'https://music.163.com/api/search/get/web',
      {
        s: keyword,
        type: '1', // 1 = 单曲
        offset: '0',
        limit: String(count),
        total: 'true',
      },
    );
    const songs = data.result?.songs ?? [];
    this.logger.log(`netease search "${keyword}" → ${songs.length} 首`);
    const tracks: Track[] = songs.map((s) => ({
      id: String(s.id),
      provider: 'netease' as const,
      title: s.name,
      artist: (s.artists ?? []).map((a) => a.name).join(' / ') || '未知艺人',
      album: s.album?.name ?? '',
      coverUrl: s.album?.picUrl ?? '',
      audioUrl: '', // 由 getStreamPath 在播放时动态获取
      duration: Math.round((s.duration ?? 0) / 1000),
      liked: false,
    }));
    // /api/search/get/web 不返回专辑封面，批量补一发 song/detail 拿 al.picUrl。
    const covers = await this.fetchCovers(
      session,
      tracks.map((t) => t.id),
    );
    return tracks.map((t) => ({
      ...t,
      coverUrl: covers.get(t.id) ?? t.coverUrl,
    }));
  }

  /** 批量取封面（search/get/web 不含 al.picUrl）。失败不影响搜索结果。 */
  private async fetchCovers(
    session: ProviderSession,
    ids: string[],
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (!ids.length) return map;
    try {
      const c = JSON.stringify(ids.map((id) => ({ id: Number(id) })));
      const data = await this.apiCall<SongDetailV3Response>(
        session,
        'https://music.163.com/api/v3/song/detail',
        { c },
      );
      for (const s of data.songs ?? []) {
        if (s.al?.picUrl) {
          // ?param=300y300 → CDN 缩放到合适尺寸，省带宽。
          map.set(String(s.id), `${s.al.picUrl}?param=300y300`);
        }
      }
    } catch (err) {
      this.logger.warn(`netease cover fetch failed: ${(err as Error).message}`);
    }
    return map;
  }

  /** 取歌曲的真实播放 URL（有时效，即拉即用）。按音质档位选 level。 */
  async getStreamPath(
    session: ProviderSession,
    songId: string,
    quality: QqQuality = 'standard',
  ): Promise<string> {
    const level = NETEASE_LEVEL[quality] ?? 'standard';
    let item = await this.fetchSongUrl(session, songId, level);
    // 该音质无权限/不存在（url 空）→ 回退标准音质再试一次。
    if (!item?.url && level !== 'standard') {
      this.logger.warn(
        `netease ${level} 无 url，回退标准音质：${songId}`,
      );
      item = await this.fetchSongUrl(session, songId, 'standard');
    }
    if (!item?.url) {
      throw new BadRequestException(
        `netease stream url missing for ${songId}: code=${item?.code ?? 'n/a'}`,
      );
    }
    return item.url;
  }

  private async fetchSongUrl(
    session: ProviderSession,
    songId: string,
    level: string,
  ): Promise<SongUrlItem | undefined> {
    const data = await this.apiCall<SongUrlResponse>(
      session,
      'https://music.163.com/api/song/enhance/player/url/v1',
      {
        ids: `[${Number(songId)}]`,
        level,
        encodeType: 'aac',
      },
    );
    return data.data?.[0];
  }

  /**
   * 红心开关：把歌加入 / 移出「我喜欢的音乐」（specialType=5 歌单）。
   * radio/like 的 like=true/false 是网易云真正的「红心 / 取消红心」切换，
   * 取消时会把歌从「我喜欢的音乐」歌单删掉。
   */
  private async setRadioLike(
    session: ProviderSession,
    songId: string,
    liked: boolean,
  ): Promise<boolean> {
    const data = await this.apiCall<{ code: number }>(
      session,
      'https://music.163.com/api/radio/like',
      {
        alg: 'itembased',
        trackId: String(songId),
        like: liked ? 'true' : 'false',
        time: '3',
      },
    );
    return data.code === 200;
  }

  /** 给一首歌点红心（加入「我喜欢的音乐」）。 */
  async like(session: ProviderSession, songId: string): Promise<boolean> {
    return this.setRadioLike(session, songId, true);
  }

  /**
   * 取消红心：从「我喜欢的音乐」移除（radio/like?like=false）。
   *
   * ⚠️ 不要用 radio/trash/add——那是私人 FM 的「不喜欢」，只会把歌丢进
   * 垃圾桶减少推荐，**不会**把它从「我喜欢的音乐」歌单里删掉；而 fetchLiked
   * 读的正是那个歌单，用 trash 取消会出现「取消了却还在收藏里、下次 detect
   * 又被重新点亮」的死循环。踩/不喜欢请用 fmTrash。
   */
  async unlike(session: ProviderSession, songId: string): Promise<boolean> {
    return this.setRadioLike(session, songId, false);
  }

  /** 私人 FM「不喜欢 / 踩」：加入垃圾桶，减少同类推荐（≠ 取消红心）。 */
  async fmTrash(session: ProviderSession, songId: string): Promise<boolean> {
    const data = await this.apiCall<{ code: number }>(
      session,
      'https://music.163.com/api/radio/trash/add',
      {
        alg: 'itembased',
        songId: String(songId),
        time: '25',
      },
    );
    return data.code === 200;
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private async apiCall<T>(
    session: ProviderSession,
    endpoint: string,
    payload: Record<string, string>,
  ): Promise<T> {
    const cookie =
      `MUSIC_U=${session.musicU}; os=pc` +
      (session.csrfToken ? `; __csrf=${session.csrfToken}` : '');

    let text = '';
    let status = 0;
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': UA,
          Referer: 'https://music.163.com/',
          Origin: 'https://music.163.com',
          Accept: 'application/json, text/plain, */*',
          Cookie: cookie,
        },
        body: new URLSearchParams(payload).toString(),
        redirect: 'manual',
      });
      status = res.status;
      text = await res.text();
    } catch (err) {
      throw new BadRequestException(
        `网易云请求失败: ${(err as Error).message}`,
      );
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      this.logger.error(`netease response not JSON: ${text.slice(0, 200)}`);
      throw new BadRequestException(
        `网易云返回非 JSON（status=${status}，bodyLen=${text.length}）`,
      );
    }
  }

  /**
   * Fetch synced lyrics for a NetEase song. Endpoint:
   *   GET /api/song/lyric?id={songId}&lv=1&kv=1&tv=-1
   * Returns { lyric: "<LRC body>", tlyric?: "<translation LRC>" }.
   * We only parse the main `lyric` for v1 — translations can be
   * added later by aligning `tlyric` lines to `lyric` time tags.
   *
   * The `lv` / `kv` / `tv` params select:
   *   lv=1: lyrics (original)
   *   kv=1: karaoke-style word-by-word timing (we ignore for v1)
   *   tv=-1: no translation
   * Sending tv=-1 keeps the response small when we don't translate.
   *
   * Returns null when:
   *   - The response has no `lyric` field (instrumental, etc.)
   *   - The lyric body has no parseable timestamps (only [ti:] / [ar:]
   *     metadata lines, no time tags → treat as no synced lyrics)
   *   - The API call fails for any reason (the controller catches
   *     and the UI shows "暂无歌词").
   */
  async getLyrics(
    session: ProviderSession,
    songId: string,
  ): Promise<LyricLine[] | null> {
    interface LyricResponse {
      lyric?: string;
      tlyric?: string;
      code?: number;
    }
    const data = await this.apiCall<LyricResponse>(
      session,
      'https://music.163.com/api/song/lyric',
      {
        id: String(songId),
        lv: '1',
        kv: '1',
        tv: '-1',
      },
    );
    if (!data.lyric) return null;
    return parseLrc(data.lyric);
  }
}
