// A link to an id inside a closed <details> opens it: /docs/faq folds each
// answer under its question, and every docs page carries a small inline script
// that, on load, on hashchange and after a click on a link with a hash, opens
// the target when it is a closed <details> and each closed <details> around
// it, and scrolls to it. Checks the built pages in dist when there is a build.
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
  const timers = [];
  const ctx = vm.createContext({ location, setTimeout: (f) => timers.push(f), document: { getElementById: (id) => ids[id] ?? null } });
  vm.runInContext(script, ctx);
  return { ctx, location, timers };
}

test("/docs/faq: each answer folds under its question, a plain-text summary on a <details> that carries the id", distOpts(DIST), () => {
  needDist(DIST);
  const html = page("docs/faq");
  const main = html.match(/<main[\s\S]*<\/main>/)[0];
  const folds = [...main.matchAll(/<details class="more faq" id="([^"]+)"[^>]*>\s*<summary[^>]*>([\s\S]*?)<\/summary>/g)];
  assert.ok(folds.length >= 10, `one <details> per question, found ${folds.length}`);
  // A heading or link inside <summary> loses its role to the disclosure button and adds a second tab stop.
  for (const [, id, q] of folds) assert.doesNotMatch(q, /</, `the question ${id} is plain text in its summary`);
  assert.doesNotMatch(main, /<h2[ >]/, "no h2 left to fold into a summary");
  // The drawn + and − have empty alt text, so a question's name is its words alone.
  assert.match(html, /content:\s*"\+"\s*\/\s*""/, "the + is not read as part of the name");
  assert.equal((main.match(/<details class="more faq"/g) ?? []).length, folds.length, "every fold has an id");
  assert.doesNotMatch(main, /<details class="more faq"[^>]*\sopen/, "answers start closed");
  // The "On this page" rail lists each question, linked to its <details>.
  const rail = html.match(/data-onpage[\s\S]*?<\/aside>/)?.[0] ?? "";
  for (const [, id] of folds) assert.match(rail, new RegExp(`href="#${id}"`), `the rail links to ${id}`);
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

test("a closed <details> that is itself the target opens", distOpts(DIST), () => {
  needDist(DIST);
  // /docs/quickstart#init and /docs/otel#claude-code name the <details> itself.
  const outer = el("details");
  const target = el("details", el("div", outer));
  run(opener(page("docs/quickstart")), { init: target }, "#init");
  assert.equal(target.open && outer.open, true, "the target and the fold around it open");
  assert.equal(target.scrolled, 1);
});

test("a click on a same-page hash link opens the fold, though the router fires no hashchange", distOpts(DIST), () => {
  needDist(DIST);
  // The ClientRouter moves to a same-page hash with pushState, so no hashchange
  // fires: the click itself runs the opener, after the router has moved.
  const target = el("details");
  const { ctx, location, timers } = run(opener(page("docs/faq")), { config: target }, "");
  assert.equal(typeof ctx.onclick, "function", "a click handler, set once like onhashchange");
  const link = { closest: (sel) => (sel === "a[href*='#']" ? link : null) };
  const text = { closest: () => null };
  ctx.onclick({ target: text });
  assert.equal(timers.length, 0, "a click on anything but a hash link does nothing");
  ctx.onclick({ target: link });
  location.hash = "#config";
  for (const f of timers.splice(0)) f();
  assert.equal(target.open, true, "the answer opens after the router moves to its hash");
  assert.equal(target.scrolled, 1);
  // Closed again by the reader, it stays closed on clicks that are not hash links.
  target.open = false;
  ctx.onclick({ target: text });
  assert.equal(timers.length, 0);
  assert.equal(target.open, false);
});

test("every docs page carries the opener once, :::more pages included", distOpts(DIST), () => {
  needDist(DIST);
  for (const p of ["docs/quickstart", "docs/privacy", "docs/troubleshooting", "docs/cli"]) opener(page(p));
});

test("the FAQ question styles ship on /docs/faq only, and outrank .more > summary in any order", distOpts(DIST), () => {
  needDist(DIST);
  const faq = page("docs/faq");
  // .more > summary (doc.css) sets padding too and may come later in the page.
  assert.match(faq, /\.doc \.faq\s*>\s*summary\s*\{[^}]*padding-block/);
  assert.match(faq, /\.doc \.faq:target\s*>\s*summary/);
  assert.doesNotMatch(page("docs/cli"), /\.faq\b/);
});
