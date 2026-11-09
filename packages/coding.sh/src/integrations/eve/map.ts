// Eve spans → coding.sh/trace semantics.
//
// The generic OTLP mapper (src/otel/map.ts) already turns eve's GenAI-semconv
// spans into llm.call / tool.* / turn events. What it can't know is eve's
// session model, which enrichFromEve layers on top, one span at a time:
//
//   session   = one eve session (agent.run.id, the HTTP API's sessionId), not the
//               conversation: gen_ai.conversation.id is shared by a root session
//               and all of its subagents, so keying on it would merge them.
//   turn      = one invoke_agent span (one trace; turnId stays the traceId).
//               session.start only for the first turn (agent.turn.sequence 0),
//               never a session.end per turn: an eve session outlives its turns.
//   subagent  = the caller's `execute_tool <name>` span (agent.action.kind
//               subagent-call | remote-agent-call) gains subagent.start/end; the
//               child's own invoke_agent becomes a child session whose
//               session.start carries { parentSessionId, parentEventId,
//               subagentId, subagentType } so ingest sets Session.parent.
//   step      = agent.step → a compact notification { type: "eve.step" } with
//               the step's reported agent.usage.* (kept out of `usage`: the
//               chat spans below it already count those tokens).
//   llm.call  = chat <model> spans, unchanged (usage, latency, ttft, stop reason).
//   workflow  = Workflow SDK infrastructure spans ("workflow" scope) are dropped.
//
// Event ids stay deterministic: replaced events keep the generic mapper's slot
// ids, and new ones use spanEventId(traceId, spanId, slot) with slots 20+.
import type { AgentEvent } from "../../schema/index.ts";
import type { Attrs, OtelScope, OtelSpan } from "../../otel/model.ts";
import { spanEventId } from "../../otel/map.ts";
import { A, AGENT_CALL_KINDS, bool, isEveSpan, isWorkflowInfraSpan, num, str } from "./attrs.ts";

export const EVE_AGENT_ID = "eve";

/** Extra slots enrichFromEve emits (the generic mapper uses 0-6 and 100+). */
export const EVE_SLOTS = { subagentStart: 20, subagentEnd: 21 } as const;

export interface EveEnrichInfo {
  scope?: Pick<OtelScope, "name">;
  resource?: Attrs;
}

export interface EveEnrichOptions {
  /** Keep Workflow SDK infrastructure spans instead of dropping them. Default false. */
  keepWorkflowSpans?: boolean;
}

/** Eve session id of a span (agent.run.id), when it is an eve span. */
export function eveSessionId(span: OtelSpan): string | undefined {
  return str(span.attributes, A.runId);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The span is part of a durable run's shape (see src/otel/durable.ts), not plumbing:
 * a delivery, the workflow function, a step attempt, a wait or a recovery. The
 * client-side `workflow.start` stays dropped: the first delivery opens the run
 * anyway, and an eve session opens with its own agent span. The bare
 * `step.execute` inside each attempt has no attributes but is the parent of
 * the step's own spans (model calls): dropping it would orphan them.
 */
function durableShape(span: OtelSpan, events: AgentEvent[]): boolean {
  if (span.name === "step.execute" && span.parentSpanId) return true;
  const d = events[0]?.payload.durable;
  if (!isObj(d)) return false;
  return d.orphan === true || d.role === "invocation" || d.role === "orchestrate" || d.role === "step" || d.role === "wait";
}

function parseJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (!(t.startsWith("{") || t.startsWith("[") || t.startsWith('"'))) return v;
  try {
    return JSON.parse(t);
  } catch {
    return v;
  }
}

function setIf(p: Record<string, unknown>, key: string, v: unknown): void {
  if (v !== undefined && v !== null && v !== "") p[key] = v;
}

/** agent.usage.* from a step or tool span (reported totals, never summed into Session usage). */
function reportedUsage(a: Attrs): Record<string, number> | undefined {
  const u: Record<string, number> = {};
  const put = (k: string, v: number | undefined) => {
    if (v !== undefined) u[k] = v;
  };
  put("inputTokens", num(a, A.usageInput));
  put("outputTokens", num(a, A.usageOutput));
  put("cacheReadTokens", num(a, A.usageCacheRead));
  put("cacheWriteTokens", num(a, A.usageCacheWrite));
  put("costUsd", num(a, A.usageCost));
  return Object.keys(u).length ? u : undefined;
}

