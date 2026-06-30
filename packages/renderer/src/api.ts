// In dev (Vite on :5173) we proxy /api/* and /music/* to the NestJS
// server on :3200 — see vite.config.ts. The HTML5 <audio> element,
// however, loads `track.audioUrl` directly, which is a server-relative
// path like `/music/stream/deezer/123`. We resolve it to an absolute
// URL using the configured API origin so it works in both dev and
// production (where Electron loads renderer from `file://` and the
// relative path would otherwise resolve against the wrong origin).
//
// `import.meta.env.DEV` is true only when Vite is running. In production
// builds, we fall back to http://localhost:3200 — the user is expected
// to have the NestJS server running on that port (Electron could be
// configured to start it as a child process in a follow-up).
const API_ORIGIN = import.meta.env.DEV ? '' : 'http://localhost:3200';
const API_BASE = API_ORIGIN + '/api';

export type MusicProvider = 'qq' | 'netease' | 'deezer';

export const PROVIDER_LABELS: Record<MusicProvider, string> = {
  qq: 'QQ 音乐',
  netease: '网易云音乐',
  deezer: 'Deezer',
};

export interface Track {
  id: string;
  provider: MusicProvider;
  title: string;
  artist: string;
  album: string;
  coverUrl: string;
  audioUrl: string; // /music/stream/{provider}/{id}，浏览器直接当 src 用
  duration: number;
  liked: boolean;
}

export interface AuthUser {
  nickname: string;
  avatarUrl: string;
  provider: MusicProvider;
}

export interface AuthStatus {
  provider: MusicProvider;
  loggedIn: boolean;
  user: AuthUser | null;
}

export interface NeteaseQrStart {
  qrImg: string;
  qrUrl: string;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchNextTrack(
  provider: MusicProvider,
  preset?: string,
): Promise<Track> {
  const qs = preset ? `&preset=${encodeURIComponent(preset)}` : '';
  return json<Track>(
    await fetch(`${API_BASE}/music/next?provider=${provider}${qs}`, {
      credentials: 'include',
    }),
  );
}

export async function toggleLike(
  provider: MusicProvider,
  trackId: string,
): Promise<{ success: boolean; liked: boolean }> {
  return json(
    await fetch(
      `${API_BASE}/music/like/${encodeURIComponent(trackId)}?provider=${provider}`,
      { method: 'POST', credentials: 'include' },
    ),
  );
}

export async function dislike(
  provider: MusicProvider,
  trackId: string,
): Promise<{ success: boolean }> {
  return json(
    await fetch(
      `${API_BASE}/music/dislike/${encodeURIComponent(trackId)}?provider=${provider}`,
      { method: 'POST', credentials: 'include' },
    ),
  );
}

export async function getLiked(provider: MusicProvider): Promise<Track[]> {
  return json<Track[]>(
    await fetch(`${API_BASE}/music/liked?provider=${provider}`, {
      credentials: 'include',
    }),
  );
}

export async function getAuthStatus(
  provider: MusicProvider,
): Promise<AuthStatus> {
  return json<AuthStatus>(
    await fetch(`${API_BASE}/auth/status?provider=${provider}`, {
      credentials: 'include',
    }),
  );
}

export function getLoginUrl(provider: MusicProvider): string {
  if (provider === 'qq') {
    return `${API_BASE}/auth/qq/login`;
  }
  return `${API_BASE}/auth/netease/qr/start`;
}

export interface DeezerEditorial {
  id: number;
  name: string;
  region?: string;
}

export async function fetchDeezerEditorials(): Promise<DeezerEditorial[]> {
  const res = await fetch(`${API_BASE}/music/deezer/editorials`, {
    credentials: 'include',
  });
  const json_ = (await res.json()) as { items: DeezerEditorial[] };
  return json_.items;
}

export async function logout(provider: MusicProvider): Promise<void> {
  await fetch(`${API_BASE}/auth/logout?provider=${provider}`, {
    credentials: 'include',
  });
}

/**
 * Ask the server to generate a NetEase QR image. Note that scanning this
 * will NOT auto-log us in (NetEase removed the server-side callback), so the
 * UI mostly uses this as a hint to open music.163.com on the phone.
 */
export async function startNeteaseQr(): Promise<NeteaseQrStart> {
  return json<NeteaseQrStart>(
    await fetch(`${API_BASE}/auth/netease/qr/start`, {
      method: 'POST',
      credentials: 'include',
    }),
  );
}

/**
 * Log in by submitting a MUSIC_U cookie (and optional __csrf) the user copied
 * from music.163.com DevTools. extraCookies (from Electron) carries the rest
 * of NetEase's cookies so the backend's weapi call looks identical to a real
 * browser request.
 */
export async function loginNeteaseCookie(
  musicU: string,
  csrfToken?: string,
  extraCookies?: Record<string, string>,
): Promise<{ success: boolean; user: AuthUser }> {
  return json(
    await fetch(`${API_BASE}/auth/netease/cookie`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ musicU, csrfToken, extraCookies }),
    }),
  );
}