import assert from "node:assert/strict";
import { once } from "node:events";
import { Agent, request } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { deflateSync, gzipSync } from "node:zlib";
import type { Session } from "../../src/schema/index.ts";
import { type BatchInfo, createOtlpPipeline, type Receiver, startReceiver } from "../../src/otel/receiver.ts";
import { ProtoReader } from "../../src/otel/proto.ts";
import { decodeLogsJson, decodeTraceJson } from "../../src/otel/json.ts";
import { encodeLogs, encodeTraces, fixture, gzip, iAttr, otlpSpan, otlpTraces, sAttr, secretRequests, splitSpans } from "./_encode.ts";
import { MemBlobs, MemIndex } from "./_memstore.ts";
import { createRedactor } from "../../src/core/redact.ts";

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
    // No cost on the spans: the local collector prices them from list prices, as serve does.
    assert.deepEqual(s.stats.usage, {
      inputTokens: 300,
      outputTokens: 45,
      cacheReadTokens: 20,
      costUsd: 0.001225,
      estimatedCostUsd: 0.001225,
      estimatedCostByTokenType: { cacheRead: 0.000025, cacheWrite: 0, input: 0.00075, output: 0.00045 },
    });
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
    // Tokens but no reported cost: priced from the list price, marked as an estimate and split by token type.
    const { costUsd: rc, estimatedCostUsd: re, estimatedCostByTokenType: rs, ...rTokens } = r?.stats.usage ?? {};
    // A reported cache read of 0 is no cache read (as the transcript adapters store it).
    assert.deepEqual(rTokens, { inputTokens: 300, outputTokens: 30 });
    assert.ok(rc !== undefined && rc > 0 && re === rc, `estimated cost ${rc} / ${re}`);
    assert.deepEqual(rs, { cacheRead: 0, cacheWrite: 0, input: 0.000075, output: 0.00006 });
    const call = (await store.listEvents(r!.id)).find((e) => e.kind === "llm.call");
    assert.equal(call?.payload.costEstimated, true);
    const w = await store.getSession(`otel-sub-${T}-${writer}`);
    const { costUsd: wc, ...wTokens } = w?.stats.usage ?? {};
    assert.deepEqual(
      { ...wTokens, estimatedCostUsd: undefined, estimatedCostByTokenType: undefined },
      { inputTokens: 500, outputTokens: 30, cacheReadTokens: 200, estimatedCostUsd: undefined, estimatedCostByTokenType: undefined },
    );
    assert.ok(wc !== undefined && wc > rc!, "the writer read more, so it cost more");
    const parent = await store.getSession(T);
    assert.equal(parent?.stats.latency?.subagents, 2);
    assert.equal(parent?.stats.latency?.llmCalls, undefined);
    assert.equal(parent?.stats.toolCalls, 0);
  });

  describe("spans exported before their subagent span", () => {
    const T = "6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d";
    const [root, reader, inner, wrap] = ["a000000000000001", "a000000000000002", "a000000000000003", "a000000000000004"];
    const agent = (id: string, parent: string | undefined, name: string, s: number, e: number) =>
      otlpSpan(T, id, parent, `invoke_agent ${name}`, [sAttr("gen_ai.operation.name", "invoke_agent"), sAttr("gen_ai.agent.name", name)], s, e);
    const chat = (id: string, parent: string, input: number, s: number, e: number) =>
      otlpSpan(T, id, parent, "chat gpt-5-mini", [sAttr("gen_ai.operation.name", "chat"), sAttr("gen_ai.request.model", "gpt-5-mini"), iAttr("gen_ai.usage.input_tokens", input), iAttr("gen_ai.usage.output_tokens", 5)], s, e);
    const tool = (id: string, parent: string, s: number, e: number) =>
      otlpSpan(T, id, parent, "execute_tool web_search", [sAttr("gen_ai.operation.name", "execute_tool"), sAttr("gen_ai.tool.name", "web_search")], s, e);
    const post = async (...spans: ReturnType<typeof chat>[]) => assert.equal((await send(rx.url, json("/v1/traces", otlpTraces("orchestrator", spans)))).status, 200);
    /** What a session holds, to compare however the spans were split across requests. */
    const shape = async (id: string) => {
      const s = await store.getSession(id);
      return s && { parent: s.parent?.sessionId, llm: s.stats.latency?.llmCalls, tools: s.stats.toolCalls, usage: s.stats.usage?.inputTokens, subagents: s.stats.latency?.subagents };
    };

    it("moves a subagent's model and tool spans into its session when its span arrives later", async () => {
      await post(chat("a000000000000011", reader, 500, 200, 2000), tool("a000000000000012", reader, 2100, 2500));
      assert.equal((await store.getSession(T))?.stats.toolCalls, 1, "stored in the trace session until the subagent span arrives");
      await post(agent(reader, root, "researcher", 100, 4900), agent(root, undefined, "orchestrator", 0, 5000));
      const child = `otel-sub-${T}-${reader}`;
      assert.deepEqual(await shape(child), { parent: T, llm: 1, tools: 1, usage: 500, subagents: undefined });
      const parent = await shape(T);
      assert.equal(parent?.llm, undefined);
      assert.equal(parent?.tools, 0);
      assert.equal(parent?.subagents, 1);
      assert.ok((await store.listEvents(child)).filter((e) => e.kind === "llm.call" || e.kind === "tool.start").every((e) => e.subagentId === reader));
      assert.ok((await store.listEvents(T)).every((e) => e.kind !== "llm.call" && e.kind !== "tool.start"));
    });

    it("gives the same sessions whatever the split, for nested subagents and a plain span between", async () => {
      const spans = [
        chat("a000000000000021", inner, 100, 300, 600),
        tool("a000000000000022", wrap, 310, 320),
        otlpSpan(T, wrap, inner, "wrapper", [], 305, 330),
        agent(inner, reader, "grep", 250, 700),
        chat("a000000000000011", reader, 500, 200, 2000),
        agent(reader, root, "researcher", 100, 4900),
        agent(root, undefined, "orchestrator", 0, 5000),
      ];
      const ids = [T, `otel-sub-${T}-${reader}`, `otel-sub-${T}-${inner}`];
      // Leaf first, one span per request, against everything in one request.
      for (const s of spans) await post(s);
      const split = [];
      for (const id of ids) split.push(await shape(id));
      const innerParent = (await store.getSession(ids[2]!))?.parent?.sessionId;
      await rx.close();
      await start();
      await post(...spans);
      const whole = [];
      for (const id of ids) whole.push(await shape(id));
      assert.deepEqual(split, whole);
      assert.equal(innerParent, ids[1], "the inner subagent is dispatched by the reader");
      assert.equal(split[2]?.tools, 1);
      assert.equal(split[2]?.llm, 1);
      assert.equal(split[1]?.llm, 1);
    });
  });

  // Regression: the root invoke_agent span is the only one with gen_ai.conversation.id, and a
  // batching exporter sends it after its subagent's spans. The subagent landed under an empty
  // session named after the trace id, and the conversation got no subagent.
  describe("a conversation id that arrives after the trace's other spans", () => {
    const T = "5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c";
    const [root, sub] = ["b000000000000001", "b000000000000002"];
    const chat = (id: string, parent: string, input: number, s: number, e: number) =>
      otlpSpan(T, id, parent, "chat gpt-4o", [sAttr("gen_ai.operation.name", "chat"), sAttr("gen_ai.request.model", "gpt-4o"), iAttr("gen_ai.usage.input_tokens", input), iAttr("gen_ai.usage.output_tokens", 10)], s, e);
    const spans = [
      chat("b000000000000011", sub, 1000, 110, 3990),
      otlpSpan(T, sub, root, "invoke_agent flights", [sAttr("gen_ai.operation.name", "invoke_agent"), sAttr("gen_ai.agent.name", "flights")], 100, 4000),
      chat("b000000000000021", root, 3000, 8010, 8990),
      otlpSpan(T, root, undefined, "invoke_agent orchestrator", [sAttr("gen_ai.operation.name", "invoke_agent"), sAttr("gen_ai.agent.name", "orchestrator"), sAttr("gen_ai.conversation.id", "conv-late")], 0, 9000),
    ];
    const post = async (part: typeof spans) => assert.equal((await send(rx.url, json("/v1/traces", otlpTraces("orchestrator", part)))).status, 200);
    const child = `otel-sub-${T}-${sub}`;
    const shape = async () => {
      const c = await store.getSession("conv-late");
      const s = await store.getSession(child);
      return {
        trace: (await store.getSession(T)) !== undefined || (await store.listEvents(T)).length > 0,
        subagents: c?.stats.latency?.subagents,
        input: c?.stats.usage?.inputTokens,
        childParent: s?.parent?.sessionId,
        childInput: s?.stats.usage?.inputTokens,
      };
    };
    const want = { trace: false, subagents: 1, input: 3000, childParent: "conv-late", childInput: 1000 };

    it("moves the subagent and its work into the conversation when the root comes in a later request", async () => {
      await post(spans.slice(0, 2));
      await post(spans.slice(2));
      assert.deepEqual(await shape(), want);
      const conv = await store.listEvents("conv-late");
      const moved = conv.filter((e) => e.kind === "subagent.start");
      assert.equal(moved.length, 1);
      assert.equal(moved[0]?.turnId, T, "a conversation's trace is a turn");
      assert.ok(conv.every((e) => e.kind !== "session.end"));
      await rx.close();
      await start();
      await post(spans);
      assert.deepEqual(await shape(), want, "the same as one request");
    });

    it("moves them when both requests are committed in one group", async () => {
      // Hold the first commit, so the next two requests queue and are mapped before either is stored.
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      const put = store.putEvents.bind(store);
      const replace = store.replaceSessionEvents.bind(store);
      let calls = 0;
      let moving = false;
      store.putEvents = async (b) => {
        if (!moving && calls++ === 0) await held;
        return put(b);
      };
      store.replaceSessionEvents = async (...args) => {
        moving = true;
        try {
          return await replace(...args);
        } finally {
          moving = false;
        }
      };
      const first = post([otlpSpan("4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b", "c000000000000001", undefined, "other", [], 0, 10)]);
      await new Promise((r) => setTimeout(r, 50));
      const a = post(spans.slice(0, 2));
      await new Promise((r) => setTimeout(r, 50));
      const b = post(spans.slice(2));
      await new Promise((r) => setTimeout(r, 50));
      release();
      await Promise.all([first, a, b]);
      assert.equal(calls, 3, "one put per request, the last two in one group");
      assert.deepEqual(await shape(), want);
    });
  });

  // Regression: Claude Code sends a model call as an api_request log record (reported cost_usd) and,
  // with CLAUDE_CODE_ENHANCED_TELEMETRY_BETA, as a claude_code.llm_request span (ttft_ms), under one
  // id. The second copy inserted nothing, so the call lost the cost or the TTFT depending on which
  // signal came first, and logs first put the prompt before session.start (a resume phase).
  describe("Claude Code logs and spans of one model call", () => {
    const T = "3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a";
    const sid = "cc-both-1";
    const c = sAttr("session.id", sid);
    const traces = otlpTraces("claude-code", [
      otlpSpan(
        T,
        "d000000000000002",
        "d000000000000001",
        "claude_code.llm_request",
        [c, sAttr("prompt.id", "p1"), sAttr("span.type", "claude_code.llm_request"), sAttr("model", "claude-sonnet-4-5"), iAttr("duration_ms", 2000), iAttr("ttft_ms", 500), iAttr("input_tokens", 100), iAttr("output_tokens", 50), iAttr("cache_read_tokens", 4000), sAttr("request_id", "req_b1")],
        100,
        2100,
      ),
      otlpSpan(T, "d000000000000001", undefined, "claude_code.interaction", [c, sAttr("span.type", "claude_code.interaction"), sAttr("prompt.id", "p1"), sAttr("user_prompt", "hello there")], 0, 6000),
    ]);
    const at = (ms: number) => String((1767225600000n + BigInt(ms)) * 1_000_000n);
    const log = (ms: number, name: string, attrs: ReturnType<typeof sAttr>[]) => ({
      timeUnixNano: at(ms),
      body: { stringValue: `claude_code.${name}` },
      attributes: [c, sAttr("event.name", name), sAttr("prompt.id", "p1"), ...attrs],
    });
    const records = [
      log(0, "user_prompt", [sAttr("prompt", "hello there")]),
      log(2100, "api_request", [
        sAttr("model", "claude-sonnet-4-5"),
        { key: "cost_usd", value: { doubleValue: 0.0123 } },
        iAttr("duration_ms", 2000),
        iAttr("input_tokens", 100),
        iAttr("output_tokens", 50),
        iAttr("cache_read_tokens", 4000),
        sAttr("request_id", "req_b1"),
      ]),
    ];
    const logs = { resourceLogs: [{ resource: { attributes: [sAttr("service.name", "claude-code")] }, scopeLogs: [{ scope: { name: "com.anthropic.claude_code.events" }, logRecords: records }] }] };

    for (const order of ["traces first", "logs first"]) {
      it(`keeps the reported cost and the span's TTFT in one call, ${order}`, async () => {
        const posts = [() => send(rx.url, json("/v1/traces", traces)), () => send(rx.url, json("/v1/logs", logs))];
        if (order === "logs first") posts.reverse();
        for (const p of posts) assert.equal((await p()).status, 200);
        const s = await store.getSession(sid);
        assert.equal(s?.stats.latency?.llmCalls, 1, "counted once");
        assert.equal(s?.stats.usage?.costUsd, 0.0123, "the reported cost, not an estimate");
        assert.equal(s?.stats.usage?.estimatedCostUsd, undefined);
        assert.equal(s?.stats.latency?.ttftP50Ms, 500);
        const events = await store.listEvents(sid);
        const calls = events.filter((e) => e.kind === "llm.call");
        assert.equal(calls.length, 1);
        assert.equal(calls[0]?.payload.costEstimated, undefined);
        assert.equal(calls[0]?.payload.ttftMs, 500);
        assert.equal(calls[0]?.durationMs, 2000);
        assert.equal(s?.stats.phases, undefined, "one prompt is one phase, not a resume");
        assert.deepEqual(events.slice(0, 2).map((e) => e.kind), ["session.start", "user.message"]);
      });
    }
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
    // Close once the server has the request, not after a fixed sleep: libuv runs due
    // timers before the poll phase that accepts connections, so a test process
    // descheduled past the sleep closed the listener with the connection still in
    // the kernel backlog, and the client saw "connect ECONNRESET".
    const arrived = once(rx.server, "request");
    const pending = send(rx.url, json("/v1/traces", fixture("openinference.json")));
    await arrived;
    await rx.close();
    assert.equal((await pending).status, 200);
    assert.ok(await store.getSession("thread-42"));
    await rx.close(); // idempotent
    await assert.rejects(send(rx.url, json("/v1/traces", {})), /ECONNREFUSED/);
    await start();
  });

  it("answers a keep-alive request in flight at close with Connection: close, so close() does not wait out keepAliveTimeout", async () => {
    const agent = new Agent({ keepAlive: true });
    const arrived = once(rx.server, "request");
    const pending = new Promise<{ status: number; connection: string | undefined }>((resolve, reject) => {
      const body = JSON.stringify(fixture("openinference.json"));
      const req = request(new URL("/v1/traces", rx.url), { method: "POST", agent, headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)) } }, (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode!, connection: res.headers.connection }));
      });
      req.on("error", reject);
      req.end(body);
    });
    await arrived;
    const closed = rx.close();
    const r = await pending;
    assert.deepEqual(r, { status: 200, connection: "close" });
    await closed;
    agent.destroy();
    await start();
  });
});

