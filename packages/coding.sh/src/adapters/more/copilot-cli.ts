// GitHub Copilot CLI (`copilot`). Tier A: JSON hook files + session-state events.jsonl + `copilot -p`.
//
// Verified against docs.github.com hooks-configuration / cli reference (2026-11):
// - Hook files: $COPILOT_HOME/hooks/*.json (user; COPILOT_HOME defaults to ~/.copilot) and
//   .github/hooks/*.json (repo; loaded in -p mode only for trusted folders). We own a
//   dedicated file, coding-sh.json, so install/uninstall never touch the user's hook files.
//   The format has no ownership marker, so each write is recorded (path + sha256) in
//   ~/.coding.sh/installs.json; uninstall removes the file only while it is ours.
//   Shape: {version:1, hooks:{<event>:[{type:"command", bash, powershell, timeoutSec}]}}.
//   The key is `bash`/`powershell` (not `command`); both are written so Windows works too.
// - Events (camelCase): sessionStart, sessionEnd, userPromptSubmitted, preToolUse,
//   permissionRequest, postToolUse, postToolUseFailure, agentStop, subagentStart, subagentStop,
//   errorOccurred, preCompact, notification, userPromptTransformed.
//   preToolUse is NOT installed: any non-zero exit there denies the tool (fail-closed), and
//   postToolUse already carries toolName + toolArgs, so tool.start is synthesized from it.
// - Payload (camelCase): sessionId, timestamp (ms), cwd + source/initialPrompt, reason, prompt,
//   toolName, toolArgs (object), toolResult{resultType,textResultForLlm}, error, transcriptPath,
//   stopReason, agentName/agentId/agentType/response, trigger. No model field.
//   PascalCase event keys switch payloads to snake_case; normalize accepts both.
// - Sessions: $COPILOT_HOME/session-state/<id>/events.jsonl, envelope {id,parentId,timestamp(ISO),
//   type,data,agentId?}: session.start{sessionId,selectedModel,context{cwd,gitRoot,branch,headCommit}},
//   user.message{content}, assistant.message{content,model}, tool.execution_start{toolCallId,toolName,
//   arguments,mcpServerName}, tool.execution_complete{toolCallId,success,result{content},error},
//   session.model_change{newModel}, session.shutdown{modelMetrics{<m>:{usage{…}}}}.
//   assistant.usage is ephemeral (never on disk). 1.0.107 also writes session.usage_record{usage{model,
//   inputTokens,outputTokens,cache*,cost,duration,finishReason}} per model call; otherwise token
//   totals come from session.shutdown.
// - Headless: `copilot -p … --allow-all --no-ask-user --output-format=json --session-id <uuid>`.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Adapter, AgentRunOutput, DetectResult, FileChange, HarnessBundle, InstallOpts, NormalizeContext, RunSpec, SpoolLine } from "../../core/types.ts";
import type { AgentEvent, RepoState, Usage } from "../../schema/index.ts";
import { forgetInstall, ownsInstall, recordInstall } from "../_shared/installs.ts";
import { parseTraceparent } from "../_shared/traceparent.ts";
import {
  Emitter,
  addUsage,
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
  hasFlag,
  home,
  hookCmd,
  isObj,
  isOurCommand,
  jsonLines,
  mtimeMs,
  num,
  overlayHome,
  rawBlob,
  readJsonObject,
  readJsonl,
  runEnv,
  spawnAgent,
  spoolIdParts,
  str,
  textOf,
  toJson,
  toMs,
  toRunOutput,
  usageFrom,
  walkFiles,
} from "./_util.ts";
import type { Json } from "./_util.ts";
import { isWrapperEvent, normalizeWrapperLine } from "./wrapper.ts";

const ID = "copilot-cli";
const FILE = "coding-sh.json";
export const COPILOT_HOOK_EVENTS = ["sessionStart", "sessionEnd", "userPromptSubmitted", "postToolUse", "postToolUseFailure", "agentStop", "subagentStart", "subagentStop", "errorOccurred", "preCompact"] as const;

