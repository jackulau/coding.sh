// OTel span tree → workflow nodes (docs/design/workflows.md §2.2).
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
//
// Durable workflow runs (spans tagged by src/otel/durable.ts, often many traces
// from many processes) are one tree: each step attempt is a step node with its
// attempt number, an attempt the engine never reported (its process died) is a
// lost step node, sleeps and waits are wait nodes, and the engine's own
// run/schedule/invocation spans are dropped like other spans.
import { durableStats } from "../../core/durable.ts";
import type { DurableTag } from "../../otel/durable.ts";
import type { AgentEvent, DurableStats, Usage } from "../../schema/index.ts";
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
  durable?: DurableTag;
}

/** Workflow framework of a durable engine id (DurableTag.engine). */
function engineFramework(engine: string): WorkflowFramework {
  if (engine === "vercel-workflow") return "vercel-workflow";
  if (engine === "temporal" || engine === "inngest" || engine === "restate" || engine === "dbos" || engine === "langgraph") return engine;
  return "otel";
}

interface AttemptInfo {
  /** The step's name. */
  name: string;
  n: number;
  attempts: number;
  ok: boolean;
  startedAt: number;
  endedAt: number;
  error?: string;
  replay?: boolean;
  resume?: WorkflowNode["resume"];
  instance?: string;
  /** Inferred time of the attempt before this one, which was never reported. */
  lostMs?: number;
  /** Of lostMs, how long its process was still seen working. */
  ranMs?: number;
  /** Earlier attempts inside the same span (DBOS retries a step within one span; a Restate invocation attempt runs several). */
  before?: AttemptInfo[];
}

