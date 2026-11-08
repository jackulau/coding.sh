import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { findClaudeWorkflowDirs, loadClaudeWorkflowDir, parseJournal, recordStatus, scanMetaName, scanPhases } from "../../src/workflows/sources/claude-workflow.ts";
import { buildWorkflowTree, type WorkflowTree } from "../../src/workflows/tree.ts";
import { AGENTS, RESUMED, RUN, RUN_OUTPUT, SCRIPT, SID, T0, writeClaudeWorkflowFixture } from "./_fixtures.ts";

let root = "";
let dirs: ReturnType<typeof writeClaudeWorkflowFixture>;
let base: WorkflowTree;
let resumed: WorkflowTree;

before(async () => {
  root = mkdtempSync(join(tmpdir(), "csh-wf-claude-"));
  dirs = writeClaudeWorkflowFixture(join(root, "projects"));
  base = buildWorkflowTree((await loadClaudeWorkflowDir(dirs.base, { concurrencyCap: 4 })).sources);
  resumed = buildWorkflowTree((await loadClaudeWorkflowDir(dirs.resumed, { concurrencyCap: 4 })).sources, { base });
});
after(() => rmSync(root, { recursive: true, force: true }));

const agent = (t: WorkflowTree, label: string) => t.nodes.find((n) => n.kind === "agent" && n.name === label)!;

describe("parseJournal", () => {
  it("pairs started/result records by key and keeps call order", () => {
    const j = [
      { type: "launched", runId: "r1" },
      { type: "started", key: "v2:a", agentId: "x1", label: "one", phase: "P" },
      { type: "started", key: "v2:b", agentId: "x2", label: "two", phase: "P" },
      { type: "result", key: "v2:b", agentId: "x2", result: { ok: 1 }, toolsUsed: ["StructuredOutput"] },
      { type: "result", key: "v2:a", agentId: "x1", result: null },
      { type: "mystery" },
      "not json",
    ]
      .map((x) => (typeof x === "string" ? x : JSON.stringify(x)))
      .join("\n");
    const p = parseJournal(j);
    assert.equal(p.runId, "r1");
    assert.equal(p.calls.length, 2);
    assert.deepEqual(
      p.calls.map((c) => [c.ordinal, c.label, c.status, c.cached]),
      [
        [0, "one", "null", false],
        [1, "two", "returned", false],
      ],
    );
    assert.deepEqual(p.calls[1]!.toolsUsed, ["StructuredOutput"]);
    assert.equal(p.unknown, 2);
  });

  it("treats a result without a start as a cache hit (resume) and records errors", () => {
    const j = [
      { type: "launched", runId: "r2", resumeFromRunId: "r1" },
      { type: "result", key: "v2:a", agentId: "x1", result: "cached value" },
      { type: "started", key: "v2:b", agentId: "x2" },
      { type: "error", key: "v2:b", agentId: "x2", error: "boom" },
      { type: "started", key: "v2:c", agentId: "x3" },
    ]
      .map((x) => JSON.stringify(x))
      .join("\n");
    const p = parseJournal(j);
    assert.equal(p.resumeFromRunId, "r1");
    assert.equal(p.calls[0]!.cached, true);
    assert.equal(p.calls[0]!.cacheInferred, true);
    assert.equal(p.calls[1]!.status, "error");
    assert.equal(p.calls[1]!.error, "boom");
    assert.equal(p.calls[2]!.status, "running");
    assert.equal(p.calls[2]!.hasResult, false);
  });

  it("reads explicit group fields and timestamps when present", () => {
    const j = [
      { type: "started", key: "k", agentId: "a", ts: "2026-11-01T10:00:00.000Z", group: { id: "g", kind: "pipeline", stage: 1, item: 2 } },
      { type: "result", key: "k", agentId: "a", ts: "2026-11-01T10:00:05.000Z", result: 1 },
    ]
      .map((x) => JSON.stringify(x))
      .join("\n");
    const [c] = parseJournal(j).calls;
    assert.equal(c!.groupId, "g");
    assert.equal(c!.groupKind, "pipeline");
    assert.equal(c!.stage, 1);
    assert.equal(c!.item, 2);
    assert.equal(c!.endedAt! - c!.startedAt!, 5000);
  });

  it("maps record statuses and scans phase() calls", () => {
    assert.equal(recordStatus("completed"), "ok");
    assert.equal(recordStatus("killed"), "aborted");
    assert.equal(recordStatus("weird"), undefined);
    assert.deepEqual(scanPhases(SCRIPT), ["Find", "Fix", "Verify"]);
  });

  it("scans meta.name, never a phase's name", () => {
    assert.equal(scanMetaName(SCRIPT), "review");
    assert.equal(scanMetaName("export const meta = {\n  description: 'Fix it',\n  name: 'fix-loop',\n  phases: [{ title: 'Find' }],\n}"), "fix-loop");
    assert.equal(scanMetaName("export const meta = { phases: [{ name: 'Find' }], name: 'late' }"), undefined);
    assert.equal(scanMetaName("phase('Find'); const name = 'x'"), undefined);
  });

  it("names a run by its record, else its script's meta.name, else the script file without the run id", () => {
    const journal = '{"type":"launched"}\n';
    const name = (src: Parameters<typeof buildWorkflowTree>[0]) => buildWorkflowTree({ journal, runId: "wf_1", ...src }).run.name;
    assert.equal(name({ record: { workflowName: "from-record" }, script: SCRIPT }), "from-record");
    assert.equal(name({ script: SCRIPT, scriptPath: "/s/other-wf_1.js" }), "review");
    assert.equal(name({ script: "phase('A')", scriptPath: "/s/fix-loop-wf_1.js" }), "fix-loop");
    assert.equal(name({}), "wf_1");
  });
});

