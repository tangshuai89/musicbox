import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '../common/config';
import { ProviderSession } from '../common/session';
import { encryptWeApi } from '../music/netease-crypto';

/**
 * 网易云身份认证策略。
 *
 * 历史背景（2026-06 抓包确认）：
 *   - 老接口 /login/qr/key + /login/qr/check 已 302→404
 *   - 新接口 /api/web/qrcode/get 只返回一张静态二维码图片，**没有任何 key
 *     可用于第三方服务器轮询扫码状态**
 *   - /api/w/login 等登录端点对所有编程访问返回 -460 反爬
 *   - MUSIC_U 改为 hex 编码（433 字节 = 866 字符），且 weapi 对非浏览器
 *     请求静默返回 200 + 空 body（指纹反爬）
 *
 * 因此：
 *   - 在 Electron 桌面端：内嵌登录窗口（main.ts）让用户真正在 music.163.com
 *     上登录，自动捕获 MUSIC_U + __csrf + 其他 cookie，postMessage 回
 *     渲染端
 *   - 在浏览器调试端：fallback 弹窗让用户粘贴 MUSIC_U
 *
 * 服务端拿到的 cookie 不再做主动校验（fetchProfileBestEffort 是 best-effort），
 * 让真正的音乐接口（/weapi/radio/get）在用户尝试听歌时做端到端校验。
 * 这样避免被反爬指纹静默拒绝卡在登录这一步。
 */

interface NeteaseQrResponse {
  code: number;
  qrcodeImageUrl?: string;
}

interface AccountResponse {
  code: number;
  profile?: {
    userId: number;
    nickname: string;
    avatarUrl?: string;
    backgroundUrl?: string;
    signature?: string;
  };
  account?: {
    id: number;
    userName: string;
  };
}

@Injectable()
export class NeteaseAuthStrategy {
  private readonly logger = new Logger(NeteaseAuthStrategy.name);

  constructor(private readonly cfg: ConfigService) {}

  /**
   * Generate a QR image the user can scan with the phone NetEase app.
   * This is **best-effort convenience** — scanning only logs the user into
   * music.163.com on their phone; our server does not receive notification.
   * After scanning the user must still export MUSIC_U cookie.
   */
  async generateQr(): Promise<{ qrImg: string; qrUrl: string }> {
    const url = `https://music.163.com/login?source=&codekey=`;
    const body = new URLSearchParams({
      url: 'https://music.163.com/',
      size: '180',
    }).toString();

    const res = await fetch('https://music.163.com/api/web/qrcode/get', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Referer: 'https://music.163.com/',
      },
      body,
    });

    if (!res.ok) {
      throw new BadRequestException(
        `netease qr endpoint returned ${res.status}`,
      );
    }

    const json = (await res.json()) as NeteaseQrResponse;
    if (json.code !== 200 || !json.qrcodeImageUrl) {
      throw new BadRequestException(
        `netease qr failed: code=${json.code}, hasImage=${!!json.qrcodeImageUrl}`,
      );
    }

    return { qrImg: json.qrcodeImageUrl, qrUrl: url };
  }

  /**
   * 接受用户粘贴的 MUSIC_U（必要时 __csrf），存入 session。
   *
   * 历史：原本想调 `/weapi/nuser/account/get` 拉昵称头像，但 NetEase 现在
   * 把 MUSIC_U 改成了 hex 编码的长 token（866 字符 / 433 字节），且对
   * 非浏览器请求会**静默返回 200 + 空 body**（反爬指纹）。继续硬调 weapi
   * 校验没有出路——服务端指纹（Sec-Fetch-* / Client Hints）不是简单加几
   * 个 header 能伪造的。
   *
   * 务实方案：信任 cookie 直接入 session，让真正的音乐接口（`/weapi/radio/get`）
   * 在用户尝试听歌时做端到端校验。如果 cookie 真过期，会在拿曲目时报
   * `{code:301}` JSON 而不是空 body，那个错误更可操作。
   *
   * 用户体验差别只是：登录时立刻显示昵称（来自下面 best-effort 调用）
   * 还是放默认"网易云用户"，昵称在下次播放失败时再提示。
   */
  async loginWithCookie(
    musicU: string,
    csrfToken?: string,
    /** Electron 抓到的全部 cookie 透传过来 */
    extraCookies?: Record<string, string>,
  ): Promise<ProviderSession> {
    if (!musicU || musicU.length < 8) {
      throw new BadRequestException('MUSIC_U 看起来无效');
    }

    this.logger.log(
      `netease login: MUSIC_U=${musicU.length}B, csrf=${
        csrfToken ? `${csrfToken.length}B` : 'MISSING'
      }, extra=${extraCookies ? Object.keys(extraCookies).length : 0} cookies`,
    );

    // best-effort 拉昵称头像（失败也只是用默认，不影响登录）
    let nickname = '网易云用户';
    let avatarUrl = '';
    try {
      const profile = await this.fetchProfileBestEffort(
        musicU,
        csrfToken,
        extraCookies,
      );
      if (profile) {
        nickname = profile.nickname;
        avatarUrl = profile.avatarUrl;
      }
    } catch (err) {
      this.logger.warn(
        `netease best-effort profile fetch failed: ${(err as Error).message}`,
      );
    }

    return {
      musicU,
      csrfToken: csrfToken ?? '',
      nickname,
      avatarUrl,
    };
  }

  /**
   * 尽力拉一次 profile。如果 NetEase 反爬拒了（空 body），返回 null，
   * 让调用方走默认昵称。
   */
  private async fetchProfileBestEffort(
    musicU: string,
    csrfToken: string | undefined,
    extraCookies: Record<string, string> | undefined,
  ): Promise<{ nickname: string; avatarUrl: string } | null> {
    const enc = encryptWeApi({});
    const url =
      `https://music.163.com/weapi/nuser/account/get` +
      (csrfToken ? `?csrf_token=${encodeURIComponent(csrfToken)}` : '');

    const MAX_COOKIE_VALUE_LEN = 1500;
    const cookieParts: string[] = [`MUSIC_U=${musicU}`];
    if (csrfToken) cookieParts.push(`__csrf=${csrfToken}`);
    if (extraCookies) {
      for (const [name, value] of Object.entries(extraCookies)) {
        if (name === 'MUSIC_U' || name === '__csrf') continue;
        if (!value || value.length === 0) continue;
        if (value.length > MAX_COOKIE_VALUE_LEN) continue;
        cookieParts.push(`${name}=${value}`);
      }
    }
    const cookieHeader = cookieParts.join('; ');

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        Referer: 'https://music.163.com/',
        Origin: 'https://music.163.com',
        Cookie: cookieHeader,
      },
      body: new URLSearchParams(enc).toString(),
      redirect: 'manual',
    });

    const rawText = await res.text();
    if (!rawText) return null; // 反爬静默拒绝 → 让上层用默认昵称

    try {
      const data = JSON.parse(rawText) as AccountResponse;
      if (data.code === 200 && data.profile) {
        return {
          nickname: data.profile.nickname ?? data.account?.userName ?? '网易云用户',
          avatarUrl: data.profile.avatarUrl ?? '',
        };
      }
    } catch {
      // 非 JSON 也视为失败
    }
    return null;
  }

  /**
   * Dev-only fallback: read MUSIC_U from env var. Useful for headless testing.
   */
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