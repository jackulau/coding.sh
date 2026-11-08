// AC-8: Seq@K curve, unbiased pass@k, gain shares, protocol fronts, rank agreement (arXiv 2610.37859).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gainShares, mulberry32, passAllK, passAtK, protocolFront, rankAgreement, seqCurve, unchangedRate, type SeqCase } from "../../src/stats/index.ts";

const close = (a: number | undefined, b: number, eps = 1e-9) => assert.ok(a !== undefined && Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

/** Brute force: share of the C(n, k) k-subsets that hold at least one of the c passes. */
function bruteForce(n: number, c: number, k: number): number {
  let hit = 0;
  let all = 0;
  const walk = (start: number, left: number, any: boolean) => {
    if (left === 0) {
      all++;
      if (any) hit++;
      return;
    }
    for (let i = start; i <= n - left; i++) walk(i + 1, left - 1, any || i < c);
  };
  walk(0, k, false);
  return hit / all;
}

/** Brute force: share of the C(n, k) k-subsets that hold only passes. */
function bruteForceAll(n: number, c: number, k: number): number {
  let hit = 0;
  let all = 0;
  const walk = (start: number, left: number, every: boolean) => {
    if (left === 0) {
      all++;
      if (every) hit++;
      return;
    }
    for (let i = start; i <= n - left; i++) walk(i + 1, left - 1, every && i < c);
  };
  walk(0, k, true);
  return hit / all;
}

describe("passAllK (pass^k, tau-bench)", () => {
  it("matches the known values", () => {
    close(passAllK(3, 3, 3), 1);
    close(passAllK(3, 2, 3), 0);
    close(passAllK(10, 3, 1), 0.3);
    close(passAllK(4, 3, 2), 3 / 6); // C(3,2)/C(4,2)
  });

  it("matches brute force for every n ≤ 8", () => {
    for (let n = 1; n <= 8; n++) for (let c = 0; c <= n; c++) for (let k = 1; k <= n; k++) close(passAllK(n, c, k), bruteForceAll(n, c, k), 1e-12);
  });

  it("rejects k outside [1, n]", () => {
    assert.throws(() => passAllK(3, 1, 4), RangeError);
    assert.throws(() => passAllK(3, 1, 0), RangeError);
  });
});

describe("passAtK (Chen et al. 2021, Eq. 1)", () => {
  it("matches the known values", () => {
    close(passAtK(10, 3, 1), 0.3);
    close(passAtK(10, 3, 5), 1 - 21 / 252); // 1 − C(7,5)/C(10,5) ≈ 0.9167
    close(passAtK(5, 0, 3), 0);
    close(passAtK(5, 3, 3), 1); // n − c = 2 < k
    close(passAtK(5, 5, 1), 1);
  });

  it("matches brute force for every n ≤ 8", () => {
    for (let n = 1; n <= 8; n++) for (let c = 0; c <= n; c++) for (let k = 1; k <= n; k++) close(passAtK(n, c, k), bruteForce(n, c, k), 1e-12);
  });

  it("stays finite for large n", () => {
    const p = passAtK(2000, 3, 100);
    assert.ok(p > 0 && p < 1);
  });

  it("rejects k outside [1, n] and c outside [0, n]", () => {
    assert.throws(() => passAtK(3, 1, 4), RangeError);
    assert.throws(() => passAtK(3, 1, 0), RangeError);
    assert.throws(() => passAtK(3, 4, 1), RangeError);
    assert.throws(() => passAtK(3, -1, 1), RangeError);
    assert.throws(() => passAtK(3, 1.5, 1), RangeError);
  });
});

describe("seqCurve and gainShares (arXiv 2610.37859 Eq. 2, §5)", () => {
  const four: SeqCase[] = [
    { id: "a", solvedAt: [1] },
    { id: "b", solvedAt: [2] },
    { id: "c", solvedAt: [null] },
    { id: "d", solvedAt: [3] },
  ];

  it("solvedAt [1], [2], [null], [3] with K = 3 → 0.25, 0.5, 0.75; EGS 0.5, LGS 0.5", () => {
    const curve = seqCurve(four, 3);
    assert.deepEqual(
      curve.map((p) => [p.k, p.rate]),
      [
        [1, 0.25],
        [2, 0.5],
        [3, 0.75],
      ],
    );
    assert.deepEqual(gainShares(curve), { egs: 0.5, lgs: 0.5 });
  });

  it("one trial per case uses Wilson", () => {
    const curve = seqCurve(four, 3);
    for (const p of curve) {
      assert.ok(p.lo <= p.rate && p.rate <= p.hi);
      assert.ok(p.lo >= 0 && p.hi <= 1);
    }
    // Wilson 1/4 at z = 1.96: [0.0456, 0.6994].
    close(curve[0]!.lo, 0.04558726, 1e-6);
    close(curve[0]!.hi, 0.69935816, 1e-6);
  });

  it("a flat curve has no gain shares; K < 2 has none; K = 2 has EGS only", () => {
    assert.deepEqual(gainShares(seqCurve([{ id: "a", solvedAt: [1] }, { id: "b", solvedAt: [null] }], 3)), {});
    assert.deepEqual(gainShares([{ rate: 0.4 }]), {});
    assert.deepEqual(gainShares([{ rate: 0.2 }, { rate: 0.6 }]), { egs: 1 });
  });

  it("solved past K does not count; empty input gives no points", () => {
    assert.deepEqual(
      seqCurve([{ id: "a", solvedAt: [5] }], 2).map((p) => p.rate),
      [0, 0],
    );
    assert.deepEqual(seqCurve([], 3), []);
    assert.throws(() => seqCurve(four, 0), RangeError);
    assert.throws(() => seqCurve([{ id: "x", solvedAt: [] }], 2), RangeError);
    assert.throws(() => seqCurve([{ id: "x", solvedAt: [0] }], 2), RangeError);
  });

  it("several trials per case: the cluster bootstrap CI contains the point and is seed-stable", () => {
    const cases: SeqCase[] = [
      { id: "a", solvedAt: [1, 2, null] },
      { id: "b", solvedAt: [2, 2, 3] },
      { id: "c", solvedAt: [null, null, 1] },
      { id: "d", solvedAt: [1, 1, 1] },
      { id: "e", solvedAt: [3, null, 2] },
    ];
    const c1 = seqCurve(cases, 3, { seed: 9, iters: 2000 });
    const c2 = seqCurve(cases, 3, { seed: 9, iters: 2000 });
    assert.deepEqual(c1, c2);
    close(c1[0]!.rate, (1 / 3 + 0 + 1 / 3 + 1 + 0) / 5);
    for (const p of c1) assert.ok(p.lo <= p.rate && p.rate <= p.hi, JSON.stringify(p));
    for (let j = 1; j < c1.length; j++) assert.ok(c1[j]!.lo >= c1[j - 1]!.lo && c1[j]!.hi >= c1[j - 1]!.hi);
  });

  it("property: 200 seeded matrices give monotone curves and shares in [0, 1]", () => {
    const rnd = mulberry32(42);
    for (let m = 0; m < 200; m++) {
      const K = 1 + Math.floor(rnd() * 5);
      const trials = 1 + Math.floor(rnd() * 3);
      const cases: SeqCase[] = Array.from({ length: 1 + Math.floor(rnd() * 8) }, (_, i) => ({
        id: `t${i}`,
        solvedAt: Array.from({ length: trials }, () => (rnd() < 0.3 ? null : 1 + Math.floor(rnd() * (K + 1)))),
      }));
      const curve = seqCurve(cases, K, { seed: m, iters: 200 });
      for (let j = 1; j < curve.length; j++) {
        assert.ok(curve[j]!.rate >= curve[j - 1]!.rate - 1e-12);
        assert.ok(curve[j]!.lo >= curve[j - 1]!.lo - 1e-12);
        assert.ok(curve[j]!.hi >= curve[j - 1]!.hi - 1e-12);
      }
      const g = gainShares(curve);
      for (const v of [g.egs, g.lgs]) if (v !== undefined) assert.ok(v >= -1e-12 && v <= 1 + 1e-12, `${v}`);
    }
  });
});

describe("protocolFront (arXiv 2610.37859 §6)", () => {
  it("keeps the nondominated points of each protocol and marks the overall front", () => {
    const front = protocolFront([
      { protocol: "pass@k", k: 1, cost: 1, success: 0.4 },
      { protocol: "pass@k", k: 2, cost: 2, success: 0.5 },
      { protocol: "pass@k", k: 3, cost: 3, success: 0.5 }, // dominated by k=2
      { protocol: "seq@k", k: 1, cost: 1, success: 0.4 },
      { protocol: "seq@k", k: 2, cost: 1.5, success: 0.6 },
      { protocol: "seq@k", k: 3, cost: 2.5, success: 0.7 },
      { protocol: "seq@k", k: 4, cost: Number.NaN, success: 0.9 }, // dropped
    ]);
    assert.deepEqual(
      front.map((p) => `${p.protocol}:${p.k}:${p.overall ? "*" : ""}`),
      ["pass@k:1:*", "pass@k:2:", "seq@k:1:*", "seq@k:2:*", "seq@k:3:*"],
    );
  });

  it("keeps one of exact duplicates, the smaller k", () => {
    const front = protocolFront([
      { protocol: "p", k: 2, cost: 1, success: 0.5 },
      { protocol: "p", k: 1, cost: 1, success: 0.5 },
      { protocol: "p", k: 1, cost: 1, success: 0.5 },
    ]);
    assert.equal(front.length, 1);
    assert.equal(front[0]!.k, 1);
  });
});

describe("rankAgreement", () => {
  it("identical rankings: τ = ρ = 1, no flips", () => {
    const r = rankAgreement({ a: 4, b: 3, c: 2, d: 1 }, { a: 0.9, b: 0.8, c: 0.5, d: 0.1 });
    assert.equal(r.n, 4);
    close(r.kendallTau, 1);
    close(r.spearman, 1);
    assert.deepEqual(r.flipped, []);
  });

  it("reversed 4: τ = −1 and 6 flips, largest gap in b first", () => {
    const r = rankAgreement({ a: 4, b: 3, c: 2, d: 1 }, { a: 1, b: 2, c: 3, d: 4 });
    close(r.kendallTau, -1);
    close(r.spearman, -1);
    assert.equal(r.flipped.length, 6);
    assert.deepEqual(r.flipped[0], { higherInA: "a", higherInB: "d", gapA: 3, gapB: 3 });
  });

  it("one adjacent swap: 1 flip, τ = 4/6", () => {
    const r = rankAgreement(new Map([["a", 4], ["b", 3], ["c", 2], ["d", 1]]), new Map([["a", 4], ["b", 2], ["c", 3], ["d", 1]]));
    assert.deepEqual(r.flipped.map((f) => [f.higherInA, f.higherInB]), [["b", "c"]]);
    close(r.kendallTau, (5 - 1) / 6);
    close(r.spearman, 1 - (6 * 2) / (4 * 15)); // 1 − 6Σd²/(n(n²−1)) = 0.8
  });

  it("ties use τ-b; only shared items count; n < 2 has no τ or ρ", () => {
    // a: x=y > z, b: x > y > z → n_c = 2, n_d = 0, t_a = 1, t_b = 0: τ-b = 2/√(2·3).
    const r = rankAgreement({ x: 2, y: 2, z: 1, only: 9 }, { x: 3, y: 2, z: 1 });
    assert.equal(r.n, 3);
    close(r.kendallTau, 2 / Math.sqrt(6));
    const one = rankAgreement({ x: 1 }, { x: 2 });
    assert.equal(one.n, 1);
    assert.equal(one.kendallTau, undefined);
    assert.equal(one.spearman, undefined);
    const flat = rankAgreement({ x: 1, y: 1 }, { x: 1, y: 2 });
    assert.equal(flat.kendallTau, undefined);
    assert.equal(flat.spearman, undefined);
  });
});

describe("unchangedRate", () => {
  it("ignores whitespace differences, counts real changes", () => {
    assert.equal(unchangedRate([{ prev: "a  b", next: " a b\n" }]), 1);
    assert.equal(unchangedRate([{ prev: "a", next: "b" }]), 0);
    assert.equal(unchangedRate([{ prev: "a", next: "a" }, { prev: "a", next: "b" }, { prev: "x", next: "y" }, { prev: "", next: " " }]), 0.5);
    assert.equal(unchangedRate([]), undefined);
  });
});
