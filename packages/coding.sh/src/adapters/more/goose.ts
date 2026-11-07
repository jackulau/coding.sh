// Goose (github.com/aaif-goose/goose, formerly block/goose). Tier A: Open Plugins hooks
// (since v1.34.0) + SQLite sessions.db + `goose run`.
//
// Verified against goose main@4facf56 source (crates/goose/src/hooks/mod.rs, session_manager.rs,
// goose-provider-types conversation/message.rs) and goose-docs.ai (2026-11):
// - Hooks: ~/.agents/plugins/<name>/hooks/hooks.json (user; $GOOSE_PATH_ROOT/.agents/plugins when
//   set) and <cwd>/.agents/plugins/<name>/hooks/hooks.json (project). Auto-discovered; plugin.json
//   optional. Claude-shaped: {"hooks":{"PreToolUse":[{matcher?,hooks:[{type:"command",command,
//   timeout(s)}]}]}}. matcher is an unanchored regex on matcher_context (a bare "*" is INVALID and
//   the rule is silently skipped); no matcher = every event, which is what we use.
// - Events: SessionStart, SessionEnd, Stop, UserPromptSubmit, PreToolUse, PreToolUseResult,
//   PostToolUse, PostToolUseFailure, BeforeReadFile, AfterFileEdit, BeforeShellExecution,
//   AfterShellExecution. stdout is a decision channel only for PreToolUse/Stop (empty = allow).
// - Payload (HookContext): event, session_id, matcher_context, tool_call_id?, tool_name?,
//   tool_input?, message? (prompt), last_assistant_message? (Stop), working_dir? (all but
//   SessionEnd). No model, no transcript path, and no tool output (tool_output is never set).
// - Sessions: <data>/sessions/sessions.db (XDG data dir, also on macOS: ~/.local/share/goose;
//   $GOOSE_PATH_ROOT/data with the root set). Tables sessions(id,name,working_dir,created_at,
//   provider_name,model_config_json,accumulated_*…), messages(id,message_id,session_id,role,
//   content_json,created_timestamp(s)), usage_ledger(session_id,created_timestamp,model,input_tokens,
//   output_tokens,cache_read_tokens,cache_write_tokens,cost,is_compaction).
//   content_json blocks: {type:"text",text} | {type:"toolRequest",id,toolCall:{status,value:{name,
//   arguments}}} | {type:"toolResponse",id,toolResult:{status,value:{content[],isError}}|{status:"error",error}}.
// - Headless: `goose run -t … --output-format stream-json -q --max-turns N --provider P --model M`;
//   stream lines {type:"message"|"notification"|"error"|"complete"}; complete carries
//   input_tokens/output_tokens/cache_*_input_tokens/cost_usd. No session id in the stream.
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Adapter, AgentRunOutput, DetectResult, FileChange, HarnessBundle, InstallOpts, NormalizeContext, RunSpec, SpoolLine } from "../../core/types.ts";
import type { AgentEvent, Usage } from "../../schema/index.ts";
import {
  Emitter,
  applyWrites,
  attachRaw,
  binVersion,
  columns,
  copyPrivate,
  emitFileChange,
  emitText,
  emitToolEnd,
  emitToolStart,
  findBinary,
  get,
  hasClaudeHooks,
  isEmptyObject,
  stripClaudeHooks,
  hasFlag,
  home,
  hookCmd,
  isObj,
  isOurCommand,
  jsonLines,
  mergeClaudeHooks,
  num,
  openSqliteCopy,
  overlayHome,
  parseJsonc,
  rawBlob,
  readJsonObject,
  readText,
  relPath,
  runEnv,
  spawnAgent,
  spoolIdParts,
  stableJson,
  str,
  toJson,
  toMs,
  toRunOutput,
  usageFrom,
  xdg,
} from "./_util.ts";
import type { Json, PlannedWrite } from "./_util.ts";
import { isWrapperEvent, normalizeWrapperLine } from "./wrapper.ts";

const ID = "goose";
const PLUGIN = "coding-sh";
export const GOOSE_HOOK_EVENTS = ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "AfterFileEdit", "Stop"] as const;

function rootOrHome(env: NodeJS.ProcessEnv): string {
  const r = env.GOOSE_PATH_ROOT;
  return r && isAbsolute(r) ? r : home(env);
}

