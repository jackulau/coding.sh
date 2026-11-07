// Provider response shapes → normalized LlmCall fields. Shared by the client
// wrappers (observe) and the raw HTTP wrapper (observeFetch).
//
// Usage convention (same as the server): inputTokens counts UNCACHED input.
//   OpenAI chat       prompt_tokens − prompt_tokens_details.cached_tokens
//   OpenAI responses  input_tokens − input_tokens_details.cached_tokens
//   Anthropic         input_tokens (cache reads/writes are reported separately)
// Cache fields are only set when non-zero, so a cache-less call has the same
// usage object the OTel path produces.
import type { LlmCall, ToolCallInfo, Usage } from "./context.ts";
import { isObj, lastUserText, num, safeJson, str } from "./util.ts";

export type Shape = "chat" | "responses" | "messages";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (isObj(v) ? v : {});

export type CallResult = Pick<LlmCall, "responseModel" | "responseId" | "text" | "toolCalls" | "usage" | "stopReason" | "ok" | "error">;

/** Request params → requestModel + the prompt (last user message). */
export function requestInfo(shape: Shape, params: unknown): { requestModel?: string; input?: string; stream: boolean } {
  const p = obj(params);
  const input = shape === "responses" ? lastUserText(p.input) : lastUserText(p.messages);
  const out: { requestModel?: string; input?: string; stream: boolean } = { stream: p.stream === true };
  const model = str(p.model);
  if (model) out.requestModel = model;
  if (input) out.input = input;
  return out;
}

function setPositive(u: Usage, k: keyof Usage, v: number | undefined): void {
  if (v !== undefined && v > 0) u[k] = v;
}

export function openaiChatUsage(raw: unknown): Usage | undefined {
  if (!isObj(raw)) return undefined;
  const total = num(raw.prompt_tokens);
  const cached = num(obj(raw.prompt_tokens_details).cached_tokens) ?? 0;
  const u: Usage = {};
  if (total !== undefined) u.inputTokens = Math.max(0, total - cached);
  const out = num(raw.completion_tokens);
  if (out !== undefined) u.outputTokens = out;
  setPositive(u, "cacheReadTokens", cached);
  return Object.keys(u).length ? u : undefined;
}

export function openaiResponsesUsage(raw: unknown): Usage | undefined {
  if (!isObj(raw)) return undefined;
  const total = num(raw.input_tokens);
  const cached = num(obj(raw.input_tokens_details).cached_tokens) ?? 0;
  const u: Usage = {};
  if (total !== undefined) u.inputTokens = Math.max(0, total - cached);
  const out = num(raw.output_tokens);
  if (out !== undefined) u.outputTokens = out;
  setPositive(u, "cacheReadTokens", cached);
  return Object.keys(u).length ? u : undefined;
}

export function anthropicUsage(raw: unknown, into: Usage = {}): Usage | undefined {
  if (!isObj(raw)) return Object.keys(into).length ? into : undefined;
  const input = num(raw.input_tokens);
  if (input !== undefined) into.inputTokens = input;
  const out = num(raw.output_tokens);
  if (out !== undefined) into.outputTokens = out;
  setPositive(into, "cacheReadTokens", num(raw.cache_read_input_tokens));
  setPositive(into, "cacheWriteTokens", num(raw.cache_creation_input_tokens));
  return Object.keys(into).length ? into : undefined;
}

function done(r: CallResult): CallResult {
  for (const k of Object.keys(r) as (keyof CallResult)[]) if (r[k] === undefined) delete r[k];
  return r;
}

// ---------------------------------------------------------------- whole responses

export function openaiChatResult(res: unknown): CallResult {
  const r = obj(res);
  const choice = obj(Array.isArray(r.choices) ? r.choices[0] : undefined);
  const msg = obj(choice.message);
  const toolCalls: ToolCallInfo[] = [];
  if (Array.isArray(msg.tool_calls))
    for (const tc of msg.tool_calls) {
      const fn = obj(obj(tc).function);
      const name = str(fn.name);
      if (name) toolCalls.push({ id: str(obj(tc).id), name, arguments: str(fn.arguments) });
    }
  return done({
    ok: true,
    responseModel: str(r.model),
    responseId: str(r.id),
    text: typeof msg.content === "string" && msg.content ? msg.content : str(msg.refusal),
    toolCalls: toolCalls.length ? toolCalls : undefined,
    usage: openaiChatUsage(r.usage),
    stopReason: str(choice.finish_reason),
  });
}

