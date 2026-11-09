// The LLM-call playground (src/viewer/playground.ts): calls captured by the
// real proxy rebuild into neutral requests (Anthropic Messages, OpenAI chat,
// OpenAI Responses), a hook-only call rebuilds from the session's events, a
// run goes to a stub OpenAI-compatible server, a save adds a case to a new
// dataset version, and the /api/playground routes guard their inputs.
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { FileEvalStore } from "../../src/datasets/store.ts";
import { validatePrefix } from "../../src/experiments/continuation.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";
import { parseRequest, PlaygroundError, rebuildCall, renderBody, requestFromBody, runPlayground, saveCase, viewerPlayground, type PlaygroundRequest } from "../../src/viewer/playground.ts";
import { startViewer, type Viewer } from "../../src/viewer/server.ts";
import { anthropicStream, call, startTestProxy, startUpstream, type TestProxy, type Upstream } from "../proxy/_helpers.ts";

const KEY = ["sk-ant-api03-", "PLAYGROUNDPLAYGROUNDPLAYGROUNDPLAYGROUND", "-abcdefAA"].join("");

/** A stub OpenAI-compatible server: records each body, answers with one chat completion. */
async function stubOpenAI(answer: (body: any) => unknown): Promise<{ url: string; bodies: any[]; headers: Record<string, unknown>[]; close(): Promise<void> }> {
  const bodies: any[] = [];
  const headers: Record<string, unknown>[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      bodies.push({ path: req.url, ...body });
      headers.push(req.headers);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(answer(body)));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    bodies,
    headers,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
const chatAnswer = (text: string, tool?: { name: string; args: unknown }) => ({
  id: "chatcmpl-pg",
  object: "chat.completion",
  model: "stub-coder-1",
  choices: [{ index: 0, message: { role: "assistant", content: text, ...(tool ? { tool_calls: [{ id: "call_9", type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } : {}) }, finish_reason: tool ? "tool_calls" : "stop" }],
  usage: { prompt_tokens: 40, completion_tokens: 7 },
});

describe("rebuild from calls the proxy captured", () => {
  let up: Upstream;
  let t: TestProxy;
  before(async () => {
    up = await startUpstream((req, res) => {
      if (req.url.startsWith("/v1/messages")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const p of anthropicStream({ tool: { name: "Bash", input: { command: "npm test" } } })) res.write(p);
        res.end();
        return;
      }
      if (req.url.startsWith("/v1/chat/completions")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(chatAnswer("Done: 4.")));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "resp_1", model: "gpt-5-codex", status: "completed", output: [{ type: "function_call", name: "exec_command", arguments: '{"cmd":"ls"}', call_id: "c2" }], usage: { input_tokens: 90, output_tokens: 5 } }));
    });
    t = await startTestProxy(up.url);
  });
  after(async () => {
    await t?.close();
    await up?.close();
  });

  async function only(api: string): Promise<AgentEvent> {
    const calls = (await t.events()).filter((e) => e.kind === "llm.call" && e.payload.api === api);
    assert.equal(calls.length, 1, `one ${api} call`);
    return calls[0]!;
  }

  test("Anthropic Messages: system, tool use and results, tools, settings and the recorded answer", async () => {
    const body = {
      model: "claude-sonnet-4-5",
      max_tokens: 2048,
      temperature: 0.3,
      stream: true,
      system: [{ type: "text", text: "You are a careful coding agent." }, { type: "text", text: "Work in /work/demo." }],
      tools: [{ name: "Bash", description: "Run a command", input_schema: { type: "object", properties: { command: { type: "string" } } } }],
      messages: [
        { role: "user", content: [{ type: "text", text: "fix the failing test" }] },
        { role: "assistant", content: [{ type: "thinking", thinking: "hmm", signature: "x" }, { type: "text", text: "Running the tests." }, { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "npm test" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "1 failing" }], is_error: true }, { type: "text", text: "keep going" }] },
      ],
    };
    await call(t.proxy.url, { path: "/v1/messages", body: JSON.stringify(body), headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" } });
    const r = await rebuildCall(t.index, t.blobs, await only("messages"));
    assert.equal(r.source, "request");
    assert.equal(r.provider, "anthropic");
    assert.deepEqual(r.request, {
      model: "claude-sonnet-4-5",
      system: "You are a careful coding agent.\n\nWork in /work/demo.",
      messages: [
        { role: "user", text: "fix the failing test" },
        { role: "assistant", text: "Running the tests.", toolCalls: [{ id: "toolu_1", name: "Bash", input: { command: "npm test" } }] },
        { role: "tool", toolUseId: "toolu_1", name: "Bash", content: "1 failing", isError: true },
        { role: "user", text: "keep going" },
      ],
      tools: [{ name: "Bash", description: "Run a command", inputSchema: { type: "object", properties: { command: { type: "string" } } } }],
      maxTokens: 2048,
      temperature: 0.3,
    });
    assert.equal(r.response?.toolCalls[0]?.name, "Bash");
    // Rendered back for Anthropic it is the same conversation (thinking aside).
    const again = requestFromBody("messages", renderBody("anthropic", r.request));
    assert.deepEqual(again, r.request);
    assert.ok(!JSON.stringify(r).includes("PLAYGROUND"), "the key never reaches the rebuilt call");
  });

  test("OpenAI chat: system and developer messages, tool calls by id, and the answer", async () => {
    const body = {
      model: "gpt-4.1-mini",
      max_completion_tokens: 300,
      messages: [
        { role: "system", content: "Be terse." },
        { role: "developer", content: [{ type: "text", text: "Use tools." }] },
        { role: "user", content: [{ type: "text", text: "what is 2+2?" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "calc", arguments: '{"expr":"2+2"}' } }] },
        { role: "tool", tool_call_id: "call_1", content: "4" },
      ],
      tools: [{ type: "function", function: { name: "calc", description: "Arithmetic", parameters: { type: "object", properties: { expr: { type: "string" } } } } }],
    };
    await call(t.proxy.url, { path: "/v1/chat/completions", body: JSON.stringify(body), headers: { "content-type": "application/json", authorization: "Bearer sk-stub" } });
    const r = await rebuildCall(t.index, t.blobs, await only("chat"));
    assert.equal(r.provider, "openai-compatible");
    assert.equal(r.request.system, "Be terse.\n\nUse tools.");
    assert.deepEqual(r.request.messages, [
      { role: "user", text: "what is 2+2?\n\n[image]" },
      { role: "assistant", toolCalls: [{ id: "call_1", name: "calc", input: { expr: "2+2" } }] },
      { role: "tool", toolUseId: "call_1", name: "calc", content: "4" },
    ]);
    assert.deepEqual(r.request.tools, [{ name: "calc", description: "Arithmetic", inputSchema: { type: "object", properties: { expr: { type: "string" } } } }]);
    assert.equal(r.request.maxTokens, 300);
    assert.equal(r.response?.text, "Done: 4.");
  });

  test("OpenAI Responses: instructions, function calls and their outputs", async () => {
    const body = {
      model: "gpt-5-codex",
      instructions: "You are Codex.",
      max_output_tokens: 500,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "list files" }] },
        { type: "reasoning", summary: [] },
        { type: "function_call", name: "exec_command", arguments: '{"cmd":"ls"}', call_id: "c1" },
        { type: "function_call_output", call_id: "c1", output: "a.txt\nb.txt" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "now count them" }] },
      ],
      tools: [{ type: "function", name: "exec_command", parameters: { type: "object", properties: { cmd: { type: "string" } } } }],
    };
    await call(t.proxy.url, { path: "/v1/responses", body: JSON.stringify(body), headers: { "content-type": "application/json", authorization: "Bearer sk-stub" } });
    const r = await rebuildCall(t.index, t.blobs, await only("responses"));
    assert.equal(r.provider, "openai");
    assert.equal(r.request.system, "You are Codex.");
    assert.deepEqual(r.request.messages, [
      { role: "user", text: "list files" },
      { role: "assistant", toolCalls: [{ id: "c1", name: "exec_command", input: { cmd: "ls" } }] },
      { role: "tool", toolUseId: "c1", name: "exec_command", content: "a.txt\nb.txt" },
      { role: "user", text: "now count them" },
    ]);
    assert.equal(r.request.maxTokens, 500);
    assert.equal(r.response?.toolCalls[0]?.name, "exec_command");
    assert.deepEqual(requestFromBody("responses", renderBody("openai", r.request)), r.request);
  });
});

