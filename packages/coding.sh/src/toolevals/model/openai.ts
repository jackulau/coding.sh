// OpenAI Responses and Chat Completions (for local / OpenAI-compatible
// servers), streamed, with no SDK (§11). TTFT is the first delta event.
import type { Usage } from "../../schema/index.ts";
import { readSse } from "./sse.ts";
import { ProviderHttpError, type Conversation, type ConversationInit, type ModelTurn, type ToolResult } from "./types.ts";

// With no baseUrl on the driver, OPENAI_BASE_URL (when set) replaces the default endpoint.
const base = (init: ConversationInit) => (init.baseUrl ?? (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1")).replace(/\/$/, "");

async function post(init: ConversationInit, path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  const res = await init.fetch(`${base(init)}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${init.apiKey}`, accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new ProviderHttpError(res.status, await res.text(), res.headers.get("retry-after"));
  return res;
}

function parseArgs(s: string): unknown {
  try {
    return s ? (JSON.parse(s) as unknown) : {};
  } catch {
    return { _raw: s };
  }
}

// ------------------------------------------------------------ Responses

export function openaiResponsesConversation(init: ConversationInit): Conversation {
  const input: unknown[] = [{ role: "user", content: init.instruction }];
  return {
    async call(signal) {
      const body: Record<string, unknown> = { model: init.model, instructions: init.system, input, stream: true };
      if (init.tools.length) body.tools = init.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.inputSchema, strict: false }));
      if (init.maxOutputTokens !== undefined) body.max_output_tokens = init.maxOutputTokens;
      if (init.temperature !== undefined) body.temperature = init.temperature;
      const t0 = performance.now();
      const res = await post(init, "/responses", body, signal);
      const usage: Usage = {};
      const turn: ModelTurn = { text: "", toolCalls: [], usage, raw: [] };
      let output: Record<string, unknown>[] = [];
      for await (const ev of readSse(res.body)) {
        if (!ev.data || ev.data === "[DONE]") continue;
        let d: Record<string, unknown>;
        try {
          d = JSON.parse(ev.data) as Record<string, unknown>;
        } catch {
          continue;
        }
        const type = String(d.type ?? ev.event ?? "");
        if (type.endsWith(".delta")) turn.ttftMs ??= performance.now() - t0;
        if (type === "response.output_text.delta") turn.text += String(d.delta ?? "");
        else if (type === "response.output_item.done") output.push(d.item as Record<string, unknown>);
        else if (type === "response.completed" || type === "response.incomplete") {
          const r = (d.response ?? {}) as Record<string, unknown>;
          if (typeof r.model === "string") turn.responseModel = r.model;
          if (Array.isArray(r.output) && r.output.length) output = r.output as Record<string, unknown>[];
          const u = (r.usage ?? {}) as Record<string, unknown>;
          const inTok = typeof u.input_tokens === "number" ? u.input_tokens : undefined;
          const cached = typeof (u.input_tokens_details as Record<string, unknown> | undefined)?.cached_tokens === "number" ? ((u.input_tokens_details as Record<string, number>).cached_tokens as number) : 0;
          if (inTok !== undefined) usage.inputTokens = inTok - cached;
          if (cached) usage.cacheReadTokens = cached;
          if (typeof u.output_tokens === "number") usage.outputTokens = u.output_tokens;
          turn.stopReason = type === "response.incomplete" ? "incomplete" : "completed";
        } else if (type === "response.failed" || type === "error") {
          throw new ProviderHttpError(500, ev.data);
        }
      }
      turn.raw = output;
      const text: string[] = [];
      for (const item of output) {
        if (item.type === "function_call") turn.toolCalls.push({ id: String(item.call_id ?? item.id), name: String(item.name), input: parseArgs(String(item.arguments ?? "")) });
        else if (item.type === "message" && Array.isArray(item.content)) {
          for (const c of item.content as Record<string, unknown>[]) if (c.type === "output_text") text.push(String(c.text ?? ""));
        }
      }
      if (text.length) turn.text = text.join("");
      if (turn.toolCalls.length) turn.stopReason = "tool_use";
      return turn;
    },
    pushToolResults(turn: ModelTurn, results: ToolResult[]) {
      input.push(...(turn.raw as unknown[]));
      for (const r of results) input.push({ type: "function_call_output", call_id: r.id, output: r.content });
    },
  };
}

