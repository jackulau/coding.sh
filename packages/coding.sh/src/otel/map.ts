// OTLP spans and log records → coding.sh/trace AgentEvents.
//
// Dialects understood (first match wins per field):
//   OTel GenAI semconv   gen_ai.operation.name, gen_ai.request/response.model,
//                        gen_ai.usage.*, gen_ai.agent.name, gen_ai.tool.*,
//                        gen_ai.input/output.messages, legacy gen_ai.prompt/
//                        gen_ai.completion (attributes, flattened, or span events)
//   OpenInference        openinference.span.kind, llm.model_name, llm.token_count.*,
//                        llm.input/output_messages.*, input.value/output.value, tool.*
//   Vercel AI SDK        ai.* (ai.generateText[.doGenerate], ai.toolCall, ai.usage.*)
//   Claude Code / Codex / Gemini CLI log events (claude_code.api_request, …)
//
// Span → events (slot numbers are part of the event id, keep them stable):
//   root span (no parent)   0 session.start · 1 turn.end · 2 user.message (root input)
//                           6 session.end (only when the session is the trace)
//   model call (llm)        0 llm.call (usage, model, durationMs) · 3 assistant.message (text)
//   tool                    0 tool.start · 1 tool.end
//   agent (non-root)        0 subagent.start · 1 subagent.end (parent session)
//                           7 session.start · 8 user.message · 9 assistant.message
//                           10 session.end (child session, see childSessionId)
//   anything else           0 span { name, spanKind, scope, ok, attributes }
//   span events             100+i error (for "exception")
//   A root span that is itself a model/tool call keeps its own events in slots 4/5 (and 3).
//
// Session = trace, unless a span (or its trace, or its resource) carries a
// conversation id (gen_ai.conversation.id, session.id, ai.telemetry.metadata.sessionId);
// then every trace of that conversation is a turn of one session. Spans under a
// nested agent span go to that subagent's child session instead (childSessionId).
//
// Usage is only taken from model-call spans: agent/chain spans (invoke_agent,
// ai.generateText) often repeat the sum of their children, and counting both
// would double the session's tokens. Their reported totals stay in payload.
import type { AgentEvent, AgentId, BlobRef, EventKind, Usage, UsageNumberKey } from "../schema/index.ts";
import { SCHEMA_VERSION } from "../schema/index.ts";
import { hashParts, sha256Hex } from "../core/ids.ts";
import { geoValue, tierValue } from "../core/pricing.ts";
import { anthropicPriceHints } from "../adapters/_shared/normalize.ts";
import { type DurableTag, durableOf, durableSessionId } from "./durable.ts";
import {
  type Attrs,
  nanosDiffMs,
  nanosToMs,
  type OtelLogRecord,
  type OtelScope,
  type OtelSpan,
  type OtelValue,
  type ResourceLogs,
  type ResourceSpans,
  STATUS_CODE,
  unsetTime,
} from "./model.ts";

export interface MapContext {
  maxInlineBytes: number;
  /** Stores content as a blob; returns its ref. */
  blob(data: string | Uint8Array): Promise<BlobRef>;
  /** Remembers trace → conversation session across batches (spans of one trace arrive in pieces). */
  traceSessions?: TraceSessionMap;
  /** Remembers span ancestry across batches, so a subagent's descendants find it (see SpanTree). */
  spanTree?: SpanTree;
  /** Keep the normalized source span/log as blobs[0] (default true). */
  keepRaw?: boolean;
  /**
   * Enrichment hook, called once per span after the built-in mapping. This is
   * where framework integrations plug in, e.g. src/integrations/eve's
   * `enrichFromEve(span, events)`. Return a replacement event list, or mutate
   * `events` in place and return nothing. Keep event ids deterministic
   * (derive new ones with spanEventId) so re-posted spans stay idempotent.
   * A throw rejects the span (counted in partial_success).
   */
  enrichSpan?: SpanEnricher;
}

export interface SpanEnrichInfo {
  resource: Attrs;
  scope: OtelScope;
  sessionId: string;
  agent: AgentId;
}

export type SpanEnricher = (span: OtelSpan, events: AgentEvent[], info: SpanEnrichInfo) => AgentEvent[] | void | Promise<AgentEvent[] | void>;

export interface MapResult {
  events: AgentEvent[];
  /** Spans/log records that could not be mapped (counted in partial_success). */
  rejected: number;
  errors: string[];
}

/** AgentEvent.source for events mapped from OTLP spans / log records (ingest dedupe keys on it). */
export const SPAN_SOURCE = "otel-span";
export const LOG_SOURCE = "otel-log";

/**
 * Bounded LRU of traceId → conversation session id. The receiver persists new
 * entries (takeDirty) to the index kv and seeds misses from it, so a trace
 * whose spans straddle a receiver restart still lands in its conversation.
 */
export class TraceSessionMap {
  private readonly map = new Map<string, string>();
  private readonly dirty = new Map<string, string>();
  private readonly max: number;
  constructor(max = 10_000) {
    this.max = max;
  }
  get(traceId: string): string | undefined {
    const v = this.map.get(traceId);
    if (v !== undefined) {
      this.map.delete(traceId);
      this.map.set(traceId, v);
    }
    return v;
  }
  has(traceId: string): boolean {
    return this.map.has(traceId);
  }
  set(traceId: string, sessionId: string): void {
    if (this.map.get(traceId) !== sessionId) this.dirty.set(traceId, sessionId);
    this.seed(traceId, sessionId);
  }
  /** Set without marking the entry for persistence (it came from storage). */
  seed(traceId: string, sessionId: string): void {
    this.map.delete(traceId);
    this.map.set(traceId, sessionId);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }
  /** Entries set since the last call. */
  takeDirty(): [string, string][] {
    const out = [...this.dirty];
    this.dirty.clear();
    return out;
  }
}

/** What the mapper needs to know about a span to route its descendants. */
export interface SpanNode {
  parentSpanId?: string;
  /** A nested (non-root) agent span: it has a child session. */
  subagent: boolean;
  /** A durable-workflow replay span: model calls under it were made before (see durable.ts). */
  replay?: boolean;
}

/**
 * Bounded LRU of `${traceId}:${spanId}` → SpanNode for spans already mapped,
 * so a span whose subagent ancestor came in an earlier batch is still routed
 * into that subagent's session. In memory only: ancestry lost to a receiver
 * restart just leaves descendants in the parent session.
 */
export class SpanTree {
  private readonly map = new Map<string, SpanNode>();
  private readonly max: number;
  constructor(max = 50_000) {
    this.max = max;
  }
  get(traceId: string, spanId: string): SpanNode | undefined {
    return this.map.get(`${traceId}:${spanId}`);
  }
  set(traceId: string, spanId: string, node: SpanNode): void {
    const k = `${traceId}:${spanId}`;
    this.map.delete(k);
    this.map.set(k, node);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }
}

/** Index kv key of a persisted trace → conversation entry. */
export const traceKvKey = (traceId: string) => `otel-trace:${traceId}`;

// ---------------------------------------------------------------- attribute helpers

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** First non-empty string among keys (numbers are stringified). */
function str(a: Attrs, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = a[k];
    if (typeof v === "string" && v !== "") return v;
    if (typeof v === "number") return String(v);
  }
  return undefined;
}

