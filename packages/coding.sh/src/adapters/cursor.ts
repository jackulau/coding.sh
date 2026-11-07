// Cursor CLI adapter (tier B: hooks are partial in -p mode, transcripts are
// undocumented). Config: ~/.cursor/hooks.json or <project>/.cursor/hooks.json
//   { "version": 1, "hooks": { "<event>": [{ "command": "…" }] } }
//
// Safety rules (cursor.com/docs/agent/hooks, verified 2026-11-06):
// - Permission events (preToolUse, subagentStart, beforeShellExecution,
//   beforeMCPExecution, beforeReadFile) BLOCK the action on empty/invalid
//   stdout, and an "allow" reply could pre-empt the user's own approval. We
//   register none of them: postToolUse/Failure carry tool_input + duration, so
//   tool.start is reconstructed from them, and subagentStop carries
//   duration_ms for subagent.start.
// - beforeSubmitPrompt requires {"continue":true}: registered with
//   hook.mjs --echo-continue.
// - hook.mjs also takes `--reply '<json>'` to print a fixed reply. Cursor
//   entries never use it for permission replies ({"permission":"allow"} or
//   similar): coding.sh observes and must never approve an action on the
//   user's behalf. Should a future event need an acknowledgement other than
//   {"continue":true}, pass it with --reply (it prints even when capture
//   fails, like --echo-continue), never an allow decision.
// - Cursor also runs Claude Code hooks from .claude/settings*.json
//   ("third-party hooks"); claude-code.ts drops those payloads (they carry
//   cursor_version/workspace_roots), so each Cursor event is captured once.
// - Unknown keys in hooks.json entries are undocumented, so no `_codingsh`
//   marker: our entries are recognized by their command.
// - In -p mode beforeSubmitPrompt, afterAgentResponse and stop do not fire.
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { paths, userHome } from "../core/paths.ts";
import type { Adapter, AgentRunOutput, HarnessBundle, InstallOpts, NormalizeContext, RunSpec, SpoolLine } from "../core/types.ts";
import type { AgentEvent } from "../schema/index.ts";
import {
  Emitter,
  applyChanges,
  applyHookInstall,
  applyHookUninstall,
  arr,
  blobList,
  clipText,
  clipValue,
  copyIfExists,
  detectAgent,
  editStats,
  fileChangesOf,
  hasFlag,
  hasOurHooks,
  isObj,
  isolatedHome,
  lineRaw,
  num,
  obj,
  outputText,
  parentLink,
  parseTestOutput,
  planFlatInstall,
  planFlatUninstall,
  readJsonl,
  runEnv,
  runHeadless,
  shellCommandOf,
  str,
  walkFiles,
  which,
  lineKey,
  type HookEventSpec,
  commandArgsEntry,
  mcpInstaller,
} from "./_shared/index.ts";
import { isWrapperLine, normalizeWrapperLine } from "./more/wrapper.ts";

export const CURSOR_AGENT = "cursor";

export const CURSOR_HOOK_EVENTS: HookEventSpec[] = [
  { event: "sessionStart" },
  { event: "sessionEnd" },
  { event: "beforeSubmitPrompt", extraArgs: ["--echo-continue"] },
  { event: "postToolUse" },
  { event: "postToolUseFailure" },
  { event: "afterFileEdit" },
  { event: "afterAgentResponse" },
  { event: "stop" },
  { event: "preCompact" },
  { event: "subagentStop" },
];

const EMPTY_SHAPE = { version: 1 };

export function cursorConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CURSOR_CONFIG_DIR || join(userHome(env), ".cursor");
}

function hooksFile(opts: { scope: "user" | "project"; projectDir?: string }): string {
  if (opts.scope === "user") return join(cursorConfigDir(), "hooks.json");
  if (!opts.projectDir) throw new Error("cursor: project scope needs projectDir");
  return join(opts.projectDir, ".cursor", "hooks.json");
}

