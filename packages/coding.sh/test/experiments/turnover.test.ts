// Y-1: coverage turnover (EvoAudit, arXiv 2611.07624): gained and lost covered
// cases, reliability shift, success-count matrix, trial-half stability, and how
// exp compare renders them. Synthetic CaseRuns only.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CaseRun, ExperimentResult } from "../../src/datasets/types.ts";
import { compareExperiments } from "../../src/experiments/compare.ts";
import { renderComparison } from "../../src/experiments/render.ts";
import { outcomesByCase, turnover } from "../../src/experiments/turnover.ts";

const T = true;
const F = false;
const outcomes = (o: Record<string, boolean[]>) => new Map(Object.entries(o));

/** One run per (case, trial) from pass patterns in trial order. */
function runs(o: Record<string, boolean[]>, extra: Partial<CaseRun>[] = []): CaseRun[] {
  const out: CaseRun[] = [];
  for (const [caseId, xs] of Object.entries(o)) xs.forEach((pass, trial) => out.push({ caseId, trial, pass, latencyMs: 1, grades: [], startedAt: 0 }));
  return [...out, ...extra.map((e) => ({ caseId: "x", trial: 0, pass: false, latencyMs: 1, grades: [], startedAt: 0, ...e }))];
}

function experiment(id: string, o: Record<string, boolean[]>, trials: number): ExperimentResult {
  return {
    id,
    name: id,
    status: "completed",
    dataset: { id: "ds", version: "1", name: "ds" },
    task: { kind: "command", ref: "x" },
    graders: [],
    trials,
    runs: runs(o),
    createdAt: 0,
    finishedAt: 1,
    summary: { graders: [] },
  } as unknown as ExperimentResult;
}

// Hand-counted, k = 4: passes A → B per case.
const A8 = { c1: [T, T, T, T], c2: [T, T, F, F], c3: [F, F, F, F], c4: [F, F, F, F], c5: [F, T, F, F], c6: [T, T, F, T], c7: [F, F, T, F], c8: [F, F, F, F] };
const B8 = { c1: [T, T, T, T], c2: [F, F, F, F], c3: [T, F, T, T], c4: [F, F, F, F], c5: [T, F, F, T], c6: [F, F, T, F], c7: [F, F, F, F], c8: [F, T, F, F] };

describe("turnover (Y-1)", () => {
  it("8 cases, k=4: gained, lost, kept, never, reliability and the full matrix", () => {
    const t = turnover(outcomes(A8), outcomes(B8));
    assert.equal(t.paired, 8);
    assert.deepEqual(t.gained, ["c3", "c8"]);
    assert.deepEqual(t.lost, ["c2", "c7"]);
    assert.equal(t.keptCovered, 3);
    assert.equal(t.neverCovered, 1);
    assert.equal(t.gained.length + t.lost.length + t.keptCovered + t.neverCovered, t.paired);
    assert.deepEqual(t.coverage, { a: 5 / 8, b: 5 / 8, diff: 0 });
    assert.deepEqual(t.reliability, { up: 3, down: 3, same: 2 });
    assert.equal(t.k, 4);
    const m = t.matrix!;
    assert.equal(m.length, 5);
    assert.ok(m.every((r) => r.length === 5));
    const expected = [
      [1, 1, 0, 1, 0], // c4 0→0, c8 0→1, c3 0→3
      [1, 0, 1, 0, 0], // c7 1→0, c5 1→2
      [1, 0, 0, 0, 0], // c2 2→0
      [0, 1, 0, 0, 0], // c6 3→1
      [0, 0, 0, 0, 1], // c1 4→4
    ];
    assert.deepEqual(m, expected);
    assert.equal(m.flat().reduce((s, x) => s + x, 0), t.paired);
    // The diagonal counts the cases with equal success counts (c1, c4).
    assert.equal(m.reduce((s, r, i) => s + r[i]!, 0), 2);
  });

  it("acceptance: A covers c1..c5, B covers c3..c9 → coverage rises, lost [c1, c2], gained [c6..c9]", () => {
    const a: Record<string, boolean[]> = {};
    const b: Record<string, boolean[]> = {};
    for (let i = 1; i <= 10; i++) {
      a[`c${i}`] = [i <= 5, F];
      b[`c${i}`] = [F, i >= 3 && i <= 9];
    }
    const t = turnover(outcomes(a), outcomes(b));
    assert.ok(t.coverage.diff > 0);
    assert.deepEqual(t.lost, ["c1", "c2"]);
    assert.deepEqual(t.gained, ["c6", "c7", "c8", "c9"]);
  });

  it("mixed k: no matrix, the rest is computed", () => {
    const t = turnover(outcomes({ c1: [T, F, F], c2: [F, F] }), outcomes({ c1: [F, F, F], c2: [T, T] }));
    assert.equal(t.matrix, undefined);
    assert.deepEqual(t.lost, ["c1"]);
    assert.deepEqual(t.gained, ["c2"]);
    assert.ok(t.halves);
  });

  it("k=1: halves absent, matrix 2×2", () => {
    const t = turnover(outcomes({ c1: [T], c2: [F], c3: [T] }), outcomes({ c1: [F], c2: [T], c3: [T] }));
    assert.equal(t.halves, undefined);
    assert.deepEqual(t.matrix, [
      [0, 1],
      [1, 1],
    ]);
  });

  it("halves: A passes trials 1-2, B trials 3-4 → first half negative, second positive, reversed", () => {
    const a: Record<string, boolean[]> = {};
    const b: Record<string, boolean[]> = {};
    for (let i = 1; i <= 6; i++) {
      a[`c${i}`] = [T, T, F, F];
      b[`c${i}`] = [F, F, T, T];
    }
    const h = turnover(outcomes(a), outcomes(b)).halves!;
    assert.deepEqual(h.first.trials, [1, 2]);
    assert.deepEqual(h.second.trials, [3, 4]);
    assert.equal(h.first.avgDiff, -1);
    assert.equal(h.second.avgDiff, 1);
    assert.equal(h.first.coverageDiff, -1);
    assert.equal(h.second.coverageDiff, 1);
    assert.deepEqual(h.reversed, { avg: true, coverage: true });
  });

  it("outcomesByCase: trial order, errored = fail, ungraded left out; unpaired cases excluded", () => {
    const rs = runs({}, [
      { caseId: "c1", trial: 1, pass: true },
      { caseId: "c1", trial: 0, pass: false, error: "boom" },
      { caseId: "c2", trial: 0, pass: false, ungraded: true },
      { caseId: "c3", trial: 0, pass: true },
    ]);
    const o = outcomesByCase(rs);
    assert.deepEqual(o.get("c1"), [F, T]);
    assert.equal(o.has("c2"), false);
    const t = turnover(o, outcomes({ c1: [F, F], c9: [T, T] }));
    assert.equal(t.paired, 1);
    assert.deepEqual(t.lost, ["c1"]);
  });
});

