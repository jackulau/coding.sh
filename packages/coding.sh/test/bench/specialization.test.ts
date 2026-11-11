// Routing headroom: the any-contender oracle gap and upset rate, checked
// against a Rasch no-specialization reference.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fitRasch, headroomStats, specialization, specializationLines, type Specialization } from "../../src/bench/specialization.ts";
import type { Cell } from "../../src/bench/types.ts";
import { mulberry32 } from "../../src/stats/prng.ts";

const cell = (caseId: string, contender: string, trial: number, pass: boolean): Cell => ({ caseId, contender, trial, position: 0, pass, score: pass ? 1 : 0, latencyMs: 10 });
const id = (i: number) => `c${String(i).padStart(3, "0")}`;

/** Outcomes drawn from a Rasch model: abilities theta, case difficulties uniform on [-3, 3]. */
function raschCells(seed: number, n: number, theta: number[], trials: number): Cell[] {
  const r = mulberry32(seed);
  const out: Cell[] = [];
  for (let i = 0; i < n; i++) {
    const b = (r() - 0.5) * 6;
    for (const [c, th] of theta.entries()) for (let t = 0; t < trials; t++) out.push(cell(id(i), `m${c}`, t, r() < 1 / (1 + Math.exp(-(th - b)))));
  }
  return out;
}

const done = (x: ReturnType<typeof specialization>): Specialization => {
  assert.ok(!("skipped" in x), "skipped" in x ? x.skipped : "");
  return x as Specialization;
};

describe("fitRasch", () => {
  test("recovers the order of 3 contenders over 200 cases", () => {
    const theta = [-1, 0, 1];
    const r = mulberry32(7);
    const y = Array.from({ length: 200 }, () => {
      const b = (r() - 0.5) * 4;
      return theta.map((th) => [r() < 1 / (1 + Math.exp(-(th - b))) ? 1 : 0]);
    });
    const fit = fitRasch(y);
    assert.ok(fit.converged);
    assert.ok(fit.theta[0]! < fit.theta[1]! && fit.theta[1]! < fit.theta[2]!, `order ${fit.theta}`);
    assert.ok(Math.abs(fit.theta.reduce((a, x) => a + x, 0)) < 1e-9, "centred");
    assert.ok(fit.theta[2]! - fit.theta[0]! > 1 && fit.theta[2]! - fit.theta[0]! < 3.5, `spread ${fit.theta}`);
  });

  test("stays finite with an all-pass case and an all-fail contender", () => {
    const y = [
      [[1], [1], [0]],
      [[1], [0], [0]],
      [[0], [1], [0]],
      [[1], [1], [0]],
    ];
    const fit = fitRasch(y);
    for (const x of [...fit.theta, ...fit.b]) assert.ok(Number.isFinite(x), String(x));
    assert.ok(fit.theta[2]! < fit.theta[0]! && fit.theta[2]! < fit.theta[1]!);
    assert.ok(fit.b[0]! < fit.b[1]!, "the all-pass case is easier");
  });
});

describe("headroomStats", () => {
  test("hand-checked oracle and gap on 4 cases × 2 contenders × 2 trials", () => {
    // y[case][contender][trial]
    const y = [
      [[1, 1], [0, 1]],
      [[0, 0], [1, 0]],
      [[1, 0], [1, 1]],
      [[0, 0], [0, 0]],
    ];
    const s = headroomStats(y);
    // trial 0: any 3/4, A 2/4, B 2/4 → best 2/4; trial 1: any 2/4, A 1/4, B 2/4 → best 2/4.
    assert.equal(s.oracle, (0.75 + 0.5) / 2);
    assert.equal(s.best, 0.5);
    assert.equal(s.gap, 0.125);
    assert.deepEqual(s.rates, [3 / 8, 4 / 8]);
    assert.equal(s.bestIndex, 1);
    // Splits: c0 t0 (A won, A is lower → upset), c1 t0 (B), c2 t1 (B). 1 of 3.
    assert.equal(s.splits, 3);
    assert.equal(s.upsets, 1);
    assert.equal(s.upset, 1 / 3);
  });

  test("3 trials with a different leader each: best is the overall best contender's rate, not a per-trial best", () => {
    // Passes over 10 cases per trial: A 8, 5, 5 (18/30); B 4, 7, 4 (15/30); C 3, 3, 6 (12/30). Each passes its first cases.
    const upTo = (...ns: number[]) => (i: number) => ns.map((n) => (i < n ? 1 : 0));
    const [a, b, c] = [upTo(8, 5, 5), upTo(4, 7, 4), upTo(3, 3, 6)];
    const s = headroomStats(Array.from({ length: 10 }, (_, i) => [a(i), b(i), c(i)]));
    assert.deepEqual(s.rates, [18 / 30, 15 / 30, 12 / 30]);
    assert.equal(s.bestIndex, 0);
    // Any contender: 8, 7, 6 of 10. The best per trial would average 0.7 too and hide the whole gap.
    assert.ok(Math.abs(s.oracle - 0.7) < 1e-12, String(s.oracle));
    assert.equal(s.best, s.rates[0]);
    assert.equal(s.gap, s.oracle - s.rates[0]!);
  });

  test("pairs with equal pass rates are skipped for upsets", () => {
    const y = [
      [[1], [0], [0]],
      [[0], [1], [0]],
      [[1], [1], [1]],
    ];
    // A and B both 2/3 (skipped); C 1/3. A vs C: c0 split, A won (no upset). B vs C: c1 split, B won.
    const s = headroomStats(y);
    assert.equal(s.splits, 2);
    assert.equal(s.upsets, 0);
    assert.equal(s.upset, 0);
  });
});

