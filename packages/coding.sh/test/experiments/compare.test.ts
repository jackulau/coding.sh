import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDataset } from "../../src/datasets/dataset.ts";
import type { CalibrationStatus, Grader } from "../../src/datasets/types.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileEvalStore } from "../../src/datasets/store.ts";
import { clusterMap, compareExperiments, isInfraError } from "../../src/experiments/compare.ts";
import { calibrate, withCalibration, type HumanLabel, type JudgedCase } from "../../src/judge/calibrate.ts";
import { createJudge, judgeGrader } from "../../src/judge/judge.ts";
import type { ChatProvider } from "../../src/judge/providers.ts";
import { pairedPosterior } from "../../src/stats/posterior.ts";
import { renderComparison } from "../../src/experiments/render.ts";
import { runExperiment } from "../../src/experiments/run.ts";
import { roganGladen } from "../../src/stats/interval.ts";

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

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
    // Only the timing note (the two runs ran back to back, not interleaved) remains.
    assert.match(quiet.timing.warning ?? "", /one after the other, not interleaved/);
    assert.deepEqual(renderComparison(quiet, { color: false }).match(/^! .*/gm), [`! ${quiet.timing.warning}`]);
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
    // Direction stability on the judge's per-case score differences (AB-14): B gains 4 of 20,
    // so a resample of 20 keeps B ahead unless it draws none of the 4: 1 − 0.8^20 ≈ 0.988.
    assert.equal(g?.stability?.direction, "b");
    assert.ok(Math.abs(g!.stability!.share - (1 - 0.8 ** 20)) < 0.015, `share ${g?.stability?.share}`);
    assert.equal(g?.stability?.nStar, 20);
    assert.equal(g?.stability?.stable, true);
    assert.match(text, /^judge stable {2}B better in 9\d% of resamples \(n\*=20\)$/m);

    // Calibration without confusion rates (records from before judge calibrate stored them): no correction, no line.
    const plain = await runExperiment({ name: "p", dataset: ds, task: (i) => i, graders: [judge(new Set(range(1, 10)), { state: "calibrated", kappa: 0.8, n: 200 })] });
    const c2 = compareExperiments(plain, plain);
    assert.equal(c2.graders[0]?.corrected, undefined);
    assert.doesNotMatch(renderComparison(c2, { color: false }), /bias-corrected/);
    assert.equal(c2.graders[0]?.stability?.direction, "none");
    assert.match(renderComparison(c2, { color: false }), /^judge unstable {2}no direction in 0% of resamples \(n\* censored\)$/m);
    // Deterministic graders never get one.
    const det = compareExperiments(await run("x", new Set(range(1, 5))), await run("y", new Set(range(1, 5)))).graders[0];
    assert.equal(det?.corrected, undefined);
    assert.equal(det?.stability, undefined);
  });
});

