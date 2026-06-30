# QQ FM Player

A minimal, elegant music player for macOS — inspired by Douban FM.

Built with **Electron + React + NestJS**.

## Features

- **Real QQ Music radio integration** via y.qq.com web APIs (radio station
  playlist + `GetVkey` for stream URLs)
- **Real NetEase Cloud Music support** via cookie-based session — log in by
  scanning a QR code with the NetEase app
- **Server-side audio proxy** — the browser never holds raw upstream URLs,
  so signing/expiry is handled at request time
- **Persistent sessions & liked tracks** to local JSON storage
- Like / dislike / skip / radio-style playback
- Clean, distraction-free interface

## Architecture

```
┌────────────────────────────────────────────────────────┐
│  Renderer (React + Vite, port 5173)                    │
│   - Talks to /api/* (Vite proxies to NestJS)           │
│   - <audio> src = /api/music/stream/{provider}/{id}    │
└────────────────────────────┬───────────────────────────┘
                             │ HTTP (cookie auth)
┌────────────────────────────▼───────────────────────────┐
│  NestJS server (port 3200)                             │
│   - Cookie-parser sessions stored in .storage/state.json│
│   - Auth: QQ OAuth + NetEase QR polling                │
│   - Music: per-provider strategy + 302 audio redirect  │
└────────────────────────────┬───────────────────────────┘
                             │ HTTPS (with provider cookies)
            ┌────────────────┴───────────────┐
            ▼                                ▼
   y.qq.com web API              music.163.com weapi
```

## Project Structure

```
packages/
  electron/   — Electron main process (window management)
  renderer/   — React frontend (UI)
  server/     — NestJS backend
    src/
      common/    — ConfigService, StorageService, SessionService
      auth/      — AuthController + strategies
        qq.strategy.ts        (real OAuth code exchange)
        netease-qr.strategy.ts (QR login + polling)
      music/     — MusicController + providers
        qq.provider.ts        (radio + GetVkey)
        netease.provider.ts   (personal FM + enhance/player/url)
        netease-crypto.ts     (weapi AES + RSA)
```

## Setup

```bash
# Install dependencies (uses npm workspaces)
npm install

# Copy environment template
cp .env.example .env
# Edit .env — see "Environment" section below
```

## Environment

All variables are optional in dev except the QQ ones (only if you want to
log in to QQ Music). The server falls back to sensible defaults.

| Var | Required | Default | Notes |
|---|---|---|---|
| `PORT` | – | `3200` | NestJS port |
| `RENDERER_BASE` | – | `http://localhost:5173` | Where to redirect after OAuth |
| `RENDERER_ORIGINS` | – | `http://localhost:5173,...` | CORS allowlist |
| `SESSION_SECRET` | prod | dev placeholder | Cookie signing key |
| `STORAGE_DIR` | – | `.storage` | Where `state.json` lives |
| `QQ_APP_ID` | for QQ login | – | From connect.qq.com |
| `QQ_APP_SECRET` | for QQ login | – | From connect.qq.com |
| `QQ_REDIRECT_URI` | for QQ login | `http://localhost:3200/auth/qq/callback` | Must match connect.qq.com exactly |
| `NETEASE_QR_POLL_MS` | – | `1500` | QR check interval |

## QQ Music OAuth setup

1. Register an app at <https://connect.qq.com/>
2. Set the callback URL to **`http://localhost:3200/auth/qq/callback`**
   (no query parameters — QQ compares the string byte-for-byte)
3. Fill in `QQ_APP_ID` / `QQ_APP_SECRET` in `.env`
4. In the app, choose "QQ 音乐" → click "登录"

> If you're already a developer under another company, that does NOT block
> you from being an *end user* of a different app. For developing under
> your own identity, either (a) ask the existing app's admin to grant you
> access to its AppID, or (b) register a separate developer account using
> a different QQ and create your own app.

## NetEase Cloud Music setup

1. No app registration needed — NetEase has no public OAuth/SDK
2. In the app, choose "网易云音乐" → click "扫码登录"
3. Open the NetEase Cloud Music app on your phone, scan the QR code
4. Confirm on your phone; the desktop session is established automatically

The server holds the `MUSIC_U` cookie in its session store. It expires
(~30 days); when calls start returning 301, just scan again.

## Development

```bash
npm run dev
# = concurrently:
#   - nest start --watch (server on :3200)
#   - vite                        (renderer on :5173)
#   - electron                    (after 3s, opens the window)
```

The Electron window loads `http://localhost:5173`. The Vite dev server
proxies `/api/*` to the NestJS backend on `:3200`. Set the cookie once and
both APIs see it.

## Build for Production

```bash
npm run build
cd packages/electron && npm run pack
```

The Electron `main.ts` loads `process.resourcesPath/renderer/index.html`.
You'll also need to bundle the NestJS server alongside (e.g. as a
sidecar) — current packaging doesn't handle this. See
`docs/production.md` once you add it.

## Known limits (P0 done, P1/P2 deferred)

- QQ Music APIs are reverse-engineered from web endpoints. If `y.qq.com`
  changes its musicu.fcg payload shape, the radio may stop loading.
- Cover art is not yet fetched for QQ tracks (QQ exposes
  `https://y.gtimg.cn/music/photo_new/T002R300x300M000{mid}.jpg`).
- Liked-track listing returns IDs only; full metadata requires a follow-up
  fetch per ID.
- No desktop tray icon, no global media keys, no lyrics (P2).

## License

MIT