/** Copies the content keys of a generic payload under new names (keeps blob refs and the truncation flag). */
function moveContent(from: Record<string, unknown> | undefined, fromKey: string, to: Record<string, unknown>, toKey: string): void {
  if (!from) return;
  setIf(to, toKey, from[fromKey]);
  setIf(to, `${toKey}Blob`, from[`${fromKey}Blob`]);
  if (from.truncated === true && from[fromKey] !== undefined) to.truncated = true;
}

/**
 * Enrich the events the OTLP mapper produced for one span with eve semantics.
 * Pure and synchronous; returns a new list (never mutates `events`). Spans
 * that are not eve's are returned unchanged, except Workflow SDK
 * infrastructure spans, which are dropped (`[]`) unless keepWorkflowSpans.
 * Spans that tell the shape of a durable run (start, deliveries, steps,
 * waits, recovery; tagged payload.durable by the mapper) are kept: they join
 * the run's session (workflow.run.id, which is also eve's agent.run.id).
 *
 * Signature-compatible with MapContext.enrichSpan in src/otel/map.ts.
 */
export function enrichFromEve(span: OtelSpan, events: AgentEvent[], info: EveEnrichInfo = {}, opts: EveEnrichOptions = {}): AgentEvent[] {
  if (isWorkflowInfraSpan(span, info.scope)) return opts.keepWorkflowSpans || durableShape(span, events) ? events : [];
  if (!isEveSpan(span, info.scope)) return events;

  const a = span.attributes;
  const runId = str(a, A.runId);
  const frameworkVersion = str(a, A.frameworkVersion);
  // Agent Runs (@vercel/agent-runs) writes these spans for other hosts too:
  // durable-harness names itself in its resource (agent.framework.name).
  const host = (info.resource && str(info.resource, A.frameworkName)) ?? str(a, A.frameworkName);
  const agent = host && /^[a-z0-9][a-z0-9-]*$/.test(host) ? host : EVE_AGENT_ID;
  const rekey = (e: AgentEvent): AgentEvent => {
    const out: AgentEvent = { ...e, payload: { ...e.payload }, agent };
    if (runId) out.sessionId = runId;
    if (!out.agentVersion && frameworkVersion) out.agentVersion = frameworkVersion;
    return out;
  };
  const evs = events.map(rekey);
  const op = str(a, A.operation);

  if (op === "invoke_agent" || span.name === "invoke_agent" || span.name.startsWith("invoke_agent ")) return activation(span, evs);
  if (op === "execute_tool") return toolCall(span, evs);
  if (span.name === "agent.step") return compactNotification(evs, stepPayload(span));
  if (span.name === "agent.approval") return compactNotification(evs, approvalPayload(span));
  return evs;
}

const CALLER_MESSAGE = "\nCaller message:\n";

function deliveredMessage(a: OtelSpan["attributes"]): string | undefined {
  const input = parseJson(str(a, A.deliveryInput));
  if (typeof input === "string") return input || undefined;
  return isObj(input) && typeof input.message === "string" && input.message ? input.message : undefined;
}

