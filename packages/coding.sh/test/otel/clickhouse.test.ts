// collector import --clickhouse (src/otel/clickhouse.ts): rows the OpenTelemetry
// Collector's clickhouseexporter writes to otel_traces, read back over
// ClickHouse's HTTP interface, become the same events and sessions as posting
// the original OTLP to the receiver.
//
// Rows come from toRows() in _clickhouse.ts (the exporter's encoding, Map and
// JSON mode) and are served by its stub of ClickHouse's HTTP interface.
// The live check against a real ClickHouse is deploy/test/clickhouse-import.test.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { after, before, describe, it } from "node:test";
import { createRedactor } from "../../src/core/redact.ts";
import {
  attributesOf,
  ClickHouseError,
  type ClickHouseSpanRow,
  cursorKey,
  fetchSpans,
  importClickHouse,
  rowsToResourceSpans,
  spanKindOf,
  spansQuery,
  statusCodeOf,
  timestampNanos,
} from "../../src/otel/clickhouse.ts";
import { decodeTraceJson } from "../../src/otel/json.ts";
import { type Receiver, startReceiver } from "../../src/otel/receiver.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { type StubClickHouse, stubClickHouse, toRows } from "./_clickhouse.ts";
import { MemBlobs, MemIndex } from "./_memstore.ts";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/otel/${name}`, import.meta.url), "utf8");

class KvIndex extends MemIndex {
  readonly kv = new Map<string, string>();
  async kvGet(key: string): Promise<string | undefined> {
    return this.kv.get(key);
  }
  async kvSet(key: string, value: string): Promise<void> {
    this.kv.set(key, value);
  }
}

function post(base: string, data: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(new URL("/v1/traces", base), { method: "POST", agent: false, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode!));
    });
    req.on("error", reject);
    req.end(data);
  });
}

/** Everything a session view reads: each session and its events, by id. */
async function dump(store: MemIndex) {
  const out: Record<string, { session: unknown; events: AgentEvent[] }> = {};
  for (const [id, session] of [...store.sessions].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const events = (await store.listEvents(id)).sort((a, b) => (a.id < b.id ? -1 : 1));
    out[id] = { session, events };
  }
  return out;
}

async function posted(body: string) {
  const store = new KvIndex();
  const rx: Receiver = await startReceiver({ port: 0, store, blobs: new MemBlobs() });
  try {
    assert.equal(await post(rx.url, body), 200);
  } finally {
    await rx.close();
  }
  return store;
}

// ---------------------------------------------------------------- tests

describe("clickhouse rows → OTLP", () => {
  it("reads both SpanKind and StatusCode spellings", () => {
    assert.equal(spanKindOf("Client"), 3);
    assert.equal(spanKindOf("SPAN_KIND_CLIENT"), 3);
    assert.equal(spanKindOf("Internal"), 1);
    assert.equal(spanKindOf("nonsense"), 0);
    assert.equal(statusCodeOf("Error"), 2);
    assert.equal(statusCodeOf("STATUS_CODE_OK"), 1);
    assert.equal(statusCodeOf(""), 0);
  });

  it("turns Map strings back into the types the exporter flattened", () => {
    const a = attributesOf({ "gen_ai.usage.input_tokens": "1200", temp: "0.7", stream: "true", "gen_ai.response.finish_reasons": '["stop"]', "gen_ai.input.messages": '[{"role":"user"}]', name: "chat" });
    assert.deepEqual(a, { "gen_ai.usage.input_tokens": 1200, temp: 0.7, stream: true, "gen_ai.response.finish_reasons": ["stop"], "gen_ai.input.messages": '[{"role":"user"}]', name: "chat" });
  });

  it("flattens JSON columns to dotted keys and unquotes 64-bit ints", () => {
    const a = attributesOf({ gen_ai: { usage: { input_tokens: "1200", output_tokens: 40 }, operation: { name: "chat" } }, ai: { response: { finishReason: "stop" } } }, "json");
    assert.deepEqual(a, { "gen_ai.usage.input_tokens": 1200, "gen_ai.usage.output_tokens": 40, "gen_ai.operation.name": "chat", "ai.response.finishReason": "stop" });
  });

  it("reads DateTime64(9) text and unix nanoseconds", () => {
    assert.equal(timestampNanos("2026-01-02 03:04:05.123456789"), "1767323045123456789");
    assert.equal(timestampNanos("1767323045123456789"), "1767323045123456789");
    assert.equal(timestampNanos("1767323045.5"), "1767323045500000000");
  });

  it("groups rows by resource and scope, with events, links and status", () => {
    const rows: ClickHouseSpanRow[] = [
      { TimestampNs: "1000", TraceId: "AB".repeat(16), SpanId: "01".repeat(8), SpanName: "chat m", SpanKind: "Client", ServiceName: "svc", ResourceAttributes: { "service.name": "svc" }, ScopeName: "s", ScopeVersion: "1", SpanAttributes: {}, Duration: "500", StatusCode: "Error", StatusMessage: "boom", EventTimesNs: ["1200"], "Events.Name": ["exception"], "Events.Attributes": [{ "exception.message": "boom" }], "Links.TraceId": ["cd".repeat(16)], "Links.SpanId": ["02".repeat(8)], "Links.TraceState": [""], "Links.Attributes": [{}] },
      { TimestampNs: "2000", TraceId: "ab".repeat(16), SpanId: "03".repeat(8), SpanName: "x", SpanKind: "SPAN_KIND_INTERNAL", ServiceName: "svc", ResourceAttributes: { "service.name": "svc" }, ScopeName: "s", ScopeVersion: "1", SpanAttributes: {}, Duration: 0, StatusCode: "STATUS_CODE_UNSET" },
      { TimestampNs: "3000", TraceId: "ab".repeat(16), SpanId: "04".repeat(8), SpanName: "y", ServiceName: "other", ResourceAttributes: {}, ScopeName: "t" },
    ];
    const rs = rowsToResourceSpans(rows);
    assert.equal(rs.length, 2);
    assert.equal(rs[0]!.scopeSpans.length, 1);
    const [a, b] = rs[0]!.scopeSpans[0]!.spans;
    assert.equal(a!.traceId, "ab".repeat(16));
    assert.equal(a!.endTimeUnixNano, "1500");
    assert.deepEqual(a!.status, { code: 2, message: "boom" });
    assert.deepEqual(a!.events, [{ timeUnixNano: "1200", name: "exception", attributes: { "exception.message": "boom" } }]);
    assert.deepEqual(a!.links, [{ traceId: "cd".repeat(16), spanId: "02".repeat(8), attributes: {} }]);
    assert.equal(b!.kind, 1);
    assert.deepEqual(rs[1]!.resource?.attributes, { "service.name": "other" });
  });

  it("sends every value as a typed parameter and splices only --where", () => {
    const { sql, params } = spansQuery({ since: 1_700_000_000_000, after: { ts: "5", traceId: "t", spanId: "s" }, where: "ServiceName = 'claude-code'", limit: 10 }, "otel_traces", "map");
    assert.match(sql, /FROM \{table:Identifier\}/);
    assert.match(sql, /\(Timestamp, TraceId, SpanId\) > \(fromUnixTimestamp64Nano\(\{at:Int64\}\), \{tid:String\}, \{sid:String\}\)/);
    assert.match(sql, /TraceId IN \(SELECT TraceId FROM \{table:Identifier\} WHERE \(hasAny\(mapKeys\(SpanAttributes\), \{agent_keys:Array\(String\)\}\)/);
    assert.match(sql, /AND \(ServiceName = 'claude-code'\) ORDER BY Timestamp, TraceId, SpanId LIMIT \{limit:UInt32\}/);
    assert.equal(params.since, "1700000000000000000");
    assert.deepEqual([params.at, params.tid, params.sid, params.limit, params.table], ["5", "t", "s", "10", "otel_traces"]);
    assert.match(params.agent_keys!, /^\['gen_ai\.operation\.name',.*'ai\.operationId'\]$/);
    assert.match(spansQuery({}, "t", "json").sql, /JSONAllPaths\(SpanAttributes\)/);
    assert.doesNotMatch(spansQuery({ genAiOnly: false }, "t", "map").sql, /TraceId IN/);
  });

  it("keeps the cursor per host, database and table, never credentials", () => {
    assert.equal(cursorKey({ url: "http://u:secret@ch:8123/?database=otel" }), "clickhouse:ch:8123/otel/otel_traces");
    assert.equal(cursorKey({ url: "https://ch:8443/", table: "logs.spans" }), "clickhouse:ch:8443/logs/spans");
  });
});

for (const name of ["claude-code-traces.json", "vercel-ai.json", "genai-semconv.json", "agent-runs/turn.json"]) {
  for (const mode of ["map", "json"] as const) {
    describe(`${name} in ${mode} mode`, () => {
      let ch: StubClickHouse;
      let rows: ClickHouseSpanRow[];
      before(async () => {
        rows = toRows(decodeTraceJson(JSON.parse(fixture(name))), mode, mode === "map" ? "short" : "proto");
        ch = await stubClickHouse({ rows: () => rows, mode: () => mode });
      });
      after(() => ch.close());

      it("imports field-by-field equal to posting the original OTLP", async () => {
        const want = await dump(await posted(fixture(name)));
        const store = new KvIndex();
        // limit 2 makes it page: the keyset cursor carries each page on.
        const r = await importClickHouse({ url: ch.url, store, blobs: new MemBlobs(), limit: 2, since: 0 });
        assert.equal(r.mode, mode);
        assert.equal(r.spans, rows.length);
        assert.equal(r.rejected, 0);
        assert.ok(Object.keys(want).length > 0);
        assert.deepEqual(await dump(store), want);
        assert.deepEqual(r.sessions.sort(), Object.keys(want));
        // The second run reads only the hour before the saved cursor again, and stores nothing.
        const again = await importClickHouse({ url: ch.url, store, blobs: new MemBlobs(), limit: 2, since: 0 });
        assert.deepEqual([again.inserted, again.sessions.length], [0, 0]);
        assert.deepEqual(again.cursor, r.cursor);
        assert.deepEqual(await dump(store), want);
        const none = await importClickHouse({ url: ch.url, store, blobs: new MemBlobs(), limit: 2, since: 0, overlapMs: 0 });
        assert.deepEqual([none.spans, none.events, none.inserted], [0, 0, 0]);
      });
    });
  }
}

describe("collector import edge cases", () => {
  let ch: StubClickHouse;
  const rows = toRows(decodeTraceJson(JSON.parse(fixture("vercel-ai.json"))), "map");
  before(async () => {
    ch = await stubClickHouse({ rows: () => rows, mode: () => "map", user: "otel", password: ["pa", "ss"].join("") });
  });
  after(() => ch.close());
  const auth = { CLICKHOUSE_USER: "otel", CLICKHOUSE_PASSWORD: ["pa", "ss"].join("") };

  it("sends credentials as headers, from the URL or the environment", async () => {
    await fetchSpans({ url: ch.url.replace("//", `//otel:${auth.CLICKHOUSE_PASSWORD}@`) + "?database=otel", since: 0 });
    const last = ch.seen.at(-1)!;
    assert.equal(last.headers["x-clickhouse-user"], "otel");
    assert.equal(last.params.get("database"), "otel");
    assert.equal(last.params.get("wait_end_of_query"), "1");
    assert.ok(![...last.params.keys()].some((k) => /^(user|password|key)$/i.test(k)));
    assert.ok(!String(last.params).includes(auth.CLICKHOUSE_PASSWORD));
    const page = await fetchSpans({ url: ch.url, env: auth, since: 0, limit: 3 });
    assert.equal(page.rows.length, 3);
    assert.deepEqual(page.next, { ts: String(page.rows[2]!.TimestampNs), traceId: page.rows[2]!.TraceId, spanId: page.rows[2]!.SpanId });
  });

  it("a dry run maps every span and writes nothing", async () => {
    const store = new KvIndex();
    const blobs = new MemBlobs();
    const r = await importClickHouse({ url: ch.url, env: auth, store, blobs, since: 0, dryRun: true, limit: 2, maxInlineBytes: 16 });
    assert.equal(r.spans, rows.length);
    assert.ok(r.events > 0);
    assert.ok(r.sessions.length > 0);
    assert.equal(r.inserted, 0);
    assert.equal(store.events.size, 0);
    assert.equal(store.sessions.size, 0);
    assert.equal(store.kv.size, 0);
    assert.equal(blobs.data.size, 0);
  });

  it("picks up a root span exported after the spans under it, behind the cursor", async () => {
    // The trace's earliest-starting span (the root) reaches the table last.
    const sorted = [...rows].sort((a, b) => (BigInt(String(a.TimestampNs)) < BigInt(String(b.TimestampNs)) ? -1 : 1));
    const [root, ...rest] = sorted;
    let table = rest;
    const late = await stubClickHouse({ rows: () => table, mode: () => "map" });
    try {
      const store = new KvIndex();
      const first = await importClickHouse({ url: late.url, store, blobs: new MemBlobs(), since: 0 });
      assert.equal(first.spans, rest.length);
      table = sorted;
      const second = await importClickHouse({ url: late.url, store, blobs: new MemBlobs(), since: 0 });
      assert.ok(second.inserted > 0, "the root span's events are stored");
      const want = await dump(await posted(fixture("vercel-ai.json")));
      assert.deepEqual(await dump(store), want);
      assert.ok(root);
    } finally {
      await late.close();
    }
  });

  it("bad auth is a ClickHouseError with the status", async () => {
    await assert.rejects(importClickHouse({ url: ch.url, env: {}, store: new KvIndex(), blobs: new MemBlobs() }), (e: unknown) => e instanceof ClickHouseError && e.status === 516 && /Authentication failed/.test(e.message));
  });

  it("an unreachable or malformed URL is a ClickHouseError with status 0", async () => {
    await assert.rejects(fetchSpans({ url: "http://127.0.0.1:1/" }), (e: unknown) => e instanceof ClickHouseError && e.status === 0 && /can't reach ClickHouse/.test(e.message));
    await assert.rejects(fetchSpans({ url: "not a url" }), (e: unknown) => e instanceof ClickHouseError && e.status === 0);
    await assert.rejects(fetchSpans({ url: "ftp://ch/" }), (e: unknown) => e instanceof ClickHouseError && e.status === 0);
  });

  it("redacts secrets in imported spans, as the collector does", async () => {
    const secret = ["sk-ant-api03-", "A".repeat(80)].join("");
    const leaky = rows.map((r) => ({ ...r, SpanAttributes: { ...(r.SpanAttributes as Record<string, string>), "ai.prompt": `use ${secret}` } }));
    const ch2 = await stubClickHouse({ rows: () => leaky, mode: () => "map" });
    try {
      const store = new KvIndex();
      await importClickHouse({ url: ch2.url, store, blobs: new MemBlobs(), since: 0, redactor: createRedactor() });
      const all = JSON.stringify([...store.events.values()]);
      assert.ok(all.length > 0);
      assert.ok(!all.includes(secret));
    } finally {
      await ch2.close();
    }
  });
});
