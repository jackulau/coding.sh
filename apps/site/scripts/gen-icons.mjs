// Writes every favicon from one cube: public/favicon.svg, favicon.ico (16+32),
// icon-16.png, icon-32.png, apple-touch-icon.png (180), icon-192.png,
// icon-512.png. Run: npm run icons
//
// The art is a pixel-art cube on a 2:1 grid: white top, light grey left,
// dark grey right, on a black rounded tile so it reads on light and dark tab
// bars. 16px and 32px are drawn pixel by pixel (a pixel is lit when its centre
// is inside a face), so their edges stay crisp instead of being a blurred
// downscale. Bigger sizes are the same geometry with 4x4 supersampling.
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const OUT = new URL("../public/", import.meta.url).pathname;
const TOP = [0xff, 0xff, 0xff], LEFT = [0xbd, 0xbd, 0xbd], RIGHT = [0x7a, 0x7a, 0x7a], TILE = [0, 0, 0];

// The cube on a 32-unit grid, 28 units wide and tall (88% of the canvas).
const FACES = [
  { c: TOP, p: [[16, 2], [30, 9], [16, 16], [2, 9]] },
  { c: LEFT, p: [[2, 9], [16, 16], [16, 30], [2, 23]] },
  { c: RIGHT, p: [[16, 16], [30, 9], [30, 23], [16, 30]] },
];

const inside = (x, y, poly) => {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
};

/** Colour at a point of the 32-unit canvas: a face, the tile, or transparent. */
function sample(x, y, { radius, scale, tile }) {
  // Cube, scaled about the centre (scale < 1 adds padding for touch icons).
  const cx = 16 + (x - 16) / scale, cy = 16 + (y - 16) / scale;
  for (const f of FACES) if (inside(cx, cy, f.p)) return [...f.c, 255];
  if (!tile) return [0, 0, 0, 0];
  // Rounded tile.
  const r = radius, qx = Math.max(r - x, x - (32 - r), 0), qy = Math.max(r - y, y - (32 - r), 0);
  return qx * qx + qy * qy <= r * r ? [...TILE, 255] : [0, 0, 0, 0];
}

function render(size, opts) {
  const ss = size <= 32 ? 1 : 4; // pixel centres for small sizes, supersampled above
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const u = ((x + (sx + 0.5) / ss) / size) * 32, v = ((y + (sy + 0.5) / ss) / size) * 32;
          const [cr, cg, cb, ca] = sample(u, v, opts);
          r += cr * ca; g += cg * ca; b += cb * ca; a += ca;
        }
      const i = (y * size + x) * 4;
      px[i] = a ? r / a : 0; px[i + 1] = a ? g / a : 0; px[i + 2] = a ? b / a : 0; px[i + 3] = a / (ss * ss);
    }
  return png(size, px);
}

// Minimal PNG encoder: RGBA, no filter.
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
function png(size, px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

// ICO with PNG entries (supported by every current browser and crawler).
function ico(images) {
  const head = Buffer.alloc(6 + images.length * 16);
  head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(([size, data], i) => {
    const e = 6 + i * 16;
    head[e] = size; head[e + 1] = size;
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...images.map(([, d]) => d)]);
}

// The SVG favicon: the 32px pixel map as crisp rects, so at 32px (a 2x tab)
// it matches the PNG exactly.
function svg() {
  const rows = { tile: [], top: [], left: [], right: [] };
  const key = (c) => (c[3] === 0 ? null : c[0] === 255 ? "top" : c[0] === 0xbd ? "left" : c[0] === 0x7a ? "right" : "tile");
  for (let y = 0; y < 32; y++) {
    let x = 0;
    while (x < 32) {
      const k = key(sample(x + 0.5, y + 0.5, SMALL));
      let e = x + 1;
      while (e < 32 && key(sample(e + 0.5, y + 0.5, SMALL)) === k) e++;
      if (k) rows[k].push(`M${x} ${y}h${e - x}v1h-${e - x}z`);
      x = e;
    }
  }
  const path = (k, fill) => `<path fill="${fill}" d="${rows[k].join("")}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" shape-rendering="crispEdges">${path("tile", "#000")}${path("top", "#fff")}${path("left", "#bdbdbd")}${path("right", "#7a7a7a")}</svg>\n`;
}

const SMALL = { radius: 6, scale: 1, tile: true };
const p16 = render(16, SMALL), p32 = render(32, SMALL);
const files = {
  "favicon.svg": svg(),
  "favicon.ico": ico([[16, p16], [32, p32]]),
  "icon-16.png": p16,
  "icon-32.png": p32,
  // Touch and manifest icons: full black square (the OS rounds it) with padding.
  "apple-touch-icon.png": render(180, { radius: 0, scale: 0.78, tile: true }),
  "icon-192.png": render(192, { radius: 0, scale: 0.78, tile: true }),
  "icon-512.png": render(512, { radius: 0, scale: 0.78, tile: true }),
};
for (const [name, data] of Object.entries(files)) writeFileSync(OUT + name, data);
console.log(`icons written: ${Object.keys(files).join(", ")}`);
