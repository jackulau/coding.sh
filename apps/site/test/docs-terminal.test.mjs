// Every code block and terminal on a built docs page shows all of its lines.
// A "<" left unescaped in a terminal's set:html (`<$0.01`, `<task>`) reads as
// the start of a tag: the browser, search and the .md twin then drop text up
// to the next ">" (J4-1 of the 2026-11-11 docs audit). Checks dist/docs when
// a build exists:
//   - inside <pre> and a Terminal body, every "<" opens a known inline tag;
//   - every fenced block of a docs/*.md page is on its built page, line for line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = fileURLToPath(new URL("..", import.meta.url));
const DIST = process.env.DOCS_DIST ? process.env.DOCS_DIST.replace(/[\\/]+$/, "") : join(SITE, "dist");
const built = existsSync(join(DIST, "docs"));
const skip = !built && "no build in apps/site/dist";

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
const decode = (s) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&([a-z]+);/gi, (m, e) => NAMED[e.toLowerCase()] ?? m);

/** Each built docs page as [path, html]. */
function pages() {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.name === "index.html") out.push([abs.slice(DIST.length).split("\\").join("/").replace(/\/index\.html$/, ""), readFileSync(abs, "utf8")]);
    }
  };
  walk(join(DIST, "docs"));
  return out.sort(([a], [b]) => (a < b ? -1 : 1));
}

/** The inside of each element whose opening tag matches `open`, to its balanced close. */
function bodies(html, open, tag) {
  const out = [];
  for (const m of html.matchAll(open)) {
    const start = m.index + m[0].length;
    const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
    re.lastIndex = start;
    let depth = 1;
    for (let t; (t = re.exec(html)); ) {
      depth += t[1] ? -1 : 1;
      if (!depth) {
        out.push(html.slice(start, t.index));
        break;
      }
    }
  }
  return out;
}

// What a terminal or code block may hold: colour spans, links, emphasis, its own <pre>/<code>.
const TAGS = new Set(["span", "code", "pre", "a", "b", "strong", "em", "i", "u", "br", "div", "kbd", "mark", "small", "sup", "sub", "time", "ins", "del", "svg", "path", "button"]);

test("every < in a code block or terminal opens a known tag", { skip }, () => {
  const found = [];
  for (const [page, html] of pages()) {
    const blocks = [...bodies(html, /<pre\b[^>]*>/g, "pre"), ...bodies(html, /<div\b[^>]*\bdata-term-body\b[^>]*>/g, "div")];
    for (const b of blocks) {
      for (const m of b.matchAll(/</g)) {
        const tag = /^<\/?([A-Za-z][\w-]*)(?:\s[^<>]*)?\/?>/.exec(b.slice(m.index));
        if (tag && TAGS.has(tag[1].toLowerCase())) continue;
        const line = b.slice(0, m.index).split("\n").length;
        found.push(`${page}: line ${line} of a block: ${JSON.stringify(b.slice(m.index, m.index + 50))}`);
      }
    }
  }
  assert.deepEqual(found, [], `escape it (&lt;) or render the text with {…} instead of set:html:\n${found.join("\n")}`);
});

/** Pages built from docs/*.md: route → file, from the <MdDoc file="…"> in each page shell. */
function mdPages() {
  const root = join(SITE, "src/pages/docs");
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.name.endsWith(".astro") && !e.name.includes("[")) {
        const file = /<MdDoc\s+file="([^"]+)"/.exec(readFileSync(abs, "utf8"))?.[1];
        if (!file) continue;
        const route = ("/docs/" + relative(root, abs).split("\\").join("/").replace(/\.astro$/, "")).replace(/\/index$/, "").replace(/\/$/, "");
        out.push([route, file]);
      }
    }
  };
  walk(root);
  return out;
}

const codes = (blocks) =>
  blocks.flatMap((b) => (b.kind === "code" ? [b.code] : b.kind === "tabs" ? b.tabs.map((t) => t.code) : b.kind === "more" || b.kind === "note" ? codes(b.blocks) : []));
// What Code.astro shows: leading blank lines and trailing whitespace trimmed.
const shown = (code) => code.replace(/^\n+|\s+$/g, "");

test("every fenced block of a docs/*.md page is on its built page, line for line", { skip }, async () => {
  const { renderDoc } = await import("../src/components/docs/markdown.ts");
  const built = new Map(pages());
  const found = [];
  for (const [route, file] of mdPages()) {
    const html = built.get(route);
    if (!html) continue;
    const rendered = new Set(bodies(html, /<pre class="code__body"[^>]*>/g, "pre").map((b) => decode(b.replace(/<[^>]+>/g, ""))));
    for (const code of codes(renderDoc(file, route))) {
      const want = shown(code);
      if (rendered.has(want)) continue;
      found.push(`${route} (docs/${file}): a ${want.split("\n").length}-line block starting ${JSON.stringify(want.split("\n")[0].slice(0, 60))} is missing or cut`);
    }
  }
  assert.deepEqual(found, [], found.join("\n"));
});
