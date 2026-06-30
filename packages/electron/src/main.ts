import {
  app,
  BrowserWindow,
  shell,
  ipcMain,
} from 'electron';
import * as path from 'path';
import * as http from 'http';

const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;

/** When a login flow is in progress, the BrowserWindow we opened for it. */
let activeLoginWindow: BrowserWindow | null = null;

/** IPC response channel for cookie-based login (NetEase). */
const NETEASE_LOGIN_CHANNEL = 'netease-login-result';

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 400,
    height: 600,
    minWidth: 360,
    minHeight: 520,
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
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    // Open DevTools so users can see renderer console errors (e.g. audio
    // loading failures, network issues with the Deezer preview URL).
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    const rendererPath = path.join(process.resourcesPath, 'renderer', 'index.html');
    mainWindow.loadFile(rendererPath);
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

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // QQ OAuth callback comes through here when launched in default browser;
    // the user can still choose to log in there. We keep the policy of
    // opening external links externally.
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── NetEase login via embedded browser ─────────────────────────────────────

interface NeteaseLoginResult {
  musicU: string;
  csrfToken?: string;
  /** All NetEase cookies from the login window — we forward them as-is so
   * the backend's weapi calls look identical to a real browser request. */
  extraCookies?: Record<string, string>;
}

const POLL_INTERVAL_MS = 1500;
/** MUSIC_U before login is a tracking placeholder (~16 hex chars); real ones
 * are longer and have a distinct shape. We just wait for `value.length > 30`
 * to be safe. */
const MIN_MUSIC_U_LENGTH = 30;

const NETEASE_DOMAINS = ['.music.163.com', 'music.163.com'];

async function readNeteaseCookies(win: BrowserWindow): Promise<{
  musicU?: string;
  csrf?: string;
  all: Record<string, string>;
}> {
  const all: Record<string, string> = {};
  let musicU: string | undefined;
  let csrf: string | undefined;

  // 抓所有 NetEase 相关域名的 cookie
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
      // 跳过 expired cookie（expirationDate === -1 表示 session cookie）
      if (c.expirationDate && c.expirationDate * 1000 < Date.now()) continue;
      all[c.name] = c.value;
      if (c.name === 'MUSIC_U' && c.value.length >= MIN_MUSIC_U_LENGTH) {
        musicU = c.value;
      }
      if (c.name === '__csrf') {
        csrf = c.value;
      }
    }
  }

  return { musicU, csrf, all };
}

/**
 * Open a child window that loads music.163.com, watch for MUSIC_U cookie
 * to appear, resolve with it, and **keep the window alive (hidden)** so its
 * Chromium session can later proxy weapi calls.
 *
 * NetEase's QR / phone / email login all set MUSIC_U on success — by loading
 * the site in a real browser, we get the cookie transparently, no manual
 * paste required.
 *
 * The persistent window is critical: NetEase's anti-bot fingerprinting sees
 * through Node's fetch (different TLS / TCP / HTTP2 stack). Only requests
 * originating from a real Chromium instance get past it.
 */
