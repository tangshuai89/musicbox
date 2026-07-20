/**
 * Deterministic "no artwork" cover.
 *
 * Some tracks arrive without a cover URL — the odd radio pick, AI-recommended
 * items whose artwork didn't resolve, or library placeholders. Left alone
 * those fall back to a bare glyph on a dead panel, and worse, leave the
 * PREVIOUS song's artwork lingering in the blurred full-window bg-layer
 * (presentCover was only called when coverUrl was truthy).
 *
 * Instead of shipping one static default image, we derive a stable gradient +
 * a matching accent colour from the track's identity (title + artist), so
 * every cover-less song still gets a distinct, intentional-looking placeholder
 * — and one that feeds the same `--cover-accent` halo / bass-breathing
 * machinery as a real cover. Same song → same colours across sessions.
 */

export interface PlaceholderCover {
  /** CSS value for `background-image` — a two-stop diagonal gradient. */
  background: string;
  /** Dominant accent RGB (matches the gradient's first stop) for --cover-accent. */
  accent: [number, number, number];
}

/** FNV-1a: tiny, stable, well-distributed string hash. */
function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** HSL (h∈[0,360), s/l∈[0,1]) → 8-bit RGB triplet. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

/**
 * Build a placeholder cover for a track that has no artwork. `seed` should be
 * something stable per song — `title·artist` is ideal (id also works but is
 * platform-specific). Empty seed falls back to a fixed brand-ish hue.
 */
export function placeholderCover(seed: string): PlaceholderCover {
  const h = hashSeed(seed || 'maestro');
  // Two related hues 40° apart → a gradient with depth but no clash.
  const hue = h % 360;
  const hue2 = (hue + 40) % 360;
  // Mid-dark, muted tones so white glyph/text stays readable and it sits
  // comfortably behind the glass cards (which expect a dim backdrop).
  const top = hslToRgb(hue, 0.5, 0.42);
  const bottom = hslToRgb(hue2, 0.55, 0.26);
  const background =
    `linear-gradient(135deg, rgb(${top[0]}, ${top[1]}, ${top[2]}) 0%, ` +
    `rgb(${bottom[0]}, ${bottom[1]}, ${bottom[2]}) 100%)`;
  return { background, accent: top };
}
