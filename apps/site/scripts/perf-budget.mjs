// Perf budget gate for the built site. Reads dist only, needs no browser, and
// exits 1 when a page goes over budget, so the Site workflow stops before deploy.
//
//   node scripts/perf-budget.mjs               static checks on dist
//   node scripts/perf-budget.mjs --dist <dir>  check another build
//
// Budgets sit about 10% above the numbers in docs/perf.md, so ordinary copy
// edits pass. If a change really needs more, raise the number here in the same
// commit and say why in the message. Load times (Lighthouse) are budgeted in
// scripts/perf/budgets.json and checked by .github/workflows/site-perf.yml.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, extname, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants } from "node:zlib";

const KB = 1024;
const BUDGET = {
  // Brotli q11, per page. The CLI and API references are generated and grow
  // with the tool, so they get their own room.
  htmlBrotli: { "/": 24.5 * KB, "/docs/cli/": 30 * KB, "/docs/api/": 30 * KB, other: 26 * KB },
  preloadFonts: 28.5 * KB, // woff2 bytes preloaded by one page (26.0KB today)
  moduleScripts: 1, // external <script type="module" src> per page
  // The cards are lossless PNG (gen-og.mjs, compressionLevel 9). Palette
  // quantization would get them near 25KB but changes pixels, so the budget
  // sits above the largest lossless card (og-image.png, 36.7KB).
  ogPng: 40 * KB, // each social card
};

const distArg = process.argv.indexOf("--dist");
const DIST = resolve(distArg > 0 ? process.argv[distArg + 1] : join(dirname(fileURLToPath(import.meta.url)), "..", "dist"));
if (!existsSync(join(DIST, "index.html"))) {
  console.error(`perf-budget: no build at ${DIST}; run npm run build first`);
  process.exit(1);
}