function openNeteaseLoginWindow(): Promise<NeteaseLoginResult> {
  return new Promise((resolve, reject) => {
    if (activeLoginWindow && !activeLoginWindow.isDestroyed()) {
      activeLoginWindow.show();
      activeLoginWindow.focus();
      return;
    }

    const loginWin = new BrowserWindow({
      width: 960,
      height: 720,
      minWidth: 720,
      minHeight: 540,
      title: '登录网易云音乐',
      parent: mainWindow ?? undefined,
      modal: false,
      backgroundColor: '#ffffff',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        // No preload = no JS injection. We only read cookies via Electron API.
      },
    });
    activeLoginWindow = loginWin;

    loginWin.loadURL('https://music.163.com/login');

    // (We previously injected a page-context weapi client here, but
    // NetEase's anti-bot now also rejects page-context fetches with
    // 200 + empty body. We do all weapi from the main process now —
    // see proxyFetch below.)

    let resolved = false;
    let pollTimer: NodeJS.Timeout | null = null;

    const stopWatching = (): void => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      // Note: we keep the cookie listener registered so re-login within the
      // same window re-triggers detection.
    };

    const finish = (result: NeteaseLoginResult): void => {
      if (resolved) return;
      resolved = true;
      stopWatching();
      // Hide but don't destroy — the window's session is the proxy we use for
      // weapi calls. Re-show it if user logs out and back in.
      if (!loginWin.isDestroyed()) loginWin.hide();
      // Notify any listener on the renderer side
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(NETEASE_LOGIN_CHANNEL, result);
      }
      resolve(result);
    };

    const fail = (err: Error): void => {
      if (resolved) return;
      resolved = true;
      stopWatching();
      if (!loginWin.isDestroyed()) loginWin.close();
      if (activeLoginWindow === loginWin) activeLoginWindow = null;
      reject(err);
    };

    // Watch cookie changes — fires every time a cookie is set/updated/removed
    // on this window's session, regardless of origin. Filter to NetEase.
    const cookieListener = (
      _event: unknown,
      cookie: Electron.Cookie,
      _cause: string,
      removed: boolean,
    ): void => {
      if (removed) return;
      const domain = cookie.domain ?? '';
      if (!domain.includes('163.com') && !domain.includes('music.126.net')) {
        return;
      }
      // Only act on MUSIC_U updates — that's the strongest signal that login
      // just completed.
      if (cookie.name === 'MUSIC_U' && cookie.value.length >= MIN_MUSIC_U_LENGTH) {
        readNeteaseCookies(loginWin).then(({ musicU, csrf, all }) => {
          if (musicU) {
            finish({
              musicU,
              csrfToken: csrf,
              extraCookies: all,
            });
          }
        });
      }
    };

    loginWin.webContents.session.cookies.on('changed', cookieListener);

    // Polling fallback (cookie 'changed' doesn't always fire reliably across
    // all Electron versions, especially after redirects). Keep this short.
    pollTimer = setInterval(async () => {
      if (resolved || loginWin.isDestroyed()) return;
      try {
        const { musicU, csrf, all } = await readNeteaseCookies(loginWin);
        if (musicU) {
          finish({ musicU, csrfToken: csrf, extraCookies: all });
        }
      } catch {
        // ignore — next tick will retry
      }
    }, POLL_INTERVAL_MS);

    loginWin.on('closed', () => {
      if (activeLoginWindow === loginWin) activeLoginWindow = null;
      if (!resolved) fail(new Error('login_cancelled'));
    });
  });
}

// ── Internal HTTP proxy (NestJS → Electron → NetEase) ──────────────────────

interface ProxyRequest {
  url: string;
  /** Raw weapi payload (will be encrypted inside the page). */
  payload?: Record<string, unknown>;
  /** CSRF token for endpoints that require it (radio/like/player/url). */
  csrfToken?: string;
}

interface ProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

let proxyServer: http.Server | null = null;
let proxyPort: number | null = null;

/** Fixed port so the NestJS server can find us without configuration.
 * Override with ELECTRON_PROXY_PORT env var if it conflicts. */
const PROXY_PORT = Number(process.env.ELECTRON_PROXY_PORT ?? 3300);

/**
 * Use the persistent login window's session to fetch a URL. Goes through
 * Chromium's full network stack, so NetEase's anti-bot fingerprinting sees
 * a real browser request.
 *
 * Implementation note: we run the fetch via `executeJavaScript()` so the
 * request originates from the page's own JS context. This matters because
 * NetEase's anti-bot doesn't only look at TLS/TCP fingerprint — it also
 * checks whether the request looks like it came from page JS. Running
 * `session.fetch()` from the main process still uses the real network stack
 * but NetEase detects the request origin and returns empty body. A
 * `window.fetch()` from inside the page passes.
 *
 * The page must be loaded on a NetEase origin (we navigate it to
 * music.163.com after login succeeds if it isn't there yet).
 */
