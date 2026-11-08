// X-25: iterate on a harness comparison: retry a stored comparison's errored
// runs in place, keep one run per slot, pick the tasks an arm failed before,
// and draw a seeded sample of tasks.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { EvalTask, RunResult } from "../../src/core/types.ts";
import { compare, runExperiment, runKey } from "../../src/runner/experiment.ts";
import { describeSelection, erroredRuns, latestPerSlot, sampleTasks, selectFailing, slotKey } from "../../src/runner/iterate.ts";
import { cleanupWorlds, obedientAgent, toyWorld } from "../helpers-eval.ts";

after(cleanupWorlds);

const run = (p: Partial<RunResult>): RunResult =>
  ({ id: "run_1", taskId: "t1", bundleId: "A", attempt: 1, pass: true, verifierExit: 0, startedAt: 0, endedAt: 10, agent: {}, ...p }) as RunResult;

describe("latestPerSlot", () => {
  it("keeps the newest counting run per task, arm and attempt, in input order", () => {
    const runs = [
      run({ id: "run_1", endedAt: 10, pass: false }),
      run({ id: "run_2", endedAt: 20 }),
      run({ id: "run_3", bundleId: "B" }),
      run({ id: "run_4", endedAt: 30, superseded: true }),
      run({ id: "run_5", endedAt: 40, cancelled: true }),
    ];
    const { runs: kept, dropped } = latestPerSlot(runs);
    assert.deepEqual(kept.map((r) => r.id), ["run_2", "run_3", "run_4", "run_5"], "runs that don't count pass through; the report leaves them out");
    assert.deepEqual(dropped.map((r) => r.id), ["run_1"]);
  });

  it("returns the same runs when no slot holds two", () => {
    const runs = [run({ id: "a" }), run({ id: "b", attempt: 2 }), run({ id: "c", taskId: "t2" })];
    const out = latestPerSlot(runs);
    assert.deepEqual(out.runs, runs);
    assert.equal(out.dropped.length, 0);
  });

  it("slotKey is the checkpoint key of the job that fills the slot", () => {
    const r = run({ taskId: "t9", bundleId: "B", attempt: 3 });
    assert.equal(slotKey(r), runKey({ task: { id: "t9" } as EvalTask, bundle: { id: "B" } as never, attempt: 3 }));
  });
});

describe("erroredRuns", () => {
  it("picks the newest errored or infra-failed run of each slot with no good run, never a cancelled or superseded one", () => {
    const runs = [
      run({ id: "e1", pass: false, error: "clone failed" }),
      run({ id: "i1", taskId: "t2", pass: false, infra: "rate-limit" }),
      run({ id: "c1", taskId: "t3", pass: false, cancelled: true }),
      run({ id: "s1", taskId: "t4", pass: false, error: "x", superseded: true }),
      run({ id: "e2", taskId: "t5", pass: false, error: "old", endedAt: 5 }),
      run({ id: "ok", taskId: "t5", pass: false, endedAt: 50 }),
      run({ id: "f1", taskId: "t6", pass: false }),
    ];
    assert.deepEqual(erroredRuns(runs).map((r) => r.id), ["e1", "i1"]);
  });
});

describe("selectFailing", () => {
  const runs = [
    run({ taskId: "t1", attempt: 1, pass: false }),
    run({ taskId: "t1", attempt: 2, pass: true }),
    run({ taskId: "t2", attempt: 1, pass: false }),
    run({ taskId: "t2", attempt: 2, pass: false }),
    run({ taskId: "t3", attempt: 1, pass: true }),
    run({ taskId: "t4", attempt: 1, pass: false, infra: "server" }),
    run({ taskId: "t5", bundleId: "B", pass: false }),
  ];
  it("any: failed in any attempt; majority: in more than half; unknown outcomes are not selected", () => {
    assert.deepEqual(selectFailing(runs, "A", "any"), ["t1", "t2"]);
    assert.deepEqual(selectFailing(runs, "A", "majority"), ["t2"], "1 of 2 is not a majority");
    assert.deepEqual(selectFailing(runs, "B"), ["t5"]);
    assert.deepEqual(selectFailing(runs, "C"), []);
  });
});

