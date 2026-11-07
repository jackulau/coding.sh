import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clusteredBootstrap, hardRegressions, mulberry32, nonInferiority, pairedBootstrap, pairedPermutation } from "../../src/stats/index.ts";

describe("pairedPermutation", () => {
  it("matches hand counts: [1,1,1,1,1] is 2/32 two-sided and 1/32 greater", () => {
    const two = pairedPermutation([1, 1, 1, 1, 1]);
    assert.equal(two.p, 2 / 32);
    assert.equal(two.method, "exact");
    assert.equal(two.n, 5);
    assert.equal(two.observed, 1);
    assert.equal(pairedPermutation([1, 1, 1, 1, 1], { alternative: "greater" }).p, 1 / 32);
    assert.equal(pairedPermutation([1, 1, 1, 1, 1], { alternative: "less" }).p, 1);
  });

  it("is 1 for all zeros, for a symmetric set and for no pairs", () => {
    assert.equal(pairedPermutation([0, 0, 0, 0]).p, 1);
    assert.equal(pairedPermutation([1, -1, 2, -2]).p, 1);
    const empty = pairedPermutation([]);
    assert.equal(empty.p, 1);
    assert.equal(empty.n, 0);
  });

  // Reference: scipy 1.18.1, scipy.stats.permutation_test((d, zeros), mean(x - y),
  // permutation_type="samples", n_resamples=np.inf, alternative=…), computed once on 2026-11-07.
  const SCIPY: { d: number[]; two: number; greater: number; less: number }[] = [
    { d: [1, -1, 2, -2], two: 1, greater: 0.625, less: 0.625 },
    { d: [0.5, -0.25, 1, 0.75, 0, 0.5, -0.5, 1, 0.25, 0.333], two: 0.06640625, greater: 0.033203125, less: 0.98046875 },
    { d: [-0.012, -0.004, 0.001, -0.02, -0.007, 0.003, -0.015, -0.009], two: 0.0390625, greater: 0.98828125, less: 0.01953125 },
  ];
  for (const ref of SCIPY) {
    it(`matches scipy on [${ref.d.join(", ")}]`, () => {
      assert.equal(pairedPermutation(ref.d).p, ref.two);
      assert.equal(pairedPermutation(ref.d, { alternative: "greater" }).p, ref.greater);
      assert.equal(pairedPermutation(ref.d, { alternative: "less" }).p, ref.less);
    });
  }

  it("does not depend on the order of the pairs", () => {
    const d = [0.5, -0.25, 1, 0.75, 0, 0.5, -0.5, 1, 0.25, 0.333];
    const rand = mulberry32(3);
    const shuffled = [...d].sort(() => rand() - 0.5);
    assert.equal(pairedPermutation(shuffled).p, pairedPermutation(d).p);
  });

  it("Monte Carlo above exactMaxN is reproducible and within 0.01 of the exact p (n = 25)", () => {
    const rand = mulberry32(11);
    const d = Array.from({ length: 25 }, () => Math.round((rand() - 0.4) * 8) / 4);
    const exact = pairedPermutation(d, { exactMaxN: 25 });
    assert.equal(exact.method, "exact");
    const mc = pairedPermutation(d, { seed: 7 });
    assert.equal(mc.method, "monte-carlo");
    assert.equal(mc.iters, 20_000);
    assert.deepEqual(pairedPermutation(d, { seed: 7 }), mc);
    assert.ok(Math.abs(mc.p - exact.p) < 0.01, `MC ${mc.p} vs exact ${exact.p}`);
    assert.ok(mc.p > 0);
  });

  it("enumerates 2^20 sign flips in under a second", () => {
    const d = Array.from({ length: 20 }, (_, i) => ((i % 5) - 1.5) / 3);
    const t0 = performance.now();
    const r = pairedPermutation(d);
    assert.equal(r.method, "exact");
    assert.ok(performance.now() - t0 < 1000, `took ${performance.now() - t0} ms`);
  });

  it("rejects non-finite differences", () => {
    assert.throws(() => pairedPermutation([1, NaN]), RangeError);
  });
});