export function copilotHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.COPILOT_HOME || join(home(env), ".copilot");
}

export function copilotHookPath(opts: { scope: "user" | "project"; projectDir?: string | undefined }, env: NodeJS.ProcessEnv = process.env): string {
  return opts.scope === "project" ? join(opts.projectDir ?? process.cwd(), ".github", "hooks", FILE) : join(copilotHome(env), "hooks", FILE);
}

export function copilotHookFile(hookCommand: string): Json {
  const hooks: Json = {};
  for (const ev of COPILOT_HOOK_EVENTS) {
    // bash runs outside Windows (the sh fast path), powershell on Windows (node).
    hooks[ev] = [{ type: "command", bash: hookCmd(hookCommand, ID, ev, "", "linux"), powershell: `& ${hookCmd(hookCommand, ID, ev, "", "win32")}`, timeoutSec: 10 }];
  }
  return { version: 1, hooks };
}

/** True when every hook in the file is ours (so the file is safe to replace/delete). */
function isOurFile(v: Json): boolean {
  const hooks = v.hooks;
  if (!isObj(hooks)) return false;
  let any = false;
  for (const list of Object.values(hooks)) {
    if (!Array.isArray(list)) return false;
    for (const h of list) {
      if (!isObj(h) || !(isOurCommand(h.bash, ID) || isOurCommand(h.command, ID))) return false;
      any = true;
    }
  }
  return any;
}

function pick(raw: Json, camel: string, snake: string): unknown {
  return raw[camel] ?? raw[snake];
}

const EVENT_ALIASES: Record<string, string> = {
  SessionStart: "sessionStart",
  SessionEnd: "sessionEnd",
  UserPromptSubmit: "userPromptSubmitted",
  PreToolUse: "preToolUse",
  PostToolUse: "postToolUse",
  PostToolUseFailure: "postToolUseFailure",
  Stop: "agentStop",
  SubagentStart: "subagentStart",
  SubagentStop: "subagentStop",
  PreCompact: "preCompact",
  ErrorOccurred: "errorOccurred",
  Notification: "notification",
};

/** Turn key for an agentStop hook run: its input timestamp, which the transcript's hook.start record repeats. */
const agentStopKey = (ts: unknown): string | undefined => (num(ts) !== undefined ? `agentStop:${num(ts)}` : undefined);

