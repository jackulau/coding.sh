import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { AgentEvent, EvalTask, RunResult, Session } from "../../src/core/types.ts";
import { compare, formatCompare, formatDuration, pool, runExperiment, scheduleJobs } from "../../src/runner/experiment.ts";
import { cleanupWorlds, obedientAgent, toyWorld } from "../helpers-eval.ts";

after(cleanupWorlds);

function run(taskId: string, bundleId: string, attempt: number, pass: boolean, extra: Partial<RunResult> = {}): RunResult {
  return {
    id: `${bundleId}-${taskId}-${attempt}`,
    taskId,
    bundleId,
    attempt,
    pass,
    verifierExit: pass ? 0 : 1,
    agent: { exitCode: 0, timedOut: false, durationMs: 1000, stdoutTail: "", stderrTail: "" },
    startedAt: 0,
    endedAt: 2000,
    ...extra,
  };
}

describe("scheduling", () => {
  it("interleaves arms per task: A1 B1 A2 B2", () => {
    const t = (id: string) => ({ id }) as EvalTask;
    const b = (id: string) => ({ id }) as never;
    const jobs = scheduleJobs([t("t1"), t("t2")], [b("A"), b("B")], 2);
    assert.deepEqual(
      jobs.map((j) => `${j.task.id}:${(j.bundle as { id: string }).id}${j.attempt}`),
      ["t1:A1", "t1:B1", "t1:A2", "t1:B2", "t2:A1", "t2:B1", "t2:A2", "t2:B2"],
    );
  });
  it("pool bounds concurrency and keeps order", async () => {
    let live = 0;
    let peak = 0;
    const out = await pool([5, 1, 4, 2, 3], 2, async (x) => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, x * 3));
      live--;
      return x * 10;
    });
    assert.deepEqual(out, [50, 10, 40, 20, 30]);
    assert.equal(peak, 2);
    assert.deepEqual(await pool([], 4, async (x) => x), []);
  });
});

