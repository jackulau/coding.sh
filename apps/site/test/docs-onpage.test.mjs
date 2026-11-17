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
    const top = [...r.matchAll(/<li[^>]*>\s*<a href="#([^"]+)"[^>]*>[^<]*<\/a>\s*(?:<ul[^>]*>([\s\S]*?)<\/ul>)?\s*<\/li>/g)];
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
