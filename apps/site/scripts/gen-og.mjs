// Writes the 1200x630 Open Graph images: public/og-image.png for the site and
// public/og/<page>.png for the changelog and every docs page (title overlay).
// Black background, the solid voxel cube, "coding.sh" and a title.
// Needs rsvg-convert (brew install librsvg). Run: npm run og
import { writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOC_PAGES } from "../src/components/docs/nav.ts";
import { cubeSvg } from "../src/lib/cube.ts";

const PUBLIC = new URL("../public/", import.meta.url).pathname;
const font = (f) => readFileSync(join(PUBLIC, "fonts", f)).toString("base64");
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
  const size = title.length > 34 ? 64 : 76;
  const tl = lines(title, size === 76 ? 22 : 28);
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

const tmp = join(tmpdir(), `og-${process.pid}`);
mkdirSync(tmp, { recursive: true });
mkdirSync(join(PUBLIC, "og"), { recursive: true });
function png(name, spec) {
  const src = join(tmp, name.replace(/\//g, "_") + ".svg");
  writeFileSync(src, svg(spec));
  execFileSync("rsvg-convert", ["-w", "1200", "-h", "630", "-o", join(PUBLIC, name + ".png"), src]);
}

png("og-image", { title: "Traces and evals for AI agents.", sub: "Open source, local-first, MIT licensed." });
png("og/changelog", { kicker: "changelog", title: "Changelog", sub: "Every release, newest first." });
for (const p of DOC_PAGES) {
  const slug = p.path === "/docs" ? "docs" : `docs-${p.path.slice("/docs/".length).replace(/\//g, "-")}`;
  png(`og/${slug}`, { kicker: "docs", title: p.title, sub: "coding.sh docs" });
}
rmSync(tmp, { recursive: true, force: true });
rmSync(join(PUBLIC, "og-image.svg"), { force: true });
console.log(`og images written: og-image.png, og/changelog.png, ${DOC_PAGES.length} docs pages`);
