import { Controller, Get, Query, Res, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get('login')
  login(@Res() res: Response) {
    const authUrl = this.authService.getAuthUrl();
    return res.redirect(authUrl);
  }

  @Get('callback')
  async callback(
    @Query('code') code: string,
    @Res() res: Response,
  ) {
    if (!code) {
      return res.status(HttpStatus.BAD_REQUEST).json({ error: 'Missing code' });
    }

    const profile = await this.authService.handleCallback(code);

    // Redirect back to the Electron app with auth info
    // The renderer will pick this up via the custom protocol or query params
    const redirectUrl = `http://localhost:5173/auth-success?nickname=${encodeURIComponent(profile.nickname)}&openId=${profile.openId}&token=${profile.accessToken}`;
    return res.redirect(redirectUrl);
  }

  @Get('status')
  getStatus() {
    const user = this.authService.getCurrentUser();
    return {
      loggedIn: this.authService.isLoggedIn(),
      user: user
        ? { nickname: user.nickname, avatarUrl: user.avatarUrl, openId: user.openId }
        : null,
    };
  }

  @Get('logout')
  logout() {
    this.authService.logout();
    return { success: true };
  }
}
