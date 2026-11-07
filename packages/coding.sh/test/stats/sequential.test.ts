// Group sequential test (EM-3): boundaries against published values, the
// repeated CI, and type-I error control of the stopping rule by simulation
// with a fixed seed.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mulberry32 } from "../../src/stats/prng.ts";
import {
  obrienFlemingBounds,
  obrienFlemingSpend,
  pairedScoreInterval,
  pairedScoreZ,
  planSequential,
  sequentialLook,
  sequentialOutcome,
  type LookResult,
  type SequentialPlan,
} from "../../src/stats/sequential.ts";

/** Run the plan's looks over one simulated sequence of paired differences; the looks taken. */
function simulate(plan: SequentialPlan, diffs: readonly number[]): LookResult[] {
  const history: LookResult[] = [];
  for (let k = 1; k <= plan.looks.length; k++) {
    const look = sequentialLook(plan, k, diffs.slice(0, plan.looks[k - 1]));
    history.push(look);
    if (look.crossed) break;
  }
  return history;
}

/** Per-case B − A pass-rate difference over `trials` trials; each arm passes with its own probability. */
function draw(rand: () => number, n: number, pa: number, pb: number, trials = 1): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    // Cases differ in difficulty; both arms see the same case.
    const shift = (rand() - 0.5) * 0.6;
    const qa = Math.min(1, Math.max(0, pa + shift));
    const qb = Math.min(1, Math.max(0, pb + shift));
    let a = 0;
    let b = 0;
    for (let t = 0; t < trials; t++) {
      if (rand() < qa) a++;
      if (rand() < qb) b++;
    }
    out.push((b - a) / trials);
  }
  return out;
}

describe("O'Brien–Fleming boundaries", () => {
  it("match the published Lan–DeMets values (4 equal looks, two-sided α 0.05)", () => {
    // gsDesign / ldbounds: 4.3326, 2.9631, 2.3590, 2.0141.
    const b = obrienFlemingBounds([0.25, 0.5, 0.75, 1]);
    for (const [got, want] of b.map((x, i) => [x, [4.3326, 2.9631, 2.359, 2.0141][i]!])) assert.ok(Math.abs(got! - want!) < 2e-3, `${got} vs ${want}`);
    assert.ok(Math.abs(obrienFlemingBounds([1])[0]! - 1.95996) < 1e-4);
  });

  it("spends nothing at 0 and all of α at the end", () => {
    assert.equal(obrienFlemingSpend(0, 0.05), 0);
    assert.equal(obrienFlemingSpend(1, 0.05), 0.05);
    assert.ok(obrienFlemingSpend(0.5, 0.05) < obrienFlemingSpend(0.75, 0.05));
    assert.throws(() => obrienFlemingBounds([0.5, 0.4, 1]), /increase/);
  });

  it("plans no look before 20 paired cases", () => {
    assert.deepEqual(planSequential(200).looks, [50, 100, 150, 200]);
    assert.deepEqual(planSequential(60).looks, [30, 45, 60]);
    // Too small to look early: one look at the end, a fixed-n test.
    const tiny = planSequential(12);
    assert.deepEqual(tiny.looks, [12]);
    assert.ok(Math.abs(tiny.bounds[0]! - 1.95996) < 1e-4);
  });
});

