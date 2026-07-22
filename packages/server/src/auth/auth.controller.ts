import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Req,
  Res,
  Logger,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { normalizeProvider } from '../common/provider';
import { Request, Response } from 'express';
import { QqAuthStrategy } from './qq.strategy';
import { NeteaseAuthStrategy } from './netease-auth.strategy';
import { SessionService } from '../common/session';
import { SpotifyMusicProvider } from '../music/spotify.provider';
import { StorageService } from '../common/storage';

const SPOTIFY_CLIENT_ID_KEY = 'secrets:spotify-client-id';

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly qq: QqAuthStrategy,
    private readonly netease: NeteaseAuthStrategy,
    private readonly sessionService: SessionService,
    private readonly spotify: SpotifyMusicProvider,
    private readonly storage: StorageService,
  ) {}

  // ── QQ 音乐（cookie 登录，非 QQ 互联 OAuth）────────────────────────────────

  /**
   * 接受内嵌登录窗口（Electron main）捕获的 QQ 音乐 cookie，存入 session。
   * 浏览器调试时也可手动粘贴 cookie。
   */
  @Post('qq/cookie')
  async qqCookieLogin(
    @Body()
    body: {
      cookie?: string;
      uin?: string;
      extraCookies?: Record<string, string>;
    },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!body?.cookie) {
      throw new BadRequestException('Missing QQ cookie');
    }
    const session = this.sessionService.resolve(req, res);
    const profile = await this.qq.loginWithCookie(
      body.cookie,
      body.uin,
      body.extraCookies,
    );
    this.sessionService.setProvider(session, 'qq', profile);
    return {
      success: true,
      user: {
        nickname: profile.nickname,
        avatarUrl: profile.avatarUrl,
        provider: 'qq' as const,
      },
    };
  }

  // ── NetEase ───────────────────────────────────────────────────────────────

  /**
   * 真·扫码登录第一步：生成二维码（unikey + dataURL 图片）。
   * 前端展示后轮询 /auth/netease/qr/check。
   */
  @Post('netease/qr/start')
  async neteaseQrStart() {
    return this.netease.qrStart();
  }

  /**
   * 真·扫码登录第二步：轮询扫码状态。
   * 800 过期 / 801 等待 / 802 已扫码待确认 / 803 成功（此时入 session）。
   */
  @Get('netease/qr/check')
  async neteaseQrCheck(
    @Query('key') key: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!key) {
      throw new BadRequestException('Missing key');
    }
    const result = await this.netease.qrCheck(key);
    if (result.code === 803 && result.session) {
      const session = this.sessionService.resolve(req, res);
      this.sessionService.setProvider(session, 'netease', result.session);
      this.logger.log(
        `netease login OK → session=${session.id.slice(0, 8)}… nickname=${result.session.nickname}`,
      );
      return {
        code: 803,
        message: result.message,
        user: {
          nickname: result.session.nickname,
          avatarUrl: result.session.avatarUrl,
          provider: 'netease' as const,
        },
      };
    }
    return { code: result.code, message: result.message };
  }

  /**
   * 用户在浏览器登录 music.163.com 后，从 DevTools 拿到 MUSIC_U cookie
   * 粘贴到这里。服务端用这个 cookie 调用 weapi 校验 + 拉 profile 后入
   * session。
   */
  @Post('netease/cookie')
  async neteaseCookieLogin(
    @Body()
    body: {
      musicU?: string;
      csrfToken?: string;
      extraCookies?: Record<string, string>;
    },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!body?.musicU) {
      throw new BadRequestException('Missing MUSIC_U');
    }
    const session = this.sessionService.resolve(req, res);
    const profile = await this.netease.loginWithCookie(
      body.musicU,
      body.csrfToken,
    );
    this.sessionService.setProvider(session, 'netease', profile);
    return {
      success: true,
      user: {
        nickname: profile.nickname,
        avatarUrl: profile.avatarUrl,
        provider: 'netease' as const,
      },
    };
  }

  // ── Status / Logout ──────────────────────────────────────────────────────

  @Get('status')
  status(
    @Query('provider') provider: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const p = normalizeProvider(provider);
    // Deezer is anonymous — always "logged in" with a synthetic user.
    if (p === 'deezer') {
      return {
        provider: 'deezer',
        loggedIn: true,
        user: {
          nickname: '公开电台',
          avatarUrl: '',
          provider: 'deezer',
        },
      };
    }
    const session = this.sessionService.resolve(req, res);
    const ps = session.providers[p];
    // 各平台的"已登录"凭据不同：QQ→qqCookie，网易云→musicU，Spotify→spotify
    // token。之前漏了 spotify，导致 /auth/status?provider=spotify 永远返回
    // loggedIn:false（即便已 OAuth 登录）。按 provider 精确判断。
    const loggedIn =
      p === 'qq'
        ? Boolean(ps?.qqCookie)
        : p === 'netease'
          ? Boolean(ps?.musicU)
          : p === 'spotify'
            ? Boolean(ps?.spotify?.accessToken)
            : false;
    return {
      provider: p,
      loggedIn,
      user: ps
        ? {
            nickname: ps.nickname ?? '',
            avatarUrl: ps.avatarUrl ?? '',
            provider: p,
          }
        : null,
    };
  }

  @Get('logout')
  logout(
    @Query('provider') provider: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const p = normalizeProvider(provider);
    if (p === 'deezer') {
      // Deezer is anonymous — nothing to clear server-side. The renderer
      // should switch providers or call reset instead.
      return { success: true, noop: true };
    }
    const session = this.sessionService.resolve(req, res);
    this.sessionService.clearProvider(session, p);
    return { success: true };
  }

  // ── Spotify（OAuth PKCE） ─────────────────────────────────

  /**
   * 当前是否已设 client_id 且登录态有效。给前端 UI 决定按钮态。
   * 额外带 tier（'premium' / 'free' / 'open' / null）—— WPS 路由用。
   */
  @Get('spotify/status')
  async spotifyStatus(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = this.sessionService.resolve(req, res);
    const stored = this.storage.get<{ clientId?: string }>(SPOTIFY_CLIENT_ID_KEY);
    const clientId = stored?.clientId ?? process.env.SPOTIFY_CLIENT_ID;
    const loggedIn = this.spotify.isConfigured(session.providers.spotify);
    // tier 只在已登录时有意义；未登录直接 null（前端据此隐藏 WPS 相关 UI）。
    let tier: string | null = null;
    if (loggedIn) {
      const me = await this.spotify.getMeInfo(session.providers.spotify!);
      tier = me?.tier ?? null;
    }
    return {
      hasClientId: Boolean(clientId),
      loggedIn,
      tier,
    };
  }

  /**
   * 渲染端初始化 Web Playback SDK 时拿 token。会自动 refresh 过期 token。
   * 返回 { accessToken, expiresAt, tier } —— renderer 用 expiresAt 提前 60s
   * 重新拉一次以避免 WPS WebSocket 静默断连。
   */
  @Get('spotify/token')
  async spotifyToken(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = this.sessionService.resolve(req, res);
    const ps = session.providers.spotify;
    if (!ps) {
      throw new UnauthorizedException('spotify_not_logged_in');
    }
    const tok = await this.spotify.getValidTokenForRenderer(ps);
    if (!tok) {
      throw new UnauthorizedException('spotify_token_unavailable');
    }
    return tok;
  }

  /**
   * 渲染端用的 /me 信息（id / displayName / tier）。tier 缺省时懒查一次。
   */
  @Get('spotify/me')
  async spotifyMe(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = this.sessionService.resolve(req, res);
    const ps = session.providers.spotify;
    if (!ps) {
      throw new UnauthorizedException('spotify_not_logged_in');
    }
    const me = await this.spotify.getMeInfo(ps);
    if (!me) {
      throw new UnauthorizedException('spotify_me_unavailable');
    }
    return me;
  }

  /**
   * 设 client_id（写到 .storage secrets.json）。不在 .env 里——是用户自带
   * 的，不应该和开发环境绑定。⚠️ 仅本地。
   */
  @Post('spotify/client-id')
  setSpotifyClientId(@Body() body: { clientId?: string }) {
    const id = body?.clientId?.trim();
    if (!id || id.length < 8) {
      throw new BadRequestException('clientId 太短');
    }
    this.storage.set(SPOTIFY_CLIENT_ID_KEY, { clientId: id });
    process.env.SPOTIFY_CLIENT_ID = id;
    return { ok: true, tail: id.slice(-6) };
  }

  /**
   * 启动 OAuth PKCE 流程：返回 authorizeUrl，renderer 跳到浏览器。
   * redirect_uri 是用户在 Spotify Developer 后台注册的回调地址
   * （生产用 https://your.app/auth/spotify/callback；dev 用
   * http://localhost:3200/auth/spotify/callback）。
   */
  @Post('spotify/start')
  startSpotify(@Body() body: { redirectUri?: string }) {
    const stored = this.storage.get<{ clientId?: string }>(SPOTIFY_CLIENT_ID_KEY);
    const clientId = stored?.clientId ?? process.env.SPOTIFY_CLIENT_ID;
    if (!clientId) {
      throw new BadRequestException('spotify_client_id_not_set：先去 /auth/spotify/client-id 设置');
    }
    const redirectUri =
      body?.redirectUri ??
      `${process.env.RENDERER_BASE ?? 'http://localhost:5173'}/auth/spotify/callback`;
    return this.spotify.startAuth(clientId, redirectUri);
  }

  /**
   * 回调：Spotify 重定向到这里，带 code + state。我们用之前缓存的
   * code_verifier 换 token，存到 session。
   */
  @Get('spotify/callback')
  async spotifyCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!code || !state) {
      throw new BadRequestException('code + state 必填');
    }
    const session = this.sessionService.resolve(req, res);
    const redirectUri =
      `${process.env.RENDERER_BASE ?? 'http://localhost:5173'}/auth/spotify/callback`;
    const result = await this.spotify.exchangeCode(
      session.providers.spotify ?? {},
      code,
      state,
      redirectUri,
    );
    this.sessionService.setProvider(session, 'spotify', {
      ...session.providers.spotify,
      spotify: result.token,
      nickname: result.profile.displayName,
    });
    // 返一个自关闭 HTML 页——回调是在 Electron 的 window.open 子窗口里打开的，
    // session cookie 已在这条 response header 里写回。子窗口关掉即可，主窗口
    // 的 polling 下次就能读到 loggedIn=true。
    res.type('html').send(`<!doctype html><html><body>
      <script>window.close()</script>
      <p style='font-family:system-ui;text-align:center;padding-top:40px;color:#1db954'>
        Spotify 登录成功 ✓<br><small>即将关闭此窗口…</small>
      </p>
    </body></html>`);
  }

  /**
   * 协议回调兑换：Electron 自定义协议 maestro:// 把 code + state 发回 main
   * process → main process IPC 给 renderer → renderer 调此端点换 token。
   * 与 GET callback 不同：这里的 session cookie 会直接写进 renderer 的
   * cookie jar（renderer 发的请求带自己的 cookie 域）。不需要 popup 或 cookie 共享。
   */
  @Get('spotify/redeem')
  async spotifyRedeem(
    @Query('code') code: string,
    @Query('state') state: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!code || !state) {
      throw new BadRequestException('code + state 必填');
    }
    const session = this.sessionService.resolve(req, res);
    const redirectUri = 'maestro://spotify-callback/';
    console.log('[spotify redeem] sessionId=' + session.id + ' exchanging code...');
    const result = await this.spotify.exchangeCode(
      session.providers.spotify ?? {},
      code,
      state,
      redirectUri,
    );
    console.log('[spotify redeem] exchange ok, tier=' + result.token.tier + ', profile=' + result.profile.id);
    this.sessionService.setProvider(session, 'spotify', {
      ...session.providers.spotify,
      spotify: result.token,
      nickname: result.profile.displayName,
    });
    console.log('[spotify redeem] setProvider done');
    return { ok: true, profile: result.profile };
  }
}