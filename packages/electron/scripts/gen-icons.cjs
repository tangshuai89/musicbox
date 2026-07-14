// Dependency-free icon generator. Draws a placeholder Maestro app icon
// (gradient squircle + white play triangle) and a monochrome macOS tray
// template glyph, encoding PNGs by hand (zlib is Node built-in) so we don't
// pull in sharp/canvas. On macOS it also folds the PNGs into an .icns via the
// system `sips`/`iconutil`. Re-run with `node scripts/gen-icons.cjs` to
// regenerate after tweaking colors — or drop your own build/icon.icns to
// replace the placeholder.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

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
function edge(px, py, ax, ay, bx, by) {
  return (px - bx) * (ay - by) - (ax - bx) * (py - by);
}
function insideTriangle(px, py, v) {
  const d1 = edge(px, py, v[0][0], v[0][1], v[1][0], v[1][1]);
  const d2 = edge(px, py, v[1][0], v[1][1], v[2][0], v[2][1]);
  const d3 = edge(px, py, v[2][0], v[2][1], v[0][0], v[0][1]);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}
// Play triangle vertices for a canvas of size S, optically nudged right.
function playTriangle(S) {
  const cx = S * 0.54;
  const cy = S * 0.5;
  const t = S * 0.3;
  return [
    [cx - t * 0.72, cy - t],
    [cx - t * 0.72, cy + t],
    [cx + t * 0.95, cy],
  ];
}

// ── app icon: gradient squircle + white play triangle ────────────────────────
function drawAppIcon(S, ss = 3) {
  const rgba = Buffer.alloc(S * S * 4);
  const radius = S * 0.2237; // macOS squircle-ish corner
  const c1 = [124, 92, 255]; // #7c5cff
  const c2 = [255, 92, 138]; // #ff5c8a
  const tri = playTriangle(S);
  const sub = ss * ss;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = x + (sx + 0.5) / ss;
          const py = y + (sy + 0.5) / ss;
          if (insideRoundRect(px, py, S, S, radius)) bg++;
          if (insideTriangle(px, py, tri)) fg++;
        }
      }
      const bgCov = bg / sub;
      const fgCov = fg / sub;
      const off = (y * S + x) * 4;
      if (bgCov === 0) continue; // transparent outside the squircle
      const t = Math.min(1, Math.max(0, (x + y) / (2 * S)));
      const br = c1[0] + (c2[0] - c1[0]) * t;
      const bg2 = c1[1] + (c2[1] - c1[1]) * t;
      const bb = c1[2] + (c2[2] - c1[2]) * t;
      rgba[off] = Math.round(br * (1 - fgCov) + 255 * fgCov);
      rgba[off + 1] = Math.round(bg2 * (1 - fgCov) + 255 * fgCov);
      rgba[off + 2] = Math.round(bb * (1 - fgCov) + 255 * fgCov);
      rgba[off + 3] = Math.round(bgCov * 255);
    }
  }
  return rgba;
}

// ── tray template: black play glyph on transparent ───────────────────────────
function drawTrayGlyph(S, ss = 4) {
  const rgba = Buffer.alloc(S * S * 4);
  const tri = playTriangle(S);
  const sub = ss * ss;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let fg = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          if (insideTriangle(x + (sx + 0.5) / ss, y + (sy + 0.5) / ss, tri)) fg++;
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

function main() {
  fs.mkdirSync(BUILD_DIR, { recursive: true });

  writePng('icon.png', 1024, 1024, drawAppIcon(1024));
  writePng('trayTemplate.png', 16, 16, drawTrayGlyph(16));
  writePng('trayTemplate@2x.png', 32, 32, drawTrayGlyph(32));

  // macOS: fold icon.png into icon.icns via system tools (no extra deps).
  if (process.platform === 'darwin') {
    const iconset = path.join(BUILD_DIR, 'icon.iconset');
    fs.mkdirSync(iconset, { recursive: true });
    const src = path.join(BUILD_DIR, 'icon.png');
    const sizes = [
      [16, 'icon_16x16.png'],
      [32, 'icon_16x16@2x.png'],
      [32, 'icon_32x32.png'],
      [64, 'icon_32x32@2x.png'],
      [128, 'icon_128x128.png'],
      [256, 'icon_128x128@2x.png'],
      [256, 'icon_256x256.png'],
      [512, 'icon_256x256@2x.png'],
      [512, 'icon_512x512.png'],
      [1024, 'icon_512x512@2x.png'],
    ];
    try {
      for (const [px, out] of sizes) {
        execFileSync('sips', ['-z', String(px), String(px), src, '--out', path.join(iconset, out)], {
          stdio: 'ignore',
        });
      }
      execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(BUILD_DIR, 'icon.icns')]);
      fs.rmSync(iconset, { recursive: true, force: true });
      console.log('wrote build/icon.icns');
    } catch (e) {
      console.warn('icns generation skipped (sips/iconutil failed):', e.message);
    }
  }
}

main();