describe("nonInferiority", () => {
  it("all-zero differences are non-inferior at δ 0.05", () => {
    const r = nonInferiority(new Array(50).fill(0), 0.05);
    assert.equal(r.lower, 0);
    assert.equal(r.nonInferior, true);
    assert.equal(r.n, 50);
    assert.equal(r.alpha, 0.05);
  });

  it("a mean of −0.1 with a small spread is not non-inferior at δ 0.05", () => {
    const rand = mulberry32(5);
    const d = Array.from({ length: 80 }, () => -0.1 + (rand() - 0.5) * 0.04);
    const r = nonInferiority(d, 0.05);
    assert.ok(r.lower < -0.05, String(r.lower));
    assert.equal(r.nonInferior, false);
  });

  it("no pairs: not non-inferior, lower NaN", () => {
    const r = nonInferiority([], 0.05);
    assert.equal(r.nonInferior, false);
    assert.ok(Number.isNaN(r.lower));
  });

  it("is the α percentile of the paired bootstrap: the lower end of its 1 − 2α interval, same seed twice", () => {
    const rand = mulberry32(9);
    const d = Array.from({ length: 60 }, (): number => (rand() < 0.2 ? -1 : rand() < 0.25 ? 1 : 0));
    const r = nonInferiority(d, 0.03, { seed: 4 });
    assert.equal(r.lower, pairedBootstrap(d, { seed: 4, alpha: 0.1 }).lo);
    assert.deepEqual(nonInferiority(d, 0.03, { seed: 4 }), r);
  });

  it("agrees with the normal-theory bound mean − z₀.₉₅·sd/√n at large n", () => {
    const rand = mulberry32(21);
    const d = Array.from({ length: 2000 }, (): number => (rand() < 0.3 ? -1 : rand() < 0.4 ? 1 : 0));
    const m = d.reduce((s, x) => s + x, 0) / d.length;
    const sd = Math.sqrt(d.reduce((s, x) => s + (x - m) ** 2, 0) / (d.length - 1));
    const normal = m - 1.6448536269514722 * (sd / Math.sqrt(d.length));
    assert.ok(Math.abs(nonInferiority(d, 0.05).lower - normal) < 0.004, `${nonInferiority(d, 0.05).lower} vs ${normal}`);
  });

  it("rejects H0 about α of the time when B is exactly δ worse", () => {
    // Paired ±1/0 outcomes with true mean −δ; the bootstrap test should claim non-inferiority ≈ 5% of runs.
    const rand = mulberry32(77);
    const delta = 0.1;
    let claims = 0;
    const reps = 300;
    for (let r = 0; r < reps; r++) {
      const d = Array.from({ length: 150 }, () => {
        const u = rand();
        return u < 0.3 ? -1 : u < 0.5 ? 1 : 0; // mean 0.2 − 0.3 = −0.1
      });
      if (nonInferiority(d, delta, { iters: 2000, seed: r }).nonInferior) claims++;
    }
    assert.ok(claims / reps < 0.1, `type I error ${claims / reps}`);
  });

  it("clusters: resamples whole clusters", () => {
    const d = [0.5, 0.5, -0.5, -0.5, 0, 0];
    const r = nonInferiority(d, 0.2, { clusterIds: ["a", "a", "b", "b", "c", "c"], seed: 1 });
    assert.equal(r.lower, clusteredBootstrap(d, ["a", "a", "b", "b", "c", "c"], { seed: 1, alpha: 0.1 }).lo);
  });

  it("rejects a negative margin", () => {
    assert.throws(() => nonInferiority([0], -0.1), RangeError);
  });
});

describe("hardRegressions", () => {
  it("flags pass^k cases the candidate now mostly fails, not cases the baseline only sometimes passed", () => {
    const base = new Map([
      ["a", [true, true, true]],
      ["b", [true, false, true]],
      ["c", [true, true, true]],
      ["d", [true, true, true]],
    ]);
    const cand = new Map([
      ["a", [false, false, true]],
      ["b", [false, false, false]],
      ["c", [true, false, true]],
    ]);
    assert.deepEqual(hardRegressions(base, cand), ["a"]);
    assert.deepEqual(hardRegressions(base, cand, 2 / 3), ["a", "c"]);
  });
});
