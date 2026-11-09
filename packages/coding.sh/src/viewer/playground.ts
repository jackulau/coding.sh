// The LLM-call playground (coding.sh ui): a captured llm.call rebuilt as a
// provider-neutral request (system, NeutralMessages, tools, settings), edited
// in the viewer, run again against a configured provider, and saved as a
// dataset case that a `continuation` task can replay.
//
// The request comes from the proxy's stored request blob when there is one
// (Anthropic Messages, OpenAI chat completions or Responses), else from the
// session's events before the call (eval/decision.ts freezePrefix). Running
// renders it back with the X-1 bodies (experiments/continuation.ts), so what
// the playground sends is what a continuation experiment would send.
import type { BlobStore, IndexStore } from "../core/types.ts";
import { costFrom, lookupPrice, pricesFor, type Prices } from "../core/pricing.ts";
import { createRedactor } from "../core/redact.ts";
import { addCases, createDataset, normalizeCase, slugify } from "../datasets/dataset.ts";
import type { Case, Dataset } from "../datasets/types.ts";
import { freezePrefix } from "../eval/decision.ts";
import { anthropicBody, openAIChatBody, openAIResponsesBody, parseResponse, prefixProblems, type FrozenPrefix, type NeutralMessage, type ToolCall, type ToolDef } from "../experiments/continuation.ts";
import { fetchJson, type FetchLike } from "../judge/http.ts";
import { ANTHROPIC_API_VERSION } from "../judge/providers.ts";
import { loadCall, type LoadedCall } from "../proxy/calls.ts";
import type { AgentEvent } from "../schema/index.ts";

export class PlaygroundError extends Error {
  readonly reason: string;
  readonly status: number;
  constructor(message: string, reason: string, status = 400) {
    super(message);
    this.name = "PlaygroundError";
    this.reason = reason;
    this.status = status;
  }
}

/** A model call as the playground edits it: everything needed to send it again, in no provider's format. */
export interface PlaygroundRequest {
  model: string;
  system: string;
  messages: NeutralMessage[];
  tools: ToolDef[];
  maxTokens: number;
  temperature?: number;
}

/** Wire formats the playground can send. */
export type PlaygroundApi = "anthropic" | "openai" | "openai-compatible";

export interface PlaygroundProvider {
  /** anthropic (Messages), openai (Responses) or openai-compatible (chat completions). */
  id: PlaygroundApi;
  label: string;
  baseURL: string;
  /** The env var holding the key. */
  keyEnv: string;
  /** A key is set, or the endpoint is on this machine (no key needed). */
  ready: boolean;
}

export interface Rebuilt {
  call: { id: string; sessionId: string; ts: number; model?: string; provider?: string; api?: string };
  /** request: the proxy's stored request; transcript: the session's events before the call. */
  source: "request" | "transcript";
  request: PlaygroundRequest;
  /** What the call answered, when the response was stored. */
  response?: PlaygroundOutput;
  /** The provider that fits the call's own format. */
  provider?: PlaygroundApi;
}

export interface PlaygroundOutput {
  text: string;
  toolCalls: ToolCall[];
  stopReason?: string;
  model?: string;
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; costUsd?: number };
}

export interface PlaygroundRun extends PlaygroundOutput {
  provider: PlaygroundApi;
  latencyMs: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export const DEFAULT_MAX_TOKENS = 1024;
/** Caps on what one POST may carry: a pasted request, not a bulk upload. */
export const MAX_MESSAGES = 2000;
export const MAX_REQUEST_CHARS = 4_000_000;

// ---------------------------------------------------------------- rebuild

/** Text of a content value: a string, or the text of its text-like blocks. Images and files become a marker. */
function textOf(v: unknown): string {
  if (typeof v === "string") return v;
  if (!Array.isArray(v)) return v === undefined || v === null ? "" : JSON.stringify(v);
  const out: string[] = [];
  for (const b of v) {
    if (typeof b === "string") out.push(b);
    else if (isObj(b)) {
      if (typeof b.text === "string") out.push(b.text);
      else if (b.type === "image" || b.type === "image_url" || b.type === "input_image") out.push("[image]");
      else if (b.type === "document" || b.type === "file" || b.type === "input_file") out.push("[file]");
    }
  }
  return out.join("\n\n");
}

const parseArgs = (s: unknown): unknown => {
  if (typeof s !== "string") return s ?? {};
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return s;
  }
};

