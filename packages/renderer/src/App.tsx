import { useState, useEffect, useRef, useCallback, type RefObject } from 'react';
import {
  fetchNextTrack,
  fetchDeezerEditorials,
  toggleLike,
  fanOutLike,
  dislike,
  getAuthStatus,
  logout,
  loginQqCookie,
  loginNeteaseCookie,
  fetchLyrics,
  pickPlayableTrack,
  fetchRecoStatus,
  runReco,
  saveRecoKey,
  importLibrary,
  PROVIDER_LABELS,
  QQ_QUALITY_LABELS,
  API_ORIGIN,
} from './api';
import type {
  Track,
  AuthStatus,
  MusicProvider,
  AuthUser,
  DeezerEditorial,
  QqQuality,
  LyricLine,
  UnifiedSearchItem,
} from './api';
import SourceSelect from './SourceSelect';
import NeteaseCookieModal from './NeteaseCookieModal';
import SearchPanel from './SearchPanel';
import ErrorPanel from './ErrorPanel';
import LyricsPanel from './LyricsPanel';
import RecoKeyModal from './RecoKeyModal';
import './App.css';

const PROVIDER_STORAGE_KEY = 'music-provider';

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Pull the dominant colour out of a cover-art image URL and apply it to
 *   1. the bg-layer div (so the window background echoes the song), and
 *   2. the --cover-accent + --cover-glow custom properties on
 *      :root (consumed by the cover's outer halo).
 *
 * CORS: cover CDNs (QQ's y.gtimg.cn in particular) don't return
 * Access-Control-Allow-Origin, which kills the canvas drawImage →
 * getImageData path (the canvas ends up "tainted" and pixel reads
 * throw). We route both the JS fetch AND the background-image URLs
 * through our server's /music/cover-proxy, which fetches the image
 * server-side and re-emits it with CORS headers. One cached response
 * serves both consumers. The original `url` stays as `track.coverUrl`
 * for use cases that don't need pixel access (e.g. SearchPanel
 * thumbnails use <img src> directly).
 *
 * The fallback path below still tries the original URL via plain
 * `fetch` (no CORS mode) — for CDNs that happen to allow it, we save
 * a server round-trip. If that throws, we fall through to background-
 * image only and skip colour extraction.
 */
async function applyCoverImage(
  url: string,
  bgLayerRef: RefObject<HTMLDivElement | null>,
  coverBackdropRef: RefObject<HTMLDivElement | null>,
  epoch: number,
  epochRef: RefObject<number>,
): Promise<void> {
  // Build the proxied URL once, against the same origin the API client
  // uses. In dev API_ORIGIN is '' → /music/cover-proxy (Vite proxies it
  // to :3200); in prod it's the sidecar origin → an absolute URL, so it
  // works even though the renderer is loaded from file://.
  const proxied = `${API_ORIGIN}/music/cover-proxy?url=${encodeURIComponent(url)}`;

  let bitmap: ImageBitmap;
  try {
    const res = await fetch(proxied);
    // Cancelled: a newer presentTrack call has incremented the epoch
    // while we were waiting. Bail out without touching any DOM — the
    // newer call will set the correct cover.
    if (epochRef.current !== epoch) return;
    if (!res.ok) throw new Error(`proxy_http_${res.status}`);
    const blob = await res.blob();
    if (epochRef.current !== epoch) return;
    bitmap = await createImageBitmap(blob);
  } catch {
    // Cancelled by a newer presentTrack call while we were fetching.
    if (epochRef.current !== epoch) return;
    // Proxy failed (server down, host not allowlisted, upstream 5xx).
    // We can still set the background-image with the ORIGINAL URL —
    // the browser happily renders cross-origin <img>s without reading
    // pixels — we just lose the colour extraction this time.
    const coverBackdrop = coverBackdropRef.current;
    const bgLayer = bgLayerRef.current;
    if (coverBackdrop) coverBackdrop.style.backgroundImage = `url(${url})`;
    if (bgLayer) bgLayer.style.backgroundImage = `url(${url})`;
    document.documentElement.style.setProperty('--cover-accent', '#1a1a1f');
    document.documentElement.style.setProperty('--cover-glow', 'transparent');
    return;
  }

  // 1) Sample the dominant colour.
  const sampleCanvas = document.createElement('canvas');
  sampleCanvas.width = 1;
  sampleCanvas.height = 1;
  const sampleCtx = sampleCanvas.getContext('2d');
  if (sampleCtx) {
    sampleCtx.drawImage(bitmap, 0, 0, 1, 1);
    const [r, g, b] = sampleCtx.getImageData(0, 0, 1, 1).data;
    document.documentElement.style.setProperty(
      '--cover-accent',
      `rgb(${r}, ${g}, ${b})`,
    );
    document.documentElement.style.setProperty(
      '--cover-glow',
      `rgba(${r}, ${g}, ${b}, 0.32)`,
    );
  }

  // 2) Set the cover as the bg-layer and the left-column backdrop.
  // Use the ORIGINAL url for CSS background-image (browser happily
  // renders cross-origin images — no CORS needed for display).
  // The proxied URL was only needed for the JS fetch above (canvas
  // pixel read path). Trying to use it for CSS too adds a second
  // server round-trip that can fail independently and leave the
  // window background blank.
  const coverBackdrop = coverBackdropRef.current;
  const bgLayer = bgLayerRef.current;
  if (coverBackdrop) coverBackdrop.style.backgroundImage = `url(${url})`;
  if (bgLayer) bgLayer.style.backgroundImage = `url(${url})`;

  bitmap.close?.();
}


function readStoredProvider(): MusicProvider | null {
  const stored = localStorage.getItem(PROVIDER_STORAGE_KEY);
  if (
    stored === 'qq' ||
    stored === 'netease' ||
    stored === 'deezer' ||
    stored === 'spotify'
  ) {
    return stored;
  }
  return null;
}

/**
 * Volume icon with four states — muted / low / mid / high — derived
 * from (volume, muted). We pick the icon set rather than the slider
 * position because the icon needs to remain readable at the tiny
 * size we use it (14×14 px in the progress row).
 *
 * SVG paths from Material Design Icons (volume_off / volume_mute /
 * volume_up variants) — re-used to keep the visual vocabulary
 * consistent with the transport buttons (dislike / like / skip) which
 * also use Material SVGs.
 */
function VolumeIcon({ volume, muted }: { volume: number; muted: boolean }) {
  if (muted || volume === 0) {
    return (
      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
        {/* Speaker with a slash — explicit "audio off" state */}
        <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
      </svg>
    );
  }
  if (volume < 0.5) {
    return (
      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
        {/* Speaker alone, no waves — quiet */}
        <path d="M7 9v6h4l5 5V4l-5 5H7z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
      {/* Speaker + two waves — loud */}
      <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
    </svg>
  );
}

/** True when running inside the Electron shell (not just a browser tab). */
const isElectron = typeof window !== 'undefined' && Boolean(window.electronAPI?.isElectron);

export default function App() {
  const [provider, setProvider] = useState<MusicProvider | null>(() => {
    const params = new URLSearchParams(window.location.search);
    const fromCallback = params.get('provider');
    if (fromCallback === 'qq' || fromCallback === 'netease') return fromCallback;
    return readStoredProvider();
  });
  const [track, setTrack] = useState<Track | null>(null);
  const [auth, setAuth] = useState<AuthStatus>({
    provider: 'qq',
    loggedIn: false,
    user: null,
  });
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCookieFallback, setShowCookieFallback] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false);
  // Lyrics: fetched on track change, cleared on source switch.
  const [lyrics, setLyrics] = useState<LyricLine[] | null>(null);
  const [lyricsLoading, setLyricsLoading] = useState(false);
  // DeepSeek 推荐：状态 + key 输入弹窗
  const [recoStatus, setRecoStatus] = useState<{ configured: boolean; librarySize: number } | null>(null);
  const [recoRunning, setRecoRunning] = useState(false);
  const [recoKeyOpen, setRecoKeyOpen] = useState(false);
  const [qualityMenuOpen, setQualityMenuOpen] = useState(false);
  const QQ_QUALITY_KEY = 'musicbox:qq-quality';
  const [qqQuality, setQqQuality] = useState<QqQuality>(() => {
    const v = localStorage.getItem(QQ_QUALITY_KEY);
    return v === 'high' || v === 'lossless' ? v : 'standard';
  });
  // 搜索模式的客户端队列。非空时 loadNextTrack 在结果里前进，而不是走
  // 服务端电台。用 ref 存，避免 loadNextTrack 的闭包读到旧值。
  //
  // 统一搜索（P0 之后）会给这个对象多带一个 unifiedItems 字段和 mergedId：
  // - unifiedItems: 原始 UnifiedSearchItem[]，用来做 heart fan-out
  // - mergedId: 当前播放这一首对应的 merged id（fan-out 入参）
  // 单平台路径（电台 / 直连）这两个字段都没有，handleLike 走老路径。
  const queueRef = useRef<{
    tracks: Track[];
    idx: number;
    unifiedItems?: UnifiedSearchItem[];
    mergedId?: string;
  } | null>(null);
  // 当前 track 是否被 fan-out 心动了（fannedOutTo.length > 0）。
  // 用于 ❤ 图标高亮 + 后面显示"3❤"小角标。
  const [fanOutCount, setFanOutCount] = useState<number>(0);
  // 切换音源时若当前有歌在放，标记跳过一次「provider 变化触发的自动加载」，
  // 让当前歌继续放到结束 / 用户点下一首，才从新音源取歌（不打断播放）。
  const skipAutoLoadRef = useRef(false);
  // presentTrack 用 ref 读当前音质，避免把 qqQuality 塞进它的依赖。
  const qqQualityRef = useRef<QqQuality>(qqQuality);
  qqQualityRef.current = qqQuality;
  // 切换音质时用于换源后跳回原播放进度。
  const pendingSeekRef = useRef<number | null>(null);
  // Deezer preset (e.g. 'all' | 'asia' | 'pop' | 'rap' | …). Persisted
  // to localStorage so the user's pick sticks across restarts.
  const DEEZER_PRESET_KEY = 'musicbox:deezer-preset';
  const [deezerPreset, setDeezerPreset] = useState<string>(() => {
    return localStorage.getItem(DEEZER_PRESET_KEY) ?? 'asia';
  });
  const [deezerEditorials, setDeezerEditorials] = useState<DeezerEditorial[]>([]);
  const audioRef = useRef<HTMLAudioElement>(null);
  const bgLayerRef = useRef<HTMLDivElement>(null);
  // Web Audio graph — created lazily on the first play-button click
  // (autoplay policy gates AudioContext + MediaElementSource creation
  // to user gestures). Once created, the graph is reused for every
  // track — MediaElementSource can only be created once per element.
  //
  // `analyser` is **state**, not a ref. The Visualizer component reads
  // it as a prop, so its useEffect needs a real re-render to fire when
  // the graph comes online. A ref would only flip after the fact and
  // the Visualizer would be stuck on its initial `null` prop forever
  // — and so would its canvas draw loop. (Ref would only work if we
  // also had a "graph ready" state flag forcing a re-render; making
  // the value itself state is simpler and correct.)
  const audioCtxRef = useRef<AudioContext | null>(null);
  // The single MediaElementAudioSourceNode for the <audio> element.
  // createMediaElementSource throws if called twice on the same element,
  // so we create it once and cache it here across graph rebuilds.
  const mediaSrcRef = useRef<MediaElementAudioSourceNode | null>(null);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  // The left-side cover-art container. We use a div + background-image
  // (rather than an <img>) so the cover can fill its column edge-to-edge
  // without distorting or showing letterboxing.
  const coverBackdropRef = useRef<HTMLDivElement>(null);
  // Epoch counter for applyCoverImage cancellation. Incremented on
  // every presentTrack call so in-flight async fetches from a stale
  // call can detect they've been superseded and bail out.
  const coverEpochRef = useRef(0);
  // Volume: persisted to localStorage as {volume, muted}. We keep
  // `muted` separate from `volume` so unmuting restores the user's
  // previous level — a single boolean toggle, no "saved-volume" hack.
  // The slider's effective output is `muted ? 0 : volume`, applied
  // to <audio>.volume in the effect below.
  const VOLUME_KEY = 'musicbox:volume';
  const [volume, setVolume] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(VOLUME_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (
          typeof parsed?.volume === 'number' &&
          parsed.volume >= 0 &&
          parsed.volume <= 1
        ) {
          return parsed.volume;
        }
      }
    } catch {
      /* fall through */
    }
    return 1;
  });
  const [muted, setMuted] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(VOLUME_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (typeof parsed?.muted === 'boolean') return parsed.muted;
      }
    } catch {
      /* fall through */
    }
    return false;
  });
  // Theme: 'dark' | 'light' | 'system'. The toggle button (☀/🌙)
  // was removed in a prior pass but we keep reading & persisting the
  // value so a future UI can re-read it. CSS follows
  // `prefers-color-scheme` when this is 'system' (the default).
  const [theme, setTheme] = useState<'dark' | 'light' | 'system'>(() => {
    const saved = localStorage.getItem('musicbox:theme') as
      | 'dark'
      | 'light'
      | 'system'
      | null;
    return saved ?? 'system';
  });

  // Apply the theme on mount and whenever it changes — write the
  // [data-theme] attribute on <html> so the CSS variables flip.
  useEffect(() => {
    localStorage.setItem('musicbox:theme', theme);
    const root = document.documentElement;
    if (theme === 'system') {
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', theme);
    }
  }, [theme]);

  // Persist volume + muted to localStorage. Single key, JSON-encoded
  // so we can extend with new fields later (e.g. balance) without
  // a migration. We don't write during the initial render — the
  // lazy useState initialiser already reads from the same key, so
  // persisting again immediately would be redundant.
  useEffect(() => {
    try {
      localStorage.setItem(VOLUME_KEY, JSON.stringify({ volume, muted }));
    } catch {
      /* quota / private mode — silently skip */
    }
  }, [volume, muted]);

  // Push the user's volume preference onto the live <audio> element
  // whenever it changes. Runs on first mount too — if the user
  // muted the player yesterday, the first audio element of this
  // session starts muted without a flash of full-volume audio.
  useEffect(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.volume = muted ? 0 : volume;
    }
  }, [volume, muted, track]);

  // Fetch lyrics when the track changes. Kicks off after presentTrack
  // sets the new track so we know the provider + id. Clears previous
  // lyrics immediately so the panel shows the loading state during
  // the fetch, not stale content from the old track.
  useEffect(() => {
    if (!track?.id || !provider) {
      setLyrics(null);
      setLyricsLoading(false);
      return;
    }
    let cancelled = false;
    setLyricsLoading(true);
    setLyrics(null);
    fetchLyrics(provider, track.id)
      .then((result) => {
        if (!cancelled) {
          setLyrics(result);
          setLyricsLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLyrics(null);
          setLyricsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [track?.id, provider]);

  // Fetch the list of available Deezer editorials once on mount.
  useEffect(() => {
    fetchDeezerEditorials()
      .then(setDeezerEditorials)
      .catch(() => setDeezerEditorials([]));
  }, []);

  // Fetch reco status (DeepSeek key configured + library size) once on mount
  // + 每次用户保存 key 之后（用 version 触发刷新）。
  const [recoStatusVersion, setRecoStatusVersion] = useState(0);
  useEffect(() => {
    fetchRecoStatus()
      .then(setRecoStatus)
      .catch(() => setRecoStatus({ configured: false, librarySize: 0 }));
  }, [recoStatusVersion]);

  // OAuth callback handler
  useEffect(() => {
    if (!provider) return;
    const params = new URLSearchParams(window.location.search);
    const errParam = params.get('error');
    if (errParam) setError(decodeURIComponent(errParam));
    getAuthStatus(provider)
      .then(setAuth)
      .catch((e) => setError((e as Error).message));
    if (params.toString()) {
      window.history.replaceState({}, '', '/');
    }
  }, [provider]);

  /**
   * Lazily attach a Web Audio analyser to the live <audio> element on
   * the first user gesture (the play-button click).
   *
   * We use `createMediaElementSource(audioEl)` and route
   * source → analyser → ctx.destination. This is the reliable way to
   * feed the frequency analyser: it taps the decoded PCM of the element
   * directly. `captureStream()` was tried before and DOESN'T work here —
   * for cross-origin media it returns a track-less stream, so the
   * analyser saw silence and the visualizer never started.
   *
   * Two requirements make this work now:
   *   1. The <audio> has `crossOrigin="anonymous"` (set in JSX), and
   *   2. our stream endpoint proxies the bytes same-origin with an
   *      `Access-Control-Allow-Origin: *` header (see music.controller).
   * Together they make the media CORS-clean, so the graph gets real
   * samples instead of zeros.
   *
   * `createMediaElementSource` can only be called ONCE per element and
   * permanently reroutes the element's output through the graph — so we
   * MUST connect to ctx.destination or playback goes silent. We guard
   * with mediaSrcRef so a second call (e.g. re-entrancy) is a no-op.
   */
  const ensureAudioGraph = useCallback((): AnalyserNode | null => {
    if (audioCtxRef.current && analyser) {
      // Already built — just make sure the context is running.
      // (It gets suspended when the window loses focus on some OSes.)
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
      // webkitAudioContext is the legacy-prefixed constructor used
      // by older Electron / Safari builds.
      const Ctor: typeof AudioContext =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      const ctx = new Ctor();
      // createMediaElementSource throws if called twice on the same
      // element; mediaSrcRef caches the one instance across rebuilds.
      const src =
        mediaSrcRef.current ?? ctx.createMediaElementSource(audioEl);
      mediaSrcRef.current = src;
      const node = ctx.createAnalyser();
      node.fftSize = 256;
      node.smoothingTimeConstant = 0.72;
      // source → analyser → speakers. The analyser is a pass-through
      // node (it doesn't alter the signal), so connecting it inline is
      // safe; we MUST reach destination or the element goes silent.
      src.connect(node);
      node.connect(ctx.destination);
      audioCtxRef.current = ctx;
      // State update (not a ref write) — this is what unblocks the
      // Visualizer, which receives `analyser` as a prop and only
      // re-runs its draw effect when this value changes.
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
  }, [analyser]);

  // 把一首 Track 呈现到播放器：解析绝对 audioUrl、换封面、置播放意图。
  // 服务端电台和搜索结果两条路径都复用它。
  const presentTrack = useCallback((next: Track) => {
    let audioUrl =
      next.audioUrl && next.audioUrl.startsWith('/')
        ? API_ORIGIN + next.audioUrl
        : next.audioUrl;
    // QQ / 网易云：把当前选择的音质拼进流地址（?mm=... 已在则追加 &q=）。
    if (
      (next.provider === 'qq' || next.provider === 'netease') &&
      audioUrl.includes(`/music/stream/${next.provider}/`)
    ) {
      const sep = audioUrl.includes('?') ? '&' : '?';
      audioUrl += `${sep}q=${qqQualityRef.current}`;
    }
    if (next.coverUrl) {
      // Pass the ref objects themselves, not the .current DOM nodes.
      // We added `key={track.id}` on cover-stack (for the shared-
      // element animation), which means the cover-art div unmounts
      // and remounts on every track change. If we passed the DOM
      // nodes captured HERE, the async fetch inside applyCoverImage
      // would resolve later, and `coverBackdrop.style.backgroundImage
      // = …` would write onto an already-detached node — the visible
      // cover-art would keep its old background forever. Reading
      // ref.current INSIDE the async function reads the freshly
      // mounted new div. (bg-layer doesn't have a key so its ref is
      // always live, but passing the ref keeps the two symmetric.)
      coverEpochRef.current += 1;
      void applyCoverImage(
        next.coverUrl,
        bgLayerRef,
        coverBackdropRef,
        coverEpochRef.current,
        coverEpochRef,
      );
    }
    setTrack({ ...next, audioUrl });
    setCurrentTime(0);
    const audio = audioRef.current;
    if (audio) audio.dataset.wantPlay = '1';
    setPlaying(true);
    // NOTE: do NOT call ensureAudioGraph() here. Building the audio
    // graph (new AudioContext + createMediaElementSource) requires
    // a real user gesture — otherwise the context starts suspended
    // and never produces sound. The graph is built lazily on the
    // first handlePlayPause click (which IS a user gesture). Until
    // then the audio plays through the default <audio> path, so
    // opening the app and auto-playing the first track works fine.
    // The trade-off: the visualizer shows its placeholder state
    // until the user clicks play/pause once.
  }, []);

  const loadNextTrack = useCallback(async () => {
    if (!provider) return;
    // 搜索模式：在结果队列里前进（循环），不打服务端电台。
    const q = queueRef.current;
    if (q && q.tracks.length) {
      q.idx = (q.idx + 1) % q.tracks.length;
      presentTrack(q.tracks[q.idx]);
      return;
    }
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
  }, [provider, deezerPreset, presentTrack]);

  /** 从搜索面板点某一行：把 UnifiedSearchItem[] 解析成可播放 Track[] 作为队列。
   *  没有可播放 bestSource 的（所有平台都无版权）会从队列里剔除——SearchPanel
   *  那一行已经置灰了，正常路径走不到；这里兜个底防止队列里出现"无主"项。
   *
   *  顺带把 unifiedItems + mergedId 存到 queueRef，handleLike 据此决定走
   *  fanOutLike 路径。 */
  const handlePlaySearch = useCallback(
    (unifiedItems: UnifiedSearchItem[], index: number) => {
      const playable: { track: Track; srcIndex: number }[] = [];
      unifiedItems.forEach((it, i) => {
        const t = pickPlayableTrack(it);
        if (t) playable.push({ track: t, srcIndex: i });
      });
      // 把被点的 index 在 unifiedItems 里的位置映射到 playable[] 的位置
      const targetSrcIndex = unifiedItems[index] ? index : 0;
      const startIdx = playable.findIndex(
        (p) => p.srcIndex === targetSrcIndex,
      );
      if (startIdx < 0 || playable.length === 0) {
        setError('没有可播放的音源');
        return;
      }
      const target = unifiedItems[targetSrcIndex];
      queueRef.current = {
        tracks: playable.map((p) => p.track),
        idx: startIdx,
        unifiedItems,
        mergedId: target?.id,
      };
      setSearchOpen(false);
      setError(null);
      // 切换搜索上下文时清掉旧的 fan-out 计数。新的 mergedId 对应的
      // ❤ 状态得 server 那边查过才知道——本轮先重置为 0，TODO: 后续
      // 拉一次 GET /music/like/merged 状态。
      setFanOutCount(0);
      presentTrack(playable[startIdx].track);
    },
    [presentTrack],
  );

  useEffect(() => {
    if (!provider) return;
    // 延迟切换音源时：跳过这一次自动加载，保住当前正在播放的歌。
    if (skipAutoLoadRef.current) {
      skipAutoLoadRef.current = false;
      return;
    }
    loadNextTrack();
  }, [provider, deezerPreset, loadNextTrack]);

  // Audio element wiring. We re-bind listeners whenever `track` changes
  // (NOT when `loadNextTrack` does — that closure trap was the bug: the
  // listener captured the first call's audio element, but subsequent
  // setTrack() didn't re-run this effect, so canplay never got handled).
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTimeUpdate = () => {
      setCurrentTime(audio.currentTime);
    };
    const onDurationChange = () => {
      setDuration(audio.duration || 0);
    };
    const onLoadedMetadata = () => {
      setDuration(audio.duration || 0);
      // 切换音质换源后，跳回原播放进度。
      if (pendingSeekRef.current != null) {
        try {
          audio.currentTime = pendingSeekRef.current;
        } catch {
          // 忽略：偶发 seek 越界
        }
        pendingSeekRef.current = null;
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
      // Build the Web Audio graph the moment playback actually starts,
      // not just on an explicit play-button click. The first track
      // autoplays, so requiring a click meant the visualizer never
      // started until the user happened to hit pause/play. Autoplay
      // is allowed in this Electron shell, so the AudioContext can run
      // here without a fresh gesture. ensureAudioGraph is idempotent —
      // subsequent calls just return the existing analyser.
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
      setError(`音频加载失败（${code}），请尝试切歌`);
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
  }, [track, loadNextTrack, ensureAudioGraph]);

  // Sync play/pause — but only call play() once the audio is actually
  // ready. The <audio> element gets its src set when the <audio> JSX
  // mounts, but data hasn't streamed in yet, so play() right then
  // gets rejected. We wait for `canplay` (see useEffect above) which
  // retries play() with the data loaded.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !track) return;
    if (playing) {
      // Mark intent; onCanPlay (or onLoadedMetadata) will actually play
      // once the browser has decoded enough of the stream.
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
  }, [playing, track]);

  // Bass-driven breathing for the cover card. RAF loop reads the
  // analyser's low-frequency bins and writes a 0..1 intensity to
  // --bass-intensity on :root, which the .cover-card.is-playing
  // animation in App.css uses to set its period. The loop runs at
  // 60fps but only does work while the audio is actually playing
  // (otherwise we just write 0 and skip the analyser read).
  useEffect(() => {
    // 搜索浮层打开时冻结封面脉动。浮层有 backdrop-filter: blur()，会把
    // 背后正在播放的封面持续重新采样；而封面每帧都在 scale/box-shadow
    // 变化（--bass-intensity 驱动），于是（尤其滚动触发浮层重绘时）每次
    // 采样到的都是不同的一帧 → 看起来像封面在不停闪烁/"重载"。搜索期间
    // 让封面保持静止，backdrop-filter 采样到的始终是同一帧 → 不再闪。
    if (searchOpen) {
      document.documentElement.style.setProperty('--bass-intensity', '0');
      return;
    }
    let raf = 0;
    const buf = new Uint8Array(64); // small buffer; we only need low bins
    const tick = () => {
      if (analyser && playing) {
        analyser.getByteFrequencyData(buf);
        // Average bins 1..12 (bin 0 is DC; bin 12 ≈ ~1kHz at 44.1kHz
        // with fftSize=256, which covers kick + bass + low mids).
        let sum = 0;
        for (let i = 1; i <= 12; i++) sum += buf[i];
        const bass = sum / (12 * 255);
        // Slight ease so single transients don't make the pulse
        // stutter. Multiply by 1.1 to push the upper range into
        // visible territory even on bass-light tracks.
        document.documentElement.style.setProperty(
          '--bass-intensity',
          (bass * 1.1).toFixed(3),
        );
      } else {
        document.documentElement.style.setProperty('--bass-intensity', '0');
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, analyser, searchOpen]);

  const handleSelectSource = (next: MusicProvider) => {
    localStorage.setItem(PROVIDER_STORAGE_KEY, next);
    if (next === 'deezer') {
      // Chromium's autoplay policy blocks audio.play() outside a user
      // gesture. The click that called us IS a user gesture, but by
      // the time React renders the player and our useEffect fires
      // play(), the gesture has expired. We pre-arm user activation
      // by creating a transient <audio> with a tiny silent WAV and
      // calling play() on it *synchronously* inside this handler. That
      // play() resolves, but more importantly, it propagates the user
      // activation flag to the document, so subsequent play() calls
      // from the same page (in our effects) are allowed.
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

  const handleSwitchSource = () => {
    audioRef.current?.pause();
    setPlaying(false);
    setTrack(null);
    setCurrentTime(0);
    setDuration(0);
    queueRef.current = null;
    setSearchOpen(false);
    setAuth({ provider: 'qq', loggedIn: false, user: null });
    localStorage.removeItem(PROVIDER_STORAGE_KEY);
    setProvider(null);
    // Drop the analyser so the Visualizer re-shows its placeholder
    // (and, on next play, ensureAudioGraph rebuilds for the new
    // <audio> element rather than reading from a stale MediaStream).
    setAnalyser(null);
    setLyrics(null);
    setLyricsLoading(false);
  };

  /**
   * 从下拉菜单切换音源，不打断当前播放：
   *  - 选中同一个音源 → 什么都不做（歌继续放）
   *  - 选中不同音源 → 只切换「后续曲目来源」，当前歌放完 / 点下一首才生效
   */
  const switchToProvider = (next: MusicProvider) => {
    setSourceMenuOpen(false);
    if (next === provider) return;
    queueRef.current = null; // 搜索队列是 QQ 专属，切走就清掉
    setSearchOpen(false);
    localStorage.setItem(PROVIDER_STORAGE_KEY, next);
    // 当前有歌在放 → 延迟加载，保住这首；否则（空闲）立即加载新音源。
    if (track) skipAutoLoadRef.current = true;
    setProvider(next);
  };

  /** 切换音质（QQ / 网易云）：立即用新音质重载当前歌，保留播放进度。 */
  const changeQuality = (q: QqQuality) => {
    setQualityMenuOpen(false);
    setQqQuality(q);
    qqQualityRef.current = q;
    localStorage.setItem(QQ_QUALITY_KEY, q);
    const audio = audioRef.current;
    if (
      audio &&
      track &&
      (track.provider === 'qq' || track.provider === 'netease') &&
      track.audioUrl
    ) {
      pendingSeekRef.current = audio.currentTime; // 换源后跳回此进度
      const base = track.audioUrl
        .replace(/[?&]q=[^&]*/, '')
        .replace(/[?&]$/, '');
      const sep = base.includes('?') ? '&' : '?';
      setTrack((prev) =>
        prev ? { ...prev, audioUrl: `${base}${sep}q=${q}` } : prev,
      );
    }
  };

  const handlePlayPause = () => {
    // Build the audio graph the first time the user hits play.
    // Subsequent clicks just resume the existing context if needed.
    ensureAudioGraph();
    setPlaying((p) => !p);
  };
  const handleSkip = () => loadNextTrack();

  /** Slider drag: update volume. If the user drags up from 0 while
   *  muted, automatically unmute — the gesture implies "I want
   *  sound now", not "I want my mute preference preserved". */
  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value) / 100;
    setVolume(v);
    if (v > 0 && muted) setMuted(false);
  };

  /** Mute button: toggle muted without touching volume. The slider
   *  stays at its previous position so unmuting restores the user's
   *  last-set level. */
  const toggleMute = () => {
    setMuted((m) => !m);
  };

  const handleLike = async () => {
    if (!track || !provider) return;
    // 统一搜索路径：fan-out 到所有 hasCopyright 的平台。
    // 判定方式：当前 track 来自 unified queueRef（带 mergedId），
    // 且 unifiedItems 里能找到它。SearchPanel 那一侧已经过滤掉
    // bestSource=null 的，所以这里能 fan-out 的前提是至少一个 source
    // 有版权。
    const q = queueRef.current;
    const current = q?.unifiedItems?.[q.idx];
    if (q?.mergedId && current && current.bestSource) {
      const nextLiked = !(fanOutCount > 0);
      const sources = current.sources
        .filter((s) => s.hasCopyright)
        .map((s) => ({ platform: s.platform, trackId: s.trackId }));
      try {
        const result = await fanOutLike(q.mergedId, sources, nextLiked);
        // 成功：更新 ❤ 角标数。fannedOutTo 现在是"当前 mergedId 心动过的
        // 全部平台"（含之前单独心过的），不再是"本次 flip"——所以角标数
        // 语义明确 = 这首歌在多少个平台上有 ❤。
        setFanOutCount(nextLiked ? result.fannedOutTo.length : 0);
        setTrack((prev) => (prev ? { ...prev, liked: nextLiked } : prev));
      } catch (e) {
        setError(`心动作业失败：${(e as Error).message}`);
      }
      return;
    }
    // 单平台路径：电台 / 现在的 now-playing，行为完全保留不变。
    const result = await toggleLike(provider, track.id);
    if (result.success) {
      setTrack((prev) => (prev ? { ...prev, liked: result.liked } : prev));
      setFanOutCount(0);
    }
  };

  const handleDislike = async () => {
    if (!track || !provider) return;
    await dislike(provider, track.id);
    loadNextTrack();
  };

  /**
   * NetEase login: 服务端生成二维码，手机网易云 App 扫码确认，服务端轮询
   * 拿到 MUSIC_U 入 session。浏览器和 Electron 统一走这个弹窗。
   */
  /**
   * NetEase login. In Electron, open an embedded music.163.com login window and
   * capture MUSIC_U from its real Chromium session — this is the only reliable
   * path, because NetEase risk control (QR-check code 8821) rejects
   * server-side QR-login polling. In a plain browser (no cookie capture), fall
   * back to the QR modal, which also offers a manual "paste MUSIC_U" entry.
   */
  const handleNeteaseLogin = async () => {
    setError(null);
    if (!isElectron || !window.electronAPI?.neteaseLogin) {
      setShowCookieFallback(true);
      return;
    }
    setLoggingIn(true);
    try {
      const result = await window.electronAPI.neteaseLogin();
      if (!result.success || !result.musicU) {
        setError(
          result.error === 'login_cancelled'
            ? '登录已取消'
            : result.error ?? '登录失败',
        );
        return;
      }
      const r = await loginNeteaseCookie(
        result.musicU,
        result.csrfToken,
        result.extraCookies,
      );
      if (r.success) {
        setAuth({ provider: 'netease', loggedIn: true, user: r.user });
        loadNextTrack();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoggingIn(false);
    }
  };

  /**
   * QQ login: in Electron, open an embedded QQ Music login window that
   * captures the real login cookie (qm_keyst / uin …) automatically —
   * no appid/secret, no QQ Connect OAuth. In a plain browser there's no
   * cookie-capture path, so we tell the user to use the desktop app.
   */
  const handleQqLogin = async () => {
    if (!isElectron || !window.electronAPI?.qqLogin) {
      setError('QQ 音乐登录需要在桌面 App 中进行(浏览器无法捕获登录 cookie)');
      return;
    }
    setError(null);
    setLoggingIn(true);
    try {
      const result = await window.electronAPI.qqLogin();
      if (!result.success || !result.cookie) {
        setError(result.error ?? '登录已取消');
        return;
      }
      const r = await loginQqCookie(
        result.cookie,
        result.uin,
        result.extraCookies,
      );
      if (r.success) {
        setAuth({ provider: 'qq', loggedIn: true, user: r.user });
        loadNextTrack();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoggingIn(false);
    }
  };

  const handleLogout = async () => {
    if (!provider) return;
    await logout(provider);
    setAuth({ provider, loggedIn: false, user: null });
  };

  /**
   * 推荐按钮：先看 status，没 key 弹 key 输入；有了直接跑。
   * 跑完把 UnifiedSearchItem[] 当搜索队列灌进 handlePlaySearch 那条路。
   */
  const handleReco = useCallback(async () => {
    setError(null);
    // 重新拉一次 status（防 stale）
    let status = recoStatus;
    try {
      status = await fetchRecoStatus();
      setRecoStatus(status);
    } catch (e) {
      setError(`推荐状态查询失败：${(e as Error).message}`);
      return;
    }
    if (!status.configured) {
      setRecoKeyOpen(true);
      return;
    }
    setRecoRunning(true);
    try {
      // 库为空 → 先自动导入各平台"我的喜欢"（当前主要是网易云 / Spotify，
      // 需已登录）。之前这里只丢一句"先 POST /music/library/import"，普通
      // 用户点不了任何按钮，推荐等于死路——改成一键自动导入。
      if (status.librarySize === 0) {
        const lib = await importLibrary();
        const imported = lib.sources.reduce((n, s) => n + s.count, 0);
        if (imported === 0) {
          const hints = lib.sources
            .filter((s) => s.error)
            .map((s) => `${PROVIDER_LABELS[s.provider]}: ${s.error}`)
            .join('；');
          setError(
            `没有可导入的"我的喜欢"，先登录网易云或 Spotify 再试${
              hints ? `（${hints}）` : ''
            }`,
          );
          return;
        }
        status = { ...status, librarySize: lib.items.length };
        setRecoStatus(status);
      }
      const result = await runReco({ count: 10 });
      if (result.items.length === 0) {
        setError('推荐没拿到结果，换个心情/语言试试？');
        return;
      }
      // 走搜索队列的同一条播放链路
      handlePlaySearch(result.items, 0);
    } catch (e) {
      setError(`推荐失败：${(e as Error).message}`);
    } finally {
      setRecoRunning(false);
    }
  }, [recoStatus, handlePlaySearch]);

  const handleSaveRecoKey = useCallback(async (key: string) => {
    if (!key || key.length < 8) {
      setError('key 太短');
      return;
    }
    try {
      const r = await saveRecoKey(key);
      setRecoKeyOpen(false);
      setRecoStatusVersion((v) => v + 1);
      setError(null);
      // 不把 tail 在 UI 上展示，避免提示"已设置"。用户可以从 status 推断。
      void r; // 仅用于触发刷新
    } catch (e) {
      setError(`保存 key 失败：${(e as Error).message}`);
    }
  }, []);

  /**
   * Wipe all client-side state and bounce back to the source picker. Useful
   * when stuck on a provider that's no longer working (e.g. NetEase), or
   * to start fresh.
   */
  const handleResetLocal = (): void => {
    localStorage.clear();
    sessionStorage.clear();
    audioRef.current?.pause();
    setPlaying(false);
    setTrack(null);
    setCurrentTime(0);
    setDuration(0);
    queueRef.current = null;
    setSearchOpen(false);
    setAuth({ provider: 'qq', loggedIn: false, user: null });
    setProvider(null);
    setTheme('system');
    // Same reasoning as handleSwitchSource — drop the analyser so it
    // doesn't keep reading from a MediaStream whose source <audio>
    // element we just unmounted.
    setAnalyser(null);
    setLyrics(null);
    setLyricsLoading(false);
  };

  const handleCookieFallbackSuccess = (user: AuthUser) => {
    setShowCookieFallback(false);
    if (!provider) return;
    setAuth({ provider, loggedIn: true, user });
    loadNextTrack();
  };

  if (!provider) {
    return <SourceSelect onSelect={handleSelectSource} />;
  }

  return (
    // search-open 时给根节点加个类：CSS 据此暂停封面上仍在跑的 CSS 动画
    // （sheen 扫光），让封面在搜索浮层的 backdrop-filter 背后完全静止，
    // 配合上面冻结的低频脉动，彻底消除"透过模糊层重采样导致的闪烁"。
    <div className={`app${searchOpen ? ' search-open' : ''}`}>
      {/* Top bar: source switch on the left, then provider-specific
          controls (preset / search / quality), then auth + reset
          pushed to the right via margin-left:auto. macOS traffic-light
          safe area (96px) is handled by the titlebar's padding-left
          AND the source-switch's left offset. */}
      <div className="titlebar">
        {/* Source-switch — always present, lives in the titlebar flow.
            The wrap is `position:fixed` so the dropdown menu can anchor
            to the button even though the titlebar itself is a flex
            row (so the button still respects flex spacing). */}
        <div className="source-switch-wrap">
          <button
            className="titlebar-btn source-switch"
            onClick={() => setSourceMenuOpen((v) => !v)}
            title="切换音源"
          >
            {PROVIDER_LABELS[provider]}
            <span className="source-switch-icon">⇄</span>
          </button>

          {sourceMenuOpen && (
            <>
              {/* 透明背板：点空白处关闭菜单，不影响播放 */}
              <div
                className="source-menu-backdrop"
                onClick={() => setSourceMenuOpen(false)}
              />
              <div className="source-menu" role="menu">
                {(['qq', 'netease', 'deezer'] as MusicProvider[]).map((p) => (
                  <button
                    key={p}
                    className={`source-menu-item${
                      p === provider ? ' source-menu-item--active' : ''
                    }`}
                    onClick={() => switchToProvider(p)}
                    role="menuitem"
                  >
                    <span className="source-menu-check">
                      {p === provider ? '✓' : ''}
                    </span>
                    <span className="source-menu-label">{PROVIDER_LABELS[p]}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {provider === 'deezer' && deezerEditorials.length > 0 && (
          <select
            className="preset-select"
            value={deezerPreset}
            onChange={(e) => {
              const next = e.target.value;
              setDeezerPreset(next);
              localStorage.setItem(DEEZER_PRESET_KEY, next);
            }}
            title="Deezer 榜单"
          >
            {deezerEditorials.map((e) => (
              <option key={e.id} value={e.name === 'All' ? 'all' :
                e.name === '亚洲流行' ? 'asia' :
                e.name === '国际流行' ? 'pop' :
                e.name === '说唱' ? 'rap' :
                e.name === '摇滚' ? 'rock' :
                e.name === '舞曲' ? 'dance' :
                e.name === 'R&B' ? 'rnb' :
                e.name === '古典' ? 'classical' :
                e.name === '爵士' ? 'jazz' : 'all'}>
                {e.name}{e.region ? ` · ${e.region}` : ''}
              </option>
            ))}
          </select>
        )}

        {provider && (
          <button
            className="titlebar-btn search-btn"
            onClick={() => setSearchOpen(true)}
            title="搜索歌手 / 歌名（跨平台统一搜索）"
          >
            🔍 搜索
          </button>
        )}

        {provider && (
          <button
            className="titlebar-btn reco-btn"
            onClick={() => void handleReco()}
            disabled={recoRunning}
            title={
              recoStatus?.configured
                ? '基于你的统一库推荐新歌'
                : '设置 DeepSeek API key 后基于你的统一库推荐新歌'
            }
          >
            {recoRunning ? '…' : '🎲 推荐'}
            {recoStatus && !recoStatus.configured && (
              <span className="reco-key-dot" aria-hidden="true" />
            )}
          </button>
        )}

        {(provider === 'qq' || provider === 'netease') && auth.loggedIn && (
          <div className="quality-wrap">
            <button
              className="titlebar-btn"
              onClick={() => setQualityMenuOpen((v) => !v)}
              title="音质（无损需会员）"
            >
              {QQ_QUALITY_LABELS[qqQuality]}
            </button>
            {qualityMenuOpen && (
              <>
                <div
                  className="source-menu-backdrop"
                  onClick={() => setQualityMenuOpen(false)}
                />
                <div className="source-menu source-menu--right" role="menu">
                  {(['standard', 'high', 'lossless'] as QqQuality[]).map((q) => (
                    <button
                      key={q}
                      className={`source-menu-item${
                        q === qqQuality ? ' source-menu-item--active' : ''
                      }`}
                      onClick={() => changeQuality(q)}
                      role="menuitem"
                    >
                      <span className="source-menu-check">
                        {q === qqQuality ? '✓' : ''}
                      </span>
                      <span className="source-menu-label">
                        {QQ_QUALITY_LABELS[q]}
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {auth.loggedIn ? null : (
          <button
            className="titlebar-btn login-btn"
            onClick={provider === 'netease' ? handleNeteaseLogin : handleQqLogin}
            disabled={loggingIn}
          >
            {loggingIn ? '登录中…' : '登录'}
          </button>
        )}

        {/* When logged in, surface the account nickname as a button
            that triggers logout / source-switch. Pushed to the right
            edge of the titlebar via margin-left:auto (set in CSS). */}
        {auth.loggedIn && (
          <button
            className="titlebar-btn account-btn"
            onClick={provider === 'deezer' ? handleSwitchSource : handleLogout}
            title={provider === 'deezer' ? '切换音源' : '退出登录'}
          >
            {auth.user?.nickname || 'User'}
          </button>
        )}

        <button
          className="titlebar-btn reset-btn"
          onClick={handleResetLocal}
          title="清空本地缓存（localStorage + sessionStorage + 当前曲目）"
        >
          ↺
        </button>
      </div>

      {/* Full-window blurred cover layer. Sits behind everything
          else in the window so the glass cards above it have a
          rich, soft, colour-saturated backdrop to actually blur.
          Without this, backdrop-filter:blur(40px) has nothing to
          blur except the body's flat radial gradients — and the
          "frosted glass" effect reads as plain translucent panels.
          background-image is set by applyCoverImage() via the
          bgLayerRef below, so it tracks the current track. */}
      <div className="bg-layer" ref={bgLayerRef} aria-hidden="true" />

      {/* Bento grid: cover card (big, left) | side column (now-playing +
          queue). The cover-load hook writes the user's background
          image onto .cover-art via background-image. No vinyl — this
          is the modern Bento aesthetic. */}
      <div className="app-grid">
        <div
          className={`glass-card cover-card${playing ? ' is-playing' : ''}`}
        >
          {/* key=track.id forces React to unmount + remount the
              cover-stack on every track change, which retriggers
              the CSS @keyframes on .cover-stack (see App.css).
              Without the key, the same DOM node would just get a
              new background-image and the spring-in wouldn't play.
              The role- prefix is required because cover-stack and
              cover-meta are siblings under cover-card and both want
              to remount on track change — without the prefix they'd
              share the same key and React would warn / behave
              unpredictably. */}
          <div className="cover-stack" key={`stack-${track?.id ?? 'empty'}`}>
            <div
              className="cover-art"
              ref={coverBackdropRef}
              onError={() => {
                document.documentElement.style.setProperty(
                  '--cover-accent',
                  '#1a1a1f',
                );
                document.documentElement.style.setProperty(
                  '--cover-glow',
                  'transparent',
                );
              }}
            >
              {!track?.coverUrl && (
                <div className="cover-art-placeholder">♪</div>
              )}
            </div>
            {/* Mirror reflection: picks up the same background-image
                via `background-image: inherit`, vertically flipped
                and blurred to evoke a wet-floor reflection. The mask
                fades it out so it blends with the dark background
                instead of clipping hard against the cover edge. */}
            <div className="cover-art-reflection" aria-hidden="true" />
          </div>
          <div className="cover-meta" key={`meta-${track?.id ?? 'empty'}`}>
            <div className="track-title">{track?.title || '...'}</div>
            <div className="track-artist">{track?.artist || '正在加载'}</div>
            {track?.album && (
              <div className="track-album">{track.album}</div>
            )}
            {error && (
              <ErrorPanel message={error} onClose={() => setError(null)} />
            )}
          </div>
        </div>

        <div className="side-column">
          <div className="glass-card side-card">
            <div className="side-card-label">Now Playing</div>
            <div className="now-playing-grid">
              <div className="now-playing-cell">
                <div className="now-playing-cell-label">Source</div>
                <div className="now-playing-cell-value">
                  {PROVIDER_LABELS[provider]}
                </div>
              </div>
              <div className="now-playing-cell">
                <div className="now-playing-cell-label">Quality</div>
                <div className="now-playing-cell-value">
                  {QQ_QUALITY_LABELS[qqQuality]}
                </div>
              </div>
              <div className="now-playing-cell">
                <div className="now-playing-cell-label">Status</div>
                <div className="now-playing-cell-value">
                  {loading ? 'Loading…' : playing ? 'Playing' : 'Paused'}
                </div>
              </div>
              <div className="now-playing-cell">
                <div className="now-playing-cell-label">Account</div>
                <div className="now-playing-cell-value">
                  {auth.user?.nickname ?? 'Guest'}
                </div>
              </div>
            </div>
          </div>

          <div className="glass-card side-card lyrics-card">
            <div className="side-card-label">Lyrics</div>
            <LyricsPanel
              lyrics={lyrics}
              currentTime={currentTime}
              loading={lyricsLoading}
              onSeek={(time) => {
                if (audioRef.current) {
                  audioRef.current.currentTime = time;
                }
              }}
            />
          </div>
        </div>
      </div>

      {/* Progress bar — full-width standalone row between the cards
          and the transport. Thin line + growing thumb dot on hover.
          The bottom of this row holds the time codes on the left and
          the volume group on the right (justify-between), so the
          time and the volume sit on opposite ends of the same line
          without crowding. */}
      <div className="progress-row">
        <div
          className="progress-bar"
          onClick={(e) => {
            const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
            const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            if (audioRef.current) {
              audioRef.current.currentTime = ratio * (audioRef.current.duration || 0);
            }
          }}
        >
          <div
            className="progress-fill"
            style={{ width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%` }}
          />
        </div>
        <div className="progress-meta">
          <div className="progress-time">
            <span>{formatTime(currentTime)}</span>
            <span>{formatTime(duration)}</span>
          </div>
          <div className="volume-group">
            <button
              className={`volume-btn${muted ? ' is-muted' : ''}`}
              onClick={toggleMute}
              title={muted ? '取消静音' : '静音'}
              aria-label={muted ? '取消静音' : '静音'}
            >
              <VolumeIcon volume={volume} muted={muted} />
            </button>
            <input
              type="range"
              className="volume-slider"
              min={0}
              max={100}
              step={1}
              value={Math.round(volume * 100)}
              onChange={handleVolumeChange}
              aria-label="音量"
              style={{
                background: `linear-gradient(to right, var(--accent-live) ${volume * 100}%, color-mix(in oklab, var(--text-primary) 18%, transparent) ${volume * 100}%)`,
              }}
            />
          </div>
        </div>
      </div>

      {/* Bottom transport: dislike / like / play / skip. */}
      <div className="transport-row">
        <button
          className="control-btn dislike-btn"
          onClick={handleDislike}
          disabled={!track}
          title="不感兴趣"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
          </svg>
        </button>

        <button
          className="control-btn like-btn"
          onClick={handleLike}
          disabled={!track}
          title={
            fanOutCount > 0
              ? `已 fan-out 心动了 ${fanOutCount} 个平台`
              : '红心'
          }
        >
          <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
            <path d="M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3zm-4.4 15.55l-.1.1-.1-.1C7.14 14.24 4 11.39 4 8.5 4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5 0 2.89-3.14 5.74-7.9 10.05z" />
          </svg>
          {fanOutCount > 1 && (
            <span className="like-btn-badge">{fanOutCount}❤</span>
          )}
        </button>

        <button
          className="control-btn play-btn"
          onClick={handlePlayPause}
          disabled={!track || loading}
          title={playing ? '暂停' : '播放'}
        >
          {loading ? (
            <svg className="spinner" viewBox="0 0 24 24" width="28" height="28">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" fill="none" strokeDasharray="31.4 31.4" />
            </svg>
          ) : playing ? (
            <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor">
              <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>

        <button
          className="control-btn skip-btn"
          onClick={handleSkip}
          disabled={loading}
          title="下一首"
        >
          <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
            <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
          </svg>
        </button>
      </div>

      {/* Always mounted (never conditionally unmounted) so the Web
          Audio graph built on it in ensureAudioGraph stays valid for
          the whole session — createMediaElementSource can only be
          called once per element, and a remounted element would
          orphan the cached source node. src is left unset when there's
          no track. crossOrigin="anonymous" + the server's CORS header
          on /music/stream make the media CORS-clean so the analyser
          gets real samples (the visualizer's whole prerequisite). */}
      <audio
        ref={audioRef}
        src={track?.audioUrl || undefined}
        crossOrigin="anonymous"
        preload="auto"
      />

      {showCookieFallback && (
        <NeteaseCookieModal
          onClose={() => setShowCookieFallback(false)}
          onSuccess={handleCookieFallbackSuccess}
        />
      )}

      {searchOpen && provider && (
        <SearchPanel
          onPlay={handlePlaySearch}
          onClose={() => setSearchOpen(false)}
        />
      )}

      {recoKeyOpen && (
        <RecoKeyModal
          onSave={handleSaveRecoKey}
          onClose={() => setRecoKeyOpen(false)}
        />
      )}
    </div>
  );
}
