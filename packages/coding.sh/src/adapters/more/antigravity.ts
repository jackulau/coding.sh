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
// - Transcript: ~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript.jsonl,
//   lines {type: USER_INPUT|PLANNER_RESPONSE|GENERIC|CHECKPOINT|SYSTEM_MESSAGE|ERROR_MESSAGE,
//   step_index, source, status, created_at, content, thinking?, error?, tool_calls[{name,args}]}; each
//   PLANNER_RESPONSE with a tool call is followed by a GENERIC entry holding its result (observed
//   locally on agy 2026-09; the format is undocumented, so it is parsed defensively).
// - Headless: `agy -p … --output-format stream-json --dangerously-skip-permissions --model M`
//   (init/step_update/result; usage{input_tokens,output_tokens,thinking_tokens,cache_read_tokens}).
// - Isolation: no documented config-dir variable (tokens live in the OS keyring), so overlay
//   only disables auto-update.
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Adapter, AgentRunOutput, DetectResult, FileChange, HarnessBundle, InstallOpts, NormalizeContext, RunSpec, SpoolLine } from "../../core/types.ts";
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
  mtimeMs,
  num,
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
/** agy tool that spawns a subagent (docs: "Agent collaboration"). Its internals are not exposed. */
const SUBAGENT_TOOL = "invoke_subagent";

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
    const handler = { type: "command", command: hookCmd(hookCommand, ID, ev), timeout: 10 };
    def[ev] = TOOL_EVENTS.has(ev) ? [{ matcher: "*", hooks: [handler] }] : [handler];
  }
  return def;
}

function isOurDef(v: unknown): boolean {
  return isObj(v) && JSON.stringify(v).includes("hook.mjs") && Object.values(v).some((list) => Array.isArray(list) && list.some((h) => isObj(h) && (isOurCommand(h.command, ID) || (Array.isArray(h.hooks) && h.hooks.some((x) => isObj(x) && isOurCommand(x.command, ID))))));
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
  const model = str(raw.modelName);
  const em = new Emitter(ctx, { agent: ID, sessionId, ts: line.ts, cwd, runId: line.runId, model }, spoolIdParts(line, sessionId, ctx));
  switch (line.event) {
    case "SessionStart":
      em.push("session.start", { source: "hook", transcriptPath: str(raw.transcriptPath) });
      break;
    case "PreInvocation": {
      // Fires before every model call; the first call of a run carries the new prompt.
      if (num(raw.invocationNum) !== 0) return [];
      const p = str(raw.lastUserInput);
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
      if (sub) em.push("subagent.start", sub, { subagentId: id });
      await agyToolStart(em, ctx, tool, id, args);
      await emitToolEnd(em, ctx, { tool, toolUseId: id, input, output: err, ok: !err, error: err }, cwd);
      if (sub) em.push("subagent.end", { subagentId: id, type: sub.type, ok: !err }, { subagentId: id });
      break;
    }
    case "Stop": {
      const err = str(raw.error);
      if (err) em.push("error", { message: err });
      em.push("turn.end", { reason: str(raw.terminationReason), fullyIdle: typeof raw.fullyIdle === "boolean" ? raw.fullyIdle : undefined });
      break;
    }
    default:
      em.push("notification", { kind: line.event });
  }
  return attachRaw(em.events, await rawBlob(ctx, line.raw));
}

export async function* agyTranscriptEvents(file: string, ctx: NormalizeContext, since?: number): AsyncGenerator<AgentEvent> {
  // <cli>/brain/<conversationId>/.system_generated/logs/transcript.jsonl. Each PLANNER_RESPONSE is
  // one model step with at most a few tool_calls; the GENERIC entries after it are their results.
  const sessionId = basename(dirname(dirname(dirname(file))));
  let started = false;
  let sawUser = false;
  let lastTs = mtimeMs(file);
  const pending: { id: string; tool: string; args: unknown; ts: number }[] = [];
  for await (const { lineNo, value: r } of readJsonl(file)) {
    const ts = toMs(r.created_at) ?? lastTs;
    lastTs = ts;
    const step = num(r.step_index) ?? `l${lineNo}`;
    const em = new Emitter(ctx, { agent: ID, sessionId, ts }, ["agy-file", sessionId, step]);
    if (!started) {
      em.push("session.start", { source: "transcript" });
      started = true;
    }
    const text = typeof r.content === "string" ? r.content.trim() : "";
    switch (r.type) {
      case "USER_INPUT":
        if (sawUser) em.push("turn.end", {});
        sawUser = true;
        pending.length = 0;
        if (text) await emitText(em, ctx, "user.message", text);
        break;
      case "PLANNER_RESPONSE":
        em.push("llm.call", { provider: "google", ok: !str(r.error) });
        if (text) await emitText(em, ctx, "assistant.message", text);
        for (const [i, tc] of (Array.isArray(r.tool_calls) ? r.tool_calls.filter(isObj) : []).entries()) {
          const id = `step-${step}-${i}`;
          const tool = str(tc.name) ?? "unknown";
          pending.push({ id, tool, args: tc.args, ts });
          const sub = subagentInfo(tool, id, tc.args);
          if (sub) em.push("subagent.start", sub, { subagentId: id });
          await agyToolStart(em, ctx, tool, id, tc.args);
        }
        break;
      case "GENERIC": {
        if (r.status === "RUNNING") break;
        const call = pending.shift();
        if (!call) break;
        const err = str(r.error);
        const durationMs = Math.max(0, ts - call.ts) || undefined;
        await emitToolEnd(em, ctx, { tool: call.tool, toolUseId: call.id, input: commonArgs(call.args), output: text || err, ok: !err, error: err, durationMs }, undefined);
        const sub = subagentInfo(call.tool, call.id, call.args);
        if (sub) em.push("subagent.end", { subagentId: call.id, type: sub.type, ok: !err }, { subagentId: call.id, durationMs });
        break;
      }
      case "CHECKPOINT":
        em.push("context.compact", { trigger: "auto" });
        break;
      case "ERROR_MESSAGE":
        em.push("error", { message: text || str(r.error) || "error" });
        break;
    }
    for (const e of em.events) if (since === undefined || e.ts >= since) yield e;
  }
  if (sawUser) {
    const tail = new Emitter(ctx, { agent: ID, sessionId, ts: lastTs }, ["agy-file", sessionId, "tail"]);
    tail.push("turn.end", {});
    for (const e of tail.events) if (since === undefined || e.ts >= since) yield e;
  }
}

export const antigravityAdapter: Adapter = {
  id: ID,
  displayName: "Antigravity CLI",
  tier: "A",
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
    r.notes = ["~/.gemini/config/hooks.json is shared by the Antigravity App, CLI and IDE: all three are captured.", "No tool output reaches hooks; run `coding.sh backfill antigravity` for transcripts."];
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
  async *backfill(ctx: NormalizeContext, opts?: { since?: number }): AsyncIterable<AgentEvent> {
    const files = walkFiles(join(agyCliDir(), "brain"), (n, full) => n === "transcript.jsonl" && full.includes(".system_generated"), 4);
    for (const f of files) {
      if (opts?.since !== undefined && mtimeMs(f) < opts.since) continue;
      yield* agyTranscriptEvents(f, ctx, opts?.since);
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
    const r = await spawnAgent({ bin, args, cwd: spec.cwd, env: runEnv(spec, { AGY_CLI_DISABLE_AUTO_UPDATE: "1" }), timeoutMs: spec.timeoutMs, onLine });
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