test("a call with no stored request rebuilds from the session's events (real Claude Code capture)", async () => {
  // scripts/e2e/proxy-capture.mjs: the hook copies of each call carry no request.
  const events = readFileSync(new URL("../fixtures/proxy/claude-code-proxied.jsonl", import.meta.url), "utf8").trim().split("\n").map((l) => JSON.parse(l) as AgentEvent);
  const index = new MemoryIndexStore();
  await index.putEvents(events);
  const hooked = events.filter((e) => e.kind === "llm.call" && e.source !== "proxy");
  const last = hooked[hooked.length - 1]!;
  const r = await rebuildCall(index, new MemoryBlobStore(), last);
  assert.equal(r.source, "transcript");
  assert.equal(r.request.model, last.model);
  assert.equal(r.request.messages[0]?.role, "user");
  assert.deepEqual(validatePrefix({ v: 1, tools: r.request.tools, messages: r.request.messages }).messages, r.request.messages);
  // The first call comes before any prompt: nothing to rebuild.
  await assert.rejects(rebuildCall(index, new MemoryBlobStore(), hooked[0]!), (e: unknown) => e instanceof PlaygroundError && e.reason === "no_request");
});

const REQ: PlaygroundRequest = {
  model: "stub-coder-1",
  system: "Be terse.",
  messages: [
    { role: "user", text: "run the tests" },
    { role: "assistant", toolCalls: [{ id: "call_1", name: "Bash", input: { command: "npm test" } }] },
    { role: "tool", toolUseId: "call_1", name: "Bash", content: "1 failing", isError: true },
  ],
  tools: [{ name: "Bash", inputSchema: { type: "object", properties: { command: { type: "string" } } } }],
  maxTokens: 256,
  temperature: 0,
};

