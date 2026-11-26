// exp list and exp show on a durable run that has stored no experiment yet. `exp run` stores its
// first record when a trial finishes and the other exp runs when their trials are done, so a run
// stopped before then, or still going, is only a job: exp list names it after the table with the
// command to continue it (or to see its progress), --json lists it under `unfinished`, and
// exp show says where it stands instead of "Can't find experiment".
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import * as exp from "../../src/cli/commands/exp.ts";
import { openContext } from "../../src/core/context.ts";
import { createDataset } from "../../src/datasets/dataset.ts";
import { FileEvalStore } from "../../src/datasets/store.ts";
import type { Grader } from "../../src/datasets/types.ts";
import { runExperiment } from "../../src/experiments/run.ts";
import { jobConfig } from "../../src/jobs/config.ts";
import { JobStore, type Job } from "../../src/jobs/store.ts";
import { runCmd, sandbox, type Sandbox } from "./_cmd.ts";

const exact: Grader = { id: "exact", version: "1", kind: "custom", grade: async (x) => ({ score: 1, pass: x.output === x.expected }) };
// The A/B that `exp run --arm` started, as its job remembers the command line.
const AB = ["exp", "run", "spec.json", "--arm", "a=a.json", "--arm", "b=b.json"];
const KILLED = "pair_killed (exp run (A/B) ab-killed) was interrupted with 1 of 4 trials finished, and has stored no experiment yet";
const KILLED_RESUME = "coding.sh exp run spec.json --arm a=a.json --arm b=b.json --resume pair_killed";
const LIVE = "exp_live (exp run still-going) is still running with no trial finished, and has stored no experiment yet";

describe("exp list and exp show: a run that has stored no experiment yet", () => {
  let sb: Sandbox;
  let live: Job | undefined;

  before(async () => {
    sb = sandbox();
    const ctx = await openContext({ env: sb.env, cwd: sb.root });
    let storedId = "";
    try {
      const ds = createDataset({ name: "sums", createdAt: 1, cases: [{ id: "c1", input: 1, expected: 1 }] });
      const stored = await runExperiment({ name: "stored-run", dataset: ds, task: (n) => n, graders: [exact] });
      await new FileEvalStore({ env: sb.env, index: ctx.index }).putExperiment(stored);
      storedId = stored.id;
    } finally {
      await ctx.close();
    }
    const jobs = JobStore.forEnv(sb.env);
    const t0 = Date.now() - 60_000;
    // Stopped after one of its four trials, before the A/B stored anything.
    const killed = await jobs.create({ id: "pair_killed", kind: "exp ab", name: "ab-killed", config: jobConfig({ k: 1 }), total: 4, concurrency: 2, command: AB, now: t0 });
    await killed.record({ key: "c1:a:0", at: t0, ms: 10, outcome: "pass" });
    await killed.finish("interrupted");
    // Still going, before its first trial: this process owns it, so it reads as running.
    live = await jobs.create({ id: "exp_live", kind: "exp run", name: "still-going", config: jobConfig({ k: 2 }), total: 3, concurrency: 1, command: ["exp", "run", "spec.json"], now: t0 + 1000 });
    // Left out: a finished run, a run whose experiment is stored, and a bench run.
    await (await jobs.create({ id: "exp_done", kind: "exp run", name: "done", config: jobConfig({ k: 3 }), total: 1, concurrency: 1, now: t0 + 2000 })).finish("completed");
    const kept = await jobs.create({ id: "exp_kept", kind: "exp run", name: "kept", config: jobConfig({ k: 4 }), total: 1, concurrency: 1, now: t0 + 3000 });
    await kept.addRefs(storedId);
    await kept.finish("interrupted");
    await (await jobs.create({ id: "bench_b", kind: "bench run", name: "bench", config: jobConfig({ k: 5 }), total: 1, concurrency: 1, now: t0 + 4000 })).finish("interrupted");
  });
  after(async () => {
    await live?.finish("interrupted");
    sb.cleanup();
  });

  it("exp list names each such run after the table, with the command to continue it or see its progress", async () => {
    const r = await runCmd(exp, sb, { action: "list", platform: "linux" });
    assert.equal(r.error, undefined, r.error?.message);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("stored-run"), r.stdout);
    assert.ok(r.stderr.includes(KILLED), r.stderr);
    assert.ok(r.stderr.includes("Continue it:"), r.stderr);
    assert.ok(r.stderr.includes(KILLED_RESUME), r.stderr);
    assert.ok(r.stderr.includes(LIVE), r.stderr);
    assert.ok(r.stderr.includes("See its progress:"), r.stderr);
    assert.ok(r.stderr.includes("coding.sh exp status exp_live"), r.stderr);
    for (const id of ["exp_done", "exp_kept", "bench_b"]) assert.ok(!r.stdout.includes(id) && !r.stderr.includes(id), `${id} is not named`);
  });

  it("exp list --json lists them under `unfinished`, as exp status --json gives them, newest first", async () => {
    const r = await runCmd(exp, sb, { action: "list", json: true });
    assert.equal(r.error, undefined, r.error?.message);
    assert.deepEqual(
      r.json.experiments.map((e: { name: string }) => e.name),
      ["stored-run"],
    );
    assert.deepEqual(
      r.json.unfinished.map((u: { id: string }) => u.id),
      ["exp_live", "pair_killed"],
    );
    const [running, killed] = r.json.unfinished;
    assert.equal(running.status, "running");
    assert.equal(running.resume, null);
    assert.equal(killed.status, "interrupted");
    assert.equal(killed.kind, "exp ab");
    assert.equal(killed.done, 1);
    assert.equal(killed.total, 4);
    assert.equal(killed.resume, KILLED_RESUME);
    const one = await runCmd(exp, sb, { action: "list", json: true, flags: { limit: 1 } });
    assert.deepEqual(
      one.json.unfinished.map((u: { id: string }) => u.id),
      ["exp_live"],
      "--limit caps them too",
    );
  });

  it("exp show on such a run, by its id or its name, says where it stands and what to run next", async () => {
    for (const ref of ["pair_killed", "ab-killed"]) {
      const r = await runCmd(exp, sb, { action: "show", positionals: [ref] });
      assert.equal(r.error?.reason, "not_found", ref);
      assert.equal(r.error.message, KILLED);
      assert.deepEqual(r.error.next, ["Continue it:", KILLED_RESUME]);
      assert.equal(r.error.data.run.id, "pair_killed");
      assert.equal(r.error.data.run.status, "interrupted");
    }
    const r = await runCmd(exp, sb, { action: "show", positionals: ["still-going"] });
    assert.equal(r.error?.message, LIVE);
    assert.deepEqual(r.error.next, ["See its progress:", "coding.sh exp status exp_live"]);
    assert.equal(r.error.data.run.status, "running");
  });

  it("exp show on a finished run, a bench run or nothing still can't find the experiment", async () => {
    for (const ref of ["exp_done", "bench_b", "nothing-here"]) {
      const r = await runCmd(exp, sb, { action: "show", positionals: [ref] });
      assert.equal(r.error?.reason, "not_found", ref);
      assert.equal(r.error.message, `Can't find experiment ${JSON.stringify(ref)}`);
      assert.deepEqual(r.error.next, ["List experiments:", "coding.sh exp list"]);
      assert.equal(r.error.data, undefined, ref);
    }
  });
});

