import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { MusicProvider, MUSIC_PROVIDERS } from '../common/provider';
import { StorageService } from '../common/storage';
import { ProviderSession, Session } from '../common/session';
import { QqMusicProvider, QqQuality } from './qq.provider';
import { NeteaseMusicProvider } from './netease.provider';
import { DeezerMusicProvider } from './deezer.provider';
import { SpotifyMusicProvider } from './spotify.provider';
import { type LyricLine } from '../common/lyrics';
import type {
  UnifiedSearchResult,
  UnifiedSearchItem,
  ProviderSearchRaw,
} from './types';
import {
  buildUnifiedItems,
  dedupTracks,
  normalizeKey,
} from './search.util';
import { MatchService } from '../match/match.service';
import { withTimeout } from '../common/timeout';

/** unified search 单平台硬超时——5s。超过这个时间视为该平台缺席，
 *  不阻塞其他平台。Spotify 偶发 504 较常见，所以这个时间不能太松。 */
const UNIFIED_SEARCH_TIMEOUT_MS = 5_000;

/** fanOut 状态上限——超过这个数 loadState 时按插入顺序淘汰最早的。
 *  5000 对应重度用户 1-2 年的累计 ❤ 量，再多就是滥用。 */
const FANOUT_MAX = 5_000;

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

/** Heart fan-out 在每个 session 下的完整状态。
 *  - providers: 老的 per-provider queue/liked/disliked（不变）
 *  - fanOut: mergedId → "这个统一 track 已经在哪些平台心动了"（fan-out 实现基础）
 *
 *  fanOut 只在 liked=true 路径被写入；liked=false 反向清除时按这里记录的
 *  平台列表 unlike——保证"只动我们之前心过的"，不会误清空用户原本单平台
 *  心过的同一首歌。 */
