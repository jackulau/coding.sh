// Model × harness grid: interaction residuals, fit, Cross-Model Fit and
// leave-one-model-out regret.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { excludesZero, gridAnalysis, gridText, STAR_MIN_CASES, type GridAnalysis, type GridAxes } from "../../src/bench/grid.ts";
import type { Cell } from "../../src/bench/types.ts";
import { mulberry32 } from "../../src/stats/prng.ts";

const id = (i: number) => `c${String(i).padStart(3, "0")}`;
const cell = (caseId: string, contender: string, pass: boolean, extra: Partial<Cell> = {}): Cell => ({ caseId, contender, trial: 0, position: 0, pass, score: pass ? 1 : 0, latencyMs: 10, ...extra });

type Spec = { name: string; axes: GridAxes; pass: (i: number) => boolean; fail?: (i: number) => string | undefined };

function build(n: number, specs: Spec[], trials = 1): { cells: Cell[]; contenders: { name: string; axes: GridAxes }[] } {
  const cells: Cell[] = [];
  for (let i = 0; i < n; i++) {
    for (const s of specs) {
      for (let t = 0; t < trials; t++) {
        const failure = s.fail?.(i);
        cells.push(cell(id(i), s.name, s.pass(i), { trial: t, ...(failure ? { failure } : {}) }));
      }
    }
  }
  return { cells, contenders: specs.map((s) => ({ name: s.name, axes: s.axes })) };
}

const done = (x: ReturnType<typeof gridAnalysis>): GridAnalysis => {
  assert.ok(!("skipped" in x), "skipped" in x ? x.skipped : "");
  return x as GridAnalysis;
};
const at = (g: GridAnalysis, m: string, h: string) => g.cells.find((c) => c.model === m && c.harness === h)!;

// Additive: m1 is 25 points better than m2 and h1 25 better than h2, with no interaction.
const additive: Spec[] = [
  { name: "m1-h1", axes: { model: "m1", harness: "h1" }, pass: (i) => i < 30 },
  { name: "m1-h2", axes: { model: "m1", harness: "h2" }, pass: (i) => i < 20 },
  { name: "m2-h1", axes: { model: "m2", harness: "h1" }, pass: (i) => i >= 20 },
  { name: "m2-h2", axes: { model: "m2", harness: "h2" }, pass: (i) => i >= 30 },
];

// Crossover: m1 does well only under h1, m2 only under h2.
const crossover: Spec[] = [
  { name: "m1-h1", axes: { model: "m1", harness: "h1" }, pass: (i) => i < 32 },
  { name: "m1-h2", axes: { model: "m1", harness: "h2" }, pass: (i) => i < 8 },
  { name: "m2-h1", axes: { model: "m2", harness: "h1" }, pass: (i) => i >= 52 },
  { name: "m2-h2", axes: { model: "m2", harness: "h2" }, pass: (i) => i >= 28 },
];

/** A models × harnesses grid whose every cell passes each case with the same chance: any pattern in it is noise. */
function nullGrid(seed: number, M: number, H: number, n: number, rate = 0.7): Spec[] {
  const r = mulberry32(seed);
  const specs: Spec[] = [];
  for (let m = 1; m <= M; m++) {
    for (let h = 1; h <= H; h++) {
      const out = Array.from({ length: n }, () => r() < rate);
      specs.push({ name: `m${m}h${h}`, axes: { model: `m${m}`, harness: `h${h}` }, pass: (i) => out[i]! });
    }
  }
  return specs;
}

/** Specs from one string of 0s and 1s per contender, a case per character. */
const fromBits = (bits: Record<string, string>): Spec[] =>
  Object.entries(bits).map(([name, b]) => ({ name, axes: { model: name.slice(0, 2), harness: name.slice(2) }, pass: (i: number) => b[i] === "1" }));

const stars = (g: GridAnalysis) => gridText(g).rows.flatMap((row) => row.slice(1).map((x) => x.endsWith("*")));

