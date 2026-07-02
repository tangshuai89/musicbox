import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { MusicProvider } from '../common/provider';
import { StorageService } from '../common/storage';
import { ProviderSession, Session } from '../common/session';
import { QqMusicProvider, QqQuality } from './qq.provider';
import { NeteaseMusicProvider } from './netease.provider';
import { DeezerMusicProvider } from './deezer.provider';
import { type LyricLine } from '../common/lyrics';

export interface Track {
  id: string;
  provider: MusicProvider;
  title: string;
  artist: string;
  album: string;
  coverUrl: string;
  audioUrl: string; // 这里是 /music/stream/{provider}/{id} 相对路径，不是真实 URL
  duration: number;
  liked: boolean;
  /** QQ 取流用的 media_mid（可能 ≠ songmid），高音质 filename 需要它。 */
  mediaMid?: string;
}

interface ProviderState {
  queue: Track[];
  liked: Set<string>;
  disliked: Set<string>;
}

/** Some providers (Deezer) work without any auth — they don't need a
 * ProviderSession. We treat them as "always available". */
const ANONYMOUS_PROVIDERS: ReadonlySet<MusicProvider> = new Set<MusicProvider>([
  'deezer',
]);

@Injectable()
export class MusicService {
  private readonly logger = new Logger(MusicService.name);

  constructor(
    private readonly storage: StorageService,
    private readonly qq: QqMusicProvider,
    private readonly netease: NeteaseMusicProvider,
    private readonly deezer: DeezerMusicProvider,
  ) {}

  private stateKey(sessionId: string): string {
    return `music:${sessionId}`;
  }

  private loadState(session: Session): Record<MusicProvider, ProviderState> {
    const fresh = (): ProviderState => ({
      queue: [],
      liked: new Set<string>(),
      disliked: new Set<string>(),
    });
    // 始终以完整默认骨架起步，再叠加持久化数据，保证三个 provider 都存在。
    const state: Record<MusicProvider, ProviderState> = {
      qq: fresh(),
      netease: fresh(),
      deezer: fresh(),
    };

    const persisted = this.storage.get<Record<string, unknown>>(
      this.stateKey(session.id),
    );
    if (persisted) {
      for (const key of ['qq', 'netease', 'deezer'] as MusicProvider[]) {
        const s = persisted[key] as Partial<ProviderState> | undefined;
        if (!s) continue;
        // 稳健还原：无论持久化里是数组、旧版 Set→{} 空对象、还是 undefined，
        // 一律 coerce 成 Set / 数组，避免 `.has is not a function`。
        state[key] = {
          queue: Array.isArray(s.queue) ? (s.queue as Track[]) : [],
          liked: new Set(
            Array.isArray(s.liked) ? (s.liked as unknown as string[]) : [],
          ),
          disliked: new Set(
            Array.isArray(s.disliked)
              ? (s.disliked as unknown as string[])
              : [],
          ),
        };
      }
    }
    return state;
  }

  private saveState(session: Session, state: Record<MusicProvider, ProviderState>): void {
    const serializable = {
      qq: { ...state.qq, liked: [...state.qq.liked], disliked: [...state.qq.disliked] },
      netease: {
        ...state.netease,
        liked: [...state.netease.liked],
        disliked: [...state.netease.disliked],
      },
      deezer: {
        ...state.deezer,
        liked: [...state.deezer.liked],
        disliked: [...state.deezer.disliked],
      },
    } as unknown as Record<MusicProvider, ProviderState>;
    this.storage.set(this.stateKey(session.id), serializable);
  }

  private requireProviderSession(
    session: Session,
    provider: MusicProvider,
  ): ProviderSession | undefined {
    if (ANONYMOUS_PROVIDERS.has(provider)) return undefined;
    const ps = session.providers[provider];
    if (!ps) {
      throw new NotFoundException(`Not logged in to ${provider}`);
    }
    return ps;
  }