function responsesOutput(output: unknown): { text?: string; toolCalls?: ToolCallInfo[] } {
  const texts: string[] = [];
  const toolCalls: ToolCallInfo[] = [];
  if (Array.isArray(output))
    for (const item of output) {
      const it = obj(item);
      if (it.type === "message" && Array.isArray(it.content)) {
        for (const c of it.content) if (obj(c).type === "output_text" && typeof obj(c).text === "string") texts.push(obj(c).text as string);
      } else if (it.type === "function_call") {
        const name = str(it.name);
        if (name) toolCalls.push({ id: str(it.call_id) ?? str(it.id), name, arguments: str(it.arguments) });
      }
    }
  const out: { text?: string; toolCalls?: ToolCallInfo[] } = {};
  if (texts.length) out.text = texts.join("");
  if (toolCalls.length) out.toolCalls = toolCalls;
  return out;
}

export function openaiResponsesResult(res: unknown): CallResult {
  const r = obj(res);
  const out = responsesOutput(r.output);
  const err = str(obj(r.error).message);
  const status = str(r.status);
  return done({
    ok: !err && status !== "failed",
    error: err,
    responseModel: str(r.model),
    responseId: str(r.id),
    text: out.text ?? str(r.output_text),
    toolCalls: out.toolCalls,
    usage: openaiResponsesUsage(r.usage),
    stopReason: str(obj(r.incomplete_details).reason) ?? status,
  });
}

export function anthropicResult(res: unknown): CallResult {
  const r = obj(res);
  const texts: string[] = [];
  const toolCalls: ToolCallInfo[] = [];
  if (Array.isArray(r.content))
    for (const b of r.content) {
      const block = obj(b);
      if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
      else if (block.type === "tool_use" && str(block.name)) toolCalls.push({ id: str(block.id), name: block.name as string, arguments: safeJson(block.input ?? {}) });
    }
  return done({
    ok: true,
    responseModel: str(r.model),
    responseId: str(r.id),
    text: texts.length ? texts.join("") : undefined,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    usage: anthropicUsage(r.usage),
    stopReason: str(r.stop_reason),
  });
}

export function resultFor(shape: Shape, res: unknown): CallResult {
  return shape === "chat" ? openaiChatResult(res) : shape === "responses" ? openaiResponsesResult(res) : anthropicResult(res);
}

// ---------------------------------------------------------------- streams

/** Folds stream chunks/events into a CallResult; remembers when the first token arrived. */
export interface StreamAcc {
  /** Returns true when the chunk is the usage-only chunk the SDK asked for and the caller must not see. */
  push(chunk: unknown, at: number): boolean;
  firstTokenAt?: number;
  result(): CallResult;
}

class ChatAcc implements StreamAcc {
  firstTokenAt?: number;
  private model?: string;
  private id?: string;
  private text = "";
  private usage?: Usage;
  private stop?: string;
  private tools: { id?: string; name: string; arguments: string }[] = [];
  private readonly swallowUsage: boolean;
  constructor(swallowUsage: boolean) {
    this.swallowUsage = swallowUsage;
  }

  push(chunk: unknown, at: number): boolean {
    if (!isObj(chunk)) return false;
    this.model ??= str(chunk.model);
    this.id ??= str(chunk.id);
    if (isObj(chunk.usage)) this.usage = openaiChatUsage(chunk.usage);
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    if (this.swallowUsage && choices.length === 0 && isObj(chunk.usage)) return true;
    for (const c of choices) {
      const choice = obj(c);
      if ((num(choice.index) ?? 0) !== 0) continue;
      const delta = obj(choice.delta);
      if (typeof delta.content === "string" && delta.content) {
        this.text += delta.content;
        this.firstTokenAt ??= at;
      }
      if (typeof delta.refusal === "string" && delta.refusal) {
        this.text += delta.refusal;
        this.firstTokenAt ??= at;
      }
      if (Array.isArray(delta.tool_calls)) {
        this.firstTokenAt ??= at;
        for (const t of delta.tool_calls) {
          const tc = obj(t);
          const i = num(tc.index) ?? this.tools.length;
          const slot = (this.tools[i] ??= { name: "", arguments: "" });
          if (str(tc.id)) slot.id = tc.id as string;
          const fn = obj(tc.function);
          if (typeof fn.name === "string") slot.name += fn.name;
          if (typeof fn.arguments === "string") slot.arguments += fn.arguments;
        }
      }
      if (str(choice.finish_reason)) this.stop = choice.finish_reason as string;
    }
    return false;
  }

