// Model × harness grid: interaction residuals, fit, Cross-Model Fit and
// leave-one-model-out regret.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { excludesZero, gridAnalysis, gridText, type GridAnalysis, type GridAxes } from "../../src/bench/grid.ts";
import type { Cell } from "../../src/bench/types.ts";

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
