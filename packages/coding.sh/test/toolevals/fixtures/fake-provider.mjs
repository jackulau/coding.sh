// Fake model provider: streams SSE for Anthropic Messages (/v1/messages),
// OpenAI Responses (/responses) and Chat Completions (/chat/completions).
// Replies come from a script: each entry is one model call,
// { text?, toolCalls?: [{ name, input }], usage?: { input, output }, status?, delayMs? }.
// When the script runs out, the last entry repeats. A function script picks
// the reply from the request body, which keeps concurrent trials independent.
import { createServer } from "node:http";

const sse = (res, events) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const [event, data] of events) res.write(`${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
  res.end();
};

function anthropic(res, turn, n, model) {
  const u = turn.usage ?? { input: 100, output: 20 };
  const ev = [["message_start", { type: "message_start", message: { id: `msg_${n}`, model, usage: { input_tokens: u.input, output_tokens: 1, cache_read_input_tokens: u.cacheRead ?? 0 } } }]];
  let i = 0;
  if (turn.text) {
    ev.push(["content_block_start", { type: "content_block_start", index: i, content_block: { type: "text", text: "" } }]);
    for (const piece of turn.text.match(/.{1,8}/gs) ?? []) ev.push(["content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: piece } }]);
    ev.push(["content_block_stop", { type: "content_block_stop", index: i }]);
    i++;
  }
  for (const [k, tc] of (turn.toolCalls ?? []).entries()) {
    ev.push(["content_block_start", { type: "content_block_start", index: i, content_block: { type: "tool_use", id: `toolu_${n}_${k}`, name: tc.name, input: {} } }]);
    const json = JSON.stringify(tc.input ?? {});
    ev.push(["content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: json.slice(0, 5) } }]);
    ev.push(["content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: json.slice(5) } }]);
    ev.push(["content_block_stop", { type: "content_block_stop", index: i }]);
    i++;
  }
  ev.push(["message_delta", { type: "message_delta", delta: { stop_reason: turn.toolCalls?.length ? "tool_use" : "end_turn" }, usage: { output_tokens: u.output } }]);
  ev.push(["message_stop", { type: "message_stop" }]);
  sse(res, ev);
}

function responses(res, turn, n, model) {
  const u = turn.usage ?? { input: 100, output: 20 };
  const output = [];
  const ev = [[null, { type: "response.created", response: { id: `resp_${n}`, model } }]];
  if (turn.text) {
    for (const piece of turn.text.match(/.{1,8}/gs) ?? []) ev.push([null, { type: "response.output_text.delta", delta: piece }]);
    output.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: turn.text }] });
  }
  for (const [k, tc] of (turn.toolCalls ?? []).entries()) {
    const item = { type: "function_call", id: `fc_${n}_${k}`, call_id: `call_${n}_${k}`, name: tc.name, arguments: JSON.stringify(tc.input ?? {}) };
    ev.push([null, { type: "response.function_call_arguments.delta", delta: item.arguments }]);
    ev.push([null, { type: "response.output_item.done", item }]);
    output.push(item);
  }
  ev.push([null, { type: "response.completed", response: { id: `resp_${n}`, model, output, usage: { input_tokens: u.input, output_tokens: u.output, input_tokens_details: { cached_tokens: u.cacheRead ?? 0 } } } }]);
  sse(res, ev);
}

function chat(res, turn, n, model) {
  const u = turn.usage ?? { input: 100, output: 20 };
  const ev = [];
  const chunk = (delta, finish = null) => [null, { id: `chat_${n}`, model, choices: [{ index: 0, delta, finish_reason: finish }] }];
  ev.push(chunk({ role: "assistant" }));
  if (turn.text) for (const piece of turn.text.match(/.{1,8}/gs) ?? []) ev.push(chunk({ content: piece }));
  for (const [k, tc] of (turn.toolCalls ?? []).entries()) {
    const args = JSON.stringify(tc.input ?? {});
    ev.push(chunk({ tool_calls: [{ index: k, id: `call_${n}_${k}`, type: "function", function: { name: tc.name, arguments: args.slice(0, 4) } }] }));
    ev.push(chunk({ tool_calls: [{ index: k, function: { arguments: args.slice(4) } }] }));
  }
  ev.push(chunk({}, turn.toolCalls?.length ? "tool_calls" : "stop"));
  ev.push([null, { id: `chat_${n}`, model, choices: [], usage: { prompt_tokens: u.input, completion_tokens: u.output } }]);
  ev.push([null, "[DONE]"]);
  sse(res, ev);
}

/** Starts the provider on 127.0.0.1. Returns { url, requests, close }. */
export async function startFakeProvider(script, { model = "fake-model" } = {}) {
  const requests = [];
  let n = 0;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {}
    requests.push({ path: req.url, headers: req.headers, body });
    const turn = (typeof script === "function" ? script(body, n) : script[Math.min(n, script.length - 1)]) ?? { text: "done" };
    n++;
    if (turn.delayMs) await new Promise((r) => setTimeout(r, turn.delayMs));
    if (turn.status && turn.status >= 400) {
      res.writeHead(turn.status, { "content-type": "application/json", ...(turn.retryAfter ? { "retry-after": String(turn.retryAfter) } : {}) });
      res.end(JSON.stringify({ error: { type: "error", message: turn.message ?? `status ${turn.status}` } }));
      return;
    }
    const m = body.model ?? model;
    if (req.url?.endsWith("/v1/messages")) anthropic(res, turn, n, m);
    else if (req.url?.endsWith("/responses")) responses(res, turn, n, m);
    else if (req.url?.endsWith("/chat/completions")) chat(res, turn, n, m);
    else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const script = JSON.parse(process.argv[2] ?? '[{"text":"hello"}]');
  const p = await startFakeProvider(script);
  process.stdout.write(`${p.url}\n`);
}
