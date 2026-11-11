// Tool-eval trial lifecycle: sandbox cleanup (EXP-7), the tap blob on the stored
// run (STO-3) and cancellation (EXP-2), with a fake command agent.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { Adapter, RunSpec, Session } from "../../src/core/types.ts";
import { sh } from "../../src/runner/exec.ts";
import { compareToolArms, summarizeArms } from "../../src/toolevals/compare.ts";
import { runToolExperiment, runTrial, type ToolJob } from "../../src/toolevals/experiment.ts";
import { formatArms } from "../../src/toolevals/report.ts";
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

// DF-1 / DF-2: a broken setup or a dead login is infrastructure (outcome unknown), never a task fail.
describe("runToolExperiment: infrastructure errors", () => {
  const retry = (stopAfter: number) => ({ retries: 3, baseMs: 0, maxMs: 0, stopAfter });
  const run = (tasks: ReturnType<typeof task>[], agent: Adapter, over: Partial<Parameters<typeof runToolExperiment>[0]> = {}) =>
    runToolExperiment({ tasks, target: cliTarget(), variants: [{ name: "base" }], drivers: [{ kind: "agent", agent: "claude-code" }], k: 1, concurrency: 1, root: tmp(), index: new MemIndex(), blobs: new MemBlobs(), adapterFor: () => agent, ...over });

  it("a setup command that exits 1 is retried once, then the trial is infra-unknown and left out of the pass rate", async () => {
    const log = join(tmp(), "setup.log");
    const broken = task({ id: "t2", setup: { commands: [`echo ran >> "${log}"; exit 1`], files: {}, env: {} } });
    const r = await run([task(), broken], shellAgent("echo hello bob"), { retry: retry(0) });
    assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 2, "one retry, not --retries 3");
    const t2 = r.trials.find((t) => t.taskId === "t2")!;
    assert.deepEqual([t2.infra, t2.attempts, t2.pass], ["setup", 2, false]);
    assert.match(t2.error ?? "", /setup .* exited 1/);
    const [arm] = summarizeArms(r.trials);
    assert.deepEqual([arm!.passes, arm!.trials, arm!.infra, arm!.errors], [1, 1, 1, 0], "1 of 1 known trials passed; the setup failure is no fail");
    assert.equal(arm!.passRate.p, 1);
    const text = formatArms([arm!]);
    assert.match(text, /\+1 infra/);
    assert.match(text, /infra: 1 trial\(s\) failed on infrastructure/);
  });

  it("a logged-out agent is never retried, stops the run after N trials in a row, and a comparison over it is void", async () => {
    const pids = join(tmp(), "pids");
    const loggedOut = shellAgent(`echo $$ >> "${pids}"; echo 'Invalid API key · Please run /login' >&2; exit 1`);
    const tasks = ["t1", "t2", "t3", "t4"].map((id) => task({ id }));
    const r = await run(tasks, loggedOut, { retry: retry(2) });
    assert.deepEqual(r.infraStop, { after: 2, kinds: { auth: 2 } });
    assert.equal(r.trials.length, 2, "no trial starts after the stop");
    assert.equal(readFileSync(pids, "utf8").trim().split("\n").length, 2, "never retried");
    assert.ok(r.trials.every((t) => t.infra === "auth" && t.attempts === undefined));
    const meta = JSON.parse(readFileSync(join(r.dir, "experiment.json"), "utf8")) as { infraStop: unknown };
    assert.deepEqual(meta.infraStop, r.infraStop);

    const both = await run(tasks.slice(0, 2), loggedOut, { retry: retry(0), variants: [{ name: "base" }, { name: "terse" }] });
    const cmp = compareToolArms(both.trials, { baseline: "base@agent:claude-code", candidate: "terse@agent:claude-code", iters: 200 });
    assert.equal(cmp.pairedTasks, 0);
    assert.equal(cmp.verdict.kind, "inconclusive");
    assert.match(cmp.verdict.text, /^void: 4 trials failed on infrastructure \(login 4\)/);
    assert.ok(cmp.notes.some((n) => /^4 trial\(s\) failed on infrastructure \(login 4\) after their retries: outcome unknown, left out of the pass rates/.test(n)));
    assert.deepEqual([cmp.baseline.trials, cmp.baseline.infra], [0, 2]);
  });

  it("an agent that could not start (exit 127) or exited non-zero before its first turn is an error, not a plain fail", async () => {
    const index = new MemIndex();
    // What the agent's process did, by task: its exit code, what it printed on stderr, and the turns its captured session shows.
    const plan: Record<string, { exitCode: number; stderr: string; turns?: number }> = {
      missing: { exitCode: 127, stderr: "spawn claude ENOENT" },
      crashed: { exitCode: 139, stderr: "Segmentation fault" },
      worked: { exitCode: 1, stderr: "Reached max turns", turns: 2 },
      wrong: { exitCode: 0, stderr: "" },
    };
    const agent: Adapter = {
      ...fakeAdapter(),
      run: async (spec: RunSpec) => {
        const p = plan[spec.instruction.split(" ")[0]!]!;
        if (p.turns) await index.upsertSession({ id: `s_${spec.runId}`, agent: "claude-code", runId: spec.runId, startedAt: 1, stats: { events: 0, turns: p.turns, toolCalls: 0, toolErrors: 0 } } as Session);
        return { exitCode: p.exitCode, timedOut: false, durationMs: 1, stdoutTail: "nope", stderrTail: p.stderr };
      },
    };
    const tasks = Object.keys(plan).map((id) => task({ id, instruction: `${id} greets bob` }));
    const r = await run(tasks, agent, { index, retry: retry(0) });
    const by = (id: string) => r.trials.find((t) => t.taskId === id)!;
    assert.deepEqual(
      Object.keys(plan).map((id) => [id, by(id).pass, by(id).error, by(id).infra]),
      [
        ["missing", false, "agent never ran, exit 127: spawn claude ENOENT", undefined],
        ["crashed", false, "agent never ran, exit 139: Segmentation fault", undefined],
        // The agent took turns and then exited 1, or exited 0 with the wrong answer: both are its own failure.
        ["worked", false, undefined, undefined],
        ["wrong", false, undefined, undefined],
      ],
    );
    const stored = await index.listRuns({ experimentId: r.experimentId });
    assert.equal(stored.find((x) => x.taskId === "missing")?.error, "agent never ran, exit 127: spawn claude ENOENT");
  });
});

