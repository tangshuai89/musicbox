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
 *
 * ⚠️ 写接口风控（2026-07 实测，隔离过变量）：读接口（search / radio/get /
 * fetchLiked）服务端直连放行，但**写接口**（radio/like 红心、radio/trash 垃圾桶）
 * 会被拦成 { code: -460, message: "检测到您的网络环境存在风险" }。两个关键因素
 * （见 apiCall 的实现）：
 *   1. **cookie 里的 `appver`（决定性）**：缺了它写接口必 -460；加上 appver=8.9.70
 *      → code=200。真实客户端总带版本号，服务端直连也必须带。
 *   2. **realIP header（X-Real-IP / X-Forwarded-For = 国内 IP）**：进一步压 405
 *      「操作频繁」限流——有 realIP 时快速连点也 0 失败，没有时偶发 405。
 *   外加 csrf_token 参数对齐 __csrf cookie（写接口通用要求）。
 *   坑：只加 realIP 不加 appver（本项目前一版就是这样）仍然 -460——之前误以为
 *   realIP 是解药，是因为手测的 cookie 恰好带了 appver 把它掩盖了。
 *
 * ⚠️ 写接口"操作频繁"（2026-07 实测）：极快速重复提交时，HTTP 200 但 body 是
 * { code: 405, message: "操作频繁，请稍候再试" } —— 网易云防抖阈值。这里当成
 * 普通失败返回 false，让同步队列按指数退避（见 LikeSyncQueue.BACKOFF_BASE_MS）
 * 重试，不要在 provider 层吞掉。appver + realIP 齐全后正常点击几乎不会触发。
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/**
 * -460/405 风控用的国内 IP（广东电信段）。搭配 cookie 里的 appver 一起，把
 * 服务端直连写接口的 -460 和 405 限流压下去；读接口不受影响，反而可能顺带
 * 解锁部分区域限制。实测该 IP 可用；若被拦换一个国内段即可。
 */
const NETEASE_REAL_IP = '116.25.146.177';

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
  /** 与 songs 平行的权限数组。`pl` = 当前用户可播的最大位率（bps），
   *  `pl<=0` 表示这首歌当前账号放不了全曲（无版权 / VIP 独占 / 只给试听）。 */
  privileges?: { id: number; pl?: number; fee?: number; st?: number }[];
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
    // /api/search/get/web 不返回封面，也不含权限；批量补一发 v3 song/detail 拿
    // al.picUrl（封面）+ privilege（可播性，见 vipLocked）。
    const enrich = await this.fetchEnrichment(
      session,
      tracks.map((t) => t.id),
    );
    return tracks.map((t) => ({
      ...t,
      coverUrl: enrich.get(t.id)?.cover ?? t.coverUrl,
      vipLocked: enrich.get(t.id)?.vipLocked,
    }));
  }

  /**
   * 批量取封面 + 权限（search/get/web 两者都不含）。失败不影响搜索结果。
   * `vipLocked` 来自 `privilege.pl`：`pl<=0` = 当前账号放不了全曲（无版权 / VIP
   * 独占 / 只给试听）——这是**用户维度**的判断，比 QQ 的歌级 pay_play 更准。
   */
  private async fetchEnrichment(
    session: ProviderSession,
    ids: string[],
  ): Promise<Map<string, { cover?: string; vipLocked?: boolean }>> {
    const map = new Map<string, { cover?: string; vipLocked?: boolean }>();
    if (!ids.length) return map;
    try {
      const c = JSON.stringify(ids.map((id) => ({ id: Number(id) })));
      const data = await this.apiCall<SongDetailV3Response>(
        session,
        'https://music.163.com/api/v3/song/detail',
        { c },
      );
      for (const s of data.songs ?? []) {
        // ?param=300y300 → CDN 缩放到合适尺寸，省带宽。
        map.set(String(s.id), {
          cover: s.al?.picUrl ? `${s.al.picUrl}?param=300y300` : undefined,
        });
      }
      for (const p of data.privileges ?? []) {
        const entry = map.get(String(p.id)) ?? {};
        entry.vipLocked = !(typeof p.pl === 'number' && p.pl > 0);
        map.set(String(p.id), entry);
      }
    } catch (err) {
      this.logger.warn(`netease enrich fetch failed: ${(err as Error).message}`);
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
    const data = await this.apiCall<{ code: number; message?: string }>(
      session,
      'https://music.163.com/api/radio/like',
      {
        alg: 'itembased',
        trackId: String(songId),
        like: liked ? 'true' : 'false',
        time: '3',
      },
    );
    // 405 = "操作频繁"——重复提交同一首歌的同方向 like/unlike（目标状态已达成）
    // / 真实失败。队列拿到 false 后会按指数退避重试。
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
    // appver 是解 -460 风控的关键（2026-07 实测，比 realIP 更决定性）：写接口
    // 缺了它必 -460，加上后 code=200。真实网易云客户端总会带这个版本号，服务端
    // 直连也必须带。os=pc + realIP header 一起把 -460 和 405 限流都压下去。
    const cookie =
      `MUSIC_U=${session.musicU}; os=pc; appver=8.9.70` +
      (session.csrfToken ? `; __csrf=${session.csrfToken}` : '');

    // 写接口（radio/like、radio/trash）需要 csrf_token 参数与 __csrf cookie 对齐；
    // 读接口会忽略这个多余参数，所以统一带上，无副作用。
    const body: Record<string, string> = { ...payload };
    if (session.csrfToken) body.csrf_token = session.csrfToken;

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
          // -460「网络环境存在风险」绕过：服务端直连的写接口（红心/垃圾桶）会被
          // 网易云风控拦截，伪造一个国内 realIP 即可放行（见 NETEASE_REAL_IP）。
          'X-Real-IP': NETEASE_REAL_IP,
          'X-Forwarded-For': NETEASE_REAL_IP,
        },
        body: new URLSearchParams(body).toString(),
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
