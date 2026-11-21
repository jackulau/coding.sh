// Viewer fixes from hands-on QA (round 6), run straight from the page's own script: a duration axis
// labels a whole minute "1m", not "1m 0s", and a subagent whose type is "subagent" (t3code) gets one
// "subagent" badge, not "subagent · subagent".
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

const html = readFileSync(new URL("../../src/viewer/ui/index.html", import.meta.url), "utf8");

function slice(from: string, to: string): string {
  const a = html.indexOf(from);
  const b = html.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `markers ${from} .. ${to}`);
  return html.slice(a, b);
}

const f: any = runInNewContext(`${slice("function fmtDuration(", "function fmtClock(")}\n({ fmtDuration, fmtDurationTick, subagentBadge })`, { String, Math, isFinite });

test("a duration axis tick drops a zero tail, so a whole minute reads 1m", () => {
  assert.equal(f.fmtDurationTick(60_000), "1m");
  assert.equal(f.fmtDurationTick(80_000), "1m 20s");
  assert.equal(f.fmtDurationTick(3_600_000), "1h");
  assert.equal(f.fmtDurationTick(90 * 60_000), "1h 30m");
  assert.equal(f.fmtDurationTick(2 * 86_400_000), "2d");
  assert.equal(f.fmtDurationTick(25_000), "25s");
  assert.equal(f.fmtDurationTick(0), "0ms");
  // The value itself keeps its full form.
  assert.equal(f.fmtDuration(60_000), "1m 0s");
  const p95 = slice('{ id: "llm-p95"', "\n");
  assert.match(p95, /tick: fmtDurationTick/, "the p95 chart uses the tick form");
});

test("a subagent's badge names its type only when the type adds something", () => {
  assert.equal(f.subagentBadge("subagent"), "subagent");
  assert.equal(f.subagentBadge("Subagent"), "subagent");
  assert.equal(f.subagentBadge("workflow-subagent"), "subagent · workflow-subagent");
  assert.equal(f.subagentBadge("Explore"), "subagent · Explore");
  assert.equal(f.subagentBadge(""), "subagent");
  assert.match(html, /h\("span", \{ class: "badge" \}, subagentBadge\(s\.parent\.type\)\)/, "the header badge uses it");
});
