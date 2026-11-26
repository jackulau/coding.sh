import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { AgentRunOutput, RunSpec } from "../../src/core/types.ts";
import { createDataset } from "../../src/datasets/dataset.ts";
import { runExperiment as runCases } from "../../src/experiments/run.ts";
import { exactGrader } from "../../src/graders/builtin.ts";
import { TRIAL_TIMEOUT_FLAG } from "../../src/jobs/flags.ts";
import { runExperiment as runTasks } from "../../src/runner/experiment.ts";
import { DEFAULT_RUN_TIMEOUT_MS, runTask } from "../../src/runner/run.ts";
import { commandDriver } from "../../src/workflows/drivers/command.ts";
import { runWorkflowExperiment } from "../../src/workflows/experiment.ts";
import { WorkflowStore } from "../../src/workflows/store.ts";
import type { WorkflowCase, WorkflowDriver } from "../../src/workflows/types.ts";
import { FIXED, cleanupWorlds, fakeAdapter, toyWorld } from "../helpers-eval.ts";

after(cleanupWorlds);

const FIX: Record<string, string> = { "src/add.js": FIXED["src/add.js"] as string, "src/mul.js": FIXED["src/mul.js"] as string };
const HALF: Record<string, string> = { "src/add.js": FIXED["src/add.js"] as string };
const RETRY_TWICE = { retries: 2, baseMs: 0, maxMs: 0 };

/** A fake agent that does `act`, then ends as `end` says: a server error, or that and a timeout. */
function endingAs(end: { timedOut: boolean }, act?: (spec: RunSpec) => Record<string, string> | undefined) {
  const base = fakeAdapter(act ? { act } : {});
  return {
    ...base,
    async run(spec: RunSpec): Promise<AgentRunOutput> {
      return { ...(await base.run!(spec)), exitCode: end.timedOut ? null : 1, timedOut: end.timedOut, stderrTail: "HTTP 503 service unavailable" };
    },
  };
}