// ------------------------------------------------------------ Chat Completions

export function openaiChatConversation(init: ConversationInit): Conversation {
  const messages: unknown[] = [
    { role: "system", content: init.system },
    { role: "user", content: init.instruction },
  ];
  return {
    async call(signal) {
      const body: Record<string, unknown> = { model: init.model, messages, stream: true, stream_options: { include_usage: true } };
      if (init.tools.length) body.tools = init.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
      if (init.maxOutputTokens !== undefined) body.max_tokens = init.maxOutputTokens;
      if (init.temperature !== undefined) body.temperature = init.temperature;
      const t0 = performance.now();
      const res = await post(init, "/chat/completions", body, signal);
      const usage: Usage = {};
      const turn: ModelTurn = { text: "", toolCalls: [], usage, raw: undefined };
      const calls = new Map<number, { id: string; name: string; args: string }>();
      for await (const ev of readSse(res.body)) {
        if (!ev.data || ev.data === "[DONE]") continue;
        let d: Record<string, unknown>;
        try {
          d = JSON.parse(ev.data) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (typeof d.model === "string") turn.responseModel = d.model;
        const u = d.usage as Record<string, unknown> | null | undefined;
        if (u) {
          const cached = typeof (u.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens === "number" ? ((u.prompt_tokens_details as Record<string, number>).cached_tokens as number) : 0;
          if (typeof u.prompt_tokens === "number") usage.inputTokens = u.prompt_tokens - cached;
          if (cached) usage.cacheReadTokens = cached;
          if (typeof u.completion_tokens === "number") usage.outputTokens = u.completion_tokens;
        }
        const choice = (Array.isArray(d.choices) ? d.choices[0] : undefined) as Record<string, unknown> | undefined;
        if (!choice) continue;
        const delta = (choice.delta ?? {}) as Record<string, unknown>;
        if ((typeof delta.content === "string" && delta.content) || Array.isArray(delta.tool_calls)) turn.ttftMs ??= performance.now() - t0;
        if (typeof delta.content === "string") turn.text += delta.content;
        for (const tc of (Array.isArray(delta.tool_calls) ? delta.tool_calls : []) as Record<string, unknown>[]) {
          const idx = Number(tc.index ?? 0);
          const fn = (tc.function ?? {}) as Record<string, unknown>;
          const cur = calls.get(idx) ?? { id: "", name: "", args: "" };
          if (typeof tc.id === "string") cur.id = tc.id;
          if (typeof fn.name === "string") cur.name += fn.name;
          if (typeof fn.arguments === "string") cur.args += fn.arguments;
          calls.set(idx, cur);
        }
        if (typeof choice.finish_reason === "string") turn.stopReason = choice.finish_reason;
      }
      const ordered = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
      turn.toolCalls = ordered.map((c, i) => ({ id: c.id || `call_${i}`, name: c.name, input: parseArgs(c.args) }));
      turn.raw = {
        role: "assistant",
        content: turn.text || null,
        ...(ordered.length ? { tool_calls: turn.toolCalls.map((c, i) => ({ id: c.id, type: "function", function: { name: c.name, arguments: ordered[i]!.args || "{}" } })) } : {}),
      };
      return turn;
    },
    pushToolResults(turn: ModelTurn, results: ToolResult[]) {
      messages.push(turn.raw);
      for (const r of results) messages.push({ role: "tool", tool_call_id: r.id, content: r.content });
    },
  };
}
