import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { Track } from './music.service';
import { ProviderSession } from '../common/session';
import { type LyricLine, parseLrc } from '../common/lyrics';

/** QQ 音质档位。standard=m4a(默认)，high=320mp3，lossless=flac（需会员）。 */
export type QqQuality = 'standard' | 'high' | 'lossless';
export const QQ_QUALITIES: QqQuality[] = ['standard', 'high', 'lossless'];

/**
 * QQ 音乐电台 + 流地址。
 *
 * 关键技术点：
 *   - 电台列表：c.y.qq.com 的 /radio/cgi-bin/radio_radio_user_list.fcg
 *     返回 songmid 列表
 *   - 元数据：c.y.qq.com 的 /song/fcgi-bin/song_detail_v2.fcg?songmid=xxx
 *   - 流地址：u.y.qq.com 的 /cgi-bin/musicu.fcg 走 GetVkey 命令返回 purl，
 *     拼接 ws.stream.qqmusic.qq.com/{purl}
 *
 * 注意：QQ 音乐 API 经常改版且无官方文档，下面的字段名（vkey, guid 等）来自
 * 社区逆向。本实现按当前主流模式编写；若线上行为变化，主要看
 * `getStreamUrl` 这一处。
 */

interface RadioSong {
  id: number;
  mid: string;
  name: string;
  title: string;
  subtitle?: string;
  singer?: { name: string; mid: string }[];
  album?: { name: string; mid: string };
  time_public?: string;
}

interface RadioResponse {
  code: number;
  data?: {
    songList?: RadioSong[];
  };
}

interface SongDetailResponse {
  code: number;
  data?: {
    track_info?: {
      id: number;
      name: string;
      mid: string;
      album?: { name: string; mid: string };
      singer?: { name: string; mid: string }[];
    };
  };
  tracks?: Array<{
    id: number;
    name: string;
    mid: string;
    album?: { name: string; mid: string };
    singer?: { name: string; mid: string }[];
  }>;
}

interface MusicuVkeyResponse {
  code?: number;
  req_0?: {
    code?: number;
    data?: {
      midurlinfo?: Array<{
        songmid: string;
        purl?: string;
        vkey?: string;
        errtype?: number;
      }>;
      sip?: string[];
    };
  };
}

interface SearchResponse {
  code: number;
  data?: {
    song?: {
      list?: Array<{
        mid: string;
        name?: string;
        title?: string;
        singer?: { name: string; mid: string }[];
        album?: { name: string; mid: string };
        interval?: number; // 时长（秒）
        // file.strMediaMid 是取流用的 media_mid（可能 ≠ songmid），
        // 高音质 filename 必须用它拼接。size_* 反映各音质是否可用。
        file?: {
          strMediaMid?: string;
          media_mid?: string;
          size_320mp3?: number;
          size_flac?: number;
        };
      }>;
    };
  };
}

@Injectable()
export class QqMusicProvider {
  private readonly logger = new Logger(QqMusicProvider.name);

  /** 种子电台的关键词池——老的 radio_radio_user_list.fcg 已返回 HTML 报废，
   * 改用「随机热门关键词 + 搜索」来喂一个类电台的随机流。 */
  private static readonly RADIO_SEEDS = [
    '周杰伦',
    '林俊杰',
    '邓紫棋',
    '陈奕迅',
    '李荣浩',
    '毛不易',
    '华语流行',
    '经典老歌',
    'Taylor Swift',
    '抖音热歌',
  ];

  isConfigured(session: ProviderSession | undefined): boolean {
    return Boolean(session?.qqCookie);
  }

  /**
   * 取一批"电台"歌曲。老的电台接口已废（返回 HTML），这里退化为
   * 「随机热门关键词 → 搜索 → 打乱」的种子电台，保证 /music/next 恒有结果。
   */
  async fetchRadioBatch(
    session: ProviderSession,
    _radioId?: number,
    count = 10,
  ): Promise<Track[]> {
    const seeds = QqMusicProvider.RADIO_SEEDS;
    const seed = seeds[Math.floor(Math.random() * seeds.length)];
    const tracks = await this.search(session, seed, 20);
    // Fisher–Yates 打乱后取前 count 首
    for (let i = tracks.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
    }
    this.logger.log(`QQ radio(seed="${seed}") → ${tracks.length} 首`);
    return tracks.slice(0, count).map((t) => ({
      ...t,
      audioUrl: '', // 由 getStreamUrl 在播放时动态获取
    }));
  }

