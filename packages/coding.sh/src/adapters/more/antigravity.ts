// Antigravity CLI (`agy`), the successor of Gemini CLI's consumer tiers (2026-06-18).
// Tier A: hooks.json + per-conversation transcript.jsonl + `agy -p`. Agent id "antigravity".
//
// Verified against antigravity.google/docs (hooks?tab=cli, cli/headless, cli/reference), 2026-11:
// - Hooks: ~/.gemini/config/hooks.json (global; shared by the Antigravity App, CLI and IDE) and
//   .agents/hooks.json (workspace). Hooks in ~/.gemini/antigravity-cli/settings.json are NOT loaded.
//   The file maps hook NAMES to event handlers, so we own one key, "coding-sh":
//   {"coding-sh":{"SessionStart":[{type,command,timeout}],"PostToolUse":[{matcher:"*",hooks:[…]}],…}}
//   Tool events nest handlers under {matcher,hooks}; the others list handlers directly.
//   Timeout is in seconds. PreToolUse REQUIRES a stdout decision, so we never install it;
//   PostToolUse carries the call (name + args, plus `error` on failure; no output).
// - stdin (camelCase): conversationId, workspacePaths[], transcriptPath, artifactDirectoryPath,
//   modelName, lastUserInput + toolCall{name,args}, stepIdx, error; PreInvocation invocationNum;
//   Stop terminationReason, error, fullyIdle.
//   Hooks must print a JSON object on stdout ({} is a valid answer to every event), so ours run
//   with --reply={}.
// - Transcript: ~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript.jsonl,
//   lines {type: USER_INPUT|PLANNER_RESPONSE|GENERIC|CHECKPOINT|SYSTEM_MESSAGE|ERROR_MESSAGE,
//   step_index, source, status: DONE|RUNNING, created_at, content, thinking?, error?,
//   tool_calls[{name,args}], truncated_fields[]}. transcript_full.jsonl next to it has the same lines
//   with nothing truncated; we read it when present. A PLANNER_RESPONSE with a tool call is followed
//   by the GENERIC step holding its result (step_index + 1), unless the call was dropped. Tool args
//   are strings. The transcript has no model, tokens, cwd or tool failures: those come from the
//   conversation DB (see readAgyConversation). Checked against 498 local conversations, agy 1.5.2.
// - Headless: `agy -p … --output-format stream-json --dangerously-skip-permissions --model M`
//   (init/step_update/result; usage{input_tokens,output_tokens,thinking_tokens,cache_read_tokens}).
// - Isolation: no documented config-dir variable (tokens live in the OS keyring), so overlay
//   only disables auto-update.
import { existsSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import type { Adapter, AgentRunOutput, BackfillOpts, DetectResult, FileChange, HarnessBundle, InstallOpts, NormalizeContext, RunSpec, SpoolLine } from "../../core/types.ts";
import { commandOf, isVerifyCommand } from "../../core/sessions.ts";
import type { AgentEvent, Usage } from "../../schema/index.ts";
import {
  removeEmptyDirs,
  Emitter,
  applyWrites,
  attachRaw,
  binVersion,
  emitText,
  emitToolEnd,
  emitToolStart,
  findBinary,
  get,
  hasFlag,
  home,
  hookCmd,
  isEmptyObject,
  isObj,
  isOurCommand,
  jsonLines,
  jsonlTail,
  mtimeMs,
  num,
  openSqliteCopy,
  rawBlob,
  readJsonObject,
  readJsonl,
  runEnv,
  spawnAgent,
  spoolIdParts,
  str,
  toJson,
  toMs,
  toRunOutput,
  usageFrom,
  walkFiles,
} from "./_util.ts";
import type { Json } from "./_util.ts";
import { isWrapperEvent, normalizeWrapperLine } from "./wrapper.ts";

const ID = "antigravity";
const KEY = "coding-sh";
export const AGY_HOOK_EVENTS = ["SessionStart", "PreInvocation", "PostToolUse", "Stop"] as const;
const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse"]);
/** agy reads hook stdout as a JSON decision; {} means "no opinion" for every event. */
const HOOK_REPLY = "--reply={}";
/** agy tool that spawns a subagent (docs: "Agent collaboration"). Its internals are not exposed. */
const SUBAGENT_TOOL = "invoke_subagent";
/**
 * Data dirs under ~/.gemini: the CLI, the Antigravity 2.0 app and the IDE (agy docs, hooks page).
 * They share ~/.gemini/config/hooks.json, so one agent id covers all three.
 */
export const AGY_PRODUCT_DIRS = ["antigravity-cli", "antigravity", "antigravity-ide"] as const;

function subagentInfo(tool: string, id: string, args: unknown): Json | undefined {
  if (tool !== SUBAGENT_TOOL) return undefined;
  const a: Json = isObj(args) ? args : {};
  const type = str(a.SubagentName) ?? str(a.subagentName) ?? str(a.name) ?? str(a.agent) ?? tool;
  return { subagentId: id, type, description: str(a.Task) ?? str(a.task) ?? str(a.prompt) ?? str(a.Prompt) };
}

export function agyCliDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(home(env), ".gemini", "antigravity-cli");
}

