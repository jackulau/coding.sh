// serve forwards committed traces to an OTLP collector (CODING_SH_FORWARD_URL,
// [serve.forward]) and mirrors committed events to [[sinks]]. A stub collector
// runs in-process; see src/server/forward.ts and src/server/mirror.ts.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ConfigError } from "../../src/core/config.ts";
import { createRedactor } from "../../src/core/redact.ts";
import type { BlobStore, Sink, SinkAck } from "../../src/core/types.ts";
import type { AgentEvent, Session } from "../../src/schema/index.ts";
import { generateKey } from "../../src/server/auth.ts";
import { resolveServeConfig, type ServeConfig } from "../../src/server/config.ts";
import { keepInMetadata, OtlpForwarder, scrubSpan, type JsonSpan } from "../../src/server/forward.ts";
import { createLogger } from "../../src/server/log.ts";
import { ServeMetrics } from "../../src/server/metrics.ts";
import { SinkMirror } from "../../src/server/mirror.ts";
import { startServe, type ServeHandle, type ServeOptions } from "../../src/server/serve.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";
import { iAttr, otlpSpan, otlpTraces, sAttr } from "../otel/_encode.ts";

type J = any;

const dirs: string[] = [];
const servers: Server[] = [];
const handles: ServeHandle[] = [];
after(async () => {
  for (const h of handles) await h.shutdown().catch(() => {});
  for (const s of servers) s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmpEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const root = mkdtempSync(join(tmpdir(), "csh-forward-"));
  dirs.push(root);
  mkdirSync(join(root, "home"));
  return { HOME: join(root, "home"), CODING_SH_HOME: join(root, "data"), CODING_SH_LOG: "json", CODING_SH_STORE_URL: "memory://", ...extra };
}

const logs: string[] = [];
const quiet = () => createLogger({ format: "json", write: (l) => logs.push(l) });

interface Stub {
  url: string;
  bodies: J[];
  headers: Record<string, string | string[] | undefined>[];
  /** Status codes to answer, in order; 200 once they run out. */
  plan: number[];
  /** Resolves once `n` spans arrived. */
  spans(n: number, ms?: number): Promise<J[]>;
}

async function stub(plan: number[] = []): Promise<Stub> {
  const bodies: J[] = [];
  const headers: Stub["headers"] = [];
  const s: Stub = { url: "", bodies, headers, plan, spans: async () => [] };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const status = s.plan.length ? s.plan.shift()! : 200;
      if (status === 200) {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        headers.push(req.headers);
      }
      res.writeHead(status, status === 503 ? { "retry-after": "0" } : {});
      res.end(status === 200 ? "{}" : "busy");
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  s.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const all = () => bodies.flatMap((b) => b.resourceSpans.flatMap((rs: J) => rs.scopeSpans.flatMap((ss: J) => ss.spans.map((sp: J) => ({ ...sp, resource: rs.resource })))));
  s.spans = async (n, ms = 5000) => {
    const deadline = Date.now() + ms;
    while (all().length < n && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    return all();
  };
  return s;
}

const FAST = { flushMs: 20, minBackoffMs: 20, maxBackoffMs: 200 };

async function serve(env: NodeJS.ProcessEnv, opts: ServeOptions & { flags?: Parameters<typeof resolveServeConfig>[0] } = {}): Promise<{ h: ServeHandle; cfg: ServeConfig }> {
  const cfg = resolveServeConfig({ port: 0, ...(opts.flags ?? {}) }, env);
  const h = await startServe(cfg, { log: quiet(), enrichSpan: false, stores: { index: new MemoryIndexStore(), blobs: new MemoryBlobStore() }, hookTiming: FAST, ...opts });
  handles.push(h);
  return { h, cfg };
}

async function post(h: ServeHandle, path: string, key: string | undefined, body: unknown): Promise<{ status: number; json: J; ms: number }> {
  const t0 = performance.now();
  const res = await fetch(h.url + path, { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined, ms: performance.now() - t0 };
}

const attr = (kvs: J[] | undefined, key: string): J => kvs?.find((kv: J) => kv.key === key)?.value;
const TRACE = "0af7651916cd43dd8448eb211c80319c";
// SHA-256 of a weights file and of the file it was edited from, as a weights.checkpoint event carries them.
const WEIGHTS_FILE = `58899f90572c${"0".repeat(52)}`;
const WEIGHTS_BASE = `0496e5111097${"f".repeat(52)}`;

/** A chat span carrying every kind of content metadata mode must drop. */
function contentSpan(spanId: string, convo = "conv-1"): J {
  const s = otlpSpan(
    TRACE,
    spanId,
    undefined,
    "chat gpt-4o",
    [
      sAttr("gen_ai.operation.name", "chat"),
      sAttr("gen_ai.request.model", "gpt-4o"),
      sAttr("gen_ai.conversation.id", convo),
      iAttr("gen_ai.usage.input_tokens", 1200),
      iAttr("gen_ai.usage.output_tokens", 30),
      sAttr("gen_ai.input.messages", '[{"role":"user","content":"my secret plan"}]'),
      sAttr("gen_ai.output.messages", '[{"role":"assistant","content":"the answer"}]'),
      sAttr("gen_ai.tool.call.arguments", '{"cmd":"cat ~/.ssh/id_rsa"}'),
      sAttr("gen_ai.tool.call.result", "-----BEGIN KEY-----"),
      sAttr("input.value", "prompt text"),
      sAttr("output.value", "completion text"),
      sAttr("user.email", "dev@example.com"),
      sAttr("coding_sh.session.title", "fix the login bug"),
      sAttr("coding_sh.run_id", "run-7"),
      { key: "app.cache_hit", value: { boolValue: true } },
      sAttr("app.token", `Bearer ${["sk", "ant", "api03", "x".repeat(40)].join("-")}`),
    ],
    0,
    1200,
  );
  s.events = [{ timeUnixNano: s.startTimeUnixNano, name: "exception", attributes: [sAttr("exception.type", "TimeoutError"), sAttr("exception.message", "prompt leaked here"), sAttr("exception.stacktrace", "at foo")] }];
  s.status = { code: 2, message: "upstream said: my secret plan" };
  return s;
}

const CONTENT_KEYS = ["gen_ai.input.messages", "gen_ai.output.messages", "gen_ai.tool.call.arguments", "gen_ai.tool.call.result", "input.value", "output.value"];

describe("serve forward: OTLP passthrough", () => {
  it("sends OTLP posted to /v1/traces on with the same trace and span ids plus coding_sh.project", async () => {
    const c = await stub();
    const ik = generateKey("ingest");
    const { h } = await serve(tmpEnv({ CODING_SH_INGEST_KEYS: `billing:${ik}`, CODING_SH_FORWARD_URL: c.url, CODING_SH_FORWARD_HEADERS: "x-api-key=k%3D1,x-team=ops" }));
    const root = otlpSpan(TRACE, "b7ad6b7169203331", undefined, "invoke_agent support", [sAttr("gen_ai.operation.name", "invoke_agent"), sAttr("gen_ai.conversation.id", "conv-1")], 0, 2000);
    const child = otlpSpan(TRACE, "00f067aa0ba902b7", "b7ad6b7169203331", "chat gpt-4o", [sAttr("gen_ai.operation.name", "chat"), sAttr("gen_ai.request.model", "gpt-4o"), sAttr("gen_ai.conversation.id", "conv-1")], 10, 1200);
    const r = await post(h, "/v1/traces", ik, otlpTraces("support-bot", [root, child]));
    assert.equal(r.status, 200);
    const spans = await c.spans(2);
    assert.equal(spans.length, 2);
    assert.deepEqual(spans.map((s) => [s.traceId, s.spanId, s.parentSpanId]).sort(), [
      [TRACE, "00f067aa0ba902b7", "b7ad6b7169203331"],
      [TRACE, "b7ad6b7169203331", undefined],
    ]);
    for (const s of spans) {
      assert.deepEqual(attr(s.resource.attributes, "coding_sh.project"), { stringValue: "billing" });
      assert.deepEqual(attr(s.resource.attributes, "service.name"), { stringValue: "support-bot" });
    }
    assert.equal(c.headers[0]!["x-api-key"], "k=1", "CODING_SH_FORWARD_HEADERS is URL-decoded");
    assert.equal(c.headers[0]!["x-team"], "ops");
    const m = await fetch(`${h.url}/metrics`).then((x) => x.text());
    assert.match(m, /coding_sh_forward_spans_total\{result="sent"\} 2/);
    assert.match(m, /coding_sh_forward_buffer_spans 0/);
    // log records and metrics are stored, not forwarded
    await h.shutdown();
    assert.equal((await c.spans(3, 50)).length, 2);
  });

  it("forwards nothing and keeps serve unchanged when CODING_SH_FORWARD_URL is unset", async () => {
    const { h, cfg } = await serve(tmpEnv());
    assert.equal(cfg.forward, undefined);
    assert.equal((await post(h, "/v1/traces", undefined, otlpTraces("svc", [contentSpan("b7ad6b7169203331")]))).status, 200);
    const m = await fetch(`${h.url}/metrics`).then((x) => x.text());
    assert.doesNotMatch(m, /coding_sh_forward/);
    await h.shutdown();
  });
});

describe("serve forward: metadata allowlist and full-mode redaction", () => {
  it("metadata mode never forwards message content, tool arguments/results, input/output values or unlisted strings", async () => {
    const c = await stub();
    const { h } = await serve(tmpEnv({ CODING_SH_FORWARD_URL: c.url, CODING_SH_CAPTURE_MODE: "metadata" }));
    assert.equal((await post(h, "/v1/traces", undefined, otlpTraces("svc", [contentSpan("b7ad6b7169203331")]))).status, 200);
    const [s] = await c.spans(1);
    const keys = s.attributes.map((kv: J) => kv.key).sort();
    for (const k of CONTENT_KEYS) assert.ok(!keys.includes(k), `${k} was forwarded`);
    assert.ok(!keys.includes("user.email") && !keys.includes("app.token") && !keys.includes("coding_sh.session.title"));
    assert.deepEqual(keys, ["app.cache_hit", "coding_sh.run_id", "gen_ai.conversation.id", "gen_ai.operation.name", "gen_ai.request.model", "gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens"]);
    assert.deepEqual(s.events[0].attributes, [{ key: "exception.type", value: { stringValue: "TimeoutError" } }]);
    assert.deepEqual(s.status, { code: 2 });
    const text = JSON.stringify(c.bodies);
    for (const needle of ["my secret plan", "the answer", "id_rsa", "BEGIN KEY", "prompt text", "completion text", "dev@example.com", "fix the login bug", "prompt leaked"]) assert.ok(!text.includes(needle), needle);
    await h.shutdown();
  });

  it("full mode keeps every attribute and redacts secrets in every string", async () => {
    const c = await stub();
    const { h } = await serve(tmpEnv({ CODING_SH_FORWARD_URL: c.url, CODING_SH_FORWARD_MODE: "full" }));
    assert.equal((await post(h, "/v1/traces", undefined, otlpTraces("svc", [contentSpan("b7ad6b7169203331")]))).status, 200);
    const [s] = await c.spans(1);
    assert.equal(attr(s.attributes, "gen_ai.input.messages").stringValue, '[{"role":"user","content":"my secret plan"}]');
    assert.ok(attr(s.attributes, "input.value"));
    const token = attr(s.attributes, "app.token").stringValue as string;
    assert.ok(!token.includes("x".repeat(40)) && token.includes("[redacted"), token);
    assert.equal(s.events[0].attributes.length, 3);
    assert.equal(s.status.message, "upstream said: my secret plan");
    await h.shutdown();
  });

  it("the allowlist table", () => {
    const str = { stringValue: "x" };
    const cases: [string, object, boolean][] = [
      ["gen_ai.operation.name", str, true],
      ["gen_ai.provider.name", str, true],
      ["gen_ai.request.model", str, true],
      ["gen_ai.response.model", str, true],
      ["gen_ai.response.id", str, true],
      ["gen_ai.response.finish_reasons", { arrayValue: { values: [str] } }, true],
      ["gen_ai.usage.cache_read.input_tokens", { intValue: "5" }, true],
      ["gen_ai.tool.name", str, true],
      ["gen_ai.tool.call.id", str, true],
      ["gen_ai.tool.type", str, true],
      ["gen_ai.agent.name", str, true],
      ["gen_ai.agent.id", str, true],
      ["gen_ai.conversation.id", str, true],
      ["service.name", str, true],
      ["telemetry.sdk.language", str, true],
      ["http.request.method", str, true],
      ["http.response.status_code", { intValue: "200" }, true],
      ["error.type", str, true],
      ["coding_sh.run_id", str, true],
      ["coding_sh.session.title", str, false],
      ["coding_sh.repo.root", str, false],
      ["coding_sh.weights.changed", { intValue: "1204" }, true],
      ["coding_sh.weights.l2", { doubleValue: 0.0183 }, true],
      ["coding_sh.weights.max_abs", { doubleValue: 0.004 }, true],
      ["coding_sh.weights.tensor", str, false],
      ["coding_sh.weights.shape", { arrayValue: { values: [{ intValue: "4096" }, { intValue: "11008" }] } }, false],
      ["coding_sh.weights.base_sha256", str, false],
      ["coding_sh.weights.edited_sha256", str, false],
      ["coding_sh.weights.note", str, false],
      ["coding_sh.weights.sha256", { stringValue: WEIGHTS_FILE }, true],
      ["gen_ai.input.messages", str, false],
      ["gen_ai.output.messages", str, false],
      ["gen_ai.system_instructions", str, false],
      ["gen_ai.tool.call.arguments", str, false],
      ["gen_ai.tool.call.result", str, false],
      ["input.value", str, false],
      ["output.value", str, false],
      ["llm.input_messages", { arrayValue: { values: [str] } }, false],
      ["app.retries", { intValue: "2" }, true],
      ["app.score", { doubleValue: 0.5 }, true],
      ["app.flag", { boolValue: false }, true],
      ["app.note", str, false],
    ];
    for (const [k, v, want] of cases) assert.equal(keepInMetadata(k, v as never), want, k);
    // The SHA-256 of a checkpoint's base file passes on a weights.checkpoint span only, and only as a SHA-256.
    const base = "coding_sh.weights.base_sha256";
    assert.equal(keepInMetadata(base, { stringValue: WEIGHTS_BASE }, "weights.checkpoint"), true);
    assert.equal(keepInMetadata(base, { stringValue: WEIGHTS_BASE.toUpperCase() }, "weights.checkpoint"), true);
    assert.equal(keepInMetadata(base, { stringValue: "layers.3.mlp.down_proj.weight" }, "weights.checkpoint"), false);
    assert.equal(keepInMetadata(base, { intValue: "7" } as never, "weights.checkpoint"), false);
    assert.equal(keepInMetadata(base, { stringValue: WEIGHTS_BASE }, "weights.edit"), false);
    assert.equal(keepInMetadata(base, { stringValue: WEIGHTS_BASE }), false);
    assert.equal(keepInMetadata("coding_sh.weights.note", str as never, "weights.checkpoint"), false);
    assert.equal(keepInMetadata("coding_sh.weights.tensor", str as never, "weights.checkpoint"), false);
    // span helper: events keep exception.type only, status message cleared
    const span: JsonSpan = { traceId: TRACE, spanId: "b7ad6b7169203331", name: "x", kind: 1, startTimeUnixNano: "1", endTimeUnixNano: "2", attributes: [], status: { code: 2, message: "boom" } };
    assert.deepEqual(scrubSpan(span, "metadata", createRedactor()).status, { code: 2 });
  });
});

describe("serve forward: a weight edit and a weights checkpoint in one metadata batch", () => {
  const TENSOR_A = "a".repeat(64);
  const TENSOR_B = "b".repeat(64);
  const weights = (s: J) => Object.fromEntries((s.attributes as J[]).filter((kv) => kv.key.startsWith("coding_sh.weights.")).map((kv) => [kv.key, kv.value]));
  const want = {
    "weights.edit": { "coding_sh.weights.changed": { intValue: "1204" }, "coding_sh.weights.l2": { doubleValue: 0.0183 }, "coding_sh.weights.max_abs": { doubleValue: 0.004 } },
    "weights.checkpoint": { "coding_sh.weights.sha256": { stringValue: WEIGHTS_FILE }, "coding_sh.weights.base_sha256": { stringValue: WEIGHTS_BASE } },
  };
  const leaked = ["layers.3.mlp.down_proj.weight", TENSOR_A, TENSOR_B, "rank-1 edit", "after layer 3"];

  it("from /v1/ingest: the checkpoint keeps its two file hashes, the edit its counts, and neither its note", async () => {
    const c = await stub();
    const ik = generateKey("ingest");
    const index = new MemoryIndexStore();
    const { h } = await serve(tmpEnv({ CODING_SH_INGEST_KEYS: `demo:${ik}`, CODING_SH_FORWARD_URL: c.url, CODING_SH_CAPTURE_MODE: "metadata" }), { stores: { index, blobs: new MemoryBlobStore() } });
    const now = Date.now() - 5000;
    const events = [
      { v: 0, id: "s", sessionId: "edit-1", ts: now, kind: "session.start", payload: {} },
      { v: 0, id: "w", sessionId: "edit-1", ts: now + 10, kind: "notification", payload: { kind: "weights.edit", tensor: "layers.3.mlp.down_proj.weight", shape: [4096, 11008], changed: 1204, l2: 0.0183, maxAbs: 0.004, baseSha256: TENSOR_A, editedSha256: TENSOR_B, note: "rank-1 edit" } },
      { v: 0, id: "c", sessionId: "edit-1", ts: now + 20, kind: "notification", payload: { kind: "weights.checkpoint", sha256: WEIGHTS_FILE, baseSha256: WEIGHTS_BASE, note: "after layer 3" } },
      { v: 0, id: "e", sessionId: "edit-1", ts: now + 30, kind: "session.end", payload: {} },
    ];
    const r = await post(h, "/v1/ingest", ik, { v: 0, service: "trainer", events });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const spans = (await c.spans(3)).filter((s) => String(s.name).startsWith("weights."));
    assert.deepEqual(Object.fromEntries(spans.map((s) => [s.name, weights(s)])), want);
    const text = JSON.stringify(c.bodies);
    for (const needle of leaked) assert.ok(!text.includes(needle), needle);
    // The store kept the same: a checkpoint is still one the session can be found by.
    const stored = (await index.listEvents((await index.listSessions({}))[0]!.id)).filter((e) => e.kind === "notification").map((e) => e.payload);
    assert.deepEqual(stored, [
      { kind: "weights.edit", changed: 1204, l2: 0.0183, maxAbs: 0.004 },
      { kind: "weights.checkpoint", sha256: WEIGHTS_FILE, baseSha256: WEIGHTS_BASE },
    ]);
    assert.deepEqual((await index.listSessions({}))[0]!.stats.weightEdits, { events: 1, weightsChanged: 1204, checkpoints: [WEIGHTS_FILE] });
    await h.shutdown();
  });

  it("from /v1/traces: the same, on the app's own spans", async () => {
    const c = await stub();
    const { h } = await serve(tmpEnv({ CODING_SH_FORWARD_URL: c.url, CODING_SH_CAPTURE_MODE: "metadata" }));
    const body = otlpTraces("trainer", [
      otlpSpan(TRACE, "b7ad6b7169203331", undefined, "edit run", [], 0, 9),
      otlpSpan(
        TRACE,
        "b7ad6b7169203332",
        "b7ad6b7169203331",
        "weights.edit",
        [
          sAttr("coding_sh.weights.tensor", "layers.3.mlp.down_proj.weight"),
          iAttr("coding_sh.weights.changed", 1204),
          { key: "coding_sh.weights.l2", value: { doubleValue: 0.0183 } },
          { key: "coding_sh.weights.max_abs", value: { doubleValue: 0.004 } },
          sAttr("coding_sh.weights.base_sha256", TENSOR_A),
          sAttr("coding_sh.weights.edited_sha256", TENSOR_B),
          sAttr("coding_sh.weights.note", "rank-1 edit"),
        ],
        1,
        2,
      ),
      otlpSpan(TRACE, "b7ad6b7169203333", "b7ad6b7169203331", "weights.checkpoint", [sAttr("coding_sh.weights.sha256", WEIGHTS_FILE), sAttr("coding_sh.weights.base_sha256", WEIGHTS_BASE), sAttr("coding_sh.weights.note", "after layer 3")], 3, 4),
    ]);
    assert.equal((await post(h, "/v1/traces", undefined, body)).status, 200);
    const spans = (await c.spans(3)).filter((s) => String(s.name).startsWith("weights."));
    assert.deepEqual(Object.fromEntries(spans.map((s) => [s.name, weights(s)])), want);
    const text = JSON.stringify(c.bodies);
    for (const needle of leaked) assert.ok(!text.includes(needle), needle);
    await h.shutdown();
  });
});

describe("serve forward: native ingest", () => {
  it("converts /v1/ingest batches to invoke_agent, execute_tool and chat spans", async () => {
    const c = await stub();
    const ik = generateKey("ingest");
    const { h } = await serve(tmpEnv({ CODING_SH_INGEST_KEYS: `demo:${ik}`, CODING_SH_FORWARD_URL: c.url }));
    const now = Date.now() - 5000;
    const events = [
      { v: 0, id: "s", sessionId: "chat-1", ts: now, kind: "session.start", payload: {} },
      { v: 0, id: "t1", sessionId: "chat-1", ts: now + 10, kind: "tool.start", payload: { tool: "search", callId: "c1", input: { q: "weather" } } },
      { v: 0, id: "t2", sessionId: "chat-1", ts: now + 50, kind: "tool.end", payload: { tool: "search", callId: "c1", ok: true, output: "sunny" } },
      { v: 0, id: "m", sessionId: "chat-1", ts: now + 60, kind: "assistant.message", model: "gpt-4o", usage: { inputTokens: 100, outputTokens: 5 }, payload: { text: "It is sunny" } },
      { v: 0, id: "e", sessionId: "chat-1", ts: now + 70, kind: "session.end", payload: {} },
    ];
    const r = await post(h, "/v1/ingest", ik, { v: 0, service: "my-api", events });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const spans = await c.spans(3);
    const names = spans.map((s) => s.name).sort();
    assert.ok(names.some((n) => n.startsWith("invoke_agent")), names.join());
    assert.ok(names.some((n) => n.startsWith("execute_tool")), names.join());
    assert.ok(names.some((n) => n.startsWith("chat")), names.join());
    for (const s of spans) assert.deepEqual(attr(s.resource.attributes, "coding_sh.project"), { stringValue: "demo" });
    assert.equal(new Set(spans.map((s) => s.traceId)).size, 1, "one trace per session");
    await h.shutdown();
  });
});

describe("serve forward: failures never touch ingest", () => {
  it("a 503 collector backs off and gets every span after it recovers; ingest answers 200 throughout", async () => {
    const c = await stub([503, 503, 503]);
    const { h } = await serve(tmpEnv({ CODING_SH_FORWARD_URL: c.url }));
    for (let i = 0; i < 5; i++) {
      const r = await post(h, "/v1/traces", undefined, otlpTraces("svc", [otlpSpan(TRACE, `b7ad6b716920333${i}`, undefined, "chat", [sAttr("gen_ai.operation.name", "chat"), sAttr("gen_ai.conversation.id", "c")], i, i + 1)]));
      assert.equal(r.status, 200);
    }
    const spans = await c.spans(5);
    assert.equal(spans.length, 5);
    assert.equal(new Set(spans.map((s) => s.spanId)).size, 5, "no span lost or doubled");
    assert.equal(c.plan.length, 0, "the stub answered 503 three times first");
    await h.shutdown();
  });

  it("a collector that is down never slows ingest, and the buffer drops the oldest past max_buffer_spans", async () => {
    // A port nothing listens on.
    const dead = await stub();
    const deadUrl = dead.url;
    await new Promise<void>((r) => servers.pop()!.close(() => r()));
    const { h } = await serve(tmpEnv({ CODING_SH_FORWARD_URL: deadUrl, CODING_SH_FORWARD_MAX_BUFFER_SPANS: "3" }), { drainMs: 200 });
    const times: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await post(h, "/v1/traces", undefined, otlpTraces("svc", [otlpSpan(TRACE, `c7ad6b716920333${i}`, undefined, "chat", [sAttr("gen_ai.operation.name", "chat"), sAttr("gen_ai.conversation.id", "c")], i, i + 1)]));
      assert.equal(r.status, 200);
      times.push(r.ms);
    }
    assert.ok(Math.max(...times) < 1000, `ingest latency ${times.map((t) => t.toFixed(0)).join(",")} ms`);
    // A refused connection takes about 2 s to fail on Windows, so the first attempt may still be under way:
    // the gauge counts its spans too, and the oldest are dropped once they are back in the buffer.
    const metricsText = () => fetch(`${h.url}/metrics`).then((x) => x.text());
    let m = await metricsText();
    for (const deadline = Date.now() + 15_000; !m.includes('coding_sh_forward_spans_total{result="dropped"} 3') && Date.now() < deadline; m = await metricsText()) await new Promise((r) => setTimeout(r, 50));
    assert.match(m, /coding_sh_forward_spans_total\{result="dropped"\} 3/);
    assert.match(m, /coding_sh_forward_buffer_spans 3/);
    await h.shutdown();
  });

  it("drops a batch the collector refuses with a 400, and keeps going", async () => {
    const c = await stub([400]);
    const metrics = new ServeMetrics();
    const f = new OtlpForwarder({ config: { endpoint: c.url, headers: {}, mode: "metadata", maxBufferSpans: 100 }, redactor: createRedactor(), metrics, flushMs: 10_000 });
    const rs = (id: string) => [{ resource: { attributes: {} }, scopeSpans: [{ scope: { name: "t", attributes: {} }, spans: [{ traceId: TRACE, spanId: id, name: "x", kind: 1, startTimeUnixNano: "1", endTimeUnixNano: "2", attributes: {}, events: [], links: [], status: { code: 0 } }] }] }];
    f.enqueue(rs("1111111111111111"), "default");
    await f.pump();
    f.enqueue(rs("2222222222222222"), "default");
    await f.pump();
    assert.equal(metrics.forwardSpans.get({ result: "failed" }), 1);
    assert.equal(metrics.forwardSpans.get({ result: "sent" }), 1);
    assert.equal((await c.spans(1))[0].spanId, "2222222222222222");
    await f.close(100);
    metrics.close();
  });
});

describe("serve forward: shutdown and roles", () => {
  it("shutdown sends what is still buffered", async () => {
    const c = await stub();
    // A flush interval longer than the test: only the shutdown flush can deliver.
    const { h } = await serve(tmpEnv({ CODING_SH_FORWARD_URL: c.url }), { hookTiming: { flushMs: 60_000 } });
    for (let i = 0; i < 3; i++) await post(h, "/v1/traces", undefined, otlpTraces("svc", [otlpSpan(TRACE, `d7ad6b716920333${i}`, undefined, "chat", [sAttr("gen_ai.operation.name", "chat"), sAttr("gen_ai.conversation.id", "c")], i, i + 1)]));
    assert.equal(c.bodies.length, 0);
    await h.shutdown();
    assert.equal((await c.spans(3, 100)).length, 3);
  });

  it("a viewer-role replica never forwards or mirrors", async () => {
    const c = await stub();
    const sink = fakeSink("viewer-sink");
    const { h } = await serve(tmpEnv({ CODING_SH_FORWARD_URL: c.url }), { flags: { role: "viewer" }, sinks: [sink] });
    const m = await fetch(`${h.url}/metrics`).then((x) => x.text());
    assert.doesNotMatch(m, /coding_sh_forward_buffer_spans/);
    assert.equal((await post(h, "/v1/traces", undefined, otlpTraces("svc", []))).status, 404);
    await h.shutdown();
    assert.equal(c.bodies.length, 0);
    assert.equal(sink.batches.length, 0);
  });
});

describe("serve forward: config", () => {
  it("reads [serve.forward] with ${ENV} headers, and env overrides the endpoint", () => {
    const env = tmpEnv({ COLLECTOR_TOKEN: "s3cret" });
    const file = join(env.CODING_SH_HOME!, "config.toml");
    mkdirSync(env.CODING_SH_HOME!, { recursive: true });
    writeFileSync(file, `[serve.forward]\nendpoint = "http://collector:4318"\nmode = "full"\nmax_buffer_spans = 500\n[serve.forward.headers]\nAuthorization = "Bearer \${COLLECTOR_TOKEN}"\n`);
    const cfg = resolveServeConfig({ port: 0, config: file }, env);
    assert.deepEqual(cfg.forward, { endpoint: "http://collector:4318", headers: { Authorization: "Bearer s3cret" }, mode: "full", maxBufferSpans: 500 });
    const over = resolveServeConfig({ port: 0, config: file }, { ...env, CODING_SH_FORWARD_URL: "https://otel.example.com", CODING_SH_FORWARD_HEADERS: "x-k=v%2C1" });
    assert.equal(over.forward!.endpoint, "https://otel.example.com");
    assert.deepEqual(over.forward!.headers, { Authorization: "Bearer s3cret", "x-k": "v,1" });
  });

  it("defaults mode to capture.mode and the buffer to 20,000 spans", () => {
    const cfg = resolveServeConfig({ port: 0 }, tmpEnv({ CODING_SH_FORWARD_URL: "http://c:4318", CODING_SH_CAPTURE_MODE: "metadata" }));
    assert.deepEqual(cfg.forward, { endpoint: "http://c:4318", headers: {}, mode: "metadata", maxBufferSpans: 20_000 });
  });

  it("refuses a non-http(s) endpoint, bad headers and a bad mode", () => {
    assert.throws(() => resolveServeConfig({ port: 0 }, tmpEnv({ CODING_SH_FORWARD_URL: "grpc://collector:4317" })), (e: Error) => e instanceof ConfigError && /http:\/\/ or https:\/\//.test(e.message));
    assert.throws(() => resolveServeConfig({ port: 0 }, tmpEnv({ CODING_SH_FORWARD_URL: "not a url" })), ConfigError);
    assert.throws(() => resolveServeConfig({ port: 0 }, tmpEnv({ CODING_SH_FORWARD_URL: "http://c", CODING_SH_FORWARD_HEADERS: "novalue" })), /k=v pairs/);
    assert.throws(() => resolveServeConfig({ port: 0 }, tmpEnv({ CODING_SH_FORWARD_URL: "http://c", CODING_SH_FORWARD_MODE: "some" })), /"full" or "metadata"/);
  });
});

// ---- sink mirroring

interface FakeSink extends Sink {
  batches: { events: AgentEvent[]; sessions: Session[] }[];
  acks: SinkAck[];
}
function fakeSink(name: string, mode: "full" | "metadata" = "full", acks: SinkAck[] = []): FakeSink {
  const s: FakeSink = {
    name,
    mode,
    batches: [],
    acks,
    async write(events: AgentEvent[], sessions: Session[], _b: BlobStore) {
      const ack = s.acks.length ? s.acks.shift()! : { ok: true };
      if (ack.ok) s.batches.push({ events, sessions });
      return ack;
    },
  };
  return s;
}
const until = async (pred: () => boolean, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (!pred() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
};

describe("serve mirrors committed events to [[sinks]]", () => {
  it("hands OTLP-receiver and native events to every sink, metadata-stripped for a metadata sink", async () => {
    const full = fakeSink("full");
    const meta = fakeSink("meta", "metadata");
    const ik = generateKey("ingest");
    const { h } = await serve(tmpEnv({ CODING_SH_INGEST_KEYS: `demo:${ik}` }), { sinks: [full, meta] });
    assert.equal((await post(h, "/v1/traces", ik, otlpTraces("svc", [contentSpan("b7ad6b7169203331")]))).status, 200);
    const now = Date.now() - 1000;
    assert.equal((await post(h, "/v1/ingest", ik, { v: 0, service: "api", events: [{ v: 0, id: "u1", sessionId: "chat-9", ts: now, kind: "user.message", payload: { text: "native hello" } }] })).status, 200);
    // The OTLP span alone maps to several events, so wait for the native one in both sinks.
    const hasNative = (k: FakeSink) => k.batches.some((b) => b.events.some((e) => e.sessionId === "demo/chat-9"));
    await until(() => hasNative(full) && hasNative(meta) && full.batches.flatMap((b) => b.events).length >= 2);
    const fullEvents = full.batches.flatMap((b) => b.events);
    assert.ok(fullEvents.some((e) => e.kind === "llm.call" || e.kind === "assistant.message"), fullEvents.map((e) => e.kind).join());
    assert.ok(fullEvents.some((e) => e.sessionId === "demo/chat-9" && e.payload.text === "native hello"));
    assert.ok(fullEvents.every((e) => e.project === "demo"));
    assert.ok(full.batches.flatMap((b) => b.sessions).some((s) => s.id === "demo/chat-9"));
    const metaText = JSON.stringify(meta.batches);
    assert.ok(!metaText.includes("native hello") && !metaText.includes("my secret plan"), metaText);
    const m = await fetch(`${h.url}/metrics`, { headers: {} }).then((x) => x.text());
    assert.match(m, /coding_sh_sink_events_total\{sink="full",result="sent"\}/);
    await h.shutdown();
  });

  it("opens [[sinks]] from config.toml: an http sink receives the OTLP events", async () => {
    const received: J[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        res.end("{}");
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const env = tmpEnv();
    mkdirSync(env.CODING_SH_HOME!, { recursive: true });
    const file = join(env.CODING_SH_HOME!, "config.toml");
    writeFileSync(file, `[[sinks]]\nkind = "http"\nname = "relay"\nendpoint = "http://127.0.0.1:${(server.address() as AddressInfo).port}/ingest"\nmode = "full"\n`);
    const cfg = resolveServeConfig({ port: 0, config: file }, env);
    const h = await startServe(cfg, { log: quiet(), enrichSpan: false, stores: { index: new MemoryIndexStore(), blobs: new MemoryBlobStore() }, hookTiming: FAST });
    handles.push(h);
    assert.equal((await post(h, "/v1/traces", undefined, otlpTraces("svc", [contentSpan("b7ad6b7169203331")]))).status, 200);
    await until(() => received.length > 0);
    assert.ok(JSON.stringify(received).includes("conv-1"), JSON.stringify(received).slice(0, 300));
    await h.shutdown();
  });

  it("retries a failing sink with backoff and drops a refused batch", async () => {
    const flaky = fakeSink("flaky", "full", [{ ok: false, error: "503", retryAfterMs: 10 }, { ok: true }]);
    const refusing = fakeSink("refusing", "full", [{ ok: false, error: "401" }]);
    const metrics = new ServeMetrics();
    const mirror = new SinkMirror({ sinks: [flaky, refusing], blobs: new MemoryBlobStore(), metrics, log: quiet(), flushMs: 10, minBackoffMs: 10, maxBackoffMs: 50 });
    const e: AgentEvent = { v: 0, id: "x", sessionId: "s", ts: 1, agent: "sdk", kind: "notification", payload: {} };
    mirror.add([e], []);
    await until(() => flaky.batches.length === 1);
    await mirror.flush();
    assert.equal(flaky.batches.length, 1);
    assert.equal(refusing.batches.length, 0);
    assert.equal(metrics.sinkEvents.get({ sink: "refusing", result: "failed" }), 1);
    assert.equal(metrics.sinkEvents.get({ sink: "flaky", result: "sent" }), 1);
    await mirror.close(100);
    metrics.close();
  });
});

describe("the local collector mirrors OTLP events to [[sinks]]", () => {
  it("an http sink in config.toml receives what `coding.sh collector` stores, once however often it is posted", async () => {
    const { spawn } = await import("node:child_process");
    const received: J[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        res.end("{}");
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const env = tmpEnv();
    delete env.CODING_SH_STORE_URL;
    mkdirSync(env.CODING_SH_HOME!, { recursive: true });
    writeFileSync(join(env.CODING_SH_HOME!, "config.toml"), `[[sinks]]\nkind = "http"\nname = "relay"\nendpoint = "http://127.0.0.1:${(server.address() as AddressInfo).port}/ingest"\nmode = "metadata"\n`);
    const main = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
    const p = spawn(process.execPath, ["--no-warnings", main, "collector", "--port", "0", "--json"], { env: { PATH: process.env.PATH, ...env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    const closed = new Promise<number>((r) => p.on("close", (code) => r(code ?? -1)));
    try {
      await until(() => /"url"/.test(stdout), 20_000);
      const url = JSON.parse(stdout).url as string;
      const res = await fetch(`${url}/v1/traces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(otlpTraces("svc", [contentSpan("b7ad6b7169203331")])) });
      assert.equal(res.status, 200, await res.text());
      await until(() => received.length > 0, 10_000);
      const text = JSON.stringify(received);
      assert.ok(text.includes("conv-1"), text.slice(0, 300) + stderr);
      assert.ok(!text.includes("my secret plan"), "a metadata sink got content");
      // An exporter's retry (the same request twice more) stores nothing new, so the sink gets nothing more.
      // A span of another conversation, posted last, says when everything before it went out.
      const body = JSON.stringify(otlpTraces("svc", [contentSpan("b7ad6b7169203331")]));
      for (let i = 0; i < 2; i++) assert.equal((await fetch(`${url}/v1/traces`, { method: "POST", headers: { "content-type": "application/json" }, body })).status, 200);
      const last = JSON.stringify(otlpTraces("svc", [contentSpan("b7ad6b7169203332", "conv-last")]));
      assert.equal((await fetch(`${url}/v1/traces`, { method: "POST", headers: { "content-type": "application/json" }, body: last })).status, 200);
      await until(() => JSON.stringify(received).includes("conv-last"), 10_000);
      const ids = received.flatMap((b) => (b.events as { id: string }[]).map((e) => e.id));
      assert.ok(JSON.stringify(received).includes("conv-last"), stderr);
      assert.equal(new Set(ids).size, ids.length, `an event reached the sink more than once: ${ids.join()}`);
    } finally {
      p.kill("SIGINT");
      await closed;
    }
  });
});
