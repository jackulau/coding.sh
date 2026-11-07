// Merge capture sources into one workflow tree (docs/design/workflows.md §2):
// workflow → phase → (group →) agent → subagent → tool / llm.
//
// Claude Code workflows: journal (call order, labels, phases, results, cache
// hits) + per-agent transcripts (times, usage, tool calls, StructuredOutput
// attempts) + meta.json (phase, effort) + host session events (Workflow tool
// window, SubagentStart/Stop times). Timing precedence per agent: journal
// timestamps, then host SubagentStart/Stop, then the transcript's first and
// last line.
//
// OTel frameworks: see sources/otel.ts.
import { basename } from "node:path";
import type { AgentEvent, Session } from "../schema/index.ts";
import { workflowStats } from "./metrics.ts";
import {
  agentDetail,
  argsHashOf,
  isObj,
  parseJournal,
  recordStatus,
  scanPhases,
  scriptHashOf,
  tsOf,
  type JournalCall,
} from "./sources/claude-workflow.ts";
import { otelTree } from "./sources/otel.ts";
import type { TreeSources, WorkflowNode, WorkflowRun } from "./types.ts";

/** Agents in one phase whose starts fall within this window of the group's first start form one inferred group. */
export const GROUP_WINDOW_MS = 2_000;

export interface WorkflowTree {
  run: WorkflowRun;
  nodes: WorkflowNode[];
  /** Agent return values by node id (store them as blobs and set node.output). */
  outputs: Record<string, unknown>;
  /** The workflow's return value, when known. */
  runOutput?: unknown;
  /** Journal records the parser did not understand (format drift signal). */
  unknownRecords?: number;
}

export interface BuildOpts {
  /** Previous run (resumedFrom) for resume savings. */
  base?: { run: WorkflowRun; nodes: WorkflowNode[] };
  /** "full" (default) adds tool/llm/subagent children; "agents" stops at agent nodes. */
  detail?: "full" | "agents";
}

const s = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const n = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * Infers concurrent groups: within each phase, agents with no explicit group
 * whose start falls within GROUP_WINDOW_MS of the group's first start.
 * Mutates nodes (groupId, groupKind "inferred") and returns the group nodes.
 */
export function inferGroups(runId: string, agents: WorkflowNode[]): WorkflowNode[] {
  const byPhase = new Map<string, WorkflowNode[]>();
  for (const a of agents) {
    if (a.groupId || a.startedAt === undefined || a.status === "cached") continue;
    byPhase.set(a.phase ?? "", [...(byPhase.get(a.phase ?? "") ?? []), a]);
  }
  const groups: WorkflowNode[] = [];
  for (const [phase, list] of byPhase) {
    list.sort((x, y) => x.startedAt! - y.startedAt! || (x.ordinal ?? 0) - (y.ordinal ?? 0));
    let cur: WorkflowNode[] = [];
    const flush = () => {
      if (cur.length >= 2) {
        const id = `${runId}/group/inferred-${groups.length}`;
        for (const m of cur) {
          m.groupId = id;
          m.groupKind = "inferred";
        }
        const g: WorkflowNode = {
          id,
          runId,
          kind: "group",
          name: `${phase || "group"} ×${cur.length}`,
          groupId: id,
          groupKind: "inferred",
          startedAt: Math.min(...cur.map((m) => m.startedAt!)),
          endedAt: Math.max(...cur.map((m) => m.endedAt ?? m.startedAt!)),
          status: cur.some((m) => m.status === "failed") ? "failed" : "ok",
        };
        if (phase) g.phase = phase;
        groups.push(g);
      }
      cur = [];
    };
    for (const a of list) {
      if (cur.length && a.startedAt! - cur[0]!.startedAt! > GROUP_WINDOW_MS) flush();
      cur.push(a);
    }
    flush();
  }
  return groups;
}

interface HostInfo {
  agents: Map<string, { start?: number; end?: number; ok?: boolean }>;
  workflow?: { start: number; end?: number; ok?: boolean; input?: unknown };
}

