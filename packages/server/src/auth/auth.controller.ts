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
} from '@nestjs/common';
import { normalizeProvider } from '../common/provider';
import { Request, Response } from 'express';
import { QqAuthStrategy } from './qq.strategy';
import { NeteaseAuthStrategy } from './netease-auth.strategy';
import { SessionService } from '../common/session';

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly qq: QqAuthStrategy,
    private readonly netease: NeteaseAuthStrategy,
    private readonly sessionService: SessionService,
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
    return {
      provider: p,
      loggedIn: Boolean(ps?.qqCookie || ps?.musicU),
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