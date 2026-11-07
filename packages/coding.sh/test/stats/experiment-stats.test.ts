// Cluster bootstrap (EM-1), Fisher's exact test (EM-4) and the paired
// Bayesian posterior (EM-6).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clusteredBootstrap } from "../../src/stats/cluster.ts";
import { pairedBootstrap } from "../../src/stats/interval.ts";
import { betaCdf, pairedPosterior } from "../../src/stats/posterior.ts";
import { binomCdfHalf, fisherExact } from "../../src/stats/tests.ts";

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

describe("clusteredBootstrap", () => {
  const diffs = [1, 1, 1, 1, 0, 0, 0, 0, -1, 0, 1, 0];
  it("one case per cluster is the plain paired bootstrap, draw for draw", () => {
    const ids = diffs.map((_, i) => `c${i}`);
    const c = clusteredBootstrap(diffs, ids, { seed: 7, iters: 3000 });
    const p = pairedBootstrap(diffs, { seed: 7, iters: 3000 });
    assert.deepEqual({ mean: c.mean, lo: c.lo, hi: c.hi, n: c.n, iters: c.iters }, p);
    assert.equal(c.clusters, diffs.length);
  });

  it("correlated clusters widen the interval and keep the plain mean", () => {
    // Three repos whose cases move together: the effective sample is 3, not 12.
    const ids = ["r1", "r1", "r1", "r1", "r2", "r2", "r2", "r2", "r3", "r3", "r3", "r3"];
    const c = clusteredBootstrap(diffs, ids, { seed: 1, iters: 4000 });
    const p = pairedBootstrap(diffs, { seed: 1, iters: 4000 });
    close(c.mean, p.mean, 1e-12);
    assert.equal(c.clusters, 3);
    assert.ok(c.hi - c.lo > p.hi - p.lo, `cluster width ${c.hi - c.lo} > case width ${p.hi - p.lo}`);
    assert.deepEqual(clusteredBootstrap(diffs, ids, { seed: 1, iters: 4000 }), c, "deterministic for a seed");
  });

  it("empty input and mismatched lengths", () => {
    const e = clusteredBootstrap([], []);
    assert.ok(Number.isNaN(e.mean));
    assert.equal(e.clusters, 0);
    assert.throws(() => clusteredBootstrap([1, 2], ["a"]), RangeError);
  });
});

describe("fisherExact", () => {
  it("tea tasting [[3,1],[1,3]] → 0.4857", () => close(fisherExact(3, 1, 1, 3), 34 / 70, 1e-12));
  it("[[1,9],[11,3]] → 0.002759", () => close(fisherExact(1, 9, 11, 3), 0.0027594561852200836, 1e-9));
  it("[[0,10],[10,0]] → 2 / C(20,10)", () => close(fisherExact(0, 10, 10, 0), 2 / 184756, 1e-15));
  it("balanced or empty tables → 1", () => {
    assert.equal(fisherExact(2, 8, 2, 8), 1);
    assert.equal(fisherExact(0, 0, 0, 0), 1);
    assert.equal(fisherExact(0, 20, 0, 20), 1);
  });
  it("symmetric in rows and columns", () => {
    close(fisherExact(6, 14, 0, 20), fisherExact(0, 20, 6, 14), 1e-12);
    close(fisherExact(6, 14, 0, 20), fisherExact(14, 6, 20, 0), 1e-12);
  });
  it("rejects bad counts", () => assert.throws(() => fisherExact(1.5, 1, 1, 1), RangeError));
});

describe("betaCdf", () => {
  it("matches closed forms", () => {
    close(betaCdf(0.5, 2, 3), 11 / 16, 1e-12); // I_x(2,3) = 1 − (1−x)³(1+3x)
    close(betaCdf(0.3, 1, 1), 0.3, 1e-12);
    close(betaCdf(0.5, 7.5, 7.5), 0.5, 1e-12);
    close(betaCdf(0.25, 0.5, 0.5), 1 / 3, 1e-10); // arcsine: (2/π) asin(√x)
    assert.equal(betaCdf(0, 2, 2), 0);
    assert.equal(betaCdf(1, 2, 2), 1);
  });
});

describe("pairedPosterior", () => {
  it("no discordant pairs → P(B>A) = 0.5, centred on 0", () => {
    const q = pairedPosterior(0, 0, 20);
    close(q.pBetter, 0.5, 1e-12);
    close(q.mean, 0, 1e-12);
    assert.ok(q.lo < 0 && q.hi > 0);
  });

  it("uniform prior: P(B>A) equals the binomial identity on discordant pairs", () => {
    // θ ~ Beta(c+1, b+1): P(θ > ½) = P(Bin(b+c+1, ½) ≤ c).
    for (const [b, c] of [
      [3, 7],
      [0, 5],
      [6, 0],
      [10, 12],
    ] as const) {
      close(pairedPosterior(b, c, 10).pBetter, binomCdfHalf(c, b + c + 1), 1e-10);
    }
  });

  it("mean is (c − b) / (N + 4α); the credible interval brackets it and is seeded", () => {
    const q = pairedPosterior(3, 7, 10, { seed: 3 });
    close(q.mean, 4 / 24, 1e-12);
    assert.ok(q.lo < q.mean && q.mean < q.hi);
    assert.ok(q.lo > -0.3 && q.hi < 0.6);
    assert.deepEqual(pairedPosterior(3, 7, 10, { seed: 3 }), q);
    // Mirror image.
    close(pairedPosterior(7, 3, 10).pBetter, 1 - q.pBetter, 1e-12);
  });

  it("a non-integer prior works and pulls less", () => {
    const j = pairedPosterior(0, 6, 4, { prior: 0.5 });
    const u = pairedPosterior(0, 6, 4);
    assert.ok(j.pBetter > u.pBetter && j.pBetter < 1);
    assert.equal(j.prior, 0.5);
  });

  it("rejects bad input", () => {
    assert.throws(() => pairedPosterior(-1, 0, 0), RangeError);
    assert.throws(() => pairedPosterior(1, 1, 1, { prior: 0 }), RangeError);
  });
});
