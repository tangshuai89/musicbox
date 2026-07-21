import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import type { UseSpotifyWpsPlayer } from './useSpotifyWpsPlayer';
import {
  fetchNextTrack,
  toggleLike,
  fanOutLike,
  detectLiked,
  dislike,
  dislikeMerged,
  pickPlayableTrack,
  findEquivalentSource,
  API_ORIGIN,
} from '../api';
import type {
  Track,
  MusicProvider,
  QqQuality,
  UnifiedSearchItem,
  UnifiedSourceInfo,
} from '../api';
import {
  readStoredProvider,
  writeStoredProvider,
  clearStoredProvider,
  readStoredQuality,
  writeStoredQuality,
  readStoredDeezerPreset,
  writeStoredDeezerPreset,
} from '../lib/storage';
import { useCoverArt } from './useCoverArt';

/**
 * 跨平台降级的优先级（镜像 server 的 PLAY_PRIORITY）：某首歌的当前源播放
 * 失败（无版权 / 取流 502 → <audio> code=4）时，按这个顺序在同一首统一
 * track 的其它平台 source 里挑下一个能播的。QQ/网易云是完整曲流优先，
 * Deezer/Spotify 是 30s 预览兜底。
 */
const FALLBACK_PRIORITY: MusicProvider[] = [
  'qq',
  'netease',
  'deezer',
  'spotify',
];

/**
 * 「完整曲流」平台：QQ / 网易云给的是全曲。Deezer/Spotify(非 Premium) 本身就是
 * 30s 预览，**不能**当作 VIP 试听升级的目标（换过去还是 30s，白换）。
 */
const FULL_SONG_PROVIDERS: MusicProvider[] = ['qq', 'netease'];

/** VIP 试听判定阈值：实际音频 ≤ TRIAL_MAX_SEC 秒、且元数据全长比它长 GAP 以上，
 *  就认定当前源是被 VIP 锁成的试听片段（QQ 试听常见 30s / 60s）。
 *  - MAX 放到 120：60s 试听的 audio.duration 常是 60.x（曾用 60 卡边界漏检）；
 *    真正的判据是 GAP，MAX 只挡"元数据错得离谱"的极端，放宽无副作用。
 *  - GAP=45 大到没有正常歌会误判：元数据是真实全长，正常播放时 audio.duration
 *    与它只差 1-2s；差 45s+ 只可能是被截断的试听。 */
const TRIAL_MAX_SEC = 120;
const TRIAL_GAP_SEC = 45;

/**
 * Parse a page of unified search / reco items into a playable queue, dropping
 * items with no playable source and keeping `tracks` ALIGNED with `unifiedItems`
 * (same index → same song) so per-song ❤ detect / fan-out maps correctly.
 * Shared by playSearch (initial queue) and loadNextTrack (reco next batch).
 */
function parsePlayableQueue(items: UnifiedSearchItem[]): {
  tracks: Track[];
  unifiedItems: UnifiedSearchItem[];
} {
  const tracks: Track[] = [];
  const unifiedItems: UnifiedSearchItem[] = [];
  for (const it of items) {
    const t = pickPlayableTrack(it);
    if (t) {
      tracks.push(t);
      unifiedItems.push(it);
    }
  }
  return { tracks, unifiedItems };
}

/**
 * The playback core: everything that touches the <audio> element, the Web
 * Audio analyser graph, the track/queue state, and provider/quality
 * switching. This is deliberately one cohesive hook — the pieces share the
 * same refs and closures and are riddled with hard-won ordering fixes
 * (epoch cancellation, effect dep arrays, the search-open freeze), so
 * splitting them further would only re-introduce the closure traps the
 * comments below guard against.
 *
 * `audioRef` is owned by the caller (App) and shared with useVolume + the
 * <audio> JSX + the progress/lyrics seek paths.
 */
