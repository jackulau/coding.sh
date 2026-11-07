import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { buildSession } from "../../src/core/sessions.ts";
import { decodeTraceJson } from "../../src/otel/json.ts";
import { mapTraces, TraceSessionMap } from "../../src/otel/map.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { loadCases } from "../../src/workflows/cases.ts";
import { claudeArgv, claudeWorkflowDriver, workflowPrompt } from "../../src/workflows/drivers/claude-workflow.ts";
import { commandDriver, mergeArgs, parseOutput } from "../../src/workflows/drivers/command.ts";
import { mulberry32 } from "../../src/stats/index.ts";
import { compareWorkflowVariants, runWorkflowExperiment, scheduleWorkflowJobs, selectDeployment } from "../../src/workflows/experiment.ts";
import { changeWindow, labelPattern, predictCacheHits, replayWorkflow, scanAgentCalls } from "../../src/workflows/replay.ts";
import { loadClaudeWorkflowDir } from "../../src/workflows/sources/claude-workflow.ts";
import { WorkflowStore } from "../../src/workflows/store.ts";
import { buildWorkflowTree, type WorkflowTree } from "../../src/workflows/tree.ts";
import type { ParetoPoint, WorkflowCase, WorkflowDriver, WorkflowRun, WorkflowVariant } from "../../src/workflows/types.ts";
import { nodeBin } from "../_bin.ts";
import { MemBlobs, MemIndex } from "../otel/_memstore.ts";
import { langGraph, RESUMED, RUN, SCRIPT, SID, writeClaudeWorkflowFixture, writeReviewCases } from "./_fixtures.ts";

let root = "";
let cases: WorkflowCase[] = [];
let base: WorkflowTree;
let resumedDir = "";

// A workflow entry point: `node fake-wf.mjs <mode> --args <json>`; "good" finds two bugs.
const FAKE_WF = `const mode = process.argv[2];
const args = JSON.parse(process.argv[process.argv.indexOf("--args") + 1]);
if (mode === "crash") { console.error("boom"); process.exit(3); }
const findings = mode === "good" ? [{ file: "src/a.ts", line: 11, summary: "off by one" }, { file: "src/b.ts", line: 40, summary: "race" }] : [];
console.log("log line");
console.log(JSON.stringify({ findings, runId: process.env.CODING_SH_WORKFLOW_RUN_ID, args }));
`;

before(async () => {
  root = mkdtempSync(join(tmpdir(), "csh-wf-exp-"));
  const dir = join(root, "evals", "workflows", "review", "cases");
  writeReviewCases(dir);
  cases = (await loadCases(dir, "review", new MemBlobs())).filter((c) => c.truth.kind === "seeded-bugs");
  writeFileSync(join(root, "fake-wf.mjs"), FAKE_WF);
  const dirs = writeClaudeWorkflowFixture(join(root, "claude", "projects"));
  resumedDir = dirs.resumed;
  base = buildWorkflowTree((await loadClaudeWorkflowDir(dirs.base)).sources);
});
after(() => rmSync(root, { recursive: true, force: true }));

const variant = (name: string, mode: string): WorkflowVariant => ({ name, command: [process.execPath, join(root, "fake-wf.mjs"), mode] });

