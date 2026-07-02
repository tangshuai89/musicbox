import { useEffect, useRef } from 'react';

/**
 * Linear-blend two #rrggbb (or rgb(r,g,b)) strings. Returns a
 * #rrggbb string. Used to brighten the cover-accent by mixing
 * with the brand accent and then with white, so the visualizer
 * bars stay visible even when the cover's dominant colour is
 * dark or muted.
 */
function mixHex(a: string, b: string, t: number): string {
  const pa = parseRgb(a);
  const pb = parseRgb(b);
  if (!pa || !pb) return a;
  const r = Math.round(pa[0] + (pb[0] - pa[0]) * t);
  const g = Math.round(pa[1] + (pb[1] - pa[1]) * t);
  const bl = Math.round(pa[2] + (pb[2] - pa[2]) * t);
  return `rgb(${r}, ${g}, ${bl})`;
}

function parseRgb(s: string): [number, number, number] | null {
  const hex = s.trim();
  if (hex.startsWith('#') && (hex.length === 7 || hex.length === 4)) {
    if (hex.length === 4) {
      return [
        parseInt(hex[1] + hex[1], 16),
        parseInt(hex[2] + hex[2], 16),
        parseInt(hex[3] + hex[3], 16),
      ];
    }
    return [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
    ];
  }
  const m = hex.match(/rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return null;
}

/** Path a rounded rect into ctx without filling. radius 0 = sharp. */
function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.closePath();
}

interface Props {
  /** AnalyserNode from the shared AudioContext. Null until the user
   *  hits play the first time (autoplay policy gates context creation
   *  to user gestures). */
  analyser: AnalyserNode | null;
  /** True while audio is actually playing — we pause the RAF loop
   *  when paused so we don't burn cycles drawing static frames. */
  playing: boolean;
}

/**
 * Live frequency-bar visualizer. Reads byte-frequency data from the
 * AnalyserNode every frame and draws 48 bars with a power-curve bin
 * mapping so low frequencies (kick, bass) get more visual real estate
 * than high ones (cymbals, hiss). Bar colour follows the live
 * `--cover-accent` CSS variable, so it tracks the current track.
 */