  /**
   * 按关键词（歌手 / 歌名）搜索。这是产品核心入口：搜歌手 → 出歌单 →
   * 点播放走 getStreamPath 出全曲流。搜索本身不强制登录态，但带上 cookie
   * 无害（会影响个性化结果）。
   */
  async search(
    session: ProviderSession,
    keyword: string,
    count = 20,
  ): Promise<Track[]> {
    const url = new URL('https://c.y.qq.com/soso/fcgi-bin/client_search_cp');
    url.searchParams.set('w', keyword);
    url.searchParams.set('p', '1');
    url.searchParams.set('n', String(count));
    url.searchParams.set('format', 'json');
    url.searchParams.set('cr', '1'); // 中文
    url.searchParams.set('t', '0'); // 0 = 单曲
    url.searchParams.set('flag_qc', '0');
    url.searchParams.set('new_json', '1'); // 返回结构化 data.song.list

    const res = await fetch(url.toString(), {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Referer: 'https://y.qq.com/',
        Cookie: session.qqCookie ?? '',
      },
    });
    const json = (await res.json()) as SearchResponse;
    if (json.code !== 0) {
      throw new BadRequestException(`QQ search failed: code=${json.code}`);
    }
    const list = json.data?.song?.list ?? [];
    this.logger.log(`QQ search "${keyword}" → ${list.length} 首`);
    return list.map((s) => ({
      id: s.mid,
      provider: 'qq' as const,
      title: s.name ?? s.title ?? '未知歌曲',
      artist: s.singer?.map((x) => x.name).join(' / ') ?? '未知艺人',
      album: s.album?.name ?? '',
      coverUrl: s.album?.mid
        ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${s.album.mid}.jpg`
        : '',
      audioUrl: '', // 播放时由 getStreamPath 动态获取
      duration: s.interval ?? 0,
      liked: false,
      mediaMid: s.file?.strMediaMid ?? s.file?.media_mid ?? '',
    }));
  }

  /**
   * 取歌曲的播放 URL。QQ 的播放 URL 几分钟就过期，所以**必须**在用户
   * 即将播放时实时拉，不缓存。返回相对路径 /music/stream/qq/{mid}，
   * 让前端统一走后端代理，前端永远拿不到 raw URL。
   */
  /** 音质档位 → GetVkey filename 的前缀 / 扩展名。standard 用默认 m4a。 */
  private static readonly QUALITY: Record<
    QqQuality,
    { prefix: string; ext: string } | null
  > = {
    standard: null, // 默认 C400 m4a，不传 filename
    high: { prefix: 'M800', ext: '.mp3' }, // 320 kbps
    lossless: { prefix: 'F000', ext: '.flac' }, // flac 无损
  };

  async getStreamPath(
    session: ProviderSession,
    songmid: string,
    mediaMid?: string,
    quality: QqQuality = 'standard',
  ): Promise<string> {
    // 高音质需要 media_mid 拼 filename；没有就退回默认 m4a。
    const spec = QqMusicProvider.QUALITY[quality];
    const filename =
      spec && mediaMid ? [`${spec.prefix}${mediaMid}${spec.ext}`] : undefined;

    let vkey = await this.fetchVkey(session, [songmid], filename);
    let info = vkey?.data?.midurlinfo?.[0];

    // 请求了高音质但没权限/该音质不存在（purl 空）→ 回退默认音质再试一次。
    if (!info?.purl && filename) {
      this.logger.warn(
        `QQ ${quality} 无 purl(errtype=${info?.errtype})，回退默认音质：${songmid}`,
      );
      vkey = await this.fetchVkey(session, [songmid]);
      info = vkey?.data?.midurlinfo?.[0];
    }

    if (!info?.purl) {
      // errtype 常见含义：无版权 / 需付费 / 登录态失效。日志留痕便于排查。
      this.logger.warn(
        `QQ GetVkey 无 purl: mid=${songmid}, errtype=${info?.errtype}, ` +
          `hasCookie=${Boolean(session.qqCookie)}, uin=${session.qqUin ?? '?'}`,
      );
      throw new BadRequestException(
        `QQ vkey missing purl for ${songmid}: errtype=${info?.errtype}（可能无版权/需会员/登录态失效）`,
      );
    }
    const upstreamHost =
      vkey?.data?.sip?.[0] ?? 'https://ws.stream.qqmusic.qq.com/';
    return upstreamHost.replace(/\/$/, '/') + info.purl;
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private async fetchSongDetails(
    session: ProviderSession,
    songmids: string[],
  ): Promise<Map<string, NonNullable<SongDetailResponse['tracks']>[number]>> {
    if (songmids.length === 0) return new Map();
    const url = new URL(
      'https://c.y.qq.com/song/fcgi-bin/song_detail_v2.fcg',
    );
    url.searchParams.set('songmid', songmids.join(','));
    url.searchParams.set('format', 'json');

    const res = await fetch(url.toString(), {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Referer: 'https://y.qq.com/',
        Cookie: session.qqCookie ?? '',
      },
    });
    const json = (await res.json()) as SongDetailResponse;
    const map = new Map<
      string,
      NonNullable<SongDetailResponse['tracks']>[number]
    >();
    for (const t of json.tracks ?? []) map.set(t.mid, t);
    return map;
  }

  private async fetchVkey(
    session: ProviderSession,
    songmids: string[],
    filenames?: string[],
  ): Promise<MusicuVkeyResponse['req_0']> {
    const guid = this.randomGuid();
    const param: Record<string, unknown> = {
      guid,
      songmid: songmids,
      songtype: songmids.map(() => 0),
      uin: session.qqUin ?? '',
      loginflag: 1,
      platform: '20',
      h5guid: guid,
    };
    // 指定 filename 才会返回对应音质的流地址（否则默认 m4a）。
    if (filenames) param.filename = filenames;
    const body = {
      comm: {
        cv: 4747474,
        ct: 24,
        format: 'json',
        inCharset: 'utf-8',
        outCharset: 'utf-8',
        notice: 0,
        platform: 'yqq.json',
        needNewCode: 1,
        uin: session.qqUin ?? '',
      },
      req_0: {
        module: 'music.vkey.GetVkey',
        method: 'UrlGetVkey',
        param,
      },
    };

    const res = await fetch(
      'https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&inCharset=utf8&outCharset=utf-8',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          Referer: 'https://y.qq.com/',
          Cookie: session.qqCookie ?? '',
        },
        body: JSON.stringify(body),
      },
    );
    const json = (await res.json()) as MusicuVkeyResponse;
    return json.req_0;
  }

  private randomGuid(): string {
    return Array.from({ length: 32 }, () =>
      Math.floor(Math.random() * 16).toString(16),
    ).join('');
  }

  /**
   * Fetch synced lyrics for a QQ song. Endpoint:
   *   GET c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg
   *       ?songmid={mid}&format=json&nobase64=1&g_tk=5381
   *
   * The `Referer: y.qq.com` header is mandatory — without it QQ returns
   * code 2001 (invalid request). `nobase64=1` asks for a plain LRC body
   * instead of base64; we still base64-decode as a fallback in case the
   * flag is ignored. The response is occasionally JSONP-wrapped
   * (`MusicJsonCallback({...})`) even with format=json, so we strip any
   * callback wrapper before parsing.
   *
   * Returns null when the song has no lyrics or the request fails — the
   * controller/service treats null as "暂无歌词".
   */
  async getLyrics(
    session: ProviderSession,
    songmid: string,
  ): Promise<LyricLine[] | null> {
    const url = new URL(
      'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg',
    );
    url.searchParams.set('songmid', songmid);
    url.searchParams.set('format', 'json');
    url.searchParams.set('nobase64', '1');
    url.searchParams.set('g_tk', '5381');

    const res = await fetch(url.toString(), {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Referer: 'https://y.qq.com/',
        Cookie: session.qqCookie ?? '',
      },
    });
    const text = await res.text();
    // Strip a JSONP callback wrapper if present: `foo({...})` → `{...}`.
    const jsonStr = text.replace(/^[^{]*(\{[\s\S]*\})[^}]*$/, '$1');
    let data: { code?: number; lyric?: string };
    try {
      data = JSON.parse(jsonStr) as { code?: number; lyric?: string };
    } catch {
      this.logger.warn(`QQ lyric parse failed for ${songmid}`);
      return null;
    }
    if (!data.lyric) return null;
    // nobase64=1 should give plain LRC, but if we still got base64
    // (no '[' timestamp brackets, looks like base64), decode it.
    let lrc = data.lyric;
    if (!lrc.includes('[') && /^[A-Za-z0-9+/=\s]+$/.test(lrc)) {
      try {
        lrc = Buffer.from(lrc, 'base64').toString('utf-8');
      } catch {
        /* leave as-is */
      }
    }
    return parseLrc(lrc);
  }
}