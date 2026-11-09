// Import GenAI spans from a ClickHouse `otel_traces` table, the one the
// OpenTelemetry Collector's clickhouseexporter writes (ClickStack, HyperDX, or
// any collector with that exporter). Rows are read over ClickHouse's HTTP
// interface with fetch, turned back into OTLP ResourceSpans, and go through the
// receiver's pipeline (createOtlpPipeline): the same mapping, redaction and
// pricing as spans posted to `coding.sh collector`, and the same event ids, so a
// span imported twice, or imported after it was posted live, is stored once.
//
// Table schema (clickhouseexporter internal/sqltemplates/traces_table.sql):
//   Timestamp DateTime64(9), TraceId, SpanId, ParentSpanId, TraceState, SpanName,
//   SpanKind ("Client" or "SPAN_KIND_CLIENT"), ServiceName, ResourceAttributes,
//   ScopeName, ScopeVersion, SpanAttributes, Duration UInt64 (ns), StatusCode
//   ("Ok"/"Error"/"Unset" or "STATUS_CODE_*"), StatusMessage,
//   Events Nested(Timestamp, Name, Attributes), Links Nested(TraceId, SpanId, TraceState, Attributes).
// Attributes are Map(String, String) by default (every value a string: ints
// "42", bools "true", arrays JSON '["stop"]'), or the JSON type with
// `json: true` (typed values, dotted keys as nested objects).
//
// Every value goes to ClickHouse as a typed query parameter (param_*); only the
// user's own --where is spliced into the SQL.
import type { BlobStore, IndexStore } from "../core/types.ts";
import type { Session } from "../schema/index.ts";
import { applyPricing, pricesFor, type Prices } from "../core/pricing.ts";
import { createRedactor, type Redactor } from "../core/redact.ts";
import { sha256Hex } from "../core/ids.ts";
import { createOtlpPipeline, rebuildSessions } from "./receiver.ts";
import { type Attrs, type OtelSpan, type OtelValue, type ResourceSpans, SPAN_KIND, STATUS_CODE } from "./model.ts";

export type AttributeMode = "map" | "json";

/** One row of the SELECT fetchSpans runs (and of `SELECT *` from otel_traces, with flattened Nested columns). */
export interface ClickHouseSpanRow {
  /** Start in ns since the epoch (fetchSpans selects it); else Timestamp is parsed. */
  TimestampNs?: string | number;
  Timestamp?: string | number;
  TraceId?: string;
  SpanId?: string;
  ParentSpanId?: string;
  TraceState?: string;
  SpanName?: string;
  SpanKind?: string;
  ServiceName?: string;
  ResourceAttributes?: Record<string, unknown>;
  ScopeName?: string;
  ScopeVersion?: string;
  SpanAttributes?: Record<string, unknown>;
  Duration?: string | number;
  StatusCode?: string;
  StatusMessage?: string;
  EventTimesNs?: (string | number)[];
  "Events.Timestamp"?: (string | number)[];
  "Events.Name"?: string[];
  "Events.Attributes"?: Record<string, unknown>[];
  "Links.TraceId"?: string[];
  "Links.SpanId"?: string[];
  "Links.TraceState"?: string[];
  "Links.Attributes"?: Record<string, unknown>[];
  [column: string]: unknown;
}

const KINDS: Record<string, number> = {
  unspecified: SPAN_KIND.UNSPECIFIED,
  internal: SPAN_KIND.INTERNAL,
  server: SPAN_KIND.SERVER,
  client: SPAN_KIND.CLIENT,
  producer: SPAN_KIND.PRODUCER,
  consumer: SPAN_KIND.CONSUMER,
};
const STATUSES: Record<string, number> = { unset: STATUS_CODE.UNSET, ok: STATUS_CODE.OK, error: STATUS_CODE.ERROR };

/** "Client", "SPAN_KIND_CLIENT" → 3. */
export function spanKindOf(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return SPAN_KIND.UNSPECIFIED;
  return KINDS[v.toLowerCase().replace(/^span_kind_/, "")] ?? SPAN_KIND.UNSPECIFIED;
}

