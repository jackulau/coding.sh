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
// A page opens with its purpose and then its shortest example:
//   the first block after <h1> is a <p> of at most 2 sentences and 45 words,
//   and a <pre> comes before the second <h2> (NO_EXAMPLE lists the pages that
//   have nothing to run, with the reason).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { distOpts, needDist } from "./_dist.mjs";

// DOCS_DIST points the test at another build, for example an older one.
const DIST = process.env.DOCS_DIST ? process.env.DOCS_DIST.replace(/[\\/]+$/, "") : fileURLToPath(new URL("../dist", import.meta.url));
const LI = 40, P = 70, PAGE = 1800;
const OPEN_SENTENCES = 2, OPEN_WORDS = 45;
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

// Pages with no example to run before the second heading, and why. A page that
// gets an example leaves this list; a test below fails when a listed page has one.
const COMPARE = "a comparison table with sources; there is nothing to run";
const NO_EXAMPLE = new Map([
  ["/docs", "the docs home: it links to the pages that have the examples"],
  ["/docs/compare", COMPARE],
  ["/docs/compare/agentops", COMPARE],
  ["/docs/compare/braintrust", COMPARE],
  ["/docs/compare/ccusage", COMPARE],
  ["/docs/compare/laminar", COMPARE],
  ["/docs/compare/langfuse", COMPARE],
  ["/docs/compare/langsmith", COMPARE],
  ["/docs/concepts", "definitions of terms; the examples sit on the pages that use them"],
  ["/docs/faq", "questions and answers"],
  ["/docs/sdk", "the generated SDK reference; /docs/how-to/trace-your-agent has the example"],
  // Open work: the page has an example, but not before its second heading. Move it up.
  ["/docs/storage", "the first example comes after the second heading"],
  ["/docs/terse-mode", "no example before the second heading"],
  ["/docs/cost", "no example before the second heading"],
  ["/docs/eval-methods", "formulas; no example before the second heading"],
  ["/docs/stores", "no example before the second heading"],
  ["/docs/how-to/attribute-commits", "no example before the second heading"],
  ["/docs/how-to/capture-with-proxy", "no example before the second heading"],
  ["/docs/how-to/ci-regressions", "no example before the second heading"],
  ["/docs/how-to/compare-agents", "no example before the second heading"],
  ["/docs/how-to/does-this-plugin-help", "no example before the second heading"],
  ["/docs/how-to/evaluate-a-skill", "no example before the second heading"],
  ["/docs/how-to/replay-llm-calls", "no example before the second heading"],
  ["/docs/how-to/self-host-team", "no example before the second heading"],
  ["/docs/how-to/test-agents-md-change", "no example before the second heading"],
]);

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

/** The opening of a page: what is wrong with the paragraph under <h1> and with the example before the second <h2>. */
export function openingProblems(html) {
  const main = /<main[^>]*>([\s\S]*?)<\/main>/.exec(html)?.[1];
  if (!main) return [];
  const body = main.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/g, "").replace(/<!--[\s\S]*?-->/g, "");
  const h1 = /<h1[^>]*>[\s\S]*?<\/h1>/.exec(body);
  if (!h1) return [];
  const after = body.slice(h1.index + h1[0].length);
  const out = [];
  const first = /^\s*<(\w+)[^>]*>([\s\S]*?)<\/\1>/.exec(after);
  if (!first || first[1] !== "p") out.push(`opens with ${first ? `<${first[1]}>` : "nothing"}, not a short paragraph`);
  else {
    const t = text(first[2]);
    const sentences = t.split(/[.!?](?=\s|$)/).filter((x) => x.trim()).length;
    const n = words(t).length;
    if (sentences > OPEN_SENTENCES || n > OPEN_WORDS) out.push(`opening paragraph is ${sentences} sentences, ${n} words (budget ${OPEN_SENTENCES} and ${OPEN_WORDS}): ${t.slice(0, 60)}...`);
  }
  const h2 = after.search(/<h2[\s>]/);
  const h2b = h2 < 0 ? -1 : after.slice(h2 + 3).search(/<h2[\s>]/);
  const head = h2b < 0 ? after : after.slice(0, h2 + 3 + h2b);
  if (!/<pre[\s>]/.test(head)) out.push("no <pre> example before the second <h2>");
  return out;
}

const DOCS = join(DIST, "docs");
const opts = distOpts(DOCS);

test("every docs page keeps to the readability budgets", opts, () => {
  needDist(DOCS);
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

test("the pending list holds only pages that are over budget", opts, () => {
  needDist(DOCS);
  const all = new Map(pages());
  const stale = [...PENDING].filter((p) => !all.has(p) || offenders(p, all.get(p)).length === 0);
  assert.deepEqual(stale, [], `remove these from PENDING in test/docs-readable.test.mjs: ${stale.join(", ")}`);
});

test("every docs page opens with a short paragraph and an example", opts, () => {
  needDist(DOCS);
  const found = [];
  for (const [page, html] of pages()) {
    for (const o of openingProblems(html)) {
      if (o.startsWith("no <pre>") && NO_EXAMPLE.has(page)) continue;
      found.push(`${page}: ${o}`);
    }
  }
  assert.deepEqual(found, [], `${found.length} opening(s) to fix; say what the page is for in two sentences, then show the shortest example (or list the page in NO_EXAMPLE with a reason):\n${found.join("\n")}`);
});

test("the NO_EXAMPLE list holds only pages that have no example", opts, () => {
  needDist(DOCS);
  const all = new Map(pages());
  const stale = [...NO_EXAMPLE.keys()].filter((p) => !all.has(p) || !openingProblems(all.get(p)).some((o) => o.startsWith("no <pre>")));
  assert.deepEqual(stale, [], `remove these from NO_EXAMPLE: ${stale.join(", ")}`);
  for (const [page, why] of NO_EXAMPLE) assert.ok(why.length > 10, `${page}: say why it has no example`);
});

test("openingProblems reports the seeded page: a three-sentence opening and no example", () => {
  const long = "A page. It says one thing. It says a second thing and then a third. ".repeat(3);
  const html = `<main><h1>Title</h1><p>${long}</p><h2>One</h2><p>text</p><h2>Two</h2></main>`;
  const problems = openingProblems(html);
  assert.equal(problems.length, 2, problems.join("\n"));
  assert.deepEqual(openingProblems("<main><h1>T</h1><p>Short. One.</p><div class=\"code\"><pre>x</pre></div><h2>A</h2><h2>B</h2></main>"), []);
  assert.match(openingProblems("<main><h1>T</h1><ul><li>x</li></ul><pre>x</pre></main>")[0], /opens with <ul>/);
});