export async function normalizeCopilot(line: SpoolLine, ctx: NormalizeContext): Promise<AgentEvent[]> {
  if (isWrapperEvent(line.event)) return normalizeWrapperLine(line, ctx);
  const raw: Json = isObj(line.raw) ? line.raw : {};
  const sessionId = str(pick(raw, "sessionId", "session_id")) ?? `copilot-unknown-${line.ppid ?? line.pid}`;
  const cwd = str(raw.cwd) ?? line.cwd;
  const ts = toMs(raw.timestamp) ?? line.ts;
  const agentId = str(pick(raw, "agentId", "agent_id"));
  const ev = EVENT_ALIASES[line.event] ?? line.event;
  // With OpenTelemetry on, Copilot CLI hands hooks its trace context: the events join the agent's spans.
  const trace = parseTraceparent(pick(raw, "traceparent", "trace_parent") ?? raw.traceParent);
  const em = new Emitter(ctx, { agent: ID, sessionId, ts, cwd, runId: line.runId, subagentId: agentId, traceId: trace?.traceId, parentSpanId: trace?.spanId }, spoolIdParts(line, sessionId, ctx), { toolKeys: true });
  const tool = str(pick(raw, "toolName", "tool_name")) ?? "unknown";
  const input = pick(raw, "toolArgs", "tool_input");
  // Hooks carry no call id; postToolUse synthesizes both halves, so pair them with a stable one.
  const toolUseId = str(pick(raw, "toolCallId", "tool_use_id")) ?? (ev.startsWith("postToolUse") ? `hook-${ctx.id(...spoolIdParts(line, sessionId, ctx)).slice(0, 16)}` : undefined);
  switch (ev) {
    case "sessionStart": {
      // initialPrompt is not emitted: userPromptSubmitted carries the same prompt (seen on 1.0.107).
      em.push("session.start", { source: str(raw.source), transcriptPath: str(pick(raw, "transcriptPath", "transcript_path")), tracestate: trace ? str(pick(raw, "tracestate", "trace_state") ?? raw.traceState)?.slice(0, 512) : undefined });
      break;
    }
    case "sessionEnd":
      em.push("session.end", { reason: str(raw.reason) });
      break;
    case "userPromptSubmitted": {
      const p = str(raw.prompt);
      if (p) await emitText(em, ctx, "user.message", p);
      break;
    }
    case "preToolUse":
      await emitToolStart(em, ctx, tool, toolUseId, input);
      break;
    case "postToolUse":
    case "postToolUseFailure": {
      await emitToolStart(em, ctx, tool, toolUseId, input);
      const res = pick(raw, "toolResult", "tool_response");
      const rt = str(get(res, "resultType"));
      const failed = ev === "postToolUseFailure" || (rt !== undefined && rt !== "success");
      const err = failed ? (str(raw.error) ?? str(get(raw, "error", "message")) ?? rt ?? "tool failed") : undefined;
      await emitToolEnd(em, ctx, { tool, toolUseId, input, output: get(res, "textResultForLlm") ?? res ?? raw.error, ok: !failed, error: err }, cwd);
      break;
    }
    case "agentStop":
      em.turnEnd({ stopReason: str(pick(raw, "stopReason", "stop_reason")), transcriptPath: str(pick(raw, "transcriptPath", "transcript_path")) }, agentStopKey(raw.timestamp));
      break;
    case "subagentStart":
    case "subagentStop": {
      // Docs: subagentStart carries agentName but no agentId; subagentStop carries both.
      // Key both halves by name so they pair; the instance id rides along when present.
      const name = str(pick(raw, "agentName", "agent_name"));
      const p = { subagentId: name ?? agentId, agentId, type: str(pick(raw, "agentType", "agent_type")) ?? name };
      if (ev === "subagentStart") {
        em.push("subagent.start", { ...p, description: str(pick(raw, "agentDescription", "agent_description")) });
        break;
      }
      const r = await clip(ctx, pick(raw, "response", "last_assistant_message"));
      em.push("subagent.end", { ...p, ok: true, stopReason: str(pick(raw, "stopReason", "stop_reason")), result: r.value }, r.blob ? { blobs: [r.blob] } : {});
      break;
    }
    case "errorOccurred": {
      const e = raw.error;
      em.push("error", { message: str(get(e, "message")) ?? (typeof e === "string" ? e : "error"), name: str(get(e, "name")), recoverable: typeof raw.recoverable === "boolean" ? raw.recoverable : undefined });
      break;
    }
    case "preCompact":
      em.push("context.compact", { trigger: raw.trigger === "manual" ? "manual" : "auto" });
      break;
    default:
      em.push("notification", { kind: ev, message: str(raw.message) });
  }
  return attachRaw(em.events, await rawBlob(ctx, line.raw));
}

// ---------------------------------------------------------------- transcripts

function metricsUsage(modelMetrics: unknown): { usage?: Usage; models: string[] } {
  let usage: Usage | undefined;
  const models: string[] = [];
  if (!isObj(modelMetrics)) return { models };
  for (const [model, m] of Object.entries(modelMetrics)) {
    models.push(model);
    const u = usageFrom(get(m, "usage"));
    const cost = num(get(m, "requests", "cost"));
    usage = addUsage(usage, u ? { ...u, ...(cost !== undefined ? { costUsd: cost } : {}) } : cost !== undefined ? { costUsd: cost } : undefined);
  }
  return usage ? { usage, models } : { models };
}

