// Next-turn continuation task (X-1, TraceDance arXiv 2609.33295): freeze a
// recorded session at a decision point and ask a model for its next turn only.
// The prefix keeps the user and harness input, assistant messages, tool calls
// and tool results; reasoning is dropped. Tools are never executed and nothing
// needs an environment, so one case costs one model call.
//
// The harness under test is a set of context files (CLAUDE.md, AGENTS.md,
// rules, skills) injected the way the agent would see them: always-on files in
// full, a path-scoped rule only when the prefix touched a matching file, a
// skill as a one-line listing unless the prefix opened it.
//
// Most agents don't record their system prompt, so absolute pass rates are
// approximate; the deltas between two harnesses on the same prefixes are what
// count. A control arm (EM-19) runs the recorded config from the same prefix:
// how often it diverges from what the agent actually did is the replay noise
// floor (replayNoise below), reported beside every delta.
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { harnessItem, itemExposure, parseFrontmatter, type ExposureEvent, type ExposureState } from "../core/exposure.ts";
import { sha256Hex } from "../core/ids.ts";
import { paths } from "../core/paths.ts";
import { costFrom, lookupPrice, pricesFor, type Prices } from "../core/pricing.ts";
import { commandOf } from "../core/sessions.ts";
import { canonicalJson } from "../datasets/hash.ts";
import { writeFileAtomic } from "../datasets/store.ts";
import type { Case, CaseRun, ExperimentResult, TraceEvent } from "../datasets/types.ts";
import { fetchJson, type FetchLike, type RetryOpts } from "../judge/http.ts";
import { ANTHROPIC_API_VERSION, DEFAULT_ANTHROPIC_MODEL } from "../judge/providers.ts";
import { CLAUDE_CODE_TOOLS, cliComplete, isCliProvider, type CliLimiter, type CliProvider } from "../judge/subscription.ts";
import { wilson } from "../stats/interval.ts";
import { withTrace } from "./run.ts";
import { TaskError, type ResolvedTask, type TaskContext } from "./task.ts";

// ---------------------------------------------------------------- prefix

export interface ToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export type NeutralMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text?: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolUseId: string; name: string; content: string; isError?: boolean };

/** A recorded session cut before a decision: everything the agent had seen, nothing it did next. */
export interface FrozenPrefix {
  v: 1;
  agent?: string;
  model?: string;
  cwd?: string;
  tools: ToolDef[];
  messages: NeutralMessage[];
  /** Whole turns dropped from the middle to fit the size cap. */
  elidedTurns?: number;
}