/** Cursor CLI versions are dates (2026.08.11-abc123); hooks shipped in the CLI in 2026.01. */
export function cursorVersionHasHooks(v: string | undefined): boolean | undefined {
  const m = v ? /^(\d{4})\.(\d{1,2})\.(\d{1,2})/.exec(v) : null;
  if (!m) return undefined;
  return Number(m[1]) * 100 + Number(m[2]) >= 202601;
}

// ---------------------------------------------------------------- normalize

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

export async function normalizeCursorLine(line: SpoolLine, ctx: NormalizeContext): Promise<AgentEvent[]> {
  // `coding.sh run --agent <id> -- …` spools its session.start/file.change/session.end under this agent id.
  if (isWrapperLine(line)) return normalizeWrapperLine(line, ctx);
  const raw = obj(lineRaw(line));
  const event = str(raw.hook_event_name) ?? line.event;
  const sessionId = str(raw.conversation_id) ?? str(raw.session_id) ?? `ppid-${line.ppid ?? line.pid}`;
  const cwd = str(raw.cwd) ?? str(arr(raw.workspace_roots)[0]) ?? line.cwd;
  const em = new Emitter(ctx, { agent: CURSOR_AGENT, sessionId, ts: line.ts, cwd, model: str(raw.model), agentVersion: str(raw.cursor_version), runId: line.runId }, ["hook", ...lineKey(line, ctx), event]);
  const gen = str(raw.generation_id);

  switch (event) {
    case "sessionStart":
      em.emit("session.start", { source: "hook", background: raw.is_background_agent === true || undefined, mode: str(raw.composer_mode) });
      break;
    case "sessionEnd": {
      const d = num(raw.duration_ms);
      em.emit("session.end", { reason: str(raw.reason), status: str(raw.final_status), error: str(raw.error_message)?.slice(0, 500) }, { durationMs: d });
      break;
    }
    case "beforeSubmitPrompt": {
      const t = await clipText(ctx, str(raw.prompt) ?? "");
      em.emit("user.message", { text: t.value, truncated: t.truncated || undefined, attachments: arr(raw.attachments).length || undefined, generationId: gen }, { blobs: blobList(t.blob) });
      break;
    }
    case "postToolUse":
    case "postToolUseFailure": {
      const ok = event === "postToolUse";
      const tool = str(raw.tool_name) ?? "unknown";
      const toolUseId = str(raw.tool_use_id) ?? ctx.id(sessionId, "tool", ...lineKey(line, ctx));
      const durationMs = num(raw.duration) ?? num(raw.duration_ms);
      const startTs = durationMs !== undefined ? line.ts - durationMs : line.ts;
      const inp = await clipValue(ctx, raw.tool_input);
      const server = tool.startsWith("MCP:") ? tool.slice(4) : str(raw.mcp_server_name);
      em.emit("tool.start", { tool, toolUseId, input: inp.value, server, reconstructed: true }, { key: [toolUseId], ts: startTs, blobs: blobList(inp.blob) });
      const output = ok ? parseMaybeJson(raw.tool_output) : (raw.error_message ?? raw.error);
      const text = outputText(output) ?? "";
      const o = await clipText(ctx, text);
      em.emit("tool.end", { tool, toolUseId, ok, durationMs, output: o.value, failureType: str(raw.failure_type), interrupted: raw.is_interrupt === true || undefined }, { key: [toolUseId], durationMs, blobs: blobList(o.blob) });
      // File edits come from afterFileEdit (exact edits); only deletes are inferred from the tool.
      if (ok) {
        for (const c of fileChangesOf(tool, raw.tool_input, output, cwd).filter((c) => c.op === "delete")) {
          em.emit("file.change", { path: c.path, op: c.op, tool, toolUseId }, { key: [toolUseId, c.path] });
        }
      }
      const cmd = shellCommandOf(tool, raw.tool_input);
      const s = cmd !== undefined ? parseTestOutput(text, cmd) : undefined;
      if (s) em.emit("test.result", { runner: s.runner, passed: s.passed, failed: s.failed, skipped: s.skipped, toolUseId }, { key: [toolUseId] });
      break;
    }
    case "afterFileEdit": {
      const path = str(raw.file_path);
      if (!path) break;
      let additions = 0;
      let deletions = 0;
      let allNew = arr(raw.edits).length > 0;
      for (const e of arr(raw.edits)) {
        const o = str(obj(e).old_string) ?? "";
        const s = editStats(o, str(obj(e).new_string) ?? "");
        additions += s.additions;
        deletions += s.deletions;
        if (o !== "") allNew = false;
      }
      const rel = fileChangesOf("edit", { file_path: path, old_string: "", new_string: "" }, undefined, cwd)[0]?.path ?? path;
      em.emit("file.change", { path: rel, op: allNew ? "add" : "modify", additions, deletions, generationId: gen });
      break;
    }
    case "afterAgentResponse": {
      const t = await clipText(ctx, str(raw.text) ?? "");
      em.emit("assistant.message", { text: t.value, truncated: t.truncated || undefined, generationId: gen }, { blobs: blobList(t.blob) });
      break;
    }
    case "stop":
      em.emit("turn.end", { ok: raw.status === undefined || raw.status === "completed", status: str(raw.status), loopCount: num(raw.loop_count), generationId: gen });
      break;
    case "preCompact":
      em.emit("context.compact", { trigger: str(raw.trigger) ?? "auto", tokensBefore: num(raw.context_tokens), contextWindow: num(raw.context_window_size), usagePercent: num(raw.context_usage_percent) });
      break;
    case "subagentStop": {
      const tp = str(raw.agent_transcript_path);
      const subagentId = str(raw.subagent_id) ?? (tp ? basename(tp, extname(tp)) : ctx.id(sessionId, "subagent", ...lineKey(line, ctx)));
      // Cursor subagents run as their own conversation; the transcript basename is that conversation's id.
      const child = tp ? basename(tp, extname(tp)) : `${sessionId}:sub:${subagentId}`;
      const d = num(raw.duration_ms);
      const startTs = d !== undefined ? line.ts - d : line.ts;
      const type = str(raw.subagent_type);
      const task = str(raw.task) ? await clipText(ctx, raw.task as string, 1024) : undefined;
      const summary = str(raw.summary) ? await clipText(ctx, raw.summary as string, 1024) : undefined;
      em.emit("subagent.start", { subagentId, type, description: str(raw.description)?.slice(0, 500), prompt: task?.value, childSessionId: child }, { key: [subagentId], ts: startTs, blobs: blobList(task?.blob) });
      em.emit("session.start", { source: "subagent", ...parentLink(ctx, CURSOR_AGENT, sessionId, subagentId, type) }, { sessionId: child, subagentId, key: ["start"], ts: startTs });
      em.emit(
        "subagent.end",
        { subagentId, type, ok: raw.status === undefined || raw.status === "completed", status: str(raw.status), result: summary?.value, childSessionId: child, toolCalls: num(raw.tool_call_count), messages: num(raw.message_count), modifiedFiles: arr(raw.modified_files).length || undefined },
        { key: [subagentId], durationMs: d, blobs: blobList(summary?.blob) },
      );
      em.emit("session.end", { reason: "subagent-stop" }, { sessionId: child, subagentId, key: ["end"], durationMs: d });
      break;
    }
    default:
      em.emit("notification", { hookEvent: event });
  }
  await em.attachRaw(lineRaw(line));
  return em.events;
}