/** First finite number among keys; numeric strings count. */
function num(a: Attrs, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = a[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
}

function bool(a: Attrs, ...keys: string[]): boolean | undefined {
  for (const k of keys) {
    const v = a[k];
    if (typeof v === "boolean") return v;
    if (v === "true" || v === "1" || v === 1) return true;
    if (v === "false" || v === "0" || v === 0) return false;
  }
  return undefined;
}

function first(a: Attrs, ...keys: string[]): OtelValue | undefined {
  for (const k of keys) {
    const v = a[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

/** Parses JSON-looking strings; anything else is returned unchanged. */
function maybeJson(v: OtelValue | undefined): unknown {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return v;
  try {
    return JSON.parse(t);
  } catch {
    return v;
  }
}

export function kebab(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
}

// ---------------------------------------------------------------- agent detection

const KNOWN: [RegExp, AgentId][] = [
  [/^claude[-_ .]?code|^com\.anthropic\.claude[-_]code/i, "claude-code"],
  [/^codex/i, "codex"],
  [/^gemini[-_ ]?cli/i, "gemini-cli"],
  [/^opencode/i, "opencode"],
  [/^goose/i, "goose"],
  [/^(github[-_ ]?)?copilot[-_ ]?cli/i, "copilot-cli"],
  [/^cursor([-_ ]?(agent|cli))?$/i, "cursor"],
  [/^(factory[-_ ]?)?droid$/i, "droid"],
  [/^amp$/i, "amp"],
  [/^aider/i, "aider"],
];

/** Log event-name prefixes that identify an agent (claude_code.api_request → claude-code). */
const EVENT_PREFIX: [string, AgentId][] = [
  ["claude_code.", "claude-code"],
  ["gemini_cli.", "gemini-cli"],
  ["codex.", "codex"],
];

/**
 * Agent id for a resource: a known agent when service.name / scope name
 * identify one, else the kebab-cased service.name, else "otel".
 */
export function detectAgent(resource: Attrs, scope?: OtelScope, eventName?: string): AgentId {
  const service = str(resource, "service.name");
  for (const [re, id] of KNOWN) if ((service && re.test(service)) || (scope?.name && re.test(scope.name))) return id;
  if (eventName) for (const [p, id] of EVENT_PREFIX) if (eventName.startsWith(p)) return id;
  if (service && !service.startsWith("unknown_service")) {
    const k = kebab(service);
    if (k) return k;
  }
  return "otel";
}

// ---------------------------------------------------------------- span classification

export type SpanClass = "llm" | "embedding" | "tool" | "agent" | "other";

const VERCEL_LLM = /^ai\.(generateText|streamText|generateObject|streamObject)\.do(Generate|Stream)$/;
const VERCEL_EMBED = /^ai\.embed(Many)?(\.doEmbed)?$/;

/** Claude Code's beta trace spans (CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1). */
const CLAUDE_CODE_SPANS: Record<string, SpanClass> = {
  "claude_code.llm_request": "llm",
  "claude_code.tool": "tool",
  "claude_code.interaction": "other",
};

export function classifySpan(span: OtelSpan): SpanClass {
  const a = span.attributes;
  const cc = CLAUDE_CODE_SPANS[str(a, "span.type") ?? span.name];
  if (cc) return cc;
  if (span.name.startsWith("claude_code.")) return "other"; // tool.execution, tool.blocked_on_user, hook
  const op = str(a, "gen_ai.operation.name")?.toLowerCase();
  if (op) {
    if (op === "chat" || op === "text_completion" || op === "generate_content" || op === "completion") return "llm";
    if (op === "embeddings" || op === "embedding") return "embedding";
    if (op === "execute_tool") return "tool";
    if (op === "invoke_agent" || op === "create_agent") return "agent";
    return "other"; // invoke_workflow, agent_step, plan, retrieval, memory ops, …
  }
  const oi = str(a, "openinference.span.kind")?.toUpperCase();
  if (oi) {
    if (oi === "LLM") return "llm";
    if (oi === "EMBEDDING") return "embedding";
    if (oi === "TOOL") return "tool";
    if (oi === "AGENT") return "agent";
    return "other"; // CHAIN, RETRIEVER, RERANKER, GUARDRAIL, EVALUATOR, PROMPT, DECISION
  }
  const ls = str(a, "langsmith.span.kind")?.toLowerCase();
  if (ls === "llm") return "llm";
  if (ls === "tool") return "tool";
  if (ls === "embedding") return "embedding";
  const vop = str(a, "ai.operationId") ?? span.name;
  if (VERCEL_LLM.test(vop)) return "llm";
  if (vop === "ai.toolCall") return "tool";
  if (VERCEL_EMBED.test(vop)) return vop.endsWith(".doEmbed") || !a["ai.operationId"] ? "embedding" : "other";
  if (vop.startsWith("ai.")) return "other"; // ai.generateText & co. are the loop around model calls
  if (first(a, "gen_ai.tool.name", "tool.name") !== undefined) return "tool";
  if (first(a, "gen_ai.request.model", "gen_ai.response.model", "llm.model_name") !== undefined) return "llm";
  return "other";
}

// ---------------------------------------------------------------- message extraction

interface Msg {
  role?: string;
  text: string;
}

const ROLE_ALIASES: Record<string, string> = { human: "user", ai: "assistant", model: "assistant", bot: "assistant" };
const normRole = (r: unknown): string | undefined => (typeof r === "string" && r ? (ROLE_ALIASES[r.toLowerCase()] ?? r.toLowerCase()) : undefined);

function contentText(c: unknown, depth = 0): string {
  if (depth > 8 || c === null || c === undefined) return "";
  if (typeof c === "string") return c;
  if (typeof c === "number" || typeof c === "boolean") return String(c);
  if (Array.isArray(c)) return c.map((p) => contentText(p, depth + 1)).filter(Boolean).join("\n");
  if (isObj(c)) {
    // Parts: { type: "text", text } (OpenAI/Vercel), { type: "text", content } (semconv), { text } (Gemini).
    const type = typeof c.type === "string" ? c.type : undefined;
    if (type && !/text|output_text|input_text/.test(type)) return "";
    for (const k of ["text", "content", "value"]) if (c[k] !== undefined) return contentText(c[k], depth + 1);
  }
  return "";
}

function msgFromObj(o: Record<string, unknown>, depth: number): Msg[] {
  if (isObj(o.kwargs)) return msgFromObj({ ...o.kwargs, role: o.kwargs.role ?? o.kwargs.type }, depth + 1); // LangChain serialized
  if (isObj(o.message) && !("role" in o)) return msgFromObj(o.message, depth + 1); // gen_ai.choice body, OpenAI choices
  const role = normRole(o.role ?? (typeof o.type === "string" && /^(human|ai|user|assistant|system|tool)$/.test(o.type) ? o.type : undefined));
  const text = contentText(o.parts ?? o.content ?? o.text, depth + 1);
  return text || role ? [{ ...(role ? { role } : {}), text }] : [];
}

/** Best-effort list of chat messages from any of the dialects' shapes. */
function messagesFrom(v: unknown, parseJson: boolean, depth = 0): Msg[] {
  if (depth > 6 || v === null || v === undefined) return [];
  if (typeof v === "string") {
    if (parseJson) {
      const parsed = maybeJson(v);
      if (parsed !== v) {
        const m = messagesFrom(parsed, false, depth + 1);
        if (m.length) return m;
      }
    }
    return v.trim() ? [{ text: v }] : [];
  }
  if (Array.isArray(v)) return v.flatMap((x) => messagesFrom(x, parseJson, depth + 1));
  if (isObj(v)) {
    if (Array.isArray(v.messages)) return messagesFrom(v.messages, false, depth + 1);
    if (Array.isArray(v.choices)) return messagesFrom(v.choices, false, depth + 1);
    if (Array.isArray(v.input) && !("role" in v)) return messagesFrom(v.input, false, depth + 1); // OpenAI Responses
    if (Array.isArray(v.output) && !("role" in v)) return messagesFrom(v.output, false, depth + 1);
    if (typeof v.prompt === "string" && !("role" in v)) return [{ role: "user", text: v.prompt }]; // Vercel ai.prompt
    if (typeof v.input === "string" && !("role" in v)) return [{ role: "user", text: v.input }];
    return msgFromObj(v, depth);
  }
  return [];
}

/** Flattened lists: `${prefix}.{i}.role` / `.content` / `.message.role` / `.message.contents.{j}.message_content.text`. */
function flattened(a: Attrs, prefix: string): Msg[] {
  const byIndex = new Map<number, Record<string, OtelValue>>();
  const head = `${prefix}.`;
  for (const [k, v] of Object.entries(a)) {
    if (!k.startsWith(head)) continue;
    const m = /^(\d+)\.(.+)$/.exec(k.slice(head.length));
    if (!m) continue;
    const i = Number(m[1]);
    let rec = byIndex.get(i);
    if (!rec) byIndex.set(i, (rec = {}));
    rec[m[2]!] = v;
  }
  return [...byIndex.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([, rec]) => {
      const role = normRole(rec["message.role"] ?? rec.role);
      let text = contentText(rec["message.content"] ?? rec.content);
      if (!text) {
        text = Object.entries(rec)
          .filter(([k, v]) => typeof v === "string" && /(^|\.)(text|message_content\.text)$/.test(k))
          .map(([, v]) => v as string)
          .join("\n");
      }
      return { ...(role ? { role } : {}), text };
    })
    .filter((m) => m.text || m.role);
}

function eventMessages(span: OtelSpan, names: string[], keys: string[]): Msg[] {
  const out: Msg[] = [];
  for (const e of span.events) {
    if (!names.includes(e.name)) continue;
    for (const k of keys) {
      const v = e.attributes[k];
      if (v !== undefined) out.push(...messagesFrom(v, true));
    }
  }
  return out;
}

function inputMessages(a: Attrs, span?: OtelSpan): Msg[] {
  let m = messagesFrom(first(a, "gen_ai.input.messages", "gen_ai.prompt", "ai.prompt.messages", "ai.prompt"), true);
  if (!m.length) m = flattened(a, "llm.input_messages");
  if (!m.length) m = flattened(a, "gen_ai.prompt");
  if (!m.length) m = messagesFrom(first(a, "input.value"), str(a, "input.mime_type") !== "text/plain");
  if (!m.length && span) {
    m = eventMessages(span, ["gen_ai.content.prompt"], ["gen_ai.prompt"]);
    if (!m.length) m = eventMessages(span, ["gen_ai.user.message", "gen_ai.system.message"], ["content", "gen_ai.event.content"]);
  }
  return m;
}

function outputMessages(a: Attrs, span?: OtelSpan): Msg[] {
  let m = messagesFrom(first(a, "gen_ai.output.messages", "gen_ai.completion"), true);
  if (!m.length) m = flattened(a, "llm.output_messages");
  if (!m.length) m = flattened(a, "gen_ai.completion");
  if (!m.length) {
    const t = str(a, "ai.response.text");
    if (t) m = [{ role: "assistant", text: t }];
  }
  if (!m.length) m = messagesFrom(first(a, "output.value", "ai.response.object"), str(a, "output.mime_type") !== "text/plain");
  if (!m.length && span) {
    m = eventMessages(span, ["gen_ai.content.completion"], ["gen_ai.completion"]);
    if (!m.length) m = eventMessages(span, ["gen_ai.choice"], ["message", "content", "gen_ai.event.content"]);
  }
  return m;
}

/** The newest user turn (the prompt that started this call). */
function userText(msgs: Msg[]): string | undefined {
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]!.role === "user" && msgs[i]!.text) return msgs[i]!.text;
  if (msgs.some((m) => m.role)) return undefined;
  return msgs.map((m) => m.text).filter(Boolean).join("\n") || undefined;
}

function assistantText(msgs: Msg[]): string | undefined {
  return msgs.filter((m) => !m.role || m.role === "assistant").map((m) => m.text).filter(Boolean).join("\n") || undefined;
}

// ---------------------------------------------------------------- usage & model

// Usage.inputTokens is the UNCACHED input only (adapters/_shared/normalize.ts
// openaiUsage), so in + cacheRead + cacheWrite is the whole prompt.
//   Totals (include cached): OTel GenAI semconv gen_ai.usage.input_tokens,
//   OpenInference llm.token_count.prompt, AI SDK ai.usage.inputTokens. Their
//   cache parts (same namespaces) are subtracted.
//   Agent log attributes (Claude Code's input_tokens + cache_read_tokens,
//   Anthropic semantics; Codex / Gemini CLI input_token_count) are kept as is,
//   matching how the transcript adapters store the same agents.
const INPUT_TOTAL = ["gen_ai.usage.input_tokens", "gen_ai.usage.prompt_tokens", "llm.token_count.prompt", "ai.usage.inputTokens", "ai.usage.promptTokens"];
const CACHE_READ = ["gen_ai.usage.cache_read.input_tokens", "gen_ai.usage.cache_read_input_tokens", "llm.token_count.prompt_details.cache_read", "ai.usage.cachedInputTokens", "ai.usage.inputTokenDetails.cacheReadTokens"];
const CACHE_WRITE = ["gen_ai.usage.cache_write.input_tokens", "gen_ai.usage.cache_creation.input_tokens", "gen_ai.usage.cache_creation_input_tokens", "llm.token_count.prompt_details.cache_write", "ai.usage.inputTokenDetails.cacheWriteTokens"];

function usageOf(a: Attrs): Usage | undefined {
  const u: Usage = {};
  const set = (k: UsageNumberKey, v: number | undefined) => {
    if (v !== undefined && v >= 0) u[k] = v;
  };
  const total = num(a, ...INPUT_TOTAL);
  const read = num(a, ...CACHE_READ);
  const write = num(a, ...CACHE_WRITE);
  if (total !== undefined) {
    // AI SDK v6 also reports the uncached part itself.
    set("inputTokens", num(a, "ai.usage.inputTokenDetails.noCacheTokens") ?? Math.max(0, total - (read ?? 0) - (write ?? 0)));
  } else {
    set("inputTokens", num(a, "input_tokens", "input_token_count"));
  }
  set("outputTokens", num(a, "gen_ai.usage.output_tokens", "gen_ai.usage.completion_tokens", "llm.token_count.completion", "ai.usage.outputTokens", "ai.usage.completionTokens", "output_tokens", "output_token_count"));
  set("cacheReadTokens", read ?? num(a, "cache_read_tokens", "cached_content_token_count", "cached_token_count"));
  // Claude Code api_request: cache_creation_tokens, else its 5-minute + 1-hour split.
  const m5 = num(a, "cache_creation_5m_tokens");
  const h1 = num(a, "cache_creation_1h_tokens");
  set("cacheWriteTokens", write ?? num(a, "cache_creation_tokens") ?? (m5 || h1 ? (m5 ?? 0) + (h1 ?? 0) : undefined));
  set("costUsd", num(a, "gen_ai.usage.cost", "llm.cost.total", "cost_usd"));
  return Object.keys(u).length ? u : undefined;
}

const requestModel = (a: Attrs) => str(a, "gen_ai.request.model", "llm.model_name", "ai.model.id", "model");
const responseModel = (a: Attrs) => str(a, "gen_ai.response.model", "ai.response.model");

// The service tier a call ran at (payload.serviceTier, priced by pricing.ts callTier). A response
// attribute, when there is one, says what was served (a `flex` request can be served `default`).
const TIER_RESPONSE = ["openai.response.service_tier", "gen_ai.openai.response.service_tier", "gen_ai.response.service_tier"];
const TIER_REQUEST = ["openai.request.service_tier", "gen_ai.openai.request.service_tier", "gen_ai.request.service_tier", "service_tier"];
function serviceTier(a: Attrs): string | undefined {
  const res = str(a, ...TIER_RESPONSE);
  if (res !== undefined) return tierValue(res);
  // AI SDK: providerMetadata.openai.serviceTier, or Anthropic's raw usage.service_tier.
  const meta = maybeJson(a["ai.response.providerMetadata"]);
  if (isObj(meta)) {
    const openai = isObj(meta.openai) ? meta.openai.serviceTier : undefined;
    const anthropic = isObj(meta.anthropic) && isObj(meta.anthropic.usage) ? meta.anthropic.usage.service_tier : undefined;
    if (typeof openai === "string" || typeof anthropic === "string") return tierValue(openai ?? anthropic);
  }
  return tierValue(str(a, ...TIER_REQUEST));
}

/**
 * Price hints for the llm.call payload (pricing.ts priceEvent): `cacheWrite1hTokens`,
 * the 1-hour part of the cache writes (Claude Code api_request `cache_creation_1h_tokens`,
 * or AI SDK provider metadata `anthropic.usage.cache_creation.ephemeral_1h_input_tokens`),
 * and `inferenceGeo` (`inference_geo`, or the same metadata's `usage.inference_geo`).
 */
function priceHints(a: Attrs): { cacheWrite1hTokens?: number; inferenceGeo?: string } {
  const meta = maybeJson(a["ai.response.providerMetadata"]);
  const fromMeta = isObj(meta) && isObj(meta.anthropic) ? anthropicPriceHints(meta.anthropic.usage) : {};
  const h1 = num(a, "cache_creation_1h_tokens");
  const geo = geoValue(str(a, "inference_geo", "gen_ai.anthropic.inference_geo"));
  return { ...fromMeta, ...(h1 ? { cacheWrite1hTokens: h1 } : {}), ...(geo ? { inferenceGeo: geo } : {}) };
}

function finishReason(a: Attrs): string | undefined {
  const fr = maybeJson(a["gen_ai.response.finish_reasons"]);
  if (Array.isArray(fr) && typeof fr[0] === "string") return fr[0];
  return str(a, "gen_ai.response.finish_reasons", "ai.response.finishReason", "llm.finish_reason", "stop_reason");
}

// ---------------------------------------------------------------- payload builder

const PREVIEW_BYTES = 512;
const SESSION_KEYS = [
  "gen_ai.conversation.id",
  "session.id",
  "ai.telemetry.metadata.sessionId",
  "ai.telemetry.metadata.session_id",
  "langsmith.metadata.thread_id",
  "langsmith.metadata.session_id",
  "conversation.id",
];
/** Claude Code redacts content unless OTEL_LOG_USER_PROMPTS / OTEL_LOG_ASSISTANT_RESPONSES are set. */
const REDACTED = /^<REDACTED>$/i;
const content = (s: string | undefined): string | undefined => (s && !REDACTED.test(s.trim()) ? s : undefined);
const RUN_KEYS = ["coding_sh.run_id", "codingsh.run_id"];

function truncateUtf8(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s) <= maxBytes) return s;
  let out = s.slice(0, maxBytes);
  while (Buffer.byteLength(out) > maxBytes - 3) out = out.slice(0, -Math.max(1, Math.ceil((Buffer.byteLength(out) - maxBytes + 3) / 4)));
  // Don't leave a lone high surrogate at the cut.
  if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
  return `${out}…`;
}

