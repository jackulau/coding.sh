// A resumed run gives the same answer as an uninterrupted one: same schedule,
// same finished trials, same sequential looks and stopping decision, same
// sweep rounds. Each case is interrupted with the graceful stop (drain) part
// way, then resumed from its job in a fresh call, and compared field by field
// with a run that was never interrupted.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createDataset } from "../../src/datasets/dataset.ts";
import { FileEvalStore } from "../../src/datasets/store.ts";
import type { CaseRun, ExperimentResult } from "../../src/datasets/types.ts";
import { runAb, type RunAbOpts } from "../../src/experiments/ab.ts";
import { runExperiment } from "../../src/experiments/run.ts";
import { runSweep, type RunSweepOpts } from "../../src/experiments/sweep.ts";
import { exactGrader } from "../../src/graders/builtin.ts";
import { jobConfig } from "../../src/jobs/config.ts";
import { JobStore, type JobKind } from "../../src/jobs/store.ts";

let root = "";
let store: FileEvalStore;
let jobs: JobStore;
before(async () => {
  root = await mkdtemp(join(tmpdir(), "csh-jobs-resume-"));
  store = new FileEvalStore({ root });
  jobs = new JobStore(root);
});
after(() => rm(root, { recursive: true, force: true }));

/** Deterministic pass/fail per (case, arm): a pass with probability `p`. */
const unit = (s: string) => parseInt(createHash("sha256").update(s).digest("hex").slice(0, 8), 16) / 0xffffffff;
const answer = (p: number, tag: string) => (input: unknown) => (unit(`${tag}:${(input as { q: string }).q}`) < p ? "Y" : "N");

const cases = Array.from({ length: 160 }, (_, i) => ({ id: `c${i}`, input: { q: `q${i}` }, expected: "Y", split: (i % 10 < 7 ? "train" : "test") as "train" | "test" }));
const ds = createDataset({ name: "resume", createdAt: 1, cases });

const trialsOf = (r: ExperimentResult) => r.runs.map((x: CaseRun) => [x.caseId, x.trial, x.pass, x.output]);

/** A drain signal that fires once `n` tasks have started, wrapping each task to count. */
function drainAfter(n: number) {
  const ctl = new AbortController();
  let started = 0;
  const wrap =
    (f: (input: unknown) => unknown) =>
    (input: unknown) => {
      if (++started >= n) ctl.abort();
      return f(input);
    };
  return { drain: ctl.signal, wrap, started: () => started };
}

async function newJob(kind: JobKind, id: string) {
  return jobs.create({ id, kind, name: id, config: jobConfig({ id }), total: 0, concurrency: 4 });
}