/** "Error", "STATUS_CODE_ERROR" → 2. */
export function statusCodeOf(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return STATUS_CODE.UNSET;
  return STATUSES[v.toLowerCase().replace(/^status_code_/, "")] ?? STATUS_CODE.UNSET;
}

/**
 * Attributes the receiver reads as arrays. In Map mode the exporter stores an
 * array as its JSON text; these are parsed back. Every other JSON-looking string
 * stays a string (message lists are JSON strings in the original spans too).
 */
const ARRAY_KEYS = new Set([
  "gen_ai.response.finish_reasons",
  "gen_ai.request.stop_sequences",
  "gen_ai.request.encoding_formats",
  "ai.response.finishReason",
  "llm.output_messages",
  "tool.names",
  "gen_ai.skill.names",
]);

const INT = /^-?(0|[1-9]\d*)$/;
const FLOAT = /^-?(0|[1-9]\d*)\.\d+(e[+-]?\d+)?$/i;

/**
 * A Map(String, String) value back to the type the exporter flattened: ints and
 * floats to numbers, "true"/"false" to booleans, JSON arrays of ARRAY_KEYS to
 * arrays. A string attribute that looks like a number (an id such as "42")
 * becomes a number too; the mapper reads ids with str(), which takes numbers.
 */
function fromMapValue(key: string, v: string): OtelValue {
  if (INT.test(v)) {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : v;
  }
  if (FLOAT.test(v)) return Number(v);
  if (v === "true") return true;
  if (v === "false") return false;
  if (ARRAY_KEYS.has(key) && v.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed as OtelValue[];
    } catch {
      // not JSON: keep the text
    }
  }
  return v;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** JSON-type value: nested objects are dotted paths (gen_ai → usage → input_tokens). */
function flattenJson(prefix: string, v: unknown, out: Attrs): void {
  if (isPlainObject(v)) {
    for (const [k, x] of Object.entries(v)) flattenJson(prefix ? `${prefix}.${k}` : k, x, out);
    return;
  }
  if (v === null || v === undefined) return;
  // 64-bit integers come back quoted unless output_format_json_quote_64bit_integers=0.
  out[prefix] = typeof v === "string" && INT.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : (v as OtelValue);
}

/** A Map or JSON attributes column as OTLP attributes. */
export function attributesOf(v: unknown, mode: AttributeMode = "map"): Attrs {
  const out: Attrs = {};
  if (typeof v === "string") {
    // A JSON column read with output_format_json_... settings that print it as text.
    try {
      v = JSON.parse(v);
    } catch {
      return out;
    }
  }
  if (!isPlainObject(v)) return out;
  if (mode === "json") {
    flattenJson("", v, out);
    return out;
  }
  for (const [k, x] of Object.entries(v)) {
    if (typeof x === "string") out[k] = fromMapValue(k, x);
    else if (x !== null && x !== undefined) out[k] = x as OtelValue;
  }
  return out;
}

const DATE_TIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * A DateTime64(9) value in ns since the epoch, as a decimal string: a number or
 * numeric string (unix seconds with a fraction, or already ns), or
 * "YYYY-MM-DD hh:mm:ss.nnnnnnnnn" (UTC unless it names a zone).
 */
export function timestampNanos(v: unknown): string {
  if (typeof v === "number") return v > 1e15 ? BigInt(Math.round(v)).toString() : (BigInt(Math.round(v * 1e6)) * 1000n).toString();
  if (typeof v !== "string" || !v) return "0";
  if (/^\d+$/.test(v)) return v.length > 12 ? v : (BigInt(v) * 1_000_000_000n).toString();
  const unix = /^(\d+)\.(\d{1,9})$/.exec(v);
  if (unix) return (BigInt(unix[1]!) * 1_000_000_000n + BigInt(unix[2]!.padEnd(9, "0"))).toString();
  const m = DATE_TIME.exec(v);
  if (!m) return "0";
  const zone = !m[4] || m[4] === "Z" ? "Z" : m[4].length === 5 ? `${m[4].slice(0, 3)}:${m[4].slice(3)}` : m[4];
  const ms = Date.parse(`${m[1]}T${m[2]}${zone}`);
  if (!Number.isFinite(ms)) return "0";
  return (BigInt(ms) * 1_000_000n + BigInt((m[3] ?? "").padEnd(9, "0"))).toString();
}