export interface MusicSessionState {
  providers: Record<MusicProvider, ProviderState>;
  /** mergedId → 在哪些平台心动了。空对象 = 没有任何 fan-out 记录。 */
  fanOut: Record<string, MusicProvider[]>;
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
    private readonly spotify: SpotifyMusicProvider,
    private readonly match: MatchService,
  ) {}

  private stateKey(sessionId: string): string {
    return `music:${sessionId}`;
  }

  private loadState(session: Session): MusicSessionState {
    const fresh = (): ProviderState => ({
      queue: [],
      liked: new Set<string>(),
      disliked: new Set<string>(),
    });
    // 始终以完整默认骨架起步，再叠加持久化数据，保证三个 provider 都存在。
    const providers: Record<MusicProvider, ProviderState> = {
      qq: fresh(),
      netease: fresh(),
      deezer: fresh(),
      spotify: fresh(),
    };
    const fanOut: Record<string, MusicProvider[]> = {};

    const persisted = this.storage.get<Record<string, unknown>>(
      this.stateKey(session.id),
    );
    if (persisted) {
      // 兼容老格式：持久化里直接是 {qq: {queue, liked, ...}, netease: ..., deezer: ...}
      // 新格式：在 providers 之外多一层 fanOut 字段。
      const persistedProviders =
        (persisted as { providers?: Record<string, unknown> }).providers ??
        (persisted as unknown as Record<string, unknown>);
      for (const key of ['qq', 'netease', 'deezer', 'spotify'] as MusicProvider[]) {
        const s = persistedProviders[key] as Partial<ProviderState> | undefined;
        if (!s) continue;
        // 稳健还原：无论持久化里是数组、旧版 Set→{} 空对象、还是 undefined，
        // 一律 coerce 成 Set / 数组，避免 `.has is not a function`。
        providers[key] = {
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
      // fanOut 是新加的，老持久化文件没这个字段是正常的。
      const rawFanOut = (persisted as { fanOut?: unknown }).fanOut;
      if (rawFanOut && typeof rawFanOut === 'object') {
        for (const [k, v] of Object.entries(rawFanOut)) {
          if (Array.isArray(v)) {
            fanOut[k] = v.filter(
              (p): p is MusicProvider =>
                p === 'qq' || p === 'netease' || p === 'deezer' || p === 'spotify',
            );
          }
        }
      }
    }
    // fanOut GC：
    //  1) orphan：mergedId 对应的所有 platform 都没在 liked 集合里 → 删
    //     （理论上 fanOutLike 写时已经保证一致，但用户可能在外部 JSON
    //     改过 state.json，或者 unified-search mergedId 重建后变孤儿）
    //  2) LRU 上限：超过 FANOUT_MAX 就按插入顺序淘汰最早的
    // （unified track 是按"被心动"的顺序写入的，对应 Object 插入顺序）
    for (const [mergedId, platforms] of Object.entries(fanOut)) {
      const stillLiked = platforms.some((p) => providers[p].liked.size > 0);
      // 粗粒度判断：只要该平台有任意 liked 就算 mergedId 仍可能有效。
      // 实际"哪首歌在哪个平台 liked"是精确匹配；这里做廉价启发式，
      // 误删概率低（删了用户重新 heart 即可）。
      const orphan = !stillLiked;
      if (orphan) {
        delete fanOut[mergedId];
      }
    }
    const keys = Object.keys(fanOut);
    if (keys.length > FANOUT_MAX) {
      const drop = keys.length - FANOUT_MAX;
      for (let i = 0; i < drop; i++) delete fanOut[keys[i]];
    }
    return { providers, fanOut };
  }

  private saveState(session: Session, state: MusicSessionState): void {
    const serializable = {
      providers: {
        qq: {
          ...state.providers.qq,
          liked: [...state.providers.qq.liked],
          disliked: [...state.providers.qq.disliked],
        },
        netease: {
          ...state.providers.netease,
          liked: [...state.providers.netease.liked],
          disliked: [...state.providers.netease.disliked],
        },
        deezer: {
          ...state.providers.deezer,
          liked: [...state.providers.deezer.liked],
          disliked: [...state.providers.deezer.disliked],
        },
        spotify: {
          ...state.providers.spotify,
          liked: [...state.providers.spotify.liked],
          disliked: [...state.providers.spotify.disliked],
        },
      },
      fanOut: state.fanOut,
    };
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
    state: MusicSessionState,
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
    const psState = state.providers[provider];
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
    const psState = state.providers[provider];
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
    // refill 成功但产出 0 首（例如整批都被 disliked 过滤掉，或平台返回空）
    // → queue 仍空。此时 shift() 会返回 undefined，被 `!` 断言成 Track 传给
    // 前端造成"空曲目"。显式返回占位，别让 undefined 漏出去。
    if (psState.queue.length === 0) {
      return this.placeholder(provider, '暂无更多曲目');
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
    if (provider === 'spotify') {
      return this.spotify.getStreamPath(ps!, trackId);
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
    } else if (provider === 'spotify') {
      const ps = this.requireProviderSession(session, 'spotify');
      tracks = await this.spotify.search(ps!, kw);
    } else {
      throw new BadRequestException(`搜索暂不支持 ${provider}`);
    }

    const state = this.loadState(session);
    const { liked, disliked } = state.providers[provider];
    return tracks
      .filter((t) => !disliked.has(t.id))
      .map((t) => ({
        ...t,
        audioUrl: this.streamPath(t),
        liked: liked.has(t.id),
      }));
  }

  /**
   * 跨平台统一搜索。同时查 QQ/网易云/Deezer，合并去重后返回统一结果。
   * 单个平台挂了不影响其他平台——部分结果仍然返回，失败的平台标记 error。
   *
   * 去重: ISRC 不可用时用"歌名+歌手"标准化匹配。
   * 排序: bestSource 优先（qq > netease > deezer，且 hasCopyright）。
   */
  async searchUnified(
    session: Session,
    keyword: string,
    page = 1,
    pageSize = 20,
  ): Promise<UnifiedSearchResult> {
    const kw = keyword.trim();
    if (!kw || kw.length > 100) {
      throw new BadRequestException('q 参数无效：1-100 字符');
    }
    // 输入清洗：page / pageSize 来自 query string，可能是 "abc"/"-1"/"999"。
    // 不防御性 cast 直接传到 slice 会产生 NaN slice / 负 length 数组。
    const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
    const effectivePageSize = Number.isFinite(pageSize)
      ? Math.min(50, Math.max(1, Math.floor(pageSize)))
      : 20;

    // 并行搜索三个平台，单个超时 5 秒不阻塞其他平台。
    const results = await Promise.all(
      MUSIC_PROVIDERS.map((p) => this.searchOneProvider(session, p, kw)),
    );

    // 合并所有平台的搜索结果到一个扁平数组。
    const allTracks: { track: Track; platform: MusicProvider }[] = [];
    for (const r of results) {
      for (const t of r.tracks) {
        allTracks.push({ track: t, platform: r.platform });
      }
    }

    // 去重: 歌名+歌手标准化 → 第一个出现的 track 作为主记录。
    const deduped = dedupTracks(allTracks);

    // 构建 UnifiedSearchItem，每个 item 聚合各平台的 source。
    const items = buildUnifiedItems(deduped, allTracks);

    // 分页（服务端分页，不依赖前端截断）。
    const total = items.length;
    const start = (safePage - 1) * effectivePageSize;
    const paged = items.slice(start, start + effectivePageSize);

    // 记录失败平台（不影响返回，前端可选展示）。
    const errors = results.filter((r) => r.error);
    if (errors.length > 0) {
      this.logger.warn(
        `unified search "${kw}" partial: ${errors.map((e) => `${e.platform}(${e.error})`).join(', ')}`,
      );
    }

    return { q: kw, total, page: safePage, pageSize: effectivePageSize, items: paged };
  }

  /** 查单个平台，带 5 秒超时。失败返回空 track + error。 */
  private async searchOneProvider(
    session: Session,
    provider: MusicProvider,
    keyword: string,
  ): Promise<ProviderSearchRaw> {
    return withTimeout(
      () => this.doSearchOneProvider(session, provider, keyword),
      UNIFIED_SEARCH_TIMEOUT_MS,
      () =>
        this.logger.warn(
          `unified search "${keyword}" on ${provider} timed out (>${UNIFIED_SEARCH_TIMEOUT_MS}ms)`,
        ),
    ).then(
      (res) => res ?? { platform: provider, tracks: [], total: 0, error: 'timeout' },
      // 兜底：doSearchOneProvider 契约上不 throw，但如果它意外 reject
      // （withTimeout 只 race、不 catch），这里必须把 reject 转成 error 结果。
      // 绝不能让单平台的 reject 冒泡到 searchUnified 的 Promise.all——否则
      // 一个平台没登录就会把整个统一搜索打成 404/500（回归 bug）。
      (err: unknown) => ({
        platform: provider,
        tracks: [],
        total: 0,
        error: (err as Error)?.message ?? 'error',
      }),
    );
  }

  /** 真正发请求的逻辑。剥离出来便于在 searchOneProvider 外面套 withTimeout。
   *  **契约：本方法绝不 throw**——某平台未登录 / 报错时返回带 error 的空结果，
   *  保证统一搜索永远是"部分结果 > 全盘失败"。 */
  private async doSearchOneProvider(
    session: Session,
    provider: MusicProvider,
    keyword: string,
  ): Promise<ProviderSearchRaw> {
    try {
      let tracks: Track[];
      if (provider === 'qq') {
        tracks = await this.qq.search(session.providers.qq ?? {}, keyword, 30);
      } else if (provider === 'netease') {
        // 网易云搜索需要登录态；未登录时 requireProviderSession 抛 404。
        const ps = this.requireProviderSession(session, 'netease');
        tracks = await this.netease.search(ps!, keyword, 30);
      } else if (provider === 'spotify') {
        // Spotify 搜索需要登录态；未登录时 requireProviderSession 抛 404。
        const ps = this.requireProviderSession(session, 'spotify');
        tracks = await this.spotify.search(ps!, keyword, 30);
      } else {
        tracks = await this.deezer.search(
          session.providers.deezer ?? {},
          keyword,
          30,
        );
      }
      // 统一搜索结果里 sources[].url 要带可播放的代理路径——provider.search()
      // 返回的 track.audioUrl 可能是空（QQ/网易云 URL 短期过期，播放时由
      // getStreamUrl 重新拿），所以这里替换成后端代理的相对路径，前端拼 base
      // 后直接当 <audio src> 用。Deezer 的 audioUrl 已是 http 完整 URL（30s
      // 预览），保留原值。
      tracks = tracks.map((t) => ({
        ...t,
        audioUrl:
          provider === 'deezer' && t.audioUrl && t.audioUrl.startsWith('http')
            ? t.audioUrl
            : this.streamPath(t),
      }));
      return { platform: provider, tracks, total: tracks.length };
    } catch (err) {
      // 未登录（NotFoundException）/ 平台报错 → 记一条 error 返回空结果。
      this.logger.warn(
        `unified search "${keyword}" on ${provider} failed: ${(err as Error).message}`,
      );
      return {
        platform: provider,
        tracks: [],
        total: 0,
        error: (err as Error).message,
      };
    }
  }

  /** 歌名+歌手标准化: 全角→半角、去空格、去标点、全小写。
   *  实际逻辑在 search.util.ts，方便白盒测试。 */
  private normalizeKey(title: string, artist: string): string {
    return normalizeKey(title, artist);
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

  async markDisliked(
    session: Session,
    provider: MusicProvider,
    trackId: string,
  ): Promise<{ success: boolean }> {
    const state = this.loadState(session);
    state.providers[provider].disliked.add(trackId);
    state.providers[provider].liked.delete(trackId);
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
    const psState = state.providers[provider];
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
   * 在给定 state 上「反转」某平台的 like 状态，返回反转前是否已 like。
   * 纯内存操作（不 IO）。单平台 toggleLike 用它——用户点 ❤ 是"翻转"语义。
   */
  private applyLikeToggle(
    state: MusicSessionState,
    provider: MusicProvider,
    trackId: string,
  ): boolean {
    const psState = state.providers[provider];
    const wasLiked = psState.liked.has(trackId);
    if (wasLiked) {
      psState.liked.delete(trackId);
    } else {
      psState.liked.add(trackId);
    }
    return wasLiked;
  }

  /**
   * 在给定 state 上把某平台的 like 状态「设为」目标值（幂等），返回是否
   * 发生了改变。fanOutLike 用它——fan-out 是"确保为目标态"语义，不是翻转：
   * 重复 like 一首已心动的歌不应把它 unlike。
   *
   * （回归测试 like.e2e #4 曾因 fanOutLike 误用 applyLikeToggle 翻转导致
   * "重复 like → 实际 unlike" 的 bug。）
   */
  private setLike(
    state: MusicSessionState,
    provider: MusicProvider,
    trackId: string,
    liked: boolean,
  ): boolean {
    const psState = state.providers[provider];
    const has = psState.liked.has(trackId);
    if (liked && !has) {
      psState.liked.add(trackId);
      return true;
    }
    if (!liked && has) {
      psState.liked.delete(trackId);
      return true;
    }
    return false; // 已是目标态，无改变
  }

  /** 把 liked 状态同步到远端平台（best-effort，失败仅记录日志）。 */
  private async syncLikeRemote(
    session: Session,
    provider: MusicProvider,
    trackId: string,
    newLiked: boolean,
  ): Promise<void> {
    // NetEase 和 Spotify 都有公开 ❤ API，这里做远端同步；QQ / Deezer 的
    // radio-like / favorites API 都要登录态 + 签名，只在本地记录即可。
    if (provider === 'netease') {
      const ps = session.providers[provider];
      if (!ps?.musicU) return;
      try {
        if (newLiked) {
          await this.netease.like(ps, trackId);
        } else {
          // netease 取消 ❤ = 移到 trash，netease.unlike 已实现
          await this.netease.unlike(ps, trackId);
        }
      } catch (err) {
        this.logger.warn(
          `netease like sync failed: ${(err as Error).message}`,
        );
      }
      return;
    }
    if (provider === 'spotify') {
      const ps = session.providers[provider];
      if (!ps?.spotify) return;
      try {
        if (newLiked) {
          await this.spotify.like(ps, trackId);
        } else {
          await this.spotify.unlike(ps, trackId);
        }
      } catch (err) {
        this.logger.warn(
          `spotify like sync failed: ${(err as Error).message}`,
        );
      }
    }
  }

  async toggleLike(
    session: Session,
    provider: MusicProvider,
    trackId: string,
  ): Promise<{ success: boolean; liked: boolean }> {
    const state = this.loadState(session);
    const wasLiked = this.applyLikeToggle(state, provider, trackId);
    this.saveState(session, state);
    // 同步到远端（best-effort，失败不影响本地）
    void this.syncLikeRemote(session, provider, trackId, !wasLiked);
    return { success: true, liked: !wasLiked };
  }

  /**
   * Heart fan-out：把"心动"一次性写到一个统一 track 的所有平台 source。
   *
   * liked=true：对每个 source 反转 like 状态，收集成功（wasLiked=false → 写入）
   *   的平台，写入 state.fanOut[mergedId]（作为未来 unlike 的幂等依据）。
   * liked=false：按 state.fanOut[mergedId] 里的平台列表反写 unlike（保证幂等
   *   ——只动我们之前心过的）。
   *
   * 单平台失败不阻塞其他平台；fannedOutTo 列出真正被这次操作影响的平台。
   *
   * 实现要点：必须复用 applyLikeToggle + syncLikeRemote，**不能**直接调
   * toggleLike——因为 toggleLike 内部 loadState / saveState 会和 fanOut
   * 的外层 saveState 互相覆盖，导致"内层修改被外层旧 state 写回去"。
   */
  async fanOutLike(
    session: Session,
    mergedId: string,
    sources: Array<{ platform: MusicProvider; trackId: string }>,
    liked: boolean,
  ): Promise<{
    success: boolean;
    liked: boolean;
    /**
     * 当前 mergedId 在所有平台上心动过的**完整列表**——也就是
     * `state.fanOut[mergedId]` 的真值。UI 拿这个当 ❤ 角标数。
     *
     * 之前实现里 fannedOutTo 只含"本次 flip"的平台，但用户可能之前
     * 单平台心过同一个 track，那部分不计入——导致 UI 显示 "1❤" 实际
     * 是 2 平台已 ❤ 的歧义。改成"全集"消除歧义。
     */
    fannedOutTo: MusicProvider[];
  }> {
    const state = this.loadState(session);
    /** 本次调用实际 flip 状态的平台（用于 sync remote / 日志）。 */
    const flipped: MusicProvider[] = [];

    if (liked) {
      // 当前 mergedId 已心动的平台（保持）。这次 sources 里没列的旧
      // 平台也保留——避免"老 fan-out 记录被覆盖"丢状态。
      const current = new Set(state.fanOut[mergedId] ?? []);
      for (const src of sources) {
        current.add(src.platform);
        try {
          // setLike 是幂等的：已心动的不会被翻回 unlike
          const changed = this.setLike(state, src.platform, src.trackId, true);
          if (changed) flipped.push(src.platform);
          void this.syncLikeRemote(session, src.platform, src.trackId, true);
        } catch (err) {
          this.logger.warn(
            `fan-out like failed (${src.platform}/${src.trackId}): ${(err as Error).message}`,
          );
        }
      }
      state.fanOut[mergedId] = [...current];
    } else {
      // 取消心动：按之前 fanOut 记录的平台列表 unlike（幂等）。
      const toUnlike = state.fanOut[mergedId] ?? [];
      for (const platform of toUnlike) {
        const src = sources.find((s) => s.platform === platform);
        if (!src) continue;
        try {
          const changed = this.setLike(state, platform, src.trackId, false);
          if (changed) flipped.push(platform);
          void this.syncLikeRemote(session, platform, src.trackId, false);
        } catch (err) {
          this.logger.warn(
            `fan-out unlike failed (${platform}/${src.trackId}): ${(err as Error).message}`,
          );
        }
      }
      delete state.fanOut[mergedId];
    }

    this.saveState(session, state);
    // 返回"全集"——liked=true 时就是当前 fan-out 列表；liked=false 时空数组
    const fannedOutTo = liked ? state.fanOut[mergedId] ?? [] : [];
    return { success: true, liked, fannedOutTo };
  }

  /** 当前 session 中某 mergedId 是否已被 fan-out 心动过。 */
  isFanOutLiked(state: MusicSessionState, mergedId: string): boolean {
    return (state.fanOut[mergedId]?.length ?? 0) > 0;
  }

  private libraryKey(sessionId: string): string {
    return `library:${sessionId}`;
  }

  /**
   * 拉取各平台"我的喜欢" → 合并为统一库 → 持久化到 .storage。
   *
   * 当前实现：仅 NetEase 真正能拉（"我喜欢的音乐" 走 /api/v6/playlist/detail）。
   * QQ 收藏需要签名（vkey/g_tk），本轮不做；Deezer 走匿名模式无 user 概念。
   * 后续接入 Spotify / QQ 后在这里加 case。
   *
   * 单平台失败不阻塞——返回的 `sources` 数组里如实记录每个平台的拉取状态
   * （{provider, count, error?}），前端可以分别展示。
   */
  async importLiked(session: Session): Promise<{
    items: UnifiedSearchItem[];
    sources: Array<{
      provider: MusicProvider;
      count: number;
      error?: string;
    }>;
    importedAt: number;
  }> {
    const sourceResults: Array<{
      provider: MusicProvider;
      count: number;
      error?: string;
    }> = [];
    const allTracks: Track[] = [];

    // NetEase
    try {
      const ps = session.providers.netease;
      if (!ps?.musicU) {
        sourceResults.push({
          provider: 'netease',
          count: 0,
          error: 'not_logged_in',
        });
      } else {
        const tracks = await this.netease.fetchLiked(ps, 1000);
        sourceResults.push({ provider: 'netease', count: tracks.length });
        allTracks.push(...tracks);
      }
    } catch (err) {
      this.logger.warn(
        `netease fetchLiked failed: ${(err as Error).message}`,
      );
      sourceResults.push({
        provider: 'netease',
        count: 0,
        error: (err as Error).message,
      });
    }

    // QQ: 公开 ❤ / 收藏 API 都需要签名，本轮留空
    sourceResults.push({
      provider: 'qq',
      count: 0,
      error: 'qq_favorites_requires_signature_not_yet_implemented',
    });

    // Spotify: 已登录 → 走 /me/tracks；未登录 → not_logged_in
    try {
      const ps = session.providers.spotify;
      if (!ps?.spotify) {
        sourceResults.push({
          provider: 'spotify',
          count: 0,
          error: 'not_logged_in',
        });
      } else {
        const tracks = await this.spotify.fetchLiked(ps, 1000);
        sourceResults.push({ provider: 'spotify', count: tracks.length });
        allTracks.push(...tracks);
      }
    } catch (err) {
      this.logger.warn(
        `spotify fetchLiked failed: ${(err as Error).message}`,
      );
      sourceResults.push({
        provider: 'spotify',
        count: 0,
        error: (err as Error).message,
      });
    }

    // Deezer: 匿名模式无 user 概念
    sourceResults.push({
      provider: 'deezer',
      count: 0,
      error: 'deezer_anonymous_no_user_likes',
    });

    // 合并去重（走 MatchService.mergeLibrary → 内部复用 buildUnifiedItems）
    const items = this.match.mergeLibrary(allTracks);

    const importedAt = Date.now();
    this.storage.set(this.libraryKey(session.id), {
      importedAt,
      items,
      sources: sourceResults,
    });

    return { items, sources: sourceResults, importedAt };
  }

  /** 读取最近一次 import 的库（无则返回 null）。 */
  getLibrary(session: Session): {
    items: UnifiedSearchItem[];
    sources: Array<{
      provider: MusicProvider;
      count: number;
      error?: string;
    }>;
    importedAt: number;
  } | null {
    const stored = this.storage.get<{
      importedAt: number;
      items: UnifiedSearchItem[];
      sources: Array<{ provider: MusicProvider; count: number; error?: string }>;
    }>(this.libraryKey(session.id));
    if (!stored) return null;
    return stored;
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