async function proxyFetch(req: ProxyRequest): Promise<ProxyResponse> {
  if (!activeLoginWindow || activeLoginWindow.isDestroyed()) {
    throw new Error('netease window not open — login first');
  }

  // NetEase's anti-bot rejects page-context fetches with 200 + empty body
  // (it can detect JS-context calls that don't look exactly like a real
  // browser). The reliable path is `session.fetch()` from the main
  // process — it uses Chromium's network stack (so TCP/TLS/HTTP2 match a
  // real browser) but doesn't go through page JavaScript.
  //
  // Encryption is done in the main process using Node's crypto. We import
  // the shared module from the server package.
  const { encryptWeApi } = require('../../server/dist/music/netease-crypto.js') as {
    encryptWeApi: (json: Record<string, unknown>) => { params: string; encSecKey: string };
  };

  const { params, encSecKey } = encryptWeApi(req.payload ?? {});
  const body = `params=${encodeURIComponent(params)}&encSecKey=${encodeURIComponent(encSecKey)}`;

  const sep = req.url.includes('?') ? '&' : '?';
  const finalUrl = req.csrfToken
    ? `${req.url}${sep}csrf_token=${encodeURIComponent(req.csrfToken)}`
    : req.url;

  const session = activeLoginWindow.webContents.session;
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Referer: 'https://music.163.com/',
    Origin: 'https://music.163.com',
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    // A mainland-China IP makes NetEase treat the request as a domestic
    // client, which avoids the "you appear to be overseas" branch that
    // returns empty bodies. (Public IP from the NetEaseCloudMusicApi
    // README; it's a NetEase-owned IP that they whitelist.)
    'X-Real-IP': '211.161.244.70',
  };

  // The login window's session has the user's MUSIC_U cookie. session.fetch
  // sends those cookies automatically.
  const res = await session.fetch(finalUrl, {
    method: 'POST',
    headers,
    body,
  });
  const text = await res.text();
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    body: text,
  };
}

function startProxyServer(): Promise<number> {
  if (proxyServer && proxyPort) return Promise.resolve(proxyPort);
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      // CORS: the only client is the local NestJS dev server
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.url === '/internal/ping') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, port: proxyPort }));
        return;
      }

      if (req.url === '/internal/netease-fetch' && req.method === 'POST') {
        let raw = '';
        req.on('data', (chunk) => (raw += chunk));
        req.on('end', async () => {
          try {
            const payload = JSON.parse(raw) as ProxyRequest;
            const result = await proxyFetch(payload);
            res.writeHead(result.status, {
              'Content-Type': result.headers['content-type'] ?? 'application/json',
            });
            res.end(result.body);
          } catch (err) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                error: 'proxy_failed',
                message: (err as Error).message,
              }),
            );
          }
        });
        return;
      }

      res.writeHead(404);
      res.end('not found');
    });
    srv.listen(PROXY_PORT, '127.0.0.1', () => {
      proxyServer = srv;
      proxyPort = PROXY_PORT;
      console.log(`[electron] internal proxy listening on :${PROXY_PORT}`);
      resolve(PROXY_PORT);
    });
    srv.on('error', (err) => {
      console.error(`[electron] proxy failed to bind :${PROXY_PORT}:`, err.message);
      reject(err);
    });
  });
}

// ── IPC wiring ──────────────────────────────────────────────────────────────

ipcMain.handle('netease:login', async () => {
  try {
    const result = await openNeteaseLoginWindow();
    return { success: true, ...result };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('netease:proxy-port', async () => {
  const port = await startProxyServer();
  return port;
});

// ── App lifecycle ───────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow();
  // Start the internal proxy early so NestJS can ping and discover the port.
  startProxyServer().catch((err) => {
    console.error('[electron] failed to start proxy:', err);
  });

  app.on('activate', () => {
    if (mainWindow === null) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});