describe("exp list: when nothing is stored", () => {
  it("with no runs either: the hint to run one, and no `unfinished` key", async () => {
    const sb = sandbox();
    try {
      const r = await runCmd(exp, sb, { action: "list", platform: "linux" });
      assert.equal(r.code, 0, r.error?.message);
      assert.ok(r.stderr.includes("No experiments"), r.stderr);
      assert.ok(!r.stderr.includes("stored yet"), r.stderr);
      assert.ok(r.stderr.includes("coding.sh exp run spec.json"), r.stderr);
      const j = await runCmd(exp, sb, { action: "list", json: true });
      assert.deepEqual(j.json.experiments, []);
      assert.equal("unfinished" in j.json, false);
    } finally {
      sb.cleanup();
    }
  });

  it("with only a run that has stored nothing: says so and names the run", async () => {
    const sb = sandbox();
    try {
      const job = await JobStore.forEnv(sb.env).create({ id: "mxrun_m", kind: "exp matrix", name: "grid", config: jobConfig({}), total: 6, concurrency: 2, command: ["exp", "run", "grid.json"] });
      await job.finish("interrupted");
      const r = await runCmd(exp, sb, { action: "list", platform: "linux" });
      assert.equal(r.code, 0, r.error?.message);
      assert.ok(r.stderr.includes("No experiments stored yet"), r.stderr);
      assert.ok(r.stderr.includes("mxrun_m (exp matrix grid) was interrupted with no trial finished, and has stored no experiment yet"), r.stderr);
      assert.ok(r.stderr.includes("coding.sh exp run grid.json --resume mxrun_m"), r.stderr);
      assert.ok(!r.stderr.includes("Run one from a spec file"), r.stderr);
    } finally {
      sb.cleanup();
    }
  });
});
