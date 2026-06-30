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
  // QQ
  accessToken?: string;
  refreshToken?: string;
  openId?: string;
  unionId?: string;
  expiresAt?: number;
  // NetEase
  musicU?: string;
  csrfToken?: string;
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
    let id = (req as Request & { cookies?: Record<string, string> }).cookies?.[
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
      });
      this.persist();
    }
    return session;
  }

  /** Require an existing session, otherwise 401. */
  require(req: Request, res: Response): Session {
    const id = (req as Request & { cookies?: Record<string, string> }).cookies?.[
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
    const id = (req as Request & { cookies?: Record<string, string> }).cookies?.[
      COOKIE_NAME
    ];
    if (id) delete this.blob.byId[id];
    res.clearCookie(COOKIE_NAME);
    this.persist();
  }
}