/** What a turn did first: a tool call (name and input) or a text-only reply. */
export type FirstAction = { type: "tool"; name: string; input?: unknown } | { type: "text" };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * The problems that make a prefix unusable, in message order; empty when it is
 * valid. A prefix must have messages, must not end on an assistant message
 * (the next turn would be the model's own continuation), every tool call needs
 * its result before the next turn, and every tool result needs its call.
 */
export function prefixProblems(raw: unknown): string[] {
  if (!isObj(raw)) return ["the prefix is not an object"];
  if (raw.v !== 1) return [`unsupported prefix version ${JSON.stringify(raw.v)} (expected 1)`];
  if (!Array.isArray(raw.messages)) return ["the prefix has no messages array"];
  if (raw.tools !== undefined && !Array.isArray(raw.tools)) return ["tools must be an array"];
  const msgs = raw.messages as unknown[];
  if (!msgs.length) return ["the prefix is empty"];
  const out: string[] = [];
  let pending = new Map<string, string>();
  const closeTurn = (at: number) => {
    for (const [id, name] of pending) out.push(`message ${at}: tool call ${name} (${id}) has no result before the next turn`);
    pending = new Map();
  };
  msgs.forEach((m, i) => {
    if (!isObj(m)) {
      out.push(`message ${i}: not an object`);
      return;
    }
    if (m.role === "user") {
      if (typeof m.text !== "string") out.push(`message ${i}: user text must be a string`);
      closeTurn(i);
    } else if (m.role === "assistant") {
      closeTurn(i);
      if (m.text !== undefined && typeof m.text !== "string") out.push(`message ${i}: assistant text must be a string`);
      if (m.toolCalls !== undefined && !Array.isArray(m.toolCalls)) out.push(`message ${i}: toolCalls must be an array`);
      for (const c of (Array.isArray(m.toolCalls) ? m.toolCalls : []) as unknown[]) {
        if (!isObj(c) || typeof c.id !== "string" || !c.id || typeof c.name !== "string" || !c.name) {
          out.push(`message ${i}: a tool call needs a string id and name`);
          continue;
        }
        pending.set(c.id, c.name);
      }
    } else if (m.role === "tool") {
      const id = m.toolUseId;
      if (typeof id !== "string" || !pending.has(id)) out.push(`message ${i}: orphan tool result ${JSON.stringify(id)} (no open call with that id)`);
      else pending.delete(id);
      if (typeof m.content !== "string") out.push(`message ${i}: tool content must be a string`);
    } else out.push(`message ${i}: unknown role ${JSON.stringify(m.role)}`);
  });
  const last = msgs[msgs.length - 1];
  if (isObj(last) && last.role === "assistant") out.push("the prefix ends on an assistant message; cut before it so the next turn is the model's to make");
  else closeTurn(msgs.length);
  return out;
}

/** The prefix, or a TaskError naming what is wrong with it. */
export function validatePrefix(raw: unknown): FrozenPrefix {
  const problems = prefixProblems(raw);
  if (problems.length) throw new TaskError(`invalid prefix: ${problems.slice(0, 3).join("; ")}${problems.length > 3 ? ` (+${problems.length - 3} more)` : ""}`);
  return raw as FrozenPrefix;
}

/** The prefix as exposure events (core/exposure.ts): user messages and tool calls, ids p<index>. */
export function prefixEvents(p: FrozenPrefix): ExposureEvent[] {
  const out: ExposureEvent[] = [];
  p.messages.forEach((m, i) => {
    const cwd = p.cwd ? { cwd: p.cwd } : {};
    if (m.role === "user") out.push({ id: `p${i}`, kind: "user.message", payload: { text: m.text }, ...cwd });
    else if (m.role === "assistant") for (const c of m.toolCalls ?? []) out.push({ id: `p${i}:${c.id}`, kind: "tool.start", payload: { tool: c.name, input: c.input }, ...cwd });
  });
  return out;
}

// ---------------------------------------------------------------- context files

/** One harness file under test: its path (as the agent would see it) and its text. */
export interface ContextFile {
  path: string;
  text: string;
}

export interface ContinuationContext {
  /** File paths (read when the task is resolved, relative to `cwd`) or {path, text}. */
  files: readonly (string | ContextFile)[];
  /** first-user (default): a <system-reminder> block before the first user message, the way Claude Code injects CLAUDE.md. system: appended to the system prompt. */
  placement?: "first-user" | "system";
}

/** How a context file reached the prompt for one prefix. */
export interface InjectedFile {
  path: string;
  /** full: the whole text; listed: a skill's name and description only. */
  how: "full" | "listed";
  text: string;
  exposure: ExposureState;
}

/**
 * Which context files reach the model for this prefix, and how: always-on
 * files (CLAUDE.md, AGENTS.md, rules without paths) in full; a path-scoped
 * rule only when the prefix touched a matching file; a skill listed by name
 * and description unless the prefix opened it. Files that are not instruction
 * items (any other path) always go in full.
 */
export function injectContext(files: readonly ContextFile[], p: FrozenPrefix): InjectedFile[] {
  const events = prefixEvents(p);
  const out: InjectedFile[] = [];
  for (const f of files) {
    const item = harnessItem(f.path, f.text);
    if (!item) {
      out.push({ path: f.path, how: "full", text: f.text, exposure: "in-context" });
      continue;
    }
    // A prefix with no events at all still had its always-on files.
    const x = item.tier === "always" && item.kind !== "skill" ? ("in-context" as const) : itemExposure(item, events, p.cwd ? { cwd: p.cwd } : {}).state;
    if (x === "in-context") out.push({ path: f.path, how: "full", text: f.text, exposure: x });
    else if (item.kind === "skill" && item.tier === "always") {
      const fm = parseFrontmatter(f.text).data;
      const desc = typeof fm.description === "string" ? fm.description : "";
      out.push({ path: f.path, how: "listed", text: `- ${item.name}${desc ? `: ${desc}` : ""}`, exposure: "listed" });
    }
  }
  return out;
}

/** The context block as the model sees it ("" when nothing is injected). */
export function contextBlock(injected: readonly InjectedFile[]): string {
  if (!injected.length) return "";
  const full = injected.filter((f) => f.how === "full").map((f) => `Contents of ${f.path}:\n\n${f.text.trimEnd()}`);
  const listed = injected.filter((f) => f.how === "listed").map((f) => f.text);
  const parts = [...full, ...(listed.length ? [`Skills you can open when they apply:\n${listed.join("\n")}`] : [])];
  return `As you answer the user's questions, you can use the following context:\n\n${parts.join("\n\n")}`;
}

// ---------------------------------------------------------------- task spec

export type ContinuationProvider = "anthropic" | "openai" | "openai-compatible" | CliProvider;

export interface ContinuationTask {
  kind: "continuation";
  /**
   * anthropic: Messages API. openai: Responses API. openai-compatible: chat completions (OpenRouter, vLLM, Ollama, …).
   * claude-code, codex: the agent's CLI on a subscription (`claude -p`, `codex exec`), the turn history as a transcript (cliTurnPrompt).
   */
  provider: ContinuationProvider;
  model: string;
  baseURL?: string;
  /** Env var holding the API key. Default ANTHROPIC_API_KEY / OPENAI_API_KEY. */
  apiKeyEnv?: string;
  /** System prompt. Default DEFAULT_CONTINUATION_SYSTEM. */
  system?: string;
  /** Read the system prompt from this file instead. */
  systemFile?: string;
  /** The harness under test. */
  context?: ContinuationContext;
  /** recorded (default): the tool definitions inferred from the session. none: no tools (text answers only). */
  toolDefs?: "recorded" | "none";
  /** Default 2048. */
  maxOutputTokens?: number;
  /** OpenAI providers only (the Anthropic API rejects sampling parameters). */
  temperature?: number;
  /** Anthropic output_config.effort / OpenAI reasoning.effort. */
  effort?: string;
  /** Reuse a stored response for the same request and trial. Default true. */
  cache?: boolean;
  /** Default <data root>/continuation-cache. */
  cacheDir?: string;
  /** Resolve relative context and system files here. Default process.cwd(). */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  retry?: RetryOpts;
  /** Price table for usage.costUsd. Default the built-in one. */
  prices?: Prices;
  /** claude-code and codex: the CLI's shared limiter (default the process-wide one). */
  limiter?: CliLimiter;
  /** Called once per case-trial: whether the response came from the cache, and what the call cost (0 when cached). */
  onCall?: (info: { caseId: string; trial: number; cached: boolean; costUsd?: number; usage: ContinuationUsage }) => void;
}

/** Neutral on purpose: it does not say this is a test or a replay. */
export const DEFAULT_CONTINUATION_SYSTEM = `You are a coding agent working in the user's repository. You can read and change files and run commands with the tools you are given. Continue the conversation: write your next response to the user, calling tools when they help.`;

export interface ContinuationUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

export interface ContinuationOutput {
  text: string;
  toolCalls: ToolCall[];
  firstAction: FirstAction;
  stopReason?: string;
  model: string;
  usage: ContinuationUsage;
}

/** Context files with their text: paths read relative to `cwd`, {path, text} as given. */
export function loadContextFiles(files: readonly (string | ContextFile)[], cwd: string): ContextFile[] {
  return files.map((f) => {
    if (typeof f !== "string") {
      if (!isObj(f) || typeof f.path !== "string" || typeof f.text !== "string") throw new TaskError("continuation task: each context file is a path or {path, text}");
      return { path: f.path, text: f.text };
    }
    const abs = resolve(cwd, f);
    if (!existsSync(abs)) throw new TaskError(`continuation task: context file ${JSON.stringify(f)} not found`);
    return { path: f, text: readFileSync(abs, "utf8") };
  });
}

/** `continuation:<provider>/<model>#<hash of system, context files and tool mode>`. */
export function continuationRef(provider: string, model: string, system: string, files: readonly ContextFile[], toolDefs: string, placement: string): string {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((f) => [f.path, f.text]);
  const h = sha256Hex(canonicalJson({ system, files: sorted, toolDefs, placement })).slice(0, 12);
  return `continuation:${provider}/${model}#${h}`;
}

// ---------------------------------------------------------------- request bodies

/** Anthropic tool_use ids allow [A-Za-z0-9_-] only; recorded ids from other agents may not fit. */
const safeId = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "call";
const objInput = (v: unknown): Record<string, unknown> => (isObj(v) ? v : v === undefined ? {} : { input: v });
const schemaOf = (t: ToolDef): Record<string, unknown> => (isObj(t.inputSchema) && t.inputSchema.type === "object" ? t.inputSchema : { type: "object", properties: {} });

interface RenderOpts {
  model: string;
  system: string;
  /** Text to put before the first user message's text (first-user placement), or "". */
  firstUser: string;
  tools: ToolDef[];
  maxOutputTokens: number;
  temperature?: number;
  effort?: string;
}

/** The messages with the context block in front of the first user message, and empty assistant turns dropped. */
function withContext(messages: readonly NeutralMessage[], firstUser: string): NeutralMessage[] {
  let done = !firstUser;
  const out: NeutralMessage[] = [];
  for (const m of messages) {
    if (m.role === "assistant" && !m.text && !m.toolCalls?.length) continue;
    if (!done && m.role === "user") {
      out.push({ role: "user", text: `<system-reminder>\n${firstUser}\n</system-reminder>\n\n${m.text}` });
      done = true;
    } else out.push(m);
  }
  return out;
}

/** Anthropic Messages body: tool_use blocks, consecutive user/tool messages merged into one user message (tool_result blocks first). */
export function anthropicBody(p: FrozenPrefix, o: RenderOpts): Record<string, unknown> {
  type Block = Record<string, unknown>;
  const messages: { role: "user" | "assistant"; content: Block[] }[] = [];
  const push = (role: "user" | "assistant", blocks: Block[]) => {
    const last = messages[messages.length - 1];
    if (last && last.role === role) {
      // A tool_result must lead its user message: results go before text already merged in.
      if (role === "user") {
        const results = blocks.filter((b) => b.type === "tool_result");
        const rest = blocks.filter((b) => b.type !== "tool_result");
        const lastResult = last.content.map((b) => b.type).lastIndexOf("tool_result");
        last.content.splice(lastResult + 1, 0, ...results);
        last.content.push(...rest);
      } else last.content.push(...blocks);
    } else messages.push({ role, content: blocks });
  };
  for (const m of withContext(p.messages, o.firstUser)) {
    if (m.role === "user") push("user", [{ type: "text", text: m.text || "(empty)" }]);
    else if (m.role === "tool") push("user", [{ type: "tool_result", tool_use_id: safeId(m.toolUseId), content: m.content || "(no output)", ...(m.isError ? { is_error: true } : {}) }]);
    else {
      const blocks: Block[] = [];
      if (m.text) blocks.push({ type: "text", text: m.text });
      for (const c of m.toolCalls ?? []) blocks.push({ type: "tool_use", id: safeId(c.id), name: c.name, input: objInput(c.input) });
      push("assistant", blocks);
    }
  }
  const body: Record<string, unknown> = { model: o.model, max_tokens: o.maxOutputTokens, system: o.system, messages };
  if (o.tools.length) body.tools = o.tools.map((t) => ({ name: t.name, description: t.description ?? "", input_schema: schemaOf(t) }));
  if (o.effort) body.output_config = { effort: o.effort };
  return body;
}

/** OpenAI chat completions body: tool_calls on assistant messages, role "tool" results. */
export function openAIChatBody(p: FrozenPrefix, o: RenderOpts): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [{ role: "system", content: o.system }];
  for (const m of withContext(p.messages, o.firstUser)) {
    if (m.role === "user") messages.push({ role: "user", content: m.text });
    else if (m.role === "tool") messages.push({ role: "tool", tool_call_id: m.toolUseId, content: m.isError ? `[error] ${m.content}` : m.content });
    else {
      const msg: Record<string, unknown> = { role: "assistant", content: m.text ?? null };
      if (m.toolCalls?.length) msg.tool_calls = m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(objInput(c.input)) } }));
      messages.push(msg);
    }
  }
  const body: Record<string, unknown> = { model: o.model, messages, max_tokens: o.maxOutputTokens };
  if (o.tools.length) body.tools = o.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: schemaOf(t) } }));
  if (o.temperature !== undefined) body.temperature = o.temperature;
  if (o.effort) body.reasoning_effort = o.effort;
  return body;
}

