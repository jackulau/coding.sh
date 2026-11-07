#!/usr/bin/env node
// Shared mock LLM for the production journeys (docs/PRODUCTION.md §6/§7).
//
//   node examples/production/mock-llm/server.mjs [--port 9999] [--host 127.0.0.1]
//
// Serves OpenAI POST /v1/chat/completions (plain, and streaming with the usage
// chunk when stream_options.include_usage is set) and Anthropic POST /v1/messages
// (plain and streaming). Every answer is "pong" with usage of exactly 1000 input
// and 500 output tokens, no cache, and echoes the requested model, so journey
// costs are exact under the pinned prices in deploy/compose/config.toml.
// GET /healthz answers {"ok":true}. Zero dependencies; stops on SIGTERM/SIGINT.
// Port 0 picks a free port; the listening URL is printed on stdout.
import { createServer } from "node:http";

const INPUT_TOKENS = 1000;
const OUTPUT_TOKENS = 500;
const TEXT = "pong";

function arg(name, fallback) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1] !== undefined) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : fallback;
}

const port = Number(arg("--port", process.env.MOCK_LLM_PORT ?? "9999"));
const host = arg("--host", process.env.MOCK_LLM_HOST ?? "127.0.0.1");
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`mock-llm: invalid --port ${port}`);
  process.exit(2);
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return undefined;
  }
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function sse(res, events) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  for (const e of events) res.write(`${e.event ? `event: ${e.event}\n` : ""}data: ${typeof e.data === "string" ? e.data : JSON.stringify(e.data)}\n\n`);
  res.end();
}

const openaiUsage = () => ({
  prompt_tokens: INPUT_TOKENS,
  completion_tokens: OUTPUT_TOKENS,
  total_tokens: INPUT_TOKENS + OUTPUT_TOKENS,
  prompt_tokens_details: { cached_tokens: 0 },
  completion_tokens_details: { reasoning_tokens: 0 },
});

function chatCompletions(res, body, model) {
  const id = "chatcmpl-mock";
  const created = Math.floor(Date.now() / 1000);
  const base = { id, created, model, system_fingerprint: "mock" };
  if (body.stream !== true) {
    return json(res, 200, {
      ...base,
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: TEXT, refusal: null }, logprobs: null, finish_reason: "stop" }],
      usage: openaiUsage(),
    });
  }
  const chunk = (choices, extra = {}) => ({ data: { ...base, object: "chat.completion.chunk", choices, ...extra } });
  const events = [
    chunk([{ index: 0, delta: { role: "assistant", content: "" }, logprobs: null, finish_reason: null }]),
    chunk([{ index: 0, delta: { content: TEXT }, logprobs: null, finish_reason: null }]),
    chunk([{ index: 0, delta: {}, logprobs: null, finish_reason: "stop" }]),
  ];
  // OpenAI sends usage only when asked, as a final chunk with empty choices.
  if (body.stream_options && body.stream_options.include_usage === true) events.push(chunk([], { usage: openaiUsage() }));
  events.push({ data: "[DONE]" });
  sse(res, events);
}

const anthropicUsage = (output) => ({
  input_tokens: INPUT_TOKENS,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: output,
});

function messages(res, body, model) {
  const id = "msg_mock";
  if (body.stream !== true) {
    return json(res, 200, {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text: TEXT }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: anthropicUsage(OUTPUT_TOKENS),
    });
  }
  const ev = (type, data) => ({ event: type, data: { type, ...data } });
  sse(res, [
    ev("message_start", { message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: anthropicUsage(0) } }),
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: TEXT } }),
    ev("content_block_stop", { index: 0 }),
    ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: OUTPUT_TOKENS } }),
    ev("message_stop", {}),
  ]);
}

const server = createServer(async (req, res) => {
  try {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && (path === "/healthz" || path === "/")) return json(res, 200, { ok: true });
    const route = path === "/v1/chat/completions" || path === "/chat/completions" ? "openai" : path === "/v1/messages" || path === "/messages" ? "anthropic" : undefined;
    if (!route) return json(res, 404, { error: { type: "not_found", message: `mock-llm: no route ${req.method} ${path}` } });
    if (req.method !== "POST") return json(res, 405, { error: { type: "method_not_allowed", message: "POST only" } });
    const body = await readJson(req);
    if (body === undefined) return json(res, 400, { error: { type: "invalid_request_error", message: "body is not JSON" } });
    const model = typeof body.model === "string" && body.model ? body.model : "mock";
    if (route === "openai") return chatCompletions(res, body, model);
    return messages(res, body, model);
  } catch (err) {
    if (!res.headersSent) json(res, 500, { error: { type: "server_error", message: String(err?.message ?? err) } });
    else res.destroy();
  }
});

server.on("error", (err) => {
  console.error(`mock-llm: ${err.message}`);
  process.exit(1);
});
server.listen(port, host, () => {
  const addr = server.address();
  console.log(`mock-llm listening on http://${host.includes(":") ? `[${host}]` : host}:${addr.port}`);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections?.();
  });
}