const serialize = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v) ?? "");

class Blobs {
  private readonly cache = new Map<string, Promise<BlobRef>>();
  private readonly ctx: MapContext;
  constructor(ctx: MapContext) {
    this.ctx = ctx;
  }
  put(data: string): Promise<BlobRef> {
    const key = sha256Hex(data);
    let p = this.cache.get(key);
    if (!p) this.cache.set(key, (p = this.ctx.blob(data)));
    return p;
  }
}

/** Builds one event's payload, moving oversize values to blobs. */
class Draft {
  readonly payload: Record<string, unknown> = {};
  readonly blobs: BlobRef[] = [];
  private readonly store: Blobs;
  private readonly maxInline: number;
  constructor(store: Blobs, maxInline: number, raw: BlobRef | undefined) {
    this.store = store;
    this.maxInline = maxInline;
    if (raw) this.blobs.push(raw);
  }

  set(key: string, v: unknown): this {
    if (v !== undefined && v !== null && v !== "") this.payload[key] = v;
    return this;
  }

  /** Inline when small; else a preview plus `${key}Blob` (and the ref in blobs). */
  async content(key: string, v: unknown): Promise<this> {
    if (v === undefined || v === null || v === "") return this;
    const text = serialize(v);
    if (Buffer.byteLength(text) <= this.maxInline) {
      this.payload[key] = v;
      return this;
    }
    const ref = await this.store.put(text);
    this.payload[key] = truncateUtf8(text, Math.min(PREVIEW_BYTES, this.maxInline));
    this.payload[`${key}Blob`] = ref;
    this.payload.truncated = true;
    if (!this.blobs.includes(ref)) this.blobs.push(ref);
    return this;
  }

