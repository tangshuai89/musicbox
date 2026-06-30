import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { Track } from './music.service';
import { ProviderSession } from '../common/session';
import { NeteaseProxy } from './netease-proxy';

/**
 * 网易云音乐：私人 FM + 播放 URL。
 *
 * 所有写操作（私人 FM、点赞）必须带 MUSIC_U cookie；未登录时会返回
 * { code: 301 }。我们在 controller 层提前校验。
 *
 * 端点：
 *   - 私人 FM:        POST /weapi/radio/get
 *   - 播放 URL:        POST /weapi/song/enhance/player/url/v1?csrf_token=
 *   - 红心 / 垃圾桶:    POST /weapi/radio/like?csrf_token=  /like?alg=itembased
 *
 * 反爬说明：
 *   网易云对 weapi 调用做了 TLS+header+cookie 多维度反爬，从 Node 进程
 *   直接 fetch 会被识别成 bot 并返回 200 + 空 body。
 *
 *   解决：所有 weapi 调用都通过 Electron 内嵌的登录窗口转发——那是一个
 *   真实的 Chromium 页面，自己持有 MUSIC_U cookie、自己做 weapi 加密、
 *   自己发出请求。NestJS 端只负责构造 payload，**不**参与加密。
 */

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
  data?: { songs?: NeteaseSong[] };
}

interface SongUrlItem {
  id: number;
  url: string | null;
  br: number;
  size: number;
  type?: string;
  level?: string;
  encodeType?: string;
}

interface SongUrlResponse {
  code: number;
  data?: SongUrlItem[];
}

@Injectable()
export class NeteaseMusicProvider {
  private readonly logger = new Logger(NeteaseMusicProvider.name);

  constructor(private readonly proxy: NeteaseProxy) {}

  isConfigured(session: ProviderSession | undefined): boolean {
    return Boolean(session?.musicU);
  }

  /**
   * 取一批私人 FM 歌曲。
   * @param session  当前会话
   * @param count    一次性拿多少首（默认 3，存到 playlist 队列里供后续消费）
   */
  async fetchRadioBatch(
    session: ProviderSession,
    count = 3,
  ): Promise<Track[]> {
    const data = await this.weapiCall<RadioResponse>(
      session,
      'https://music.163.com/weapi/radio/get',
      {},
    );
    if (data.code !== 200) {
      throw new BadRequestException(`netease radio failed: code=${data.code}`);
    }
    const songs = (data.data?.songs ?? []).slice(0, count);
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
   * 取歌曲的真实播放 URL。和 QQ 一样 URL 有时效，所以即时拉即时用。
   * 返回 raw URL，由 controller 层做 302。
   */
  async getStreamPath(
    session: ProviderSession,
    songId: string,
  ): Promise<string> {
    const data = await this.weapiCall<SongUrlResponse>(
      session,
      'https://music.163.com/weapi/song/enhance/player/url/v1',
      {
        ids: [Number(songId)],
        br: 999000, // 320kbps mp3
      },
      true, // use csrf token from cookie
    );
    const item = data.data?.[0];
    if (!item?.url) {
      throw new BadRequestException(
        `netease stream url missing for ${songId}: code=${data.code}`,
      );
    }
    return item.url;
  }

  /** 给一首歌点红心。 */
  async like(session: ProviderSession, songId: string): Promise<boolean> {
    const data = await this.weapiCall<{ code: number }>(
      session,
      'https://music.163.com/weapi/radio/like',
      {
        alg: 'itembased',
        trackId: Number(songId),
        like: true,
      },
      true,
    );
    return data.code === 200;
  }

  /** 标记「不喜欢」，私人 FM 会减少推荐。 */
  async unlike(session: ProviderSession, songId: string): Promise<boolean> {
    const data = await this.weapiCall<{ code: number }>(
      session,
      'https://music.163.com/weapi/radio/trash/add',
      {
        alg: 'itembased',
        songId: Number(songId),
      },
      true,
    );
    return data.code === 200;
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private async weapiCall<T>(
    session: ProviderSession,
    endpoint: string,
    payload: Record<string, unknown>,
    useCsrf = false,
  ): Promise<T> {
    // The Electron side handles encryption + fetch; we just hand over the
    // raw payload. The login window's page carries MUSIC_U / __csrf cookies
    // and uses the browser's own fetch, so NetEase's anti-bot sees a real
    // browser request and lets it through.
    await this.proxy.ensureDiscovered();
    if (!this.proxy.isAvailable()) {
      throw new BadRequestException(
        '网易云未连接：请通过 Electron 启动应用 (npm run dev) 完成网易云登录',
      );
    }

    let status = 0;
    let text = '';
    try {
      const r = await this.proxy.fetch(endpoint, {
        payload,
        csrfToken: useCsrf ? session.csrfToken : undefined,
      });
      status = r.status;
      text = r.body;
    } catch (err) {
      // The Electron-side proxy returns 502 with a JSON body containing
      // `message` for any error. The proxy body is included in the error
      // message by netease-proxy.ts — extract it for the log.
      const msg = (err as Error).message;
      this.logger.warn(`proxy fetch failed: ${msg}`);
      if (msg.includes('window not open')) {
        throw new BadRequestException('请先在网易云登录窗口完成登录，再尝试听歌');
      }
      throw new BadRequestException(`网易云请求失败: ${msg}`);
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      this.logger.error(
        `netease response not JSON: ${text.slice(0, 200)}`,
      );
      throw new BadRequestException(
        `网易云返回非 JSON（status=${status}，bodyLen=${text.length}）`,
      );
    }
  }
}