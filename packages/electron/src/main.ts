import {
  app,
  BrowserWindow,
  shell,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
} from 'electron';
import * as path from 'path';
import { spawn, ChildProcess } from 'node:child_process';

// Pin the app name so userData / logs land under a stable, branded dir in
// BOTH dev and packaged mode (~/Library/Application Support/Maestro). Without
// this, dev would derive the name from the electron package.json (@maestro/…).
app.setName('Maestro');

const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;

/**
 * Runtime asset (icons) resolver. In dev, assets live in `packages/electron/build`
 * (one level up from the compiled `dist/`). In a packaged app they're copied to
 * `Resources/build/` via electron-builder extraResources.
 */
function assetPath(name: string): string {
  return isDev
    ? path.join(__dirname, '..', 'build', name)
    : path.join(process.resourcesPath, 'build', name);
}

/** Set true once the user really wants to quit (Cmd+Q / tray Quit), so the
 * window `close` handler stops hiding-to-tray and lets the app exit. */
let isQuitting = false;

// ── NestJS sidecar（packaged 模式） ────────────────────────────────────────

/** Sidecar 进程。dev 模式不启动（用户用 `npm run dev:server` 自己跑）。 */
let sidecar: ChildProcess | null = null;

/** Sidecar 端口，默认 3200；PORT env 可改。 */
const SIDECAR_PORT = Number(process.env.PORT ?? 3200);

