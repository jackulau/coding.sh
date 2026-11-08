// Model calls through a coding agent's own CLI, so a Claude or ChatGPT
// subscription can answer without an API key:
//
//   claude-code  `claude -p`: CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) or the CLI's login
//   codex        `codex exec`: the ChatGPT login in $CODEX_HOME/auth.json
//
// One place for every caller (the judge, `exp ab` and `refine` replays, the
// refine proposer). Each call is kept apart from the user's own setup:
//
//  - a throwaway config dir (CLAUDE_CONFIG_DIR, CODEX_HOME) that holds only a
//    copy of the login, so no user settings, hooks, plugins, MCP servers,
//    CLAUDE.md or AGENTS.md load, and the user's coding.sh hooks never record
//    a replay as a session. A login that was refreshed during the run is
//    copied back when the process exits, unless the real file changed since;
//  - flags that load nothing on top: no setting sources, strict MCP config,
//    no slash commands, no tools, no saved session (claude); no user config,
//    no rules, no project docs, a read-only sandbox, ephemeral (codex);
//  - an empty working directory, removed after the call.
//
// When the login can't be copied (Claude Code on macOS keeps it in the
// keychain, keyed by config dir), the call keeps the real config dir and
// relies on the flags alone; `cliHome().isolated` says which.
//
// Calls through one CLI share a limiter: at most `max` at a time, and a
// rate-limit or overload error makes every call wait out a common backoff
// (20 s, 40 s, 80 s, 160 s) before it gives up. A spent subscription (a usage
// limit message) stops every later call with one error and aborts `stopped`.
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { which } from "../adapters/_shared/detect.ts";
import { DEFAULT_MODELS } from "../core/pricing.ts";
import { userHome } from "../core/paths.ts";
import { spawn } from "../core/spawn.ts";
import { ProviderError, type ChatProvider } from "./providers.ts";

export type CliProvider = "claude-code" | "codex";
export const CLI_PROVIDERS: readonly CliProvider[] = ["claude-code", "codex"];
export const isCliProvider = (p: unknown): p is CliProvider => p === "claude-code" || p === "codex";

/** The command each provider runs, found on PATH. */
export const CLI_COMMAND: Readonly<Record<CliProvider, string>> = { "claude-code": "claude", codex: "codex" };
/** What the CLI bills against, for messages. */
export const CLI_PLAN: Readonly<Record<CliProvider, string>> = { "claude-code": "Claude subscription", codex: "ChatGPT subscription" };
/** The model a provider uses when neither the flags nor the sessions name one. */
export const CLI_DEFAULT_MODEL: Readonly<Record<CliProvider, string>> = { "claude-code": DEFAULT_MODELS.anthropic, codex: DEFAULT_MODELS.openai };

const set = (v: string | undefined): boolean => !!v && !!v.trim();

// ---------------------------------------------------------------- login

export interface CliLogin {
  /** The CLI is on PATH. */
  installed: boolean;
  loggedIn: boolean;
  /** How it is logged in, for the one-line note. */
  how?: string;
}

const claudeConfigDir = (env: NodeJS.ProcessEnv) => env.CLAUDE_CONFIG_DIR || join(userHome(env), ".claude");
const claudeUserJson = (env: NodeJS.ProcessEnv) => (env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, ".claude.json") : join(userHome(env), ".claude.json"));
const codexHome = (env: NodeJS.ProcessEnv) => env.CODEX_HOME || join(userHome(env), ".codex");

