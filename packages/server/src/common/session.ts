import {
  Injectable,
  OnModuleDestroy,
  UnauthorizedException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { StorageService } from './storage';
import { ConfigService } from './config';
import { MusicProvider } from './provider';

export interface ProviderSession {
  // QQ 音乐（真登录 cookie，来自内嵌登录窗口；不是 QQ 互联 OAuth token）
  qqCookie?: string; // 完整 "k=v; k=v" cookie header
  qqUin?: string; // 归一化后的纯数字 uin，用于 musicu.fcg
  /**
   * 解析后的 cookie map（qqmusic_key / qm_keyst / skey / p_skey / p_uin /
   * uin / …）。与 qqCookie 共存：qqCookie 是拼好的请求头，qqCookies 是按
   * 名访问的 map（g_tk 计算 / 后续端点按名取值都用这个）。
   * 老 session 里可能只有 qqCookie，没有 qqCookies —— 缺字段时直接兜底
   * '5381'（DJB2 of ""），favorites 仍能走（cookie 才是真鉴权）。
   */
  qqCookies?: Record<string, string>;
  /**
   * 是否 QQ 音乐绿钻会员（VIP）。登录时 best-effort 拉一次存下来。
   * 决定 pay_play=1 的歌是否标 vipLocked：绿钻能播全曲 → 不锁；非绿钻 → 锁。
   * `undefined` = 未知（老 session / 拉取失败）→ 按非会员处理（pay_play 生效），
   * 与本功能上线前的行为一致，重新登录后会填上。 */
  qqVip?: boolean;
  // NetEase
  musicU?: string;
  csrfToken?: string;
  // Spotify (OAuth PKCE)
  spotify?: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number; // ms epoch
    /** Cached Spotify product tier, captured during exchangeCode from /v1/me's
     * `product` field. Used by the renderer to decide whether to route
     * playback through the Web Playback SDK (premium) or fall back to the
     * 30s preview path (free). Optional so old persisted sessions still
     * load; the next /me call fills it in lazily. */
    tier?: 'premium' | 'free' | 'open';
    /** Cached profile info from the most recent /v1/me. Same lazy fill as tier. */
    spotifyUserId?: string;
    spotifyDisplayName?: string;
  };
  // Profile (shared)
  nickname?: string;
  avatarUrl?: string;
}

export interface Session {
  id: string;
  createdAt: number;
  providers: Partial<Record<MusicProvider, ProviderSession>>;
  /** Per-session UI prefs (e.g. the Deezer preset). Anonymous providers
   * don't have a ProviderSession, so this is where we stash their
   * state. */
  prefs?: Record<string, string>;
}

const COOKIE_NAME = 'mb_session';
const SESSION_KEY = 'sessions';

interface SessionBlob {
  byId: Record<string, Session>;
}

@Injectable()
export class SessionService implements OnModuleDestroy {
  private blob: SessionBlob = { byId: {} };

  constructor(
    private readonly storage: StorageService,
    private readonly cfg: ConfigService,
  ) {
    const persisted = this.storage.get<SessionBlob>(SESSION_KEY);
    if (persisted) {
      this.blob = persisted;
      this.evictExpired();
    }
  }

  onModuleDestroy(): void {
    this.storage.set(SESSION_KEY, this.blob);
    this.storage.flushSync();
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [id, s] of Object.entries(this.blob.byId)) {
      if (now - s.createdAt > this.cfg.sessionTtlMs) {
        delete this.blob.byId[id];
      }
    }
  }

  private persist(): void {
    this.storage.set(SESSION_KEY, this.blob);
  }

  /** Read or create a session based on the request cookie. */
  resolve(req: Request, res: Response): Session {
    let id = (req as Request & { signedCookies?: Record<string, string> }).signedCookies?.[
      COOKIE_NAME
    ];
    let session = id ? this.blob.byId[id] : undefined;
    if (!session) {
      id = randomBytes(24).toString('hex');
      session = { id, createdAt: Date.now(), providers: {} };
      this.blob.byId[id] = session;
      res.cookie(COOKIE_NAME, id, {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: this.cfg.sessionTtlMs,
        // secure: true in production (requires HTTPS)
        secure: false,
        // Signed with cfg.sessionSecret → lands in req.signedCookies and
        // can't be tampered client-side. Must match the read side, which
        // reads signedCookies (see above).
        signed: true,
      });
      this.persist();
    }
    return session;
  }

  /** Require an existing session, otherwise 401. */
  require(req: Request, res: Response): Session {
    const id = (req as Request & { signedCookies?: Record<string, string> }).signedCookies?.[
      COOKIE_NAME
    ];
    const session = id ? this.blob.byId[id] : undefined;
    if (!session) {
      throw new UnauthorizedException('No active session');
    }
    // Refresh the cookie sliding window.
    res.cookie(COOKIE_NAME, id, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: this.cfg.sessionTtlMs,
      secure: false,
      // Sign the cookie with cfg.sessionSecret so it lands in
      // req.signedCookies and can't be forged/tampered client-side.
      // (Previously the secret was passed to cookieParser but never used
      // because cookies were unsigned — dead config.)
      signed: true,
    });
    return session;
  }

  getProvider(
    session: Session,
    provider: MusicProvider,
  ): ProviderSession | undefined {
    return session.providers[provider];
  }

  setProvider(
    session: Session,
    provider: MusicProvider,
    data: ProviderSession,
  ): void {
    session.providers[provider] = { ...session.providers[provider], ...data };
    this.persist();
  }

  clearProvider(session: Session, provider: MusicProvider): void {
    delete session.providers[provider];
    this.persist();
  }

  destroy(req: Request, res: Response): void {
    const id = (req as Request & { signedCookies?: Record<string, string> }).signedCookies?.[
      COOKIE_NAME
    ];
    if (id) delete this.blob.byId[id];
    res.clearCookie(COOKIE_NAME);
    this.persist();
  }
}