describe("exp compare: turnover in the report (Y-1)", () => {
  it("comparison.turnover is always there; text shows coverage, reliability, halves, lost coverage and --matrix", () => {
    const a = experiment("A", A8, 4);
    const b = experiment("B", B8, 4);
    const c = compareExperiments(a, b, { seed: 1, iters: 500 });
    assert.deepEqual(c.turnover.lost, ["c2", "c7"]);
    const text = renderComparison(c, { color: false, a, b, matrix: true });
    assert.match(text, /^coverage A 62\.5% → B 62\.5% \(0\.0pp\) {2}gained 2 {2}lost 2 {2}kept 3 \(cases that passed in any of 4 trials\)$/m);
    assert.match(text, /^ {9}reliability 3 up, 3 down, 2 same \(cases by per-case pass rate\)$/m);
    assert.match(text, /^halves {2}trials 1-2 /m);
    assert.match(text, /^lost coverage 2\n/m);
    // Lost coverage comes before the regressions list.
    assert.ok(text.indexOf("lost coverage 2") < text.indexOf("regressions 3"));
    assert.match(text, /^success counts \(cases by passes out of 4: A in rows, B in columns\)$/m);
    assert.match(text, /^A\\B {2}0 {2}1 {2}2 {2}3 {2}4$/m);
    assert.match(text, /^0 {4}1 {2}1 {2}· {2}1 {2}·$/m);
    // No --matrix, no grid.
    assert.doesNotMatch(renderComparison(c, { color: false, a, b }), /success counts/);
  });

  it("one trial: no turnover lines in text (coverage is the pass rate), still in the JSON", () => {
    const a = experiment("A", { c1: [T], c2: [F] }, 1);
    const b = experiment("B", { c1: [F], c2: [T] }, 1);
    const c = compareExperiments(a, b, { seed: 1, iters: 200 });
    assert.deepEqual(c.turnover.gained, ["c2"]);
    const text = renderComparison(c, { color: false, a, b });
    assert.doesNotMatch(text, /coverage|lost coverage|halves/);
  });

  it("a significant verdict whose direction reverses between halves carries a warning", () => {
    const a: Record<string, boolean[]> = {};
    const b: Record<string, boolean[]> = {};
    for (let i = 1; i <= 20; i++) {
      a[`c${i}`] = [T, F, F, F];
      b[`c${i}`] = [F, F, T, T];
    }
    const c = compareExperiments(experiment("A", a, 4), experiment("B", b, 4), { seed: 1, iters: 500 });
    assert.equal(c.verdict, "better");
    assert.ok(c.turnover.halves!.reversed.avg);
    assert.match(c.turnover.warning!, /reverses between trial halves \(trials 1-2 vs trials 3-4\); confirm with more trials/);
    assert.match(renderComparison(c, { color: false }), /^! B is better overall, but the change reverses/m);
  });
});