export async function* copilotSessionEvents(file: string, ctx: NormalizeContext, since?: number): AsyncGenerator<AgentEvent> {
  let sessionId = basename(file) === "events.jsonl" ? basename(dirname(file)) : basename(file, ".jsonl");
  let cwd: string | undefined;
  let repo: RepoState | undefined;
  let model: string | undefined;
  let sawUser = false;
  let sawUsage = false;
  let lastTs = mtimeMs(file);
  const calls = new Map<string, { tool: string; input: unknown; ts: number }>();
  for await (const { lineNo, value: r } of readJsonl(file)) {
    const d: Json = isObj(r.data) ? r.data : {};
    const ts = toMs(r.timestamp) ?? lastTs;
    lastTs = ts;
    const type = str(r.type) ?? "";
    if (type === "session.start") {
      sessionId = str(d.sessionId) ?? sessionId;
      cwd = str(get(d, "context", "cwd")) ?? cwd;
      model = str(d.selectedModel) ?? model;
      const root = str(get(d, "context", "gitRoot"));
      if (root) {
        repo = { root, head: str(get(d, "context", "headCommit")) ?? "" };
        const br = str(get(d, "context", "branch"));
        if (br) repo.branch = br;
      }
    }
    const sub = str(r.agentId);
    const em = new Emitter(ctx, { agent: ID, sessionId, ts, cwd, model, subagentId: sub }, ["copilot-file", sessionId, str(r.id) ?? lineNo], { toolKeys: true });
    switch (type) {
      case "session.start":
        em.push("session.start", { source: "transcript", copilotVersion: str(d.copilotVersion), producer: str(d.producer) }, repo ? { repo } : {});
        break;
      case "user.message": {
        const text = str(d.content);
        if (text) {
          if (sawUser) em.push("turn.end", {});
          sawUser = true;
          await emitText(em, ctx, "user.message", text);
        }
        break;
      }
      case "hook.start": {
        // The transcript records each hook run with its input: an agentStop ends the turn,
        // keyed like the hook's own turn.end so a session seen both ways keeps one.
        const key = d.hookType === "agentStop" ? agentStopKey(get(d, "input", "timestamp")) : undefined;
        if (key) {
          em.turnEnd({ stopReason: str(get(d, "input", "stopReason")) }, key);
          sawUser = false;
        }
        break;
      }
      case "assistant.message": {
        model = str(d.model) ?? model;
        const text = str(d.content);
        if (text) await emitText(em, ctx, "assistant.message", text, model ? { model } : {});
        break;
      }
      case "assistant.usage":
      case "session.usage_record": {
        // 1.0.107 writes one session.usage_record{usage{…}} per model call; assistant.usage is the older live shape.
        const c: Json = type === "session.usage_record" ? (isObj(d.usage) ? d.usage : {}) : d;
        const u = usageFrom({ inputTokens: c.inputTokens, outputTokens: c.outputTokens, cacheReadTokens: c.cacheReadTokens, cacheWriteTokens: c.cacheWriteTokens, costUsd: c.cost });
        const m = str(c.responseModel) ?? str(c.model);
        if (u) sawUsage = true;
        const dur = num(c.duration);
        em.push("llm.call", { responseModel: m, ok: true, stopReason: str(c.finishReason) }, { ...(u ? { usage: u } : {}), ...(m ? { model: m } : {}), ...(dur !== undefined ? { durationMs: dur } : {}) });
        break;
      }
      case "tool.execution_start": {
        const tool = str(d.toolName) ?? "unknown";
        const id = str(d.toolCallId);
        if (id) calls.set(id, { tool, input: d.arguments, ts });
        await emitToolStart(em, ctx, tool, id, d.arguments);
        break;
      }
      case "tool.execution_complete": {
        const id = str(d.toolCallId);
        const call = id ? calls.get(id) : undefined;
        const ok = d.success !== false;
        await emitToolEnd(
          em,
          ctx,
          { tool: call?.tool ?? str(d.toolName) ?? "unknown", toolUseId: id, input: call?.input, output: get(d, "result", "content") ?? d.result, ok, error: ok ? undefined : (str(get(d, "error", "message")) ?? str(d.error) ?? "tool failed"), durationMs: call ? Math.max(0, ts - call.ts) || undefined : undefined },
          cwd,
        );
        break;
      }
      case "subagent.started":
        // Keyed by the spawning tool call; the child's own agentId tags its events.
        em.push("subagent.start", { subagentId: str(d.toolCallId), toolUseId: str(d.toolCallId), type: str(d.agentName), description: str(d.agentDescription) ?? str(d.agentDisplayName), model: str(d.model) });
        break;
      case "subagent.completed":
      case "subagent.failed": {
        const ok = type === "subagent.completed";
        const dur = num(d.durationMs);
        // totalTokens stays in the payload: the child's own llm.call events already carry usage.
        em.push(
          "subagent.end",
          { subagentId: str(d.toolCallId), toolUseId: str(d.toolCallId), type: str(d.agentName), ok, error: ok ? undefined : (str(get(d, "error", "message")) ?? str(d.error) ?? "subagent failed"), totalTokens: num(d.totalTokens), totalToolCalls: num(d.totalToolCalls) },
          dur !== undefined ? { durationMs: dur } : {},
        );
        break;
      }
      case "session.model_change":
        model = str(d.newModel) ?? model;
        em.push("notification", { kind: "model_change", model, previous: str(d.previousModel) });
        break;
      case "session.compaction_complete":
      case "session.compaction_start":
        if (type === "session.compaction_start") em.push("context.compact", { trigger: "auto" });
        break;
      case "session.error":
        em.push("error", { message: str(d.message) ?? "error" });
        break;
      case "session.shutdown": {
        if (sawUser) em.push("turn.end", {});
        sawUser = false;
        const { usage, models } = metricsUsage(d.modelMetrics);
        const cur = str(d.currentModel);
        // Per-call usage already counted wins over the shutdown totals (buildSession sums all events).
        em.push("session.end", { reason: "shutdown", models: models.length ? models : undefined, apiDurationMs: num(d.totalApiDurationMs) }, { ...(usage && !sawUsage ? { usage } : {}), ...(cur ? { model: cur } : {}) });
        break;
      }
    }
    for (const e of em.events) if (since === undefined || e.ts >= since) yield e;
  }
}