// ---------------------------------------------------------------- backfill

/**
 * Best-effort import of ~/.cursor/projects/<sanitized>/agent-transcripts/
 * (<id>.jsonl or <id>/<id>.jsonl). The format is undocumented and carries no
 * timestamps: lines are {role, message:{content:[{type,text}]}}; event times
 * are the file's birth time + line number (ms), so order is preserved.
 */
async function* backfillCursor(ctx: NormalizeContext, opts: { since?: number } = {}): AsyncIterable<AgentEvent> {
  const root = join(process.env.CURSOR_DATA_DIR || cursorConfigDir(), "projects");
  for await (const f of walkFiles(root, { match: (n, p) => n.endsWith(".jsonl") && /[\\/]agent-transcripts[\\/]/.test(p), maxDepth: 4, since: opts.since })) {
    const sessionId = basename(f.path, ".jsonl");
    let born = f.mtimeMs;
    try {
      const st = await stat(f.path);
      born = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
    } catch {
      // keep mtime
    }
    born = Math.floor(born);
    const out: AgentEvent[] = [];
    let first = true;
    for await (const r of readJsonl(f.path)) {
      const e = obj(r.value);
      const ts = born + r.lineNo;
      const em = new Emitter(ctx, { agent: CURSOR_AGENT, sessionId, ts }, ["transcript", basename(f.path), r.lineNo]);
      if (first) {
        em.emit("session.start", { source: "transcript" }, { key: ["start"] });
        first = false;
      }
      const role = str(e.role) ?? str(obj(e.message).role);
      const content = obj(e.message).content ?? e.content;
      const blocks = typeof content === "string" ? [{ type: "text", text: content }] : arr(content);
      let bi = 0;
      for (const b of blocks) {
        const i = bi++;
        if (!isObj(b)) continue;
        if (b.type === "text" && str(b.text) && (role === "user" || role === "assistant")) {
          const t = await clipText(ctx, b.text as string);
          em.emit(role === "user" ? "user.message" : "assistant.message", { text: t.value, truncated: t.truncated || undefined }, { blobs: blobList(t.blob), key: [r.lineNo, i] });
        } else if (b.type === "tool_use" || b.type === "tool_call") {
          const id = str(b.id) ?? str(b.call_id) ?? `${r.lineNo}:${i}`;
          const inp = await clipValue(ctx, b.input ?? b.args);
          em.emit("tool.start", { tool: str(b.name) ?? "unknown", toolUseId: id, input: inp.value }, { key: [id], blobs: blobList(inp.blob) });
        } else if (b.type === "tool_result") {
          const id = str(b.tool_use_id) ?? `${r.lineNo}:${i}`;
          const o = await clipText(ctx, outputText(b.content) ?? "");
          em.emit("tool.end", { tool: "unknown", toolUseId: id, ok: b.is_error !== true, output: o.value }, { key: [id], blobs: blobList(o.blob) });
        }
      }
      out.push(...em.events);
    }
    for (const e of out) if (opts.since === undefined || e.ts >= opts.since) yield e;
  }
}

