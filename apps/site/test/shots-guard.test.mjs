// The landing screenshots are rasters, so their text cannot be grepped. The
// capture script reads each page's visible text before it shoots and refuses a
// page that shows the vendor instructions file name, the test-jargon status
// label, a dev host and port, or placeholder data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertCleanText, dirtyText } from "../scripts/shots/clean-text.mjs";

const read = (p) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), "utf8");

test("dirtyText catches each seeded string", () => {
  assert.equal(dirtyText(["see ", "claude", ".md"].join("")).length, 1);
  assert.equal(dirtyText(["fixture", "tested"].join("-")).length, 1);
  assert.equal(dirtyText("Viewer at http://localhost:4319/").length, 1);
  assert.equal(dirtyText("127.0.0.1:4319").length, 1);
  assert.equal(dirtyText("Sample data").length, 1);
  assert.equal(dirtyText("Acme Corp").length, 1);
});

test("dirtyText passes the viewer's own words", () => {
  assert.deepEqual(dirtyText("Sessions 47\nclaude-code 29\nUse the --since flag. A sample of 5 runs per task."), []);
});

test("assertCleanText throws with the shot's name", () => {
  assert.throws(() => assertCleanText("running on localhost:4319", "hero"), /hero: the page shows text a screenshot must not carry[\s\S]*dev host/);
  assert.doesNotThrow(() => assertCleanText("claude-code 29 sessions", "hero"));
});

test("capture.mjs checks the page text before every screenshot", () => {
  const src = read("scripts/shots/capture.mjs");
  assert.match(src, /import \{ assertCleanText \} from "\.\/clean-text\.mjs"/);
  const clean = (src.match(/assertCleanText\(/g) ?? []).length;
  const shots = (src.match(/page\.screenshot\(/g) ?? []).length;
  assert.ok(clean >= 2, "assertCleanText is not called");
  // Both screenshot helpers (shot, stitch) call the guard first.
  for (const fn of ["async function shot(", "async function stitch("]) {
    const body = src.slice(src.indexOf(fn), src.indexOf(fn) + 400);
    assert.match(body, /assertCleanText\(/, `${fn} does not call assertCleanText before shooting`);
  }
  assert.ok(shots >= 1);
});
