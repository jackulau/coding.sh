// Factory Droid (`droid`, docs.factory.com). Tier A: Claude-shaped hooks + JSONL sessions + `droid exec`.
//
// Verified against docs.factory.com hooks reference / droid exec (2026-11):
// - Hooks: ~/.factory/hooks.json (user) and .factory/hooks.json (project), keyed by event at
//   the TOP LEVEL (no "hooks" wrapper): {"PreToolUse":[{matcher,hooks:[{type,command,timeout(s)}]}]}.
//   If hooks.json is absent Droid reads the `hooks` key of the matching settings.json instead,
//   so we never create hooks.json while settings.json holds hooks (that would shadow them).
// - Events: PreToolUse, PostToolUse, UserPromptSubmit, Notification, Stop, SubagentStop,
//   PreCompact, SessionStart, SessionEnd (no SubagentStart).
// - Payload: session_id, transcript_path, cwd, permission_mode, hook_event_name + tool_name,
//   tool_input, tool_response; prompt; stop: tool_execution_count, elapsed_time; SubagentStop:
//   task_name, task_result, task_error; SessionEnd: reason, session_duration_ms, message_count;
//   PreCompact: trigger, estimated_tokens. No model: read it from the <id>.settings.json sidecar.
// - Tools: Execute, Read, Edit, Create, ApplyPatch, LS, Glob, Grep, Task, FetchUrl, WebSearch, mcp__*.
// - Sessions (format not officially documented; parsed defensively): ~/.factory/sessions/
//   -<cwd with / → ->/<uuid>.jsonl, first line {type:"session_start",id,title,cwd}, then
//   {type:"message",message:{id,role,content[Anthropic blocks]}} (streaming may repeat an id).
//   Sidecar <uuid>.settings.json: model, tokenUsage{inputTokens,outputTokens,cacheCreationTokens,cacheReadTokens}.
// - Headless: `droid exec "<prompt>" -o json --auto high --cwd d -m M` → one result object
//   {type:"result",session_id,usage{input_tokens,output_tokens,cache_read_input_tokens,…}}.
// - Isolation: no config-dir env var; override HOME.
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Adapter, AgentRunOutput, DetectResult, FileChange, HarnessBundle, InstallOpts, NormalizeContext, RunSpec, SpoolLine } from "../../core/types.ts";
import type { AgentEvent, Usage } from "../../schema/index.ts";
import {
  Emitter,
  applyWrites,
  attachRaw,
  binVersion,
  clip,
  copyAuth,
  emitText,
  emitToolEnd,
  emitToolStart,
  findBinary,
  get,
  hasClaudeHooks,
  hasFlag,
  home,
  hookCmd,
  isEmptyObject,
  isObj,
  isOurCommand,
  jsonlTail,
  jsonLines,
  mergeClaudeHooks,
  mtimeMs,
  num,
  overlayHome,
  parseJsonc,
  rawBlob,
  readJsonObject,
  readJsonl,
  runEnv,
  spawnAgent,
  spoolIdParts,
  stableJson,
  str,
  stripClaudeHooks,
  textOf,
  toJson,
  toMs,
  toRunOutput,
  usageFrom,
  walkFiles,
} from "./_util.ts";
import type { Json, PlannedWrite } from "./_util.ts";
import { isWrapperEvent, normalizeWrapperLine } from "./wrapper.ts";

const ID = "droid";
export const DROID_HOOK_EVENTS = ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SubagentStop", "PreCompact", "Notification"] as const;
const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse"]);

export function factoryDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(home(env), ".factory");
}

function scopeDir(opts: { scope: "user" | "project"; projectDir?: string | undefined }): string {
  return opts.scope === "project" ? join(opts.projectDir ?? process.cwd(), ".factory") : factoryDir();
}

const isOurs = (h: Json): boolean => isOurCommand(h.command, ID);