const text = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const array = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** Nested columns as one array of objects, whether flattened (Events.Name) or not (Events: [{Name}] or [[t, name, attrs]]). */
function nested(row: ClickHouseSpanRow, name: "Events" | "Links", fields: string[]): Record<string, unknown>[] {
  const whole = row[name];
  if (Array.isArray(whole)) {
    return whole.map((x) => (Array.isArray(x) ? Object.fromEntries(fields.map((f, i) => [f, x[i]])) : isPlainObject(x) ? x : {}));
  }
  const cols = fields.map((f) => array<unknown>(row[`${name}.${f}`]));
  const n = Math.max(0, ...cols.map((c) => c.length));
  return Array.from({ length: n }, (_, i) => Object.fromEntries(fields.map((f, j) => [f, cols[j]![i]])));
}

/** One row as an OTLP span. */
export function rowToSpan(row: ClickHouseSpanRow, mode: AttributeMode = "map"): OtelSpan {
  const ns = row.TimestampNs !== undefined ? String(row.TimestampNs) : undefined;
  const start = ns && /^\d+$/.test(ns) ? ns : timestampNanos(row.Timestamp);
  let end = start;
  try {
    end = (BigInt(start) + BigInt(String(row.Duration ?? 0))).toString();
  } catch {
    // a malformed duration: an instant span
  }
  const eventTimes = array<string | number>(row.EventTimesNs);
  const events = nested(row, "Events", ["Timestamp", "Name", "Attributes"]).map((e, i) => ({
    timeUnixNano: eventTimes[i] !== undefined && /^\d+$/.test(String(eventTimes[i])) ? String(eventTimes[i]) : timestampNanos(e.Timestamp),
    name: typeof e.Name === "string" ? e.Name : "",
    attributes: attributesOf(e.Attributes, mode),
  }));
  const links = nested(row, "Links", ["TraceId", "SpanId", "TraceState", "Attributes"]).map((l) => ({
    ...(text(l.TraceId) ? { traceId: (l.TraceId as string).toLowerCase() } : {}),
    ...(text(l.SpanId) ? { spanId: (l.SpanId as string).toLowerCase() } : {}),
    attributes: attributesOf(l.Attributes, mode),
  }));
  const span: OtelSpan = {
    name: row.SpanName ?? "",
    kind: spanKindOf(row.SpanKind),
    startTimeUnixNano: start,
    endTimeUnixNano: end,
    attributes: attributesOf(row.SpanAttributes, mode),
    events,
    links,
    status: { code: statusCodeOf(row.StatusCode), ...(text(row.StatusMessage) ? { message: row.StatusMessage } : {}) },
  };
  if (text(row.TraceId)) span.traceId = row.TraceId!.toLowerCase();
  if (text(row.SpanId)) span.spanId = row.SpanId!.toLowerCase();
  if (text(row.ParentSpanId)) span.parentSpanId = row.ParentSpanId!.toLowerCase();
  if (text(row.TraceState)) span.traceState = row.TraceState;
  return span;
}

/**
 * Rows as OTLP ResourceSpans: one resource per distinct ResourceAttributes +
 * ServiceName, one scope per ScopeName + ScopeVersion under it, rows in order.
 */
