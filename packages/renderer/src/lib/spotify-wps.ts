/**
 * Spotify Web Playback SDK 包装。
 *
 * 设计目标：
 *  - 把 SDK 的 window.Spotify.Player 收敛成一个 Promise + 简单同步 API
 *    (connect/play/pause/resume/seek/disconnect) 供 useSpotifyWpsPlayer 用。
 *  - device name 唯一化（避免 dev + prod 同账号冲突），并支持 token 切换。
 *  - 不在没 SDK 脚本时 throw —— 静默返回 disconnected，让 UI 走 30s 预览兜底。
 *
 * 约束（v2）：
 *  - 仅 Premium 账户可用；Free 走 MusicService 现有 /music/stream/spotify/:id
 *    代理路径（30s mp3），不走这里。
 *  - 浏览器 vs Electron：WPS 要求 secure context（HTTPS / localhost），但
 *    renderer 跑在 Vite (:5173) 和 Electron 都是 secure context。
 *  - SDK 在账户上"为这个 App 注册一个 Spotify Connect 设备"——只要音乐
 *    来自同一 Spotify 账号且设备 active，推流由 Spotify 服务器发起，WPS
 *    接收 WebSocket 字节。
 */

// SDK 脚本由 index.html defer 加载（<script src="https://sdk.scdn.co/spotify-player.js">）。

export type WpsStateCallback = (s: WpsPlayerState) => void;

export interface WpsPlayerState {
  /** 是否有当前播放内容。 */
  hasTrack: boolean;
  /** 是否正在播放。 */
  isPlaying: boolean;
  /** 当前曲目信息（来自 SDK，可能为 null）。 */
  track: {
    uri: string;
    name: string;
    artists: string[];
    album: string;
    durationMs: number;
  } | null;
  /** 当前播放位置 ms（来自 SDK 的 position，每 1s 左右更新一次）。 */
  positionMs: number;
}

export interface WpsWrapper {
  /** SDK 是否已 ready（connect 完成）。 */
  readonly ready: boolean;
  /** 注册一个状态变更订阅。返回 unsubscribe。 */
  onStateChange(cb: WpsStateCallback): () => void;
  /** 用新 token 重新连接（refresh 轮换时）。会断开旧 player 再建。 */
  connect(token: string): Promise<void>;
  /** 仅刷新内部 getToken（不重建 connection）。用在 token 1h 到期续期时，
   *  让 SDK 的 getOAuthToken 回调能拿到新 token，无需打断当前播放。 */
  refreshToken(token: string): void;
  /** 断开 + 不再 connect。 */
  disconnect(): void;
  /** 播放 spotify:track:{id} 或 spotify:uri。SDK 内部会切到本设备。 */
  play(trackUri: string): Promise<void>;
  /** 恢复当前 paused 曲目。 */
  resume(): Promise<void>;
  pause(): Promise<void>;
  /** 跳到位置。 */
  seek(positionMs: number): Promise<void>;
  /** 让本 wrapper 的设备成为 active（播放前必做，否则手机先抢走）。 */
  transferHere(): Promise<void>;
}

declare global {
  interface Window {
    Spotify?: {
      Player: new (opts: {
        name: string;
        getOAuthToken: (cb: (token: string) => void) => void;
        volume?: number;
      }) => SpotifyPlayer;
    };
  }
}

/** SDK 的 Player 类型（按官方 SDK 文档）。 */
interface SpotifyPlayer {
  connect(): Promise<boolean>;
  disconnect(): void;
  getCurrentState(): Promise<SpotifyWebPlaybackState | null>;
  getVolume(): Promise<number>;
  setVolume(v: number): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  togglePlay(): Promise<void>;
  seek(positionMs: number): Promise<void>;
  activateElement?(): Promise<void>;
  nextTrack?(): Promise<void>;
  previousTrack?(): Promise<void>;
  // SDK 事件回调各自 payload 不同，统一收成 unknown，回调里 narrow。
  on(event: string, cb: (payload: unknown) => void): void;
}

interface SpotifyWebPlaybackState {
  context?: { uri: string };
  track: {
    uri: string;
    name: string;
    artists: Array<{ name: string }>;
    album: { name: string };
    duration_ms: number;
  } | null;
  paused: boolean;
  position: number;
  timestamp: number;
}

type SpotifySdk = NonNullable<typeof window.Spotify>;

let sdkPromise: Promise<SpotifySdk> | null = null;

/** 等待 SDK 脚本（index.html 已经 defer 加载）。 */
function waitForSdk(): Promise<SpotifySdk> {
  if (window.Spotify) return Promise.resolve(window.Spotify);
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise<SpotifySdk>((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (window.Spotify) return resolve(window.Spotify);
      if (Date.now() - start > 5000) {
        return reject(new Error('spotify-wps: SDK script 未在 5s 内 ready'));
      }
      setTimeout(tick, 50);
    };
    tick();
  });
  return sdkPromise;
}

