# Maestro

**English** · [简体中文](./README.zh-CN.md) · [日本語](./README.ja.md)

> Your cross-platform music brain. Log into NetEase Cloud Music, QQ Music,
> Spotify and Deezer, pull your **liked ("hearted") songs** from every
> platform, let a large language model (**DeepSeek**, using *your own* API
> key) recommend what to fall in love with next — and when you heart a
> track, heart it **everywhere it's licensed**, so "sorry, unavailable in
> your region / no rights" never stops the music again.

Built with **Electron + React + NestJS** as a desktop-first client.

> 🟢 **Phase 0–5 done; Phase 6 (frontend refactor + packaging) shipping.**
> All four platform adapters, the unified search, the cross-platform
> match engine, the importable unified library, DeepSeek recommendations,
> heart fan-out, and the visionOS-style Bento glass UI are working today
> in dev. The remaining work — production packaging, Spotify play/heart
> write, and a few UX polish items — is in the
> [next-iteration plan](./NEXT-ITERATION.md).

---

## The idea

Streaming platforms each hold a slice of your taste and a slice of the
world's catalogue — and neither slice is complete. A song you love on QQ
Music is missing from NetEase; a Spotify recommendation has no rights in
your region. Maestro treats all four platforms as **one library you own**:

```
   ┌── Connect ──────────────────────────────────────────────┐
   │  NetEase · QQ Music · Spotify · Deezer                   │
   └───────────────┬─────────────────────────────────────────┘
                   │  pull "liked / hearted" songs from each
                   ▼
   ┌── Aggregate ────────────────────────────────────────────┐
   │  one unified, de-duplicated library of what you love     │
   └───────────────┬─────────────────────────────────────────┘
                   │  send to DeepSeek (your API key)
                   ▼
   ┌── Recommend ────────────────────────────────────────────┐
   │  the LLM proposes the next songs you might love          │
   └───────────────┬─────────────────────────────────────────┘
                   │  you press ❤
                   ▼
   ┌── Heart everywhere ─────────────────────────────────────┐
   │  add the ❤ on every platform that has the rights         │
   └───────────────┬─────────────────────────────────────────┘
                   │  play
                   ▼
   ┌── Never hit a dead end ─────────────────────────────────┐
   │  search all platforms at once; play from whichever one   │
   │  actually holds the license → no "unavailable" gaps      │
   └─────────────────────────────────────────────────────────┘
```

### Design principles

