# QQ FM Player

A minimal, elegant music player for macOS — inspired by Douban FM.

Built with **Electron + React + NestJS**.

## Features

- QQ Music login integration (OAuth via QQ Connect)
- Radio-style playback — just press play, skip what you don't like
- Like (red heart) your favorite tracks
- Clean, distraction-free interface

## Project Structure

```
packages/
  electron/   — Electron main process (window management)
  renderer/   — React frontend (UI)
  server/     — NestJS backend (API, auth, music service)
```

## Development

```bash
# Install dependencies
npm install

# Start all services (server + renderer + electron)
npm run dev
```

Individual services:

```bash
npm run dev:server    # NestJS on :3200
npm run dev:renderer  # Vite on :5173
npm run dev:electron  # Electron app
```

## Build for Production

```bash
npm run build
cd packages/electron && npm run pack
```

## QQ Music OAuth Setup

1. Register an app at [QQ Connect](https://connect.qq.com/)
2. Set the callback URL to `http://localhost:3200/auth/callback`
3. Set environment variables:
   ```
   QQ_APP_ID=your_app_id
   QQ_APP_SECRET=your_app_secret
   ```

## License

MIT