describe("command driver", () => {
  it("runs `<cmd> --args <json>` with the run id in env and parses the last JSON line", async () => {
    const d = commandDriver({ cwd: root });
    const r = await d.run({ ...variant("good", "good"), args: { extra: 1 } }, cases[0]!, { CODING_SH_WORKFLOW_RUN_ID: "wfr_x", CODING_SH_RUN_ID: "wfr_x" });
    assert.equal(r.exitCode, 0);
    assert.equal(r.runId, "wfr_x");
    const out = r.output as { findings: unknown[]; runId: string; args: unknown };
    assert.equal(out.findings.length, 2);
    assert.equal(out.runId, "wfr_x");
    assert.deepEqual(out.args, { target: "src", seeded: "seeded-1", extra: 1 });
    const bad = await d.run(variant("crash", "crash"), cases[0]!, {});
    assert.equal(bad.exitCode, 3);
    assert.equal(bad.error, "boom");
    await assert.rejects(d.run({ name: "none" }, cases[0]!, {}), /no command or script/);
  });

  it("merges args and parses output forms", () => {
    assert.deepEqual(mergeArgs({ a: 1, b: 1 }, { b: 2 }), { a: 1, b: 2 });
    assert.deepEqual(mergeArgs("x", undefined), "x");
    assert.deepEqual(mergeArgs(undefined, undefined), {});
    assert.deepEqual(parseOutput('{"a":1}'), { a: 1 });
    assert.deepEqual(parseOutput('noise\n{"a":2}\nmore noise'), { a: 2 });
    assert.equal(parseOutput("plain"), "plain");
    assert.equal(parseOutput("  "), null);
  });
});

describe("claude-code-workflow driver", () => {
  it("builds the -p prompt and argv", () => {
    const argv = claudeArgv({ name: "v", script: "wf/review.js", resumeFromRunId: "wf_1" }, cases[0]!, { cwd: "/repo", settings: "/tmp/s.json" });
    assert.deepEqual(argv.slice(0, 5), ["-p", "--output-format", "json", "--settings", "/tmp/s.json"]);
    // The script path is native (C:\repo\wf\review.js on Windows).
    assert.ok(argv[5]!.startsWith(`Run the workflow script at ${resolve("/repo", "wf/review.js")} with args {"target":"src","seeded":"seeded-1"}. Resume from run wf_1`), argv[5]);
    assert.equal(workflowPrompt("/s.js", {}), "Run the workflow script at /s.js with args {}. Return its result as JSON and nothing else.");
    assert.throws(() => claudeArgv({ name: "v" }, cases[0]!), /has no script/);
  });

  it("runs a (fake) claude binary and finds the run dir by the printed session id", async () => {
    const argvLog = join(root, "claude-argv.json");
    const bin = nodeBin(
      root,
      "fake-claude",
      `import { utimesSync, writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));
const t = new Date(Date.now() + 60_000);
utimesSync(${JSON.stringify(join(resumedDir, "journal.jsonl"))}, t, t);
console.log(JSON.stringify({ type: "result", session_id: ${JSON.stringify(SID)}, result: "Here you go:\\n" + JSON.stringify({ findings: [] }), is_error: false }));
`,
    );
    const d = claudeWorkflowDriver({ bin, cwd: root, env: { CLAUDE_CONFIG_DIR: join(root, "claude"), HOME: root } });
    const r = await d.run({ name: "v", script: "wf.js" }, cases[0]!, { CODING_SH_WORKFLOW_RUN_ID: "wfr_c" });
    assert.equal(r.exitCode, 0);
    assert.equal(r.error, undefined);
    assert.deepEqual(r.output, { findings: [] });
    assert.equal(r.runId, RESUMED);
    assert.equal(r.sources?.hostSessionId, SID);
    assert.equal(JSON.parse(readFileSync(argvLog, "utf8"))[0], "-p");
  });
});