  result(): CallResult {
    const tools = this.tools.filter((t) => t && t.name).map((t) => ({ id: t.id, name: t.name, arguments: t.arguments || undefined }));
    return done({
      ok: true,
      responseModel: this.model,
      responseId: this.id,
      text: this.text || undefined,
      toolCalls: tools.length ? tools : undefined,
      usage: this.usage,
      stopReason: this.stop,
    });
  }
}

class ResponsesAcc implements StreamAcc {
  firstTokenAt?: number;
  private text = "";
  private final?: CallResult;
  private model?: string;
  private id?: string;
  private error?: string;

  push(chunk: unknown, at: number): boolean {
    if (!isObj(chunk)) return false;
    const type = str(chunk.type) ?? "";
    const resp = obj(chunk.response);
    this.model ??= str(resp.model);
    this.id ??= str(resp.id);
    if (type === "response.output_text.delta" && typeof chunk.delta === "string") {
      this.text += chunk.delta;
      this.firstTokenAt ??= at;
    } else if (type === "response.function_call_arguments.delta" || type === "response.refusal.delta") {
      this.firstTokenAt ??= at;
    } else if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
      this.final = openaiResponsesResult(chunk.response);
    } else if (type === "error") {
      this.error = str(chunk.message) ?? str(obj(chunk.error).message) ?? "stream error";
    }
    return false;
  }

  result(): CallResult {
    const r: CallResult = this.final ? { ...this.final } : { ok: true };
    r.responseModel ??= this.model;
    r.responseId ??= this.id;
    if (!r.text && this.text) r.text = this.text;
    if (this.error) {
      r.ok = false;
      r.error = this.error;
    }
    return done(r);
  }
}

class AnthropicAcc implements StreamAcc {
  firstTokenAt?: number;
  private model?: string;
  private id?: string;
  private text = "";
  private usage: Usage = {};
  private stop?: string;
  private error?: string;
  private tools = new Map<number, { id?: string; name: string; arguments: string }>();

  push(chunk: unknown, at: number): boolean {
    if (!isObj(chunk)) return false;
    switch (chunk.type) {
      case "message_start": {
        const m = obj(chunk.message);
        this.model ??= str(m.model);
        this.id ??= str(m.id);
        anthropicUsage(m.usage, this.usage);
        break;
      }
      case "content_block_start": {
        const b = obj(chunk.content_block);
        if (b.type === "tool_use") this.tools.set(num(chunk.index) ?? this.tools.size, { id: str(b.id), name: str(b.name) ?? "", arguments: "" });
        else if (b.type === "text" && typeof b.text === "string" && b.text) {
          this.text += b.text;
          this.firstTokenAt ??= at;
        }
        break;
      }
      case "content_block_delta": {
        const d = obj(chunk.delta);
        if (d.type === "text_delta" && typeof d.text === "string") {
          this.text += d.text;
          this.firstTokenAt ??= at;
        } else if (d.type === "input_json_delta") {
          const t = this.tools.get(num(chunk.index) ?? -1);
          if (t && typeof d.partial_json === "string") t.arguments += d.partial_json;
          this.firstTokenAt ??= at;
        } else {
          this.firstTokenAt ??= at;
        }
        break;
      }
      case "message_delta": {
        this.stop = str(obj(chunk.delta).stop_reason) ?? this.stop;
        anthropicUsage(chunk.usage, this.usage);
        break;
      }
      case "error":
        this.error = str(obj(chunk.error).message) ?? "stream error";
        break;
    }
    return false;
  }

  result(): CallResult {
    const tools = [...this.tools.values()].filter((t) => t.name).map((t) => ({ id: t.id, name: t.name, arguments: t.arguments || undefined }));
    return done({
      ok: !this.error,
      error: this.error,
      responseModel: this.model,
      responseId: this.id,
      text: this.text || undefined,
      toolCalls: tools.length ? tools : undefined,
      usage: Object.keys(this.usage).length ? { ...this.usage } : undefined,
      stopReason: this.stop,
    });
  }
}

export function streamAcc(shape: Shape, swallowUsage = false): StreamAcc {
  return shape === "chat" ? new ChatAcc(swallowUsage) : shape === "responses" ? new ResponsesAcc() : new AnthropicAcc();
}