  /** Attribute map with each oversize value replaced by { blob, bytes }. */
  async attributes(key: string, a: Attrs, omit: Set<string> = new Set()): Promise<this> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(a)) {
      if (omit.has(k)) continue;
      const text = serialize(v);
      if (Buffer.byteLength(text) <= this.maxInline) {
        Object.defineProperty(out, k, { value: v, writable: true, enumerable: true, configurable: true });
        continue;
      }
      const ref = await this.store.put(text);
      if (!this.blobs.includes(ref)) this.blobs.push(ref);
      Object.defineProperty(out, k, { value: { blob: ref, bytes: Buffer.byteLength(text) }, writable: true, enumerable: true, configurable: true });
    }
    if (Object.keys(out).length) this.payload[key] = out;
    return this;
  }
}

// ---------------------------------------------------------------- spans

interface SpanCtx {
  resource: Attrs;
  scope: OtelScope;
  span: OtelSpan;
  traceId: string;
  spanId: string;
  sessionId: string;
  /** Session is a conversation spanning traces (vs. the trace itself). */
  conversation: boolean;
  agent: AgentId;
  agentVersion?: string;
  runId?: string;
  /** Span id of the nearest enclosing subagent; sessionId is then its child session. */
  subagentId?: string;
  /** What the span is in a durable workflow run (payload.durable on its first event). */
  durable?: DurableTag;
  /** The span sits under a durable replay span. */
  replayed?: boolean;
}

