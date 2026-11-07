// Anthropic Messages API, streamed, with no SDK (§11). TTFT is the first
// content_block_delta: text → ttftMs, thinking → ttfThinkingMs.
import type { Usage } from "../../schema/index.ts";
import { readSse } from "./sse.ts";
import { ProviderHttpError, type Conversation, type ConversationInit, type ModelTurn, type ToolCall, type ToolResult } from "./types.ts";

type Block = { type: string; [k: string]: unknown };

export function anthropicConversation(init: ConversationInit): Conversation {
  const messages: { role: "user" | "assistant"; content: unknown }[] = [{ role: "user", content: init.instruction }];
  const url = `${(init.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "")}/v1/messages`;
  return {
    async call(signal) {
      const body: Record<string, unknown> = {
        model: init.model,
        max_tokens: init.maxOutputTokens ?? 4096,
        system: init.system,
        messages,
        stream: true,
      };
      if (init.tools.length) body.tools = init.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
      if (init.temperature !== undefined) body.temperature = init.temperature;
      const t0 = performance.now();
      const res = await init.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": init.apiKey, "anthropic-version": "2023-06-01", accept: "text/event-stream" },
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) throw new ProviderHttpError(res.status, await res.text(), res.headers.get("retry-after"));
      const blocks: Block[] = [];
      const partialJson = new Map<number, string>();
      const usage: Usage = {};
      const turn: ModelTurn = { text: "", toolCalls: [], usage, raw: blocks };
      for await (const ev of readSse(res.body)) {
        if (!ev.data || ev.data === "[DONE]") continue;
        let d: Record<string, unknown>;
        try {
          d = JSON.parse(ev.data) as Record<string, unknown>;
        } catch {
          continue;
        }
        const type = String(d.type ?? ev.event ?? "");
        if (type === "message_start") {
          const m = (d.message ?? {}) as Record<string, unknown>;
          if (typeof m.model === "string") turn.responseModel = m.model;
          const u = (m.usage ?? {}) as Record<string, number>;
          if (typeof u.input_tokens === "number") usage.inputTokens = u.input_tokens;
          if (typeof u.output_tokens === "number") usage.outputTokens = u.output_tokens;
          if (typeof u.cache_read_input_tokens === "number") usage.cacheReadTokens = u.cache_read_input_tokens;
          if (typeof u.cache_creation_input_tokens === "number") usage.cacheWriteTokens = u.cache_creation_input_tokens;
        } else if (type === "content_block_start") {
          const i = Number(d.index ?? blocks.length);
          const cb = { ...((d.content_block ?? {}) as Block) };
          if (cb.type === "tool_use") partialJson.set(i, "");
          blocks[i] = cb;
        } else if (type === "content_block_delta") {
          const i = Number(d.index ?? 0);
          const delta = (d.delta ?? {}) as Record<string, unknown>;
          const b = (blocks[i] ??= { type: "text", text: "" });
          if (delta.type === "text_delta") {
            turn.ttftMs ??= performance.now() - t0;
            b.text = String(b.text ?? "") + String(delta.text ?? "");
          } else if (delta.type === "thinking_delta") {
            turn.ttfThinkingMs ??= performance.now() - t0;
            b.thinking = String(b.thinking ?? "") + String(delta.thinking ?? "");
          } else if (delta.type === "signature_delta") {
            b.signature = String(b.signature ?? "") + String(delta.signature ?? "");
          } else if (delta.type === "input_json_delta") {
            turn.ttftMs ??= performance.now() - t0;
            partialJson.set(i, (partialJson.get(i) ?? "") + String(delta.partial_json ?? ""));
          }
        } else if (type === "content_block_stop") {
          const i = Number(d.index ?? 0);
          const b = blocks[i];
          if (b?.type === "tool_use") {
            const raw = partialJson.get(i) ?? "";
            try {
              b.input = raw ? JSON.parse(raw) : (b.input ?? {});
            } catch {
              b.input = {};
            }
          }
        } else if (type === "message_delta") {
          const delta = (d.delta ?? {}) as Record<string, unknown>;
          if (typeof delta.stop_reason === "string") turn.stopReason = delta.stop_reason;
          const u = (d.usage ?? {}) as Record<string, number>;
          if (typeof u.output_tokens === "number") usage.outputTokens = u.output_tokens;
          if (typeof u.input_tokens === "number") usage.inputTokens = u.input_tokens;
        } else if (type === "error") {
          const err = (d.error ?? {}) as Record<string, unknown>;
          throw new ProviderHttpError(err.type === "overloaded_error" ? 529 : 500, String(err.message ?? ev.data));
        }
      }
      for (const b of blocks) {
        if (!b) continue;
        if (b.type === "text") turn.text += String(b.text ?? "");
        else if (b.type === "tool_use") turn.toolCalls.push({ id: String(b.id), name: String(b.name), input: b.input ?? {} } satisfies ToolCall);
      }
      return turn;
    },
    pushToolResults(turn: ModelTurn, results: ToolResult[]) {
      messages.push({ role: "assistant", content: (turn.raw as Block[]).filter(Boolean) });
      messages.push({ role: "user", content: results.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.content, is_error: r.isError })) });
    },
  };
}
