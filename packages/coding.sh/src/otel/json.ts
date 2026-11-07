// OTLP/HTTP JSON decoding into the normalized model (model.ts).
//
// Per the OTLP spec (https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding)
// keys are lowerCamelCase, trace/span ids are hex (not base64), enums are
// integers and int64 fields may be decimal strings. Real exporters deviate, so
// this decoder also accepts: snake_case keys (the proto field names), base64
// ids (protojson's default for bytes), enum names ("SPAN_KIND_CLIENT"),
// int64 values as JSON numbers, and doubles as "NaN"/"Infinity" strings.
import {
  type Attrs,
  bytesToHex,
  normId,
  type OtelLink,
  type OtelLogRecord,
  type OtelResource,
  type OtelScope,
  type OtelSpan,
  type OtelSpanEvent,
  type OtelValue,
  OtlpDecodeError,
  type ResourceLogs,
  type ResourceSpans,
} from "./model.ts";

type Obj = Record<string, unknown>;

const MAX_DEPTH = 32;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

const snake = (k: string): string => k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);

/** o[camelKey] ?? o[snake_key]. */
function get(o: Obj, key: string): unknown {
  const v = o[key];
  return v !== undefined ? v : o[snake(key)];
}

function arr(o: Obj, key: string): unknown[] {
  const v = get(o, key);
  return Array.isArray(v) ? v : [];
}

function objs(o: Obj, key: string): Obj[] {
  return arr(o, key).filter(isObj);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Hex id (any case) or base64 bytes → lowercase hex; undefined if absent/empty/zero. */
export function jsonId(v: unknown, bytes: 8 | 16): string | undefined {
  if (typeof v !== "string" || !v) return undefined;
  if (v.length === bytes * 2 && /^[0-9a-fA-F]+$/.test(v)) return normId(v);
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(v)) {
    const b = Buffer.from(v, v.includes("-") || v.includes("_") ? "base64url" : "base64");
    if (b.length === bytes) return normId(bytesToHex(b));
  }
  // Odd lengths/other shapes: keep hex-looking ids rather than dropping data.
  if (/^[0-9a-fA-F]+$/.test(v)) return normId(v);
  throw new OtlpDecodeError(`invalid ${bytes === 16 ? "trace" : "span"} id ${JSON.stringify(v.slice(0, 64))}`);
}

/** fixed64 nanos as decimal string; accepts strings and numbers. */
function nanos(v: unknown): string {
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v).toString();
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return BigInt(Math.round(v)).toString();
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return BigInt(Math.round(Number(v))).toString();
  return "0";
}

function int64(v: unknown): number | string | null {
  if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : null;
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) {
    const b = BigInt(v.trim());
    return b >= BigInt(Number.MIN_SAFE_INTEGER) && b <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(b) : b.toString();
  }
  return null;
}

function double(v: unknown): number | string | null {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    // NaN/Infinity aren't JSON values; keep them as their protojson strings.
    return Number.isFinite(n) ? n : v;
  }
  return null;
}

function uint(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}

/** Enum field: integer, numeric string, or its proto name ("SPAN_KIND_CLIENT"). */
function enumValue(v: unknown, names: readonly string[], prefix: string): number {
  if (typeof v === "number") return Math.trunc(v);
  if (typeof v === "string") {
    if (/^\d+$/.test(v)) return Number(v);
    const i = names.indexOf(v.toUpperCase().replace(prefix, ""));
    if (i >= 0) return i;
  }
  return 0;
}

const SPAN_KINDS = ["UNSPECIFIED", "INTERNAL", "SERVER", "CLIENT", "PRODUCER", "CONSUMER"] as const;
const STATUS_CODES = ["UNSET", "OK", "ERROR"] as const;
const SEVERITIES = [
  "UNSPECIFIED",
  "TRACE", "TRACE2", "TRACE3", "TRACE4",
  "DEBUG", "DEBUG2", "DEBUG3", "DEBUG4",
  "INFO", "INFO2", "INFO3", "INFO4",
  "WARN", "WARN2", "WARN3", "WARN4",
  "ERROR", "ERROR2", "ERROR3", "ERROR4",
  "FATAL", "FATAL2", "FATAL3", "FATAL4",
] as const;

export function jsonAnyValue(v: unknown, depth = 0): OtelValue {
  if (depth > MAX_DEPTH) throw new OtlpDecodeError("AnyValue nested too deeply");
  if (!isObj(v)) return null;
  let x: unknown;
  if ((x = get(v, "stringValue")) !== undefined) return typeof x === "string" ? x : String(x);
  if ((x = get(v, "boolValue")) !== undefined) return x === true || x === "true";
  if ((x = get(v, "intValue")) !== undefined) return int64(x);
  if ((x = get(v, "doubleValue")) !== undefined) return double(x);
  if ((x = get(v, "arrayValue")) !== undefined) return isObj(x) ? arr(x, "values").map((e) => jsonAnyValue(e, depth + 1)) : [];
  if ((x = get(v, "kvlistValue")) !== undefined) return isObj(x) ? jsonAttrs(arr(x, "values"), depth + 1) : {};
  if ((x = get(v, "bytesValue")) !== undefined) return typeof x === "string" ? x : null;
  return null;
}