// ---------------------------------------------------------------- run

const helpCache = new Map<string, Promise<string>>();

function helpText(bin: string): Promise<string> {
  let p = helpCache.get(bin);
  if (!p) {
    p = new Promise((resolve) => {
      try {
        execFile(bin, ["--help"], { timeout: 5000, maxBuffer: 1 << 20 }, (_e, out, err) => resolve(`${out ?? ""}\n${err ?? ""}`));
      } catch {
        resolve("");
      }
    });
    helpCache.set(bin, p);
  }
  return p;
}

export function cursorBinary(env: NodeJS.ProcessEnv = process.env): string | undefined {
  // `agent` is a generic name (other tools install it too); prefer cursor-agent.
  return which("cursor-agent", env) ?? which("agent", env);
}

export async function runCursor(spec: RunSpec): Promise<AgentRunOutput> {
  const env = runEnv(spec);
  const bin = cursorBinary(env as NodeJS.ProcessEnv) ?? "cursor-agent";
  const help = await helpText(bin);
  const supports = (f: string) => help.includes(f);
  const args = ["-p", "--output-format", "stream-json"];
  if (!hasFlag(spec.flags, "--force", "-f", "--yolo")) args.push("--force");
  if (supports("--trust") && !hasFlag(spec.flags, "--trust")) args.push("--trust");
  if (supports("--approve-mcps") && !hasFlag(spec.flags, "--approve-mcps")) args.push("--approve-mcps");
  if (supports("--workspace") && !hasFlag(spec.flags, "--workspace")) args.push("--workspace", spec.cwd);
  if (spec.model && !hasFlag(spec.flags, "--model", "-m")) args.push("--model", spec.model);
  args.push(...spec.flags, spec.instruction);
  let sessionId: string | undefined;
  const res = await runHeadless({
    bin,
    args,
    cwd: spec.cwd,
    env,
    timeoutMs: spec.timeoutMs,
    onJson: (v) => {
      sessionId = str(obj(v).session_id) ?? sessionId;
    },
  });
  // Cursor's stream-json carries no token usage.
  return sessionId ? { ...res, sessionId } : { ...res };
}

