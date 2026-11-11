// Links on the built docs go straight to a docs page: never to a repo doc on
// GitHub (the site has its own page for each one a reader needs), and never to
// a path in worker/moved.ts (the 301 works, but a link should name the page it
// means). Checks dist/docs (pages and their .md twins) when a build exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MOVED } from "../worker/moved.ts";

const DIST = process.env.DOCS_DIST ? process.env.DOCS_DIST.replace(/[\\/]+$/, "") : fileURLToPath(new URL("../dist", import.meta.url));
const built = existsSync(join(DIST, "docs"));
const skip = !built && "no build in apps/site/dist";

/** Every built docs file as [site path, text]: the pages, their .md twins, and /docs.md. */
function files() {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.name.endsWith(".html") || e.name.endsWith(".md")) out.push([abs.slice(DIST.length).split("\\").join("/"), readFileSync(abs, "utf8")]);
    }
  };
  walk(join(DIST, "docs"));
  if (existsSync(join(DIST, "docs.md"))) out.push(["/docs.md", readFileSync(join(DIST, "docs.md"), "utf8")]);
  return out.sort(([a], [b]) => (a < b ? -1 : 1));
}

const lineOf = (text, at) => text.slice(0, at).split("\n").length;

test("no docs page links a repo doc on GitHub", { skip }, () => {
  const found = [];
  for (const [file, text] of files()) {
    for (const m of text.matchAll(/github\.com\/jackulau\/coding\.sh\/(?:blob|tree)\/[^/\s"')]+\/docs\/[^\s"')#]*/g)) found.push(`${file}:${lineOf(text, m.index)}: ${m[0]}`);
  }
  assert.deepEqual(found, [], `link the site page instead (markdown.ts SITE_PAGES maps docs/*.md to it):\n${found.join("\n")}`);
});

test("no docs page links a path that moved", { skip }, () => {
  const found = [];
  const old = (p) => MOVED[p.replace(/\.md$/, "").replace(/(.)\/+$/, "$1")];
  for (const [file, text] of files()) {
    // href="/docs/x", href="https://coding.sh/docs/x", and Markdown ](https://coding.sh/docs/x) in the twins.
    for (const m of text.matchAll(/(?:href="|\]\()(?:https:\/\/coding\.sh)?(\/docs[^"#?)\s]*)/g)) {
      const to = old(m[1]);
      if (to) found.push(`${file}:${lineOf(text, m.index)}: ${m[1]} (link ${to})`);
    }
  }
  assert.deepEqual(found, [], `these links go through a 301 in worker/moved.ts:\n${found.join("\n")}`);
});