export function usePlayer(
  audioRef: RefObject<HTMLAudioElement | null>,
  /**
   * Optional Premium Spotify Web Playback SDK bridge (v2), passed as a ref
   * to break the circular dependency (App needs player.provider to decide
   * whether WPS is enabled, and usePlayer needs WPS to route transport).
   * When wpsRef.current is ready AND the current track is from spotify,
   * transport commands (play / pause / resume) route through WPS instead of
   * the HTML <audio> element. For non-spotify tracks or when WPS isn't ready,
   * the existing <audio> path is used unchanged.
   */
  wpsRef?: RefObject<UseSpotifyWpsPlayer | null>,
) {
  const [provider, setProvider] = useState<MusicProvider | null>(() => {
    const params = new URLSearchParams(window.location.search);
    const fromCallback = params.get('provider');
    if (fromCallback === 'qq' || fromCallback === 'netease') return fromCallback;
    return readStoredProvider();
  });
  const [track, setTrack] = useState<Track | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [fanOutCount, setFanOutCount] = useState<number>(0);
  // 本首歌是否因请求音质是 VIP 试听、被自动降到标准音质播放（UI 如实展示）。
  const [trialFellBack, setTrialFellBack] = useState(false);

  const [qqQuality, setQqQuality] = useState<QqQuality>(() => readStoredQuality());
  // presentTrack reads the current quality via ref to avoid a dep on it.
  const qqQualityRef = useRef<QqQuality>(qqQuality);
  qqQualityRef.current = qqQuality;

  const [deezerPreset, setDeezerPreset] = useState<string>(() =>
    readStoredDeezerPreset(),
  );

  // Search-mode client queue. Non-empty → loadNextTrack advances within the
  // results instead of hitting the server radio. Held in a ref so
  // loadNextTrack's closure doesn't read a stale value. Unified search adds
  // unifiedItems + mergedId for the heart fan-out path.
  // `unifiedItems` is kept ALIGNED with `tracks` (both index by idx) — playSearch
  // drops non-playable items from BOTH so idx maps to the right unified item.
  // mergedId is derived per-track as unifiedItems[idx].id (not a fixed field).
  const queueRef = useRef<{
    tracks: Track[];
    idx: number;
    unifiedItems?: UnifiedSearchItem[];
    /**
     * Reco queues only: fetch the next batch when the last track ends, instead
     * of looping back to #1. Returns the raw unified items for the next batch
     * (parsed + appended by loadNextTrack). Search / liked-library queues leave
     * this undefined and keep the classic looping behaviour.
     */
    loadMore?: () => Promise<UnifiedSearchItem[]>;
  } | null>(null);
  // Guards the async detect-liked result: only apply if the queue is still on
  // the same unified track we detected for (avoids a stale detect clobbering a
  // newer song's ❤ state after a fast skip).
  const activeMergedIdRef = useRef<string | undefined>(undefined);
  // On source switch with a track playing, skip one provider-change auto-load
  // so the current song keeps playing until it ends / the user skips.
  const skipAutoLoadRef = useRef(false);
  // For quality switches: jump back to the original position after reload.
  const pendingSeekRef = useRef<number | null>(null);
  // WPS: 最近一次通过 WPS play() 送出的 spotify track id。用来区分
  // "切到新歌 → play(newUri)" 和 "同一首暂停后恢复 → resume()"。
  const wpsPlayedIdRef = useRef<string | null>(null);

  // 跨平台自动降级用的三件套：
  //  - currentUnifiedRef：当前在播这首「统一 track」（含各平台 source）。
  //    radio 单平台 track 没有 unified item → undefined，降级直接跳过。
  //  - triedPlatformsRef：本首歌已经试过的平台，防止在 sources 间来回死循环。
  //  - trackRef：最新 track 的镜像，降级构造 fallback track 时读当前平台 /
  //    保留红心态，避免把 track 塞进各 effect 的依赖数组。
  const currentUnifiedRef = useRef<UnifiedSearchItem | undefined>(undefined);
  const triedPlatformsRef = useRef<Set<MusicProvider>>(new Set());
  const trackRef = useRef<Track | null>(null);
  trackRef.current = track;
  // 本首歌是否已经问过服务端要跨平台等价源（每首歌只问一次，避免死循环）。
  // 用于「unified item 只有 netease 一个 source、netease 又挂了」时向服务端
  // 实时匹配一个 QQ/其它平台的可播放源。换新歌时在 presentTrack 里重置。
  const serverEquivTriedRef = useRef(false);
  // VIP 30s 试听自动升级用：
  //  - trialServerTriedRef：本首歌是否已就「试听」问过服务端等价源（每首一次）。
  //    与 serverEquivTriedRef 分开——试听升级和 code=4 降级是两条独立触发。
  //  - trialEvaluatedRef：当前这个音源是否已做过试听判定（每次上源一次，防
  //    onLoadedMetadata/onDurationChange 重复触发；每次 presentTrack 重置）。
  const trialServerTriedRef = useRef(false);
  const trialEvaluatedRef = useRef(false);
  // 本首歌是否已就"试听"降到过标准音质重试（每首一次）。很多 VIP 试听其实是
  // "无损/极高是 VIP、标准免费全曲"，降标准通常直接拿到全曲；每首歌只降一次，
  // 标准仍是试听才继续跨平台。换新歌时在 presentTrack 里重置。
  const forcedStandardRef = useRef(false);

  // Web Audio graph — created lazily on the first play (autoplay policy gates
  // AudioContext + MediaElementSource to user gestures). `analyser` is state
  // (not a ref) because the bass RAF effect below reads it as a dependency
  // and needs a real re-render when the graph comes online.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const mediaSrcRef = useRef<MediaElementAudioSourceNode | null>(null);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);

  const { bgLayerRef, coverBackdropRef, presentCover, presentPlaceholder } =
    useCoverArt();

  /**
   * Lazily attach a Web Audio analyser to the live <audio> element.
   * source → analyser → ctx.destination. createMediaElementSource can only
   * be called ONCE per element and permanently reroutes its output through
   * the graph — so we MUST connect to ctx.destination or playback goes
   * silent. Guarded with mediaSrcRef so a second call is a no-op.
   */
  const ensureAudioGraph = useCallback((): AnalyserNode | null => {
    if (audioCtxRef.current && analyser) {
      // Already built — just make sure the context is running (it gets
      // suspended when the window loses focus on some OSes).
      if (audioCtxRef.current.state === 'suspended') {
        void audioCtxRef.current.resume().catch((e) => {
          console.warn('[audio] context resume() rejected:', e);
        });
      }
      return analyser;
    }
    const audioEl = audioRef.current;
    if (!audioEl) return null;
    try {
      const Ctor: typeof AudioContext =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      const ctx = new Ctor();
      const src = mediaSrcRef.current ?? ctx.createMediaElementSource(audioEl);
      mediaSrcRef.current = src;
      const node = ctx.createAnalyser();
      node.fftSize = 256;
      node.smoothingTimeConstant = 0.72;
      src.connect(node);
      node.connect(ctx.destination);
      audioCtxRef.current = ctx;
      setAnalyser(node);
      if (ctx.state === 'suspended') {
        void ctx.resume().catch((e) => {
          console.warn('[audio] initial context resume() rejected:', e);
        });
      }
      return node;
    } catch (e) {
      console.error('[audio] failed to build audio graph', e);
      return null;
    }
  }, [analyser, audioRef]);

  // Present a Track to the player: resolve absolute audioUrl, swap cover,
  // set play intent. Shared by the server radio and search-result paths.
  // `unified`（可选）是这首歌的跨平台源信息：传了它，播放失败时才能自动
  // 降级到其它平台。radio 单平台 track 不传。
  const presentTrack = useCallback(
    (next: Track, unified?: UnifiedSearchItem) => {
      // 换歌就重置「已试平台」；同一首歌的跨平台降级复用 presentTrack 但要
      // 保留记录（否则 netease→qq 失败后又把 netease 当没试过 → 死循环）。
      const isNewSong =
        !unified || unified.id !== currentUnifiedRef.current?.id;
      currentUnifiedRef.current = unified;
      if (isNewSong) {
        triedPlatformsRef.current = new Set();
        serverEquivTriedRef.current = false;
        trialServerTriedRef.current = false;
        forcedStandardRef.current = false;
      }
      triedPlatformsRef.current.add(next.provider);
      // 每次上源（含跨平台切换）都要对新源重做一次试听判定。
      trialEvaluatedRef.current = false;
      // 新上的源默认按用户选的音质播——清掉"试听回退到标准"的标记。standard
      // 重载走的是 setTrack（不经 presentTrack），所以那个标记能一直保留到换歌 /
      // 跨平台换源为止（那两种才经过这里）。
      setTrialFellBack(false);
      // 每次上歌/换源都先清掉上一次的报错——切到下一首/降级成功后不该再
      // 残留旧的 "音频加载失败" 弹窗。真正失败会在 onError 里重新 setError。
      setError(null);
      let audioUrl =
        next.audioUrl && next.audioUrl.startsWith('/')
          ? API_ORIGIN + next.audioUrl
          : next.audioUrl;
      // QQ / NetEase: append the selected quality to the stream URL.
      if (
        (next.provider === 'qq' || next.provider === 'netease') &&
        audioUrl.includes(`/music/stream/${next.provider}/`)
      ) {
        const sep = audioUrl.includes('?') ? '&' : '?';
        audioUrl += `${sep}q=${qqQualityRef.current}`;
      }
      // Spotify Premium + WPS ready：清空 audioUrl，否则 <audio> 会同时播
      // 30s 预览代理，跟 WPS 全曲流冲突（双声道）。WPS 就绪判断懒读 ref。
      if (next.provider === 'spotify' && wpsRef?.current?.wpsReady) {
        audioUrl = '';
      }
      if (next.coverUrl) {
        // presentCover reads the ref.current INSIDE its async work, so it
        // writes onto the freshly-remounted cover div (key={track.id} makes
        // the cover unmount/remount on every track change).
        presentCover(next.coverUrl);
      } else {
        // No artwork → generate a stable gradient placeholder from the song
        // identity. Also overwrites the previous track's cover in the blurred
        // bg-layer (which presentCover would otherwise leave stale).
        presentPlaceholder(
          next.title || next.artist ? `${next.title}·${next.artist}` : next.id,
        );
      }
      setTrack({ ...next, audioUrl });
      setCurrentTime(0);
      const audio = audioRef.current;
      if (audio) audio.dataset.wantPlay = '1';
      setPlaying(true);
      // NOTE: do NOT build the audio graph here — it requires a real user
      // gesture. The graph is built lazily on the first play (onPlay /
      // handlePlayPause). Until then audio plays through the default path.
    },
    [presentCover, presentPlaceholder, audioRef, wpsRef],
  );

  /** 用一个跨平台 source + 展示元数据构造 fallback Track 并重播。同一首歌
   *  → presentTrack 里 isNewSong=false，triedPlatformsRef / serverEquivTriedRef
   *  累加不清零，避免死循环。 */
  const presentFallbackSource = useCallback(
    (
      src: UnifiedSourceInfo,
      unified: UnifiedSearchItem | undefined,
      display: { title: string; artist: string; album: string; coverUrl: string; duration: number },
    ) => {
      const fallback: Track = {
        id: src.trackId,
        provider: src.platform,
        title: display.title,
        artist: display.artist,
        album: display.album,
        coverUrl: display.coverUrl,
        audioUrl: src.url,
        duration: display.duration,
        // 跨平台是同一首歌，红心态一致 —— 保留，别被降级重置成未收藏。
        liked: trackRef.current?.liked ?? false,
        mediaMid: src.mediaMid,
      };
      console.warn(
        `[audio] "${display.title}" 在 ${trackRef.current?.provider} 播放失败，` +
          `自动切到 ${src.platform} 源`,
      );
      presentTrack(fallback, unified);
    },
    [presentTrack],
  );

  /**
   * 当前源播放失败时，自动降级到同一首歌的其它平台源。两级：
   *  1. **item 内**：unified.sources 里还没试过的平台（快，无网络）。
   *  2. **服务端实时匹配**：item 只有一个 source（如 netease-only 库条目），
   *     netease 又挂了 → 问服务端去其余已登录平台搜同名同时长的等价源
   *     （每首歌只问一次）。这修的正是「突然好想你只有网易云源、code=4 后无源
   *     可退」的盲点。
   * 成功切源 → true（onError 不报错）；彻底无源 → false，交调用方报错。
   */
  const tryFallbackSource = useCallback(async (): Promise<boolean> => {
    const unified = currentUnifiedRef.current;
    const cur = trackRef.current;
    if (!unified || !cur) return false;
    const tried = triedPlatformsRef.current;
    const display = {
      title: unified.title,
      artist: unified.artist,
      album: unified.album,
      coverUrl: unified.coverUrl,
      duration: unified.duration,
    };

    // 1) item 内其它平台 source。
    const inItem = FALLBACK_PRIORITY.filter((p) => !tried.has(p))
      .map((p) =>
        unified.sources.find((s) => s.platform === p && s.hasCopyright),
      )
      .find((s): s is UnifiedSourceInfo => Boolean(s));
    if (inItem) {
      presentFallbackSource(inItem, unified, display);
      return true;
    }

    // 2) 服务端实时跨平台匹配（每首歌一次）。
    if (serverEquivTriedRef.current) return false;
    serverEquivTriedRef.current = true;
    const songId = unified.id; // 快照：await 期间用户可能切歌，回来要校验。
    try {
      const src = await findEquivalentSource(cur.provider, {
        title: unified.title,
        artist: unified.artist,
        duration: unified.duration,
      });
      // 竞态守卫：await 期间已切到别的歌 → 丢弃结果。
      if (currentUnifiedRef.current?.id !== songId) return false;
      if (src && !triedPlatformsRef.current.has(src.platform)) {
        presentFallbackSource(src, currentUnifiedRef.current, display);
        return true;
      }
    } catch {
      // 网络/匹配失败 → 静默走报错。
    }
    return false;
  }, [presentFallbackSource]);

  /**
   * VIP 30s 试听自动升级：QQ/网易云对 VIP 独占曲目会返回 30s 试听片段——音频
   * **实际时长 ≈30s，但元数据是全长**。检测到后去**其它完整曲流平台**（qq/网易
   * 云）搜同名等价源换过去，把 30s 试听升级成全曲。与 tryFallbackSource 的区别：
   *  - 触发点不同：那个是 code=4 播放失败；这个是播成功但被锁成试听片段。
   *  - 目标平台受限：只认 FULL_SONG_PROVIDERS——Deezer/Spotify 的 30s 是正常预览，
   *    换过去还是 30s，白换，所以排除（服务端可能返回 spotify，这里拒掉）。
   * 换源后新音源的 onLoadedMetadata 会再判一次：还是试听 → 试下一个完整平台；
   * 完整平台都试过仍是试听（两边都 VIP 锁）→ 保持现状，无能为力。
   */
  const tryUpgradeFromTrial = useCallback(async (): Promise<void> => {
    const unified = currentUnifiedRef.current;
    const cur = trackRef.current;
    // 需要 unified item 才能安全升级：radio 单平台 track 没有 unified，换源时
    // presentTrack 会把它当新歌重置 triedPlatformsRef → qq↔netease 来回死循环。
    // 与 tryFallbackSource 同款约束（radio 本就没有跨平台降级）。
    if (!unified || !cur) return;
    const tried = triedPlatformsRef.current;
    const display = {
      title: unified.title,
      artist: unified.artist,
      album: unified.album,
      coverUrl: unified.coverUrl,
      // 用元数据全长——换到新源后若仍是试听，其 audio.duration 会再次远短于它。
      duration: unified.duration,
    };

    // 1) item 内其它「完整曲流」平台的源（快，无网络）。要求 !vipLocked——换到
    //    另一个已知 VIP 锁的源没意义（还是试听），跳过它。
    const inItem = FULL_SONG_PROVIDERS.filter((p) => !tried.has(p))
      .map((p) =>
        unified.sources.find(
          (s) => s.platform === p && s.hasCopyright && !s.vipLocked,
        ),
      )
      .find((s): s is UnifiedSourceInfo => Boolean(s));
    if (inItem) {
      console.warn(
        `[audio] "${display.title}" 疑似 ${cur.provider} 30s 试听，` +
          `升级到 ${inItem.platform} 全曲源`,
      );
      presentFallbackSource(inItem, unified, display);
      return;
    }

    // 2) 服务端实时匹配（每首歌一次），只接受完整曲流平台的结果。
    if (trialServerTriedRef.current) return;
    trialServerTriedRef.current = true;
    const songId = unified.id; // 快照：await 期间可能切歌，回来要校验。
    try {
      const src = await findEquivalentSource(cur.provider, {
        title: display.title,
        artist: display.artist,
        duration: display.duration,
      });
      // 竞态守卫：await 期间切了别的歌 → 丢弃。
      if (currentUnifiedRef.current?.id !== songId) return;
      if (
        src &&
        FULL_SONG_PROVIDERS.includes(src.platform) &&
        !triedPlatformsRef.current.has(src.platform)
      ) {
        console.warn(
          `[audio] "${display.title}" 30s 试听，服务端匹配到 ${src.platform} ` +
            `全曲源，升级`,
        );
        presentFallbackSource(src, currentUnifiedRef.current, display);
      }
    } catch {
      // 匹配失败 → 保持现状（继续放 30s 试听，best-effort）。
    }
  }, [presentFallbackSource]);

  /**
   * 检测到 VIP 试听片段后的处理，两步（先便宜的、再兜底）：
   *  1. **同平台降标准音质重试**：QQ/网易云很多"试听"其实是"无损/极高是 VIP、
   *     标准免费全曲"（本次两张截图都是「无损」）。降到标准通常直接拿到全曲，
   *     还留在用户选的平台。每首歌只降一次（forcedStandardRef）。
   *  2. **跨平台换完整曲流源**：标准也被锁成试听（整首 VIP）→ 去别的完整平台。
   * 换源/重载后新音源的 onLoadedMetadata 会再判一次，形成"标准→跨平台"的接力。
   */
  const handleTrialDetected = useCallback(async () => {
    const cur = trackRef.current;
    if (!cur) return;
    // 1) 同平台降标准音质重试。
    if (
      (cur.provider === 'qq' || cur.provider === 'netease') &&
      qqQualityRef.current !== 'standard' &&
      !forcedStandardRef.current
    ) {
      forcedStandardRef.current = true;
      // 去掉已有的 q=xxx 再拼 q=standard（复用 changeQuality 的写法）。
      const base = cur.audioUrl
        .replace(/[?&]q=[^&]*/, '')
        .replace(/[?&]$/, '');
      const sep = base.includes('?') ? '&' : '?';
      console.warn(
        `[audio] "${cur.title}" 疑似 ${qqQualityRef.current} 音质 VIP 试听，` +
          `先降到标准音质同平台重试`,
      );
      // 让重载后的标准源重新做试听判定（setTrack 改 audioUrl 不走 presentTrack）。
      trialEvaluatedRef.current = false;
      setTrialFellBack(true); // UI 如实展示"标准(试听回退)"
      setTrack((prev) =>
        prev ? { ...prev, audioUrl: `${base}${sep}q=standard` } : prev,
      );
      return;
    }
    // 2) 跨平台换完整曲流源。
    await tryUpgradeFromTrial();
  }, [tryUpgradeFromTrial]);

  /**
   * 切歌后的红心检测：查这首统一 track 在各平台的红心情况；任一平台已 ❤ →
   * 后端补齐其余平台 → 前端把 ❤ 点亮 + 角标显示平台数。用 activeMergedIdRef
   * 防止快速切歌时旧结果盖掉新歌状态。
   */
  const detectAndApplyLiked = useCallback(
    async (unified: UnifiedSearchItem | undefined) => {
      activeMergedIdRef.current = unified?.id;
      if (!unified) {
        setFanOutCount(0);
        return;
      }
      const sources = unified.sources
        .filter((s) => s.hasCopyright)
        .map((s) => ({ platform: s.platform, trackId: s.trackId }));
      if (!sources.length) {
        setFanOutCount(0);
        return;
      }
      try {
        const r = await detectLiked(unified.id, sources, {
          title: unified.title,
          artist: unified.artist,
          duration: unified.duration,
        });
        // 只在还停留在这首歌时应用（防快速切歌竞态）。
        if (activeMergedIdRef.current !== unified.id) return;
        setFanOutCount(r.liked ? r.fannedOutTo.length : 0);
        setTrack((prev) => (prev ? { ...prev, liked: r.liked } : prev));
      } catch {
        // 检测失败不影响播放，静默。
      }
    },
    [],
  );

  /**
   * 重检当前这首歌的 liked/fanOut 状态。用于后台跨平台匹配（LikeSyncQueue
   * discover）补齐后重新拿到更新后的 fannedOutTo，让 fanOutCount 角标准确。
   */
  const refreshLikedState = useCallback(() => {
    void detectAndApplyLiked(currentUnifiedRef.current);
  }, [detectAndApplyLiked]);

  const loadNextTrack = useCallback(async () => {
    if (!provider) return;
    // Search / reco / liked-library mode: advance within the results queue.
    const q = queueRef.current;
    if (q && q.tracks.length) {
      // Reco queue reached the end → pull the next AI batch and continue,
      // rather than looping back to #1 (the classic search-queue behaviour).
      const atEnd = q.idx >= q.tracks.length - 1;
      if (atEnd && q.loadMore) {
        setLoading(true);
        try {
          const more = await q.loadMore();
          // Race guard: user may have skipped / switched source / started a new
          // search during the await — only mutate if this is still the queue.
          if (queueRef.current !== q) return;
          const parsed = parsePlayableQueue(more);
          if (parsed.tracks.length) {
            q.tracks.push(...parsed.tracks);
            (q.unifiedItems ??= []).push(...parsed.unifiedItems);
            q.idx += 1;
            presentTrack(q.tracks[q.idx], q.unifiedItems[q.idx]);
            void detectAndApplyLiked(q.unifiedItems[q.idx]);
            return;
          }
          // Next batch had nothing playable → fall through to loop so playback
          // isn't a dead end.
        } catch (e) {
          setError(`获取下一批推荐失败：${(e as Error).message}`);
          if (queueRef.current !== q) return;
          // fall through to loop
        } finally {
          setLoading(false);
        }
      }
      q.idx = (q.idx + 1) % q.tracks.length;
      presentTrack(q.tracks[q.idx], q.unifiedItems?.[q.idx]);
      void detectAndApplyLiked(q.unifiedItems?.[q.idx]);
      return;
    }
    // Radio (server) track: not a unified item, so there's no fan-out. Clear
    // the badge, otherwise it keeps showing the last search song's platform
    // count on top of unrelated radio tracks. `next.liked` (from the server)
    // still drives the ❤ fill via presentTrack.
    setFanOutCount(0);
    setLoading(true);
    setError(null);
    try {
      const next = await fetchNextTrack(
        provider,
        provider === 'deezer' ? deezerPreset : undefined,
      );
      presentTrack(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [provider, deezerPreset, presentTrack, detectAndApplyLiked]);

  /** Play a search result: parse UnifiedSearchItem[] into a playable queue,
   *  dropping items with no playable source. Keeps unifiedItems aligned with
   *  tracks so handleLike / detect can map idx → the right unified item. */
  const playSearch = useCallback(
    (
      unifiedItems: UnifiedSearchItem[],
      index: number,
      /** Reco only: loader for the next batch when this queue runs out. */
      loadMore?: () => Promise<UnifiedSearchItem[]>,
    ) => {
      // Keep track+unified ALIGNED: drop non-playable from both so idx maps
      // to the right unified item (for per-song ❤ detect / fan-out).
      const { tracks, unifiedItems: aligned } = parsePlayableQueue(unifiedItems);
      const targetSrcIndex = unifiedItems[index] ? index : 0;
      const startIdx = aligned.indexOf(unifiedItems[targetSrcIndex]);
      if (startIdx < 0 || tracks.length === 0) {
        setError('没有可播放的音源');
        return;
      }
      queueRef.current = { tracks, idx: startIdx, unifiedItems: aligned, loadMore };
      setSearchOpen(false);
      setError(null);
      // New search context → clear the old fan-out count.
      setFanOutCount(0);
      presentTrack(tracks[startIdx], aligned[startIdx]);
      void detectAndApplyLiked(aligned[startIdx]);
    },
    [presentTrack, detectAndApplyLiked],
  );

  // Auto-load on provider / preset change (but skip once when delaying a
  // source switch so the current song isn't interrupted).
  useEffect(() => {
    if (!provider) return;
    if (skipAutoLoadRef.current) {
      skipAutoLoadRef.current = false;
      return;
    }
    loadNextTrack();
  }, [provider, deezerPreset, loadNextTrack]);

  // Audio element wiring. Re-bind whenever `track` changes (NOT when
  // loadNextTrack does — that closure trap was the original bug).
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTimeUpdate = () => setCurrentTime(audio.currentTime);
    const onDurationChange = () => setDuration(audio.duration || 0);
    const onLoadedMetadata = () => {
      setDuration(audio.duration || 0);
      // After a quality-switch reload, jump back to the original position.
      // (Skip trial detection here — a quality reload of a trial is still a
      // trial, and we don't want to yank the platform mid-listen.)
      if (pendingSeekRef.current != null) {
        try {
          audio.currentTime = pendingSeekRef.current;
        } catch {
          // ignore occasional out-of-range seek
        }
        pendingSeekRef.current = null;
        return;
      }
      // VIP 30s 试听检测（每个音源判一次）：只对完整曲流平台（qq/网易云），
      // 且实际音频远短于元数据全长 → 判定为被 VIP 锁成的试听片段，去别的完整
      // 平台搜全曲换过去。Deezer/Spotify 的 30s 是正常预览，provider 已排除。
      if (!trialEvaluatedRef.current) {
        trialEvaluatedRef.current = true;
        const cur = trackRef.current;
        const audioDur = audio.duration;
        if (
          cur &&
          FULL_SONG_PROVIDERS.includes(cur.provider) &&
          Number.isFinite(audioDur) &&
          audioDur > 0 &&
          audioDur <= TRIAL_MAX_SEC &&
          cur.duration > audioDur + TRIAL_GAP_SEC
        ) {
          void handleTrialDetected();
        }
      }
    };
    const onCanPlay = () => {
      if (audio.dataset.wantPlay === '1' && audio.paused) {
        audio.play().catch((e) => {
          console.error('[audio] play() rejected in canplay:', e);
        });
      }
    };
    const onPlay = () => {
      audio.dataset.wantPlay = '1';
      // Build the graph the moment playback actually starts (autoplay is
      // allowed in this Electron shell). Idempotent.
      ensureAudioGraph();
    };
    const onPause = () => {
      audio.dataset.wantPlay = '0';
    };
    const onEnded = () => {
      audio.dataset.wantPlay = '0';
      loadNextTrack();
    };
    const onError = () => {
      const err = audio.error;
      const code = err ? `code=${err.code}` : 'no-MediaError';
      console.error('[audio] error', code, audio.src);
      // 无版权 / 取流失败：先自动降级到同一首歌的其它平台源（含向服务端实时
      // 匹配），全都失败才把报错弹给用户。tryFallbackSource 是异步的（可能要
      // 问服务端），拿到 false 才报错。
      void tryFallbackSource().then((ok) => {
        if (!ok) setError(`音频加载失败（${code}），请尝试切歌`);
      });
    };
    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('durationchange', onDurationChange);
    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('canplay', onCanPlay);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);
    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('durationchange', onDurationChange);
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      audio.removeEventListener('canplay', onCanPlay);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
    };
  }, [
    track,
    loadNextTrack,
    ensureAudioGraph,
    audioRef,
    tryFallbackSource,
    handleTrialDetected,
  ]);

  // Sync play/pause — but only call play() once the audio is actually ready
  // (the src is set on mount but data hasn't streamed yet). onCanPlay retries.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !track) return;
    // Spotify Premium + WPS ready → 走 WPS 路径（HTMLAudioElement 不用，
    // 否则会被 30s 预览代理劫持成 mp3 字节流）。wpsRef 引用稳定，effect 只在
    // playing / track 变化时跑，此处懒读 .current 拿最新 WPS 实例。
    const wps = wpsRef?.current ?? null;
    const useWps = Boolean(
      wps?.wpsReady && track.provider === 'spotify' && track.id,
    );
    if (useWps && wps) {
      if (playing) {
        audio.dataset.wantPlay = '1';
        // 切到新歌 → play(newUri)；同一首暂停后恢复 → resume。用 ref 里记的
        // 上一次 play 过的 id 区分（audio.dataset.wantPlay 无法区分这两种）。
        if (wpsPlayedIdRef.current !== track.id) {
          const uri = `spotify:track:${track.id}`;
          wpsPlayedIdRef.current = track.id;
          void wps.play(uri).catch((e: Error) => {
            console.error('[wps] play() rejected:', e);
            setError(`WPS 播放失败：${e.message}`);
          });
        } else {
          void wps.resume().catch(() => {
            // resume 失败常见于 SDK 内部状态；忽略
          });
        }
      } else {
        audio.dataset.wantPlay = '0';
        void wps.pause().catch(() => {
          // ignore
        });
      }
      return;
    }
    if (playing) {
      audio.dataset.wantPlay = '1';
      if (audio.readyState >= 3 /* HAVE_FUTURE_DATA */) {
        audio.play().catch((e) => {
          console.error('[audio] play() rejected:', e);
          setError(`播放失败: ${(e as Error).message || e}`);
        });
      }
    } else {
      audio.dataset.wantPlay = '0';
      audio.pause();
    }
  }, [playing, track, audioRef, wpsRef]);

  /** WPS → 时间轴桥：App 在 wps.state 变化时调它，把 SDK 上报的位置/时长
   *  喂回 usePlayer 的 currentTime / duration。仅在 WPS 播放 spotify 时用。 */
  const applyWpsProgress = useCallback(
    (positionMs: number, durationMs: number) => {
      setCurrentTime(positionMs / 1000);
      if (durationMs > 0) setDuration(durationMs / 1000);
    },
    [],
  );

  useEffect(() => {
    let target: HTMLDivElement | null = null;
    let lastValue = '';
    const writeBassIntensity = (value: string) => {
      const nextTarget = coverBackdropRef.current;
      if (nextTarget !== target) {
        target = nextTarget;
        lastValue = '';
      }
      if (target && value !== lastValue) {
        target.style.setProperty('--bass-intensity', value);
        lastValue = value;
      }
    };

    if (searchOpen || !analyser || !playing) {
      writeBassIntensity('0');
      return;
    }

    let raf = 0;
    const buf = new Uint8Array(64);
    const tick = () => {
      analyser.getByteFrequencyData(buf);
      let sum = 0;
      for (let i = 1; i <= 12; i++) sum += buf[i];
      const bass = sum / (12 * 255);
      writeBassIntensity(Math.min(1, bass * 1.1).toFixed(3));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, analyser, searchOpen, coverBackdropRef]);

  const selectSource = (next: MusicProvider) => {
    writeStoredProvider(next);
    if (next === 'deezer') {
      // Pre-arm user activation for Chromium's autoplay policy: play a tiny
      // silent WAV synchronously inside this click handler so subsequent
      // play() calls from our effects are allowed.
      try {
        const tmp = new Audio();
        tmp.muted = true;
        tmp.src =
          'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
        const p = tmp.play();
        if (p && typeof p.then === 'function') {
          p.then(() => {
            tmp.pause();
            tmp.src = '';
          }).catch(() => {});
        }
      } catch {
        // ignore
      }
    }
    setProvider(next);
  };

  /** Switch source from the dropdown without interrupting playback: same
   *  source → no-op; different → only later tracks come from the new source
   *  (current song plays out, or the user skips). */
  const switchToProvider = (next: MusicProvider) => {
    if (next === provider) return;
    queueRef.current = null; // the search queue is source-specific
    setSearchOpen(false);
    writeStoredProvider(next);
    if (track) skipAutoLoadRef.current = true;
    setProvider(next);
  };

  /** Switch quality (QQ / NetEase): reload the current song at the new
   *  quality, preserving the playback position. */
  const changeQuality = (q: QqQuality) => {
    setQqQuality(q);
    qqQualityRef.current = q;
    writeStoredQuality(q);
    const audio = audioRef.current;
    if (
      audio &&
      track &&
      (track.provider === 'qq' || track.provider === 'netease') &&
      track.audioUrl
    ) {
      pendingSeekRef.current = audio.currentTime; // restore after reload
      const base = track.audioUrl
        .replace(/[?&]q=[^&]*/, '')
        .replace(/[?&]$/, '');
      const sep = base.includes('?') ? '&' : '?';
      setTrack((prev) =>
        prev ? { ...prev, audioUrl: `${base}${sep}q=${q}` } : prev,
      );
    }
  };

  const changeDeezerPreset = (next: string) => {
    setDeezerPreset(next);
    writeStoredDeezerPreset(next);
  };

  const handlePlayPause = () => {
    // Build the graph the first time the user hits play; later clicks just
    // resume the context if needed.
    ensureAudioGraph();
    setPlaying((p) => !p);
  };

  const handleSkip = () => loadNextTrack();

  /** Go back one track within the search queue (looping). Radio has no history,
   *  so prev is a no-op there. */
  const loadPrevTrack = useCallback(() => {
    const q = queueRef.current;
    if (q && q.tracks.length) {
      q.idx = (q.idx - 1 + q.tracks.length) % q.tracks.length;
      presentTrack(q.tracks[q.idx], q.unifiedItems?.[q.idx]);
      void detectAndApplyLiked(q.unifiedItems?.[q.idx]);
    }
  }, [presentTrack, detectAndApplyLiked]);

  const handlePrev = () => loadPrevTrack();

  const handleLike = async () => {
    if (!track || !provider) return;
    // 语义：❤ 是开关。未收藏 → 在所有有版权的平台收藏（fan-out）；已收藏 →
    // 取消之前 fan-out 过的所有平台的收藏（不写「不喜欢」、不影响 FM 推荐——
    // 那是「踩」的语义）。
    const q = queueRef.current;
    const current = q?.unifiedItems?.[q.idx];
    if (current && current.bestSource) {
      const sources = current.sources
        .filter((s) => s.hasCopyright)
        .map((s) => ({ platform: s.platform, trackId: s.trackId }));
      const next = !track.liked;
      try {
        // 带上歌曲元数据：收藏时后端会去其余已登录平台跨平台匹配同名同时长的
        // 等价曲目，把红心真正同步过去（严格 ±3s，后台异步）。
        const result = await fanOutLike(current.id, sources, next, {
          title: current.title,
          artist: current.artist,
          duration: current.duration,
        });
        setFanOutCount(next ? result.fannedOutTo.length : 0);
        setTrack((prev) => (prev ? { ...prev, liked: next } : prev));
      } catch (e) {
        setError(`心动作业失败：${(e as Error).message}`);
      }
      return;
    }
    // Single-platform path (radio): toggleLike 本身就是翻转语义。收藏方向同样
    // 带元数据，让后端跨平台匹配把红心补到其余已登录平台。
    const result = await toggleLike(provider, track.id, {
      title: track.title,
      artist: track.artist,
      duration: track.duration,
    });
    if (result.success) {
      setTrack((prev) => (prev ? { ...prev, liked: result.liked } : prev));
      setFanOutCount(0);
    }
  };

  const handleDislike = async () => {
    if (!track || !provider) return;
    // Unified search path: 踩 = 取消这首歌在所有平台的红心 + 标记不喜欢，
    // 否则某平台残留的红心会在下次切到这首歌时被 detect 重新点亮/收藏回来。
    const q = queueRef.current;
    const current = q?.unifiedItems?.[q.idx];
    if (current && current.bestSource) {
      const sources = current.sources
        .filter((s) => s.hasCopyright)
        .map((s) => ({ platform: s.platform, trackId: s.trackId }));
      try {
        await dislikeMerged(current.id, sources);
        setFanOutCount(0);
        setTrack((prev) => (prev ? { ...prev, liked: false } : prev));
      } catch {
        // 踩失败不阻塞切歌，静默。
      }
      loadNextTrack();
      return;
    }
    // Single-platform path (radio): 单平台标记不喜欢。
    await dislike(provider, track.id);
    loadNextTrack();
  };

  /** Seek the live <audio> element (progress-bar click, lyric-line click).
   *  Spotify Premium + WPS ready → seek through the SDK instead (the <audio>
   *  element isn't the playback source for those tracks). */
  const seek = (seconds: number) => {
    const wps = wpsRef?.current ?? null;
    if (wps?.wpsReady && track?.provider === 'spotify') {
      setCurrentTime(seconds); // 乐观更新，SDK 回报后再校正
      void wps.seek(Math.round(seconds * 1000)).catch(() => {
        // ignore
      });
      return;
    }
    const audio = audioRef.current;
    if (audio) audio.currentTime = seconds;
  };

  /** Clear all playback state and drop back to no-provider. The auth reset,
   *  lyric clear (auto, via useLyrics when provider→null) and localStorage
   *  wipe are orchestrated by the caller. */
  const resetForSwitch = () => {
    audioRef.current?.pause();
    setPlaying(false);
    setTrack(null);
    setCurrentTime(0);
    setDuration(0);
    queueRef.current = null;
    currentUnifiedRef.current = undefined;
    triedPlatformsRef.current = new Set();
    setError(null);
    setSearchOpen(false);
    setProvider(null);
    // Drop the analyser so it doesn't keep reading from a MediaStream whose
    // source <audio> element we just unmounted; it rebuilds on next play.
    setAnalyser(null);
    clearStoredProvider();
  };

  return {
    // state
    provider,
    track,
    /** 当前歌来自 unified search 时的跨平台 sources（歌词多源回退用）。
     *  ref 的更新总是先于 setTrack，所以 render 时读到的一定是当前歌的。 */
    currentSources:
      currentUnifiedRef.current?.sources.map((s) => ({
        platform: s.platform,
        trackId: s.trackId,
      })) ?? undefined,
    playing,
    currentTime,
    duration,
    loading,
    error,
    setError,
    searchOpen,
    setSearchOpen,
    fanOutCount,
    trialFellBack,
    qqQuality,
    deezerPreset,
    // cover refs (for the JSX)
    bgLayerRef,
    coverBackdropRef,
    // actions
    selectSource,
    switchToProvider,
    changeQuality,
    changeDeezerPreset,
    loadNextTrack,
    playSearch,
    applyWpsProgress,
    handlePlayPause,
    handleSkip,
    handlePrev,
    handleLike,
    handleDislike,
    refreshLikedState,
    seek,
    resetForSwitch,
  };
}
