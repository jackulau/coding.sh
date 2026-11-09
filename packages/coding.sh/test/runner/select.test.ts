// X-15: the task picker, the dollar budget and the spend cap.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { EvalTask, RunResult } from "../../src/core/types.ts";
import { runExperiment } from "../../src/runner/experiment.ts";
import { estimateTaskCosts, fitBudget, pearson, rankTasks, TaskCostUnknown, type TaskCost } from "../../src/runner/select.ts";
import { cleanupWorlds, obedientAgent, toyWorld } from "../helpers-eval.ts";

after(cleanupWorlds);

let n = 0;
function run(taskId: string, bundleId: string, pass: boolean, extra: Partial<RunResult> = {}): RunResult {
  return {
    id: `r${++n}`,
    taskId,
    bundleId,
    attempt: 1,
    pass,
    verifierExit: pass ? 0 : 1,
    agent: { exitCode: 0, timedOut: false, durationMs: 1, stdoutTail: "", stderrTail: "" },
    startedAt: 0,
    endedAt: 1,
    ...extra,
  };
}

const TASKS = Array.from({ length: 10 }, (_, i) => `t${i + 1}`);

/**
 * 6 bundles (skill 1..6) × 10 tasks, one run each:
 * t1–t4 pass above a skill threshold (they tell configs apart), t5–t6 pass
 * at random with respect to skill, t7 fails everywhere, t8 never ran, t9–t10
 * pass everywhere (saturated).
 */
function suite(): RunResult[] {
  const thresholds: Record<string, number> = { t1: 3, t2: 2, t3: 4, t4: 5 };
  const noise: Record<string, number[]> = { t5: [1, 4, 6], t6: [2, 3, 6] };
  const out: RunResult[] = [];
  for (let s = 1; s <= 6; s++) {
    const b = `b${s}`;
    for (const t of TASKS) {
      if (t === "t8") continue;
      const pass = t in thresholds ? s > (thresholds[t] as number) : t in noise ? (noise[t] as number[]).includes(s) : t !== "t7";
      out.push(run(t, b, pass));
    }
  }
  return out;
}

describe("rankTasks", () => {
  it("6 bundles × 10 tasks: informative tasks first, then mixed, unseen, and the always-pass tasks last as saturated", () => {
    const ranked = rankTasks(TASKS, suite(), { seed: 1 });
    assert.equal(ranked.length, 10);
    const tier = (id: string) => ranked.find((r) => r.taskId === id)!.tier;
    const top = ranked.slice(0, 4).map((r) => r.taskId).sort();
    assert.deepEqual(top, ["t1", "t2", "t3", "t4"], JSON.stringify(ranked));
    for (const r of ranked.slice(0, 4)) {
      assert.equal(r.tier, "ranked");
      assert.ok((r.q as number) >= 0.5, `${r.taskId} q ${r.q}`);
    }
    // Noise tasks rank below every informative one.
    for (const id of ["t5", "t6"]) {
      const r = ranked.find((x) => x.taskId === id)!;
      assert.ok(r.tier !== "ranked" || (r.q as number) < 0.5, `${id}: ${JSON.stringify(r)}`);
      assert.ok(ranked.indexOf(r) >= 4);
    }
    assert.equal(tier("t7"), "mixed", "all-fail tells nothing apart, but is not saturated");
    assert.equal(tier("t8"), "unseen");
    assert.deepEqual(ranked.slice(-2).map((r) => [r.taskId, r.tier]), [["t9", "saturated"], ["t10", "saturated"]]);
    assert.equal(ranked[ranked.length - 3]!.taskId, "t8");
  });

  it("is deterministic for a seed and ignores cancelled, superseded and infra runs", () => {
    const rs = suite();
    assert.deepEqual(rankTasks(TASKS, rs, { seed: 9 }), rankTasks(TASKS, rs, { seed: 9 }));
    const noisy = [...rs, run("t9", "b1", false, { cancelled: true as const }), run("t9", "b2", false, { superseded: true }), run("t9", "b3", false, { infra: "rate-limit" })];
    assert.equal(rankTasks(["t9"], noisy)[0]!.tier, "saturated");
  });

  it("fewer configs than minConfigs leaves a task mixed", () => {
    const rs = [run("a", "b1", true), run("a", "b2", false), run("z", "b1", true), run("z", "b2", false)];
    assert.equal(rankTasks(["a"], rs)[0]!.tier, "mixed");
  });

  it("pearson", () => {
    assert.equal(pearson([1, 2, 3], [2, 4, 6]), 1);
    assert.ok(Number.isNaN(pearson([1, 1, 1], [1, 2, 3])));
  });
});

