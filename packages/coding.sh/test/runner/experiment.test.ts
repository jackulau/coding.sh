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
    const { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { wrapperAdapter } = await import("../../src/adapters/more/wrapper.ts");
    const w = await toyWorld();
    const dir = mkdtempSync(join(tmpdir(), "csh-cancel-"));
    const pidFile = join(dir, "pids");
    const pidsSoFar = () => (existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim().split("\n").map(Number) : []);
    // Abort once both running agents have started.
    const ac = new AbortController();
    let abortedAt = 0;
    const started = setInterval(() => {
      if (pidsSoFar().length < 2) return;
      clearInterval(started);
      abortedAt = Date.now();
      ac.abort();
    }, 20);
    try {
      // Records its pid (a real one on Windows too, unlike an MSYS shell's $$), then sleeps.
      const agent = [process.execPath, "-e", `require("node:fs").appendFileSync(${JSON.stringify(pidFile)}, process.pid + "\\n"); setTimeout(() => {}, 30000)`];
      const A = await w.mkBundle("A", "fix", { agent: "wrapper", flags: agent });
      const B = await w.mkBundle("B", "fix", { agent: "wrapper", flags: agent, env: { ARM: "b" } });
      const r = await runExperiment({ tasks: [w.task], bundles: [A, B], k: 2, adapterFor: () => wrapperAdapter, blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir, concurrency: 2, timeoutMs: 60_000, signal: ac.signal });
      assert.ok(abortedAt > 0 && Date.now() - abortedAt < 4500, `resolved ${Date.now() - abortedAt}ms after the abort`);
      assert.equal(r.cancelled, true);
      assert.equal(r.results.length, 2, "the 2 queued jobs never started");
      assert.ok(r.results.every((x) => x.cancelled === true && !x.pass && x.error === "cancelled"));
      assert.deepEqual(readdirSync(w.runsDir), [], "work dirs removed");
      const stored = await w.index.listRuns({ experimentId: r.experimentId });
      assert.ok(stored.length === 2 && stored.every((x) => x.cancelled));
      const pids = pidsSoFar();
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
      clearInterval(started);
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
    const src = (p: string) => JSON.stringify(new URL(p, import.meta.url).href);
    // The agent records its pid (a real one on Windows too, unlike an MSYS shell's $$), then sleeps.
    const agent = [process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 30000)`];
    // runTask with no signal (a caller that never threads one), then a hard exit
    // (second Ctrl-C) while the agent runs: its finally never executes.
    const code = `
      import { toyWorld } from ${src("../helpers-eval.ts")};
      import { runTask } from ${src("../../src/runner/run.ts")};
      import { wrapperAdapter } from ${src("../../src/adapters/more/wrapper.ts")};
      import { existsSync } from "node:fs";
      const w = await toyWorld();
      const bundle = await w.mkBundle("A", "fix", { agent: "wrapper", flags: ${JSON.stringify(agent)} });
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

// Z-19: a cost delta over different subsets of runs is not a verdict.
describe("compare cost coverage", () => {
  const agent = (costUsd?: number, tokens?: number) => ({
    exitCode: 0,
    timedOut: false,
    durationMs: 1000,
    stdoutTail: "",
    stderrTail: "",
    ...(costUsd !== undefined || tokens !== undefined ? { usage: { ...(costUsd !== undefined ? { costUsd } : {}), ...(tokens !== undefined ? { inputTokens: tokens } : {}) } } : {}),
  });
  /** 10 tasks; baseline always costs $1; candidate costs $0.10 on its first `priced` runs. */
  const arms = (priced: number) => {
    const out: RunResult[] = [];
    for (let i = 0; i < 10; i++) {
      out.push(run(`t${i}`, "A", 1, true, { agent: agent(1) }));
      out.push(run(`t${i}`, "B", 1, true, { agent: agent(i < priced ? 0.1 : undefined) }));
    }
    return out;
  };

  it("one arm priced on 2 of 10 runs: no 'cheaper' claim, a coverage note and a (2/10) mark", () => {
    const r = compare(arms(2), { baseline: "A", candidate: "B" });
    const cost = r.metrics.find((m) => m.key === "cost");
    assert.deepEqual([cost?.n, cost?.runs], [{ baseline: 10, candidate: 2 }, { baseline: 10, candidate: 10 }]);
    assert.ok(!r.notes.some((n) => /cheaper|more expensive/.test(n)));
    assert.ok(r.notes.includes("cost is known for 10/10 baseline and 2/10 candidate runs; the cost delta compares different subsets of runs and is not a verdict"));
    const line = formatCompare(r).split("\n").find((l) => l.startsWith("cost / run")) ?? "";
    assert.match(line, /^cost \/ run +\$1\.00 +\$0\.100 \(2\/10\) +-\$0\.900/);
    assert.doesNotMatch(formatCompare(r, { color: true }).split("\n").find((l) => l.includes("cost / run")) ?? "", /\x1b\[3[12]m/, "delta uncoloured under the threshold");
  });

  it("one arm never priced: NaN, no claim, still a coverage note", () => {
    const r = compare(arms(0), { baseline: "A", candidate: "B" });
    const cost = r.metrics.find((m) => m.key === "cost");
    assert.ok(Number.isNaN(cost?.candidate));
    assert.ok(!r.notes.some((n) => /cheaper/.test(n)));
    assert.ok(r.notes.some((n) => n.startsWith("cost is known for 10/10 baseline and 0/10 candidate runs")));
    assert.match(formatCompare(r), /^cost \/ run +\$1\.00 +— /m);
  });

  it("exactly 8 of 10 priced is enough for the claim", () => {
    const r = compare(arms(8), { baseline: "A", candidate: "B" });
    assert.ok(r.notes.some((n) => /candidate is 90% cheaper per run/.test(n)));
    assert.ok(!r.notes.some((n) => n.startsWith("cost is known")));
    assert.match(formatCompare(r), /\(8\/10\)/);
  });

  it("full coverage: no marks", () => {
    const r = compare(arms(10), { baseline: "A", candidate: "B" });
    assert.ok(r.notes.some((n) => /90% cheaper/.test(n)));
    assert.doesNotMatch(formatCompare(r), /\(\d+\/\d+\)/);
    assert.deepEqual(r.metrics.find((m) => m.key === "cost")?.costEstimatedRuns, { baseline: 0, candidate: 0 });
  });

  it("price-table costs from sessions count as known and are counted as estimated", () => {
    const results = arms(10).map((r, i) => (r.bundleId === "B" && i % 4 === 1 ? { ...r, agent: agent(undefined) } : r));
    const priced = (costUsd: number): Session => ({ id: "s", agent: "x", startedAt: 0, stats: { events: 0, turns: 1, toolCalls: 0, toolErrors: 0, filesChanged: 0, usage: { costUsd } }, flags: [] });
    const sessions = new Map(results.filter((r) => r.bundleId === "B" && r.agent.usage === undefined).map((r) => [r.id, priced(0.1)]));
    const r = compare(results, { baseline: "A", candidate: "B", sessions });
    const cost = r.metrics.find((m) => m.key === "cost");
    assert.deepEqual(cost?.n, { baseline: 10, candidate: 10 });
    assert.deepEqual(cost?.costEstimatedRuns, { baseline: 0, candidate: sessions.size });
    assert.ok(sessions.size > 0);
    assert.match(formatCompare(r), new RegExp(`cost: ${sessions.size} of 20 runs estimated from the price table`));
  });

  it("partial token coverage is marked too", () => {
    const results: RunResult[] = [];
    for (let i = 0; i < 4; i++) {
      results.push(run(`t${i}`, "A", 1, true, { agent: agent(1, 100) }));
      results.push(run(`t${i}`, "B", 1, true, { agent: agent(1, i === 0 ? 50 : undefined) }));
    }
    const text = formatCompare(compare(results, { baseline: "A", candidate: "B" }));
    assert.match(text, /^tokens \/ run +100 +50 \(1\/4\)/m);
  });
});

// Z-10: why each arm's runs failed (arXiv 2611.08285).
describe("compare failure anatomy", () => {
  const fixture = (outcomes: Record<string, [string, string]>) =>
    Object.entries(outcomes).flatMap(([t, [a, b]]) => [...[...a].map((c, i) => run(t, "A", i + 1, c === "1")), ...[...b].map((c, i) => run(t, "B", i + 1, c === "1"))]);

  it("k=3: per-arm split, variance shares, notes and rows", () => {
    const results = fixture({ t1: ["100", "111"], t2: ["000", "011"], t3: ["000", "000"], t4: ["111", "111"] });
    const r = compare(results, { baseline: "A", candidate: "B", iters: 500 });
    const a = r.anatomy;
    assert.ok(a);
    assert.deepEqual([a.baseline.fails, a.baseline.badRun, a.baseline.beyondArm, a.baseline.unsolvedByAll], [8, 2, 3, 3]);
    assert.deepEqual([a.candidate.fails, a.candidate.badRun, a.candidate.beyondArm, a.candidate.unsolvedByAll], [4, 1, 0, 3]);
    assert.ok(Math.abs(a.variance.task + a.variance.arm + a.variance.run - 1) < 1e-12);
    assert.equal(a.variance.n, 24);
    assert.ok(r.notes.includes("1 task failed every attempt in both arms (50% of failed runs): check them with coding.sh eval validate / eval curate"));
    assert.ok(!r.notes.some((n) => /bad runs/.test(n)), "B's failures are mostly not bad runs");
    const text = formatCompare(r);
    assert.match(text, /^failures {10}A 8 \(bad-run 2 · beyond-arm 3 · unsolved-by-all 3\)$/m);
    assert.match(text, /^ {18}B 4 \(bad-run 1 · beyond-arm 0 · unsolved-by-all 3\)$/m);
    assert.match(text, /^variance {10}task \d+% · arm \d+% · run-to-run \d+%$/m);
    assert.deepEqual(compare(results, { baseline: "A", candidate: "B", iters: 500 }), r, "deterministic");
  });

  it("notes when most of B's failures are bad runs, and when run noise beats the arm effect", () => {
    const r = compare(fixture({ t1: ["111", "100"], t2: ["111", "110"], t3: ["111", "111"] }), { baseline: "A", candidate: "B", iters: 200 });
    assert.equal(r.anatomy?.candidate.badRun, 3);
    assert.ok(r.notes.some((n) => n.startsWith("most of B's failures are bad runs (3 of 3")));
    assert.ok(r.notes.some((n) => /^run-to-run noise \(\d+%\) outweighs the harness effect \(\d+%\)$/.test(n)));
  });

  it("k=1: no anatomy, a note to rerun with -k 3", () => {
    const r = compare(fixture({ t1: ["1", "0"], t2: ["0", "0"] }), { baseline: "A", candidate: "B" });
    assert.equal(r.anatomy, undefined);
    assert.ok(r.notes.includes("k=1: bad runs and beyond-ability failures look the same; rerun with --k 3 (arXiv 2611.08285)"));
    assert.doesNotMatch(formatCompare(r), /^failures/m);
  });

  it("no variance prints as such", () => {
    const r = compare(fixture({ t1: ["11", "11"] }), { baseline: "A", candidate: "B" });
    assert.match(formatCompare(r), /^variance {10}no variance/m);
  });
});

// Z-9: `compare A --without <path>` reports the effect of the path.
describe("compare ablation report", () => {
  it("flips the sign of the diff into an effect line and names what B dropped", () => {
    const results: RunResult[] = [];
    for (let i = 0; i < 6; i++) results.push(run(`t${i}`, "A", 1, true), run(`t${i}`, "B", 1, i < 2));
    const bundle = (id: string, name: string) => ({ id, name, agent: "x", flags: [], env: {}, files: {}, remove: [], createdAt: 0 });
    const r = compare(results, {
      baseline: "A",
      candidate: "B",
      iters: 500,
      bundles: { baseline: bundle("A", "base"), candidate: bundle("B", "base-without-claude-skills-pdf") },
      ablation: { paths: [".claude/skills/pdf"], dropped: [".claude/skills/pdf/SKILL.md", ".claude/skills/pdf/forms.md"], unmatched: [] },
    });
    assert.ok(r.ablation);
    assert.ok(Math.abs(r.ablation.effect.mean - -r.diff.mean) < 1e-12);
    assert.deepEqual([r.ablation.effect.lo, r.ablation.effect.hi], [-r.diff.hi, -r.diff.lo]);
    const text = formatCompare(r);
    assert.match(text, /^A = base · B = base without \.claude\/skills\/pdf \(2 files dropped\)$/m);
    assert.match(text, /^effect of \.claude\/skills\/pdf = A − B: \+66\.7 pp \[/m);
    assert.equal(compare(results, { baseline: "A", candidate: "B" }).ablation, undefined);
  });
});