/** invoke_agent: one turn of an eve session (root or child). */
function activation(span: OtelSpan, evs: AgentEvent[]): AgentEvent[] {
  const a = span.attributes;
  const traceId = span.traceId!;
  const spanId = span.spanId!;
  const seq = num(a, A.turnSequence);
  const parentRunId = str(a, A.parentRunId);
  const isChild = str(a, A.runType) === "subagent" || parentRunId !== undefined;
  const byKind = (k: AgentEvent["kind"]) => evs.find((e) => e.kind === k);
  // The generic mapper emits session.start/user.message/turn.end for a root span,
  // and subagent.start/end when the child's first turn joined the caller's trace.
  const startLike = byKind("session.start") ?? byKind("subagent.start");
  const endLike = byKind("turn.end") ?? byKind("subagent.end");
  const userMsg = byKind("user.message");
  const template = startLike ?? endLike ?? evs[0];
  if (!template) return evs;
  const base = (): AgentEvent => {
    const e: AgentEvent = { ...template, payload: {} };
    delete e.subagentId;
    delete e.usage;
    delete e.durationMs;
    delete e.model;
    return e;
  };
  const out: AgentEvent[] = [];
  const startMs = startLike?.ts ?? template.ts;
  const endMs = endLike?.ts ?? template.ts;

  // session.start: only for the session's first turn (or when the sequence is unknown).
  if (seq === undefined || seq === 0) {
    const p: Record<string, unknown> = {};
    setIf(p, "name", span.name);
    setIf(p, "agentName", str(a, A.agentName) ?? str(a, A.genAiAgentName));
    setIf(p, "traceId", traceId);
    setIf(p, "conversationId", str(a, A.conversationId));
    setIf(p, "runType", str(a, A.runType));
    setIf(p, "channel", str(a, A.channelName) ?? str(a, A.channelKind));
    setIf(p, "origin", str(a, A.sessionOrigin));
    setIf(p, "audience", str(a, A.channelAudience));
    if (isChild) {
      setIf(p, "parentSessionId", parentRunId);
      if (span.parentSpanId) p.parentEventId = spanEventId(traceId, span.parentSpanId, 0);
      setIf(p, "subagentId", str(a, A.parentCallId));
      setIf(p, "subagentType", str(a, A.subagentName) ?? str(a, A.agentName));
    }
    out.push({ ...base(), id: spanEventId(traceId, spanId, 0), kind: "session.start", ts: startMs, payload: p });
  }

  // user.message: this turn's input. The generic mapper takes it from
  // gen_ai.input.messages, which from the second turn on is the whole
  // history, so prefer the delivery's own input. For a child, eve frames the
  // caller's message ("You are the subagent ... Caller message:\n<msg>"); keep <msg>.
  const um: Record<string, unknown> = {};
  const delivered = deliveredMessage(a);
  if (delivered !== undefined) {
    const cut = isChild ? delivered.lastIndexOf(CALLER_MESSAGE) : -1;
    um.text = cut >= 0 ? delivered.slice(cut + CALLER_MESSAGE.length) : delivered;
    if (cut >= 0) um.framed = true;
  } else if (userMsg) Object.assign(um, userMsg.payload);
  else if (startLike?.kind === "subagent.start") moveContent(startLike.payload, "prompt", um, "text");
  if (um.text !== undefined) out.push({ ...base(), id: userMsg?.id ?? spanEventId(traceId, spanId, 2), kind: "user.message", ts: userMsg?.ts ?? startMs, payload: um });

  // turn.end: outcome, reply, wall time, reported usage.
  if (endLike) {
    const p: Record<string, unknown> = {};
    const g = endLike.payload;
    setIf(p, "ok", g.ok);
    setIf(p, "error", g.error);
    setIf(p, "outcome", str(a, A.turnOutcome));
    setIf(p, "eveTurnId", str(a, A.turnId));
    setIf(p, "turnSequence", seq);
    setIf(p, "durationMs", endLike.durationMs ?? g.durationMs);
    if (endLike.kind === "subagent.end") moveContent(g, "result", p, "output");
    else moveContent(g, "output", p, "output");
    setIf(p, "reportedUsage", g.reportedUsage);
    const e: AgentEvent = { ...base(), id: spanEventId(traceId, spanId, 1), kind: "turn.end", ts: endMs, payload: p };
    if (endLike.durationMs !== undefined) e.durationMs = endLike.durationMs;
    out.push(e);
  }

  // Keep span-event errors (exceptions); drop the generic session.end (a turn never ends an eve session).
  for (const e of evs) if (e.kind === "error") out.push(e);
  return out;
}