export default function Visualizer({ analyser, playing }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);
  // Historical-peak tracker for the per-bar cap dots. Declared at
  // component scope so it persists across draws; the actual array
  // is allocated inside the effect (after we know barCount) so
  // re-running the effect with a new analyser gets a clean slate.
  const peaksRef = useRef<number[]>([]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !analyser) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // The analyser buffer is half of fftSize. 256 → 128 bins, which
    // is plenty for 48 visible bars after the power-curve mapping.
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.72;
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    // 48 bars; allocate the peak tracker once per effect run so a
    // fresh analyser (or new track) starts with no ghost peaks.
    const barCount = 48;
    peaksRef.current = new Array(barCount).fill(0);

    // HiDPI: back the canvas at devicePixelRatio, but apply the scale
    // only once per resize (otherwise ctx.scale compounds on every
    // resize and the bars grow each time).
    const dpr = window.devicePixelRatio || 1;
    const cssSize = { w: 0, h: 0 };
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      cssSize.w = rect.width;
      cssSize.h = rect.height;
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    // rAF-batch the resize (see Particles.tsx for the full rationale)
    // to avoid the "ResizeObserver loop completed" console spam.
    let roScheduled = false;
    const ro = new ResizeObserver(() => {
      if (roScheduled) return;
      roScheduled = true;
      requestAnimationFrame(() => {
        roScheduled = false;
        resize();
      });
    });
    ro.observe(canvas);

    const draw = () => {
      rafRef.current = requestAnimationFrame(draw);
      if (!analyser) return;
      analyser.getByteFrequencyData(dataArray);

      const w = cssSize.w;
      const h = cssSize.h;
      ctx.clearRect(0, 0, w, h);

      // Read the live cover accent and brand accent from CSS, then
      // build a brighter, more saturated mix. Dark cover colours
      // (e.g. cinematic albums) would otherwise produce bars that
      // are invisible on the dark card. Mixing 30% brand orange
      // + lifting toward white guarantees the bars always pop.
      const rootStyle = getComputedStyle(document.documentElement);
      const coverRaw = rootStyle.getPropertyValue('--cover-accent').trim() ||
        '#d97757';
      const brandRaw = rootStyle.getPropertyValue('--accent').trim() ||
        '#d97757';
      // 60% cover + 40% brand → blend toward the brand to keep the
      // energy up, then a second pass blends toward white for the
      // peak colour of each bar.
      const midColor = mixHex(coverRaw, brandRaw, 0.45);
      const peakColor = mixHex(midColor, '#ffffff', 0.35);

      const gap = 2;
      const barWidth = (w - gap * (barCount - 1)) / barCount;
      const maxBin = bufferLength - 1;

      // Peak tracker: one peak level per bar. Each frame, if the
      // current value beats the peak we lift the peak instantly;
      // otherwise we let it decay. This produces the classic "dot
      // hovering above the bar, slowly drifting down" effect. We
      // declare it inside the effect (per analyser setup) so a
      // re-creation of the effect starts with fresh peaks.
      const peaks = peaksRef.current;

      for (let i = 0; i < barCount; i++) {
        const t = i / (barCount - 1);
        const dataIdx = Math.floor(t * t * maxBin);
        const value = dataArray[dataIdx] / 255;
        // 8% baseline floor — always at least a visible sliver.
        const barH = Math.max(value * h * 0.94, h * 0.08);

        // Peak update. Instant rise, ~3.5% decay/frame at 60fps
        // gives a roughly 1-second fall time which reads as
        // "remembered loudness".
        const prevPeak = peaks[i] ?? 0;
        const nextPeak = value > prevPeak ? value : prevPeak * 0.965;
        peaks[i] = nextPeak;

        // Gradient: cooler/dimmer at the bottom, brighter at the top
        // of the bar. We fill the whole bar with `midColor` first
        // (cheap), then overlay a top slice in `peakColor`.
        const x = i * (barWidth + gap);
        const y = h - barH;
        const r = Math.min(2, barWidth / 2);

        ctx.globalAlpha = 0.95;
        ctx.fillStyle = midColor;
        roundedRect(ctx, x, y, barWidth, barH, r);
        ctx.fill();

        // Brighter top slice — the loudest 30% of each bar, drawn
        // in peakColor with a soft glow. This is what makes the
        // visualizer feel "alive" even on quiet tracks.
        const topH = Math.max(barH * 0.3, 4);
        const topY = h - topH;
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = peakColor;
        // soft glow behind the top slice
        ctx.shadowColor = peakColor;
        ctx.shadowBlur = 8;
        roundedRect(ctx, x, topY, barWidth, topH, r);
        ctx.fill();
        ctx.shadowBlur = 0;

        // Peak cap — a small bright dot at the historical peak
        // height of this bar, with its own soft glow. We skip
        // drawing it once the peak has decayed near zero so the
        // card doesn't get littered with ghost dots during quiet
        // passages.
        if (nextPeak > 0.04) {
          const peakPx = nextPeak * h * 0.94;
          const peakY = h - peakPx;
          ctx.globalAlpha = 0.95;
          ctx.fillStyle = peakColor;
          ctx.shadowColor = peakColor;
          ctx.shadowBlur = 6;
          ctx.beginPath();
          ctx.arc(x + barWidth / 2, peakY, 2.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowBlur = 0;
        }
      }
      ctx.globalAlpha = 1;
    };

    if (playing) {
      draw();
    } else {
      // Draw a single quiet frame so the canvas isn't blank.
      draw();
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      ro.disconnect();
    };
  }, [analyser, playing]);

  return (
    <div className="visualizer-wrap">
      <canvas
        ref={canvasRef}
        className="visualizer-canvas"
        aria-hidden="true"
      />
      {analyser === null && (
        <div className="visualizer-placeholder" aria-hidden="true">
          <div className="visualizer-placeholder-glyph">♪</div>
          <div className="visualizer-placeholder-hint">
            点击播放开启频谱
          </div>
        </div>
      )}
    </div>
  );
}
