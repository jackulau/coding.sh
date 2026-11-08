// A meta-eval of the hill-climb itself: drive the real decision and stats code
// with synthetic ground truth and assert the properties the climb rests on —
// it rarely promotes a non-improvement, it refuses a cheaper candidate that
// loses quality, it blocks a candidate that forgets an earlier kept win, its
// plateau detector stops on a plateau but not on real improvement, and its
// McNemar power matches the analytic curve. Everything is seeded, so the
// numbers are deterministic; the bounds are loose enough to never be flaky.
// The full study (more seeds, printed numbers) lives in
// docs/research/hillclimb-quality.md.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { judgeObjectives, climbPlateau, type ClimbRound, type RunPoint, type TaskPair } from "../../src/refine/objectives.ts";
import { checkGuard, guardSet } from "../../src/refine/guard.ts";
import { mcnemarPaired, hardRegressions } from "../../src/stats/tests.ts";
import { gateVerdict } from "../../src/stats/gate.ts";
import { acceptanceGatePaired } from "../../src/stats/tests.ts";
import { mcnemarPower } from "../../src/stats/mcnemar-power.ts";
import { pairedBootstrap } from "../../src/stats/interval.ts";
import { mulberry32 } from "../../src/stats/prng.ts";

const ALPHA = 0.05;
const majority = (xs: boolean[]) => xs.filter(Boolean).length * 2 >= xs.length;
const runsFor = (p: number, k: number, rand: () => number) => Array.from({ length: k }, () => rand() < p);

function suitePairs(tasks: [number, number][], k: number, rand: () => number, cost?: { base: number; cand: number }): TaskPair[] {
  return tasks.map(([pb, pc], i): TaskPair => ({
    task: `t${i}`,
    base: runsFor(pb, k, rand).map((pass): RunPoint => ({ pass, ...(cost ? { cost: cost.base } : {}) })),
    cand: runsFor(pc, k, rand).map((pass): RunPoint => ({ pass, ...(cost ? { cost: cost.cand } : {}) })),
  }));
}
const gateOf = (pairs: TaskPair[]) =>
  gateVerdict(acceptanceGatePaired(pairs.map((p) => majority(p.base.map((r) => r.pass))), pairs.map((p) => majority(p.cand.map((r) => r.pass)))));

/** Share of seeds whose candidate the suite keeps, with per-task true deltas from `delta`. */
function keepRate(N: number, objectives: ("pass" | "cost")[], seed0: number, delta: (i: number) => number, cost?: { base: number; cand: number }): number {
  const T = 12, k = 3;
  let keep = 0;
  for (let s = 0; s < N; s++) {
    const rand = mulberry32(seed0 + s * 7);
    const tasks: [number, number][] = [];
    for (let i = 0; i < T; i++) {
      const pb = 0.25 + 0.55 * rand();
      tasks.push([pb, Math.max(0, Math.min(1, pb + delta(i)))]);
    }
    const pairs = suitePairs(tasks, k, rand, cost);
    const d = judgeObjectives(pairs, { objectives, margin: 0.02, minGain: 0.1, alpha: ALPHA, seed: seed0 + s, gate: gateOf(pairs) });
    if (d.verdict === "keep") keep++;
  }
  return keep / N;
}

