# Musicbox

**English** · [简体中文](./README.zh-CN.md) · [日本語](./README.ja.md)

> Your cross-platform music brain. Log into NetEase Cloud Music, QQ Music,
> Spotify and Deezer, pull your **liked ("hearted") songs** from every
> platform, let a large language model (**DeepSeek**, using *your own* API
> key) recommend what to fall in love with next — and when you heart a
> track, heart it **everywhere it's licensed**, so "sorry, unavailable in
> your region / no rights" never stops the music again.

Built with **Electron + React + NestJS** as a desktop-first client.

> ⚠️ **Status: early alpha / active development.** The player foundation and
> per-platform adapters work today; the defining features (liked-song
> import, AI recommendations, cross-platform heart fan-out, unified
> multi-source search) are still being built. See
> [Status & progress](#status--progress) for an honest, per-feature
> breakdown.

---

## The idea

Streaming platforms each hold a slice of your taste and a slice of the
world's catalogue — and neither slice is complete. A song you love on QQ
Music is missing from NetEase; a Spotify recommendation has no rights in
your region. Musicbox treats all four platforms as **one library you own**:

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
  locally on your machine — nothing is sent to a Musicbox server (there
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
| Log in                             | ✅ QR scan | ✅ cookie (embedded window) | 📋 | ✅ anonymous (no login) |
| Play full track                    | ✅ | ✅ (std / 320 / lossless) | 📋 | 🚧 30 s preview only |
| Radio / station feed               | ✅ private FM | 🚧 keyword-seeded pseudo-radio | 📋 | ✅ editorial charts |
| Search                             | 📋 | ✅ | 📋 | 📋 |
| Local like / dislike               | ✅ | ✅ | 📋 | ✅ |
| Sync ❤ back to the platform        | ✅ radio-like | 🚧 local only | 📋 | 🚧 local only |
| Import your existing liked songs   | 📋 | 📋 | 📋 | 📋 |

### Cross-cutting product features

| Feature                                          | Status |
| ------------------------------------------------ | :----: |
| Multi-source player shell (Electron/React/Nest)  | ✅ |
| Per-platform login & session persistence         | ✅ |
| Server-side audio proxy (URLs never reach the UI)| ✅ |
| Glass/cosmic themed UI, light/dark, cover-art accent | ✅ |
| **Import liked songs from every platform**       | 📋 |
| **Unified library (cross-platform de-dup match)**| 📋 |
| **DeepSeek recommendation engine**               | 📋 |
| **Heart fan-out to all licensed platforms**      | 📋 |
| **Unified multi-source search & playback fallback** | 📋 |
| **Spotify adapter**                              | 📋 |

**Rough completion against the full vision: ~25–30%.** The foundation
(desktop shell, three of four platform adapters, per-source radio / search /
playback, local like state, themed UI) is solid and working. The five
features that *define* the product — liked-song import, the unified library,
DeepSeek recommendations, cross-platform heart fan-out, and unified search —
are not built yet.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Renderer (React + Vite, :5173)                              │
│   - Calls /api/*  (Vite dev-proxies to NestJS, strips /api)  │
│   - <audio> src = /music/stream/{provider}/{id}             │
│   - Cover-art colour extraction, theming, source switcher    │
└───────────────────────────────┬──────────────────────────────┘
                                │ HTTP (cookie session)
┌───────────────────────────────▼──────────────────────────────┐
│  NestJS server (:3200)                                        │
│   common/   ConfigService · StorageService · SessionService   │
│   auth/     QQ cookie login · NetEase QR login                │
│   music/    per-provider strategy + audio proxy (302 / pipe)  │
│                                                               │
│   📋 planned: library/ (aggregate liked) · reco/ (DeepSeek)  │
│              · match/ (cross-platform track resolution)       │
└───────────────────────────────┬──────────────────────────────┘
                                │ HTTPS (with per-platform creds)
       ┌──────────────┬─────────┴──────────┬──────────────┐
       ▼              ▼                     ▼              ▼
  music.163.com   y.qq.com            Spotify Web API  api.deezer.com
  (plaintext /api) (search + GetVkey)   📋 planned     (public API)
```

The **Electron main process** additionally hosts an embedded login window
(to capture the QQ Music login cookie via a real Chromium session) and an
internal proxy scaffold. Sessions and liked/disliked state persist to
`packages/server/.storage/state.json` (git-ignored).

---

## Project structure

```
packages/
  electron/   Electron main process — window + embedded login capture
    src/main.ts, src/preload.ts
  renderer/   React front-end (UI, player, source switcher, search, QR modal)
    src/App.tsx, api.ts, SourceSelect.tsx, SearchPanel.tsx, NeteaseCookieModal.tsx
  server/     NestJS back-end
    src/common/   config · storage · session · provider registry
    src/auth/     auth.controller · qq.strategy · netease-auth.strategy
    src/music/    music.controller · music.service
                  qq.provider · netease.provider · deezer.provider
                  netease-crypto (weapi AES/RSA — legacy, see notes)
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

The Vite dev server proxies `/api/*` (with the `/api` prefix stripped) and
`/music/*` to NestJS on `:3200`, so the whole app is same-origin in dev and
one session cookie is shared.

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
| `DEEPSEEK_API_KEY` | – | 📋 planned — your DeepSeek key for recommendations |

---

## Logging in to each source

- **NetEase Cloud Music** — click **登录**, scan the QR code with the NetEase
  phone app, confirm. The server drives NetEase's plaintext `/api/login/
  qrcode/*` endpoints and captures `MUSIC_U` from the `Set-Cookie` on
  success. A manual "paste `MUSIC_U`" fallback is available. The cookie
  lives ~30 days; when calls start returning `301`, scan again.
- **QQ Music** — click **登录** (desktop app only). Musicbox opens an embedded
  QQ Music login window and captures the real login cookie
  (`qm_keyst` / `qqmusic_key` / `uin`) — **no** QQ Connect OAuth, no
  AppID/secret. Search + full-track playback (standard / 320 kbps / lossless)
  then work; lossless needs a QQ Music membership.
- **Deezer** — no login. Anonymous public editorial charts stream 30-second
  previews.
- **Spotify** — 📋 planned (OAuth PKCE against the Spotify Web API).

---

## Build for production

```bash
npm run build                         # server + renderer + electron
cd packages/electron && npm run pack  # (packaging is WIP)
```

> **Known packaging gap:** the NestJS server isn't yet bundled/sidecar-ed
> into the Electron app, and the renderer's production API base
> (`http://localhost:3200/api`) doesn't match the server's unprefixed
> routes (the `/api` strip only exists in the Vite dev proxy). Both need to
> be resolved before a packaged build works end-to-end — see the roadmap.

---

## Roadmap (next up)

1. **NetEase adapter hardening** — remove the stale "NetEase disabled" bounce
   in `App.tsx`, delete the now-dead Electron NetEase proxy + unused
   `netease-crypto.ts`, and make liked-track handling real (not placeholder).
2. **Import liked songs** — per-platform "fetch my hearted songs" (NetEase
   "我喜欢的音乐" playlist, QQ favourites, Deezer favourites) into a unified,
   persisted library.
3. **Cross-platform track matching** — resolve "the same song" across
   platforms by ISRC / title+artist+duration fuzzy match, so hearts and
   playback can fan out and fall back.
4. **DeepSeek recommendation engine** — feed the aggregated library to
   DeepSeek (BYO key) and surface a recommendation queue.
5. **Heart fan-out** — one ❤ writes to every platform that holds the rights.
6. **Unified multi-source search & playback fallback** — search all platforms
   at once; auto-play from whichever holds the license.
7. **Spotify adapter** — OAuth PKCE, liked-songs read, playback/heart write.
8. **Production packaging** — bundle the NestJS server as a sidecar and fix
   the prod API base/prefix mismatch.

---

## Privacy & security

This is a **local-first personal tool**. Platform cookies (`MUSIC_U`,
QQ login cookies), sessions and — in future — your DeepSeek API key are
stored in plaintext under `packages/server/.storage/` on your own machine
and are **git-ignored**. Nothing is uploaded to any Musicbox-operated
service; there is none. Treat `.storage/` like a password file.

## License

MIT
