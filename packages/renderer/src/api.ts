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
  mediaMid?: string; // QQ 取流用的 media_mid（高音质需要）
}

/** QQ 音质档位。standard=m4a，high=320mp3，lossless=flac（需会员）。 */
export type QqQuality = 'standard' | 'high' | 'lossless';
export const QQ_QUALITY_LABELS: Record<QqQuality, string> = {
  standard: '标准',
  high: '极高 320',
  lossless: '无损',
};

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
  key: string;
  qrImg: string;
  qrUrl: string;
}

export interface NeteaseQrCheck {
  /** 800 过期 / 801 等待扫码 / 802 已扫码待确认 / 803 登录成功 */
  code: number;
  message: string;
  user?: AuthUser;
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

/**
 * QQ 音乐 cookie 登录。cookie 由 Electron 内嵌登录窗口捕获后透传;浏览器
 * 调试时也可手动传入。
 */
export async function loginQqCookie(
  cookie: string,
  uin?: string,
  extraCookies?: Record<string, string>,
): Promise<{ success: boolean; user: AuthUser }> {
  return json(
    await fetch(`${API_BASE}/auth/qq/cookie`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie, uin, extraCookies }),
    }),
  );
}

/** 按关键词搜索(歌手 / 歌名)。当前仅 QQ 支持。 */
export async function searchTracks(
  provider: MusicProvider,
  q: string,
): Promise<Track[]> {
  const res = await json<{ items: Track[] }>(
    await fetch(
      `${API_BASE}/music/search?provider=${provider}&q=${encodeURIComponent(q)}`,
      { credentials: 'include' },
    ),
  );
  return res.items;
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

/** 真·扫码登录第一步：拿二维码（key + dataURL 图片）。 */
export async function startNeteaseQr(): Promise<NeteaseQrStart> {
  return json<NeteaseQrStart>(
    await fetch(`${API_BASE}/auth/netease/qr/start`, {
      method: 'POST',
      credentials: 'include',
    }),
  );
}

/** 真·扫码登录第二步：轮询扫码状态，803 时服务端已入 session。 */
export async function checkNeteaseQr(key: string): Promise<NeteaseQrCheck> {
  return json<NeteaseQrCheck>(
    await fetch(
      `${API_BASE}/auth/netease/qr/check?key=${encodeURIComponent(key)}`,
      { credentials: 'include' },
    ),
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

export interface LyricLine {
  time: number;
  text: string;
}

export async function fetchLyrics(
  provider: MusicProvider,
  trackId: string,
): Promise<LyricLine[] | null> {
  const res = await fetch(
    `${API_BASE}/music/lyrics?provider=${provider}&trackId=${encodeURIComponent(trackId)}`,
    { credentials: 'include' },
  );
  if (!res.ok) return null;
  const data = (await res.json()) as { lyrics: LyricLine[] | null };
  return data.lyrics ?? null;
}