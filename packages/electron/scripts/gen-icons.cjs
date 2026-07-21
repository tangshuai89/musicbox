// Dependency-free icon generator. Draws the Maestro app icon (warm gradient
// squircle + vinyl record with a heart label — echoes the in-app 红心电台
// vinyl UI) and a monochrome macOS tray template glyph (heart), encoding PNGs
// by hand (zlib is Node built-in) so we don't pull in sharp/canvas. Each icns
// size is rendered natively (no downscaling) and folded into build/icon.icns
// by a pure-JS ICNS writer, so regeneration works on any OS. Re-run with
// `node scripts/gen-icons.cjs` after tweaking colors — or drop your own
// build/icon.icns to replace it.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const BUILD_DIR = path.join(__dirname, '..', 'build');

// ── PNG encoder ─────────────────────────────────────────────────────────────
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── geometry ─────────────────────────────────────────────────────────────────
function insideRoundRect(x, y, w, h, r) {
  const cx = Math.min(Math.max(x, r), w - r);
  const cy = Math.min(Math.max(y, r), h - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}
// Classic implicit heart curve: (x²+y²−1)³ − x²y³ ≤ 0. Spans roughly
// x∈[−1.14,1.14], y∈[−1,1.2] in its own space; `s` scales, (cx,cy) centers.
function insideHeart(px, py, cx, cy, s) {
  const x = (px - cx) / s;
  const y = -(py - cy) / s + 0.11; // optical vertical centering
  const a = x * x + y * y - 1;
  return a * a * a - x * x * y * y * y <= 0;
}

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}
// Analytic 1px-feather coverage for a disc edge.
function discCov(dist, R) {
  return clamp01(R - dist + 0.5);
}

// ── app icon: warm gradient squircle + vinyl record with heart label ────────
function drawAppIcon(S, ss = 3) {
  const rgba = Buffer.alloc(S * S * 4);
  const radius = S * 0.2237; // macOS squircle-ish corner
  // Warm terracotta palette — matches the app's --accent family.
  const g1 = [235, 158, 118]; // top-left  #eb9e76
  const g2 = [162, 71, 42]; // bottom-right #a2472a
  const vinyl = [34, 27, 22]; // #221b16
  const vinylEdge = [58, 46, 38]; // rim sheen base
  const label = [250, 243, 234]; // #faf3ea 奶白
  const heart = [224, 72, 62]; // #e0483e
  const cx = S * 0.5;
  const cy = S * 0.5;
  const discR = S * 0.365;
  const labelR = S * 0.155;
  const holeR = S * 0.02;
  const heartS = S * 0.075;
  const sub = ss * ss;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      // squircle + heart coverage via supersampling (implicit shapes)
      let bgN = 0;
      let heartN = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = x + (sx + 0.5) / ss;
          const py = y + (sy + 0.5) / ss;
          if (insideRoundRect(px, py, S, S, radius)) bgN++;
          if (insideHeart(px, py, cx, cy, heartS)) heartN++;
        }
      }
      const bgCov = bgN / sub;
      if (bgCov === 0) continue;
      const off = (y * S + x) * 4;

      const px = x + 0.5;
      const py = y + 0.5;
      // background: diagonal warm gradient + soft highlight toward top-left
      const t = clamp01((px + py) / (2 * S));
      let r = g1[0] + (g2[0] - g1[0]) * t;
      let g = g1[1] + (g2[1] - g1[1]) * t;
      let b = g1[2] + (g2[2] - g1[2]) * t;
      const hx = (px - S * 0.32) / (S * 0.75);
      const hy = (py - S * 0.28) / (S * 0.75);
      const hi = Math.max(0, 1 - Math.sqrt(hx * hx + hy * hy)) * 26;
      r += hi;
      g += hi;
      b += hi;

      const dx = px - cx;
      const dy = py - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // soft drop shadow around the disc
      const shadow = clamp01((discR * 1.06 - dist) / (S * 0.03)) * 0.25;
      r *= 1 - shadow;
      g *= 1 - shadow;
      b *= 1 - shadow;

      // vinyl disc: grooves + rim sheen
      const dCov = discCov(dist, discR);
      if (dCov > 0) {
        let vr = vinyl[0];
        let vg = vinyl[1];
        let vb = vinyl[2];
        const rel = dist / discR;
        if (rel > 0.42 && rel < 0.96) {
          // fine sinusoidal grooves
          const groove = 0.5 + 0.5 * Math.sin(rel * discR * (Math.PI / (S * 0.0155)));
          const lift = groove * 9;
          vr += lift;
          vg += lift;
          vb += lift;
        }
        if (rel > 0.965) {
          // rim sheen brightest toward the top-left
          const ang = Math.atan2(dy, dx);
          const sheen = 0.5 + 0.5 * Math.cos(ang + Math.PI * 0.75);
          vr = vinylEdge[0] + sheen * 26;
          vg = vinylEdge[1] + sheen * 22;
          vb = vinylEdge[2] + sheen * 18;
        }
        r = r * (1 - dCov) + vr * dCov;
        g = g * (1 - dCov) + vg * dCov;
        b = b * (1 - dCov) + vb * dCov;
      }

      // label
      const lCov = discCov(dist, labelR);
      if (lCov > 0) {
        r = r * (1 - lCov) + label[0] * lCov;
        g = g * (1 - lCov) + label[1] * lCov;
        b = b * (1 - lCov) + label[2] * lCov;
      }

      // heart on the label
      const hCov = heartN / sub;
      if (hCov > 0) {
        r = r * (1 - hCov) + heart[0] * hCov;
        g = g * (1 - hCov) + heart[1] * hCov;
        b = b * (1 - hCov) + heart[2] * hCov;
      }

      // spindle hole
      const oCov = discCov(dist, holeR);
      if (oCov > 0) {
        r = r * (1 - oCov) + vinyl[0] * oCov;
        g = g * (1 - oCov) + vinyl[1] * oCov;
        b = b * (1 - oCov) + vinyl[2] * oCov;
      }

      rgba[off] = Math.round(Math.min(255, r));
      rgba[off + 1] = Math.round(Math.min(255, g));
      rgba[off + 2] = Math.round(Math.min(255, b));
      rgba[off + 3] = Math.round(bgCov * 255);
    }
  }
  return rgba;
}

