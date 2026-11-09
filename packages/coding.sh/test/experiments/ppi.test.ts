import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDataset } from "../../src/datasets/dataset.ts";
import type { CaseRun, ExperimentResult } from "../../src/datasets/types.ts";
import { compareExperiments } from "../../src/experiments/compare.ts";
import { graderPpi, labelMajority, MIN_PPI_LABELS, ppiDelta, ppiMean, ppiPairedDiff } from "../../src/experiments/ppi.ts";
import { renderComparison } from "../../src/experiments/render.ts";
import { summarizeRuns } from "../../src/experiments/run.ts";
import type { HumanLabel } from "../../src/judge/calibrate.ts";
import { mulberry32 } from "../../src/stats/prng.ts";

const bern = (rand: () => number, p: number) => (rand() < p ? 1 : 0);

/** One arm: true human outcomes y and a judge that passes humans' passes with `sens` and humans' fails with 1 − spec. */
function arm(rand: () => number, N: number, p: number, sens: number, spec: number) {
  const y: number[] = [];
  const f: number[] = [];
  for (let i = 0; i < N; i++) {
    const yi = bern(rand, p);
    y.push(yi);
    f.push(yi ? bern(rand, sens) : bern(rand, 1 - spec));
  }
  return { y, f };
}

function sample(rand: () => number, N: number, n: number): number[] {
  const idx = Array.from({ length: N }, (_, i) => i);
  for (let i = N - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  return idx.slice(0, n);
}

describe("ppiMean", () => {
  it("a perfect judge (yhat = y) gives the judge mean over every case, at λ = 1", () => {
    const all = [1, 0, 1, 1, 0, 1, 0, 1, 1, 1];
    const lab = [0, 1, 2, 3, 4].map((i) => ({ yhat: all[i]!, y: all[i]! }));
    const r = ppiMean(all, lab);
    assert.equal(r.lambda, 1);
    assert.ok(Math.abs(r.theta - 0.7) < 1e-12);
    // Plain PPI (λ = 1) too.
    assert.ok(Math.abs(ppiMean(all, lab, { lambda: 1 }).theta - 0.7) < 1e-12);
  });

  it("an uninformative judge gets λ = 0: the human mean and its interval", () => {
    const all = [1, 1, 1, 1, 1, 1];
    const lab = [
      { yhat: 1, y: 1 },
      { yhat: 1, y: 0 },
      { yhat: 1, y: 1 },
      { yhat: 1, y: 0 },
    ];
    const r = ppiMean(all, lab);
    assert.equal(r.lambda, 0);
    assert.equal(r.theta, 0.5);
    assert.ok(r.lo < 0.5 && r.hi > 0.5);
  });

  it("removes a judge's bias: the estimate lands on the human rate, not the judge's", () => {
    const rand = mulberry32(7);
    const { y, f } = arm(rand, 4000, 0.5, 0.9, 0.5); // judge passes half of the human fails
    const lab = sample(rand, 4000, 400).map((i) => ({ yhat: f[i]!, y: y[i]! }));
    const r = ppiMean(f, lab);
    const judgeMean = f.reduce((s, x) => s + x, 0) / f.length;
    const humanMean = y.reduce((s, x) => s + x, 0) / y.length;
    assert.ok(judgeMean > humanMean + 0.15, `judge mean ${judgeMean}`);
    assert.ok(Math.abs(r.theta - humanMean) < Math.abs(judgeMean - humanMean) / 3, `${r.theta} vs human ${humanMean}, judge ${judgeMean}`);
    // Never wider than human-only.
    const human = ppiMean(f, lab, { lambda: 0 });
    assert.ok(r.se <= human.se + 1e-12);
  });

  it("is NaN below two labels", () => {
    assert.ok(Number.isNaN(ppiMean([1, 0], [{ yhat: 1, y: 1 }]).theta));
  });
});

describe("PPI on a biased-judge simulation (true A .50, B .60; the judge over-passes B)", () => {
  // 300 seeded reps: the raw judge CI rarely covers the true +0.10; the corrected one does at about 95%.
  const reps = 300;
  const N = 400;
  const n = 150;
  const truth = 0.1;
  const z = 1.959963984540054;
  let rawCover = 0;
  let pairedCover = 0;
  let indepCover = 0;
  let deltaJ = 0;
  const rand = mulberry32(0x5eed);
  for (let r = 0; r < reps; r++) {
    const A = arm(rand, N, 0.5, 0.9, 0.9);
    const B = arm(rand, N, 0.6, 0.9, 0.55);
    // Raw judge delta, normal interval on per-case differences.
    const d = A.f.map((x, i) => B.f[i]! - x);
    const m = d.reduce((s, x) => s + x, 0) / N;
    const sd = Math.sqrt(d.reduce((s, x) => s + (x - m) ** 2, 0) / (N - 1));
    if (m - (z * sd) / Math.sqrt(N) <= truth && truth <= m + (z * sd) / Math.sqrt(N)) rawCover++;
    // Humans label the same cases on both arms (paired).
    const idx = sample(rand, N, n);
    const p = ppiPairedDiff(
      A.f.map((x, i) => ({ a: x, b: B.f[i]! })),
      idx.map((i) => ({ yhatA: A.f[i]!, yhatB: B.f[i]!, yA: A.y[i]!, yB: B.y[i]! })),
    );
    if (p.lo <= truth && truth <= p.hi) pairedCover++;
    // Different cases per arm (independent).
    const ia = sample(rand, N, n);
    const ib = sample(rand, N, n);
    const ea = ppiMean(A.f, ia.map((i) => ({ yhat: A.f[i]!, y: A.y[i]! })));
    const eb = ppiMean(B.f, ib.map((i) => ({ yhat: B.f[i]!, y: B.y[i]! })));
    const q = ppiDelta(ea, eb);
    if (q.lo <= truth && truth <= q.hi) indepCover++;
    // ΔJ through graderPpi on the paired labels.
    const ids = A.f.map((_, i) => `c${i}`);
    const g = graderPpi(
      { a: new Map(ids.map((k, i) => [k, A.f[i]!])), b: new Map(ids.map((k, i) => [k, B.f[i]!])) },
      { a: new Map(idx.map((i) => [ids[i]!, A.y[i]!])), b: new Map(idx.map((i) => [ids[i]!, B.y[i]!])) },
    );
    if (g.warnings.some((w) => w.includes("specificity differs"))) deltaJ++;
  }

  it("reports its coverage", (t) => {
    t.diagnostic(`raw ${rawCover / reps}, paired ${pairedCover / reps}, independent ${indepCover / reps}, ΔJ ${deltaJ / reps}`);
  });
  it("raw judge CI covers the true delta in under 50% of reps", () => {
    assert.ok(rawCover / reps < 0.5, `raw coverage ${rawCover / reps}`);
  });
  it("paired PPI++ covers it at about 95%", () => {
    const c = pairedCover / reps;
    assert.ok(c >= 0.9 && c <= 0.99, `paired coverage ${c}`);
  });
  it("independent PPI++ covers it at 95% or more (conservative)", () => {
    const c = indepCover / reps;
    assert.ok(c >= 0.9 && c <= 1, `independent coverage ${c}`);
  });
  it("the ΔJ warning fires in at least 95% of reps", () => {
    assert.ok(deltaJ / reps >= 0.95, `ΔJ rate ${deltaJ / reps}`);
  });
});

describe("labelMajority", () => {
  it("matches the criterion (no criterion counts for all), drops skip and ties", () => {
    const labels: HumanLabel[] = [
      { caseId: "a", value: "pass" },
      { caseId: "a", value: "fail", criterion: "other" },
      { caseId: "b", value: "fail", criterion: "helpful" },
      { caseId: "c", value: "pass" },
      { caseId: "c", value: "fail" },
      { caseId: "d", value: "skip" },
    ];
    assert.deepEqual([...labelMajority(labels, "helpful")], [
      ["a", 1],
      ["b", 0],
    ]);
  });
});

// ---------------------------------------------------------------- compareExperiments

const ds = createDataset({ name: "ppi", createdAt: 1, cases: Array.from({ length: 60 }, (_, i) => ({ id: `c${i}`, input: i })) });

function exp(id: string, judgePass: (i: number) => boolean): ExperimentResult {
  const runs: CaseRun[] = ds.cases.map((c, i) => ({
    caseId: c.id,
    trial: 1,
    latencyMs: 1,
    startedAt: 0,
    grades: [
      { graderId: "exact", result: { pass: true, score: 1 } },
      { graderId: "helpful", result: { pass: judgePass(i), score: judgePass(i) ? 1 : 0 } },
    ],
    pass: judgePass(i),
  }));
  const graders = [
    { id: "exact", version: "e1", kind: "exact" },
    { id: "helpful", version: "j1", kind: "llm" },
  ];
  return {
    id,
    name: id,
    status: "completed",
    dataset: { id: ds.id, name: ds.name, version: ds.version },
    task: { kind: "function", ref: id },
    graders,
    trials: 1,
    createdAt: 0,
    finishedAt: 1,
    runs,
    summary: summarizeRuns(runs, graders, 1),
  };
}

describe("compareExperiments with human labels", () => {
  // Humans: A passes even cases, B passes even cases and every case i % 3 === 1 → B is better.
  const humanA = (i: number) => i % 2 === 0;
  const humanB = (i: number) => i % 2 === 0 || i % 3 === 1;
  // The judge over-passes B: it also passes every i % 5 === 0 on B.
  const a = exp("A", humanA);
  const b = exp("B", (i) => humanB(i) || i % 5 === 0);
  const labels = (fn: (i: number) => boolean, n: number): HumanLabel[] =>
    Array.from({ length: n }, (_, i) => ({ caseId: `c${i}`, criterion: "helpful", value: fn(i) ? ("pass" as const) : ("fail" as const) }));
  const opts = { iters: 300 };

  it("without labels the comparison is byte-identical (no ppi, no warnings)", () => {
    const plain = compareExperiments(a, b, opts);
    const withEmpty = compareExperiments(a, b, { ...opts, minLabels: 5 });
    assert.equal(JSON.stringify(plain), JSON.stringify(withEmpty));
    for (const g of plain.graders) {
      assert.equal("ppi" in g, false);
      assert.equal("warnings" in g, false);
    }
    assert.doesNotMatch(renderComparison(plain, { color: false }), /corrected B − A|raw \(uncorrected\)/);
  });

  it("with labels the judge grader gets a corrected delta; deterministic graders do not", () => {
    const cmp = compareExperiments(a, b, { ...opts, labels: { a: labels(humanA, 40), b: labels(humanB, 40) } });
    const exact = cmp.graders.find((g) => g.id === "exact")!;
    assert.equal("ppi" in exact, false);
    const g = cmp.graders.find((x) => x.id === "helpful")!;
    assert.ok(g.ppi?.corrected);
    assert.equal(g.ppi.corrected.method, "paired");
    assert.deepEqual(g.ppi.labels, { a: 40, b: 40 });
    // Human truth over the 60 paired cases.
    const truth = ds.cases.reduce((s, _c, i) => s + Number(humanB(i)) - Number(humanA(i)), 0) / 60;
    const d = g.ppi.corrected.diff;
    assert.ok(d.lo <= truth && truth <= d.hi, `${truth} in [${d.lo}, ${d.hi}]`);
    assert.ok(g.ppi.corrected.raw > truth, "the raw judge delta overstates B");
    const text = renderComparison(cmp, { color: false });
    assert.match(text, /judge-corrected B − A \(human scale\)/);
    assert.match(text, /helpful PPI\+\+ paired: 40 \+ 40 human labels/);
    assert.match(text, /exact .*raw \(uncorrected\)/);
  });

  it("under minLabels: no correction and a reason", () => {
    const cmp = compareExperiments(a, b, { ...opts, labels: { a: labels(humanA, 10), b: labels(humanB, 40) } });
    const g = cmp.graders.find((x) => x.id === "helpful")!;
    assert.equal(g.ppi?.corrected, undefined);
    assert.match(g.ppi!.reason!, new RegExp(`at least ${MIN_PPI_LABELS} human labels per arm .*A 10, B 40`));
    assert.match(renderComparison(cmp, { color: false }), /helpful raw \(uncorrected\): needs at least 20/);
  });

  it("labels are never shared across arms: B's labels do not correct A", () => {
    const cmp = compareExperiments(a, b, { ...opts, labels: { a: [], b: labels(humanB, 40) } });
    const g = cmp.graders.find((x) => x.id === "helpful")!;
    assert.equal(g.ppi?.labels.a, 0);
    assert.equal(g.ppi?.corrected, undefined);
  });

  it("labels for another criterion are ignored", () => {
    const other = labels(humanA, 40).map((l) => ({ ...l, criterion: "safety" }));
    const cmp = compareExperiments(a, b, { ...opts, labels: { a: other, b: other } });
    assert.deepEqual(cmp.graders.find((x) => x.id === "helpful")!.ppi?.labels, { a: 0, b: 0 });
    const viaCriteria = compareExperiments(a, b, { ...opts, labels: { a: other, b: other }, criteria: new Map([["helpful", "safety"]]) });
    assert.deepEqual(viaCriteria.graders.find((x) => x.id === "helpful")!.ppi?.labels, { a: 40, b: 40 });
  });
});
