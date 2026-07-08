import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import {
  getAuthStatus,
  logout,
  loginQqCookie,
  loginNeteaseCookie,
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
      .then(setAuth)
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
    handleLogout,
    handleCookieFallbackSuccess,
    resetAuth,
  };
}
