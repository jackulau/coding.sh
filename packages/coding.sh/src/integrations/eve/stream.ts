// eve session stream (NDJSON, stream version 27) → coding.sh events.
//
// `GET /eve/v1/session/:id/stream` serves the session's stored lines:
//   {"at": "...", "facts": [{type, data, scope}, ...]}   event line
//   {"progress": {...}}                                  progress record (text deltas)
//   {"$eve": "heartbeat" | "stream.lease-ended" | "stream.ended"}   transport, not stored
// Stored lines (event lines and progress records) are numbered from 0; eve's
// own readers key events on (sessionId, line, index), and so do we, so
// mapping the same stream twice yields the same ids.
//
// This is what the eval task wrapper (task.ts) hands graders as the trace. It
// needs no telemetry setup. For persistent capture prefer OTel (map.ts):
// the two paths describe the same work with different ids, so ingest one per
// session, not both.
import type { AgentEvent, EventKind, Usage, UsageNumberKey } from "../../schema/index.ts";
import { SCHEMA_VERSION } from "../../schema/index.ts";
import { hashParts } from "../../core/ids.ts";
import { EVE_AGENT_ID } from "./map.ts";

export interface EveFact {
  type: string;
  data?: Record<string, unknown>;
  scope?: Record<string, unknown>;
}

export interface EveStreamLine {
  at?: string;
  facts?: EveFact[];
  progress?: unknown;
  $eve?: string;
}

export interface EveStreamOptions {
  /** The eve session id (wrun_…) the stream belongs to. */
  sessionId: string;
  /** Set when this is a child session's stream: becomes session.start's parent link. */
  parentSessionId?: string;
  /** callId of the parent's subagent call (the parent's subagent.start subagentId). */
  subagentId?: string;
  subagentType?: string;
  /** Text longer than this is cut (default 4000 chars). */
  maxText?: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const s = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const n = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Transport records (heartbeats, lease ends) are not stored lines and have no position. */
export function isTransportRecord(line: EveStreamLine): boolean {
  return typeof line.$eve === "string";
}

function usageOf(v: unknown): Usage | undefined {
  if (!isObj(v)) return undefined;
  const u: Usage = {};
  const map: [UsageNumberKey, string][] = [
    ["inputTokens", "inputTokens"],
    ["outputTokens", "outputTokens"],
    ["cacheReadTokens", "cacheReadTokens"],
    ["cacheWriteTokens", "cacheWriteTokens"],
    ["costUsd", "costUsd"],
  ];
  for (const [k, src] of map) {
    const x = n(v[src]);
    if (x !== undefined) u[k] = x;
  }
  return Object.keys(u).length ? u : undefined;
}

function textOf(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p): p is Record<string, unknown> => isObj(p) && p.kind === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n");
}

interface PendingCall {
  tool: string;
  kind: string;
  ts: number;
  turnId?: string;
  startEventId: string;
}

/**
 * Incremental mapper: feed stored lines in order with `push`. Events that a
 * later fact in the same line completes (llm.call + its usage.recorded,
 * subagent.end + the child's usage) are emitted at the end of that line.
 */
export class EveStreamMapper {
  readonly sessionId: string;
  /** Stored lines seen so far: the `startIndex` to resume this stream from. */
  position = 0;
  /** Reply text per eve turn id ("turn_0"), from turn.settled's reply part ids. */
  readonly replies = new Map<string, string>();
  readonly deliveryOutcomes = new Map<string, { outcome: string; turnId?: string }>();
  ended = false;
  private opts: EveStreamOptions;
  private agentVersion?: string;
  private agentName?: string;
  private turnStart = new Map<string, number>();
  private turnTrace = new Map<string, string>();
  private models = new Map<string, { ts: number; modelId?: string; attempt?: number; turnId?: string }>();
  private calls = new Map<string, PendingCall>();
  private children = new Map<string, string>();
  private parts = new Map<string, string>();
  private held = new Map<string, AgentEvent>();

  constructor(opts: EveStreamOptions) {
    this.opts = opts;
    this.sessionId = opts.sessionId;
  }

  private cut(t: string): string {
    const max = this.opts.maxText ?? 4000;
    return t.length > max ? `${t.slice(0, max)}…` : t;
  }

