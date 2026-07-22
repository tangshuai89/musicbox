import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { Track } from './music.service';
import { ProviderSession } from '../common/session';
import { StorageService } from '../common/storage';

/** storage key where AuthController persists the user's Spotify client_id.
 *  Must stay in sync with auth.controller.ts SPOTIFY_CLIENT_ID_KEY. */
const SPOTIFY_CLIENT_ID_KEY = 'secrets:spotify-client-id';

/**
 * Spotify Web API adapter。
 *
 * 设计取舍：
 *  - 不支持完整曲库播放（Spotify 不允许非 Premium 完整曲流），
 *    只走 preview_url（30s mp3，同 Deezer 限制）。UI 需要把这个限制
 *    明确告诉用户——避免他以为可以一直听下去。
 *  - 鉴权用 OAuth PKCE：用户从浏览器/桌面端拿到 client_id（无需 secret），
 *    我们生成 verifier + challenge，跳到 accounts.spotify.com 授权，回调
 *    拿 token。refresh_token 长期有效，access_token 1 小时，自己续。
 *
 * 接口约定（沿用 provider 家族）：
 *  - isConfigured: 简单判断 token 存在
 *  - search: Web API /v1/search?q=&type=track&limit=30
 *  - getStreamPath: 返回 preview_url（直接当 audio src 用）
 *  - like / unlike: PUT/DELETE /v1/me/tracks
 *  - fetchRadioBatch: Spotify 没"私人 FM"概念，给一个 30 首热门轨的退路
 *  - fetchLiked: GET /v1/me/tracks，importLiked 走它
 */

const SPOTIFY_API = 'https://api.spotify.com/v1';
const SPOTIFY_ACCOUNTS = 'https://accounts.spotify.com';
const SPOTIFY_SCOPES = [
  'user-library-read',     // 读 liked
  'user-library-modify',   // 写 liked
  'user-read-email',       // 读 /v1/me → 拿 product（premium/free）做 WPS 路由
  'streaming',             // Web Playback SDK 必需（Premium 校验）
  'user-modify-playback-state', // WPS 的 transfer/resume/seek
].join(' ');

/** Spotify product tier from /v1/me's `product` field. Drives the renderer's
 * decision to route playback through the WPS (premium) or the 30s preview
 * proxy (free / open). */
export type SpotifyProductTier = 'premium' | 'free' | 'open';

interface SpotifyAccessToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // ms epoch
  /** Cached tier from /v1/me. Filled by exchangeCode + getMeInfo. */
  tier?: SpotifyProductTier;
  spotifyUserId?: string;
  spotifyDisplayName?: string;
}

interface SpotifyTrack {
  id: string;
  name: string;
  artists?: Array<{ id: string; name: string }>;
  album?: {
    id: string;
    name: string;
    images?: Array<{ url: string; width: number; height: number }>;
  };
  duration_ms?: number;
  preview_url?: string | null;
  external_urls?: { spotify?: string };
}

interface SpotifySearchResponse {
  tracks?: {
    items?: SpotifyTrack[];
    total?: number;
  };
}

interface SpotifySavedTracksResponse {
  items?: Array<{ added_at: string; track: SpotifyTrack }>;
  total?: number;
  next?: string | null;
}

@Injectable()
export class SpotifyMusicProvider {
  private readonly logger = new Logger(SpotifyMusicProvider.name);

  // PKCE 临时态：state → { codeVerifier, codeChallenge, createdAt, clientId }
  // 不持久化（重启清空，反正用户在浏览器侧手点确认也得重走）。
  // 实际 v1 用 Map<state, {codeVerifier, createdAt}>，clientId 不存（callback 时再读）
  private readonly pendingFlows = new Map<
    string,
    { codeVerifier: string; createdAt: number }
  >();

  /** PKCE flow TTL：10 分钟。超过这个时间视为过期，exchangeCode 拒绝。
   *  同时用于 lazy GC——startAuth 时清掉所有 >TTL 的 orphan。 */
  private static readonly PKCE_TTL_MS = 10 * 60_000;

  constructor(private readonly storage: StorageService) {}

  // ── 配置 / 鉴权基础 ─────────────────────────────────────

  /**
   * 解析 client_id：优先 process.env（当次会话 setSpotifyClientId 会写），
   * 回退到持久化的 storage。⚠️ 之前只读 process.env，服务重启后 env 丢失
   * → refresh/exchange 报 "SPOTIFY_CLIENT_ID 未设"，Spotify 静默掉线，直到
   * 用户再手动设一次 client_id。读 storage 兜底后，重启即恢复。
   */
  private resolveClientId(): string | null {
    const fromEnv = process.env.SPOTIFY_CLIENT_ID;
    if (fromEnv) return fromEnv;
    const stored = this.storage.get<{ clientId?: string }>(
      SPOTIFY_CLIENT_ID_KEY,
    );
    return stored?.clientId ?? null;
  }

