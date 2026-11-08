// Claude Code adapter (tier A): settings.json hooks, transcript backfill,
// `claude -p --output-format stream-json` headless runs, CLAUDE_CONFIG_DIR
// isolation. See docs/ADAPTERS.md.
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { createInterface } from "node:readline";
import { paths, userHome } from "../core/paths.ts";
import type { Adapter, AgentRunOutput, BackfillOpts, HarnessBundle, InstallOpts, NormalizeContext, RunSpec, SpoolLine } from "../core/types.ts";
import type { AgentEvent, Usage } from "../schema/index.ts";
import {
  ClaudeTranscriptConverter,
  Emitter,
  cursorView,
  anthropicUsage,
  arr,
  applyChanges,
  applyHookInstall,
  applyHookUninstall,
  blobList,
  childSessionId,
  clipText,
  clipValue,
  copyIfExists,
  detectAgent,
  emitDerived,
  hasFlag,
  hasOurHooks,
  isObj,
  isolatedHome,
  lineRaw,
  mcpServer,
  parentLink,
  num,
  obj,
  outputText,
  planNestedInstall,
  planNestedUninstall,
  promptText,
  readJsonl,
  readJsonlTail,
  runEnv,
  runHeadless,
  str,
  toMs,
  walkFiles,
  which,
  lineKey,
  type HookEventSpec,
  mcpInstaller,
} from "./_shared/index.ts";
import { isWrapperLine, normalizeWrapperLine } from "./more/wrapper.ts";
import { pluginDirIn } from "../runner/plugins.ts";
import { pluginHookCommands } from "./_shared/claude-plugins.ts";

export const CLAUDE_AGENT = "claude-code";

/** Hook events we register. Tool events use matcher "*"; Task matchers are dead upstream (use Agent). */
export const CLAUDE_HOOK_EVENTS: HookEventSpec[] = [
  { event: "SessionStart", timeout: 10 },
  { event: "UserPromptSubmit", timeout: 10 },
  { event: "PreToolUse", matcher: "*", timeout: 10 },
  { event: "PostToolUse", matcher: "*", timeout: 10 },
  { event: "PostToolUseFailure", matcher: "*", timeout: 10 },
  { event: "Stop", timeout: 10 },
  { event: "StopFailure", timeout: 10 },
  { event: "SubagentStart", timeout: 10 },
  { event: "SubagentStop", timeout: 10 },
  { event: "PreCompact", timeout: 10 },
  { event: "SessionEnd", timeout: 5 },
  { event: "Notification", timeout: 10 },
];

/** $CLAUDE_CONFIG_DIR or ~/.claude. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(userHome(env), ".claude");
}

/** ~/.claude.json (or $CLAUDE_CONFIG_DIR/.claude.json): user state, including user-scope MCP servers. */
export function claudeUserJson(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, ".claude.json") : join(userHome(env), ".claude.json");
}

function settingsFiles(opts: { scope: "user" | "project"; projectDir?: string }, env = process.env): string[] {
  if (opts.scope === "user") return [join(claudeConfigDir(env), "settings.json")];
  if (!opts.projectDir) throw new Error("claude-code: project scope needs projectDir");
  // settings.local.json is git-ignored by Claude Code, so teammates without coding.sh are unaffected.
  return [join(opts.projectDir, ".claude", "settings.local.json"), join(opts.projectDir, ".claude", "settings.json")];
}

/**
 * Cursor (and Codex, which also reads Claude settings files) can execute Claude
 * Code hooks from .claude/settings.json ("third-party hooks"). Those payloads
 * carry the host agent's fields (Cursor: cursor_version/workspace_roots/
 * conversation_id; Codex: turn_id, which Claude Code never sends); that agent's
 * own adapter captures the same events natively, so drop them here.
 */
export function isForeignClaudePayload(raw: Record<string, unknown>): boolean {
  return raw.cursor_version !== undefined || (raw.conversation_id !== undefined && raw.generation_id !== undefined) || Array.isArray(raw.workspace_roots) || typeof raw.turn_id === "string";
}

// ---------------------------------------------------------------- normalize

const TRANSCRIPT_TAIL_BYTES = 8 * 1024 * 1024;
const FLUSH_SLACK_MS = 2_000;

