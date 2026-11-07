// Private helpers for the "more" adapters (Gemini CLI, Copilot CLI, Amp, Pi,
// Droid, Goose, Aider, wrapper). Kept local so these adapters don't depend on
// src/adapters/_shared, which another module owns and builds in parallel.
//
// Four groups:
//   - config files: JSON(C) read, planned writes with backups, Claude-shaped hook merging
//   - normalization: event builder with deterministic ids, payload clipping into blobs,
//     usage/test/file-change heuristics shared across agents
//   - processes: binary lookup, version probe, headless spawn with a group-kill timeout
//   - transcripts: JSONL readers, directory walks, read-only SQLite copies
import { spawn, execFile } from "../../core/spawn.ts";
import { randomBytes } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import type { AgentRunOutput, FileChange, NormalizeContext, SpoolLine } from "../../core/types.ts";
import type { AgentEvent, AgentId, EventKind, Usage } from "../../schema/index.ts";
import { paths, userHome } from "../../core/paths.ts";
import { sha256Hex } from "../../core/ids.ts";
import { supervise } from "../../core/children.ts";
import { commandOf, isVerifyCommand } from "../../core/sessions.ts";
import { exactUninstall, existedBeforeInstall, forgetInstall, recordInstall, restoreForInstall } from "../_shared/installs.ts";
import { resolveWriteTarget } from "../_shared/files.ts";
import { hookPathForCommand } from "../_shared/hooks.ts";
import { editJsonc, parseJsonc as parseJsoncShared } from "../_shared/jsonc.ts";

export type Json = Record<string, unknown>;

// ---------------------------------------------------------------- tiny accessors

export const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
export const num = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};
export const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

/** Nested lookup: get(o, "a", "b") === o.a?.b. */
export function get(o: unknown, ...path: (string | number)[]): unknown {
  let cur: unknown = o;
  for (const k of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[k];
  }
  return cur;
}

/** First present string among keys of o. */
export function pickStr(o: unknown, ...keys: string[]): string | undefined {
  if (!isObj(o)) return undefined;
  for (const k of keys) {
    const v = str(o[k]);
    if (v) return v;
  }
  return undefined;
}

/** Parse ISO strings, epoch seconds or epoch ms into epoch ms. */
export function toMs(v: unknown): number | undefined {
  if (typeof v === "string") {
    if (/^\d+(\.\d+)?$/.test(v)) return toMs(Number(v));
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : undefined;
  }
  const n = num(v);
  if (n === undefined) return undefined;
  return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
}

export function home(env: NodeJS.ProcessEnv = process.env): string {
  return userHome(env);
}

/** XDG base dirs with the conventional fallbacks (also used on macOS by most CLIs). */
export function xdg(kind: "config" | "data" | "state" | "cache", env: NodeJS.ProcessEnv = process.env): string {
  const key = { config: "XDG_CONFIG_HOME", data: "XDG_DATA_HOME", state: "XDG_STATE_HOME", cache: "XDG_CACHE_HOME" }[kind];
  const v = env[key];
  if (v && isAbsolute(v)) return v;
  const h = home(env);
  return { config: join(h, ".config"), data: join(h, ".local", "share"), state: join(h, ".local", "state"), cache: join(h, ".cache") }[kind];
}

// ---------------------------------------------------------------- hook command

/** The one hook command every adapter installs: node "<hook.mjs>" <agent> <Event>. */
export function hookCmd(hookCommand: string, agent: AgentId, event: string, extra = ""): string {
  return `node "${hookPathForCommand(hookCommand)}" ${agent} ${event}${extra ? ` ${extra}` : ""}`;
}

/** True when a command string is a coding.sh hook for `agent` (works without the marker). */
export function isOurCommand(cmd: unknown, agent: AgentId): boolean {
  return typeof cmd === "string" && /hook\.mjs"?\s/.test(cmd) && new RegExp(`\\s${agent.replace(/[-.]/g, "\\$&")}\\s`).test(`${cmd} `);
}

// ---------------------------------------------------------------- config files

export function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** JSON with comments and trailing commas (settings.json files are often JSONC). One parser for every config path. */
export function parseJsonc(text: string): unknown {
  return parseJsoncShared(text);
}

export class ConfigParseError extends Error {}

/** Read a JSON object file. Missing → undefined text and {}. Unparseable → throws (never clobber). */
export function readJsonObject(path: string): { text: string | undefined; value: Json } {
  const text = readText(path);
  if (text === undefined) return { text, value: {} };
  let v: unknown;
  try {
    v = parseJsonc(text);
  } catch (e) {
    throw new ConfigParseError(`${path}: not valid JSON (${(e as Error).message}); refusing to modify it`);
  }
  if (!isObj(v)) throw new ConfigParseError(`${path}: expected a JSON object; refusing to modify it`);
  return { text, value: v };
}

export const toJson = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

/**
 * New text for a JSON(C) config whose value becomes `next`: a file that exists
 * is edited in place, so comments and layout outside the changed members
 * survive; a new file is plain two-space JSON.
 */
export function jsonEdit(before: string | undefined, next: Json): string {
  return before === undefined || before.trim() === "" ? toJson(next) : editJsonc(before, next);
}