describe("compare", () => {
  it("clear win: paired stats, Wilson CIs, exact McNemar", () => {
    const results: RunResult[] = [];
    for (let i = 0; i < 10; i++) {
      results.push(run(`t${i}`, "A", 1, i < 2, { agent: { exitCode: 0, timedOut: false, durationMs: 1000, stdoutTail: "", stderrTail: "", usage: { costUsd: 1 } } }));
      results.push(run(`t${i}`, "B", 1, i < 9, { agent: { exitCode: 0, timedOut: false, durationMs: 500, stdoutTail: "", stderrTail: "", usage: { costUsd: 0.5 } } }));
    }
    const r = compare(results, { baseline: "A", candidate: "B", iters: 2000 });
    assert.equal(r.pairedTasks, 10);
    assert.deepEqual([r.mcnemar.b, r.mcnemar.c], [0, 7]);
    assert.ok(Math.abs(r.mcnemar.p - 2 / 128) < 1e-12);
    assert.ok(Math.abs(r.diff.mean - 0.7) < 1e-12);
    assert.ok(r.diff.lo > 0);
    assert.equal(r.verdict.kind, "better");
    assert.match(r.verdict.text, /^candidate better: \+70\.0 pp/);
    assert.ok(Math.abs(r.baseline.passRate.lo - 0.0567) < 1e-3, String(r.baseline.passRate.lo));
    const cost = r.metrics.find((m) => m.key === "cost");
    assert.deepEqual([cost?.baseline, cost?.candidate, cost?.relative], [1, 0.5, -0.5]);
    assert.ok(r.notes.some((n) => /50% cheaper/.test(n)));
  });

  it("identical arms → no significant difference, flagged as underpowered", () => {
    const results = [run("t1", "A", 1, true), run("t1", "B", 1, true), run("t2", "A", 1, false), run("t2", "B", 1, false)];
    const r = compare(results, { baseline: "A", candidate: "B" });
    assert.equal(r.verdict.kind, "no-difference");
    assert.match(r.verdict.text, /underpowered/);
    assert.equal(r.mcnemar.p, 1);
  });

  it("bootstrap and McNemar disagree → inconclusive, not a claimed win", () => {
    const results: RunResult[] = [];
    for (const t of ["t1", "t2"]) for (let a = 1; a <= 2; a++) results.push(run(t, "A", a, false), run(t, "B", a, true));
    const r = compare(results, { baseline: "A", candidate: "B" });
    assert.equal(r.k, 2);
    // One discordant pair per task, not per attempt: b=0, c=2 → p = 0.5.
    assert.deepEqual([r.mcnemar.b, r.mcnemar.c], [0, 2]);
    assert.ok(Math.abs(r.mcnemar.p - 0.5) < 1e-12);
    assert.equal(r.verdict.kind, "inconclusive");
    assert.ok(r.notes.some((n) => /optimistic/.test(n)));
  });

  it("McNemar treats a task's attempts as one cluster (majority outcome)", () => {
    const results: RunResult[] = [];
    // 3 tasks x 5 attempts, every attempt flips fail → pass. Attempt-aligned
    // pairs would give c=15 (p ≈ 6e-5); there are only 3 independent tasks.
    for (const t of ["t1", "t2", "t3"]) for (let a = 1; a <= 5; a++) results.push(run(t, "A", a, false), run(t, "B", a, true));
    // Majority decides: 2/3 → 1/3 is a regression, 1/2 → 1/2 (both ≥ 0.5) is no change.
    results.push(run("t4", "A", 1, true), run("t4", "A", 2, true), run("t4", "A", 3, false));
    results.push(run("t4", "B", 1, true), run("t4", "B", 2, false), run("t4", "B", 3, false));
    results.push(run("t5", "A", 1, true), run("t5", "A", 2, false), run("t5", "B", 1, false), run("t5", "B", 2, true));
    const r = compare(results, { baseline: "A", candidate: "B" });
    assert.equal(r.pairedTasks, 5);
    assert.deepEqual([r.mcnemar.b, r.mcnemar.c], [1, 3]);
    assert.ok(Math.abs(r.mcnemar.p - 0.625) < 1e-12);
    assert.notEqual(r.verdict.kind, "better");
  });

  it("unpaired tasks are excluded and noted; no pairs → inconclusive", () => {
    const r = compare([run("t1", "A", 1, true), run("t2", "B", 1, true)], { baseline: "A", candidate: "B" });
    assert.equal(r.pairedTasks, 0);
    assert.deepEqual(r.unpairedTasks, ["t1", "t2"]);
    assert.equal(r.verdict.kind, "inconclusive");
  });

  it("turns, tokens and latency come from captured sessions; divergence from events", () => {
    const ra = run("t1", "A", 1, true);
    const rb = run("t1", "B", 1, true);
    const sess = (turns: number, llmP50Ms: number, llmP95Ms: number): Session => ({
      id: "s",
      agent: "x",
      startedAt: 0,
      stats: { events: 0, turns, toolCalls: 0, toolErrors: 0, filesChanged: 0, usage: { inputTokens: 10, outputTokens: 5 }, latency: { llmMs: 900, llmP50Ms, llmP95Ms } },
      flags: [],
    });
    const tool = (id: string, tool: string, input: unknown): AgentEvent => ({ id, v: 0, sessionId: "s", ts: Number(id.slice(1)), agent: "x", kind: "tool.start", payload: { tool, input } });
    const r = compare([ra, rb], {
      baseline: "A",
      candidate: "B",
      sessions: new Map([
        [ra.id, sess(10, 400, 1200)],
        [rb.id, sess(6, 300, 800)],
      ]),
      events: new Map([
        [ra.id, [tool("e1", "Read", { file_path: "a" }), tool("e2", "Bash", { command: "npm test" })]],
        [rb.id, [tool("e1", "Read", { file_path: "a" }), tool("e2", "Edit", { file_path: "a" })]],
      ]),
    });
    const m = Object.fromEntries(r.metrics.map((x) => [x.key, x]));
    assert.equal(m.turns?.delta, -4);
    assert.equal(m.tokens?.baseline, 15);
    assert.equal(m.llmP50?.delta, -100);
    assert.equal(m.llmP95?.candidate, 800);
    assert.equal(m.wall?.baseline, 2000);
    assert.equal(r.tasks[0]?.divergence?.index, 1);
    const text = formatCompare(r);
    assert.match(text, /LLM call p95 +1\.2s +800ms +-400ms \(-33%\)/);
    assert.match(text, /step 2: Bash vs Edit/);
  });
});

