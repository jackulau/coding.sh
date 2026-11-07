import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDataset } from "../../src/datasets/dataset.ts";
import type { CalibrationStatus, Grader } from "../../src/datasets/types.ts";
import { compareExperiments } from "../../src/experiments/compare.ts";
import { renderComparison } from "../../src/experiments/render.ts";
import { runExperiment } from "../../src/experiments/run.ts";
import { roganGladen } from "../../src/stats/interval.ts";

const ids = Array.from({ length: 20 }, (_, i) => `c${String(i + 1).padStart(2, "0")}`);
const ds = createDataset({ name: "paired", createdAt: 1, cases: ids.map((id) => ({ id, input: id })) });

/** Grader that passes exactly the case ids in `pass` (the task echoes the case id). */
const passing = (pass: Set<string>): Grader => ({
  id: "ok",
  version: "1",
  kind: "custom",
  grade: async (ctx) => (pass.has(String(ctx.output)) ? { score: 1, pass: true } : { score: 0, pass: false, reason: "nope" }),
});

async function run(name: string, pass: Set<string>, opts: { trials?: number; dataset?: typeof ds } = {}) {
  return runExperiment({
    name,
    dataset: opts.dataset ?? ds,
    task: (input) => input,
    graders: [passing(pass)],
    ...(opts.trials ? { trials: opts.trials } : {}),
  });
}

const range = (a: number, b: number) => ids.slice(a - 1, b);

