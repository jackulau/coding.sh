import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { deserialize, serialize } from "node:v8";
import { gzipSync } from "node:zlib";
import { buildSession, foldSession, sessionOf, sessionState, type SessionState } from "../../src/core/sessions.ts";
import { joinUpstream } from "../../src/proxy/server.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { anthropicStream, call, everything, sleep, sse, startTestProxy, startUpstream, type TestProxy, type Upstream } from "./_helpers.ts";

const SECRET = "sk-ant-api03-SECRETSECRETSECRETSECRETSECRETSECRETSECRET-abcdefAA";
const SESSION = "4f1c2a9e-8d7b-4c1a-9e2f-0a1b2c3d4e5f";

const messagesBody = (o: { stream?: boolean; prompt?: string; system?: string } = {}) =>
  JSON.stringify({
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    stream: o.stream ?? true,
    system: [{ type: "text", text: o.system ?? "You are a careful coding agent." }],
    tools: [
      { name: "Bash", description: "Run a command", input_schema: { type: "object" } },
      { name: "Read", description: "Read a file", input_schema: { type: "object" } },
    ],
    messages: [{ role: "user", content: [{ type: "text", text: o.prompt ?? "fix the failing test" }] }],
    metadata: { user_id: JSON.stringify({ device_id: "d", session_id: SESSION }) },
  });

const claudeHeaders = (extra: Record<string, string> = {}) => ({
  "content-type": "application/json",
  "x-api-key": SECRET,
  authorization: `Bearer ${SECRET}`,
  "anthropic-version": "2023-06-01",
  "user-agent": "claude-cli/2.1.319 (external, cli)",
  "x-claude-code-session-id": SESSION,
  ...extra,
});

describe("proxy: Anthropic Messages streaming", () => {
  let up: Upstream;
  let t: TestProxy;
  let release: () => void = () => {};
  const parts = anthropicStream({ tool: { name: "Bash", input: { command: "npm test" } } });
  after(async () => {
    await t?.close();
    await up?.close();
  });

  it("passes the stream through byte for byte, chunk by chunk, before the upstream finishes", async () => {
    up = await startUpstream(async (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_123", "anthropic-ratelimit-requests-remaining": "49", "anthropic-ratelimit-tokens-remaining": "79000", "x-secret-upstream": "no" });
      res.write(parts[0]);
      // Hold the rest until the client has the first event: the proxy must not buffer.
      await new Promise<void>((r) => (release = r));
      for (const p of parts.slice(1)) {
        res.write(p);
        await sleep(2);
      }
      res.end();
    });
    t = await startTestProxy(up.url);
    let firstAt = 0;
    const result = await call(t.proxy.url, {
      path: "/v1/messages?beta=true",
      body: messagesBody(),
      headers: claudeHeaders(),
      onChunk: () => {
        if (!firstAt) {
          firstAt = Date.now();
          release();
        }
      },
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.toString(), parts.join(""), "client gets the exact upstream bytes");
    assert.ok(result.chunks.length > 1, "streamed in several chunks");
    assert.equal(result.headers["request-id"], "req_123");
    // The upstream got the client's own credentials and path.
    const seen = up.seen[0]!;
    assert.equal(seen.headers["x-api-key"], SECRET);
    assert.equal(seen.headers.authorization, `Bearer ${SECRET}`);
    assert.equal(seen.url, "/v1/messages?beta=true");
    assert.equal(seen.body.toString(), messagesBody());
  });

  it("records one llm.call in the session Claude Code names, with usage, cache tokens, timings and content", async () => {
    const events = await t.events();
    assert.equal(events.length, 1);
    const e = events[0]!;
    assert.equal(e.kind, "llm.call");
    assert.equal(e.source, "proxy");
    assert.equal(e.sessionId, SESSION);
    assert.equal(e.agent, "claude-code");
    assert.equal(e.agentVersion, "2.1.319");
    assert.equal(e.model, "claude-sonnet-4-5-20250929");
    assert.deepEqual({ ...e.usage, costUsd: undefined }, { inputTokens: 12, outputTokens: 42, cacheReadTokens: 5000, cacheWriteTokens: 300, costUsd: undefined });
    assert.ok((e.usage?.costUsd ?? 0) > 0, "priced from the table");
    const p = e.payload;
    assert.equal(p.provider, "anthropic");
    assert.equal(p.api, "messages");
    assert.equal(p.ok, true);
    assert.equal(p.statusCode, 200);
    assert.equal(p.stopReason, "tool_use");
    assert.equal(p.messageId, "msg_test_1");
    assert.equal(p.requestId, "req_123");
    assert.equal(p.linkedBy, "header");
    assert.equal(p.rlRequestsRemaining, 49);
    assert.equal(p.rlTokensRemaining, 79000);
    assert.deepEqual(p.toolNames, ["Bash", "Read"]);
    assert.equal(p.toolCount, 2);
    assert.equal(p.messageCount, 1);
    assert.equal(p.prompt, "fix the failing test");
    assert.equal(typeof p.ttftMs, "number");
    assert.equal(typeof p.systemHash, "string");
    assert.equal((p.systemHash as string).length, 16);
    // Content: request with system/tools in their own blobs, and the rebuilt response.
    const req = JSON.parse((await t.blobs.getText(p.requestRef as string))!);
    assert.deepEqual(req.body.system, { $blob: p.systemRef });
    assert.deepEqual(req.body.tools, { $blob: p.toolsRef });
    assert.equal(req.body.messages[0].content[0].text, "fix the failing test");
    assert.equal(req.headers["x-claude-code-session-id"], SESSION);
    const sys = JSON.parse((await t.blobs.getText(p.systemRef as string))!);
    assert.equal(sys[0].text, "You are a careful coding agent.");
    const res = JSON.parse((await t.blobs.getText(p.responseRef as string))!);
    assert.equal(res.status, 200);
    assert.equal(res.body.content[0].text, "Hello world");
    assert.deepEqual(res.body.content[1], { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "npm test" } });
    assert.equal(res.headers["x-secret-upstream"], undefined, "only allowlisted response headers");
    assert.deepEqual(new Set(e.blobs), new Set([p.requestRef, p.responseRef, p.systemRef, p.toolsRef]));
  });

  it("never stores the client's auth headers", async () => {
    const all = await everything(t);
    assert.ok(!all.includes(SECRET.slice(10, 40)), "secret appears nowhere in events or blobs");
    assert.ok(!/x-api-key|"authorization"/i.test(all));
  });

  it("builds the session with the call's usage and a title from its prompt", async () => {
    const s = await t.index.getSession(SESSION);
    assert.ok(s);
    assert.equal(s.parseVersion, 0, "created by the proxy: ingest stamps it later");
    assert.equal(s.stats.usage?.outputTokens, 42);
    assert.equal(s.title, "fix the failing test");
  });
});

