// The built docs make no claim that a release has already made stale: the
// Python SDK is on PyPI, the package is published, the docs home calls
// coding.sh new rather than "Pre-alpha", headings carry no build-status tags,
// and prose names no coding.sh version (it is stale the next day; the
// changelog keeps the history). Checks dist/docs when a build exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = process.env.DOCS_DIST ? process.env.DOCS_DIST.replace(/[\\/]+$/, "") : fileURLToPath(new URL("../dist", import.meta.url));
const built = existsSync(join(DIST, "docs"));
const skip = !built && "no build in apps/site/dist";

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
const decode = (s) => s.replace(/&(#39|[a-z]+);/gi, (m, e) => NAMED[e.toLowerCase()] ?? m).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
const text = (html) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/** Each built docs page as [path, <main> html]. */
function pages() {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.name === "index.html") {
        const html = readFileSync(abs, "utf8");
        const main = /<main[^>]*>([\s\S]*?)<\/main>/.exec(html)?.[1];
        if (main) out.push([abs.slice(DIST.length).split("\\").join("/").replace(/\/index\.html$/, ""), main]);
      }
    }
  };
  walk(join(DIST, "docs"));
  return out.sort(([a], [b]) => (a < b ? -1 : 1));
}

// Stale the day the release shipped (the Python SDK has been on PyPI since 0.1.6).
const STALE = [/not (?:yet )?on PyPI/i, /once the package is published/i, /until (?:it|the package) is (?:on PyPI|published)/i];

test("no docs page says a shipped package is not published yet", { skip }, () => {
  const found = [];
  for (const [page, main] of pages()) {
    const t = text(main);
    for (const re of STALE) {
      const m = re.exec(t);
      if (m) found.push(`${page}: "${t.slice(Math.max(0, m.index - 40), m.index + m[0].length + 20)}"`);
    }
  }
  assert.deepEqual(found, [], found.join("\n"));
});

test("the docs home does not call coding.sh pre-alpha", { skip }, () => {
  const home = pages().find(([p]) => p === "/docs");
  assert.ok(home, "dist/docs/index.html is missing");
  const t = text(home[1]);
  const at = t.search(/pre-alpha/i);
  assert.equal(at, -1, `/docs says "${t.slice(Math.max(0, at - 40), at + 60)}"; say "coding.sh is new" and link the roadmap`);
});

test("no docs heading carries a (built) or (partial) tag", { skip }, () => {
  const found = [];
  for (const [page, main] of pages()) {
    for (const m of main.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/g)) {
      const t = text(m[2]);
      if (/\(\s*(built|partial)\s*\)/i.test(t)) found.push(`${page}: <h${m[1]}> ${t}`);
    }
  }
  assert.deepEqual(found, [], `say a real gap in one sentence, and list it on /docs/roadmap:\n${found.join("\n")}`);
});

// A coding.sh version in prose: v0.1.4, 0.1.6. Code blocks and inline code are
// left out (an install pin is an example), and so is the CLI reference, which
// prints the version it was generated from. Versions of other software
// (RFC 0.1.0, T3 Code 0.1.7, semconv 1.37.0) are not ours, and neither is the agent release
// the /docs/agents matrix prints after "Verified on a real install (".
const OURS = /(?<![\w.])v?0\.\d{1,2}\.\d{1,3}(?![\w.]*\d)/g;
const THEIRS = /(?:RFC|T3 Code|semconv|Pi|Claude Code|Codex|Cursor|OpenCode|Node(?:\.js)?|Python|schema|spec|real install \()\s*$/i;

test("docs prose names no coding.sh version", { skip }, () => {
  const found = [];
  for (const [page, main] of pages()) {
    if (page === "/docs/cli" || page.startsWith("/docs/cli/")) continue;
    const t = text(main.replace(/<(pre|code|script|style)\b[^>]*>[\s\S]*?<\/\1>/g, " "));
    for (const m of t.matchAll(OURS)) {
      if (THEIRS.test(t.slice(Math.max(0, m.index - 16), m.index))) continue;
      found.push(`${page}: "${t.slice(Math.max(0, m.index - 50), m.index + m[0].length + 20)}"`);
    }
  }
  assert.deepEqual(found, [], `drop the version (the changelog keeps it), or move it into a code block if it is a pin example:\n${found.join("\n")}`);
});
