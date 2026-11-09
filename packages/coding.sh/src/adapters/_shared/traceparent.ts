// W3C Trace Context (https://www.w3.org/TR/trace-context/#traceparent-header):
// an agent that runs with OpenTelemetry can hand its hooks the trace it is in, so
// hook events and the agent's OTLP spans land in one session.
import type { AgentEvent } from "../../schema/index.ts";
import type { IndexStore } from "../../core/types.ts";

export interface TraceParent {
  /** 32 lowercase hex chars. */
  traceId: string;
  /** The caller's span: 16 lowercase hex chars. */
  spanId: string;
  sampled: boolean;
}

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/;
const ZERO = /^0+$/;

/**
 * A `traceparent` value, or undefined when it is not valid: version `ff`, an
 * all-zero trace or span id, uppercase hex, or anything after the flags on
 * version 00 (later versions may append fields, which are ignored).
 */
export function parseTraceparent(v: unknown): TraceParent | undefined {
  if (typeof v !== "string") return undefined;
  const m = TRACEPARENT.exec(v.trim());
  if (!m) return undefined;
  const [, version, traceId, spanId, flags, rest] = m;
  if (version === "ff" || (version === "00" && rest !== undefined)) return undefined;
  if (ZERO.test(traceId!) || ZERO.test(spanId!)) return undefined;
  return { traceId: traceId!, spanId: spanId!, sampled: (parseInt(flags!, 16) & 1) === 1 };
}

/**
 * Remembers which session a trace belongs to, from hook events that carry a
 * traceId (the agent's traceparent), in the index kv the OTLP receiver reads
 * (`kvKey`: otel/map.ts traceKvKey, otel-trace:<traceId>). Spans of that trace that name no conversation then
 * join the hook session. A trace already mapped keeps its session; OTel events
 * themselves are skipped (the receiver maps those).
 */
export async function rememberTraceSessions(index: Pick<IndexStore, "kvGet" | "kvSet">, events: readonly AgentEvent[], kvKey: (traceId: string) => string): Promise<void> {
  if (!index.kvGet || !index.kvSet) return;
  const seen = new Map<string, string>();
  for (const e of events) {
    if (!e.traceId || e.source?.startsWith("otel-") || seen.has(e.traceId)) continue;
    seen.set(e.traceId, e.sessionId);
  }
  for (const [traceId, sessionId] of seen) {
    const key = kvKey(traceId);
    if (!(await index.kvGet(key))) await index.kvSet(key, sessionId);
  }
}