describe("run and save", () => {
  let stub: Awaited<ReturnType<typeof stubOpenAI>>;
  let dir: string;
  before(async () => {
    stub = await stubOpenAI(() => chatAnswer("Fixing it.", { name: "Bash", args: { command: "npm test -- --fix" } }));
    dir = mkdtempSync(join(tmpdir(), "csh-playground-"));
  });
  after(async () => {
    await stub?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("runs against a stub OpenAI-compatible server and parses text, tool calls and usage", async () => {
    const env = { OPENAI_BASE_URL: stub.url, OPENAI_API_KEY: "sk-stub-key" };
    const out = await runPlayground("openai-compatible", REQ, { env, prices: {} });
    assert.equal(out.text, "Fixing it.");
    assert.deepEqual(out.toolCalls, [{ id: "call_9", name: "Bash", input: { command: "npm test -- --fix" } }]);
    assert.equal(out.stopReason, "tool_calls");
    assert.deepEqual(out.usage, { inputTokens: 40, outputTokens: 7 });
    const sent = stub.bodies.at(-1);
    assert.equal(sent.path, "/v1/chat/completions");
    assert.equal(stub.headers.at(-1)!.authorization, "Bearer sk-stub-key");
    assert.deepEqual(sent.messages.map((m: any) => m.role), ["system", "user", "assistant", "tool"]);
    assert.equal(sent.max_tokens, 256);
    assert.equal(sent.temperature, 0);
    assert.equal(sent.tools[0].function.name, "Bash");
  });

  test("a local endpoint needs no key; a remote one without a key says which env var to set", async () => {
    await runPlayground("openai-compatible", REQ, { env: { OPENAI_BASE_URL: stub.url }, prices: {} });
    assert.equal(stub.headers.at(-1)!.authorization, undefined);
    await assert.rejects(runPlayground("anthropic", REQ, { env: {} }), (e: unknown) => e instanceof PlaygroundError && e.reason === "missing_api_key" && /ANTHROPIC_API_KEY/.test(e.message));
    await assert.rejects(runPlayground("gemini", REQ, { env: {} }), /provider must be one of/);
  });

  test("a provider error is a 502 PlaygroundError with no key in it", async () => {
    const fetch = async () => new Response(JSON.stringify({ error: { message: "bad key sk-stub-key" } }), { status: 401, headers: { "content-type": "application/json" } });
    await assert.rejects(runPlayground("openai-compatible", REQ, { env: { OPENAI_BASE_URL: "https://api.example.test/v1", OPENAI_API_KEY: "sk-stub-key" }, fetch }), (e: unknown) => {
      assert.ok(e instanceof PlaygroundError && e.status === 502);
      assert.doesNotMatch(e.message, /sk-stub-key/);
      return true;
    });
  });

  test("save adds a case to a new dataset version that a continuation task can read", async () => {
    const env = { HOME: dir, CODING_SH_HOME: join(dir, ".coding.sh") };
    const store = new FileEvalStore({ env });
    const a = await saveCase(store, { dataset: "Playground picks", request: REQ, expected: { text: "Fixing it." }, sessionId: "s1", callId: "e1" });
    assert.equal(a.datasetId, "playground-picks");
    assert.equal(a.cases, 1);
    const b = await saveCase(store, { dataset: "Playground picks", request: { ...REQ, messages: [{ role: "user", text: "say hi" }] } });
    assert.equal(b.cases, 2);
    assert.notEqual(a.version, b.version);
    const versions = await store.listDatasetVersions("playground-picks");
    assert.equal(versions.length, 2);
    const ds = (await store.getDataset("playground-picks"))!;
    const c = ds.cases.find((x) => x.id === a.caseId)!;
    assert.deepEqual(validatePrefix(c.input).messages, REQ.messages);
    assert.deepEqual(c.expected, { text: "Fixing it." });
    assert.deepEqual(c.metadata, { source: "playground", maxTokens: 256, system: "Be terse.", temperature: 0, callId: "e1" });
    assert.equal(c.sourceSessionId, "s1");
    assert.deepEqual(c.tags, ["playground"]);
    // The same case again changes nothing.
    const again = await saveCase(store, { dataset: "Playground picks", request: REQ, expected: { text: "Fixing it." }, sessionId: "s1", callId: "e1" });
    assert.equal(again.cases, 2);
    // Secrets typed into the request are redacted before they are stored.
    const s = await saveCase(store, { dataset: "Playground picks", request: { ...REQ, messages: [{ role: "user", text: `my key is ${KEY}` }] } });
    assert.ok(!JSON.stringify(await store.getDataset("playground-picks")).includes("PLAYGROUNDPLAYGROUND"), String(s.caseId));
  });

  test("parseRequest names the first problem", () => {
    const bad: [unknown, RegExp][] = [
      [null, /must be an object/],
      [{ ...REQ, model: "" }, /model is required/],
      [{ ...REQ, messages: [] }, /non-empty array/],
      [{ ...REQ, messages: [{ role: "user", text: "hi" }, { role: "assistant", text: "hello" }] }, /ends on an assistant message/],
      [{ ...REQ, messages: [{ role: "tool", toolUseId: "x", name: "Bash", content: "" }] }, /orphan tool result/],
      [{ ...REQ, maxTokens: 0 }, /maxTokens/],
      [{ ...REQ, temperature: 3 }, /temperature/],
      [{ ...REQ, tools: [{}] }, /tools must be objects with a name/],
      [{ ...REQ, system: 5 }, /system must be a string/],
    ];
    for (const [raw, re] of bad) assert.throws(() => parseRequest(raw), (e: unknown) => e instanceof PlaygroundError && re.test(e.message), JSON.stringify(raw)?.slice(0, 80));
    assert.deepEqual(parseRequest({ model: "m", messages: [{ role: "user", text: "hi" }] }), { model: "m", system: "", messages: [{ role: "user", text: "hi" }], tools: [], maxTokens: 1024 });
  });
});

describe("/api/playground", () => {
  let stub: Awaited<ReturnType<typeof stubOpenAI>>;
  let up: Upstream;
  let t: TestProxy;
  let v: Viewer;
  let bare: Viewer;
  let dir: string;
  let callId: string;
  let sessionId: string;
  const req = async (viewer: Viewer, path: string, init: RequestInit = {}) => {
    const r = await fetch(`http://127.0.0.1:${viewer.port}${path}`, { ...init, headers: { authorization: `Bearer ${viewer.token}`, ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers as Record<string, string>) } });
    return { status: r.status, body: (await r.json()) as any };
  };

  before(async () => {
    stub = await stubOpenAI((b) => chatAnswer(`echo: ${b.messages.at(-1).content}`));
    up = await startUpstream((_r, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(chatAnswer("4")));
    });
    t = await startTestProxy(up.url);
    await call(t.proxy.url, { path: "/v1/chat/completions", body: JSON.stringify({ model: "gpt-4.1-mini", messages: [{ role: "system", content: "Be terse." }, { role: "user", content: "2+2?" }] }), headers: { "content-type": "application/json", authorization: "Bearer sk-stub" } });
    const e = (await t.events()).find((x) => x.kind === "llm.call")!;
    callId = e.id;
    sessionId = e.sessionId;
    dir = mkdtempSync(join(tmpdir(), "csh-playground-api-"));
    const env = { HOME: dir, CODING_SH_HOME: join(dir, ".coding.sh"), OPENAI_BASE_URL: stub.url };
    const playground = viewerPlayground({ env, datasets: new FileEvalStore({ env }), prices: {} });
    v = await startViewer({ index: t.index, blobs: t.blobs, port: 0, updateStatus: async () => ({ disabled: "test" }) as any, playground });
    bare = await startViewer({ index: t.index, blobs: t.blobs, port: 0, updateStatus: async () => ({ disabled: "test" }) as any });
  });
  after(async () => {
    await v?.close();
    await bare?.close();
    await t?.close();
    await up?.close();
    await stub?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("rebuild, edit, run against the stub, save: one round trip through the API", async () => {
    const home = await req(v, "/api/playground");
    assert.equal(home.status, 200);
    assert.deepEqual(home.body.providers.map((p: any) => [p.id, p.ready]), [["anthropic", false], ["openai", true], ["openai-compatible", true]]);
    assert.deepEqual(home.body.datasets, []);
    const r = await req(v, `/api/playground/calls/${callId}?session=${encodeURIComponent(sessionId)}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.request.system, "Be terse.");
    assert.equal(r.body.provider, "openai-compatible");
    const edited = { ...r.body.request, messages: [{ role: "user", text: "3+3?" }] };
    const run = await req(v, "/api/playground/run", { method: "POST", body: JSON.stringify({ provider: "openai-compatible", request: edited }) });
    assert.equal(run.status, 200, JSON.stringify(run.body));
    assert.equal(run.body.text, "echo: 3+3?");
    assert.ok(run.body.latencyMs >= 0);
    const save = await req(v, "/api/playground/save", { method: "POST", body: JSON.stringify({ dataset: "arith", request: edited, expected: { text: run.body.text }, sessionId, callId }) });
    assert.equal(save.status, 200, JSON.stringify(save.body));
    assert.equal(save.body.datasetId, "arith");
    assert.equal(save.body.cases, 1);
    const after = await req(v, "/api/playground");
    assert.deepEqual(after.body.datasets.map((d: any) => [d.id, d.cases, d.latest]), [["arith", 1, save.body.version]]);
    // Without a session the call id alone (or a prefix of it) finds the call.
    assert.equal((await req(v, `/api/playground/calls/${callId.slice(0, 12)}`)).status, 200);
  });

  test("bad input is a 400 with a reason; unknown calls 404; only the local viewer has it", async () => {
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) => req(v, path, { method: "POST", body: JSON.stringify(body), headers });
    const cases: [string, unknown, number, RegExp][] = [
      ["/api/playground/run", { request: REQ }, 400, /provider is required/],
      ["/api/playground/run", { provider: "openai-compatible", request: { ...REQ, messages: [] } }, 400, /non-empty array/],
      ["/api/playground/run", { provider: "anthropic", request: REQ }, 400, /ANTHROPIC_API_KEY/],
      ["/api/playground/save", { request: REQ }, 400, /dataset is required/],
      ["/api/playground/save", { dataset: "!!!", request: REQ }, 400, /letter or digit/],
    ];
    for (const [path, body, status, re] of cases) {
      const r = await post(path, body);
      assert.equal(r.status, status, `${path} ${JSON.stringify(body).slice(0, 60)}`);
      assert.match(r.body.error, re);
    }
    assert.equal((await req(v, "/api/playground/run")).status, 405);
    assert.equal((await req(v, "/api/playground/calls/ffffffffffff")).status, 404);
    assert.equal((await req(v, "/api/playground/nope", { method: "POST", body: "{}" })).status, 404);
    assert.equal((await post("/api/playground/run", { provider: "openai-compatible", request: REQ }, { origin: "https://evil.example" })).status, 403);
    const text = await fetch(`http://127.0.0.1:${v.port}/api/playground/run`, { method: "POST", body: "{}", headers: { authorization: `Bearer ${v.token}`, "content-type": "text/plain" } });
    assert.equal(text.status, 415);
    const r = await req(bare, "/api/playground");
    assert.equal(r.status, 404);
    assert.match(r.body.error, /only in the local viewer/);
  });
});