describe("findClaudeWorkflowDirs", () => {
  it("finds run dirs from the projects, project, session or run directory", async () => {
    const projects = join(root, "projects");
    for (const start of [projects, join(projects, "-work-demo"), dirs.sessionDir, dirs.base]) {
      const found = await findClaudeWorkflowDirs(start);
      assert.ok(found.length >= 1, start);
      assert.ok(found.every((d) => d.hostSessionId === SID));
    }
    assert.deepEqual((await findClaudeWorkflowDirs(projects)).map((d) => d.runId).sort(), [RUN, RESUMED].sort());
  });
});

describe("Claude Code workflow tree", () => {
  it("builds workflow → phase → group → agent → tool/llm from journal, record, meta and transcripts", () => {
    const { run, nodes } = base;
    assert.equal(run.id, RUN);
    assert.equal(run.name, "review");
    assert.equal(run.framework, "claude-code-workflow");
    assert.equal(run.status, "ok");
    assert.equal(run.hostSessionId, SID);
    assert.equal(run.startedAt, T0 - 1000);
    assert.equal(run.endedAt, T0 + 56_000);
    assert.deepEqual(run.phases, ["Find", "Fix", "Verify"]);
    assert.ok(run.scriptHash && run.argsHash);
    assert.equal(nodes.filter((n) => n.kind === "agent").length, AGENTS.length);
    assert.deepEqual(
      nodes.filter((n) => n.kind === "phase").map((n) => n.name),
      ["Find", "Fix", "Verify"],
    );
    // Find: three agents started together → an inferred (barrier) group.
    const find = agent(base, "find-a");
    const group = nodes.find((n) => n.id === find.parentId)!;
    assert.equal(group.kind, "group");
    assert.equal(group.groupKind, "inferred");
    assert.equal(group.parentId, `${RUN}/phase/Find`);
    // Fix: the journal's explicit pipeline group, stage and item.
    const check1 = agent(base, "check-1");
    assert.equal(check1.groupKind, "pipeline");
    assert.equal(check1.stage, 1);
    assert.equal(check1.item, 1);
    // Timing from the transcripts (the journal has none).
    assert.equal(find.startedAt, T0);
    assert.equal(find.endedAt, T0 + 10_000);
    assert.equal(find.sessionId !== undefined, true);
    assert.equal(find.model, "claude-sonnet-4-5");
    assert.equal(find.usage?.costUsd, 0.1);
    // Children: the transcript's model call and StructuredOutput tool call.
    const kids = nodes.filter((n) => n.parentId === find.id).map((n) => n.kind).sort();
    assert.deepEqual(kids, ["llm", "tool"]);
    assert.deepEqual(base.runOutput, RUN_OUTPUT);
    assert.deepEqual(base.outputs[find.id], AGENTS[0]!.result);
  });

  it("marks the null agent and the schema retry", () => {
    assert.equal(agent(base, "verify-null").status, "null");
    const s = agent(base, "verify-schema");
    assert.deepEqual(s.schema, { declared: true, attempts: 2, failures: 1, finalValid: true });
    assert.equal(base.run.stats.schemaFailures, 1);
    assert.equal(base.run.stats.schemaFinalInvalid, 0);
    assert.equal(base.run.stats.nullAgents, 1);
    assert.equal(base.run.stats.nullRate, 1 / 9);
  });

  it("computes metrics: wall, agent time, barrier idle, critical path, utilization, cost per phase", () => {
    const s = base.run.stats;
    assert.equal(s.wallMs, 57_000);
    assert.equal(s.agentMs, 10_000 + 19_900 + 29_800 + 5000 + 9900 + 3500 + 3500 + 4000 + 4500);
    assert.equal(s.peakConcurrency, 3);
    // find-a waits 20 s and find-b 10 s for find-c before Fix starts.
    assert.equal(s.barrierIdleMs, 30_000);
    // Inferred groups make the path an approximation.
    assert.equal(s.criticalPathExact, false);
    assert.deepEqual(
      s.criticalPath!.map((id) => base.nodes.find((n) => n.id === id)!.name),
      ["find-c", "fix-1", "check-1", "verify-null", "verify-schema"],
    );
    assert.equal(s.criticalPathMs, 55_000 - 200);
    assert.equal(s.orchestrationGapMs, 1100 + 500 + 1000 + 500);
    assert.equal(s.utilization, s.agentMs / (4 * 57_000));
    assert.ok(Math.abs(s.costUsd! - 1) < 1e-9);
    assert.ok(Math.abs(s.costShareByPhase!.Find! - 0.6) < 1e-9);
    assert.equal(s.perPhase!.find((p) => p.phase === "Find")!.wallMs, 30_000);
    assert.equal(s.perAgent!.length, 9);
  });

  it("counts resume cache hits and what they saved", () => {
    const { run, nodes } = resumed;
    assert.equal(run.resumedFrom, RUN);
    const agents = nodes.filter((n) => n.kind === "agent");
    assert.equal(agents.length, 9);
    assert.deepEqual(
      agents.filter((n) => n.status === "cached").map((n) => n.ordinal),
      [0, 1, 2, 3, 4, 5, 6],
    );
    const s = run.stats;
    assert.equal(s.cacheHits, 7);
    assert.equal(s.agents, 2);
    assert.equal(s.cacheHitRate, 7 / 9);
    assert.equal(s.resumeSavedMs, 10_000 + 19_900 + 29_800 + 5000 + 9900 + 3500 + 3500);
    assert.ok(Math.abs(s.resumeSavedUsd! - 0.8) < 1e-9);
  });

  it("reports a run whose calls never resolved as running, and as failed once the record says so", () => {
    const journal = [{ type: "started", key: "k", agentId: "a", label: "slow" }].map((x) => JSON.stringify(x)).join("\n");
    assert.equal(buildWorkflowTree({ journal, runId: "r" }).run.status, "running");
    const failed = buildWorkflowTree({ journal, runId: "r", record: { status: "failed", startTime: T0, durationMs: 1000 } });
    assert.equal(failed.run.status, "failed");
    const n = failed.nodes.find((x) => x.kind === "agent")!;
    assert.equal(n.status, "failed");
    assert.equal(n.error, "no result recorded");
  });
});
