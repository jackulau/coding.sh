// The agent-free tool-use loop (§4.2): stream a model call, emit one llm.call
// event (durationMs, ttftMs, usage, stopReason), run the tool calls, append
// the results, repeat until an assistant message has no tool calls or a
// budget runs out. Retries up to 3 times on 429/5xx (honouring retry-after),
// each failed attempt recorded as an llm.call with ok:false.
import { hashParts } from "../../core/ids.ts";
import type { AgentEvent, Usage } from "../../schema/index.ts";
import { estimateCost, totalTokens } from "../metrics.ts";
import type { Budget, Driver, Prices } from "../types.ts";
import { anthropicConversation } from "./anthropic.ts";
import { openaiChatConversation, openaiResponsesConversation } from "./openai.ts";
import type { ToolRuntime } from "./tools.ts";
import { ProviderHttpError, type Conversation, type ModelTurn, type ToolResult } from "./types.ts";

export const MODEL_AGENT = "coding.sh-model";
export const DEFAULT_SYSTEM =
  "You are working in a sandbox. Use the tools to complete the task. When finished, reply with the final answer and no tool call.";
const MAX_RETRIES = 3;
const OUTPUT_INLINE = 2048;

export interface LoopOpts {
  driver: Extract<Driver, { kind: "model" }>;
  instruction: string;
  tools: ToolRuntime;
  apiKey: string;
  fetch: typeof fetch;
  budget: Budget;
  trialId: string;
  cwd?: string;
  prices?: Prices;
  emit: (e: AgentEvent) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface LoopResult {
  finalText: string;
  usage: Usage;
  turns: number;
  stopped: "final" | "budget" | "error";
  budgetExceeded?: keyof Budget;
  error?: string;
  responseModel?: string;
}

export function createConversation(o: LoopOpts): Conversation {
  const init = {
    model: o.driver.model,
    system: o.driver.system ?? DEFAULT_SYSTEM,
    instruction: o.instruction,
    tools: o.tools.defs,
    apiKey: o.apiKey,
    baseUrl: o.driver.baseUrl,
    maxOutputTokens: o.driver.maxOutputTokens,
    temperature: o.driver.temperature,
    fetch: o.fetch,
  };
  if (o.driver.provider === "anthropic") return anthropicConversation(init);
  if (o.driver.provider === "openai") return openaiResponsesConversation(init);
  return openaiChatConversation(init);
}

function addUsage(sum: Usage, u: Usage): void {
  for (const k of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd"] as const) {
    const v = u[k];
    if (typeof v === "number") sum[k] = (sum[k] ?? 0) + v;
  }
}

export async function runModelLoop(o: LoopOpts): Promise<LoopResult> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const started = Date.now();
  let seq = 0;
  const ev = (kind: AgentEvent["kind"], payload: Record<string, unknown>, extra: Partial<AgentEvent> = {}): AgentEvent => {
    const e: AgentEvent = {
      id: hashParts(MODEL_AGENT, o.trialId, seq++),
      v: 0,
      sessionId: o.trialId,
      runId: o.trialId,
      ts: Date.now(),
      agent: MODEL_AGENT,
      model: o.driver.model,
      kind,
      payload,
      source: "model-driver",
      ...extra,
    };
    if (o.cwd) e.cwd = o.cwd;
    o.emit(e);
    return e;
  };
  const deadline = o.budget.wallMs !== undefined ? started + o.budget.wallMs : undefined;
  const ctrl = new AbortController();
  const timer = deadline !== undefined ? setTimeout(() => ctrl.abort(), Math.max(0, deadline - Date.now())) : undefined;
  timer?.unref?.();

  ev("session.start", { driver: `model:${o.driver.provider}/${o.driver.model}` });
  ev("user.message", { text: o.instruction });
  const conv = createConversation(o);
  const usage: Usage = {};
  let turns = 0;
  const result: LoopResult = { finalText: "", usage, turns: 0, stopped: "final" };
  const stop = (why: LoopResult["stopped"], extra: Partial<LoopResult> = {}) => Object.assign(result, { stopped: why }, extra);

