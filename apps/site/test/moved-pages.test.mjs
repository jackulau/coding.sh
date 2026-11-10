// A docs page that moved keeps its old URL: the worker answers the old path
// with a 301 to the new one, which must be a page in the docs nav.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/index.ts";
import { MOVED } from "../worker/moved.ts";
import { DOC_PAGES } from "../src/components/docs/nav.ts";

const env = { ASSETS: { fetch: async () => new Response("asset", { status: 200 }) } };
const get = (path) => worker.fetch(new Request(`https://coding.sh${path}`), env);

test("a moved page answers 301 to its new path, query kept", async () => {
  assert.ok(Object.keys(MOVED).length > 0);
  for (const [from, to] of Object.entries(MOVED)) {
    for (const [path, want] of [[from, to], [`${from}/`, to], [`${from}?ref=x`, `${to}?ref=x`], [`${from}.md`, `${to}.md`]]) {
      const res = await get(path);
      assert.equal(res.status, 301, path);
      assert.equal(res.headers.get("Location"), `https://coding.sh${want}`, path);
    }
  }
});

test("a moved page's new path is a docs page, and its old path is not", () => {
  const paths = new Set(DOC_PAGES.map((p) => p.path));
  for (const [from, to] of Object.entries(MOVED)) {
    assert.ok(paths.has(to), `${to} is not in the docs nav`);
    assert.ok(!paths.has(from), `${from} is still in the docs nav`);
  }
});

test("other paths reach the static assets", async () => {
  for (const path of ["/", "/docs/how-to/test-agents-md-change", "/docs/how-to/compare-agents.md"]) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    assert.equal(await res.text(), "asset", path);
  }
});