  private ev(kind: EventKind, pos: string, ts: number, payload: Record<string, unknown>, extra: Partial<AgentEvent> = {}): AgentEvent {
    const e: AgentEvent = {
      id: hashParts("eve-stream", this.sessionId, pos, kind),
      v: SCHEMA_VERSION,
      sessionId: this.sessionId,
      ts,
      source: "eve-stream",
      agent: EVE_AGENT_ID,
      kind,
      payload,
      ...extra,
    };
    if (this.agentVersion && !e.agentVersion) e.agentVersion = this.agentVersion;
    if (e.turnId) {
      const trace = this.turnTrace.get(e.turnId);
      if (trace && !e.traceId) e.traceId = trace;
    }
    return e;
  }

  /** Map one stored line (or skip a transport record). Returns the events it completes. */
  push(line: EveStreamLine): AgentEvent[] {
    if (isTransportRecord(line)) {
      if (line.$eve === "stream.ended") this.ended = true;
      return [];
    }
    const lineNo = this.position++;
    if (!Array.isArray(line.facts)) return [];
    const ts = line.at ? Date.parse(line.at) : 0;
    const out: AgentEvent[] = [];
    line.facts.forEach((fact, index) => {
      if (isObj(fact)) out.push(...this.fact(fact, `${lineNo}:${index}`, Number.isFinite(ts) ? ts : 0));
    });
    for (const e of this.held.values()) out.push(e);
    this.held.clear();
    return out;
  }

