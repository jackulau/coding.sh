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
import { chatRows, type Fault, type StubClickHouse, stubClickHouse, toRows } from "./_clickhouse.ts";
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

  it("keeps a cursor per row filter: --all and each --where have their own", () => {
    const url = "http://ch:8123/";
    const plain = cursorKey({ url });
    assert.equal(cursorKey({ url, genAiOnly: true, where: "  " }), plain);
    const where = cursorKey({ url, where: "ServiceName = 'claude-code'" });
    assert.match(where, /^clickhouse:ch:8123\/default\/otel_traces#where=[0-9a-f]{16}$/);
    assert.ok(!where.includes("claude-code"), "the condition itself is not in the key");
    assert.equal(cursorKey({ url, where: " ServiceName = 'claude-code' " }), where);
    assert.notEqual(cursorKey({ url, where: "ServiceName = 'codex'" }), where);
    assert.equal(cursorKey({ url, genAiOnly: false }), `${plain}#all`);
    assert.equal(cursorKey({ url, genAiOnly: false, where: "ServiceName = 'claude-code'" }), where.replace("#where", "#all#where"));
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

// Regression: the cursor was kept per table only and a run always resumed from it,
// so rows a filtered first run skipped, and a root span that landed more than the
// overlap behind the cursor, could never be imported.
describe("collector import cursor", () => {
  const HOUR_NS = 3_600_000_000_000n;
  const shift = (rows: ClickHouseSpanRow[], hours: bigint) => rows.map((r) => ({ ...r, TimestampNs: String(BigInt(String(r.TimestampNs)) + hours * HOUR_NS) }));
  const startNs = (r: ClickHouseSpanRow) => BigInt(String(r.TimestampNs));
  // Two services: claude-code first, my-vercel-app three hours later.
  const claude = toRows(decodeTraceJson(JSON.parse(fixture("claude-code-traces.json"))), "map");
  const vercel = shift(toRows(decodeTraceJson(JSON.parse(fixture("vercel-ai.json"))), "map"), 3n);
  const all = [...claude, ...vercel];
  let table: ClickHouseSpanRow[] = all;
  let ch: StubClickHouse;
  before(async () => {
    ch = await stubClickHouse({ rows: () => table, mode: () => "map" });
  });
  after(() => ch.close());

  const fresh = async (rows: ClickHouseSpanRow[]) => {
    table = rows;
    const store = new KvIndex();
    await importClickHouse({ url: ch.url, store, blobs: new MemBlobs(), since: 0 });
    return dump(store);
  };

  it("a run without the --where reads the rows the filtered run skipped", async () => {
    const want = await fresh(all);
    const store = new KvIndex();
    const run = (o: { where?: string } = {}) => importClickHouse({ url: ch.url, store, blobs: new MemBlobs(), since: 0, ...o });
    const where = "ServiceName = 'my-vercel-app'";
    const filtered = await run({ where });
    assert.equal(filtered.spans, vercel.length);
    assert.equal(store.sessions.size, 1);

    const unfiltered = await run();
    assert.equal(unfiltered.spans, all.length, "reads from --since, not from the filtered run's cursor");
    assert.ok(unfiltered.inserted > 0, "the claude-code rows behind that cursor are stored");
    assert.deepEqual(await dump(store), want);

    // Each filter resumes at its own cursor.
    assert.deepEqual([...store.kv.keys()].filter((k) => k.startsWith("clickhouse:")).sort(), [cursorKey({ url: ch.url }), cursorKey({ url: ch.url, where })].sort());
    const again = await run();
    assert.deepEqual([again.spans, again.inserted], [vercel.length, 0], "only the hour before the cursor is read again");
    assert.deepEqual([(await run({ where })).inserted, (await run({ where: "ServiceName = 'claude-code'" })).spans], [0, claude.length]);
  });

  it("genAiOnly: false (--all) does not resume from the agent-traces cursor", async () => {
    table = all;
    const store = new KvIndex();
    await importClickHouse({ url: ch.url, store, blobs: new MemBlobs(), since: 0, overlapMs: 0 });
    const every = await importClickHouse({ url: ch.url, store, blobs: new MemBlobs(), since: 0, overlapMs: 0, genAiOnly: false });
    assert.equal(every.spans, all.length);
    assert.equal((await importClickHouse({ url: ch.url, store, blobs: new MemBlobs(), since: 0, overlapMs: 0, genAiOnly: false })).spans, 0);
  });

  it("fromStart reads from since again and leaves the cursor where it was", async () => {
    table = all;
    const store = new KvIndex();
    const first = await importClickHouse({ url: ch.url, store, blobs: new MemBlobs(), since: 0 });
    const since = Number(startNs(vercel[0]!) / 1_000_000n) - 1000;
    const late = await importClickHouse({ url: ch.url, store, blobs: new MemBlobs(), since, fromStart: true, overlapMs: 0 });
    assert.deepEqual([late.spans, late.inserted], [vercel.length, 0], "from that time, whatever the cursor says");
    const whole = await importClickHouse({ url: ch.url, store, blobs: new MemBlobs(), since: 0, fromStart: true });
    assert.deepEqual([whole.spans, whole.inserted], [all.length, 0]);
    assert.deepEqual(whole.cursor, first.cursor);
    assert.deepEqual(JSON.parse(store.kv.get(cursorKey({ url: ch.url }))!), first.cursor, "the cursor is still saved");
    // A bounded re-read of old rows does not pull the cursor back.
    const old = await importClickHouse({ url: ch.url, store, blobs: new MemBlobs(), since: 0, until: since, fromStart: true });
    assert.equal(old.spans, claude.length);
    assert.deepEqual(JSON.parse(store.kv.get(cursorKey({ url: ch.url }))!), first.cursor);
  });

  it("fromStart imports a root span that landed more than the overlap behind the cursor", async () => {
    // The root starts first and is exported last; its children started two hours later.
    const sorted = [...vercel].sort((a, b) => (startNs(a) < startNs(b) ? -1 : 1));
    const [root, ...rest] = sorted;
    const children = shift(rest, 2n);
    const want = await fresh([root!, ...children]);
    table = children;
    const store = new KvIndex();
    const run = (o: { fromStart?: boolean } = {}) => importClickHouse({ url: ch.url, store, blobs: new MemBlobs(), since: 0, ...o });
    assert.equal((await run()).spans, children.length);
    table = [root!, ...children];
    assert.equal((await run()).inserted, 0, "a resumed run reads one hour back: the root is two hours back");
    const reset = await run({ fromStart: true });
    assert.ok(reset.inserted > 0, "the root span's events are stored");
    assert.deepEqual(await dump(store), want);
  });
});

// Regression: sessions were rebuilt once, after the last page, and the cursor was
// saved per page. A run that lost its connection on a later page left the earlier
// pages' events with no session, and the next run read those pages again, stored
// nothing new and so rebuilt nothing: fewer sessions than traces, with exit 0.
describe("an import that fails part-way", () => {
  // 4 traces of 3 spans, 4 rows a page: 3 pages (and an empty fourth), each trace but the first split over two.
  const rows = chatRows(4, 3);
  const traces = new Set(rows.map((r) => r.TraceId)).size;
  let fault: (select: number) => Fault | undefined = () => undefined;
  let ch: StubClickHouse;
  let want: Awaited<ReturnType<typeof dump>>;
  before(async () => {
    ch = await stubClickHouse({ rows: () => rows, mode: () => "map", fault: (n) => fault(n) });
    const clean = new KvIndex();
    await importClickHouse({ url: ch.url, store: clean, blobs: new MemBlobs(), limit: 4, since: 0 });
    want = await dump(clean);
    assert.equal(Object.keys(want).length, traces);
  });
  after(() => ch.close());

  /** Faults counted from the next SELECT on: `at(2)` is the second page the next run asks for. */
  const faults = (f: (page: number) => Fault | undefined) => {
    const from = ch.seen.filter((q) => !q.sql.includes("system.columns")).length;
    fault = (n) => f(n - from);
  };
  const run = (store: KvIndex, o: { retryDelaysMs?: number[]; fetch?: typeof fetch } = {}) => importClickHouse({ url: ch.url, store, blobs: new MemBlobs(), limit: 4, since: 0, ...o });
  /** Sessions that have stored events and no row. */
  const orphans = (store: KvIndex) => [...new Set([...store.events.values()].map((e) => e.event.sessionId))].filter((id) => !store.sessions.has(id));

  it("leaves no stored event without its session, and the next run finishes the job", async () => {
    const store = new KvIndex();
    faults((page) => (page >= 2 ? "reset" : undefined));
    await assert.rejects(run(store, { retryDelaysMs: [1, 1] }), (e: unknown) => {
      assert.ok(e instanceof ClickHouseError, String(e));
      assert.equal(e.status, 0);
      assert.match(e.message, /can't reach ClickHouse.*\(3 tries\)/);
      assert.deepEqual(e.imported, { spans: 4, inserted: store.events.size, sessions: 2 }, "how far it got");
      return true;
    });
    assert.ok(store.events.size > 0, "page 1 is stored");
    assert.deepEqual(orphans(store), [], "and its sessions are built before its cursor is saved");
    assert.deepEqual(JSON.parse(store.kv.get(cursorKey({ url: ch.url }))!).spanId, rows[3]!.SpanId);

    faults(() => undefined);
    const again = await run(store);
    assert.ok(again.inserted > 0, "pages 2 and 3");
    assert.equal(store.sessions.size, traces, "one session per trace");
    assert.deepEqual(orphans(store), []);
    assert.deepEqual(await dump(store), want, "the same store as a run that never failed");
  });

  for (const [name, how] of [
    ["a connection reset before the answer", "reset"],
    ["a connection dropped part-way through the rows", "cut"],
    ["a 503 from ClickHouse", 503],
  ] as const) {
    it(`tries a page again after ${name}`, async () => {
      const store = new KvIndex();
      faults((page) => (page === 2 ? how : undefined));
      const before = ch.seen.length;
      const r = await run(store, { retryDelaysMs: [1] });
      assert.equal(r.spans, rows.length);
      assert.equal(r.sessions.length, traces);
      assert.deepEqual(await dump(store), want);
      // system.columns, four pages (the last one empty), and page 2 twice.
      assert.equal(ch.seen.length - before, 6);
    });
  }

  it("tries again after a 5xx that is not ClickHouse's own (a proxy in front of it)", async () => {
    let calls = 0;
    const viaProxy: typeof fetch = async (...args) => (++calls === 3 ? new Response("upstream connect error or disconnect/reset before headers", { status: 500 }) : fetch(...args));
    faults(() => undefined);
    const store = new KvIndex();
    await importClickHouse({ url: ch.url, store, blobs: new MemBlobs(), limit: 4, since: 0, fetch: viaProxy, retryDelaysMs: [1] });
    assert.equal(calls, 6, "system.columns, four pages (the last one empty), and page 2 twice");
    assert.deepEqual(await dump(store), want);
  });

  it("does not try again when ClickHouse answers with an exception, or nothing listens at the URL", async () => {
    const store = new KvIndex();
    faults((page) => (page === 2 ? 500 : undefined));
    const before = ch.seen.length;
    await assert.rejects(run(store), (e: unknown) => e instanceof ClickHouseError && e.status === 500 && !e.transient && /MEMORY_LIMIT_EXCEEDED/.test(e.message) && e.imported?.spans === 4);
    assert.equal(ch.seen.length - before, 3, "system.columns, page 1, page 2 once");
    assert.deepEqual(orphans(store), []);

    let calls = 0;
    const refused: typeof fetch = async () => {
      calls++;
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    };
    await assert.rejects(run(new KvIndex(), { fetch: refused }), (e: unknown) => e instanceof ClickHouseError && e.status === 0 && !e.transient && e.imported === undefined);
    assert.equal(calls, 1);
  });

  it("rebuilds a page that was stored but whose cursor was never saved", async () => {
    // The store fails while page 2's sessions are written: its events are in, its cursor is not.
    class Flaky extends KvIndex {
      failUpserts = 0;
      upserts = 0;
      override async upsertSession(session: Parameters<KvIndex["upsertSession"]>[0]): Promise<void> {
        if (++this.upserts > 2 && this.failUpserts-- > 0) throw new Error("disk full");
        return super.upsertSession(session);
      }
    }
    faults(() => undefined);
    const store = new Flaky();
    store.failUpserts = 1;
    await assert.rejects(run(store), /disk full/);
    assert.ok(orphans(store).length > 0, "page 2's events are stored with no session");
    const again = await run(store);
    assert.ok(again.inserted > 0, "page 3");
    assert.deepEqual(orphans(store), []);
    assert.deepEqual(await dump(store), want);
  });
});

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
