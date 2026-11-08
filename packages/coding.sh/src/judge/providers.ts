// Provider-agnostic chat completion (zero dependencies):
//
//  - Anthropic Messages API (POST {baseURL}/v1/messages)
//  - OpenAI-compatible chat completions (POST {baseURL}/chat/completions):
//    OpenAI, OpenRouter, Ollama, LM Studio, vLLM, … via baseURL.
//  - The Claude Code CLI (`claude -p`), for a Claude subscription without an API key.
//
// API keys come from the environment only, are read at call time (so a judge
// whose answers are all cached needs no key), and are never logged, hashed
// into versions, cached, or included in errors.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MODELS } from "../core/pricing.ts";
import { spawn } from "../core/spawn.ts";
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

/** The base URL: the option, else the env var the vendor's own SDKs read (a proxy, gateway or local stub), else the vendor's. */
function baseFrom(opts: CommonOpts, envVar: string, fallback: string): string {
  return trimSlash(opts.baseURL ?? readKey(opts.env ?? process.env, envVar) ?? fallback);
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
  const baseURL = baseFrom(opts, "ANTHROPIC_BASE_URL", "https://api.anthropic.com");
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

// ---------------------------------------------------------------- Claude Code

export interface ClaudeCodeOpts {
  model?: string;
  env?: NodeJS.ProcessEnv;
  /** The CLI to run (default "claude", found on PATH). */
  command?: string;
  /** Kill the call after this long (default 5 min). */
  timeoutMs?: number;
}

/**
 * The judge through the Claude Code CLI (`claude -p`), so a Claude subscription
 * can grade without an API key: auth is whatever the CLI uses
 * (CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`, ANTHROPIC_API_KEY, or its
 * login). Each call runs with no tools, no setting sources (so no user or project
 * hooks, plugins or MCP servers reach the judge), no saved session, in an empty
 * temp directory, and asks for the verdict schema with --json-schema.
 */
export function claudeCodeProvider(opts: ClaudeCodeOpts = {}): ChatProvider {
  const model = opts.model ?? DEFAULT_ANTHROPIC_MODEL;
  const command = opts.command ?? "claude";
  const timeoutMs = opts.timeoutMs ?? 300_000;
  return {
    name: "claude-code",
    model,
    params: { structuredOutput: true },
    async complete(req) {
      const args = ["-p", "--output-format", "json", "--model", model, "--system-prompt", req.system, "--tools", "", "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands"];
      if (req.jsonSchema) args.push("--json-schema", JSON.stringify(req.jsonSchema));
      const cwd = await mkdtemp(join(tmpdir(), "csh-judge-"));
      try {
        const out = await runCli(command, args, req.user, { cwd, env: opts.env ?? process.env, timeoutMs, ...(req.signal ? { signal: req.signal } : {}) });
        let json: {
          is_error?: boolean;
          result?: unknown;
          structured_output?: unknown;
          stop_reason?: string;
          usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
          modelUsage?: Record<string, unknown>;
        };
        try {
          json = JSON.parse(out.stdout.trim().split("\n").pop() ?? "");
        } catch {
          throw new ProviderError(`claude-code: \`${command} -p\` exited ${out.code} without a JSON result${clipErr(out.stderr)}`);
        }
        if (json.is_error || out.code !== 0) {
          throw new ProviderError(`claude-code: \`${command} -p\` failed: ${clip(typeof json.result === "string" ? json.result : out.stderr, 300) || `exit ${out.code}`}`);
        }
        const text = json.structured_output !== undefined && json.structured_output !== null ? JSON.stringify(json.structured_output) : typeof json.result === "string" ? json.result : "";
        const r: ChatResponse = { text, model: Object.keys(json.modelUsage ?? {})[0] ?? model };
        if (json.stop_reason) r.stopReason = json.stop_reason;
        const u = json.usage;
        if (u) r.usage = { inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), outputTokens: u.output_tokens };
        return r;
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
  };
}

function clip(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function clipErr(stderr: string): string {
  const t = clip(stderr, 300);
  return t ? `: ${t}` : "";
}

function runCli(
  command: string,
  args: string[],
  stdin: string,
  o: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      reject(new ProviderError(`claude-code: could not run \`${command}\`: ${(e as Error).message}`));
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const stop = () => child.kill();
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, o.timeoutMs);
    o.signal?.addEventListener("abort", stop, { once: true });
    child.stdout!.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr!.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new ProviderError(e.code === "ENOENT" ? `claude-code: \`${command}\` is not on PATH (install Claude Code, or use another provider)` : `claude-code: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", stop);
      if (o.signal?.aborted) reject(new ProviderError("claude-code: aborted"));
      else if (timedOut) reject(new ProviderError(`claude-code: no answer within ${Math.round(o.timeoutMs / 1000)} s`));
      else resolvePromise({ code, stdout, stderr });
    });
    child.stdin!.on("error", () => {});
    child.stdin!.end(stdin);
  });
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
  // OPENAI_BASE_URL only for OpenAI itself: a named endpoint (gateway, Ollama, …) passes its own.
  const baseURL = opts.name && opts.name !== "openai" ? trimSlash(opts.baseURL ?? "https://api.openai.com/v1") : baseFrom(opts, "OPENAI_BASE_URL", "https://api.openai.com/v1");
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