export function goosePluginDir(opts: { scope: "user" | "project"; projectDir?: string | undefined }, env: NodeJS.ProcessEnv = process.env): string {
  const base = opts.scope === "project" ? (opts.projectDir ?? process.cwd()) : rootOrHome(env);
  return join(base, ".agents", "plugins", PLUGIN);
}

export function gooseConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const r = env.GOOSE_PATH_ROOT;
  return r && isAbsolute(r) ? join(r, "config") : join(xdg("config", env), "goose");
}

export function gooseSessionsDb(env: NodeJS.ProcessEnv = process.env): string {
  const r = env.GOOSE_PATH_ROOT;
  if (r && isAbsolute(r)) return join(r, "data", "sessions", "sessions.db");
  if (process.platform === "win32") return join(env.APPDATA ?? join(home(env), "AppData", "Roaming"), "Block", "goose", "data", "sessions", "sessions.db");
  return join(xdg("data", env), "goose", "sessions", "sessions.db");
}

const isOurs = (h: Json): boolean => isOurCommand(h.command, ID);
const MANIFEST = toJson({ name: PLUGIN, description: "coding.sh: records goose sessions to ~/.coding.sh (local only).", version: "1.0.0" });

function spec(hookCommand: string) {
  return {
    events: GOOSE_HOOK_EVENTS,
    entry: (event: string): Json => ({ type: "command", command: hookCmd(hookCommand, ID, event), timeout: 10 }),
    isOurs,
  };
}

export async function normalizeGoose(line: SpoolLine, ctx: NormalizeContext): Promise<AgentEvent[]> {
  if (isWrapperEvent(line.event)) return normalizeWrapperLine(line, ctx);
  const raw: Json = isObj(line.raw) ? line.raw : {};
  const sessionId = str(raw.session_id) ?? `goose-unknown-${line.ppid ?? line.pid}`;
  const cwd = str(raw.working_dir) ?? line.cwd;
  const em = new Emitter(ctx, { agent: ID, sessionId, ts: line.ts, cwd, runId: line.runId }, spoolIdParts(line, sessionId, ctx), { toolKeys: true });
  const ev = str(raw.event) ?? line.event;
  const tool = str(raw.tool_name) ?? "unknown";
  const toolUseId = str(raw.tool_call_id);
  switch (ev) {
    case "SessionStart":
      em.push("session.start", { source: "hook" });
      break;
    case "SessionEnd":
      em.push("session.end", {});
      break;
    case "UserPromptSubmit": {
      const p = str(raw.message);
      if (p) await emitText(em, ctx, "user.message", p);
      break;
    }
    case "PreToolUse":
      await emitToolStart(em, ctx, tool, toolUseId, raw.tool_input);
      break;
    case "PostToolUse":
    case "PostToolUseFailure": {
      // Goose sends no tool output; file edits come from AfterFileEdit instead of guessing from input.
      const ok = ev === "PostToolUse";
      // input is deliberately not passed: with no output, edit/test heuristics would guess.
      await emitToolEnd(em, ctx, { tool, toolUseId, input: undefined, output: raw.tool_output, ok, error: ok ? undefined : "tool failed" }, cwd);
      break;
    }
    case "AfterFileEdit": {
      const p = str(raw.matcher_context) ?? str(get(raw, "tool_input", "path")) ?? str(get(raw, "tool_input", "file_path"));
      if (!p) break;
      // No call id on this hook: the tool request in sessions.db has it.
      const id = toolUseId ?? (await gooseSession(sessionId, line.ts))?.toolUseId(tool, raw.tool_input, line.ts);
      emitFileChange(em, { path: relPath(p, cwd), op: "modify", tool, toolUseId: id }, {}, p);
      break;
    }
    case "Stop": {
      const t = str(raw.last_assistant_message);
      if (t) await emitText(em, ctx, "assistant.message", t);
      em.turnEnd({}, (await gooseSession(sessionId, line.ts))?.turnKey(line.ts));
      break;
    }
    default:
      em.push("notification", { kind: ev, context: str(raw.matcher_context) });
  }
  return attachRaw(em.events, await rawBlob(ctx, line.raw));
}

// ---------------------------------------------------------------- sessions.db

