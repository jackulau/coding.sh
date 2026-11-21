// Viewer fixes from hands-on QA (round 7), run straight from the page's own script: the zero tick
// of a duration axis takes the unit of the ticks beside it, and a file change has one name in the
// step list and in its pane.
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

const f: any = runInNewContext(`${slice("function fmtDuration(", "function fmtClock(")}\n${slice("function changeVerb(", "\n")}\n({ fmtDurationTick, changeVerb })`, { String, Math, isFinite });

test("a duration axis labels zero in the unit of its other ticks", () => {
  assert.equal(f.fmtDurationTick(0, [0, 25_000, 50_000, 75_000]), "0s");
  assert.equal(f.fmtDurationTick(0, [0, 60_000, 120_000]), "0m");
  assert.equal(f.fmtDurationTick(0, [0, 3_600_000]), "0h");
  assert.equal(f.fmtDurationTick(0, [0, 500, 1000]), "0ms");
  // Ticks with a tail (1m 30s) give zero the tail unit, as the first tick ends.
  assert.equal(f.fmtDurationTick(0, [0, 90_000, 180_000]), "0s");
  // Without the other ticks, or with none above zero, zero stays as it was.
  assert.equal(f.fmtDurationTick(0), "0ms");
  assert.equal(f.fmtDurationTick(0, [0]), "0ms");
  // The other ticks read as before.
  assert.equal(f.fmtDurationTick(25_000, [0, 25_000]), "25s");
  assert.match(slice("const yl = h(\"div\", { class: \"ch-y\"", "s.style.top"),/o\.fmtTick\(t, o\.ticks\)/, "the chart hands its ticks to the formatter");
});

test("a file change has one name in the step list and in its pane", () => {
  assert.equal(f.changeVerb("add"), "Added");
  assert.equal(f.changeVerb("delete"), "Deleted");
  assert.equal(f.changeVerb("edit"), "Changed");
  assert.equal(f.changeVerb(undefined), "Changed");
  assert.match(html, /const verb = changeVerb\(p\.op\);/, "the step row uses it");
  assert.match(html, /h\("h2", \{ class: "pane-title" \}, h\("span", \{ class: "tool" \}, changeVerb\(p\.op\)\)/, "the pane heading uses it");
  assert.doesNotMatch(html, /"Edit "/, "no pane says Edit for a change the list calls Changed");
});