  private async refillQueue(
    session: Session,
    provider: MusicProvider,
    state: Record<MusicProvider, ProviderState>,
  ): Promise<void> {
    const ps = this.requireProviderSession(session, provider);
    let batch: Track[];
    if (provider === 'qq') {
      if (!ps || !this.qq.isConfigured(ps)) {
        throw new BadRequestException('QQ session not configured');
      }
      batch = await this.qq.fetchRadioBatch(ps);
    } else if (provider === 'netease') {
      if (!ps || !this.netease.isConfigured(ps)) {
        throw new BadRequestException('NetEase session not configured');
      }
      batch = await this.netease.fetchRadioBatch(ps);
    } else {
      // Deezer / future anonymous providers. Honour the user's preset
      // (set via /music/deezer/preset) and default to 'all' = international
      // pop. Storing it in the session keeps the picker persistent.
      const preset = session.prefs?.deezerPreset ?? 'all';
      batch = await this.deezer.fetchRadioBatch(ps as ProviderSession, preset);
    }
    const psState = state[provider];
    batch = batch
      .filter((t) => !psState.disliked.has(t.id))
      .map((t) => {
        // Deezer's preview URL is a hot-linkable mp3. We expose it
        // directly (instead of routing through /music/stream/... like
        // QQ/NetEase) because the audio element then loads it with the
        // browser's own headers, and the cross-origin request is
        // allowed by Deezer's CDN (Access-Control-Allow-Origin: *).
        // The hdnea=… signature isn't strictly required to be honoured
        // for the 30s clip — the server-side redirect path was an
        // over-engineered workaround that turned out to break autoplay.
        const audioUrl = provider === 'deezer' && t.audioUrl && t.audioUrl.startsWith('http')
          ? t.audioUrl
          : this.streamPath(t);
        return {
          ...t,
          audioUrl,
          liked: psState.liked.has(t.id),
        };
      });
    psState.queue.push(...batch);
    this.saveState(session, state);
  }

  /** Get the next track from the radio. Auto-refills if the queue is empty. */
  async getNextTrack(session: Session, provider: MusicProvider): Promise<Track> {
    const state = this.loadState(session);
    const psState = state[provider];
    while (psState.queue.length === 0) {
      try {
        await this.refillQueue(session, provider, state);
      } catch (err) {
        this.logger.warn(
          `refill failed (session=${session.id.slice(0, 8)}…, provider=${provider}): ${(err as Error).message}`,
        );
        // 兜底：返回一首占位让前端不卡死
        return this.placeholder(provider, (err as Error).message);
      }
      if (psState.queue.length === 0) break;
    }
    const track = psState.queue.shift()!;
    this.saveState(session, state);
    return track;
  }

  /**
   * Resolve a stream URL by track ID. We re-fetch from the provider every time
   * because QQ/NetEase URLs expire within minutes. Deezer's preview URLs are
   * already inlined into the track payload, but we still route through
   * here for a consistent interface.
   */
  async getStreamUrl(
    session: Session,
    provider: MusicProvider,
    trackId: string,
    opts?: { mediaMid?: string; quality?: QqQuality },
  ): Promise<string> {
    const ps = this.requireProviderSession(session, provider);
    if (provider === 'qq') {
      return this.qq.getStreamPath(
        ps!,
        trackId,
        opts?.mediaMid,
        opts?.quality ?? 'standard',
      );
    }
    if (provider === 'netease') {
      return this.netease.getStreamPath(ps!, trackId, opts?.quality ?? 'standard');
    }
    return this.deezer.getStreamPath(ps!, trackId);
  }

  /**
   * 按关键词搜索（当前仅 QQ）。搜索不强制登录——用户可以先搜再登录；
   * 但真正播放（getStreamUrl）需要登录态。返回的 audioUrl 统一是后端
   * 代理相对路径，前端拿不到 raw URL。
   */
  async searchTracks(
    session: Session,
    provider: MusicProvider,
    keyword: string,
  ): Promise<Track[]> {
    const kw = keyword.trim();
    if (!kw) return [];

    let tracks: Track[];
    if (provider === 'qq') {
      const ps = session.providers.qq; // 可能未登录（QQ 搜索允许匿名）
      tracks = await this.qq.search(ps ?? {}, kw);
    } else if (provider === 'netease') {
      // 网易云搜索需要登录态（cookie）。未登录时 requireProviderSession 抛 404。
      const ps = this.requireProviderSession(session, 'netease');
      tracks = await this.netease.search(ps!, kw);
    } else {
      throw new BadRequestException(`搜索暂不支持 ${provider}`);
    }

    const state = this.loadState(session);
    const { liked, disliked } = state[provider];
    return tracks
      .filter((t) => !disliked.has(t.id))
      .map((t) => ({
        ...t,
        audioUrl: this.streamPath(t),
        liked: liked.has(t.id),
      }));
  }

  /** 后端代理相对路径；QQ 带上 media_mid 以便播放时选高音质。 */
  private streamPath(track: Track): string {
    const base = `/music/stream/${track.provider}/${encodeURIComponent(
      track.id,
    )}`;
    return track.provider === 'qq' && track.mediaMid
      ? `${base}?mm=${encodeURIComponent(track.mediaMid)}`
      : base;
  }

