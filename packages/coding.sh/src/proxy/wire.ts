// Wire formats the proxy understands: Anthropic Messages (and count_tokens),
// OpenAI Chat Completions and OpenAI Responses. Pure functions over parsed
// JSON: which API a path is, what a request asks for, and the final response
// rebuilt from a stream (or read from a JSON body).
import { anthropicPriceHints, anthropicUsage, arr, isObj, num, obj, openaiUsage, str } from "../adapters/_shared/normalize.ts";
import type { Usage } from "../schema/index.ts";
import type { SseEvent } from "./sse.ts";

export type Provider = "anthropic" | "openai";
export type Api = "messages" | "count_tokens" | "chat" | "responses" | "other";

export interface Route {
  provider: Provider;
  api: Api;
}

/** Which API a request is for. Paths may carry a prefix (`/v1`, a gateway's own path). */
export function classify(method: string, path: string, headers: Record<string, string | string[] | undefined>): Route {
  const p = path.split("?")[0]!.replace(/\/+$/, "");
  const post = method === "POST";
  if (post && /\/messages\/count_tokens$/.test(p)) return { provider: "anthropic", api: "count_tokens" };
  if (post && /\/messages$/.test(p)) return { provider: "anthropic", api: "messages" };
  if (post && /\/chat\/completions$/.test(p)) return { provider: "openai", api: "chat" };
  if (post && /\/responses$/.test(p)) return { provider: "openai", api: "responses" };
  // Anything else goes to the provider the client's headers point at.
  const anthropic = headers["anthropic-version"] !== undefined || headers["x-api-key"] !== undefined || /\/messages(\/|$)/.test(p);
  return { provider: anthropic ? "anthropic" : "openai", api: "other" };
}

export interface RequestInfo {
  model?: string;
  stream: boolean;
  /** System prompt as text (Anthropic system, OpenAI system/developer messages, Responses instructions). */
  system?: string;
  /** The request's own system value (string or blocks), for storage and replay. */
  systemRaw?: unknown;
  tools: unknown[];
  toolNames: string[];
  messages: unknown[];
  /** Last user message text, for titles and previews. */
  prompt?: string;
  /** First user message text (conversation key for clients that send no session id). */
  firstPrompt?: string;
  metadata?: Record<string, unknown>;
  /** Responses API: the response this one continues. */
  previousResponseId?: string;
  /** Sampling and limit settings, small. */
  params: Record<string, unknown>;
}

const PARAM_KEYS = ["temperature", "top_p", "top_k", "max_tokens", "max_output_tokens", "max_completion_tokens", "tool_choice", "thinking", "reasoning", "reasoning_effort", "service_tier", "parallel_tool_calls", "stop_sequences", "stop", "text", "truncation", "store", "prompt_cache_key"];

/** Text of a content value: a string, or text blocks (Anthropic, Chat parts, Responses input_text/output_text). */
export function textOf(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (!Array.isArray(v)) return undefined;
  const parts: string[] = [];
  for (const b of v) {
    if (typeof b === "string") parts.push(b);
    else if (isObj(b) && typeof b.text === "string" && (b.type === undefined || /text$/.test(String(b.type)))) parts.push(b.text);
  }
  return parts.length ? parts.join("\n") : undefined;
}

function userTexts(api: Api, messages: unknown[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (!isObj(m)) {
      if (typeof m === "string") out.push(m);
      continue;
    }
    if (m.role !== "user") continue;
    // Tool results ride on user messages in the Messages API: they are not prompts.
    if (api === "messages" && Array.isArray(m.content) && m.content.every((b) => isObj(b) && b.type === "tool_result")) continue;
    const t = textOf(m.content);
    if (t?.trim()) out.push(t);
  }
  return out;
}

function toolName(t: unknown): string | undefined {
  if (!isObj(t)) return undefined;
  return str(t.name) ?? str(obj(t.function).name) ?? str(t.type);
}

