// Run: node --no-warnings --test scripts/perf/test/*.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { analyzeMetrics, metricMatches } from "../../../packages/coding.sh/src/experiments/metrics.ts";
import { checkBudgets, checkGate, minEffect } from "../gate.mjs";
import { PAGES } from "../lighthouse.mjs";

const BUDGETS = JSON.parse(readFileSync(new URL("../budgets.json", import.meta.url), "utf8"));
const fill = (v) => Array(9).fill(v);

// An exp metrics result with one pair per index: arm 0 gets base[i], arm 1 cand[i].
function result(metrics) {
  const pairs = Object.values(metrics)[0].base.length;
  const runs = [];
  for (let i = 0; i < pairs; i++) {
    for (const arm of [0, 1]) {
      const m = {};
      for (const [name, v] of Object.entries(metrics)) m[name] = (arm ? v.cand : v.base)[i];
      runs.push({ pair: i + 1, arm, startedAt: 0, durationMs: 1, metrics: m });
    }
  }
  const seed = 7;
  return { runs, pairs, seed, alpha: 0.05, correction: "holm", metrics: analyzeMetrics(runs, { seed }).metrics };
}

// Mobile home LCP from run 42663796506 (a version bump): about 1646 ms, every pair a little slower.
const base = [1630, 1641, 1646, 1652, 1638, 1660, 1644, 1649, 1655];

test("a significant 0.9% LCP change does not fail the gate", () => {
  const deltas = [9, 11, 13, 14, 15, 16, 18, 22, 38];
  const r = result({ "mobile.home.lcp_ms": { base, cand: base.map((x, i) => x + deltas[i]) } });
  assert.equal(r.metrics[0].verdict, "worse", "coding.sh calls it worse");
  const g = checkGate(r);
  assert.deepEqual(g.failures, []);
  assert.equal(g.small.length, 1);
  assert.match(g.small[0], /^mobile\.home\.lcp_ms got worse/);
});

test("a 10% LCP regression fails the gate", () => {
  const r = result({ "mobile.home.lcp_ms": { base, cand: base.map((x, i) => Math.round(x * 1.1) + (i % 3) * 7) } });
  const g = checkGate(r);
  assert.equal(g.failures.length, 1);
  assert.match(g.failures[0], /^mobile\.home\.lcp_ms got worse: 1646 -> 18\d\d/);
});

test("one added byte of script still fails the gate", () => {
  const js = [6800, 6800, 6800, 6800, 6800, 6800, 6800, 6800, 6800];
  const g = checkGate(result({ "mobile.home.js_bytes": { base: js, cand: js.map((x) => x + 1) } }));
  assert.equal(g.failures.length, 1);
});

test("the minimum effect is the larger of 3% and the floor", () => {
  assert.equal(minEffect("mobile.home.lcp_ms", 1650), 49.5);
  assert.equal(minEffect("desktop.home.lcp_ms", 100), 20);
  assert.equal(minEffect("mobile.evals.cls", 0.08), 0.01);
  assert.equal(minEffect("mobile.home.js_bytes", 6800), 0);
});

// Desktop quickstart LCP from run 42561923508: median 130.5 against a budget of 130.
test("a budget overshoot inside the noise passes", () => {
  const cand = [112, 118, 124, 128, 130.5, 133, 138, 142, 150];
  const r = result({ "desktop.quickstart.lcp_ms": { base: cand, cand } });
  const b = checkBudgets(r, { "desktop.quickstart.lcp_ms": 130 });
  assert.equal(b.checked, 1);
  assert.deepEqual(b.failures, []);
});

test("a clear budget overshoot fails", () => {
  const cand = [150, 152, 155, 158, 160, 161, 163, 165, 170];
  const r = result({ "desktop.quickstart.lcp_ms": { base: cand, cand } });
  const b = checkBudgets(r, { "desktop.quickstart.lcp_ms": 130 });
  assert.equal(b.failures.length, 1);
  assert.match(b.failures[0], /^desktop\.quickstart\.lcp_ms is 160 \(95% CI from 1\d\d(\.\d)?\), budget 130/);
});

test("a fixed byte count one byte over its budget fails", () => {
  const html = Array(9).fill(24801);
  const b = checkBudgets(result({ "mobile.home.html_bytes": { base: html, cand: html } }), { "*.home.html_bytes": 24800 });
  assert.equal(b.failures.length, 1);
});

test("a timing budget with too few quiet samples is skipped, not failed", () => {
  const cand = [150, 152, 155, 158, 160, 161, 163, 165, 170];
  const busy = [0.9, 0.9, 0.9, 0.9, 0.9, 0.1, 0.1, 0.1, 0.1];
  const r = result({ "desktop.quickstart.lcp_ms": { base: cand, cand }, "desktop.quickstart.cpu_busy": { base: busy, cand: busy } });
  const b = checkBudgets(r, { "desktop.quickstart.lcp_ms": 130 });
  assert.deepEqual(b.failures, []);
  assert.deepEqual(b.busy, ["desktop.quickstart.lcp_ms (4 of 9)"]);
});

// Mobile evals layout shift: 0.0039 in 17 of 18 samples of run 42721228885.
test("evals layout shift at 0.05 fails the gate, and fails its budget when it crept up unseen", () => {
  const was = fill(0.0039);
  const now = [0.05, 0.051, 0.049, 0.05, 0.052, 0.05, 0.048, 0.05, 0.05];
  assert.equal(checkGate(result({ "mobile.evals.cls": { base: was, cand: now } })).failures.length, 1);
  // Base and head both at 0.05: the A/B sees no change, so only the budget can catch it.
  const drift = result({ "mobile.evals.cls": { base: now, cand: now } });
  assert.deepEqual(checkGate(drift).failures, []);
  const b = checkBudgets(drift, BUDGETS);
  assert.equal(b.failures.length, 1);
  assert.match(b.failures[0], /^mobile\.evals\.cls is 0\.05 .*budget 0\.02/);
});

test("blocking time has its own budget per page", () => {
  const r = result({ "mobile.home.tbt_ms": { base: fill(30), cand: fill(30) }, "mobile.evals.tbt_ms": { base: fill(55), cand: fill(55) } });
  const b = checkBudgets(r, BUDGETS);
  assert.equal(b.checked, 2);
  assert.equal(b.failures.length, 1);
  assert.match(b.failures[0], /^mobile\.home\.tbt_ms is 30 .*budget 20/);
});

test("every page the harness loads has budgets for its load, shift, blocking time, bytes and requests", () => {
  const patterns = Object.keys(BUDGETS).filter((k) => !k.startsWith("$"));
  const per = ["mobile.%.lcp_ms", "mobile.%.fcp_ms", "mobile.%.tbt_ms", "mobile.%.dcl_ms", "desktop.%.lcp_ms", "mobile.%.cls", "desktop.%.cls", "mobile.%.html_bytes", "mobile.%.js_bytes", "mobile.%.font_bytes", "mobile.%.startup_requests", "desktop.%.startup_requests"];
  assert.ok(PAGES.cli, "the CLI reference is measured");
  for (const page of Object.keys(PAGES)) {
    for (const name of per.map((m) => m.replace("%", page))) assert.ok(patterns.some((p) => metricMatches(name, [p])), `no budget for ${name}`);
  }
});
