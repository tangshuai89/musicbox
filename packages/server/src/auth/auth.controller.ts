import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Req,
  Res,
  BadRequestException,
} from '@nestjs/common';
import { normalizeProvider } from '../common/provider';
import { Request, Response } from 'express';
import { QqOAuthStrategy } from './qq.strategy';
import { NeteaseAuthStrategy } from './netease-auth.strategy';
import { SessionService } from '../common/session';
import { ConfigService } from '../common/config';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly qq: QqOAuthStrategy,
    private readonly netease: NeteaseAuthStrategy,
    private readonly sessionService: SessionService,
    private readonly cfg: ConfigService,
  ) {}

  // ── QQ ────────────────────────────────────────────────────────────────────

  @Get('qq/login')
  qqLogin(@Req() req: Request, @Res() res: Response) {
    if (!this.qq.isConfigured()) {
      return res.redirect(
        `${this.cfg.rendererBase}/?provider=qq&error=qq_not_configured`,
      );
    }
    const state = this.qq.newState();
    const url = this.qq.buildAuthorizeUrl(state);
    return res.redirect(url);
  }

  @Get('qq/callback')
  async qqCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (!code) {
      return res.redirect(
        `${this.cfg.rendererBase}/?provider=qq&error=missing_code`,
      );
    }
    try {
      const profile = await this.qq.exchangeCode(code);
      const session = this.sessionService.resolve(req, res);
      this.sessionService.setProvider(session, 'qq', profile);
      return res.redirect(`${this.cfg.rendererBase}/?provider=qq&login=ok`);
    } catch (err) {
      return res.redirect(
        `${this.cfg.rendererBase}/?provider=qq&error=${encodeURIComponent(
          (err as Error).message,
        )}`,
      );
    }
  }

  // ── NetEase ───────────────────────────────────────────────────────────────

  /**
   * Generate a QR image for convenience (用户可以在手机网易云上扫这个码登
   * 录 music.163.com，但本服务器收不到通知）。前端主要用来在 modal 里展示
   * "用手机扫码" 提示。
   */
  @Post('netease/qr/start')
  async neteaseQrStart() {
    return this.netease.generateQr();
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
      body.extraCookies,
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
    return {
      provider: p,
      loggedIn: Boolean(ps?.accessToken || ps?.musicU),
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
}