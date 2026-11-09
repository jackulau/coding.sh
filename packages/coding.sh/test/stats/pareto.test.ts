// AA-17: Bayesian-bootstrap Pareto support and P(on the frontier) (ParetoSaddler, arXiv 2611.02079).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dominates, frontierSupport, mulberry32, paretoSupport, type ParetoCase, type QC } from "../../src/stats/index.ts";

const runs = (q: number[], c: number | number[]): QC[] => q.map((x, i) => ({ q: x, c: Array.isArray(c) ? (c[i] as number) : c }));

/** n cases × r runs with seeded noise around (q, c) per arm. */
function noisy(n: number, r: number, base: { q: number; c: number }, cand: { q: number; c: number }, noise: number, seed = 7): ParetoCase[] {
  const rnd = mulberry32(seed);
  const jit = (x: number) => x * (1 + noise * (rnd() * 2 - 1));
  return Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    base: Array.from({ length: r }, () => ({ q: base.q, c: jit(base.c) })),
    cand: Array.from({ length: r }, () => ({ q: cand.q, c: jit(cand.c) })),
  }));
}

describe("paretoSupport (AA-17)", () => {
  it("is byte-identical for a fixed seed", () => {
    const cases = noisy(10, 3, { q: 0.6, c: 0.1 }, { q: 0.6, c: 0.08 }, 0.3);
    assert.equal(JSON.stringify(paretoSupport(cases, { seed: 3, draws: 2000 })), JSON.stringify(paretoSupport(cases, { seed: 3, draws: 2000 })));
  });

  it("same quality, 30% cheaper, low noise (10 × 3): support ≥ 0.99, promote via the cost branch", () => {
    const p = paretoSupport(noisy(10, 3, { q: 1, c: 0.1 }, { q: 1, c: 0.07 }, 0.05), { seed: 1 });
    assert.ok(p.support >= 0.99, String(p.support));
    assert.equal(p.promote, true);
    assert.ok(p.pCostCut > 0.99);
    assert.equal(p.pQualityGain, 0);
    assert.deepEqual(p.branchShares, { quality: 0, cost: 1 });
    assert.ok(Math.abs(p.dC.mean + 0.3) < 0.05, String(p.dC.mean));
    assert.equal(p.dC.scale, "relative");
    assert.deepEqual([p.cases, p.runs.base, p.runs.cand], [10, 30, 30]);
  });

  it("one case that improves has support 1 but is held: its exact one-sided p is 1/2 > 1 − γ", () => {
    const one = paretoSupport([{ id: "t0", base: runs([0], 1), cand: runs([1], 1) }], { seed: 1, draws: 2000 });
    assert.equal(one.support, 1);
    assert.deepEqual(one.exact, { pQuality: 0.5, pCost: 1, level: 1 - 0.7 });
    assert.equal(one.promote, false);
    assert.match(one.notes.join("\n"), /exact sign-flip test over 1 case gives p 0\.500 > 0\.30/);
    // Two cases reach 1/4 ≤ 0.3; a cheaper single case is held the same way on the cost side.
    const two = paretoSupport(["t0", "t1"].map((id) => ({ id, base: runs([0], 1), cand: runs([1], 1) })), { seed: 1, draws: 2000 });
    assert.equal(two.exact.pQuality, 0.25);
    assert.equal(two.promote, true);
    const cheaper = paretoSupport([{ id: "t0", base: runs([1], 1), cand: runs([1], 0.5) }], { seed: 1, draws: 2000 });
    assert.deepEqual([cheaper.support, cheaper.exact.pCost, cheaper.promote], [1, 0.5, false]);
  });

  it("a lucky single run (net +1 pass, equal cost) has dQ > 0 but no promote", () => {
    const cases: ParetoCase[] = [];
    for (let i = 0; i < 4; i++) cases.push({ id: `l${i}`, base: runs([1, 1, 0], 1), cand: runs([1, 0, 0], 1) });
    for (let i = 0; i < 5; i++) cases.push({ id: `w${i}`, base: runs([1, 0, 0], 1), cand: runs([1, 1, 0], 1) });
    cases.push({ id: "same", base: runs([1, 1, 1], 1), cand: runs([1, 1, 1], 1) });
    const p = paretoSupport(cases, { seed: 2 });
    assert.ok(p.dQ.mean > 0);
    assert.ok(p.support < 0.7, String(p.support));
    assert.equal(p.promote, false);
    // Equal cost: the cost branch never holds.
    assert.equal(p.pCostCut, 0);
  });

  it("50% cheaper at dQ −0.05: promoted at εQ=0.1, not at εQ=0", () => {
    const cases = Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, base: runs([1, 1, 1], 0.1), cand: runs([0.95, 0.95, 0.95], 0.05) }));
    assert.equal(paretoSupport(cases, { seed: 1 }).promote, true);
    const strict = paretoSupport(cases, { seed: 1, epsQ: 0 });
    assert.equal(strict.promote, false);
    assert.equal(strict.support, 0);
  });

  it("εC=0.2 blocks a quality gain that costs +50%; the default allows it", () => {
    const cases = Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, base: runs([0.5, 0.5], 0.1), cand: runs([0.7, 0.7], 0.15) }));
    const p = paretoSupport(cases, { seed: 1 });
    assert.equal(p.promote, true);
    assert.deepEqual(p.branchShares, { quality: 1, cost: 0 });
    assert.equal(paretoSupport(cases, { seed: 1, epsC: 0.2 }).promote, false);
  });

  it("R=1: 'equal' gives support 0 or 1 with a note, 'dirichlet' a fraction", () => {
    const cases: ParetoCase[] = [
      { id: "a", base: runs([1], 1), cand: runs([0], 1) },
      { id: "b", base: runs([0], 1), cand: runs([1], 1) },
      { id: "c", base: runs([0], 1), cand: runs([1], 1) },
    ];
    const eq = paretoSupport(cases, { seed: 1, caseWeights: "equal", draws: 500 });
    assert.ok(eq.support === 0 || eq.support === 1);
    assert.ok(eq.notes.includes("no within-case replicates: equal-weight gate is the mean gate"));
    const dir = paretoSupport(cases, { seed: 1, draws: 2000 });
    assert.ok(dir.support > 0 && dir.support < 1, String(dir.support));
  });

  it("support ≥ the share of draws in the quality branch, and ≥ the cost branch", () => {
    for (const seed of [1, 2, 3]) {
      const p = paretoSupport(noisy(8, 3, { q: 0.5, c: 1 }, { q: 0.55, c: 1.05 }, 0.4, seed), { seed, draws: 3000 });
      assert.ok(p.support >= p.pQualityGain && p.support >= p.pCostCut);
      assert.ok(p.support <= p.pQualityGain + p.pCostCut + 1e-12);
    }
  });

  it("'equal' matches a hand-rolled reference within 1e-12 (2 cases × 2 runs × 20 draws)", () => {
    const cases: ParetoCase[] = [
      { id: "x", base: runs([1, 0], [0.1, 0.3]), cand: runs([1, 1], [0.2, 0.2]) },
      { id: "y", base: runs([0, 0], [0.2, 0.2]), cand: runs([1, 0], [0.1, 0.4]) },
    ];
    const p = paretoSupport(cases, { seed: 9, draws: 20, caseWeights: "equal" });
    const rnd = mulberry32(9);
    const w2 = () => {
      const a = -Math.log(1 - rnd());
      const b = -Math.log(1 - rnd());
      return [a / (a + b), b / (a + b)] as const;
    };
    let event = 0;
    let sum = 0;
    for (let d = 0; d < 20; d++) {
      let qb = 0;
      let qc = 0;
      let cb = 0;
      let cc = 0;
      for (const c of cases) {
        const [b0, b1] = w2();
        const [c0, c1] = w2();
        qb += (b0 * c.base[0]!.q + b1 * c.base[1]!.q) / 2;
        cb += (b0 * c.base[0]!.c + b1 * c.base[1]!.c) / 2;
        qc += (c0 * c.cand[0]!.q + c1 * c.cand[1]!.q) / 2;
        cc += (c0 * c.cand[0]!.c + c1 * c.cand[1]!.c) / 2;
      }
      const dq = qc - qb;
      const dc = (cc - cb) / cb;
      sum += dq;
      if ((dq > 0 && dc <= Infinity) || (dc < 0 && dq >= -0.1)) event++;
    }
    assert.ok(Math.abs(p.dQ.mean - sum / 20) < 1e-12);
    assert.equal(p.support, event / 20);
  });

  it("drops unusable runs, skips cases with none, falls back to absolute cost at base cost 0", () => {
    const p = paretoSupport(
      [
        { id: "ok", base: [{ q: 1, c: 0 }, { q: 1, c: NaN }], cand: [{ q: 1, c: 0 }] },
        { id: "empty", base: [{ q: NaN, c: 1 }], cand: [{ q: 1, c: 1 }] },
      ],
      { seed: 1, draws: 100 },
    );
    assert.deepEqual(p.skipped, ["empty"]);
    assert.deepEqual(p.runs, { base: 1, cand: 1 });
    assert.equal(p.dC.scale, "absolute");
    assert.match(p.notes.join("\n"), /absolute, not relative/);
    const none = paretoSupport([{ id: "z", base: [], cand: runs([1], 1) }]);
    assert.equal(none.promote, false);
    assert.equal(none.cases, 0);
  });

  it("10,000 draws × 50 cases × 2 arms × 3 runs stays fast", () => {
    const cases = noisy(50, 3, { q: 0.7, c: 0.1 }, { q: 0.7, c: 0.09 }, 0.3);
    const t0 = performance.now();
    paretoSupport(cases, { seed: 1 });
    const ms = performance.now() - t0;
    assert.ok(ms < 1500, `${ms.toFixed(0)} ms`);
  });
});