describe("proxy: resilience", () => {
  it("answers the client when the store write fails", async () => {
    const up = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "msg_1", type: "message", model: "claude-haiku-4-5", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 1 } }));
    });
    const t = await startTestProxy(up.url, {
      write: async () => {
        throw new Error("disk full");
      },
    });
    try {
      const r = await call(t.proxy.url, { path: "/v1/messages", body: messagesBody({ stream: false }), headers: claudeHeaders() });
      assert.equal(r.status, 200);
      assert.equal(JSON.parse(r.body.toString()).content[0].text, "ok");
      await t.recorder.flush();
      assert.equal(t.errors.length, 1);
      assert.match(t.errors[0]!.message, /disk full/);
      assert.equal(t.recorder.stats.failed, 1);
    } finally {
      await t.close();
      await up.close();
    }
  });

  it("returns 502 and records a network error when the upstream is down", async () => {
    const t = await startTestProxy("http://127.0.0.1:1");
    try {
      const r = await call(t.proxy.url, { path: "/v1/messages", body: messagesBody({ stream: false }), headers: claudeHeaders() });
      assert.equal(r.status, 502);
      assert.match(JSON.parse(r.body.toString()).error.message, /unreachable/);
      const [e] = await t.events();
      assert.equal(e!.payload.ok, false);
      assert.equal(e!.payload.errorClass, "network");
      const s = await t.index.getSession(SESSION);
      assert.equal(s?.stats.llmErrors?.count, 1);
    } finally {
      await t.close();
    }
  });

  it("records 429s with their class and retry-after", async () => {
    const up = await startUpstream((_req, res) => {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "7" });
      res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Number of requests has exceeded your rate limit" } }));
    });
    const t = await startTestProxy(up.url);
    try {
      const r = await call(t.proxy.url, { path: "/v1/messages", body: messagesBody({ stream: false }), headers: claudeHeaders() });
      assert.equal(r.status, 429);
      const [e] = await t.events();
      assert.equal(e!.payload.ok, false);
      assert.equal(e!.payload.errorClass, "rate_limit");
      assert.equal(e!.payload.errorType, "rate_limit_error");
      assert.equal(e!.payload.retryAfterMs, 7000);
      assert.match(String(e!.payload.error), /rate limit/);
    } finally {
      await t.close();
      await up.close();
    }
  });

  it("stops the upstream call when the client goes away", async () => {
    let upstreamClosed = false;
    const up = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(anthropicStream()[0]);
      res.on("close", () => (upstreamClosed = true));
    });
    const t = await startTestProxy(up.url);
    try {
      const ac = new AbortController();
      await assert.rejects(call(t.proxy.url, { path: "/v1/messages", body: messagesBody(), headers: claudeHeaders(), signal: ac.signal, onChunk: () => ac.abort() }));
      for (let i = 0; i < 100 && !upstreamClosed; i++) await sleep(10);
      assert.ok(upstreamClosed, "upstream request closed");
      const [e] = await t.events();
      assert.equal(e!.payload.aborted, true);
      assert.equal(e!.payload.ok, true, "an interrupt is not an API error");
    } finally {
      await t.close();
      await up.close();
    }
  });

  it("refuses a non-loopback Host header and cross-origin browser requests", async () => {
    const t = await startTestProxy("http://127.0.0.1:1");
    try {
      const a = await call(t.proxy.url, { path: "/v1/messages", body: "{}", headers: { host: "evil.example.com" } });
      assert.equal(a.status, 403);
      const b = await call(t.proxy.url, { path: "/v1/messages", body: "{}", headers: { origin: "https://evil.example.com" } });
      assert.equal(b.status, 403);
      assert.deepEqual(await t.events(), []);
    } finally {
      await t.close();
    }
  });

  it("answers its health check without forwarding", async () => {
    const t = await startTestProxy("http://127.0.0.1:1");
    try {
      const r = await call(t.proxy.url, { method: "GET", path: "/__codingsh/health" });
      assert.equal(r.status, 200);
      assert.equal(JSON.parse(r.body.toString()).service, "coding.sh proxy");
    } finally {
      await t.close();
    }
  });
});

