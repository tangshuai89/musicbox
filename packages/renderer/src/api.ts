// The NestJS server exposes its routes WITHOUT any prefix: `/music/*`,
// `/auth/*`, `/reco/*`. In dev (Vite on :5173) those paths are proxied
// to the server on :3200 (see vite.config.ts). The HTML5 <audio>
// element loads `track.audioUrl` directly — a server-relative path like
// `/music/stream/deezer/123` — so we resolve every URL against the same
// API origin, which works in both dev and production (where Electron
// loads the renderer from `file://` and a bare relative path would
// otherwise resolve against the wrong origin).
//
// ⚠️ There is deliberately NO `/api` prefix. The old code prefixed the
// client with `/api` and relied on Vite's dev proxy to strip it — but
// the server never had that prefix and prod has no such rewrite, so
// packaged builds 404'd on every call. Client and server now agree on
// the prefix-less shape (matching the audio path, which never used one).
//
// `import.meta.env.DEV` is true only when Vite is running. In production
// builds we read the sidecar URL from window.electronAPI.apiBase (pushed
// by the preload bridge once main spawns the NestJS sidecar). If neither
// is set (running a prod build without Electron), we fall back to
// http://localhost:3200 and let the user deal with it.
function resolveApiOrigin(): string {
  // In Electron, prefer the sidecar URL that main process pushed via preload.
  if (typeof window !== 'undefined' && (window as { electronAPI?: { apiBase?: string } }).electronAPI?.apiBase) {
    return (window as { electronAPI: { apiBase: string } }).electronAPI.apiBase;
  }
  if (import.meta.env.DEV) return '';
  return 'http://localhost:3200';
}

/** Resolved server origin (''  in dev, sidecar URL / localhost:3200 in
 *  prod). Exported so the renderer can build media URLs (audio src,
 *  cover-proxy) against the exact same origin the API client uses. */
export const API_ORIGIN = resolveApiOrigin();
const API_BASE = API_ORIGIN;

export type MusicProvider = 'qq' | 'netease' | 'deezer' | 'spotify';

export const PROVIDER_LABELS: Record<MusicProvider, string> = {
  qq: 'QQ 音乐',
  netease: '网易云音乐',
  deezer: 'Deezer',
  spotify: 'Spotify',
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

/**
 * Heart fan-out：把一个 unified track 的 ❤ 一次性写到所有 hasCopyright 的平台。
 * sources 是 UnifiedSearchItem.sources 列表（去掉 hasCopyright=false 的）。
 *
 * 返回的 fannedOutTo：liked=true 时是当前 mergedId 心动过的**全部平台**
 * （含之前单独心过的），UI 角标直接用它的 length 表达"这首歌在几个平台有 ❤"；
 * liked=false 时是空数组。
 */
export async function fanOutLike(
  mergedId: string,
  sources: Array<{ platform: MusicProvider; trackId: string }>,
  liked: boolean,
): Promise<{ success: boolean; liked: boolean; fannedOutTo: MusicProvider[] }> {
  return json(
    await fetch(`${API_BASE}/music/like/merged`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mergedId, sources, liked }),
    }),
  );
}

/**
 * 切歌时的红心检测 + 自动同步：查这首统一 track 在各平台的红心情况，
 * 任一平台已红心 → 后端补齐其余平台并返回 liked=true + 完整平台列表。
 * 全没红心 → liked=false（不写任何东西）。
 */
export async function detectLiked(
  mergedId: string,
  sources: Array<{ platform: MusicProvider; trackId: string }>,
): Promise<{ liked: boolean; fannedOutTo: MusicProvider[] }> {
  return json(
    await fetch(`${API_BASE}/music/like/detect`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mergedId, sources }),
    }),
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

/**
 * 统一 track 的「踩」：取消这首歌在所有 fan-out 平台的红心（真正从各平台收藏
 * 移除）+ 标记不喜欢。用于统一搜索队列里的歌——单平台电台仍走 dislike()。
 */
export async function dislikeMerged(
  mergedId: string,
  sources: Array<{ platform: MusicProvider; trackId: string }>,
): Promise<{ success: boolean }> {
  return json(
    await fetch(`${API_BASE}/music/dislike/merged`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mergedId, sources }),
    }),
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
 * 启动 Spotify OAuth PKCE 流程：服务端生成 code_verifier / state 并缓存，
 * 返回授权 URL。renderer 拿到后用 shell.openExternal 在系统浏览器打开，
 * 用户登录后 Spotify 跳回 redirect_uri（默认是 renderer 的
 * /auth/spotify/callback），后端在那里用 verifier 换 token 存进 session。
 * 之后调 `getAuthStatus('spotify')` 就能看到 loggedIn=true。
 *
 * 注意：调用前必须已经通过 POST /auth/spotify/client-id 设过 client_id，
 * 否则会返回 400。useAuth 在调用前会先检查 hasClientId。
 */
export async function startSpotify(redirectUri?: string): Promise<{
  authorizeUrl: string;
  state: string;
}> {
  return json(
    await fetch(`${API_BASE}/auth/spotify/start`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(redirectUri ? { redirectUri } : {}),
    }),
  );
}