/** 等端口就绪（轮询 :3200/music/deezer/editorials 之类的轻量 endpoint）。 */
async function waitForSidecar(port: number, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/music/deezer/editorials`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`sidecar not ready after ${timeoutMs}ms on :${port}`);
}

/** Spawn NestJS sidecar（packaged 模式）。 */
function startSidecar(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (isDev) {
      // dev 模式：用户自己跑 `npm run dev:server`，别在这里再起一个
      resolve();
      return;
    }
    const serverEntry = path.join(
      process.resourcesPath,
      'server',
      'main.js',
    );
    console.log(`[main] spawning sidecar: ${serverEntry}`);
    // Persist under Electron's userData (~/Library/Application Support/Maestro
    // on macOS) so state + backups survive app updates and live in a stable,
    // user-discoverable place — not next to the read-only .app bundle. Backups
    // sit alongside state.json in a `backups/` subdir.
    const userData = app.getPath('userData');
    sidecar = spawn(process.execPath, [serverEntry], {
      env: {
        ...process.env,
        // Electron 的 process.execPath 就是 node（在 packaged Electron 里
        // 也是），所以可以直接 spawn 它跑 .js。Mac 上在某些版本可能需要
        // ELECTRON_RUN_AS_NODE=1 才能当 node 用。
        ELECTRON_RUN_AS_NODE: '1',
        PORT: String(SIDECAR_PORT),
        STORAGE_DIR: path.join(userData, '.storage'),
        STORAGE_BACKUP_DIR: path.join(userData, 'backups'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    sidecar.stdout?.on('data', (b) => process.stdout.write(`[sidecar] ${b}`));
    sidecar.stderr?.on('data', (b) => process.stderr.write(`[sidecar-err] ${b}`));
    sidecar.on('error', (err) => {
      console.error('[main] sidecar spawn error:', err);
      reject(err);
    });
    sidecar.on('exit', (code) => {
      console.log(`[main] sidecar exited with code=${code}`);
      sidecar = null;
    });
    waitForSidecar(SIDECAR_PORT)
      .then(() => resolve())
      .catch(reject);
  });
}

/** 关闭 sidecar。app quit 时调。 */
function stopSidecar(): void {
  if (!sidecar) return;
  console.log('[main] killing sidecar');
  try {
    sidecar.kill('SIGTERM');
  } catch {
    // ignore
  }
  sidecar = null;
}

// ── Tray + media controls ────────────────────────────────────────────────────
//
// The tray menu drives playback by sending 'tray:command' to the renderer,
// which owns the actual player state (usePlayer). The renderer reports back its
// state via 'player:state' so the tray label/tooltip stay in sync. This keeps a
// single source of truth (no duplicate play logic in main).

let tray: Tray | null = null;

interface PlaybackState {
  isPlaying: boolean;
  title?: string;
  artist?: string;
}

let playbackState: PlaybackState = { isPlaying: false };

/** Bring the main window back from the tray (or recreate it if it was torn
 * down). Used by the tray "Show" item and by app `activate`. */
function showMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
}

/** Send a transport command to the renderer's player. */
function sendTrayCommand(command: 'playpause' | 'next' | 'prev'): void {
  mainWindow?.webContents.send('tray:command', command);
}

/** Rebuild the tray context menu + tooltip from the current playback state. */
function refreshTray(): void {
  if (!tray) return;
  const { isPlaying, title, artist } = playbackState;
  const nowPlaying = title
    ? `${title}${artist ? ` — ${artist}` : ''}`
    : '未在播放';
  const menu = Menu.buildFromTemplate([
    { label: nowPlaying, enabled: false },
    { type: 'separator' },
    {
      label: isPlaying ? '暂停' : '播放',
      click: () => sendTrayCommand('playpause'),
    },
    { label: '上一首', click: () => sendTrayCommand('prev') },
    { label: '下一首', click: () => sendTrayCommand('next') },
    { type: 'separator' },
    { label: '显示主窗口', click: () => showMainWindow() },
    {
      label: '退出 Maestro',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(title ? `Maestro · ${nowPlaying}` : 'Maestro');
}

function createTray(): void {
  if (tray) return;
  const image = nativeImage.createFromPath(assetPath('trayTemplate.png'));
  // Template image → macOS auto-inverts it for light/dark menubars.
  image.setTemplateImage(true);
  tray = new Tray(image);
  refreshTray();
}

/** The QQ Music login window (kept alive hidden after success so we could
 * proxy through its Chromium session later if QQ ever tightens anti-bot). */
let activeQqLoginWindow: BrowserWindow | null = null;

/** IPC response channel for cookie-based login (QQ Music). */
const QQ_LOGIN_CHANNEL = 'qq-login-result';

/** The NetEase login window (embedded-browser cookie capture). */
let activeNeteaseLoginWindow: BrowserWindow | null = null;

/** IPC response channel for cookie-based login (NetEase). */
const NETEASE_LOGIN_CHANNEL = 'netease-login-result';

/** Cookie polling interval for the login window (cookie 'changed' events
 * don't always fire reliably across redirects). */
const POLL_INTERVAL_MS = 1500;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    // 880×720 hits the Bento sweet spot: wide enough for cover +
    // side column to coexist at ~16:13, tall enough that the cover
    // has room to breathe and the transport row doesn't crowd
    // the progress bar. The user can still resize freely.
    width: 880,
    height: 720,
    minWidth: 640,
    minHeight: 560,
    // No maxWidth — let power users size up; UI uses responsive layout.
    titleBarStyle: 'hiddenInset',
    // macOS traffic-light buttons live in the top-left. The renderer
    // titlebar reserves a 80px safe area on the left so it doesn't
    // overlap the system buttons (or the green fullscreen button when
    // the user hovers at the very top edge).
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: '#0f0f12',
    resizable: true,
    show: false,
    // macOS uses the app-bundle .icns; Win/Linux need an explicit window icon.
    icon: process.platform === 'darwin' ? undefined : assetPath('icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      // Spotify OAuth PKCE：renderer 里 window.open(authorizeUrl) 需要在
      // Electron 内创建子 BrowserWindow 而不是跳系统浏览器——这样才能共享
      // session cookie storage，使 login 完成后的 cookie 在主窗口 poll 时可见。
      nativeWindowOpen: true,
      // Widevine DRM：Spotify WPS 需要 EME + Widevine CDM 播放全曲
      // 否则 SDK 初始化报 EMEError: No supported keysystem was found
      plugins: true,
      autoplayPolicy: 'no-user-gesture-required',
    } as Electron.WebPreferences,
  });

  if (isDev) {
    mainWindow.loadURL('http://127.0.0.1:5173');
    // Open DevTools so users can see renderer console errors (e.g. audio
    // loading failures, network issues with the Deezer preview URL).
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    const rendererPath = path.join(process.resourcesPath, 'renderer', 'index.html');
    mainWindow.loadFile(rendererPath);
  }

  // 一旦 renderer 加载完，把 sidecar URL 告诉它。renderer 用这个替换 hardcode
  // 的 localhost:3200，确保 prod 模式下 fetch 走对地方。
  if (!isDev) {
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow?.webContents.send('sidecar-ready', {
        apiBase: `http://127.0.0.1:${SIDECAR_PORT}`,
      });
    });
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // Forward renderer console messages to the main process log so they
  // appear in the same stream as the NestJS / Electron output. DevTools
  // is detached so it isn't always visible; this makes debugging audio
  // and fetch issues much easier.
  mainWindow.webContents.on(
    'console-message',
    (_e: unknown, level: number, message: string, line: number, source: string) => {
      const tag = ['DBG', 'LOG', 'WARN', 'ERR'][level] ?? 'LOG';
      console.log(`[renderer ${tag}] ${message}  (${source}:${line})`);
    },
  );

  // window.open handler: Spotify OAuth 需要 Electron 子窗口（session cookie 共享），
  // 所以 allow 所有 popup；不需要的外部链接 renderer 走 shell.openExternal API。
  mainWindow.webContents.setWindowOpenHandler(() => {
    return { action: 'allow' };
  });

  // Close-to-tray: hide the window instead of quitting so playback keeps
  // running in the background (macOS music-player convention). The app only
  // truly exits via Cmd+Q / tray "退出", which set isQuitting first.
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── QQ Music login via embedded browser ────────────────────────────────────