/** Wrap/unwrap the top-level event map of hooks.json so the Claude-shaped helpers apply. */
const wrap = (o: Json): Json => ({ hooks: o });
const unwrap = (o: Json): Json => (isObj(o.hooks) ? o.hooks : {});

/** Which file holds (or should hold) the hooks for a scope. */
export function droidHookTarget(opts: { scope: "user" | "project"; projectDir?: string | undefined }): { path: string; form: "hooks.json" | "settings.json" } {
  const dir = scopeDir(opts);
  const hooksJson = join(dir, "hooks.json");
  if (existsSync(hooksJson)) return { path: hooksJson, form: "hooks.json" };
  const settings = join(dir, "settings.json");
  if (existsSync(settings)) {
    try {
      if (isObj(readJsonObject(settings).value.hooks)) return { path: settings, form: "settings.json" };
    } catch {
      // unparseable: fall through to hooks.json, which Droid prefers anyway
    }
  }
  return { path: hooksJson, form: "hooks.json" };
}

function spec(hookCommand: string) {
  return {
    events: DROID_HOOK_EVENTS,
    entry: (event: string): Json => ({ type: "command", command: hookCmd(hookCommand, ID, event), timeout: 10 }),
    matcher: (event: string) => (TOOL_EVENTS.has(event) ? "*" : undefined),
    isOurs,
  };
}