export const spanEventId = (traceId: string, spanId: string, slot: number): string => hashParts("otel", traceId, spanId, slot);

/**
 * Session of a nested agent span. The subagent's own start/prompt/result/end
 * live there (with session.start.payload.parentSessionId, so buildSession sets
 * Session.parent), and so do the events of its descendant spans (model calls,
 * tools, nested subagents), tagged with subagentId, whenever the descendant's
 * ancestry up to the agent span is known: same batch, or an earlier batch via
 * MapContext.spanTree. Spans exported before their agent ancestor (a long
 * subagent under a batching exporter) stay in the parent session: stored
 * events are never moved.
 */
export const childSessionId = (traceId: string, spanId: string): string => `otel-sub-${traceId}-${spanId}`;

const SPAN_TTFT_MS = ["ai.response.msToFirstChunk", "ai.stream.msToFirstChunk", "ttft_ms"];
const SPAN_TTFT_S = ["gen_ai.response.time_to_first_chunk"]; // semconv: seconds
const FIRST_CHUNK_EVENT = /first[._ -]?(chunk|token)/i;

/** Time to first token in ms: span attributes, else a streaming "first chunk" span event. */
function ttftMs(span: OtelSpan): number | undefined {
  const a = span.attributes;
  const ms = num(a, ...SPAN_TTFT_MS);
  if (ms !== undefined) return ms;
  const s = num(a, ...SPAN_TTFT_S);
  if (s !== undefined) return Math.round(s * 1e6) / 1e3;
  const ev = span.events.find((e) => FIRST_CHUNK_EVENT.test(e.name));
  if (!ev) return undefined;
  const evMs = num(ev.attributes, ...SPAN_TTFT_MS);
  if (evMs !== undefined) return evMs;
  if (unsetTime(ev.timeUnixNano) || unsetTime(span.startTimeUnixNano)) return undefined;
  return nanosDiffMs(span.startTimeUnixNano, ev.timeUnixNano);
}

// Claude Code can export the same model/tool call twice: as a log event
// (claude_code.api_request / tool_result) and as a beta trace span
// (claude_code.llm_request / claude_code.tool). Keying those events on the
// agent's own request/tool-use ids makes the second copy a no-op insert.
// Only for claude-code: other frameworks don't guarantee unique call ids.
const ccLlmId = (sessionId: string, requestId: string, part: "call" | "text"): string => hashParts("otel-cc-llm", sessionId, requestId, part);
const ccToolId = (sessionId: string, toolUseId: string, part: "start" | "end"): string => hashParts("otel-cc-tool", sessionId, toolUseId, part);
const ccPromptId = (sessionId: string, promptId: string): string => hashParts("otel-cc-prompt", sessionId, promptId);

const conversationOf = (a: Attrs): string | undefined => str(a, ...SESSION_KEYS);

function toolInput(v: unknown): unknown {
  const parsed = maybeJson(v as OtelValue);
  if (isObj(parsed) && parsed.command === undefined) {
    // Claude Code's tool_parameters name the Bash command bash_command/full_command.
    const cmd = parsed.full_command ?? parsed.bash_command;
    if (typeof cmd === "string") return { ...parsed, command: cmd };
  }
  return parsed;
}

function errorMessage(span: OtelSpan): string | undefined {
  if (span.status.message) return span.status.message;
  const ex = span.events.find((e) => e.name === "exception");
  return ex ? str(ex.attributes, "exception.message", "exception.type") : undefined;
}