describe("frontierSupport (AA-17)", () => {
  /** An arm: n cases × r runs with seeded multiplicative noise on q and c. */
  const arm = (n: number, r: number, q: number, c: number, noise: number, seed: number) => {
    const rnd = mulberry32(seed);
    const jit = (x: number) => x * (1 + noise * (rnd() * 2 - 1));
    return new Map(Array.from({ length: n }, (_, i) => [`t${i}`, Array.from({ length: r }, () => ({ q: jit(q), c: jit(c) }))] as const));
  };
  const by = (fs: ReturnType<typeof frontierSupport>) => Object.fromEntries(fs.map((f) => [f.arm, f.pFront]));

  it("A dominates B everywhere: pFront(A) = 1, pFront(B) ≈ 0", () => {
    const fs = frontierSupport(new Map([["A", arm(10, 3, 0.9, 0.05, 0.05, 1)], ["B", arm(10, 3, 0.6, 0.1, 0.05, 2)]]), { seed: 1, draws: 2000 });
    assert.equal(by(fs).A, 1);
    assert.ok(by(fs).B! < 0.01, String(by(fs).B));
    const a = fs.find((f) => f.arm === "A")!;
    assert.ok(Math.abs(a.q - 0.9) < 0.02 && Math.abs(a.c - 0.05) < 0.002, JSON.stringify(a));
  });

  it("a clean trade-off (better and dearer vs worse and cheaper): both ≈ 1", () => {
    const fs = frontierSupport(new Map([["A", arm(10, 3, 0.9, 0.2, 0.05, 1)], ["B", arm(10, 3, 0.6, 0.05, 0.05, 2)]]), { seed: 1, draws: 2000 });
    assert.ok(by(fs).A! > 0.99 && by(fs).B! > 0.99, JSON.stringify(by(fs)));
  });

  it("near-equal noisy arms are each on the front in a share of draws", () => {
    const fs = frontierSupport(new Map([["A", arm(8, 3, 0.7, 0.1, 0.3, 1)], ["B", arm(8, 3, 0.7, 0.1, 0.3, 2)], ["C", arm(8, 3, 0.7, 0.1, 0.3, 3)]]), { seed: 1, draws: 2000 });
    for (const f of fs) assert.ok(f.pFront > 0.2 && f.pFront < 1, JSON.stringify(fs));
  });

  it("is byte-identical for a fixed seed, uses only cases every arm ran, and is empty without one", () => {
    const arms = new Map([["A", arm(6, 2, 0.8, 0.1, 0.2, 1)], ["B", arm(6, 2, 0.7, 0.08, 0.2, 2)]]);
    assert.equal(JSON.stringify(frontierSupport(arms, { seed: 9, draws: 500 })), JSON.stringify(frontierSupport(arms, { seed: 9, draws: 500 })));
    // A case only A ran, and one where B's only run is unusable, change nothing.
    const extra = new Map([["A", new Map([...arms.get("A")!, ["solo", [{ q: 0, c: 9 }]], ["nan", [{ q: 0, c: 9 }]]])], ["B", new Map([...arms.get("B")!, ["nan", [{ q: NaN, c: 1 }]]])]]);
    assert.equal(JSON.stringify(frontierSupport(extra, { seed: 9, draws: 500 })), JSON.stringify(frontierSupport(arms, { seed: 9, draws: 500 })));
    assert.deepEqual(frontierSupport(new Map([["A", new Map([["x", runs([1], 1)]])], ["B", new Map([["y", runs([1], 1)]])]])), []);
    assert.deepEqual(frontierSupport(new Map()), []);
    // One run per case with equal case weights: every draw is the point estimate.
    const one = frontierSupport(new Map([["A", new Map([["x", runs([1], 2)]])], ["B", new Map([["x", runs([1], 1)]])]]), { caseWeights: "equal", draws: 10 });
    assert.deepEqual(by(one), { A: 0, B: 1 });
  });
});

describe("dominates", () => {
  it("higher quality and lower cost, strictly better on one", () => {
    assert.equal(dominates({ q: 1, c: 1 }, { q: 0.5, c: 1 }), true);
    assert.equal(dominates({ q: 1, c: 0.5 }, { q: 1, c: 1 }), true);
    assert.equal(dominates({ q: 1, c: 1 }, { q: 1, c: 1 }), false);
    assert.equal(dominates({ q: 1, c: 2 }, { q: 0.5, c: 1 }), false);
  });
});