function contentBlocks(json: unknown): Json[] {
  let v: unknown = json;
  if (typeof json === "string") {
    try {
      v = JSON.parse(json);
    } catch {
      return [{ type: "text", text: json }];
    }
  }
  return Array.isArray(v) ? v.filter(isObj) : [];
}

/** sessions.created_at/updated_at are SQLite CURRENT_TIMESTAMP: UTC without a zone ("2026-11-07 07:45:01"). */
function sqliteMs(v: unknown): number | undefined {
  if (typeof v === "string" && /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(v)) return toMs(`${v.replace(" ", "T")}Z`);
  return toMs(v);
}

/** Goose stores injected context (turn-context, top-of-mind) as hidden user messages. */
function hiddenMessage(m: Row): boolean {
  if (typeof m.metadata_json !== "string") return false;
  try {
    const meta: unknown = JSON.parse(m.metadata_json);
    return isObj(meta) && (meta.userVisible === false || meta.turnContext === true);
  } catch {
    return false;
  }
}

function resultText(tr: unknown): { ok: boolean; output: unknown; error?: string } {
  if (!isObj(tr)) return { ok: true, output: tr };
  if (tr.status === "error") return { ok: false, output: tr.error, error: str(tr.error) ?? "tool error" };
  const val = tr.value;
  const content = isObj(val) ? val.content : val;
  const isErr = isObj(val) && val.isError === true;
  return isErr ? { ok: false, output: content, error: "tool error" } : { ok: true, output: content };
}

type Row = Record<string, unknown>;

const messageKey = (m: Row): string => String(m.message_id ?? m.id);

/** A user message that opens a turn (text, no tool responses, not hidden context). */
function isPrompt(m: Row): boolean {
  if (str(m.role) !== "user" || hiddenMessage(m)) return false;
  const bs = contentBlocks(m.content_json);
  return !bs.some((b) => b.type === "toolResponse") && bs.some((b) => b.type === "text" && !!str(b.text)?.trim());
}

const msgOrder = (mc: Set<string>): string => `ORDER BY ${mc.has("created_timestamp") ? "created_timestamp, " : ""}id`;
const toolKey = (tool: string | undefined, input: unknown): string => `${tool ?? ""} ${stableJson(input)}`;

interface GooseSession {
  readAt: number;
  /** The turn a Stop hook at `ts` closes, keyed like gooseDbEvents keys its turn.end. */
  turnKey(ts: number): string | undefined;
  /** The call id of the latest request for this tool and input by `ts`. */
  toolUseId(tool: string, input: unknown, ts: number): string | undefined;
}

const gooseSessions = new Map<string, GooseSession>();

/**
 * What hooks that name no message or call (Stop, AfterFileEdit) need from sessions.db.
 * Read from a copy, and read again only for a hook newer than the last read: one
 * ingest run copies the database once per session.
 */
async function gooseSession(sessionId: string, ts: number): Promise<GooseSession | undefined> {
  const path = gooseSessionsDb();
  const k = `${path}\0${sessionId}`;
  const hit = gooseSessions.get(k);
  if (hit && ts <= hit.readAt) return hit;
  const readAt = Date.now();
  const h = await openSqliteCopy(path);
  if (!h) return undefined;
  const msgs: { key: string; ts: number; prompt: boolean }[] = [];
  const calls: { id: string; key: string; ts: number }[] = [];
  try {
    const mc = new Set(columns(h.db, "messages"));
    if (!mc.has("session_id")) return undefined;
    for (const m of h.db.prepare(`SELECT * FROM messages WHERE session_id = ? ${msgOrder(mc)}`).all(sessionId) as Row[]) {
      if (hiddenMessage(m)) continue;
      const mts = toMs(m.created_timestamp) ?? 0;
      msgs.push({ key: messageKey(m), ts: mts, prompt: isPrompt(m) });
      if (str(m.role) !== "assistant") continue;
      for (const b of contentBlocks(m.content_json)) {
        const id = str(b.id);
        if (b.type === "toolRequest" && id) calls.push({ id, key: toolKey(str(get(b, "toolCall", "value", "name")), get(b, "toolCall", "value", "arguments")), ts: mts });
      }
    }
  } finally {
    h.close();
  }
  const s: GooseSession = {
    readAt,
    turnKey(at) {
      let last: (typeof msgs)[number] | undefined;
      for (const m of msgs) if (m.ts <= at) last = m;
      return last && !last.prompt ? last.key : undefined;
    },
    toolUseId(tool, input, at) {
      const key = toolKey(tool, input);
      let id: string | undefined;
      for (const c of calls) if (c.key === key && c.ts <= at) id = c.id;
      return id;
    },
  };
  if (gooseSessions.size >= 16) gooseSessions.delete(gooseSessions.keys().next().value!);
  gooseSessions.set(k, s);
  return s;
}