/** OpenAI Responses body: message items, function_call and function_call_output items. */
export function openAIResponsesBody(p: FrozenPrefix, o: RenderOpts): Record<string, unknown> {
  const input: Record<string, unknown>[] = [];
  for (const m of withContext(p.messages, o.firstUser)) {
    if (m.role === "user") input.push({ role: "user", content: [{ type: "input_text", text: m.text }] });
    else if (m.role === "tool") input.push({ type: "function_call_output", call_id: m.toolUseId, output: m.isError ? `[error] ${m.content}` : m.content });
    else {
      if (m.text) input.push({ role: "assistant", content: [{ type: "output_text", text: m.text }] });
      for (const c of m.toolCalls ?? []) input.push({ type: "function_call", call_id: c.id, name: c.name, arguments: JSON.stringify(objInput(c.input)) });
    }
  }
  const body: Record<string, unknown> = { model: o.model, instructions: o.system, input, max_output_tokens: o.maxOutputTokens, store: false };
  if (o.tools.length) body.tools = o.tools.map((t) => ({ type: "function", name: t.name, description: t.description ?? "", parameters: schemaOf(t) }));
  if (o.temperature !== undefined) body.temperature = o.temperature;
  if (o.effort) body.reasoning = { effort: o.effort };
  return body;
}