// ---------------------------------------------------------------- overlay

/** Isolated CURSOR_CONFIG_DIR (hooks.json + copied cli-config.json for auth). */
export async function overlayCursor(_bundle: HarnessBundle, runDir: string): Promise<{ env: Record<string, string>; flags: string[] }> {
  const dir = join(isolatedHome(runDir), ".cursor");
  await applyChanges([planFlatInstall({ agent: CURSOR_AGENT, file: join(dir, "hooks.json"), hookCommand: paths().hook, events: CURSOR_HOOK_EVENTS, marker: false, ensure: EMPTY_SHAPE })], {
    agent: CURSOR_AGENT,
    dryRun: false,
    noBackup: true,
  });
  await copyIfExists(join(cursorConfigDir(), "cli-config.json"), join(dir, "cli-config.json"));
  return { env: { CURSOR_CONFIG_DIR: dir }, flags: [] };
}

// ---------------------------------------------------------------- adapter

export const cursor: Adapter = {
  id: CURSOR_AGENT,
  displayName: "Cursor CLI",
  tier: "B",

  async detect() {
    const dir = cursorConfigDir();
    const r = await detectAgent({
      bins: ["cursor-agent", "agent"],
      configDir: dir,
      // "agent" is generic: require Cursor's date-style version. "cursor-agent"
      // is unambiguous, so a probe that timed out still counts.
      versionCheck: (v, bin) => (v ? /^\d{4}\.\d{1,2}\.\d{1,2}/.test(v) : bin === "cursor-agent"),
      hooked: () => hasOurHooks(CURSOR_AGENT, join(dir, "hooks.json")),
    });
    const notes = [...(r.notes ?? [])];
    if (r.installed && cursorVersionHasHooks(r.version) === false) notes.push(`cursor-agent ${r.version} predates CLI hooks; run \`cursor-agent update\` (hooks need 2026.01+)`);
    if (r.installed) notes.push("cursor-agent -p does not fire beforeSubmitPrompt/afterAgentResponse/stop; prompts and final text are missing from headless runs");
    return notes.length ? { ...r, notes } : r;
  },

  async install(opts: InstallOpts) {
    const change = planFlatInstall({ agent: CURSOR_AGENT, file: hooksFile(opts), hookCommand: opts.hookCommand, events: CURSOR_HOOK_EVENTS, marker: false, ensure: EMPTY_SHAPE });
    return applyHookInstall([change], { agent: CURSOR_AGENT, dryRun: opts.dryRun });
  },

  async uninstall(opts) {
    return applyHookUninstall([planFlatUninstall(CURSOR_AGENT, hooksFile(opts), EMPTY_SHAPE)], { agent: CURSOR_AGENT, dryRun: opts.dryRun });
  },

  // ~/.cursor/mcp.json: read by the Cursor editor and cursor-agent alike.
  ...mcpInstaller((env) => ({ agent: CURSOR_AGENT, file: join(cursorConfigDir(env), "mcp.json"), format: "json", key: "mcpServers", entry: commandArgsEntry })),

  normalize: normalizeCursorLine,
  backfill: backfillCursor,
  run: runCursor,
  overlay: overlayCursor,

  harnessFiles() {
    return {
      project: ["AGENTS.md", "CLAUDE.md", ".cursorrules", ".cursor/rules/**", ".cursor/mcp.json", ".cursor/hooks.json", ".cursor/commands/**", ".cursor/agents/**", ".cursor/skills/**", ".cursor/cli.json"],
      user: ["~/.cursor/rules/**", "~/.cursor/mcp.json", "~/.cursor/hooks.json", "~/.cursor/commands/**", "~/.cursor/agents/**", "~/.cursor/skills/**"],
    };
  },
};

