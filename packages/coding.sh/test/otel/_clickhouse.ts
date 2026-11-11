// Rows as the OpenTelemetry Collector's clickhouseexporter writes them, and a
// stub of ClickHouse's HTTP interface that serves them, for the import tests.
//
// toRows() follows exporter_traces.go: Map mode stores every attribute value as
// pcommon's AsString (ints "42", bools "true", arrays and maps as JSON); JSON
// mode (`json: true`) stores typed values with dotted keys as nested objects.
// The stub answers the two queries fetchSpans sends, honoring the param_*
// values (keyset cursor, since, until, limit), a --where of the form
// `ServiceName = '<name>'` and the credential headers. `fault` makes a page
// fail: a dropped connection, before or part-way through the rows, or an error status.
import { createServer, type Server } from "node:http";
import type { ClickHouseSpanRow } from "../../src/otel/clickhouse.ts";
import type { Attrs, OtelValue, ResourceSpans } from "../../src/otel/model.ts";

/** pcommon Value.AsString: what Map(String, String) holds. */
function asString(v: OtelValue): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

/** The JSON type's view: dotted keys as nested objects. */
function nest(a: Attrs): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a)) {
    const parts = k.split(".");
    let o = out;
    for (const p of parts.slice(0, -1)) o = (o[p] ??= {}) as Record<string, unknown>;
    o[parts.at(-1)!] = v;
  }
  return out;
}

const KIND_NAMES = ["Unspecified", "Internal", "Server", "Client", "Producer", "Consumer"];
const STATUS_NAMES = ["Unset", "Ok", "Error"];

/** Rows as fetchSpans selects them, from OTLP, as clickhouseexporter would store them. */
export function toRows(resourceSpans: ResourceSpans[], mode: "map" | "json", spelling: "short" | "proto" = "short"): ClickHouseSpanRow[] {
  const attrs = (a: Attrs) => (mode === "map" ? Object.fromEntries(Object.entries(a).map(([k, v]) => [k, asString(v)])) : nest(a));
  const rows: ClickHouseSpanRow[] = [];
  for (const rs of resourceSpans) {
    const res = rs.resource?.attributes ?? {};
    for (const ss of rs.scopeSpans) {
      for (const s of ss.spans) {
        const kind = s.kind ?? 0;
        const code = s.status?.code ?? 0;
        rows.push({
          TimestampNs: s.startTimeUnixNano,
          TraceId: s.traceId ?? "",
          SpanId: s.spanId ?? "",
          ParentSpanId: s.parentSpanId ?? "",
          TraceState: s.traceState ?? "",
          SpanName: s.name,
          SpanKind: spelling === "short" ? KIND_NAMES[kind] : `SPAN_KIND_${KIND_NAMES[kind]!.toUpperCase()}`,
          ServiceName: typeof res["service.name"] === "string" ? res["service.name"] : "",
          ResourceAttributes: attrs(res),
          ScopeName: ss.scope?.name ?? "",
          ScopeVersion: ss.scope?.version ?? "",
          SpanAttributes: attrs(s.attributes),
          Duration: Number(BigInt(s.endTimeUnixNano) - BigInt(s.startTimeUnixNano)),
          StatusCode: spelling === "short" ? STATUS_NAMES[code] : `STATUS_CODE_${STATUS_NAMES[code]!.toUpperCase()}`,
          StatusMessage: s.status?.message ?? "",
          EventTimesNs: (s.events ?? []).map((e) => e.timeUnixNano),
          "Events.Name": (s.events ?? []).map((e) => e.name),
          "Events.Attributes": (s.events ?? []).map((e) => attrs(e.attributes)),
          "Links.TraceId": (s.links ?? []).map((l) => l.traceId ?? ""),
          "Links.SpanId": (s.links ?? []).map((l) => l.spanId ?? ""),
          "Links.TraceState": (s.links ?? []).map(() => ""),
          "Links.Attributes": (s.links ?? []).map((l) => attrs(l.attributes)),
        });
      }
    }
  }
  return rows;
}

/**
 * `traces` traces of `per` chat spans each, as clickhouseexporter stores them in
 * Map mode: one session per trace, a trace's spans next to each other in the
 * table's order. The first span starts at `startMs`, traces one second apart.
 */