describe("runWorkflowExperiment + compareWorkflowVariants", () => {
  it("interleaves attempts across variants per case", () => {
    const jobs = scheduleWorkflowJobs(cases, [{ name: "a" }, { name: "b" }], 2);
    assert.deepEqual(
      jobs.map((j) => `${j.case.id}/${j.attempt}/${j.variant.name}`),
      ["seeded-1/1/a", "seeded-1/1/b", "seeded-1/2/a", "seeded-1/2/b", "seeded-2/1/a", "seeded-2/1/b", "seeded-2/2/a", "seeded-2/2/b"],
    );
  });

  it("runs, scores, tags and stores every job, then compares the variants paired by case", async () => {
    const store = new WorkflowStore(join(root, "store1"));
    const progress: number[] = [];
    const res = await runWorkflowExperiment({
      workflow: "review",
      variants: [variant("bad", "bad"), variant("good", "good")],
      cases,
      k: 2,
      driver: commandDriver({ cwd: root }),
      store,
      onProgress: (p) => progress.push(p.done),
    });
    assert.equal(res.runs.length, 8);
    assert.deepEqual(progress, [1, 2, 3, 4, 5, 6, 7, 8]);
    const good1 = res.runs.find((r) => r.variant === "good" && r.caseId === "seeded-1")!;
    assert.ok(Math.abs(res.scores.get(good1.id)! - 0.8) < 1e-12);
    assert.ok(good1.tags.includes("variant:good") && good1.tags.includes("case:seeded-1"));
    assert.equal(good1.framework, "command");
    assert.equal(good1.experimentId, res.experimentId);
    const stored = (await store.getRun(good1.id))!;
    assert.equal(((await store.getValue(stored.run.output!)) as { runId: string }).runId, good1.id);
    const exp = (await store.getExperiment(res.experimentId))!;
    assert.equal(exp.runIds.length, 8);
    assert.equal(Object.keys(exp.scores).length, 8);

    const report = compareWorkflowVariants(res.runs, res.scores, { baseline: "bad", candidate: "good", iters: 500, seed: 1 });
    assert.equal(report.pairedCases, 2);
    assert.equal(report.quality.baseline, 0);
    assert.ok(Math.abs(report.quality.candidate - (0.8 + 2 / 3) / 2) < 1e-9);
    assert.deepEqual([report.mcnemar.b, report.mcnemar.c], [0, 2]);
    // The bootstrap excludes 0 but two cases cannot make McNemar significant.
    assert.equal(report.verdict.kind, "inconclusive");
    assert.match(report.verdict.text, /underpowered/);
    assert.ok(report.metrics.some((m) => m.key === "wallMs"));
    const good = report.pareto.find((p) => p.variant === "good")!;
    assert.equal(good.cases, 2);
    const bad = report.pareto.find((p) => p.variant === "bad")!;
    assert.ok(good.quality.mean > bad.quality.mean);
    // Nothing dominates the higher-quality variant, whatever the wall times.
    assert.equal(good.dominated, false);
  });

  it("builds run trees from the driver's sources, or from receiver spans in the index", async () => {
    const blobs = new MemBlobs();
    const events: AgentEvent[] = (await mapTraces(decodeTraceJson(langGraph()), { maxInlineBytes: 4096, blob: (d) => blobs.put(d), traceSessions: new TraceSessionMap() })).events;
    const viaSources = await runWorkflowExperiment({
      workflow: "graph",
      variants: [variant("good", "good")],
      cases: cases.slice(0, 1),
      k: 1,
      driver: commandDriver({ cwd: root, collect: async (runId) => ({ spans: events, runId, framework: "langgraph" }) }),
      store: new WorkflowStore(join(root, "store2")),
    });
    const r1 = viaSources.runs[0]!;
    assert.equal(r1.framework, "langgraph");
    assert.equal(r1.stats.agents, 4);

    const index = new MemIndex();
    await index.putEvents(events);
    const bySession = new Map<string, AgentEvent[]>();
    for (const e of events) bySession.set(e.sessionId, [...(bySession.get(e.sessionId) ?? []), e]);
    for (const evs of bySession.values()) await index.upsertSession(buildSession(evs));
    const viaIndex = await runWorkflowExperiment({
      workflow: "graph",
      variants: [variant("good", "good")],
      cases: cases.slice(0, 1),
      k: 1,
      driver: commandDriver({ cwd: root }),
      store: new WorkflowStore(join(root, "store3")),
      index,
    });
    assert.equal(viaIndex.runs[0]!.stats.agents, 4);
  });

  it("records a failed run when the driver throws or exits non-zero", async () => {
    const throwing: WorkflowDriver = {
      id: "command",
      run: async () => {
        throw new Error("spawn failed");
      },
    };
    const res = await runWorkflowExperiment({ workflow: "review", variants: [{ name: "x" }], cases: cases.slice(0, 1), k: 1, driver: throwing, store: new WorkflowStore(join(root, "store4")) });
    assert.equal(res.runs[0]!.status, "failed");
    const crash = await runWorkflowExperiment({ workflow: "review", variants: [variant("crash", "crash")], cases: cases.slice(0, 1), k: 1, driver: commandDriver({ cwd: root }), store: new WorkflowStore(join(root, "store5")) });
    assert.equal(crash.runs[0]!.status, "failed");
    const report = compareWorkflowVariants(crash.runs, crash.scores, { baseline: "crash", candidate: "nope" });
    assert.equal(report.verdict.kind, "inconclusive");
    assert.deepEqual(report.unpairedCases, ["seeded-1"]);
  });
});

