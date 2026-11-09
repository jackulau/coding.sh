// The model driver's answers to MCP server → client requests (§10.3):
//   sampling/createMessage → the driver's own model, one call with no tools,
//                            logged as an llm.call with purpose "mcp-sampling"
//                            (its tokens and cost count; it is not an agent turn)
//   elicitation/create     → the task's scripted [mcp] elicitation answers
//                            (first `match` regex on the message wins; default decline)
//   roots/list             → the task's [mcp] roots, else the sandbox work dir
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { hashParts } from "../../core/ids.ts";
import type { AgentEvent } from "../../schema/index.ts";
import type { McpClientHandlers } from "../mcp/client.ts";
import type { Driver, TaskMcp } from "../types.ts";
import { anthropicConversation } from "./anthropic.ts";
import { MODEL_AGENT } from "./loop.ts";
import { openaiChatConversation, openaiResponsesConversation } from "./openai.ts";
import type { ConversationInit } from "./types.ts";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const SAMPLING_SYSTEM = "You are answering a request an MCP server made through the client. Reply with the answer only.";
const SAMPLING_MAX_TOKENS = 4096;

export interface McpHandlerOpts {
  driver: Extract<Driver, { kind: "model" }>;
  apiKey: string;
  fetch: typeof fetch;
  trialId: string;
  /** Sandbox work dir: the default root, and the base for relative ones. */
  work: string;
  mcp?: TaskMcp;
  emit: (e: AgentEvent) => void;
}

/** Text of sampling messages: one message as-is, more as `role: text` blocks. */
export function samplingText(messages: unknown): string {
  const list = Array.isArray(messages) ? messages.filter(isObj) : [];
  const text = (m: Record<string, unknown>) => {
    const parts = Array.isArray(m.content) ? m.content : [m.content];
    return parts.map((c) => (isObj(c) && c.type === "text" && typeof c.text === "string" ? c.text : isObj(c) ? `[${String(c.type)}]` : "")).join("\n");
  };
  if (list.length === 1) return text(list[0]!);
  return list.map((m) => `${String(m.role ?? "user")}: ${text(m)}`).join("\n\n");
}

/** The elicitation answer for a server message. */
export function elicitationAnswer(mcp: TaskMcp | undefined, message: string): { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> } {
  for (const a of mcp?.elicitation ?? []) {
    if (a.match !== undefined && !new RegExp(a.match, "i").test(message)) continue;
    return { action: a.action, ...(a.action === "accept" && a.content ? { content: a.content } : {}) };
  }
  return { action: "decline" };
}

export function mcpHandlers(o: McpHandlerOpts): McpClientHandlers {
  let seq = 0;
  return {
    async sampling(params) {
      const init: ConversationInit = {
        model: o.driver.model,
        system: typeof params.systemPrompt === "string" && params.systemPrompt ? params.systemPrompt : SAMPLING_SYSTEM,
        instruction: samplingText(params.messages),
        tools: [],
        apiKey: o.apiKey,
        ...(o.driver.baseUrl ? { baseUrl: o.driver.baseUrl } : {}),
        maxOutputTokens: typeof params.maxTokens === "number" && params.maxTokens > 0 ? Math.min(params.maxTokens, SAMPLING_MAX_TOKENS) : SAMPLING_MAX_TOKENS,
        ...(typeof params.temperature === "number" ? { temperature: params.temperature } : o.driver.temperature !== undefined ? { temperature: o.driver.temperature } : {}),
        promptCache: false,
        fetch: o.fetch,
      };
      const conv = o.driver.provider === "anthropic" ? anthropicConversation(init) : o.driver.provider === "openai" ? openaiResponsesConversation(init) : openaiChatConversation(init);
      const ts = Date.now();
      const t0 = performance.now();
      const event = (payload: Record<string, unknown>, extra: Partial<AgentEvent> = {}) =>
        o.emit({ id: hashParts(MODEL_AGENT, o.trialId, "mcp-sampling", seq++), v: 0, sessionId: o.trialId, runId: o.trialId, ts, agent: MODEL_AGENT, model: o.driver.model, kind: "llm.call", source: "model-driver", payload: { provider: o.driver.provider, requestModel: o.driver.model, purpose: "mcp-sampling", ...payload }, durationMs: Math.round((performance.now() - t0) * 10) / 10, ...extra });
      try {
        const turn = await conv.call();
        event({ ok: true, stopReason: turn.stopReason ?? null }, { usage: { ...turn.usage } });
        return { role: "assistant", content: { type: "text", text: turn.text }, model: turn.responseModel ?? o.driver.model, stopReason: turn.stopReason === "max_tokens" || turn.stopReason === "length" ? "maxTokens" : "endTurn" };
      } catch (e) {
        event({ ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 500) });
        throw e;
      }
    },
    async elicitation(params) {
      return elicitationAnswer(o.mcp, typeof params.message === "string" ? params.message : "");
    },
    async roots() {
      const paths = o.mcp?.roots?.length ? o.mcp.roots : ["."];
      return paths.map((p) => {
        const abs = isAbsolute(p) ? p : resolve(o.work, p);
        return { uri: pathToFileURL(abs).toString(), name: p === "." ? "work" : p };
      });
    },
  };
}
