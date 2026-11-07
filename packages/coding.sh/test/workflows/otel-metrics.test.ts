import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeTraceJson } from "../../src/otel/json.ts";
import { mapTraces, TraceSessionMap } from "../../src/otel/map.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { criticalPath, explicitEdges, timedAgents } from "../../src/workflows/critical-path.ts";
import { buildGantt, ganttTsv } from "../../src/workflows/gantt.ts";
import { barrierIdle, concurrencySeries, eventEnd, makespan, pipelineSavings, workflowStats } from "../../src/workflows/metrics.ts";
import { matchFrameworkSpan } from "../../src/workflows/sources/otel-frameworks.ts";
import { splitTraces } from "../../src/workflows/sources/otel.ts";
import { buildWorkflowTree } from "../../src/workflows/tree.ts";
import type { WorkflowNode, WorkflowRun } from "../../src/workflows/types.ts";
import { MemBlobs } from "../otel/_memstore.ts";
import { agentsSdkHandoff, GRAPH_TRACE, HANDOFF_TRACE, langGraph, T0 } from "./_fixtures.ts";

async function spans(doc: Record<string, unknown>): Promise<AgentEvent[]> {
  const blobs = new MemBlobs();
  return (await mapTraces(decodeTraceJson(doc), { maxInlineBytes: 4096, blob: (d) => blobs.put(d), traceSessions: new TraceSessionMap() })).events;
}

describe("OTel span trees", () => {
  it("maps an Agents SDK handoff: two agents, a handoff node, model and tool calls", async () => {
    const t = buildWorkflowTree({ spans: await spans(agentsSdkHandoff()) });
    assert.equal(t.run.id, HANDOFF_TRACE);
    assert.equal(t.run.framework, "openai-agents");
    assert.equal(t.run.name, "Support workflow");
    assert.equal(t.run.startedAt, T0);
    assert.equal(t.run.endedAt, T0 + 9000);
    const agents = t.nodes.filter((n) => n.kind === "agent");
    assert.deepEqual(
      agents.map((a) => [a.name, a.ordinal]),
      [
        ["triage", 0],
        ["billing", 1],
      ],
    );
    const h = t.nodes.find((n) => n.kind === "handoff")!;
    assert.equal(h.from, "triage");
    assert.equal(h.to, "billing");
    const billing = agents[1]!;
    assert.deepEqual(billing.usage, { inputTokens: 700, outputTokens: 100 });
    assert.equal(billing.toolCalls, 1);
    assert.equal(t.nodes.filter((n) => n.parentId === billing.id && n.kind === "llm").length, 2);
    assert.equal(t.run.stats.wallMs, 9000);
    assert.deepEqual(t.run.stats.tokens, { inputTokens: 800, outputTokens: 120 });
    assert.equal(t.run.stats.agents, 2);
  });

  it("maps a LangGraph graph: node spans become steps with their superstep", async () => {
    const t = buildWorkflowTree({ spans: await spans(langGraph()) });
    assert.equal(t.run.id, GRAPH_TRACE);
    assert.equal(t.run.framework, "langgraph");
    const steps = t.nodes.filter((n) => n.kind === "step");
    assert.deepEqual(
      steps.map((s) => [s.name, s.stage]),
      [
        ["plan", 1],
        ["research", 2],
        ["draft", 2],
        ["review", 3],
      ],
    );
    assert.equal(t.run.stats.peakConcurrency, 2);
    assert.deepEqual(
      t.run.stats.criticalPath!.map((id) => t.nodes.find((n) => n.id === id)!.name),
      ["plan", "research", "review"],
    );
    assert.equal(t.run.stats.criticalPathExact, false);
    // detail "agents" drops llm/tool nodes but keeps folded usage.
    const lean = buildWorkflowTree({ spans: await spans(langGraph()) }, { detail: "agents" });
    assert.equal(lean.nodes.filter((n) => n.kind === "llm").length, 0);
    assert.deepEqual(lean.run.stats.tokens, t.run.stats.tokens);
  });

  it("splits receiver events by workflow run id, else trace id", async () => {
    const a = await spans(agentsSdkHandoff());
    const b = (await spans(langGraph())).map((e) => ({ ...e, runId: "wfr_1" }));
    const m = splitTraces([...a, ...b]);
    assert.deepEqual([...m.keys()].sort(), [HANDOFF_TRACE, "wfr_1"].sort());
  });

  it("matches framework spans by scope and attributes", () => {
    assert.equal(matchFrameworkSpan("mastra", "workflow step: fetch", { "mastra.span.type": "workflow_step" })?.kind, "step");
    assert.equal(matchFrameworkSpan("crewai.telemetry", "Crew Created", {})?.kind, "phase");
    assert.equal(matchFrameworkSpan("x", "plain", {}), undefined);
  });

  it("uses each event's real end (end-stamped kinds are not extended by their duration)", () => {
    assert.equal(eventEnd({ kind: "llm.call", ts: 100, durationMs: 50 }), 150);
    assert.equal(eventEnd({ kind: "turn.end", ts: 100, durationMs: 50 }), 100);
  });
});

