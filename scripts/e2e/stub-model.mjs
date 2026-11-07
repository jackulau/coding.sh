// A stub model server for end-to-end capture runs: speaks OpenAI chat/completions,
// OpenAI responses and Anthropic messages, streaming or not.
//
// First request that offers tools -> one tool call that writes hello.txt (the
// request's `write`-like tool, else a shell tool). Once a tool result is in the
// conversation, or no tools are offered -> STUB_TEXT. Aider (no tools, whole-file
// edit format) -> STUB_TEXT plus a listing of hello.txt.
//
//   node scripts/e2e/stub-model.mjs            # listens on PORT (default 8787)
//   import { startStub } from "./stub-model.mjs"; const s = await startStub(); s.url
//   startStub({ decide: (body) => ({ tool: { name, args } }) | ({ text }) | undefined })  # a scenario; undefined falls back
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

export const MODEL = "stub-model";
export const TEXT = "Done. I wrote hello.txt.";
const CONTENT = "hello from stub\n";
const usage = { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 };

let n = 0;
const id = (p) => `${p}_${Date.now().toString(36)}${(n++).toString(36)}`;

export const toolNames = (body) => (body.tools || []).map((x) => x.name || x.function?.name).filter(Boolean);

function pickTool(names) {
  const prefs = [
    ["write", { filePath: "hello.txt", file_path: "hello.txt", path: "hello.txt", content: CONTENT }],
    ["Write", { file_path: "hello.txt", content: CONTENT }],
    ["Create", { file_path: "hello.txt", content: CONTENT }],
    ["create", { path: "hello.txt", file_text: CONTENT }],
  ];
  for (const [name, args] of prefs) if (names.includes(name)) return { name, args };
  const sh = names.find((x) => /shell|bash/i.test(x));
  return sh ? { name: sh, args: { command: "echo hello from stub > hello.txt", description: "write file" } } : undefined;
}

function hasToolResult(body) {
  const msgs = body.messages || [];
  if (msgs.some((m) => m.role === "tool")) return true;
  if (msgs.some((m) => Array.isArray(m.content) && m.content.some((c) => c?.type === "tool_result"))) return true;
  return (Array.isArray(body.input) ? body.input : []).some((i) => i?.type === "function_call_output");
}

/** Aider offers no tools: it edits from a reply in its edit format (whole: the file name, then a fenced listing). */
function aiderWhole(body) {
  const text = (body.messages || []).map((m) => (typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((c) => c?.text ?? "").join("") : "")).join("\n");
  return /\*file listing\*/.test(text);
}

function decide(body) {
  const names = toolNames(body);
  if (!names.length && aiderWhole(body)) return { text: `${TEXT}\n\nhello.txt\n\`\`\`\n${CONTENT}\`\`\`\n` };
  if (!names.length || hasToolResult(body)) return { text: TEXT };
  const tool = pickTool(names);
  return tool ? { tool } : { text: TEXT };
}

function json(res, o) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(o));
}

function sse(res, chunks, named) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  for (const c of chunks) res.write(named ? `event: ${c.type}\ndata: ${JSON.stringify(c)}\n\n` : `data: ${JSON.stringify(c)}\n\n`);
  if (!named) res.write("data: [DONE]\n\n");
  res.end();
}

function chat(body, res, d) {
  const base = { id: id("chatcmpl"), created: Math.floor(Date.now() / 1000), model: MODEL };
  const callId = id("call");
  if (!body.stream) {
    const message = d.tool
      ? { role: "assistant", content: null, tool_calls: [{ id: callId, type: "function", function: { name: d.tool.name, arguments: JSON.stringify(d.tool.args) } }] }
      : { role: "assistant", content: d.text };
    return json(res, { ...base, object: "chat.completion", choices: [{ index: 0, message, finish_reason: d.tool ? "tool_calls" : "stop" }], usage });
  }
  const chunk = (delta, finish_reason = null) => ({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] });
  const chunks = [chunk({ role: "assistant", content: "" })];
  if (d.tool) {
    chunks.push(chunk({ tool_calls: [{ index: 0, id: callId, type: "function", function: { name: d.tool.name, arguments: "" } }] }));
    chunks.push(chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(d.tool.args) } }] }));
    chunks.push(chunk({}, "tool_calls"));
  } else {
    chunks.push(chunk({ content: d.text }));
    chunks.push(chunk({}, "stop"));
  }
  chunks.push({ ...base, object: "chat.completion.chunk", choices: [], usage });
  sse(res, chunks, false);
}

function anthropic(body, res, d) {
  const mid = id("msg");
  const toolId = id("toolu");
  const model = body.model || MODEL;
  const content = d.tool ? [{ type: "tool_use", id: toolId, name: d.tool.name, input: d.tool.args }] : [{ type: "text", text: d.text }];
  const stop = d.tool ? "tool_use" : "end_turn";
  if (!body.stream) return json(res, { id: mid, type: "message", role: "assistant", model, content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 120, output_tokens: 30 } });
  const ev = [{ type: "message_start", message: { id: mid, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 120, output_tokens: 1 } } }];
  if (d.tool) {
    ev.push({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: toolId, name: d.tool.name, input: {} } });
    ev.push({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(d.tool.args) } });
  } else {
    ev.push({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    ev.push({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: d.text } });
  }
  ev.push({ type: "content_block_stop", index: 0 });
  ev.push({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 30 } });
  ev.push({ type: "message_stop" });
  sse(res, ev, true);
}

function responses(body, res, d) {
  const item = d.tool
    ? { type: "function_call", id: id("fc"), call_id: id("call"), name: d.tool.name, arguments: JSON.stringify(d.tool.args), status: "completed" }
    : { type: "message", id: id("msg"), role: "assistant", status: "completed", content: [{ type: "output_text", text: d.text, annotations: [] }] };
  const u = { input_tokens: 120, output_tokens: 30, total_tokens: 150, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
  const resp = { id: id("resp"), object: "response", created_at: Math.floor(Date.now() / 1000), model: body.model || MODEL, status: "completed", output: [item], usage: u };
  if (!body.stream) return json(res, resp);
  const ev = [
    { type: "response.created", response: { ...resp, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress" } },
  ];
  if (!d.tool) ev.push({ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: d.text });
  ev.push({ type: "response.output_item.done", output_index: 0, item });
  ev.push({ type: "response.completed", response: resp });
  sse(res, ev, true);
}

/** Starts the stub on 127.0.0.1 (port 0 = any free port). `requests` logs what each call asked for. */
export function startStub({ port = 0, decide: custom } = {}) {
  const pick = (body) => (custom && custom(body)) || decide(body);
  const requests = [];
  const server = createServer((req, res) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      let body = {};
      try {
        body = buf ? JSON.parse(buf) : {};
      } catch {}
      const url = req.url.split("?")[0];
      requests.push({ method: req.method, url, model: body.model, tools: toolNames(body).length, toolResult: hasToolResult(body) });
      if (req.method === "GET" && /models$/.test(url)) return json(res, { object: "list", data: [{ id: MODEL, object: "model", owned_by: "stub" }] });
      if (/chat\/completions$/.test(url)) return chat(body, res, pick(body));
      if (/messages$/.test(url)) return anthropic(body, res, pick(body));
      if (/responses$/.test(url)) return responses(body, res, pick(body));
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `stub: no route ${url}` } }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${server.address().port}`;
      resolve({ url, requests, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const s = await startStub({ port: Number(process.env.PORT || 8787) });
  console.log(`stub model on ${s.url}`);
}