  async toggleLike(
    session: Session,
    provider: MusicProvider,
    trackId: string,
  ): Promise<{ success: boolean; liked: boolean }> {
    const state = this.loadState(session);
    const psState = state[provider];
    const wasLiked = psState.liked.has(trackId);
    if (wasLiked) {
      psState.liked.delete(trackId);
    } else {
      psState.liked.add(trackId);
    }
    this.saveState(session, state);

    // 同步到远端（best-effort，失败不影响本地）
    const ps = session.providers[provider];
    if (provider === 'netease' && ps?.musicU) {
      try {
        if (!wasLiked) await this.netease.like(ps, trackId);
        // 取消红心不需要远程通知
      } catch (err) {
        this.logger.warn(
          `netease like sync failed: ${(err as Error).message}`,
        );
      }
    }

    return { success: true, liked: !wasLiked };
  }

  async markDisliked(
    session: Session,
    provider: MusicProvider,
    trackId: string,
  ): Promise<{ success: boolean }> {
    const state = this.loadState(session);
    state[provider].disliked.add(trackId);
    state[provider].liked.delete(trackId);
    this.saveState(session, state);

    const ps = session.providers[provider];
    if (provider === 'netease' && ps?.musicU) {
      try {
        await this.netease.unlike(ps, trackId);
      } catch (err) {
        this.logger.warn(
          `netease trash sync failed: ${(err as Error).message}`,
        );
      }
    }
    return { success: true };
  }

  async getLikedTracks(
    session: Session,
    provider: MusicProvider,
  ): Promise<Track[]> {
    const state = this.loadState(session);
    const psState = state[provider];
    // 简化：返回 liked 集合里的占位记录，真实元数据需要按需拉
    return [...psState.liked].map((id) => ({
      id,
      provider,
      title: '(已收藏)',
      artist: '',
      album: '',
      coverUrl: '',
      audioUrl: `/music/stream/${provider}/${encodeURIComponent(id)}`,
      duration: 0,
      liked: true,
    }));
  }

  /**
   * Fetch synced lyrics for a track. Returns null when the provider
   * doesn't expose lyrics (QQ — public lyric API is gated behind
   * signature) or when the track has no lyric data (instrumental,
   * newer releases, region restrictions).
   *
   * Per-provider quirks:
   *  - NetEase: GET /api/song/lyric returns a flat { lyric, tlyric }
   *    structure where `lyric` is the LRC body. We parse it into
   *    LyricLine[] (translation strings tacked onto the matching
   *    line are out of scope for v1).
   *  - Deezer: /track/{id} includes `lyrics` (plain text only, no
   *    timestamps) when the rights-holder uploaded them. We try to
   *    match the Deezer `track_lyrics` style of unsynced lyrics via
   *    a separate endpoint that does exist but returns the timestamp
   *    format we want. Falls back to null otherwise.
   *  - QQ: GET c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg with a
   *    y.qq.com Referer returns the LRC body (trackId here is the
   *    songmid). Works anonymously; the session cookie is passed through
   *    when present but isn't required.
   */
  async getLyrics(
    session: Session,
    provider: MusicProvider,
    trackId: string,
  ): Promise<LyricLine[] | null> {
    try {
      if (provider === 'netease') {
        const ps = this.requireProviderSession(session, provider);
        if (!ps) return null;
        return await this.netease.getLyrics(ps, trackId);
      }
      if (provider === 'deezer') {
        return await this.deezer.getLyrics(trackId);
      }
      // QQ: lyrics work anonymously; pass the session cookie if we have
      // one (harmless) but fall back to an empty session otherwise.
      return await this.qq.getLyrics(session.providers.qq ?? {}, trackId);
    } catch (err) {
      this.logger.warn(
        `lyrics fetch failed (${provider}/${trackId}): ${(err as Error).message}`,
      );
      return null;
    }
  }

  /** When the provider is unavailable, return a minimal placeholder so the UI
   * doesn't appear broken. */
  private placeholder(
    provider: MusicProvider,
    reason: string,
  ): Track {
    return {
      id: `placeholder-${Date.now()}`,
      provider,
      title: '暂时没有可播放的曲目',
      artist: reason,
      album: '',
      coverUrl: '',
      audioUrl: '',
      duration: 0,
      liked: false,
    };
  }
}