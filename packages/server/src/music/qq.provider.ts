import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { Track } from './music.service';
import { ProviderSession } from '../common/session';

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

@Injectable()
export class QqMusicProvider {
  private readonly logger = new Logger(QqMusicProvider.name);

  /** 流行电台的固定 id（QQ 音乐内置电台 id）。 */
  private static readonly DEFAULT_RADIO_ID = 87;

  isConfigured(session: ProviderSession | undefined): boolean {
    return Boolean(session?.accessToken && session?.openId);
  }

  /** 取一批电台歌曲。本地缓存用 playlistSize 控制长度。 */
  async fetchRadioBatch(
    session: ProviderSession,
    radioId: number = QqMusicProvider.DEFAULT_RADIO_ID,
    count = 5,
  ): Promise<Track[]> {
    const url = new URL(
      'https://c.y.qq.com/radio/cgi-bin/radio_radio_user_list.fcg',
    );
    url.searchParams.set('id', String(radioId));
    url.searchParams.set('num', String(count));
    url.searchParams.set('song_num', String(count));
    url.searchParams.set('format', 'json');
    url.searchParams.set('inCharset', 'utf8');
    url.searchParams.set('outCharset', 'utf-8');

    const res = await fetch(url.toString(), {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Referer: 'https://y.qq.com/',
        // QQ 风的 cookie，登录态由 session 提供
        Cookie: `uin=${session.openId}; qqmusic_uin=${session.openId}; qqmusic_key=${session.accessToken}`,
      },
    });
    const json = (await res.json()) as RadioResponse;
    if (json.code !== 0 || !json.data?.songList?.length) {
      throw new BadRequestException(
        `QQ radio fetch failed: code=${json.code}`,
      );
    }

    const songs = json.data.songList;
    // 用 song_detail 批量拉元数据（标题、艺人、专辑、封面）
    const details = await this.fetchSongDetails(
      session,
      songs.map((s) => s.mid),
    );

    return songs.map((s, i) => {
      const d = details.get(s.mid);
      return {
        id: s.mid,
        provider: 'qq' as const,
        title: d?.name ?? s.name ?? s.title ?? '未知歌曲',
        artist:
          d?.singer?.map((x) => x.name).join(' / ') ??
          s.singer?.map((x) => x.name).join(' / ') ??
          '未知艺人',
        album: d?.album?.name ?? s.album?.name ?? '',
        coverUrl: '', // 后续若要封面可用 https://y.gtimg.cn/music/photo_new/T002R300x300M000{mid}.jpg
        audioUrl: '', // 由 getStreamUrl 在播放时动态获取
        duration: 0,
        liked: false,
      };
    });
  }

  /**
   * 取歌曲的播放 URL。QQ 的播放 URL 几分钟就过期，所以**必须**在用户
   * 即将播放时实时拉，不缓存。返回相对路径 /music/stream/qq/{mid}，
   * 让前端统一走后端代理，前端永远拿不到 raw URL。
   */
  async getStreamPath(
    session: ProviderSession,
    songmid: string,
  ): Promise<string> {
    const vkey = await this.fetchVkey(session, [songmid]);
    const info = vkey?.data?.midurlinfo?.[0];
    if (!info?.purl) {
      throw new BadRequestException(
        `QQ vkey missing purl for ${songmid}: errtype=${info?.errtype}`,
      );
    }
    // 把 raw url 暂存到 storage 一段短暂时间，由 /music/stream 端点读取后 302
    // 这里我们直接拼成完整的 upstream URL 让 controller 302
    const upstreamHost = vkey?.data?.sip?.[0] ?? 'https://ws.stream.qqmusic.qq.com/';
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
        Cookie: `qqmusic_key=${session.accessToken}`,
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
  ): Promise<MusicuVkeyResponse['req_0']> {
    const guid = this.randomGuid();
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
        uin: session.openId ?? '',
      },
      req_0: {
        module: 'music.vkey.GetVkey',
        method: 'UrlGetVkey',
        param: {
          guid,
          songmid: songmids,
          songtype: songmids.map(() => 0),
          uin: session.openId ?? '',
          loginflag: 1,
          platform: '20',
          h5guid: guid,
        },
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
          Cookie: `qqmusic_key=${session.accessToken}; qqmusic_uin=${session.openId}; uin=${session.openId}`,
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
}