export function agyHooksPath(opts: { scope: "user" | "project"; projectDir?: string | undefined }, env: NodeJS.ProcessEnv = process.env): string {
  return opts.scope === "project" ? join(opts.projectDir ?? process.cwd(), ".agents", "hooks.json") : join(home(env), ".gemini", "config", "hooks.json");
}

export function agyHookDef(hookCommand: string): Json {
  const def: Json = {};
  for (const ev of AGY_HOOK_EVENTS) {
    const handler = { type: "command", command: hookCmd(hookCommand, ID, ev, HOOK_REPLY), timeout: 10 };
    def[ev] = TOOL_EVENTS.has(ev) ? [{ matcher: "*", hooks: [handler] }] : [handler];
  }
  return def;
}

function isOurDef(v: unknown): boolean {
  return isObj(v) && JSON.stringify(v).includes("hook.mjs") && Object.values(v).some((list) => Array.isArray(list) && list.some((h) => isObj(h) && (isOurCommand(h.command, ID) || (Array.isArray(h.hooks) && h.hooks.some((x) => isObj(x) && isOurCommand(x.command, ID))))));
}

/**
 * agy wraps every prompt: <USER_REQUEST>text</USER_REQUEST> then <ADDITIONAL_METADATA> (local time,
 * open files) and sometimes <USER_SETTINGS_CHANGE>. Keep only the request. A truncated transcript
 * can cut the closing tag, so the body runs to the end then.
 */
export function agyUserText(content: string): string {
  const m = /^\s*<USER_REQUEST>([\s\S]*?)(?:<\/USER_REQUEST>|$)/.exec(content);
  return (m ? m[1]! : content).trim();
}

/** Map agy tool args onto the common keys our heuristics read (command, file_path). */
function commonArgs(args: unknown): unknown {
  if (!isObj(args)) return args;
  const out: Json = { ...args };
  if (typeof args.CommandLine === "string" && out.command === undefined) out.command = args.CommandLine;
  if (typeof args.TargetFile === "string" && out.file_path === undefined) out.file_path = args.TargetFile;
  return out;
}

/** tool.start showing agy's own args; verify detection reads the mapped ones. */
async function agyToolStart(em: Emitter, ctx: NormalizeContext, tool: string, id: string, args: unknown): Promise<void> {
  await emitToolStart(em, ctx, tool, id, args);
  const ev = em.events.at(-1);
  if (ev && isVerifyCommand(commandOf(commonArgs(args)))) ev.payload.verify = true;
}

