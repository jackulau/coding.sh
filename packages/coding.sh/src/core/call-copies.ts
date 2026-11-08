// A model call captured twice: by the agent's own capture path (hook,
// transcript, OTel) and by `coding.sh proxy`. Both copies are stored; session
// stats count one of them (sessions.ts, sansProxy). Timelines (`show`, the
// viewer, MCP) show one line per call: the proxy's copy, which has the call id
// that `show <call>`, `diff-calls` and `exp replay` take, with the fields only
// the other copy has filled in (turnId, cache tokens the stream did not report).
//
// Copies pair by the provider's id for the call, the same in both: `messageId`
// (Anthropic) or `responseId` (OpenAI), in the same session. Each copy pairs
// at most once. A call without such an id, or seen by one path only (a retry
// only the proxy saw), stays as it is. The raw event APIs (`show --json`,
// /api/sessions/{id}/events) keep both copies.
import type { AgentEvent } from "../schema/index.ts";

/** The provider's id of a model call in its session, when it has one. */
function callKey(e: AgentEvent): string | undefined {
  if (e.kind !== "llm.call" || e.source === "gateway") return undefined;
  const p = e.payload;
  const id = typeof p.messageId === "string" && p.messageId ? p.messageId : typeof p.responseId === "string" && p.responseId ? p.responseId : undefined;
  return id ? `${e.sessionId}\0${id}` : undefined;
}

/** `a` with every field it lacks taken from `b`. */
function fill<T extends object>(a: T, b: T): T {
  const out = { ...a } as Record<string, unknown>;
  for (const [k, v] of Object.entries(b)) if (out[k] === undefined && v !== undefined) out[k] = v;
  return out as T;
}

/** The proxy's copy of a call with the other copy's fields filled in. */
function merge(proxy: AgentEvent, other: AgentEvent): AgentEvent {
  const out = fill(proxy, other);
  out.payload = fill(proxy.payload, other.payload);
  if (proxy.usage && other.usage) out.usage = fill(proxy.usage, other.usage);
  if (proxy.blobs && other.blobs) out.blobs = [...new Set([...proxy.blobs, ...other.blobs])];
  return out;
}

export interface CallCopies {
  /** Proxy call id → that call with its other copy's fields filled in. */
  merged: Map<string, AgentEvent>;
  /** Id of a copy folded into a proxy call → that call's id. */
  folded: Map<string, string>;
}

/** Pairs each proxy model call with the other capture path's copy of it. */
export function callCopies(events: readonly AgentEvent[]): CallCopies {
  const out: CallCopies = { merged: new Map(), folded: new Map() };
  const open = new Map<string, AgentEvent[]>();
  for (const e of events) {
    const key = callKey(e);
    if (!key) continue;
    const proxy = e.source === "proxy";
    const waiting = open.get(key);
    const i = waiting?.findIndex((w) => (w.source === "proxy") !== proxy) ?? -1;
    if (i < 0) {
      open.set(key, [...(waiting ?? []), e]);
      continue;
    }
    const [twin] = waiting!.splice(i, 1);
    const [p, other] = proxy ? [e, twin!] : [twin!, e];
    out.merged.set(p.id, merge(p, other));
    out.folded.set(other.id, p.id);
  }
  return out;
}

/** The events with each model call once: a proxy call merged with its other copy, which is dropped. */
export function mergeCallCopies(events: readonly AgentEvent[]): AgentEvent[] {
  const c = callCopies(events);
  if (!c.folded.size) return [...events];
  return events.filter((e) => !c.folded.has(e.id)).map((e) => c.merged.get(e.id) ?? e);
}
