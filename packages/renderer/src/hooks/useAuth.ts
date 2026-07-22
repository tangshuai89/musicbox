import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import {
  getAuthStatus,
  getSpotifyStatus,
  logout,
  loginQqCookie,
  loginNeteaseCookie,
  setSpotifyClientId,
  startSpotify,
  redeemSpotifyCode,
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
      // Electron: maestro:// 协议 — 打开系统浏览器授权，OS 调回 app 后 main process
      // IPC 发 code+state 给 renderer，renderer 调 redeem 端点拿 cookie。
      if (isElectron && window.electronAPI?.openExternal) {
        const { authorizeUrl } = await startSpotify('maestro://spotify-callback');
        await window.electronAPI.openExternal(authorizeUrl);
        // 等 main process 的 spotify:oauth-protocol IPC
        const result = await new Promise<{ code: string; state: string }>(
          (resolve) => {
            const handler = (...args: unknown[]) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const data = args[0] as any as { code: string; state: string };
              window.electronAPI!.removeListener('spotify:oauth-protocol', handler);
              resolve(data);
            };
            window.electronAPI!.on('spotify:oauth-protocol', handler);
          },
        );
        const redeemed = await redeemSpotifyCode(result.code, result.state);
        if (redeemed.ok) {
          // 重新取 status——此时 session cookie 已写，tier 会是 redeem 后的正确值
          const s = await getSpotifyStatus();
          setAuth({
            provider: 'spotify',
            loggedIn: true,
            user: redeemed.profile,
            tier: s.tier,
          });
          loadNextTrack();
        } else {
          setError('Spotify 登录失败：redeem 失败');
        }
        return;
      }
      // 浏览器模式：window.open popup + polling cookie
      const { authorizeUrl } = await startSpotify();
      window.open(authorizeUrl, '_blank', 'noopener');
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