function readText(p: string): string | undefined {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Whether the CLI is installed and logged in, from the environment and the
 * CLI's own files only (no process is started): CLAUDE_CODE_OAUTH_TOKEN, a
 * .credentials.json, or a claude.ai account in .claude.json (the macOS
 * keychain login); for Codex, auth.json in $CODEX_HOME.
 */
export function cliLogin(kind: CliProvider, env: NodeJS.ProcessEnv = process.env, command = CLI_COMMAND[kind]): CliLogin {
  const installed = which(command, env) !== undefined;
  if (kind === "claude-code") {
    if (set(env.CLAUDE_CODE_OAUTH_TOKEN)) return { installed, loggedIn: true, how: "CLAUDE_CODE_OAUTH_TOKEN" };
    if (existsSync(join(claudeConfigDir(env), ".credentials.json"))) return { installed, loggedIn: true, how: "your Claude Code login" };
    if (/"oauthAccount"\s*:\s*\{/.test(readText(claudeUserJson(env)) ?? "")) return { installed, loggedIn: true, how: "your Claude Code login" };
    return { installed, loggedIn: false };
  }
  const auth = readText(join(codexHome(env), "auth.json"));
  if (auth && /"(?:tokens|OPENAI_API_KEY)"\s*:\s*(?:\{|"[^"]+")/.test(auth)) return { installed, loggedIn: true, how: "your Codex login" };
  return { installed, loggedIn: false };
}

/** How to log a CLI in, for errors. */
export const LOGIN_HINT: Readonly<Record<CliProvider, string>> = {
  "claude-code": "run `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN, or log in with `claude`",
  codex: "run `codex login`",
};

/**
 * The provider to use when none was asked for: undefined while an API key is
 * set (the API is the default), else the first logged-in CLI, Codex first only
 * when the sessions are Codex's.
 */
export function autoCliProvider(env: NodeJS.ProcessEnv, prefer?: CliProvider): { provider: CliProvider; how: string } | undefined {
  if (set(env.ANTHROPIC_API_KEY) || set(env.OPENAI_API_KEY)) return undefined;
  const order: CliProvider[] = prefer === "codex" ? ["codex", "claude-code"] : ["claude-code", "codex"];
  for (const kind of order) {
    const l = cliLogin(kind, env);
    if (l.installed && l.loggedIn) return { provider: kind, how: l.how ?? "" };
  }
  return undefined;
}

// ---------------------------------------------------------------- isolation

export interface CliHome {
  /** The env each call runs with. */
  env: NodeJS.ProcessEnv;
  /** Parent of the per-call working dirs. */
  dir: string;
  /** true: a throwaway config dir; false: the real one, with the flags alone keeping its setup out. */
  isolated: boolean;
}

interface Copied {
  real: string;
  copy: string;
  original: string;
}

const homes = new Map<string, CliHome>();
const copies: Copied[] = [];
let exitHook = false;

/** Env vars that mark a process as running inside Claude Code; a nested `claude -p` must not inherit them. */
const NESTED = /^(?:CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_SSE_PORT|CLAUDE_AGENT_SDK_VERSION)$/;

function onExit(): void {
  if (exitHook) return;
  exitHook = true;
  process.once("exit", () => {
    // A login refreshed in the copy goes back, unless the real file moved on meanwhile.
    for (const c of copies) {
      const now = readText(c.copy);
      if (now !== undefined && now !== c.original && readText(c.real) === c.original) {
        try {
          writeFileSync(c.real, now, { mode: 0o600 });
        } catch {
          // keep the real login as it was
        }
      }
    }
    for (const h of homes.values()) rmSync(h.dir, { recursive: true, force: true });
  });
}

function copyLogin(real: string, dir: string, name: string): boolean {
  const original = readText(real);
  if (original === undefined) return false;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const copy = join(dir, name);
  copyFileSync(real, copy);
  chmodSync(copy, 0o600);
  copies.push({ real, copy, original });
  return true;
}

/** The throwaway home for one CLI and base env, made once per process and removed at exit. */
export function cliHome(kind: CliProvider, base: NodeJS.ProcessEnv = process.env): CliHome {
  // The whole env is the key: a call with another env (PATH, a token) must not run with the first one's.
  const key = `${kind}\0${JSON.stringify(Object.entries(base).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))}`;
  const hit = homes.get(key);
  if (hit) return hit;
  const dir = mkdtempSync(join(tmpdir(), `coding-sh-${kind}-`));
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!NESTED.test(k)) env[k] = v;
  let isolated: boolean;
  if (kind === "claude-code") {
    const config = join(dir, "config");
    const envAuth = set(base.CLAUDE_CODE_OAUTH_TOKEN) || set(base.ANTHROPIC_API_KEY) || set(base.ANTHROPIC_AUTH_TOKEN);
    isolated = envAuth || copyLogin(join(claudeConfigDir(base), ".credentials.json"), config, ".credentials.json");
    if (isolated) {
      mkdirSync(config, { recursive: true, mode: 0o700 });
      env.CLAUDE_CONFIG_DIR = config;
    }
    Object.assign(env, { DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", ENABLE_CLAUDEAI_MCP_SERVERS: "false" });
  } else {
    const home = join(dir, "codex");
    isolated = copyLogin(join(codexHome(base), "auth.json"), home, "auth.json") || set(base.CODEX_API_KEY);
    if (isolated) {
      mkdirSync(home, { recursive: true, mode: 0o700 });
      env.CODEX_HOME = home;
    }
  }
  const h: CliHome = { env, dir, isolated };
  homes.set(key, h);
  onExit();
  return h;
}

// ---------------------------------------------------------------- limits

export type LimitKind = "spent" | "rate";

/** A usage-limit message (the plan is spent until a reset) or a rate-limit / overload one; undefined otherwise. */
export function limitKind(message: string): LimitKind | undefined {
  if (/usage[ _]limit|hit your (?:usage )?limit|limit (?:reached|will reset)|out of (?:extra )?usage|insufficient_quota/i.test(message)) return "spent";
  if (/\b429\b|\b529\b|rate[ _-]?limit|overloaded|too many requests/i.test(message)) return "rate";
  return undefined;
}

/** "resets 5pm (Europe/Paris)", "try again in 2 hours": the part of a usage-limit message that says when. */
function resetText(message: string): string {
  const m = /(resets?\s[^.|\n]+|try again (?:in|at)\s[^.|\n]+)/i.exec(message);
  if (m) return `; ${m[1]!.trim()}`;
  // "Claude AI usage limit reached|<epoch seconds>"
  const epoch = /\|(\d{10})\b/.exec(message);
  return epoch ? `; resets ${new Date(Number(epoch[1]) * 1000).toLocaleString()}` : "";
}

export class CliLimiter {
  max: number;
  /** First backoff after a rate-limit error; it doubles on each retry. */
  baseDelayMs: number;
  retries: number;
  private active = 0;
  private waiting: (() => void)[] = [];
  private coolUntil = 0;
  /** Set once the subscription's usage limit is hit: every later call fails with it. */
  spent: string | undefined;
  private readonly stop = new AbortController();
  /** Rate-limit waits so far, for the report. */
  backoffs = 0;
  /** Called on each backoff and when the plan is spent, with a line for the user. */
  onNote: ((line: string) => void) | undefined;

  constructor(o: { max?: number; baseDelayMs?: number; retries?: number } = {}) {
    this.max = o.max ?? 2;
    this.baseDelayMs = o.baseDelayMs ?? 20_000;
    this.retries = o.retries ?? 4;
  }

  /** Aborts once the plan is spent: a run can stop scheduling on it. */
  get stopped(): AbortSignal {
    return this.stop.signal;
  }

  private async acquire(): Promise<void> {
    while (this.active >= this.max) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
  }

  private release(): void {
    this.active--;
    this.waiting.shift()?.();
  }

  private async cooldown(signal?: AbortSignal): Promise<void> {
    const wait = this.coolUntil - Date.now();
    if (wait <= 0) return;
    await new Promise<void>((r) => {
      const t = setTimeout(r, wait);
      signal?.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
    });
  }

  /**
   * Run one call in a slot. `once` resolves with the result or with an error
   * message; rate limits back off and retry, a usage limit spends the plan.
   */
  async call<T>(label: string, once: () => Promise<{ ok: T } | { error: string }>, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      if (this.spent) throw new ProviderError(this.spent);
      await this.cooldown(signal);
      if (signal?.aborted) throw new ProviderError(`${label}: aborted`);
      await this.acquire();
      let r: { ok: T } | { error: string };
      try {
        r = await once();
      } finally {
        this.release();
      }
      if ("ok" in r) return r.ok;
      const kind = limitKind(r.error);
      if (kind === "spent") {
        if (!this.spent) {
          this.spent = `${label}: your ${label === "codex" ? CLI_PLAN.codex : CLI_PLAN["claude-code"]} hit its usage limit${resetText(r.error)}. Finished trials are kept: run the same command again after the reset to continue`;
          this.onNote?.(this.spent);
          this.stop.abort();
        }
        throw new ProviderError(this.spent);
      }
      if (kind === "rate" && attempt < this.retries) {
        const delay = this.baseDelayMs * 2 ** attempt;
        this.coolUntil = Math.max(this.coolUntil, Date.now() + delay);
        this.backoffs++;
        this.onNote?.(`${label}: rate limited (${clip(r.error, 120)}); waiting ${Math.round(delay / 1000)} s before retrying (${attempt + 1} of ${this.retries})`);
        continue;
      }
      throw new ProviderError(kind === "rate" ? `${label}: still rate limited after ${this.retries} retries: ${clip(r.error, 300)}` : r.error);
    }
  }
}

const limiters = new Map<CliProvider, CliLimiter>();

/** The process-wide limiter for one CLI: every caller in this process shares its slots and backoff. */
export function cliLimiter(kind: CliProvider): CliLimiter {
  let l = limiters.get(kind);
  if (!l) limiters.set(kind, (l = new CliLimiter()));
  return l;
}

// ---------------------------------------------------------------- one call

export interface CliCall {
  system: string;
  /** Sent on stdin. */
  user: string;
  model?: string;
  /** JSON Schema the reply must follow (strict: every property required, no additional properties). */
  jsonSchema?: Record<string, unknown>;
  /** claude --effort / codex model_reasoning_effort. */
  effort?: string;
  /**
   * claude-code only: Claude Code built-in tools (CLAUDE_CODE_TOOLS) the model
   * gets natively. A PreToolUse hook refuses every call, so none runs, and
   * --max-turns 1 ends the call there; the reply's tool calls come back in
   * CliResult.toolCalls. Not with jsonSchema.
   */
  tools?: readonly string[];
  signal?: AbortSignal;
}

/**
 * The Claude Code built-in tools a replay can offer natively (`claude -p
 * --tools`). Tools outside this list (MCP tools, another agent's tools) can't be.
 */
export const CLAUDE_CODE_TOOLS: ReadonlySet<string> = new Set(["Bash", "Read", "Edit", "MultiEdit", "Write", "Glob", "Grep", "NotebookEdit", "WebFetch", "WebSearch", "TodoWrite", "Task", "Skill"]);

/** --settings for a native-tools call: every tool call is refused before it runs (exit 2 blocks it). */
const REFUSE_TOOLS = JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "exit 2" }] }] } });