  try {
    for (;;) {
      if (o.budget.turns !== undefined && turns >= o.budget.turns) {
        stop("budget", { budgetExceeded: "turns" });
        break;
      }
      let turn: ModelTurn | undefined;
      for (let attempt = 0; ; attempt++) {
        const callTs = Date.now();
        const t0 = performance.now();
        try {
          turn = await conv.call(ctrl.signal);
          const durationMs = Math.round((performance.now() - t0) * 10) / 10;
          const payload: Record<string, unknown> = { provider: o.driver.provider, requestModel: o.driver.model, ok: true, stopReason: turn.stopReason ?? null };
          if (turn.responseModel) payload.responseModel = turn.responseModel;
          if (turn.ttftMs !== undefined) payload.ttftMs = Math.round(turn.ttftMs * 10) / 10;
          if (turn.ttfThinkingMs !== undefined) payload.ttfThinkingMs = Math.round(turn.ttfThinkingMs * 10) / 10;
          if (turn.usage.outputTokens && durationMs > 0) payload.tokensPerSec = Math.round((turn.usage.outputTokens / (durationMs / 1000)) * 10) / 10;
          ev("llm.call", payload, { ts: callTs, durationMs, usage: { ...turn.usage } });
          break;
        } catch (e) {
          const durationMs = Math.round((performance.now() - t0) * 10) / 10;
          const msg = ctrl.signal.aborted ? "wall budget exceeded" : e instanceof Error ? e.message : String(e);
          ev("llm.call", { provider: o.driver.provider, requestModel: o.driver.model, ok: false, error: msg.slice(0, 500), ...(e instanceof ProviderHttpError ? { status: e.status } : {}) }, { ts: callTs, durationMs });
          if (ctrl.signal.aborted) {
            stop("budget", { budgetExceeded: "wallMs" });
            return result;
          }
          if (e instanceof ProviderHttpError && e.schemaRejected) {
            stop("error", { error: "schema-rejected-by-provider" });
            return result;
          }
          if (e instanceof ProviderHttpError && e.retryable && attempt < MAX_RETRIES) {
            const wait = Math.min(e.retryAfterMs ?? 500 * 2 ** attempt, 30_000);
            if (deadline !== undefined && Date.now() + wait > deadline) {
              stop("budget", { budgetExceeded: "wallMs" });
              return result;
            }
            await sleep(wait);
            continue;
          }
          stop("error", { error: msg });
          return result;
        }
      }
      turns++;
      result.turns = turns;
      addUsage(usage, turn.usage);
      if (turn.responseModel) result.responseModel = turn.responseModel;
      if (turn.text) ev("assistant.message", { text: turn.text, ...(turn.toolCalls.length ? {} : { final: true }) }, { usage: undefined });
      if (!turn.toolCalls.length) {
        result.finalText = turn.text;
        stop("final");
        break;
      }
      if (o.budget.tokens !== undefined && totalTokens(usage) > o.budget.tokens) {
        stop("budget", { budgetExceeded: "tokens" });
        break;
      }
      const cost = usage.costUsd ?? estimateCost(usage, o.driver.model, o.prices);
      if (o.budget.costUsd !== undefined && cost !== undefined && cost > o.budget.costUsd) {
        stop("budget", { budgetExceeded: "costUsd" });
        break;
      }
      const results: ToolResult[] = [];
      for (const call of turn.toolCalls) {
        const name = o.tools.names.get(call.name) ?? call.name;
        ev("tool.start", { tool: name, toolUseId: call.id, input: call.input });
        const t0 = performance.now();
        const r = await o.tools.exec(call);
        const durationMs = Math.round((performance.now() - t0) * 10) / 10;
        ev("tool.end", { tool: name, toolUseId: call.id, ok: !r.isError, durationMs, output: r.content.slice(0, OUTPUT_INLINE), outputBytes: Buffer.byteLength(r.content, "utf8") }, { durationMs });
        results.push({ id: call.id, content: r.content, isError: r.isError });
      }
      conv.pushToolResults(turn, results);
      if (ctrl.signal.aborted) {
        stop("budget", { budgetExceeded: "wallMs" });
        break;
      }
    }
  } finally {
    if (timer) clearTimeout(timer);
    ev("session.end", { reason: result.stopped, ...(result.budgetExceeded ? { budgetExceeded: result.budgetExceeded } : {}), ...(result.error ? { error: result.error } : {}) });
  }
  return result;
}
