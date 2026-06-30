import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '../common/config';
import { ProviderSession } from '../common/session';
import * as crypto from 'crypto';

/**
 * QQ 互联 OAuth 2.0 真实流程。
 *
 *   1. /auth/qq/login  → 302 到 https://graph.qq.com/oauth2.0/authorize
 *   2. 用户授权后 QQ 回调 /auth/qq/callback?code=xxx&state=yyy
 *   3. 我们 POST https://graph.qq.com/oauth2.0/token 用 code 换 access_token
 *   4. 再 GET https://graph.qq.com/oauth2.0/me 拿 openid（这一步 QQ 会在 body 里塞一段 JSONP，要剥掉 callback(...) 包装）
 *   5. 再 GET https://graph.qq.com/user/get_user_info 拿昵称头像
 *
 * QQ 的 redirect_uri 必须严格匹配注册时填写的字符串，所以这里不放任何
 * query 参数。如果以后要扩展多 provider 共用同一回调，通过 state 区分。
 */
@Injectable()
export class QqOAuthStrategy {
  private readonly logger = new Logger(QqOAuthStrategy.name);

  constructor(private readonly cfg: ConfigService) {}

  buildAuthorizeUrl(state: string): string {
    const url = new URL('https://graph.qq.com/oauth2.0/authorize');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.cfg.qqAppId);
    url.searchParams.set('redirect_uri', this.cfg.qqRedirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('scope', 'get_user_info');
    return url.toString();
  }

  isConfigured(): boolean {
    return Boolean(this.cfg.qqAppId && this.cfg.qqAppSecret);
  }

  /**
   * Exchange the OAuth code for tokens + profile. Throws on any failure so
   * the controller can surface a useful error to the renderer.
   */
  async exchangeCode(code: string): Promise<ProviderSession> {
    if (!this.isConfigured()) {
      throw new BadRequestException(
        'QQ_APP_ID / QQ_APP_SECRET not configured on the server',
      );
    }

    const tokenResp = await this.fetchToken(code);
    const { access_token, refresh_token, expires_in } = tokenResp;

    const openId = await this.fetchOpenId(access_token);
    const profile = await this.fetchUserInfo(access_token, openId);

    return {
      accessToken: access_token,
      refreshToken: refresh_token,
      openId,
      unionId: openId, // 简化处理：用 openId 作为稳定 ID
      expiresAt: Date.now() + Number(expires_in ?? 7200) * 1000,
      nickname: profile.nickname,
      avatarUrl: profile.figureurl_qq_2 || profile.figureurl_qq_1 || profile.figureurl_1 || '',
    };
  }

  /** Refresh an expired access token. Returns null if refresh failed. */
  async refresh(session: ProviderSession): Promise<ProviderSession | null> {
    if (!session.refreshToken) return null;
    if (!this.isConfigured()) return null;

    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.cfg.qqAppId,
      client_secret: this.cfg.qqAppSecret,
      refresh_token: session.refreshToken,
    });

    try {
      const res = await fetch(
        `https://graph.qq.com/oauth2.0/token?${params.toString()}`,
      );
      const text = await res.text();
      const parsed = new URLSearchParams(text);
      if (parsed.get('access_token')) {
        return {
          ...session,
          accessToken: parsed.get('access_token')!,
          refreshToken: parsed.get('refresh_token') ?? session.refreshToken,
          expiresAt:
            Date.now() +
            Number(parsed.get('expires_in') ?? 7200) * 1000,
        };
      }
      this.logger.warn(`QQ refresh failed: ${text}`);
      return null;
    } catch (err) {
      this.logger.warn(`QQ refresh error: ${(err as Error).message}`);
      return null;
    }
  }

  // ── internal helpers ──────────────────────────────────────────────────────

  private async fetchToken(code: string): Promise<{
    access_token: string;
    refresh_token: string;
    expires_in: string;
  }> {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.cfg.qqAppId,
      client_secret: this.cfg.qqAppSecret,
      code,
      redirect_uri: this.cfg.qqRedirectUri,
    });

    const res = await fetch(
      `https://graph.qq.com/oauth2.0/token?${params.toString()}`,
    );
    const text = await res.text();
    // 正常返回是 application/x-www-form-urlencoded
    const parsed = new URLSearchParams(text);
    if (!parsed.get('access_token')) {
      throw new BadRequestException(
        `QQ token exchange failed: ${text.slice(0, 200)}`,
      );
    }
    return {
      access_token: parsed.get('access_token')!,
      refresh_token: parsed.get('refresh_token') ?? '',
      expires_in: parsed.get('expires_in') ?? '7200',
    };
  }

  private async fetchOpenId(accessToken: string): Promise<string> {
    const res = await fetch(
      `https://graph.qq.com/oauth2.0/me?access_token=${encodeURIComponent(accessToken)}`,
    );
    const text = await res.text();
    // 返回 callback({"client_id":"...","openid":"..."});
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new BadRequestException(
        `QQ openid response unrecognised: ${text.slice(0, 200)}`,
      );
    }
    const json = JSON.parse(match[0]) as { openid?: string };
    if (!json.openid) {
      throw new BadRequestException(
        `QQ openid missing: ${text.slice(0, 200)}`,
      );
    }
    return json.openid;
  }

  private async fetchUserInfo(
    accessToken: string,
    openId: string,
  ): Promise<{
    nickname: string;
    figureurl_qq_2?: string;
    figureurl_qq_1?: string;
    figureurl_1?: string;
  }> {
    const params = new URLSearchParams({
      access_token: accessToken,
      oauth_consumer_key: this.cfg.qqAppId,
      openid: openId,
    });
    const res = await fetch(
      `https://graph.qq.com/user/get_user_info?${params.toString()}`,
    );
    const json = (await res.json()) as {
      ret?: number;
      msg?: string;
      nickname?: string;
      figureurl_qq_2?: string;
      figureurl_qq_1?: string;
      figureurl_1?: string;
    };
    if (json.ret !== 0 || !json.nickname) {
      throw new BadRequestException(
        `QQ user info failed: ${json.msg ?? 'unknown'}`,
      );
    }
    return {
      nickname: json.nickname,
      figureurl_qq_2: json.figureurl_qq_2,
      figureurl_qq_1: json.figureurl_qq_1,
      figureurl_1: json.figureurl_1,
    };
  }

  /** Generate an opaque state string for CSRF protection. */
  newState(): string {
    return crypto.randomBytes(16).toString('hex');
  }
}