// Regression: blobs were redacted as JSON text. A `NAME=value` line after an escaped
// newline and a JSON field inside a JSON string no longer matched there, so the
// source span, the source log record and an oversize structured value kept the
// secrets their events showed as redacted.
describe("blob redaction", () => {
  const TRACE = "5ec0000000000000000000000000beef";

  const run = async (opts: { redactor?: false } = {}) => {
    const store = new MemIndex();
    const blobs = new MemBlobs();
    const options: Parameters<typeof createOtlpPipeline>[0] = { store, blobs, keepRaw: true };
    if (opts.redactor !== false) options.redactor = createRedactor();
    const pipeline = createOtlpPipeline(options);
    const { traces, logs, canaries } = secretRequests(TRACE);
    const events = [...(await pipeline.map("traces", decodeTraceJson(traces))).events, ...(await pipeline.map("logs", decodeLogsJson(logs))).events];
    const texts = new Map([...blobs.data].map(([ref, b]) => [ref, Buffer.from(b).toString()]));
    return { events, texts, canaries };
  };

  it("keeps no secret in a source span, a source log record or a content blob", async () => {
    const { events, texts, canaries } = await run();
    const held = (text: string) => canaries.filter((c) => text.includes(c));
    for (const [ref, text] of texts) assert.deepEqual(held(text), [], `blob ${ref.slice(0, 8)} holds a secret in clear: ${text.slice(0, 80)}`);
    assert.deepEqual(held(JSON.stringify(events)), [], "events hold no secret");

    // The blobs are there and still say what was removed.
    const all = [...texts.values()];
    const spans = all.filter((t) => t.startsWith('{"format":"otlp.span"'));
    assert.equal(spans.length, 3);
    assert.equal(all.filter((t) => t.startsWith('{"format":"otlp.log"')).length, 1);
    const toolSpan = spans.find((t) => t.includes('"gen_ai.tool.call.id":"c1"'))!;
    const shown = ["line one", "DB_PASSWORD=[redacted:secret-assignment]", 'export STRIPE_SECRET_KEY="[redacted:secret-assignment]"'].join("\n");
    assert.ok(toolSpan.includes(JSON.stringify(shown).slice(1, -1)), toolSpan);
    assert.equal(JSON.parse(toolSpan).span.spanId, "a000000000000002", "the source span is still JSON");
  });

  it("counts what was redacted inside an oversize structured value on its event, with a redacted preview", async () => {
    const { events, texts } = await run();
    const end = events.find((e) => e.kind === "tool.end" && e.spanId === "a000000000000003")!;
    const stored = texts.get(end.payload.outputBlob as string)!;
    assert.ok(stored.includes("DB_PASSWORD=[redacted:secret-assignment]"), stored.slice(0, 200));
    assert.ok(stored.startsWith((end.payload.output as string).slice(0, -1)), "the preview is a prefix of the stored blob");
    assert.deepEqual(end.payload.redactions, { "secret-assignment": 2, "secret-field": 2 });
    // The small result is counted inline, as before; the source span adds nothing to it.
    const small = events.find((e) => e.kind === "tool.end" && e.spanId === "a000000000000002")!;
    assert.deepEqual(small.payload.redactions, { "secret-assignment": 2, "secret-field": 2 });
    assert.equal(events.find((e) => e.kind === "session.start")!.payload.redactions, undefined);
  });

  it("stores blobs as given without a redactor", async () => {
    const { texts, canaries } = await run({ redactor: false });
    const span = [...texts.values()].find((t) => t.includes('"gen_ai.tool.call.id":"c1"'))!;
    assert.ok(canaries.every((c) => span.includes(c)));
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