describe("formatCompare", () => {
  const results = [run("t1", "A", 1, false), run("t1", "B", 1, true)];
  it("plain text by default, ANSI only on request", () => {
    const r = compare(results, { baseline: "A", candidate: "B" });
    const plain = formatCompare(r);
    assert.doesNotMatch(plain, /\x1b\[/);
    assert.match(plain, /pass rate +0\.0% \[0\.0–79\.3%\] +100\.0% \[20\.7–100\.0%\]/);
    assert.match(plain, /verdict: /);
    assert.match(formatCompare(r, { color: true }), /\x1b\[32m/);
  });
  it("long task ids never run into the baseline column (QA: `task_f76993c356…3/3`)", () => {
    const id = "task_f76993c356a1b2c3d4";
    const rs: RunResult[] = [];
    for (let a = 1; a <= 3; a++) rs.push(run(id, "A", a, a === 1), run(id, "B", a, true));
    const text = formatCompare(compare(rs, { baseline: "A", candidate: "B" }));
    const line = text.split("\n").find((l) => l.includes("task_f7"));
    assert.ok(line, text);
    assert.match(line, /…\s+1\/3\s+3\/3/, line);
    // The truncated id still fits its column, so the baseline cell stays aligned with the header.
    const header = text.split("\n").find((l) => /^task\s+baseline/.test(l)) ?? "";
    assert.equal(line.indexOf("1/3"), header.indexOf("baseline"), `${header}\n${line}`);
  });
  it("prints the same power / MDE line and warnings as exp compare", () => {
    const rs: RunResult[] = [];
    for (let i = 0; i < 6; i++) rs.push(run(`t${i}`, "A", 1, i < 2), run(`t${i}`, "B", 1, i < 4));
    const r = compare(rs, { baseline: "A", candidate: "B" });
    assert.equal(r.power.n, 6);
    assert.ok(Number.isFinite(r.power.mde) && r.power.mde > 0);
    const text = formatCompare(r);
    assert.match(text, /^power {3}MDE \d+\.\dpp \(α 0\.05, power 80%, paired, sd of per-case Δ \d\.\d\d\)$/m, text);
    assert.match(text, /^! only 6 paired cases \(< 200\)/m, text);
    assert.match(text, /^! observed \|B − A\| 33\.3pp is below the minimum detectable effect/m, text);
  });
  it("power line degrades to — with too few tasks", () => {
    const r = compare(results, { baseline: "A", candidate: "B" });
    assert.ok(Number.isNaN(r.power.mde));
    const text = formatCompare(r);
    assert.match(text, /^power {3}MDE — /m);
    assert.match(text, /^! only 1 paired case\(s\): too few/m);
  });
  it("formatDuration", () => {
    assert.deepEqual([formatDuration(850), formatDuration(12_340), formatDuration(192_000), formatDuration(NaN)], ["850ms", "12.3s", "3m12s", "—"]);
  });
});

describe("runExperiment (end to end with a fake agent)", () => {
  it("runs every (task, arm, attempt), stores runs, and compares", async () => {
    const w = await toyWorld();
    const A = await w.mkBundle("lazy", "half effort");
    const B = await w.mkBundle("diligent", "always fix bugs");
    const tasks = [w.task, { ...w.task, id: "t2" }];
    const seen: string[] = [];
    const { experimentId, results } = await runExperiment({
      tasks,
      bundles: [A, B],
      adapterFor: () => obedientAgent(),
      blobs: w.blobs,
      index: w.index,
      git: w.git,
      runsDir: w.runsDir,
      k: 2,
      concurrency: 3,
      onProgress: (p) => seen.push(`${p.done}/${p.total}`),
    });
    assert.equal(results.length, 8);
    assert.equal(seen.at(-1), "8/8");
    assert.ok(results.every((r) => r.experimentId === experimentId && !r.error));
    assert.equal((await w.index.listRuns({ experimentId })).length, 8);
    const r = compare(results, { baseline: A.id, candidate: B.id, bundles: { baseline: A, candidate: B } });
    assert.equal(r.baseline.passes, 0);
    assert.equal(r.candidate.passes, 4);
    assert.equal(r.verdict.kind, "inconclusive", "4 discordant pairs is not enough for McNemar at 0.05");
    const text = formatCompare(r);
    assert.match(text, /lazy \(/);
    assert.match(text, /~ CLAUDE\.md/);
  });
});

// EXP-8: errored runs that still passed the verifier count as passes, and the note says so.
describe("compare notes", () => {
  it("says errored runs that passed the verifier count as passes", () => {
    const r = compare([run("t1", "A", 1, false), run("t1", "B", 1, true, { error: "agent timed out" }), run("t2", "B", 1, false, { error: "setup failed" })], { baseline: "A", candidate: "B" });
    assert.equal(r.candidate.passes, 1);
    const note = r.notes.find((n) => n.includes("recorded an error")) ?? "";
    assert.match(note, /2 run\(s\) recorded an error/);
    assert.match(note, /1 of them still passed the verifier and count as passes/);
    assert.doesNotMatch(note, /they count as failures/);
  });
  it("errored runs that all failed still read as failures", () => {
    const r = compare([run("t1", "A", 1, true), run("t1", "B", 1, false, { error: "agent timed out" })], { baseline: "A", candidate: "B" });
    assert.ok(r.notes.some((n) => /1 run\(s\) recorded an error \(setup, agent or verifier\); they count as failures/.test(n)));
  });
  it("cancelled runs are left out of the comparison", () => {
    const r = compare([run("t1", "A", 1, true), run("t1", "B", 1, true), run("t2", "A", 1, true), run("t2", "B", 1, false, { cancelled: true, error: "cancelled" })], { baseline: "A", candidate: "B" });
    assert.equal(r.candidate.runs, 1);
    assert.deepEqual(r.unpairedTasks, ["t2"]);
    assert.ok(r.notes.some((n) => /1 run\(s\) were cancelled/.test(n)));
  });
});

// EXP-2: an abort reaches the agent's process group through runExperiment → runTask → adapter.run → spawnAgent.
describe("runExperiment cancellation", () => {
  it("an abort kills running agents, cleans their work dirs, marks them cancelled and starts nothing new", async () => {
    const { mkdtempSync, readFileSync, readdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { wrapperAdapter } = await import("../../src/adapters/more/wrapper.ts");
    const w = await toyWorld();
    const dir = mkdtempSync(join(tmpdir(), "csh-cancel-"));
    const pidFile = join(dir, "pids");
    try {
      const agent = ["/bin/sh", "-c", `echo $$ >> ${pidFile}; sleep 30`];
      const A = await w.mkBundle("A", "fix", { agent: "wrapper", flags: agent });
      const B = await w.mkBundle("B", "fix", { agent: "wrapper", flags: agent, env: { ARM: "b" } });
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 1500);
      const t0 = Date.now();
      const r = await runExperiment({ tasks: [w.task], bundles: [A, B], k: 2, adapterFor: () => wrapperAdapter, blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir, concurrency: 2, timeoutMs: 60_000, signal: ac.signal });
      assert.ok(Date.now() - t0 < 6000, `resolved in ${Date.now() - t0}ms`);
      assert.equal(r.cancelled, true);
      assert.equal(r.results.length, 2, "the 2 queued jobs never started");
      assert.ok(r.results.every((x) => x.cancelled === true && !x.pass && x.error === "cancelled"));
      assert.deepEqual(readdirSync(w.runsDir), [], "work dirs removed");
      const stored = await w.index.listRuns({ experimentId: r.experimentId });
      assert.ok(stored.length === 2 && stored.every((x) => x.cancelled));
      const pids = readFileSync(pidFile, "utf8").trim().split("\n").map(Number);
      assert.equal(pids.length, 2);
      for (const pid of pids) {
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
        }
        if (alive) process.kill(pid, "SIGKILL");
        assert.equal(alive, false, `agent ${pid} killed`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("hard exit mid-run", () => {
  it("kills the agent and removes the work dir even though no abort reached the run", async () => {
    const { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } = await import("node:fs");
    const { spawn } = await import("node:child_process");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "csh-hardexit-"));
    const runsDir = join(dir, "runs");
    const pidFile = join(dir, "pid");
    const src = (p: string) => JSON.stringify(new URL(p, import.meta.url).pathname);
    // runTask with no signal (a caller that never threads one), then a hard exit
    // (second Ctrl-C) while the agent runs: its finally never executes.
    const code = `
      import { toyWorld } from ${src("../helpers-eval.ts")};
      import { runTask } from ${src("../../src/runner/run.ts")};
      import { wrapperAdapter } from ${src("../../src/adapters/more/wrapper.ts")};
      import { existsSync } from "node:fs";
      const w = await toyWorld();
      const bundle = await w.mkBundle("A", "fix", { agent: "wrapper", flags: ["/bin/sh", "-c", "echo $$ > ${pidFile}; sleep 30"] });
      runTask({ task: w.task, bundle, adapter: wrapperAdapter, blobs: w.blobs, index: w.index, git: w.git, runsDir: ${JSON.stringify(runsDir)}, timeoutMs: 60_000 });
      const t = setInterval(() => { if (existsSync(${JSON.stringify(pidFile)})) { clearInterval(t); setTimeout(() => process.exit(130), 100); } }, 20);
    `;
    try {
      const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      child.stderr.on("data", (d) => (err += d));
      assert.equal(await new Promise<number | null>((r) => child.on("close", r)), 130, err);
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      await new Promise((r) => setTimeout(r, 100));
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      if (alive) process.kill(pid, "SIGKILL");
      assert.equal(alive, false, "agent killed");
      assert.deepEqual(existsSync(runsDir) ? readdirSync(runsDir) : [], [], "work dir removed by the exit hook");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