/** Events for every session in a goose sessions.db (read from a copy). */
export async function* gooseDbEvents(dbPath: string, ctx: NormalizeContext, since?: number): AsyncGenerator<AgentEvent> {
  const h = await openSqliteCopy(dbPath);
  if (!h) return;
  try {
    const sc = new Set(columns(h.db, "sessions"));
    const mc = new Set(columns(h.db, "messages"));
    if (!sc.has("id") || !mc.has("session_id")) return;
    const hasLedger = columns(h.db, "usage_ledger").length > 0;
    const sessions = h.db.prepare("SELECT * FROM sessions ORDER BY created_at").all() as Row[];
    const msgStmt = h.db.prepare(`SELECT * FROM messages WHERE session_id = ? ${msgOrder(mc)}`);
    const ledgerStmt = hasLedger ? h.db.prepare("SELECT * FROM usage_ledger WHERE session_id = ? ORDER BY created_timestamp, id") : undefined;
    for (const s of sessions) {
      const sessionId = String(s.id);
      const cwd = str(s.working_dir);
      let model: string | undefined;
      try {
        model = str(get(parseJsonc(String(s.model_config_json ?? "")), "model_name"));
      } catch {
        // none
      }
      const startTs = sqliteMs(s.created_at) ?? 0;
      const updated = sqliteMs(s.updated_at) ?? startTs;
      if (since !== undefined && updated < since) continue;
      const out: AgentEvent[] = [];
      const head = new Emitter(ctx, { agent: ID, sessionId, ts: startTs, cwd, model }, ["goose-db", sessionId, "meta"]);
      const parent = str(s.parent_session_id);
      const sessionType = str(s.session_type);
      head.push("session.start", { source: "sessions.db", name: str(s.name), provider: str(s.provider_name), sessionType, parentSessionId: parent, subagentId: parent ? sessionId : undefined, subagentType: parent ? sessionType : undefined });
      out.push(...head.events);
      const calls = new Map<string, { tool: string; input: unknown; ts: number }>();
      let sawUser = false;
      // The turn's last visible message keys its turn.end (gooseSession().turnKey finds the same one for a Stop hook).
      let last: string | undefined;
      let lastTs = startTs;
      for (const m of msgStmt.all(sessionId) as Row[]) {
        const ts = toMs(m.created_timestamp) ?? lastTs;
        lastTs = ts;
        const em = new Emitter(ctx, { agent: ID, sessionId, ts, cwd, model }, ["goose-db", sessionId, messageKey(m)], { toolKeys: true });
        const bs = contentBlocks(m.content_json);
        const text = bs.filter((b) => b.type === "text").map((b) => str(b.text) ?? "").join("\n").trim();
        const role = str(m.role);
        const prompt = isPrompt(m);
        if (prompt && sawUser) em.turnEnd({}, last);
        if (!hiddenMessage(m)) last = prompt ? undefined : messageKey(m);
        if (role === "user") {
          const responses = bs.filter((b) => b.type === "toolResponse");
          if (prompt) {
            sawUser = true;
            await emitText(em, ctx, "user.message", text);
          }
          for (const b of responses) {
            const id = str(b.id);
            const call = id ? calls.get(id) : undefined;
            const r = resultText(b.toolResult);
            await emitToolEnd(em, ctx, { tool: call?.tool ?? "unknown", toolUseId: id, input: call?.input, output: r.output, ok: r.ok, error: r.error, durationMs: call ? Math.max(0, ts - call.ts) || undefined : undefined }, cwd);
          }
        } else if (role === "assistant") {
          if (text) await emitText(em, ctx, "assistant.message", text);
          for (const b of bs.filter((x) => x.type === "toolRequest")) {
            const id = str(b.id);
            const tool = str(get(b, "toolCall", "value", "name")) ?? "unknown";
            const input = get(b, "toolCall", "value", "arguments");
            if (id) calls.set(id, { tool, input, ts });
            await emitToolStart(em, ctx, tool, id, input);
          }
        }
        out.push(...em.events);
      }
      const tail = new Emitter(ctx, { agent: ID, sessionId, ts: lastTs, cwd, model }, ["goose-db", sessionId, "tail"]);
      if (sawUser) tail.turnEnd({}, last);
      const ledger = ledgerStmt ? (ledgerStmt.all(sessionId) as Row[]) : [];
      if (ledger.length) {
        // One llm.call per ledger row: exact per-call usage.
        for (const r of ledger) {
          const lm = str(r.model) ?? model;
          const u = usageFrom({ input_tokens: r.input_tokens, output_tokens: r.output_tokens, cache_read_tokens: r.cache_read_tokens, cache_write_tokens: r.cache_write_tokens, cost_usd: r.cost });
          const le = new Emitter(ctx, { agent: ID, sessionId, ts: toMs(r.created_timestamp) ?? lastTs, cwd, model: lm }, ["goose-db", sessionId, "ledger", String(r.id)]);
          le.push("llm.call", { responseModel: lm, ok: true, compaction: num(r.is_compaction) ? true : undefined }, u ? { usage: u } : {});
          out.push(...le.events);
        }
      } else {
        const u = usageFrom({ input_tokens: s.accumulated_input_tokens ?? s.input_tokens, output_tokens: s.accumulated_output_tokens ?? s.output_tokens, cache_read_tokens: s.accumulated_cache_read_tokens, cache_write_tokens: s.accumulated_cache_write_tokens, cost_usd: s.accumulated_cost });
        if (u && Object.values(u).some((v) => v)) tail.push("notification", { kind: "usage.total", source: "sessions.db" }, { usage: u });
      }
      out.push(...tail.events);
      if (parent) {
        // Mirror the subagent on the parent's timeline; childSessionId links the sessions.
        const p = new Emitter(ctx, { agent: ID, sessionId: parent, ts: startTs, cwd, subagentId: sessionId }, ["goose-db", parent, "subagent", sessionId]);
        p.push("subagent.start", { subagentId: sessionId, type: sessionType, childSessionId: sessionId, description: str(s.name) });
        p.push("subagent.end", { subagentId: sessionId, childSessionId: sessionId, ok: true }, { ts: lastTs, durationMs: Math.max(0, lastTs - startTs) });
        out.push(...p.events);
      }
      for (const e of out) if (since === undefined || e.ts >= since) yield e;
    }
  } finally {
    h.close();
  }
}