export async function normalizeAgy(line: SpoolLine, ctx: NormalizeContext): Promise<AgentEvent[]> {
  if (isWrapperEvent(line.event)) return normalizeWrapperLine(line, ctx);
  const raw: Json = isObj(line.raw) ? line.raw : {};
  const sessionId = str(raw.conversationId) ?? `agy-unknown-${line.ppid ?? line.pid}`;
  const ws = Array.isArray(raw.workspacePaths) ? str(raw.workspacePaths[0]) : undefined;
  const cwd = ws ?? line.cwd;
  // "auto" is agy's model router, not a model id.
  const model = raw.modelName === "auto" ? undefined : str(raw.modelName);
  const em = new Emitter(ctx, { agent: ID, sessionId, ts: line.ts, cwd, runId: line.runId, model }, spoolIdParts(line, sessionId, ctx), { toolKeys: true });
  switch (line.event) {
    case "SessionStart":
      em.push("session.start", { source: "hook", transcriptPath: str(raw.transcriptPath) });
      break;
    case "PreInvocation": {
      // Fires before every model call; the first call of a run carries the new prompt.
      if (num(raw.invocationNum) !== 0) return [];
      const p = agyUserText(str(raw.lastUserInput) ?? "");
      if (!p) return [];
      await emitText(em, ctx, "user.message", p);
      break;
    }
    case "PreToolUse": {
      const tool = str(get(raw, "toolCall", "name")) ?? "unknown";
      await agyToolStart(em, ctx, tool, `step-${num(raw.stepIdx) ?? line.ts}`, get(raw, "toolCall", "args"));
      break;
    }
    case "PostToolUse": {
      const tool = str(get(raw, "toolCall", "name")) ?? "unknown";
      const id = `step-${num(raw.stepIdx) ?? line.ts}`;
      const args = get(raw, "toolCall", "args");
      const input = commonArgs(args);
      const err = str(raw.error);
      const sub = subagentInfo(tool, id, args);
      if (sub) em.push("subagent.start", sub, { subagentId: id, key: [id] });
      await agyToolStart(em, ctx, tool, id, args);
      await emitToolEnd(em, ctx, { tool, toolUseId: id, input, output: err, ok: !err, error: err }, cwd);
      if (sub) em.push("subagent.end", { subagentId: id, type: sub.type, ok: !err }, { subagentId: id, key: [id] });
      break;
    }
    case "Stop": {
      const err = str(raw.error);
      if (err) em.push("error", { message: err });
      em.turnEnd({ reason: str(raw.terminationReason), fullyIdle: typeof raw.fullyIdle === "boolean" ? raw.fullyIdle : undefined }, agyTurnKey(agyTranscriptOf(raw, sessionId), line.ts));
      break;
    }
    default:
      em.push("notification", { kind: line.event });
  }
  return attachRaw(em.events, await rawBlob(ctx, line.raw));
}

// ---------------------------------------------------------------- conversation DB
//
// <data dir>/conversations/<conversationId>.db (SQLite, read as a copy) holds what the transcript
// leaves out, as protobuf blobs. Field numbers come from the descriptors embedded in agy 1.5.2:
// - steps(idx = step_index, step_type, status, error_details): CortexStepStatus 6 CANCELED,
//   7 ERROR, 12 INTERRUPTED. error_details field 2 is the short error text.
// - gen_metadata(data) = CortexStepGeneratorMetadata, one row per model call:
//   2 step_indices (the planner step it wrote, plus that step's tool step), 1 chat_model.
//   chat_model = ChatModelMetadata: 4 usage, 11 time_to_first_token, 12 streaming_duration
//   (google.protobuf.Duration), 19 response_model.
//   usage = ModelUsageStats: 2 input_tokens (uncached), 3 output_tokens (thinking + response),
//   4 cache_write_tokens, 5 cache_read_tokens, 6 api_provider (24 Gemini, 26 Anthropic on Vertex).
// - executor_metadata(data): field 10 (or 17) → 12 holds the workspace folders as file:// URIs,
//   when the conversation has a workspace.

/** One protobuf field: a varint, or length-delimited bytes. Fixed 32/64-bit fields are skipped. */
interface PbField {
  f: number;
  v?: number;
  b?: Uint8Array;
}

function readVarint(buf: Uint8Array, at: { i: number }): number {
  let r = 0;
  for (let s = 0; s < 64; s += 7) {
    if (at.i >= buf.length) throw new Error("truncated varint");
    const byte = buf[at.i++]!;
    r += (byte & 0x7f) * 2 ** s;
    if (!(byte & 0x80)) return r;
  }
  throw new Error("varint too long");
}

/** Top-level fields of a protobuf message, or undefined when the bytes don't parse as one. */
export function pbFields(buf: Uint8Array | undefined): PbField[] | undefined {
  if (!buf) return undefined;
  const out: PbField[] = [];
  const at = { i: 0 };
  try {
    while (at.i < buf.length) {
      const key = readVarint(buf, at);
      const f = Math.floor(key / 8);
      const wire = key % 8;
      if (f === 0) return undefined;
      if (wire === 0) out.push({ f, v: readVarint(buf, at) });
      else if (wire === 2) {
        const n = readVarint(buf, at);
        if (at.i + n > buf.length) return undefined;
        out.push({ f, b: buf.subarray(at.i, at.i + n) });
        at.i += n;
      } else if (wire === 1) at.i += 8;
      else if (wire === 5) at.i += 4;
      else return undefined;
    }
  } catch {
    return undefined;
  }
  return at.i === buf.length ? out : undefined;
}