describe("--trial-timeout", () => {
  it("the help says the limit is per agent call, task run or workflow run, that each retry and repair round gets it again, and that a run over it is not retried", () => {
    const desc = TRIAL_TIMEOUT_FLAG.desc;
    assert.match(desc, /each agent call, task run or workflow run/);
    assert.match(desc, /each retry and repair round gets it again/);
    assert.match(desc, /a run over it is not retried/);
    assert.doesNotMatch(desc, /retries included/);
  });

  it("agent tasks: the first agent call and each repair round's call get the whole limit, 30 minutes by default", async () => {
    const w = await toyWorld();
    const learner = fakeAdapter({ canResume: true, act: (spec) => (spec.instruction.includes("Verification failed.") ? FIX : HALF) });
    const r = await runTask({ task: w.task, bundle: await w.mkBundle("x", "x"), adapter: learner, blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir, timeoutMs: 1234, repair: { rounds: 3, signal: "bit" } });
    assert.equal(r.repair?.pass, true);
    assert.deepEqual(
      learner.specs.map((s) => s.timeoutMs),
      [1234, 1234],
    );
    const plain = fakeAdapter({ act: () => FIX });
    await runTask({ task: w.task, bundle: await w.mkBundle("y", "y"), adapter: plain, blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir });
    assert.deepEqual(
      plain.specs.map((s) => s.timeoutMs),
      [DEFAULT_RUN_TIMEOUT_MS],
    );
    assert.equal(DEFAULT_RUN_TIMEOUT_MS, 30 * 60_000);
  });

  it("agent tasks: the verifier grades a run whose agent ran out of time, and that run is not retried", async () => {
    const w = await toyWorld();
    const r = await runTask({ task: w.task, bundle: await w.mkBundle("t", "t"), adapter: endingAs({ timedOut: true }, () => FIX), blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir, timeoutMs: 1000 });
    assert.equal(r.pass, true, "the work the agent left passes");
    assert.equal(r.error, "agent timed out");

    const opts = { tasks: [w.task], bundles: [await w.mkBundle("u", "u")], k: 1, blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir, concurrency: 1, timeoutMs: 1000, retry: RETRY_TWICE };
    const serverError = endingAs({ timedOut: false });
    const retried = await runTasks({ ...opts, adapterFor: () => serverError });
    assert.equal(serverError.specs.length, 3, "a server error is retried");
    assert.equal(retried.results[0]?.attempts, 3);
    const outOfTime = endingAs({ timedOut: true });
    const once = await runTasks({ ...opts, adapterFor: () => outOfTime });
    assert.equal(outOfTime.specs.length, 1, "the same run out of time is not");
    assert.equal(once.results[0]?.attempts, undefined);
    assert.equal(once.results[0]?.pass, false);
  });

  it("case runs: each attempt gets the whole limit, and a run over it fails and is not retried", async () => {
    const dataset = createDataset({ name: "trial-timeout", cases: [{ id: "c1", input: "x", expected: "x" }] });
    /** Waits `ms`, or until the run's signal fires. */
    const nap = (ms: number, signal?: AbortSignal) =>
      new Promise<void>((res) => {
        const t = setTimeout(res, ms);
        signal?.addEventListener("abort", () => (clearTimeout(t), res()), { once: true });
      });
    let calls = 0;
    // Each attempt takes 700 ms: under the 1200 ms limit alone, over it together.
    const retried = await runCases({
      name: "retried",
      dataset,
      task: async (input, ctx) => {
        calls++;
        await nap(700, ctx.signal);
        if (calls === 1) throw new Error("HTTP 503 service unavailable");
        return input;
      },
      graders: [exactGrader()],
      retry: RETRY_TWICE,
      timeoutMs: 1200,
    });
    const [second] = retried.runs;
    assert.equal(second?.attempts, 2);
    assert.equal(second?.error, undefined);
    assert.equal(second?.pass, true, "the retry got the whole limit");

    calls = 0;
    const slow = await runCases({
      name: "slow",
      dataset,
      task: async (input, ctx) => {
        calls++;
        await nap(5000, ctx.signal);
        return input;
      },
      graders: [exactGrader()],
      retry: RETRY_TWICE,
      timeoutMs: 300,
    });
    const [over] = slow.runs;
    assert.equal(calls, 1, "not retried");
    assert.equal(over?.pass, false);
    assert.match(over?.error ?? "", /^timed out after 300 ms \(trial timeout\)$/);
  });

  it("workflow runs: a run over the limit times out and is not retried", async () => {
    const dir = mkdtempSync(join(tmpdir(), "csh-trial-timeout-"));
    try {
      writeFileSync(join(dir, "fails.mjs"), `console.error("HTTP 503 service unavailable"); process.exit(1);`);
      writeFileSync(join(dir, "hangs.mjs"), `console.error("HTTP 503 service unavailable"); setTimeout(() => {}, 30_000);`);
      const wfCase: WorkflowCase = { id: "c1", workflow: "w", split: "dev", args: {}, truth: { kind: "verifier" } };
      const inner = commandDriver({ cwd: dir, timeoutMs: 2500 });
      let calls = 0;
      const driver: WorkflowDriver = {
        id: "command",
        run: (v, c, env) => {
          calls++;
          return inner.run(v, c, env);
        },
      };
      const run = async (script: string) => {
        calls = 0;
        const variants = [{ name: script, command: [process.execPath, join(dir, script)] }];
        const res = await runWorkflowExperiment({ workflow: "w", variants, cases: [wfCase], k: 1, driver, store: new WorkflowStore(join(dir, `store-${script}`)), retry: RETRY_TWICE, score: () => undefined });
        return { calls, run: res.runs[0] };
      };
      const fails = await run("fails.mjs");
      assert.equal(fails.calls, 3, "a server error is retried");
      const hangs = await run("hangs.mjs");
      assert.equal(hangs.calls, 1, "a run over the limit is not");
      assert.equal(hangs.run?.error, "timed out");
      assert.equal(hangs.run?.status, "failed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
