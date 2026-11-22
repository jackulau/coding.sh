// The viewer's number, time and count formatters, run straight from the page's own script
// (they are plain functions with no DOM), so the page and the test cannot drift apart.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { duration } from "../../src/cli/output.ts";

const html = readFileSync(new URL("../../src/viewer/ui/index.html", import.meta.url), "utf8");

function slice(from: string, to: string): string {
  const a = html.indexOf(from);
  const b = html.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `markers ${from} .. ${to}`);
  return html.slice(a, b);
}

const src = [slice("const nf = new Intl.NumberFormat();", "function fmtDate("), slice("function midClip(", "function clip("), slice("function summaryLine(", "\n}\n") + "\n}"].join("\n");
const f: any = runInNewContext(`${src}\n({ plural, fmtNum, fmtCompact, fmtCost, fmtDuration, fmtRel, summaryLine, midClip })`, { Intl, Date, String, Number, Math, isFinite });

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

test("compact counts never read 1000k, and reach billions", () => {
  assert.equal(f.fmtCompact(0), "0");
  assert.equal(f.fmtCompact(999), "999");
  assert.equal(f.fmtCompact(1000), "1.0k");
  assert.equal(f.fmtCompact(1234), "1.2k");
  assert.equal(f.fmtCompact(9999), "10k");
  assert.equal(f.fmtCompact(12_345), "12k");
  assert.equal(f.fmtCompact(999_950), "1.0M");
  assert.equal(f.fmtCompact(999_999_999), "1.0B");
  assert.equal(f.fmtCompact(1.5e9), "1.5B");
});

test("costs get a thousands separator, and compact past $100k", () => {
  assert.equal(f.fmtCost(0.00004), "<$0.0001");
  assert.equal(f.fmtCost(0.0042), "$0.0042");
  assert.equal(f.fmtCost(1.5), "$1.50");
  assert.equal(f.fmtCost(42.4), "$42");
  assert.equal(f.fmtCost(1234.5), "$1,235");
  assert.equal(f.fmtCost(99_999.4), "$99,999");
  assert.equal(f.fmtCost(123_456), "$123k");
  assert.equal(f.fmtCost(12_345_678.9), "$12M");
});

test("long durations roll up to days", () => {
  assert.equal(f.fmtDuration(90_000), "1m 30s");
  assert.equal(f.fmtDuration(23 * 3600e3 + 59 * 60e3), "23h 59m");
  assert.equal(f.fmtDuration(24 * 3600e3), "1d 0h");
  assert.equal(f.fmtDuration(1284 * 3600e3 + 12 * 60e3), "53d 12h");
});

test("durations round the whole value to the unit shown, as the CLI does, so a carry moves up a unit", () => {
  assert.equal(f.fmtDuration(8_975_379), "2h 30m");
  assert.equal(f.fmtDuration(119_600), "2m 0s");
  assert.equal(f.fmtDuration(3_599_600), "1h 0m");
  assert.equal(f.fmtDuration(23 * 3600e3 + 59 * 60e3 + 40e3), "1d 0h");
  // Under a day the viewer prints the CLI's value in its own spacing: "2h 5m" where the CLI prints "2h05m".
  const asCli = (s: string) => s.replace(/^(\d+)([hm]) (\d+)([ms])$/, (_, a: string, u: string, b: string, v: string) => a + u + b.padStart(2, "0") + v);
  const values = [0, 999.4, 999.5, 9_949, 9_950, 59_499, 59_500, 119_600, 3_599_499, 3_599_500, 8_975_379, 86_369_999];
  for (let ms = 0; ms < 86_000e3; ms += 7919) values.push(ms);
  for (const ms of values) assert.equal(asCli(f.fmtDuration(ms)), duration(ms), `${ms} ms`);
});

test("long ids that differ at the end keep both ends", () => {
  const a = "claude-opus-5-5-20261001-thinking-high-extended-preview-a";
  const b = "claude-opus-5-5-20261001-thinking-high-extended-preview-b";
  assert.equal(f.midClip("gpt-6.1-sol", 22), "gpt-6.1-sol");
  assert.equal(f.midClip(a, 22).length, 22);
  assert.notEqual(f.midClip(a, 22), f.midClip(b, 22));
  assert.match(f.midClip(a, 22), /^claude-opus.*….*-a$/);
});

test("compare bar axes fit a grader score gap above 1 (objective grader) and keep pass-rate gaps within ±1", () => {
  const ns: (x: number) => number = runInNewContext(`${slice("function niceSpan(", "\n")}\nniceSpan`);
  assert.equal(ns(0.05), 0.1);
  assert.equal(ns(0.4), 0.5);
  assert.equal(ns(0.95), 1);
  assert.equal(ns(1), 1);
  assert.equal(ns(1.5), 2);
  assert.equal(ns(2.5), 3);
  assert.equal(ns(3), 5);
  assert.equal(ns(12), 14);
});