  private fact(f: EveFact, pos: string, ts: number): AgentEvent[] {
    const d = isObj(f.data) ? f.data : {};
    const scopeTurn = isObj(f.scope) ? s(f.scope.turnId) : undefined;
    const turnId = s(d.turnId) ?? scopeTurn;
    switch (f.type) {
      case "session.started": {
        const rt = isObj(d.runtime) ? d.runtime : {};
        this.agentVersion = s(rt.eveVersion);
        this.agentName = s(rt.agentName) ?? s(rt.agentId);
        const payload: Record<string, unknown> = { name: this.agentName, agentId: s(rt.agentId), framework: "eve" };
        if (this.opts.parentSessionId) {
          payload.parentSessionId = this.opts.parentSessionId;
          if (this.opts.subagentId) payload.subagentId = this.opts.subagentId;
          if (this.opts.subagentType) payload.subagentType = this.opts.subagentType;
        }
        return [this.ev("session.start", pos, ts, payload)];
      }
      case "session.ended":
        this.ended = true;
        return [this.ev("session.end", pos, ts, { reason: s(d.reason) ?? s(d.outcome) })];
      case "turn.started": {
        if (turnId) {
          this.turnStart.set(turnId, ts);
          const trace = isObj(d.trace) ? s(d.trace.traceId) : undefined;
          if (trace) this.turnTrace.set(turnId, trace);
        }
        return [];
      }
      case "delivery.consumed": {
        const text = textOf(d.parts);
        if (!text) return [];
        return [this.ev("user.message", pos, ts, { text: this.cut(text), deliveryId: s(d.deliveryId) }, { turnId })];
      }
      case "model.started": {
        const runId = s(d.runId);
        if (runId) this.models.set(runId, { ts, modelId: s(d.modelId), attempt: n(d.attempt), turnId });
        return [];
      }
      case "model.settled": {
        const runId = s(d.runId);
        if (!runId) return [];
        const m = this.models.get(runId);
        const modelId = m?.modelId;
        const slash = modelId?.indexOf("/") ?? -1;
        const ok = d.outcome === undefined || d.outcome === "completed";
        const payload: Record<string, unknown> = {
          provider: slash > 0 ? modelId!.slice(0, slash) : undefined,
          requestModel: modelId,
          stopReason: s(d.finishReason),
          ok,
          outcome: s(d.outcome),
          eveRunId: runId,
          attempt: m?.attempt,
        };
        if (!ok && d.error !== undefined) payload.error = d.error;
        const start = m?.ts ?? ts;
        const e = this.ev("llm.call", pos, start, payload, { turnId: m?.turnId ?? turnId, durationMs: Math.max(0, ts - start), model: modelId });
        this.held.set(`run:${runId}`, e);
        return [];
      }
      case "usage.recorded": {
        const owner = isObj(d.owner) ? d.owner : {};
        const usage = usageOf(d.usage);
        if (!usage) return [];
        const runId = s(owner.runId);
        const callId = s(owner.callId);
        if (runId) {
          const e = this.held.get(`run:${runId}`);
          if (e) e.usage = usage;
        } else if (callId) {
          // A subagent's model usage, reported on the caller's stream: totals only (the child counts its own).
          const e = this.held.get(`sub:${callId}`);
          if (e) e.payload.reportedUsage = usage;
        }
        return [];
      }
      case "call.requested": {
        const callId = s(d.callId);
        const cap = isObj(d.capability) ? d.capability : {};
        const tool = s(cap.name) ?? "unknown";
        const kind = s(cap.kind) ?? "tool";
        if (!callId) return [];
        const start = this.ev("tool.start", pos, ts, { tool, toolUseId: callId, input: d.input, actionKind: kind, label: s(cap.label), framework: kind === "control" || undefined }, { turnId });
        const out = [start];
        const pending: PendingCall = { tool, kind, ts, turnId, startEventId: start.id };
        if (kind === "agent") {
          const input = isObj(d.input) ? d.input : {};
          const sub = this.ev("subagent.start", `${pos}:sub`, ts, { subagentId: callId, type: tool, description: s(cap.label), prompt: typeof input.message === "string" ? this.cut(input.message) : undefined }, { turnId, subagentId: callId, parentId: start.id });
          out.push(sub);
        }
        this.calls.set(callId, pending);
        return out;
      }
      case "child.opened": {
        const owner = isObj(d.owner) ? d.owner : {};
        const callId = s(owner.callId);
        const child = s(d.sessionId);
        if (callId && child) this.children.set(callId, child);
        return [];
      }
      case "call.settled": {
        const callId = s(d.callId);
        if (!callId) return [];
        const c = this.calls.get(callId);
        const tool = c?.tool ?? "unknown";
        const ok = d.outcome === "completed";
        const durationMs = c ? Math.max(0, ts - c.ts) : undefined;
        const end = this.ev(
          "tool.end",
          pos,
          ts,
          { tool, toolUseId: callId, ok, durationMs, output: d.output, outcome: s(d.outcome), error: ok ? undefined : d.error, actionKind: c?.kind },
          { turnId: c?.turnId ?? turnId, durationMs },
        );
        const out = [end];
        if (c?.kind === "agent") {
          const result = typeof d.output === "string" ? this.cut(d.output) : d.output;
          const sub = this.ev(
            "subagent.end",
            `${pos}:sub`,
            ts,
            { subagentId: callId, ok, outcome: s(d.outcome), result, error: ok ? undefined : d.error, childSessionId: this.children.get(callId) },
            { turnId: c.turnId ?? turnId, subagentId: callId, parentId: c.startEventId, durationMs },
          );
          this.held.set(`sub:${callId}`, sub);
        }
        return out;
      }
      case "content.completed": {
        const partId = s(d.partId);
        if (d.kind !== "text" || typeof d.value !== "string") return [];
        if (partId) this.parts.set(partId, d.value);
        return [this.ev("assistant.message", pos, ts, { text: this.cut(d.value), phase: s(d.phase), partId }, { turnId })];
      }
      case "turn.settled": {
        const reply = (Array.isArray(d.reply) ? d.reply : [])
          .map((p) => (typeof p === "string" ? this.parts.get(p) : undefined))
          .filter((t): t is string => t !== undefined)
          .join("\n");
        if (turnId) this.replies.set(turnId, reply);
        const ok = d.outcome === "completed";
        const start = (turnId ? this.turnStart.get(turnId) : undefined) ?? ts;
        return [this.ev("turn.end", pos, ts, { ok, outcome: s(d.outcome), eveTurnId: turnId, output: reply ? this.cut(reply) : undefined, error: ok ? undefined : d.error }, { turnId, durationMs: Math.max(0, ts - start) })];
      }
      case "delivery.settled": {
        const id = s(d.deliveryId);
        const outcome = s(d.outcome) ?? "unknown";
        if (id) this.deliveryOutcomes.set(id, { outcome, turnId });
        if (outcome === "handled") return [];
        return [this.ev("notification", pos, ts, { type: "eve.delivery", deliveryId: id, outcome }, { turnId })];
      }
      default:
        return [];
    }
  }
}

/** Parse NDJSON text into stream lines (blank and malformed lines are skipped). */
export function parseEveStream(text: string): EveStreamLine[] {
  const out: EveStreamLine[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const v = JSON.parse(line) as unknown;
      if (isObj(v)) out.push(v as EveStreamLine);
    } catch {
      /* partial or foreign line */
    }
  }
  return out;
}

/** Map a whole stream (NDJSON text or parsed lines) to events. */
export function mapEveStream(input: string | Iterable<EveStreamLine>, opts: EveStreamOptions): AgentEvent[] {
  const lines = typeof input === "string" ? parseEveStream(input) : input;
  const m = new EveStreamMapper(opts);
  const out: AgentEvent[] = [];
  for (const l of lines) out.push(...m.push(l));
  return out;
}