interface QqLoginResult {
  /** Full "k=v; k=v" cookie header captured from the QQ login window. This is
   * the REAL QQ Music login state (qm_keyst / qqmusic_key / uin …) — NOT a
   * QQ Connect OAuth token. */
  cookie: string;
  /** Normalised numeric uin (leading 'o'/zeros stripped) for musicu.fcg. */
  uin?: string;
  /** All captured cookies, for debugging / forwarding. */
  extraCookies?: Record<string, string>;
}

/** QQ / QQ-Music cookies live across several *.qq.com hosts. */
const QQ_DOMAINS = ['.qq.com', '.y.qq.com', 'y.qq.com', 'qq.com'];

/** The cookie whose appearance means "QQ Music login just completed". Newer
 * web login sets `qm_keyst`; older flows set `qqmusic_key`. Either is enough. */
const QQ_LOGIN_MARKERS = ['qm_keyst', 'qqmusic_key'];

/** uin cookie looks like `o0361503867` — strip the leading `o` and zeros so
 * musicu.fcg's `uin` param is the bare QQ number. */
function normaliseUin(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/^o/i, '').replace(/^0+/, '');
  return digits || undefined;
}

async function readQqCookies(win: BrowserWindow): Promise<{
  cookie: string;
  uin?: string;
  all: Record<string, string>;
  hasMarker: boolean;
}> {
  const all: Record<string, string> = {};
  const seen = new Set<string>();
  for (const domain of QQ_DOMAINS) {
    let cookies;
    try {
      cookies = await win.webContents.session.cookies.get({ domain });
    } catch {
      continue;
    }
    for (const c of cookies) {
      if (!c.name || seen.has(c.name)) continue;
      seen.add(c.name);
      if (c.expirationDate && c.expirationDate * 1000 < Date.now()) continue;
      all[c.name] = c.value;
    }
  }
  const cookie = Object.entries(all)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
  const uin = normaliseUin(all['uin'] ?? all['wxuin'] ?? all['p_uin']);
  const hasMarker = QQ_LOGIN_MARKERS.some((m) => Boolean(all[m]));
  return { cookie, uin, all, hasMarker };
}

/**
 * Open a child window on y.qq.com, let the user log into QQ Music, and resolve
 * once the login-marker cookie (qm_keyst / qqmusic_key) appears. We keep the
 * window hidden-alive afterwards so its Chromium session could later proxy
 * requests if QQ ever tightens anti-bot.
 *
 * Unlike QQ Connect OAuth, this needs NO appid/secret and NO registered app —
 * we just capture the browser's own login cookies.
 */