describe("compareExperiments", () => {
  it("known flips: 3 regressions, 7 improvements", async () => {
    // A passes c01..c10. B regresses c01..c03 and fixes c11..c17.
    const a = await run("baseline", new Set(range(1, 10)));
    const b = await run("candidate", new Set([...range(4, 10), ...range(11, 17)]));
    const c = compareExperiments(a, b, { seed: 1, iters: 4000 });
    assert.equal(c.paired, 20);
    assert.equal(c.a.passRate, 0.5);
    assert.equal(c.b.passRate, 0.7);
    assert.ok(Math.abs(c.diff.mean - 0.2) < 1e-12);
    assert.ok(c.diff.lo < 0.2 && 0.2 < c.diff.hi);
    assert.equal(c.mcnemar.b, 3);
    assert.equal(c.mcnemar.c, 7);
    // 2 · P(X ≤ 3), X ~ Bin(10, ½) = 2 · (1 + 10 + 45 + 120) / 1024
    assert.ok(Math.abs(c.mcnemar.p - 0.34375) < 1e-12);
    assert.equal(c.verdict, "inconclusive");
    assert.deepEqual(c.regressions.map((x) => x.caseId), ["c01", "c02", "c03"]);
    assert.deepEqual(c.improvements.map((x) => x.caseId), range(11, 17));
    assert.equal(c.datasetWarning, undefined);
    assert.equal(c.graders[0]?.id, "ok");
    assert.ok(Math.abs((c.graders[0]?.diff.mean ?? NaN) - 0.2) < 1e-12);
    // Deterministic for a seed.
    assert.deepEqual(compareExperiments(a, b, { seed: 1, iters: 4000 }).diff, c.diff);

    const text = renderComparison(c, { color: false, a, b, limit: 2 });
    assert.ok(!/\u001b\[/.test(text));
    assert.match(text, /B − A {3}\+20\.0pp \[/);
    assert.match(text, /mcnemar p=0\.344 {2}3 regressed, 7 improved/);
    assert.match(text, /verdict inconclusive \(CI includes 0\)/);
    assert.match(text, /regressions 3\n/);
    assert.match(text, /c01\s+100%\s+0%\s+-100pp/);
    assert.match(text, /… 1 more/);
    // Power: 7 × +1, 3 × −1, 10 × 0 → sd² = (10 − 20·0.2²)/19; MDE = (z.975 + z.8)·sd/√20.
    const mde = (1.959963984540054 + 0.8416212335729143) * Math.sqrt(9.2 / 19) / Math.sqrt(20);
    assert.ok(Math.abs(c.power.mde - mde) < 1e-8);
    assert.ok(Math.abs(c.power.mde - 0.43592) < 1e-4);
    assert.equal(c.power.n, 20);
    assert.deepEqual(c.power.warnings.map((w) => w.code), ["small-n", "below-mde"]);
    assert.match(text, /^power {3}MDE 43\.6pp \(α 0\.05, power 80%, paired, sd of per-case Δ 0\.70\)$/m);
    assert.match(text, /^! only 20 paired cases \(< 200\)/m);
    assert.match(text, /^! observed \|B − A\| 20\.0pp is below the minimum detectable effect 43\.6pp \(α 0\.05, power 80%\)/m);
    // Single trial: no pass^k.
    assert.equal(c.passK, undefined);
    assert.doesNotMatch(text, /pass\^/);
    assert.ok(/\u001b\[/.test(renderComparison(c, { color: true })));
  });

  it("a significant verdict does not also claim the difference is undetectable", async () => {
    // QA: 24 paired cases, A passes all, B regresses 6 → B is worse, yet |Δ| 25.0pp < MDE 25.3pp.
    const ids24 = Array.from({ length: 24 }, (_, i) => `k${String(i + 1).padStart(2, "0")}`);
    const ds24 = createDataset({ name: "p24", createdAt: 1, cases: ids24.map((id) => ({ id, input: id })) });
    const a = await run("a24", new Set(ids24), { dataset: ds24 });
    const b = await run("b24", new Set(ids24.slice(6)), { dataset: ds24 });
    const c = compareExperiments(a, b, { seed: 1, iters: 4000 });
    assert.equal(c.verdict, "worse");
    assert.ok(c.mcnemar.p < 0.05);
    assert.ok(Math.abs(c.diff.mean) < c.power.mde);
    assert.deepEqual(c.power.warnings.map((w) => w.code), ["small-n", "near-mde"]);
    const text = renderComparison(c, { color: false, a, b });
    assert.match(text, /verdict B is worse/);
    assert.doesNotMatch(text, /cannot reliably detect/);
    assert.match(text, /^! observed \|B − A\| 25\.0pp is significant but below the minimum detectable effect 25\.3pp .*magnitude may be overstated/m);
  });

  it("identical runs: zero difference, p = 1", async () => {
    const a = await run("a", new Set(range(1, 12)));
    const b = await run("b", new Set(range(1, 12)));
    const c = compareExperiments(a, b);
    assert.equal(c.diff.mean, 0);
    assert.equal(c.diff.lo, 0);
    assert.equal(c.diff.hi, 0);
    assert.equal(c.mcnemar.p, 1);
    assert.equal(c.verdict, "inconclusive");
    assert.ok(Number.isNaN(c.power.mde));
    assert.deepEqual(c.power.warnings.map((w) => w.code), ["small-n", "no-change"]);
    assert.match(renderComparison(c, { color: false }), /^power {3}MDE — /m);
    assert.deepEqual(c.regressions, []);
    assert.deepEqual(c.improvements, []);
  });

  it("a clear improvement and a clear regression get a verdict", async () => {
    const a = await run("a", new Set(range(1, 4)));
    const b = await run("b", new Set(range(1, 18)));
    const better = compareExperiments(a, b, { seed: 2 });
    assert.equal(better.verdict, "better");
    assert.ok(better.diff.lo > 0);
    assert.ok(better.mcnemar.p < 0.001);
    assert.equal(compareExperiments(b, a, { seed: 2 }).verdict, "worse");
    assert.match(renderComparison(better, { color: false }), /verdict B is better/);
    // 14 × +1, 6 × 0: the observed +70pp clears the MDE; only the suite size is flagged.
    assert.ok(better.power.mde < better.diff.mean);
    assert.deepEqual(better.power.warnings.map((w) => w.code), ["small-n"]);
    // With the size threshold lowered, a clear effect gets no warning at all.
    const quiet = compareExperiments(a, b, { seed: 2, minPaired: 20 });
    assert.deepEqual(quiet.power.warnings, []);
    assert.doesNotMatch(renderComparison(quiet, { color: false }), /^! /m);
    // Stricter alpha or higher power needs a larger effect.
    assert.ok(compareExperiments(a, b, { seed: 2, alpha: 0.01 }).power.mde > better.power.mde);
    assert.ok(compareExperiments(a, b, { seed: 2, power: 0.9 }).power.mde > better.power.mde);
  });

  it("pairs by case id across dataset versions and warns", async () => {
    const smaller = createDataset({ name: "paired", cases: [...ids.slice(0, 15), "extra"].map((id) => ({ id, input: id })) });
    const a = await run("a", new Set(range(1, 10)));
    const b = await run("b", new Set([...range(1, 10), "extra"]), { dataset: smaller });
    const c = compareExperiments(a, b);
    assert.equal(c.paired, 15);
    assert.deepEqual(c.onlyInA, range(16, 20));
    assert.deepEqual(c.onlyInB, ["extra"]);
    assert.match(c.datasetWarning ?? "", /only the 15 shared case id\(s\) are compared/);
    const text = renderComparison(c, { color: false });
    assert.match(text, /^! A ran on/m);
    assert.match(text, /unpaired: 5 only in A, 1 only in B/);
  });

  it("trials > 1 compares per-case pass rates", async () => {
    let n = 0;
    const flaky: Grader = {
      id: "ok",
      version: "1",
      kind: "custom",
      // c01 passes every other attempt in B.
      grade: async (ctx) => ({ score: 1, pass: ctx.output !== "c01" || n++ % 2 === 0 }),
    };
    const a = await runExperiment({ name: "a", dataset: ds, task: (i) => i, graders: [passing(new Set(ids))], trials: 2 });
    const b = await runExperiment({ name: "b", dataset: ds, task: (i) => i, graders: [flaky], trials: 2, concurrency: 1 });
    const c = compareExperiments(a, b);
    assert.deepEqual(c.regressions, [{ caseId: "c01", a: 1, b: 0.5, delta: -0.5 }]);
    // Majority rule: 0.5 still counts as a pass for McNemar.
    assert.equal(c.mcnemar.b, 0);
    assert.ok(Math.abs(c.diff.mean - -0.5 / 20) < 1e-12);
    // pass^2: A passes every trial of every case; B misses one trial of c01.
    assert.deepEqual(c.passK, { a: { k: 2, rate: 1 }, b: { k: 2, rate: 19 / 20 }, diff: 19 / 20 - 1 });
    assert.match(renderComparison(c, { color: false }), /^pass\^2 {2}A 100\.0% {2}B 95\.0% {2}-5\.0pp \(cases where every trial passed\)$/m);
  });

  it("pass^k with different trial counts reports each k", async () => {
    const a = await run("a", new Set(range(1, 10)));
    let n = 0;
    const flaky: Grader = {
      id: "ok",
      version: "1",
      kind: "custom",
      // c01..c10 pass, except c01 fails its second of three attempts.
      grade: async (ctx) => ({ score: 1, pass: range(1, 10).includes(String(ctx.output)) && !(ctx.output === "c01" && n++ === 1) }),
    };
    const b = await runExperiment({ name: "b", dataset: ds, task: (i) => i, graders: [flaky], trials: 3, concurrency: 1 });
    const c = compareExperiments(a, b);
    assert.deepEqual(c.passK, { a: { k: 1, rate: 0.5 }, b: { k: 3, rate: 0.45 }, diff: 0.45 - 0.5 });
    assert.match(renderComparison(c, { color: false }), /^pass\^k {2}A 50\.0% \(k=1\) {2}B 45\.0% \(k=3\) {2}-5\.0pp/m);
  });

  it("judge graders with calibration rates get Rogan–Gladen corrected pass rates", async () => {
    const judge = (pass: Set<string>, calibration: CalibrationStatus): Grader => ({ ...passing(pass), id: "judge", kind: "llm-judge", calibration });
    const rates = { state: "calibrated", kappa: 0.8, n: 200, sensitivity: 0.9, specificity: 0.8, positives: 100, negatives: 100 } as CalibrationStatus;
    const a = await runExperiment({ name: "a", dataset: ds, task: (i) => i, graders: [judge(new Set(range(1, 10)), rates)] });
    // B's judge is no better than chance: the correction is refused, not faked.
    const chance = { state: "calibrated", n: 200, sensitivity: 0.5, specificity: 0.4 } as CalibrationStatus;
    const b = await runExperiment({ name: "b", dataset: ds, task: (i) => i, graders: [judge(new Set(range(1, 14)), chance)] });
    const c = compareExperiments(a, b);
    const g = c.graders[0];
    assert.equal(g?.id, "judge");
    assert.deepEqual(g?.corrected?.a, roganGladen(0.5, 0.9, 0.8, 20, { positives: 100, negatives: 100 }));
    // (0.5 + 0.8 − 1) / (0.9 + 0.8 − 1) = 0.3 / 0.7
    assert.ok(Math.abs((g?.corrected?.a?.p ?? NaN) - 0.3 / 0.7) < 1e-12);
    assert.equal(g?.corrected?.b?.corrected, false);
    const text = renderComparison(c, { color: false, a, b });
    assert.match(text, /^judge bias-corrected pass {2}A 42\.9% \[\d+\.\d%, \d+\.\d%\] {2}B refused \(sensitivity \+ specificity ≤ 1\) \(Rogan–Gladen, 95%\)$/m);

    // Calibration without confusion rates (today's CalibrationStatus): no correction, no line.
    const plain = await runExperiment({ name: "p", dataset: ds, task: (i) => i, graders: [judge(new Set(range(1, 10)), { state: "calibrated", kappa: 0.8, n: 200 })] });
    const c2 = compareExperiments(plain, plain);
    assert.equal(c2.graders[0]?.corrected, undefined);
    assert.doesNotMatch(renderComparison(c2, { color: false }), /bias-corrected/);
    // Deterministic graders never get one.
    assert.equal(compareExperiments(await run("x", new Set(range(1, 5))), await run("y", new Set(range(1, 5)))).graders[0]?.corrected, undefined);
  });
});