/** 设备名：避免 dev + prod 同账号冲突，所以带 pid + 短随机后缀。 */
function makeDeviceName(): string {
  return `maestro-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function createWpsWrapper(): WpsWrapper {
  let player: SpotifyPlayer | null = null;
  let getToken: (() => Promise<string | null>) | null = null;
  // 设备名在 wrapper 生命周期内固定：token 续期重连时复用同一名字，
  // Spotify Connect 才会把推流继续路由到同一设备（否则每次重连都冒出一个
  // 新设备、播放会断）。
  const deviceName = makeDeviceName();
  const subs = new Set<WpsStateCallback>();
  let lastState: WpsPlayerState = {
    hasTrack: false,
    isPlaying: false,
    track: null,
    positionMs: 0,
  };

  function emit(s: WpsPlayerState): void {
    lastState = s;
    subs.forEach((cb) => {
      try {
        cb(s);
      } catch {
        // 订阅者抛错不影响其他订阅者
      }
    });
  }

  function bindListeners(p: SpotifyPlayer): void {
    // SDK 事件 payload 类型各异，回调统一收 unknown 再 narrow（见 on() 签名）。
    const onPlayerStateChanged = (payload: unknown): void => {
      const sdkState = payload as SpotifyWebPlaybackState | null;
      if (!sdkState || !sdkState.track) {
        emit({ hasTrack: false, isPlaying: false, track: null, positionMs: 0 });
        return;
      }
      const t = sdkState.track;
      emit({
        hasTrack: true,
        isPlaying: !sdkState.paused,
        track: {
          uri: t.uri,
          name: t.name,
          artists: t.artists.map((a) => a.name),
          album: t.album.name,
          durationMs: t.duration_ms,
        },
        positionMs: sdkState.position ?? 0,
      });
    };
    const onReady = (payload: unknown): void => {
      // 切到本设备：Spotify Connect 客户端调 PUT /v1/me/player 切到本 deviceId
      // 即可（由 useSpotifyWpsPlayer 拿到 deviceId 后经 transferHere() 完成）。
      const info = payload as { device_id?: string };
      if (info?.device_id) {
        (player as unknown as { _deviceId?: string })._deviceId = info.device_id;
      }
    };
    const onNotReady = (): void => {
      emit({ hasTrack: false, isPlaying: false, track: null, positionMs: 0 });
    };
    const onError = (label: string) => (payload: unknown): void => {
      console.warn(`[spotify-wps] ${label}:`, payload);
    };
    p.on('player_state_changed', onPlayerStateChanged);
    p.on('ready', onReady);
    p.on('not_ready', onNotReady);
    p.on('initial_state', onPlayerStateChanged);
    p.on('authentication_error', onError('authentication_error'));
    p.on('playback_error', onError('playback_error'));
  }

  async function connect(token: string): Promise<void> {
    getToken = async () => token;
    const Spotify = await waitForSdk();
    if (player) {
      try {
        player.disconnect();
      } catch {
        // ignore
      }
      player = null;
    }
    const p = new Spotify.Player({
      name: deviceName,
      getOAuthToken: (cb) => {
        // SDK 会在 WebSocket 续连时回调；此时调我们的 token getter。
        if (getToken) {
          void getToken().then((t) => (t ? cb(t) : cb(token)));
        } else {
          cb(token);
        }
      },
      volume: 0.8,
    });
    bindListeners(p);
    const ok = await p.connect();
    if (!ok) {
      throw new Error('spotify-wps: connect() 返 false');
    }
    player = p;
  }

  function disconnect(): void {
    if (player) {
      try {
        player.disconnect();
      } catch {
        // ignore
      }
      player = null;
    }
    subs.clear();
    getToken = null;
  }

  async function play(trackUri: string): Promise<void> {
    if (!player) throw new Error('spotify-wps: not connected');
    // 通过 PUT /v1/me/player/play 切到本设备 + 播放
    const deviceId = (player as unknown as { _deviceId?: string })._deviceId;
    if (!deviceId) throw new Error('spotify-wps: device not ready');
    const token = await getToken?.();
    if (!token) throw new Error('spotify-wps: no token');
    const res = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ uris: [trackUri] }),
    });
    if (!res.ok && res.status !== 204) {
      const text = await res.text().catch(() => '');
      throw new Error(`spotify-wps: play failed ${res.status} ${text.slice(0, 200)}`);
    }
  }

  async function resume(): Promise<void> {
    if (!player) return;
    await player.resume();
  }

  async function pause(): Promise<void> {
    if (!player) return;
    await player.pause();
  }

  async function seek(positionMs: number): Promise<void> {
    if (!player) return;
    await player.seek(positionMs);
  }

  async function transferHere(): Promise<void> {
    if (!player) return;
    const deviceId = (player as unknown as { _deviceId?: string })._deviceId;
    if (!deviceId) return;
    const token = await getToken?.();
    if (!token) return;
    await fetch('https://api.spotify.com/v1/me/player', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ device_ids: [deviceId], play: false }),
    });
  }

  function onStateChange(cb: WpsStateCallback): () => void {
    subs.add(cb);
    // 立即把当前 lastState 推给新订阅者（避免 race：connect 完时已有 state）
    try {
      cb(lastState);
    } catch {
      // ignore
    }
    return () => {
      subs.delete(cb);
    };
  }

  return {
    get ready() {
      return Boolean(player);
    },
    onStateChange,
    connect,
    refreshToken(token: string): void {
      getToken = async () => token;
    },
    disconnect,
    play,
    resume,
    pause,
    seek,
    transferHere,
  };
}
