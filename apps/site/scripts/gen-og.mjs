// Writes the 1200x630 Open Graph images: public/og-image.png for the site and
// public/og/<page>.png for the changelog, the blog, every blog post and every
// docs page (title overlay).
// Black background, the solid voxel cube, "coding.sh" and a title.
// Needs rsvg-convert (brew install librsvg). Run: npm run og
// `--missing` (run by `npm run build`) writes only the cards that don't exist
// yet, so a new docs page gets its card; without rsvg-convert it warns and the
// page falls back to the site card.
// rsvg-convert's PNGs are then re-encoded losslessly with sharp (zlib level 9,
// no alpha channel since the background is opaque): pixel-identical, ~30% smaller.
import { writeFileSync, readFileSync, readdirSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Checked before anything else is loaded, so `--missing` (the build) only warns
// on a machine without rsvg-convert, or on a Node that can't import .ts files.
const MISSING_ONLY = process.argv.includes("--missing");
function skip(why) {
  console.warn(`og: ${why}; pages without a card use /og-image.png`);
  process.exit(MISSING_ONLY ? 0 : 1);
}
try {
  execFileSync("rsvg-convert", ["--version"], { stdio: "ignore" });
} catch {
  skip("rsvg-convert not found (brew install librsvg)");
}
let DOC_PAGES, cubeSvg, sharp, cards, manifest, manifestEntry;
try {
  ({ DOC_PAGES } = await import("../src/components/docs/nav.ts"));
  ({ cards, manifest, manifestEntry } = await import("./og-cards.mjs"));
  ({ cubeSvg } = await import("../src/lib/cube.ts"));
  ({ default: sharp } = await import("sharp"));
} catch (err) {
  skip(`could not load the page list (${String(err.message).split("\n")[0]})`);
}

const PUBLIC = new URL("../public/", import.meta.url).pathname;
// Full source fonts live in src/assets/fonts/source; public/fonts is the old home.
const SOURCE_FONTS = new URL("../src/assets/fonts/source/", import.meta.url).pathname;
const FONTS = existsSync(SOURCE_FONTS) ? SOURCE_FONTS : join(PUBLIC, "fonts");
const font = (f) => readFileSync(join(FONTS, f)).toString("base64");
const sans = font("geist-latin.woff2");
const mono = font("geist-mono-latin.woff2");
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const cube = cubeSvg(undefined, undefined, 100);

/** Wraps a title onto at most three lines of roughly `max` characters. */
function lines(text, max) {
  const out = [];
  for (const word of text.split(" ")) {
    const last = out[out.length - 1];
    if (last && (last + " " + word).length <= max) out[out.length - 1] = last + " " + word;
    else out.push(word);
  }
  return out.slice(0, 3);
}

function svg({ kicker, title, sub }) {
  // Lines wrap short enough to stay left of the cube (x ≈ 830).
  const size = title.length > 34 ? 64 : 76;
  const tl = lines(title, size === 76 ? 18 : 22);
  const top = 300 - ((tl.length - 1) * size * 1.05) / 2;
  const scale = 300 / cube.height;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<style>@font-face{font-family:G;src:url(data:font/woff2;base64,${sans}) format("woff2");font-weight:400 700}@font-face{font-family:GM;src:url(data:font/woff2;base64,${mono}) format("woff2");font-weight:400 700}</style>
<rect width="1200" height="630" fill="#000"/>
<g transform="translate(${1100 - cube.width * scale} ${315 - (cube.height * scale) / 2}) scale(${scale})">${cube.body}</g>
<text x="88" y="112" font-family="GM, Geist Mono, monospace" font-weight="600" font-size="34" fill="#f4f4f5">coding<tspan fill="#8b8b92">.sh</tspan>${kicker ? `<tspan fill="#5c5c63"> / </tspan><tspan fill="#8b8b92">${esc(kicker)}</tspan>` : ""}</text>
${tl.map((l, i) => `<text x="88" y="${top + i * size * 1.05}" font-family="G, Geist, sans-serif" font-weight="600" font-size="${size}" letter-spacing="-2.5" fill="#f4f4f5">${esc(l)}</text>`).join("\n")}
<text x="88" y="${top + (tl.length - 1) * size * 1.05 + 70}" font-family="G, Geist, sans-serif" font-size="28" fill="#8b8b92">${esc(sub)}</text>
<text x="88" y="560" font-family="GM, Geist Mono, monospace" font-size="22" fill="#5c5c63">curl -fsSL https://coding.sh/install | sh</text>
</svg>
`;
}

const list = cards(DOC_PAGES);
const MANIFEST = join(PUBLIC, "og", "manifest.json");
// What each card was drawn from. `--missing` draws a card that has no PNG and a
// card whose title or template differs from this record.
let recorded = {};
try {
  recorded = JSON.parse(readFileSync(MANIFEST, "utf8"));
} catch {}
const stale = (c) => {
  const r = recorded[c.name];
  const e = manifestEntry(c);
  return !r || r.title !== e.title || r.template !== e.template;
};

const tmp = join(tmpdir(), `og-${process.pid}`);
mkdirSync(tmp, { recursive: true });
mkdirSync(join(PUBLIC, "og"), { recursive: true });
let written = 0;
for (const c of list) {
  if (MISSING_ONLY && existsSync(join(PUBLIC, c.name + ".png")) && !stale(c)) continue;
  written++;
  const src = join(tmp, c.name.replace(/\//g, "_") + ".svg");
  writeFileSync(src, svg(c));
  const raw = execFileSync("rsvg-convert", ["-w", "1200", "-h", "630", src], { maxBuffer: 64 << 20 });
  await sharp(raw).removeAlpha().png({ compressionLevel: 9 }).toFile(join(PUBLIC, c.name + ".png"));
}
writeFileSync(MANIFEST, JSON.stringify(manifest(list), null, 2) + "\n");
rmSync(tmp, { recursive: true, force: true });
rmSync(join(PUBLIC, "og-image.svg"), { force: true });
console.log(MISSING_ONLY ? `og: ${written} missing or changed card(s) written` : `og images written: ${list.length} cards`);
