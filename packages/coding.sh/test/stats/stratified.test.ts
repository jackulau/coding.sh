// AB-15: stratified audit estimator, proportional allocation, Hoeffding budget,
// label efficiency η and the judge cost break-even (Choi et al., arXiv 2610.35698).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { allocateProportional, binStrata, hoeffdingBudget, judgeBreakEven, labelEfficiency, mulberry32, stratifiedMean } from "../../src/stats/index.ts";

const near = (got: number, want: number, tol: number, what = "") => assert.ok(Math.abs(got - want) <= tol, `${what} ${got} vs ${want} ± ${tol}`);

describe("labelEfficiency (Eq.4-7)", () => {
  it("the paper's pooled GPT-5.5 point: s 0.844, α 0.402 at θ 0.8 → η 0.2073", () => {
    const e = labelEfficiency(0.8, 0.844, 0.402);
    near(e.eta, 0.2073, 1e-3, "η");
    near(e.gap, 0.442, 1e-12, "gap");
  });

  it("a sharp judge (s 0.95, α 0.05) at θ 0.5 → η 4.263", () => {
    const e = labelEfficiency(0.5, 0.95, 0.05);
    near(e.eta, 4.263, 1e-3, "η");
    // Symmetric judge at θ 0.5: the oracle split is even.
    near(e.n1Share, 0.5, 1e-12, "n1Share");
    // By hand: A = (0.5·√.0475 + 0.5·√.0475)² / 0.9² = 0.0475 / 0.81.
    near(e.A, 0.0475 / 0.81, 1e-12, "A");
    near(e.D, 0.25 / 0.81, 1e-12, "D");
  });

  it("no discrimination (gap ≤ 0): η 0, A ∞", () => {
    const e = labelEfficiency(0.6, 0.5, 0.5);
    assert.equal(e.eta, 0);
    assert.equal(e.A, Infinity);
  });

  it("inputs outside [0, 1] throw", () => {
    assert.throws(() => labelEfficiency(1.2, 0.9, 0.1), RangeError);
    assert.throws(() => labelEfficiency(0.5, -0.1, 0.1), RangeError);
  });
});

describe("judgeBreakEven (Eq.8)", () => {
  it("(0.5, 0.95, 0.05) at $0.001 per judge call → $0.004643 per human label", () => {
    near(judgeBreakEven(0.5, 0.95, 0.05, 0.001), 0.004643, 1e-5);
  });
  it("η ≤ 1 never breaks even", () => {
    assert.equal(judgeBreakEven(0.8, 0.844, 0.402, 0.001), Infinity);
  });
  it("is the cost where the two designs' variance at a fixed budget is equal", () => {
    // Budget B: direct audit gives θ(1−θ)c_H/B; the judge design (√(A c_H) + √(D c_L))²/B (Eq.8's derivation).
    const [t, s, a, cL] = [0.3, 0.9, 0.08, 0.002];
    const cH = judgeBreakEven(t, s, a, cL);
    const e = labelEfficiency(t, s, a);
    near((Math.sqrt(e.A * cH) + Math.sqrt(e.D * cL)) ** 2, t * (1 - t) * cH, 1e-12, "variance × budget");
  });
});

describe("hoeffdingBudget (Eq.3)", () => {
  it("±0.05 at 95% needs 738 labels", () => {
    assert.equal(hoeffdingBudget(0.05, 0.05), 738);
  });
});

describe("allocateProportional (App. B.2)", () => {
  it("[700, 200, 100] with 50 labels → [35, 10, 5]", () => {
    assert.deepEqual(allocateProportional([700, 200, 100], 50), { n: [35, 10, 5], clamped: false });
  });
  it("keeps 1 ≤ n_j ≤ N_j and spends the whole budget", () => {
    const r = allocateProportional([1000, 2, 1], 10);
    assert.equal(r.n.reduce((s, x) => s + x, 0), 10);
    r.n.forEach((x, j) => assert.ok(x >= 1 && x <= [1000, 2, 1][j]!));
  });
  it("clamps a budget above the population", () => {
    assert.deepEqual(allocateProportional([5, 5], 20), { n: [5, 5], clamped: true });
  });
  it("empty strata get nothing; a budget below the nonempty strata throws", () => {
    assert.deepEqual(allocateProportional([0, 10, 10], 4).n, [0, 2, 2]);
    assert.throws(() => allocateProportional([5, 5, 5], 2), RangeError);
  });
});