/**
 * Transcript window for a Stop at `untilTs`: entries from the last real
 * prompt up to untilTs (+slack, transcripts are flushed around Stop).
 */
async function transcriptWindow(path: string, untilTs: number, whole = false): Promise<unknown[]> {
  const entries = (await readJsonlTail(path, TRANSCRIPT_TAIL_BYTES)).filter((e) => {
    const ts = isObj(e) ? toMs(e.timestamp, 0) : 0;
    return ts === 0 || ts <= untilTs + FLUSH_SLACK_MS;
  });
  if (whole) return entries;
  let start = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (isObj(e) && promptText(e) !== undefined) {
      start = i;
      break;
    }
  }
  // Hook output written before the prompt (SessionStart's, on the first turn or
  // after a compaction) reaches no Stop window otherwise: since the previous prompt.
  let prev = start - 1;
  while (prev > 0 && !(isObj(entries[prev]) && promptText(entries[prev] as Record<string, unknown>) !== undefined)) prev--;
  const hooks = entries.slice(Math.max(prev, 0), start).filter((e) => isObj(e) && e.type === "attachment" && /^hook_/.test(str(obj(e.attachment).type) ?? ""));
  return [...hooks, ...entries.slice(start)];
}

/** The plugins' hook commands under the config dir a transcript lives in (<dir>/projects/<slug>/…). */
function pluginHooksFor(transcript: string): ReadonlyMap<string, string> {
  let dir = dirname(transcript);
  while (basename(dir) !== "projects" && dirname(dir) !== dir) dir = dirname(dir);
  return pluginHookCommands(basename(dir) === "projects" ? dirname(dir) : dirname(dirname(transcript)));
}

async function windowEvents(ctx: NormalizeContext, path: string | undefined, untilTs: number, sessionId: string, subagentId: string | undefined, runId: string | undefined, whole: boolean): Promise<{ events: AgentEvent[]; model?: string; turnId?: string }> {
  if (!path) return { events: [] };
  let entries: unknown[];
  try {
    entries = await transcriptWindow(path, untilTs, whole);
  } catch {
    return { events: [] };
  }
  // A subagent's prompt reaches no hook: its window records it (same id as the backfill's).
  const conv = new ClaudeTranscriptConverter(ctx, { agent: CLAUDE_AGENT, mode: "assistant", sessionId, subagentId, runId, source: basename(path), sidechain: subagentId !== undefined, prompts: subagentId !== undefined, pluginHooks: pluginHooksFor(path) });
  let i = 0;
  for (const e of entries) await conv.add(e, i++);
  return { events: await conv.finish(), model: conv.model, turnId: conv.currentTurnId };
}

/**
 * The subagent an Agent (or Task) call ran, from the parent's PostToolUse. Some
 * agents (web-fetch) fire no SubagentStart or SubagentStop, so this is the only
 * record that links them to the parent. Every event uses the key the
 * SubagentStart/Stop path uses, so a hooked agent is stored once. Returns the
 * child transcript's events; the rest go to `em`.
 */
async function subagentFromResult(ctx: NormalizeContext, em: Emitter, raw: Record<string, unknown>, line: SpoolLine, parentSid: string, toolUseId: string, ok: boolean): Promise<AgentEvent[]> {
  const res = obj(raw.tool_response);
  const agentId = str(res.agentId);
  if (!agentId) return [];
  const input = obj(raw.tool_input);
  const child = childSessionId(parentSid, agentId);
  const type = str(res.agentType) ?? str(input.subagent_type);
  const description = str(input.description);
  const tp = str(raw.transcript_path);
  const w = await windowEvents(ctx, tp && join(dirname(tp), basename(tp, ".jsonl"), "subagents", `agent-${agentId}.jsonl`), line.ts, child, agentId, line.runId, true);
  const durationMs = num(res.totalDurationMs);
  const startTs = durationMs !== undefined ? line.ts - durationMs : (w.events[0]?.ts ?? line.ts);
  const parentId = em.ctx.id(em.base.agent, parentSid, "tool.start", toolUseId);
  const childBase = { sessionId: child, subagentId: agentId, ts: startTs };
  em.emit("subagent.start", { subagentId: agentId, type, description, childSessionId: child, toolUseId }, { key: [agentId], ts: startTs, parentId });
  em.emit("session.start", { source: "subagent", description, ...parentLink(ctx, em.base.agent, parentSid, agentId, type) }, { ...childBase, key: ["start"] });
  const prompt = str(input.prompt);
  if (prompt && !w.events.some((e) => e.kind === "user.message")) {
    const t = await clipText(ctx, prompt);
    em.emit("user.message", { text: t.value, truncated: t.truncated || undefined }, { ...childBase, key: ["prompt"], blobs: blobList(t.blob) });
  }
  // A background agent returns at once ("async_launched"): it ends later, on its own SubagentStop.
  const status = str(res.status);
  if (status === "async_launched" || status === "running") return w.events;
  const r = await clipText(ctx, outputText(res.content) ?? "", 1024);
  em.emit("subagent.end", { subagentId: agentId, type, ok: ok && (status === undefined || status === "completed"), childSessionId: child, result: r.value || undefined }, { key: [agentId], parentId, durationMs, blobs: blobList(r.blob) });
  em.emit("session.end", { reason: "subagent-stop" }, { sessionId: child, subagentId: agentId, key: ["end"], model: str(res.resolvedModel) ?? w.model });
  return w.events;
}