describe("specialization", () => {
  test("Rasch-generated data: no evidence, gap inside the expected band", () => {
    for (const [seed, theta, trials] of [
      [11, [-0.5, 0, 0.5], 1],
      [12, [0, 0.4], 3],
      [13, [-0.6, -0.2, 0.2, 0.6], 1],
    ] as const) {
      const s = done(specialization(raschCells(seed, 80, [...theta], trials), theta.map((_, i) => `m${i}`), trials));
      assert.equal(s.verdict, "no-evidence-of-specialization", `seed ${seed}: p ${s.pAdj}`);
      assert.ok(s.gap >= s.gapExpected.lo && s.gap <= s.gapExpected.hi, `seed ${seed}: gap ${s.gap} outside [${s.gapExpected.lo}, ${s.gapExpected.hi}]`);
      assert.ok(s.gap > 0, "noise alone makes a raw gap");
    }
  });

  test("3 contenders × 3 trials, a different one leading each trial: the rate beside the best contender is its pass rate", () => {
    // Passes over 30 cases per trial: A 24, 15, 15 (60%); B 12, 21, 12 (50%); C 9, 9, 18 (40%).
    const passes: Record<string, number[]> = { A: [24, 15, 15], B: [12, 21, 12], C: [9, 9, 18] };
    const cells: Cell[] = [];
    for (let i = 0; i < 30; i++) for (const [c, ns] of Object.entries(passes)) for (const [t, n] of ns.entries()) cells.push(cell(id(i), c, t, i < n));
    const s = done(specialization(cells, ["A", "B", "C"], 3));
    assert.deepEqual(s.best, { contender: "A", rate: 0.6 });
    assert.equal(s.bestSingle, s.best.rate);
    assert.equal(s.gap, s.oracle - s.best.rate);
    assert.ok(Math.abs(s.gap - 0.1) < 1e-12, String(s.gap));
    assert.match(specializationLines(s)[0]!, /any contender 70\.0% vs best single \(A\) 60\.0%: gap 10\.0 pp/);
  });

  test("Rasch-generated 3 contenders × 3 trials: the gap from the best contender's rate stays inside the expected band", () => {
    for (const seed of [31, 32, 33]) {
      const s = done(specialization(raschCells(seed, 60, [1, 0.3, -0.3], 3), ["m0", "m1", "m2"], 3));
      assert.equal(s.bestSingle, s.best.rate);
      assert.equal(s.gap, s.oracle - s.best.rate);
      assert.ok(s.gap >= s.gapExpected.lo && s.gap <= s.gapExpected.hi, `seed ${seed}: gap ${s.gap} outside [${s.gapExpected.lo}, ${s.gapExpected.hi}]`);
      assert.equal(s.verdict, "no-evidence-of-specialization", `seed ${seed}: p ${s.pAdj}`);
    }
  });

  test("planted specialization: A passes the first half, B the second → gap 50 pp, p < 0.01", () => {
    const cells: Cell[] = [];
    for (let i = 0; i < 40; i++) cells.push(cell(id(i), "A", 0, i < 20), cell(id(i), "B", 0, i >= 20));
    const s = done(specialization(cells, ["A", "B"], 1));
    assert.equal(s.oracle, 1);
    assert.equal(s.bestSingle, 0.5);
    assert.ok(Math.abs(s.gap - 0.5) < 1e-12);
    assert.ok(s.pGap < 0.01, `p ${s.pGap}`);
    assert.equal(s.verdict, "contenders-specialize");
    assert.ok(s.gapExpected.hi < 0.45, `expected band ${JSON.stringify(s.gapExpected)}`);
    // Equal pass rates: no pair to call an upset.
    assert.ok(Number.isNaN(s.upset));
    assert.match(specializationLines(s).join("\n"), /Contenders specialize/);
  });

  test("identical outcomes: gap 0, upset NaN shown as '-'", () => {
    const cells: Cell[] = [];
    for (let i = 0; i < 30; i++) for (const c of ["A", "B", "C"]) cells.push(cell(id(i), c, 0, i % 3 !== 0));
    const s = done(specialization(cells, ["A", "B", "C"], 1));
    assert.equal(s.gap, 0);
    assert.ok(Number.isNaN(s.upset));
    assert.equal(s.verdict, "no-evidence-of-specialization");
    assert.equal(s.pGap, 1);
    const text = specializationLines(s);
    assert.match(text[1]!, /^Upsets -:/);
    assert.match(text[2]!, /unlikely to beat running A alone/);
    // Stored as JSON, NaN becomes null and still renders '-'.
    const stored = JSON.parse(JSON.stringify(s)) as Specialization;
    assert.equal(stored.upset, null);
    assert.match(specializationLines(stored)[1]!, /^Upsets -:/);
  });

  test("byte-identical for a seed; a different seed moves only the reference", () => {
    const cells = raschCells(21, 50, [-0.3, 0.3], 2);
    const a = JSON.stringify(specialization(cells, ["m0", "m1"], 2));
    const b = JSON.stringify(specialization([...cells].reverse(), ["m0", "m1"], 2));
    assert.equal(a, b);
    const c = done(specialization(cells, ["m0", "m1"], 2, { seed: 2 }));
    assert.notEqual(JSON.stringify(c), a);
    assert.equal(c.gap, (JSON.parse(a) as Specialization).gap);
  });

  test("skips under 20 cases and under 2 contenders", () => {
    const few = raschCells(3, 19, [0, 0], 1);
    assert.deepEqual(specialization(few, ["m0", "m1"], 1), { skipped: "19 counted cases; needs 20" });
    assert.deepEqual(specialization(raschCells(3, 40, [0], 1), ["m0"], 1), { skipped: "needs 2 or more contenders" });
  });

  test("recurring upsets with 3 trials name the case, the winner and the trials", () => {
    // A passes c012-c029; B (worse overall) passes c000-c008 in every trial and c009 in two of three.
    const cells: Cell[] = [];
    for (let i = 0; i < 30; i++) {
      for (let t = 0; t < 3; t++) {
        cells.push(cell(id(i), "A", t, i >= 12));
        cells.push(cell(id(i), "B", t, i < 9 || (i === 9 && t < 2)));
      }
    }
    const s = done(specialization(cells, ["A", "B"], 3));
    assert.equal(s.verdict, "contenders-specialize");
    assert.equal(s.best.contender, "A");
    assert.equal(s.upset, 1 - 18 * 3 / (18 * 3 + 29));
    assert.equal(s.recurringUpsets.length, 10);
    assert.deepEqual(s.recurringUpsets[0], { caseId: "c000", winner: "B", over: "A", trials: 3 });
    assert.deepEqual(s.recurringUpsets[9], { caseId: "c009", winner: "B", over: "A", trials: 2 });
    assert.match(specializationLines(s).at(-1)!, /^Recurring upsets: c000 \(B over A, 3\/3 trials\)/);
  });

  test("one trial: no recurring upsets even when specialized", () => {
    const cells: Cell[] = [];
    for (let i = 0; i < 30; i++) cells.push(cell(id(i), "A", 0, i >= 12), cell(id(i), "B", 0, i < 12));
    const s = done(specialization(cells, ["A", "B"], 1));
    assert.equal(s.verdict, "contenders-specialize");
    assert.deepEqual(s.recurringUpsets, []);
  });
});