describe("runToolExperiment cancellation", () => {
  it("an abort kills the running agent, starts no new trial and keeps cut-short trials out of trials.jsonl", async () => {
    const root = tmp();
    const pidFile = join(tmp(), "pids");
    const index = new MemIndex();
    const ac = new AbortController();
    // Abort once the agent is running.
    let abortedAt = 0;
    const started = setInterval(() => {
      if (!existsSync(pidFile)) return;
      clearInterval(started);
      abortedAt = Date.now();
      ac.abort();
    }, 20);
    // The agent records its pid with node (a real pid on Windows too, unlike an MSYS shell's $$), then sleeps.
    const agent = `'${process.execPath}' -e "require('fs').appendFileSync(process.argv[1], process.pid + '\\n'); setTimeout(() => {}, 30000)" '${pidFile}'`;
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
      adapterFor: () => shellAgent(agent),
      signal: ac.signal,
    }).finally(() => clearInterval(started));
    assert.ok(Date.now() - abortedAt < 4000, `stopped ${Date.now() - abortedAt}ms after the abort`);
    assert.equal(r.cancelled, true);
    assert.deepEqual(r.trials, []);
    assert.deepEqual(readdirSync(r.dir).sort(), ["experiment.json"], "no trial dir, no trials.jsonl");
    const pids = readFileSync(pidFile, "utf8").trim().split("\n").map(Number);
    assert.equal(pids.length, 1, "no trial started after the abort");
    // The agent is a grandchild (/bin/sh forks it): once killed it stays a
    // zombie, still answering signal 0, until init reaps it, which can lag on
    // a loaded machine. A surviving agent would sleep for 30 s.
    const until = Date.now() + 3000;
    let alive = true;
    while (alive && Date.now() < until) {
      try {
        process.kill(pids[0]!, 0);
        await new Promise((res) => setTimeout(res, 20));
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, "agent killed");
    const runs = await index.listRuns({ experimentId: r.experimentId });
    assert.ok(runs.length === 1 && runs[0]!.cancelled === true);
  });
});