// ---------------------------------------------------------------- adapter

export const copilotCliAdapter: Adapter = {
  id: ID,
  displayName: "GitHub Copilot CLI",
  tier: "A",
  // 2 (0.1.2): hook and transcript copies share ids; no duplicate initial prompt; one llm.call per usage record.
  // 3 (0.1.5): hook events keep the OTel trace from the hook's traceparent (traceId, parentSpanId). A tool call that loads a skill names it (payload.skill).
  parseVersion: 3,
  async detect(): Promise<DetectResult> {
    const binary = findBinary(["copilot"]);
    const dir = copilotHome();
    let hooked = false;
    try {
      const path = copilotHookPath({ scope: "user" });
      const { text, value } = readJsonObject(path);
      hooked = ownsInstall(path, text) || isOurFile(value);
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
    r.notes = ["Token totals are written at session shutdown; run `coding.sh ingest --backfill --agent copilot-cli` for usage.", "Repo hooks (.github/hooks) load in -p mode only for trusted folders."];
    return r;
  },
  async install(opts: InstallOpts): Promise<FileChange[]> {
    const path = copilotHookPath(opts);
    const { text, value } = readJsonObject(path);
    // The file format has no ownership marker: a file is ours when installs.json
    // records it with matching content, or (older installs) when every hook in it
    // is a coding.sh hook.
    if (text !== undefined && !ownsInstall(path, text) && !isOurFile(value)) throw new Error(`${path} exists and holds hooks not written by coding.sh; refusing to overwrite it`);
    const after = toJson(copilotHookFile(opts.hookCommand));
    const changes = applyWrites(ID, [{ path, before: text, after, summary: `${text ? "update" : "add"} coding.sh hook file (${COPILOT_HOOK_EVENTS.join(", ")})` }], opts.dryRun);
    if (!opts.dryRun && !ownsInstall(path, after)) recordInstall(ID, path, after);
    return changes;
  },
  async uninstall(opts): Promise<FileChange[]> {
    const path = copilotHookPath(opts);
    const { text, value } = readJsonObject(path);
    // A file the user edited to add their own hooks is theirs now: leave it.
    if (text === undefined || !(ownsInstall(path, text) || isOurFile(value))) return [];
    const changes = applyWrites(ID, [{ path, before: text, after: undefined, summary: "remove the coding.sh hook file" }], opts.dryRun);
    if (!opts.dryRun) forgetInstall(path);
    return changes;
  },
  normalize: normalizeCopilot,
  async *backfill(ctx: NormalizeContext, opts?: { since?: number }): AsyncIterable<AgentEvent> {
    const dir = join(copilotHome(), "session-state");
    for (const f of walkFiles(dir, (n) => n.endsWith(".jsonl"), 1)) {
      if (opts?.since !== undefined && mtimeMs(f) < opts.since) continue;
      yield* copilotSessionEvents(f, ctx, opts?.since);
    }
  },
  async run(spec: RunSpec): Promise<AgentRunOutput> {
    const bin = findBinary(["copilot"], { ...process.env, ...spec.env }) ?? "copilot";
    const sid = spec.flags.find((f, i, a) => a[i - 1] === "--session-id") ?? (spec.flags.find((f) => f.startsWith("--session-id="))?.slice(13) || undefined);
    const sessionId = sid ?? randomUUID();
    const args = ["-p", spec.instruction, "--output-format=json"];
    if (!hasFlag(spec.flags, "--allow-all", "--allow-all-tools", "--yolo")) args.push("--allow-all");
    if (!hasFlag(spec.flags, "--no-ask-user")) args.push("--no-ask-user");
    if (!sid) args.push("--session-id", sessionId);
    if (spec.model && !hasFlag(spec.flags, "--model")) args.push(`--model=${spec.model}`);
    args.push(...spec.flags);
    let streamed: Usage | undefined;
    let shutdown: Usage | undefined;
    const onLine = jsonLines((o) => {
      const d = isObj(o.data) ? o.data : o;
      if (o.type === "assistant.usage") streamed = addUsage(streamed, usageFrom({ inputTokens: d.inputTokens, outputTokens: d.outputTokens, cacheReadTokens: d.cacheReadTokens, cacheWriteTokens: d.cacheWriteTokens, costUsd: d.cost }));
      if (o.type === "session.shutdown") shutdown = metricsUsage(d.modelMetrics).usage ?? shutdown;
    });
    const r = await spawnAgent({ bin, args, cwd: spec.cwd, stdoutFile: spec.stdoutFile, env: runEnv(spec), timeoutMs: spec.timeoutMs, onLine });
    return toRunOutput(r, sessionId, shutdown ?? streamed);
  },
  harnessFiles() {
    return {
      project: [".github/copilot-instructions.md", ".github/instructions/**", ".github/agents/**", ".github/skills/**", ".github/hooks/**", ".github/copilot/settings.json", "AGENTS.md", "CLAUDE.md", "GEMINI.md", ".claude/rules/**", ".agents/skills/**"],
      user: ["~/.copilot/copilot-instructions.md", "~/.copilot/instructions/**", "~/.copilot/agents/**", "~/.copilot/skills/**", "~/.copilot/hooks/**", "~/.copilot/mcp-config.json", "~/.copilot/settings.json", "~/.agents/skills/**"],
    };
  },
  async overlay(_bundle: HarnessBundle, runDir: string) {
    const h = overlayHome(runDir);
    // config.json carries the logged-in account; tokens themselves live in the OS keychain.
    copyAuth([".copilot/config.json"], h);
    return { env: { COPILOT_HOME: join(h, ".copilot") }, flags: [] };
  },
};
