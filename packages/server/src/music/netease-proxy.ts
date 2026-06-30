import { Injectable, Logger } from '@nestjs/common';

/**
 * Bridge to the Electron-internal HTTP proxy.
 *
 * Why this exists:
 *   NetEase's anti-bot fingerprints Node's fetch (TLS / TCP / HTTP2 stack
 *   mismatch with real browsers). It detects our weapi calls as bots and
 *   returns empty 200 bodies.
 *
 *   The Electron main process keeps a persistent login window with a real
 *   Chromium session. It exposes a localhost-only HTTP endpoint that proxies
 *   our requests through that Chromium session — so NetEase sees a normal
 *   browser request.
 *
 * Behaviour:
 *   - If the proxy is reachable, every `fetch()` here goes through Electron
 *   - If not reachable (browser-only dev mode), throws — caller falls back to
 *     direct fetch (which will fail with empty body, but at least we surface
 *     a clear error)
 */
@Injectable()
export class NeteaseProxy {
  private readonly logger = new Logger(NeteaseProxy.name);
  private endpoint: string | null = null;
  private discoverPromise: Promise<void> | null = null;

  constructor() {
    // Start discovery in background; we don't block startup on it because
    // the dev script starts NestJS 3s before Electron. The first weapi call
    // will await the discovery.
    this.discoverPromise = this.discover();
  }

  private async discover(): Promise<void> {
    const port = Number(process.env.ELECTRON_PROXY_PORT ?? 3300);
    // Retry for up to 10s with backoff — Electron needs to boot before its
    // HTTP server is reachable.
    const deadline = Date.now() + 10_000;
    let attempt = 0;
    while (Date.now() < deadline) {
      attempt++;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/internal/ping`, {
          signal: AbortSignal.timeout(500),
        });
        if (res.ok) {
          this.endpoint = `http://127.0.0.1:${port}`;
          this.logger.log(`netease proxy discovered at :${port} (attempt ${attempt})`);
          return;
        }
      } catch {
        // retry
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    this.logger.warn(
      `netease proxy at :${port} never came up after ${attempt} attempts — ` +
        `weapi calls will fall back to direct fetch (likely anti-bot blocked). ` +
        `If you're running the dev server without Electron, this is expected; ` +
        `the app needs the Electron shell for NetEase.`,
    );
  }

  /**
   * Re-attempt discovery if a previous attempt failed. Cheap if already up.
   * Call this from the music provider on each request so the system recovers
   * automatically once Electron finishes booting.
   */
  async ensureDiscovered(): Promise<void> {
    if (this.endpoint) return;
    if (!this.discoverPromise) {
      this.discoverPromise = this.discover();
    }
    await this.discoverPromise;
    // If still not available after one full discovery round-trip, try again
    // on the next call rather than staying permanently broken.
    if (!this.endpoint) this.discoverPromise = null;
  }

  isAvailable(): boolean {
    return this.endpoint !== null;
  }

  async fetch(
    url: string,
    init: {
      payload?: Record<string, unknown>;
      csrfToken?: string;
    },
  ): Promise<{ status: number; body: string; headers: Record<string, string> }> {
    await this.ensureDiscovered();
    if (!this.endpoint) {
      throw new Error(
        'netease proxy unavailable — start the app via Electron (npm run dev) so it can route weapi through Chromium',
      );
    }
    const res = await fetch(`${this.endpoint}/internal/netease-fetch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        payload: init.payload ?? {},
        csrfToken: init.csrfToken,
      }),
    });
    if (!res.ok) {
      // Surface the body too — the Electron side always returns JSON like
      // { error, message }, and the message is what we actually want.
      const body = await res.text();
      let detail = body;
      try {
        const parsed = JSON.parse(body) as { message?: string; error?: string };
        if (parsed.message) detail = parsed.message;
      } catch {
        // not JSON, keep raw body
      }
      throw new Error(`netease proxy returned ${res.status}: ${detail}`);
    }
    return {
      status: res.status,
      body: await res.text(),
      headers: Object.fromEntries(res.headers.entries()),
    };
  }
}