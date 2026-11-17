// The docs sidebar folds by group on every screen size: each group is a
// <details>, and at build time only the first group and the group that holds
// the page are open. Checks the built pages in dist when there is a build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { distOpts, needDist } from "./_dist.mjs";

const DIST = fileURLToPath(new URL("../dist", import.meta.url));

/** Each docs nav on a built page (the sidebar, then the phone menu) as its groups in order. */
function navs(path) {
  const html = readFileSync(join(DIST, path, "index.html"), "utf8");
  const found = [...html.matchAll(/<nav class="docs__(toc|menu-list)"([^>]*)>([\s\S]*?)<\/nav>/g)];
  return found.map(([, kind, attrs, inner]) => ({
    kind,
    label: attrs.match(/aria-label="([^"]*)"/)?.[1],
    groups: [...inner.matchAll(/<details class="docs__fold"([^>]*)>\s*<summary[^>]*>\s*([^<]*?)\s*</g)].map((m) => ({
      name: m[2],
      open: /\sopen(\s|=|$)/.test(m[1]),
    })),
    current: inner.match(/<a href="([^"]*)"[^>]*aria-current="page"/)?.[1],
  }));
}

const CASES = [
  { path: "docs/quickstart", open: ["Get started"], current: "/docs/quickstart" },
  { path: "docs/evals", open: ["Get started", "Evaluate"], current: "/docs/evals" },
  { path: "docs/cli/eval", open: ["Get started", "Reference"], current: "/docs/cli" },
];

for (const c of CASES) {
  test(`/${c.path}: the sidebar and the menu open ${c.open.join(" and ")} only`, distOpts(DIST), () => {
    needDist(DIST);
    const all = navs(c.path);
    assert.deepEqual(all.map((n) => n.kind), ["toc", "menu-list"], "one sidebar nav and one menu nav");
    for (const n of all) {
      assert.ok(n.label, `the ${n.kind} nav has an aria-label`);
      assert.equal(n.groups.length, 8, `the ${n.kind} nav has one <details> per group`);
      assert.deepEqual(n.groups.filter((g) => g.open).map((g) => g.name), c.open, `open groups in the ${n.kind} nav`);
      assert.equal(n.current, c.current, `the ${n.kind} nav marks the current page`);
    }
  });
}