/** Anthropic Messages: tool_use blocks become calls, tool_result blocks become tool messages (thinking is left out). */
function fromAnthropic(body: Record<string, unknown>): Pick<PlaygroundRequest, "system" | "messages" | "tools"> {
  const messages: NeutralMessage[] = [];
  const names = new Map<string, string>();
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    if (!isObj(m)) continue;
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? m.content : [];
    if (m.role === "assistant") {
      const text = textOf(blocks.filter((b) => isObj(b) && b.type === "text"));
      const toolCalls: ToolCall[] = [];
      for (const b of blocks) {
        if (isObj(b) && b.type === "tool_use" && typeof b.name === "string") {
          const id = String(b.id ?? `call_${names.size}`);
          names.set(id, b.name);
          toolCalls.push({ id, name: b.name, input: b.input ?? {} });
        }
      }
      if (text || toolCalls.length) messages.push({ role: "assistant", ...(text ? { text } : {}), ...(toolCalls.length ? { toolCalls } : {}) });
      continue;
    }
    const rest: unknown[] = [];
    for (const b of blocks) {
      if (isObj(b) && b.type === "tool_result") {
        const id = String(b.tool_use_id ?? "");
        messages.push({ role: "tool", toolUseId: id, name: names.get(id) ?? "tool", content: textOf(b.content), ...(b.is_error === true ? { isError: true } : {}) });
      } else rest.push(b);
    }
    const text = textOf(rest);
    if (text) messages.push({ role: "user", text });
  }
  const tools: ToolDef[] = [];
  for (const t of Array.isArray(body.tools) ? body.tools : []) {
    if (isObj(t) && typeof t.name === "string") tools.push({ name: t.name, ...(str(t.description) ? { description: str(t.description)! } : {}), ...(isObj(t.input_schema) ? { inputSchema: t.input_schema } : {}) });
  }
  return { system: textOf(body.system), messages, tools };
}

/** OpenAI chat completions: system and developer messages join the system prompt. */
function fromChat(body: Record<string, unknown>): Pick<PlaygroundRequest, "system" | "messages" | "tools"> {
  const system: string[] = [];
  const messages: NeutralMessage[] = [];
  const names = new Map<string, string>();
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    if (!isObj(m)) continue;
    if (m.role === "system" || m.role === "developer") system.push(textOf(m.content));
    else if (m.role === "user") messages.push({ role: "user", text: textOf(m.content) });
    else if (m.role === "tool") {
      const id = String(m.tool_call_id ?? "");
      messages.push({ role: "tool", toolUseId: id, name: names.get(id) ?? str(m.name) ?? "tool", content: textOf(m.content) });
    } else if (m.role === "assistant") {
      const text = textOf(m.content);
      const toolCalls: ToolCall[] = [];
      for (const c of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        if (!isObj(c) || !isObj(c.function) || typeof c.function.name !== "string") continue;
        const id = String(c.id ?? `call_${names.size}`);
        names.set(id, c.function.name);
        toolCalls.push({ id, name: c.function.name, input: parseArgs(c.function.arguments) });
      }
      if (text || toolCalls.length) messages.push({ role: "assistant", ...(text ? { text } : {}), ...(toolCalls.length ? { toolCalls } : {}) });
    }
  }
  return { system: system.filter(Boolean).join("\n\n"), messages, tools: openAITools(body.tools) };
}

