import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mulberry32, pairedPermutation } from "../../src/stats/index.ts";

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
