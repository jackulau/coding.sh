// EM-12: item difficulty (1PL/2PL IRT) and informative case selection.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { correlation, fitIrt, informativeItems, irtOrderTasks, irtResponsesFromRuns, itemInformation, mulberry32, type IrtResponse } from "../../src/stats/index.ts";

/** Standard normal by Box-Muller from a seeded uniform. */
function normal(rand: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
}

/** Simulated responses: subjects × items × trials under σ(a(θ − b)). */
function simulate(o: { subjects: number; items: number; trials: number; seed: number; twoPl?: boolean }) {
  const rand = mulberry32(o.seed);
  const theta = Array.from({ length: o.subjects }, () => normal(rand));
  const b = Array.from({ length: o.items }, () => normal(rand) * 1.2);
  const a = Array.from({ length: o.items }, () => (o.twoPl ? Math.exp(normal(rand) * 0.4) : 1));
  const responses: IrtResponse[] = [];
  for (let s = 0; s < o.subjects; s++) {
    for (let i = 0; i < o.items; i++) {
      const p = 1 / (1 + Math.exp(-a[i]! * (theta[s]! - b[i]!)));
      let pass = 0;
      for (let t = 0; t < o.trials; t++) if (rand() < p) pass++;
      responses.push({ subject: `c${s}`, item: `case${i}`, pass, n: o.trials });
    }
  }
  return { theta, b, a, responses };
}

describe("fitIrt", () => {
  it("Rasch: recovered difficulties correlate > 0.9 with the truth (30 configs × 80 cases × 1 trial)", () => {
    const sim = simulate({ subjects: 30, items: 80, trials: 1, seed: 1 });
    const fit = fitIrt(sim.responses);
    assert.equal(fit.model, "1pl");
    assert.ok(fit.converged, `not converged after ${fit.iterations}`);
    const est = sim.b.map((_, i) => fit.items.find((x) => x.id === `case${i}`)!.difficulty);
    const r = correlation(est, sim.b);
    assert.ok(r > 0.9, `r = ${r}`);
    assert.ok(fit.items.every((x) => x.discrimination === 1));
    const ab = sim.theta.map((_, s) => fit.subjects.find((x) => x.id === `c${s}`)!.ability);
    assert.ok(correlation(ab, sim.theta) > 0.9);
  });

  it("Rasch with few configs and repeated trials (8 configs × 60 cases × 4 trials)", () => {
    const sim = simulate({ subjects: 8, items: 60, trials: 4, seed: 2 });
    const fit = fitIrt(sim.responses);
    const est = sim.b.map((_, i) => fit.items.find((x) => x.id === `case${i}`)!.difficulty);
    assert.ok(correlation(est, sim.b) > 0.9, `r = ${correlation(est, sim.b)}`);
  });

  it("2PL recovers difficulty and tracks discrimination (200 configs × 40 cases)", () => {
    const sim = simulate({ subjects: 200, items: 40, trials: 1, seed: 3, twoPl: true });
    const fit = fitIrt(sim.responses, { model: "2pl" });
    assert.ok(fit.converged);
    const items = sim.b.map((_, i) => fit.items.find((x) => x.id === `case${i}`)!);
    assert.ok(correlation(items.map((x) => x.difficulty), sim.b) > 0.9);
    assert.ok(correlation(items.map((x) => x.discrimination), sim.a) > 0.5, `r_a = ${correlation(items.map((x) => x.discrimination), sim.a)}`);
    // The 2PL fits at least as well as the 1PL on 2PL data.
    assert.ok(fit.logLik >= fitIrt(sim.responses).logLik);
  });

  it("is deterministic, keeps all-pass cases finite, and checks its input", () => {
    const sim = simulate({ subjects: 6, items: 10, trials: 1, seed: 4 });
    const resp = [...sim.responses, ...Array.from({ length: 6 }, (_, s) => ({ subject: `c${s}`, item: "easy", pass: 1 }))];
    const a = fitIrt(resp);
    assert.deepEqual(a, fitIrt(resp));
    const easy = a.items.find((x) => x.id === "easy")!;
    assert.ok(Number.isFinite(easy.difficulty) && easy.difficulty < Math.min(...a.items.filter((x) => x.id !== "easy").map((x) => x.difficulty)) + 1e-9);
    assert.equal(easy.passRate, 1);
    assert.throws(() => fitIrt([{ subject: "a", item: "x", pass: 2, n: 1 }]), RangeError);
  });

  it("aggregates repeated responses of one config on one case", () => {
    const one = fitIrt([
      { subject: "a", item: "x", pass: 1 },
      { subject: "a", item: "x", pass: 0 },
      { subject: "b", item: "x", pass: 1 },
    ]);
    assert.deepEqual(
      one.items.map((x) => [x.id, x.n, x.subjects]),
      [["x", 3, 2]],
    );
  });
});