export async function normalizeClaudeLine(line: SpoolLine, ctx: NormalizeContext, agent = CLAUDE_AGENT): Promise<AgentEvent[]> {
  // `coding.sh run --agent <id> -- …` spools its session.start/file.change/session.end under this agent id.
  if (isWrapperLine(line)) return normalizeWrapperLine(line, ctx);
  const raw = obj(lineRaw(line));
  if (agent === CLAUDE_AGENT && isForeignClaudePayload(raw)) return [];
  const event = str(raw.hook_event_name) ?? line.event;
  const parentSid = str(raw.session_id) ?? `ppid-${line.ppid ?? line.pid}`;
  const subagentId = str(raw.agent_id);
  // Tool/prompt events fired inside a subagent belong to its child session.
  const inChild = subagentId !== undefined && event !== "SubagentStart" && event !== "SubagentStop";
  const sessionId = inChild ? childSessionId(parentSid, subagentId) : parentSid;
  const em = new Emitter(
    ctx,
    {
      agent,
      sessionId,
      ts: line.ts,
      cwd: str(raw.cwd) ?? line.cwd,
      model: str(raw.model) ?? str(obj(raw.model).id),
      runId: line.runId,
      subagentId: inChild ? subagentId : undefined,
    },
    ["hook", ...lineKey(line, ctx), event],
  );
  const tool = str(raw.tool_name) ?? "unknown";
  const toolUseId = str(raw.tool_use_id) ?? ctx.id(sessionId, "tool", ...lineKey(line, ctx));
  const extra: AgentEvent[] = [];

  switch (event) {
    case "SessionStart":
      // Same key as the transcript's session.start: a backfill of a hooked session adds no second start.
      // A `claude --resume` start keeps its own row: it marks where the session picked up again.
      em.emit("session.start", { source: str(raw.source), transcriptPath: str(raw.transcript_path), permissionMode: str(raw.permission_mode), entrypoint: line.entrypoint }, raw.source === "resume" ? {} : { key: ["start"] });
      break;
    case "UserPromptSubmit": {
      const t = await clipText(ctx, str(raw.prompt) ?? "");
      em.emit("user.message", { text: t.value, truncated: t.truncated || undefined }, { blobs: blobList(t.blob) });
      break;
    }
    case "PreToolUse": {
      const inp = await clipValue(ctx, raw.tool_input);
      em.emit("tool.start", { tool, toolUseId, input: inp.value, server: mcpServer(tool) }, { key: [toolUseId], blobs: blobList(inp.blob) });
      break;
    }
    case "PostToolUse":
    case "PostToolUseFailure": {
      const ok = event === "PostToolUse";
      const response = ok ? raw.tool_response : (raw.error ?? raw.tool_response);
      const text = outputText(response) ?? "";
      const o = await clipText(ctx, text);
      const durationMs = num(raw.duration_ms) ?? num(obj(raw.tool_response).durationMs);
      em.emit("tool.end", { tool, toolUseId, ok, durationMs, output: o.value, interrupted: raw.is_interrupt === true || undefined }, { key: [toolUseId], durationMs, blobs: blobList(o.blob) });
      await emitDerived(em, { tool, toolUseId, input: raw.tool_input, output: ok ? raw.tool_response : text, ok, cwd: str(raw.cwd) ?? line.cwd });
      if (!inChild && (tool === "Agent" || tool === "Task")) extra.push(...(await subagentFromResult(ctx, em, raw, line, parentSid, toolUseId, ok)));
      break;
    }
    case "Stop":
    case "StopFailure": {
      const w = await windowEvents(ctx, str(raw.transcript_path), line.ts, sessionId, undefined, line.runId, false);
      extra.push(...w.events);
      if (w.model) em.base.model ??= w.model;
      if (!w.events.some((e) => e.kind === "assistant.message") && str(raw.last_assistant_message)) {
        const t = await clipText(ctx, raw.last_assistant_message as string);
        em.emit("assistant.message", { text: t.value, truncated: t.truncated || undefined }, { blobs: blobList(t.blob) });
      }
      if (event === "StopFailure") em.emit("error", { message: (str(raw.error) ?? str(obj(raw.error).message) ?? "stop failure").slice(0, 1000), errorType: str(raw.error_type) });
      // Keyed by the turn the transcript window ends in (the transcript keys its turn.end the
      // same way), so a backfill of this session and a Stop-hook continuation
      // (stop_hook_active) add no second end for the turn. No transcript: keyed by spool position.
      em.emit("turn.end", { ok: event === "Stop", stopHookActive: raw.stop_hook_active === true || undefined }, w.turnId ? { key: [w.turnId, "end"], turnId: w.turnId } : {});
      break;
    }
    case "SubagentStart": {
      const id = subagentId ?? toolUseId;
      const child = childSessionId(parentSid, id);
      const type = str(raw.agent_type);
      const tp = str(raw.transcript_path);
      const description = tp && subagentId ? str((await subagentMeta(join(dirname(tp), basename(tp, ".jsonl"), "subagents", `agent-${subagentId}.jsonl`))).description) : undefined;
      em.emit("subagent.start", { subagentId: id, type, description, childSessionId: child }, { key: [id] });
      em.emit("session.start", { source: "subagent", description, ...parentLink(ctx, agent, parentSid, id, type) }, { sessionId: child, subagentId: id, key: ["start"] });
      break;
    }
    case "SubagentStop": {
      const id = subagentId ?? toolUseId;
      const child = childSessionId(parentSid, id);
      const w = await windowEvents(ctx, str(raw.agent_transcript_path), line.ts, child, id, line.runId, true);
      // Claude Code's internal forks (the compaction summarizer, prompt suggestions) fire a
      // SubagentStop with no agent type, no SubagentStart and no transcript on disk: no session.
      if (!str(raw.agent_type) && !w.events.length) return [];
      extra.push(...w.events);
      const r = str(raw.last_assistant_message) ? await clipText(ctx, raw.last_assistant_message as string, 1024) : undefined;
      em.emit("subagent.end", { subagentId: id, type: str(raw.agent_type), ok: true, childSessionId: child, result: r?.value }, { key: [id], blobs: blobList(r?.blob) });
      em.emit("session.end", { reason: "subagent-stop" }, { sessionId: child, subagentId: id, key: ["end"], model: w.model });
      break;
    }
    case "PreCompact":
      em.emit("context.compact", { trigger: str(raw.trigger) ?? "auto", customInstructions: str(raw.custom_instructions) ? true : undefined });
      break;
    case "SessionEnd":
      em.emit("session.end", { reason: str(raw.reason) });
      break;
    case "Notification":
      em.emit("notification", { text: str(raw.message)?.slice(0, 1000), type: str(raw.notification_type) });
      break;
    default:
      em.emit("notification", { hookEvent: event });
  }
  await em.attachRaw(lineRaw(line));
  return [...em.events, ...extra];
}