export interface PlannedWrite {
  path: string;
  before: string | undefined;
  /** undefined = delete the file. */
  after: string | undefined;
  summary: string;
  mode?: number;
  /**
   * Hook-config tracking in installs.json, as for the core adapters' hook files:
   * - "install": record the write and what uninstall can restore byte-for-byte
   *   (the pre-install backup when `pristine`, i.e. `before` held none of our entries).
   * - "uninstall": `remaining` is the config left after removing our entries
   *   (undefined = nothing). While the file is untouched since our write and
   *   `remaining` matches the original, the original bytes come back instead of
   *   `after`; a file that existed before install is never deleted.
   */
  track?: "install" | "uninstall";
  pristine?: boolean;
  remaining?: Json;
}

/**
 * Apply planned writes (or just describe them when dryRun). Unchanged files are
 * skipped, so a second install returns []. Existing files are backed up to
 * <data>/backups/<agent>/<ts>-<name> before being modified or deleted.
 */
export function applyWrites(agent: AgentId, writes: PlannedWrite[], dryRun: boolean, env: NodeJS.ProcessEnv = process.env): FileChange[] {
  const changes: FileChange[] = [];
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  for (const planned of writes) {
    const w = planned.track === "uninstall" ? exactUninstallWrite(planned, env) : planned;
    if (w.before === w.after) continue;
    const action: FileChange["action"] = w.before === undefined ? "create" : w.after === undefined ? "delete" : "modify";
    const change: FileChange = { path: w.path, action, summary: w.summary };
    if (w.before !== undefined) change.before = w.before;
    if (w.after !== undefined) change.after = w.after;
    changes.push(change);
    if (dryRun) continue;
    let backup: string | undefined;
    if (w.before !== undefined) {
      const dir = join(paths(env).backups, agent);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const flat = w.path.replace(/^[/\\]+/, "").replace(/[/\\:]+/g, "_");
      backup = join(dir, `${ts}-${flat}`);
      writeFileSync(backup, w.before, { mode: 0o600 });
    }
    if (w.track === "uninstall") forgetInstall(w.path, env);
    if (w.after === undefined) {
      rmSync(w.path, { force: true });
      continue;
    }
    // A symlinked config is written through to its target (the link stays a link).
    const target = resolveWriteTarget(w.path);
    mkdirSync(dirname(target), { recursive: true });
    let mode = w.mode;
    try {
      mode ??= statSync(target).mode & 0o777;
    } catch {
      // new file
    }
    const tmp = `${target}.codingsh-${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, w.after, { mode: mode ?? 0o644 });
    if (mode !== undefined) chmodSync(tmp, mode);
    renameSync(tmp, target);
    if (w.track === "install") recordInstall(agent, w.path, w.after, env, Date.now(), restoreForInstall(w.path, w.before, w.pristine === true, backup, env));
  }
  return changes;
}

/** Swap a tracked uninstall's `after` for the exact original when safe (see PlannedWrite.track). */
function exactUninstallWrite(w: PlannedWrite, env: NodeJS.ProcessEnv): PlannedWrite {
  if (w.before === undefined) return w;
  const exact = exactUninstall(w.path, w.before, w.remaining, { env, parse: parseJsonc });
  if (exact) return { ...w, after: exact.after, summary: `${w.summary} (${exact.summary})` };
  if (w.after === undefined && existedBeforeInstall(w.path, env)) return { ...w, after: toJson(w.remaining ?? {}) };
  return w;
}

// ---------------------------------------------------------------- Claude-shaped hooks

/**
 * The hooks block shape shared by Claude Code, Gemini CLI, Droid, Goose and Qwen:
 *   { hooks: { <Event>: [ { matcher?, hooks: [ { type: "command", command, timeout? } ] } ] } }
 */
export interface ClaudeHookSpec {
  events: readonly string[];
  /** Hook entry for an event (the object inside the inner `hooks` array). */
  entry: (event: string) => Json;
  /** Matcher for an event; undefined = omit the key. */
  matcher?: (event: string) => string | undefined;
  isOurs: (hook: Json) => boolean;
}

/** Remove our hook entries; drops groups/events that only held ours. Returns a new object. */
export function stripClaudeHooks(settings: Json, isOurs: (hook: Json) => boolean): Json {
  const hooks = settings.hooks;
  if (!isObj(hooks)) return settings;
  const next: Json = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      next[event] = groups;
      continue;
    }
    const kept: unknown[] = [];
    for (const g of groups) {
      if (!isObj(g) || !Array.isArray(g.hooks)) {
        if (!(isObj(g) && isOurs(g))) kept.push(g);
        continue;
      }
      const inner = g.hooks.filter((h) => !(isObj(h) && isOurs(h)));
      if (inner.length === g.hooks.length) kept.push(g);
      else if (inner.length > 0) kept.push({ ...g, hooks: inner });
    }
    if (kept.length > 0 || groups.length === 0) next[event] = kept;
  }
  const out: Json = { ...settings };
  if (Object.keys(next).length === 0) delete out.hooks;
  else out.hooks = next;
  return out;
}

/** Strip ours, then append one group per event. Idempotent. */
export function mergeClaudeHooks(settings: Json, spec: ClaudeHookSpec): Json {
  const base = stripClaudeHooks(settings, spec.isOurs);
  const hooks: Json = isObj(base.hooks) ? { ...base.hooks } : {};
  for (const event of spec.events) {
    const group: Json = {};
    const m = spec.matcher?.(event);
    if (m !== undefined) group.matcher = m;
    group.hooks = [spec.entry(event)];
    const prev = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    hooks[event] = [...prev, group];
  }
  // `settings` first fixes the key order: "hooks" keeps its place, so a re-install over keys added after it is a no-op.
  return { ...settings, ...base, hooks };
}

/** Whether any of our hooks are present in a Claude-shaped settings object. */
export function hasClaudeHooks(settings: Json, isOurs: (hook: Json) => boolean): boolean {
  if (!isObj(settings.hooks)) return false;
  for (const groups of Object.values(settings.hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (isObj(g) && isOurs(g)) return true;
      if (isObj(g) && Array.isArray(g.hooks) && g.hooks.some((h) => isObj(h) && isOurs(h))) return true;
    }
  }
  return false;
}

/** True when an object is empty after removing our edits (so a file we created can be deleted). */
export const isEmptyObject = (o: Json): boolean => Object.keys(o).length === 0;

/** Remove `from` and each parent up to and including `upTo` while they are empty directories. */
export function removeEmptyDirs(from: string, upTo: string): void {
  const stop = resolve(upTo);
  for (let d = resolve(from); d === stop || d.startsWith(stop + sep); d = dirname(d)) {
    try {
      if (readdirSync(d).length) return;
      rmdirSync(d);
    } catch {
      return;
    }
    if (d === stop) return;
  }
}

// ---------------------------------------------------------------- normalization

export interface EventBase {
  agent: AgentId;
  sessionId: string;
  ts: number;
  cwd?: string | undefined;
  runId?: string | undefined;
  model?: string | undefined;
  agentVersion?: string | undefined;
  turnId?: string | undefined;
  subagentId?: string | undefined;
}

export type EventExtra = Partial<Omit<AgentEvent, "id" | "v" | "kind" | "payload" | "agent" | "sessionId">> & {
  /**
   * Natural key (a tool call id, a message id): the id becomes
   * ctx.id(agent, session, kind, …key), so the same event seen by a hook and in
   * a backfilled transcript gets one id and is stored once.
   */
  key?: (string | number)[];
};

export interface EmitterOptions {
  /** Key tool.start/tool.end (and their file.change/test.result) by toolUseId. */
  toolKeys?: boolean;
}

/**
 * Builds events with deterministic ids: ctx.id(...idParts, index), or a natural
 * key when one is given. Same input → same ids, so re-ingesting a spool line or
 * transcript record is a no-op.
 */
export class Emitter {
  readonly events: AgentEvent[] = [];
  readonly toolKeys: boolean;
  private readonly ctx: NormalizeContext;
  private readonly base: EventBase;
  private readonly idParts: (string | number)[];
  constructor(ctx: NormalizeContext, base: EventBase, idParts: (string | number)[], opts: EmitterOptions = {}) {
    this.ctx = ctx;
    this.base = base;
    this.idParts = idParts;
    this.toolKeys = opts.toolKeys === true;
  }
  /**
   * turn.end keyed by the turn's last assistant message when it is known, with a
   * matching turnId: the hook's and the transcript's copy of one turn share an
   * id, and buildSession counts the turn once whichever path stored it.
   */
  turnEnd(payload: Json, lastMessage: string | number | undefined, extra: EventExtra = {}): AgentEvent {
    if (lastMessage === undefined) return this.push("turn.end", payload, extra);
    return this.push("turn.end", payload, { ...extra, key: ["last", lastMessage], turnId: this.ctx.id(this.base.agent, this.base.sessionId, "turn", lastMessage) });
  }
  push(kind: EventKind, payload: Json, { key, ...extra }: EventExtra = {}): AgentEvent {
    const e: AgentEvent = {
      id: key ? this.ctx.id(this.base.agent, this.base.sessionId, kind, ...key) : this.ctx.id(...this.idParts, this.events.length),
      v: 0,
      sessionId: this.base.sessionId,
      ts: this.base.ts,
      agent: this.base.agent,
      kind,
      payload: dropUndefined(payload),
    };
    const opt: EventExtra = {
      cwd: this.base.cwd,
      runId: this.base.runId,
      model: this.base.model,
      agentVersion: this.base.agentVersion,
      turnId: this.base.turnId,
      subagentId: this.base.subagentId,
      ...extra,
    };
    for (const [k, v] of Object.entries(opt)) {
      if (v === undefined) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      (e as unknown as Json)[k] = v;
    }
    this.events.push(e);
    return e;
  }
}

export function dropUndefined(o: Json): Json {
  const out: Json = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
}

/**
 * Deterministic id parts for a spool line: its spool position (file + offset)
 * when ingest provides it; otherwise ts + pid plus a content hash that guards
 * same-ms lines from one pid (wrapper).
 */
export function spoolIdParts(line: SpoolLine, sessionId: string, ctx?: Pick<NormalizeContext, "source">): (string | number)[] {
  if (ctx?.source) return ["spool", line.agent, sessionId, line.event, "at", ctx.source.file, ctx.source.offset];
  const h = sha256Hex(JSON.stringify(line.raw ?? line.rawFile ?? null)).slice(0, 16);
  return ["spool", line.agent, sessionId, line.event, line.ts, line.pid, h];
}

/** Per-field inline limit for strings inside payloads. */
export const FIELD_LIMIT = 1024;
/** Whole-payload inline budget (schema: payloads stay < 4 KB). */
export const PAYLOAD_LIMIT = 3072;

function truncateStr(s: string, limit: number): string {
  if (Buffer.byteLength(s) <= limit) return s;
  let cut = s.slice(0, limit);
  while (Buffer.byteLength(cut) > limit) cut = cut.slice(0, -16);
  return `${cut}…[truncated ${Buffer.byteLength(s) - Buffer.byteLength(cut)} bytes]`;
}

function shrink(v: unknown, limit: number, depth = 0): unknown {
  if (typeof v === "string") return truncateStr(v, limit);
  if (Array.isArray(v)) {
    const head = v.slice(0, 20).map((x) => shrink(x, Math.max(128, limit / 2), depth + 1));
    return v.length > 20 ? [...head, `…[${v.length - 20} more]`] : head;
  }
  if (isObj(v)) {
    if (depth > 4) return "[object]";
    const out: Json = {};
    for (const [k, x] of Object.entries(v)) out[k] = shrink(x, limit, depth + 1);
    return out;
  }
  return v;
}

export interface Clipped {
  value: unknown;
  blob?: string;
}

/**
 * Keep `value` inline if small; otherwise store the full value as a blob and
 * return a shrunk preview (long strings truncated, structure kept so that e.g.
 * `input.command` still drives verify detection).
 */
export async function clip(ctx: NormalizeContext, value: unknown, limit = FIELD_LIMIT): Promise<Clipped> {
  if (value === undefined) return { value };
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const cap = Math.min(limit, Math.max(256, ctx.maxInlineBytes || limit));
  if (text === undefined || Buffer.byteLength(text) <= cap) return { value };
  const blob = await ctx.blob(text);
  let preview = shrink(value, Math.min(cap, 512));
  if (Buffer.byteLength(JSON.stringify(preview)) > PAYLOAD_LIMIT) preview = truncateStr(text, Math.min(cap, 512));
  return { value: preview, blob };
}

/** Text from a tool result in any of the common shapes (string, {content:[{text}]}, {output}, …). */
export function textOf(v: unknown, depth = 0): string | undefined {
  if (v === undefined || v === null || depth > 5) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    const parts = v.map((x) => textOf(x, depth + 1)).filter((x): x is string => !!x);
    return parts.length ? parts.join("\n") : undefined;
  }
  if (isObj(v)) {
    for (const k of ["text", "textResultForLlm", "output", "stdout", "content", "llmContent", "returnDisplay", "result", "message", "error"]) {
      const t = textOf(v[k], depth + 1);
      if (t) {
        if (k === "stdout" && typeof v.stderr === "string" && v.stderr) return `${t}\n${v.stderr}`;
        return t;
      }
    }
    return JSON.stringify(v);
  }
  return undefined;
}

/** Usage from any of the common token-count shapes (Anthropic, OpenAI, Gemini, Copilot, Pi, Goose). */
export function usageFrom(o: unknown): Usage | undefined {
  if (!isObj(o)) return undefined;
  const pick = (...ks: string[]): number | undefined => {
    for (const k of ks) {
      const v = num(get(o, ...k.split(".")));
      if (v !== undefined) return v;
    }
    return undefined;
  };
  const u: Usage = {};
  const input = pick("input_tokens", "inputTokens", "input", "prompt_tokens", "promptTokens", "promptTokenCount", "input_token_count");
  const output = pick("output_tokens", "outputTokens", "output", "completion_tokens", "completionTokens", "candidatesTokenCount", "output_token_count");
  const cacheRead = pick("cache_read_input_tokens", "cacheReadTokens", "cacheRead", "cache_read_tokens", "cached", "cachedContentTokenCount", "cachedInputTokens", "cached_tokens", "prompt_tokens_details.cached_tokens");
  const cacheWrite = pick("cache_creation_input_tokens", "cacheWriteTokens", "cacheWrite", "cache_write_tokens", "cache_creation_tokens");
  const cost = pick("total_cost_usd", "costUsd", "cost_usd", "cost.total", "cost", "totalCost");
  if (input !== undefined) u.inputTokens = input;
  if (output !== undefined) u.outputTokens = output;
  if (cacheRead !== undefined) u.cacheReadTokens = cacheRead;
  if (cacheWrite !== undefined) u.cacheWriteTokens = cacheWrite;
  if (cost !== undefined) u.costUsd = cost;
  return Object.keys(u).length ? u : undefined;
}

export function addUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!b) return a;
  const out: Usage = { ...(a ?? {}) };
  for (const k of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd"] as const) {
    const v = b[k];
    if (v !== undefined) out[k] = (out[k] ?? 0) + v;
  }
  return out;
}

export interface TestSummary {
  runner?: string;
  passed: number;
  failed: number;
  skipped?: number;
}

/**
 * Pass/fail counts from common test-runner summaries. Returns the LAST summary
 * found (watch modes and retries print several). Undefined when nothing matched.
 */
export function parseTestSummary(text: string | undefined): TestSummary | undefined {
  if (!text) return undefined;
  const t = text.replace(/\x1b\[[0-9;]*m/g, "");
  let m: RegExpExecArray | null;
  const last = (re: RegExp): RegExpExecArray | null => {
    let found: RegExpExecArray | null = null;
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    while ((m = g.exec(t))) found = m;
    return found;
  };
  const n = (s: string | undefined) => (s ? Number(s) : 0);
  // cargo: test result: ok. 5 passed; 1 failed; 2 ignored
  if ((m = last(/test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/))) return { runner: "cargo", passed: n(m[1]), failed: n(m[2]), skipped: n(m[3]) };
  // jest: Tests:       1 failed, 2 skipped, 5 passed, 8 total
  if ((m = last(/^Tests:\s+(.*\d+ total)$/m))) {
    const s = m[1]!;
    return { runner: "jest", passed: n(/(\d+) passed/.exec(s)?.[1]), failed: n(/(\d+) failed/.exec(s)?.[1]), skipped: n(/(\d+) (?:skipped|pending|todo)/.exec(s)?.[1]) };
  }
  // vitest:      Tests  2 failed | 10 passed | 1 skipped (13)
  if ((m = last(/^\s*Tests\s+((?:\d+ \w+(?: \| )?)+)\s*\(\d+\)/m))) {
    const s = m[1]!;
    return { runner: "vitest", passed: n(/(\d+) passed/.exec(s)?.[1]), failed: n(/(\d+) failed/.exec(s)?.[1]), skipped: n(/(\d+) (?:skipped|todo)/.exec(s)?.[1]) };
  }
  // node:test / tap: "# pass 5" "# fail 1" ("ℹ pass 5" in spec reporter)
  const np = last(/^(?:#|ℹ) pass (\d+)$/m);
  const nf = last(/^(?:#|ℹ) fail (\d+)$/m);
  if (np || nf) {
    const ns = last(/^(?:#|ℹ) skipped (\d+)$/m);
    const r: TestSummary = { runner: "node", passed: n(np?.[1]), failed: n(nf?.[1]) };
    if (ns) r.skipped = n(ns[1]);
    return r;
  }
  // pytest: ==== 3 failed, 10 passed, 1 skipped in 0.52s ====
  if ((m = last(/^=+ (.*?(?:passed|failed|error|errors).*?) in [\d.]+s(?: \([^)]*\))? =+$/m))) {
    const s = m[1]!;
    return {
      runner: "pytest",
      passed: n(/(\d+) passed/.exec(s)?.[1]),
      failed: n(/(\d+) failed/.exec(s)?.[1]) + n(/(\d+) errors?/.exec(s)?.[1]),
      skipped: n(/(\d+) skipped/.exec(s)?.[1]),
    };
  }
  // mocha: "  5 passing (20ms)" "  1 failing"
  const mp = last(/^\s+(\d+) passing\b/m);
  if (mp) {
    const r: TestSummary = { runner: "mocha", passed: n(mp[1]), failed: n(last(/^\s+(\d+) failing\b/m)?.[1]) };
    const pend = last(/^\s+(\d+) pending\b/m);
    if (pend) r.skipped = n(pend[1]);
    return r;
  }
  // go test: count "--- PASS" / "--- FAIL" lines, or package-level ok/FAIL lines
  const goPass = t.match(/^\s*--- PASS:/gm)?.length ?? 0;
  const goFail = t.match(/^\s*--- FAIL:/gm)?.length ?? 0;
  if (goPass || goFail) return { runner: "go", passed: goPass, failed: goFail };
  const pkgOk = t.match(/^ok\s+\S+\s+[\d.]+s/gm)?.length ?? 0;
  const pkgFail = t.match(/^FAIL\s+\S+\s+[\d.]+s/gm)?.length ?? 0;
  if (pkgOk || pkgFail) return { runner: "go", passed: pkgOk, failed: pkgFail };
  return undefined;
}

/** Test summary for a finished shell tool call, only when the command looks like a test/check run. */
export function testResultFor(input: unknown, output: string | undefined): TestSummary | undefined {
  if (!isVerifyCommand(commandOf(input))) return undefined;
  return parseTestSummary(output);
}

export interface FileTouch {
  path: string;
  op: "add" | "modify" | "delete";
}

const EDIT_TOOL = /(write|edit|create|replace|patch|str_?replace|multi_?edit|insert|delete_file|remove_file|new_file|apply_diff|search_replace|text_editor)/i;
const PATH_KEYS = ["file_path", "filePath", "path", "absolute_path", "absolutePath", "target_file", "targetFile", "filename", "file", "notebook_path"];

/** Relative to cwd when inside it, else as given (always "/"-separated). */
export function relPath(p: string, cwd: string | undefined): string {
  let out = p;
  if (cwd && isAbsolute(p)) {
    const r = relative(cwd, p);
    if (r && !r.startsWith("..") && !isAbsolute(r)) out = r;
  }
  return out.split(sep).join("/");
}

/** Files a successful edit-like tool call touched, from its input (and apply_patch bodies). */
export function fileTouches(tool: string, input: unknown, cwd?: string): FileTouch[] {
  const out: FileTouch[] = [];
  const patch = typeof input === "string" ? input : pickStr(input, "patch", "input", "diff", "patchText");
  if (patch && /\*\*\* (?:Add|Update|Delete) File: /.test(patch)) {
    for (const m of patch.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)) {
      out.push({ path: relPath(m[2]!.trim(), cwd), op: m[1] === "Add" ? "add" : m[1] === "Delete" ? "delete" : "modify" });
    }
    return out;
  }
  if (!EDIT_TOOL.test(tool)) return out;
  const p = pickStr(input, ...PATH_KEYS);
  if (!p) {
    // multi-file edits: { edits: [{ file_path }] } / { files: [...] }
    const list = get(input, "edits") ?? get(input, "files");
    if (Array.isArray(list)) for (const x of list) {
      const q = typeof x === "string" ? x : pickStr(x, ...PATH_KEYS);
      if (q) out.push({ path: relPath(q, cwd), op: "modify" });
    }
    return dedupeTouches(out);
  }
  const op: FileTouch["op"] = /delete|remove/i.test(tool) ? "delete" : /create|new_file/i.test(tool) ? "add" : "modify";
  out.push({ path: relPath(p, cwd), op });
  return out;
}

function dedupeTouches(t: FileTouch[]): FileTouch[] {
  const seen = new Set<string>();
  return t.filter((x) => (seen.has(x.path) ? false : (seen.add(x.path), true)));
}

export interface ToolEndArgs {
  tool: string;
  toolUseId: string | undefined;
  input: unknown;
  output: unknown;
  ok: boolean;
  durationMs?: number | undefined;
  error?: string | undefined;
  extra?: EventExtra;
}

/** Natural key for an event of a tool call, when the emitter keys tools by call id. */
const toolKey = (em: Emitter, toolUseId: string | undefined, ...rest: string[]): EventExtra => (em.toolKeys && toolUseId ? { key: [toolUseId, ...rest] } : {});

/** tool.end + derived file.change / test.result events. */
export async function emitToolEnd(em: Emitter, ctx: NormalizeContext, a: ToolEndArgs, cwd: string | undefined): Promise<void> {
  const text = textOf(a.output);
  const out = await clip(ctx, text ?? a.output);
  const payload: Json = { tool: a.tool, toolUseId: a.toolUseId, ok: a.ok, durationMs: a.durationMs, output: out.value, error: a.error };
  em.push("tool.end", payload, { ...(a.durationMs !== undefined ? { durationMs: a.durationMs } : {}), ...a.extra, blobs: [...(a.extra?.blobs ?? []), ...(out.blob ? [out.blob] : [])], ...toolKey(em, a.toolUseId) });
  // Keyed by the path as the call gave it: the two capture paths may know different cwds.
  if (a.ok) for (const f of fileTouches(a.tool, a.input)) emitFileChange(em, { path: relPath(f.path, cwd), op: f.op, tool: a.tool, toolUseId: a.toolUseId }, a.extra, f.path);
  const tr = testResultFor(a.input, text);
  if (tr) em.push("test.result", { ...tr, toolUseId: a.toolUseId }, { ...a.extra, ...toolKey(em, a.toolUseId) });
}

/** file.change of a tool call, keyed like the rest of the call plus the path as the call named it (`keyPath`). */
export function emitFileChange(em: Emitter, payload: { path: string; op: string; tool?: string | undefined; toolUseId?: string | undefined }, extra: EventExtra = {}, keyPath = payload.path): void {
  em.push("file.change", payload, { ...extra, ...toolKey(em, payload.toolUseId, keyPath) });
}

/** tool.start with a clipped input. */
export async function emitToolStart(em: Emitter, ctx: NormalizeContext, tool: string, toolUseId: string | undefined, input: unknown, extra: EventExtra = {}): Promise<void> {
  const c = await clip(ctx, input);
  const payload: Json = { tool, toolUseId, input: c.value };
  if (isVerifyCommand(commandOf(input))) payload.verify = true;
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(tool);
  if (mcp) payload.server = mcp[1];
  em.push("tool.start", payload, { ...extra, blobs: [...(extra.blobs ?? []), ...(c.blob ? [c.blob] : [])], ...toolKey(em, toolUseId) });
}

/** Text event (user/assistant message) with clipping. */
export async function emitText(em: Emitter, ctx: NormalizeContext, kind: "user.message" | "assistant.message", text: string, extra: EventExtra = {}): Promise<void> {
  const c = await clip(ctx, text, 2048);
  em.push(kind, { text: c.value }, { ...extra, blobs: [...(extra.blobs ?? []), ...(c.blob ? [c.blob] : [])] });
}

/** Raw payload blob (blobs[0] on the first event of a line, per the schema). */
export async function rawBlob(ctx: NormalizeContext, raw: unknown): Promise<string | undefined> {
  if (raw === undefined || raw === null) return undefined;
  return ctx.blob(typeof raw === "string" ? raw : JSON.stringify(raw));
}

/** Puts the raw blob first on the first emitted event. */
export function attachRaw(events: AgentEvent[], ref: string | undefined): AgentEvent[] {
  const first = events[0];
  if (first && ref) first.blobs = [ref, ...(first.blobs ?? []).filter((b) => b !== ref)];
  return events;
}

// ---------------------------------------------------------------- processes

/**
 * The node binary that agent plugins (Amp, Pi) spawn the hook with, resolved at
 * install time: the `node` on PATH first, because a stable entry such as
 * /opt/homebrew/bin/node or a version-manager shim survives node upgrades;
 * otherwise the node running coding.sh (process.execPath, which under npx or a
 * version manager can be a versioned path that later disappears).
 */
export function resolveNodePath(env: NodeJS.ProcessEnv = process.env): string {
  // Windows: only node.exe. The plugins call child_process.spawn directly, which cannot run a node.cmd shim.
  return findBinary(["node"], process.platform === "win32" ? { ...env, PATHEXT: ".EXE" } : env) ?? process.execPath;
}

/**
 * A variable from an env object. Windows env names are case-insensitive, and a copy of
 * process.env (`{ ...process.env, ...overrides }`) keeps Windows' own spelling ("Path"), so
 * there the exact name wins, then any spelling.
 */
export function envVar(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (env[name] !== undefined || platform !== "win32") return env[name];
  const up = name.toUpperCase();
  return Object.entries(env).find(([k]) => k.toUpperCase() === up)?.[1];
}

/** Find a binary on PATH (plus `extra` absolute candidates). */
export function findBinary(names: readonly string[], env: NodeJS.ProcessEnv = process.env, extra: readonly string[] = []): string | undefined {
  const exts = process.platform === "win32" ? (envVar(env, "PATHEXT") ?? ".EXE;.CMD;.BAT").split(";").map((e) => e.toLowerCase()) : [""];
  for (const dir of (envVar(env, "PATH") ?? "").split(delimiter).filter(Boolean)) {
    for (const n of names) for (const e of exts) {
      const p = join(dir, n + e);
      try {
        const s = statSync(p);
        if (s.isFile() && (process.platform === "win32" || (s.mode & 0o111) !== 0)) return p;
      } catch {
        // not here
      }
    }
  }
  for (const p of extra) if (existsSync(p)) return p;
  return undefined;
}

/** `<bin> --version` → first version-looking token (5 s budget, never throws). */
export function binVersion(bin: string, args: string[] = ["--version"], timeoutMs = 5000): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(bin, args, { timeout: timeoutMs, env: { ...process.env, NO_COLOR: "1", CI: "1" }, windowsHide: true }, (_err, stdout, stderr) => {
        const text = `${stdout ?? ""}\n${stderr ?? ""}`;
        resolve(/\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/.exec(text)?.[0]);
      });
    } catch {
      resolve(undefined);
    }
  });
}

class Tail {
  private buf = "";
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  push(s: string): void {
    this.buf += s;
    if (this.buf.length > this.max * 2) this.buf = this.buf.slice(-this.max);
  }
  text(): string {
    return this.buf.slice(-this.max);
  }
}

export interface SpawnOpts {
  bin: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
  stdin?: string;
  /** Called for each complete stdout line (stream-json parsers). */
  onLine?: (line: string) => void;
  tailBytes?: number;
  /** Stop the agent's process group on abort (default: the ambient signal, see core/children.ts). */
  signal?: AbortSignal;
}

export interface SpawnResult {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
}

/**
 * Spawn an agent headless (argv array, no shell). On timeout or abort the whole
 * process group is SIGTERMed, then SIGKILLed 3 s later; stragglers are reaped
 * when the agent exits.
 */
export function spawnAgent(o: SpawnOpts): Promise<SpawnResult> {
  const started = Date.now();
  const max = o.tailBytes ?? 16 * 1024;
  const out = new Tail(max);
  const err = new Tail(max);
  let partial = "";
  const posix = process.platform !== "win32";
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(o.bin, o.args, {
      cwd: o.cwd,
      env: o.env as NodeJS.ProcessEnv,
      stdio: [o.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: posix,
      windowsHide: true,
    });
  } catch (e) {
    return Promise.resolve({ exitCode: 127, timedOut: false, durationMs: 0, stdoutTail: "", stderrTail: (e as Error).message });
  }
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (s: string) => {
    out.push(s);
    if (!o.onLine) return;
    partial += s;
    let i: number;
    while ((i = partial.indexOf("\n")) >= 0) {
      const line = partial.slice(0, i).replace(/\r$/, "");
      partial = partial.slice(i + 1);
      if (line.trim()) safeCall(o.onLine, line);
    }
  });
  child.stderr?.on("data", (s: string) => err.push(s));
  child.stdin?.on("error", () => {}); // the agent may exit without reading stdin
  if (o.stdin !== undefined) child.stdin?.end(o.stdin);
  return supervise(child, { group: posix, timeoutMs: o.timeoutMs, termGraceMs: 3000, signal: o.signal }).then((r) => {
    if (o.onLine && partial.trim()) safeCall(o.onLine, partial);
    const extraErr = r.error ? r.error.message : r.aborted ? "aborted" : undefined;
    return {
      exitCode: r.error ? (r.error.code === "ENOENT" ? 127 : 126) : r.code,
      timedOut: r.timedOut,
      durationMs: Date.now() - started,
      stdoutTail: out.text(),
      stderrTail: extraErr ? `${err.text()}\n${extraErr}` : err.text(),
    };
  });
}

function safeCall(f: (l: string) => void, l: string): void {
  try {
    f(l);
  } catch {
    // parser bugs must not break the run
  }
}

/** Env for a headless run: inherit, overlay spec.env, tag CODING_SH_RUN_ID, keep it non-interactive. */
export function runEnv(spec: { env: Record<string, string>; runId: string }, extra: Record<string, string> = {}): Record<string, string | undefined> {
  return { ...process.env, CI: process.env.CI ?? "1", NO_COLOR: "1", ...extra, ...spec.env, CODING_SH_RUN_ID: spec.runId };
}

/** Parse each stdout line as JSON; non-JSON lines are ignored. */
export function jsonLines(onJson: (o: Json) => void): (line: string) => void {
  return (line) => {
    const t = line.trim();
    if (!t.startsWith("{")) return;
    try {
      const v = JSON.parse(t);
      if (isObj(v)) onJson(v);
    } catch {
      // partial or log line
    }
  };
}

export function toRunOutput(r: SpawnResult, sessionId: string | undefined, usage: Usage | undefined): AgentRunOutput {
  const o: AgentRunOutput = { exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs, stdoutTail: r.stdoutTail, stderrTail: r.stderrTail };
  if (sessionId) o.sessionId = sessionId;
  if (usage) o.usage = usage;
  return o;
}

/** Flags in `flags` that start with any of `names` (so harness flags can override our defaults). */
export function hasFlag(flags: readonly string[], ...names: string[]): boolean {
  return flags.some((f) => names.some((n) => f === n || f.startsWith(`${n}=`)));
}

// ---------------------------------------------------------------- overlay

/** Isolated home for a run. The runner materializes "~/…" bundle files here. */
export function overlayHome(runDir: string): string {
  return join(runDir, "home");
}

/**
 * Copy credential files from the real home into the overlay home (0600) so an
 * isolated run can still authenticate. Only files that exist and that the
 * bundle didn't already provide are copied. Returns the copied relative paths.
 */
export function copyAuth(relFiles: readonly string[], toHome: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const realHome = home(env);
  if (realHome === toHome) return [];
  return relFiles.filter((rel) => copyPrivate(join(realHome, rel), join(toHome, rel)));
}

/** Copy src → dst (0600) when src exists and dst doesn't. True when copied. */
export function copyPrivate(src: string, dst: string): boolean {
  if (src === dst || !existsSync(src) || existsSync(dst)) return false;
  try {
    mkdirSync(dirname(dst), { recursive: true, mode: 0o700 });
    copyFileSync(src, dst);
    chmodSync(dst, 0o600);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- transcripts

const jsonlTails = new Map<string, { size: number; rest: Buffer; items: unknown[] }>();

/**
 * Items picked from each record of a transcript that only grows, read
 * incrementally: a call reads just the bytes appended since the last one, so
 * normalize can consult the transcript for every hook line of a long session.
 * A file that shrank is read again from the start. `tag` names the picker.
 */
export function jsonlTail<T>(tag: string, path: string, pick: (record: Json) => T[]): T[] {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return [];
  }
  const key = `${tag}\0${path}`;
  let c = jsonlTails.get(key);
  if (!c || size < c.size) {
    if (jsonlTails.size >= 64) jsonlTails.delete(jsonlTails.keys().next().value!);
    c = { size: 0, rest: Buffer.alloc(0), items: [] };
    jsonlTails.set(key, c);
  }
  if (size === c.size) return c.items as T[];
  const buf = Buffer.alloc(size - c.size);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, buf.length, c.size);
  } finally {
    closeSync(fd);
  }
  c.size = size;
  const data = Buffer.concat([c.rest, buf]);
  const end = data.lastIndexOf(0x0a);
  c.rest = Buffer.from(data.subarray(end + 1));
  for (const l of data.subarray(0, end + 1).toString("utf8").split("\n")) {
    let r: unknown;
    try {
      r = JSON.parse(l);
    } catch {
      continue;
    }
    if (isObj(r)) c.items.push(...pick(r));
  }
  return c.items as T[];
}

/** Order-independent JSON, for matching a hook's tool input to a transcript's. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

export interface JsonlRecord {
  lineNo: number;
  value: Json;
}

/** Stream a JSONL file; malformed lines are skipped. */
export async function* readJsonl(file: string): AsyncGenerator<JsonlRecord> {
  let stream: ReturnType<typeof createReadStream>;
  try {
    stream = createReadStream(file, { encoding: "utf8" });
  } catch {
    return;
  }
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  try {
    for await (const line of rl) {
      lineNo++;
      const t = line.trim();
      if (!t) continue;
      try {
        const v = JSON.parse(t);
        if (isObj(v)) yield { lineNo, value: v };
      } catch {
        // partial last line / garbage
      }
    }
  } catch {
    // unreadable file
  } finally {
    rl.close();
    stream.destroy();
  }
}

/** Files under `dir` (depth-limited) whose basename matches. Sorted for deterministic output. */
export function walkFiles(dir: string, match: (name: string, full: string) => boolean, maxDepth = 4): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth) walk(full, depth + 1);
      } else if (e.isFile() && match(e.name, full)) out.push(full);
    }
  };
  walk(dir, 0);
  return out.sort();
}

export function mtimeMs(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

type SqliteModule = typeof import("node:sqlite");

/** node:sqlite, or undefined on Node builds without it. */
export async function loadSqlite(): Promise<SqliteModule | undefined> {
  try {
    const emit = process.emitWarning;
    // node:sqlite prints an ExperimentalWarning on first import; keep CLI output clean.
    process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
      const msg = typeof w === "string" ? w : w.message;
      if (/SQLite/i.test(msg)) return;
      (emit as (...a: unknown[]) => void).call(process, w, ...rest);
    }) as typeof process.emitWarning;
    try {
      return await import("node:sqlite");
    } finally {
      process.emitWarning = emit;
    }
  } catch {
    return undefined;
  }
}

/**
 * Open a COPY of a SQLite database read-only (WAL/SHM included) so the agent's
 * live writer never sees our lock. Caller must call close().
 */
export async function openSqliteCopy(dbPath: string): Promise<{ db: import("node:sqlite").DatabaseSync; close: () => void } | undefined> {
  if (!existsSync(dbPath)) return undefined;
  const sqlite = await loadSqlite();
  if (!sqlite) return undefined;
  const dir = mkdtempSync(join(tmpdir(), "csh-sqlite-"));
  const dst = join(dir, basename(dbPath));
  try {
    copyFileSync(dbPath, dst);
    for (const sfx of ["-wal", "-shm"]) if (existsSync(dbPath + sfx)) copyFileSync(dbPath + sfx, dst + sfx);
    const db = new sqlite.DatabaseSync(dst);
    return {
      db,
      close: () => {
        try {
          db.close();
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    };
  } catch {
    rmSync(dir, { recursive: true, force: true });
    return undefined;
  }
}

/** Column names of a table (empty when it doesn't exist). */
export function columns(db: import("node:sqlite").DatabaseSync, table: string): string[] {
  try {
    return (db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as { name: string }[]).map((r) => r.name);
  } catch {
    return [];
  }
}