describe("hill-climb meta-eval", () => {
  it("holds its false-promote rate at the null (an identical candidate is rarely kept)", () => {
    const rate = keepRate(300, ["pass"], 1000, () => 0);
    assert.ok(rate <= 0.07, `null keep rate ${(rate * 100).toFixed(1)}% should be at or below ~7% (two one-sided α-${ALPHA} tests OR'd)`);
  });

  it("promotes real wins more often as the effect grows (power is monotone in the effect)", () => {
    const small = keepRate(200, ["pass"], 2000, () => 0.05);
    const large = keepRate(200, ["pass"], 2000, () => 0.2);
    assert.ok(large > small, `power should rise with the effect: +5pts ${(small * 100).toFixed(1)}% vs +20pts ${(large * 100).toFixed(1)}%`);
    assert.ok(large >= 0.15, `a +20pt win on every task should be detectable more than rarely (got ${(large * 100).toFixed(1)}%)`);
  });

  it("refuses a cheaper candidate as its quality loss grows, and never keeps a large loss", () => {
    const cost = { base: 1, cand: 0.6 }; // 40% cheaper
    const even = keepRate(150, ["cost", "pass"], 3000, () => 0, cost);
    const mid = keepRate(150, ["cost", "pass"], 3000, () => -0.1, cost);
    const big = keepRate(150, ["cost", "pass"], 3000, () => -0.2, cost);
    assert.ok(even >= mid && mid >= big, `keep rate should fall as quality drops: even ${even}, −10pt ${mid}, −20pt ${big}`);
    assert.ok(big <= 0.02, `a cheaper candidate that loses 20pts of quality should almost never be kept (got ${(big * 100).toFixed(1)}%)`);
  });

  it("names a wide-interval hold as a data problem, not a quality loss", () => {
    const runs = (k: number, passes: number, m: Partial<RunPoint> = {}) => Array.from({ length: k }, (_, i) => ({ pass: i < passes, ...m }) as RunPoint);
    const pairs = Array.from({ length: 8 }, (_, i): TaskPair => ({ task: `t${i}`, base: runs(3, 2, { cost: 0.2 }), cand: runs(3, i < 4 ? 3 : 1, { cost: 0.1 }) }));
    const d = judgeObjectives(pairs, { objectives: ["cost"], margin: 0.05, minGain: 0.1, seed: 7 });
    assert.equal(d.verdict, "inconclusive");
    assert.ok(d.quality.mean >= 0 && !d.quality.nonInferior);
    assert.ok(!d.reasons.some((r) => /costs quality/.test(r)), "a held candidate is not reported as a quality loss");
    assert.match(d.warnings.join("\n"), /add tasks or trials/);
  });

  it("blocks a candidate that forgets any earlier kept win (K8 guard)", () => {
    const G = 16;
    const set = guardSet([{ id: "r_aaaaaaaaaa", at: 1, status: "kept", guardTasks: Array.from({ length: G }, (_, i) => `g${i}`) }], {});
    const build = (forget: number) => {
      const base = new Map<string, boolean[]>();
      const cand = new Map<string, boolean[]>();
      for (let i = 0; i < G; i++) {
        base.set(`g${i}`, [true, true, true]);
        cand.set(`g${i}`, i < forget ? [false, false, false] : [true, true, true]);
      }
      return checkGuard(set, { base, cand }, {});
    };
    assert.equal(build(0).ok, true, "holding every kept win passes");
    for (const f of [1, 2, 4, 8]) assert.equal(build(f).ok, false, `forgetting ${f} kept wins is blocked`);
  });

  it("matches the analytic McNemar power curve", () => {
    const sim = (n: number, d: number, delta: number) => {
      const N = 4000, pWin = (d + delta) / (2 * d);
      let rej = 0;
      for (let s = 0; s < N; s++) {
        const rand = mulberry32(7000 + s * 131);
        const base: boolean[] = [], cand: boolean[] = [];
        for (let i = 0; i < n; i++) {
          if (rand() < d) { const w = rand() < pWin; base.push(!w); cand.push(w); }
          else { const v = rand() < 0.6; base.push(v); cand.push(v); }
        }
        if (mcnemarPaired(base, cand).p < ALPHA) rej++;
      }
      return rej / N;
    };
    for (const [n, d, delta] of [[50, 0.3, 0.2], [30, 0.4, 0.2]] as const) {
      const emp = sim(n, d, delta);
      const analytic = mcnemarPower(n, d, delta);
      assert.ok(Math.abs(emp - analytic) < 0.03, `n=${n} d=${d} δ=${delta}: empirical ${emp.toFixed(3)} vs analytic ${analytic.toFixed(3)}`);
    }
    // Size at the null is at or below the nominal level.
    const size = sim(50, 0.4, 0);
    assert.ok(size <= 0.06, `McNemar size at the null ${size.toFixed(3)} should be at or below ~α`);
  });

  it("stops the loop on a plateau but not on persistent improvement", () => {
    const n = 12, eps = 0.05, delta = 0.05;
    const gainsRound = (meanG: number, rand: () => number) =>
      Array.from({ length: n }, () => {
        const u1 = Math.max(1e-9, rand()), u2 = rand();
        const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        return Math.max(-1, Math.min(1, meanG + 0.15 * z));
      });
    const mk = (means: number[], rand: () => number): ClimbRound[] => means.map((m, i) => ({ id: `c${i}`, round: i + 1, kept: m > 0, base: { pass: 0 }, cand: { pass: 0 }, gains: gainsRound(m, rand) }));
    const share = (f: (rand: () => number) => ClimbRound[], N: number, seed0: number) => {
      let stop = 0;
      for (let s = 0; s < N; s++) if (climbPlateau(f(mulberry32(seed0 + s * 19)), { eps, delta }).status === "stop") stop++;
      return stop / N;
    };
    const plateauAfter = share((r) => mk([...Array(4).fill(0.1), ...Array(26).fill(0)], r), 150, 12000);
    const persistent = share((r) => mk(Array(30).fill(0.1), r), 150, 13000);
    assert.ok(plateauAfter >= 0.9, `a loop that flatlines should stop (got ${(plateauAfter * 100).toFixed(0)}%)`);
    assert.ok(persistent <= 0.05, `a loop still gaining +10pts/round should not false-alarm (got ${(persistent * 100).toFixed(0)}%)`);
  });

  it("the paired bootstrap undercovers a little at small n (an honesty check, not a target)", () => {
    const coverage = (nTasks: number) => {
      const N = 400, mu = 0.05, sd = 0.3;
      let cover = 0;
      for (let s = 0; s < N; s++) {
        const rand = mulberry32(3100 + s * 17);
        const diffs: number[] = [];
        for (let i = 0; i < nTasks; i++) {
          const u1 = Math.max(1e-9, rand()), u2 = rand();
          const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
          diffs.push(Math.max(-1, Math.min(1, mu + sd * z)));
        }
        const b = pairedBootstrap(diffs, { iters: 2000, seed: 0x5eed });
        if (b.lo <= mu && mu <= b.hi) cover++;
      }
      return cover / N;
    };
    const small = coverage(8);
    const large = coverage(30);
    assert.ok(small < 0.95, `the 95% CI undercovers at n=8 (got ${(small * 100).toFixed(0)}%)`);
    assert.ok(large > small, `coverage improves with n (n=8 ${(small * 100).toFixed(0)}% vs n=30 ${(large * 100).toFixed(0)}%)`);
  });

  it("the hard-regression screen catches a task the base always solved and the candidate breaks", () => {
    const base = new Map([["a", [true, true, true]], ["b", [true, true, true]]]);
    const cand = new Map([["a", [true, true, true]], ["b", [false, false, false]]]);
    assert.deepEqual(hardRegressions(base, cand), ["b"]);
  });
});
