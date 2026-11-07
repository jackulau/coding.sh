import assert from "node:assert/strict";
import { test } from "node:test";
import { compare, headline, normalized, WEIGHTS } from "../score.mjs";
import { meets } from "../bench.mjs";
import { parseTapSummary } from "../conformance.mjs";
import { bootstrapMedianDiff, nearestRank, quantile, wilson } from "../lib/util.mjs";

const gatesOk = { typecheck: true, tests: true, build: true, siteBuild: true };

test("weights sum to 100", () => {
  assert.equal(Object.values(WEIGHTS).reduce((a, b) => a + b, 0), 100);
});

test("headline is null with gated list when a gate fails", () => {
  const h = headline({ ...gatesOk, tests: false }, { "cli.guidelines": { value: 1 } });
  assert.equal(h.headline, null);
  assert.deepEqual(h.gated, ["tests"]);
});

test("headline is 100 when every component is perfect", () => {
  const c = {
    "cli.heldout.success": { value: 1 },
    "cli.invalidRate": { value: 0 },
    "cli.guidelines": { value: 1 },
    "replay.success": { value: 1 },
    "conformance.fixtures": { value: 1 },
    "conformance.smoke": { value: 1 },
    "capture.health": { value: 1 },
    "perf.hook": { value: 5, met: true },
    "site.js": { value: 1, met: true },
    "site.council": { value: 2 },
  };
  const h = headline(gatesOk, c);
  assert.equal(h.headline, 100);
  assert.equal(h.coverage, 1);
});

test("normalization follows the doc table and rescales missing weight", () => {
  const n = normalized({ "cli.invalidRate": { value: 0.1 }, "perf.hook": { met: true }, "perf.help": { met: false }, "site.js": { met: true }, "site.council": { value: 0 } });
  assert.equal(n["cli.invalidRate"], 0.5);
  assert.equal(n.perf, 0.5);
  assert.equal(n.site, 0.6 * 1 + 0.4 * 0.5);
  const h = headline(gatesOk, { "cli.guidelines": { value: 0.5 }, "perf.hook": { met: true } });
  // guidelines 10 × 0.5 + perf 10 × 1 over 20 weight
  assert.equal(h.headline, 75);
  assert.equal(h.coverage, 0.2);
  assert.ok(h.missing.includes("cli.heldout.success"));
});

test("compare is direction-aware", () => {
  const r = compare({ headline: 1, components: { "perf.hook": { value: 8 }, "cli.guidelines": { value: 0.9 } } }, { headline: 1, components: { "perf.hook": { value: 9 }, "cli.guidelines": { value: 1 } } });
  assert.equal(r.components["perf.hook"].direction, "better");
  assert.equal(r.components["cli.guidelines"].direction, "worse");
});

test("perf budgets", () => {
  assert.equal(meets("perf.hook", 10), true);
  assert.equal(meets("perf.hook", 10.1), false);
  assert.equal(meets("perf.ingest", 5000), true);
  assert.equal(meets("perf.ingest", 4999), false);
  assert.equal(meets("perf.storeSize", 2.5), false);
  assert.equal(meets("perf.viewerTti", null), undefined);
});

test("TAP summary parsing", () => {
  assert.deepEqual(parseTapSummary("# tests 150\n# suites 53\n# pass 149\n# fail 1\n# skipped 0\n"), { tests: 150, pass: 149, fail: 1, skipped: 0, todo: undefined, cancelled: undefined });
});

test("stats helpers", () => {
  assert.equal(nearestRank([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.equal(nearestRank([1, 2, 3, 4], 50), 2);
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  const [lo, hi] = wilson(5, 10);
  assert.ok(lo > 0.2 && lo < 0.25 && hi > 0.75 && hi < 0.8);
  const d = bootstrapMedianDiff([10, 11, 12, 10, 11, 12, 10, 11], [20, 21, 22, 20, 21, 22, 20, 21]);
  assert.equal(d.diff, 10);
  assert.ok(d.ci[0] > 8 && d.ci[1] < 12);
});