describe("paired score statistic and repeated CI", () => {
  it("is McNemar's (c − b)/√(b + c) for one trial per case", () => {
    const d = [...Array(9).fill(1), ...Array(3).fill(-1), ...Array(20).fill(0)];
    assert.ok(Math.abs(pairedScoreZ(d) - 6 / Math.sqrt(12)) < 1e-12);
    assert.equal(pairedScoreZ([0, 0, 0]), 0);
  });

  it("excludes 0 exactly when the test rejects", () => {
    const rand = mulberry32(7);
    for (let i = 0; i < 300; i++) {
      const n = 25 + Math.floor(rand() * 100);
      const d = draw(rand, n, 0.5, 0.5 + (rand() - 0.5) * 0.4, 1 + Math.floor(rand() * 3));
      const c = 2 + rand() * 2;
      const ci = pairedScoreInterval(d, c);
      const rejects = Math.abs(pairedScoreZ(d)) >= c;
      assert.equal(ci.lo > 0 || ci.hi < 0, rejects, `n ${n} c ${c} z ${pairedScoreZ(d)} ci ${ci.lo}..${ci.hi}`);
    }
  });

  it("is the whole range when n ≤ c² (no difference can be rejected)", () => {
    assert.deepEqual(pairedScoreInterval(Array(10).fill(1), 4), { mean: 1, lo: -1, hi: 1 });
  });
});

describe("stopping rule", () => {
  it("keeps the type-I error at α under H0 (simulated, fixed seed)", () => {
    const rand = mulberry32(0x5eed);
    const reps = 4000;
    for (const { n, trials } of [
      { n: 200, trials: 1 },
      { n: 60, trials: 3 },
    ]) {
      const plan = planSequential(n);
      let rejected = 0;
      let early = 0;
      let peeked = 0; // the same looks with the fixed-n 1.96 at each one: what naive peeking does
      for (let r = 0; r < reps; r++) {
        const d = draw(rand, n, 0.6, 0.6, trials);
        const h = simulate(plan, d);
        if (h.at(-1)!.crossed) rejected++;
        if (h.at(-1)!.crossed && h.length < plan.looks.length) early++;
        if (plan.looks.some((m) => Math.abs(pairedScoreZ(d.slice(0, m))) >= 1.959964)) peeked++;
      }
      const rate = rejected / reps;
      assert.ok(rate <= 0.06, `n ${n}, trials ${trials}: type-I error ${rate}`);
      assert.ok(rate >= 0.025, `n ${n}, trials ${trials}: type-I error ${rate} (far below α: the bounds are off)`);
      assert.ok(early > 0, "some null runs cross early, by chance");
      assert.ok(peeked / reps > rate + 0.02, `naive peeking ${peeked / reps} should inflate the error over ${rate}`);
    }
  });

  it("stops early under a real effect, and the repeated CI covers the truth", () => {
    const rand = mulberry32(42);
    const plan = planSequential(200);
    const reps = 1000;
    let early = 0;
    let covered = 0;
    let cases = 0;
    for (let r = 0; r < reps; r++) {
      const d = draw(rand, 200, 0.45, 0.65);
      const truth = 0.2; // the shift is symmetric and clipping is rare at these rates
      const o = sequentialOutcome(plan, simulate(plan, d));
      if (o.early) early++;
      if (o.diff.lo <= truth && truth <= o.diff.hi) covered++;
      cases += o.stoppedAt;
    }
    assert.ok(early / reps > 0.6, `stopped early ${early / reps}`);
    assert.ok(cases / reps < 150, `mean paired cases ${cases / reps}`);
    assert.ok(covered / reps >= 0.94, `coverage ${covered / reps}`);
  });

  it("says why it stopped", () => {
    const plan = planSequential(100);
    const better = sequentialOutcome(plan, simulate(plan, Array(100).fill(1)));
    assert.equal(better.reason, "crossed");
    assert.equal(better.verdict, "better");
    assert.equal(better.early, true);
    assert.equal(better.stoppedAt, 25);
    const flat = sequentialOutcome(plan, simulate(plan, Array(100).fill(0)));
    assert.equal(flat.reason, "budget");
    assert.equal(flat.verdict, "inconclusive");
    assert.equal(flat.stoppedAt, 100);
    const cut = sequentialOutcome(plan, simulate(plan, Array(100).fill(0)).slice(0, 2));
    assert.equal(cut.reason, "cancelled");
    assert.equal(sequentialOutcome(plan, []).stoppedAt, 0);
  });
});