describe("proxy: OpenAI", () => {
  it("passes a gzipped Chat Completions response through untouched and parses its usage", async () => {
    const body = JSON.stringify({ id: "chatcmpl-1", object: "chat.completion", model: "gpt-4.1-mini-2025-04-14", choices: [{ index: 0, message: { role: "assistant", content: "4" }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 8 } } });
    const gz = gzipSync(body);
    const up = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip", "x-ratelimit-remaining-requests": "99" });
      res.end(gz);
    });
    const t = await startTestProxy(up.url);
    try {
      const r = await call(t.proxy.url, {
        path: "/v1/chat/completions",
        body: JSON.stringify({ model: "gpt-4.1-mini", messages: [{ role: "system", content: "Be terse." }, { role: "user", content: "2+2?" }] }),
        headers: { "content-type": "application/json", authorization: "Bearer sk-proj-abcdefghijklmnopqrstuvwxyz0123456789", "accept-encoding": "gzip", "user-agent": "OpenAI/JS 4.104.0" },
      });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, gz, "compressed bytes unchanged");
      const [e] = await t.events();
      assert.equal(e!.agent, "proxy");
      assert.match(e!.sessionId, /^proxy-[0-9a-f]{16}$/);
      assert.equal(e!.payload.client, "openai");
      assert.equal(e!.payload.api, "chat");
      assert.equal(e!.payload.responseId, "chatcmpl-1");
      assert.equal(e!.payload.stopReason, "stop");
      assert.equal(e!.payload.rlRequestsRemaining, 99);
      assert.deepEqual({ i: e!.usage?.inputTokens, c: e!.usage?.cacheReadTokens, o: e!.usage?.outputTokens }, { i: 12, c: 8, o: 1 });
      const all = await everything(t);
      assert.ok(!all.includes("abcdefghijklmnopqrstuvwxyz0123"));
    } finally {
      await t.close();
      await up.close();
    }
  });

  it("links Codex Responses calls to its thread and rebuilds the streamed output", async () => {
    const thread = "019a1b8d-1d73-7f00-9df8-82f7ad50858c";
    const stream = sse([
      { event: "response.created", data: { type: "response.created", response: { id: "resp_1", model: "gpt-5-codex", status: "in_progress", output: [] } } },
      { event: "response.output_text.delta", data: { type: "response.output_text.delta", delta: "Running" } },
      { event: "response.output_item.done", data: { type: "response.output_item.done", item: { type: "function_call", name: "exec_command", arguments: '{"cmd":"ls"}', call_id: "c1" } } },
      { event: "response.completed", data: { type: "response.completed", response: { id: "resp_1", model: "gpt-5-codex", status: "completed", output: [], usage: { input_tokens: 9000, input_tokens_details: { cached_tokens: 8000 }, output_tokens: 50 } } } },
    ]);
    const up = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const s of stream) res.write(s);
      res.end();
    });
    const t = await startTestProxy(up.url);
    try {
      const r = await call(t.proxy.url, {
        path: "/v1/responses",
        body: JSON.stringify({ model: "gpt-5-codex", stream: true, instructions: "You are Codex.", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "list files" }] }], tools: [{ type: "function", name: "exec_command" }] }),
        headers: {
          "content-type": "application/json",
          authorization: "Bearer sk-stub",
          originator: "codex_exec",
          "user-agent": "codex_exec/0.167.0 (Mac OS 26.5.2; arm64)",
          "session-id": thread,
          "x-codex-turn-metadata": JSON.stringify({ session_id: thread, turn_id: "turn-1" }),
        },
      });
      assert.equal(r.body.toString(), stream.join(""));
      const [e] = await t.events();
      assert.equal(e!.sessionId, thread);
      assert.equal(e!.agent, "codex");
      assert.equal(e!.agentVersion, "0.167.0");
      assert.equal(e!.turnId, "turn-1");
      assert.equal(e!.payload.stopReason, "tool_calls");
      assert.deepEqual({ i: e!.usage?.inputTokens, c: e!.usage?.cacheReadTokens, o: e!.usage?.outputTokens }, { i: 1000, c: 8000, o: 50 });
      const res = JSON.parse((await t.blobs.getText(e!.payload.responseRef as string))!);
      assert.equal(res.body.output[0].name, "exec_command", "output items collected from the stream");
    } finally {
      await t.close();
      await up.close();
    }
  });

  it("forwards other paths untouched and records nothing", async () => {
    const up = await startUpstream((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "gpt-5" }], path: req.url }));
    });
    const t = await startTestProxy(up.url);
    try {
      const r = await call(t.proxy.url, { method: "GET", path: "/v1/models", headers: { authorization: "Bearer sk-x" } });
      assert.equal(JSON.parse(r.body.toString()).path, "/v1/models");
      assert.deepEqual(await t.events(), []);
    } finally {
      await t.close();
      await up.close();
    }
  });

  it("puts each turn of a stateless conversation in one proxy session", async () => {
    const up = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "c", model: "gpt-4.1", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }));
    });
    const t = await startTestProxy(up.url);
    try {
      const turn1 = [{ role: "user", content: "plan a trip" }];
      const turn2 = [...turn1, { role: "assistant", content: "ok" }, { role: "user", content: "make it shorter" }];
      for (const messages of [turn1, turn2]) await call(t.proxy.url, { path: "/v1/chat/completions", body: JSON.stringify({ model: "gpt-4.1", messages }), headers: { "content-type": "application/json" } });
      await call(t.proxy.url, { path: "/v1/chat/completions", body: JSON.stringify({ model: "gpt-4.1", messages: [{ role: "user", content: "another chat" }] }), headers: { "content-type": "application/json" } });
      const events = await t.events();
      const ids = new Set(events.map((e) => e.sessionId));
      assert.equal(events.length, 3);
      assert.equal(ids.size, 2);
      const [a] = events.filter((e) => e.payload.prompt === "make it shorter");
      const s = await t.index.getSession(a!.sessionId);
      assert.equal(s?.title, "plan a trip");
    } finally {
      await t.close();
      await up.close();
    }
  });
});