describe("judge calibrate → exp compare (EM-5a)", () => {
  it("a judge calibrated by calibrate() now gets a Rogan–Gladen corrected rate in compare", async () => {
    // Regression: CalibrationStatus never carried sensitivity/specificity, so the correction never fired.
    const root = await mkdtemp(join(tmpdir(), "coding-sh-em5a-"));
    try {
      const store = new FileEvalStore({ root });
      // The judge passes the case ids in `passSet` (the task echoes the case id).
      const provider = (passSet: Set<string>): ChatProvider => ({
        name: "fake",
        model: "fake-1",
        params: {},
        complete: async (req) => {
          // Case ids are cNN, so a substring check is exact; the task echoes the id into the prompt.
          const pass = [...passSet].some((id) => req.user.includes(id));
          return { text: JSON.stringify({ score: pass ? 1 : 0, pass, reason: "fake" }), model: "fake-1" };
        },
      });
      const grader = (passSet: Set<string>) => judgeGrader(createJudge({ name: "correct", rubric: "is it right", provider: provider(passSet), tunedOn: ["dev"] }));
      const first = await runExperiment({ name: "j0", dataset: ds, task: (i) => i, graders: [grader(new Set(range(1, 10)))], store });
      const stored = await store.getJudge(first.graders[0]!.version);
      assert.ok(stored);

      // Held-out labels: judge vs humans on 30 test cases (fail = positive): tp 8, fp 2, fn 4, tn 16.
      const labels: HumanLabel[] = [];
      const verdicts: JudgedCase[] = [];
      const splits: Record<string, "test"> = {};
      const add = (kind: string, n: number, human: boolean, judge: boolean) => {
        for (let i = 0; i < n; i++) {
          const id = `${kind}-${i}`;
          labels.push({ caseId: id, value: human ? "pass" : "fail" });
          verdicts.push({ caseId: id, pass: judge, confidence: 0.4 });
          splits[id] = "test";
        }
      };
      add("tp", 8, false, false);
      add("fp", 2, true, false);
      add("fn", 4, false, true);
      add("tn", 16, true, true);
      const report = calibrate({ judge: stored, labels, verdicts, splits });
      // sensitivity = P(judge pass | human pass) = tn / (tn + fp); specificity = P(judge fail | human fail) = tp / (tp + fn).
      assert.equal(report.status.positives, 18);
      assert.equal(report.status.negatives, 12);
      close(report.status.sensitivity!, 16 / 18);
      close(report.status.specificity!, 8 / 12);
      await store.putJudge(withCalibration(stored, report));

      // Later runs pick up the stored calibration, and compare corrects both sides.
      const a = await runExperiment({ name: "ja", dataset: ds, task: (i) => i, graders: [grader(new Set(range(1, 10)))], store });
      const b = await runExperiment({ name: "jb", dataset: ds, task: (i) => i, graders: [grader(new Set(range(1, 14)))], store });
      assert.equal(a.graders[0]?.calibration?.sensitivity, report.status.sensitivity);
      const c = compareExperiments(a, b);
      const g = c.graders[0];
      assert.ok(g?.corrected?.a && g.corrected.b, "both sides corrected");
      assert.deepEqual(g.corrected.a, roganGladen(a.summary.graders[0]!.passed / 20, 16 / 18, 8 / 12, 20, { positives: 18, negatives: 12 }));
      assert.match(renderComparison(c, { color: false, a, b }), /^correct bias-corrected pass {2}A \d+\.\d% \[.*\] {2}B \d+\.\d% \[.*\] \(Rogan–Gladen, 95%\)$/m);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("in-sample calibration stores no confusion rates", () => {
    const labels: HumanLabel[] = [
      { caseId: "x", value: "pass" },
      { caseId: "y", value: "fail" },
    ];
    const verdicts: JudgedCase[] = [
      { caseId: "x", pass: true },
      { caseId: "y", pass: false },
    ];
    const r = calibrate({ judge: { id: "j@1", tunedOn: ["test"] }, labels, verdicts, splits: { x: "test", y: "test" } });
    assert.equal(r.state, "in-sample");
    assert.equal(r.status.sensitivity, undefined);
    assert.equal(r.status.positives, undefined);
  });
});

describe("compare: cluster bootstrap (EM-1)", () => {
  // 20 cases in 4 repos of 5; B fixes all of r1 and r2's first case.
  const meta = createDataset({ name: "clustered", createdAt: 1, cases: ids.map((id, i) => ({ id, input: id, metadata: { repo: `r${Math.floor(i / 5) + 1}` } })) });

  it("resamples repos, reports the cluster count and warns below 10 clusters", async () => {
    const a = await run("a", new Set(range(11, 20)), { dataset: meta });
    const b = await run("b", new Set([...range(1, 6), ...range(11, 20)]), { dataset: meta });
    const plain = compareExperiments(a, b, { seed: 1, iters: 4000 });
    const of = clusterMap(meta.cases, "repo");
    assert.equal(of.size, 20);
    assert.deepEqual(clusterMap(meta.cases, "metadata.repo"), of);
    const c = compareExperiments(a, b, { seed: 1, iters: 4000, cluster: { key: "repo", of } });
    assert.equal(c.diff.mean, plain.diff.mean);
    assert.ok(c.diff.hi - c.diff.lo > plain.diff.hi - plain.diff.lo, "clustering widens the interval");
    assert.deepEqual({ key: c.cluster?.key, clusters: c.cluster?.clusters, missing: c.cluster?.missing }, { key: "repo", clusters: 4, missing: 0 });
    assert.match(c.cluster?.warning ?? "", /only 4 repo cluster\(s\) \(< 10\)/);
    assert.equal(plain.cluster, undefined);
    const text = renderComparison(c, { color: false });
    assert.match(text, /\(20 paired cases in 4 repo clusters, 95% cluster bootstrap\)/);
    assert.match(text, /^! only 4 repo cluster\(s\)/m);
    assert.match(renderComparison(plain, { color: false }), /\(20 paired cases, 95% paired bootstrap\)/);
  });

  it("cases without the key are their own clusters; session falls back to the source session", async () => {
    const mixed = createDataset({
      name: "mixed",
      createdAt: 1,
      cases: ids.map((id, i) => (i < 10 ? { id, input: id, sourceSessionId: `s${i % 2}` } : { id, input: id })),
    });
    const of = clusterMap(mixed.cases, "session");
    assert.equal(of.size, 10);
    const a = await run("a", new Set(range(1, 5)), { dataset: mixed });
    const b = await run("b", new Set(range(1, 9)), { dataset: mixed });
    const c = compareExperiments(a, b, { cluster: { key: "session", of } });
    // 2 sessions + 10 singletons.
    assert.equal(c.cluster?.clusters, 12);
    assert.equal(c.cluster?.missing, 10);
    assert.match(renderComparison(c, { color: false }), /10 paired case\(s\) have no session; each counts as its own cluster/);
  });
});

describe("compare: Bayesian posterior at small n (EM-6)", () => {
  it("below 100 paired cases it adds P(B>A) and keeps the bootstrap interval", async () => {
    const a = await run("a", new Set(range(1, 10)));
    const b = await run("b", new Set([...range(4, 10), ...range(11, 17)]));
    const c = compareExperiments(a, b, { seed: 1, iters: 4000 });
    assert.deepEqual(c.posterior, pairedPosterior(3, 7, 10, { seed: 1 }));
    assert.ok(c.posterior!.pBetter > 0.8 && c.posterior!.pBetter < 0.95);
    assert.ok(Number.isFinite(c.diff.lo) && Number.isFinite(c.diff.hi), "bootstrap CI kept");
    const text = renderComparison(c, { color: false });
    assert.match(text, /^bayes {3}P\(B>A\)=0\.\d\d {2}B − A \+16\.7pp \[/m);
    assert.match(text, /^B − A {3}\+20\.0pp \[/m);
  });

  it("at 100 paired cases or more it is left out", async () => {
    const many = Array.from({ length: 100 }, (_, i) => `m${i}`);
    const big = createDataset({ name: "big", createdAt: 1, cases: many.map((id) => ({ id, input: id })) });
    const a = await run("a", new Set(many.slice(0, 50)), { dataset: big });
    const b = await run("b", new Set(many.slice(0, 60)), { dataset: big });
    const c = compareExperiments(a, b, { iters: 500 });
    assert.equal(c.posterior, undefined);
    assert.doesNotMatch(renderComparison(c, { color: false }), /^bayes/m);
  });
});

describe("compare: attrition (EM-4)", () => {
  it("classifies infra errors", () => {
    for (const m of ["node agent.mjs: timed out after 120000 ms", "https://x/: HTTP 503: busy", "https://x/: HTTP 429: slow down", "./a: could not start: ENOENT", "fetch failed", "killed by SIGKILL"]) {
      assert.ok(isInfraError(m), m);
    }
    for (const m of ["./a: exited 3: agent crashed", "stdout is not JSON: hi", "TypeError: x is undefined", "https://x/: HTTP 404: nope"]) assert.ok(!isInfraError(m), m);
  });

  it("flags one arm losing many more trials, split into infra and agent errors", async () => {
    const a = await run("a", new Set(ids));
    let k = 0;
    const b = await runExperiment({
      name: "b",
      dataset: ds,
      task: (input) => {
        const i = ids.indexOf(String(input));
        if (i < 6) throw new Error("timed out after 1000 ms");
        if (i < 9) throw new Error(`exited 3: crash ${k++}`);
        return input;
      },
      graders: [passing(new Set(ids))],
    });
    const c = compareExperiments(a, b);
    assert.deepEqual(c.attrition.a, { runs: 20, completed: 20, errored: 0, infra: 0, agent: 0, ungraded: 0, missing: 0, lost: 0 });
    assert.deepEqual(c.attrition.b, { runs: 20, completed: 11, errored: 9, infra: 6, agent: 3, ungraded: 0, missing: 0, lost: 9 });
    // Fisher [[0,20],[9,11]]: only x = 0 and x = 9 are as extreme, 2 · C(20,9)/C(40,9) ≈ 0.0012.
    close(c.attrition.p, (2 * 167960) / 273438880, 1e-12);
    assert.match(c.attrition.warning ?? "", /uneven attrition: A lost 0 of 20 trials, B lost 9 of 20 .* 6 task error\(s\) look like infrastructure/);
    const text = renderComparison(c, { color: false });
    assert.match(text, /^lost {4}A 0\/20 {2}B 9\/20 \(6 infra errors, 3 agent errors\) {2}Fisher p=0\.00\d/m);
    assert.match(text, /^! uneven attrition/m);
  });

  it("balanced or no attrition: no warning, no line; missing trials count on the same dataset", async () => {
    const a = await run("a", new Set(range(1, 10)));
    const b = await run("b", new Set(range(1, 12)));
    const c = compareExperiments(a, b);
    assert.equal(c.attrition.p, 1);
    assert.equal(c.attrition.warning, undefined);
    assert.doesNotMatch(renderComparison(c, { color: false }), /^lost/m);
    // B (forced, cancelled) ran only 15 of A's 20 cases on the same dataset version.
    const partial = { ...b, status: "cancelled" as const, runs: b.runs.slice(0, 15) };
    const p = compareExperiments(a, partial, { force: true });
    assert.equal(p.attrition.b.missing, 5);
    assert.equal(p.attrition.b.lost, 5);
    assert.equal(p.attrition.b.runs, 20);
  });
});

describe("compare: acceptance gate (AA-5)", () => {
  it("8 wins, 0 losses of 10 solved → ship; the line sits under the verdict", async () => {
    const a = await run("a", new Set(range(1, 10)));
    const b = await run("b", new Set(range(1, 18)));
    const c = compareExperiments(a, b, { gate: {} });
    const g = c.gate!;
    assert.deepEqual([g.wins, g.losses, g.solved, g.decision, g.verdict], [8, 0, 10, "accept", "ship"]);
    close(g.p, 256 / 6561, 1e-12);
    assert.deepEqual(g.wonCases, range(11, 18));
    const text = renderComparison(c, { color: false });
    assert.match(text, /^verdict .*\ngate {4}Ship it: B wins 8 cases, loses 0\n {8}accept · 8 won, 0 lost of 10 solved \(0%\) · net \+8 at λ=2 · p = 0\.039 < α 0\.05$/m);
  });

  it("5 wins at λ=2 → hold (not-significant); the verdict line does not change", async () => {
    const a = await run("a", new Set(range(1, 10)));
    const b = await run("b", new Set(range(1, 15)));
    const c = compareExperiments(a, b, { gate: {} });
    assert.deepEqual(c.gate!.reasons, ["not-significant"]);
    assert.equal(c.gate!.verdict, "hold");
    const plain = renderComparison(compareExperiments(a, b), { color: false });
    const gated = renderComparison(c, { color: false });
    assert.equal(gated.match(/^verdict .*$/m)![0], plain.match(/^verdict .*$/m)![0]);
    assert.match(gated, /^gate {4}Hold: not enough evidence \(B wins 5, loses 0; needs 8\+ wins with no losses\)$/m);
  });

  it("30 wins, 2 losses of 10 solved → regression-fraction, both lost cases listed", async () => {
    const big = Array.from({ length: 42 }, (_, i) => `d${String(i + 1).padStart(2, "0")}`);
    const dsBig = createDataset({ name: "big", createdAt: 1, cases: big.map((id) => ({ id, input: id })) });
    const a = await run("a", new Set(big.slice(0, 10)), { dataset: dsBig });
    const b = await run("b", new Set([...big.slice(2, 10), ...big.slice(10, 40)]), { dataset: dsBig });
    const g = compareExperiments(a, b, { gate: {} }).gate!;
    assert.deepEqual([g.wins, g.losses, g.solved], [30, 2, 10]);
    assert.deepEqual(g.reasons, ["regression-fraction"]);
    assert.deepEqual(g.lostCases, ["d01", "d02"]);
    assert.equal(g.verdict, "dont-ship");
    const text = renderComparison(compareExperiments(a, b, { gate: {} }), { color: false });
    assert.match(text, /^gate {4}Don't ship: B breaks 2 cases A solved \(and wins 30\)$/m);
    assert.match(text, /^ {8}lost: d01, d02$/m);
  });

  it("at λ=1, α=1, τ=1 it accepts exactly when improvements outnumber regressions", async () => {
    const a = await run("a", new Set(range(1, 10)));
    const b = await run("b", new Set([...range(4, 10), ...range(11, 17)]));
    const loose = { lambda: 1, alpha: 1, tau: 1 };
    assert.equal(compareExperiments(a, b, { gate: loose }).gate!.decision, "accept");
    assert.equal(compareExperiments(b, a, { gate: loose }).gate!.decision, "abstain");
  });

  it("one-sided and ungraded cases never count; k=3 uses the majority outcome", async () => {
    const a = await run("a", new Set(range(1, 10)));
    const b = await run("b", new Set(range(1, 18)));
    // B (forced, cancelled) ran only c01..c15: c16..c18 are only in A.
    const partial = { ...b, status: "cancelled" as const, runs: b.runs.filter((r) => range(1, 15).includes(r.caseId)) };
    const g = compareExperiments(a, partial, { force: true, gate: {} }).gate!;
    assert.deepEqual([g.wins, g.losses, g.solved], [5, 0, 10]);
    // An ungraded run is no outcome at all.
    const ungraded = { ...b, runs: b.runs.map((r) => (r.caseId === "c11" ? { ...r, pass: false, ungraded: true as const } : r)) };
    assert.deepEqual(compareExperiments(a, ungraded, { gate: {} }).gate!.wins, 7);
    // k=3: c01 passes 2 of 3 in B (still solved), c02 passes 1 of 3 (lost).
    let n1 = 0;
    let n2 = 0;
    const flaky: Grader = {
      id: "ok",
      version: "1",
      kind: "custom",
      grade: async (ctx) => {
        const id = String(ctx.output);
        const pass = id === "c01" ? n1++ !== 0 : id === "c02" ? n2++ === 0 : range(1, 10).includes(id);
        return { score: pass ? 1 : 0, pass };
      },
    };
    const k3 = await runExperiment({ name: "k3", dataset: ds, task: (i) => i, graders: [flaky], trials: 3, concurrency: 1 });
    const gk = compareExperiments(a, k3, { gate: {} }).gate!;
    assert.deepEqual([gk.wins, gk.losses, gk.solved, gk.lostCases], [0, 1, 10, ["c02"]]);
  });

  it("notes that errored trials count as failures when attrition is uneven", async () => {
    const a = await run("a", new Set(ids));
    const b = await runExperiment({
      name: "b",
      dataset: ds,
      task: (input) => {
        if (ids.indexOf(String(input)) < 9) throw new Error("timed out after 1000 ms");
        return input;
      },
      graders: [passing(new Set(ids))],
    });
    const c = compareExperiments(a, b, { gate: {} });
    assert.equal(c.gate!.losses, 9);
    assert.match(c.gate!.note ?? "", /counts a task error as a failure/);
    assert.match(renderComparison(c, { color: false }), /^! trials were lost to errors/m);
  });

  it("without the gate option there is no gate key and no gate line", async () => {
    const a = await run("a", new Set(range(1, 10)));
    const b = await run("b", new Set(range(1, 18)));
    const c = compareExperiments(a, b);
    assert.equal("gate" in c, false);
    assert.doesNotMatch(renderComparison(c, { color: false }), /^gate/m);
  });
});

describe("compare: A/A noise floor (EM-10)", () => {
  it("the noise floor sets the MDE when the observed spread is smaller, and compare notes the flip rate", async () => {
    const a = await run("a", new Set(range(1, 12)));
    const b = await run("b", new Set(range(1, 12)));
    const noise = { sd: 0.4, flipRate: 0.15, paired: 20 };
    const c = compareExperiments(a, b, { noise });
    // No case changed, so without the floor the MDE is unknown.
    assert.ok(Number.isNaN(compareExperiments(a, b).power.mde));
    close(c.power.mde, ((1.959963984540054 + 0.8416212335729143) * 0.4) / Math.sqrt(20), 1e-8);
    assert.deepEqual(c.power.noise, { ...noise, used: true });
    assert.deepEqual(c.power.warnings.map((w) => w.code), ["small-n", "below-mde"]);
    assert.match(renderComparison(c, { color: false }), /^noise {3}A\/A flip rate on this dataset 15\.0% \(sd 0\.40 over 20 cases; the MDE uses it as a floor\)$/m);
  });
});