/** execute_tool: annotate the tool events; agent dispatches also get subagent.start/end. */
function toolCall(span: OtelSpan, evs: AgentEvent[]): AgentEvent[] {
  const a = span.attributes;
  const kind = str(a, A.actionKind);
  const outcome = str(a, A.actionOutcome);
  const out = evs.map((e) => {
    if (e.kind === "tool.start") {
      setIf(e.payload, "actionKind", kind);
      setIf(e.payload, "framework", bool(a, A.isFrameworkTool));
      setIf(e.payload, "eveTurnId", str(a, A.turnId));
      setIf(e.payload, "stepIndex", num(a, A.stepIndex));
    } else if (e.kind === "tool.end") {
      setIf(e.payload, "outcome", outcome);
      setIf(e.payload, "errorType", str(a, A.errorType));
      const reported = reportedUsage(a);
      if (reported) e.payload.reportedUsage = reported;
    }
    return e;
  });
  if (!kind || !AGENT_CALL_KINDS.has(kind)) return out;

  const start = out.find((e) => e.kind === "tool.start");
  const end = out.find((e) => e.kind === "tool.end");
  const template = start ?? end;
  if (!template) return out;
  const traceId = span.traceId!;
  const spanId = span.spanId!;
  const subagentId = str(a, A.toolCallId) ?? spanId;
  const type = str(a, A.toolName) ?? str(a, A.actionName);
  const base = (): AgentEvent => {
    const e: AgentEvent = { ...template, payload: {}, subagentId };
    delete e.durationMs;
    delete e.usage;
    return e;
  };

  const sp: Record<string, unknown> = { subagentId };
  setIf(sp, "type", type);
  if (kind === "remote-agent-call") sp.remote = true;
  const input = parseJson(start?.payload.input);
  if (isObj(input) && typeof input.message === "string") sp.prompt = input.message;
  else moveContent(start?.payload, "input", sp, "prompt");
  if (isObj(input) && typeof input.taskId === "string") sp.taskId = input.taskId;
  out.push({ ...base(), id: spanEventId(traceId, spanId, EVE_SLOTS.subagentStart), kind: "subagent.start", ts: start?.ts ?? template.ts, payload: sp });

  if (end) {
    const ep: Record<string, unknown> = { subagentId };
    setIf(ep, "ok", end.payload.ok);
    setIf(ep, "outcome", outcome);
    setIf(ep, "error", end.payload.error);
    moveContent(end.payload, "output", ep, "result");
    // eve records the subagent's reply as a JSON string ("\"text\""); keep the text.
    if (end.payload.truncated !== true && typeof ep.result === "string") {
      const r = parseJson(ep.result);
      if (typeof r === "string") ep.result = r;
    }
    const reported = reportedUsage(a);
    if (reported) ep.reportedUsage = reported;
    const e: AgentEvent = { ...base(), id: spanEventId(traceId, spanId, EVE_SLOTS.subagentEnd), kind: "subagent.end", ts: end.ts, payload: ep };
    if (end.durationMs !== undefined) e.durationMs = end.durationMs;
    out.push(e);
  }
  return out;
}

function stepPayload(span: OtelSpan): Record<string, unknown> {
  const a = span.attributes;
  const p: Record<string, unknown> = { type: "eve.step", name: span.name };
  setIf(p, "eveTurnId", str(a, A.turnId));
  setIf(p, "stepIndex", num(a, A.stepIndex));
  setIf(p, "attempt", num(a, A.stepAttempt));
  setIf(p, "agentName", str(a, A.agentName));
  setIf(p, "model", str(a, A.modelId));
  setIf(p, "reportedUsage", reportedUsage(a));
  setIf(p, "affinity", str(a, "vercel.ai_gateway.affinity.outcome"));
  return p;
}

function approvalPayload(span: OtelSpan): Record<string, unknown> {
  const a = span.attributes;
  const p: Record<string, unknown> = { type: "eve.approval", name: span.name };
  setIf(p, "kind", str(a, A.approvalKind));
  setIf(p, "outcome", str(a, A.approvalOutcome));
  setIf(p, "toolUseId", str(a, A.toolCallId));
  setIf(p, "tool", str(a, A.actionName));
  setIf(p, "requestId", str(a, A.approvalRequestId));
  setIf(p, "connection", str(a, A.connectionName));
  setIf(p, "eveTurnId", str(a, A.turnId));
  return p;
}

/** Replace the generic { type: "span", attributes } notification with a compact eve payload. */
function compactNotification(evs: AgentEvent[], payload: Record<string, unknown>): AgentEvent[] {
  return evs.map((e) => {
    // The generic mapper keeps a span it has no mapping for as kind "span".
    if (e.kind !== "notification" && e.kind !== "span") return e;
    const p: Record<string, unknown> = { ...payload };
    setIf(p, "ok", e.payload.ok);
    setIf(p, "error", e.payload.error);
    return { ...e, kind: "notification", payload: p };
  });
}