// ------------------------------------------------------------ pure metrics

const run = (o: Partial<WorkflowRun> = {}): WorkflowRun => ({ id: "r", framework: "command", name: "t", startedAt: 1000, status: "ok", stats: undefined as unknown as WorkflowRun["stats"], tags: [], ...o });
const ag = (id: string, start: number, end: number, o: Partial<WorkflowNode> = {}): WorkflowNode => ({ id, runId: "r", kind: "agent", name: id, startedAt: start, endedAt: end, status: "ok", ...o });

describe("critical path", () => {
  it("is exact over explicit deps: the longest duration-weighted chain", () => {
    const nodes = [ag("a", 0, 10, { deps: [] }), ag("b", 10, 15, { deps: ["a"] }), ag("c", 10, 40, { deps: ["a"] }), ag("d", 40, 45, { deps: ["b", "c"] })];
    const cp = criticalPath(nodes);
    assert.equal(cp.exact, true);
    assert.deepEqual(cp.path, ["a", "c", "d"]);
    assert.equal(cp.ms, 45);
  });

  it("is exact over explicit parallel/pipeline groups, chaining pipeline items stage by stage", () => {
    const nodes = [
      ag("p0", 0, 10, { ordinal: 0, groupId: "g1", groupKind: "parallel" }),
      ag("p1", 0, 30, { ordinal: 1, groupId: "g1", groupKind: "parallel" }),
      ag("s0i0", 31, 35, { ordinal: 2, groupId: "g2", groupKind: "pipeline", stage: 0, item: 0 }),
      ag("s0i1", 31, 50, { ordinal: 3, groupId: "g2", groupKind: "pipeline", stage: 0, item: 1 }),
      ag("s1i0", 35, 60, { ordinal: 4, groupId: "g2", groupKind: "pipeline", stage: 1, item: 0 }),
      ag("s1i1", 50, 52, { ordinal: 5, groupId: "g2", groupKind: "pipeline", stage: 1, item: 1 }),
    ];
    const edges = explicitEdges(timedAgents(nodes))!;
    assert.deepEqual(edges.get("s1i0"), ["s0i0"]);
    assert.deepEqual(edges.get("s0i0")!.sort(), ["p0", "p1"]);
    const cp = criticalPath(nodes);
    assert.equal(cp.exact, true);
    assert.deepEqual(cp.path, ["p1", "s0i0", "s1i0"]);
    assert.equal(cp.ms, 60);
    assert.deepEqual(cp.gaps, [{ after: "p1", ms: 1 }]);
  });

  it("approximates from timing when the structure is not recorded", () => {
    const nodes = [ag("a", 0, 10), ag("b", 2, 20), ag("c", 21, 30), ag("d", 25, 28)];
    const cp = criticalPath(nodes);
    assert.equal(cp.exact, false);
    assert.deepEqual(cp.path, ["b", "c"]);
    assert.equal(cp.ms, 28);
  });

  it("ignores cached agents (they did not run)", () => {
    assert.deepEqual(criticalPath([ag("a", 0, 10, { status: "cached" }), ag("b", 0, 5)]).path, ["b"]);
  });
});

