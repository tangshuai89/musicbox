import { useCallback, useRef, type RefObject } from 'react';
import { API_ORIGIN } from '../api';
import { resetCoverColor, setCoverColor } from '../lib/coverColor';

/**
 * Pull the dominant colour out of a cover-art image URL and apply it to
 *   1. the bg-layer div (so the window background echoes the song), and
 *   2. the --cover-accent + --cover-glow custom properties on :root
 *      (consumed by the cover's outer halo).
 *
 * CORS: cover CDNs (QQ's y.gtimg.cn in particular) don't return
 * Access-Control-Allow-Origin, which kills the canvas drawImage →
 * getImageData path (the canvas ends up "tainted" and pixel reads throw). We
 * route the JS fetch through our server's /music/cover-proxy, which re-emits
 * the image with CORS headers. The original `url` is used for the CSS
 * background-image (the browser renders cross-origin <img>s fine without
 * pixel access).
 */
async function applyCoverImage(
  url: string,
  bgLayerRef: RefObject<HTMLDivElement | null>,
  coverBackdropRef: RefObject<HTMLDivElement | null>,
  epoch: number,
  epochRef: RefObject<number>,
): Promise<void> {
  // Build the proxied URL against the same origin the API client uses. In
  // dev API_ORIGIN is '' → /music/cover-proxy (Vite proxies to :3200); in
  // prod it's the sidecar origin → an absolute URL.
  const proxied = `${API_ORIGIN}/music/cover-proxy?url=${encodeURIComponent(url)}`;

  let bitmap: ImageBitmap;
  try {
    const res = await fetch(proxied);
    // Cancelled: a newer presentTrack call incremented the epoch while we
    // were waiting. Bail without touching the DOM.
    if (epochRef.current !== epoch) return;
    if (!res.ok) throw new Error(`proxy_http_${res.status}`);
    const blob = await res.blob();
    if (epochRef.current !== epoch) return;
    bitmap = await createImageBitmap(blob);
  } catch {
    if (epochRef.current !== epoch) return;
    // Proxy failed (server down, host not allowlisted, upstream 5xx). We can
    // still set the background-image with the ORIGINAL URL — we just lose
    // the colour extraction this time.
    const coverBackdrop = coverBackdropRef.current;
    const bgLayer = bgLayerRef.current;
    if (coverBackdrop) coverBackdrop.style.backgroundImage = `url(${url})`;
    if (bgLayer) bgLayer.style.backgroundImage = `url(${url})`;
    resetCoverColor();
    return;
  }

  // 1) Sample the dominant colour.
  const sampleCanvas = document.createElement('canvas');
  sampleCanvas.width = 1;
  sampleCanvas.height = 1;
  const sampleCtx = sampleCanvas.getContext('2d');
  if (sampleCtx) {
    sampleCtx.drawImage(bitmap, 0, 0, 1, 1);
    const [r, g, b] = sampleCtx.getImageData(0, 0, 1, 1).data;
    setCoverColor(r, g, b);
  }

  // 2) Set the cover as the bg-layer and the left-column backdrop. Use the
  // ORIGINAL url for CSS background-image (no CORS needed for display); the
  // proxied URL was only needed for the JS pixel-read fetch above.
  const coverBackdrop = coverBackdropRef.current;
  const bgLayer = bgLayerRef.current;
  if (coverBackdrop) coverBackdrop.style.backgroundImage = `url(${url})`;
  if (bgLayer) bgLayer.style.backgroundImage = `url(${url})`;

  bitmap.close?.();
}

/**
 * Owns the two DOM refs that receive the cover background-image plus the
 * epoch counter used to cancel stale in-flight fetches. `presentCover(url)`
 * bumps the epoch and kicks off colour extraction; reading ref.current
 * INSIDE the async work (not capturing the node here) is what lets it write
 * onto the freshly-remounted cover div after a track change.
 */
export function useCoverArt() {
  const bgLayerRef = useRef<HTMLDivElement>(null);
  const coverBackdropRef = useRef<HTMLDivElement>(null);
  const coverEpochRef = useRef(0);

  const presentCover = useCallback((url: string) => {
    coverEpochRef.current += 1;
    void applyCoverImage(
      url,
      bgLayerRef,
      coverBackdropRef,
      coverEpochRef.current,
      coverEpochRef,
    );
  }, []);

  return { bgLayerRef, coverBackdropRef, presentCover };
}