// ---------------------------------------------------------------- backfill

/** Subagent transcripts: <sid>/subagents/agent-<id>.jsonl, and Workflow-tool agents at <sid>/subagents/workflows/<wf>/agent-<id>.jsonl. */
const SUBAGENT_FILE = /[\\/]([^\\/]+)[\\/]subagents[\\/](?:workflows[\\/]([^\\/]+)[\\/])?agent-([^\\/]+)\.jsonl$/;

/** A backfilled session whose last entry is older than this is treated as finished (gets a session.end). */
export const TRANSCRIPT_IDLE_MS = 30 * 60_000;

async function* backfillClaude(base: NormalizeContext, opts: BackfillOpts = {}, env = process.env): AsyncIterable<AgentEvent> {
  const root = join(claudeConfigDir(env), "projects");
  const since = opts.since;
  const workflows = new WorkflowIndex();
  // A failed blob write is the store's fault (bad S3 secret, DB down), not a bad
  // transcript: it must abort the backfill (reported, cursors left unset) rather
  // than silently drop the file.
  let blobError: { err: unknown } | undefined;
  const ctx: NormalizeContext = {
    ...base,
    blob: async (data) => {
      try {
        return await base.blob(data);
      } catch (err) {
        blobError ??= { err };
        throw err;
      }
    },
  };
  for await (const f of walkFiles(root, { match: (n) => n.endsWith(".jsonl") && n !== "journal.jsonl", maxDepth: 5, since })) {
    const sub = SUBAGENT_FILE.exec(f.path);
    // Main transcripts sit directly in projects/<slug>/; any other .jsonl (workflow journals, …) is not a session.
    if (!sub && relative(root, f.path).split(/[\\/]/).length !== 2) continue;
    if (opts.changed && !(await opts.changed(cursorView(f, TRANSCRIPT_IDLE_MS)))) continue; // unchanged since the last backfill (or since it went idle)
    let events: AgentEvent[];
    try {
      events = sub ? await convertSubagentFile(ctx, f.path, sub[1]!, sub[3]!, sub[2] ? (firstTs) => workflows.link(f.path, sub[1]!, sub[2]!, sub[3]!, firstTs) : undefined) : await convertMainFile(ctx, f.path);
    } catch {
      if (blobError) throw blobError.err;
      continue; // unreadable transcript: skip, never abort the whole backfill
    }
    if (blobError) throw blobError.err; // in case a converter swallowed it
    for (const e of events) if (since === undefined || e.ts >= since) yield e;
  }
}