export function chatRows(traces: number, per: number, startMs = 1_767_323_045_000): ClickHouseSpanRow[] {
  const hex = (n: number, len: number) => n.toString(16).padStart(len, "0");
  const rows: ClickHouseSpanRow[] = [];
  for (let t = 0; t < traces; t++) {
    for (let s = 0; s < per; s++) {
      rows.push({
        TimestampNs: String(BigInt(startMs + t * 1000 + s * 10) * 1_000_000n),
        TraceId: hex(t + 1, 32),
        SpanId: hex(t * per + s + 1, 16),
        ParentSpanId: "",
        TraceState: "",
        SpanName: "chat claude-sonnet-4-5",
        SpanKind: "Client",
        ServiceName: "chat-app",
        ResourceAttributes: { "service.name": "chat-app" },
        ScopeName: "chat-app",
        ScopeVersion: "",
        SpanAttributes: { "gen_ai.operation.name": "chat", "gen_ai.system": "anthropic", "gen_ai.request.model": "claude-sonnet-4-5", "gen_ai.usage.input_tokens": "1000", "gen_ai.usage.output_tokens": "200" },
        Duration: 5_000_000,
        StatusCode: "Ok",
        StatusMessage: "",
        EventTimesNs: [],
        "Events.Name": [],
        "Events.Attributes": [],
        "Links.TraceId": [],
        "Links.SpanId": [],
        "Links.TraceState": [],
        "Links.Attributes": [],
      });
    }
  }
  return rows;
}

export interface Seen {
  sql: string;
  params: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
}

/** How a spans SELECT fails: the connection drops before the answer or part-way through the rows, or ClickHouse answers an error with this HTTP status. */
export type Fault = "reset" | "cut" | number;

/** Answers system.columns and the spans SELECT like ClickHouse's HTTP interface, over `rows`. */
export async function stubClickHouse(opts: {
  rows: () => ClickHouseSpanRow[];
  mode: () => "map" | "json";
  user?: string;
  password?: string;
  /** Called with the number of each spans SELECT (1 for the first the stub sees). */
  fault?: (select: number) => Fault | undefined;
}) {
  const seen: Seen[] = [];
  let selects = 0;
  const server: Server = createServer((req, res) => {
    let sql = "";
    req.on("data", (c) => (sql += c));
    req.on("end", () => {
      const url = new URL(req.url!, "http://x");
      seen.push({ sql, params: url.searchParams, headers: req.headers });
      if (opts.user && (req.headers["x-clickhouse-user"] !== opts.user || req.headers["x-clickhouse-key"] !== opts.password)) {
        res.writeHead(516, { "x-clickhouse-exception-code": "516" });
        res.end(`Code: 516. DB::Exception: ${opts.user}: Authentication failed: password is incorrect, or there is no user with such name. (AUTHENTICATION_FAILED)\n`);
        return;
      }
      if (sql.includes("system.columns")) {
        res.end(JSON.stringify({ type: opts.mode() === "json" ? "JSON" : "Map(LowCardinality(String), String)" }) + "\n");
        return;
      }
      const p = url.searchParams;
      const key = (r: ClickHouseSpanRow) => [BigInt(String(r.TimestampNs)), r.TraceId!, r.SpanId!] as const;
      const cmp = (a: readonly [bigint, string, string], b: readonly [bigint, string, string]) =>
        a[0] !== b[0] ? (a[0] < b[0] ? -1 : 1) : a[1] !== b[1] ? (a[1] < b[1] ? -1 : 1) : a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0;
      let rows = [...opts.rows()].sort((a, b) => cmp(key(a), key(b)));
      if (p.has("param_since")) rows = rows.filter((r) => key(r)[0] >= BigInt(p.get("param_since")!));
      if (p.has("param_until")) rows = rows.filter((r) => key(r)[0] < BigInt(p.get("param_until")!));
      const service = /AND \(ServiceName = '([^']*)'\)/.exec(sql)?.[1];
      if (service !== undefined) rows = rows.filter((r) => r.ServiceName === service);
      if (p.has("param_at")) {
        const at = [BigInt(p.get("param_at")!), p.get("param_tid")!, p.get("param_sid")!] as const;
        rows = rows.filter((r) => cmp(key(r), at) > 0);
      }
      rows = rows.slice(0, Number(p.get("param_limit")));
      const body = rows.map((r) => JSON.stringify(r) + "\n").join("");
      const fault = opts.fault?.(++selects);
      if (fault === "reset") {
        req.socket.destroy();
        return;
      }
      if (fault === "cut") {
        res.writeHead(200, { "Content-Length": Buffer.byteLength(body) });
        res.write(body.slice(0, Math.ceil(body.length / 2)), () => req.socket.destroy());
        return;
      }
      if (fault !== undefined) {
        // ClickHouse's own error answers: 503 when it has too many queries, an exception otherwise.
        const [code, name, text] = fault === 503 ? ["202", "TOO_MANY_SIMULTANEOUS_QUERIES", "Too many simultaneous queries. Maximum: 100"] : ["241", "MEMORY_LIMIT_EXCEEDED", "Memory limit (total) exceeded"];
        res.writeHead(fault, { "x-clickhouse-exception-code": code });
        res.end(`Code: ${code}. DB::Exception: ${text}. (${name})\n`);
        return;
      }
      res.end(body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/`, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

export type StubClickHouse = Awaited<ReturnType<typeof stubClickHouse>>;