function hostInfo(host: readonly AgentEvent[] | undefined, runId: string, firstAgentStart?: number): HostInfo {
  const agents = new Map<string, { start?: number; end?: number; ok?: boolean }>();
  const calls = new Map<string, { start: number; end?: number; ok?: boolean; input?: unknown; output?: string }>();
  for (const e of host ?? []) {
    const sid = s(e.payload.subagentId) ?? e.subagentId;
    if (e.kind === "subagent.start" && sid) agents.set(sid, { ...agents.get(sid), start: e.ts });
    if (e.kind === "subagent.end" && sid) agents.set(sid, { ...agents.get(sid), end: e.ts, ok: e.payload.ok !== false });
    if ((e.kind === "tool.start" || e.kind === "tool.end") && e.payload.tool === "Workflow") {
      const id = s(e.payload.toolUseId) ?? e.id;
      const c = calls.get(id) ?? { start: e.ts };
      if (e.kind === "tool.start") {
        c.start = e.ts;
        c.input = e.payload.input;
      } else {
        c.end = e.ts;
        c.ok = e.payload.ok !== false;
        c.output = typeof e.payload.output === "string" ? e.payload.output : JSON.stringify(e.payload.output ?? "");
      }
      calls.set(id, c);
    }
  }
  const list = [...calls.values()];
  const wf =
    list.find((c) => c.output?.includes(runId)) ??
    (firstAgentStart !== undefined ? list.find((c) => c.start <= firstAgentStart && (c.end === undefined || c.end >= firstAgentStart)) : undefined) ??
    (list.length === 1 ? list[0] : undefined);
  const out: HostInfo = { agents };
  if (wf) out.workflow = { start: wf.start, ...(wf.end !== undefined ? { end: wf.end } : {}), ...(wf.ok !== undefined ? { ok: wf.ok } : {}), input: wf.input };
  return out;
}

function children(runId: string, parent: WorkflowNode, events: readonly AgentEvent[]): WorkflowNode[] {
  const out: WorkflowNode[] = [];
  const tools = new Map<string, WorkflowNode>();
  for (const e of [...events].sort((a, b) => a.ts - b.ts)) {
    if (e.kind === "llm.call") {
      const key = s(e.payload.messageId) ?? e.id;
      const node: WorkflowNode = {
        id: `${parent.id}/llm/${key}`,
        runId,
        parentId: parent.id,
        kind: "llm",
        name: e.model ?? "llm",
        startedAt: e.ts,
        endedAt: e.ts + (e.durationMs ?? 0),
        status: e.payload.ok === false ? "failed" : "ok",
      };
      if (parent.phase) node.phase = parent.phase;
      if (e.usage) node.usage = e.usage;
      if (e.model) node.model = e.model;
      out.push(node);
    } else if (e.kind === "tool.start" || e.kind === "tool.end") {
      const id = s(e.payload.toolUseId) ?? e.id;
      const tool = s(e.payload.tool) ?? "tool";
      let node = tools.get(id);
      if (!node) {
        node = {
          id: `${parent.id}/tool/${id}`,
          runId,
          parentId: parent.id,
          kind: tool === "Agent" || tool === "Task" ? "subagent" : "tool",
          name: tool,
          startedAt: e.ts,
          status: "running",
        };
        if (parent.phase) node.phase = parent.phase;
        if (node.kind === "subagent" && isObj(e.payload.input)) node.name = s(e.payload.input.description) ?? s(e.payload.input.subagent_type) ?? tool;
        tools.set(id, node);
        out.push(node);
      }
      if (e.kind === "tool.end") {
        node.endedAt = e.ts;
        node.status = e.payload.ok === false ? "failed" : "ok";
        if (e.payload.ok === false && typeof e.payload.output === "string") node.error = e.payload.output.slice(0, 300);
      }
    }
  }
  return out;
}

