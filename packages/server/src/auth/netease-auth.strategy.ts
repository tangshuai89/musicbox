import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import * as QRCode from 'qrcode';
import { ConfigService } from '../common/config';
import { ProviderSession } from '../common/session';

/**
 * 网易云身份认证策略 —— 真·扫码登录。
 *
 * 2026-07 实测：music.163.com 的明文 `/api/*` 端点（非 weapi）对服务端
 * 直接请求是放行的（weapi 加密通道才有浏览器指纹反爬）：
 *
 *   1. POST /api/login/qrcode/unikey   {type:1}          → { unikey }
 *   2. 二维码内容: https://music.163.com/login?codekey={unikey}
 *      （服务端用 qrcode 库生成 dataURL，前端展示，手机网易云 App 扫码）
 *   3. POST /api/login/qrcode/client/login {key,type:1}  → code:
 *        800 二维码过期 / 801 等待扫码 / 802 已扫码待确认 / 803 登录成功
 *      803 时响应 Set-Cookie 携带 MUSIC_U 与 __csrf
 *   4. POST /api/nuser/account/get（带 cookie）           → 昵称/头像/uid
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const BASE_HEADERS: Record<string, string> = {
  'Content-Type': 'application/x-www-form-urlencoded',
  'User-Agent': UA,
  Referer: 'https://music.163.com/',
  Origin: 'https://music.163.com',
  Accept: 'application/json, text/plain, */*',
};

interface AccountResponse {
  code: number;
  profile?: {
    userId: number;
    nickname: string;
    avatarUrl?: string;
  } | null;
  account?: { id: number; userName: string } | null;
}

export interface NeteaseQrCheckResult {
  /** 800 过期 / 801 等待扫码 / 802 已扫码待确认 / 803 成功 */
  code: number;
  message: string;
  session?: ProviderSession;
}

@Injectable()
export class NeteaseAuthStrategy {
  private readonly logger = new Logger(NeteaseAuthStrategy.name);

  constructor(private readonly cfg: ConfigService) {}

  /** 第一步：拿 unikey 并生成二维码图片（dataURL）。 */
  async qrStart(): Promise<{ key: string; qrImg: string; qrUrl: string }> {
    const res = await fetch('https://music.163.com/api/login/qrcode/unikey', {
      method: 'POST',
      headers: BASE_HEADERS,
      body: new URLSearchParams({ type: '1' }).toString(),
    });
    const json = (await res.json()) as { code: number; unikey?: string };
    if (json.code !== 200 || !json.unikey) {
      throw new BadRequestException(`netease qr unikey failed: code=${json.code}`);
    }
    const qrUrl = `https://music.163.com/login?codekey=${json.unikey}`;
    const qrImg = await QRCode.toDataURL(qrUrl, { width: 220, margin: 1 });
    return { key: json.unikey, qrImg, qrUrl };
  }

  /** 第二步：轮询扫码状态。803 时捕获 Set-Cookie 里的 MUSIC_U / __csrf。 */
  async qrCheck(key: string): Promise<NeteaseQrCheckResult> {
    const res = await fetch(
      'https://music.163.com/api/login/qrcode/client/login',
      {
        method: 'POST',
        headers: BASE_HEADERS,
        body: new URLSearchParams({ key, type: '1' }).toString(),
        redirect: 'manual',
      },
    );
    const json = (await res.json()) as { code: number; message?: string };
    this.logger.log(`netease qr check key=${key.slice(0, 8)}… → code=${json.code}`);
    if (json.code !== 803) {
      return { code: json.code, message: json.message ?? '' };
    }

    // 803 = authorised. The MUSIC_U / __csrf cookies come back in Set-Cookie.
    // getSetCookie() returns one entry per Set-Cookie header (the correct way —
    // a single combined header can't be split on commas because expiry dates
    // contain commas).
    const setCookies =
      typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : [];
    const cookies: Record<string, string> = {};
    for (const line of setCookies) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) {
        cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
      }
    }
    this.logger.log(
      `netease qr 803: ${setCookies.length} set-cookie header(s), names=[${Object.keys(cookies).join(',')}]`,
    );
    const musicU = cookies['MUSIC_U'];
    const csrfToken = cookies['__csrf'] ?? '';
    if (!musicU) {
      this.logger.error(
        `netease qr 803 but no MUSIC_U in set-cookie (got: ${Object.keys(cookies).join(',') || '<none>'})`,
      );
      throw new BadRequestException('登录成功但未取到 MUSIC_U，请重试');
    }
    this.logger.log(`netease qr 803: captured MUSIC_U (len=${musicU.length})`);

    const profile = await this.fetchProfile(musicU, csrfToken);
    return {
      code: 803,
      message: '登录成功',
      session: {
        musicU,
        csrfToken,
        nickname: profile?.nickname ?? '网易云用户',
        avatarUrl: profile?.avatarUrl ?? '',
      },
    };
  }

  /** 浏览器调试兜底：用户手动粘贴 MUSIC_U。 */
  async loginWithCookie(
    musicU: string,
    csrfToken?: string,
  ): Promise<ProviderSession> {
    if (!musicU || musicU.length < 8) {
      throw new BadRequestException('MUSIC_U 看起来无效');
    }
    const profile = await this.fetchProfile(musicU, csrfToken ?? '');
    return {
      musicU,
      csrfToken: csrfToken ?? '',
      nickname: profile?.nickname ?? '网易云用户',
      avatarUrl: profile?.avatarUrl ?? '',
    };
  }

  /** 用明文 /api 端点拉账号信息（服务端直连可用，无需 weapi 加密）。 */
  private async fetchProfile(
    musicU: string,
    csrfToken: string,
  ): Promise<{ nickname: string; avatarUrl: string } | null> {
    try {
      const cookie =
        `MUSIC_U=${musicU}; os=pc` + (csrfToken ? `; __csrf=${csrfToken}` : '');
      const res = await fetch('https://music.163.com/api/nuser/account/get', {
        method: 'POST',
        headers: { ...BASE_HEADERS, Cookie: cookie },
        body: '',
      });
      const data = (await res.json()) as AccountResponse;
      if (data.code === 200 && data.profile) {
        return {
          nickname: data.profile.nickname ?? data.account?.userName ?? '网易云用户',
          avatarUrl: data.profile.avatarUrl ?? '',
        };
      }
      this.logger.warn(
        `netease account/get code=${data.code}, profile=${data.profile ? 'yes' : 'null'}`,
      );
    } catch (err) {
      this.logger.warn(`netease profile fetch failed: ${(err as Error).message}`);
    }
    return null;
  }

  /** Dev-only fallback: read MUSIC_U from env var. Useful for headless testing. */
  devLoginFromEnv(): ProviderSession | null {
    if (!this.cfg.neteaseMusicU) return null;
    return {
      musicU: this.cfg.neteaseMusicU,
      csrfToken: '',
      nickname: 'Dev User',
      avatarUrl: '',
    };
  }
}