async function mapSpan(c: SpanCtx, ctx: MapContext, store: Blobs): Promise<AgentEvent[]> {
  const { span, traceId, spanId } = c;
  const a = span.attributes;
  const klass = classifySpan(span);
  const isRoot = !span.parentSpanId;
  const startMs = nanosToMs(unsetTime(span.startTimeUnixNano) ? span.endTimeUnixNano : span.startTimeUnixNano);
  const endMs = unsetTime(span.endTimeUnixNano) ? startMs : nanosToMs(span.endTimeUnixNano);
  const durationMs = nanosDiffMs(span.startTimeUnixNano, span.endTimeUnixNano);
  const failed = span.status.code === STATUS_CODE.ERROR || bool(a, "success") === false;
  const error = failed ? (errorMessage(span) ?? str(a, "error")) : undefined;
  const cc = c.agent === "claude-code";
  const max = ctx.maxInlineBytes;

  let raw: BlobRef | undefined;
  if (ctx.keepRaw !== false) {
    raw = await store.put(
      JSON.stringify({ format: "otlp.span", v: 0, resource: c.resource, scope: { name: c.scope.name, version: c.scope.version }, span }),
    );
  }

  const out: AgentEvent[] = [];
  const parentId = span.parentSpanId ? spanEventId(traceId, span.parentSpanId, 0) : undefined;
  const emit = (slot: number, kind: EventKind, ts: number, d: Draft, extra: Partial<AgentEvent> = {}, id?: string): AgentEvent => {
    const e: AgentEvent = {
      id: id ?? spanEventId(traceId, spanId, slot),
      v: SCHEMA_VERSION,
      sessionId: c.sessionId,
      ts,
      agent: c.agent,
      kind,
      traceId,
      spanId,
      source: SPAN_SOURCE,
      payload: d.payload,
    };
    if (span.parentSpanId) e.parentSpanId = span.parentSpanId;
    if (parentId) e.parentId = parentId;
    if (c.conversation) e.turnId = traceId;
    if (c.agentVersion) e.agentVersion = c.agentVersion;
    if (c.runId) e.runId = c.runId;
    if (c.subagentId) e.subagentId = c.subagentId;
    if (d.blobs.length) e.blobs = d.blobs;
    Object.assign(e, extra);
    out.push(e);
    return e;
  };
  const draft = () => new Draft(store, max, raw);
  const agentName = str(a, "gen_ai.agent.name", "agent.name") ?? (/^invoke_agent\s+(.+)$/.exec(span.name)?.[1] || undefined);

  // ---- model call
  const llm = async (slot: number) => {
    const req = requestModel(a);
    const res = responseModel(a);
    const usage = usageOf(a);
    const hints = priceHints(a);
    const d = draft()
      .set("provider", str(a, "gen_ai.provider.name", "gen_ai.system", "llm.provider", "llm.system", "ai.model.provider"))
      .set("requestModel", req)
      .set("responseModel", res)
      .set("serviceTier", serviceTier(a))
      .set("cacheWrite1hTokens", hints.cacheWrite1hTokens)
      .set("inferenceGeo", hints.inferenceGeo)
      .set("operation", klass === "embedding" ? "embeddings" : (str(a, "gen_ai.operation.name") ?? "chat"))
      .set("name", span.name)
      .set("ttftMs", ttftMs(span))
      .set("stopReason", finishReason(a))
      .set("ok", !failed)
      .set("error", error)
      .set("replay", c.replayed || undefined);
    const outTokens = usage?.outputTokens;
    const tps = num(a, "ai.response.avgOutputTokensPerSecond", "ai.response.avgCompletionTokensPerSecond");
    if (tps !== undefined) d.set("tokensPerSec", tps);
    else if (outTokens && durationMs > 0) d.set("tokensPerSec", Math.round((outTokens / (durationMs / 1000)) * 100) / 100);
    const model = res ?? req;
    const requestId = cc ? str(a, "request_id") : undefined;
    const callId = requestId ? ccLlmId(c.sessionId, requestId, "call") : undefined;
    emit(slot, "llm.call", startMs, d.set("requestId", requestId), { durationMs, ...(model ? { model } : {}), ...(usage ? { usage } : {}) }, callId);
    const text = assistantText(outputMessages(a, span));
    if (text) {
      const m = await draft().content("text", text);
      emit(3, "assistant.message", endMs, m, model ? { model } : {}, requestId ? ccLlmId(c.sessionId, requestId, "text") : undefined);
    }
  };

  // ---- tool call
  const tool = async (startSlot: number, endSlot: number) => {
    const name =
      str(a, "gen_ai.tool.name", "tool.name", "ai.toolCall.name", "tool_name") ?? (/^execute_tool\s+(.+)$/.exec(span.name)?.[1] || span.name || "tool");
    const explicitId = str(a, "gen_ai.tool.call.id", "ai.toolCall.id", "tool.id", "tool_call.id", "tool_use_id");
    const toolUseId = explicitId ?? spanId;
    const ids = cc && explicitId ? [ccToolId(c.sessionId, explicitId, "start"), ccToolId(c.sessionId, explicitId, "end")] : [];
    const input = first(a, "gen_ai.tool.call.arguments", "tool.parameters", "ai.toolCall.args", "ai.toolCall.input", "input.value", "tool_input", "tool_parameters");
    const output = first(a, "gen_ai.tool.call.result", "ai.toolCall.result", "ai.toolCall.output", "output.value");
    const s = draft().set("tool", name).set("toolUseId", toolUseId).set("description", str(a, "gen_ai.tool.description", "tool.description"));
    await s.content("input", toolInput(input));
    emit(startSlot, "tool.start", startMs, s, {}, ids[0]);
    const e = draft().set("tool", name).set("toolUseId", toolUseId).set("ok", !failed).set("durationMs", durationMs).set("error", error);
    await e.content("output", maybeJson(output));
    emit(endSlot, "tool.end", endMs, e, { durationMs }, ids[1]);
  };

  // A durable engine's root span (a queue delivery, StartWorkflow, a recovery write) is
  // plumbing of a longer run, not a turn: it stays a plain span in the run's session.
  if (isRoot && !(c.durable && klass === "other")) {
    const s = draft().set("name", span.name).set("agentName", agentName).set("traceId", traceId).set("scope", c.scope.name || undefined);
    emit(0, "session.start", startMs, s);
    const resumed = c.durable?.recovered || c.durable?.waitEdge === "end";
    const prompt = resumed ? undefined : (content(str(a, "user_prompt")) ?? userText(inputMessages(a, klass === "llm" ? span : undefined)));
    const promptId = cc ? str(a, "prompt.id") : undefined;
    if (prompt) emit(2, "user.message", startMs, await draft().content("text", prompt), {}, promptId ? ccPromptId(c.sessionId, promptId) : undefined);
    if (klass === "llm" || klass === "embedding") await llm(4);
    else if (klass === "tool") await tool(4, 5);
    const end = draft().set("ok", !failed).set("error", error).set("durationMs", durationMs);
    if (klass !== "llm") await end.content("output", assistantText(outputMessages(a)));
    const reported = klass === "llm" || klass === "embedding" ? undefined : usageOf(a);
    if (reported) end.set("reportedUsage", reported);
    emit(1, "turn.end", endMs, end, { durationMs });
    if (!c.conversation) {
      emit(6, "session.end", endMs, draft().set("reason", failed ? "error" : "completed").set("error", error), { durationMs });
    }
  } else if (klass === "llm" || klass === "embedding") {
    await llm(0);
  } else if (klass === "tool") {
    await tool(0, 1);
  } else if (klass === "agent") {
    const child = childSessionId(traceId, spanId);
    const prompt = userText(inputMessages(a));
    const result = assistantText(outputMessages(a));
    const s = draft().set("subagentId", spanId).set("type", agentName).set("description", str(a, "gen_ai.agent.description"));
    await s.content("prompt", prompt);
    s.set("childSessionId", child);
    const startEv = emit(0, "subagent.start", startMs, s, { subagentId: spanId });
    const e = draft().set("subagentId", spanId).set("ok", !failed).set("error", error);
    await e.content("result", result);
    const reported = usageOf(a);
    if (reported) e.set("reportedUsage", reported);
    e.set("childSessionId", child);
    emit(1, "subagent.end", endMs, e, { subagentId: spanId, durationMs });

    // The subagent's own session, linked back to the subagent.start above.
    const inChild = { sessionId: child, subagentId: spanId };
    const cs = draft()
      .set("parentSessionId", c.sessionId)
      .set("parentEventId", startEv.id)
      .set("subagentId", spanId)
      .set("subagentType", agentName)
      .set("name", span.name)
      .set("traceId", traceId);
    emit(7, "session.start", startMs, cs, inChild);
    if (prompt) emit(8, "user.message", startMs, await draft().content("text", prompt), inChild);
    if (result) emit(9, "assistant.message", endMs, await draft().content("text", result), inChild);
    emit(10, "session.end", endMs, draft().set("reason", failed ? "error" : "completed").set("error", error), { ...inChild, durationMs });
  } else {
    // No better mapping: keep it as a generic span (schema kind "span": { name, attributes }).
    const d = draft().set("name", span.name).set("spanKind", span.kind).set("scope", c.scope.name || undefined).set("ok", !failed).set("error", error);
    await d.attributes("attributes", a);
    emit(0, "span", startMs, d, { durationMs });
  }

  // ---- durable workflow tag on the span's first event (model and tool calls are never steps or waits).
  if (c.durable && out[0]) {
    const stepLike = c.durable.role === "step" || c.durable.role === "wait";
    out[0].payload.durable = stepLike && klass !== "other" && klass !== "agent" ? { ...c.durable, role: "other" } : c.durable;
  }

  // ---- span events: exceptions become error events; content events were folded in above.
  for (const [i, ev] of span.events.entries()) {
    if (ev.name !== "exception") continue;
    const d = draft()
      .set("message", str(ev.attributes, "exception.message") ?? "exception")
      .set("type", str(ev.attributes, "exception.type"))
      .set("escaped", bool(ev.attributes, "exception.escaped"));
    await d.content("stacktrace", str(ev.attributes, "exception.stacktrace"));
    emit(100 + i, "error", unsetTime(ev.timeUnixNano) ? endMs : nanosToMs(ev.timeUnixNano), d);
  }

  // ---- integration hook (e.g. enrichFromEve from src/integrations/eve)
  if (ctx.enrichSpan) {
    const replaced = await ctx.enrichSpan(span, out, { resource: c.resource, scope: c.scope, sessionId: c.sessionId, agent: c.agent });
    if (replaced) {
      for (const e of replaced) e.source ??= SPAN_SOURCE;
      return replaced;
    }
    for (const e of out) e.source ??= SPAN_SOURCE;
  }
  return out;
}

/** Span id of the nearest nested agent span at or above `spanId`, if the chain up to it is known. */
function enclosingSubagent(tree: SpanTree, traceId: string, spanId: string | undefined): string | undefined {
  for (let depth = 0; spanId && depth < 256; depth++) {
    const node = tree.get(traceId, spanId);
    if (!node) return undefined;
    if (node.subagent) return spanId;
    spanId = node.parentSpanId;
  }
  return undefined;
}