/**
 * What a subscription CLI is told on top of the system prompt. `claude -p` and
 * `codex exec` take one message and run their own tools, so the turn history
 * goes in as a transcript and the model writes its tool calls as JSON instead
 * of calling them.
 */
// Nothing here may suggest that tools are unavailable. On a real subscription replay, a model whose
// own tool list was empty said "the Bash tool is disabled" instead of running the tests, whatever
// this text said; the API path (native tools) never does. So Claude Code gets the session's tools
// natively when it can (CLAUDE_CODE_TOOLS), and this protocol is the fallback.
export const CLI_TURN_PROTOCOL = `This session is replayed. The user's message holds it up to now, in <conversation>, and the tools you have in it, in <tools>. Write your next turn in it, as you would with those tools. The tools in your own tool list here only return your answer and say nothing about the session: in the session, every tool in <tools> works and none is disabled. To call one, put it in "tool_calls", with its name and its input as a JSON object written as a string; the calls run after you answer, in order, and you see their results next. Write only your next turn: in "text", what you say to the user now (empty when you only call tools); in "tool_calls", the tools you call now (empty when you call none).`;
/** With the session's tools given natively (Claude Code): only the transcript form needs saying. */
export const CLI_NATIVE_PROTOCOL = `This session is replayed. The user's message holds it up to now, in <conversation>. Write your next turn in it: what you say to the user, and the tool calls you make now, as you normally would.`;
/** The end of the CLI user message, next to where the model starts writing. */
export const CLI_TURN_ASK = `Write your next turn. Every tool in <tools> works: call the ones you need in "tool_calls".`;
export const CLI_NATIVE_ASK = "Write your next turn.";

/** The reply a subscription CLI must give: the turn's text and its tool calls, inputs as JSON strings (strict-schema friendly). */
export const CLI_TURN_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    text: { type: "string" },
    tool_calls: {
      type: "array",
      items: { type: "object", properties: { name: { type: "string" }, input_json: { type: "string" } }, required: ["name", "input_json"], additionalProperties: false },
    },
  },
  required: ["text", "tool_calls"],
  additionalProperties: false,
};