describe("binStrata", () => {
  it("merges a 3-item top bin into its neighbour at minSize 25", () => {
    const rand = mulberry32(1);
    const values = [
      ...Array.from({ length: 40 }, () => 0.1 + rand() * 0.09),
      ...Array.from({ length: 40 }, () => 0.3 + rand() * 0.09),
      ...Array.from({ length: 40 }, () => 0.5 + rand() * 0.09),
      ...Array.from({ length: 40 }, () => 0.7 + rand() * 0.09),
      0.85,
      0.9,
      1,
    ];
    const r = binStrata(values);
    assert.deepEqual(
      r.strata.map((s) => [s.lo, s.hi, s.size]),
      [
        [0, 0.2, 40],
        [0.2, 0.4, 40],
        [0.4, 0.6, 40],
        [0.6, 1, 43],
      ],
    );
    assert.equal(r.index.at(-1), 3);
    assert.equal(r.index[0], 0);
  });
  it("undefined values form an unmerged unknown stratum", () => {
    const r = binStrata([0.1, undefined, 0.9, undefined], { minSize: 1 });
    assert.equal(r.strata.at(-1)?.unknown, true);
    assert.equal(r.strata.at(-1)?.size, 2);
    assert.equal(r.index[1], r.strata.length - 1);
  });
  it("collapses to one stratum when nothing reaches minSize", () => {
    const r = binStrata([0.1, 0.5, 0.9]);
    assert.equal(r.strata.length, 1);
    assert.deepEqual(r.index, [0, 0, 0]);
  });
});

describe("stratifiedMean (Eq.1-3)", () => {
  it("a census (n_j = N_j) returns the exact mean with se 0", () => {
    const r = stratifiedMean([
      { N: 10, n: 10, successes: 7 },
      { N: 30, n: 30, successes: 3 },
    ]);
    near(r.p, 10 / 40, 1e-12);
    assert.equal(r.se, 0);
    near(r.bounds.lo, 0.25, 1e-12);
    near(r.bounds.hi, 0.25, 1e-12);
  });
  it("matches Eq.1-3 by hand on two strata", () => {
    // π = (0.75, 0.25); p̂ = (0.8, 0.4); S² = n/(n−1)·p(1−p); FPC (1 − n/N).
    const r = stratifiedMean([
      { N: 300, n: 10, successes: 8 },
      { N: 100, n: 5, successes: 2 },
    ]);
    near(r.p, 0.75 * 0.8 + 0.25 * 0.4, 1e-12, "p");
    const v = (0.75 ** 2 * (1 - 10 / 300) * ((10 / 9) * 0.16)) / 10 + (0.25 ** 2 * (1 - 5 / 100) * ((5 / 4) * 0.24)) / 5;
    near(r.se, Math.sqrt(v), 1e-12, "se");
    near(r.hoeffdingEps, Math.sqrt((Math.log(40) * (0.75 ** 2 / 10 + 0.25 ** 2 / 5)) / 2), 1e-12, "ε");
    // §3.1 bounds bracket p.
    assert.ok(r.bounds.lo <= r.p && r.p <= r.bounds.hi);
  });
  it("a stratum with no labels leaves p unknown but keeps the bounds", () => {
    const r = stratifiedMean([
      { N: 50, n: 50, successes: 50 },
      { N: 50, n: 0, successes: 0 },
    ]);
    assert.ok(Number.isNaN(r.p));
    assert.deepEqual(r.bounds, { lo: 0.5, hi: 1 });
  });
  it("rejects impossible counts", () => {
    assert.throws(() => stratifiedMean([{ N: 5, n: 6, successes: 1 }]), RangeError);
  });

  it("Monte Carlo (2000 reps): proportional is unbiased, beats equal shares, covers ~95%, and stays inside ε", () => {
    // Population 2000 in confidence strata with falling accuracy; budget 100.
    const sizes = [1400, 400, 150, 50];
    const acc = [0.95, 0.8, 0.5, 0.3];
    const pop = sizes.map((N, j) => {
      const k = Math.round(N * acc[j]!);
      return Array.from({ length: N }, (_, i) => i < k);
    });
    const truth = pop.flat().filter(Boolean).length / 2000;
    const rand = mulberry32(2026);
    const draw = (xs: boolean[], n: number) => {
      // Partial Fisher-Yates: n items without replacement.
      const a = xs.slice();
      let s = 0;
      for (let i = 0; i < n; i++) {
        const j = i + Math.floor(rand() * (a.length - i));
        [a[i], a[j]] = [a[j]!, a[i]!];
        if (a[i]) s++;
      }
      return s;
    };
    const prop = allocateProportional(sizes, 100).n;
    const equal = [25, 25, 25, 25];
    const run = (alloc: number[]) => stratifiedMean(alloc.map((n, j) => ({ N: sizes[j]!, n, successes: draw(pop[j]!, n) })));
    const reps = 2000;
    let bias = 0;
    let sqP = 0;
    let sqE = 0;
    let covered = 0;
    let beyondEps = 0;
    for (let r = 0; r < reps; r++) {
      const p = run(prop);
      const e = run(equal);
      const err = p.p - truth;
      bias += err;
      sqP += err * err;
      sqE += (e.p - truth) ** 2;
      if (p.lo <= truth && truth <= p.hi) covered++;
      if (Math.abs(err) >= p.hoeffdingEps) beyondEps++;
    }
    near(bias / reps, 0, 0.005, "bias");
    assert.ok(Math.sqrt(sqP / reps) < Math.sqrt(sqE / reps), `RMSE proportional ${Math.sqrt(sqP / reps)} vs equal ${Math.sqrt(sqE / reps)}`);
    const cov = covered / reps;
    assert.ok(cov >= 0.92 && cov <= 0.97, `coverage ${cov}`);
    assert.ok(beyondEps / reps <= 0.05, `P(|err| ≥ ε) ${beyondEps / reps}`);
  });
});
