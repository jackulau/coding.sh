// Native batched ingest (`POST /v1/ingest`, docs/PRODUCTION.md §2): the SDKs'
// envelope `{ v: 0, service?, events: AgentEvent[] }`. Invalid events are
// rejected one by one and the rest are kept; the key decides the project.
import { EVENT_KINDS, type AgentEvent, type Usage } from "../schema/index.ts";
import { kebab } from "../otel/map.ts";
import { HttpError, RPC } from "../otel/receiver.ts";
import { MAX_EVENTS_PER_REQUEST } from "./config.ts";
import { sdkEventId } from "./project.ts";

export interface NativeBatch {
  /** Valid events, ids already mapped to `hashParts("sdk", project, clientId)`; project set by the queue. */
  events: AgentEvent[];
  rejected: { index: number; error: string }[];
}

const KINDS = new Set<string>(EVENT_KINDS);
const DAY_MS = 86_400_000;
const PRINTABLE_ID = /^[\x21-\x7e]{1,128}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Deep copy with U+0000 removed from every string (text columns cannot hold it). */
function stripNul<T>(v: T): T {
  if (typeof v === "string") return (v.includes("\u0000") ? v.replaceAll("\u0000", "") : v) as T;
  if (Array.isArray(v)) return v.map(stripNul) as T;
  if (isObj(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k.replaceAll("\u0000", "")] = stripNul(x);
    return out as T;
  }
  return v;
}

const USAGE_KEYS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd"] as const;
// Optional AgentEvent fields a client may send (anything else is dropped; blobs always are).
const STRING_FIELDS = ["parentId", "turnId", "subagentId", "agentVersion", "model", "runId", "traceId", "spanId", "parentSpanId", "cwd", "source"] as const;

/** Why one event is invalid, or undefined. */
function invalid(e: unknown, now: number): string | undefined {
  if (!isObj(e)) return "event must be an object";
  if (e.v !== 0) return "v must be 0";
  if (typeof e.id !== "string" || !PRINTABLE_ID.test(e.id)) return "id must be 1-128 printable ASCII characters";
  if (typeof e.sessionId !== "string" || e.sessionId.length < 1 || e.sessionId.length > 200 || CONTROL.test(e.sessionId)) return "sessionId must be 1-200 characters with no control characters";
  if (typeof e.kind !== "string" || !KINDS.has(e.kind)) return `kind must be one of ${EVENT_KINDS.join(", ")}`;
  if (typeof e.ts !== "number" || !Number.isFinite(e.ts) || e.ts < 0 || e.ts > now + DAY_MS) return "ts must be epoch milliseconds between 0 and now + 1 day";
  if (!isObj(e.payload)) return "payload must be an object";
  if (e.usage !== undefined) {
    if (!isObj(e.usage)) return "usage must be an object";
    for (const k of USAGE_KEYS) {
      const x = e.usage[k];
      if (x !== undefined && (typeof x !== "number" || !Number.isFinite(x) || x < 0)) return `usage.${k} must be a non-negative number`;
    }
  }
  if (e.parentId !== undefined && (typeof e.parentId !== "string" || !PRINTABLE_ID.test(e.parentId))) return "parentId must be 1-128 printable ASCII characters";
  if (e.durationMs !== undefined && (typeof e.durationMs !== "number" || !Number.isFinite(e.durationMs) || e.durationMs < 0)) return "durationMs must be a non-negative number";
  if (e.agent !== undefined && (typeof e.agent !== "string" || e.agent.length > 100)) return "agent must be a string of at most 100 characters";
  return undefined;
}

/** Validates an envelope (already JSON-parsed). Throws HttpError 400 for a bad envelope. */
export function parseNativeBatch(body: unknown, project: string, now = Date.now()): NativeBatch {
  if (!isObj(body)) throw new HttpError(400, RPC.INVALID_ARGUMENT, 'body must be a JSON object: {"v":0,"service":"…","events":[…]}');
  if (body.v !== undefined && body.v !== 0) throw new HttpError(400, RPC.INVALID_ARGUMENT, "envelope v must be 0");
  if (!Array.isArray(body.events)) throw new HttpError(400, RPC.INVALID_ARGUMENT, "events must be an array");
  if (body.events.length > MAX_EVENTS_PER_REQUEST) throw new HttpError(400, RPC.INVALID_ARGUMENT, `at most ${MAX_EVENTS_PER_REQUEST} events per request (got ${body.events.length}); split the batch`);
  const service = typeof body.service === "string" ? kebab(body.service).slice(0, 100) : "";
  const agent = service || "sdk";
  const events: AgentEvent[] = [];
  const rejected: NativeBatch["rejected"] = [];
  body.events.forEach((raw, index) => {
    const why = invalid(raw, now);
    if (why) {
      rejected.push({ index, error: why });
      return;
    }
    const e = stripNul(raw as Record<string, unknown>);
    const out: AgentEvent = {
      id: sdkEventId(project, e.id as string),
      v: 0,
      sessionId: e.sessionId as string,
      ts: e.ts as number,
      agent: typeof e.agent === "string" && e.agent ? e.agent : agent,
      kind: e.kind as AgentEvent["kind"],
      payload: e.payload as Record<string, unknown>,
    };
    for (const k of STRING_FIELDS) if (typeof e[k] === "string" && e[k]) (out as unknown as Record<string, unknown>)[k] = e[k];
    if (out.parentId) out.parentId = sdkEventId(project, out.parentId);
    out.source ??= "sdk";
    if (typeof e.durationMs === "number") out.durationMs = e.durationMs;
    if (isObj(e.usage)) {
      const u: Usage = {};
      for (const k of USAGE_KEYS) if (typeof e.usage[k] === "number") u[k] = e.usage[k] as number;
      out.usage = u;
    }
    if (isObj(e.repo) && typeof e.repo.root === "string") out.repo = e.repo as unknown as AgentEvent["repo"];
    events.push(out);
  });
  return { events, rejected };
}