/** OpenAI Responses: instructions, then message, function_call and function_call_output items. */
function fromResponses(body: Record<string, unknown>): Pick<PlaygroundRequest, "system" | "messages" | "tools"> {
  const system: string[] = [];
  if (typeof body.instructions === "string") system.push(body.instructions);
  const messages: NeutralMessage[] = [];
  const names = new Map<string, string>();
  const items = typeof body.input === "string" ? [{ role: "user", content: body.input }] : Array.isArray(body.input) ? body.input : [];
  let open: Extract<NeutralMessage, { role: "assistant" }> | undefined;
  for (const it of items) {
    if (!isObj(it)) continue;
    if (it.type === "function_call" && typeof it.name === "string") {
      const id = String(it.call_id ?? it.id ?? `call_${names.size}`);
      names.set(id, it.name);
      if (!open) messages.push((open = { role: "assistant" }));
      (open.toolCalls ??= []).push({ id, name: it.name, input: parseArgs(it.arguments) });
      continue;
    }
    if (it.type === "function_call_output") {
      const id = String(it.call_id ?? "");
      messages.push({ role: "tool", toolUseId: id, name: names.get(id) ?? "tool", content: textOf(it.output) });
      open = undefined;
      continue;
    }
    if (it.type === "reasoning") continue;
    const role = it.role;
    const text = textOf(it.content);
    if (role === "system" || role === "developer") system.push(text);
    else if (role === "assistant") {
      if (open && !open.toolCalls?.length) open.text = open.text ? `${open.text}\n\n${text}` : text;
      else messages.push((open = { role: "assistant", text }));
    } else if (role === "user") {
      messages.push({ role: "user", text });
      open = undefined;
    }
  }
  return { system: system.filter(Boolean).join("\n\n"), messages, tools: openAITools(body.tools) };
}

function openAITools(v: unknown): ToolDef[] {
  const tools: ToolDef[] = [];
  for (const t of Array.isArray(v) ? v : []) {
    if (!isObj(t)) continue;
    const f = isObj(t.function) ? t.function : t;
    if (typeof f.name !== "string") continue;
    tools.push({ name: f.name, ...(str(f.description) ? { description: str(f.description)! } : {}), ...(isObj(f.parameters) ? { inputSchema: f.parameters } : {}) });
  }
  return tools;
}

/** A stored request body, in its API's shape, as a PlaygroundRequest. */
export function requestFromBody(api: string, body: Record<string, unknown>): PlaygroundRequest {
  const parts = api === "messages" ? fromAnthropic(body) : api === "responses" ? fromResponses(body) : fromChat(body);
  const maxTokens = num(body.max_tokens) ?? num(body.max_completion_tokens) ?? num(body.max_output_tokens) ?? DEFAULT_MAX_TOKENS;
  const temperature = num(body.temperature);
  return { model: str(body.model) ?? "", ...parts, maxTokens, ...(temperature !== undefined ? { temperature } : {}) };
}

/** The provider whose wire format the call used. */
function providerOfCall(c: LoadedCall): PlaygroundApi | undefined {
  const api = c.request?.api ?? str(c.event.payload.api);
  const provider = c.request?.provider ?? str(c.event.payload.provider);
  if (api === "messages" || provider === "anthropic") return "anthropic";
  if (api === "responses") return "openai";
  if (api === "chat" || provider === "openai") return "openai-compatible";
  return undefined;
}

/** A stored response, parsed the way a run's is. */
function outputOf(c: LoadedCall, provider: PlaygroundApi | undefined): PlaygroundOutput | undefined {
  const body = c.response?.body;
  if (!provider || !isObj(body)) return undefined;
  const p = parseResponse(provider, body, c.event.model ?? "");
  if (!p.text && !p.toolCalls.length) return undefined;
  return { text: p.text, toolCalls: p.toolCalls, ...(p.stopReason ? { stopReason: p.stopReason } : {}), ...(p.model ? { model: p.model } : {}), usage: p.usage };
}

/**
 * One llm.call rebuilt for the playground. The proxy's stored request when it
 * is there; else the conversation up to the call, from the session's events.
 * Everything taken from the store passes the redactor again.
 */