// ── tray template: black heart glyph on transparent ───────────────────────────
function drawTrayGlyph(S, ss = 4) {
  const rgba = Buffer.alloc(S * S * 4);
  const cx = S * 0.5;
  const cy = S * 0.5;
  const s = S * 0.34; // heart spans ~78% of the canvas — crisp at 16px
  const sub = ss * ss;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let fg = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          if (insideHeart(x + (sx + 0.5) / ss, y + (sy + 0.5) / ss, cx, cy, s)) fg++;
        }
      }
      if (fg === 0) continue;
      const off = (y * S + x) * 4;
      rgba[off] = 0;
      rgba[off + 1] = 0;
      rgba[off + 2] = 0;
      rgba[off + 3] = Math.round((fg / sub) * 255); // black shape; mac inverts for menubar
    }
  }
  return rgba;
}

function writePng(name, w, h, rgba) {
  const p = path.join(BUILD_DIR, name);
  fs.writeFileSync(p, encodePng(w, h, rgba));
  console.log(`wrote ${path.relative(process.cwd(), p)} (${w}x${h})`);
}

// ── ICNS writer (pure JS) ──────────────────────────────────────────────────────
// Modern icns entries accept raw PNG payloads, so no sips/iconutil needed —
// regeneration works on any OS, and each size is rendered natively (crisper
// than downscaling the 1024px master).
const ICNS_TYPES = {
  16: 'icp4',
  32: 'icp5',
  64: 'icp6',
  128: 'ic07',
  256: 'ic08',
  512: 'ic09',
  1024: 'ic10',
};
function writeIcns(pngBySize) {
  const entries = [];
  for (const [size, type] of Object.entries(ICNS_TYPES)) {
    const png = pngBySize[size];
    if (!png) continue;
    const header = Buffer.alloc(8);
    header.write(type, 0, 'ascii');
    header.writeUInt32BE(png.length + 8, 4);
    entries.push(header, png);
  }
  const body = Buffer.concat(entries);
  const fileHeader = Buffer.alloc(8);
  fileHeader.write('icns', 0, 'ascii');
  fileHeader.writeUInt32BE(body.length + 8, 4);
  const p = path.join(BUILD_DIR, 'icon.icns');
  fs.writeFileSync(p, Buffer.concat([fileHeader, body]));
  console.log(`wrote ${path.relative(process.cwd(), p)}`);
}

function main() {
  fs.mkdirSync(BUILD_DIR, { recursive: true });

  const pngBySize = {};
  for (const size of Object.keys(ICNS_TYPES).map(Number)) {
    pngBySize[size] = encodePng(size, size, drawAppIcon(size, size <= 64 ? 4 : 3));
  }
  fs.writeFileSync(path.join(BUILD_DIR, 'icon.png'), pngBySize[1024]);
  console.log('wrote build/icon.png (1024x1024)');
  writeIcns(pngBySize);

  writePng('trayTemplate.png', 16, 16, drawTrayGlyph(16));
  writePng('trayTemplate@2x.png', 32, 32, drawTrayGlyph(32));
}

main();