const attr = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * The same request as anthropicBody, as one system prompt and one message for
 * a CLI: the system prompt (with "system" placement, the context block too)
 * and CLI_TURN_PROTOCOL; then the tool definitions and every message of the
 * prefix in order (the context block in front of the first user message, tool
 * calls with their JSON input, tool results with their content). The text of
 * every block is the API body's text, unchanged.
 */
export function cliTurnPrompt(p: FrozenPrefix, o: RenderOpts & { native?: boolean }): { system: string; user: string } {
  const tools = (o.native ? [] : o.tools).map((t) => `<tool name="${attr(t.name)}">\n${t.description ? `${t.description.trimEnd()}\n` : ""}Input schema: ${JSON.stringify(schemaOf(t))}\n</tool>`);
  const turns: string[] = [];
  for (const m of withContext(p.messages, o.firstUser)) {
    if (m.role === "user") turns.push(`<user>\n${m.text || "(empty)"}\n</user>`);
    else if (m.role === "tool") turns.push(`<tool_result id="${attr(safeId(m.toolUseId))}" name="${attr(m.name)}"${m.isError ? ' is_error="true"' : ""}>\n${m.content || "(no output)"}\n</tool_result>`);
    else {
      const parts = [...(m.text ? [m.text] : []), ...(m.toolCalls ?? []).map((c) => `<tool_call id="${attr(safeId(c.id))}" name="${attr(c.name)}">${JSON.stringify(objInput(c.input))}</tool_call>`)];
      turns.push(`<assistant>\n${parts.join("\n")}\n</assistant>`);
    }
  }
  const user = `${tools.length ? `<tools>\n${tools.join("\n")}\n</tools>\n\n` : ""}<conversation>\n${turns.join("\n\n")}\n</conversation>\n\n${o.native ? CLI_NATIVE_ASK : CLI_TURN_ASK}`;
  return { system: `${o.system}\n\n${o.native ? CLI_NATIVE_PROTOCOL : CLI_TURN_PROTOCOL}`, user };
}

// ---------------------------------------------------------------- responses

const n = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const parseArgs = (s: unknown): unknown => {
  if (typeof s !== "string") return s ?? {};
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return s;
  }
};

/** Text, tool calls, stop reason, model and token usage from a provider's response JSON. */
export function parseResponse(provider: ContinuationProvider, json: unknown, model: string): Omit<ContinuationOutput, "firstAction"> {
  const j = isObj(json) ? json : {};
  const u = isObj(j.usage) ? j.usage : {};
  const usage: ContinuationUsage = {};
  const put = (k: keyof ContinuationUsage, v: unknown) => {
    const x = n(v);
    if (x !== undefined) usage[k] = x;
  };
  let text = "";
  const toolCalls: ToolCall[] = [];
  let stopReason: string | undefined;
  if (isCliProvider(provider)) {
    // The stored CLI reply (cliTurn below): the turn and the call's usage.
    if (typeof j.text === "string") text = j.text;
    for (const c of Array.isArray(j.tool_calls) ? j.tool_calls : []) {
      if (isObj(c) && typeof c.name === "string") toolCalls.push({ id: `call_${toolCalls.length}`, name: c.name, input: parseArgs(c.input_json) });
    }
    if (typeof j.stop_reason === "string") stopReason = j.stop_reason;
    put("inputTokens", u.inputTokens);
    put("outputTokens", u.outputTokens);
    put("cacheReadTokens", u.cacheReadTokens);
    put("cacheWriteTokens", u.cacheWriteTokens);
  } else if (provider === "anthropic") {
    for (const b of Array.isArray(j.content) ? j.content : []) {
      if (!isObj(b)) continue;
      if (b.type === "text" && typeof b.text === "string") text += b.text;
      else if (b.type === "tool_use" && typeof b.name === "string") toolCalls.push({ id: String(b.id ?? `call_${toolCalls.length}`), name: b.name, input: b.input ?? {} });
    }
    if (typeof j.stop_reason === "string") stopReason = j.stop_reason;
    put("inputTokens", u.input_tokens);
    put("outputTokens", u.output_tokens);
    put("cacheReadTokens", u.cache_read_input_tokens);
    put("cacheWriteTokens", u.cache_creation_input_tokens);
  } else if (provider === "openai-compatible") {
    const choice = Array.isArray(j.choices) && isObj(j.choices[0]) ? j.choices[0] : {};
    const msg = isObj(choice.message) ? choice.message : {};
    if (typeof msg.content === "string") text = msg.content;
    for (const c of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
      if (!isObj(c) || !isObj(c.function) || typeof c.function.name !== "string") continue;
      toolCalls.push({ id: String(c.id ?? `call_${toolCalls.length}`), name: c.function.name, input: parseArgs(c.function.arguments) });
    }
    if (typeof choice.finish_reason === "string") stopReason = choice.finish_reason;
    put("inputTokens", u.prompt_tokens);
    put("outputTokens", u.completion_tokens);
  } else {
    for (const item of Array.isArray(j.output) ? j.output : []) {
      if (!isObj(item)) continue;
      if (item.type === "message") {
        for (const c of Array.isArray(item.content) ? item.content : []) if (isObj(c) && typeof c.text === "string") text += c.text;
      } else if (item.type === "function_call" && typeof item.name === "string") {
        toolCalls.push({ id: String(item.call_id ?? item.id ?? `call_${toolCalls.length}`), name: item.name, input: parseArgs(item.arguments) });
      }
    }
    if (typeof j.status === "string") stopReason = j.status;
    put("inputTokens", u.input_tokens);
    put("outputTokens", u.output_tokens);
  }
  return { text, toolCalls, ...(stopReason ? { stopReason } : {}), model: typeof j.model === "string" ? j.model : model, usage };
}