describe("informativeItems", () => {
  it("prefers mid-difficulty, high-discrimination cases; dead cases go last", () => {
    const fit = {
      model: "2pl" as const,
      iterations: 1,
      converged: true,
      logLik: 0,
      subjects: [-0.5, 0, 0.5].map((ability, i) => ({ id: `s${i}`, ability, n: 1 })),
      items: [
        { id: "far-hard", difficulty: 3, discrimination: 1.5 },
        { id: "mid-sharp", difficulty: 0, discrimination: 2 },
        { id: "mid-flat", difficulty: 0, discrimination: 0.5 },
        { id: "near-sharp", difficulty: 0.8, discrimination: 2 },
        { id: "mid-dead", difficulty: 0, discrimination: 2, passRate: 1 },
      ].map((x) => ({ n: 3, subjects: 3, passRate: 0.5, ...x })),
    };
    const ranked = informativeItems(fit);
    assert.deepEqual(
      ranked.map((x) => x.id),
      ["mid-sharp", "near-sharp", "mid-flat", "far-hard", "mid-dead"],
    );
    assert.equal(ranked.at(-1)!.dead, true);
    assert.deepEqual(
      informativeItems(fit, { k: 2 }).map((x) => x.id),
      ["mid-sharp", "near-sharp"],
    );
    // Target abilities move the peak: for strong configs the hard case is the informative one.
    assert.equal(informativeItems(fit, { abilities: [3] })[0]!.id, "far-hard");
    assert.ok(Math.abs(itemInformation({ difficulty: 0, discrimination: 2 }, 0) - 1) < 1e-12);
  });

  it("on fitted 2PL data the picked cases sit nearer the configs' abilities and discriminate more", () => {
    const sim = simulate({ subjects: 200, items: 60, trials: 1, seed: 5, twoPl: true });
    const fit = fitIrt(sim.responses, { model: "2pl" });
    const ranked = informativeItems(fit);
    const top = ranked.slice(0, 15);
    const rest = ranked.slice(15);
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    const centre = mean(fit.subjects.map((s) => s.ability));
    assert.ok(mean(top.map((x) => Math.abs(x.difficulty - centre))) < mean(rest.map((x) => Math.abs(x.difficulty - centre))));
    assert.ok(mean(top.map((x) => x.discrimination)) > mean(rest.map((x) => x.discrimination)));
  });
});

describe("irtResponsesFromRuns", () => {
  it("one response per config and task, counted runs only", () => {
    const r = irtResponsesFromRuns([
      { taskId: "t1", bundleId: "A", pass: true },
      { taskId: "t1", bundleId: "A", pass: false },
      { taskId: "t1", bundleId: "A", pass: true, cancelled: true },
      { taskId: "t1", bundleId: "B", pass: false, infra: "network" },
      { taskId: "t2", bundleId: "B", pass: true },
    ]);
    assert.deepEqual(r, [
      { subject: "A", item: "t1", pass: 1, n: 2 },
      { subject: "B", item: "t2", pass: 1, n: 1 },
    ]);
  });
});

describe("irtOrderTasks", () => {
  /** Runs of `configs` bundles on tasks with fixed difficulty; ability rises with the bundle index. */
  function history(configs: number, seed: number) {
    const rand = mulberry32(seed);
    const diff: Record<string, number> = { easy: -3, mid: 0, midhard: 1, hard: 4, solved: -50 };
    const runs: { taskId: string; bundleId: string; pass: boolean }[] = [];
    for (let c = 0; c < configs; c++) {
      const theta = -1 + (2 * c) / Math.max(1, configs - 1);
      for (const [t, b] of Object.entries(diff)) for (let k = 0; k < 6; k++) runs.push({ taskId: t, bundleId: `b${c}`, pass: rand() < 1 / (1 + Math.exp(-(theta - b))) });
    }
    return runs;
  }
  const tasks = ["solved", "hard", "unseen", "easy", "mid", "midhard"].map((taskId) => ({ taskId, tier: "x" }));

  it("mid-difficulty tasks first, unseen next, all-pass last; fields added only where fitted", () => {
    const r = irtOrderTasks(tasks, history(6, 1), { target: "b2" });
    assert.equal(r.fitted, true);
    assert.equal(r.model, "1pl");
    assert.equal(r.configs, 6);
    assert.equal(r.tasks[0]!.taskId, "mid");
    assert.deepEqual(r.tasks.slice(-2).map((t) => t.taskId), ["unseen", "solved"]);
    assert.equal(r.tasks.find((t) => t.taskId === "unseen")!.information, undefined);
    assert.ok(r.tasks.find((t) => t.taskId === "mid")!.information! > r.tasks.find((t) => t.taskId === "hard")!.information!);
    assert.equal(r.tasks.find((t) => t.taskId === "mid")!.tier, "x", "the task's own fields are kept");
    assert.match(r.note, /1PL item information at the baseline's ability \(6 configs\)/);
    assert.deepEqual(irtOrderTasks(tasks, history(6, 1), { target: "b2" }), r);
  });

  it("2PL from twoPlFrom configs; fewer than minConfigs keeps the input order", () => {
    assert.equal(irtOrderTasks(tasks, history(6, 2), { twoPlFrom: 5 }).model, "2pl");
    const few = irtOrderTasks(tasks, history(2, 3));
    assert.equal(few.fitted, false);
    assert.deepEqual(few.tasks, tasks);
    assert.match(few.note, /needs stored runs from 3 or more configs \(found 2\)/);
  });
});
