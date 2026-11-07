import assert from "node:assert/strict";
import { request } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { deflateSync, gzipSync } from "node:zlib";
import type { Session } from "../../src/schema/index.ts";
import { type BatchInfo, type Receiver, startReceiver } from "../../src/otel/receiver.ts";
import { ProtoReader } from "../../src/otel/proto.ts";
import { encodeLogs, encodeTraces, fixture, gzip, iAttr, otlpSpan, otlpTraces, sAttr, splitSpans } from "./_encode.ts";
import { MemBlobs, MemIndex } from "./_memstore.ts";

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

function send(
  base: string,
  opts: { method?: string; path: string; body?: Uint8Array | string; headers?: Record<string, string>; chunked?: boolean },
): Promise<Res> {
  const url = new URL(opts.path, base);
  return new Promise((resolve, reject) => {
    const req = request(url, { method: opts.method ?? "POST", headers: opts.headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    if (opts.body !== undefined) {
      if (opts.chunked) {
        const b = Buffer.from(opts.body);
        for (let i = 0; i < b.length; i += 256) req.write(b.subarray(i, i + 256));
      } else {
        req.setHeader("Content-Length", Buffer.byteLength(opts.body));
        req.write(opts.body);
      }
    }
    req.end();
  });
}

const json = (path: string, body: unknown, headers: Record<string, string> = {}) => ({
  path,
  body: typeof body === "string" ? body : JSON.stringify(body),
  headers: { "Content-Type": "application/json", ...headers },
});
const proto = (path: string, body: Uint8Array, headers: Record<string, string> = {}) => ({
  path,
  body,
  headers: { "Content-Type": "application/x-protobuf", ...headers },
});

/** Strips fields that legitimately differ between a single post and incremental posts. */
const sessionShape = (s: Session | undefined) => s && { ...s };

describe("OTLP receiver over HTTP", () => {
  let store: MemIndex;
  let blobs: MemBlobs;
  let rx: Receiver;
  let batches: BatchInfo[];
  const errors: Error[] = [];

  const start = async (extra: Partial<Parameters<typeof startReceiver>[0]> = {}) => {
    store = new MemIndex();
    blobs = new MemBlobs();
    batches = [];
    rx = await startReceiver({ port: 0, store, blobs, onBatch: (b) => void batches.push(b), onError: (e) => void errors.push(e), ...extra });
  };

  before(() => start());
  beforeEach(async () => {
    await rx.close();
    await start();
  });
  after(() => rx.close());

  it("binds to 127.0.0.1 on an ephemeral port", () => {
    assert.equal(rx.host, "127.0.0.1");
    assert.ok(rx.port > 0);
    assert.equal(rx.url, `http://127.0.0.1:${rx.port}`);
  });

  it("ingests OTLP/JSON traces and answers {}", async () => {
    const res = await send(rx.url, json("/v1/traces", fixture("genai-semconv.json")));
    assert.equal(res.status, 200);
    assert.match(String(res.headers["content-type"]), /application\/json/);
    assert.deepEqual(JSON.parse(res.body.toString()), {});
    const s = await store.getSession("5b8efff798038103d269b633813fc60c");
    assert.ok(s);
    assert.equal(s.agent, "weather-bot");
    assert.equal(s.title, "What's the weather in Paris?");
    assert.deepEqual(s.stats.usage, { inputTokens: 300, outputTokens: 45, cacheReadTokens: 20 });
    assert.equal(s.stats.toolCalls, 2);
    assert.equal(s.endedAt, 1767225605000);
    assert.equal(batches.length, 1);
    assert.equal(batches[0]!.inserted, 12);
    assert.equal(batches[0]!.sessions.length, 1);
  });

  it("ingests protobuf traces with an empty ExportTraceServiceResponse and the same ids as JSON", async () => {
    const res = await send(rx.url, proto("/v1/traces", encodeTraces(fixture("genai-semconv.json"))));
    assert.equal(res.status, 200);
    assert.equal(res.headers["content-type"], "application/x-protobuf");
    assert.equal(res.body.length, 0);
    const protoIds = store.all().map((e) => e.id).sort();

    await rx.close();
    await start();
    await send(rx.url, json("/v1/traces", fixture("genai-semconv.json")));
    assert.deepEqual(store.all().map((e) => e.id).sort(), protoIds);
  });

  it("accepts gzip and deflate bodies (Claude Code logs, protobuf and JSON)", async () => {
    let res = await send(rx.url, proto("/v1/logs", gzip(encodeLogs(fixture("claude-code-logs.json"))), { "Content-Encoding": "gzip" }));
    assert.equal(res.status, 200);
    const s = await store.getSession("cc-session-1");
    assert.equal(s?.agent, "claude-code");
    assert.equal(s?.title, "fix the failing test");
    assert.equal(s?.stats.toolErrors, 1);

    res = await send(rx.url, json("/v1/traces", "", { "Content-Encoding": "deflate" }));
    assert.equal(res.status, 400, "deflate header with a non-deflate body is a 400");
    res = await send(rx.url, {
      ...json("/v1/traces", ""),
      body: deflateSync(JSON.stringify(fixture("vercel-ai.json"))),
      headers: { "Content-Type": "application/json; charset=utf-8", "Content-Encoding": "deflate" },
    });
    assert.equal(res.status, 200);
    assert.ok(await store.getSession("4bf92f3577b34da6a3ce929d0e0e4736"));
  });

  it("is idempotent on re-post", async () => {
    await send(rx.url, json("/v1/traces", fixture("openinference.json")));
    const before = await store.getSession("thread-42");
    const count = store.events.size;
    const res = await send(rx.url, proto("/v1/traces", encodeTraces(fixture("openinference.json"))));
    assert.equal(res.status, 200);
    assert.equal(store.events.size, count);
    assert.equal(batches[1]!.inserted, 0);
    assert.deepEqual(await store.getSession("thread-42"), before);
  });

  it("assembles a session from out-of-order spans (root last, children shuffled)", async () => {
    await send(rx.url, json("/v1/traces", fixture("genai-semconv.json")));
    const whole = await store.getSession("5b8efff798038103d269b633813fc60c");

    await rx.close();
    await start();
    const parts = splitSpans(fixture("genai-semconv.json"));
    const root = parts.pop()!; // the fixture lists the root last, as BatchSpanProcessor does
    const order = [2, 0, 3, 1].map((i) => parts[i]!);
    for (const p of order) assert.equal((await send(rx.url, json("/v1/traces", p))).status, 200);
    const partial = await store.getSession("5b8efff798038103d269b633813fc60c");
    assert.equal(partial?.endedAt, undefined, "not ended before the root arrives");
    assert.equal(partial?.title, undefined);
    assert.equal(partial?.stats.toolCalls, 2);
    await send(rx.url, json("/v1/traces", root));
    assert.deepEqual(sessionShape(await store.getSession("5b8efff798038103d269b633813fc60c")), sessionShape(whole));
  });

  it("joins Claude Code logs and beta trace spans into one session without double counting", async () => {
    await send(rx.url, json("/v1/logs", fixture("claude-code-logs.json")));
    await send(rx.url, proto("/v1/traces", encodeTraces(fixture("claude-code-traces.json"))));
    const s = await store.getSession("cc-session-1");
    assert.equal(s?.stats.latency?.llmCalls, 2);
    assert.equal(s?.stats.toolCalls, 2);
    assert.equal(s?.stats.usage?.inputTokens, 2500);
  });

  it("upserts a child session for a nested agent span, with parent and latency stats", async () => {
    const res = await send(rx.url, json("/v1/traces", fixture("openinference.json")));
    assert.equal(res.status, 200);
    const parent = await store.getSession("thread-42");
    assert.equal(parent?.stats.latency?.llmCalls, undefined, "the researcher's calls are credited to its own session");
    assert.equal(parent?.stats.latency?.subagents, 1);
    const child = await store.getSession("otel-sub-0af7651916cd43dd8448eb211c80319c-c000000000000001");
    assert.equal(child?.stats.latency?.llmCalls, 2);
    assert.equal(child?.stats.toolCalls, 1);
    assert.equal(child?.parent?.sessionId, "thread-42");
    assert.equal(child?.parent?.subagentId, "c000000000000001");
    assert.equal(child?.parent?.type, "researcher");
  });

  it("credits a GenAI subagent's work and uncached input tokens to the right sessions (gzip protobuf)", async () => {
    const T = "7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e";
    const [root, reader, writer] = ["f000000000000001", "f000000000000002", "f000000000000003"];
    const agent = (id: string, parent: string | undefined, name: string, s: number, e: number) =>
      otlpSpan(T, id, parent, `invoke_agent ${name}`, [sAttr("gen_ai.operation.name", "invoke_agent"), sAttr("gen_ai.agent.name", name)], s, e);
    const chat = (id: string, parent: string, input: number, cached: number, s: number, e: number) =>
      otlpSpan(
        T,
        id,
        parent,
        "chat gpt-5-mini",
        [
          sAttr("gen_ai.operation.name", "chat"),
          sAttr("gen_ai.request.model", "gpt-5-mini"),
          iAttr("gen_ai.usage.input_tokens", input),
          iAttr("gen_ai.usage.output_tokens", 30),
          iAttr("gen_ai.usage.cache_read.input_tokens", cached),
        ],
        s,
        e,
      );
    const work = [
      chat("f000000000000011", reader, 300, 0, 200, 2000),
      otlpSpan(T, "f000000000000012", reader, "execute_tool read_file", [sAttr("gen_ai.operation.name", "execute_tool"), sAttr("gen_ai.tool.name", "read_file")], 2100, 2500),
      chat("f000000000000021", writer, 700, 200, 5100, 9000),
    ];
    const agents = [agent(reader, root, "reader", 100, 4900), agent(writer, root, "writer", 5000, 13900), agent(root, undefined, "orchestrator", 0, 14000)];
    // Two posts, the agent spans first: the receiver remembers span ancestry across batches.
    for (const batch of [agents, work]) {
      const res = await send(rx.url, proto("/v1/traces", gzip(encodeTraces(otlpTraces("orchestrator", batch))), { "Content-Encoding": "gzip" }));
      assert.equal(res.status, 200);
    }
    const r = await store.getSession(`otel-sub-${T}-${reader}`);
    assert.equal(r?.stats.toolCalls, 1);
    assert.equal(r?.stats.latency?.llmCalls, 1);
    assert.deepEqual(r?.stats.usage, { inputTokens: 300, outputTokens: 30, cacheReadTokens: 0 });
    const w = await store.getSession(`otel-sub-${T}-${writer}`);
    assert.deepEqual(w?.stats.usage, { inputTokens: 500, outputTokens: 30, cacheReadTokens: 200 });
    const parent = await store.getSession(T);
    assert.equal(parent?.stats.latency?.subagents, 2);
    assert.equal(parent?.stats.latency?.llmCalls, undefined);
    assert.equal(parent?.stats.toolCalls, 0);
  });

  it("runs the enrichSpan hook on every span", async () => {
    await rx.close();
    const names: string[] = [];
    await start({ enrichSpan: (span) => void names.push(span.name) });
    await send(rx.url, json("/v1/traces", fixture("vercel-ai.json")));
    assert.equal(names.length, 4);
  });

  it("returns 413 for oversize bodies (declared, chunked, and gzip bombs)", async () => {
    await rx.close();
    await start({ maxBodyBytes: 1024 });
    const big = JSON.stringify({ resourceSpans: [], pad: "x".repeat(4096) });
    let res = await send(rx.url, json("/v1/traces", big));
    assert.equal(res.status, 413);
    assert.equal(JSON.parse(res.body.toString()).code, 8);
    res = await send(rx.url, { ...json("/v1/traces", big), chunked: true });
    assert.equal(res.status, 413);
    const bomb = gzipSync(Buffer.alloc(512 * 1024, 0x20));
    assert.ok(bomb.length < 1024);
    res = await send(rx.url, { path: "/v1/traces", body: bomb, headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" } });
    assert.equal(res.status, 413);
    // The default limit is 16 MiB.
    await rx.close();
    await start();
    res = await send(rx.url, { path: "/v1/traces", body: Buffer.alloc(17 * 1024 * 1024, 0x20), headers: { "Content-Type": "application/json" } });
    assert.equal(res.status, 413);
  });

  it("returns 400 for bodies that don't decode", async () => {
    let res = await send(rx.url, json("/v1/traces", "this is not json"));
    assert.equal(res.status, 400);
    const status = JSON.parse(res.body.toString());
    assert.equal(status.code, 3);
    assert.match(status.message, /invalid JSON/);
    res = await send(rx.url, json("/v1/logs", "[1,2]"));
    assert.equal(res.status, 400);
    res = await send(rx.url, proto("/v1/traces", Uint8Array.from([0x0a, 0x7f, 0x01])));
    assert.equal(res.status, 400);
    assert.equal(res.headers["content-type"], "application/x-protobuf");
    const r = new ProtoReader(res.body);
    let code = 0;
    r.fields((f) => {
      if (f === 1) code = r.varint();
      else r.string();
      return true;
    });
    assert.equal(code, 3);
    res = await send(rx.url, { path: "/v1/traces", body: "{}", headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" } });
    assert.equal(res.status, 400);
    assert.equal(store.events.size, 0);
  });

  it("returns 415 for unsupported content types and encodings", async () => {
    let res = await send(rx.url, { path: "/v1/traces", body: "{}", headers: { "Content-Type": "text/plain" } });
    assert.equal(res.status, 415);
    res = await send(rx.url, json("/v1/traces", "{}", { "Content-Encoding": "zstd" }));
    assert.equal(res.status, 415);
  });

  it("reports rejected spans as partial_success", async () => {
    const req = fixture("vercel-ai.json");
    delete req.resourceSpans[0].scopeSpans[0].spans[1].spanId;
    let res = await send(rx.url, json("/v1/traces", req));
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body.toString());
    assert.equal(body.partialSuccess.rejectedSpans, "1");
    assert.match(body.partialSuccess.errorMessage, /traceId\/spanId/);

    res = await send(rx.url, proto("/v1/traces", encodeTraces(req)));
    assert.equal(res.status, 200);
    assert.ok(res.body.length > 0, "protobuf partial_success is non-empty");
  });

  it("accepts metrics and drops them", async () => {
    let res = await send(rx.url, json("/v1/metrics", { resourceMetrics: [] }));
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body.toString()), {});
    res = await send(rx.url, proto("/v1/metrics", new Uint8Array()));
    assert.equal(res.status, 200);
    assert.equal(store.events.size, 0);
    assert.equal(batches.length, 0);
  });

  it("handles CORS preflight for localhost origins and refuses others", async () => {
    let res = await send(rx.url, {
      method: "OPTIONS",
      path: "/v1/traces",
      headers: { Origin: "http://localhost:5173", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,traceparent" },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers["access-control-allow-origin"], "http://localhost:5173");
    assert.match(String(res.headers["access-control-allow-methods"]), /POST/);
    assert.equal(res.headers["access-control-allow-headers"], "content-type,traceparent");

    res = await send(rx.url, json("/v1/traces", fixture("vercel-ai.json"), { Origin: "http://127.0.0.1:3000" }));
    assert.equal(res.status, 200);
    assert.equal(res.headers["access-control-allow-origin"], "http://127.0.0.1:3000");

    res = await send(rx.url, { method: "OPTIONS", path: "/v1/traces", headers: { Origin: "https://evil.example" } });
    assert.equal(res.status, 403);
    assert.equal(res.headers["access-control-allow-origin"], undefined);
    res = await send(rx.url, json("/v1/traces", fixture("genai-semconv.json"), { Origin: "https://evil.example" }));
    assert.equal(res.status, 403);
    assert.equal(await store.getSession("5b8efff798038103d269b633813fc60c"), undefined);

    await rx.close();
    await start({ corsOrigins: ["https://app.example"] });
    res = await send(rx.url, { method: "OPTIONS", path: "/v1/logs", headers: { Origin: "https://app.example" } });
    assert.equal(res.status, 204);
  });

  it("guards against DNS rebinding with a Host header check", async () => {
    const res = await send(rx.url, json("/v1/traces", fixture("vercel-ai.json"), { Host: "attacker.example:4318" }));
    assert.equal(res.status, 403);
    const ok = await send(rx.url, json("/v1/traces", fixture("vercel-ai.json"), { Host: `localhost:${rx.port}` }));
    assert.equal(ok.status, 200);
  });

  it("returns 404 for unknown paths and 405 for other methods", async () => {
    let res = await send(rx.url, json("/v1/spans", {}));
    assert.equal(res.status, 404);
    res = await send(rx.url, { method: "GET", path: "/v1/traces" });
    assert.equal(res.status, 405);
    assert.equal(res.headers.allow, "POST, OPTIONS");
  });

  it("answers 503 (retryable) when the store fails, and the retry lands", async () => {
    store.failPuts = 1;
    let res = await send(rx.url, json("/v1/traces", fixture("vercel-ai.json")));
    assert.equal(res.status, 503);
    assert.match(errors.at(-1)!.message, /disk full/);
    res = await send(rx.url, json("/v1/traces", fixture("vercel-ai.json")));
    assert.equal(res.status, 200);
    assert.ok(await store.getSession("4bf92f3577b34da6a3ce929d0e0e4736"));
  });

  it("redacts secrets in events and blobs by default", async () => {
    const req = fixture("vercel-ai.json");
    const root = req.resourceSpans[0].scopeSpans[0].spans[3];
    const key = "sk-ant-api03-" + "A".repeat(40);
    root.attributes.find((a: any) => a.key === "ai.prompt").value = { stringValue: JSON.stringify({ prompt: `use ${key}` }) };
    await send(rx.url, json("/v1/traces", req));
    const msg = store.all().find((e) => e.kind === "user.message")!;
    assert.equal(msg.payload.text, "use [redacted:anthropic-key]");
    for (const b of blobs.data.values()) assert.ok(!Buffer.from(b).toString().includes(key));
  });

  it("refuses non-loopback binds unless allowRemote", async () => {
    await assert.rejects(startReceiver({ host: "0.0.0.0", port: 0, store, blobs }), /non-loopback/);
    await assert.rejects(startReceiver({ host: "192.168.1.10", port: 0, store, blobs }), /allowRemote/);
  });

  it("closes gracefully, waiting for in-flight requests", async () => {
    const pending = send(rx.url, json("/v1/traces", fixture("openinference.json")));
    // Let the request reach the server before closing.
    await new Promise((r) => setTimeout(r, 20));
    await rx.close();
    assert.equal((await pending).status, 200);
    assert.ok(await store.getSession("thread-42"));
    await rx.close(); // idempotent
    await assert.rejects(send(rx.url, json("/v1/traces", {})), /ECONNREFUSED/);
    await start();
  });
});

describe("trace → conversation map persistence", () => {
  it("routes a later span of a conversation trace into the conversation after a restart", async () => {
    const { MemoryIndexStore, MemoryBlobStore } = await import("../../src/store/memory.ts");
    const store = new MemoryIndexStore();
    const blobsStore = new MemoryBlobStore();
    const t0 = 1_767_225_600_000_000_000n;
    const span = (spanId: string, attrs: { key: string; value: { stringValue: string } }[], parentSpanId?: string) => ({
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId,
      ...(parentSpanId ? { parentSpanId } : {}),
      name: "chat m",
      kind: 3,
      startTimeUnixNano: String(t0),
      endTimeUnixNano: String(t0 + 1_000_000n),
      attributes: [{ key: "gen_ai.operation.name", value: { stringValue: "chat" } }, ...attrs],
    });
    const req = (s: unknown) => ({ resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ scope: { name: "t" }, spans: [s] }] }] });

    const rx1 = await startReceiver({ port: 0, store, blobs: blobsStore });
    const r1 = await send(rx1.url, json("/v1/traces", req(span("b7ad6b7169203331", [{ key: "gen_ai.conversation.id", value: { stringValue: "conv-42" } }]))));
    assert.equal(r1.status, 200);
    await rx1.close();
    assert.equal(await store.kvGet("otel-trace:0af7651916cd43dd8448eb211c80319c"), "conv-42");

    // New receiver (fresh in-memory map): the child span carries no conversation id.
    const rx2 = await startReceiver({ port: 0, store, blobs: blobsStore });
    const r2 = await send(rx2.url, json("/v1/traces", req(span("c7ad6b7169203332", [], "b7ad6b7169203331"))));
    assert.equal(r2.status, 200);
    await rx2.close();
    const events = await store.listEvents("conv-42");
    assert.ok(events.some((e) => e.spanId === "c7ad6b7169203332"), "child span joined the conversation session");
    assert.equal((await store.listEvents("0af7651916cd43dd8448eb211c80319c")).length, 0);
    const session = await store.getSession("conv-42");
    assert.deepEqual(session?.traceIds, ["0af7651916cd43dd8448eb211c80319c"]);
  });
});

describe("receiver default enrichment (eve)", () => {
  it("applies enrichFromEve by default and the plain mapping with enrichSpan: false", async () => {
    const { MemoryIndexStore, MemoryBlobStore } = await import("../../src/store/memory.ts");
    const { readFileSync } = await import("node:fs");
    const { OTLP_EXPORT, ROOT_A, CHILD_A0 } = await import("../integrations/eve/helpers.ts");
    const bodies = JSON.parse(readFileSync(OTLP_EXPORT, "utf8")) as unknown[];
    const post = async (enrichSpan?: false) => {
      const store = new MemoryIndexStore();
      const rx = await startReceiver({ port: 0, store, blobs: new MemoryBlobStore(), ...(enrichSpan === false ? { enrichSpan } : {}) });
      try {
        for (const b of bodies) assert.equal((await send(rx.url, json("/v1/traces", b))).status, 200);
      } finally {
        await rx.close();
      }
      return store;
    };
    const enriched = await post();
    const root = await enriched.getSession(ROOT_A);
    assert.equal(root?.agent, "eve");
    assert.equal((await enriched.getSession(CHILD_A0))?.parent?.sessionId, ROOT_A);
    assert.ok((await enriched.listEvents(ROOT_A)).every((e) => e.source === "otel-span"));

    const plain = await post(false);
    assert.notEqual((await plain.getSession(ROOT_A))?.agent, "eve", "enrichSpan: false keeps the generic mapping");
    assert.equal((await plain.getSession(CHILD_A0))?.parent?.sessionId === ROOT_A && (await plain.getSession(CHILD_A0))?.agent === "eve", false);
  });
});
