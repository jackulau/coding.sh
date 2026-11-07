import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import type { AgentEvent, Session } from "../../src/schema/index.ts";
import { HttpSink } from "../../src/sinks/http.ts";
import { otlpTracesUrl, OtlpSink, sessionSpanId, toOtlpSpans, traceIdFor } from "../../src/sinks/otlp.ts";
import { parseRetryAfter } from "../../src/sinks/post.ts";
import { MemoryBlobStore } from "../../src/store/memory.ts";

type Req = { method?: string; url?: string; headers: IncomingMessage["headers"]; body: any };
let server: Server;
let base = "";
const requests: Req[] = [];
let respond: (req: Req) => { status: number; headers?: Record<string, string>; delayMs?: number } = () => ({ status: 200 });

before(async () => {
  server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const r: Req = { method: req.method, url: req.url, headers: req.headers, body: data ? JSON.parse(data) : undefined };
      requests.push(r);
      const { status, headers, delayMs } = respond(r);
      setTimeout(() => {
        res.writeHead(status, headers);
        res.end(status >= 400 ? "nope" : "{}");
      }, delayMs ?? 0);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const blobs = new MemoryBlobStore();
const ev = (o: Partial<AgentEvent>): AgentEvent => ({ id: Math.random().toString(36), v: 0, sessionId: "s1", ts: 1_700_000_000_000, agent: "claude-code", kind: "notification", payload: {}, ...o });
const session: Session = {
  id: "s1",
  agent: "claude-code",
  model: "claude-x",
  title: "secret prompt",
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_010_000,
  stats: { events: 5, turns: 1, toolCalls: 1, toolErrors: 1, filesChanged: 0, usage: { inputTokens: 100, outputTokens: 50 } },
  flags: ["no-verification"],
};
const batch: AgentEvent[] = [
  ev({ id: "start", kind: "tool.start", ts: 1_700_000_001_000, payload: { tool: "Bash", toolUseId: "tu1", input: { command: "cat secrets.txt" } } }),
  ev({ id: "end", kind: "tool.end", ts: 1_700_000_002_500, payload: { tool: "Bash", toolUseId: "tu1", ok: false, output: "SECRET OUTPUT" } }),
  ev({ id: "llm", kind: "llm.call", ts: 1_700_000_003_000, durationMs: 800, model: "claude-x", usage: { inputTokens: 100, outputTokens: 50 }, payload: { provider: "anthropic", requestModel: "claude-x", ttftMs: 200, ok: true } }),
  ev({ id: "msg", kind: "assistant.message", ts: 1_700_000_004_000, model: "claude-x", payload: { text: "SECRET REPLY" } }),
  ev({ id: "se", kind: "session.end", ts: 1_700_000_010_000, payload: {} }),
];

describe("OTLP mapping", () => {
  it("maps session, tool and model calls to gen_ai spans with deterministic ids", () => {
    const spans = toOtlpSpans(batch, [session], "full");
    const byName = new Map(spans.map((s) => [s.name, s]));
    assert.deepEqual([...byName.keys()].sort(), ["chat claude-x", "execute_tool Bash", "invoke_agent claude-code"]);
    const attr = (name: string, key: string) => byName.get(name)!.attributes.find((a) => a.key === key)?.value;
    const root = byName.get("invoke_agent claude-code")!;
    assert.equal(root.traceId, traceIdFor("s1"));
    assert.equal(root.spanId, sessionSpanId("s1"));
    assert.match(root.traceId, /^[0-9a-f]{32}$/);
    assert.match(root.spanId, /^[0-9a-f]{16}$/);
    assert.equal(root.parentSpanId, undefined);
    assert.deepEqual(attr("invoke_agent claude-code", "gen_ai.operation.name"), { stringValue: "invoke_agent" });
    assert.deepEqual(attr("invoke_agent claude-code", "gen_ai.agent.name"), { stringValue: "claude-code" });
    assert.deepEqual(attr("invoke_agent claude-code", "gen_ai.request.model"), { stringValue: "claude-x" });
    assert.deepEqual(attr("invoke_agent claude-code", "gen_ai.usage.input_tokens"), { intValue: "100" });
    assert.equal(root.startTimeUnixNano, "1700000000000000000");
    const tool = byName.get("execute_tool Bash")!;
    assert.equal(tool.parentSpanId, root.spanId);
    assert.equal(tool.startTimeUnixNano, "1700000001000000000", "start from matching tool.start");
    assert.equal(tool.status?.code, 2);
    assert.deepEqual(attr("execute_tool Bash", "gen_ai.tool.name"), { stringValue: "Bash" });
    assert.match((attr("execute_tool Bash", "gen_ai.tool.call.arguments") as { stringValue: string }).stringValue, /cat secrets/);
    const chat = byName.get("chat claude-x")!;
    assert.equal(BigInt(chat.endTimeUnixNano) - BigInt(chat.startTimeUnixNano), 800_000_000n);
    assert.deepEqual(attr("chat claude-x", "gen_ai.usage.output_tokens"), { intValue: "50" });
    assert.deepEqual(attr("chat claude-x", "gen_ai.provider.name"), { stringValue: "anthropic" });
    assert.deepEqual(toOtlpSpans(batch, [session], "full"), spans, "deterministic");
  });

  it("strips content in metadata mode", () => {
    const json = JSON.stringify(toOtlpSpans(batch, [session], "metadata"));
    for (const secret of ["cat secrets", "SECRET OUTPUT", "SECRET REPLY", "secret prompt"]) assert.ok(!json.includes(secret), secret);
    assert.ok(json.includes("execute_tool Bash"));
  });

  it("falls back to assistant.message chat spans and nests subagent sessions in the parent trace", () => {
    const child: Session = { ...session, id: "child", parent: { sessionId: "s1" } };
    const spans = toOtlpSpans([
      ev({ id: "m", sessionId: "child", kind: "assistant.message", model: "m1", usage: { outputTokens: 3 }, payload: { text: "x" } }),
      ev({ id: "ce", sessionId: "child", kind: "session.end" }),
    ], [session, child], "metadata");
    assert.deepEqual(spans.map((s) => s.name), ["chat m1", "invoke_agent claude-code"]);
    assert.ok(spans.every((s) => s.traceId === traceIdFor("s1")));
    assert.equal(spans[1]!.parentSpanId, sessionSpanId("s1"));
  });

  it("builds the /v1/traces URL", () => {
    assert.equal(otlpTracesUrl("http://x:4318"), "http://x:4318/v1/traces");
    assert.equal(otlpTracesUrl("http://x:4318/"), "http://x:4318/v1/traces");
    assert.equal(otlpTracesUrl("http://x/v1/traces"), "http://x/v1/traces");
  });
});

describe("sinks over HTTP", () => {
  it("OtlpSink POSTs ExportTraceServiceRequest JSON with headers", async () => {
    requests.length = 0;
    respond = () => ({ status: 200 });
    const sink = new OtlpSink({ kind: "otlp", endpoint: base, mode: "metadata", headers: { authorization: "Bearer t" } });
    assert.deepEqual(await sink.write(batch, [session], blobs), { ok: true });
    const r = requests[0]!;
    assert.equal(r.url, "/v1/traces");
    assert.equal(r.headers["content-type"], "application/json");
    assert.equal(r.headers.authorization, "Bearer t");
    assert.equal(r.body.resourceSpans[0].scopeSpans[0].spans.length, 3);
    assert.ok(!JSON.stringify(r.body).includes("SECRET"));
  });

  it("OtlpSink skips the request when nothing maps to a span", async () => {
    requests.length = 0;
    const sink = new OtlpSink({ kind: "otlp", endpoint: base, mode: "full" });
    assert.deepEqual(await sink.write([ev({ kind: "notification" })], [], blobs), { ok: true });
    assert.equal(requests.length, 0);
  });

  it("HttpSink posts events + sessions and strips content in metadata mode", async () => {
    requests.length = 0;
    respond = () => ({ status: 202 });
    const full = new HttpSink({ kind: "http", endpoint: `${base}/ingest`, mode: "full", headers: { "x-key": "k" } });
    assert.deepEqual(await full.write(batch, [session], blobs), { ok: true });
    assert.equal(requests[0]!.url, "/ingest");
    assert.equal(requests[0]!.headers["x-key"], "k");
    assert.equal(requests[0]!.body.schema, "coding.sh/trace");
    assert.equal(requests[0]!.body.events.length, 5);
    assert.equal(requests[0]!.body.sessions[0].title, "secret prompt");
    const meta = new HttpSink({ kind: "http", endpoint: `${base}/ingest`, mode: "metadata" });
    await meta.write(batch, [session], blobs);
    assert.ok(!JSON.stringify(requests[1]!.body).toLowerCase().includes("secret"));
  });

  it("returns retryAfterMs on 429/5xx, none on other 4xx, and handles timeouts and refused connections", async () => {
    const sink = (timeoutMs?: number, endpoint = base) => new HttpSink({ kind: "http", endpoint, mode: "full" }, { timeoutMs });
    respond = () => ({ status: 429, headers: { "retry-after": "7" } });
    assert.deepEqual(await sink().write(batch, [], blobs).then((a) => [a.ok, a.retryAfterMs]), [false, 7000]);
    respond = () => ({ status: 503 });
    const a503 = await sink().write(batch, [], blobs);
    assert.equal(a503.ok, false);
    assert.ok((a503.retryAfterMs ?? 0) > 0);
    assert.match(a503.error!, /503/);
    respond = () => ({ status: 401 });
    const a401 = await sink().write(batch, [], blobs);
    assert.equal(a401.ok, false);
    assert.equal(a401.retryAfterMs, undefined);
    respond = () => ({ status: 200, delayMs: 300 });
    const slow = await sink(50).write(batch, [], blobs);
    assert.equal(slow.ok, false);
    assert.match(slow.error!, /timed out after 50ms/);
    const refused = await sink(1000, "http://127.0.0.1:1").write(batch, [], blobs);
    assert.equal(refused.ok, false);
    assert.ok(refused.retryAfterMs);
  });

  it("parses Retry-After seconds and dates", () => {
    assert.equal(parseRetryAfter("3"), 3000);
    assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 5_000), 5_000);
    assert.equal(parseRetryAfter("garbage"), undefined);
    assert.equal(parseRetryAfter(null), undefined);
    assert.equal(parseRetryAfter("999999"), 3_600_000);
  });
});