/** Step attempts of a durable run by span id, with the step's attempt count and where the run resumed. */
function attemptsBySpan(d: DurableStats): Map<string, AttemptInfo> {
  const bySpan = new Map<string, AttemptInfo[]>();
  for (const step of d.steps) {
    const attempts = Math.max(0, ...step.attempts.map((a) => a.n));
    step.attempts.forEach((a, i) => {
      if (!a.spanId) return;
      const info: AttemptInfo = { name: step.name, n: a.n, attempts, ok: a.ok, startedAt: a.startedAt, endedAt: a.endedAt };
      if (a.error) info.error = a.error;
      if (a.replay) info.replay = true;
      if (a.instance) info.instance = a.instance;
      if (i === 0 && step.unreportedMs !== undefined && a.n > 1) {
        info.lostMs = step.unreportedMs;
        if (step.unreportedRanMs !== undefined) info.ranMs = step.unreportedRanMs;
      }
      bySpan.set(a.spanId, [...(bySpan.get(a.spanId) ?? []), info]);
    });
  }
  // Attempts sharing a span (DBOS retries, a Restate invocation attempt's runs):
  // the latest holds the others, and the resume belongs to the first.
  const out = new Map<string, AttemptInfo>();
  for (const [spanId, infos] of bySpan) {
    infos.sort((x, y) => x.startedAt - y.startedAt);
    // A crash, deploy or restart says more than the wait that may end at the same attempt.
    const resume = d.resumes.filter((r) => r.spanId === spanId).sort((x, y) => Number(x.reason === "wait") - Number(y.reason === "wait"))[0];
    if (resume) infos[0]!.resume = resume.reason;
    const latest = infos.pop()!;
    if (infos.length) latest.before = infos;
    out.set(spanId, latest);
  }
  return out;
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
  const durable = events.find((e) => isObj(e.payload.durable))?.payload.durable;
  if (durable) info.durable = durable as DurableTag;
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

  const durable = [...spans.values()].some((s) => s.durable) ? durableStats(events) : undefined;
  const attemptOf = durable ? attemptsBySpan(durable) : new Map<string, AttemptInfo>();

  const firstRoot = roots[0];
  const traceId = firstRoot?.traceId ?? "";
  const runId = opts.runId ?? traceId ?? "otel-run";
  let framework: WorkflowFramework | undefined = opts.framework ?? (durable ? engineFramework(durable.engine) : frameworkOfScope(firstRoot?.scope));
  const nodes: WorkflowNode[] = [];
  const rootId = runId;
  const single = roots.length === 1 && firstRoot?.kind === "root";
  const wf: WorkflowNode = {
    id: rootId,
    runId,
    kind: "workflow",
    name: opts.name ?? durable?.workflow ?? (single ? firstRoot!.name : "workflow"),
    status: "ok",
  };
  // A durable run outlives any one span (the client's start span ends at once): it spans all of them.
  const extent = durable ? [...spans.values()] : roots;
  if (extent.length) {
    wf.startedAt = Math.min(...extent.map((r) => r.start));
    wf.endedAt = Math.max(...extent.map((r) => r.end));
  }
  nodes.push(wf);
  const nodeId = (s: SpanInfo) => `${runId}/span/${s.traceId}/${s.spanId}`;

  const walk = (s: SpanInfo, parent: WorkflowNode, ctx: { inAgent: boolean; phase?: string }) => {
    let node: WorkflowNode | undefined;
    // Earlier attempts split out of this span; a child goes under the one it started in.
    const parts: WorkflowNode[] = [];
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
    } else if (s.durable) {
      // A step attempt is a step node; the engine's other spans (start, run,
      // schedule, invocation, waits, a step's inner spans) are dropped, unless
      // the engine records attempts on them (a Restate invocation attempt's journal).
      const a = s.durable.role === "step" || s.durable.role === "invocation" ? attemptOf.get(s.spanId) : undefined;
      if (a) {
        const name = (i: AttemptInfo) => (s.durable!.role === "step" ? (s.durable!.step ?? s.name) : i.name);
        const lostBefore = (i: AttemptInfo, at: number) => {
          if (i.lostMs === undefined) return;
          // It counts as work only until its process was last seen; the rest is downtime.
          const ran = Math.min(i.ranMs ?? i.lostMs, i.lostMs);
          const lost: WorkflowNode = { ...base("step", name(i)), id: i === (a.before?.[0] ?? a) ? `${nodeId(s)}/lost` : `${nodeId(s)}/${i.name}/${i.n}/lost`, startedAt: at - i.lostMs, endedAt: at - i.lostMs + ran, status: "failed", attempt: i.n - 1, attempts: i.attempts, lost: true };
          if (i.lostMs > ran) lost.lostMs = i.lostMs - ran;
          lost.error = "never reported: the process running it stopped";
          nodes.push(lost);
        };
        lostBefore(a.before?.[0] ?? a, s.start);
        for (const [k, b] of (a.before ?? []).entries()) {
          if (k > 0) lostBefore(b, b.startedAt);
          const id = s.durable.role === "invocation" ? `${nodeId(s)}/${b.name}/${b.n}` : `${nodeId(s)}/${b.n}`;
          const part: WorkflowNode = { ...base("step", name(b)), id, startedAt: b.startedAt, endedAt: b.endedAt, attempt: b.n, attempts: b.attempts, status: b.ok ? "ok" : "failed" };
          if (!b.ok && b.error) part.error = b.error;
          else delete part.error;
          if (b.resume) part.resume = b.resume;
          if (b.instance) part.instance = b.instance;
          parts.push(part);
          nodes.push(part);
        }
        if (a.before?.length) lostBefore(a, a.startedAt);
        node = base("step", name(a));
        if (parts.length || s.durable.role === "invocation") {
          node.startedAt = a.startedAt;
          node.endedAt = a.endedAt;
          // The span's outcome is its last attempt's (a Restate attempt that ran search, then failed in read).
          if (a.ok) {
            node.status = "ok";
            delete node.error;
          }
        }
        node.attempt = a.n;
        node.attempts = a.attempts;
        // The attempt's outcome as core/durable.ts read it (Vercel leaves a failed attempt's span OK).
        if (!a.ok) {
          node.status = "failed";
          if (a.error) node.error = a.error;
        }
        if (a.replay) node.status = "cached";
        if (a.resume) node.resume = a.resume;
        if (a.instance) node.instance = a.instance;
        // A framework step that is also durable (a LangGraph node in a checkpointed thread) keeps its superstep.
        const fm = matchFrameworkSpan(s.scope, s.name, s.attrs);
        if (fm) framework ??= fm.framework;
        if (fm?.stage !== undefined) node.stage = fm.stage;
        if (fm?.item !== undefined) node.item = fm.item;
        next = { ...ctx, inAgent: true };
      }
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
    } else if (s.kind === "root" && !durable) {
      // A second root (multi-trace run) becomes a phase. A durable run's
      // roots are its invocations (HTTP handlers, queue consumers): dropped.
      node = base("phase", s.name);
      node.phase = s.name;
      next = { ...ctx, phase: s.name };
      framework ??= frameworkOfScope(s.scope);
    }
    if (node) nodes.push(node);
    for (const c of children.get(keyOf(s.traceId, s.spanId)) ?? []) walk(c, parts.find((p) => c.start < p.endedAt!) ?? node ?? parent, next);
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

  // Durable sleeps and waits: gaps in the run, not work.
  durable?.waits.forEach((w, i) => {
    const n: WorkflowNode = { id: `${runId}/wait/${i}`, runId, parentId: wf.id, kind: "wait", name: w.name ?? "wait", startedAt: w.startedAt, status: w.endedAt === undefined ? "running" : "ok" };
    if (w.endedAt !== undefined) n.endedAt = w.endedAt;
    nodes.push(n);
  });

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
