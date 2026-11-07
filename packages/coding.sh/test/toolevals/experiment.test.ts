// Tool-eval trial lifecycle: sandbox cleanup (EXP-7), the tap blob on the stored
// run (STO-3) and cancellation (EXP-2), with a fake command agent.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { Adapter, RunSpec } from "../../src/core/types.ts";
import { sh } from "../../src/runner/exec.ts";
import { runToolExperiment, runTrial, type ToolJob } from "../../src/toolevals/experiment.ts";
import { fakeAdapter, MemBlobs, MemIndex } from "../helpers-eval.ts";
import { cleanup, cliTarget, task, tmp } from "./helpers.ts";

after(cleanup);

/** An "agent" that runs one shell line in the sandbox (PATH holds the tapped fake-cli shim). */
function shellAgent(line: string): Adapter {
  return {
    ...fakeAdapter(),
    run: async (spec: RunSpec) => {
      const r = await sh(line, { cwd: spec.cwd, env: { ...process.env, ...spec.env }, timeoutMs: spec.timeoutMs });
      return { exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs, stdoutTail: r.stdoutTail, stderrTail: r.stderrTail };
    },
  };
}

const job = (over: Partial<ToolJob> = {}): ToolJob => ({ task: task(), variant: { name: "base" }, driver: { kind: "agent", agent: "claude-code" }, attempt: 1, ...over });

describe("runTrial", () => {
  it("removes the sandbox when setup fails (no keep)", async () => {
    const expDir = tmp();
    const t = task({ setup: { commands: ["echo secret > leaked.txt; exit 3"], files: {}, env: {} } });
    const r = await runTrial({ job: job({ task: t }), target: cliTarget(), experimentId: "texp_x", expDir, index: new MemIndex(), blobs: new MemBlobs(), adapterFor: () => shellAgent("true") });
    assert.match(r.error ?? "", /setup .* exited 3/);
    assert.deepEqual(readdirSync(expDir), [], "trial dir removed");
  });

  it("keeps the sandbox of a failed setup with keep", async () => {
    const expDir = tmp();
    const t = task({ setup: { commands: ["exit 3"], files: {}, env: {} } });
    const r = await runTrial({ job: job({ task: t }), target: cliTarget(), experimentId: "texp_x", expDir, index: new MemIndex(), blobs: new MemBlobs(), keep: true, adapterFor: () => shellAgent("true") });
    assert.deepEqual(readdirSync(expDir), [r.id]);
  });

  it("stores the tap blob on the run it puts, so blob gc sees it", async () => {
    const expDir = tmp();
    const index = new MemIndex();
    const blobs = new MemBlobs();
    const r = await runTrial({ job: job(), target: cliTarget(), experimentId: "texp_tap", expDir, index, blobs, adapterFor: () => shellAgent("fake-cli greet bob") });
    assert.ok(r.tapBlob, "the trial tapped a call");
    const [run] = await index.listRuns({ experimentId: "texp_tap" });
    assert.equal(run?.tapBlob, r.tapBlob);
    assert.ok(await blobs.get(r.tapBlob!));
  });
});

describe("runToolExperiment cancellation", () => {
  it("an abort kills the running agent, starts no new trial and keeps cut-short trials out of trials.jsonl", async () => {
    const root = tmp();
    const pidFile = join(tmp(), "pids");
    const index = new MemIndex();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 800);
    const t0 = Date.now();
    const r = await runToolExperiment({
      tasks: [task()],
      target: cliTarget(),
      variants: [{ name: "base" }],
      drivers: [{ kind: "agent", agent: "claude-code" }],
      k: 3,
      concurrency: 1,
      root,
      index,
      blobs: new MemBlobs(),
      adapterFor: () => shellAgent(`echo $$ >> ${pidFile}; sleep 30`),
      signal: ac.signal,
    });
    assert.ok(Date.now() - t0 < 5000, `stopped in ${Date.now() - t0}ms`);
    assert.equal(r.cancelled, true);
    assert.deepEqual(r.trials, []);
    assert.deepEqual(readdirSync(r.dir).sort(), ["experiment.json"], "no trial dir, no trials.jsonl");
    const pids = readFileSync(pidFile, "utf8").trim().split("\n").map(Number);
    assert.equal(pids.length, 1, "no trial started after the abort");
    let alive = true;
    try {
      process.kill(pids[0]!, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false, "agent killed");
    const runs = await index.listRuns({ experimentId: r.experimentId });
    assert.ok(runs.length === 1 && runs[0]!.cancelled === true);
  });
});
