// Normalized OTLP data model shared by the protobuf and JSON decoders.
//
// Both wire formats decode into these plain, JSON-serializable shapes, so the
// mapper (map.ts) has one input and the raw span/log we keep as a blob can be
// re-normalized later without the original request body:
// - trace/span ids are lowercase hex ("" never appears: absent ids are undefined)
// - times are unsigned nanosecond counts as decimal strings (exact; > 2^53)
// - AnyValue becomes a plain JSON value: int64 → number when safe, else a
//   decimal string; bytes → base64 string; kvlist → object; empty → null

export type OtelValue = string | number | boolean | null | OtelValue[] | { [key: string]: OtelValue };
export type Attrs = Record<string, OtelValue>;

export interface OtelResource {
  attributes: Attrs;
  schemaUrl?: string;
}

export interface OtelScope {
  name: string;
  version?: string;
  attributes: Attrs;
  schemaUrl?: string;
}

export interface OtelSpanEvent {
  timeUnixNano: string;
  name: string;
  attributes: Attrs;
}

export interface OtelLink {
  traceId?: string;
  spanId?: string;
  attributes: Attrs;
}

/** Span.SpanKind */
export const SPAN_KIND = { UNSPECIFIED: 0, INTERNAL: 1, SERVER: 2, CLIENT: 3, PRODUCER: 4, CONSUMER: 5 } as const;
/** Status.StatusCode */
export const STATUS_CODE = { UNSET: 0, OK: 1, ERROR: 2 } as const;

export interface OtelSpan {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  traceState?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Attrs;
  events: OtelSpanEvent[];
  links: OtelLink[];
  status: { code: number; message?: string };
  flags?: number;
}

export interface OtelLogRecord {
  timeUnixNano: string;
  observedTimeUnixNano: string;
  severityNumber: number;
  severityText?: string;
  body?: OtelValue;
  attributes: Attrs;
  traceId?: string;
  spanId?: string;
  eventName?: string;
  flags?: number;
}

export interface ScopeSpans {
  scope: OtelScope;
  spans: OtelSpan[];
}

export interface ResourceSpans {
  resource: OtelResource;
  scopeSpans: ScopeSpans[];
}

export interface ScopeLogs {
  scope: OtelScope;
  logRecords: OtelLogRecord[];
}

export interface ResourceLogs {
  resource: OtelResource;
  scopeLogs: ScopeLogs[];
}

/** Thrown for malformed request bodies; the receiver answers 400. */
export class OtlpDecodeError extends Error {
  override name = "OtlpDecodeError";
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

export function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += HEX[x];
  return s;
}

/** Hex id, or undefined for empty / all-zero ids (both mean "not set" in OTLP). */
export function normId(hex: string | undefined): string | undefined {
  if (!hex || /^0+$/.test(hex)) return undefined;
  return hex.toLowerCase();
}

/** Nanosecond decimal string → whole milliseconds since epoch. */
export function nanosToMs(nanos: string): number {
  try {
    return Number(BigInt(nanos) / 1_000_000n);
  } catch {
    return 0;
  }
}

/** Difference of two nanosecond strings in milliseconds (3 decimals), never negative. */
export function nanosDiffMs(start: string, end: string): number {
  try {
    const d = BigInt(end) - BigInt(start);
    if (d <= 0n) return 0;
    return Number(d / 1000n) / 1000;
  } catch {
    return 0;
  }
}

/** True when a nanosecond string is unset ("0" or empty). */
export const unsetTime = (nanos: string): boolean => !nanos || /^0+$/.test(nanos);

/** int64 → number when exactly representable, else its decimal string. */
export function int64Value(v: bigint): number | string {
  return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
}
