import { useState, useEffect, useRef, useCallback } from 'react';
import {
  fetchNextTrack,
  fetchDeezerEditorials,
  toggleLike,
  dislike,
  getAuthStatus,
  logout,
  loginQqCookie,
  loginNeteaseCookie,
  PROVIDER_LABELS,
  QQ_QUALITY_LABELS,
} from './api';
import type {
  Track,
  AuthStatus,
  MusicProvider,
  AuthUser,
  DeezerEditorial,
  QqQuality,
} from './api';
import SourceSelect from './SourceSelect';
import NeteaseCookieModal from './NeteaseCookieModal';
import SearchPanel from './SearchPanel';
import ErrorPanel from './ErrorPanel';
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
 * To dodge cross-origin tainting we use a fetch + createImageBitmap
 * pipeline (with `mode: 'cors'`), which gives us a clean canvas
 * even for Deezer CDN covers. The Image element we create isn't
 * attached to the DOM — it's a pure data path.
 */
async function applyCoverImage(
  url: string,
  bgLayer: HTMLDivElement | null,
  coverBackdrop: HTMLDivElement | null,
): Promise<void> {
  let bitmap: ImageBitmap;
  try {
    const res = await fetch(url, { mode: 'cors' });
    const blob = await res.blob();
    bitmap = await createImageBitmap(blob);
  } catch {
    // CORS-locked cover. We can still set the background-image (the
    // browser is happy to render cross-origin <img>s) — we just can't
    // extract the average colour. Fall back to a neutral dark accent.
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

  // 2) Set the cover as the bg-layer and the left-column backdrop
  // (browser will fetch + cache the URL once for both).
  if (coverBackdrop) coverBackdrop.style.backgroundImage = `url(${url})`;
  if (bgLayer) bgLayer.style.backgroundImage = `url(${url})`;

  bitmap.close?.();
}

/**
 * Apply the user's saved theme override (or system default if none).
 * Called once on mount and after the user toggles the theme button.
 */
function applyTheme(): 'dark' | 'light' {
  const root = document.documentElement;
  const saved = localStorage.getItem('musicbox:theme') as 'dark' | 'light' | null;
  if (saved === 'dark' || saved === 'light') {
    root.setAttribute('data-theme', saved);
    return saved;
  }
  // No override — clear the explicit attr so the @media
  // prefers-color-scheme rule takes over.
  root.removeAttribute('data-theme');
  return window.matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';
}

function readStoredProvider(): MusicProvider | null {
  const stored = localStorage.getItem(PROVIDER_STORAGE_KEY);
  if (stored === 'qq' || stored === 'netease' || stored === 'deezer') {
    return stored;
  }
  return null;
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
  const [qualityMenuOpen, setQualityMenuOpen] = useState(false);
  const QQ_QUALITY_KEY = 'musicbox:qq-quality';
  const [qqQuality, setQqQuality] = useState<QqQuality>(() => {
    const v = localStorage.getItem(QQ_QUALITY_KEY);
    return v === 'high' || v === 'lossless' ? v : 'standard';
  });
  // 搜索模式的客户端队列。非空时 loadNextTrack 在结果里前进，而不是走
  // 服务端电台。用 ref 存，避免 loadNextTrack 的闭包读到旧值。
  const queueRef = useRef<{ tracks: Track[]; idx: number } | null>(null);
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
  // The left-side cover-art container. We use a div + background-image
  // (rather than an <img>) so the cover can fill its column edge-to-edge
  // without distorting or showing letterboxing.
  const coverBackdropRef = useRef<HTMLDivElement>(null);
  // Theme: 'dark' | 'light' | 'system'. 'system' is the default —
  // the UI follows `prefers-color-scheme` and we don't write a
  // data-theme attribute. The user's explicit pick is stored in
  // localStorage so it sticks across restarts.
  const [theme, setTheme] = useState<'dark' | 'light' | 'system'>(() => {
    const saved = localStorage.getItem('musicbox:theme') as
      | 'dark'
      | 'light'
      | 'system'
      | null;
    return saved ?? 'system';
  });
  // The active (resolved) theme — what the CSS variables actually
  // reflect. We track it so the toggle button shows the right glyph.
  const [resolvedTheme, setResolvedTheme] = useState<'dark' | 'light'>(
    'dark',
  );

  // Apply the theme on mount and whenever the user toggles.
  useEffect(() => {
    localStorage.setItem('musicbox:theme', theme);
    if (theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      setResolvedTheme(mq.matches ? 'dark' : 'light');
      const handler = (e: MediaQueryListEvent) =>
        setResolvedTheme(e.matches ? 'dark' : 'light');
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    }
    setResolvedTheme(theme);
  }, [theme]);

  const cycleTheme = useCallback(() => {
    setTheme((t) => (t === 'system' ? 'dark' : t === 'dark' ? 'light' : 'system'));
  }, []);

  // Fetch the list of available Deezer editorials once on mount.
  useEffect(() => {
    fetchDeezerEditorials()
      .then(setDeezerEditorials)
      .catch(() => setDeezerEditorials([]));
  }, []);

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

  // 把一首 Track 呈现到播放器：解析绝对 audioUrl、换封面、置播放意图。
  // 服务端电台和搜索结果两条路径都复用它。
  const presentTrack = useCallback((next: Track) => {
    let audioUrl =
      next.audioUrl && next.audioUrl.startsWith('/')
        ? (import.meta.env.DEV ? '' : 'http://localhost:3200') + next.audioUrl
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
      void applyCoverImage(
        next.coverUrl,
        bgLayerRef.current,
        coverBackdropRef.current,
      );
    }
    setTrack({ ...next, audioUrl });
    setCurrentTime(0);
    const audio = audioRef.current;
    if (audio) audio.dataset.wantPlay = '1';
    setPlaying(true);
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

  /** 从搜索面板点某一行：整批结果作为队列，从 index 开始播。 */
  const handlePlaySearch = useCallback(
    (results: Track[], index: number) => {
      queueRef.current = { tracks: results, idx: index };
      setSearchOpen(false);
      setError(null);
      presentTrack(results[index]);
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
  }, [track, loadNextTrack]);

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

  const handlePlayPause = () => setPlaying((p) => !p);
  const handleSkip = () => loadNextTrack();

  const handleLike = async () => {
    if (!track || !provider) return;
    const result = await toggleLike(provider, track.id);
    if (result.success) {
      setTrack((prev) => (prev ? { ...prev, liked: result.liked } : prev));
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

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="app">
      {/* Top bar: all the switching controls live up here. macOS
          traffic-light safe area (78px) is handled by the titlebar's
          padding-left. */}
      <div className="titlebar">
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

        {(provider === 'qq' || provider === 'netease') && auth.loggedIn && (
          <button
            className="titlebar-btn search-btn"
            onClick={() => setSearchOpen(true)}
            title="搜索歌手 / 歌名"
          >
            🔍 搜索
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

        <button
          className="titlebar-btn reset-btn"
          onClick={handleResetLocal}
          title="清空本地缓存（localStorage + sessionStorage + 当前曲目）"
        >
          ↺
        </button>
      </div>

      {/* Cover: classic round black disc, rotating gently while
          playing. The cover-load hook puts the user's background
          image here via background-image; the LP textures (rings,
          centre label, hole) are absolutely-positioned siblings so
          they rotate together. */}
      {/* Source-switch — 点击弹出下拉菜单，不打断当前播放。 */}
      <div className="source-switch-wrap">
        <button
          className="body-corner-btn source-switch"
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

      {/* The provider's "logged in as" label moves to the top-right
          corner, mirroring the source-switch on the left. */}
      {auth.loggedIn && (
        <button
          className="body-corner-btn body-corner-btn--right"
          onClick={provider === 'deezer' ? handleSwitchSource : handleLogout}
          title={provider === 'deezer' ? '切换音源' : '退出登录'}
        >
          {auth.user?.nickname || 'User'}
        </button>
      )}

      <div className="cover-container">
        <div
          className={`cover-backdrop${playing ? '' : ' paused'}`}
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
          <div className="vinyl-rings" />
          <div className="vinyl-label" />
          <div className="vinyl-hole" />
        </div>
      </div>

      {/* Track info centred under the cover. */}
      <div className="track-info">
        <div className="track-title">{track?.title || '...'}</div>
        <div className="track-artist">
          {track ? `${track.artist} · ${track.album}` : '正在加载'}
        </div>
        {error && (
          <ErrorPanel message={error} onClose={() => setError(null)} />
        )}
      </div>

      {/* Progress line + timecodes above the transport. */}
      <div className="progress-container">
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
        <div className="progress-time">
          <span>{formatTime(currentTime)}</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>

      {/* Bottom transport: dislike / play / skip — no like here, that
          lives in the titlebar (or we can move it down later). */}
      <div className="controls">
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
          title="红心"
        >
          <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
            <path d="M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3zm-4.4 15.55l-.1.1-.1-.1C7.14 14.24 4 11.39 4 8.5 4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5 0 2.89-3.14 5.74-7.9 10.05z" />
          </svg>
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

      {track && track.audioUrl && (
        <audio ref={audioRef} src={track.audioUrl} preload="auto" />
      )}

      {showCookieFallback && (
        <NeteaseCookieModal
          onClose={() => setShowCookieFallback(false)}
          onSuccess={handleCookieFallbackSuccess}
        />
      )}

      {searchOpen && (provider === 'qq' || provider === 'netease') && (
        <SearchPanel
          provider={provider}
          onPlay={handlePlaySearch}
          onClose={() => setSearchOpen(false)}
        />
      )}
    </div>
  );
}