async function convertFile(path: string, conv: ClaudeTranscriptConverter): Promise<AgentEvent[]> {
  for await (const r of readJsonl(path)) await conv.add(r.value, r.lineNo);
  return conv.finish();
}

async function convertMainFile(ctx: NormalizeContext, path: string): Promise<AgentEvent[]> {
  const sessionId = basename(path, ".jsonl");
  return convertFile(path, new ClaudeTranscriptConverter(ctx, { agent: CLAUDE_AGENT, mode: "full", sessionId, source: basename(path), endIfIdleMs: TRANSCRIPT_IDLE_MS, pluginHooks: pluginHooksFor(path) }));
}

/** How a Workflow-tool subagent ties back to its parent session. */
interface SubagentLink {
  /** The parent's Workflow tool_use id that launched (or resumed) the run. */
  toolUseId?: string;
  workflowId: string;
  label?: string;
  phase?: string;
  /** The run's journal has this agent's result. */
  done?: boolean;
}

/**
 * Workflow runs, per backfill: the parent's Workflow tool calls (their result
 * names the run's transcript dir, …/subagents/workflows/<wf>) and the run's
 * journal.jsonl (agentId → label/phase). Each file is read once.
 */
class WorkflowIndex {
  private readonly calls = new Map<string, Promise<Map<string, { toolUseId: string; ts: number }[]>>>();
  private readonly journals = new Map<string, Promise<Map<string, { label?: string; phase?: string; done?: boolean }>>>();

  async link(agentPath: string, parentSid: string, workflowId: string, agentId: string, firstTs: number | undefined): Promise<SubagentLink> {
    const wfDir = dirname(agentPath);
    const parentFile = join(dirname(dirname(dirname(dirname(wfDir)))), `${parentSid}.jsonl`); // <slug>/<sid>/subagents/workflows/<wf>
    if (!this.calls.has(parentFile)) this.calls.set(parentFile, scanWorkflowCalls(parentFile));
    if (!this.journals.has(wfDir)) this.journals.set(wfDir, readWorkflowJournal(join(wfDir, "journal.jsonl")));
    const calls = (await this.calls.get(parentFile)!).get(workflowId) ?? [];
    const j = (await this.journals.get(wfDir)!).get(agentId);
    // A run can be resumed by later Workflow calls: take the last launch at or before the agent's first entry.
    const at = firstTs ?? Infinity;
    const call = calls.filter((c) => c.ts <= at + FLUSH_SLACK_MS).at(-1) ?? calls[0];
    return { workflowId, toolUseId: call?.toolUseId, label: j?.label, phase: j?.phase, done: j?.done };
  }
}