function nodeStatus(c: JournalCall, runDone: boolean): WorkflowNode["status"] {
  if (c.cached) return "cached";
  if (c.status === "error") return "failed";
  if (c.status === "null") return "null";
  if (c.status === "returned") return "ok";
  return runDone ? "failed" : "running";
}

function claudeTree(src: TreeSources, opts: BuildOpts): WorkflowTree {
  const parsed = parseJournal(src.journal ?? "");
  const record = src.record ?? {};
  const runId = src.runId ?? s(record.runId) ?? parsed.runId ?? "workflow-run";
  const sessions = new Map<string, Session>();
  for (const t of src.transcripts ?? []) if (t.parent?.subagentId) sessions.set(t.parent.subagentId, t);

  const details = new Map<number, ReturnType<typeof agentDetail>>();
  for (const c of parsed.calls) {
    if (!c.agentId) continue;
    const evs = src.agentEvents?.[c.agentId];
    const ses = sessions.get(c.agentId);
    if (evs || ses) details.set(c.ordinal, agentDetail(evs, ses));
  }
  const firstStart = Math.min(...parsed.calls.map((c) => c.startedAt ?? details.get(c.ordinal)?.startedAt ?? Infinity));
  const host = hostInfo(src.host, runId, Number.isFinite(firstStart) ? firstStart : undefined);

  // ---- run-level fields
  const recStart = n(record.startTime) ?? tsOf(record.startedAt) ?? tsOf(record.timestamp);
  const recDuration = n(record.durationMs);
  const recStatus = recordStatus(record.status) ?? recordStatus(parsed.status);
  const allResolved = parsed.calls.length > 0 && parsed.calls.every((c) => c.hasResult);
  let endedAt = recStart !== undefined && recDuration !== undefined ? recStart + recDuration : parsed.finishedAt ?? host.workflow?.end;
  const status: WorkflowRun["status"] = recStatus ?? (host.workflow?.ok === false ? "failed" : endedAt !== undefined || allResolved ? "ok" : "running");
  const runDone = status !== "running";

  // ---- agent nodes
  const meta = src.meta ?? {};
  const agents: WorkflowNode[] = [];
  const outputs: Record<string, unknown> = {};
  const childNodes: WorkflowNode[] = [];
  for (const c of parsed.calls) {
    const m = c.agentId ? (meta[c.agentId] ?? {}) : {};
    const d = details.get(c.ordinal);
    const h = c.agentId ? host.agents.get(c.agentId) : undefined;
    const node: WorkflowNode = {
      id: `${runId}/agent/${c.ordinal}`,
      runId,
      kind: "agent",
      name: c.label ?? s(m.description) ?? c.agentId ?? `agent ${c.ordinal}`,
      ordinal: c.ordinal,
      status: nodeStatus(c, runDone),
    };
    const phase = c.phase ?? s(m.workflowPhase) ?? s(m.phase);
    if (phase) node.phase = phase;
    const start = c.startedAt ?? h?.start ?? d?.startedAt;
    const end = c.endedAt ?? h?.end ?? (c.hasResult || runDone ? d?.endedAt : undefined);
    if (start !== undefined) node.startedAt = start;
    if (end !== undefined) node.endedAt = Math.max(end, start ?? end);
    if (c.issuedAt !== undefined) node.issuedAt = c.issuedAt;
    if (d?.sessionId) node.sessionId = d.sessionId;
    const model = d?.model ?? c.model ?? s(m.model);
    if (model) node.model = model;
    const effort = c.effort ?? s(m.effort);
    if (effort) node.effort = effort;
    if (d?.usage) node.usage = d.usage;
    if (d?.latency) node.latency = d.latency;
    if (d?.turns !== undefined) node.turns = d.turns;
    if (d?.toolCalls !== undefined) node.toolCalls = d.toolCalls;
    if (d?.toolErrors !== undefined) node.toolErrors = d.toolErrors;
    if (d) node.apiRetries = d.apiRetries;
    const declared = c.schema ?? (c.toolsUsed?.includes("StructuredOutput") || d?.schema.used === true);
    if (declared || d?.schema.attempts) {
      const attempts = d?.schema.attempts ?? 0;
      const valid = d?.schema.anySuccess === true || node.status === "ok" || node.status === "cached";
      node.schema = { declared: declared === true, attempts, failures: d?.schema.failures ?? 0, finalValid: declared ? valid : null };
    }
    if (c.key) node.inputHash = c.key;
    if (c.groupId) node.groupId = `${runId}/group/${c.groupId}`;
    if (c.groupKind) node.groupKind = c.groupKind;
    if (c.stage !== undefined) node.stage = c.stage;
    if (c.item !== undefined) node.item = c.item;
    if (c.error) node.error = c.error;
    else if (node.status === "failed" && !c.hasResult) node.error = "no result recorded";
    if (c.hasResult && c.result !== undefined && c.result !== null) outputs[node.id] = c.result;
    agents.push(node);
    if (opts.detail !== "agents" && c.agentId && src.agentEvents?.[c.agentId]) childNodes.push(...children(runId, node, src.agentEvents[c.agentId]!));
  }

  // ---- phases, groups, parents
  const declaredPhases = Array.isArray(record.phases)
    ? record.phases.map((p) => (isObj(p) ? s(p.title) ?? s(p.name) : s(p))).filter((p): p is string => !!p)
    : src.script
      ? scanPhases(src.script)
      : [];
  const phaseOrder = [...declaredPhases];
  for (const a of agents) if (a.phase && !phaseOrder.includes(a.phase)) phaseOrder.push(a.phase);

  const groups = new Map<string, WorkflowNode>();
  for (const a of agents) {
    if (!a.groupId) continue;
    const g: WorkflowNode = groups.get(a.groupId) ?? { id: a.groupId, runId, kind: "group", name: a.groupId.slice(a.groupId.lastIndexOf("/") + 1), groupId: a.groupId, status: "ok" };
    if (a.groupKind) g.groupKind ??= a.groupKind;
    if (a.phase) g.phase ??= a.phase;
    groups.set(a.groupId, g);
  }
  for (const g of inferGroups(runId, agents)) groups.set(g.id, g);
  for (const g of groups.values()) {
    const members = agents.filter((a) => a.groupId === g.id);
    const t = members.filter((m) => m.startedAt !== undefined);
    if (t.length) {
      g.startedAt = Math.min(...t.map((m) => m.startedAt!));
      g.endedAt = Math.max(...t.map((m) => m.endedAt ?? m.startedAt!));
    }
    if (members.some((m) => m.status === "failed")) g.status = "failed";
    if (members.length && members.every((m) => m.status === "cached")) g.status = "cached";
  }

  const wf: WorkflowNode = { id: runId, runId, kind: "workflow", name: "", status: status === "failed" || status === "aborted" ? "failed" : status === "running" ? "running" : "ok" };
  const phaseNodes = new Map<string, WorkflowNode>();
  for (const p of phaseOrder) {
    const members = agents.filter((a) => a.phase === p);
    if (!members.length) continue;
    const node: WorkflowNode = { id: `${runId}/phase/${p}`, runId, parentId: wf.id, kind: "phase", name: p, phase: p, status: members.some((m) => m.status === "failed") ? "failed" : members.every((m) => m.status === "cached") ? "cached" : "ok" };
    const t = members.filter((m) => m.startedAt !== undefined);
    if (t.length) {
      node.startedAt = Math.min(...t.map((m) => m.startedAt!));
      node.endedAt = Math.max(...t.map((m) => m.endedAt ?? m.startedAt!));
    }
    phaseNodes.set(p, node);
  }
  for (const g of groups.values()) g.parentId = (g.phase ? phaseNodes.get(g.phase)?.id : undefined) ?? wf.id;
  for (const a of agents) {
    const g = a.groupId ? groups.get(a.groupId) : undefined;
    const groupSize = g ? agents.filter((x) => x.groupId === g.id).length : 0;
    a.parentId = g && groupSize >= 2 ? g.id : ((a.phase ? phaseNodes.get(a.phase)?.id : undefined) ?? wf.id);
  }

  // ---- run
  const timed = agents.filter((a) => a.startedAt !== undefined);
  const startedAt = recStart ?? parsed.launchedAt ?? host.workflow?.start ?? (timed.length ? Math.min(...timed.map((a) => a.startedAt!)) : 0);
  if (endedAt === undefined && runDone && timed.length) endedAt = Math.max(...timed.map((a) => a.endedAt ?? a.startedAt!));
  const scriptPath = s(record.scriptPath) ?? parsed.scriptPath;
  const name = s(record.workflowName) ?? s(record.name) ?? (scriptPath ? basename(scriptPath).replace(/\.[cm]?[jt]s$/, "") : runId);
  wf.name = name;
  wf.startedAt = startedAt;
  if (endedAt !== undefined) wf.endedAt = endedAt;

  const run: WorkflowRun = {
    id: runId,
    framework: src.framework ?? "claude-code-workflow",
    name,
    startedAt,
    status,
    stats: undefined as unknown as WorkflowRun["stats"],
    tags: [],
    source: { kind: "journal" },
  };
  if (endedAt !== undefined) run.endedAt = endedAt;
  if (src.hostSessionId) run.hostSessionId = src.hostSessionId;
  const resumed = parsed.resumeFromRunId ?? s(record.resumeFromRunId) ?? s(record.resumedFrom);
  if (resumed) run.resumedFrom = resumed;
  if (src.script !== undefined) run.scriptHash = scriptHashOf(src.script);
  const args = "args" in record ? record.args : parsed.hasArgs ? parsed.args : isObj(host.workflow?.input) && "args" in host.workflow.input ? host.workflow.input.args : undefined;
  if (args !== undefined) run.argsHash = argsHashOf(args);
  const cap = src.concurrencyCap ?? n(record.concurrencyCap) ?? n(record.maxConcurrency) ?? n(record.concurrency);
  if (cap !== undefined) run.concurrencyCap = cap;
  if (phaseOrder.length) run.phases = phaseOrder;

  const nodes = [wf, ...phaseNodes.values(), ...groups.values(), ...agents, ...childNodes];
  run.stats = workflowStats(run, nodes, opts.base);
  const out: WorkflowTree = { run, nodes, outputs, unknownRecords: parsed.unknown };
  if ("result" in record) out.runOutput = record.result;
  return out;
}