export async function rebuildCall(index: IndexStore, blobs: BlobStore, event: AgentEvent): Promise<Rebuilt> {
  if (event.kind !== "llm.call") throw new PlaygroundError("not a model call", "not_a_call");
  const red = createRedactor();
  const loaded = await loadCall(blobs, event);
  const provider = providerOfCall(loaded);
  const call: Rebuilt["call"] = {
    id: event.id,
    sessionId: event.sessionId,
    ts: event.ts,
    ...(event.model ? { model: event.model } : {}),
    ...(str(event.payload.provider) ? { provider: str(event.payload.provider)! } : {}),
    ...(loaded.request?.api ? { api: loaded.request.api } : {}),
  };
  if (loaded.request && (loaded.request.api === "messages" || loaded.request.api === "chat" || loaded.request.api === "responses")) {
    const request = red.value(requestFromBody(loaded.request.api, loaded.request.body));
    if (!request.model) request.model = event.model ?? "";
    const response = outputOf(loaded, provider);
    return { call, source: "request", request, ...(response ? { response: red.value(response) } : {}), ...(provider ? { provider } : {}) };
  }
  const events = await index.listEvents(event.sessionId);
  const prefix = await freezePrefix(events, event.id, blobs, { redact: red });
  if (!prefix.messages.some((m) => m.role === "user")) throw new PlaygroundError("This call has no stored request and no prompt before it to rebuild one from", "no_request", 404);
  const request: PlaygroundRequest = { model: event.model ?? prefix.model ?? "", system: "", messages: prefix.messages, tools: prefix.tools, maxTokens: DEFAULT_MAX_TOKENS };
  return { call, source: "transcript", request, ...(provider ? { provider } : {}) };
}

// ---------------------------------------------------------------- validate

/** A PlaygroundRequest from a POST body, or a PlaygroundError naming the first problem. */
export function parseRequest(raw: unknown): PlaygroundRequest {
  if (!isObj(raw)) throw new PlaygroundError("request must be an object", "invalid_request");
  if (typeof raw.model !== "string" || !raw.model.trim()) throw new PlaygroundError("request.model is required", "invalid_request");
  if (raw.system !== undefined && typeof raw.system !== "string") throw new PlaygroundError("request.system must be a string", "invalid_request");
  if (!Array.isArray(raw.messages) || !raw.messages.length) throw new PlaygroundError("request.messages must be a non-empty array", "invalid_request");
  if (raw.messages.length > MAX_MESSAGES) throw new PlaygroundError(`request.messages holds at most ${MAX_MESSAGES} messages`, "invalid_request");
  const tools = raw.tools === undefined ? [] : raw.tools;
  // prefixProblems checks the messages and tools the way a continuation case's input is checked.
  // It must not end on the assistant's turn: the run asks for the next one.
  const problems = prefixProblems({ v: 1, tools, messages: raw.messages });
  if (problems.length) throw new PlaygroundError(`request: ${problems[0]}`, "invalid_request");
  const maxTokens = raw.maxTokens === undefined ? DEFAULT_MAX_TOKENS : raw.maxTokens;
  if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 200_000) throw new PlaygroundError("request.maxTokens must be an integer from 1 to 200000", "invalid_request");
  if (raw.temperature !== undefined && (typeof raw.temperature !== "number" || raw.temperature < 0 || raw.temperature > 2)) throw new PlaygroundError("request.temperature must be a number from 0 to 2", "invalid_request");
  if (!Array.isArray(tools) || !tools.every((t) => isObj(t) && typeof t.name === "string" && t.name)) throw new PlaygroundError("request.tools must be objects with a name", "invalid_request");
  if (JSON.stringify(raw).length > MAX_REQUEST_CHARS) throw new PlaygroundError(`request is over ${MAX_REQUEST_CHARS} characters`, "invalid_request");
  return {
    model: raw.model.trim(),
    system: (raw.system as string | undefined) ?? "",
    messages: raw.messages as NeutralMessage[],
    tools: tools as ToolDef[],
    maxTokens,
    ...(typeof raw.temperature === "number" ? { temperature: raw.temperature } : {}),
  };
}