describe("sampleTasks", () => {
  const xs = Array.from({ length: 20 }, (_, i) => `t${i}`);
  it("is deterministic per seed, without replacement, in input order", () => {
    const a = sampleTasks(xs, 5, 7);
    assert.deepEqual(sampleTasks(xs, 5, 7), a);
    assert.equal(new Set(a).size, 5);
    assert.deepEqual(a, [...a].sort((p, q) => xs.indexOf(p) - xs.indexOf(q)));
    assert.notDeepEqual(sampleTasks(xs, 5, 8), a, "another seed, another sample");
    assert.deepEqual(sampleTasks(xs, 50, 1), xs);
  });
  it("draws each task about equally often over many seeds", () => {
    const hits = new Map<string, number>();
    for (let seed = 0; seed < 2000; seed++) for (const t of sampleTasks(xs, 5, seed)) hits.set(t, (hits.get(t) ?? 0) + 1);
    // Expected 2000 × 5/20 = 500 per task; ±20% is far outside sampling noise (sd ≈ 19).
    for (const t of xs) assert.ok(Math.abs((hits.get(t) ?? 0) - 500) < 100, `${t}: ${hits.get(t)}`);
  });
});

describe("describeSelection", () => {
  it("says the delta holds on the subset and the rates are conditioned on prior failure", () => {
    const tasks = [{ id: "t1" }, { id: "t2" }] as EvalTask[];
    const s = describeSelection({ from: 12, tasks, failing: { experimentId: "exp_1", bundleId: "A", bundle: "base", mode: "any", matched: 2 } });
    assert.equal(s.tasks, 2);
    assert.match(s.note, /^selection: 2 of 12 tasks: the 2 tasks base failed in exp_1\. The B − A difference holds for these tasks; both pass rates are conditioned on base having failed them/);
    const sampled = describeSelection({ from: 40, tasks, sample: { n: 2, seed: 7 } });
    assert.match(sampled.note, /^selection: 2 of 40 tasks: a sample of 2 \(seed 7\)\. Pass rates are estimates for the full set/);
  });
});

describe("runExperiment --retry-errors", () => {
  it("runs only the errored slot again, marks the old run superseded, and the comparison counts the slot once", async () => {
    const w = await toyWorld();
    // The stores upsert a run by id (SQLite: ON CONFLICT(id) DO UPDATE); MemIndex appends, so replace in place here.
    const putRun = w.index.putRun.bind(w.index);
    w.index.putRun = async (r: RunResult) => {
      const i = w.index.runs.findIndex((x) => x.id === r.id);
      if (i >= 0) w.index.runs[i] = r;
      else await putRun(r);
    };
    const A = await w.mkBundle("lazy", "half effort");
    const B = await w.mkBundle("diligent", "always fix bugs");
    const tasks: EvalTask[] = [w.task, { ...w.task, id: "t2" }];
    const agent = obedientAgent();
    const base = { tasks, bundles: [A, B], adapterFor: () => agent, blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir, k: 2, concurrency: 2 };
    const first = await runExperiment(base);
    assert.equal(first.results.length, 8);
    assert.deepEqual([first.planned, first.skipped, first.retried], [8, 0, undefined]);
    // One run of B on t2 errored (say the repo failed to clone).
    const victim = first.results.find((r) => r.bundleId === B.id && r.taskId === "t2" && r.attempt === 2)!;
    await w.index.putRun({ ...victim, pass: false, error: "git clone failed" });
    const stored = await w.index.listRuns({ experimentId: first.experimentId });
    const errored = erroredRuns(stored);
    assert.deepEqual(errored.map((r) => r.id), [victim.id]);
    const calls = agent.specs.length;
    const replaces = new Map(errored.map((r) => [slotKey(r), r]));
    const again = await runExperiment({ ...base, select: (j) => replaces.has(runKey(j)), replaces, experimentId: first.experimentId });
    assert.equal(agent.specs.length - calls, 1, "one agent call");
    assert.deepEqual([again.planned, again.skipped, again.retried], [1, 0, 1]);
    const after = await w.index.listRuns({ experimentId: first.experimentId });
    assert.equal(after.length, 9, "the old run stays for the record");
    assert.equal(after.find((r) => r.id === victim.id)?.superseded, true);
    const slots = latestPerSlot(after);
    assert.equal(slots.dropped.length, 0, "the superseded run is not a duplicate");
    const report = compare(slots.runs, { baseline: A.id, candidate: B.id });
    assert.equal(report.baseline.runs + report.candidate.runs, 8, "each slot counts once");
    assert.equal(report.candidate.passes, 4, "B's retried run passes");
  });
});
