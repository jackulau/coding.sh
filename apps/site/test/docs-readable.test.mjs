// The docs pages stay readable at a glance. The same budgets as
// tasks/tools/docs-readability.py, applied to the built pages in dist/docs
// when a build exists. Counted is the visible text inside <main>, without
// code blocks, nav, asides, scripts and styles; table cells are left out of
// the bullet and paragraph counts but count toward the page total.
//   a list item  <= 40 words
//   a paragraph  <= 70 words
//   a guide page <= 1800 words (reference pages are exempt from the total)
// A long bullet about one flag belongs in a table row; depth belongs in a
// <details class="more"> block or on the page that owns it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// DOCS_DIST points the test at another build, for example an older one.
const DIST = process.env.DOCS_DIST ? process.env.DOCS_DIST.replace(/[\\/]+$/, "") : fileURLToPath(new URL("../dist", import.meta.url));
const LI = 40, P = 70, PAGE = 1800;
const REFERENCE = [
  "/docs/config",
  "/docs/sdk",
  "/docs/api",
  "/docs/troubleshooting",
  "/docs/cli",
  "/docs/trace-format",
  "/docs/query",
  "/docs/stores",
  "/docs/eval-methods",
];

// Pending: pages that still break a budget and are waiting for a rewrite.
// Only pages that really are over budget belong here; a test below fails when
// one of them comes back under, so the list shrinks. Empty since the docs
// regroup of 2026-11-11.
const PENDING = new Set([]);

const under = (page, prefix) => page === prefix || page.startsWith(prefix + "/");

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", rarr: "\u2192", larr: "\u2190", mdash: "\u2014", ndash: "\u2013", hellip: "\u2026", middot: "\u00b7", times: "\u00d7", copy: "\u00a9" };
const unescape = (s) =>
  s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(n); } catch { return m; }
    }
    return NAMED[e] ?? NAMED[e.toLowerCase()] ?? m;
  });
const words = (s) => s.split(/\s+/).filter(Boolean);
const text = (x) => words(unescape(x.replace(/<[^>]+>/g, " "))).join(" ");
const inner = (s, re) => [...s.matchAll(re)].map((m) => text(m[1]));

/** Each built docs page as [path, html], e.g. ["/docs/experiments", "<!doctype ..."]. */
function pages() {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.name === "index.html") {
        const page = abs.slice(DIST.length).split("\\").join("/").replace(/\/index\.html$/, "");
        out.push([page, readFileSync(abs, "utf8")]);
      }
    }
  };
  walk(join(DIST, "docs"));
  return out.sort(([a], [b]) => (a < b ? -1 : 1));
}

/** The budgets one page breaks, as "kind N words: first words...". */
function offenders(page, html) {
  const m = /<main[^>]*>([\s\S]*?)<\/main>/.exec(html);
  if (!m) return [];
  // A diagram's labels are not prose (its figure caption is counted).
  const b = m[1].replace(/<(pre|nav|aside|script|style|svg)\b[^>]*>[\s\S]*?<\/\1>/g, "");
  const prose = b.replace(/<table[^>]*>[\s\S]*?<\/table>/g, "");
  const out = [];
  for (const x of inner(prose, /<li\b[^>]*>([\s\S]*?)<\/li>/g)) {
    const n = words(x).length;
    if (n > LI) out.push(`bullet ${n} words: ${x.slice(0, 70)}...`);
  }
  for (const x of inner(prose, /<p\b[^>]*>([\s\S]*?)<\/p>/g)) {
    const n = words(x).length;
    if (n > P) out.push(`paragraph ${n} words: ${x.slice(0, 70)}...`);
  }
  const total = words(text(b)).length;
  if (total > PAGE && !REFERENCE.some((r) => under(page, r))) out.push(`page ${total} words (budget ${PAGE})`);
  return out;
}

const built = existsSync(join(DIST, "docs"));
const skip = !built && "no build in apps/site/dist";

test("every docs page keeps to the readability budgets", { skip }, () => {
  const found = [];
  for (const [page, html] of pages()) {
    if (PENDING.has(page)) continue;
    for (const o of offenders(page, html)) found.push(`${page}: ${o}`);
  }
  assert.deepEqual(found, [], `${found.length} budget(s) broken; cut the text, make a table, or move depth into <details class="more">:\n${found.join("\n")}`);
});

test("a screenshot or a diagram is not read as a paragraph or a bullet", () => {
  const many = (n) => Array(n).fill("word").join(" ");
  const html = `<main><figure><picture><img alt="${many(80)}"></picture><figcaption>${many(10)}</figcaption></figure><p>short</p>` +
    `<figure class="diagram"><svg><line x1="0"/><path d="M0 0"/><text>${many(80)}</text></svg></figure><ul><li>${many(5)}</li></ul></main>`;
  assert.deepEqual(offenders("/docs/x", html), []);
  assert.deepEqual(offenders("/docs/x", `<main><p>${many(71)}</p><ul><li>${many(41)}</li></ul></main>`).map((o) => o.split(":")[0]), ["bullet 41 words", "paragraph 71 words"]);
});

test("the pending list holds only pages that are over budget", { skip }, () => {
  const all = new Map(pages());
  const stale = [...PENDING].filter((p) => !all.has(p) || offenders(p, all.get(p)).length === 0);
  assert.deepEqual(stale, [], `remove these from PENDING in test/docs-readable.test.mjs: ${stale.join(", ")}`);
});