/** What a request body asks for. Unknown shapes give an empty view, never a throw. */
export function parseRequest(api: Api, body: unknown): RequestInfo {
  const b = obj(body);
  const info: RequestInfo = { stream: b.stream === true, tools: arr(b.tools), toolNames: [], messages: [], params: {} };
  info.model = str(b.model);
  for (const k of PARAM_KEYS) if (b[k] !== undefined) info.params[k] = b[k];
  for (const t of info.tools) {
    const n = toolName(t);
    if (n) info.toolNames.push(n);
  }
  if (isObj(b.metadata)) info.metadata = b.metadata;
  if (api === "messages" || api === "count_tokens") {
    info.messages = arr(b.messages);
    if (b.system !== undefined) {
      info.systemRaw = b.system;
      info.system = textOf(b.system);
    }
  } else if (api === "chat") {
    const all = arr(b.messages);
    const sys: string[] = [];
    for (const m of all) {
      const role = obj(m).role;
      if (role === "system" || role === "developer") {
        const t = textOf(obj(m).content);
        if (t) sys.push(t);
      } else info.messages.push(m);
    }
    if (sys.length) {
      info.system = sys.join("\n\n");
      info.systemRaw = all.filter((m) => obj(m).role === "system" || obj(m).role === "developer");
    }
  } else if (api === "responses") {
    if (typeof b.input === "string") info.messages = [{ role: "user", content: b.input }];
    else {
      const sys: string[] = [];
      for (const m of arr(b.input)) {
        const role = obj(m).role;
        if (role === "system" || role === "developer") {
          const t = textOf(obj(m).content);
          if (t) sys.push(t);
        }
        info.messages.push(m);
      }
      if (sys.length && !str(b.instructions)) info.system = sys.join("\n\n");
      // Without instructions (Codex), the system prompt is the leading system/developer items;
      // ones added later in the conversation are turns, so they don't change its hash.
      if (typeof b.instructions !== "string") {
        const lead: unknown[] = [];
        for (const m of arr(b.input)) {
          const role = obj(m).role;
          if (role !== "system" && role !== "developer") break;
          lead.push(m);
        }
        if (lead.length) info.systemRaw = lead;
      }
    }
    if (typeof b.instructions === "string") {
      info.systemRaw = b.instructions;
      info.system = b.instructions;
    }
    info.previousResponseId = str(b.previous_response_id);
  }
  const users = userTexts(api, info.messages);
  if (users.length) {
    info.firstPrompt = users[0];
    info.prompt = users[users.length - 1];
  }
  return info;
}

// ---------------------------------------------------------------- responses

export interface CallResult {
  id?: string;
  model?: string;
  stopReason?: string;
  usage?: Usage;
  /** Pricing hints for the llm.call payload (1-hour cache writes, inference geo, service tier). */
  hints: Record<string, unknown>;
  /** The final response, rebuilt: Anthropic message, Chat completion or Responses object. */
  body?: unknown;
  /** Error the API returned (in a body or an SSE error event). */
  error?: { type?: string; message?: string };
  /** count_tokens: the count. */
  inputTokens?: number;
  /** Time of the first content delta (ms since epoch). */
  firstTokenAt?: number;
  /** Stream events seen. */
  events: number;
}

export interface Accumulator {
  feed(ev: SseEvent, now: number): void;
  result(): CallResult;
}

const parse = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

function errorOf(v: unknown): CallResult["error"] | undefined {
  const o = obj(v);
  const e = isObj(o.error) ? o.error : o.type === "error" ? o : undefined;
  if (!e) return undefined;
  const out: { type?: string; message?: string } = {};
  const type = str(e.type) ?? str(e.code);
  if (type) out.type = type;
  const message = str(e.message);
  if (message) out.message = message;
  return out;
}

function anthropicHints(u: unknown, extra: Record<string, unknown>): Record<string, unknown> {
  const h: Record<string, unknown> = { ...anthropicPriceHints(u) };
  const tier = str(obj(u).service_tier) ?? str(extra.service_tier);
  if (tier) h.serviceTier = tier;
  const speed = str(obj(u).speed);
  if (speed) h.speed = speed;
  return h;
}

