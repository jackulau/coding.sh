// The receiver's group commit on the real stores (SQLite index, file blobs):
// concurrent requests are stored together, each still gets its own answer,
// and a session built from the events in hand equals one read back from the store.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { buildSession } from "../../src/core/sessions.ts";
import type { IndexStore, Sink } from "../../src/core/types.ts";
import { type BatchInfo, type Receiver, startReceiver } from "../../src/otel/receiver.ts";
import { SinkMirror } from "../../src/server/mirror.ts";
import { FsBlobStore } from "../../src/store/fs-blobs.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { MemBlobs, MemIndex } from "./_memstore.ts";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/otel/${name}`, import.meta.url), "utf8");

function post(base: string, data: string, path = "/v1/traces"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(new URL(path, base), { method: "POST", agent: false, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

describe("receiver group commit", () => {
  let root: string;
  let store: SqliteIndexStore;
  let rx: Receiver;
  const batches: BatchInfo[] = [];
  before(async () => {
    root = mkdtempSync(join(tmpdir(), "cs-rx-commit-"));
    store = await SqliteIndexStore.open(join(root, "index.db"));
    rx = await startReceiver({ port: 0, store, blobs: new FsBlobStore(join(root, "blobs")), onBatch: (b) => void batches.push(b) });
  });
  after(async () => {
    await rx.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("answers every request of a concurrent burst and stores each once", async () => {
    const bodies = ["genai-semconv.json", "vercel-ai.json", "openinference.json", "claude-code-traces.json", "agent-runs/turn.json", "genai-semconv-agents.json"].map(fixture);
    const res = await Promise.all([...bodies, ...bodies].map((b) => post(rx.url, b)));
    assert.deepEqual(res.map((r) => r.status), Array(12).fill(200));
    assert.equal(batches.length, 12);
    // The second copy of each request stores nothing new, whichever group it landed in.
    const inserted = batches.reduce((n, b) => n + b.inserted, 0);
    const mapped = batches.reduce((n, b) => n + b.events.length, 0) / 2;
    assert.equal(inserted, mapped);
    for (const b of batches) for (const s of b.sessions) assert.ok(b.events.some((e) => e.sessionId === s.id), "a batch reports only its own sessions");
  });

  it("builds a new session from the events in hand as from the stored events", async () => {
    const seen = new Set<string>();
    for (const b of batches) {
      for (const s of b.sessions) {
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        const inHand = b.events.filter((e) => e.sessionId === s.id);
        assert.deepEqual(buildSession(inHand), buildSession(await store.listEvents(s.id)), s.id);
      }
    }
    assert.ok(seen.size >= 6);
  });
});

// A JSON time past what fixed64 holds is read as unset, and a log whose duration would put its start
// before the earliest time a Date holds starts at the log's time. SQLite reads back no integer past
// 2^53, and --json output holds no time a Date cannot: every stored time stays within +-8.64e15 ms.
describe("times past what a Date holds", () => {
  it("are not stored, and every session still lists", async () => {
    const root = mkdtempSync(join(tmpdir(), "cs-rx-time-"));
    const store = await SqliteIndexStore.open(join(root, "index.db"));
    const rx = await startReceiver({ port: 0, store, blobs: new MemBlobs() });
    try {
      const traceId = "0af7651916cd43dd8448eb211c80319c";
      const far = "99999999999999999999999";
      const attr = (key: string, v: string | number) => ({ key, value: typeof v === "string" ? { stringValue: v } : { doubleValue: v } });
      const span = { traceId, spanId: "b7ad6b7169203331", name: "chat m", kind: 3, startTimeUnixNano: far, endTimeUnixNano: far, attributes: [attr("gen_ai.operation.name", "chat")] };
      const traces = { resourceSpans: [{ resource: { attributes: [attr("service.name", "probe")] }, scopeSpans: [{ scope: { name: "s" }, spans: [span] }] }] };
      const logs = (timeUnixNano: string, attributes: object[]) => ({
        resourceLogs: [{ resource: { attributes: [attr("service.name", "claude-code")] }, scopeLogs: [{ scope: { name: "com.anthropic.claude_code.events" }, logRecords: [{ timeUnixNano, traceId, attributes }] }] }],
      });
      const prompt = logs(far, [attr("event.name", "user_prompt"), attr("prompt", "hi")]);
      const call = logs("1767225603000000000", [attr("event.name", "api_request"), attr("model", "claude-sonnet-4-5"), attr("input_tokens", "1"), attr("output_tokens", "1"), attr("duration_ms", 1e300)]);
      for (const [path, body] of [["/v1/traces", traces], ["/v1/logs", prompt], ["/v1/logs", call]] as const) {
        const res = await post(rx.url, JSON.stringify(body), path);
        assert.equal(res.status, 200, `${path} ${res.body}`);
      }
      const sessions = await store.listSessions({ limit: 100 });
      assert.ok(sessions.length >= 1);
      const inRange = (t: number | undefined, label: string) => t === undefined || assert.ok(Math.abs(t) <= 8_640_000_000_000_000, `${label}: ${t}`);
      let calls = 0;
      for (const s of sessions) {
        inRange(s.startedAt, `${s.id} startedAt`);
        inRange(s.endedAt, `${s.id} endedAt`);
        for (const e of await store.listEvents(s.id)) {
          inRange(e.ts, `${e.kind} ts`);
          if (e.kind !== "llm.call" || e.payload.event !== "api_request") continue;
          calls++;
          assert.equal(e.ts, 1767225603000, "a call whose duration reaches before the earliest Date starts at its log's time");
          assert.equal(e.durationMs, undefined, "and has no duration");
        }
      }
      assert.equal(calls, 1);
    } finally {
      await rx.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  // A Claude Code log with no trace belongs to the session its session.id names, and that session
  // ends at its last activity: an event's time plus its duration. A duration_ms that would put that
  // end past what a Date holds is dropped, so sessions --json and status --json list the whole store.
  it("leave the end of a session keyed by its logs in range when a log's duration reaches past them", async () => {
    const root = mkdtempSync(join(tmpdir(), "cs-rx-dur-"));
    const store = await SqliteIndexStore.open(join(root, "index.db"));
    const rx = await startReceiver({ port: 0, store, blobs: new MemBlobs() });
    try {
      const ts = 1767225603000;
      const attr = (key: string, v: string | number) => ({ key, value: typeof v === "string" ? { stringValue: v } : { doubleValue: v } });
      const usage = [attr("model", "claude-sonnet-4-5"), attr("input_tokens", "1"), attr("output_tokens", "1")];
      const log = (session: string, name: string, duration: number, extra: object[] = []) => ({
        timeUnixNano: `${ts}000000`,
        attributes: [attr("session.id", session), attr("event.name", name), attr("duration_ms", duration), ...extra],
      });
      const records = [
        log("cc-dur-far", "api_request", 1e300, usage),
        log("cc-dur-back", "api_request", -1e300, usage),
        // Its start is in range; its end, the log's time plus the duration, is not.
        log("cc-dur-compact", "compaction", 8.639e15),
        log("cc-dur-tool", "tool_result", 1e300, [attr("tool_name", "Bash")]),
        log("cc-dur-kept", "api_request", 1500, usage),
      ];
      const body = { resourceLogs: [{ resource: { attributes: [attr("service.name", "claude-code")] }, scopeLogs: [{ scope: { name: "com.anthropic.claude_code.events" }, logRecords: records }] }] };
      const res = await post(rx.url, JSON.stringify(body), "/v1/logs");
      assert.equal(res.status, 200, res.body);
      const sessions = await store.listSessions({ limit: 100 });
      assert.deepEqual(sessions.map((s) => s.id).sort(), ["cc-dur-back", "cc-dur-compact", "cc-dur-far", "cc-dur-kept", "cc-dur-tool"]);
      for (const s of sessions) {
        const events = await store.listEvents(s.id);
        assert.ok(events.length >= 1, s.id);
        const kept = s.id === "cc-dur-kept";
        assert.equal(s.startedAt, kept ? ts - 1500 : ts, `${s.id} startedAt`);
        assert.equal(s.endedAt, ts, `${s.id} endedAt`);
        for (const e of events) {
          assert.equal(e.durationMs, kept ? 1500 : undefined, `${s.id} ${e.kind} durationMs`);
          assert.equal(e.payload.durationMs, undefined, `${s.id} ${e.kind} payload durationMs`);
        }
      }
    } finally {
      await rx.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// What the collector mirrors to [[sinks]] (cli/commands/collector.ts): the events a request
// newly stored, so an exporter's retry reaches a sink once. On SQLite (it names the ids it
// inserted, and a failed group rolls back) and on a store with the required contract alone
// (the stored ids are read before the put, and a put stays when the rebuild after it fails).
describe("the receiver hands a sink each stored event once", () => {
  const full = JSON.parse(fixture("genai-semconv.json"));
  // The first three of its five spans: a request the full one overlaps.
  const half = structuredClone(full);
  half.resourceSpans[0].scopeSpans[0].spans.length = 3;

  const roots: string[] = [];
  const stores: [string, () => Promise<IndexStore>][] = [
    ["sqlite", async () => {
      const root = mkdtempSync(join(tmpdir(), "cs-rx-sink-"));
      roots.push(root);
      return SqliteIndexStore.open(join(root, "index.db"));
    }],
    ["a store with putEvents alone", async () => new MemIndex()],
  ];
  after(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });

  /** A receiver wired to a recording sink as the collector wires its [[sinks]]. */
  async function collector(store: IndexStore) {
    const sent: string[] = [];
    const sink: Sink = {
      name: "stub",
      mode: "full",
      async write(events) {
        sent.push(...events.map((e) => e.id));
        return { ok: true };
      },
    };
    const mirror = new SinkMirror({ sinks: [sink], blobs: new MemBlobs(), flushMs: 10 });
    const batches: BatchInfo[] = [];
    const rx = await startReceiver({ port: 0, store, blobs: new MemBlobs(), onBatch: (b) => (batches.push(b), mirror.add(b.insertedEvents, b.sessions)) });
    const stored = async () => {
      const ids: string[] = [];
      for (const s of await store.listSessions()) ids.push(...(await store.listEvents(s.id)).map((e) => e.id));
      return ids.sort();
    };
    const flushed = async () => {
      await mirror.flush();
      return [...sent].sort();
    };
    const close = async () => {
      await rx.close();
      await mirror.close(1000);
      await store.close();
    };
    return { rx, batches, stored, flushed, close };
  }

  for (const [name, open] of stores) {
    it(`${name}: a request posted three times is sent once, and one that overlaps it sends only what is new`, async () => {
      const c = await collector(await open());
      try {
        for (let i = 0; i < 3; i++) assert.equal((await post(c.rx.url, JSON.stringify(half))).status, 200);
        assert.deepEqual(c.batches.map((b) => [b.inserted, b.insertedEvents.length]), [[5, 5], [0, 0], [0, 0]]);
        assert.deepEqual(await c.flushed(), await c.stored());
        assert.equal((await post(c.rx.url, JSON.stringify(full))).status, 200);
        const last = c.batches.at(-1)!;
        assert.deepEqual([last.events.length, last.inserted, last.insertedEvents.length], [12, 7, 7]);
        assert.deepEqual(await c.flushed(), await c.stored(), "the sink has every stored event, each once");
        assert.equal((await c.stored()).length, 12);
      } finally {
        await c.close();
      }
    });

    it(`${name}: a request whose commit failed is sent once when its retry commits`, async () => {
      const store = await open();
      // The session rebuild after the put fails once (a dropped connection, a busy database).
      let fail = 1;
      const failing = <A extends unknown[], R>(real: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
        if (fail-- > 0) throw new Error("connection reset");
        return real(...a);
      };
      store.upsertSession = failing(store.upsertSession.bind(store));
      if (store.rebuildSession) store.rebuildSession = failing(store.rebuildSession.bind(store));
      const c = await collector(store);
      try {
        assert.equal((await post(c.rx.url, JSON.stringify(half))).status, 503);
        assert.deepEqual(await c.flushed(), [], "nothing is handed on before the commit");
        for (let i = 0; i < 3; i++) assert.equal((await post(c.rx.url, JSON.stringify(half))).status, 200);
        assert.equal((await c.stored()).length, 5);
        assert.deepEqual(await c.flushed(), await c.stored(), "the sink has every stored event, each once");
      } finally {
        await c.close();
      }
    });
  }
});