/** 检查 Spotify client_id 是否已设（不返回 id 本身）。 */
export async function getSpotifyStatus(): Promise<{
  hasClientId: boolean;
  loggedIn: boolean;
}> {
  return json(
    await fetch(`${API_BASE}/auth/spotify/status`, {
      credentials: 'include',
    }),
  );
}

/** 设置 Spotify OAuth client_id（用户在 Spotify Developer 后台创建应用拿到的）。 */
export async function setSpotifyClientId(
  clientId: string,
): Promise<{ ok: true; tail: string }> {
  return json(
    await fetch(`${API_BASE}/auth/spotify/client-id`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId }),
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

/** 统一搜索结果里每个平台的源信息（服务端 SourceInfo 的前端镜像）。 */
export interface UnifiedSourceInfo {
  platform: MusicProvider;
  trackId: string;
  hasCopyright: boolean;
  url: string;
  mediaMid?: string;
}

/** 统一搜索结果（去重合并后）单条。 */
export interface UnifiedSearchItem {
  id: string;
  title: string;
  artist: string;
  album: string;
  coverUrl: string;
  duration: number;
  sources: UnifiedSourceInfo[];
  bestSource: MusicProvider | null;
}

/** 统一搜索的整页响应。 */
export interface UnifiedSearchResult {
  q: string;
  total: number;
  page: number;
  pageSize: number;
  items: UnifiedSearchItem[];
}

/**
 * 跨平台统一搜索。服务端同时查 QQ / 网易云 / Deezer，合并去重后分页返回。
 * 单平台失败不阻塞其他平台——items 仍可能非空，errors 在 server log 里有。
 *
 * 取消支持：传入 AbortSignal 即可中断进行中的请求。debounce 重新触发时
 * 把上一次的 controller abort() 掉，避免旧响应覆盖新结果。
 */
export async function searchUnified(
  q: string,
  page = 1,
  pageSize = 20,
  signal?: AbortSignal,
): Promise<UnifiedSearchResult> {
  const params = new URLSearchParams({
    q,
    page: String(page),
    pageSize: String(pageSize),
  });
  return json<UnifiedSearchResult>(
    await fetch(`${API_BASE}/music/search?${params.toString()}`, {
      credentials: 'include',
      signal,
    }),
  );
}

/**
 * 把 UnifiedSearchItem 解析成可播放的 Track：按 bestSource（已有版权 + 优先级
 * 最高）取对应的 source，把 platform-specific 的 id / audioUrl / mediaMid
 * 拼回标准 Track 形状。bestSource 为 null 表示「所有平台都无版权」，返回
 * null 让 UI 走灰色不可播放态。
 */
export function pickPlayableTrack(
  item: UnifiedSearchItem,
): Track | null {
  if (!item.bestSource) return null;
  const src = item.sources.find((s) => s.platform === item.bestSource);
  if (!src) return null;
  return {
    id: src.trackId,
    provider: src.platform,
    title: item.title,
    artist: item.artist,
    album: item.album,
    coverUrl: item.coverUrl,
    audioUrl: src.url,
    duration: item.duration,
    liked: false,
    mediaMid: src.mediaMid,
  };
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

/** DeepSeek 推荐相关 API（v1：BYO key + 跑一次推荐）。 */
export interface RecoStatus {
  configured: boolean;
  librarySize: number;
}

export interface RecoRequest {
  count?: number;
  language?: 'zh' | 'en' | 'ja' | 'auto' | string;
  mood?: string;
}

export interface RecoRunResult {
  items: UnifiedSearchItem[];
  model: string;
  runAt: number;
  raw?: string; // 调试用，模型原始响应（截断）
}

export async function fetchRecoStatus(): Promise<RecoStatus> {
  return json(
    await fetch(`${API_BASE}/reco/status`, { credentials: 'include' }),
  );
}

export async function runReco(req: RecoRequest = {}): Promise<RecoRunResult> {
  return json(
    await fetch(`${API_BASE}/reco/run`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    }),
  );
}

export async function saveRecoKey(apiKey: string): Promise<{ ok: true; tail: string }> {
  return json(
    await fetch(`${API_BASE}/reco/key`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey }),
    }),
  );
}

/** 单个平台的"我的喜欢"导入状态。count=0 且有 error 表示该平台没拉到。 */
export interface LibrarySource {
  provider: MusicProvider;
  count: number;
  error?: string;
}

export interface LibraryImportResult {
  items: UnifiedSearchItem[];
  sources: LibrarySource[];
  importedAt: number;
}

/**
 * 触发"我的喜欢"导入：后端从各平台拉取已 ❤ 列表，合并去重后落地，返回
 * 合并结果 + 每个平台的导入状态。AI 推荐需要先有库，UI 在库为空时调它。
 */
export async function importLibrary(): Promise<LibraryImportResult> {
  return json<LibraryImportResult>(
    await fetch(`${API_BASE}/music/library/import`, {
      method: 'POST',
      credentials: 'include',
    }),
  );
}

/** 读最近一次导入的库；未导入过返回 null（后端 404）。 */
export async function getLibrary(): Promise<LibraryImportResult | null> {
  const res = await fetch(`${API_BASE}/music/library`, {
    credentials: 'include',
  });
  if (res.status === 404) return null;
  return json<LibraryImportResult>(res);
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