const pbOne = (m: PbField[] | undefined, f: number): PbField | undefined => m?.find((x) => x.f === f);
const pbMsg = (m: PbField[] | undefined, f: number): PbField[] | undefined => pbFields(pbOne(m, f)?.b);
const pbInt = (m: PbField[] | undefined, f: number): number | undefined => pbOne(m, f)?.v;
/** A string field, only when it is text (no control characters besides whitespace). */
function pbText(m: PbField[] | undefined, f: number): string | undefined {
  const b = pbOne(m, f)?.b;
  if (!b?.length) return undefined;
  const s = Buffer.from(b).toString("utf8");
  return /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f�]+$/.test(s) ? s : undefined;
}
/** A repeated varint field, packed or not. */
function pbInts(m: PbField[] | undefined, f: number): number[] {
  const out: number[] = [];
  for (const x of m ?? []) {
    if (x.f !== f) continue;
    if (x.v !== undefined) out.push(x.v);
    else if (x.b) {
      const at = { i: 0 };
      try {
        while (at.i < x.b.length) out.push(readVarint(x.b, at));
      } catch {
        // malformed packed list: keep what parsed
      }
    }
  }
  return out;
}
/** google.protobuf.Duration {1 seconds, 2 nanos} in ms. */
function pbDurationMs(m: PbField[] | undefined): number | undefined {
  if (!m) return undefined;
  return Math.round((pbInt(m, 1) ?? 0) * 1000 + (pbInt(m, 2) ?? 0) / 1e6);
}

const API_PROVIDERS: Record<number, string> = { 24: "google", 26: "anthropic" };
const FAILED_STATUS: Record<number, string> = { 6: "canceled", 7: "error", 12: "interrupted" };

function providerOf(model: string | undefined): string {
  if (model?.startsWith("claude")) return "anthropic";
  if (model?.startsWith("gpt") || model?.startsWith("o3") || model?.startsWith("o4")) return "openai";
  return "google";
}

/** The model call behind one or more transcript steps. */
export interface AgyGeneration {
  model?: string;
  provider: string;
  usage?: Usage;
  ttftMs?: number;
  durationMs?: number;
}

export interface AgyConversation {
  /** step_index → the model call that wrote it (a planner step, its tool step, or a failed call's error step). */
  generations: Map<number, AgyGeneration>;
  /** Steps agy marked ERROR, CANCELED or INTERRUPTED: step_index → error text. */
  failedSteps: Map<number, string>;
  /** The conversation's first workspace folder, when it has one. */
  cwd?: string;
}