describe("resume equals an uninterrupted run", () => {
  it("exp run: the interrupted run continues to the same trials and summary", async () => {
    const base = { name: "plain", dataset: ds, graders: [exactGrader()], trials: 2, store, concurrency: 4 } as const;
    const full = await runExperiment({ ...base, task: answer(0.6, "a") });

    const job = await newJob("exp run", "exp_resume_plain");
    const d = drainAfter(37);
    const first = await runExperiment({ ...base, id: job.id, task: d.wrap(answer(0.6, "a")), drain: d.drain, job: job.scope() });
    await job.finish("interrupted");
    assert.equal(first.status, "cancelled");
    assert.ok(first.runs.length >= 37 && first.runs.length < full.runs.length, `stopped part way (${first.runs.length})`);

    let reran = 0;
    const again = await jobs.resume(job.id);
    const second = await runExperiment({
      ...base,
      id: job.id,
      task: (input: unknown) => {
        reran++;
        return answer(0.6, "a")(input);
      },
      job: again.scope(),
    });
    await again.finish("completed");
    assert.equal(second.status, "completed");
    assert.equal(second.id, first.id);
    assert.equal(reran, full.runs.length - first.runs.length, "only the unfinished trials ran again");
    assert.deepEqual(trialsOf(second), trialsOf(full));
    assert.deepEqual(second.summary.passRate, full.summary.passRate);
    assert.equal(second.summary.n, full.summary.n);
  });

  for (const at of [9, 41, 75]) {
    it(`interleaved A/B with --stop-early, interrupted after ${at} trials: same looks, same stop, same runs`, async () => {
      const base: Omit<RunAbOpts, "arms"> = { name: `ab${at}`, dataset: ds, graders: [exactGrader()], store, seed: 11, concurrency: 3, stopEarly: { looks: 4 }, bootstrapIters: 200 };
      const arms = (wrap = (f: (input: unknown) => unknown) => f) =>
        [
          { name: "a", task: wrap(answer(0.35, "a")) },
          { name: "b", task: wrap(answer(0.85, "b")) },
        ] as const;
      const full = await runAb({ ...base, arms: arms() });
      assert.ok(full.sequential, "a sequential outcome");

      const job = await newJob("exp ab", `pair_resume_${at}`);
      const d = drainAfter(at);
      const first = await runAb({ ...base, arms: arms(d.wrap), drain: d.drain, job: job.scope() });
      await job.finish("interrupted");
      assert.equal(first.a.status, "cancelled");
      assert.equal(full.sequential!.early, true, "the uninterrupted run stops early");
      const n = (r: typeof full) => r.a.runs.length + r.b.runs.length;
      assert.ok(n(first) < n(full), `interrupted before the stop (${n(first)} of ${n(full)})`);

      const again = await jobs.resume(job.id);
      const second = await runAb({ ...base, arms: arms(), job: again.scope() });
      await again.finish("completed");
      assert.equal(second.a.status, "completed");
      assert.equal(second.pairId, first.pairId);
      assert.deepEqual([second.a.id, second.b.id], [first.a.id, first.b.id]);
      assert.equal(second.seed, full.seed);
      assert.deepEqual(second.sequential, full.sequential, "same looks, same stopping decision");
      assert.deepEqual(trialsOf(second.a), trialsOf(full.a));
      assert.deepEqual(trialsOf(second.b), trialsOf(full.b));
      assert.deepEqual(second.a.summary.passRate, full.a.summary.passRate);
      assert.deepEqual(second.b.summary.passRate, full.b.summary.passRate);
    });
  }

  it("A/B resumed after a crash (no graceful stop): the job log alone restores it", async () => {
    const base: Omit<RunAbOpts, "arms"> = { name: "abcrash", dataset: ds, graders: [exactGrader()], store, seed: 5, concurrency: 2, stopEarly: true, bootstrapIters: 200 };
    const arms = [
      { name: "a", task: answer(0.4, "a") },
      { name: "b", task: answer(0.8, "b") },
    ] as const;
    const full = await runAb({ ...base, arms });
    const job = await newJob("exp ab", "pair_resume_crash");
    // A crash: the process dies after 30 trials. Simulate by aborting hard and dropping the in-memory result.
    const kill = new AbortController();
    let n = 0;
    const killing = arms.map((a) => ({ ...a, task: (input: unknown) => (++n >= 30 && kill.abort(), (a.task as (i: unknown) => unknown)(input)) })) as unknown as RunAbOpts["arms"];
    await runAb({ ...base, arms: killing, signal: kill.signal, job: job.scope() });
    const again = await jobs.resume(job.id);
    const second = await runAb({ ...base, arms, job: again.scope() });
    assert.deepEqual(second.sequential, full.sequential);
    assert.deepEqual(trialsOf(second.a), trialsOf(full.a));
    assert.deepEqual(trialsOf(second.b), trialsOf(full.b));
  });

  it("sweep: interrupted mid-race, the resumed sweep ranks, drops and picks the same configs", async () => {
    const configs = [
      { name: "base", task: answer(0.4, "base") },
      { name: "t2", task: answer(0.55, "t2") },
      { name: "t5", task: answer(0.8, "t5") },
      { name: "t9", task: answer(0.3, "t9") },
    ];
    const base: Omit<RunSweepOpts, "configs"> = { name: "sw", dataset: ds, graders: [exactGrader()], store, seed: 3, concurrency: 3, bootstrapIters: 200 };
    const full = await runSweep({ ...base, configs });
    assert.equal(full.status, "completed");

    for (const at of [20, full.used + 5]) {
      const job = await newJob("exp sweep", `sweep_resume_${at}`);
      const d = drainAfter(at);
      const first = await runSweep({ ...base, configs: configs.map((c) => ({ ...c, task: d.wrap(c.task) })), drain: d.drain, job: job.scope() });
      await job.finish("interrupted");
      assert.equal(first.status, "cancelled", `cancelled after ${at}`);
      const again = await jobs.resume(job.id);
      const second = await runSweep({ ...base, configs, job: again.scope() });
      assert.equal(second.status, "completed");
      assert.deepEqual(second.rounds, full.rounds, `same rounds (interrupted after ${at})`);
      assert.equal(second.used, full.used);
      assert.equal(second.winner?.name, full.winner?.name);
      assert.deepEqual(
        { ...second.winner?.heldOut, experiment: undefined },
        { ...full.winner?.heldOut, experiment: undefined },
      );
      assert.deepEqual(second.configs.map((c) => [c.name, c.train, c.droppedIn]), full.configs.map((c) => [c.name, c.train, c.droppedIn]));
    }
  });
});