describe("proxy: metadata mode", () => {
  it("stores no prompts, responses or blobs, only counts, names, hashes and usage", async () => {
    const up = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const p of anthropicStream({ text: "TOPSECRETANSWER" })) res.write(p);
      res.end();
    });
    const t = await startTestProxy(up.url, { config: { mode: "metadata" } });
    try {
      await call(t.proxy.url, { path: "/v1/messages", body: messagesBody({ prompt: "TOPSECRETPROMPT" }), headers: claudeHeaders() });
      const [e] = await t.events();
      assert.equal(e!.payload.prompt, undefined);
      assert.equal(e!.blobs, undefined);
      assert.equal(typeof e!.payload.systemHash, "string");
      assert.equal(e!.payload.toolCount, 2);
      assert.equal(e!.usage?.outputTokens, 42);
      const all = await everything(t);
      assert.ok(!all.includes("TOPSECRET"));
      let n = 0;
      for await (const _ of t.blobs.list()) n++;
      assert.equal(n, 0);
    } finally {
      await t.close();
      await up.close();
    }
  });
});

describe("proxy: sessions", () => {
  const ev = (o: Partial<AgentEvent> & { id: string; kind: AgentEvent["kind"] }): AgentEvent => ({ v: 0, sessionId: "s", ts: 1000, agent: "claude-code", payload: {}, ...o });

  it("counts a call once when the transcript recorded it too", () => {
    const events = [
      ev({ id: "u", kind: "user.message", source: "hook", payload: { text: "hi" } }),
      ev({ id: "t", kind: "llm.call", source: "transcript", ts: 2000, durationMs: 900, usage: { inputTokens: 10, outputTokens: 5 }, payload: { messageId: "msg_1", ok: true } }),
      ev({ id: "p", kind: "llm.call", source: "proxy", ts: 2000, durationMs: 950, usage: { inputTokens: 10, outputTokens: 5 }, payload: { messageId: "msg_1", ok: true } }),
      ev({ id: "p2", kind: "llm.call", source: "proxy", ts: 2500, durationMs: 100, payload: { ok: false, statusCode: 529, errorClass: "overloaded" } }),
    ];
    const s = buildSession(events);
    assert.equal(s.stats.usage?.inputTokens, 10);
    assert.equal(s.stats.usage?.outputTokens, 5);
    assert.equal(s.stats.duplicateUsage, undefined, "not reported as duplicate either");
    assert.equal(s.stats.latency?.llmCalls, 1);
    assert.equal(s.stats.llmErrors?.count, 1, "only the proxy saw the overloaded retry");
  });

  it("counts proxy calls when nothing else recorded model calls", () => {
    const s = buildSession([ev({ id: "u", kind: "user.message", source: "hook", payload: { text: "hi" } }), ev({ id: "p", kind: "llm.call", source: "proxy", usage: { inputTokens: 7, outputTokens: 3 }, payload: { ok: true } })]);
    assert.equal(s.stats.usage?.inputTokens, 7);
  });

  it("stops counting the proxy's calls once the transcript's arrive, folded one append at a time", () => {
    const events = [
      ev({ id: "u", kind: "user.message", source: "hook", ts: 1000, payload: { text: "hi" } }),
      ev({ id: "p", kind: "llm.call", source: "proxy", ts: 2000, durationMs: 950, usage: { inputTokens: 10, outputTokens: 5 }, payload: { ok: true } }),
      ev({ id: "t", kind: "llm.call", source: "transcript", ts: 3000, durationMs: 900, usage: { inputTokens: 10, outputTokens: 5 }, payload: { ok: true } }),
    ];
    // Live: the hook and the proxy first (the transcript is read later), with the fold saved in between.
    let st: SessionState = sessionState();
    const append = (es: AgentEvent[]) => {
      for (const e of es) foldSession(st, e);
      st = deserialize(serialize(st)) as SessionState;
      return sessionOf(st);
    };
    const live = append(events.slice(0, 2));
    assert.equal(live.stats.usage?.outputTokens, 5, "the proxy's call counts while it is the only one");
    assert.equal(live.stats.latency?.llmCalls, 1);
    const later = append(events.slice(2));
    assert.equal(later.stats.usage?.outputTokens, 5, "the transcript's call replaces it");
    assert.equal(later.stats.latency?.llmCalls, 1);
    assert.deepEqual(later.stats, buildSession(events).stats, "same as a full rebuild");
  });

  it("titles a proxy-only session from the call's last prompt", () => {
    const s = buildSession([ev({ id: "p", kind: "llm.call", source: "proxy", agent: "proxy", payload: { ok: true, prompt: "summarize the release notes" } })]);
    assert.equal(s.title, "summarize the release notes");
  });
});