describe("compareWorkflowVariants control fork (EM-19)", () => {
  const run = (id: string, variant: string | undefined, caseId: string, resumedFrom?: string) =>
    ({ id, framework: "claude", name: "review", ...(variant ? { variant } : {}), caseId, ...(resumedFrom ? { resumedFrom } : {}), startedAt: 1, status: "ok", stats: {}, tags: [] }) as unknown as WorkflowRun;
  const cases = ["c1", "c2", "c3", "c4"];

  it("flags a replayed candidate with no baseline replayed from the same runs", () => {
    const runs = cases.flatMap((c) => [run(`src-${c}`, "base", c), run(`new-${c}`, "edit", c, `src-${c}`)]);
    const scores = new Map(runs.map((r) => [r.id, 1]));
    const r = compareWorkflowVariants(runs, scores, { baseline: "base", candidate: "edit", iters: 200 });
    assert.deepEqual(r.control, { sources: cases.map((c) => `src-${c}`), controlRuns: 0 });
    assert.ok(r.notes.some((n) => /^no control fork: edit resumes from 4 recorded run\(s\)/.test(n)), r.notes.join("\n"));
  });

  it("reports the control replays' drift from their source runs as the replay noise floor", () => {
    const sources = cases.map((c) => run(`src-${c}`, undefined, c));
    const control = cases.map((c) => run(`ctl-${c}`, "control", c, `src-${c}`));
    const edit = cases.map((c) => run(`new-${c}`, "edit", c, `src-${c}`));
    const scores = new Map<string, number>([...sources, ...edit].map((r) => [r.id, 1]));
    for (const [i, r] of control.entries()) scores.set(r.id, i === 0 ? 0 : 1);
    const r = compareWorkflowVariants([...sources, ...control, ...edit], scores, { baseline: "control", candidate: "edit", iters: 200 });
    assert.deepEqual(r.control, { sources: cases.map((c) => `src-${c}`), controlRuns: 4, drift: { n: 4, changed: 1, rate: 0.25 } });
    assert.ok(r.notes.includes("replay noise floor: 1 of 4 control replay(s) changed outcome from their source run (25%); differences below that are replay drift"), r.notes.join("\n"));
    assert.equal(compareWorkflowVariants(sources.map((s, i) => ({ ...s, variant: i % 2 ? "a" : "b" })), scores, { baseline: "a", candidate: "b", iters: 50 }).control, undefined, "no replay, no control check");
  });
});