export interface CliResult {
  /** The reply: the structured output as JSON when a schema was given, else the text. */
  text: string;
  model: string;
  stopReason?: string;
  usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
  /** The CLI's own API-equivalent cost, when it reports one. */
  costUsd?: number;
  /** Commands Codex ran before answering (read-only sandbox, empty dir). */
  commands?: number;
  /** With CliCall.tools: the tool calls of the reply, in order (none of them ran). */
  toolCalls?: { name: string; input: unknown }[];
}

export interface CliOpts {
  env?: NodeJS.ProcessEnv;
  /** The CLI to run (default `claude` / `codex` on PATH). */
  command?: string;
  /** Kill one call after this long (default 5 min). */
  timeoutMs?: number;
  limiter?: CliLimiter;
}

function clip(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** One model call through the CLI, isolated, limited and retried (see the top of this file). */
export async function cliComplete(kind: CliProvider, req: CliCall, o: CliOpts = {}): Promise<CliResult> {
  const home = cliHome(kind, o.env ?? process.env);
  const limiter = o.limiter ?? cliLimiter(kind);
  const command = o.command ?? CLI_COMMAND[kind];
  const timeoutMs = o.timeoutMs ?? 300_000;
  return limiter.call(
    kind,
    async () => {
      const cwd = await mkdtemp(join(home.dir, "w-"));
      try {
        return kind === "claude-code" ? await claudeOnce(command, req, home, cwd, timeoutMs) : await codexOnce(command, req, home, cwd, timeoutMs);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
    req.signal,
  );
}

/**
 * The `claude -p` flags that load nothing from the user's setup. The model gets
 * no tools, or with `tools` those built-ins with every call refused by a
 * PreToolUse hook of our own and the run ended after the first turn.
 */
export function claudeArgs(req: Pick<CliCall, "system" | "model" | "jsonSchema" | "effort" | "tools">, model: string): string[] {
  const native = !!req.tools?.length;
  const args = ["-p", "--output-format", native ? "stream-json" : "json", ...(native ? ["--verbose"] : []), "--model", model, "--system-prompt", req.system];
  args.push("--tools", native ? req.tools!.join(",") : "", "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands");
  if (native) args.push("--settings", REFUSE_TOOLS, "--max-turns", "1");
  if (req.effort) args.push("--effort", req.effort);
  if (req.jsonSchema && !native) args.push("--json-schema", JSON.stringify(req.jsonSchema));
  return args;
}

type ClaudeUsage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };

function claudeUsage(u: ClaudeUsage = {}): CliResult["usage"] {
  const usage: CliResult["usage"] = {};
  if (num(u.input_tokens) !== undefined) usage.inputTokens = u.input_tokens;
  if (num(u.output_tokens) !== undefined) usage.outputTokens = u.output_tokens;
  if (num(u.cache_read_input_tokens) !== undefined) usage.cacheReadTokens = u.cache_read_input_tokens;
  if (num(u.cache_creation_input_tokens) !== undefined) usage.cacheWriteTokens = u.cache_creation_input_tokens;
  return usage;
}

/**
 * The first turn of a `--output-format stream-json` run: its text and tool
 * calls, up to the refused calls' results; usage and cost from the result line.
 */
function claudeStream(command: string, stdout: string, code: number | null, stderr: string, model: string): { ok: CliResult } | { error: string } {
  const texts: string[] = [];
  const toolCalls: { name: string; input: unknown }[] = [];
  let firstTurnDone = false;
  let result: { subtype?: string; is_error?: boolean; result?: unknown; usage?: ClaudeUsage; total_cost_usd?: number; errors?: unknown } | undefined;
  let served: string | undefined;
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let e: { type?: string; subtype?: string; message?: { model?: string; content?: unknown }; is_error?: boolean };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "assistant" && !firstTurnDone) {
      if (typeof e.message?.model === "string") served = e.message.model;
      for (const c of Array.isArray(e.message?.content) ? e.message.content : []) {
        const b = c as { type?: string; text?: string; name?: string; input?: unknown };
        if (b.type === "text" && typeof b.text === "string" && b.text.trim()) texts.push(b.text);
        else if (b.type === "tool_use" && typeof b.name === "string") toolCalls.push({ name: b.name, input: b.input ?? {} });
      }
    } else if (e.type === "user") firstTurnDone = true;
    else if (e.type === "result") result = e as typeof result;
  }
  if (!result) return { error: `claude-code: \`${command} -p\` exited ${code} without a result${stderr.trim() ? `: ${clip(stderr, 300)}` : ""}` };
  // error_max_turns is how a turn with tool calls ends here (the calls were refused, the run stopped).
  if (result.subtype !== "success" && result.subtype !== "error_max_turns") {
    const why = typeof result.result === "string" ? result.result : Array.isArray(result.errors) ? result.errors.join("; ") : stderr;
    return { error: `claude-code: \`${command} -p\` failed: ${clip(why || `exit ${code}`, 300)}` };
  }
  if (result.subtype === "success" && result.is_error) return { error: `claude-code: \`${command} -p\` failed: ${clip(typeof result.result === "string" ? result.result : `exit ${code}`, 300)}` };
  const r: CliResult = { text: texts.join("\n\n"), model: served && served !== "<synthetic>" ? served : model, usage: claudeUsage(result.usage), toolCalls, stopReason: toolCalls.length ? "tool_use" : "end_turn" };
  if (num(result.total_cost_usd) !== undefined) r.costUsd = result.total_cost_usd;
  return { ok: r };
}