function openQqLoginWindow(): Promise<QqLoginResult> {
  return new Promise((resolve, reject) => {
    if (activeQqLoginWindow && !activeQqLoginWindow.isDestroyed()) {
      activeQqLoginWindow.show();
      activeQqLoginWindow.focus();
      return;
    }

    const loginWin = new BrowserWindow({
      width: 1000,
      height: 760,
      minWidth: 720,
      minHeight: 540,
      title: '登录 QQ 音乐',
      parent: mainWindow ?? undefined,
      modal: false,
      backgroundColor: '#ffffff',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });
    activeQqLoginWindow = loginWin;

    // QQ's login panel sometimes opens a popup (ptlogin / graph). Allow child
    // windows so the flow can complete inside Electron rather than the OS
    // browser. They share this window's session, so cookies land on it.
    loginWin.webContents.setWindowOpenHandler(() => ({ action: 'allow' }));

    loginWin.loadURL('https://y.qq.com/');

    let resolved = false;
    let pollTimer: NodeJS.Timeout | null = null;

    const stop = (): void => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    const finish = (result: QqLoginResult): void => {
      if (resolved) return;
      resolved = true;
      stop();
      console.log(
        `[qq-login] captured ${
          Object.keys(result.extraCookies ?? {}).length
        } cookies, uin=${result.uin ?? '?'}, keys=[${Object.keys(
          result.extraCookies ?? {},
        ).join(',')}]`,
      );
      if (!loginWin.isDestroyed()) loginWin.hide();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(QQ_LOGIN_CHANNEL, result);
      }
      resolve(result);
    };

    const fail = (err: Error): void => {
      if (resolved) return;
      resolved = true;
      stop();
      if (!loginWin.isDestroyed()) loginWin.close();
      if (activeQqLoginWindow === loginWin) activeQqLoginWindow = null;
      reject(err);
    };

    const tryCapture = async (): Promise<void> => {
      if (resolved || loginWin.isDestroyed()) return;
      try {
        const { cookie, uin, all, hasMarker } = await readQqCookies(loginWin);
        if (hasMarker) {
          finish({ cookie, uin, extraCookies: all });
        }
      } catch {
        // ignore — next tick retries
      }
    };

    const cookieListener = (
      _event: unknown,
      cookie: Electron.Cookie,
      _cause: string,
      removed: boolean,
    ): void => {
      if (removed) return;
      if (!(cookie.domain ?? '').includes('qq.com')) return;
      if (QQ_LOGIN_MARKERS.includes(cookie.name) && cookie.value) {
        void tryCapture();
      }
    };
    loginWin.webContents.session.cookies.on('changed', cookieListener);

    // Polling fallback — cookie 'changed' can miss updates after redirects.
    pollTimer = setInterval(() => void tryCapture(), POLL_INTERVAL_MS);

    loginWin.on('closed', () => {
      if (activeQqLoginWindow === loginWin) activeQqLoginWindow = null;
      if (!resolved) fail(new Error('login_cancelled'));
    });
  });
}

// ── NetEase login via embedded browser ─────────────────────────────────────
//
// NetEase risk control (QR-check code 8821) rejects server-side login polling:
// it accepts the phone scan but refuses to hand a login cookie to an untrusted
// server caller. The reliable desktop path is to let the user sign in inside a
// real Chromium window and capture MUSIC_U from its session — same shape as the
// QQ flow above.

interface NeteaseLoginResult {
  musicU: string;
  csrfToken?: string;
  /** All captured NetEase cookies, forwarded for parity with a real browser. */
  extraCookies?: Record<string, string>;
}

/** NetEase login cookies live on the music.163.com hosts. */
const NETEASE_DOMAINS = ['.music.163.com', 'music.163.com'];

/** A logged-out MUSIC_U placeholder is short; a real one is long. Wait for a
 * value that's clearly the post-login cookie. */
