// Provider-agnostic chat completion over plain fetch (zero dependencies):
//
//  - Anthropic Messages API (POST {baseURL}/v1/messages)
//  - OpenAI-compatible chat completions (POST {baseURL}/chat/completions):
//    OpenAI, OpenRouter, Ollama, LM Studio, vLLM, … via baseURL.
//
// API keys come from the environment only, are read at call time (so a judge
// whose answers are all cached needs no key), and are never logged, hashed
// into versions, cached, or included in errors.
import { DEFAULT_MODELS } from "../core/pricing.ts";
import { fetchJson, type FetchLike, type RetryOpts } from "./http.ts";

export interface ChatRequest {
  system: string;
  user: string;
  /** JSON Schema the reply should follow, for providers with structured outputs. */
  jsonSchema?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ChatResponse {
  text: string;
  model: string;
  stopReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface ChatProvider {
  /** "anthropic", "openai", … — part of the judge version. */
  readonly name: string;
  readonly model: string;
  /** Behavior-affecting request parameters (hashed into the judge version). Never secrets. */
  readonly params: Readonly<Record<string, unknown>>;
  complete(req: ChatRequest): Promise<ChatResponse>;
}

export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

interface CommonOpts {
  model?: string;
  baseURL?: string;
  /** Env var holding the key. */
  apiKeyEnv?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  retry?: RetryOpts;
  maxTokens?: number;
}

function readKey(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const v = env[name];
  return v && v.trim() ? v.trim() : undefined;
}

function trimSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

// ---------------------------------------------------------------- Anthropic

export const DEFAULT_ANTHROPIC_MODEL = DEFAULT_MODELS.anthropic;
export const ANTHROPIC_API_VERSION = "2026-10-21";

export interface AnthropicOpts extends CommonOpts {
  /** output_config.effort ("low" | "medium" | "high" | …). Omitted by default (model default). */
  effort?: string;
  /** Constrain the reply with output_config.format json_schema. Default true. */
  structuredOutput?: boolean;
}

/**
 * Anthropic Messages API. No `temperature` is sent: API version 2026-10-21
 * rejects sampling parameters on every model (and current models reject
 * non-default values regardless). Determinism for reruns comes from the
 * on-disk verdict cache instead.
 */
export function anthropicProvider(opts: AnthropicOpts = {}): ChatProvider {
  const model = opts.model ?? DEFAULT_ANTHROPIC_MODEL;
  const baseURL = trimSlash(opts.baseURL ?? "https://api.anthropic.com");
  const keyEnv = opts.apiKeyEnv ?? "ANTHROPIC_API_KEY";
  const maxTokens = opts.maxTokens ?? 4096;
  const structured = opts.structuredOutput ?? true;
  const params: Record<string, unknown> = { maxTokens, structuredOutput: structured, apiVersion: ANTHROPIC_API_VERSION };
  if (opts.effort) params.effort = opts.effort;
  return {
    name: "anthropic",
    model,
    params,
    async complete(req) {
      const key = readKey(opts.env ?? process.env, keyEnv);
      if (!key) throw new ProviderError(`anthropic: set ${keyEnv} to call the judge (no cached verdict for this input)`);
      const outputConfig: Record<string, unknown> = {};
      if (opts.effort) outputConfig.effort = opts.effort;
      if (structured && req.jsonSchema) outputConfig.format = { type: "json_schema", schema: req.jsonSchema };
      const body: Record<string, unknown> = {
        model,
        max_tokens: maxTokens,
        system: req.system,
        messages: [{ role: "user", content: req.user }],
      };
      if (Object.keys(outputConfig).length) body.output_config = outputConfig;
      const json = (await fetchJson(
        `${baseURL}/v1/messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": ANTHROPIC_API_VERSION },
          body: JSON.stringify(body),
        },
        { ...opts.retry, ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(req.signal ? { signal: req.signal } : {}), secrets: [key], label: "anthropic" },
      )) as {
        content?: { type: string; text?: string }[];
        model?: string;
        stop_reason?: string;
        stop_details?: { category?: string; explanation?: string } | null;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      if (json.stop_reason === "refusal") {
        const why = json.stop_details?.category ? ` (${json.stop_details.category})` : "";
        throw new ProviderError(`anthropic: model declined to judge this input${why}`);
      }
      // Thinking blocks (and anything else) are skipped; only text is the verdict.
      const text = (json.content ?? [])
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("");
      const r: ChatResponse = { text, model: json.model ?? model };
      if (json.stop_reason) r.stopReason = json.stop_reason;
      if (json.usage) r.usage = { inputTokens: json.usage.input_tokens, outputTokens: json.usage.output_tokens };
      return r;
    },
  };
}

// ---------------------------------------------------------------- OpenAI-compatible

export interface OpenAICompatOpts extends CommonOpts {
  /** Default 0. */
  temperature?: number;
  seed?: number;
  /** "json_object" / "json_schema" response_format, if the server supports it. Default: none (most portable). */
  responseFormat?: "json_object" | "json_schema";
  /** Some servers want `max_completion_tokens`. Default "max_tokens". */
  maxTokensParam?: "max_tokens" | "max_completion_tokens";
  /** Fail when the key env var is unset (default true; set false for local Ollama / LM Studio). */
  requireKey?: boolean;
  /** Name in the judge version, e.g. "openrouter" or "ollama". Default "openai". */
  name?: string;
  headers?: Record<string, string>;
}

export function openAICompatibleProvider(opts: OpenAICompatOpts = {}): ChatProvider {
  if (!opts.model) throw new ProviderError("openai-compatible provider: `model` is required (there is no portable default)");
  const model = opts.model;
  const baseURL = trimSlash(opts.baseURL ?? "https://api.openai.com/v1");
  const keyEnv = opts.apiKeyEnv ?? "OPENAI_API_KEY";
  const requireKey = opts.requireKey ?? true;
  const maxTokens = opts.maxTokens ?? 4096;
  const temperature = opts.temperature ?? 0;
  const maxParam = opts.maxTokensParam ?? "max_tokens";
  const params: Record<string, unknown> = { maxTokens, temperature, maxTokensParam: maxParam };
  if (opts.seed !== undefined) params.seed = opts.seed;
  if (opts.responseFormat) params.responseFormat = opts.responseFormat;
  const name = opts.name ?? "openai";
  return {
    name,
    model,
    params,
    async complete(req) {
      const key = readKey(opts.env ?? process.env, keyEnv);
      if (!key && requireKey) throw new ProviderError(`${name}: set ${keyEnv} to call the judge (no cached verdict for this input)`);
      const body: Record<string, unknown> = {
        model,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
        temperature,
        [maxParam]: maxTokens,
      };
      if (opts.seed !== undefined) body.seed = opts.seed;
      if (opts.responseFormat === "json_object") body.response_format = { type: "json_object" };
      else if (opts.responseFormat === "json_schema" && req.jsonSchema) {
        body.response_format = { type: "json_schema", json_schema: { name: "verdict", schema: req.jsonSchema, strict: true } };
      }
      const headers: Record<string, string> = { "content-type": "application/json", ...(opts.headers ?? {}) };
      if (key) headers.authorization = `Bearer ${key}`;
      const json = (await fetchJson(
        `${baseURL}/chat/completions`,
        { method: "POST", headers, body: JSON.stringify(body) },
        { ...opts.retry, ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(req.signal ? { signal: req.signal } : {}), secrets: [key], label: name },
      )) as {
        choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }[];
        model?: string;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const choice = json.choices?.[0];
      if (choice?.message?.refusal) throw new ProviderError(`${name}: model declined to judge this input`);
      const r: ChatResponse = { text: choice?.message?.content ?? "", model: json.model ?? model };
      if (choice?.finish_reason) r.stopReason = choice.finish_reason;
      if (json.usage) r.usage = { inputTokens: json.usage.prompt_tokens, outputTokens: json.usage.completion_tokens };
      return r;
    },
  };
}