async function claudeOnce(command: string, req: CliCall, home: CliHome, cwd: string, timeoutMs: number): Promise<{ ok: CliResult } | { error: string }> {
  const model = req.model ?? CLI_DEFAULT_MODEL["claude-code"];
  const out = await runCli("claude-code", command, claudeArgs(req, model), req.user, { cwd, env: home.env, timeoutMs, ...(req.signal ? { signal: req.signal } : {}) });
  if (req.tools?.length) return claudeStream(command, out.stdout, out.code, out.stderr, model);
  let json: {
    is_error?: boolean;
    result?: unknown;
    structured_output?: unknown;
    stop_reason?: string;
    total_cost_usd?: number;
    usage?: ClaudeUsage;
    modelUsage?: Record<string, unknown>;
  };
  try {
    json = JSON.parse(out.stdout.trim().split("\n").pop() ?? "");
  } catch {
    return { error: `claude-code: \`${command} -p\` exited ${out.code} without a JSON result${out.stderr.trim() ? `: ${clip(out.stderr, 300)}` : ""}` };
  }
  if (json.is_error || out.code !== 0) return { error: `claude-code: \`${command} -p\` failed: ${clip(typeof json.result === "string" ? json.result : out.stderr, 300) || `exit ${out.code}`}` };
  const text = json.structured_output !== undefined && json.structured_output !== null ? JSON.stringify(json.structured_output) : typeof json.result === "string" ? json.result : "";
  const used = Object.keys(json.modelUsage ?? {});
  const usage = claudeUsage(json.usage);
  const r: CliResult = { text, model: used.includes(model) ? model : (used[0] ?? model), usage };
  if (json.stop_reason) r.stopReason = json.stop_reason;
  if (num(json.total_cost_usd) !== undefined) r.costUsd = json.total_cost_usd;
  return { ok: r };
}