/** An agent that follows a plan per task (named in its instruction), one letter per trial: P replies "hello bob", F does not. */
function plannedAgent(plan: Record<string, string>): Adapter {
  const calls = new Map<string, number>();
  return {
    ...fakeAdapter(),
    run: async (spec: RunSpec) => {
      const id = spec.instruction.split(" ")[0]!;
      const n = calls.get(id) ?? 0;
      calls.set(id, n + 1);
      return { exitCode: 0, timedOut: false, durationMs: 1, stdoutTail: plan[id]![n] === "P" ? "hello bob" : "nope", stderrTail: "" };
    },
  };
}

const planned = (ids: string[]) => ids.map((id) => task({ id, instruction: `${id} greets bob` }));
const runPlanned = (plan: Record<string, string>, over: Partial<Parameters<typeof runToolExperiment>[0]> = {}) => {
  const agent = plannedAgent(plan);
  return runToolExperiment({
    tasks: planned(Object.keys(plan)),
    target: cliTarget(),
    variants: [{ name: "base" }],
    drivers: [{ kind: "agent", agent: "claude-code" }],
    k: 1,
    concurrency: 1,
    root: tmp(),
    index: new MemIndex(),
    blobs: new MemBlobs(),
    adapterFor: () => agent,
    ...over,
  });
};

describe("runToolExperiment: adaptive samples and the regression stop (TB-3)", () => {
  it("adaptive: 2 trials per task, a 3rd only where they disagree", async () => {
    const r = await runPlanned({ t1: "PP", t2: "PFP", t3: "FPF" }, { samples: "adaptive", k: 5 });
    const count = (id: string) => r.trials.filter((t) => t.taskId === id).length;
    assert.deepEqual(["t1", "t2", "t3"].map(count), [2, 3, 3]);
    assert.deepEqual(
      r.trials.filter((t) => t.attempt === 3).map((t) => t.taskId),
      ["t2", "t3"],
    );
    const meta = JSON.parse(readFileSync(join(r.dir, "experiment.json"), "utf8")) as { k: number; samples: string };
    assert.equal(meta.k, 2);
    assert.equal(meta.samples, "adaptive");
    const [arm] = summarizeArms(r.trials, { adaptive: true });
    assert.deepEqual(arm?.verdicts, { passed: 2, failed: 1, tieBreaks: 2 });
    const text = formatArms(summarizeArms(r.trials, { adaptive: true }));
    assert.match(text, /tasks passed/);
    assert.match(text, /base@agent:claude-code +2\/3 +8 +2 +0/);
    assert.match(text, /adaptive, no CI/);
    assert.doesNotMatch(text, /95% CI/);
  });

  it("stops at the first task that passed every baseline trial and fails here", async () => {
    const base = await runPlanned({ t1: "PP", t2: "PP", t3: "PP" }, { k: 2 });
    const r = await runPlanned({ t1: "P", t2: "F", t3: "F" }, { stopOnRegression: base.trials });
    assert.deepEqual(r.regression, { taskId: "t2", arm: "base@agent:claude-code" });
    assert.deepEqual(
      r.trials.map((t) => t.taskId),
      ["t1", "t2"],
      "t3 never started",
    );
    const meta = JSON.parse(readFileSync(join(r.dir, "experiment.json"), "utf8")) as { regression: unknown };
    assert.deepEqual(meta.regression, r.regression);
  });

  it("no regression when the task failed in the baseline; another arm falls back to the task's trials", async () => {
    const base = await runPlanned({ t1: "P", t2: "F" });
    const same = await runPlanned({ t1: "P", t2: "F" }, { stopOnRegression: base.trials });
    assert.equal(same.regression, undefined);
    assert.equal(same.trials.length, 2);
    const other = await runPlanned({ t1: "F", t2: "F" }, { stopOnRegression: base.trials, variants: [{ name: "terse" }] });
    assert.deepEqual(other.regression, { taskId: "t1", arm: "terse@agent:claude-code" });
  });
});