// `[\\/]+`: the cheap filter runs on raw JSON lines, where a Windows separator is `\\`.
const WORKFLOW_DIR_RE = /subagents[\\/]+workflows[\\/]+(wf_[^\s\\/"'`]+)/;

async function scanWorkflowCalls(parentFile: string): Promise<Map<string, { toolUseId: string; ts: number }[]>> {
  const out = new Map<string, { toolUseId: string; ts: number }[]>();
  try {
    for await (const line of readLines(parentFile)) {
      if (!line.includes("tool_result") || !WORKFLOW_DIR_RE.test(line)) continue; // cheap filter before JSON.parse
      let e: Record<string, unknown>;
      try {
        e = obj(JSON.parse(line));
      } catch {
        continue;
      }
      if (e.type !== "user") continue;
      for (const b of arr(obj(e.message).content)) {
        const id = str(obj(b).tool_use_id);
        const m = obj(b).type === "tool_result" && id ? WORKFLOW_DIR_RE.exec(outputText(obj(b).content) ?? "") : null;
        if (!m) continue;
        const list = out.get(m[1]!) ?? [];
        list.push({ toolUseId: id!, ts: toMs(e.timestamp, 0) });
        out.set(m[1]!, list);
      }
    }
  } catch {
    // parent transcript missing or unreadable: no links
  }
  return out;
}

async function readWorkflowJournal(path: string): Promise<Map<string, { label?: string; phase?: string; done?: boolean }>> {
  const out = new Map<string, { label?: string; phase?: string; done?: boolean }>();
  try {
    for await (const r of readJsonl(path)) {
      const o = obj(r.value);
      const id = str(o.agentId);
      if (!id) continue;
      if (o.type === "started") out.set(id, { ...out.get(id), label: str(o.label), phase: str(o.phase) });
      else if (o.type === "result") out.set(id, { ...out.get(id), done: true });
    }
  } catch {
    // no journal
  }
  return out;
}

async function* readLines(path: string): AsyncGenerator<string> {
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  try {
    for await (const line of rl) yield line;
  } finally {
    rl.close();
  }
}

/** The `.meta.json` sidecar of a subagent transcript (agentType, description, toolUseId, finished); {} when absent. */
async function subagentMeta(transcriptPath: string): Promise<Record<string, unknown>> {
  try {
    return obj(JSON.parse(await readFile(transcriptPath.replace(/\.jsonl$/, ".meta.json"), "utf8")));
  } catch {
    return {}; // older versions write no meta sidecar
  }
}

async function convertSubagentFile(ctx: NormalizeContext, path: string, parentSid: string, agentId: string, resolveLink?: (firstTs: number | undefined) => Promise<SubagentLink>): Promise<AgentEvent[]> {
  const child = childSessionId(parentSid, agentId);
  const meta = await subagentMeta(path);
  const type = str(meta.agentType);
  const conv = new ClaudeTranscriptConverter(ctx, { agent: CLAUDE_AGENT, mode: "full", sessionId: child, subagentId: agentId, source: basename(path), sidechain: true, pluginHooks: pluginHooksFor(path) });
  for await (const r of readJsonl(path)) await conv.add(r.value, r.lineNo);
  if (!conv.out.length) return conv.finish();
  const link = resolveLink ? await resolveLink(conv.out[0]!.ts) : undefined;
  // Finished per the meta sidecar; without that flag (Workflow agents, old versions), per the run journal or an idle transcript.
  const known = typeof meta.finished === "boolean" ? meta.finished : link?.done;
  const finished = known ?? Date.now() - conv.lastEntryTs > TRANSCRIPT_IDLE_MS;
  // A running subagent's open turn ends later, with its real end.
  const events = await conv.finish(finished);
  const first = events[0]!;
  const last = events[events.length - 1]!;
  const description = str(meta.description) ?? link?.label;
  const start = events.find((e) => e.kind === "session.start");
  if (start) start.payload = { ...start.payload, source: "subagent", description, ...parentLink(ctx, CLAUDE_AGENT, parentSid, agentId, type) };
  const toolUseId = link?.toolUseId ?? str(meta.toolUseId);
  const parentId = toolUseId ? ctx.id(CLAUDE_AGENT, parentSid, "tool.start", toolUseId) : undefined;
  const em = new Emitter(ctx, { agent: CLAUDE_AGENT, sessionId: parentSid, ts: first.ts, cwd: first.cwd, agentVersion: first.agentVersion }, ["subagent", agentId]);
  em.emit("subagent.start", { subagentId: agentId, type, description, childSessionId: child, toolUseId, workflowId: link?.workflowId, phase: str(meta.workflowPhase) ?? link?.phase }, { key: [agentId], parentId });
  if (finished) {
    const lastText = [...events].reverse().find((e) => e.kind === "assistant.message");
    em.emit("subagent.end", { subagentId: agentId, type, ok: true, childSessionId: child, result: typeof lastText?.payload.text === "string" ? (lastText.payload.text as string).slice(0, 1024) : undefined }, { key: [agentId], ts: last.ts, parentId, durationMs: last.ts - first.ts });
    // The child ends with its subagent.end (same key as the live SubagentStop's session.end, so
    // they dedupe). An end guessed from idleness is keyed by its time instead: if the
    // subagent turns out to be still running, its real end is not dropped as a duplicate.
    em.emit("session.end", { reason: known ? "subagent-stop" : "idle" }, { sessionId: child, subagentId: agentId, key: known ? ["end"] : ["idle", last.ts], ts: last.ts, cwd: last.cwd });
  }
  return [...events, ...em.events];
}

// ---------------------------------------------------------------- run

/**
 * `claude -p` argv for a run (exported for tests): a new session under a fresh
 * id, or with `resumeSessionId` that session continued (`--resume`), unless the
 * bundle's flags already pick the session.
 */
export function claudeRunArgs(spec: Pick<RunSpec, "model" | "flags" | "resumeSessionId">): { args: string[]; sessionId?: string } {
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  if (!hasFlag(spec.flags, "--permission-mode", "--dangerously-skip-permissions")) args.push("--permission-mode", "bypassPermissions");
  if (spec.model && !hasFlag(spec.flags, "--model")) args.push("--model", spec.model);
  let sessionId: string | undefined;
  if (!hasFlag(spec.flags, "--session-id", "--resume", "-r", "--continue", "-c")) {
    sessionId = spec.resumeSessionId ?? randomUUID();
    args.push(spec.resumeSessionId ? "--resume" : "--session-id", sessionId);
  }
  args.push(...spec.flags);
  return sessionId ? { args, sessionId } : { args };
}

export async function runClaude(spec: RunSpec): Promise<AgentRunOutput> {
  const bin = which("claude", { ...process.env, ...spec.env }) ?? "claude";
  const built = claudeRunArgs(spec);
  const args = built.args;
  let sessionId = built.sessionId;
  let usage: Usage | undefined;
  const res = await runHeadless({
    stdoutFile: spec.stdoutFile,
    bin,
    args,
    cwd: spec.cwd,
    env: runEnv(spec),
    timeoutMs: spec.timeoutMs,
    stdin: spec.instruction,
    onJson: (v) => {
      const o = obj(v);
      sessionId = str(o.session_id) ?? sessionId;
      if (o.type === "result") {
        usage = anthropicUsage(o.usage) ?? {};
        const cost = num(o.total_cost_usd);
        if (cost !== undefined) usage.costUsd = cost;
      }
    },
  });
  const out: AgentRunOutput = { ...res };
  if (sessionId) out.sessionId = sessionId;
  if (usage) out.usage = usage;
  return out;
}

// ---------------------------------------------------------------- overlay

/**
 * Isolated CLAUDE_CONFIG_DIR at <run>/home/.claude: holds the bundle's
 * "~/.claude/…" files (written by the runner) plus our hooks, so the run is
 * captured without reading or touching the user's ~/.claude. Credentials:
 * Linux/Windows keep them in .credentials.json (copied in); macOS keeps them
 * in the keychain, so isolated runs there need ANTHROPIC_API_KEY or
 * CLAUDE_CODE_OAUTH_TOKEN in the bundle/run env. The bundle's plugins were
 * written by the runner under the same isolated home; each is loaded for this
 * run only with `--plugin-dir`.
 */
export async function overlayClaude(bundle: HarnessBundle, runDir: string): Promise<{ env: Record<string, string>; flags: string[] }> {
  const home = isolatedHome(runDir);
  const configDir = join(home, ".claude");
  await applyChanges(
    [planNestedInstall({ agent: CLAUDE_AGENT, file: join(configDir, "settings.json"), hookCommand: paths().hook, events: CLAUDE_HOOK_EVENTS, marker: true })],
    { agent: CLAUDE_AGENT, dryRun: false, noBackup: true },
  );
  await copyIfExists(join(claudeConfigDir(), ".credentials.json"), join(configDir, ".credentials.json"));
  const flags = (bundle.plugins ?? []).flatMap((p) => ["--plugin-dir", pluginDirIn(home, p.name)]);
  return { env: { CLAUDE_CONFIG_DIR: configDir, DISABLE_AUTOUPDATER: "1" }, flags };
}

// ---------------------------------------------------------------- adapter

export const claudeCode: Adapter = {
  id: CLAUDE_AGENT,
  displayName: "Claude Code",
  tier: "A",
  // 2 (0.1.2): one session.end (idle end) and one compaction across hooks and backfill.
  // 3 (0.1.2): harness.loaded (nested CLAUDE.md, skills) and file.change from Bash edits.
  // 4 (0.1.2): subagent prompt and description (turn, title); no session for internal forks; hook-less subagents (web-fetch) linked from the parent's PostToolUse(Agent).
  // 5 (0.1.2): hook.context (text hooks added to the context, with its source and size).
  // 6 (0.1.2): session.start records how Claude Code was launched (entrypoint).
  // 7 (0.1.2): session.end keeps Claude Code's reported cost (cost-state) as reportedUsage.
  parseVersion: 7,

  detect() {
    const dir = claudeConfigDir();
    return detectAgent({
      bins: ["claude"],
      configDir: dir,
      hooked: () => hasOurHooks(CLAUDE_AGENT, join(dir, "settings.json")),
    });
  },

  async install(opts: InstallOpts) {
    const [file] = settingsFiles(opts);
    const change = planNestedInstall({ agent: CLAUDE_AGENT, file: file!, hookCommand: opts.hookCommand, events: CLAUDE_HOOK_EVENTS, marker: true });
    return applyHookInstall([change], { agent: CLAUDE_AGENT, dryRun: opts.dryRun });
  },

  async uninstall(opts) {
    const changes = settingsFiles(opts).map((f) => planNestedUninstall(CLAUDE_AGENT, f));
    return applyHookUninstall(changes, { agent: CLAUDE_AGENT, dryRun: opts.dryRun });
  },

  // User-scope MCP servers live in ~/.claude.json, the file `claude mcp add -s user` edits.
  ...mcpInstaller((env) => ({ agent: CLAUDE_AGENT, file: claudeUserJson(env), format: "json", key: "mcpServers", entry: (s) => ({ type: "stdio", command: s.command, args: s.args, env: {} }) })),

  normalize: (line, ctx) => normalizeClaudeLine(line, ctx),
  backfill: (ctx, opts) => backfillClaude(ctx, opts),
  run: runClaude,
  canResume: true,
  overlay: overlayClaude,

  harnessFiles() {
    return {
      project: [
        "CLAUDE.md",
        "CLAUDE.local.md",
        "**/CLAUDE.md",
        ".claude/CLAUDE.md",
        ".claude/settings.json",
        ".claude/settings.local.json",
        ".claude/agents/**",
        ".claude/commands/**",
        ".claude/skills/**",
        ".claude/hooks/**",
        ".claude/output-styles/**",
        ".claude/rules/**",
        ".mcp.json",
      ],
      user: [
        "~/.claude/CLAUDE.md",
        "~/.claude/settings.json",
        "~/.claude/agents/**",
        "~/.claude/commands/**",
        "~/.claude/skills/**",
        "~/.claude/output-styles/**",
        "~/.claude/rules/**",
        "~/.claude/hooks/**",
      ],
    };
  },
};