// Failures are grouped by message, so one shared regression prints once with
// the pages it hits instead of once per page.
const failures = new Map();
const fail = (where, msg) => failures.set(msg, [...(failures.get(msg) ?? []), where]);
const fmt = (n) => `${(n / KB).toFixed(1)}KB`;
const read = (p) => readFileSync(p, "utf8");
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
// A site path like /docs/cli/x.js maps to dist/docs/cli/x.js.
const distFile = (href) => join(DIST, decodeURIComponent(href.split(/[?#]/)[0]));
const attr = (tag, name) => tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"))?.slice(1).find((v) => v !== undefined);
const hasAttr = (tag, name) => new RegExp(`\\s${name}(\\s|=|/?>)`, "i").test(tag);

const pages = walk(DIST)
  .filter((f) => f.endsWith(".html") && !relative(DIST, f).startsWith("pagefind"))
  .map((f) => {
    const rel = "/" + relative(DIST, f).replace(/index\.html$/, "");
    return { file: f, path: rel, html: read(f) };
  })
  .sort((a, b) => a.path.localeCompare(b.path));

// 1. HTML weight on the wire.
let worstHtml = { size: 0 };
for (const p of pages) {
  const size = brotliCompressSync(readFileSync(p.file), { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
  const max = BUDGET.htmlBrotli[p.path] ?? BUDGET.htmlBrotli.other;
  if (size > max) fail(p.path, `HTML is ${fmt(size)} brotli, budget ${fmt(max)}`);
  if (size / max > (worstHtml.size / worstHtml.max || 0)) worstHtml = { path: p.path, size, max };
}

// 2. Preloaded fonts.
let worstFonts = { size: 0 };
for (const p of pages) {
  let size = 0;
  for (const tag of p.html.match(/<link\b[^>]*>/gi) ?? []) {
    if (attr(tag, "rel") !== "preload" || attr(tag, "as") !== "font") continue;
    const f = distFile(attr(tag, "href") ?? "");
    if (!existsSync(f)) fail(p.path, `preloaded font ${attr(tag, "href")} is missing from dist`);
    else size += statSync(f).size;
  }
  if (size > BUDGET.preloadFonts) fail(p.path, `preloads ${fmt(size)} of fonts, budget ${fmt(BUDGET.preloadFonts)}`);
  if (size > worstFonts.size) worstFonts = { path: p.path, size };
}

// 3. Startup JS: one external module per page, and no static imports from any
// startup module (a static import is a shared chunk on the critical path).
const staticImport = /(?<![\w$.])import\s*(?:["'`]|[\w$*{][^;()"'`]*?\bfrom\s*["'`])/;
let worstScripts = { n: 0 };
for (const p of pages) {
  const scripts = [...p.html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(([, a]) => attr(`<s ${a}>`, "type") === "module");
  const external = scripts.filter(([, a]) => attr(`<s ${a}>`, "src"));
  if (external.length > BUDGET.moduleScripts)
    fail(p.path, `${external.length} external module scripts, budget ${BUDGET.moduleScripts} (${external.map(([, a]) => attr(`<s ${a}>`, "src")).join(", ")})`);
  if (external.length > worstScripts.n) worstScripts = { path: p.path, n: external.length };
  for (const [, a, body] of scripts) {
    const src = attr(`<s ${a}>`, "src");
    const code = src ? (existsSync(distFile(src)) ? read(distFile(src)) : "") : body;
    if (src && !code) fail(p.path, `module script ${src} is missing from dist`);
    const hit = code.match(staticImport);
    if (hit) fail(p.path, `startup module ${src ?? "(inline)"} has a static import: ${code.slice(hit.index, hit.index + 60)}`);
  }
}

// 4. Images: the first screenshot is the LCP candidate, and every image reserves its box.
let imgCount = 0;
for (const p of pages) {
  const shotAt = p.html.search(/<figure\b[^>]*\sclass\s*=\s*"(?:[^"]*\s)?shot(?:\s[^"]*)?"/i);
  if (shotAt >= 0) {
    const img = p.html.slice(shotAt).match(/<img\b[^>]*>/i)?.[0] ?? "";
    if (attr(img, "loading") !== "eager" || attr(img, "fetchpriority") !== "high")
      fail(p.path, `first .shot img must be loading="eager" fetchpriority="high"`);
  }
  for (const img of p.html.match(/<img\b[^>]*>/gi) ?? []) {
    imgCount++;
    if (!hasAttr(img, "width") || !hasAttr(img, "height")) fail(p.path, `img without width/height: ${img.slice(0, 100)}`);
  }
}

// 5. No page may need a *-rest font subset. Those faces exist only for rare
// glyphs; if a page uses one, its text reflows when the extra file arrives.
const decode = (s) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&(nbsp|amp|lt|gt|quot|apos|copy|middot|rarr|larr|hellip|mdash|ndash);/g, (_, n) =>
      ({ nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", copy: "©", middot: "·", rarr: "→", larr: "←", hellip: "…", mdash: "—", ndash: "–" })[n],
    );
const cssEscapes = (s) => s.replace(/\\([0-9a-f]{1,6})\s?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
const parseRange = (r) =>
  r.split(",").map((part) => {
    const [a, b] = part.trim().replace(/^u\+/i, "").split("-");
    if (a.includes("?")) return [parseInt(a.replace(/\?/g, "0"), 16), parseInt(a.replace(/\?/g, "f"), 16)];
    return [parseInt(a, 16), parseInt(b ?? a, 16)];
  });
const cssFor = (p) => {
  const inline = [...p.html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
  const linked = (p.html.match(/<link\b[^>]*>/gi) ?? [])
    .filter((t) => attr(t, "rel") === "stylesheet" && existsSync(distFile(attr(t, "href") ?? "")))
    .map((t) => read(distFile(attr(t, "href"))));
  return [...inline, ...linked].join("\n");
};
let restFaces = 0;
for (const p of pages) {
  const css = cssFor(p);
  const rest = [];
  for (const [, body] of css.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
    const url = body.match(/url\(\s*["']?([^"')]+)/i)?.[1] ?? "";
    const range = body.match(/unicode-range\s*:\s*([^;}]+)/i)?.[1];
    if (/-rest\b[^/]*\.woff2$/i.test(url) && range) rest.push({ url, ranges: parseRange(range) });
  }
  restFaces = Math.max(restFaces, rest.length);
  if (!rest.length) continue;
  const text =
    decode(
      p.html
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
        .replace(/<[^>]*\splaceholder\s*=\s*"([^"]*)"[^>]*>/gi, " $1 ")
        .replace(/<[^>]+>/g, " "),
    ) + [...css.matchAll(/content\s*:\s*(["'])(.*?)\1/g)].map((m) => cssEscapes(m[2])).join("");
  const hits = new Map();
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    for (const f of rest) if (f.ranges.some(([a, b]) => cp >= a && cp <= b)) hits.set(ch, f.url);
  }
  for (const [ch, url] of hits)
    fail(p.path, `uses U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")} "${ch}", which only ${url} has`);
}

// 6. Social cards.
const ogFiles = [join(DIST, "og-image.png"), ...(existsSync(join(DIST, "og")) ? walk(join(DIST, "og")) : [])].filter(
  (f) => extname(f) === ".png" && existsSync(f),
);
let worstOg = { size: 0 };
for (const f of ogFiles) {
  const size = statSync(f).size;
  if (size > BUDGET.ogPng) fail(relative(DIST, f), `${fmt(size)}, budget ${fmt(BUDGET.ogPng)}`);
  if (size > worstOg.size) worstOg = { file: relative(DIST, f), size };
}

console.log(`perf-budget: ${pages.length} pages, ${imgCount} images, ${ogFiles.length} OG cards`);
console.log(`  html     ${worstHtml.path} ${fmt(worstHtml.size)} of ${fmt(worstHtml.max)} (closest to budget)`);
console.log(`  fonts    ${worstFonts.path ?? "-"} preloads ${fmt(worstFonts.size)} of ${fmt(BUDGET.preloadFonts)}`);
console.log(`  scripts  ${worstScripts.path ?? "-"} has ${worstScripts.n} of ${BUDGET.moduleScripts} external modules`);
console.log(`  rest     ${restFaces} *-rest font faces checked`);
console.log(`  og       ${worstOg.file ?? "-"} ${fmt(worstOg.size)} of ${fmt(BUDGET.ogPng)}`);

if (failures.size) {
  for (const [msg, where] of failures) {
    const at = where.length > 3 ? `${where.slice(0, 3).join(", ")} and ${where.length - 3} more` : where.join(", ");
    console.log(`${process.env.GITHUB_ACTIONS ? "::error::perf budget: " : "  FAIL "}${at}: ${msg}`);
  }
  console.log(`perf-budget: ${failures.size} over budget`);
  process.exit(1);
}
console.log("perf-budget: ok");
