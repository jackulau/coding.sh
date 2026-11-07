// Codex CLI adapter (tier A): $CODEX_HOME/hooks.json hooks (Claude-shaped),
// rollout backfill ($CODEX_HOME/sessions/**/rollout-*.jsonl), `codex exec --json`
// headless runs, CODEX_HOME isolation.
//
// Verified against codex-rs rust-v0.166.0 (hooks crate + generated schemas):
// - hooks.json top level allows only `description` and `hooks` (deny_unknown_fields);
//   unknown keys on groups/handlers are ignored and are not part of the trust
//   hash, so `_codingsh: true` goes on our handlers.
// - Omitted matcher = all tools. Timeouts are seconds; SessionEnd is capped at 3.
// - New or changed hooks run only once trusted (state keyed by
//   "<file>:<snake_event>:<group>:<handler>" in the user config.toml). We NEVER
//   write trust state: install/detect tell the user to approve via /hooks, and
//   eval runs pass --dangerously-bypass-hook-trust.
// - `[features] hooks` is stable and on by default; we only report it when the
//   user disabled it.
// - Stdout must stay empty (plain text becomes model context on SessionStart /
//   UserPromptSubmit / SubagentStart and fails Stop) — hook.mjs prints nothing.
// - Codex has no per-call timing in hooks (PostModelRequest carries usage but no
//   latency), so llm.call events come from the rollout at Stop time, keyed by
//   response_id so live and backfilled copies dedupe.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, isAbsolute, join, relative } from "node:path";
import { paths, userHome } from "../core/paths.ts";
import { parseToml } from "../core/toml.ts";
import { T3_AGENT, T3_ORIGINATOR } from "../spool/host.ts";
import type { Adapter, AgentRunOutput, BackfillOpts, FileChange, HarnessBundle, InstallOpts, NormalizeContext, RunSpec, SpoolLine } from "../core/types.ts";
import type { AgentEvent, Usage } from "../schema/index.ts";
import {
  Emitter,
  addUsage,
  applyChanges,
  applyHookInstall,
  applyHookUninstall,
  arr,
  blobList,
  buildHookCommand,
  clipDiff,
  clipText,
  clipValue,
  diffHeader,
  copyIfExists,
  detectAgent,
  emitDerived,
  hasFlag,
  hasOurHooks,
  installRecord,
  isObj,
  isOurEntry,
  isolatedHome,
  lineRaw,
  num,
  obj,
  outputText,
  parentLink,
  planNestedInstall,
  planNestedUninstall,
  readJsonl,
  readJsonlTail,
  readTextIfExists,
  runEnv,
  runHeadless,
  shellCommandOf,
  str,
  toMs,
  unifiedDiff,
  walkFiles,
  which,
  lineKey,
  type HookEventSpec,
  mcpInstaller,
} from "./_shared/index.ts";
import { isWrapperLine, normalizeWrapperLine } from "./more/wrapper.ts";

export const CODEX_AGENT = "codex";

/** Hook events we register (no matcher = every tool). */
export const CODEX_HOOK_EVENTS: HookEventSpec[] = [
  { event: "SessionStart", timeout: 10 },
  { event: "UserPromptSubmit", timeout: 10 },
  { event: "PreToolUse", timeout: 10 },
  { event: "PostToolUse", timeout: 10 },
  { event: "PreCompact", timeout: 10 },
  { event: "SubagentStart", timeout: 10 },
  { event: "SubagentStop", timeout: 10 },
  { event: "Stop", timeout: 10 },
  { event: "SessionEnd", timeout: 3 },
];

export const TRUST_NOTE =
  "Codex runs new or changed hooks only after you trust them: start `codex`, run /hooks and approve the coding.sh entries (coding.sh never writes trust hashes; eval runs use --dangerously-bypass-hook-trust).";

/** $CODEX_HOME or ~/.codex. */
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME || join(userHome(env), ".codex");
}

function hooksFile(opts: { scope: "user" | "project"; projectDir?: string }, env = process.env): string {
  if (opts.scope === "user") return join(codexHome(env), "hooks.json");
  if (!opts.projectDir) throw new Error("codex: project scope needs projectDir");
  return join(opts.projectDir, ".codex", "hooks.json");
}

const snake = (event: string) => event.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

/** Events whose trust hash ignores the matcher (codex-rs hooks/src/engine/discovery.rs). */
const MATCHERLESS = new Set(["UserPromptSubmit", "Stop", "Interrupt", "PreModelRequest", "PostModelRequest"]);

function sortedJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(sortedJson).join(",")}]`;
  if (isObj(v)) {
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${sortedJson(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** The trust hash Codex expects for one handler. Read-only use: we compare, never write. */
export function codexTrustHash(event: string, matcher: string | undefined, handler: Record<string, unknown>): string {
  const h: Record<string, unknown> = { type: "command", command: handler.command, timeout: num(handler.timeout) ?? 600, async: handler.async === true };
  if (str(handler.statusMessage)) h.statusMessage = handler.statusMessage;
  if (handler.additionalContextLimit !== undefined) h.additionalContextLimit = handler.additionalContextLimit;
  const id: Record<string, unknown> = { event_name: snake(event), hooks: [h] };
  if (matcher !== undefined && !MATCHERLESS.has(event)) id.matcher = matcher;
  return `sha256:${createHash("sha256").update(sortedJson(id)).digest("hex")}`;
}

/** Our handlers in a hooks.json that Codex will skip because they are not (or no longer) trusted. */
export function untrustedHooks(file: string, env = process.env): string[] {
  let cfg: Record<string, unknown>;
  try {
    cfg = obj(JSON.parse(readTextIfExists(file) ?? "{}"));
  } catch {
    return [];
  }
  let state: Record<string, unknown> = {};
  try {
    state = obj(obj(parseToml(readTextIfExists(join(codexHome(env), "config.toml")) ?? "").hooks).state);
  } catch {
    // unreadable config: everything counts as untrusted
  }
  const out: string[] = [];
  for (const [event, groups] of Object.entries(obj(cfg.hooks))) {
    arr(groups).forEach((g, gi) => {
      arr(obj(g).hooks).forEach((h, hi) => {
        if (!isOurEntry(h, CODEX_AGENT)) return;
        const s = obj(state[`${file}:${snake(event)}:${gi}:${hi}`]);
        if (s.trusted_hash !== codexTrustHash(event, str(obj(g).matcher), obj(h))) out.push(event);
      });
    });
  }
  return out;
}

function featureDisabled(env = process.env): boolean {
  try {
    const f = obj(parseToml(readTextIfExists(join(codexHome(env), "config.toml")) ?? "").features);
    return f.hooks === false || f.codex_hooks === false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- usage

/** Codex usage: OpenAI-style (input includes cached reads/writes; output includes reasoning). */
export function codexUsage(u: unknown): Usage | undefined {
  if (!isObj(u)) return undefined;
  const input = num(u.input_tokens);
  const cached = num(u.cached_input_tokens) ?? 0;
  const written = num(u.cache_write_input_tokens) ?? 0;
  const out: Usage = {};
  if (input !== undefined) out.inputTokens = Math.max(0, input - cached - written);
  if (num(u.cached_input_tokens) !== undefined) out.cacheReadTokens = cached;
  if (written > 0) out.cacheWriteTokens = written;
  if (num(u.output_tokens) !== undefined) out.outputTokens = u.output_tokens as number;
  return Object.keys(out).length ? out : undefined;
}

// ---------------------------------------------------------------- rollout conversion

export interface RolloutOpts {
  /** "full" (backfill) or "assistant" (Stop window: assistant messages + llm.call only). */
  mode: "full" | "assistant";
  /** Override the session id (default: session_meta.id, the thread id). */
  sessionId?: string;
  /** Only records of this turn (Stop window). */
  turnId?: string;
  /** Emit subagent.start/end into the parent session (backfill of a subagent thread). */
  edges?: boolean;
  runId?: string;
  /** Backfill: emit session.end at the last record when it is older than this (ms). */
  endIfIdleMs?: number;
}

interface Call {
  tool: string;
  input: unknown;
  ts: number;
}

const MODEL_OUTPUT = new Set(["reasoning", "function_call", "custom_tool_call", "local_shell_call"]);

/** A backfilled rollout whose last record is older than this is treated as finished (gets a session.end). */
export const ROLLOUT_IDLE_MS = 30 * 60_000;

function textOf(content: unknown): string {
  return arr(content)
    .map((c) => (isObj(c) && typeof c.text === "string" ? c.text : ""))
    .filter(Boolean)
    .join("\n");
}

function parseMaybeJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return v;
  try {
    return JSON.parse(t);
  } catch {
    return v;
  }
}

function toolName(p: Record<string, unknown>): { tool: string; server?: string; namespace?: string } {
  const name = str(p.name) ?? (p.type === "local_shell_call" ? "local_shell" : "unknown");
  const ns = str(p.namespace);
  if (ns?.startsWith("mcp__")) return { tool: `${ns}__${name}`, server: ns.slice(5) };
  return { tool: name, namespace: ns };
}

const mcpServerOf = (tool: string) => (tool.startsWith("mcp__") ? tool.split("__")[1] : undefined);

function relPath(p: string, cwd?: string): string {
  if (cwd && isAbsolute(p)) {
    const r = relative(cwd, p);
    if (r && !r.startsWith("..") && !isAbsolute(r)) return r.split("\\").join("/");
  }
  return p;
}

function diffStats(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+") && !l.startsWith("+++")) additions++;
    else if (l.startsWith("-") && !l.startsWith("---")) deletions++;
  }
  return { additions, deletions };
}

/** Unified diff for one entry of a Codex FileChange item: its unified_diff (+ header), or the added file's content. */
function fileDiff(rel: string, op: "add" | "modify" | "delete", c: Record<string, unknown>): string | undefined {
  if (typeof c.unified_diff === "string" && c.unified_diff.trim()) return /^(---|diff --git) /m.test(c.unified_diff) ? c.unified_diff : diffHeader(rel, op) + c.unified_diff;
  if (op === "add" && typeof c.content === "string") return unifiedDiff(rel, "", c.content, "add");
  return undefined;
}

/**
 * Converts rollout records to events. Handles both rollout generations:
 * - ≥0.160: event_msg item_completed (UserMessage/AgentMessage/CommandExecution/
 *   FileChange/McpToolCall) + token_usage_record (per response, with response_id);
 * - older: event_msg user_message/agent_message + token_count.
 * Tool calls come from response_item function_call/custom_tool_call (+ outputs).
 */
export class CodexRolloutConverter {
  readonly ctx: NormalizeContext;
  readonly opts: RolloutOpts;
  readonly flags: { items: boolean; usageRecords: boolean };
  sessionId: string;
  parent?: { sessionId: string; type?: string; description?: string };
  cwd?: string;
  model?: string;
  version?: string;
  provider?: string;
  turnId?: string;
  /** This thread's agent path in a multi-agent session ("/root" for the main thread). */
  agentPath = "/root";
  private historyStart?: number;
  private started = false;
  private lastInputTs?: number;
  private firstOutputTs?: number;
  private lastTs = 0;
  private lastOk?: boolean;
  private lastTotal?: number;
  private readonly calls = new Map<string, Call>();
  private readonly prompts = new Map<string, number>();
  private readonly seen = new Set<string>();
  readonly events: AgentEvent[] = [];

  constructor(ctx: NormalizeContext, opts: RolloutOpts, flags: { items: boolean; usageRecords: boolean }, fallbackSessionId: string) {
    this.ctx = ctx;
    this.opts = opts;
    this.flags = flags;
    this.sessionId = opts.sessionId ?? fallbackSessionId;
  }

  /** First pass: which rollout generation is this file? */
  static scan(rec: unknown, flags: { items: boolean; usageRecords: boolean }): void {
    if (!isObj(rec)) return;
    if (rec.type === "token_usage_record") flags.usageRecords = true;
    if (rec.type === "event_msg" && obj(rec.payload).type === "item_completed") {
      const t = obj(obj(rec.payload).item).type;
      if (t === "UserMessage" || t === "AgentMessage") flags.items = true;
    }
  }

  private emitter(ts: number, ord: number, turnId = this.turnId): Emitter {
    return new Emitter(
      this.ctx,
      { agent: CODEX_AGENT, sessionId: this.sessionId, ts, cwd: this.cwd, model: this.model, agentVersion: this.version, runId: this.opts.runId, turnId, subagentId: this.parent ? this.sessionId : undefined },
      ["rollout", ord],
    );
  }

  private push(em: Emitter): void {
    for (const e of em.events) {
      if (this.seen.has(e.id)) continue;
      this.seen.add(e.id);
      this.events.push(e);
    }
  }

  private inTurn(turnId: string | undefined): boolean {
    return this.opts.turnId === undefined || (turnId ?? this.turnId) === this.opts.turnId;
  }

  async add(rec: unknown, lineNo: number): Promise<void> {
    if (!isObj(rec)) return;
    const p = obj(rec.payload);
    const ts = toMs(rec.timestamp, this.lastTs);
    const ord = num(rec.ordinal) ?? lineNo;
    const full = this.opts.mode === "full";
    if (rec.type === "session_meta") {
      if (this.started) return;
      this.started = true;
      const spawn = obj(obj(obj(p.source).subagent).thread_spawn);
      this.sessionId = this.opts.sessionId ?? str(p.id) ?? str(p.session_id) ?? this.sessionId;
      this.cwd = str(p.cwd);
      this.version = str(p.cli_version);
      this.provider = str(p.model_provider);
      this.historyStart = num(p.subagent_history_start_ordinal);
      const parentId = str(p.parent_thread_id) ?? str(spawn.parent_thread_id);
      if (parentId && parentId !== this.sessionId) this.parent = { sessionId: parentId, type: str(p.agent_role) ?? str(spawn.agent_role) ?? undefined, description: str(p.agent_path) ?? str(spawn.agent_path) };
      this.agentPath = str(p.agent_path) ?? str(spawn.agent_path) ?? this.agentPath;
      if (!full) return;
      const em = this.emitter(toMs(p.timestamp, ts), ord);
      const git = obj(p.git);
      const payload: Record<string, unknown> = { source: "rollout", originator: str(p.originator), launch: typeof p.source === "string" ? p.source : undefined, provider: this.provider, gitBranch: str(git.branch), gitCommit: str(git.commit_hash) };
      if (this.parent) Object.assign(payload, parentLink(this.ctx, CODEX_AGENT, this.parent.sessionId, this.sessionId, this.parent.type));
      // Threads T3 Code ran (codex app-server with its originator) belong to T3 Code.
      if (payload.originator && T3_ORIGINATOR.test(payload.originator as string)) payload.via = T3_AGENT;
      em.emit("session.start", payload, { key: ["start"] });
      if (this.parent && this.opts.edges !== false) {
        em.emit("subagent.start", { subagentId: this.sessionId, type: this.parent.type, description: this.parent.description, childSessionId: this.sessionId }, { sessionId: this.parent.sessionId, subagentId: undefined, turnId: undefined, key: [this.sessionId] });
      }
      this.push(em);
      return;
    }
    // Subagent threads start with a copy of the parent's history: skip it.
    if (this.historyStart !== undefined && ord < this.historyStart) return;
    this.lastTs = Math.max(this.lastTs, ts);

    const type = rec.type;
    const pt = str(p.type);
    if (type === "turn_context") {
      this.turnId = str(p.turn_id) ?? this.turnId;
      this.model = str(p.model) ?? this.model;
      this.cwd = str(p.cwd) ?? this.cwd;
      return;
    }
    const em = this.emitter(ts, ord);
    if (type === "event_msg") {
      if (pt === "task_started") {
        this.turnId = str(p.turn_id) ?? this.turnId;
        em.base.turnId = this.turnId;
        this.markInput(ts);
      } else if ((pt === "task_complete" || pt === "turn_aborted") && full && this.inTurn(str(p.turn_id))) {
        const ok = pt === "task_complete" && p.error == null;
        this.lastOk = ok;
        const turn = str(p.turn_id) ?? this.turnId;
        em.emit("turn.end", { ok, status: pt === "turn_aborted" ? (str(p.reason) ?? "aborted") : undefined, ttftMs: num(p.time_to_first_token_ms) }, { key: [turn ?? ord], turnId: turn, durationMs: num(p.duration_ms) });
      } else if (pt === "item_completed") {
        await this.item(em, p, ts, full);
      } else if ((pt === "user_message" || pt === "agent_message") && !this.flags.items) {
        if (pt === "user_message") {
          this.markInput(ts);
          if (full) await this.userMessage(em, str(p.message) ?? "", ["um", ord]);
        } else if (this.inTurn(undefined)) {
          const t = await clipText(this.ctx, str(p.message) ?? "");
          if (t.value) em.emit("assistant.message", { text: t.value, truncated: t.truncated || undefined }, { key: ["am", ord], blobs: blobList(t.blob) });
        }
      } else if (pt === "token_count" && !this.flags.usageRecords) {
        const info = obj(p.info);
        const total = num(obj(info.total_token_usage).total_tokens);
        if (isObj(info.last_token_usage) && total !== this.lastTotal && this.inTurn(undefined)) {
          this.lastTotal = total;
          this.llmCall(em, ts, info.last_token_usage, ["tc", ord]);
        }
      } else if (pt === "context_compacted" && full) {
        em.emit("context.compact", {}, { key: ["compact", ord] });
      } else if (pt === "error" && full) {
        em.emit("error", { message: (str(p.message) ?? "error").slice(0, 1000) });
      }
    } else if (type === "token_usage_record") {
      if (this.inTurn(str(p.turn_id))) this.llmCall(em, ts, p.usage, [str(p.response_id) ?? `ord:${ord}`], str(p.turn_id), str(p.response_id));
    } else if (type === "compacted") {
      this.markInput(ts);
      if (full) em.emit("context.compact", { windowNumber: num(p.window_number) }, { key: ["compact", str(p.window_id) ?? ord] });
    } else if (type === "response_item") {
      if (pt && MODEL_OUTPUT.has(pt)) this.firstOutputTs ??= ts;
      // Inter-agent mail: only what this thread sends is model output; a message from another agent is input.
      if (pt === "agent_message") {
        const author = str(p.author);
        if (author === undefined || author === this.agentPath) this.firstOutputTs ??= ts;
        else this.markInput(ts);
      }
      if (pt === "message" && p.role === "assistant") this.firstOutputTs ??= ts;
      if (pt?.endsWith("_output")) this.markInput(ts); // a tool result starts the next model call
      if (full) await this.responseItem(em, p, pt, ts);
    }
    this.push(em);
  }

  private markInput(ts: number): void {
    this.lastInputTs = ts;
    this.firstOutputTs = undefined;
  }

  private llmCall(em: Emitter, ts: number, u: unknown, key: (string | number)[], turnId?: string, responseId?: string): void {
    const usage = codexUsage(u);
    const start = this.lastInputTs !== undefined && this.lastInputTs <= ts ? this.lastInputTs : ts;
    const durationMs = ts - start;
    const ttftMs = this.firstOutputTs !== undefined && this.firstOutputTs >= start ? this.firstOutputTs - start : undefined;
    const out = usage?.outputTokens;
    em.emit(
      "llm.call",
      { provider: this.provider, responseModel: this.model, ok: true, ttftMs, tokensPerSec: out && durationMs > 0 ? Math.round((out / (durationMs / 1000)) * 10) / 10 : undefined, responseId },
      { key, ts: start, durationMs, usage, turnId: turnId ?? this.turnId },
    );
    // The next call starts when this one ended, unless a tool result/prompt arrives later.
    this.markInput(ts);
  }

  private async userMessage(em: Emitter, text: string, fallbackKey: (string | number)[]): Promise<void> {
    const t = await clipText(this.ctx, text);
    if (!t.value) return;
    const turn = this.turnId;
    const n = turn ? (this.prompts.get(turn) ?? 0) : 1;
    if (turn) this.prompts.set(turn, n + 1);
    em.emit("user.message", { text: t.value, truncated: t.truncated || undefined }, { key: n === 0 ? ["prompt", turn!] : fallbackKey, blobs: blobList(t.blob) });
  }

  private async item(em: Emitter, p: Record<string, unknown>, ts: number, full: boolean): Promise<void> {
    const it = obj(p.item);
    const id = str(it.id) ?? `item:${ts}`;
    const turn = str(p.turn_id) ?? this.turnId;
    const t0 = toMs(p.started_at_ms, ts);
    const t1 = toMs(p.completed_at_ms, ts);
    switch (it.type) {
      case "UserMessage":
        this.markInput(ts);
        if (full) await this.userMessage(em, textOf(it.content), [id]);
        return;
      case "AgentMessage": {
        if (!this.inTurn(turn)) return;
        const t = await clipText(this.ctx, textOf(it.content));
        if (t.value) em.emit("assistant.message", { text: t.value, truncated: t.truncated || undefined, phase: str(it.phase) }, { key: [id], ts: t1, turnId: turn, blobs: blobList(t.blob) });
        return;
      }
    }
    if (!full) return;
    switch (it.type) {
      case "CommandExecution": {
        const input = { command: shellCommandOf("shell", { command: it.command }) ?? "" };
        const ok = it.status === "completed" && (num(it.exit_code) ?? 0) === 0;
        const text = str(it.aggregated_output) ?? [str(it.stdout), str(it.stderr)].filter(Boolean).join("\n");
        await this.toolPair(em, { id, tool: "Bash", input, t0, t1, ok, text, turn, exitCode: num(it.exit_code) });
        return;
      }
      case "McpToolCall": {
        const tool = `mcp__${str(it.server) ?? "unknown"}__${str(it.tool) ?? "unknown"}`;
        const ok = it.status === "completed" && it.error == null;
        await this.toolPair(em, { id, tool, input: it.arguments, t0, t1, ok, text: ok ? (outputText(obj(it.result).content) ?? "") : JSON.stringify(it.error ?? "").slice(0, 2000), turn, server: str(it.server) });
        return;
      }
      case "FileChange": {
        if (it.status === "failed" || it.status === "declined") return;
        for (const [path, ch] of Object.entries(obj(it.changes))) {
          const c = obj(ch);
          const op = c.type === "add" ? "add" : c.type === "delete" ? "delete" : "modify";
          const stats = typeof c.unified_diff === "string" ? diffStats(c.unified_diff) : typeof c.content === "string" ? { additions: c.content === "" ? 0 : c.content.replace(/\n$/, "").split("\n").length, deletions: 0 } : {};
          const moved = str(c.move_path);
          const rel = relPath(path, this.cwd);
          const d = await clipDiff(this.ctx, fileDiff(rel, op, c));
          em.emit(
            "file.change",
            { path: rel, op, ...stats, movedTo: moved && moved !== "None" ? relPath(moved, this.cwd) : undefined, tool: "apply_patch", toolUseId: id, diff: d.diff, diffTruncated: d.diffTruncated },
            { key: [id, rel], ts: t1, turnId: turn, blobs: blobList(d.blob) },
          );
        }
        return;
      }
    }
  }

  private async toolPair(em: Emitter, o: { id: string; tool: string; input: unknown; t0: number; t1: number; ok: boolean; text: string; turn?: string; server?: string; exitCode?: number }): Promise<void> {
    const inp = await clipValue(this.ctx, o.input);
    em.emit("tool.start", { tool: o.tool, toolUseId: o.id, input: inp.value, server: o.server }, { key: [o.id], ts: o.t0, turnId: o.turn, blobs: blobList(inp.blob) });
    const out = await clipText(this.ctx, o.text);
    em.emit("tool.end", { tool: o.tool, toolUseId: o.id, ok: o.ok, durationMs: o.t1 - o.t0, output: out.value, exitCode: o.exitCode }, { key: [o.id], ts: o.t1, turnId: o.turn, durationMs: o.t1 - o.t0, blobs: blobList(out.blob) });
    await emitDerived(em, { tool: o.tool === "Bash" ? "shell" : o.tool, toolUseId: o.id, input: o.input, output: o.text, ok: o.ok, cwd: this.cwd, extra: { ts: o.t1, turnId: o.turn } });
  }

  private async responseItem(em: Emitter, p: Record<string, unknown>, pt: string | undefined, ts: number): Promise<void> {
    if (pt === "function_call" || pt === "custom_tool_call" || pt === "local_shell_call") {
      const id = str(p.call_id) ?? str(p.id);
      if (!id) return;
      const { tool, server, namespace } = toolName(p);
      const input = pt === "function_call" ? parseMaybeJson(p.arguments) : pt === "custom_tool_call" ? p.input : obj(p.action);
      this.calls.set(id, { tool, input, ts });
      const inp = await clipValue(this.ctx, input);
      em.emit("tool.start", { tool, toolUseId: id, input: inp.value, server, namespace }, { key: [id], blobs: blobList(inp.blob) });
    } else if (pt === "function_call_output" || pt === "custom_tool_call_output" || pt === "local_shell_call_output") {
      const id = str(p.call_id);
      if (!id) return;
      const call = this.calls.get(id);
      this.calls.delete(id);
      const tool = call?.tool ?? "unknown";
      const parsed = parseMaybeJson(p.output);
      const meta = obj(obj(parsed).metadata);
      const exit = num(meta.exit_code) ?? num(obj(parsed).exit_code);
      const ok = (exit ?? 0) === 0 && obj(p.output).success !== false;
      const text = (isObj(parsed) && typeof parsed.output === "string" ? parsed.output : outputText(parsed)) ?? "";
      const o = await clipText(this.ctx, text);
      const durationMs = call ? ts - call.ts : undefined;
      em.emit("tool.end", { tool, toolUseId: id, ok, durationMs, output: o.value, exitCode: exit }, { key: [id], durationMs, blobs: blobList(o.blob) });
      await emitDerived(em, { tool, toolUseId: id, input: call?.input, output: text, ok, cwd: this.cwd });
    }
  }

  finish(): AgentEvent[] {
    if (this.parent && this.opts.mode === "full" && this.opts.edges !== false && this.started) {
      const em = this.emitter(this.lastTs, -1, undefined);
      em.emit("subagent.end", { subagentId: this.sessionId, ok: this.lastOk, childSessionId: this.sessionId }, { sessionId: this.parent.sessionId, subagentId: undefined, turnId: undefined, key: [this.sessionId] });
      this.push(em);
    }
    const idle = this.opts.endIfIdleMs;
    if (this.opts.mode === "full" && this.started && this.lastTs > 0 && idle !== undefined && Date.now() - this.lastTs > idle) {
      const em = this.emitter(this.lastTs, -2, undefined);
      // Keyed by the last record's time: a resumed thread gets a later end instead of keeping a stale one.
      em.emit("session.end", { reason: "idle" }, { key: ["idle", this.lastTs], turnId: undefined });
      this.push(em);
    }
    return this.events;
  }
}

/** Convert one rollout file (two streaming passes: detect generation, then convert). */
export async function convertRollout(ctx: NormalizeContext, path: string, opts: RolloutOpts): Promise<AgentEvent[]> {
  const flags = { items: false, usageRecords: false };
  try {
    for await (const r of readJsonl(path)) CodexRolloutConverter.scan(r.value, flags);
  } catch {
    return [];
  }
  const fallback = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(path)?.[1] ?? basename(path, ".jsonl");
  const conv = new CodexRolloutConverter(ctx, opts, flags, fallback);
  try {
    for await (const r of readJsonl(path)) await conv.add(r.value, r.lineNo);
  } catch {
    // truncated file: keep what was converted
  }
  return conv.finish();
}

// ---------------------------------------------------------------- normalize

const CALL_TAIL_BYTES = 2 * 1024 * 1024;

/**
 * Codex hooks carry no tool timing. The rollout records the model's tool call
 * (response_item with call_id = tool_use_id) before PostToolUse fires, so the
 * duration is PostToolUse ts − that record's timestamp. Best effort: undefined
 * when the call is not in the transcript tail.
 */
async function callStartTs(path: string | undefined, callId: string, endTs: number): Promise<number | undefined> {
  if (!path) return undefined;
  let recs: unknown[];
  try {
    recs = await readJsonlTail(path, CALL_TAIL_BYTES);
  } catch {
    return undefined;
  }
  for (let i = recs.length - 1; i >= 0; i--) {
    const r = obj(recs[i]);
    const p = obj(r.payload);
    if (r.type === "response_item" && p.call_id === callId && (p.type === "function_call" || p.type === "custom_tool_call" || p.type === "local_shell_call")) {
      const t = toMs(r.timestamp, NaN);
      return Number.isFinite(t) && t <= endTs ? endTs - t : undefined;
    }
  }
  return undefined;
}

export async function normalizeCodexLine(line: SpoolLine, ctx: NormalizeContext): Promise<AgentEvent[]> {
  // `coding.sh run --agent <id> -- …` spools its session.start/file.change/session.end under this agent id.
  if (isWrapperLine(line)) return normalizeWrapperLine(line, ctx);
  const raw = obj(lineRaw(line));
  const event = str(raw.hook_event_name) ?? line.event;
  const rootSid = str(raw.session_id) ?? `ppid-${line.ppid ?? line.pid}`;
  const agentId = str(raw.agent_id);
  // Subagents are real Codex threads; their hook events carry agent_id (the thread id).
  const inChild = agentId !== undefined && agentId !== rootSid && event !== "SubagentStart" && event !== "SubagentStop";
  const sessionId = inChild ? agentId : rootSid;
  const turnId = str(raw.turn_id);
  const em = new Emitter(
    ctx,
    { agent: CODEX_AGENT, sessionId, ts: line.ts, cwd: str(raw.cwd) ?? line.cwd, model: str(raw.model), runId: line.runId, turnId, subagentId: inChild ? agentId : undefined },
    ["hook", ...lineKey(line, ctx), event],
  );
  const tool = str(raw.tool_name) ?? "unknown";
  const toolUseId = str(raw.tool_use_id) ?? ctx.id(sessionId, "tool", ...lineKey(line, ctx));
  const extra: AgentEvent[] = [];

  switch (event) {
    case "SessionStart":
      em.emit("session.start", { source: "hook", startSource: str(raw.source), transcriptPath: str(raw.transcript_path), permissionMode: str(raw.permission_mode) }, { key: ["start"] });
      break;
    case "UserPromptSubmit": {
      const t = await clipText(ctx, str(raw.prompt) ?? "");
      em.emit("user.message", { text: t.value, truncated: t.truncated || undefined }, { key: turnId ? ["prompt", turnId] : undefined, blobs: blobList(t.blob) });
      break;
    }
    case "PreToolUse": {
      const inp = await clipValue(ctx, raw.tool_input);
      em.emit("tool.start", { tool, toolUseId, input: inp.value, server: mcpServerOf(tool) }, { key: [toolUseId], blobs: blobList(inp.blob) });
      break;
    }
    case "PostToolUse": {
      const resp = raw.tool_response;
      const r = obj(resp);
      const exit = num(r.exit_code) ?? num(r.exitCode);
      const ok = (exit ?? 0) === 0 && r.success !== false && r.error == null;
      const text = outputText(resp) ?? "";
      const o = await clipText(ctx, text);
      const durationMs = num(r.duration_ms) ?? num(raw.duration_ms) ?? (await callStartTs(str(raw.transcript_path), toolUseId, line.ts));
      em.emit("tool.end", { tool, toolUseId, ok, durationMs, output: o.value, exitCode: exit }, { key: [toolUseId], durationMs, blobs: blobList(o.blob) });
      await emitDerived(em, { tool, toolUseId, input: raw.tool_input, output: text, ok, cwd: em.base.cwd });
      break;
    }
    case "PreCompact":
    case "PostCompact":
      em.emit("context.compact", { trigger: str(raw.trigger) }, { key: ["compact", turnId ?? line.ts, event] });
      break;
    case "Stop": {
      const path = str(raw.transcript_path);
      if (path && turnId) extra.push(...(await convertRollout(ctx, path, { mode: "assistant", sessionId, turnId, runId: line.runId })));
      if (!extra.some((e) => e.kind === "assistant.message") && str(raw.last_assistant_message)) {
        const t = await clipText(ctx, raw.last_assistant_message as string);
        em.emit("assistant.message", { text: t.value, truncated: t.truncated || undefined }, { blobs: blobList(t.blob) });
      }
      em.emit("turn.end", { ok: true, stopHookActive: raw.stop_hook_active === true || undefined }, { key: turnId ? [turnId] : undefined });
      break;
    }
    case "SubagentStart": {
      const id = agentId ?? toolUseId;
      const type = str(raw.agent_type);
      em.emit("subagent.start", { subagentId: id, type, childSessionId: id }, { key: [id] });
      em.emit("session.start", { source: "subagent", ...parentLink(ctx, CODEX_AGENT, rootSid, id, type) }, { sessionId: id, subagentId: id, turnId: undefined, key: ["start"] });
      break;
    }
    case "SubagentStop": {
      const id = agentId ?? toolUseId;
      const path = str(raw.agent_transcript_path);
      // Tools/prompts inside the subagent arrive as their own hook events; take model calls + replies from its rollout.
      if (path) extra.push(...(await convertRollout(ctx, path, { mode: "assistant", sessionId: id, edges: false, runId: line.runId })));
      const r = str(raw.last_assistant_message) ? await clipText(ctx, raw.last_assistant_message as string) : undefined;
      em.emit("subagent.end", { subagentId: id, type: str(raw.agent_type), ok: true, result: r?.value, childSessionId: id }, { key: [id], blobs: blobList(r?.blob) });
      em.emit("session.end", { reason: "subagent-stop" }, { sessionId: id, subagentId: id, turnId: undefined, key: ["end"] });
      break;
    }
    case "SessionEnd":
      em.emit("session.end", { reason: str(raw.reason) }, { key: ["end"] });
      break;
    default:
      em.emit("notification", { hookEvent: event });
  }
  await em.attachRaw(lineRaw(line));
  const seen = new Set<string>();
  return [...em.events, ...extra].filter((e) => !seen.has(e.id) && !!seen.add(e.id));
}

// ---------------------------------------------------------------- backfill

async function* backfillCodex(ctx: NormalizeContext, opts: BackfillOpts = {}): AsyncIterable<AgentEvent> {
  const home = codexHome();
  for (const dir of ["sessions", "archived_sessions"]) {
    for await (const f of walkFiles(join(home, dir), { match: (n) => /^rollout-.*\.jsonl$/.test(n), maxDepth: 4, since: opts.since })) {
      if (opts.changed && !(await opts.changed(f))) continue; // unchanged since the last backfill
      for (const e of await convertRollout(ctx, f.path, { mode: "full", endIfIdleMs: ROLLOUT_IDLE_MS })) if (opts.since === undefined || e.ts >= opts.since) yield e;
    }
  }
}

// ---------------------------------------------------------------- run

function execHelp(bin: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve) => {
    try {
      execFile(bin, ["exec", "--help"], { timeout: 5000, env, maxBuffer: 1 << 20 }, (_e, out, err) => resolve(`${out ?? ""}\n${err ?? ""}`));
    } catch {
      resolve("");
    }
  });
}

/** `codex exec --json` argv for a run (exported for tests). */
export function codexExecArgs(spec: Pick<RunSpec, "cwd" | "model" | "flags">, help: string): string[] {
  const args = ["exec", "--json"];
  // Our run-local hooks are not trusted in the isolated CODEX_HOME; without this they are skipped silently.
  if (help.includes("--dangerously-bypass-hook-trust") && !hasFlag(spec.flags, "--dangerously-bypass-hook-trust")) args.push("--dangerously-bypass-hook-trust");
  if (!hasFlag(spec.flags, "-s", "--sandbox", "--dangerously-bypass-approvals-and-sandbox")) args.push("-s", "workspace-write");
  if (spec.model && !hasFlag(spec.flags, "-m", "--model")) args.push("-m", spec.model);
  if (!hasFlag(spec.flags, "-C", "--cd")) args.push("-C", spec.cwd);
  if (!hasFlag(spec.flags, "--skip-git-repo-check")) args.push("--skip-git-repo-check");
  args.push(...spec.flags, "-"); // instruction on stdin
  return args;
}

export async function runCodex(spec: RunSpec): Promise<AgentRunOutput> {
  const env = runEnv(spec);
  const bin = which("codex", env as NodeJS.ProcessEnv) ?? "codex";
  const args = codexExecArgs(spec, await execHelp(bin, env as NodeJS.ProcessEnv));
  let sessionId: string | undefined;
  let usage: Usage | undefined;
  const res = await runHeadless({
    bin,
    args,
    cwd: spec.cwd,
    env,
    timeoutMs: spec.timeoutMs,
    stdin: spec.instruction,
    onJson: (v) => {
      const o = obj(v);
      if (o.type === "thread.started") sessionId ??= str(o.thread_id);
      if (o.type === "turn.completed") usage = addUsage(usage, codexUsage(o.usage));
    },
  });
  const out: AgentRunOutput = { ...res };
  if (sessionId) out.sessionId = sessionId;
  if (usage) out.usage = usage;
  return out;
}

// ---------------------------------------------------------------- overlay

/** Isolated CODEX_HOME with our hooks and the user's auth. Harness files (config.toml, AGENTS.md) come from the bundle. */
export async function overlayCodex(_bundle: HarnessBundle, runDir: string): Promise<{ env: Record<string, string>; flags: string[] }> {
  const home = join(isolatedHome(runDir), ".codex");
  await applyChanges([planNestedInstall({ agent: CODEX_AGENT, file: join(home, "hooks.json"), hookCommand: paths().hook, events: CODEX_HOOK_EVENTS, marker: true })], { agent: CODEX_AGENT, dryRun: false, noBackup: true });
  await copyIfExists(join(codexHome(), "auth.json"), join(home, "auth.json"));
  return { env: { CODEX_HOME: home }, flags: [] };
}

// ---------------------------------------------------------------- adapter

function withTrustNote(c: FileChange | undefined, project: boolean): FileChange | undefined {
  if (!c || c.action === "delete") return c;
  return { ...c, summary: `${c.summary}. ${TRUST_NOTE}${project ? " Project hooks also load only when the project's .codex/ layer is trusted." : ""}` };
}

export const codex: Adapter = {
  id: CODEX_AGENT,
  displayName: "Codex CLI",
  tier: "A",

  detect() {
    const home = codexHome();
    const file = join(home, "hooks.json");
    return detectAgent({
      bins: ["codex"],
      configDir: home,
      hooked: () => hasOurHooks(CODEX_AGENT, file),
      notes: () => {
        const notes: string[] = [];
        if (featureDisabled()) notes.push("hooks are disabled in config.toml ([features] hooks = false); coding.sh hooks will not run");
        if (hasOurHooks(CODEX_AGENT, file)) {
          const untrusted = untrustedHooks(file);
          if (untrusted.length) notes.push(`${untrusted.length} coding.sh hook(s) not trusted yet (${[...new Set(untrusted)].join(", ")}). ${TRUST_NOTE}`);
        }
        return notes;
      },
    });
  },

  async install(opts: InstallOpts) {
    const change = planNestedInstall({ agent: CODEX_AGENT, file: hooksFile(opts), hookCommand: opts.hookCommand, events: CODEX_HOOK_EVENTS, marker: true });
    return applyHookInstall([withTrustNote(change, opts.scope === "project")], { agent: CODEX_AGENT, dryRun: opts.dryRun });
  },

  async uninstall(opts) {
    return applyHookUninstall([planNestedUninstall(CODEX_AGENT, hooksFile(opts))], { agent: CODEX_AGENT, dryRun: opts.dryRun });
  },

  // [mcp_servers.coding-sh] in $CODEX_HOME/config.toml, as a marked block (comments and formatting kept).
  ...mcpInstaller((env) => ({ agent: CODEX_AGENT, file: join(codexHome(env), "config.toml"), format: "toml" })),

  normalize: normalizeCodexLine,
  backfill: backfillCodex,
  // Until the user approves our hooks in /hooks (or while [features] hooks =
  // false), Codex skips them; the rollouts are then the only capture path.
  tailWhenUnhooked: () => {
    const file = join(codexHome(), "hooks.json");
    if (!hasOurHooks(CODEX_AGENT, file)) return false;
    if (!featureDisabled() && untrustedHooks(file).length === 0) return false;
    const since = installRecord(file)?.ts;
    return since !== undefined ? { since } : {};
  },
  run: runCodex,
  overlay: overlayCodex,

  harnessFiles() {
    return {
      project: ["AGENTS.md", "AGENTS.override.md", "**/AGENTS.md", ".codex/config.toml", ".codex/hooks.json", ".codex/prompts/**", ".codex/skills/**", ".agents/skills/**"],
      user: ["~/.codex/AGENTS.md", "~/.codex/AGENTS.override.md", "~/.codex/config.toml", "~/.codex/prompts/**", "~/.codex/skills/**", "~/.agents/skills/**"],
    };
  },
};

/** The command we install for one event (exported for tests). */
export const codexHookCommand = (hookPath: string, event: string) => buildHookCommand(hookPath, CODEX_AGENT, event);