const MIN_MUSIC_U_LENGTH = 30;

async function readNeteaseCookies(win: BrowserWindow): Promise<{
  musicU?: string;
  csrf?: string;
  all: Record<string, string>;
}> {
  const all: Record<string, string> = {};
  let musicU: string | undefined;
  let csrf: string | undefined;
  const seen = new Set<string>();
  for (const domain of NETEASE_DOMAINS) {
    let cookies;
    try {
      cookies = await win.webContents.session.cookies.get({ domain });
    } catch {
      continue;
    }
    for (const c of cookies) {
      if (!c.name || seen.has(c.name)) continue;
      seen.add(c.name);
      if (c.expirationDate && c.expirationDate * 1000 < Date.now()) continue;
      all[c.name] = c.value;
      if (c.name === 'MUSIC_U' && c.value.length >= MIN_MUSIC_U_LENGTH) {
        musicU = c.value;
      }
      if (c.name === '__csrf') csrf = c.value;
    }
  }
  return { musicU, csrf, all };
}

/**
 * Open a child window on music.163.com/login, let the user sign in (the
 * NetEase page's own QR, phone, or password — all in a real browser NetEase
 * trusts), and resolve once MUSIC_U appears in the window's session cookies.
 */
function openNeteaseLoginWindow(): Promise<NeteaseLoginResult> {
  return new Promise((resolve, reject) => {
    if (activeNeteaseLoginWindow && !activeNeteaseLoginWindow.isDestroyed()) {
      activeNeteaseLoginWindow.show();
      activeNeteaseLoginWindow.focus();
      return;
    }

    const loginWin = new BrowserWindow({
      width: 1000,
      height: 760,
      minWidth: 720,
      minHeight: 540,
      title: '登录网易云音乐',
      parent: mainWindow ?? undefined,
      modal: false,
      backgroundColor: '#ffffff',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });
    activeNeteaseLoginWindow = loginWin;

    loginWin.webContents.setWindowOpenHandler(() => ({ action: 'allow' }));
    loginWin.loadURL('https://music.163.com/login');

    let resolved = false;
    let pollTimer: NodeJS.Timeout | null = null;

    const stop = (): void => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    const finish = (result: NeteaseLoginResult): void => {
      if (resolved) return;
      resolved = true;
      stop();
      console.log(
        `[netease-login] captured MUSIC_U (len=${result.musicU.length}), ${
          Object.keys(result.extraCookies ?? {}).length
        } cookies`,
      );
      if (!loginWin.isDestroyed()) loginWin.hide();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(NETEASE_LOGIN_CHANNEL, result);
      }
      resolve(result);
    };

    const fail = (err: Error): void => {
      if (resolved) return;
      resolved = true;
      stop();
      if (!loginWin.isDestroyed()) loginWin.close();
      if (activeNeteaseLoginWindow === loginWin) activeNeteaseLoginWindow = null;
      reject(err);
    };

    const tryCapture = async (): Promise<void> => {
      if (resolved || loginWin.isDestroyed()) return;
      try {
        const { musicU, csrf, all } = await readNeteaseCookies(loginWin);
        if (musicU) finish({ musicU, csrfToken: csrf, extraCookies: all });
      } catch {
        // ignore — next tick retries
      }
    };

    const cookieListener = (
      _event: unknown,
      cookie: Electron.Cookie,
      _cause: string,
      removed: boolean,
    ): void => {
      if (removed) return;
      if (!(cookie.domain ?? '').includes('163.com')) return;
      if (cookie.name === 'MUSIC_U' && cookie.value.length >= MIN_MUSIC_U_LENGTH) {
        void tryCapture();
      }
    };
    loginWin.webContents.session.cookies.on('changed', cookieListener);

    // Polling fallback — cookie 'changed' can miss updates after redirects.
    pollTimer = setInterval(() => void tryCapture(), POLL_INTERVAL_MS);

    loginWin.on('closed', () => {
      if (activeNeteaseLoginWindow === loginWin) activeNeteaseLoginWindow = null;
      if (!resolved) fail(new Error('login_cancelled'));
    });
  });
}

