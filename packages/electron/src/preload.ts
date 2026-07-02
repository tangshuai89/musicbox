import { contextBridge, ipcRenderer } from 'electron';

/**
 * Renderer ↔ main bridge. Only methods that *must* run in the main process
 * (opening windows, accessing native session cookies) live here. Everything
 * else (API calls, audio state) stays in the renderer.
 */

export interface QqLoginResult {
  /** Full "k=v; k=v" QQ Music login cookie header. */
  cookie: string;
  /** Normalised numeric uin for musicu.fcg. */
  uin?: string;
  extraCookies?: Record<string, string>;
}

export interface QqLoginResponse {
  success: boolean;
  cookie?: string;
  uin?: string;
  extraCookies?: Record<string, string>;
  error?: string;
}

export interface NeteaseLoginResponse {
  success: boolean;
  musicU?: string;
  csrfToken?: string;
  extraCookies?: Record<string, string>;
  error?: string;
}

const electronAPI = {
  platform: process.platform,

  /** Open a QQ Music login window; resolves when the login cookie is captured. */
  qqLogin: (): Promise<QqLoginResponse> => ipcRenderer.invoke('qq:login'),

  /** Open a NetEase login window; resolves when MUSIC_U is captured. */
  neteaseLogin: (): Promise<NeteaseLoginResponse> =>
    ipcRenderer.invoke('netease:login'),

  /** Subscribe to QQ login-completed events. */
  onQqLoginSuccess: (cb: (r: QqLoginResult) => void): (() => void) => {
    const handler = (_e: unknown, payload: QqLoginResult): void => cb(payload);
    ipcRenderer.on('qq-login-result', handler);
    return () => ipcRenderer.removeListener('qq-login-result', handler);
  },

  /** Tell main we're in Electron so the renderer can branch its behaviour. */
  isElectron: true as const,
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

// Ambient type for renderer code
export type ElectronAPI = typeof electronAPI;