- **Desktop client first.** All credentials and your DeepSeek API key live
  locally on your machine — nothing is sent to a Maestro server (there
  isn't one).
- **You own the aggregation.** Your liked songs from all platforms become a
  single library that only you hold.
- **Bring your own AI key.** Recommendations run through DeepSeek with a key
  you supply; you control the cost and the data.
- **Copyright-aware everywhere.** A ❤ fans out only to platforms that hold
  the rights; playback and search silently fall back to whichever platform
  can actually serve the track.

---

## Status & progress

Legend: ✅ done · 🚧 partial / in progress · 📋 planned

### Per-platform capabilities

| Capability                         | NetEase | QQ Music | Spotify | Deezer |
| ---------------------------------- | :-----: | :------: | :-----: | :----: |
| Log in                             | ✅ QR scan | ✅ cookie (embedded window) | ✅ OAuth PKCE | ✅ anonymous |
| Play full track                    | ✅ | ✅ (std / 320 / lossless) | 🚧 30s preview | 🚧 30s preview |
| Radio / station feed               | ✅ private FM | 🚧 keyword-seeded pseudo-radio | 🚧 short preview | ✅ editorial charts |
| Search                             | ✅ | ✅ | 🚧 limited | ✅ |
| Local like / dislike               | ✅ | ✅ | ✅ | ✅ |
| Sync ❤ back to the platform        | ✅ | ✅ | 📋 | ✅ |
| Import your existing liked songs   | ✅ | ✅ | ✅ | ✅ |

### Cross-cutting product features

| Feature | Status |
| --- | :---: |
| Multi-source player shell (Electron / React / Nest) | ✅ |
| Per-platform login & session persistence | ✅ |
| Server-side audio proxy (URLs never reach the UI) | ✅ |
| **VisionOS-style Bento glass UI** (cover-driven accent, bass-reactive breathing, lyrics panel) | ✅ |
| Light / dark / system theme | ✅ |
| **Unified multi-source search & playback fallback** | ✅ |
| **Cross-platform track matching** (ISRC + fuzzy title/artist/duration) | ✅ |
| **Unified liked-songs library** (import + de-dup) | ✅ |
| **DeepSeek BYO-key AI recommendations** | ✅ |
| **Heart fan-out to all licensed platforms** | ✅ |
| **Spotify adapter** (OAuth PKCE + read) | ✅ |
| Frontend architecture: CSS/tsx 解耦 + SCSS 7-1 + 拆巨石 | ✅ (PR #13) |
| **Production packaging** (NestJS sidecar + prod API base) | 🚧 in progress |
| Spotify full-track play + ❤ write | 📋 |

**Rough completion: ~85%.** The defining product features (unified search,
match engine, library, DeepSeek recommendations, heart fan-out) all work
end-to-end. What's left is the production-packaging story and a small
number of platform parity items — see [NEXT-ITERATION.md](./NEXT-ITERATION.md).

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Renderer (React + Vite, :5173)                              │
│   - Vite-dev proxies /api/*, /music/*, /auth/*, /reco/*      │
│   - <audio> src = /music/stream/{provider}/{id}             │
│   - Cover-art colour extraction, theming, source switcher    │
│                                                              │
│   src/                                                       │
│     App.tsx        thin composition layer                    │
│     hooks/         8 focused hooks (player owns the audio core)│
│     components/    19 components across 6 groups            │
│     lib/           format · storage · coverColor             │
│     styles/        SCSS 7-1 (abstracts / base / components) │
│                    — single main.scss, zero style imports   │
│                      in tsx                                   │
└───────────────────────────────┬──────────────────────────────┘
                                │ HTTP (cookie session)
┌───────────────────────────────▼──────────────────────────────┐
│  NestJS server (:3200)                                        │
│   common/   ConfigService · StorageService · SessionService  │
│   auth/     QQ cookie + NetEase QR + Spotify OAuth-PKCE      │
│   music/    per-provider strategy + audio proxy + cover proxy│
│   library/  import + unified library (read / write)          │
│   match/    cross-platform track resolution (ISRC + fuzzy)   │
│   reco/     DeepSeek BYO-key recommendations                 │
│   like/     fan-out ❤ across licensed platforms              │
│                                                              │
│   All providers implement a common MusicProvider interface    │
│   (common/provider.ts) and live in music/<name>.provider.ts  │
└───────────────────────────────┬──────────────────────────────┘
                                │ HTTPS (with per-platform creds)
       ┌──────────────┬─────────┴──────────┬──────────────┐
       ▼              ▼                     ▼              ▼
  music.163.com   y.qq.com            Spotify Web API  api.deezer.com
  (weapi AES/RSA)  (search + GetVkey)  (OAuth PKCE)   (public API)
```

The **Electron main process** additionally hosts an embedded login window
(to capture the QQ Music login cookie via a real Chromium session), an
embedded NetEase login window (NetEase risk control rejects server-side
QR polling), and the packaged-build sidecar management (WIP). Sessions
and liked/disliked state persist to `packages/server/.storage/state.json`
(git-ignored).

---

## Project structure

```
packages/
  electron/   Electron main process
              src/main.ts, src/preload.ts, src/recorder.ts
  renderer/   React front-end (UI, player, source switcher, search)
              src/
                App.tsx                  composition layer
                main.tsx                 entry
                api.ts                   data layer
                hooks/                   8 hooks (usePlayer owns the audio core)
                components/              19 components
                  common/   Modal · ErrorPanel
                  layout/   Titlebar · SourceMenu · QualityMenu · DeezerPresetSelect
                  player/   CoverCard · NowPlayingCard · LyricsCard · LyricsPanel
                            ProgressBar · VolumeControl · VolumeIcon · TransportBar
                  search/   SearchPanel · SourceChip
                  modals/   NeteaseCookieModal · RecoKeyModal
                  source-select/SourceSelect
                lib/         format · storage · coverColor
                styles/      main.scss + 7-1 partials
  server/     NestJS back-end
              src/
                common/   config · storage · session · provider registry · timeout
                auth/     auth controller + QQ / NetEase / Spotify strategies
                music/    music controller + 4 providers + audio / cover proxy
                          + netease-crypto (weapi AES/RSA)
                library/  liked-songs import + unified library
                match/    cross-platform track resolution
                reco/     DeepSeek recommendation engine
                like/     heart fan-out
specs/        Phase-level spec files (one per P0–P5 + packaging)
              + tasks.md under each
.env.example  Dev env vars (all optional, sensible defaults)
```

---

## Setup

```bash
# Requires Node 18+ (Node 22 recommended). Uses npm workspaces.
npm install

cp .env.example .env    # optional — every var has a sane dev default
```

## Development

```bash
npm run dev
# concurrently:
#   nest start --watch   → server on :3200
#   vite                 → renderer on :5173
#   electron             → opens the window after 3s
```

The Vite dev server proxies `/api/*` (with the `/api` prefix stripped),
`/music/*`, `/auth/*` and `/reco/*` to NestJS on `:3200`, so the whole app
is same-origin in dev and one session cookie is shared.

## Environment

Every variable is optional in dev; the server falls back to sensible
defaults.

| Var | Default | Notes |
| --- | --- | --- |
| `PORT` | `3200` | NestJS port |
| `RENDERER_BASE` | `http://localhost:5173` | Post-login redirect base |
| `RENDERER_ORIGINS` | `http://localhost:5173,http://localhost:3000` | CORS allow-list |
| `SESSION_SECRET` | dev placeholder | Cookie signing key — **set in prod** |
| `SESSION_TTL_MS` | 30 days | Session lifetime |
| `STORAGE_DIR` | `.storage` | Where `state.json` lives |
| `NETEASE_MUSIC_U` | – | Dev-only: inject a NetEase `MUSIC_U` cookie |
| `NETEASE_QR_POLL_MS` | `1500` | QR poll interval |
| `DEEPSEEK_API_KEY` | – | **You supply this at runtime** (BYO key) — server reads from session |

---

## Logging in to each source

- **NetEase Cloud Music** — click **登录**, scan the QR code with the NetEase
  phone app, confirm. The server drives NetEase's `/api/login/qrcode/*`
  endpoints and captures `MUSIC_U` from the `Set-Cookie` on success. A
  manual "paste `MUSIC_U`" fallback is available. The cookie lives ~30
  days; when calls start returning `301`, scan again.
- **QQ Music** — click **登录** (desktop app only). Maestro opens an embedded
  QQ Music login window and captures the real login cookie
  (`qm_keyst` / `qqmusic_key` / `uin`) — **no** QQ Connect OAuth, no
  AppID/secret. Search + full-track playback (standard / 320 kbps / lossless)
  work; lossless needs a QQ Music membership.
- **Deezer** — no login. Anonymous public editorial charts stream 30-second
  previews.
- **Spotify** — click **登录**, OAuth PKCE flow. Liked-songs read + ❤ write
  in v1; full-track play requires Spotify Premium (deferred).

---

## Build for production

```bash
npm run build   # tsc server + vite renderer + tsc electron
```

This produces:

- `packages/server/dist/` — compiled NestJS (runs standalone: `node packages/server/dist/main.js` serves `:3200`)
- `packages/renderer/dist/` — static Vite bundle
- `packages/electron/dist/` — compiled Electron main + preload

### Package a macOS `.dmg`

```bash
# App icon + tray glyph (build/icon.icns, build/trayTemplate*.png).
# Committed already; only re-run if you change scripts/gen-icons.cjs.
cd packages/electron && npm run gen-icons

# Build everything first, then pack. Disable code signing during dev
# (electron-builder otherwise stalls looking for a Developer ID cert).
npm run build
cd packages/electron && CSC_IDENTITY_AUTO_DISCOVERY=false npm run pack
# → packages/electron/release/*.dmg
```

How the packaged app runs:

- **Sidecar**: Electron main spawns `resources/server/main.js` as a NestJS
  sidecar, polls `:3200/music/deezer/editorials` until ready, then opens the
  window. On quit (Cmd+Q / tray "退出") the sidecar is killed.
- **API base**: preload exposes `window.electronAPI.apiBase`; the renderer's
  `api.ts` prefers it over the dev `localhost:3200` fallback.
- **extraResources**: `renderer/`, `server/` (compiled dist) and `build/`
  (icons) are copied into `.app/Contents/Resources/`.
- **Tray**: a menubar tray icon with play/pause, prev/next, show-window and
  quit. Closing the main window hides it to the tray (playback continues);
  the app only exits via Cmd+Q or the tray "退出" item.

> **Known limitation** — the sidecar needs the server's runtime
> `node_modules`. With npm workspaces those are hoisted to the repo root, so a
> fully self-contained `.dmg` still needs the server deps bundled (or an
> esbuild bundle that preserves NestJS decorator metadata). See
> `specs/packaging/spec.md` → "已知限制". Dev (`npm run dev`) remains the
> fully-supported way to run the app.

---

## Next iteration

See [NEXT-ITERATION.md](./NEXT-ITERATION.md) for what's planned next, why,
and the acceptance criteria for each item. At a glance:

1. **Production packaging** — NestJS sidecar + correct prod API base so
   `electron-builder` ships a working app.
2. **Spotify parity** — full-track play (Premium) and ❤ write-back.
3. **Local persistence hardening** — back up / restore the unified library
   and session cookies so re-installs don't lose state.
4. **Lyrics quality** — surface the existing lyrics fetch more prominently
   and add a "tap to copy" / "tap to share" affordance.
5. **Settings & onboarding polish** — first-run key flow, library backup
   location, and source-connection health.

---

## Privacy & security

This is a **local-first personal tool**. Platform cookies (`MUSIC_U`,
QQ login cookies, Spotify refresh tokens), sessions, your DeepSeek API
key and the unified library are stored in plaintext under
`packages/server/.storage/` on your own machine and are **git-ignored**.
Nothing is uploaded to any Maestro-operated service; there is none.
Treat `.storage/` like a password file.

## License

MIT
