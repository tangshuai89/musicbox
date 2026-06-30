import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { MusicProvider } from '../common/provider';
import { StorageService } from '../common/storage';
import { ProviderSession, Session } from '../common/session';
import { QqMusicProvider } from './qq.provider';
import { NeteaseMusicProvider } from './netease.provider';
import { DeezerMusicProvider } from './deezer.provider';

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
    const persisted = this.storage.get<Record<MusicProvider, ProviderState>>(
      this.stateKey(session.id),
    );
    if (persisted) {
      for (const key of Object.keys(persisted) as MusicProvider[]) {
        const s = persisted[key];
        if (Array.isArray((s.liked as unknown))) {
          s.liked = new Set(s.liked as unknown as string[]);
        }
        if (Array.isArray((s.disliked as unknown))) {
          s.disliked = new Set(s.disliked as unknown as string[]);
        }
      }
      return persisted;
    }
    return {
      qq: { queue: [], liked: new Set(), disliked: new Set() },
      netease: { queue: [], liked: new Set(), disliked: new Set() },
      deezer: { queue: [], liked: new Set(), disliked: new Set() },
    };
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
          : `/music/stream/${provider}/${encodeURIComponent(t.id)}`;
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
        this.logger.warn(`refill failed: ${(err as Error).message}`);
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
  ): Promise<string> {
    const ps = this.requireProviderSession(session, provider);
    if (provider === 'qq') {
      return this.qq.getStreamPath(ps!, trackId);
    }
    if (provider === 'netease') {
      return this.netease.getStreamPath(ps!, trackId);
    }
    return this.deezer.getStreamPath(ps!, trackId);
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