/** Reads a conversation DB (already opened as a copy). Tables or blobs it can't parse are skipped. */
export function readAgyConversation(db: DatabaseSync): AgyConversation {
  const conv: AgyConversation = { generations: new Map(), failedSteps: new Map() };
  const rows = (sql: string): Record<string, unknown>[] => {
    try {
      return db.prepare(sql).all() as Record<string, unknown>[];
    } catch {
      return [];
    }
  };
  const bytes = (v: unknown): Uint8Array | undefined => (v instanceof Uint8Array ? v : undefined);
  for (const r of rows("SELECT data FROM gen_metadata ORDER BY idx")) {
    const gen = pbFields(bytes(r.data));
    const chat = pbMsg(gen, 1);
    if (!chat) continue;
    const u = pbMsg(chat, 4);
    const usage: Usage = {};
    const input = pbInt(u, 2);
    const output = pbInt(u, 3);
    const cacheWrite = pbInt(u, 4);
    const cacheRead = pbInt(u, 5);
    if (input !== undefined) usage.inputTokens = input;
    if (output !== undefined) usage.outputTokens = output;
    if (cacheRead !== undefined) usage.cacheReadTokens = cacheRead;
    if (cacheWrite !== undefined) usage.cacheWriteTokens = cacheWrite;
    const model = pbText(chat, 19);
    const ttftMs = pbDurationMs(pbMsg(chat, 11));
    const streamMs = pbDurationMs(pbMsg(chat, 12));
    const g: AgyGeneration = { provider: API_PROVIDERS[pbInt(u, 6) ?? -1] ?? providerOf(model) };
    if (model) g.model = model;
    if (Object.keys(usage).length) g.usage = usage;
    if (ttftMs !== undefined) g.ttftMs = ttftMs;
    if (ttftMs !== undefined || streamMs !== undefined) g.durationMs = (ttftMs ?? 0) + (streamMs ?? 0);
    for (const step of pbInts(gen, 2)) if (!conv.generations.has(step)) conv.generations.set(step, g);
  }
  for (const r of rows("SELECT idx, status, error_details FROM steps WHERE status IN (6, 7, 12)")) {
    const text = pbText(pbFields(bytes(r.error_details)), 2);
    conv.failedSteps.set(Number(r.idx), text ? text.slice(0, 500) : FAILED_STATUS[Number(r.status)]!);
  }
  const exec = pbFields(bytes(rows("SELECT data FROM executor_metadata ORDER BY idx LIMIT 1")[0]?.data));
  for (const f of [10, 17]) {
    const uri = pbText(pbMsg(exec, f), 12);
    if (!uri?.startsWith("file://")) continue;
    try {
      conv.cwd = fileURLToPath(uri);
    } catch {
      try {
        // A POSIX URI (file:///work/x) read on Windows: keep the path as agy wrote it.
        conv.cwd = fileURLToPath(uri, { windows: false });
      } catch {
        // not a local path
      }
    }
    break;
  }
  return conv;
}

async function loadAgyConversation(dbPath: string): Promise<AgyConversation | undefined> {
  const h = await openSqliteCopy(dbPath);
  if (!h) return undefined;
  try {
    return readAgyConversation(h.db);
  } finally {
    h.close();
  }
}

// ---------------------------------------------------------------- transcripts

/** brain/<conversationId>/.system_generated/logs/<file> → conversationId. */
const agyConversationOf = (file: string): string => basename(dirname(dirname(dirname(file))));

/** A hook's conversation transcript: its transcriptPath, else the conversation's dir in each product's data dir. */
function agyTranscriptOf(raw: Json, conversationId: string): string | undefined {
  const given = str(raw.transcriptPath);
  const dirs = given ? [dirname(given)] : AGY_PRODUCT_DIRS.map((d) => join(home(), ".gemini", d, "brain", conversationId, ".system_generated", "logs"));
  for (const d of dirs) for (const f of ["transcript_full.jsonl", "transcript.jsonl"]) if (existsSync(join(d, f))) return join(d, f);
  return undefined;
}

/**
 * The turn a Stop hook at `ts` closes, keyed like agyTranscriptEvents keys its
 * turn.end: the step index of the turn's last planner response.
 */
export function agyTurnKey(path: string | undefined, ts: number): number | undefined {
  if (!path) return undefined;
  let last: number | undefined;
  for (const r of jsonlTail("agy-steps", path, (r) => [{ type: r.type, step: num(r.step_index), ts: toMs(r.created_at) }])) {
    if ((r.ts ?? -Infinity) > ts) break;
    if (r.type === "USER_INPUT") last = undefined;
    else if (r.type === "PLANNER_RESPONSE") last = r.step;
  }
  return last;
}

/** One transcript per conversation: transcript_full.jsonl when present (nothing truncated), else transcript.jsonl. */
export function agyTranscriptFiles(dataDir: string): string[] {
  const found = walkFiles(join(dataDir, "brain"), (n, full) => (n === "transcript.jsonl" || n === "transcript_full.jsonl") && basename(dirname(full)) === "logs" && basename(dirname(dirname(full))) === ".system_generated", 4);
  const byDir = new Map<string, string>();
  for (const f of found) if (!byDir.has(dirname(f)) || basename(f) === "transcript_full.jsonl") byDir.set(dirname(f), f);
  return [...byDir.values()].sort();
}

/**
 * A tool step's result header (agy 1.5): "Created At: <iso>\nCompleted At: <iso>\n\n",
 * then for a command "The command exited with code N." before its output. Times are whole
 * seconds; durationMs is absent unless both parse.
 */