/** The `codex exec` flags: no user config, rules or project docs, read-only and ephemeral, our instructions in place of Codex's. */
export function codexArgs(req: Pick<CliCall, "model" | "effort">, files: { cwd: string; instructions: string; schema?: string; last: string }): string[] {
  const args = ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "-s", "read-only", "-C", files.cwd];
  args.push("-c", `model_instructions_file=${JSON.stringify(files.instructions)}`, "-c", "project_doc_max_bytes=0");
  if (req.model) args.push("-m", req.model);
  if (req.effort) args.push("-c", `model_reasoning_effort=${JSON.stringify(req.effort)}`);
  if (files.schema) args.push("--output-schema", files.schema);
  args.push("-o", files.last, "-");
  return args;
}

async function codexOnce(command: string, req: CliCall, home: CliHome, cwd: string, timeoutMs: number): Promise<{ ok: CliResult } | { error: string }> {
  // The files go next to the working dir, not in it: the model sees an empty directory.
  const dir = await mkdtemp(join(home.dir, "f-"));
  try {
    const files = { cwd, instructions: join(dir, "instructions.md"), last: join(dir, "last.txt"), ...(req.jsonSchema ? { schema: join(dir, "schema.json") } : {}) };
    await writeFile(files.instructions, req.system);
    if (files.schema) await writeFile(files.schema, JSON.stringify(req.jsonSchema));
    const out = await runCli("codex", command, codexArgs(req, files), req.user, { cwd, env: home.env, timeoutMs, ...(req.signal ? { signal: req.signal } : {}) });
    const usage: CliResult["usage"] = {};
    let failed: string | undefined;
    let lastMessage = "";
    let commands = 0;
    for (const line of out.stdout.split("\n")) {
      if (!line.trim().startsWith("{")) continue;
      let e: { type?: string; message?: string; error?: { message?: string }; item?: { type?: string; text?: string }; usage?: Record<string, unknown> };
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.type === "error" && e.message) failed = e.message;
      else if (e.type === "turn.failed") failed = e.error?.message ?? failed ?? "turn failed";
      else if (e.type === "item.completed" && e.item?.type === "agent_message" && typeof e.item.text === "string") lastMessage = e.item.text;
      else if (e.type === "item.completed" && e.item?.type === "command_execution") commands++;
      else if (e.type === "turn.completed" && e.usage) {
        const input = num(e.usage.input_tokens) ?? 0;
        const cached = num(e.usage.cached_input_tokens) ?? 0;
        usage.inputTokens = (usage.inputTokens ?? 0) + input - cached;
        usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + cached;
        usage.outputTokens = (usage.outputTokens ?? 0) + (num(e.usage.output_tokens) ?? 0);
      }
    }
    if (failed) return { error: `codex: \`${command} exec\` failed: ${clip(failed, 300)}` };
    if (out.code !== 0) return { error: `codex: \`${command} exec\` exited ${out.code}${out.stderr.trim() ? `: ${clip(out.stderr, 300)}` : ""}` };
    const text = (await readFile(files.last, "utf8").catch(() => lastMessage)).trim() || lastMessage;
    const r: CliResult = { text, model: req.model ?? "codex default", usage };
    if (commands) r.commands = commands;
    return { ok: r };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runCli(
  kind: CliProvider,
  command: string,
  args: string[],
  stdin: string,
  o: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      reject(new ProviderError(`${kind}: could not run \`${command}\`: ${(e as Error).message}`));
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
      reject(new ProviderError(e.code === "ENOENT" ? `${kind}: \`${command}\` is not on PATH (install ${kind === "codex" ? "Codex" : "Claude Code"}, or use another provider)` : `${kind}: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", stop);
      if (o.signal?.aborted) reject(new ProviderError(`${kind}: aborted`));
      else if (timedOut) reject(new ProviderError(`${kind}: no answer within ${Math.round(o.timeoutMs / 1000)} s`));
      else resolvePromise({ code, stdout, stderr });
    });
    child.stdin!.on("error", () => {});
    child.stdin!.end(stdin);
  });
}

// ---------------------------------------------------------------- judge providers

export interface ClaudeCodeOpts extends CliOpts {
  model?: string;
}

/**
 * The judge through the Claude Code CLI (`claude -p`), so a Claude subscription
 * can grade without an API key: auth is whatever the CLI uses
 * (CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`, ANTHROPIC_API_KEY, or its
 * login). Each call runs isolated (see the top of this file) and asks for the
 * verdict schema with --json-schema.
 */
export function claudeCodeProvider(opts: ClaudeCodeOpts = {}): ChatProvider {
  const model = opts.model ?? CLI_DEFAULT_MODEL["claude-code"];
  return cliChatProvider("claude-code", model, opts);
}

export type CodexOpts = ClaudeCodeOpts;

/** The judge through the Codex CLI (`codex exec`), on a ChatGPT subscription; --output-schema holds it to the verdict schema. */
export function codexProvider(opts: CodexOpts = {}): ChatProvider {
  return cliChatProvider("codex", opts.model ?? CLI_DEFAULT_MODEL.codex, opts);
}

function cliChatProvider(kind: CliProvider, model: string, opts: CliOpts): ChatProvider {
  return {
    name: kind,
    model,
    params: { structuredOutput: true },
    async complete(req) {
      const r = await cliComplete(kind, { system: req.system, user: req.user, model, ...(req.jsonSchema ? { jsonSchema: req.jsonSchema } : {}), ...(req.signal ? { signal: req.signal } : {}) }, opts);
      const u = r.usage;
      return {
        text: r.text,
        model: r.model,
        ...(r.stopReason ? { stopReason: r.stopReason } : {}),
        usage: { inputTokens: (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0), outputTokens: u.outputTokens },
      };
    },
  };
}
