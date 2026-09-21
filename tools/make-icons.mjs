/*
 * Generates the extension icons:  node tools/make-icons.mjs
 *
 * Chrome wants PNGs at several sizes and will not take an SVG, so the artwork
 * is drawn here and encoded directly. Only node:zlib is needed -- a PNG is a
 * signature plus three chunks, and the pixels are deflated scanlines.
 *
 * The mark is a keyhole on the deep blue used by the panel header: the deal is
 * hidden, and this is what opens it. Everything is supersampled 4x and boxed
 * down, which is what keeps the curves clean at 16px.
 */

import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";

const SIZES = [16, 32, 48, 128];
const OUT = path.join(import.meta.dirname, "..", "icons");

const NAVY = [13, 46, 110]; // #0d2e6e, the panel header colour
const WHITE = [255, 255, 255];
const SS = 4; // supersampling factor

/* ------------------------------------------------------------------ *
 * Drawing
 * ------------------------------------------------------------------ */

// Signed distance to a rounded rectangle, used for the tile itself.
function insideRoundedRect(x, y, w, h, r) {
  const dx = Math.max(Math.abs(x - w / 2) - (w / 2 - r), 0);
  const dy = Math.max(Math.abs(y - h / 2) - (h / 2 - r), 0);
  return dx * dx + dy * dy <= r * r;
}

function insideCircle(x, y, cx, cy, r) {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

// The keyhole stem: a trapezoid widening towards the bottom.
function insideStem(x, y, size) {
  const top = size * 0.52;
  const bottom = size * 0.75;
  if (y < top || y > bottom) return false;
  const t = (y - top) / (bottom - top);
  const halfWidth = size * (0.055 + 0.055 * t);
  return Math.abs(x - size / 2) <= halfWidth;
}

// Returns RGBA for one supersampled point.
function sample(x, y, size) {
  if (!insideRoundedRect(x, y, size, size, size * 0.22)) return [0, 0, 0, 0];
  const hole =
    insideCircle(x, y, size / 2, size * 0.42, size * 0.17) ||
    insideStem(x, y, size);
  return hole ? [...WHITE, 255] : [...NAVY, 255];
}

function render(size) {
  const big = size * SS;
  const px = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [sr, sg, sb, sa] = sample(
            ((x * SS + sx + 0.5) / big) * size,
            ((y * SS + sy + 0.5) / big) * size,
            size
          );
          // Premultiply so transparent corners do not darken the edge.
          const w = sa / 255;
          r += sr * w;
          g += sg * w;
          b += sb * w;
          a += sa;
        }
      }
      const n = SS * SS;
      const alpha = a / n;
      const un = alpha > 0 ? 255 / a : 0;
      const i = (y * size + x) * 4;
      px[i] = Math.round(r * un);
      px[i + 1] = Math.round(g * un);
      px[i + 2] = Math.round(b * un);
      px[i + 3] = Math.round(alpha);
    }
  }
  return px;
}

/* ------------------------------------------------------------------ *
 * PNG encoding
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10-12 stay zero: deflate, adaptive filtering, no interlace

  // Each scanline is prefixed with its filter type; 0 means none.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ */

fs.mkdirSync(OUT, { recursive: true });
for (const size of SIZES) {
  const file = path.join(OUT, "icon" + size + ".png");
  fs.writeFileSync(file, encodePng(size, render(size)));
  console.log("wrote " + path.relative(process.cwd(), file));
}