/** True when `spanId` or a known ancestor is a durable replay span. */
function underReplay(tree: SpanTree, traceId: string, spanId: string | undefined): boolean {
  for (let depth = 0; spanId && depth < 256; depth++) {
    const node = tree.get(traceId, spanId);
    if (!node) return false;
    if (node.replay) return true;
    spanId = node.parentSpanId;
  }
  return false;
}

/** Maps decoded ExportTraceServiceRequest content to events. */
export async function mapTraces(batch: ResourceSpans[], ctx: MapContext): Promise<MapResult> {
  const store = new Blobs(ctx);
  const result: MapResult = { events: [], rejected: 0, errors: [] };

  // Pass 1: which traces in this batch belong to a conversation (any span may
  // carry the id), and the span tree (spans arrive in any order).
  // A durable workflow run id keys the session too (one run = one session across
  // traces, processes and days), below an explicit conversation id.
  const traceConv = new Map<string, string>();
  const traceRun = new Map<string, string>();
  const durable = new Map<OtelSpan, DurableTag>();
  // Durable spans that name no run (Restate's run spans): their trace's run, below.
  const unkeyed: [OtelSpan, DurableTag][] = [];
  const traceRunId = new Map<string, string>();
  const tree = ctx.spanTree ?? new SpanTree();
  for (const rs of batch)
    for (const ss of rs.scopeSpans)
      for (const sp of ss.spans) {
        const conv = conversationOf(sp.attributes);
        if (sp.traceId && conv && !traceConv.has(sp.traceId)) traceConv.set(sp.traceId, conv);
        const d = durableOf(sp, rs.resource.attributes, ss.scope);
        if (d && !d.run) unkeyed.push([sp, d]);
        else if (d) {
          if (sp.traceId && !traceRunId.has(sp.traceId)) traceRunId.set(sp.traceId, d.run);
          durable.set(sp, d);
          const sid = durableSessionId(d);
          if (sp.traceId && !traceRun.has(sp.traceId)) traceRun.set(sp.traceId, sid);
          // Traces a run span links to belong to the run too (Vercel continuous mode
          // links each invocation to its HTTP handler's own trace).
          for (const l of sp.links) if (l.traceId && l.traceId !== sp.traceId && !traceRun.has(l.traceId)) traceRun.set(l.traceId, sid);
        }
        if (sp.traceId && sp.spanId) {
          const node: SpanNode = { subagent: !!sp.parentSpanId && classifySpan(sp) === "agent" };
          if (sp.parentSpanId) node.parentSpanId = sp.parentSpanId;
          if (d?.replay) node.replay = true;
          tree.set(sp.traceId, sp.spanId, node);
        }
      }
  for (const [sp, d] of unkeyed) {
    const known = sp.traceId ? ctx.traceSessions?.get(sp.traceId) : undefined;
    const run = (sp.traceId && traceRunId.get(sp.traceId)) || (known?.startsWith(`${d.engine}:`) ? known.slice(d.engine.length + 1) : undefined);
    if (run) durable.set(sp, { ...d, run });
  }
  for (const [t, s] of traceConv) ctx.traceSessions?.set(t, s);
  // A trace already keyed (an explicit conversation, or an earlier batch) keeps its session.
  for (const [t, s] of traceRun) if (!traceConv.has(t) && !ctx.traceSessions?.has(t)) ctx.traceSessions?.set(t, s);

  for (const rs of batch) {
    const resource = rs.resource.attributes;
    const resourceConv = conversationOf(resource);
    for (const ss of rs.scopeSpans) {
      // DBOS checks the global tracer at launch with an empty "probe" span: nothing happened.
      if (ss.scope.name === "otel-bootstrap-check") continue;
      const agent = detectAgent(resource, ss.scope);
      for (const span of ss.spans) {
        if (!span.traceId || !span.spanId) {
          result.rejected++;
          if (result.errors.length < 5) result.errors.push(`span ${JSON.stringify(span.name)} has no valid traceId/spanId`);
          continue;
        }
        const conv =
          conversationOf(span.attributes) ?? traceConv.get(span.traceId) ?? ctx.traceSessions?.get(span.traceId) ?? resourceConv ?? traceRun.get(span.traceId);
        const c: SpanCtx = {
          resource,
          scope: ss.scope,
          span,
          traceId: span.traceId,
          spanId: span.spanId,
          sessionId: conv ?? span.traceId,
          conversation: conv !== undefined && conv !== span.traceId,
          agent,
        };
        const version = str(resource, "service.version") ?? str(span.attributes, "app.version");
        if (version) c.agentVersion = version;
        const runId = str(span.attributes, ...RUN_KEYS) ?? str(resource, ...RUN_KEYS);
        if (runId) c.runId = runId;
        const d = durable.get(span);
        if (d) c.durable = d;
        if (underReplay(tree, span.traceId, span.spanId)) c.replayed = true;
        const sub = enclosingSubagent(tree, span.traceId, span.parentSpanId);
        if (sub) {
          c.subagentId = sub;
          c.sessionId = childSessionId(span.traceId, sub);
        }
        try {
          result.events.push(...(await mapSpan(c, ctx, store)));
        } catch (err) {
          result.rejected++;
          if (result.errors.length < 5) result.errors.push(`span ${span.spanId}: ${(err as Error).message}`);
        }
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------- logs

/** Agent event namespaces: claude_code.api_request → ("claude_code", "api_request"). */
const AGENT_EVENT = /^(claude_code|gemini_cli|codex|qwen_code)\.(.+)$/;

/**
 * Event name of a log record: the event_name field, the event.name attribute
 * (Claude Code puts the short form there: "api_request"), or a dotted body.
 * A namespaced candidate wins over a short one.
 */
function logEventName(rec: OtelLogRecord): string | undefined {
  const fromAttr = str(rec.attributes, "event.name");
  const fromBody = typeof rec.body === "string" && /^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/i.test(rec.body) ? rec.body : undefined;
  const candidates = [rec.eventName, fromAttr, fromBody].filter((x): x is string => !!x);
  return candidates.find((n) => n.includes(".")) ?? candidates[0];
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Log time in ms: time_unix_nano, else observed time, else an ISO event.timestamp attribute. */
function logTime(rec: OtelLogRecord): { ms: number; nanos: string } {
  if (!unsetTime(rec.timeUnixNano)) return { ms: nanosToMs(rec.timeUnixNano), nanos: rec.timeUnixNano };
  if (!unsetTime(rec.observedTimeUnixNano)) return { ms: nanosToMs(rec.observedTimeUnixNano), nanos: rec.observedTimeUnixNano };
  const iso = str(rec.attributes, "event.timestamp");
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? { ms, nanos: `${ms}000000` } : { ms: Date.now(), nanos: "0" };
}

/** Maps decoded ExportLogsServiceRequest content to events. */
export async function mapLogs(batch: ResourceLogs[], ctx: MapContext): Promise<MapResult> {
  const store = new Blobs(ctx);
  const result: MapResult = { events: [], rejected: 0, errors: [] };
  for (const rl of batch) {
    for (const sl of rl.scopeLogs) {
      for (const rec of sl.logRecords) {
        try {
          result.events.push(...(await mapLog(rec, rl.resource.attributes, sl.scope, ctx, store)));
        } catch (err) {
          result.rejected++;
          if (result.errors.length < 5) result.errors.push(`log record: ${(err as Error).message}`);
        }
      }
    }
  }
  return result;
}

async function mapLog(rec: OtelLogRecord, resource: Attrs, scope: OtelScope, ctx: MapContext, store: Blobs): Promise<AgentEvent[]> {
  const a = rec.attributes;
  const name = logEventName(rec);
  const agent = detectAgent(resource, scope, name);
  const cc = agent === "claude-code";
  const { ms: ts, nanos } = logTime(rec);
  const conv = conversationOf(a) ?? (rec.traceId ? ctx.traceSessions?.get(rec.traceId) : undefined) ?? conversationOf(resource);
  const sessionId = conv ?? rec.traceId ?? `otel-logs-${agent}-${dayOf(ts)}`;
  // Logs have no id: hash what identifies the record (same record → same id on re-export).
  const key = hashParts(
    "otel-log",
    nanos,
    name ?? "",
    rec.traceId ?? "",
    rec.spanId ?? "",
    str(resource, "service.name") ?? "",
    sha256Hex(stableJson({ a, b: rec.body ?? null })),
  );
  const raw =
    ctx.keepRaw === false
      ? undefined
      : await store.put(JSON.stringify({ format: "otlp.log", v: 0, resource, scope: { name: scope.name, version: scope.version }, log: rec }));
  const version = str(resource, "service.version") ?? str(a, "app.version");
  const runId = str(a, ...RUN_KEYS) ?? str(resource, ...RUN_KEYS);
  const promptId = str(a, "prompt.id");
  const subagentId = str(a, "agent_id");
  const out: AgentEvent[] = [];
  const draft = () => new Draft(store, ctx.maxInlineBytes, raw);
  const emit = (slot: number, kind: EventKind, at: number, d: Draft, extra: Partial<AgentEvent> = {}, id?: string) => {
    const e: AgentEvent = { id: id ?? hashParts(key, slot), v: SCHEMA_VERSION, sessionId, ts: at, agent, kind, source: LOG_SOURCE, payload: d.payload };
    if (rec.traceId) e.traceId = rec.traceId;
    if (rec.spanId) e.spanId = rec.spanId;
    if (version) e.agentVersion = version;
    if (runId) e.runId = runId;
    if (promptId) e.turnId = promptId;
    if (subagentId) e.subagentId = subagentId;
    if (d.blobs.length) e.blobs = d.blobs;
    Object.assign(e, extra);
    out.push(e);
  };

  const suffix = name ? (AGENT_EVENT.exec(name)?.[2] ?? name) : undefined;
  const durationMs = num(a, "duration_ms");
  const startTs = durationMs !== undefined ? ts - Math.round(durationMs) : ts;
  const timing = durationMs !== undefined ? { durationMs } : {};
  const usage = usageOf(a);
  const model = str(a, "model", "gen_ai.response.model", "gen_ai.request.model");
  const requestId = cc ? str(a, "request_id") : undefined;

  if (suffix === "user_prompt") {
    const d = draft().set("promptLength", num(a, "prompt_length")).set("command", str(a, "command_name"));
    await d.content("text", content(str(a, "prompt_text", "prompt")));
    emit(0, "user.message", ts, d, {}, cc && promptId ? ccPromptId(sessionId, promptId) : undefined);
  } else if ((suffix === "api_request" || suffix === "api_response" || suffix === "sse_event") && usage) {
    // A completed model call. Gemini CLI's and Codex's api_request carry no
    // tokens and fall through to notification, so each call is counted once.
    const hints = priceHints(a);
    const d = draft()
      .set("provider", cc ? "anthropic" : str(a, "gen_ai.provider.name", "gen_ai.system", "provider"))
      .set("requestModel", model)
      .set("ok", true)
      .set("statusCode", num(a, "status_code"))
      .set("requestId", requestId)
      .set("serviceTier", serviceTier(a))
      .set("speed", tierValue(str(a, "speed")))
      .set("cacheWrite1hTokens", hints.cacheWrite1hTokens)
      .set("inferenceGeo", hints.inferenceGeo)
      .set("event", name);
    emit(0, "llm.call", startTs, d, { ...timing, ...(model ? { model } : {}), usage }, requestId ? ccLlmId(sessionId, requestId, "call") : undefined);
  } else if (suffix === "api_error") {
    const d = draft()
      .set("requestModel", model)
      .set("ok", false)
      .set("error", str(a, "error", "error.message"))
      .set("statusCode", num(a, "status_code"))
      .set("attempt", num(a, "attempt"))
      .set("requestId", requestId)
      .set("event", name);
    emit(0, "llm.call", startTs, d, { ...timing, ...(model ? { model } : {}) });
  } else if (suffix === "assistant_response") {
    const text = content(str(a, "response"));
    const d = draft().set("responseLength", num(a, "response_length"));
    await d.content("text", text);
    emit(0, "assistant.message", ts, d, model ? { model } : {}, requestId ? ccLlmId(sessionId, requestId, "text") : undefined);
  } else if (suffix === "tool_result" || suffix === "tool_call") {
    const tool = str(a, "tool_name", "function_name", "gen_ai.tool.name") ?? "tool";
    const explicitId = str(a, "tool_use_id", "call_id", "gen_ai.tool.call.id");
    const toolUseId = explicitId ?? key.slice(0, 16);
    const ok = bool(a, "success") ?? !str(a, "error", "error_type");
    const input = toolInput(first(a, "tool_input", "tool_parameters", "function_args", "arguments", "gen_ai.tool.call.arguments"));
    const s = draft().set("tool", tool).set("toolUseId", toolUseId).set("server", str(a, "mcp_server_name", "mcp_server.name"));
    await s.content("input", input);
    emit(1, "tool.start", startTs, s, {}, cc && explicitId ? ccToolId(sessionId, explicitId, "start") : undefined);
    const e = draft()
      .set("tool", tool)
      .set("toolUseId", toolUseId)
      .set("ok", ok)
      .set("durationMs", durationMs)
      .set("error", str(a, "error", "error_type"))
      .set("decision", str(a, "decision", "decision_type"))
      .set("source", str(a, "decision_source", "source"));
    await e.content("output", maybeJson(first(a, "tool_result", "output", "gen_ai.tool.call.result")));
    emit(0, "tool.end", ts, e, timing, cc && explicitId ? ccToolId(sessionId, explicitId, "end") : undefined);
  } else if (suffix === "compaction") {
    const d = draft()
      .set("trigger", str(a, "trigger") === "manual" ? "manual" : "auto")
      .set("tokensBefore", num(a, "tokens_before", "pre_tokens", "input_tokens"));
    emit(0, "context.compact", ts, d);
  } else if (name === "gen_ai.choice" || name === "gen_ai.client.inference.operation.details") {
    const text = assistantText(name === "gen_ai.choice" ? messagesFrom(rec.body, true) : outputMessages(a));
    if (text) emit(0, "assistant.message", ts, await draft().content("text", text), model ? { model } : {});
  } else {
    const d = draft()
      .set("type", suffix && name !== suffix ? suffix : "log")
      .set("event", name)
      .set("severity", rec.severityText || (rec.severityNumber ? rec.severityNumber : undefined));
    if (rec.body !== undefined && rec.body !== name) await d.content("body", rec.body);
    await d.attributes("attributes", a, new Set(["event.name", "event.timestamp", "session.id"]));
    emit(0, "notification", ts, d);
  }
  return out;
}
