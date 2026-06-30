import { useState, useEffect, useRef, useCallback } from 'react';
import {
  fetchNextTrack,
  fetchDeezerEditorials,
  toggleLike,
  dislike,
  getAuthStatus,
  getLoginUrl,
  logout,
  loginNeteaseCookie,
  PROVIDER_LABELS,
} from './api';
import type {
  Track,
  AuthStatus,
  MusicProvider,
  AuthUser,
  DeezerEditorial,
} from './api';
import SourceSelect from './SourceSelect';
import NeteaseCookieModal from './NeteaseCookieModal';
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
    const stored = readStoredProvider();
    // NetEase is temporarily disabled (weapi 200 + empty body since
    // 2024 anti-bot upgrade). If the user has it stored, force them back
    // to the source picker so they see the QQ option.
    if (stored === 'netease') {
      localStorage.removeItem(PROVIDER_STORAGE_KEY);
      return null;
    }
    return stored;
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

  const loadNextTrack = useCallback(async () => {
    if (!provider) return;
    setLoading(true);
    setError(null);
    try {
      const next = await fetchNextTrack(
        provider,
        provider === 'deezer' ? deezerPreset : undefined,
      );
      // Resolve the server-relative audioUrl to an absolute URL. The
      // <audio> element loads this directly, so a relative path won't
      // resolve correctly in production (where Electron loads the
      // renderer from file://). In dev we keep it relative so Vite's
      // /music proxy routes it to the NestJS server.
      const audioUrl =
        next.audioUrl && next.audioUrl.startsWith('/')
          ? (import.meta.env.DEV ? '' : 'http://localhost:3200') + next.audioUrl
          : next.audioUrl;
      console.log(
        '[audio] track set, audioUrl=',
        audioUrl,
        'readyState-after-set will be visible in next tick',
      );
      // If the new track has a cover, push it into both the left
      // backdrop and the global bg-layer so the window echoes the
      // new song. Fire-and-forget; the request resolves async.
      if (next.coverUrl) {
        void applyCoverImage(next.coverUrl, bgLayerRef.current, coverBackdropRef.current);
      }
      setTrack({ ...next, audioUrl });
      setCurrentTime(0);
      // We always want to auto-play once data is ready. We don't call
      // play() here — that would race against the audio element's own
      // data loading. Instead, set the intent flag; the onCanPlay
      // listener will call play() when data is actually available, and
      // the play/pause useEffect below will also try once it sees
      // readyState >= 3.
      const audio = audioRef.current;
      if (audio) audio.dataset.wantPlay = '1';
      setPlaying(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [provider, deezerPreset]);

  useEffect(() => {
    if (!provider) return;
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
    setAuth({ provider: 'qq', loggedIn: false, user: null });
    localStorage.removeItem(PROVIDER_STORAGE_KEY);
    setProvider(null);
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
   * NetEase login: in Electron, open an embedded login window that captures
   * MUSIC_U automatically. In a plain browser tab, fall back to the manual
   * cookie paste flow.
   */
  const handleNeteaseLogin = async () => {
    if (!isElectron || !window.electronAPI) {
      setShowCookieFallback(true);
      return;
    }
    setError(null);
    setLoggingIn(true);
    try {
      const result = await window.electronAPI.neteaseLogin();
      if (!result.success || !result.musicU) {
        setError(result.error ?? '登录已取消');
        return;
      }
      const r = await loginNeteaseCookie(
        result.musicU,
        result.csrfToken,
        result.extraCookies,
      );
      if (r.success) {
        setAuth({ provider: 'netease', loggedIn: true, user: r.user });
        // 登录成功立刻拉一首——之前那次失败是因为还没登录窗口
        loadNextTrack();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoggingIn(false);
    }
  };

  /**
   * QQ login: redirect to QQ OAuth. Works the same in Electron and browser.
   */
  const handleQqLogin = () => {
    window.location.href = getLoginUrl('qq');
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
    setAuth({ provider: 'qq', loggedIn: false, user: null });
    setProvider(null);
    setTheme('system');
  };

  const handleCookieFallbackSuccess = (user: AuthUser) => {
    setShowCookieFallback(false);
    if (!provider) return;
    setAuth({ provider, loggedIn: true, user });
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
      {/* Source-switch button — pulled out of the titlebar to the
          top-left of the body area. Keeps the full "DEEZER ⇄"
          label so the provider name is obvious. */}
      <button
        className="body-corner-btn source-switch"
        onClick={handleSwitchSource}
        title={`切换音源（${PROVIDER_LABELS[provider]}）`}
      >
        {PROVIDER_LABELS[provider]}
        <span className="source-switch-icon">⇄</span>
      </button>

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
    </div>
  );
}