describe("compareWorkflowVariants P(front) and deployment (AA-19)", () => {
  /**
   * n cases × r runs of one variant: quality, cost and wall time wobble run to run by a
   * seeded pattern (the same in every variant with the same seed). No cost: none recorded;
   * costRuns: only the first that many runs record it. Returns the runs and their scores.
   */
  const arm = (variant: string, o: { q: number; cost?: number; wallMs?: number; noise?: number; n?: number; r?: number; seed?: number; costRuns?: number }) => {
    const rnd = mulberry32(o.seed ?? 11);
    const runs: WorkflowRun[] = [];
    const scores = new Map<string, number>();
    const noise = o.noise ?? 0.2;
    let i = 0;
    for (let c = 0; c < (o.n ?? 10); c++) {
      for (let k = 0; k < (o.r ?? 3); k++) {
        const e = rnd() * 2 - 1;
        const id = `${variant}-${c}-${k}`;
        const withCost = o.cost !== undefined && i++ < (o.costRuns ?? Infinity);
        const stats = { ...(withCost ? { costUsd: o.cost! * (1 + noise * (rnd() * 2 - 1)) } : {}), ...(o.wallMs !== undefined ? { wallMs: o.wallMs * (1 + noise * (rnd() * 2 - 1)) } : {}) };
        runs.push({ id, framework: "command", name: "wf", variant, caseId: `c${c}`, startedAt: 1, status: "ok", stats, tags: [] } as unknown as WorkflowRun);
        scores.set(id, Math.min(1, Math.max(0, o.q + noise * e)));
      }
    }
    return { runs, scores };
  };
  const both = (...arms: ReturnType<typeof arm>[]) => ({ runs: arms.flatMap((a) => a.runs), scores: new Map(arms.flatMap((a) => [...a.scores])) });
  const pt = (variant: string, q: [number, number], cost: number, extra: Partial<ParetoPoint> = {}): ParetoPoint => ({
    variant,
    cases: 10,
    quality: { mean: q[0], lo: q[1], hi: q[0] + (q[0] - q[1]) },
    costUsd: { mean: cost, lo: cost, hi: cost },
    wallMs: { mean: NaN, lo: NaN, hi: NaN },
    dominated: false,
    ...extra,
  });

  it("near-equal noisy variants both stay on the front in a share of draws, though the point rule calls one dominated", () => {
    // Same wobble, b a hair worse and dearer: dominated on point means, not credibly.
    const { runs, scores } = both(arm("a", { q: 0.7, cost: 0.1 }), arm("b", { q: 0.69, cost: 0.1005 }));
    const r = compareWorkflowVariants(runs, scores, { baseline: "a", candidate: "b", iters: 2000, seed: 1 });
    const [a, b] = r.pareto;
    assert.deepEqual([b!.dominated, b!.dominatedBy], [true, ["a"]]);
    assert.ok(a!.pFront! > 0.3 && a!.pFront! <= 1, String(a!.pFront));
    assert.ok(b!.pFront! > 0.3 && b!.pFront! <= 1, String(b!.pFront));
    assert.deepEqual(r.frontierAxes, ["quality", "costUsd"]);
  });

  it("a better and cheaper variant is on the front in every draw, the other in almost none", () => {
    const { runs, scores } = both(arm("good", { q: 0.9, cost: 0.05, noise: 0.05 }), arm("bad", { q: 0.5, cost: 0.1, noise: 0.05, seed: 12 }));
    const r = compareWorkflowVariants(runs, scores, { baseline: "bad", candidate: "good", iters: 2000, seed: 1 });
    const p = Object.fromEntries(r.pareto.map((x) => [x.variant, x.pFront]));
    assert.equal(p.good, 1);
    assert.ok(p.bad! < 0.05, String(p.bad));
    const again = compareWorkflowVariants(runs, scores, { baseline: "bad", candidate: "good", iters: 2000, seed: 1 });
    assert.equal(JSON.stringify(again), JSON.stringify(r), "deterministic for a seed");
  });

  it("weighs quality against wall time when no run records cost, and skips variants that report cost on few runs", () => {
    const wall = both(arm("a", { q: 0.8, wallMs: 60_000 }), arm("b", { q: 0.6, wallMs: 30_000, seed: 12 }));
    const w = compareWorkflowVariants(wall.runs, wall.scores, { baseline: "a", candidate: "b", iters: 500, seed: 1 });
    assert.deepEqual(w.frontierAxes, ["quality", "wallMs"]);
    assert.ok(w.notes.includes("no run records cost, so P(front) weighs quality against wall time"), w.notes.join("\n"));
    assert.ok(w.pareto.every((p) => p.pFront! > 0.9), JSON.stringify(w.pareto.map((p) => p.pFront)));
    // b reports cost on 10 of its 30 runs: no P(front) for it, so none at all with two variants.
    const few = both(arm("a", { q: 0.8, cost: 0.1 }), arm("b", { q: 0.6, cost: 0.05, costRuns: 10 }));
    const f = compareWorkflowVariants(few.runs, few.scores, { baseline: "a", candidate: "b", iters: 500, seed: 1 });
    assert.equal(f.frontierAxes, undefined);
    assert.ok(f.pareto.every((p) => p.pFront === undefined));
    assert.ok(f.notes.includes("no P(front) for b (cost on 10 of 30 scored runs): it needs cost on at least 80% of a variant's scored runs"), f.notes.join("\n"));
  });

  it("selectDeployment: min-cost under a quality floor, weighted quality − λ·cost, and the front's extremes", () => {
    const pts = [pt("base", [0.8, 0.75], 0.1), pt("cheap", [0.74, 0.72], 0.05), pt("cheapest", [0.6, 0.5], 0.02)];
    const drop = selectDeployment(pts, { kind: "min-cost", qDropFrom: { variant: "base", pp: 10 } });
    assert.deepEqual(drop.picked, ["cheap"]);
    assert.match(drop.reason, /^cheapest of 2 with quality lower bound ≥ base's 0\.800 − 10 pp = 0\.700: \$0\.0500/);
    const none = selectDeployment(pts, { kind: "min-cost", qDropFrom: { variant: "base", pp: 0 } });
    assert.deepEqual(none.picked, []);
    assert.match(none.reason, /^no variant with cost has quality lower bound ≥ base's 0\.800 − 0 pp = 0\.800 \(highest lower bound: base 0\.750\)/);
    assert.deepEqual(selectDeployment(pts, { kind: "min-cost", qMin: 0.4 }).picked, ["cheapest"]);
    assert.deepEqual(selectDeployment(pts, { kind: "weighted", lambda: 0 }).picked, ["base"]);
    assert.deepEqual(selectDeployment(pts, { kind: "weighted", lambda: 2 }).picked, ["cheap"]);
    // A clean trade-off has two extremes; when one variant dominates there is one.
    const trade = selectDeployment([pt("q", [0.9, 0.85], 0.2, { pFront: 0.99 }), pt("c", [0.6, 0.55], 0.05, { pFront: 0.98 })], { kind: "pareto" });
    assert.deepEqual(trade.picked, ["q", "c"]);
    assert.equal(trade.reason, "highest quality q, lowest cost c, of 2 on the front (P(front) ≥ 0.5)");
    assert.deepEqual(selectDeployment([pt("a", [0.9, 0.85], 0.05, { pFront: 1 }), pt("b", [0.6, 0.55], 0.1, { pFront: 0.01 })], { kind: "pareto" }).picked, ["a"]);
    // Without P(front) the point-mean front stands in.
    assert.deepEqual(selectDeployment([pt("a", [0.9, 0.85], 0.05), pt("b", [0.6, 0.55], 0.1, { dominated: true })], { kind: "pareto" }).picked, ["a"]);
  });

  it("carries the deployment pick on the report", () => {
    const { runs, scores } = both(arm("base", { q: 0.8, cost: 0.1, noise: 0.05 }), arm("lite", { q: 0.78, cost: 0.04, noise: 0.05, seed: 12 }));
    const r = compareWorkflowVariants(runs, scores, { baseline: "base", candidate: "lite", iters: 500, seed: 1, select: { kind: "min-cost", qDropFrom: { variant: "base", pp: 10 } } });
    assert.deepEqual(r.deployment?.picked, ["lite"]);
    assert.equal(compareWorkflowVariants(runs, scores, { baseline: "base", candidate: "lite", iters: 500, seed: 1 }).deployment, undefined);
  });
});

describe("replay prediction", () => {
  const edit = (from: string, to: string) => {
    assert.ok(SCRIPT.includes(from), from);
    return SCRIPT.replace(from, to);
  };

  it("scans agent() call sites with labels and phases", () => {
    const sites = scanAgentCalls(SCRIPT);
    assert.deepEqual(
      sites.map((s) => [s.labelText, s.phase]),
      [
        ["find-a", "Find"],
        ["find-b", "Find"],
        ["find-c", "Find"],
        ["fix-${i}", "Fix"],
        ["check-${i}", "Fix"],
        ["verify-null", "Verify"],
        ["verify-schema", "Verify"],
      ],
    );
    assert.ok(labelPattern("fix-${i}", "`").test("fix-12"));
    assert.ok(!labelPattern("fix-${i}", "`").test("check-1"));
    assert.equal(changeWindow("a\nb\nc", "a\nb\nc"), undefined);
    assert.deepEqual(changeWindow("a\nconst x = 1;\nc", "a\nconst x = 2;\nc"), { start: 1, baseEnd: 2, editedEnd: 2, idents: ["x"] });
  });

  it("predicts the cached prefix up to the first changed call", () => {
    const p = (edited: string, o: { argsChanged?: boolean } = {}) => predictCacheHits(base.nodes, SCRIPT, edited, o);
    assert.equal(p(SCRIPT).hits, 9);
    const last = p(edit(`prompt: "Summarize"`, `prompt: "Summarize briefly"`));
    assert.equal(last.hits, 8);
    assert.deepEqual(last.firstMiss, { ordinal: 8, label: "verify-schema" });
    assert.ok(Math.abs(last.estimatedUsd! - 0.1) < 1e-12);
    assert.equal(last.heuristic, true);
    assert.equal(p(edit(`"Find races in "`, `"Find data races in "`)).hits, 1);
    assert.equal(p(edit(`"Fix " + f`, `"Fix carefully " + f`)).hits, 3);
    assert.equal(p(edit(`  const nul = await agent`, `  const nul2 = await agent`)).hits, 7);
    assert.equal(p(edit(`  phase("Verify");\n`, `  phase("Verify");\n  await agent({ label: "extra", prompt: "x" });\n`)).hits, 7);
    assert.equal(p(SCRIPT, { argsChanged: true }).hits, 0);
  });

  it("drives a resume through the driver and stores the replayed run with its savings", async () => {
    const store = new WorkflowStore(join(root, "store-replay"));
    await store.putRun(base.run, base.nodes);
    const resumedSources = (await loadClaudeWorkflowDir(resumedDir)).sources;
    const calls: WorkflowVariant[] = [];
    const driver: WorkflowDriver = {
      id: "claude-code-workflow",
      run: async (v) => {
        calls.push(v);
        return { runId: RESUMED, output: { findings: [] }, exitCode: 0, sources: resumedSources };
      },
    };
    const edited = edit(`prompt: "Verify"`, `prompt: "Verify twice"`);
    const dry = await replayWorkflow({ base, baseScript: SCRIPT, script: "/w/review.js", editedScript: edited, driver, store, dryRun: true });
    assert.equal(dry.prediction.hits, 7);
    assert.equal(dry.run, undefined);
    assert.equal(calls.length, 0);
    const res = await replayWorkflow({ base, baseScript: SCRIPT, script: "/w/review.js", editedScript: edited, args: { target: "src" }, driver, store });
    assert.equal(calls[0]!.resumeFromRunId, RUN);
    assert.equal(calls[0]!.script, "/w/review.js");
    assert.equal(res.prediction.hits, 7);
    const run = (await store.getRun(RESUMED))!.run;
    assert.ok(run.tags.includes("replay"));
    assert.equal(run.resumedFrom, RUN);
    assert.equal(run.stats.cacheHits, 7);
    assert.ok(Math.abs(run.stats.resumeSavedUsd! - 0.8) < 1e-9);
    // Different args invalidate every call.
    const changed = await replayWorkflow({ base, baseScript: SCRIPT, script: "/w/review.js", editedScript: SCRIPT, args: { target: "lib" }, driver, store, dryRun: true });
    assert.equal(changed.prediction.hits, 0);
  });
});

// VWR-6: the experiment record used to be rewritten from an in-memory copy after
// every job, erasing a score written meanwhile and, with concurrency, dropping runs.
describe("workflow experiment record (VWR-6)", () => {
  const kase = (id: string): WorkflowCase => ({ ...cases[0]!, id });
  const okDriver = (delay: () => Promise<void>): WorkflowDriver => ({
    id: "command",
    async run(_v, _c, env) {
      await delay();
      return { runId: env.CODING_SH_WORKFLOW_RUN_ID!, output: null, exitCode: 0, startedAt: Date.now(), endedAt: Date.now() };
    },
  });

  it("keeps a score written while the experiment is still running", async () => {
    const store = new WorkflowStore(join(root, "vwr6-score"));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    let first = "";
    let second = "";
    const p = runWorkflowExperiment({
      workflow: "review",
      variants: [{ name: "A" }, { name: "B" }, { name: "C" }],
      cases: [kase("c1")],
      k: 1,
      driver: okDriver(() => (++calls === 2 ? gate : Promise.resolve())),
      store,
      experimentId: "wfx_vwr6",
      score: () => undefined,
      onProgress: ({ run, done }) => {
        if (done === 1) first = run.id;
      },
    });
    while (!first) await new Promise((r) => setTimeout(r, 5));
    // A stale read-modify-write of the whole record (the old `workflows score` path)...
    const e = (await store.getExperiment("wfx_vwr6"))!;
    e.scores[first] = 0.9;
    await store.putExperiment(e);
    release();
    const res = await p;
    const done = (await store.getExperiment("wfx_vwr6"))!;
    assert.equal(done.scores[first], 0.9, "score written mid-run survives the later jobs");
    assert.deepEqual(new Set(done.runIds), new Set(res.runs.map((r) => r.id)));
    assert.equal(done.runIds.length, 3);
    // The append `workflows score` uses now, plus a stale whole-record write after it.
    second = res.runs[1]!.id;
    await store.setExperimentScore("wfx_vwr6", second, 0.4);
    await store.putExperiment(done);
    const fin = (await store.getExperiment("wfx_vwr6"))!;
    assert.equal(fin.scores[second], 0.4, "an appended score survives a stale record write");
    assert.equal(fin.scores[first], 0.9);
  });

  it("records every run with concurrency 8 (40 jobs, 20 tries)", async () => {
    for (let t = 0; t < 20; t++) {
      const store = new WorkflowStore(join(root, `vwr6-conc-${t}`));
      const res = await runWorkflowExperiment({
        workflow: "review",
        variants: [{ name: "A" }, { name: "B" }],
        cases: Array.from({ length: 20 }, (_, i) => kase(`c${i}`)),
        k: 1,
        driver: okDriver(() => new Promise((r) => setTimeout(r, Math.random() * 3))),
        store,
        concurrency: 8,
        experimentId: "wfx_conc",
        score: () => 1,
      });
      const fin = (await store.getExperiment("wfx_conc"))!;
      assert.equal(res.runs.length, 40);
      assert.equal(fin.runIds.length, 40, `try ${t}: every run is in the record`);
      assert.equal(Object.keys(fin.scores).length, 40, `try ${t}: every score is in the record`);
      assert.equal((await store.listExperiments())[0]?.runIds.length, 40, "listExperiments folds the log too");
    }
  });
});