export function agyResultMeta(text: string): { durationMs?: number; exitCode?: number } {
  const head = text.slice(0, 512);
  const at = (k: string): number | undefined => {
    const m = new RegExp(`^${k}: (\\S+)$`, "m").exec(head);
    const t = m ? Date.parse(m[1]!) : NaN;
    return Number.isFinite(t) ? t : undefined;
  };
  const created = at("Created At");
  const completed = at("Completed At");
  const exit = /^The command exited with code (-?\d+)\b/m.exec(head);
  const out: { durationMs?: number; exitCode?: number } = {};
  if (created !== undefined && completed !== undefined && completed >= created) out.durationMs = completed - created;
  if (exit) out.exitCode = Number(exit[1]);
  return out;
}

export async function* agyTranscriptEvents(file: string, ctx: NormalizeContext, since?: number, conv?: AgyConversation): AsyncGenerator<AgentEvent> {
  // Each PLANNER_RESPONSE is one model step with at most a few tool_calls; the GENERIC steps right
  // after it are their results. A tool step agy marked ERROR is left out of the transcript (seen in
  // every such step locally): the call is followed by the next planner step, and the error is in the
  // DB at the step the result would have had. Event ids depend only on the conversation and step
  // index, so transcript.jsonl and transcript_full.jsonl import as the same events.
  const sessionId = agyConversationOf(file);
  const cwd = conv?.cwd;
  let started = false;
  let sawUser = false;
  // The turn's last planner step keys its turn.end (agyTurnKey finds the same one for a Stop hook).
  let last: number | undefined;
  let lastTs = mtimeMs(file);
  type Call = { id: string; tool: string; args: unknown; ts: number; resultStep?: number; model?: string };
  // Tool calls of the latest planner step that have no result yet.
  let pending: Call[] = [];
  // Model calls already emitted (one gen_metadata row can cover several steps).
  const emitted = new Set<AgyGeneration>();
  const llmCall = (em: Emitter, g: AgyGeneration | undefined, ok: boolean, error?: string): void => {
    if (g) emitted.add(g);
    em.push("llm.call", { provider: g?.provider ?? "google", responseModel: g?.model, ttftMs: g?.ttftMs, ok, error }, { ...(g?.usage ? { usage: g.usage } : {}), ...(g?.durationMs !== undefined ? { durationMs: g.durationMs } : {}) });
  };
  const toolEnd = async (em: Emitter, call: Call, ts: number, output: string, err: string | undefined): Promise<void> => {
    // The result's own header times the call (whole seconds); below a second, the steps' timestamps do.
    const meta = agyResultMeta(output);
    const durationMs = meta.durationMs || Math.max(0, ts - call.ts) || undefined;
    const failed = err ?? (meta.exitCode ? `exit code ${meta.exitCode}` : undefined);
    await emitToolEnd(em, ctx, { tool: call.tool, toolUseId: call.id, input: commonArgs(call.args), output: output || err, ok: !failed, error: failed, durationMs, exitCode: meta.exitCode }, cwd);
    const sub = subagentInfo(call.tool, call.id, call.args);
    if (sub) em.push("subagent.end", { subagentId: call.id, type: sub.type, ok: !failed }, { subagentId: call.id, durationMs, key: [call.id] });
  };
  /** Ends the calls a newer step left without a result: failed ones from the DB; the rest stay a bare tool.start. */
  const dropPending = async (ts: number): Promise<AgentEvent[]> => {
    const out: AgentEvent[] = [];
    for (const call of pending) {
      const err = call.resultStep !== undefined ? conv?.failedSteps.get(call.resultStep) : undefined;
      if (!err) continue;
      const em = new Emitter(ctx, { agent: ID, sessionId, ts, cwd, model: call.model }, ["agy-file", sessionId, call.resultStep!, "failed"], { toolKeys: true });
      await toolEnd(em, call, ts, "", err);
      out.push(...em.events);
    }
    pending = [];
    return out;
  };
  for await (const { lineNo, value: r } of readJsonl(file)) {
    const ts = toMs(r.created_at) ?? lastTs;
    lastTs = ts;
    const stepIdx = num(r.step_index);
    const step = stepIdx ?? `l${lineNo}`;
    const gen = stepIdx !== undefined ? conv?.generations.get(stepIdx) : undefined;
    const em = new Emitter(ctx, { agent: ID, sessionId, ts, cwd, model: gen?.model }, ["agy-file", sessionId, step], { toolKeys: true });
    if (!started) {
      em.push("session.start", { source: "transcript" });
      started = true;
    }
    const text = typeof r.content === "string" ? r.content.trim() : "";
    const dropped = r.type === "GENERIC" ? [] : await dropPending(ts);
    switch (r.type) {
      case "USER_INPUT":
        if (sawUser) em.turnEnd({}, last);
        sawUser = true;
        last = undefined;
        const prompt = agyUserText(text);
        if (prompt) await emitText(em, ctx, "user.message", prompt);
        break;
      case "PLANNER_RESPONSE":
        last = stepIdx;
        llmCall(em, gen && !emitted.has(gen) ? gen : undefined, !str(r.error), str(r.error));
        if (text) await emitText(em, ctx, "assistant.message", text);
        for (const [i, tc] of (Array.isArray(r.tool_calls) ? r.tool_calls.filter(isObj) : []).entries()) {
          // The id of the tool step that will hold its result: hooks name a call by that step (stepIdx).
          // In the conversation DB that step (type 132) carries the call, the planner step only the
          // reply; a planner step has one call (2545 of 2545 local calls, agy 1.5.x). No hook payload
          // was available to check stepIdx against.
          const id = stepIdx !== undefined ? `step-${stepIdx + 1 + i}` : `step-${step}-${i}`;
          const tool = str(tc.name) ?? "unknown";
          pending.push({ id, tool, args: tc.args, ts, ...(stepIdx !== undefined ? { resultStep: stepIdx + 1 + i } : {}), ...(gen?.model ? { model: gen.model } : {}) });
          const sub = subagentInfo(tool, id, tc.args);
          if (sub) em.push("subagent.start", sub, { subagentId: id, key: [id] });
          await agyToolStart(em, ctx, tool, id, tc.args);
        }
        break;
      case "GENERIC": {
        // RUNNING: the call went to the background (e.g. a long run_command); this is what the model got back.
        const call = pending.shift();
        if (!call) break;
        await toolEnd(em, call, ts, text, str(r.error) ?? (stepIdx !== undefined ? conv?.failedSteps.get(stepIdx) : undefined));
        break;
      }
      case "CHECKPOINT":
        em.push("context.compact", { trigger: "auto" });
        break;
      case "ERROR_MESSAGE": {
        const message = text || str(r.error) || "error";
        em.push("error", { message });
        // A model call that failed still spent tokens.
        if (gen && !emitted.has(gen)) llmCall(em, gen, false, message.slice(0, 500));
        break;
      }
    }
    for (const e of [...dropped, ...em.events]) if (since === undefined || e.ts >= since) yield e;
  }
  const tail = new Emitter(ctx, { agent: ID, sessionId, ts: lastTs, cwd }, ["agy-file", sessionId, "tail"]);
  if (sawUser) tail.turnEnd({}, last);
  for (const e of [...(await dropPending(lastTs)), ...tail.events]) if (since === undefined || e.ts >= since) yield e;
}