// ---------------------------------------------------------------- providers

const LOCAL_BASE = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/;

/** The providers this machine can call, from the same env vars continuation tasks read. */
export function playgroundProviders(env: NodeJS.ProcessEnv): PlaygroundProvider[] {
  const anthropic = (env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com").replace(/\/+$/, "");
  const openai = (env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
  const ready = (base: string, key: string) => !!env[key]?.trim() || LOCAL_BASE.test(base);
  return [
    { id: "anthropic", label: "Anthropic Messages", baseURL: anthropic, keyEnv: "ANTHROPIC_API_KEY", ready: ready(anthropic, "ANTHROPIC_API_KEY") },
    { id: "openai", label: "OpenAI Responses", baseURL: openai, keyEnv: "OPENAI_API_KEY", ready: ready(openai, "OPENAI_API_KEY") },
    { id: "openai-compatible", label: "OpenAI-compatible chat", baseURL: openai, keyEnv: "OPENAI_API_KEY", ready: ready(openai, "OPENAI_API_KEY") },
  ];
}

/** The provider-format body the run sends. */
export function renderBody(provider: PlaygroundApi, r: PlaygroundRequest): Record<string, unknown> {
  const prefix: FrozenPrefix = { v: 1, tools: r.tools, messages: r.messages };
  const opts = { model: r.model, system: r.system, firstUser: "", tools: r.tools, maxOutputTokens: r.maxTokens, ...(r.temperature !== undefined ? { temperature: r.temperature } : {}) };
  if (provider === "anthropic") {
    const body = anthropicBody(prefix, opts);
    if (!r.system) delete body.system;
    if (r.temperature !== undefined) body.temperature = r.temperature;
    return body;
  }
  if (provider === "openai") {
    const body = openAIResponsesBody(prefix, opts);
    if (!r.system) delete body.instructions;
    return body;
  }
  const body = openAIChatBody(prefix, opts);
  if (!r.system) (body.messages as unknown[]).shift();
  return body;
}

export interface RunOpts {
  env: NodeJS.ProcessEnv;
  prices?: Prices;
  fetch?: FetchLike;
  signal?: AbortSignal;
  now?: () => number;
}

/** Sends the request once to the provider and parses the answer. No retries past fetchJson's, no cache. */
export async function runPlayground(providerId: string, r: PlaygroundRequest, o: RunOpts): Promise<PlaygroundRun> {
  const provider = playgroundProviders(o.env).find((p) => p.id === providerId);
  if (!provider) throw new PlaygroundError(`provider must be one of anthropic, openai, openai-compatible`, "invalid_request");
  const key = o.env[provider.keyEnv]?.trim();
  if (!provider.ready) throw new PlaygroundError(`Set ${provider.keyEnv} (or a local ${provider.id === "anthropic" ? "ANTHROPIC_BASE_URL" : "OPENAI_BASE_URL"}) where coding.sh ui runs, then restart it`, "missing_api_key");
  const url = provider.id === "anthropic" ? `${provider.baseURL}/v1/messages` : provider.id === "openai" ? `${provider.baseURL}/responses` : `${provider.baseURL}/chat/completions`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (provider.id === "anthropic") {
    headers["anthropic-version"] = ANTHROPIC_API_VERSION;
    if (key) headers["x-api-key"] = key;
  } else if (key) headers.authorization = `Bearer ${key}`;
  const now = o.now ?? Date.now;
  const t0 = now();
  let json: unknown;
  try {
    json = await fetchJson(url, { method: "POST", headers, body: JSON.stringify(renderBody(provider.id, r)) }, { retries: 0, secrets: [key], label: provider.label, ...(o.fetch ? { fetch: o.fetch } : {}), ...(o.signal ? { signal: o.signal } : {}) });
  } catch (e) {
    throw new PlaygroundError(e instanceof Error ? e.message : String(e), "provider_error", 502);
  }
  const p = parseResponse(provider.id, json, r.model);
  const price = lookupPrice(p.model, o.prices ?? pricesFor()) ?? lookupPrice(r.model, o.prices ?? pricesFor());
  const usage = { ...p.usage, ...(price ? { costUsd: costFrom(p.usage, price) } : {}) };
  return { provider: provider.id, text: p.text, toolCalls: p.toolCalls, ...(p.stopReason ? { stopReason: p.stopReason } : {}), model: p.model, usage, latencyMs: Math.max(0, now() - t0) };
}

// ---------------------------------------------------------------- save

/** The dataset store calls the playground saves through (FileEvalStore fits). */
export interface PlaygroundDatasets {
  getDataset(id: string, version?: string): Promise<Dataset | undefined>;
  putDataset(ds: Dataset, opts?: { note?: string }): Promise<{ version: string; created: boolean }>;
  listDatasets(): Promise<{ id: string; name: string; latest: string; cases: number }[]>;
}

export interface SaveInput {
  dataset: string;
  request: PlaygroundRequest;
  /** The answer to keep as the case's expected output: a run's, the recorded one, or text typed in. */
  expected?: unknown;
  sessionId?: string;
  callId?: string;
  tags?: string[];
}

/**
 * Adds the request as a case: input is a continuation prefix (so `exp run` with a
 * continuation task replays it), the system prompt and settings go in metadata.
 * Creates the dataset when it does not exist. Returns the new version.
 */
export async function saveCase(store: PlaygroundDatasets, s: SaveInput): Promise<{ datasetId: string; name: string; version: string; caseId: string; cases: number; created: boolean }> {
  const name = s.dataset.trim();
  if (!name || name.length > 120) throw new PlaygroundError("dataset must be a name of 1 to 120 characters", "invalid_request");
  let id: string;
  try {
    id = slugify(name);
  } catch {
    throw new PlaygroundError("dataset needs a letter or digit in its name", "invalid_request");
  }
  const red = createRedactor();
  const input: FrozenPrefix = red.value({ v: 1, model: s.request.model, tools: s.request.tools, messages: s.request.messages });
  const metadata: Record<string, unknown> = { source: "playground", maxTokens: s.request.maxTokens };
  if (s.request.system) metadata.system = red.string(s.request.system);
  if (s.request.temperature !== undefined) metadata.temperature = s.request.temperature;
  if (s.callId) metadata.callId = s.callId;
  const c: Case = normalizeCase({
    input,
    ...(s.expected !== undefined && s.expected !== null && s.expected !== "" ? { expected: red.value(s.expected) } : {}),
    metadata,
    tags: ["playground", ...(s.tags ?? [])],
    ...(s.sessionId ? { sourceSessionId: s.sessionId } : {}),
  });
  const existing = await store.getDataset(id);
  const ds = existing ? addCases(existing, [c]) : createDataset({ name, cases: [c] });
  const { version, created } = await store.putDataset(ds, { note: `playground: added ${c.id}` });
  return { datasetId: ds.id, name: ds.name, version, caseId: c.id, cases: ds.cases.length, created };
}

/** The viewer's playground (`coding.sh ui`): providers from this machine's env, saves to its dataset store. */
export interface PlaygroundSource {
  providers(): PlaygroundProvider[];
  datasets(): Promise<{ id: string; name: string; latest: string; cases: number }[]>;
  run(provider: string, r: PlaygroundRequest, signal?: AbortSignal): Promise<PlaygroundRun>;
  save(s: SaveInput): ReturnType<typeof saveCase>;
}

export function viewerPlayground(o: { env: NodeJS.ProcessEnv; datasets: PlaygroundDatasets; prices?: Prices; fetch?: FetchLike }): PlaygroundSource {
  return {
    providers: () => playgroundProviders(o.env),
    datasets: () => o.datasets.listDatasets(),
    run: (provider, r, signal) => runPlayground(provider, r, { env: o.env, ...(o.prices ? { prices: o.prices } : {}), ...(o.fetch ? { fetch: o.fetch } : {}), ...(signal ? { signal } : {}) }),
    save: (s) => saveCase(o.datasets, s),
  };
}
