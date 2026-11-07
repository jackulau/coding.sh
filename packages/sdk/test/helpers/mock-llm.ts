// Mock LLM HTTP server for SDK tests: OpenAI chat completions + responses and
// Anthropic messages, plain and streaming. It always answers "pong" with usage
// of 1000 input / 500 output tokens and echoes the requested model, like the
// shared fixture examples/production/mock-llm/server.mjs (docs/PRODUCTION.md §6).
// A model starting with "fail" gets a 500; "tool" gets a tool call.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockLlm {
  url: string;
  requests: { path: string; body: Record<string, unknown> }[];
  /** Sent on every response, e.g. a gateway's request id header. */
  headers: Record<string, string>;
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return {};
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function sse(res: ServerResponse, events: { event?: string; data: unknown }[], delayMs: number): Promise<void> {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const e of events) {
    await sleep(delayMs);
    res.write(`${e.event ? `event: ${e.event}\n` : ""}data: ${typeof e.data === "string" ? e.data : JSON.stringify(e.data)}\n\n`);
  }
  res.end();
}

export async function startMockLlm(opts: { delayMs?: number } = {}): Promise<MockLlm> {
  const delay = opts.delayMs ?? 5;
  const requests: MockLlm["requests"] = [];
  const state = { headers: {} as Record<string, string> };
  // A fresh response id per call, as real APIs give: the server counts a repeated id as one call.
  let seq = 0;
  const server = createServer(async (req, res) => {
    const path = (req.url ?? "").split("?")[0]!;
    const body = await readJson(req);
    requests.push({ path, body });
    for (const [k, v] of Object.entries(state.headers)) res.setHeader(k, v);
    const model = typeof body.model === "string" ? body.model : "mock";
    if (model.startsWith("fail")) {
      return json(res, 500, path.endsWith("/messages") ? { type: "error", error: { type: "api_error", message: "mock failure" } } : { error: { message: "mock failure", type: "server_error" } });
    }
    const tool = model.startsWith("tool");
    await sleep(delay);

    if (path === "/v1/chat/completions") {
      const usage = { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500, prompt_tokens_details: { cached_tokens: 0 } };
      const id = `chatcmpl-mock-${++seq}`;
      const created = 1_700_000_000;
      if (body.stream !== true) {
        const message = tool
          ? { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup_order", arguments: '{"id":"42"}' } }] }
          : { role: "assistant", content: "pong", refusal: null };
        return json(res, 200, { id, object: "chat.completion", created, model, choices: [{ index: 0, message, finish_reason: tool ? "tool_calls" : "stop", logprobs: null }], usage });
      }
      const chunk = (delta: unknown, finish: string | null = null) => ({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }] });
      const events: { data: unknown }[] = [{ data: chunk({ role: "assistant", content: "" }) }];
      if (tool) {
        events.push({ data: chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup_order", arguments: "" } }] }) });
        events.push({ data: chunk({ tool_calls: [{ index: 0, function: { arguments: '{"id":"42"}' } }] }) });
        events.push({ data: chunk({}, "tool_calls") });
      } else {
        events.push({ data: chunk({ content: "po" }) }, { data: chunk({ content: "ng" }) }, { data: chunk({}, "stop") });
      }
      const so = body.stream_options as Record<string, unknown> | undefined;
      if (so?.include_usage) events.push({ data: { id, object: "chat.completion.chunk", created, model, choices: [], usage } });
      events.push({ data: "[DONE]" });
      return sse(res, events, delay);
    }

    if (path === "/v1/responses") {
      const response = {
        id: `resp_mock_${++seq}`,
        object: "response",
        created_at: 1_700_000_000,
        model,
        status: "completed",
        output: [{ type: "message", id: "msg_mock", role: "assistant", status: "completed", content: [{ type: "output_text", text: "pong", annotations: [] }] }],
        usage: { input_tokens: 1000, output_tokens: 500, total_tokens: 1500, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
        error: null,
        incomplete_details: null,
      };
      if (body.stream !== true) return json(res, 200, response);
      const created = { ...response, status: "in_progress", output: [], usage: null };
      return sse(
        res,
        [
          { event: "response.created", data: { type: "response.created", sequence_number: 0, response: created } },
          { event: "response.output_text.delta", data: { type: "response.output_text.delta", sequence_number: 1, item_id: "msg_mock", output_index: 0, content_index: 0, delta: "po" } },
          { event: "response.output_text.delta", data: { type: "response.output_text.delta", sequence_number: 2, item_id: "msg_mock", output_index: 0, content_index: 0, delta: "ng" } },
          { event: "response.completed", data: { type: "response.completed", sequence_number: 3, response } },
        ],
        delay,
      );
    }

    if (path === "/v1/messages") {
      const id = `msg_mock_${++seq}`;
      if (body.stream !== true) {
        const content = tool ? [{ type: "tool_use", id: "toolu_1", name: "lookup_order", input: { id: "42" } }] : [{ type: "text", text: "pong" }];
        return json(res, 200, { id, type: "message", role: "assistant", model, content, stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 500 } });
      }
      return sse(
        res,
        [
          { event: "message_start", data: { type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 1 } } } },
          { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
          { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "po" } } },
          { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ng" } } },
          { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
          { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 500 } } },
          { event: "message_stop", data: { type: "message_stop" } },
        ],
        delay,
      );
    }
    json(res, 404, { error: { message: `no route ${path}` } });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    get headers() {
      return state.headers;
    },
    set headers(h: Record<string, string>) {
      state.headers = h;
    },
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** `v` with this mock's per-call response ids made equal, to compare two calls' results. */
export const sameIds = (v: unknown): unknown => JSON.parse(JSON.stringify(v).replace(/(chatcmpl-mock-|resp_mock_|msg_mock_)\d+/g, "$1N"));
