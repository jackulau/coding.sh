// What a comparison says when it has almost nothing to go on, and how numbers
// read: an MDE above 100pp is "too few cases", no paired cases is said as
// such, a metric that did not move is "same" (not inconclusive), and a tiny p
// is "< 0.001", never "0.00".
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDataset } from "../../src/datasets/dataset.ts";
import type { Grader } from "../../src/datasets/types.ts";
import { compareExperiments } from "../../src/experiments/compare.ts";
import { renderMetrics, runMetrics, type MetricArm } from "../../src/experiments/metrics.ts";
import { mdeText } from "../../src/experiments/power.ts";
import { renderComparison } from "../../src/experiments/render.ts";
import { runExperiment } from "../../src/experiments/run.ts";
import { fmtP } from "../../src/improve/changes.ts";

const passing = (pass: Set<string>): Grader => ({
  id: "ok",
  version: "1",
  kind: "custom",
  grade: async (ctx) => (pass.has(String(ctx.output)) ? { score: 1, pass: true } : { score: 0, pass: false, reason: "nope" }),
});
const run = (name: string, ids: string[], pass: string[]) =>
  runExperiment({ name, dataset: createDataset({ name: "small", createdAt: 1, cases: ids.map((id) => ({ id, input: id })) }), task: (input) => input, graders: [passing(new Set(pass))] });

describe("small-n wording", () => {
  it("an MDE above 100pp shows as too few cases", async () => {
    assert.equal(mdeText(1.6), "— (too few cases)");
    assert.equal(mdeText(0.125), "12.5pp");
    assert.equal(mdeText(Number.NaN), "—");
    const ids = ["c1", "c2", "c3"];
    const text = renderComparison(compareExperiments(await run("a", ids, ["c1"]), await run("b", ids, ["c2", "c3"])), { color: false });
    assert.match(text, /power {3}MDE — \(too few cases\)/);
    assert.doesNotMatch(text, /MDE \d{3,}\.\dpp/);
  });

  it("no paired cases is the reason, not CI includes 0", async () => {
    const c = compareExperiments(await run("a", ["a1", "a2"], ["a1"]), await run("b", ["b1", "b2"], ["b1"]));
    assert.equal(c.paired, 0);
    const text = renderComparison(c, { color: false });
    assert.match(text, /verdict inconclusive \(no paired cases\)/);
    assert.doesNotMatch(text, /CI includes 0/);
  });

  it("exp metrics counts a fixed, unchanged metric as same", async () => {
    let k = 0;
    const arm = (name: string): MetricArm => ({ name, task: { kind: "function", name, fn: () => ({ exit_code: 0, lcp_ms: 2000 + (k++ % 7) * 13 }) } });
    const r = await runMetrics({ arms: [arm("a"), arm("b")], pairs: 6, seed: 1, iters: 200 });
    const exit = r.metrics.find((m) => m.name === "exit_code")!;
    assert.equal(exit.deterministic, true);
    assert.equal(r.summary.same, 1);
    assert.equal(r.summary.inconclusive, 1);
    assert.match(renderMetrics(r, { color: false }), /verdict: 0 better · 0 worse · 1 same · 1 inconclusive/);
  });

  it("fmtP gives three decimals or < 0.001", () => {
    assert.equal(fmtP(0.0004), "< 0.001");
    assert.equal(fmtP(0.0342), "0.034");
    assert.equal(fmtP(1), "1.000");
  });
});
