// The "On this page" rail lists each h2 and, nested under it, its h3s. A
// Tabs block's steps stay under their tab label, once. Checks the built
// pages in dist when there is a build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { distOpts, needDist } from "./_dist.mjs";

const DIST = fileURLToPath(new URL("../dist", import.meta.url));
const read = (path) => readFileSync(join(DIST, path, "index.html"), "utf8");
const rail = (html) => html.match(/<aside class="onpage"[\s\S]*?<\/aside>/)?.[0] ?? "";
const hrefs = (s) => [...s.matchAll(/<a href="#([^"]+)"/g)].map((m) => m[1]);
/** h2 and h3 ids in the article, in order, with the h2s Tabs keeps out of the rail left out. */
function headings(html) {
  const main = html.match(/<main[\s\S]*?<\/main>/)[0];
  return [...main.matchAll(/<h([23]) id="([^"]+)"([^>]*)>/g)].filter((m) => !/data-in-tabs/.test(m[3])).map((m) => ({ level: Number(m[1]), id: m[2] }));
}

for (const path of ["docs/sdk", "docs/config", "docs/api/read"]) {
  test(`/${path}: the rail has one entry per h2 and h3, each h3 inside its h2's entry`, distOpts(DIST), () => {
    needDist(DIST);
    const html = read(path);
    const r = rail(html);
    const hs = headings(html);
    assert.ok(hs.some((h) => h.level === 3), "the page has h3s");
    assert.deepEqual(hrefs(r), hs.map((h) => h.id), "rail entries match the headings, in order");
    // Each h2 entry: <li><a href="#h2">..</a><ul><li><a href="#h3">..</a></li>...</ul></li>
    const top = [...r.matchAll(/<li[^>]*>\s*<a href="#([^"]+)"[^>]*>(?:[^<]|<wbr>)*<\/a>\s*(?:<ul[^>]*>([\s\S]*?)<\/ul>)?\s*<\/li>/g)];
    let at = -1;
    for (const h of hs) {
      if (h.level === 2) {
        at = top.findIndex((m) => m[1] === h.id);
        assert.ok(at >= 0, `#${h.id} is a top-level entry`);
      } else if (at >= 0) {
        assert.ok(hrefs(top[at][2] ?? "").includes(h.id), `#${h.id} sits in the list under #${top[at][1]}`);
      }
    }
  });
}

test("/docs/quickstart: each tab step is listed once, under its tab", distOpts(DIST), () => {
  needDist(DIST);
  const ids = hrefs(rail(read("docs/quickstart")));
  assert.equal(new Set(ids).size, ids.length, "no entry twice");
  assert.ok(ids.includes("your-agent") && ids.includes("coding-agent"), "the tab labels are listed");
});

// Below 1280px the same list is a closed "On this page" dropdown at the top of
// the article: one <details> that CSS shows open as the rail on wide screens.
for (const path of ["docs/sdk", "docs/quickstart"]) {
  test(`/${path}: "On this page" is one closed <details> above the article`, distOpts(DIST), () => {
    needDist(DIST);
    const html = read(path);
    const r = rail(html);
    assert.equal((html.match(/<aside class="onpage"/g) ?? []).length, 1, "one copy of the list");
    const d = r.match(/<details\b[^>]*>\s*<summary\b[^>]*>On this page<\/summary>/);
    assert.ok(d, "a <details> whose summary reads On this page");
    assert.ok(!/\sopen\b/.test(d[0].match(/<details\b[^>]*>/)[0]), "closed by default");
    assert.ok(hrefs(r.slice(r.indexOf("</summary>"))).length >= 2, "the entries sit inside the details");
    assert.ok(html.indexOf('<aside class="onpage"') < html.indexOf("<main"), "placed before the article");
  });
}

// The rail hides the other h2s' h3s to stay short; the dropdown below 1280px
// lists every h3, so a reader (or a keyboard) reaches observe() from the top.
const LAYOUT = readFileSync(new URL("../src/components/docs/DocsLayout.astro", import.meta.url), "utf8");
/** The CSS inside `@media (min-width: 1280px) { ... }` blocks, balanced. */
function wideBlocks(css) {
  const out = [];
  for (const m of css.matchAll(/@media \(min-width: 1280px\) \{/g)) {
    let depth = 1, i = m.index + m[0].length;
    for (; depth && i < css.length; i++) depth += css[i] === "{" ? 1 : css[i] === "}" ? -1 : 0;
    out.push(css.slice(m.index, i));
  }
  return out;
}
test("only the wide rail hides the h3s of the h2s not being read", () => {
  const rule = /\.onpage:has\(\[data-active\]\) li:not\(:has\(\[data-active\]\)\) > ul\s*\{\s*display:\s*none/g;
  const css = LAYOUT.slice(LAYOUT.indexOf("<style>"));
  const wide = wideBlocks(css).join("\n");
  assert.equal((css.match(rule) ?? []).length, 1, "one rule hides them");
  assert.equal((wide.match(rule) ?? []).length, 1, "and it sits in the 1280px media query");
});

// An API path in the rail wraps at its slashes and commas, never inside a word
// ("event / s"): a <wbr> after each "/" in a path and each ", ", and no
// overflow-wrap: anywhere on the rail links.
test("/docs/api/read: rail labels break at path segments, not mid-word", distOpts(DIST), () => {
  needDist(DIST);
  const r = rail(read("docs/api/read"));
  assert.match(r, />\s*GET \/api\/<wbr>sessions\/<wbr>\{id\}\/<wbr>outline\s*<\/a>/, "a <wbr> after each path slash");
  assert.match(r, /\/<wbr>fork, <wbr>POST \/api\//, "a <wbr> after a list comma");
  const css = LAYOUT.slice(LAYOUT.indexOf("<style>"));
  for (const rule of css.matchAll(/([^{}]*\.onpage[^{}]*)\{([^}]*)\}/g)) {
    assert.doesNotMatch(rule[2], /overflow-wrap:\s*anywhere/, `${rule[1].trim()} does not break words anywhere`);
  }
  assert.match(css, /\.onpage__link \{[^}]*overflow-wrap: break-word/, "a word longer than the rail still wraps");
});
