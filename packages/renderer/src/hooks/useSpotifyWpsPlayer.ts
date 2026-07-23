/**
 * useSpotifyWpsPlayer — 把 spotify-wps 包装成 React hook。
 *
 * 行为：
 *  - 懒初始化：首次有 Premium spotify session 时调 connect；后续 OAuth
 *    状态变化（logout / Free / 非 Premium）会断连。
 *  - token 续期：监听 expiresAt，提前 60s 重拉 + connect(newToken)。
 *  - 状态镜像：把 WPS 的 player_state_changed 镜像到本 hook 的 state，
 *    usePlayer 拿这套 state 同步 UI。
 *
 * 这是 v2 的 Premium-only 播放路径；Free 账户 / 离线时返回的 wpsReady
 * 始终是 false，调用方应当回退到 30s 预览路径。
 */
import { useEffect, useRef, useState } from 'react';
import { getSpotifyToken } from '../api';
import { createWpsWrapper, type WpsWrapper, type WpsPlayerState } from '../lib/spotify-wps';

export interface UseSpotifyWpsPlayer {
  /** WPS player 是否 connected。false = 走 30s 预览路径。 */
  wpsReady: boolean;
  /** WPS 镜像过来的播放状态。 */
  state: WpsPlayerState;
  /** 开始播放一个 spotify track URI（spotify:track:xxx）。 */
  play(trackUri: string): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  seek(positionMs: number): Promise<void>;
  /** 拿 deviceId 切到本设备的 Spotify Connect API 调用。 */
  transferHere(): Promise<void>;
}

interface Options {
  /** 当前是否登录到 Premium Spotify。tier !== 'premium' 时不会 connect。 */
  enabled: boolean;
}

/** 每 30s 检查一次 token 即将到期的情况，提前 60s refresh。 */
const TOKEN_REFRESH_LEAD_MS = 60_000;
const TOKEN_CHECK_INTERVAL_MS = 30_000;

export function useSpotifyWpsPlayer({ enabled }: Options): UseSpotifyWpsPlayer {
  const [wpsReady, setWpsReady] = useState(false);
  const [state, setState] = useState<WpsPlayerState>({
    hasTrack: false,
    isPlaying: false,
    track: null,
    positionMs: 0,
  });
  const wrapperRef = useRef<WpsWrapper | null>(null);

  useEffect(() => {
    if (!enabled) {
      // Free / 没登录 / tier 缺省 → 不 connect，已有 wrapper 断连
      wrapperRef.current?.disconnect();
      wrapperRef.current = null;
      setWpsReady(false);
      console.log('[wps hook] disabled, wpsReady=false');
      return;
    }

    let cancelled = false;
    let refreshTimer: number | null = null;

    async function init(): Promise<void> {
      try {
        const tok = await getSpotifyToken();
        if (cancelled) return;
        if (tok.tier !== 'premium') {
          // 罕见的并发：login 切到 free / premium 切换中 → 不连
          setWpsReady(false);
          return;
        }
        const w = createWpsWrapper();
        wrapperRef.current = w;
        // No stored unsubscribe: teardown calls w.disconnect() which clears
        // all subscribers, and the callback already guards on `cancelled`.
        w.onStateChange((s) => {
          if (!cancelled) setState(s);
        });
        await w.connect(tok.accessToken);
        if (cancelled) { w.disconnect(); return; }
        // 不等 fixed timeout——SDK ready 事件先到才真 ready。
        // 安全上限 15s；期间 emeOk 变为 false 或 ready 不 fire 则退出。
        const ready = await new Promise<boolean>((resolve) => {
          const deadline = Date.now() + 15_000;
          const check = () => {
            if (cancelled) return resolve(false);
            if (w.emeOk && w.hasDeviceId) return resolve(true);
            if (!w.emeOk) return resolve(false);
            if (Date.now() > deadline) return resolve(false);
            setTimeout(check, 200);
          };
          // 如果 ready 事件在 connect 里已经 fire 了，立即检查
          check();
        });
        if (!ready) {
          setWpsReady(false);
          return;
        }
        setWpsReady(true);

        // Token 续期定时器：每次 tick 检查 expiresAt；将到期则重拉 + connect
        refreshTimer = window.setInterval(async () => {
          if (cancelled) return;
          try {
            const cur = await getSpotifyToken();
            if (cancelled) return;
            const remaining = cur.expiresAt - Date.now();
            if (remaining < TOKEN_REFRESH_LEAD_MS) {
              // 仅刷新 token，不重建 connection —— 避免 disconnect→connect 之间
              // 的播放秒停（v2 已知限制：$w.connect() 会断旧 player 再建新。
              // 修复：不重连，只让 SDK 的 getOAuthToken 回调在下次 WebSocket 续连
              // 时拿到新 token）。
              w.refreshToken(cur.accessToken);
            }
          } catch (err) {
            // token 端点失败时保持现有连接（WPS 自己会断），下次 tick 再试
            console.warn('[wps] token refresh check failed:', err);
          }
        }, TOKEN_CHECK_INTERVAL_MS);
      } catch (err) {
        if (!cancelled) {
          console.warn('[wps] init failed (Premium required, Free = expected):', err);
          setWpsReady(false);
        }
      }
    }
    void init();

    return () => {
      cancelled = true;
      if (refreshTimer) window.clearInterval(refreshTimer);
      wrapperRef.current?.disconnect();
      wrapperRef.current = null;
      setWpsReady(false);
    };
  }, [enabled]);

  return {
    wpsReady,
    state,
    async play(trackUri) {
      await wrapperRef.current?.play(trackUri);
    },
    async pause() {
      await wrapperRef.current?.pause();
    },
    async resume() {
      await wrapperRef.current?.resume();
    },
    async seek(positionMs) {
      await wrapperRef.current?.seek(positionMs);
    },
    async transferHere() {
      await wrapperRef.current?.transferHere();
    },
  };
}