export function rowsToResourceSpans(rows: Iterable<ClickHouseSpanRow>, mode: AttributeMode = "map"): ResourceSpans[] {
  const resources = new Map<string, { rs: ResourceSpans; scopes: Map<string, OtelSpan[]> }>();
  for (const row of rows) {
    const attributes = attributesOf(row.ResourceAttributes, mode);
    if (text(row.ServiceName) && attributes["service.name"] === undefined) attributes["service.name"] = row.ServiceName!;
    const rkey = JSON.stringify(Object.entries(attributes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    let r = resources.get(rkey);
    if (!r) resources.set(rkey, (r = { rs: { resource: { attributes }, scopeSpans: [] }, scopes: new Map() }));
    const name = row.ScopeName ?? "";
    const version = text(row.ScopeVersion);
    const skey = `${name}\u0000${version ?? ""}`;
    let spans = r.scopes.get(skey);
    if (!spans) {
      spans = [];
      r.scopes.set(skey, spans);
      r.rs.scopeSpans.push({ scope: { name, ...(version ? { version } : {}), attributes: {} }, spans });
    }
    spans.push(rowToSpan(row, mode));
  }
  return [...resources.values()].map((r) => r.rs);
}

// ---------------------------------------------------------------- HTTP

export class ClickHouseError extends Error {
  override name = "ClickHouseError";
  /** HTTP status, or 0 when the server could not be reached. */
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface ClickHouseTarget {
  /** http(s)://[user:password@]host:8123/[?database=db] */
  url: string;
  /** Default otel_traces. "db.table" also names the database. */
  table?: string;
  /** Default: the URL's userinfo, then CLICKHOUSE_USER / CLICKHOUSE_PASSWORD. */
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

interface Endpoint {
  base: URL;
  database: string;
  table: string;
  headers: Record<string, string>;
  fetch: typeof fetch;
}

function endpoint(t: ClickHouseTarget): Endpoint {
  let url: URL;
  try {
    url = new URL(t.url);
  } catch {
    throw new ClickHouseError(`not a URL: ${t.url}`, 0);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ClickHouseError(`ClickHouse's HTTP interface needs an http:// or https:// URL, not ${url.protocol}`, 0);
  const env = t.env ?? process.env;
  const user = decodeURIComponent(url.username) || env.CLICKHOUSE_USER || "";
  const password = decodeURIComponent(url.password) || env.CLICKHOUSE_PASSWORD || "";
  let table = t.table || "otel_traces";
  let database = url.searchParams.get("database") || "";
  const dot = table.indexOf(".");
  if (dot > 0) {
    database = table.slice(0, dot);
    table = table.slice(dot + 1);
  }
  // Credentials go in headers, never in the URL a proxy might log.
  const base = new URL(url.origin + url.pathname);
  for (const [k, v] of url.searchParams) if (k !== "database") base.searchParams.set(k, v);
  const headers: Record<string, string> = {};
  if (user) headers["X-ClickHouse-User"] = user;
  if (password) headers["X-ClickHouse-Key"] = password;
  return { base, database, table, headers, fetch: t.fetch ?? fetch };
}

/** Where a target's import cursor is kept: host, database and table, never credentials. */
export function cursorKey(t: ClickHouseTarget): string {
  const e = endpoint(t);
  return `clickhouse:${e.base.host}/${e.database || "default"}/${e.table}`;
}

async function query(e: Endpoint, sql: string, params: Record<string, string>): Promise<string> {
  const url = new URL(e.base);
  if (e.database) url.searchParams.set("database", e.database);
  // Errors become a real HTTP status instead of a 200 with an exception mid-stream.
  url.searchParams.set("wait_end_of_query", "1");
  url.searchParams.set("output_format_json_quote_64bit_integers", "0");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(`param_${k}`, v);
  let res: Response;
  try {
    res = await e.fetch(url, { method: "POST", body: sql, headers: { ...e.headers, "Content-Type": "text/plain; charset=utf-8" } });
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    throw new ClickHouseError(`can't reach ClickHouse at ${e.base.origin}: ${cause?.code ?? cause?.message ?? (err as Error).message}`, 0);
  }
  const body = await res.text();
  if (!res.ok) throw new ClickHouseError(body.trim().split("\n")[0]!.slice(0, 500) || `HTTP ${res.status}`, res.status);
  const exception = res.headers.get("x-clickhouse-exception-code");
  if (exception) throw new ClickHouseError(`ClickHouse error ${exception}: ${body.slice(-500)}`, 500);
  return body;
}

function jsonLines<T>(body: string): T[] {
  const out: T[] = [];
  for (const line of body.split("\n")) if (line.trim()) out.push(JSON.parse(line) as T);
  return out;
}

/** "map" or "json": the type of the table's SpanAttributes column. */
export async function attributeMode(t: ClickHouseTarget): Promise<AttributeMode> {
  const e = endpoint(t);
  const rows = jsonLines<{ type?: string }>(
    await query(e, "SELECT type FROM system.columns WHERE database = currentDatabase() AND table = {table:String} AND name = 'SpanAttributes' FORMAT JSONEachRow", { table: e.table }),
  );
  if (!rows.length) throw new ClickHouseError(`table ${e.database || "default"}.${e.table} has no SpanAttributes column (is it an otel_traces table?)`, 404);
  return /^JSON/i.test(rows[0]!.type ?? "") ? "json" : "map";
}

/** Keyset position: the last row read. */
export interface SpanCursor {
  /** Timestamp in ns since the epoch. */
  ts: string;
  traceId: string;
  spanId: string;
}

export interface FetchSpansOptions extends ClickHouseTarget {
  /** Only spans that started at or after this (ms since the epoch). */
  since?: number;
  /** Only spans that started before this (ms since the epoch). */
  until?: number;
  /** A ClickHouse boolean expression ANDed into the WHERE, as typed. */
  where?: string;
  /** Default: only traces with an agent span (GenAI, OpenInference, Vercel AI SDK, Claude Code, eve). false: every span. */
  genAiOnly?: boolean;
  /** Read after this row. */
  after?: SpanCursor;
  /** Rows per page. Default 5000. */
  limit?: number;
  mode?: AttributeMode;
}

const COLUMNS = [
  "toString(toUnixTimestamp64Nano(Timestamp)) AS TimestampNs",
  "TraceId",
  "SpanId",
  "ParentSpanId",
  "TraceState",
  "SpanName",
  "SpanKind",
  "ServiceName",
  "ResourceAttributes",
  "ScopeName",
  "ScopeVersion",
  "SpanAttributes",
  "Duration",
  "StatusCode",
  "StatusMessage",
  "arrayMap(t -> toString(toUnixTimestamp64Nano(t)), Events.Timestamp) AS EventTimesNs",
  "Events.Name",
  "Events.Attributes",
  "Links.TraceId",
  "Links.SpanId",
  "Links.TraceState",
  "Links.Attributes",
].join(", ");

/** Span attributes that mark a span the receiver maps as agent work (see classifySpan in map.ts). */
const AGENT_KEYS = [
  "gen_ai.operation.name",
  "gen_ai.system",
  "gen_ai.provider.name",
  "gen_ai.request.model",
  "gen_ai.agent.name",
  "gen_ai.tool.name",
  "openinference.span.kind",
  "llm.model_name",
  "langsmith.span.kind",
  "ai.operationId",
];

/** The SELECT for one page, and its parameters. Exported for tests. */
export function spansQuery(o: Omit<FetchSpansOptions, "url">, table: string, mode: AttributeMode): { sql: string; params: Record<string, string> } {
  const params: Record<string, string> = { table, limit: String(o.limit ?? 5000) };
  const where: string[] = [];
  if (o.since !== undefined) {
    where.push("Timestamp >= fromUnixTimestamp64Nano({since:Int64})");
    params.since = (BigInt(Math.floor(o.since)) * 1_000_000n).toString();
  }
  if (o.until !== undefined) {
    where.push("Timestamp < fromUnixTimestamp64Nano({until:Int64})");
    params.until = (BigInt(Math.floor(o.until)) * 1_000_000n).toString();
  }
  if (o.after) {
    where.push("(Timestamp, TraceId, SpanId) > (fromUnixTimestamp64Nano({at:Int64}), {tid:String}, {sid:String})");
    params.at = o.after.ts;
    params.tid = o.after.traceId;
    params.sid = o.after.spanId;
  }
  if (o.genAiOnly !== false) {
    // Whole traces that hold an agent span, so a trace's other spans (the
    // Claude Code interaction around its model calls, a Vercel ai.generateText
    // around its doGenerate) come too, as they would when posted live.
    const keys = mode === "json" ? "JSONAllPaths(SpanAttributes)" : "mapKeys(SpanAttributes)";
    const inner = [`(hasAny(${keys}, {agent_keys:Array(String)}) OR startsWith(SpanName, 'claude_code.') OR ScopeName = 'eve.agent')`];
    if (o.since !== undefined) inner.push("Timestamp >= fromUnixTimestamp64Nano({since:Int64})");
    if (o.until !== undefined) inner.push("Timestamp < fromUnixTimestamp64Nano({until:Int64})");
    where.push(`TraceId IN (SELECT TraceId FROM {table:Identifier} WHERE ${inner.join(" AND ")})`);
    params.agent_keys = `[${AGENT_KEYS.map((k) => `'${k}'`).join(",")}]`;
  }
  if (o.where?.trim()) where.push(`(${o.where})`);
  const sql =
    `SELECT ${COLUMNS} FROM {table:Identifier}` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY Timestamp, TraceId, SpanId LIMIT {limit:UInt32} FORMAT JSONEachRow";
  return { sql, params };
}

/** One page of rows in (Timestamp, TraceId, SpanId) order, and the cursor after it. */
export async function fetchSpans(o: FetchSpansOptions): Promise<{ rows: ClickHouseSpanRow[]; mode: AttributeMode; next?: SpanCursor }> {
  const e = endpoint(o);
  const mode = o.mode ?? (await attributeMode(o));
  const { sql, params } = spansQuery(o, e.table, mode);
  const rows = jsonLines<ClickHouseSpanRow>(await query(e, sql, params));
  const last = rows.at(-1);
  const next = last ? { ts: String(last.TimestampNs ?? timestampNanos(last.Timestamp)), traceId: last.TraceId ?? "", spanId: last.SpanId ?? "" } : undefined;
  return { rows, mode, ...(next ? { next } : {}) };
}

// ---------------------------------------------------------------- import

export interface ImportClickHouseOptions extends Omit<FetchSpansOptions, "after" | "mode"> {
  store: IndexStore;
  blobs: BlobStore;
  maxInlineBytes?: number;
  /** Default: the built-in secret rules, as the collector. false: none. */
  redactor?: Redactor | false;
  prices?: Prices;
  /** Count only: read the rows and map them, store nothing and keep no cursor. */
  dryRun?: boolean;
  /** Start from `since` instead of the saved cursor. */
  fromStart?: boolean;
  /**
   * How far before the saved cursor a run starts reading again, in ms (default
   * one hour). A row's Timestamp is its span's start, and a long span (an
   * agent's root span) is exported after the spans under it, so it can land
   * behind the cursor; reading again stores nothing twice.
   */
  overlapMs?: number;
  onPage?: (p: { spans: number; events: number }) => void;
}

export interface ImportClickHouseResult {
  mode: AttributeMode;
  /** Rows read (on a re-run, the rows in the overlap before the cursor too). */
  spans: number;
  /** Events mapped from them. */
  events: number;
  /** Events newly stored (0 on a re-run, which reads only the overlap again). */
  inserted: number;
  sessions: string[];
  rejected: number;
  errors: string[];
  /** Where the next run starts (a dry run leaves the saved one as it was). */
  cursor?: SpanCursor;
  dryRun: boolean;
}

/**
 * Pages GenAI spans out of ClickHouse into the index, through one receiver
 * pipeline. The cursor (the last row read) is kept in the index kv under
 * cursorKey(), so the next run reads only newer rows; event ids are stable,
 * so reading a row again stores nothing new.
 */
export async function importClickHouse(o: ImportClickHouseOptions): Promise<ImportClickHouseResult> {
  const key = cursorKey(o);
  const redactor = o.redactor === false ? undefined : (o.redactor ?? createRedactor());
  const prices = o.prices ?? pricesFor();
  const blobs: BlobStore = o.dryRun ? DRY_BLOBS : o.blobs;
  // A dry run reads trace → conversation entries but saves none.
  const kvGet = o.store.kvGet?.bind(o.store);
  const pipeline = createOtlpPipeline({
    store: o.dryRun ? ({ ...(kvGet ? { kvGet } : {}) } as unknown as IndexStore) : o.store,
    blobs,
    ...(o.maxInlineBytes !== undefined ? { maxInlineBytes: o.maxInlineBytes } : {}),
    ...(redactor ? { redactor } : {}),
    keepRaw: false,
  });
  let saved: SpanCursor | undefined;
  if (!o.fromStart && o.store.kvGet) {
    try {
      const v = await o.store.kvGet(key);
      if (v) saved = JSON.parse(v) as SpanCursor;
    } catch {
      saved = undefined;
    }
  }
  const overlapNs = BigInt(Math.max(0, Math.floor(o.overlapMs ?? DEFAULT_OVERLAP_MS))) * 1_000_000n;
  let after: SpanCursor | undefined = saved && overlapNs ? { ts: String(BigInt(saved.ts) - overlapNs), traceId: "", spanId: "" } : saved;
  const result: ImportClickHouseResult = { mode: "map", spans: 0, events: 0, inserted: 0, sessions: [], rejected: 0, errors: [], dryRun: !!o.dryRun, ...(saved ? { cursor: saved } : {}) };
  const touched = new Set<string>();
  let mode: AttributeMode | undefined;
  for (;;) {
    const page = await fetchSpans({ ...o, ...(after ? { after } : {}), ...(mode ? { mode } : {}) });
    mode = result.mode = page.mode;
    if (!page.rows.length) break;
    const batch = o.dryRun ? undefined : blobs.batch?.();
    const mapped = await pipeline.map("traces", rowsToResourceSpans(page.rows, page.mode), batch);
    const events = applyPricing(mapped.events, prices);
    result.spans += page.rows.length;
    result.events += events.length;
    result.rejected += mapped.rejected;
    result.errors.push(...mapped.errors);
    if (o.dryRun) for (const e of events) touched.add(e.sessionId);
    else {
      await batch?.flush();
      const inserted = events.length ? (await o.store.putEvents(events)).inserted : 0;
      result.inserted += inserted;
      // Sessions of a page that stored something (rows read again in the overlap store nothing).
      if (inserted) for (const e of events) touched.add(e.sessionId);
      if (page.next && (!result.cursor || compareCursor(page.next, result.cursor) > 0)) {
        result.cursor = page.next;
        if (o.store.kvSet) await o.store.kvSet(key, JSON.stringify(page.next));
      }
    }
    if (page.next) after = page.next;
    o.onPage?.({ spans: result.spans, events: result.events });
    if (page.rows.length < (o.limit ?? 5000)) break;
  }
  if (!o.dryRun) {
    const sessions: Session[] = await rebuildSessions(o.store, touched);
    result.sessions = sessions.map((s) => s.id);
  } else result.sessions = [...touched];
  return result;
}

const DEFAULT_OVERLAP_MS = 3_600_000;

function compareCursor(a: SpanCursor, b: SpanCursor): number {
  const at = BigInt(a.ts);
  const bt = BigInt(b.ts);
  if (at !== bt) return at < bt ? -1 : 1;
  if (a.traceId !== b.traceId) return a.traceId < b.traceId ? -1 : 1;
  return a.spanId < b.spanId ? -1 : a.spanId > b.spanId ? 1 : 0;
}

/** Hashes without storing (a dry run writes nothing). Only put() is called by the pipeline. */
const DRY_BLOBS = { kind: "dry-run", put: async (data: Uint8Array | string) => sha256Hex(data) } as unknown as BlobStore;