/** Usage fields of `next` overwrite `prev` (message_delta repeats or updates message_start's). */
function mergeUsage(prev: unknown, next: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = { ...obj(prev) };
  for (const [k, v] of Object.entries(obj(next))) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

export function anthropicAccumulator(): Accumulator {
  let message: Record<string, unknown> | undefined;
  let usage: Record<string, unknown> = {};
  const blocks: Record<string, unknown>[] = [];
  const partialJson = new Map<number, string>();
  let stopReason: string | undefined;
  let stopSequence: unknown;
  let error: CallResult["error"];
  let first: number | undefined;
  let n = 0;
  return {
    feed(ev, now) {
      n++;
      const d = obj(parse(ev.data));
      const type = str(d.type) ?? ev.event;
      if (type === "message_start") {
        message = { ...obj(d.message) };
        usage = mergeUsage(usage, obj(d.message).usage);
      } else if (type === "content_block_start") {
        const i = num(d.index) ?? blocks.length;
        blocks[i] = { ...obj(d.content_block) };
      } else if (type === "content_block_delta") {
        first ??= now;
        const i = num(d.index) ?? blocks.length - 1;
        const b = (blocks[i] ??= { type: "text", text: "" });
        const delta = obj(d.delta);
        if (delta.type === "text_delta") b.text = String(b.text ?? "") + String(delta.text ?? "");
        else if (delta.type === "input_json_delta") partialJson.set(i, (partialJson.get(i) ?? "") + String(delta.partial_json ?? ""));
        else if (delta.type === "thinking_delta") b.thinking = String(b.thinking ?? "") + String(delta.thinking ?? "");
        else if (delta.type === "signature_delta") b.signature = String(delta.signature ?? "");
        else if (delta.type === "citations_delta") {
          if (!Array.isArray(b.citations)) b.citations = [];
          (b.citations as unknown[]).push(delta.citation);
        }
      } else if (type === "content_block_stop") {
        const i = num(d.index);
        if (i !== undefined && partialJson.has(i)) {
          const raw = partialJson.get(i)!;
          blocks[i]!.input = raw ? (parse(raw) ?? raw) : {};
          partialJson.delete(i);
        }
      } else if (type === "message_delta") {
        const delta = obj(d.delta);
        stopReason = str(delta.stop_reason) ?? stopReason;
        if (delta.stop_sequence !== undefined) stopSequence = delta.stop_sequence;
        usage = mergeUsage(usage, d.usage);
      } else if (type === "error") {
        error = errorOf(d) ?? { message: ev.data.slice(0, 500) };
      }
    },
    result() {
      for (const [i, raw] of partialJson) if (blocks[i]) blocks[i]!.input = raw ? (parse(raw) ?? raw) : {};
      const r: CallResult = { hints: anthropicHints(usage, {}), events: n };
      if (message) {
        r.id = str(message.id);
        r.model = str(message.model);
        r.body = { ...message, content: blocks.filter(Boolean), stop_reason: stopReason ?? message.stop_reason ?? null, stop_sequence: stopSequence ?? message.stop_sequence ?? null, usage };
      }
      r.stopReason = stopReason;
      const u = anthropicUsage(usage);
      if (u) r.usage = u;
      if (error) r.error = error;
      if (first !== undefined) r.firstTokenAt = first;
      return r;
    },
  };
}

export function chatAccumulator(): Accumulator {
  let id: string | undefined;
  let model: string | undefined;
  let usage: unknown;
  let tier: string | undefined;
  const choices: { content: string; reasoning: string; role?: string; finish?: string; tools: Map<number, { id?: string; type?: string; name: string; args: string }> }[] = [];
  let error: CallResult["error"];
  let first: number | undefined;
  let n = 0;
  return {
    feed(ev, now) {
      n++;
      if (ev.data === "[DONE]") return;
      const d = obj(parse(ev.data));
      const e = errorOf(d);
      if (e && d.choices === undefined) {
        error = e;
        return;
      }
      id ??= str(d.id);
      model ??= str(d.model);
      tier ??= str(d.service_tier);
      if (isObj(d.usage)) usage = d.usage;
      for (const c of arr(d.choices)) {
        const co = obj(c);
        const i = num(co.index) ?? 0;
        const ch = (choices[i] ??= { content: "", reasoning: "", tools: new Map() });
        const delta = obj(co.delta);
        if (typeof delta.role === "string") ch.role = delta.role;
        if (typeof delta.content === "string" && delta.content) {
          first ??= now;
          ch.content += delta.content;
        }
        const reasoning = str(delta.reasoning_content) ?? str(delta.reasoning);
        if (reasoning) {
          first ??= now;
          ch.reasoning += reasoning;
        }
        for (const tc of arr(delta.tool_calls)) {
          first ??= now;
          const t = obj(tc);
          const ti = num(t.index) ?? ch.tools.size;
          const cur = ch.tools.get(ti) ?? { name: "", args: "" };
          if (str(t.id)) cur.id = str(t.id);
          if (str(t.type)) cur.type = str(t.type);
          const f = obj(t.function);
          if (typeof f.name === "string") cur.name += f.name;
          if (typeof f.arguments === "string") cur.args += f.arguments;
          ch.tools.set(ti, cur);
        }
        if (str(co.finish_reason)) ch.finish = str(co.finish_reason);
      }
    },
    result() {
      const r: CallResult = { hints: tier ? { serviceTier: tier } : {}, events: n };
      if (id) r.id = id;
      if (model) r.model = model;
      if (choices.length) {
        r.stopReason = choices[0]?.finish;
        r.body = {
          id,
          object: "chat.completion",
          model,
          choices: choices.map((c, index) => {
            const message: Record<string, unknown> = { role: c.role ?? "assistant", content: c.content || null };
            if (c.reasoning) message.reasoning_content = c.reasoning;
            if (c.tools.size) message.tool_calls = [...c.tools.values()].map((t) => ({ id: t.id, type: t.type ?? "function", function: { name: t.name, arguments: t.args } }));
            return { index, message, finish_reason: c.finish ?? null };
          }),
          ...(usage ? { usage } : {}),
        };
      }
      const u = openaiUsage(usage);
      if (u) r.usage = u;
      if (error) r.error = error;
      if (first !== undefined) r.firstTokenAt = first;
      return r;
    },
  };
}

export function responsesAccumulator(): Accumulator {
  let response: Record<string, unknown> | undefined;
  const items: unknown[] = [];
  let error: CallResult["error"];
  let first: number | undefined;
  let n = 0;
  return {
    feed(ev, now) {
      n++;
      const d = obj(parse(ev.data));
      const type = str(d.type) ?? ev.event ?? "";
      if (type === "response.created" || type === "response.in_progress" || type === "response.completed" || type === "response.failed" || type === "response.incomplete") {
        if (isObj(d.response)) response = { ...d.response };
        if (type === "response.failed") error = errorOf(obj(d.response)) ?? { type: "failed" };
      } else if (type === "response.output_item.done") {
        if (d.item !== undefined) items.push(d.item);
      } else if (type.endsWith(".delta")) {
        first ??= now;
      } else if (type === "error") {
        error = errorOf(d) ?? { type: str(d.code), message: str(d.message) };
      }
    },
    result() {
      const r: CallResult = { hints: {}, events: n };
      if (response) {
        // The ChatGPT backend (store: false) completes with an empty output: the items came one by one.
        const output = arr(response.output).length ? response.output : items;
        r.body = { ...response, output };
        fillResponses(r, r.body);
      } else if (items.length) r.body = { output: items };
      if (error) r.error = error;
      if (first !== undefined) r.firstTokenAt = first;
      return r;
    },
  };
}

function fillResponses(r: CallResult, body: unknown): void {
  const b = obj(body);
  r.id = str(b.id);
  r.model = str(b.model);
  const status = str(b.status);
  const reason = str(obj(b.incomplete_details).reason);
  // Responses has no stop reason: "tool_calls" when it ends on a call, else its status.
  const calls = arr(b.output).some((i) => /_call$/.test(String(obj(i).type ?? "")));
  r.stopReason = reason ?? (status === "completed" && calls ? "tool_calls" : status);
  const u = openaiUsage(b.usage);
  if (u) r.usage = u;
  const tier = str(b.service_tier);
  if (tier) r.hints.serviceTier = tier;
  const e = isObj(b.error) ? errorOf(b) : undefined;
  if (e) r.error = e;
}

export function accumulatorFor(api: Api): Accumulator | undefined {
  if (api === "messages") return anthropicAccumulator();
  if (api === "chat") return chatAccumulator();
  if (api === "responses") return responsesAccumulator();
  return undefined;
}

/** A non-streamed response body (JSON), success or error. */
export function parseJsonResponse(api: Api, text: string): CallResult {
  const v = parse(text);
  const r: CallResult = { hints: {}, events: 0 };
  if (v === undefined) {
    if (text.trim()) r.error = { message: text.slice(0, 500) };
    return r;
  }
  const b = obj(v);
  const err = errorOf(b);
  if (err && (b.type === "error" || (isObj(b.error) && b.choices === undefined && b.output === undefined))) {
    r.error = err;
    r.body = v;
    return r;
  }
  r.body = v;
  if (api === "messages") {
    r.id = str(b.id);
    r.model = str(b.model);
    r.stopReason = str(b.stop_reason);
    const u = anthropicUsage(b.usage);
    if (u) r.usage = u;
    r.hints = anthropicHints(b.usage, {});
  } else if (api === "count_tokens") {
    r.inputTokens = num(b.input_tokens);
  } else if (api === "chat") {
    r.id = str(b.id);
    r.model = str(b.model);
    r.stopReason = str(obj(arr(b.choices)[0]).finish_reason);
    const u = openaiUsage(b.usage);
    if (u) r.usage = u;
    const tier = str(b.service_tier);
    if (tier) r.hints.serviceTier = tier;
  } else if (api === "responses") {
    fillResponses(r, b);
  }
  return r;
}

/** The first thing a response does: a tool call (name + input) or text. For replay grading. */
export interface FirstAction {
  type: "tool" | "text" | "none";
  name?: string;
  input?: unknown;
  text?: string;
}

export function firstAction(api: Api, body: unknown): FirstAction {
  const b = obj(body);
  if (api === "messages") {
    const content = arr(b.content);
    const tool = content.find((c) => obj(c).type === "tool_use");
    if (tool) return { type: "tool", name: str(obj(tool).name), input: obj(tool).input };
    const text = textOf(content.filter((c) => obj(c).type === "text"));
    return text?.trim() ? { type: "text", text } : { type: "none" };
  }
  if (api === "chat") {
    const m = obj(obj(arr(b.choices)[0]).message);
    const tc = obj(arr(m.tool_calls)[0]);
    if (Object.keys(tc).length) {
      const args = str(obj(tc.function).arguments);
      return { type: "tool", name: str(obj(tc.function).name), input: args ? (parse(args) ?? args) : {} };
    }
    const text = str(m.content);
    return text?.trim() ? { type: "text", text } : { type: "none" };
  }
  if (api === "responses") {
    const out = arr(b.output);
    const call = out.find((i) => /_call$/.test(String(obj(i).type ?? "")));
    if (call) {
      const c = obj(call);
      const args = str(c.arguments);
      return { type: "tool", name: str(c.name) ?? str(c.type), input: args ? (parse(args) ?? args) : (c.action ?? c.input) };
    }
    const texts: string[] = [];
    for (const i of out) for (const p of arr(obj(i).content)) if (typeof obj(p).text === "string") texts.push(String(obj(p).text));
    const text = texts.join("\n");
    return text.trim() ? { type: "text", text } : { type: "none" };
  }
  return { type: "none" };
}
