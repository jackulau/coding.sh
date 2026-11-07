// OTel span tree → workflow nodes (docs/WORKFLOWS.md §2.2).
//
// Input is what the receiver stored: AgentEvents carrying traceId, spanId and
// parentSpanId (src/otel/map.ts). One span maps to one or more events (an
// agent span gives subagent.start/end in the parent session plus the child
// session's own events), so events are grouped back by span id first.
//
//   root span                         workflow
//   invoke_agent                      agent (subagent when under an agent)
//   chat / text_completion / …        llm
//   execute_tool                      tool
//   framework step span               step, or handoff with from/to (otel-frameworks.ts)
//   other span with agent descendants phase, named after the span
//   other span                        dropped; its children move up to its parent
import type { AgentEvent, Usage } from "../../schema/index.ts";
import { addUsage, eventEnd, eventStart } from "../metrics.ts";
import type { WorkflowFramework, WorkflowNode, WorkflowRun } from "../types.ts";
import { frameworkOfScope, matchFrameworkSpan } from "./otel-frameworks.ts";

interface SpanInfo {
  spanId: string;
  traceId: string;
  parentSpanId?: string;
  events: AgentEvent[];
  start: number;
  end: number;
  kind: "root" | "llm" | "tool" | "agent" | "generic";
  name: string;
  scope?: string;
  attrs: Record<string, unknown>;
  ok: boolean;
  error?: string;
  usage?: Usage;
  model?: string;
  sessionId?: string;
  agentName?: string;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function spanInfo(spanId: string, events: AgentEvent[]): SpanInfo {
  const first = events[0]!;
  const info: SpanInfo = {
    spanId,
    traceId: first.traceId ?? "",
    events,
    start: Math.min(...events.map(eventStart)),
    end: Math.max(...events.map(eventEnd)),
    kind: "generic",
    name: "span",
    attrs: {},
    ok: true,
  };
  const parent = events.find((e) => e.parentSpanId)?.parentSpanId;
  if (parent) info.parentSpanId = parent;
  const has = (k: string) => events.find((e) => e.kind === k);
  const llm = has("llm.call");
  const toolStart = has("tool.start");
  const toolEnd = has("tool.end");
  const subStart = has("subagent.start");
  const subEnd = has("subagent.end");
  const rootStart = events.find((e) => e.kind === "session.start" && !e.parentSpanId && typeof e.payload.parentSessionId !== "string");
  const generic = has("span");
  if (rootStart && !info.parentSpanId) {
    info.kind = "root";
    info.name = str(rootStart.payload.name) ?? str(rootStart.payload.agentName) ?? "workflow";
    info.scope = str(rootStart.payload.scope);
    info.agentName = str(rootStart.payload.agentName);
    const end = has("turn.end");
    if (end && end.payload.ok === false) {
      info.ok = false;
      info.error = str(end.payload.error);
    }
  } else if (llm) {
    info.kind = "llm";
    info.name = str(llm.payload.name) ?? str(llm.payload.operation) ?? "llm";
    info.ok = llm.payload.ok !== false;
    info.error = str(llm.payload.error);
    if (llm.usage) info.usage = llm.usage;
    if (llm.model) info.model = llm.model;
  } else if (toolStart || toolEnd) {
    info.kind = "tool";
    info.name = str((toolStart ?? toolEnd)!.payload.tool) ?? "tool";
    info.ok = toolEnd ? toolEnd.payload.ok !== false : true;
    info.error = str(toolEnd?.payload.error);
  } else if (subStart || subEnd) {
    info.kind = "agent";
    info.name = str(subStart?.payload.type) ?? str(subStart?.payload.description) ?? "agent";
    info.ok = subEnd ? subEnd.payload.ok !== false : true;
    info.error = str(subEnd?.payload.error);
    info.sessionId = str(subStart?.payload.childSessionId) ?? str(subEnd?.payload.childSessionId);
  } else if (generic) {
    info.name = str(generic.payload.name) ?? "span";
    info.scope = str(generic.payload.scope);
    if (isObj(generic.payload.attributes)) info.attrs = generic.payload.attributes;
    info.ok = generic.payload.ok !== false;
    info.error = str(generic.payload.error);
  }
  // Errors recorded as span events (exceptions).
  const err = events.find((e) => e.kind === "error");
  if (err && !info.error) info.error = str(err.payload.message);
  return info;
}

export interface OtelTree {
  run: Omit<WorkflowRun, "stats">;
  nodes: WorkflowNode[];
}

/**
 * Builds one workflow tree from the events of one trace (or of several traces
 * sharing a workflow run id; each root then becomes a phase under a synthetic
 * workflow node).
 */
export function otelTree(events: readonly AgentEvent[], opts: { runId?: string; framework?: WorkflowFramework; name?: string } = {}): OtelTree {
  const bySpan = new Map<string, AgentEvent[]>();
  for (const e of events) {
    if (!e.spanId) continue;
    const key = `${e.traceId ?? ""}/${e.spanId}`;
    bySpan.set(key, [...(bySpan.get(key) ?? []), e]);
  }
  const spans = new Map<string, SpanInfo>();
  for (const [key, evs] of bySpan) spans.set(key, spanInfo(evs[0]!.spanId!, evs));
  const keyOf = (traceId: string, spanId: string) => `${traceId}/${spanId}`;
  const parentKey = (s: SpanInfo) => (s.parentSpanId ? keyOf(s.traceId, s.parentSpanId) : undefined);

  const children = new Map<string, SpanInfo[]>();
  const roots: SpanInfo[] = [];
  for (const s of spans.values()) {
    const p = parentKey(s);
    if (p && spans.has(p)) children.set(p, [...(children.get(p) ?? []), s]);
    else roots.push(s);
  }
  for (const list of children.values()) list.sort((a, b) => a.start - b.start || a.spanId.localeCompare(b.spanId));
  roots.sort((a, b) => a.start - b.start);

  const hasAgentDesc = new Map<string, boolean>();
  const agentBelow = (s: SpanInfo): boolean => {
    const k = keyOf(s.traceId, s.spanId);
    const cached = hasAgentDesc.get(k);
    if (cached !== undefined) return cached;
    let v = false;
    for (const c of children.get(k) ?? []) {
      const fm = c.kind === "generic" ? matchFrameworkSpan(c.scope, c.name, c.attrs) : undefined;
      if (c.kind === "agent" || fm?.kind === "step" || fm?.kind === "handoff" || agentBelow(c)) {
        v = true;
        break;
      }
    }
    hasAgentDesc.set(k, v);
    return v;
  };

  const firstRoot = roots[0];
  const traceId = firstRoot?.traceId ?? "";
  const runId = opts.runId ?? traceId ?? "otel-run";
  let framework: WorkflowFramework | undefined = opts.framework ?? frameworkOfScope(firstRoot?.scope);
  const nodes: WorkflowNode[] = [];
  const rootId = runId;
  const single = roots.length === 1 && firstRoot?.kind === "root";
  const wf: WorkflowNode = {
    id: rootId,
    runId,
    kind: "workflow",
    name: opts.name ?? (single ? firstRoot!.name : "workflow"),
    status: "ok",
  };
  if (roots.length) {
    wf.startedAt = Math.min(...roots.map((r) => r.start));
    wf.endedAt = Math.max(...roots.map((r) => r.end));
  }
  nodes.push(wf);
  const nodeId = (s: SpanInfo) => `${runId}/span/${s.traceId}/${s.spanId}`;

  const walk = (s: SpanInfo, parent: WorkflowNode, ctx: { inAgent: boolean; phase?: string }) => {
    let node: WorkflowNode | undefined;
    let next = ctx;
    const base = (kind: WorkflowNode["kind"], name: string): WorkflowNode => {
      const n: WorkflowNode = { id: nodeId(s), runId, parentId: parent.id, kind, name, startedAt: s.start, endedAt: s.end, status: s.ok ? "ok" : "failed" };
      if (ctx.phase) n.phase = ctx.phase;
      if (s.error && !s.ok) n.error = s.error;
      return n;
    };
    if (s.kind === "llm") {
      node = base("llm", s.name);
      if (s.usage) node.usage = s.usage;
      if (s.model) node.model = s.model;
    } else if (s.kind === "tool") {
      node = base("tool", s.name);
    } else if (s.kind === "agent") {
      node = base(ctx.inAgent ? "subagent" : "agent", s.name);
      if (s.sessionId) node.sessionId = s.sessionId;
      next = { ...ctx, inAgent: true };
    } else if (s.kind === "generic") {
      const fm = matchFrameworkSpan(s.scope, s.name, s.attrs);
      if (fm) framework ??= fm.framework;
      if (fm?.kind === "step" || fm?.kind === "handoff") {
        node = base(fm.kind, fm.name ?? s.name);
        if (fm.from) node.from = fm.from;
        if (fm.to) node.to = fm.to;
        if (fm.stage !== undefined) node.stage = fm.stage;
        if (fm.item !== undefined) node.item = fm.item;
        if (fm.kind === "step") next = { ...ctx, inAgent: true };
      } else if (!ctx.inAgent && (fm?.kind === "phase" || agentBelow(s))) {
        node = base("phase", fm?.name ?? s.name);
        node.phase = node.name;
        next = { ...ctx, phase: node.name };
      }
    } else if (s.kind === "root") {
      // A second root (multi-trace run) becomes a phase.
      node = base("phase", s.name);
      node.phase = s.name;
      next = { ...ctx, phase: s.name };
      framework ??= frameworkOfScope(s.scope);
    }
    if (node) nodes.push(node);
    for (const c of children.get(keyOf(s.traceId, s.spanId)) ?? []) walk(c, node ?? parent, next);
  };

  if (single) {
    const r = firstRoot!;
    if (!r.ok) wf.status = "failed";
    if (r.error) wf.error = r.error;
    // A root that is itself an agent with no agent below it: one agent node holds its calls.
    const rootIsLoneAgent = r.agentName !== undefined && !agentBelow(r);
    let parent = wf;
    if (rootIsLoneAgent) {
      const a: WorkflowNode = { id: `${runId}/agent/root`, runId, parentId: wf.id, kind: "agent", name: r.agentName!, startedAt: r.start, endedAt: r.end, status: r.ok ? "ok" : "failed" };
      nodes.push(a);
      parent = a;
    }
    for (const c of children.get(keyOf(r.traceId, r.spanId)) ?? []) walk(c, parent, { inAgent: rootIsLoneAgent });
  } else {
    for (const r of roots) walk(r, wf, { inAgent: false });
  }

  // Agent usage = its own llm calls (not those of nested subagents).
  const byParent = new Map<string, WorkflowNode[]>();
  for (const x of nodes) if (x.parentId) byParent.set(x.parentId, [...(byParent.get(x.parentId) ?? []), x]);
  for (const a of nodes) {
    if (a.kind !== "agent" && a.kind !== "subagent" && a.kind !== "step") continue;
    const u: Usage = {};
    let calls = 0;
    let tools = 0;
    let toolErrors = 0;
    let retries = 0;
    const stack = [...(byParent.get(a.id) ?? [])];
    while (stack.length) {
      const c = stack.pop()!;
      if (c.kind === "agent" || c.kind === "subagent" || c.kind === "step") continue;
      if (c.kind === "llm") {
        calls++;
        addUsage(u, c.usage);
        if (c.status === "failed") retries++;
        if (c.model) a.model ??= c.model;
      }
      if (c.kind === "tool") {
        tools++;
        if (c.status === "failed") toolErrors++;
      }
      stack.push(...(byParent.get(c.id) ?? []));
    }
    if (Object.keys(u).length) a.usage = u;
    a.toolCalls = tools;
    a.toolErrors = toolErrors;
    a.apiRetries = retries;
    if (calls) a.latency = { llmCalls: calls };
  }
  // Agent ordinals by start time, so replay/prefix logic has an order.
  nodes
    .filter((x) => x.kind === "agent" || x.kind === "step")
    .sort((x, y) => (x.startedAt ?? 0) - (y.startedAt ?? 0) || x.id.localeCompare(y.id))
    .forEach((x, i) => (x.ordinal = i));

  const run: Omit<WorkflowRun, "stats"> = {
    id: runId,
    framework: framework ?? "otel",
    name: wf.name,
    startedAt: wf.startedAt ?? 0,
    status: wf.status === "failed" ? "failed" : "ok",
    tags: [],
    source: { kind: "otel", path: traceId },
  };
  if (wf.endedAt !== undefined) run.endedAt = wf.endedAt;
  const phases = nodes.filter((x) => x.kind === "phase").map((x) => x.name);
  if (phases.length) run.phases = [...new Set(phases)];
  return { run, nodes };
}

/** Groups receiver events by workflow run: trace id, or the CODING_SH_WORKFLOW_RUN_ID carried as runId. */
export function splitTraces(events: readonly AgentEvent[]): Map<string, AgentEvent[]> {
  const out = new Map<string, AgentEvent[]>();
  for (const e of events) {
    if (!e.spanId) continue;
    const key = e.runId ?? e.traceId ?? "";
    out.set(key, [...(out.get(key) ?? []), e]);
  }
  return out;
}