  isConfigured(session: ProviderSession | undefined): boolean {
    return Boolean(this.readToken(session));
  }

  /** 读 token，必要时自动 refresh。返回 accessToken（或 null）。 */
  async getValidAccessToken(
    session: ProviderSession,
  ): Promise<string | null> {
    const tok = this.readToken(session);
    if (!tok) return null;
    if (tok.expiresAt > Date.now() + 30_000) return tok.accessToken;
    // 过期了 → refresh
    return this.refreshAccessToken(session, tok.refreshToken);
  }

  /** 把 OAuth 回调拿到的 token 写到 session。 */
  saveToken(
    session: ProviderSession,
    token: SpotifyAccessToken,
  ): ProviderSession {
    return {
      ...session,
      spotify: token,
    };
  }

  private readToken(session: ProviderSession | undefined):
    | SpotifyAccessToken
    | null {
    return session?.spotify ?? null;
  }

  private async refreshAccessToken(
    session: ProviderSession,
    refreshToken: string,
  ): Promise<string | null> {
    const clientId = this.resolveClientId();
    if (!clientId) {
      this.logger.warn('refreshAccessToken: SPOTIFY_CLIENT_ID 未设');
      return null;
    }
    try {
      const res = await fetch(`${SPOTIFY_ACCOUNTS}/api/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientId,
        }),
      });
      if (!res.ok) {
        this.logger.warn(`spotify refresh failed: ${res.status}`);
        return null;
      }
      const data = (await res.json()) as {
        access_token: string;
        expires_in: number;
        refresh_token?: string; // 不一定回，不回就复用旧的
      };
      const newTok: SpotifyAccessToken = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? refreshToken,
        expiresAt: Date.now() + data.expires_in * 1000,
      };
      session.spotify = newTok;
      return newTok.accessToken;
    } catch (err) {
      this.logger.warn(`spotify refresh exception: ${(err as Error).message}`);
      return null;
    }
  }

  // ── OAuth PKCE 流程 ─────────────────────────────────────

  /**
   * 生成 PKCE 流程的 code_verifier + code_challenge + state。
   * 实际不直接调 accounts.spotify.com，由调用方（controller）拿 authorizeUrl
   * 去 redirect 用户浏览器。
   */
  startAuth(clientId: string, redirectUri: string): {
    authorizeUrl: string;
    state: string;
  } {
    // Lazy GC：每次 start 都清掉过期的 orphan，避免用户多次开启又不回调
    // 时 Map 无限增长。检查 200ms 内开销可忽略。
    this.evictExpiredFlows();
    const codeVerifier = base64UrlEncode(randomBytes(32));
    const codeChallenge = base64UrlEncode(
      sha256(Buffer.from(codeVerifier)),
    );
    const state = base64UrlEncode(randomBytes(16));
    this.pendingFlows.set(state, {
      codeVerifier,
      createdAt: Date.now(),
    });
    const url = new URL(`${SPOTIFY_ACCOUNTS}/authorize`);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('scope', SPOTIFY_SCOPES);
    url.searchParams.set('state', state);
    return { authorizeUrl: url.toString(), state };
  }

  /** 删掉 >TTL 的 flow entries。startAuth 入口 lazy 调用。 */
  private evictExpiredFlows(): void {
    const cutoff = Date.now() - SpotifyMusicProvider.PKCE_TTL_MS;
    for (const [state, flow] of this.pendingFlows) {
      if (flow.createdAt < cutoff) {
        this.pendingFlows.delete(state);
      }
    }
  }

  /**
   * 用户授权后回调。用 code + verifier 换 token。state 必须匹配之前存的 verifier。
   * 返回 { token, profile }。失败抛 BadRequestException。
   * 顺带从 /v1/me 缓存 product tier（premium/free）—— render 端据此决定走 WPS 还是 30s 预览。
   */
  async exchangeCode(
    session: ProviderSession,
    code: string,
    state: string,
    redirectUri: string,
  ): Promise<{ token: SpotifyAccessToken; profile: { id: string; displayName: string } }> {
    const flow = this.pendingFlows.get(state);
    if (!flow) {
      throw new BadRequestException('invalid_state：state 不存在或已过期');
    }
    this.pendingFlows.delete(state);
    // PKCE flow TTL: 10 分钟
    if (Date.now() - flow.createdAt > SpotifyMusicProvider.PKCE_TTL_MS) {
      throw new BadRequestException('expired_state：请重新登录');
    }
    const clientId = this.resolveClientId();
    if (!clientId) {
      throw new BadRequestException('SPOTIFY_CLIENT_ID 未设');
    }
    const tokenRes = await fetch(`${SPOTIFY_ACCOUNTS}/api/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: flow.codeVerifier,
      }),
    });
    if (!tokenRes.ok) {
      const text = await tokenRes.text().catch(() => '');
      throw new BadRequestException(`spotify token exchange failed: ${tokenRes.status} ${text.slice(0, 200)}`);
    }
    const data = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    // /v1/me 拿 tier + profile。失败不阻塞登录（退化成 free + 占位 profile），
    // 后续 getMeInfo 懒查询可以补上。
    const token: SpotifyAccessToken = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    const meInfo = await this.fetchMeInfo(data.access_token);
    if (meInfo) {
      token.tier = meInfo.tier;
      token.spotifyUserId = meInfo.id;
      token.spotifyDisplayName = meInfo.displayName;
    } else {
      // OAuth 成功但 /v1/me 失败：保守当 free（UI 走 30s 预览路径）
      this.logger.warn('exchangeCode: /v1/me failed; defaulting tier to free');
      token.tier = 'free';
    }
    session.spotify = token;
    return {
      token,
      profile: {
        id: token.spotifyUserId ?? 'unknown',
        displayName: token.spotifyDisplayName ?? 'Spotify User',
      },
    };
  }

  /** GET /v1/me → { id, displayName, tier } | null。轻量 helper，refresh / lazy fill 复用。 */
  private async fetchMeInfo(
    accessToken: string,
  ): Promise<{ id: string; displayName: string; tier: SpotifyProductTier } | null> {
    try {
      const res = await fetch(`${SPOTIFY_API}/me`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) return null;
      const p = (await res.json()) as {
        id?: string;
        display_name?: string;
        product?: string;
      };
      const rawTier = (p.product ?? 'free').toLowerCase();
      console.log('[spotify /v1/me] id=' + p.id + ' product=' + p.product + ' rawTier=' + rawTier);
      const tier: SpotifyProductTier =
        rawTier === 'premium' ? 'premium' : rawTier === 'open' ? 'open' : 'free';
      return {
        id: p.id ?? 'unknown',
        displayName: p.display_name ?? 'Spotify User',
        tier,
      };
    } catch (err) {
      this.logger.warn(`fetchMeInfo exception: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * 渲染端用的 token 端点：返回当前有效 access_token + expiresAt + tier。
   * 必要时先 refresh。renderer 把 accessToken 喂给 WPS SDK；WPS 自己管 WebSocket 续连。
   * expiresAt 给 renderer 用来提前 60s 重新拉一次（防 WPS 静默掉线）。
   */
  async getValidTokenForRenderer(
    session: ProviderSession,
  ): Promise<{ accessToken: string; expiresAt: number; tier: SpotifyProductTier | null } | null> {
    const tok = this.readToken(session);
    if (!tok) return null;
    let accessToken: string | null = tok.accessToken;
    if (tok.expiresAt <= Date.now() + 30_000) {
      accessToken = await this.refreshAccessToken(session, tok.refreshToken);
      if (!accessToken) return null;
    }
    return {
      accessToken,
      expiresAt: tok.expiresAt,
      tier: tok.tier ?? null,
    };
  }

  /** 渲染端用的 /me 端点。tier 缺省时懒查一次（老 session 从老 OAuth 留回来的）。 */
  async getMeInfo(
    session: ProviderSession,
  ): Promise<{ id: string; displayName: string; tier: SpotifyProductTier } | null> {
    const tok = this.readToken(session);
    if (!tok) return null;
    if (tok.tier && tok.spotifyUserId) {
      return {
        id: tok.spotifyUserId,
        displayName: tok.spotifyDisplayName ?? 'Spotify User',
        tier: tok.tier,
      };
    }
    const accessToken = await this.getValidAccessToken(session);
    if (!accessToken) return null;
    const info = await this.fetchMeInfo(accessToken);
    if (info) {
      tok.tier = info.tier;
      tok.spotifyUserId = info.id;
      tok.spotifyDisplayName = info.displayName;
    }
    return info;
  }

  // ── 业务接口（MusicProvider 家族） ─────────────────────

  async search(
    session: ProviderSession,
    keyword: string,
    limit = 30,
  ): Promise<Track[]> {
    const token = await this.getValidAccessToken(session);
    if (!token) {
      throw new BadRequestException('spotify_not_logged_in');
    }
    const url = new URL(`${SPOTIFY_API}/search`);
    url.searchParams.set('q', keyword);
    url.searchParams.set('type', 'track');
    url.searchParams.set('limit', String(Math.min(limit, 50)));
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      // token 失效，再试一次（refresh 已尝试过，所以是 refresh 也失败）
      throw new BadRequestException('spotify_auth_failed');
    }
    if (!res.ok) {
      this.logger.warn(`spotify search ${res.status}`);
      return [];
    }
    const data = (await res.json()) as SpotifySearchResponse;
    return (data.tracks?.items ?? []).map((t) => this.toTrack(t));
  }

  /**
   * 拉流的代理路径。Spotify 真正给的是 preview_url（30s mp3）。
   * 这里把 url 直接返回，让 music.service 走 audio proxy 字节代理
   * （这样 Web Audio analyser 才能 CORS-clean 取样）。
   */
  async getStreamPath(
    session: ProviderSession,
    trackId: string,
  ): Promise<string> {
    const token = await this.getValidAccessToken(session);
    if (!token) throw new BadRequestException('spotify_not_logged_in');
    const res = await fetch(`${SPOTIFY_API}/tracks/${encodeURIComponent(trackId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new BadRequestException(`spotify track fetch ${res.status}`);
    }
    const data = (await res.json()) as SpotifyTrack;
    if (!data.preview_url) {
      throw new BadRequestException(
        'spotify_no_preview：当前区域或曲目无 30s 预览',
      );
    }
    return data.preview_url;
  }

  async like(
    session: ProviderSession,
    trackId: string,
  ): Promise<{ success: boolean }> {
    const token = await this.getValidAccessToken(session);
    if (!token) throw new BadRequestException('spotify_not_logged_in');
    const res = await fetch(`${SPOTIFY_API}/me/tracks`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ids: [trackId] }),
    });
    if (!res.ok) {
      this.logger.warn(`spotify like ${res.status}`);
      return { success: false };
    }
    return { success: true };
  }

  async unlike(
    session: ProviderSession,
    trackId: string,
  ): Promise<{ success: boolean }> {
    const token = await this.getValidAccessToken(session);
    if (!token) throw new BadRequestException('spotify_not_logged_in');
    const res = await fetch(`${SPOTIFY_API}/me/tracks`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ids: [trackId] }),
    });
    if (!res.ok) {
      this.logger.warn(`spotify unlike ${res.status}`);
      return { success: false };
    }
    return { success: true };
  }

  /**
   * 拉流的"电台"替身。Spotify 没私人 FM 概念，这里给一个
   * 30 首"全球流行"热门轨的退路（走 Featured Playlists API）。
   * 用户切到 Spotify 源后立即有 30 首可以连续播。
   */
  async fetchRadioBatch(
    session: ProviderSession,
    count = 30,
  ): Promise<Track[]> {
    const token = await this.getValidAccessToken(session);
    if (!token) return [];
    // 简单：直接搜"top hits global"取前 N 首
    const res = await this.search(session, 'top hits global', count);
    return res;
  }

  async fetchLiked(
    session: ProviderSession,
    maxTracks = 1000,
  ): Promise<Track[]> {
    const token = await this.getValidAccessToken(session);
    if (!token) return [];
    const out: Track[] = [];
    let url: string | null =
      `${SPOTIFY_API}/me/tracks?limit=${Math.min(50, maxTracks)}`;
    while (url && out.length < maxTracks) {
      const res: Response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        this.logger.warn(`spotify fetchLiked ${res.status}`);
        break;
      }
      const data = (await res.json()) as SpotifySavedTracksResponse;
      for (const item of data.items ?? []) {
        if (out.length >= maxTracks) break;
        out.push({ ...this.toTrack(item.track), liked: true });
      }
      url = data.next ?? null;
    }
    return out;
  }

  /** 字段映射：Web API → Track。 */
  private toTrack(t: SpotifyTrack): Track {
    return {
      id: t.id,
      provider: 'spotify' as const,
      title: t.name,
      artist: (t.artists ?? []).map((a) => a.name).join(' / ') || '未知艺人',
      album: t.album?.name ?? '',
      coverUrl: t.album?.images?.[0]?.url ?? '',
      audioUrl: t.preview_url ?? '', // search 阶段没拿到时为空，播放时再 fetch
      duration: Math.round((t.duration_ms ?? 0) / 1000),
      liked: false,
    };
  }
}

// ── PKCE crypto helpers（用 Node built-in crypto） ───────────

import { randomBytes, createHash } from 'node:crypto';

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function sha256(input: Buffer): Buffer {
  return createHash('sha256').update(input).digest();
}
