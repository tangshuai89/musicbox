import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import {
  getAuthStatus,
  getSpotifyStatus,
  logout,
  loginQqCookie,
  loginNeteaseCookie,
  setSpotifyClientId,
  startSpotify,
} from '../api';
import type { AuthStatus, AuthUser, MusicProvider } from '../api';

/** True when running inside the Electron shell (not just a browser tab). */
const isElectron =
  typeof window !== 'undefined' && Boolean(window.electronAPI?.isElectron);

/**
 * Auth for the current provider: status fetch on provider change, QQ /
 * NetEase login (Electron cookie-capture, with a QR-modal fallback in a
 * plain browser), logout, and the manual-cookie success path.
 *
 * `loadNextTrack` is called after a successful login so playback starts
 * immediately; `setError` surfaces failures in the shared error panel.
 */
export function useAuth(
  provider: MusicProvider | null,
  loadNextTrack: () => void,
  setError: Dispatch<SetStateAction<string | null>>,
) {
  const [auth, setAuth] = useState<AuthStatus>({
    provider: 'qq',
    loggedIn: false,
    user: null,
  });
  const [loggingIn, setLoggingIn] = useState(false);
  const [showCookieFallback, setShowCookieFallback] = useState(false);

  // OAuth callback handler + status fetch on provider change.
  useEffect(() => {
    if (!provider) return;
    const params = new URLSearchParams(window.location.search);
    const errParam = params.get('error');
    if (errParam) setError(decodeURIComponent(errParam));
    getAuthStatus(provider)
      .then((status) => {
        // Spotify needs an extra tier query — /v1/me's product field isn't
        // returned by the generic /auth/status. fetch tier only on first
        // hit, then merge.
        if (provider === 'spotify' && status.loggedIn) {
          void getSpotifyStatus().then((s) => {
            setAuth({ ...status, tier: s.tier });
          });
        } else {
          setAuth(status);
        }
      })
      .catch((e) => setError((e as Error).message));
    if (params.toString()) {
      window.history.replaceState({}, '', '/');
    }
  }, [provider, setError]);

  /**
   * NetEase login. In Electron, open an embedded music.163.com login window
   * and capture MUSIC_U from its real Chromium session — the only reliable
   * path, because NetEase risk control rejects server-side QR polling. In a
   * plain browser, fall back to the QR modal (which also offers manual
   * MUSIC_U entry).
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
   * captures the real login cookie automatically. In a plain browser there's
   * no cookie-capture path, so we tell the user to use the desktop app.
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
   * Spotify login: OAuth PKCE. 流程：
   *  1. POST /auth/spotify/start → 拿 authorizeUrl + state（后端缓存 verifier）
   *  2. shell.openExternal 在系统浏览器打开 authorizeUrl
   *  3. 用户在浏览器里登录 Spotify；Spotify 跳回 redirect_uri
   *     （renderer 的 /auth/spotify/callback），后端在那里换 token 入 session
   *  4. 我们轮询 /auth/status?provider=spotify，直到 loggedIn=true 或超时
   *
   * 客户端不能直接收 callback——回调 hit 浏览器而非 Electron，所以靠轮询
   * 而不是 postMessage / IPC。90s 超时够 OAuth 走完；如果用户没设 client_id
   * 引导他们去设置面板粘进来（复用 RecoKeyModal 风格的小弹窗太重，先
   * 在错误里给明确指引）。
   */
  const handleSpotifyLogin = async () => {
    setError(null);
    setLoggingIn(true);
    try {
      const status = await getSpotifyStatus();
      if (!status.hasClientId) {
        // prompt() 在 Electron 上不被支持（manifest v3 封了）。fallback: 提示用户去 .env 设。
        let id: string | null = null;
        try {
          id = window.prompt(
            '需要先在 Spotify Developer 后台创建应用，拿到 client_id 后粘到这里：\n' +
              '（https://developer.spotify.com/dashboard → Create app）',
          );
        } catch {
          setError('未配置 Spotify client_id。请在 .env 中设置 SPOTIFY_CLIENT_ID=');
          return;
        }
        if (!id || !id.trim()) {
          setError('已取消：未填 Spotify client_id');
          return;
        }
        await setSpotifyClientId(id.trim());
      }
      const { authorizeUrl } = await startSpotify();
      // 用 window.open 而不是 Electron shell.openExternal——后者把授权页踢到系统
      // 浏览器（Safari）；回调的 session cookie 写在系统浏览器里，Electron 自己的
      // renderer 永远读不到，轮询 getSpotifyStatus 永远不会 loggedIn=true。
      // nativeWindowOpen:true 主窗口的效果：window.open 在 Electron 内创子窗口，
      // session cookie 共享，主窗口轮询能拿到 login 状态。
      window.open(authorizeUrl, '_blank', 'noopener');
      // 轮询 status；Spotify 跳回 callback 后后端会入 session，
      // 下一次轮询就会看到 loggedIn=true。
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        const s = await getSpotifyStatus();
        if (s.loggedIn) {
          const full = await getAuthStatus('spotify');
          setAuth({
            provider: 'spotify',
            loggedIn: true,
            user: full.user,
            tier: s.tier,
          });
          loadNextTrack();
          return;
        }
      }
      setError('Spotify 登录超时（90s），请重试');
    } catch (e) {
      setError(`Spotify 登录失败：${(e as Error).message}`);
    } finally {
      setLoggingIn(false);
    }
  };

  const handleCookieFallbackSuccess = (user: AuthUser) => {
    setShowCookieFallback(false);
    if (!provider) return;
    setAuth({ provider, loggedIn: true, user });
    loadNextTrack();
  };

  const resetAuth = () =>
    setAuth({ provider: 'qq', loggedIn: false, user: null });

  return {
    auth,
    loggingIn,
    showCookieFallback,
    setShowCookieFallback,
    handleNeteaseLogin,
    handleQqLogin,
    handleSpotifyLogin,
    handleLogout,
    handleCookieFallbackSuccess,
    resetAuth,
  };
}