export function firstActionOf(toolCalls: readonly ToolCall[]): FirstAction {
  const c = toolCalls[0];
  return c ? { type: "tool", name: c.name, input: c.input } : { type: "text" };
}

/** The input of a tool call, normalized for comparing two calls: a shell command with whitespace squeezed, else canonical JSON. */
function normalizedInput(input: unknown): string {
  const cmd = commandOf(input);
  if (cmd !== undefined) return cmd.replace(/\s+/g, " ").trim();
  return canonicalJson(input ?? null).replace(/\s+/g, " ");
}

/**
 * Whether two first actions differ: a different kind, a different tool name,
 * or the same tool with different normalized input. Undefined when both are
 * text-only: the rubric has to decide those.
 */
export function actionsDiffer(a: FirstAction, b: FirstAction): boolean | undefined {
  if (a.type === "text" && b.type === "text") return undefined;
  if (a.type !== b.type) return true;
  if (a.type === "tool" && b.type === "tool") return a.name !== b.name || normalizedInput(a.input) !== normalizedInput(b.input);
  return true;
}

// ---------------------------------------------------------------- the task

const CACHE_VERSION = 1;

/** The trace a judge sees: the last 12 prefix messages, ids p<index>. */
export function prefixTrace(p: FrozenPrefix, last = 12): TraceEvent[] {
  const start = Math.max(0, p.messages.length - last);
  return p.messages.slice(start).map((m, k) => {
    const id = `p${start + k}`;
    if (m.role === "user") return { id, kind: "user.message", payload: { text: m.text } };
    if (m.role === "tool") return { id, kind: "tool.end", payload: { tool: m.name, ok: !m.isError, output: m.content } };
    return { id, kind: "assistant.message", payload: { ...(m.text ? { text: m.text } : {}), ...(m.toolCalls?.length ? { toolCalls: m.toolCalls.map((c) => ({ name: c.name, input: c.input })) } : {}) } };
  });
}