describe("budget", () => {
  const cost = (id: string, usd: number): [string, TaskCost] => [id, { taskId: id, usd, source: "baseline" }];
  const costs = new Map([cost("t1", 0.2), cost("t2", 0.15), cost("t3", 0.3), cost("t4", 0.2), cost("t5", 0.1)]);

  it("a $1.20 budget over 2 arms picks t1, t2 and t4 for $1.10", () => {
    const fit = fitBudget(["t1", "t2", "t3", "t4", "t5"], costs, { budget: 1.2, arms: 2 });
    assert.deepEqual(fit.picked, ["t1", "t2", "t4"]);
    assert.deepEqual(fit.skipped, ["t3", "t5"]);
    assert.equal(Math.round(fit.usd * 100), 110);
  });

  it("k multiplies the cost, and a sum that equals the budget fits", () => {
    assert.deepEqual(fitBudget(["t1", "t2"], costs, { budget: 1.4, arms: 2, k: 2 }).picked, ["t1", "t2"]);
    assert.deepEqual(fitBudget(["t5", "t1"], costs, { budget: 0.6, arms: 2 }).picked, ["t5", "t1"]);
  });

  const task = (id: string) => ({ id }) as EvalTask;
  const priced = (t: string, b: string, usd: number) => run(t, b, true, { agent: { exitCode: 0, timedOut: false, durationMs: 1, stdoutTail: "", stderrTail: "", usage: { costUsd: usd } } });

  it("the cost of a run comes from the baseline, any runs, the source session, the median of the others, then --cost-per-run", () => {
    const runs = [priced("a", "base", 0.4), priced("a", "other", 9), priced("b", "other", 0.3), priced("b", "other", 0.5), { ...priced("c", "base", 7), cancelled: true as const }];
    const got = estimateTaskCosts([task("a"), task("b"), task("c"), task("d")], runs, { baselineId: "base", sessionCost: (t) => (t.id === "c" ? 0.2 : undefined) });
    assert.deepEqual(
      [...got.values()].map((c) => [c.taskId, c.source, Math.round(c.usd * 1000) / 1000]),
      [
        ["a", "baseline", 0.4],
        ["b", "runs", 0.4],
        ["c", "session", 0.2],
        ["d", "pool", 0.4],
      ],
    );
    const flag = estimateTaskCosts([task("x")], [], { flag: 0.25 });
    assert.deepEqual(flag.get("x"), { taskId: "x", usd: 0.25, source: "flag" });
  });

  it("no cost known at all throws TaskCostUnknown naming the tasks", () => {
    assert.throws(
      () => estimateTaskCosts([task("x"), task("y")], [run("x", "b", true)]),
      (e: unknown) => e instanceof TaskCostUnknown && e.taskIds.join() === "x,y" && /no cost known for 2 tasks/.test(e.message),
    );
  });
});

describe("spend cap", () => {
  it("$1.00 at $0.50 a run runs exactly 2 jobs and reports the rest as skipped", async () => {
    const w = await toyWorld();
    const tasks = Array.from({ length: 3 }, (_, i) => ({ ...w.task, id: `t${i + 1}` }));
    const agent = obedientAgent();
    const r = await runExperiment({ tasks, bundles: [await w.mkBundle("a", "fix"), await w.mkBundle("b", "fix it")], adapterFor: () => agent, blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir, maxCostUsd: 1, concurrency: 1 });
    assert.equal(agent.specs.length, 2);
    assert.equal(r.results.length, 2);
    assert.equal(r.budget?.spentUsd, 1);
    assert.equal(r.budget?.skipped, 4);
    assert.equal(r.cancelled, false);
  });
});