/** Model from the session sidecar next to the transcript (`<id>.settings.json`). */
export function droidSidecar(transcriptPath: string | undefined): Json | undefined {
  if (!transcriptPath) return undefined;
  const p = transcriptPath.replace(/\.jsonl$/, ".settings.json");
  try {
    const v = parseJsonc(readFileSync(p, "utf8"));
    return isObj(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

interface ToolUse {
  id: string;
  key: string;
  ts: number;
}

/** tool_use blocks of a transcript (normalize sees many tool hooks of one session). */
function transcriptToolUses(path: string): ToolUse[] {
  return jsonlTail<ToolUse>("droid-tool-uses", path, (r) => {
    const m = get(r, "message");
    if (!isObj(m) || m.role !== "assistant") return [];
    const ts = toMs(get(r, "timestamp")) ?? 0;
    return blocks(m.content).flatMap((b) => (b.type === "tool_use" && str(b.id) ? [{ id: str(b.id)!, key: toolKey(str(b.name), b.input), ts }] : []));
  });
}

const toolKey = (tool: string | undefined, input: unknown): string => `${tool ?? ""} ${stableJson(input)}`;

/**
 * Droid tool hooks carry no call id (seen on 1.6.0). The transcript does: the assistant tool_use
 * is written before PreToolUse fires. Take the latest tool_use with the same tool and input at or
 * before the hook, so Pre/Post pair and share the id the transcript backfill uses.
 */
export function droidToolUseId(transcriptPath: string | undefined, tool: string, input: unknown, ts: number): string | undefined {
  if (!transcriptPath) return undefined;
  const key = toolKey(tool, input);
  let id: string | undefined;
  for (const u of transcriptToolUses(transcriptPath)) if (u.key === key && u.ts <= ts) id = u.id;
  return id;
}

const lineTs = (r: Json): number | undefined => toMs(r.timestamp) ?? toMs(get(r, "message", "timestamp")) ?? toMs(get(r, "message", "created_at"));

/**
 * The conversation message of a transcript line. Not conversation: UI-only notices and hook
 * bookkeeping (visibility "user_only"), and injected context (system reminders) whose line id
 * starts with "context-".
 */
function conversationMessage(r: Json): Json | undefined {
  const m = isObj(r.message) ? r.message : r.role ? r : undefined;
  if (!m || m.visibility === "user_only" || str(r.id)?.startsWith("context-")) return undefined;
  return m;
}

const messageKey = (r: Json, m: Json): string | undefined => str(m.id) ?? str(r.id);

/** A user message that opens a turn (text, no tool results). */
function isPrompt(m: Json): boolean {
  if (m.role !== "user") return false;
  const bs = blocks(m.content);
  return !bs.some((b) => b.type === "tool_result") && bs.some((b) => b.type === "text" && !!str(b.text)?.trim());
}

/**
 * The turn a Stop hook closes, keyed like the transcript keys its turn.end: by the last
 * conversation message written by then (none when that is the prompt itself).
 */
export function droidTurnKey(transcriptPath: string | undefined, ts: number): string | undefined {
  if (!transcriptPath) return undefined;
  let last: { key: string; prompt: boolean } | undefined;
  const msgs = jsonlTail<{ key: string; ts: number; prompt: boolean }>("droid-messages", transcriptPath, (r) => {
    const m = conversationMessage(r);
    const key = m && messageKey(r, m);
    return m && key ? [{ key, ts: lineTs(r) ?? 0, prompt: isPrompt(m) }] : [];
  });
  for (const x of msgs) if (x.ts <= ts) last = x;
  return last && !last.prompt ? last.key : undefined;
}

/** tool_response arrives as a JSON string on 1.6.0. */
function parseResponse(resp: unknown): unknown {
  if (typeof resp !== "string") return resp;
  try {
    return JSON.parse(resp);
  } catch {
    return resp;
  }
}

function toolResult(resp: unknown): { ok: boolean; error?: string } {
  if (isObj(resp)) {
    if (resp.is_error === true || resp.isError === true || resp.success === false) return { ok: false, error: str(resp.error) ?? textOf(resp.content) ?? "tool error" };
    if (typeof resp.error === "string" && resp.error) return { ok: false, error: resp.error };
  }
  return { ok: true };
}

export async function normalizeDroid(line: SpoolLine, ctx: NormalizeContext): Promise<AgentEvent[]> {
  if (isWrapperEvent(line.event)) return normalizeWrapperLine(line, ctx);
  const raw: Json = isObj(line.raw) ? line.raw : {};
  const sessionId = str(raw.session_id) ?? `droid-unknown-${line.ppid ?? line.pid}`;
  const cwd = str(raw.cwd) ?? line.cwd;
  const model = str(droidSidecar(str(raw.transcript_path))?.model);
  const em = new Emitter(ctx, { agent: ID, sessionId, ts: line.ts, cwd, runId: line.runId, model }, spoolIdParts(line, sessionId, ctx), { toolKeys: true });
  const ev = str(raw.hook_event_name) ?? line.event;
  const tool = str(raw.tool_name) ?? "unknown";
  const toolUseId = str(raw.tool_use_id) ?? str(raw.tool_call_id) ?? (TOOL_EVENTS.has(ev) ? droidToolUseId(str(raw.transcript_path), tool, raw.tool_input, line.ts) : undefined);
  switch (ev) {
    case "SessionStart":
      em.push("session.start", { source: str(raw.source), transcriptPath: str(raw.transcript_path), permissionMode: str(raw.permission_mode) });
      break;
    case "SessionEnd": {
      const d = num(raw.session_duration_ms);
      em.push("session.end", { reason: str(raw.reason), messageCount: num(raw.message_count) }, d !== undefined ? { durationMs: d } : {});
      break;
    }
    case "UserPromptSubmit": {
      const p = str(raw.prompt);
      if (p) await emitText(em, ctx, "user.message", p);
      break;
    }
    case "PreToolUse": {
      await emitToolStart(em, ctx, tool, toolUseId, raw.tool_input);
      // Droid has SubagentStop but no SubagentStart: the Task tool call is the start.
      if (tool === "Task") {
        const type = str(get(raw, "tool_input", "subagent_type")) ?? "subagent";
        em.push("subagent.start", { subagentId: type, type, description: str(get(raw, "tool_input", "description")), toolUseId }, { subagentId: type });
      }
      break;
    }
    case "PostToolUse": {
      const resp = parseResponse(raw.tool_response);
      const { ok, error } = toolResult(resp);
      await emitToolEnd(em, ctx, { tool, toolUseId, input: raw.tool_input, output: resp, ok, error }, cwd);
      break;
    }
    case "Stop": {
      const el = num(raw.elapsed_time);
      em.turnEnd({ toolExecutions: num(raw.tool_execution_count), elapsedTime: el }, droidTurnKey(str(raw.transcript_path), line.ts));
      break;
    }
    case "SubagentStop": {
      const r = await clip(ctx, raw.task_result);
      const err = str(raw.task_error);
      const name = str(raw.task_name) ?? "subagent";
      em.push("subagent.end", { subagentId: name, type: name, ok: !err, result: r.value, error: err }, { subagentId: name, ...(r.blob ? { blobs: [r.blob] } : {}) });
      break;
    }
    case "PreCompact":
      em.push("context.compact", { trigger: raw.trigger === "manual" ? "manual" : "auto", tokensBefore: num(raw.estimated_tokens) });
      break;
    case "Notification":
      em.push("notification", { kind: "notification", message: str(raw.message) });
      break;
    default:
      em.push("notification", { kind: ev });
  }
  return attachRaw(em.events, await rawBlob(ctx, line.raw));
}

// ---------------------------------------------------------------- transcripts

function blocks(c: unknown): Json[] {
  if (typeof c === "string") return [{ type: "text", text: c }];
  return Array.isArray(c) ? c.filter(isObj) : [];
}

export async function* droidSessionEvents(file: string, ctx: NormalizeContext, since?: number): AsyncGenerator<AgentEvent> {
  let sessionId = basename(file, ".jsonl");
  let cwd: string | undefined;
  let title: string | undefined;
  let startTs: number | undefined;
  // Streaming can rewrite a message: keep the last version, in first-seen order.
  const msgs = new Map<string, { ts: number; m: Json; natural: boolean }>();
  let n = 0;
  for await (const { lineNo, value: r } of readJsonl(file)) {
    const ts = lineTs(r);
    if (r.type === "session_start") {
      sessionId = str(r.id) ?? str(r.sessionId) ?? sessionId;
      cwd = str(r.cwd);
      title = str(r.title);
      startTs = ts;
      continue;
    }
    const m = conversationMessage(r);
    if (!m) continue;
    const natural = messageKey(r, m);
    const key = natural ?? `line-${lineNo}`;
    const prev = msgs.get(key);
    msgs.set(key, { ts: ts ?? prev?.ts ?? startTs ?? mtimeMs(file) + n++, m, natural: natural !== undefined });
  }
  const sidecar = droidSidecar(file);
  const model = str(sidecar?.model);
  const out: AgentEvent[] = [];
  const head = new Emitter(ctx, { agent: ID, sessionId, ts: startTs ?? [...msgs.values()][0]?.ts ?? mtimeMs(file), cwd, model }, ["droid-file", sessionId, "meta"]);
  head.push("session.start", { source: "transcript", title });
  out.push(...head.events);
  const calls = new Map<string, { tool: string; input: unknown; ts: number }>();
  let sawUser = false;
  // The turn's last message, which keys its turn.end (droidTurnKey finds the same one for a Stop hook).
  let last: string | undefined;
  let lastTs = head.events[0]!.ts;
  for (const [key, { ts, m, natural }] of msgs) {
    lastTs = ts;
    const em = new Emitter(ctx, { agent: ID, sessionId, ts, cwd, model }, ["droid-file", sessionId, key], { toolKeys: true });
    const role = str(m.role);
    const bs = blocks(m.content);
    const prompt = isPrompt(m);
    if (prompt && sawUser) em.turnEnd({}, last);
    last = prompt || !natural ? undefined : key;
    if (role === "user") {
      const results = bs.filter((b) => b.type === "tool_result");
      const text = bs.filter((b) => b.type === "text").map((b) => str(b.text) ?? "").join("\n").trim();
      if (prompt) {
        sawUser = true;
        await emitText(em, ctx, "user.message", text);
      }
      for (const b of results) {
        const id = str(b.tool_use_id);
        const call = id ? calls.get(id) : undefined;
        await emitToolEnd(em, ctx, { tool: call?.tool ?? "unknown", toolUseId: id, input: call?.input, output: b.content, ok: b.is_error !== true, durationMs: call ? Math.max(0, ts - call.ts) || undefined : undefined }, cwd);
      }
    } else if (role === "assistant") {
      const text = bs.filter((b) => b.type === "text").map((b) => str(b.text) ?? "").join("\n").trim();
      if (text) await emitText(em, ctx, "assistant.message", text);
      for (const b of bs.filter((x) => x.type === "tool_use")) {
        const tool = str(b.name) ?? "unknown";
        const id = str(b.id);
        if (id) calls.set(id, { tool, input: b.input, ts });
        await emitToolStart(em, ctx, tool, id, b.input);
      }
    }
    out.push(...em.events);
  }
  const tail = new Emitter(ctx, { agent: ID, sessionId, ts: lastTs, cwd, model }, ["droid-file", sessionId, "tail"]);
  if (sawUser) tail.turnEnd({}, last);
  // Session totals from the sidecar: on one event with a stable id, so re-backfill never double counts.
  const tu = isObj(sidecar?.tokenUsage) ? sidecar.tokenUsage : undefined;
  const usage: Usage | undefined = tu ? usageFrom({ inputTokens: tu.inputTokens, outputTokens: (num(tu.outputTokens) ?? 0) + (num(tu.thinkingTokens) ?? 0), cacheReadTokens: tu.cacheReadTokens, cacheWriteTokens: tu.cacheCreationTokens }) : undefined;
  if (usage) tail.push("notification", { kind: "usage.total", source: "settings.json" }, { usage });
  out.push(...tail.events);
  for (const e of out) if (since === undefined || e.ts >= since) yield e;
}

// ---------------------------------------------------------------- adapter

function readHooks(path: string, form: "hooks.json" | "settings.json"): { text: string | undefined; settings: Json; full: Json } {
  const { text, value } = readJsonObject(path);
  return form === "hooks.json" ? { text, settings: wrap(value), full: value } : { text, settings: value, full: value };
}

export const droidAdapter: Adapter = {
  id: ID,
  displayName: "Factory Droid",
  tier: "A",
  // 2 (0.1.2): hook and transcript copies share ids; tool hooks paired through the transcript's tool_use id.
  parseVersion: 2,
  async detect(): Promise<DetectResult> {
    const binary = findBinary(["droid"]);
    const dir = factoryDir();
    let hooked = false;
    for (const [p, form] of [[join(dir, "hooks.json"), "hooks.json"], [join(dir, "settings.json"), "settings.json"]] as const) {
      try {
        if (existsSync(p) && hasClaudeHooks(readHooks(p, form).settings, isOurs)) hooked = true;
      } catch {
        // ignore
      }
    }
    const r: DetectResult = { installed: !!binary || existsSync(dir), hooked };
    if (binary) {
      r.binary = binary;
      const v = await binVersion(binary);
      if (v) r.version = v;
    }
    if (existsSync(dir)) r.configDir = dir;
    return r;
  },
  async install(opts: InstallOpts): Promise<FileChange[]> {
    const { path, form } = droidHookTarget(opts);
    const { text, settings, full } = readHooks(path, form);
    const merged = mergeClaudeHooks(settings, spec(opts.hookCommand));
    const after = form === "hooks.json" ? unwrap(merged) : { ...full, hooks: merged.hooks };
    return applyWrites(ID, [{ path, before: text, after: toJson(after), summary: `add coding.sh hooks to ${form} (${DROID_HOOK_EVENTS.join(", ")})`, track: "install", pristine: !hasClaudeHooks(settings, isOurs) }], opts.dryRun);
  },
  async uninstall(opts): Promise<FileChange[]> {
    const dir = scopeDir(opts);
    const writes: PlannedWrite[] = [];
    for (const [path, form] of [[join(dir, "hooks.json"), "hooks.json"], [join(dir, "settings.json"), "settings.json"]] as const) {
      if (!existsSync(path)) continue;
      const { text, settings } = readHooks(path, form);
      if (!hasClaudeHooks(settings, isOurs)) continue;
      const stripped = stripClaudeHooks(settings, isOurs);
      const next = form === "hooks.json" ? unwrap(stripped) : stripped;
      writes.push({ path, before: text, after: form === "hooks.json" && isEmptyObject(next) ? undefined : toJson(next), summary: `remove coding.sh hooks from ${form}`, track: "uninstall", remaining: next });
    }
    return applyWrites(ID, writes, opts.dryRun);
  },
  normalize: normalizeDroid,
  async *backfill(ctx: NormalizeContext, opts?: { since?: number }): AsyncIterable<AgentEvent> {
    for (const f of walkFiles(join(factoryDir(), "sessions"), (n) => n.endsWith(".jsonl"), 2)) {
      if (opts?.since !== undefined && mtimeMs(f) < opts.since) continue;
      yield* droidSessionEvents(f, ctx, opts?.since);
    }
  },
  async run(spec: RunSpec): Promise<AgentRunOutput> {
    const bin = findBinary(["droid"], { ...process.env, ...spec.env }) ?? "droid";
    const args = ["exec", spec.instruction, "-o", "json"];
    if (!hasFlag(spec.flags, "--auto", "--skip-permissions-unsafe")) args.push("--auto", "high");
    if (!hasFlag(spec.flags, "--cwd")) args.push("--cwd", spec.cwd);
    if (spec.model && !hasFlag(spec.flags, "-m", "--model")) args.push("-m", spec.model);
    args.push(...spec.flags);
    let sessionId: string | undefined;
    let usage: Usage | undefined;
    const take = (o: Json) => {
      sessionId = str(o.session_id) ?? sessionId;
      if (o.type === "result" || o.type === "completion") usage = usageFrom(o.usage) ?? usage;
    };
    const r = await spawnAgent({ bin, args, cwd: spec.cwd, stdoutFile: spec.stdoutFile, env: runEnv(spec), timeoutMs: spec.timeoutMs, onLine: jsonLines(take) });
    if (!sessionId) {
      // Pretty-printed result object: parse the tail as a whole.
      try {
        const v = JSON.parse(r.stdoutTail.slice(r.stdoutTail.lastIndexOf("\n{") + 1));
        if (isObj(v)) take(v);
      } catch {
        // not JSON
      }
    }
    return toRunOutput(r, sessionId, usage);
  },
  harnessFiles() {
    return {
      project: ["AGENTS.md", "agents.md", "CLAUDE.md", "**/AGENTS.md", ".factory/settings.json", ".factory/hooks.json", ".factory/droids/**", ".factory/skills/**", ".factory/commands/**", ".factory/mcp.json", ".agents/**"],
      user: ["~/.factory/AGENTS.md", "~/.factory/settings.json", "~/.factory/hooks.json", "~/.factory/droids/**", "~/.factory/skills/**", "~/.factory/commands/**", "~/.factory/mcp.json", "~/.agents/AGENTS.md"],
    };
  },
  async overlay(_bundle: HarnessBundle, runDir: string) {
    const h = overlayHome(runDir);
    // Droid has no config-dir variable: an isolated HOME is the only way. FACTORY_API_KEY
    // (inherited) is the documented headless auth; a file login is copied when present.
    copyAuth([".factory/auth.json"], h);
    return { env: { HOME: h }, flags: [] };
  },
};
