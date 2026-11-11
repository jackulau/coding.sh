// The viewer's number, time and count formatters, run straight from the page's own script
// (they are plain functions with no DOM), so the page and the test cannot drift apart.
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

const src = [slice("const nf = new Intl.NumberFormat();", "function fmtDate("), slice("function summaryLine(", "\n}\n") + "\n}"].join("\n");
const f: any = runInNewContext(`${src}\n({ plural, fmtNum, fmtCompact, fmtCost, fmtDuration, fmtRel, summaryLine })`, { Intl, Date, String, Number, Math, isFinite });

test("counts of one read in the singular", () => {
  assert.equal(f.plural(1, "tool call"), "1 tool call");
  assert.equal(f.plural(2, "tool call"), "2 tool calls");
  assert.equal(f.plural(0, "tool call"), "0 tool calls");
  assert.deepEqual([...f.summaryLine({ sessions: 1, toolCalls: 1, llmCalls: 1 })], ["1 session", "1 tool call", "1 model call"]);
  assert.deepEqual([...f.summaryLine({ sessions: 2, toolCalls: 3, llmCalls: 1234 })], ["2 sessions", "3 tool calls", "1.2k model calls"]);
});

test("relative times: past, a minute of skew, and the future", () => {
  const now = Date.now();
  assert.equal(f.fmtRel(0), "");
  assert.equal(f.fmtRel(now - 5_000), "just now");
  assert.equal(f.fmtRel(now + 20_000), "just now");
  assert.equal(f.fmtRel(now - 5 * 60_000 - 500), "5m ago");
  assert.equal(f.fmtRel(now - 3 * 3600_000 - 500), "3h ago");
  assert.equal(f.fmtRel(now + 5 * 60_000 + 500), "in 5m");
  assert.equal(f.fmtRel(now + 3 * 3600_000 + 500), "in 3h");
  assert.equal(f.fmtRel(now + 2 * 86400_000 + 500), "in 2d");
});
