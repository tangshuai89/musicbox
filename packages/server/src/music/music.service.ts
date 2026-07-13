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
import { LikeSyncQueue } from './like-sync.queue';

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
  /** mergedId → 在哪些平台心动了（含每平台的代表 trackId，用于 mergedId
   *  漂移时按曲目重合归一 + unlike 时兜底定位）。空对象 = 无 fan-out 记录。
   *  老格式（纯平台名数组）在 loadState 时被 coerce 成 trackId 缺省的条目。 */
  fanOut: Record<string, FanOutEntry[]>;
}

/** fanOut 记录里的单个平台条目。trackId 可能缺省（老格式迁移而来）。 */
export interface FanOutEntry {
  platform: MusicProvider;
  trackId?: string;
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
    private readonly likeSync: LikeSyncQueue,
  ) {
    // 把「同步一首歌的红心到某平台」的实际写操作交给同步队列的 worker 回调。
    // 队列负责合并去重 / 串行 / 退避重试；这里只提供「怎么写一次」的逻辑。
    this.likeSync.registerProcessor((session, platform, trackId, liked) =>
      this.syncLikeRemoteOnce(session, platform, trackId, liked),
    );
  }

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
    const fanOut: Record<string, FanOutEntry[]> = {};

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
        const isLikeableName = (p: unknown): p is MusicProvider =>
          // deezer 不再参与红心记账：过滤掉历史污染进 fanOut 的 deezer。
          p === 'qq' || p === 'netease' || p === 'spotify';
        for (const [k, v] of Object.entries(rawFanOut)) {
          if (!Array.isArray(v)) continue;
          const entries: FanOutEntry[] = [];
          for (const item of v) {
            // 老格式：平台名字符串；新格式：{platform, trackId}。
            if (isLikeableName(item)) {
              entries.push({ platform: item });
            } else if (
              item &&
              typeof item === 'object' &&
              isLikeableName((item as FanOutEntry).platform)
            ) {
              const e = item as FanOutEntry;
              entries.push({
                platform: e.platform,
                trackId:
                  typeof e.trackId === 'string' ? e.trackId : undefined,
              });
            }
          }
          if (entries.length) fanOut[k] = entries;
        }
      }
    }
    // 匿名源（deezer）无收藏概念：清掉历史 bug 污染进 liked 的记录，
    // 否则 deezer 电台会显示假红心、角标虚高。disliked 是合法的（电台过滤用），保留。
    for (const p of ANONYMOUS_PROVIDERS) {
      providers[p].liked.clear();
    }
    // fanOut GC：
    //  1) orphan：mergedId 对应的所有 platform 都没在 liked 集合里 → 删
    //     （理论上 fanOutLike 写时已经保证一致，但用户可能在外部 JSON
    //     改过 state.json，或者 unified-search mergedId 重建后变孤儿）
    //  2) LRU 上限：超过 FANOUT_MAX 就按插入顺序淘汰最早的
    // （unified track 是按"被心动"的顺序写入的，对应 Object 插入顺序）
    for (const [mergedId, entries] of Object.entries(fanOut)) {
      const stillLiked = entries.some(
        (e) => providers[e.platform].liked.size > 0,
      );
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
        // 踩 = 私人 FM「不喜欢」→ 走 fmTrash（垃圾桶），不是取消红心。
        await this.netease.fmTrash(ps, trackId);
      } catch (err) {
        this.logger.warn(
          `netease trash sync failed: ${(err as Error).message}`,
        );
      }
    }
    return { success: true };
  }

  /**
   * 统一 track 的「踩」：跨平台彻底不想再听这首。一次性做三件事——
   *  1. **取消跨平台红心**：走 fanOutLike(false)，按 state.fanOut[mergedId] 记录
   *     的平台真正 unlike（网易云用正确接口从「我喜欢的音乐」移除，见
   *     netease.unlike）+ 清 fanOut 记录 + 入队远端 unlike。这是本方法存在的
   *     核心理由——修「踩了一首 fan-out 的歌，其它平台红心还在、下次 detect
   *     又把它点亮/收藏回来」的复活循环。
   *  2. **本地 disliked 标记**（每平台一首）：电台补歌时过滤，不再刷到。
   *  3. **netease FM「不喜欢」**：best-effort 减少推荐（≠ 取消红心，第 1 步已做）。
   *
   * 与单平台 markDisliked 的区别：markDisliked 只动一个平台、且不碰红心；这里
   * 是跨平台，并且把收藏也一并清掉。幂等：未曾心动过的歌，第 1 步是 no-op。
   */
  async dislikeMerged(
    session: Session,
    mergedId: string,
    sources: Array<{ platform: MusicProvider; trackId: string }>,
  ): Promise<{ success: boolean }> {
    // 1. 取消跨平台红心（fanOutLike false 内部会 loadState/saveState + 入队，
    //    await 完成后其状态已落盘，下面的 loadState 读到的是清理后的态）。
    await this.fanOutLike(session, mergedId, sources, false);

    // 2. 本地 disliked 标记（每平台一首，和 fan-out「每平台一首」口径一致）。
    const state = this.loadState(session);
    const byPlatform = this.groupByPlatform(sources);
    const neteaseTargets: string[] = [];
    for (const [platform, trackIds] of byPlatform) {
      const trackId = trackIds[0];
      state.providers[platform].disliked.add(trackId);
      state.providers[platform].liked.delete(trackId); // fanOutLike 已清，双保险
      if (platform === 'netease') neteaseTargets.push(trackId);
    }
    this.saveState(session, state);

    // 3. netease FM「不喜欢」（减少推荐）。best-effort，失败不影响踩本身。
    const ps = session.providers.netease;
    if (ps?.musicU) {
      for (const trackId of neteaseTargets) {
        try {
          await this.netease.fmTrash(ps, trackId);
        } catch (err) {
          this.logger.warn(
            `netease fmTrash failed: ${(err as Error).message}`,
          );
        }
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
   * 该平台是否有「收藏 / 红心」概念。Deezer 是匿名源、没有 per-user library
   * （importLiked 也把它标记为 anonymous_no_user_likes），所以它**永不参与红心
   * 记账**：本地 liked 集合、fanOut 记录、角标数、远端同步队列一律跳过。
   *
   * 未登录的 likeable 平台（QQ/网易云/Spotify）不在此列——它们仍会记本地「意图」，
   * 登录后 detect 会补同步；只有 Deezer 是结构性排除。
   */
  private isLikeable(provider: MusicProvider): boolean {
    return !ANONYMOUS_PROVIDERS.has(provider);
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
    // Deezer 等匿名源无收藏概念：任何写红心都 no-op（bulletproof——无论哪条
    // 路径误传 deezer，都不会污染本地 liked 集合 / 角标）。
    if (!this.isLikeable(provider)) return false;
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

  /** 某平台当前 session 是否具备写红心的能力（有收藏概念 + 已登录）。
   *  Deezer 匿名没有 user 红心概念 → 永远 false，不会入同步队列。 */
  private canSyncLike(session: Session, provider: MusicProvider): boolean {
    if (!this.isLikeable(provider)) return false;
    const ps = session.providers[provider];
    switch (provider) {
      case 'qq':
        return !!ps?.qqCookie;
      case 'netease':
        return !!ps?.musicU;
      case 'spotify':
        return !!ps?.spotify;
      default:
        return false; // deezer
    }
  }

  /**
   * 同步一首歌的红心到某个平台的远端——**单次**写，供 LikeSyncQueue 的 worker
   * 回调。成功 → 乐观更新本地缓存；失败 → throw（队列据此退避重试）。
   *
   * 与旧的 fire-and-forget `syncLikeRemote` 的区别：
   *  - 不再自己吞异常，交给队列统一重试 + 记日志；
   *  - 平台返回 code≠0 / success=false 视为失败并 throw（旧实现静默丢弃）。
   *
   * 未登录 / Deezer 匿名 → 直接返回（视为「无需同步」，不 throw、不占重试）。
   */
  private async syncLikeRemoteOnce(
    session: Session,
    provider: MusicProvider,
    trackId: string,
    liked: boolean,
  ): Promise<void> {
    const ps = session.providers[provider];
    if (provider === 'qq') {
      if (!ps?.qqCookie) return;
      const ts = Date.now();
      const ok = liked
        ? await this.qq.like(ps, trackId, ts)
        : await this.qq.unlike(ps, trackId, ts);
      if (!ok) throw new Error(`qq setFav(${liked}) returned false`);
      this.updateLikedCache(session, 'qq', trackId, liked);
      return;
    }
    if (provider === 'netease') {
      if (!ps?.musicU) return;
      // like → 加入「我喜欢的音乐」；unlike → radio/like?like=false 真正移除
      // （不是 trash，见 netease.unlike 注释）。
      const ok = liked
        ? await this.netease.like(ps, trackId)
        : await this.netease.unlike(ps, trackId);
      if (!ok) {
        throw new Error(`netease ${liked ? 'like' : 'unlike'} returned false`);
      }
      this.updateLikedCache(session, 'netease', trackId, liked);
      return;
    }
    if (provider === 'spotify') {
      if (!ps?.spotify) return;
      const res = liked
        ? await this.spotify.like(ps, trackId)
        : await this.spotify.unlike(ps, trackId);
      if (!res.success) {
        throw new Error(`spotify ${liked ? 'like' : 'unlike'} failed`);
      }
      this.updateLikedCache(session, 'spotify', trackId, liked);
      return;
    }
    // deezer：匿名，无远端红心 → 无需同步。
  }

  /** 把「每平台一首」的红心同步目标推入队列（MQ 思路：合并去重 + 异步重试）。
   *  空目标直接忽略；不能写红心的平台（deezer/未登录）由入队方提前过滤。 */
  private enqueueLikeSync(
    session: Session,
    mergedId: string,
    liked: boolean,
    targets: Array<{ platform: MusicProvider; trackId: string }>,
  ): void {
    if (!targets.length) return;
    this.likeSync.enqueue({ session, mergedId, liked, targets });
  }

  // ── 跨平台红心检测 + 自动同步（切歌时用） ──────────────────

  /**
   * 每 session 每平台的「已红心 trackId 集合」缓存，避免每次切歌都拉整份
   * 收藏列表（QQ 1000+ 首）。TTL 内直接查集合。
   */
  private readonly likedCache = new Map<
    string,
    { set: Set<string>; at: number }
  >();
  private static readonly LIKED_CACHE_TTL_MS = 5 * 60 * 1000;

  private likedCacheKey(session: Session, provider: MusicProvider): string {
    return `${session.id}:${provider}`;
  }

  /** 乐观更新缓存（我们自己写了 like/unlike 之后）。 */
  private updateLikedCache(
    session: Session,
    provider: MusicProvider,
    trackId: string,
    liked: boolean,
  ): void {
    const entry = this.likedCache.get(this.likedCacheKey(session, provider));
    if (!entry) return; // 还没建缓存就不管，下次拉的时候是新鲜的
    if (liked) entry.set.add(trackId);
    else entry.set.delete(trackId);
  }

  /** 用一份已拉到的红心列表整体填充缓存。importLiked 拉全量收藏时顺手复用，
   *  避免紧接着的切歌 detect 又把 QQ 1000+ 首重拉一遍（importLiked 与 detect
   *  之前是各拉各的，互不复用）。 */
  private primeLikedCache(
    session: Session,
    provider: MusicProvider,
    trackIds: string[],
  ): void {
    this.likedCache.set(this.likedCacheKey(session, provider), {
      set: new Set(trackIds),
      at: Date.now(),
    });
    this.reconcileLiked(session, provider, new Set(trackIds));
  }

  /**
   * 两套真值源主动对账（#5）：拿到一份**新鲜的**远端红心全量后，把本地
   * `providers[p].liked` 收敛到「远端 ∪ 同步队列在途的 like − 在途的 unlike」。
   * 远端是权威；在途的乐观写还没落到远端，不能被当作失配抹掉。
   * 只在远端拉取**成功**时调用（失败保留本地状态，绝不误清）；未登录 /
   * Deezer 永远不会走到这里。顺带把 fanOut 记录里该平台已不再红心的条目
   * 移除（外部在官方 App 取消了收藏 → 角标不再多算）。
   */
  private reconcileLiked(
    session: Session,
    provider: MusicProvider,
    remote: Set<string>,
  ): void {
    if (!this.isLikeable(provider)) return;
    const state = this.loadState(session);
    const local = state.providers[provider].liked;

    const next = new Set(remote);
    for (const t of this.likeSync.pendingTargets(session.id)) {
      if (t.platform !== provider) continue;
      if (t.liked) next.add(t.trackId);
      else next.delete(t.trackId);
    }

    const unchanged =
      next.size === local.size && [...next].every((id) => local.has(id));
    if (unchanged) return;

    state.providers[provider].liked = next;
    for (const [mergedId, entries] of Object.entries(state.fanOut)) {
      const kept = entries.filter(
        (e) => e.platform !== provider || !e.trackId || next.has(e.trackId),
      );
      if (kept.length === entries.length) continue;
      if (kept.length) state.fanOut[mergedId] = kept;
      else delete state.fanOut[mergedId];
    }
    this.saveState(session, state);
    this.logger.log(
      `reconciled ${provider} liked: local ${local.size} → ${next.size}`,
    );
  }

  /**
   * 取某平台「已红心 trackId 集合」（带 TTL 缓存）。只对已登录平台有效，
   * 未登录 / Deezer 返回 null。
   */
  private async getLikedSet(
    session: Session,
    provider: MusicProvider,
  ): Promise<Set<string> | null> {
    const key = this.likedCacheKey(session, provider);
    const cached = this.likedCache.get(key);
    if (cached && Date.now() - cached.at < MusicService.LIKED_CACHE_TTL_MS) {
      return cached.set;
    }
    const ps = session.providers[provider];
    let set: Set<string> | null = null;
    try {
      if (provider === 'qq' && ps?.qqCookie) {
        set = await this.qq.fetchLikedMidSet(ps);
      } else if (provider === 'netease' && ps?.musicU) {
        const tracks = await this.netease.fetchLiked(ps, 2000);
        set = new Set(tracks.map((t) => t.id));
      } else if (provider === 'spotify' && ps?.spotify) {
        const tracks = await this.spotify.fetchLiked(ps, 2000);
        set = new Set(tracks.map((t) => t.id));
      }
    } catch (err) {
      this.logger.warn(
        `getLikedSet(${provider}) failed: ${(err as Error).message}`,
      );
    }
    if (set) {
      this.likedCache.set(key, { set, at: Date.now() });
      this.reconcileLiked(session, provider, set);
    }
    return set;
  }

  private async isLikedOn(
    session: Session,
    provider: MusicProvider,
    trackId: string,
  ): Promise<boolean> {
    const set = await this.getLikedSet(session, provider);
    return set?.has(trackId) ?? false;
  }

  /**
   * mergedId 漂移归一（#6）：mergedId 是“时长聚类 + 平台优先级”派生的，不同次
   * 搜索可能不同（某平台超时缺席 / 变体聚类不同 → main 换了）。fanOut 记录
   * 里存有每平台的代表 trackId：新来的 (mergedId, sources) 若与某条已有记录的
   * 任一 (platform, trackId) 重合，就认定是同一首歌，复用那条记录的 key——
   * 避免同一首歌在不同 mergedId 下分裂成两条记录（角标乱 / 踩了又复活）。
   * 无重合则原样返回。扫全表是 O(记录数×条目)，上限 FANOUT_MAX，纯内存可接受。
   */
  private canonicalMergedId(
    state: MusicSessionState,
    mergedId: string,
    sources: Array<{ platform: MusicProvider; trackId: string }>,
  ): string {
    if (state.fanOut[mergedId]) return mergedId;
    const wanted = new Set(sources.map((s) => `${s.platform}:${s.trackId}`));
    for (const [key, entries] of Object.entries(state.fanOut)) {
      if (
        entries.some(
          (e) => e.trackId && wanted.has(`${e.platform}:${e.trackId}`),
        )
      ) {
        return key;
      }
    }
    return mergedId;
  }

  /** 把新的 (platform, repId) 合并进 fanOut 条目列表：按平台去重，新 trackId
   *  补全老格式缺省的条目；只留 likeable 平台。 */
  private mergeFanOutEntries(
    prev: FanOutEntry[],
    next: FanOutEntry[],
  ): FanOutEntry[] {
    const byPlatform = new Map<MusicProvider, FanOutEntry>();
    for (const e of [...prev, ...next]) {
      if (!this.isLikeable(e.platform)) continue;
      const existing = byPlatform.get(e.platform);
      if (!existing) {
        byPlatform.set(e.platform, { ...e });
      } else if (!existing.trackId && e.trackId) {
        existing.trackId = e.trackId;
      }
    }
    return [...byPlatform.values()];
  }

  /**
   * 把 sources 按平台归组。统一搜索的合并 key 只按「歌名+歌手」归一化、没有
   * 时长门槛，所以一首歌（如 "If I Ain't Got You"）常把同平台的十几个变体
   * 版本塞进同一个 unified item 的 sources。fan-out 必须**每个平台最多一首**，
   * 否则会把十几个变体全部收藏（实测 bug：点一首收藏一大堆）。
   */
  private groupByPlatform(
    sources: Array<{ platform: MusicProvider; trackId: string }>,
  ): Map<MusicProvider, string[]> {
    const m = new Map<MusicProvider, string[]>();
    for (const s of sources) {
      const arr = m.get(s.platform) ?? [];
      arr.push(s.trackId);
      m.set(s.platform, arr);
    }
    return m;
  }

  /**
   * 切歌时调：查这首统一 track 在各平台的红心情况。
   *  - 任一平台已红心 → 把「其余有版权但还没红心」的平台也补上红心（fan-out），
   *    返回 liked=true + 现在红心的完整平台列表。
   *  - 全都没红心 → 返回 liked=false（不写任何东西）。
   *
   * **每个平台最多操作一首**：同平台若有多个变体源，只认/只写一首（优先已在
   * 收藏里的那个变体，否则第一首）——否则会把同名的一堆变体全收藏。
   * 只对已登录平台生效；Deezer / 未登录平台跳过。幂等：已红心的平台不重复写。
   */
  async detectLikedAndSync(
    session: Session,
    mergedId: string,
    sources: Array<{ platform: MusicProvider; trackId: string }>,
  ): Promise<{ liked: boolean; fannedOutTo: MusicProvider[] }> {
    const byPlatform = this.groupByPlatform(sources);

    // 每个平台：判断是否已红心（任一变体在收藏里就算），并选一个代表 trackId
    // （已收藏的那个变体优先，否则第一个）。**每平台只认一首**——统一搜索会把
    // 同名的一堆变体塞进同一 item，这里就是「不同步 20 个音源」的第一道闸。
    const perPlatform = await Promise.all(
      [...byPlatform.entries()].map(async ([platform, trackIds]) => {
        const set = await this.getLikedSet(session, platform);
        const likedId = set ? trackIds.find((id) => set.has(id)) : undefined;
        return {
          platform,
          liked: Boolean(likedId),
          canSync: this.canSyncLike(session, platform),
          repId: likedId ?? trackIds[0],
        };
      }),
    );

    const anyLiked = perPlatform.some((p) => p.liked);
    if (!anyLiked) {
      // 没有任何平台红心 → 只读检测，什么都不写。但如果这首歌有 fan-out
      // 记录（可能挂在漂移前的老 mergedId 下），说明它曾被心过但远端已被
      // 对账/取消——不在这里清理（交给 loadState 的 GC 启发式）。
      return { liked: false, fannedOutTo: [] };
    }

    // 有红心 → 检测本身只读；真正的「补齐其余平台」交给同步队列异步做。
    //  - 已红心的平台：确认态，反映到本地 + 计入角标；
    //  - 还没红心但能写的平台：乐观点亮本地 + 入队（每平台一首）后台补；
    //  - 不能写红心的平台（deezer/未登录）：既不入队也不计角标。
    const state = this.loadState(session);
    // mergedId 漂移归一（#6）：若同一首歌已挂在老 key 下，复用老 key。
    const canonicalId = this.canonicalMergedId(state, mergedId, sources);
    const fresh: FanOutEntry[] = [];
    const targets: Array<{ platform: MusicProvider; trackId: string }> = [];
    for (const p of perPlatform) {
      if (p.liked) {
        this.setLike(state, p.platform, p.repId, true);
        fresh.push({ platform: p.platform, trackId: p.repId });
      } else if (p.canSync) {
        this.setLike(state, p.platform, p.repId, true); // 乐观点亮
        fresh.push({ platform: p.platform, trackId: p.repId });
        targets.push({ platform: p.platform, trackId: p.repId });
      }
    }
    // 与已有 fanOut 记录**合并**而非覆盖：某次搜索可能没返回某平台的 source
    // （平台超时缺席 / 变体聚类不同），但那首歌在该平台仍是红心的——直接覆盖
    // 会把它从记录里抹掉、角标少算。合并保留旧平台（dislikeMerged 已 delete
    // 整条记录，所以这里不会复活被取消的红心）。只留 likeable 平台。
    const merged = this.mergeFanOutEntries(
      state.fanOut[canonicalId] ?? [],
      fresh,
    );
    state.fanOut[canonicalId] = merged;
    this.saveState(session, state);

    // 关键改动：远端写不再在切歌时内联执行，而是推入同步队列（MQ 思路）——
    // 每平台一首、失败自动重试、不阻塞播放。检测→入队→后台同步解耦。
    this.enqueueLikeSync(session, canonicalId, true, targets);

    return { liked: true, fannedOutTo: merged.map((e) => e.platform) };
  }

  async toggleLike(
    session: Session,
    provider: MusicProvider,
    trackId: string,
  ): Promise<{ success: boolean; liked: boolean }> {
    // Deezer 等匿名源没有收藏概念：点 ❤ 静默 no-op，不写本地、不入队、不点亮。
    if (!this.isLikeable(provider)) {
      return { success: true, liked: false };
    }
    const state = this.loadState(session);
    const wasLiked = this.applyLikeToggle(state, provider, trackId);
    this.saveState(session, state);
    // 远端同步走队列（best-effort + 重试，不阻塞本地）。单平台用一个稳定
    // 的合成 key，避免和统一搜索的 mergedId 撞车。
    this.enqueueLikeSync(session, `single:${provider}:${trackId}`, !wasLiked, [
      { platform: provider, trackId },
    ]);
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
   * 本地 like 集合**同步**更新（GET /music/liked 立即可见，e2e 依赖此），
   * 远端写则统一推入同步队列（每平台一首 + 失败重试），不内联阻塞。
   *
   * 实现要点：必须复用 setLike + 同步队列，**不能**直接调 toggleLike——
   * 因为 toggleLike 内部 loadState / saveState 会和 fanOut 的外层 saveState
   * 互相覆盖，导致"内层修改被外层旧 state 写回去"。
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
    // mergedId 漂移归一（#6）：若同一首歌已挂在老 key 下，复用老 key——
    // 保证“同一首歌只有一条 fan-out 记录”，unlike/踩能找到完整平台列表。
    const canonicalId = this.canonicalMergedId(state, mergedId, sources);
    /** 本次要推入同步队列的远端目标（每平台一首）。 */
    const targets: Array<{ platform: MusicProvider; trackId: string }> = [];

    if (liked) {
      // **每个平台只收藏一首**：统一搜索会把同名的一堆变体塞进同一 item 的
      // sources（无时长门槛），遍历全部会把十几个变体全收藏。按平台取第一首。
      const fresh: FanOutEntry[] = [];
      const byPlatform = this.groupByPlatform(sources);
      for (const [platform, trackIds] of byPlatform) {
        // Deezer 匿名无收藏概念 → 不记账、不计角标、不入队。
        if (!this.isLikeable(platform)) continue;
        const trackId = trackIds[0];
        fresh.push({ platform, trackId });
        // setLike 是幂等的：已心动的不会被翻回 unlike（本地即时可见）。
        this.setLike(state, platform, trackId, true);
        targets.push({ platform, trackId });
      }
      // 与已有记录合并：这次 sources 里没列的旧平台也保留——避免“老
      // fan-out 记录被覆盖”丢状态；历史污染的 deezer 在合并时被过滤。
      state.fanOut[canonicalId] = this.mergeFanOutEntries(
        state.fanOut[canonicalId] ?? [],
        fresh,
      );
    } else {
      // 取消心动：按之前 fanOut 记录的平台列表 unlike（幂等）。定位 trackId
      // 优先用记录里存的代表 trackId（漂移后本次 sources 可能缺某平台），
      // 没有再兜底用本次 sources 里同平台的第一首。
      const toUnlike = state.fanOut[canonicalId] ?? [];
      for (const entry of toUnlike) {
        if (!this.isLikeable(entry.platform)) continue; // 跳过历史 deezer 记录
        const trackId =
          entry.trackId ??
          sources.find((s) => s.platform === entry.platform)?.trackId;
        if (!trackId) continue;
        this.setLike(state, entry.platform, trackId, false);
        targets.push({ platform: entry.platform, trackId });
      }
      delete state.fanOut[canonicalId];
    }

    this.saveState(session, state);
    // 远端写走同步队列：合并去重、每平台一首、失败重试，不阻塞本次响应。
    this.enqueueLikeSync(session, canonicalId, liked, targets);
    // 返回"全集"——liked=true 时就是当前 fan-out 列表；liked=false 时空数组
    const fannedOutTo = liked
      ? (state.fanOut[canonicalId] ?? []).map((e) => e.platform)
      : [];
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
   * 当前实现：
   *   - NetEase: 三步拉"我喜欢的音乐"歌单（/api/v6/playlist/detail）
   *   - QQ: 两步拉"我喜欢"（splcloud/getmyfav → qzone/cdinfo_byids_cp），
   *     详见 QqMusicProvider.fetchLiked
   *   - Spotify: 已登录 → /me/tracks；未登录 → not_logged_in
   *   - Deezer: 匿名模式无 user 概念
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
        this.primeLikedCache(session, 'netease', tracks.map((t) => t.id));
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

    // QQ: 两步拉取（getmyfav dirid=201 → songlist detail），详见
    // QqMusicProvider.fetchLiked。失败不阻塞其他平台。
    try {
      const ps = session.providers.qq;
      if (!ps?.qqCookie) {
        sourceResults.push({
          provider: 'qq',
          count: 0,
          error: 'not_logged_in',
        });
      } else {
        // 上限 2000（fetchLiked 内部按 1000/页分页）—— 覆盖绝大多数用户的
        // 收藏规模；1093 首的用户不会被 1000 截断。
        const tracks = await this.qq.fetchLiked(ps, 2000);
        sourceResults.push({ provider: 'qq', count: tracks.length });
        allTracks.push(...tracks);
        this.primeLikedCache(session, 'qq', tracks.map((t) => t.id));
      }
    } catch (err) {
      this.logger.warn(`qq fetchLiked failed: ${(err as Error).message}`);
      sourceResults.push({
        provider: 'qq',
        count: 0,
        error: (err as Error).message,
      });
    }

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
        this.primeLikedCache(session, 'spotify', tracks.map((t) => t.id));
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