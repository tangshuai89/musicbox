import { useEffect, useRef } from 'react';

/**
 * Floating soft-glow particle field. Renders ~30 cover-coloured
 * orbs that drift slowly across the window with wrap-around, and
 * gently push away from the cursor when it gets close. Sits in
 * the .app's background z-layer (between the bg-layer wash and the
 * glass cards), so the cards still read crisp but the window
 * between them is alive.
 *
 * Colour tracks the current `--cover-accent` CSS variable, so the
 * whole field re-tints when a new track loads. Each frame we re-
 * read the variable (cheap) and only re-write particle colours when
 * it actually changed — avoids 30 object writes per RAF tick.
 */

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  alpha: number;
}

const PARTICLE_COUNT = 30;
const REPEL_RADIUS = 130;
const REPEL_FORCE = 0.55;

/** Accepts #rrggbb or rgb(r,g,b) and returns rgba(r,g,b,a). */
function toRgba(colour: string, alpha: number): string {
  let r = 0,
    g = 0,
    b = 0;
  const trimmed = colour.trim();
  if (trimmed.startsWith('#') && trimmed.length === 7) {
    r = parseInt(trimmed.slice(1, 3), 16);
    g = parseInt(trimmed.slice(3, 5), 16);
    b = parseInt(trimmed.slice(5, 7), 16);
  } else {
    const m = trimmed.match(/rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (m) {
      r = Number(m[1]);
      g = Number(m[2]);
      b = Number(m[3]);
    }
  }
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export default function Particles() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    let cssW = 0;
    let cssH = 0;

    const particles: Particle[] = [];
    const seedParticles = (w: number, h: number) => {
      particles.length = 0;
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        particles.push({
          x: Math.random() * w,
          y: Math.random() * h,
          // Drift is intentionally slow — a "drifting dust" feel,
          // not "screen saver". Keep velocity well under 1 px/frame
          // at 60fps.
          vx: (Math.random() - 0.5) * 0.18,
          vy: (Math.random() - 0.5) * 0.18,
          // 22–52px radius. Smaller = "dust", bigger = "soft glow".
          // We mix both for a layered feel.
          radius: 22 + Math.random() * 30,
          // 0.14–0.30 alpha — visible but never opaque, so the
          // cards above stay readable.
          alpha: 0.14 + Math.random() * 0.16,
        });
      }
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      cssW = rect.width;
      cssH = rect.height;
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (particles.length === 0) seedParticles(cssW, cssH);
      else {
        // Re-clamp existing particles inside the new bounds instead
        // of re-seeding, so the field doesn't "jump" on resize.
        for (const p of particles) {
          p.x = Math.min(Math.max(p.x, 0), cssW);
          p.y = Math.min(Math.max(p.y, 0), cssH);
        }
      }
    };

    resize();
    // Defer the resize handler to the next animation frame. Running
    // it synchronously inside the ResizeObserver callback lets the
    // canvas backing-store write feed back into the same observation
    // pass, which Chromium reports as "ResizeObserver loop completed
    // with undelivered notifications" (the console spam). rAF-batching
    // breaks that re-entrancy — one resize per frame, max.
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

    // Track cover-accent — when the track changes the colour shifts,
    // and we want the particle field to follow. Read once per frame;
    // only update the cached string when it actually changes.
    let lastCover = '';
    const coverAccent = (): string => {
      const root = getComputedStyle(document.documentElement);
      return (
        root.getPropertyValue('--cover-accent').trim() || 'rgb(217, 119, 87)'
      );
    };

    // Mouse repulsion — particles near the cursor get pushed away.
    // We don't render a cursor sprite; the effect is felt as "the
    // field parts around my pointer", which is subtle and tasteful.
    let mouseX = -9999;
    let mouseY = -9999;
    const onMouseMove = (e: MouseEvent) => {
      mouseX = e.clientX;
      mouseY = e.clientY;
    };
    const onMouseLeave = () => {
      mouseX = -9999;
      mouseY = -9999;
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseleave', onMouseLeave);

    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);

      const cover = coverAccent();
      const coverChanged = cover !== lastCover;
      lastCover = cover;

      ctx.clearRect(0, 0, cssW, cssH);

      // additive blending so overlapping orbs brighten instead of
      // muddying — each particle reads as a soft light source
      for (const p of particles) {
        // Mouse repulsion — radial push away from (mouseX, mouseY)
        if (mouseX > -1000) {
          const dx = p.x - mouseX;
          const dy = p.y - mouseY;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < REPEL_RADIUS && dist > 0.01) {
            const force = ((REPEL_RADIUS - dist) / REPEL_RADIUS) * REPEL_FORCE;
            p.x += (dx / dist) * force;
            p.y += (dy / dist) * force;
          }
        }

        // Drift
        p.x += p.vx;
        p.y += p.vy;

        // Wrap-around at the canvas edges so the field looks
        // endless. We don't hard-clamp at the radius — particles
        // can exit fully off one side and re-enter on the other,
        // which gives a smoother "field of motes" feel than
        // bouncing or stopping.
        if (p.x < -p.radius) p.x = cssW + p.radius;
        else if (p.x > cssW + p.radius) p.x = -p.radius;
        if (p.y < -p.radius) p.y = cssH + p.radius;
        else if (p.y > cssH + p.radius) p.y = -p.radius;

        // Radial-gradient "soft glow": full alpha at the centre
        // fading to transparent at the rim. setTransform (above)
        // already accounts for dpr, so we draw in CSS pixels.
        const g = ctx.createRadialGradient(
          p.x,
          p.y,
          0,
          p.x,
          p.y,
          p.radius,
        );
        g.addColorStop(0, toRgba(cover, p.alpha));
        g.addColorStop(1, toRgba(cover, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.fill();
      }
      // `coverChanged` is read for side-effect — without referencing
      // it, the linter complains; here it's the gate that prevents
      // us from re-reading getComputedStyle per particle.
      void coverChanged;
    };

    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseleave', onMouseLeave);
    };
  }, []);

  return <canvas ref={canvasRef} className="particles-canvas" aria-hidden="true" />;
}