// The per-request fields a CLIProxyAPI-style log keeps: session id, effort, service tier, speed, TTFT, compaction.
describe("proxy: per-request fields", () => {
  it("Anthropic: effort, speed and service tier from the request, TTFT, the session id, and a compaction block", async () => {
    const stream = sse([
      { event: "message_start", data: { type: "message_start", message: { id: "msg_c", model: "claude-opus-4-6", content: [], usage: { input_tokens: 10, output_tokens: 1 } } } },
      { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "compaction", content: "" } } },
      { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
      { event: "content_block_start", data: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } } },
      { event: "content_block_delta", data: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "ok" } } },
      { event: "content_block_stop", data: { type: "content_block_stop", index: 1 } },
      { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } } },
      { event: "message_stop", data: { type: "message_stop" } },
    ]);
    const up = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const s of stream) res.write(s);
      res.end();
    });
    const t = await startTestProxy(up.url);
    try {
      const body = JSON.parse(messagesBody());
      Object.assign(body, { model: "claude-opus-4-6", output_config: { effort: "high" }, speed: "fast", service_tier: "auto", context_management: { edits: [{ type: "compact_20260112" }] } });
      const r = await call(t.proxy.url, { path: "/v1/messages?beta=true", body: JSON.stringify(body), headers: claudeHeaders() });
      assert.equal(r.body.toString(), stream.join(""));
      const [e] = await t.events();
      assert.equal(e!.sessionId, SESSION, "the client's session id");
      assert.equal(e!.payload.linkedBy, "header");
      assert.equal(e!.payload.reasoningEffort, "high");
      assert.equal(e!.payload.speed, "fast");
      assert.equal(e!.payload.serviceTier, "auto");
      assert.equal(typeof e!.payload.ttftMs, "number");
      assert.equal(e!.payload.compaction, true);
    } finally {
      await t.close();
      await up.close();
    }
  });

  it("Codex: /responses/compact is logged as a compaction call; the tier the response reports wins over the request's", async () => {
    const thread = "019a1b8d-1d73-7f00-9df8-82f7ad50858d";
    const up = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "resp_c", object: "response", model: "gpt-5.5", service_tier: "priority", output: [{ type: "compaction", encrypted_content: "x" }], usage: { input_tokens: 5000, output_tokens: 400 } }));
    });
    const t = await startTestProxy(up.url);
    try {
      const r = await call(t.proxy.url, {
        path: "/v1/responses/compact",
        body: JSON.stringify({ model: "gpt-5.5", instructions: "You are Codex.", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "list files" }] }], reasoning: { effort: "xhigh" }, service_tier: "auto" }),
        headers: { "content-type": "application/json", authorization: "Bearer sk-stub", "user-agent": "codex_exec/0.167.0 (Mac OS 26.5.2; arm64)", "session-id": thread },
      });
      assert.equal(r.status, 200);
      assert.equal(up.seen[0]!.url, "/v1/responses/compact", "forwarded to the same path");
      const [e] = await t.events();
      assert.equal(e!.kind, "llm.call");
      assert.equal(e!.sessionId, thread);
      assert.equal(e!.payload.api, "responses");
      assert.equal(e!.payload.compaction, true);
      assert.equal(e!.payload.reasoningEffort, "xhigh");
      assert.equal(e!.payload.serviceTier, "priority");
      assert.equal(e!.payload.requestedServiceTier, "auto");
      assert.equal(e!.usage?.outputTokens, 400);
    } finally {
      await t.close();
      await up.close();
    }
  });

  it("an ordinary call has none of them", async () => {
    const up = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "msg_1", type: "message", model: "claude-sonnet-4-5", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 1 } }));
    });
    const t = await startTestProxy(up.url);
    try {
      await call(t.proxy.url, { path: "/v1/messages", body: messagesBody({ stream: false }), headers: claudeHeaders() });
      const [e] = await t.events();
      for (const k of ["compaction", "speed", "serviceTier", "requestedServiceTier", "reasoningEffort", "ttftMs"]) assert.equal(e!.payload[k], undefined, k);
    } finally {
      await t.close();
      await up.close();
    }
  });
});

describe("joinUpstream", () => {
  it("does not double /v1 and keeps a gateway's path", () => {
    assert.equal(joinUpstream("https://api.anthropic.com", "/v1/messages").href, "https://api.anthropic.com/v1/messages");
    assert.equal(joinUpstream("https://gw.example.com/anthropic/v1", "/v1/messages?beta=true").href, "https://gw.example.com/anthropic/v1/messages?beta=true");
    assert.equal(joinUpstream("https://gw.example.com/openai/", "/v1/responses").href, "https://gw.example.com/openai/v1/responses");
    assert.equal(joinUpstream("https://chatgpt.com/backend-api/codex", "/responses").href, "https://chatgpt.com/backend-api/codex/responses");
  });
});