function keyEnv(t: ContinuationTask): string {
  return t.apiKeyEnv ?? (t.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY");
}

const LOCAL_BASE = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/;

/** The env var a task's uncached model calls need, when it is unset and the endpoint is not local; else undefined. */
export function missingModelKey(t: ContinuationTask, env: NodeJS.ProcessEnv): string | undefined {
  if (isCliProvider(t.provider)) return undefined;
  const name = keyEnv(t);
  if (env[name]?.trim()) return undefined;
  return LOCAL_BASE.test(baseURLOf(t, env)) ? undefined : name;
}

function baseURLOf(t: ContinuationTask, env: NodeJS.ProcessEnv): string {
  const fromEnv = t.provider === "anthropic" ? env.ANTHROPIC_BASE_URL : env.OPENAI_BASE_URL;
  const def = t.provider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1";
  return (t.baseURL ?? (fromEnv?.trim() || def)).replace(/\/+$/, "");
}

function endpoint(t: ContinuationTask, base: string): string {
  if (isCliProvider(t.provider)) return base;
  if (t.provider === "anthropic") return `${base}/v1/messages`;
  if (t.provider === "openai") return `${base}/responses`;
  return `${base}/chat/completions`;
}

/** A continuation task's settings, resolved once: what every request is built from. */
interface Prepared {
  ref: string;
  url: string;
  base: string;
  useCache: boolean;
  /** The request body and its cache file for one prefix and trial. */
  request(prefix: FrozenPrefix, trial: number): { body: Record<string, unknown>; file: string };
}

function prepare(spec: ContinuationTask): Prepared {
  if (!["anthropic", "openai", "openai-compatible", "claude-code", "codex"].includes(spec.provider)) {
    throw new TaskError(`continuation task: provider must be "anthropic", "openai", "openai-compatible", "claude-code" or "codex" (got ${JSON.stringify(spec.provider)})`);
  }
  if (typeof spec.model !== "string" || !spec.model) throw new TaskError("continuation task: `model` is required");
  const cwd = spec.cwd ?? process.cwd();
  const env = spec.env ?? process.env;
  let system = spec.system ?? DEFAULT_CONTINUATION_SYSTEM;
  if (spec.systemFile) {
    const f = resolve(cwd, spec.systemFile);
    if (!existsSync(f)) throw new TaskError(`continuation task: systemFile ${JSON.stringify(spec.systemFile)} not found`);
    system = readFileSync(f, "utf8");
  }
  const files = loadContextFiles(spec.context?.files ?? [], cwd);
  const placement = spec.context?.placement ?? "first-user";
  const toolDefs = spec.toolDefs ?? "recorded";
  const maxOutputTokens = spec.maxOutputTokens ?? 2048;
  const cli = isCliProvider(spec.provider);
  const base = cli ? `cli:${spec.provider}` : baseURLOf(spec, env);
  const cacheDir = spec.cacheDir ?? join(paths(env).root, "continuation-cache");
  return {
    ref: continuationRef(spec.provider, spec.model, system, files, toolDefs, placement),
    url: endpoint(spec, base),
    base,
    useCache: spec.cache !== false,
    request(prefix, trial) {
      const block = contextBlock(injectContext(files, prefix));
      const opts: RenderOpts = {
        model: spec.model,
        system: placement === "system" && block ? `${system}\n\n${block}` : system,
        firstUser: placement === "first-user" ? block : "",
        tools: toolDefs === "recorded" ? prefix.tools : [],
        maxOutputTokens,
        ...(spec.temperature !== undefined && spec.provider !== "anthropic" ? { temperature: spec.temperature } : {}),
        ...(spec.effort ? { effort: spec.effort } : {}),
      };
      // Claude Code can give the model the session's own tools when they are all its built-ins.
      const native = spec.provider === "claude-code" && opts.tools.length > 0 && opts.tools.every((t) => CLAUDE_CODE_TOOLS.has(t.name));
      const body = cli
        ? { model: spec.model, ...cliTurnPrompt(prefix, { ...opts, native }), ...(native ? { tools: opts.tools.map((t) => t.name) } : {}), ...(spec.effort ? { effort: spec.effort } : {}) }
        : spec.provider === "anthropic"
          ? anthropicBody(prefix, opts)
          : spec.provider === "openai"
            ? openAIResponsesBody(prefix, opts)
            : openAIChatBody(prefix, opts);
      // The key never enters the cache key or the file: provider, endpoint, body and trial do.
      const key = sha256Hex(canonicalJson({ v: CACHE_VERSION, provider: spec.provider, baseURL: base, body, trial }));
      return { body, file: join(cacheDir, key.slice(0, 2), `${key}.json`) };
    },
  };
}

/** One planned call: whether a stored response already answers it, and its size (for cost estimates). */
export interface PlannedCall {
  cached: boolean;
  requestChars: number;
  maxOutputTokens: number;
}

/**
 * What running this task on `input` for `trial` would send, and whether the
 * response cache already holds the answer. Makes no network call.
 */
export function planContinuation(spec: ContinuationTask): (input: unknown, trial: number) => PlannedCall {
  const p = prepare(spec);
  const maxOutputTokens = spec.maxOutputTokens ?? 2048;
  return (input, trial) => {
    const { body, file } = p.request(validatePrefix(input), trial);
    return { cached: p.useCache && existsSync(file), requestChars: JSON.stringify(body).length, maxOutputTokens };
  };
}

type CliTurnBody = { model: string; system: string; user: string; effort?: string; tools?: string[] };

/** One next turn through a subscription CLI, stored the way parseResponse reads it. */
async function cliTurn(kind: CliProvider, req: CliTurnBody, o: { env: NodeJS.ProcessEnv; limiter?: CliLimiter; signal?: AbortSignal }): Promise<Record<string, unknown>> {
  const r = await cliComplete(kind, { ...req, ...(req.tools?.length ? {} : { jsonSchema: CLI_TURN_SCHEMA }), ...(o.signal ? { signal: o.signal } : {}) }, { env: o.env, ...(o.limiter ? { limiter: o.limiter } : {}) }).catch((e: unknown) => {
    throw new TaskError(e instanceof Error ? e.message : String(e));
  });
  if (r.toolCalls) {
    return {
      cli: kind,
      text: r.text,
      tool_calls: r.toolCalls.map((c) => ({ name: c.name, input_json: JSON.stringify(c.input) })),
      model: r.model,
      ...(r.stopReason ? { stop_reason: r.stopReason } : {}),
      usage: r.usage,
    };
  }
  let turn: unknown;
  try {
    turn = JSON.parse(r.text);
  } catch {
    turn = undefined;
  }
  // A reply that ignored the schema is still a turn: its text, no tool calls.
  const t = isObj(turn) ? turn : { text: r.text, tool_calls: [] };
  return {
    cli: kind,
    text: typeof t.text === "string" ? t.text : "",
    tool_calls: Array.isArray(t.tool_calls) ? t.tool_calls : [],
    model: r.model,
    ...(r.stopReason ? { stop_reason: r.stopReason } : {}),
    usage: r.usage,
    ...(r.commands ? { commands: r.commands } : {}),
  };
}

export function continuationTask(spec: ContinuationTask): ResolvedTask {
  const p = prepare(spec);
  const env = spec.env ?? process.env;
  const prices = spec.prices ?? pricesFor();
  return {
    info: { kind: "continuation", ref: p.ref },
    async run(input: unknown, ctx: TaskContext) {
      const prefix = validatePrefix(input);
      const { body, file } = p.request(prefix, ctx.trial);
      let json: unknown;
      let cached = false;
      if (p.useCache) {
        try {
          json = JSON.parse(await readFile(file, "utf8")) as unknown;
          cached = true;
        } catch {
          json = undefined;
        }
      }
      if (json === undefined && isCliProvider(spec.provider)) {
        json = await cliTurn(spec.provider, body as CliTurnBody, { env, ...(spec.limiter ? { limiter: spec.limiter } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}) });
        if (p.useCache) {
          await mkdir(dirname(file), { recursive: true });
          await writeFileAtomic(file, JSON.stringify(json));
        }
      }
      if (json === undefined) {
        const keyName = keyEnv(spec);
        const apiKey = env[keyName]?.trim();
        const local = LOCAL_BASE.test(p.base);
        if (!apiKey && !local) throw new TaskError(`${spec.provider}: set ${keyName} to call the model (no cached response for this case)`);
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (spec.provider === "anthropic") {
          headers["anthropic-version"] = ANTHROPIC_API_VERSION;
          if (apiKey) headers["x-api-key"] = apiKey;
        } else if (apiKey) headers.authorization = `Bearer ${apiKey}`;
        json = await fetchJson(p.url, { method: "POST", headers, body: JSON.stringify(body) }, { ...spec.retry, ...(spec.fetch ? { fetch: spec.fetch } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}), secrets: [apiKey], label: spec.provider });
        if (isObj(json) && json.stop_reason === "refusal") throw new TaskError(`${spec.provider}: the model declined this prefix`);
        if (p.useCache) {
          await mkdir(dirname(file), { recursive: true });
          await writeFileAtomic(file, JSON.stringify(json));
        }
      }
      const parsed = parseResponse(spec.provider, json, spec.model);
      const price = lookupPrice(parsed.model, prices) ?? lookupPrice(spec.model, prices);
      if (price) parsed.usage.costUsd = costFrom(parsed.usage, price);
      const out: ContinuationOutput = { ...parsed, firstAction: firstActionOf(parsed.toolCalls) };
      spec.onCall?.({ caseId: ctx.caseId, trial: ctx.trial, cached, usage: parsed.usage, ...(parsed.usage.costUsd !== undefined ? { costUsd: cached ? 0 : parsed.usage.costUsd } : {}) });
      return withTrace(out, prefixTrace(prefix));
    },
  };
}