export function jsonAttrs(list: unknown, depth = 0): Attrs {
  const out: Attrs = {};
  if (!Array.isArray(list)) return out;
  for (const kv of list) {
    if (!isObj(kv) || typeof kv.key !== "string") continue;
    // defineProperty: a key named "__proto__" must stay data, not change the prototype.
    Object.defineProperty(out, kv.key, { value: jsonAnyValue(kv.value, depth), writable: true, enumerable: true, configurable: true });
  }
  return out;
}

function resource(v: unknown, schemaUrl: unknown): OtelResource {
  const r: OtelResource = { attributes: isObj(v) ? jsonAttrs(get(v, "attributes")) : {} };
  if (typeof schemaUrl === "string" && schemaUrl) r.schemaUrl = schemaUrl;
  return r;
}

function scope(v: unknown, schemaUrl: unknown): OtelScope {
  const s: OtelScope = { name: "", attributes: {} };
  if (isObj(v)) {
    s.name = str(v.name) ?? "";
    if (typeof v.version === "string" && v.version) s.version = v.version;
    s.attributes = jsonAttrs(get(v, "attributes"));
  }
  if (typeof schemaUrl === "string" && schemaUrl) s.schemaUrl = schemaUrl;
  return s;
}

function setIf<T extends object, K extends keyof T>(o: T, k: K, v: T[K] | undefined): void {
  if (v !== undefined && v !== "") o[k] = v;
}

function span(o: Obj): OtelSpan {
  const status = isObj(o.status) ? o.status : {};
  const s: OtelSpan = {
    name: str(o.name) ?? "",
    kind: enumValue(o.kind, SPAN_KINDS, "SPAN_KIND_"),
    startTimeUnixNano: nanos(get(o, "startTimeUnixNano")),
    endTimeUnixNano: nanos(get(o, "endTimeUnixNano")),
    attributes: jsonAttrs(o.attributes),
    events: objs(o, "events").map(
      (e): OtelSpanEvent => ({ timeUnixNano: nanos(get(e, "timeUnixNano")), name: str(e.name) ?? "", attributes: jsonAttrs(e.attributes) }),
    ),
    links: objs(o, "links").map((l): OtelLink => {
      const link: OtelLink = { attributes: jsonAttrs(l.attributes) };
      setIf(link, "traceId", jsonId(get(l, "traceId"), 16));
      setIf(link, "spanId", jsonId(get(l, "spanId"), 8));
      return link;
    }),
    status: { code: enumValue(status.code, STATUS_CODES, "STATUS_CODE_") },
  };
  setIf(s.status, "message", str(status.message));
  setIf(s, "traceId", jsonId(get(o, "traceId"), 16));
  setIf(s, "spanId", jsonId(get(o, "spanId"), 8));
  setIf(s, "parentSpanId", jsonId(get(o, "parentSpanId"), 8));
  setIf(s, "traceState", str(get(o, "traceState")));
  if (get(o, "flags") !== undefined) s.flags = uint(get(o, "flags"));
  return s;
}

function logRecord(o: Obj): OtelLogRecord {
  const l: OtelLogRecord = {
    timeUnixNano: nanos(get(o, "timeUnixNano")),
    observedTimeUnixNano: nanos(get(o, "observedTimeUnixNano")),
    severityNumber: enumValue(get(o, "severityNumber"), SEVERITIES, "SEVERITY_NUMBER_"),
    attributes: jsonAttrs(o.attributes),
  };
  setIf(l, "severityText", str(get(o, "severityText")));
  if (o.body !== undefined) l.body = jsonAnyValue(o.body);
  setIf(l, "traceId", jsonId(get(o, "traceId"), 16));
  setIf(l, "spanId", jsonId(get(o, "spanId"), 8));
  setIf(l, "eventName", str(get(o, "eventName")));
  if (get(o, "flags") !== undefined) l.flags = uint(get(o, "flags"));
  return l;
}

function root(body: unknown, key: string): Obj[] {
  if (!isObj(body)) throw new OtlpDecodeError(`expected a JSON object with "${key}"`);
  const v = get(body, key);
  if (v !== undefined && !Array.isArray(v)) throw new OtlpDecodeError(`"${key}" must be an array`);
  return (v ?? []).filter(isObj);
}

/** Decodes a parsed ExportTraceServiceRequest JSON body. */
export function decodeTraceJson(body: unknown): ResourceSpans[] {
  return root(body, "resourceSpans").map((rs) => ({
    resource: resource(rs.resource, get(rs, "schemaUrl")),
    scopeSpans: objs(rs, "scopeSpans").map((ss) => ({
      scope: scope(ss.scope, get(ss, "schemaUrl")),
      spans: objs(ss, "spans").map(span),
    })),
  }));
}

/** Decodes a parsed ExportLogsServiceRequest JSON body. */
export function decodeLogsJson(body: unknown): ResourceLogs[] {
  return root(body, "resourceLogs").map((rl) => ({
    resource: resource(rl.resource, get(rl, "schemaUrl")),
    scopeLogs: objs(rl, "scopeLogs").map((sl) => ({
      scope: scope(sl.scope, get(sl, "schemaUrl")),
      logRecords: objs(sl, "logRecords").map(logRecord),
    })),
  }));
}

/** Validates the top-level shape of an ExportMetricsServiceRequest JSON body. */
export function validateMetricsJson(body: unknown): void {
  root(body, "resourceMetrics");
}

/** Parses JSON text, mapping syntax errors to OtlpDecodeError. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new OtlpDecodeError(`invalid JSON: ${(err as Error).message}`);
  }
}