// ---------------------------------------------------------------- adapter

export const gooseAdapter: Adapter = {
  id: ID,
  displayName: "Goose",
  tier: "A",
  async detect(): Promise<DetectResult> {
    const binary = findBinary(["goose"]);
    const cfg = gooseConfigDir();
    let hooked = false;
    try {
      hooked = hasClaudeHooks(readJsonObject(join(goosePluginDir({ scope: "user" }), "hooks", "hooks.json")).value, isOurs);
    } catch {
      // ignore
    }
    const r: DetectResult = { installed: !!binary || existsSync(cfg), hooked };
    if (binary) {
      r.binary = binary;
      const v = await binVersion(binary);
      if (v) r.version = v;
    }
    if (existsSync(cfg)) r.configDir = cfg;
    r.notes = ["Hooks need goose >= 1.34. Goose sends no tool output to hooks: run `coding.sh ingest --backfill --agent goose` for results and usage."];
    return r;
  },
  async install(opts: InstallOpts): Promise<FileChange[]> {
    const dir = goosePluginDir(opts);
    const hooksPath = join(dir, "hooks", "hooks.json");
    const { text, value } = readJsonObject(hooksPath);
    const writes: PlannedWrite[] = [{ path: hooksPath, before: text, after: toJson(mergeClaudeHooks(value, spec(opts.hookCommand))), summary: `add coding.sh hooks (${GOOSE_HOOK_EVENTS.join(", ")})`, track: "install", pristine: !hasClaudeHooks(value, isOurs) }];
    const manifest = join(dir, "plugin.json");
    const mBefore = readText(manifest);
    if (mBefore === undefined) writes.push({ path: manifest, before: undefined, after: MANIFEST, summary: "add plugin manifest" });
    return applyWrites(ID, writes, opts.dryRun);
  },
  async uninstall(opts): Promise<FileChange[]> {
    const dir = goosePluginDir(opts);
    const hooksPath = join(dir, "hooks", "hooks.json");
    const { text, value } = readJsonObject(hooksPath);
    if (text === undefined || !hasClaudeHooks(value, isOurs)) return [];
    // Remove only what we wrote: hooks someone else added and a hand-edited manifest stay.
    const rest = stripClaudeHooks(value, isOurs);
    const writes: PlannedWrite[] = [{ path: hooksPath, before: text, after: isEmptyObject(rest) ? undefined : toJson(rest), summary: "remove coding.sh hooks", track: "uninstall", remaining: rest }];
    const manifest = join(dir, "plugin.json");
    const mText = readText(manifest);
    if (mText === MANIFEST && isEmptyObject(rest)) writes.push({ path: manifest, before: mText, after: undefined, summary: "remove plugin manifest" });
    return applyWrites(ID, writes, opts.dryRun);
  },
  normalize: normalizeGoose,
  async *backfill(ctx: NormalizeContext, opts?: { since?: number }): AsyncIterable<AgentEvent> {
    yield* gooseDbEvents(gooseSessionsDb(), ctx, opts?.since);
  },
  async run(spec: RunSpec): Promise<AgentRunOutput> {
    const bin = findBinary(["goose"], { ...process.env, ...spec.env }) ?? "goose";
    const name = `codingsh-${spec.runId}`;
    const args = ["run", "-t", spec.instruction, "--output-format", "stream-json", "-q", "-n", name];
    if (spec.model && !hasFlag(spec.flags, "--model")) args.push("--model", spec.model);
    args.push(...spec.flags);
    let usage: Usage | undefined;
    const onLine = jsonLines((o) => {
      if (o.type === "complete") usage = usageFrom({ input_tokens: o.input_tokens, output_tokens: o.output_tokens, cache_read_input_tokens: o.cache_read_input_tokens, cache_write_tokens: o.cache_write_input_tokens, cost_usd: o.cost_usd });
    });
    const env = runEnv(spec, { GOOSE_MODE: "auto" });
    const r = await spawnAgent({ bin, args, cwd: spec.cwd, env, timeoutMs: spec.timeoutMs, onLine });
    // The stream has no session id: look the named session up (best effort).
    let sessionId: string | undefined;
    const db = await openSqliteCopy(gooseSessionsDb(env as NodeJS.ProcessEnv));
    if (db) {
      try {
        const row = db.db.prepare("SELECT id FROM sessions WHERE name = ? ORDER BY created_at DESC LIMIT 1").get(name) as Row | undefined;
        sessionId = row ? String(row.id) : undefined;
      } catch {
        // schema without name
      } finally {
        db.close();
      }
    }
    return toRunOutput(r, sessionId, usage);
  },
  harnessFiles() {
    return {
      project: [".goosehints", "AGENTS.md", "**/.goosehints", "**/AGENTS.md", ".agents/skills/**", ".goose/skills/**", ".claude/skills/**", ".agents/plugins/**", ".config/goose/settings.json"],
      user: ["~/.config/goose/config.yaml", "~/.config/goose/.goosehints", "~/.config/goose/AGENTS.md", "~/.agents/AGENTS.md", "~/.agents/skills/**", "~/.agents/plugins/**", "~/.config/goose/skills/**", "~/.config/goose/recipes/**"],
    };
  },
  async overlay(bundle: HarnessBundle, runDir: string) {
    const h = overlayHome(runDir);
    const root = join(runDir, "goose");
    // Provider choice lives in config.yaml; keep the user's unless the bundle brings one.
    // Secrets move to <root>/config/secrets.yaml (keyring off), so API keys come from env.
    if (!bundle.files["~/.config/goose/config.yaml"]) copyPrivate(join(gooseConfigDir(), "config.yaml"), join(root, "config", "config.yaml"));
    else copyPrivate(join(h, ".config", "goose", "config.yaml"), join(root, "config", "config.yaml"));
    return { env: { GOOSE_PATH_ROOT: root, HOME: h, GOOSE_DISABLE_KEYRING: "1", XDG_CONFIG_HOME: join(h, ".config"), XDG_DATA_HOME: join(h, ".local", "share") }, flags: [] };
  },
};