/**
 * Builds the tree from whichever sources are present: a Claude Code journal
 * (with transcripts, meta and host events), or OTel span events.
 */
export function buildWorkflowTree(sources: TreeSources, opts: BuildOpts = {}): WorkflowTree {
  if (sources.journal !== undefined) return claudeTree(sources, opts);
  if (sources.spans?.length) {
    const t = otelTree(sources.spans, { ...(sources.runId ? { runId: sources.runId } : {}), ...(sources.framework ? { framework: sources.framework } : {}) });
    const nodes = opts.detail === "agents" ? t.nodes.filter((x) => x.kind !== "llm" && x.kind !== "tool") : t.nodes;
    const run: WorkflowRun = { ...t.run, stats: undefined as unknown as WorkflowRun["stats"] };
    if (sources.concurrencyCap !== undefined) run.concurrencyCap = sources.concurrencyCap;
    if (sources.script !== undefined) run.scriptHash = scriptHashOf(sources.script);
    // Agent usage was folded from llm children before filtering, so totals hold either way.
    run.stats = workflowStats(run, nodes, opts.base);
    return { run, nodes, outputs: {} };
  }
  throw new Error("buildWorkflowTree needs a journal or OTel spans");
}

/** Recomputes stats (e.g. once the resumed-from run is known). */
export function restat(t: { run: WorkflowRun; nodes: WorkflowNode[] }, base?: { run: WorkflowRun; nodes: WorkflowNode[] }): WorkflowRun {
  t.run.stats = workflowStats(t.run, t.nodes, base);
  return t.run;
}