export const DEFAULT_CONTINUATION_MODEL = DEFAULT_ANTHROPIC_MODEL;

// ---------------------------------------------------------------- control arm

/**
 * What a case's recorded next turn was, read from its metadata:
 * `recorded` (a FirstAction) and `recordedPass` (whether that turn met the
 * rubric; decision-point cases are failures, so false).
 */
export function recordedTurn(c: Pick<Case, "metadata"> | undefined): { action?: FirstAction; pass?: boolean } {
  const m = c?.metadata ?? {};
  const r = m.recorded;
  const action = isObj(r) && (r.type === "text" || (r.type === "tool" && typeof r.name === "string")) ? (r as FirstAction) : undefined;
  return { ...(action ? { action } : {}), ...(typeof m.recordedPass === "boolean" ? { pass: m.recordedPass } : {}) };
}

/** EM-19: how often the control arm's turn differs from the recorded one, from the same prefix. */
export interface ReplayNoise {
  /** Control trials compared with their recorded turn. */
  n: number;
  diverged: number;
  rate: number;
  lo: number;
  hi: number;
  /** Trials decided by the first action (tool name or normalized input) vs by the rubric (text-only turns). */
  byAction: number;
  byRubric: number;
}

/**
 * The replay noise floor of a control experiment (the recorded config run
 * from the same prefixes). A tool turn diverges when its first action differs
 * from the recorded one (tool name, or normalized input); a text-only turn
 * when its graded outcome differs from the recorded turn's. Undefined when no
 * case says what it recorded.
 */
export function replayNoise(control: Pick<ExperimentResult, "runs">, cases: ReadonlyMap<string, Pick<Case, "metadata">>): ReplayNoise | undefined {
  let nTrials = 0;
  let diverged = 0;
  let byAction = 0;
  let byRubric = 0;
  for (const r of control.runs as CaseRun[]) {
    if (r.error !== undefined || r.ungraded) continue;
    const rec = recordedTurn(cases.get(r.caseId));
    const out = isObj(r.output) ? r.output : {};
    const got = isObj(out.firstAction) ? (out.firstAction as FirstAction) : undefined;
    if (!rec.action || !got) continue;
    let d = actionsDiffer(got, rec.action);
    if (d === undefined) {
      if (rec.pass === undefined) continue;
      d = r.pass !== rec.pass;
      byRubric++;
    } else byAction++;
    nTrials++;
    if (d) diverged++;
  }
  if (!nTrials) return undefined;
  const w = wilson(diverged, nTrials);
  return { n: nTrials, diverged, rate: diverged / nTrials, lo: w.lo, hi: w.hi, byAction, byRubric };
}