describe("gridAnalysis", () => {
  test("additive 2x2 (40 cases): every |Δp| < 0.01 and no CI excludes 0", () => {
    const { cells, contenders } = build(40, additive);
    const g = done(gridAnalysis(cells, contenders));
    assert.deepEqual(g.models, ["m1", "m2"]);
    assert.deepEqual(g.harnesses, ["h1", "h2"]);
    assert.equal(g.cases, 40);
    for (const c of g.cells) {
      assert.ok(Math.abs(c.dp.est) < 0.01, `${c.model}/${c.harness} Δp ${c.dp.est}`);
      assert.ok(!excludesZero(c.dp), `${c.model}/${c.harness} CI ${c.dp.lo}..${c.dp.hi}`);
      assert.ok(!excludesZero(c.dv));
    }
    assert.deepEqual(g.reversals, []);
  });

  test("crossover 2x2 (60 cases): Δp(m1,h1) = +0.2 with a CI excluding 0, a rank reversal, CrossFit 50 each", () => {
    const { cells, contenders } = build(60, crossover);
    const g = done(gridAnalysis(cells, contenders));
    const c = at(g, "m1", "h1");
    assert.ok(Math.abs(c.dp.est - 0.2) < 1e-12, String(c.dp.est));
    assert.ok(c.dp.lo > 0, `CI ${c.dp.lo}..${c.dp.hi}`);
    assert.ok(Math.abs(at(g, "m1", "h2").dp.est + 0.2) < 1e-12);
    assert.deepEqual(g.reversals, [{ models: ["m1", "m2"], harnesses: ["h1", "h2"] }]);
    for (const x of g.crossFit) assert.ok(Math.abs(x.est - 50) < 1e-9, `${x.harness} ${x.est}`);
    assert.ok(Math.abs(g.crossFitGap.est) < 1e-9);
    assert.ok(!excludesZero(g.crossFitGap), `gap CI ${g.crossFitGap.lo}..${g.crossFitGap.hi}`);
    const text = gridText(g);
    assert.equal(text.rows[0]![1], "53.3% +20.0*");
    assert.ok(text.lines.some((l) => l === "Rank reversal: m1 leads m2 under h1, m2 leads under h2."));
    assert.match(text.lines[0]!, /not a clear lead/);
  });

  test("3x2 fixture: F, CrossFit and leave-one-model-out regret match hand values to 1e-9", () => {
    // Joint rates J over 10 cases: m1 0.8/0.4, m2 0.3/0.6, m3 0.5/0.4.
    const J: Record<string, [number, number]> = { m1: [8, 4], m2: [3, 6], m3: [5, 4] };
    const specs: Spec[] = Object.entries(J).flatMap(([m, [a, b]]) => [
      { name: `${m}-h1`, axes: { model: m, harness: "h1" }, pass: (i: number) => i < a },
      { name: `${m}-h2`, axes: { model: m, harness: "h2" }, pass: (i: number) => i < b },
    ]);
    const g = done(gridAnalysis(...Object.values(build(10, specs)) as [Cell[], { name: string; axes: GridAxes }[]]));
    const F = { m1: [1, 0.5], m2: [0.5, 1], m3: [1, 0.8] };
    for (const [m, [f1, f2]] of Object.entries(F)) {
      assert.ok(Math.abs(at(g, m, "h1").f! - f1!) < 1e-9);
      assert.ok(Math.abs(at(g, m, "h2").f! - f2!) < 1e-9);
    }
    const cf1 = 100 * Math.cbrt(1 * 0.5 * 1);
    const cf2 = 100 * Math.cbrt(0.5 * 1 * 0.8);
    const byH = Object.fromEntries(g.crossFit.map((x) => [x.harness, x.est]));
    assert.ok(Math.abs(byH.h1! - cf1) < 1e-9);
    assert.ok(Math.abs(byH.h2! - cf2) < 1e-9);
    assert.equal(g.crossFit[0]!.harness, "h1");
    assert.ok(Math.abs(g.crossFitGap.est - (cf1 - cf2)) < 1e-9);
    // Held out m1: m2, m3 favour h2 (√0.8 > √0.5), m1 loses 80 − 40 = 40. Held out m2: m1, m3 favour h1, m2 loses 60 − 30 = 30.
    // Held out m3: m1, m2 tie, the first harness (h1) is picked, which is m3's best: 0.
    assert.deepEqual(g.lomo.map((x) => [x.model, x.pick, x.best]), [["m1", "h2", "h1"], ["m2", "h1", "h2"], ["m3", "h1", "h1"]]);
    const regrets = g.lomo.map((x) => x.regret);
    for (const [i, want] of [40, 30, 0].entries()) assert.ok(Math.abs(regrets[i]! - want) < 1e-9, `${regrets[i]} vs ${want}`);
    assert.ok(Math.abs(g.meanRegret - 70 / 3) < 1e-9);
  });

  test("3x3 with every cell truly 70% (60 cases): the order flips on point estimates, but no rank reversal is listed", () => {
    for (const seed of [1, 2, 3]) {
      const { cells, contenders } = build(60, nullGrid(seed, 3, 3, 60));
      const g = done(gridAnalysis(cells, contenders));
      // The point estimates do flip between two harnesses for some pair of models: that is what noise looks like.
      const lead = (a: string, b: string, h: string) => at(g, a, h).p - at(g, b, h).p;
      const flips = [["m1", "m2"], ["m1", "m3"], ["m2", "m3"]].some(([a, b]) => [["h1", "h2"], ["h1", "h3"], ["h2", "h3"]].some(([x, y]) => lead(a!, b!, x!) * lead(a!, b!, y!) < 0));
      assert.ok(flips, `seed ${seed}: no flip in the point estimates`);
      assert.deepEqual(g.reversals, [], `seed ${seed}`);
      assert.ok(!gridText(g).lines.some((l) => l.startsWith("Rank reversal")), `seed ${seed}`);
    }
  });

  test("3x3 with a planted reversal: every pair whose gaps both clear noise is listed, a tie is not", () => {
    // Pass rates over 60 cases: m1 80/60/20, m2 20/60/80, m3 60/60/60 under h1/h2/h3.
    const upTo: Record<string, number[]> = { m1: [48, 36, 12], m2: [12, 36, 48], m3: [36, 36, 36] };
    const specs: Spec[] = Object.entries(upTo).flatMap(([m, ns]) => ns.map((n, k) => ({ name: `${m}h${k + 1}`, axes: { model: m, harness: `h${k + 1}` }, pass: (i: number) => i < n })));
    const { cells, contenders } = build(60, specs);
    const g = done(gridAnalysis(cells, contenders));
    assert.deepEqual(g.reversals, [
      { models: ["m1", "m2"], harnesses: ["h1", "h3"] },
      { models: ["m1", "m3"], harnesses: ["h1", "h3"] },
      { models: ["m3", "m2"], harnesses: ["h1", "h3"] },
    ]);
    assert.ok(gridText(g).lines.includes("Rank reversal: m3 leads m2 under h1, m2 leads under h3."));
    // Held out, m1 and m2 each get the other's best harness and lose 60 points; m3 loses nothing. A regret this large is not noise.
    assert.deepEqual(g.lomo.map((x) => [x.model, x.pick, Math.round(x.regret)]), [["m1", "h3", 60], ["m2", "h1", 60], ["m3", "h2", 0]]);
    assert.ok(Math.abs(g.meanRegret - 40) < 1e-9);
    assert.ok(g.meanRegretCi!.lo > 20 && g.meanRegretCi!.hi < 60, JSON.stringify(g.meanRegretCi));
    assert.match(gridText(g).lines.find((l) => l.startsWith("Leave-one-model-out regret"))!, /m1 60\.0 pts \(95% CI \d+\.\d to \d+\.\d; picks h3, best h1\).*; mean 40\.0 \(95% CI \d+\.\d to \d+\.\d\)\.$/);
  });

  test("regret carries a 95% interval that holds the estimate and starts at 0 on a grid of pure noise", () => {
    for (const seed of [1, 2, 3]) {
      const { cells, contenders } = build(60, nullGrid(seed, 3, 3, 60));
      const g = done(gridAnalysis(cells, contenders));
      assert.ok(g.meanRegret > 0, `seed ${seed}: noise alone gives a regret`);
      const ci = g.meanRegretCi!;
      assert.ok(ci.lo <= g.meanRegret && g.meanRegret <= ci.hi, `seed ${seed}: ${g.meanRegret} outside ${JSON.stringify(ci)}`);
      assert.equal(ci.lo, 0, `seed ${seed}: ${JSON.stringify(ci)}`);
      for (const x of g.lomo) {
        assert.ok(x.regretCi!.lo >= 0 && x.regretCi!.lo <= x.regret && x.regret <= x.regretCi!.hi, `seed ${seed} ${x.model}: ${x.regret} outside ${JSON.stringify(x.regretCi)}`);
        assert.equal(x.regretCi!.lo, 0, `seed ${seed} ${x.model}`);
      }
      assert.match(gridText(g).lines.find((l) => l.startsWith("Leave-one-model-out regret"))!, /; mean \d+\.\d \(95% CI 0\.0 to \d+\.\d\)\.$/);
    }
  });

  test("a record stored before regret had an interval still prints", () => {
    const { cells, contenders } = build(60, crossover);
    const g = done(gridAnalysis(cells, contenders));
    const { meanRegretCi: _m, ...rest } = g;
    const old: GridAnalysis = { ...rest, lomo: g.lomo.map(({ regretCi: _r, ...x }) => x) };
    assert.match(gridText(old).lines.find((l) => l.startsWith("Leave-one-model-out regret"))!, /m1 \d+\.\d pts \(picks h2, best h1\); .*; mean \d+\.\d\.$/);
  });

  test("2x2 residuals are ± the same number: all four cells share one star state", () => {
    // The outcomes of a real `bench run` over four contenders that each pass 70% of cases (60 cases, in case id order).
    // Each interval has one bound at 0; rounding left it at ±1e-16 in three cells, which were starred, and at 0 in the fourth.
    const { cells, contenders } = build(
      60,
      fromBits({
        m1h1: "010100001110000111100110001001110110111101111111111110110111",
        m1h2: "011011011111101111111001101111111101111111101000111101011010",
        m2h1: "101010011111111110011110011111111111111111111111111110111111",
        m2h2: "101011111111101011111111101110101101111111001111000011100111",
      }),
    );
    const g = done(gridAnalysis(cells, contenders));
    for (const c of g.cells) assert.ok(Math.abs(Math.abs(c.dp.est) - 0.0541666) < 1e-6, `${c.contender} Δp ${c.dp.est}`);
    assert.deepEqual(g.cells.map((c) => excludesZero(c.dp)), [false, false, false, false]);
    assert.deepEqual(stars(g), [false, false, false, false]);
    // On every seed the four agree, starred or not.
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const null2 = build(60, nullGrid(seed, 2, 2, 60));
      const s = stars(done(gridAnalysis(null2.cells, null2.contenders)));
      assert.ok(s.every((x) => x === s[0]), `seed ${seed}: ${s}`);
    }
  });

  test(`under ${STAR_MIN_CASES} paired cases no cell is starred, with a note; the legend says the stars are not adjusted`, () => {
    // A full crossover: m1 passes only under h1, m2 only under h2. Every bootstrap draw gives Δp = ±0.5.
    const full: Spec[] = additive.map((s) => ({ ...s, pass: () => (s.axes.model === "m1") === (s.axes.harness === "h1") }));
    const few = build(10, full);
    const g = done(gridAnalysis(few.cells, few.contenders));
    assert.ok(g.cells.every((c) => excludesZero(c.dp)), "the intervals do exclude 0");
    assert.deepEqual(stars(g), [false, false, false, false]);
    const note = "10 paired cases: under 20, so no cell is starred";
    assert.ok(g.notes.includes(note), g.notes.join("; "));
    const text = gridText(g);
    assert.equal(text.lines.filter((l) => l === note).length, 1);
    assert.match(text.heading, /\* = this cell's 95% CI excludes 0, not adjusted for the number of cells/);
    // A record stored before the rule shows no stars either, and still gets the note.
    assert.equal(gridText({ ...g, notes: [] }).lines.filter((l) => l === note).length, 1);
    assert.deepEqual(stars({ ...g, notes: [] }), [false, false, false, false]);
    const enough = build(STAR_MIN_CASES, full);
    const g20 = done(gridAnalysis(enough.cells, enough.contenders));
    assert.deepEqual(stars(g20), [true, true, true, true]);
    assert.ok(!g20.notes.some((n) => n.includes("starred")));
  });

  test("duplicating trials leaves the estimates unchanged", () => {
    const one = done(gridAnalysis(...Object.values(build(60, crossover, 1)) as [Cell[], { name: string; axes: GridAxes }[]]));
    const three = done(gridAnalysis(...Object.values(build(60, crossover, 3)) as [Cell[], { name: string; axes: GridAxes }[]]));
    assert.equal(three.trials, 3);
    assert.deepEqual({ ...three, trials: 1 }, one);
  });

  test("a cell that times out on half its cases gets a negative Δv with a CI excluding 0", () => {
    const specs: Spec[] = additive.map((s) => (s.name === "m1-h1" ? { ...s, pass: (i: number) => i < 30 && i % 2 === 1, fail: (i: number) => (i % 2 === 0 ? "timeout" : undefined) } : s));
    const g = done(gridAnalysis(...Object.values(build(40, specs)) as [Cell[], { name: string; axes: GridAxes }[]]));
    const c = at(g, "m1", "h1");
    assert.equal(c.v, 0.5);
    assert.ok(Math.abs(c.dv.est + 0.125) < 1e-12, String(c.dv.est));
    assert.ok(c.dv.hi < 0, `CI ${c.dv.lo}..${c.dv.hi}`);
    assert.ok(gridText(g).lines.some((l) => l.startsWith("Completes cleanly less often") && l.includes("m1 + h1 -12.5 pp")));
    // A wrong answer is a valid completion: only J and p drop, not v.
    assert.equal(at(g, "m2", "h2").v, 1);
  });

  test("incomplete grids skip with a reason", () => {
    const three = build(20, additive.slice(0, 3));
    assert.deepEqual(gridAnalysis(three.cells, three.contenders), { skipped: "no contender runs m2 with h2" });
    const flat = build(20, additive.map((s) => ({ ...s, axes: { model: s.axes.model!, harness: "h1" } })).slice(0, 2));
    assert.deepEqual(gridAnalysis(flat.cells, flat.contenders), { skipped: "m1-h1 and m1-h2 both run m1 with h1" });
    const none = build(20, additive);
    assert.deepEqual(gridAnalysis(none.cells, none.contenders.map((c) => ({ name: c.name }))), { skipped: "no contender has both a model and a harness" });
    const oneModel = build(20, additive.filter((s) => s.axes.model === "m1"));
    assert.match((gridAnalysis(oneModel.cells, oneModel.contenders) as { skipped: string }).skipped, /needs 2 or more models/);
  });

  test("a contender without axes is left off the grid with a note; a model that never passes is dropped from the fit", () => {
    const specs: Spec[] = [...additive.map((s) => (s.axes.model === "m2" ? { ...s, pass: () => false } : s)), { name: "baseline", axes: {}, pass: () => true }];
    const { cells, contenders } = build(40, specs);
    const g = done(gridAnalysis(cells, contenders));
    assert.deepEqual(g.dropped, ["m2"]);
    assert.equal(at(g, "m2", "h1").f, undefined);
    assert.ok(g.notes.some((n) => n.includes("m2 never passed cleanly")));
    assert.ok(g.notes.some((n) => n.includes("not on the grid") && n.includes("baseline")));
    assert.equal(g.lomo.length, 0);
  });

  test("deterministic for a seed", () => {
    const { cells, contenders } = build(60, crossover);
    assert.equal(JSON.stringify(gridAnalysis(cells, contenders, { seed: 5 })), JSON.stringify(gridAnalysis([...cells].reverse(), contenders, { seed: 5 })));
    assert.notEqual(JSON.stringify(gridAnalysis(cells, contenders, { seed: 5 })), JSON.stringify(gridAnalysis(cells, contenders, { seed: 6 })));
  });
});