describe("concurrency, barriers and pipelines", () => {
  it("sweeps concurrency without overlapping back-to-back agents", () => {
    assert.deepEqual(
      concurrencySeries([
        { start: 0, end: 10 },
        { start: 10, end: 20 },
        { start: 5, end: 15 },
      ]),
      [
        { t: 0, running: 1 },
        { t: 5, running: 2 },
        { t: 10, running: 2 },
        { t: 15, running: 1 },
        { t: 20, running: 0 },
      ],
    );
  });

  it("charges barrier idle only when later work waits on the group", () => {
    const grp = { groupId: "g", groupKind: "parallel" as const };
    const withLater = [ag("a", 0, 10, grp), ag("b", 0, 30, grp), ag("c", 30, 40)];
    assert.deepEqual([...barrierIdle(withLater)], [
      ["a", 20],
      ["b", 0],
    ]);
    assert.equal(barrierIdle([ag("a", 0, 10, grp), ag("b", 0, 30, grp)]).size, 0);
  });

  it("list-schedules makespan and estimates what a pipeline would save over two barriers", () => {
    assert.equal(makespan([5, 5, 5], 2), 10);
    assert.equal(makespan([5, 5, 5], 8), 5);
    // Stage A: items take 10 and 30; stage B: items take 30 and 10. With a barrier: 0..30, then 30..60.
    const A = { groupId: "A", groupKind: "parallel" as const };
    const B = { groupId: "B", groupKind: "parallel" as const };
    const nodes = [ag("a0", 0, 10, { ...A, item: 0 }), ag("a1", 0, 30, { ...A, item: 1 }), ag("b0", 30, 60, { ...B, item: 0 }), ag("b1", 30, 40, { ...B, item: 1 })];
    // Pipelined chains: item 0 = 10 + 30 = 40, item 1 = 30 + 10 = 40 → 40, saving 20.
    assert.equal(pipelineSavings(nodes, 4), 20);
    // Without item indices there is no mapping to simulate.
    assert.equal(pipelineSavings(nodes.map(({ item: _i, ...n }) => n), 4), undefined);
  });

  it("sums queue wait from issuedAt and leaves utilization unset without a cap", () => {
    const s = workflowStats(run({ endedAt: 1100 }), [ag("a", 1000, 1050, { issuedAt: 990 }), ag("b", 1010, 1100, { issuedAt: 1000 })]);
    assert.equal(s.queueWaitMs, 20);
    assert.equal(s.utilization, undefined);
    assert.equal(s.wallMs, 100);
    assert.equal(s.parallelism, 140 / 100);
  });
});

describe("gantt", () => {
  it("lays agents out by phase with critical flags, idle and cost, and prints TSV", () => {
    const grp = { groupId: "g", groupKind: "parallel" as const, phase: "Find" };
    const nodes = [
      ag("a", 1000, 1010, { ...grp, ordinal: 0, usage: { costUsd: 0.5 } }),
      ag("b", 1000, 1030, { ...grp, ordinal: 1, sessionId: "child-b" }),
      ag("c", 1031, 1040, { phase: "Fix", ordinal: 2 }),
      ag("z", 1000, 1000, { phase: "Fix", ordinal: 3, status: "cached", startedAt: undefined, endedAt: undefined }),
    ];
    const r = run({ endedAt: 1040, phases: ["Find", "Fix"], concurrencyCap: 2 });
    r.stats = workflowStats(r, nodes);
    const g = buildGantt(r, nodes);
    assert.equal(g.cap, 2);
    assert.deepEqual(
      g.phases.map((p) => [p.name, p.rows.map((x) => x.label)]),
      [
        ["Find", ["a", "b"]],
        ["Fix", ["c", "z"]],
      ],
    );
    const a = g.phases[0]!.rows[0]!;
    assert.equal(a.idleAfterMs, 20);
    assert.equal(a.costUsd, 0.5);
    assert.equal(g.phases[0]!.rows[1]!.critical, true);
    const tsv = ganttTsv(g).split("\n");
    assert.equal(tsv[0], "phase\tlabel\tstatus\tstart_ms\tend_ms\tduration_ms\tcritical\tidle_after_ms\tcost_usd\tsession");
    assert.equal(tsv[1], "Find\ta\tok\t0\t10\t10\t\t20\t0.5000\t");
    assert.equal(tsv[2], "Find\tb\tok\t0\t30\t30\tyes\t\t\tchild-b");
    assert.equal(tsv[4], "Fix\tz\tcached\t0\t0\t0\t\t\t\t");
  });
});