const sizeOf = (p: string): number => {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
};


export const antigravityAdapter: Adapter = {
  id: ID,
  displayName: "Antigravity CLI",
  tier: "A",
  // 2 (0.1.2): calls named by their result step, turns by the last planner step, as hooks do.
  // 3 (0.1.5): a command result's exit code (nonzero fails the call) and its Created/Completed At time it. A tool call that loads a skill names it (payload.skill).
  parseVersion: 3,
  async detect(): Promise<DetectResult> {
    const binary = findBinary(["agy"]);
    const dir = agyCliDir();
    let hooked = false;
    try {
      hooked = isOurDef(readJsonObject(agyHooksPath({ scope: "user" })).value[KEY]);
    } catch {
      // ignore
    }
    const r: DetectResult = { installed: !!binary || existsSync(dir), hooked };
    if (binary) {
      r.binary = binary;
      const v = await binVersion(binary);
      if (v) r.version = v;
    }
    if (existsSync(dir)) r.configDir = dir;
    r.notes = ["~/.gemini/config/hooks.json is shared by the Antigravity App, CLI and IDE: all three are captured.", "Hooks carry no tool output, model tokens or cost; `coding.sh ingest --backfill --agent antigravity` imports them from the transcripts and conversation DBs."];
    return r;
  },
  async install(opts: InstallOpts): Promise<FileChange[]> {
    const path = agyHooksPath(opts);
    const { text, value } = readJsonObject(path);
    if (value[KEY] !== undefined && !isOurDef(value[KEY])) throw new Error(`${path} already has a "${KEY}" hook not written by coding.sh; refusing to overwrite it`);
    const next = { ...value, [KEY]: agyHookDef(opts.hookCommand) };
    return applyWrites(ID, [{ path, before: text, after: toJson(next), summary: `add the "${KEY}" hook (${AGY_HOOK_EVENTS.join(", ")})`, track: "install", pristine: value[KEY] === undefined }], opts.dryRun);
  },
  async uninstall(opts): Promise<FileChange[]> {
    const path = agyHooksPath(opts);
    const { text, value } = readJsonObject(path);
    if (text === undefined || !isOurDef(value[KEY])) return [];
    const { [KEY]: _ours, ...rest } = value;
    const changes = applyWrites(ID, [{ path, before: text, after: isEmptyObject(rest) ? undefined : toJson(rest), summary: `remove the "${KEY}" hook`, track: "uninstall", remaining: rest }], opts.dryRun);
    // A bare ~/.gemini left behind would read as a Gemini CLI install: drop the dirs we emptied.
    if (!opts.dryRun && opts.scope === "user" && changes.some((c) => c.action === "delete")) removeEmptyDirs(dirname(path), join(home(), ".gemini"));
    return changes;
  },
  normalize: normalizeAgy,
  async *backfill(ctx: NormalizeContext, opts?: BackfillOpts): AsyncIterable<AgentEvent> {
    for (const product of AGY_PRODUCT_DIRS) {
      const dataDir = join(home(), ".gemini", product);
      for (const f of agyTranscriptFiles(dataDir)) {
        // The transcript and its conversation DB move together: either changing re-reads both.
        const db = join(dataDir, "conversations", `${agyConversationOf(f)}.db`);
        const parts = [f, db, `${db}-wal`];
        const file = { path: f, size: parts.reduce((n, p) => n + sizeOf(p), 0), mtimeMs: Math.max(...parts.map(mtimeMs)) };
        if (opts?.since !== undefined && file.mtimeMs < opts.since) continue;
        if (opts?.changed && !(await opts.changed(file))) continue;
        yield* agyTranscriptEvents(f, ctx, opts?.since, await loadAgyConversation(db));
      }
    }
  },
  async run(spec: RunSpec): Promise<AgentRunOutput> {
    const bin = findBinary(["agy"], { ...process.env, ...spec.env }) ?? "agy";
    const args = ["-p", spec.instruction, "--output-format", "stream-json"];
    if (!hasFlag(spec.flags, "--dangerously-skip-permissions")) args.push("--dangerously-skip-permissions");
    if (spec.model && !hasFlag(spec.flags, "--model")) args.push("--model", spec.model);
    args.push(...spec.flags);
    let sessionId: string | undefined;
    let usage: Usage | undefined;
    const onLine = jsonLines((o) => {
      sessionId ??= str(o.conversation_id) ?? str(o.session_id) ?? str(o.conversationId);
      if (o.type === "result") usage = usageFrom(o.usage) ?? usage;
    });
    const r = await spawnAgent({ bin, args, cwd: spec.cwd, stdoutFile: spec.stdoutFile, env: runEnv(spec, { AGY_CLI_DISABLE_AUTO_UPDATE: "1" }), timeoutMs: spec.timeoutMs, onLine });
    return toRunOutput(r, sessionId, usage);
  },
  harnessFiles() {
    return {
      project: ["AGENTS.md", "GEMINI.md", ".agents/**"],
      user: ["~/.gemini/antigravity-cli/settings.json", "~/.gemini/config/hooks.json", "~/.gemini/config/mcp_config.json", "~/.gemini/GEMINI.md"],
    };
  },
  async overlay(_bundle: HarnessBundle, _runDir: string) {
    return { env: { AGY_CLI_DISABLE_AUTO_UPDATE: "1" }, flags: [] };
  },
};
