// A link to an id inside a closed <details> opens it: /docs/faq folds each
// answer under its question, and every docs page carries a small inline script
// that, on load and on hashchange, opens each closed <details> around the
// target and scrolls to it. Checks the built pages in dist when there is a build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { distOpts, needDist } from "./_dist.mjs";

const DIST = fileURLToPath(new URL("../dist", import.meta.url));
const page = (path) => readFileSync(join(DIST, path, "index.html"), "utf8");

/** The inline script that opens <details> for the hash, from a built page. */
function opener(html) {
  const found = [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((s) => /onhashchange/.test(s));
  assert.equal(found.length, 1, "one inline script handles the hash");
  return found[0];
}

/** A tiny DOM: elements with a parent, an open flag for <details>, and closest() for the one selector the script uses. */
function el(tag, parent, attrs = {}) {
  const e = {
    tag,
    parentElement: parent ?? null,
    // HTMLDetailsElement.open is a boolean property: it coerces what it is given.
    o: false,
    get open() {
      return this.o;
    },
    set open(v) {
      this.o = !!v;
    },
    scrolled: 0,
    ...attrs,
    closest(sel) {
      assert.equal(sel, "details:not([open])");
      for (let n = this; n; n = n.parentElement) if (n.tag === "details" && !n.open) return n;
      return null;
    },
    scrollIntoView() {
      this.scrolled++;
    },
  };
  return e;
}

function run(script, ids, hash) {
  const location = { hash };
  const ctx = vm.createContext({ location, document: { getElementById: (id) => ids[id] ?? null } });
  vm.runInContext(script, ctx);
  return { ctx, location };
}

test("/docs/faq: each answer folds under its question, which keeps its id and self-link", distOpts(DIST), () => {
  needDist(DIST);
  const html = page("docs/faq");
  const main = html.match(/<main[\s\S]*<\/main>/)[0];
  const folds = [...main.matchAll(/<details class="more faq"[^>]*>\s*<summary[^>]*>\s*<h2 id="([^"]+)"[^>]*>\s*<a class="h-anchor"[^>]*href="#([^"]+)"/g)];
  assert.ok(folds.length >= 10, `one <details> per question, found ${folds.length}`);
  for (const [, id, href] of folds) assert.equal(href, id, `the question ${id} links to itself`);
  assert.equal((main.match(/<h2[ >]/g) ?? []).length, folds.length, "every question is inside a fold");
  assert.doesNotMatch(main, /<details class="more faq"[^>]*\sopen/, "answers start closed");
});

test("/docs/troubleshooting stays open, so find-in-page reaches every answer", distOpts(DIST), () => {
  needDist(DIST);
  const main = page("docs/troubleshooting").match(/<main[\s\S]*<\/main>/)[0];
  assert.doesNotMatch(main, /<summary[^>]*>\s*<h[23]/, "no heading folded into a summary");
});

test("a hash inside closed <details> opens each one around it and scrolls to the target", distOpts(DIST), () => {
  needDist(DIST);
  const script = opener(page("docs/faq"));
  // On load: the target sits in an inner fold inside an outer fold, both closed.
  const outer = el("details");
  const inner = el("details", el("div", outer));
  const target = el("h3", el("summary", inner));
  const other = el("details");
  const { ctx, location } = run(script, { "own-agent": target }, "#own-agent");
  assert.equal(outer.open && inner.open, true, "both folds open on load");
  assert.equal(other.open, false, "a fold elsewhere stays closed");
  assert.equal(target.scrolled, 1, "the target is scrolled into view");

  // On hashchange: a closed fold opens; a target already in view is left where it is.
  const later = el("details");
  const deep = el("p", later);
  const plain = el("h2", el("main"));
  Object.assign(ctx.document, { getElementById: (id) => ({ deep, plain })[id] ?? null });
  location.hash = "#deep";
  ctx.onhashchange();
  assert.equal(later.open, true, "the fold opens on hashchange");
  assert.equal(deep.scrolled, 1);
  location.hash = "#plain";
  ctx.onhashchange();
  assert.equal(plain.scrolled, 0, "no scroll when nothing was closed");
  // A hash that names nothing, or is not valid percent-encoding, does nothing.
  for (const h of ["#nope", "#%E0%A4%A", ""]) {
    location.hash = h;
    assert.doesNotThrow(() => ctx.onhashchange());
  }
});

test("every docs page carries the opener once, :::more pages included", distOpts(DIST), () => {
  needDist(DIST);
  for (const p of ["docs/quickstart", "docs/privacy", "docs/troubleshooting", "docs/cli"]) opener(page(p));
});
