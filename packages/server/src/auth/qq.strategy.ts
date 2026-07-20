import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ProviderSession } from '../common/session';

/**
 * QQ 音乐登录策略（cookie 版）。
 *
 * 历史背景（2026-07 定论）：
 *   - 旧实现走 QQ 互联 OAuth（graph.qq.com）拿 access_token，再把它当成
 *     qqmusic_key 塞进 y.qq.com 的请求——这是**两套不同的鉴权系统**，
 *     access_token ≠ qqmusic_key，GetVkey 对需要登录态的歌只会返回空 purl。
 *     而且 QQ 互联网站应用还要求已备案的网站，个人开发者根本过不了审核。
 *   - 新实现：Electron 内嵌登录窗口让用户真正在 y.qq.com 登录 QQ 音乐，
 *     自动捕获浏览器 cookie（qm_keyst / qqmusic_key / uin …），透传到这里
 *     入 session。无需任何 appid / appsecret / 备案。
 *
 * 这里不主动校验 cookie（best-effort 拉昵称，失败也不挡登录），把端到端
 * 校验留给真正的音乐接口（GetVkey）——cookie 真失效时那边会给出可操作的
 * 错误，而不是卡在登录这一步。
 */
@Injectable()
export class QqAuthStrategy {
  private readonly logger = new Logger(QqAuthStrategy.name);

  /**
   * 接受内嵌登录窗口捕获的 QQ 音乐 cookie，存入 session。
   *
   * @param cookie      完整的 "k=v; k=v" cookie header
   * @param uin         归一化后的纯数字 uin（musicu.fcg 用）
   * @param extraCookies 全部 cookie map（调试用）
   */
  async loginWithCookie(
    cookie: string,
    uin?: string,
    extraCookies?: Record<string, string>,
  ): Promise<ProviderSession> {
    if (!cookie || cookie.length < 8) {
      throw new BadRequestException('QQ cookie 看起来无效');
    }

    const hasKey = /qm_keyst=|qqmusic_key=/.test(cookie);
    this.logger.log(
      `qq login: cookieLen=${cookie.length}, uin=${uin ?? 'MISSING'}, ` +
        `hasLoginKey=${hasKey}, cookieCount=${
          extraCookies ? Object.keys(extraCookies).length : 0
        }`,
    );
    if (!hasKey) {
      this.logger.warn(
        'qq login: 没有 qm_keyst / qqmusic_key，可能只登录了 QQ 未登录 QQ 音乐',
      );
    }

    // best-effort 拉昵称/头像 + 绿钻状态；失败只用默认，不影响登录
    let nickname = 'QQ 音乐用户';
    let avatarUrl = '';
    let qqVip: boolean | undefined;
    try {
      const profile = await this.fetchProfileBestEffort(cookie, uin);
      if (profile) {
        nickname = profile.nickname || nickname;
        avatarUrl = profile.avatarUrl || '';
        qqVip = profile.vip;
      }
    } catch (err) {
      this.logger.warn(
        `qq best-effort profile failed: ${(err as Error).message}`,
      );
    }

    // extraCookies 是 Electron 登录窗口解析后的完整 cookie map（qqmusic_key
    // / qm_keyst / skey / p_skey / p_uin / uin / …）。把它落进 session，
    // QQ provider 需要按名取 skey 算 g_tk、做 favorites 鉴权时直接读。
    // 老 session 没这个字段 → provider 那边用 '5381' 兜底，不阻塞。
    return {
      qqCookie: cookie,
      qqUin: uin,
      qqCookies: extraCookies,
      nickname,
      avatarUrl,
      qqVip,
    };
  }

  isConfigured(session: ProviderSession | undefined): boolean {
    return Boolean(session?.qqCookie);
  }

  /**
   * QQ 音乐 map_userinfo 里可能表示"绿钻会员"的字段（不同版本字段名不一）。
   * 任一 ≥ 1 / true → 判定为 VIP。拿不到任何一个 → 返回 undefined（未知）。
   */
  private static readonly VIP_FIELDS = [
    'ivip',
    'isVip',
    'is_vip',
    'vip',
    'svip',
    'is_green',
    'green',
    'yellow_vip',
    'lvip',
  ];

  private detectVip(entry: Record<string, unknown>): boolean | undefined {
    let sawField = false;
    for (const f of QqAuthStrategy.VIP_FIELDS) {
      const v = entry[f];
      if (v === undefined || v === null) continue;
      sawField = true;
      if (typeof v === 'number' && v >= 1) return true;
      if (typeof v === 'boolean' && v) return true;
      if (typeof v === 'string' && /^(1|true|yes)$/i.test(v)) return true;
    }
    // 见到了 vip 字段但都是"非会员"值 → 明确 false；一个都没见到 → 未知。
    return sawField ? false : undefined;
  }

  /**
   * 尽力拉一次用户资料（昵称/头像 + 绿钻状态）。用 QQ 音乐 get_user_baseinfo_v2。
   * 失败返回 null，让上层用默认昵称、VIP 未知。
   */
  private async fetchProfileBestEffort(
    cookie: string,
    uin?: string,
  ): Promise<{ nickname: string; avatarUrl: string; vip?: boolean } | null> {
    if (!uin) return null;
    const body = {
      comm: { ct: 24, cv: 0 },
      req_0: {
        module: 'userInfo.BaseUserInfoServer',
        method: 'get_user_baseinfo_v2',
        param: { vec_uin: [uin] },
      },
    };
    const res = await fetch(
      'https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&inCharset=utf8&outCharset=utf-8',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          Referer: 'https://y.qq.com/',
          Cookie: cookie,
        },
        body: JSON.stringify(body),
      },
    );
    const text = await res.text();
    if (!text) return null;
    try {
      const json = JSON.parse(text) as {
        req_0?: {
          data?: {
            map_userinfo?: Record<
              string,
              { nick?: string; headpic?: string; avatar?: string }
            >;
          };
        };
      };
      const map = json.req_0?.data?.map_userinfo;
      const first = map ? Object.values(map)[0] : undefined;
      if (first?.nick) {
        const vip = this.detectVip(first as Record<string, unknown>);
        // 打日志方便核对：若 VIP 检测没命中（vip=undefined），这行会列出
        // map_userinfo 的实际字段名，贴出来就能把 VIP_FIELDS 补准。
        this.logger.log(
          `qq profile: nick="${first.nick}" vip=${vip ?? 'unknown'}` +
            (vip === undefined
              ? ` (userinfo keys: ${Object.keys(first as object).join(',')})`
              : ''),
        );
        return {
          nickname: first.nick,
          avatarUrl: first.headpic ?? first.avatar ?? '',
          vip,
        };
      }
    } catch {
      // 非 JSON / 结构变了都视为失败
    }
    return null;
  }
}