// ── IPC wiring ──────────────────────────────────────────────────────────────

ipcMain.handle('qq:login', async () => {
  try {
    const result = await openQqLoginWindow();
    return { success: true, ...result };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('netease:login', async () => {
  try {
    const result = await openNeteaseLoginWindow();
    return { success: true, ...result };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

/**
 * Open URL in the OS default browser (Spotify OAuth authorizeUrl, etc.).
 * Renderer hands the URL through main rather than calling shell.openExternal
 * directly because Electron's renderer-side window.open has different
 * semantics across platforms.
 */
ipcMain.handle('shell:open-external', async (_event, url: string) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    throw new Error('openExternal: only http(s) URLs are allowed');
  }
  await shell.openExternal(url);
});

/** Renderer → main: current playback state, so the tray label/tooltip reflect
 * what's actually playing. Fire-and-forget (ipcRenderer.send). */
ipcMain.on('player:state', (_event, state: PlaybackState) => {
  playbackState = {
    isPlaying: Boolean(state?.isPlaying),
    title: state?.title,
    artist: state?.artist,
  };
  refreshTray();
});

// ── App lifecycle ───────────────────────────────────────────────────────────

// 强制 Chromium 启用 EME + Widevine 组件。即使没外部 CDM，这个 flag 让
// Chromium 自身尝试加载系统级别的 Widevine（如果 macOS 有的话）。
app.commandLine.appendSwitch('enable-features', 'EncryptedMedia');

// Spotify OAuth：注册 maestro:// 自定义协议，回调时 macOS / Windows 调起 app
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('maestro', process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  }
} else {
  app.setAsDefaultProtocolClient('maestro');
}

// 协议 URL 回调：OS 把 maestro://spotify-callback?code=...&state=... 递进来
app.on('open-url', (event, url) => {
  event.preventDefault();
  console.log('[main] open-url:', url);
  try {
    // Spotify 回跳的 redirect_uri 常常带一个尾斜杠：
    //   maestro://spotify-callback/?code=...   （有 /）
    // 而 Dashboard 里注册的是  maestro://spotify-callback （无 /）
    // → URL 解析不受影响（searchParams 不受路径影响），但 log 要精准
    const normalized = url.replace(/\/\?/, '?');
    const parsed = new URL(normalized);
    const code = parsed.searchParams.get('code');
    const state = parsed.searchParams.get('state');
    console.log('[main] parsed code:', code, 'state:', state);
    if (!code || !state) {
      console.error('[main] open-url 缺 code 或 state，忽略');
      return;
    }
    if (!mainWindow || mainWindow.isDestroyed()) {
      console.error('[main] mainWindow 尚未就绪，延迟 1s 再试');
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          console.log('[main] 延迟推送 spotify:oauth-protocol');
          mainWindow.webContents.send('spotify:oauth-protocol', { code, state });
        }
      }, 1000);
      return;
    }
    console.log('[main] IPC send spotify:oauth-protocol');
    mainWindow.webContents.send('spotify:oauth-protocol', { code, state });
  } catch (err) {
    console.error('[main] open-url parse failed:', err);
  }
});

app.whenReady().then(async () => {
  // 1. 启动 sidecar（prod 模式才有），等它就绪
  try {
    await startSidecar();
  } catch (err) {
    console.error('[main] failed to start sidecar:', err);
    // 不阻塞窗口打开——前端能展示一个错误面板，比黑屏好
  }

  // 2. 打开主窗口
  createWindow();

  // 3. 托盘常驻 + 自定义 Dock 图标（dev 也生效，方便验证图标）
  createTray();
  if (process.platform === 'darwin') {
    try {
      app.dock?.setIcon(nativeImage.createFromPath(assetPath('icon.png')));
    } catch (err) {
      console.warn('[main] dock.setIcon failed:', err);
    }
  }

  app.on('activate', () => {
    // Clicking the Dock icon re-shows the (possibly hidden) window.
    showMainWindow();
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  stopSidecar();
});

app.on('window-all-closed', () => {
  stopSidecar();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
