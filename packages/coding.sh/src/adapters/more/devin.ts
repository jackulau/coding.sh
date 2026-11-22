// Devin CLI (`devin`, docs.devin.ai/cli), Cognition's terminal agent. Tier A: Claude-format hooks + `devin -p`.
//
// Facts marked (live) were seen on v3000.14.30821 under a throwaway home (scripts/e2e/devin-capture.mjs);
// the rest are from docs.devin.ai/cli (2026-11).
// - Hooks: the user config (devinConfigDir()/config.json, under "hooks") and, in the session's
//   folder and each parent up to the project root (live: the repository root, or the session's
//   folder outside a repository), .devin/hooks.v1.json (the event map itself),
//   .devin/config.json and .devin/config.local.json (git-ignored; under "hooks"). We install into
//   the user config or .devin/config.local.json. Devin also runs Claude Code's hooks
//   (read_config_from.claude, on by default); spool/devin.ts relabels or drops those calls.
// - Events: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, Stop,
//   PostCompaction, SessionEnd. Since v3000.11.92 also PreCompact and PostCompact around the same
//   compaction: we hook PostCompaction only. Before v3000.11.92 a hook file naming an event Devin
//   did not know lost all of its hooks, so we register only these.
// - Matcher: a regex on tool_name, for the tool events; "" matches every tool.
// - Every matching hook runs (live): with coding.sh hooks in the user config and a project file,
//   each event runs both, about 90 ms apart, with the same payload. firingKey gives both one id.
// - Payload (live): hook_event_name, session_id (a slug such as "brave-otter"), prompt_id (one per
//   prompt, absent before the first); SessionStart source, UserPromptSubmit prompt, SessionEnd
//   reason. No cwd, model or transcript_path; no tool_use_id on tool events (docs). PreToolUse
//   and PermissionRequest: tool_name, tool_input; PostToolUse adds tool_response {success,
//   output, error}; Stop: stop_hook_active, last_assistant_message; PostCompaction: summary.
// - Env (live): DEVIN_PROJECT_DIR (and CLAUDE_PROJECT_DIR), the project root, for every hook. A hook
//   from the user config runs in the session's folder, a project's hook in the project root.
// - Tools: read, write, edit, apply_patch, notebook_read, notebook_edit, grep, glob, exec (shell),
//   get_output, write_to_process, kill_shell, webfetch, ask_user_question, todo_write,
//   exit_plan_mode, skill, run_subagent, read_subagent, request_scope, mcp_* and mcp__<server>__<tool>.
// - Folders (live): DEVIN_CONFIG_HOME moves the config to $DEVIN_CONFIG_HOME/devin, and
//   DEVIN_SESSIONS_DIR the sessions (cli/sessions.db, SQLite: not read here). MCP servers
//   (v3000.3+): devinConfigDir()/mcp_config.json, {"mcpServers": {...}}.
// - Headless: `devin -p -- <prompt>`; `--permission-mode dangerous`, `--model`,
//   `--respect-workspace-trust false` (print mode fails in an untrusted folder without it),
//   `--export <path>` (the conversation in ATIF after each turn).
// - Login (live): without one, `devin -p` prints "How would you like to log in?" and waits for a
//   key, even with stdin closed. `devin auth status` names the login file: on Windows
//   %APPDATA%\devin\credentials.toml, which stays put when DEVIN_CONFIG_HOME moves the config.
// - OTel (live): service.name "devin-local", log scope ai.devin.local.events (session_start,
//   user_prompt, session_end), session.id equal to the hooks' session_id (otel/map.ts).
// - Process model: since v3000.13.4 sessions may run in a shared background process (`devin
//   daemon`); `devin acp` started none (live). config.json's process_model picks; Devin ignores
//   config keys it does not know (live), so eval runs set it on any version.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentAbortSignal } from "../../core/children.ts";
import { paths } from "../../core/paths.ts";
import type { Adapter, AgentRunOutput, DetectResult, FileChange, HarnessBundle, InstallOpts, NormalizeContext, RunSpec, SpoolLine } from "../../core/types.ts";
import type { AgentEvent, Usage } from "../../schema/index.ts";
import { DEVIN_PROJECT_HOOK_FILES, devinConfigDir } from "../../spool/devin.ts";
import { commandArgsEntry, mcpInstaller } from "../_shared/mcp.ts";
import { firingKey, lineRaw } from "../_shared/normalize.ts";
import { bundleUserFiles, copyIfExists, isolatedHome } from "../_shared/overlay.ts";
import {
  Emitter,
  applyWrites,
  attachRaw,
  binVersion,
  emitText,
  emitToolEnd,
  emitToolStart,
  findBinary,
  get,
  hasClaudeHooks,
  hasFlag,
  hookCmd,
  isEmptyObject,
  isObj,
  isOurCommand,
  jsonEdit,
  mergeClaudeHooks,
  num,
  rawBlob,
  readJsonObject,
  runEnv,
  spawnAgent,
  str,
  stripClaudeHooks,
  textOf,
  toJson,
  toRunOutput,
} from "./_util.ts";
import type { Json, PlannedWrite } from "./_util.ts";
import { isWrapperLine, normalizeWrapperLine } from "./wrapper.ts";

const ID = "devin";
export const DEVIN_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop", "PostCompaction", "SessionEnd"] as const;
const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse", "PermissionRequest"]);
/** The read_config_from keys that import another tool's rules, skills, MCP servers or hooks: off in eval runs. */
const IMPORTS = ["cursor", "windsurf", "claude", "copilot", "codex", "kiro", "opencode", "zed"] as const;
/** What `devin -p` prints instead of running when it has no login (live: the picker, then the code prompt). */
const LOGIN_PROMPT = /How would you like to log in\?|to sign in, then copy the code|Paste the code from the sign-in page/;

const isOurs = (h: Json): boolean => isOurCommand(h.command, ID);

function spec(hookCommand: string) {
  return {
    events: DEVIN_HOOK_EVENTS,
    entry: (event: string): Json => ({ type: "command", command: hookCmd(hookCommand, ID, event), timeout: 10 }),
    matcher: (event: string) => (TOOL_EVENTS.has(event) ? "" : undefined),
    isOurs,
  };
}

/** The file that holds our hooks for a scope: the user config, or the project's git-ignored .devin/config.local.json. Both keep them under "hooks". */
export function devinHookTarget(opts: { scope: "user" | "project"; projectDir?: string | undefined }, env: NodeJS.ProcessEnv = process.env): string {
  return opts.scope === "project" ? join(opts.projectDir ?? process.cwd(), ".devin", "config.local.json") : join(devinConfigDir(env), "config.json");
}

/** A hooks file as a Claude-shaped settings object: .devin/hooks.v1.json is the event map itself, the others hold it under "hooks". */
function readHooks(path: string): { text: string | undefined; settings: Json; bare: boolean } {
  const { text, value } = readJsonObject(path);
  const bare = path.endsWith("hooks.v1.json");
  return { text, settings: bare ? { hooks: value } : value, bare };
}

/** The tool call's result, from PostToolUse's tool_response {success, output, error}. */
function toolResult(resp: unknown): { ok: boolean; output: unknown; error?: string } {
  if (!isObj(resp)) return { ok: true, output: resp };
  const output = "output" in resp ? resp.output : resp;
  const ok = resp.success !== false && resp.is_error !== true;
  return ok ? { ok, output } : { ok, output, error: str(resp.error) ?? textOf(resp.error) ?? textOf(output) ?? "tool error" };
}

export async function normalizeDevin(line: SpoolLine, ctx: NormalizeContext): Promise<AgentEvent[]> {
  if (isWrapperLine(line)) return normalizeWrapperLine(line, ctx);
  const payload = lineRaw(line);
  const raw: Json = isObj(payload) ? payload : {};
  const sessionId = str(raw.session_id) ?? `devin-unknown-${line.ppid ?? line.pid}`;
  const ev = str(raw.hook_event_name) ?? line.event;
  const cwd = str(raw.cwd) ?? line.cwd;
  // One prompt_id per prompt: it keys the turn, so the events of one prompt share a turnId.
  const promptId = str(raw.prompt_id);
  const turnId = promptId ? ctx.id(ID, sessionId, "turn", promptId) : undefined;
  // Ids from the payload and a time slot, not the spool position: the copies two hook files write of one firing get the same ids.
  const em = new Emitter(ctx, { agent: ID, sessionId, ts: line.ts, cwd, runId: line.runId, model: str(raw.model), turnId }, ["hook", ...firingKey(line, ctx, payload, ID, sessionId, ev), ev], { toolKeys: true });
  const tool = str(raw.tool_name) ?? "unknown";
  const toolUseId = str(raw.tool_use_id) ?? str(raw.tool_call_id);
  switch (ev) {
    case "SessionStart":
      em.push("session.start", { source: str(raw.source) });
      break;
    case "SessionEnd":
      em.push("session.end", { reason: str(raw.reason) });
      break;
    case "UserPromptSubmit": {
      const p = str(raw.prompt);
      if (p) await emitText(em, ctx, "user.message", p);
      break;
    }
    case "PreToolUse":
      await emitToolStart(em, ctx, tool, toolUseId, raw.tool_input);
      break;
    case "PostToolUse":
    case "PostToolUseFailure": {
      const r = toolResult(raw.tool_response);
      const ok = ev === "PostToolUse" && r.ok;
      await emitToolEnd(em, ctx, { tool, toolUseId, input: raw.tool_input, output: r.output, ok, error: ok ? undefined : (r.error ?? str(raw.error) ?? "tool error") }, cwd);
      break;
    }
    case "PermissionRequest": {
      // The wording unapproved.ts and waiting.ts read a permission prompt by (PERMISSION_TEXT, PERMISSION_TOOL).
      const command = str(get(raw, "tool_input", "command"));
      const message = `Devin needs your permission to use ${tool}${command ? `: ${command.length > 200 ? `${command.slice(0, 200)}…` : command}` : ""}`;
      em.push("notification", { kind: "permission_prompt", tool, toolUseId, message });
      break;
    }
    case "Stop": {
      const last = str(raw.last_assistant_message);
      if (last) await emitText(em, ctx, "assistant.message", last);
      // A Stop that fires because a Stop hook blocked the last one continues the same turn.
      if (raw.stop_hook_active === true) em.push("turn.end", { stopHookActive: true });
      else em.turnEnd({}, promptId);
      break;
    }
    case "PostCompaction":
    case "PostCompact":
    case "PreCompact": {
      const trigger = raw.trigger === "manual" || raw.trigger === "auto" ? raw.trigger : undefined;
      em.push("context.compact", { trigger, tokensBefore: num(raw.tokens_before) });
      break;
    }
    case "Notification":
      em.push("notification", { kind: "notification", message: str(raw.message), type: str(raw.notification_type) });
      break;
    default:
      em.push("notification", { kind: ev });
  }
  return attachRaw(em.events, await rawBlob(ctx, payload));
}

// ---------------------------------------------------------------- headless runs

/**
 * Session id and usage from an `--export` file (ATIF: session_id, final_metrics with
 * total_prompt_tokens, total_completion_tokens, total_cached_tokens and total_cost_usd).
 * Prompt tokens include the cached ones; Usage.inputTokens does not.
 */
export function devinExport(path: string): { sessionId?: string; usage?: Usage } {
  let v: unknown;
  try {
    v = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
  if (!isObj(v)) return {};
  const out: { sessionId?: string; usage?: Usage } = {};
  const sid = str(v.session_id);
  if (sid) out.sessionId = sid;
  const m = isObj(v.final_metrics) ? v.final_metrics : {};
  const prompt = num(m.total_prompt_tokens);
  const cached = num(m.total_cached_tokens);
  const u: Usage = {};
  if (prompt !== undefined) u.inputTokens = Math.max(0, prompt - (cached ?? 0));
  if (cached !== undefined) u.cacheReadTokens = cached;
  const output = num(m.total_completion_tokens);
  if (output !== undefined) u.outputTokens = output;
  const cost = num(m.total_cost_usd);
  if (cost !== undefined) u.costUsd = cost;
  if (Object.keys(u).length) out.usage = u;
  return out;
}

// ---------------------------------------------------------------- adapter

export const devinAdapter: Adapter = {
  id: ID,
  displayName: "Devin CLI",
  tier: "A",
  // 2 (0.1.8): test.result comes from the shared parser: pytest -q's bare summary line counts, the node runner is "node:test", and skipped is absent when 0.
  // 3 (0.1.8): a test.result comes only from a command that runs tests (runsTests): a command that prints a log holding a summary (tail, grep, cat, Get-Content) gives none.
  parseVersion: 3,
  async detect(): Promise<DetectResult> {
    const binary = findBinary(["devin"]);
    const dir = devinConfigDir();
    let hooked = false;
    try {
      hooked = hasClaudeHooks(readJsonObject(join(dir, "config.json")).value, isOurs);
    } catch {
      // unparseable config: not hooked
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
    const path = devinHookTarget(opts);
    const { text, settings } = readHooks(path);
    const merged = mergeClaudeHooks(settings, spec(opts.hookCommand));
    return applyWrites(ID, [{ path, before: text, after: jsonEdit(text, merged), summary: `add coding.sh hooks (${DEVIN_HOOK_EVENTS.join(", ")})`, track: "install", pristine: !hasClaudeHooks(settings, isOurs) }], opts.dryRun);
  },
  async uninstall(opts): Promise<FileChange[]> {
    // Every file Devin reads hooks from in this scope, wherever an earlier version or the user put ours.
    const files = opts.scope === "project" ? DEVIN_PROJECT_HOOK_FILES.map((f) => join(opts.projectDir ?? process.cwd(), ".devin", f)) : [devinHookTarget(opts)];
    const writes: PlannedWrite[] = [];
    for (const path of files) {
      if (!existsSync(path)) continue;
      const { text, settings, bare } = readHooks(path);
      if (!hasClaudeHooks(settings, isOurs)) continue;
      const stripped = stripClaudeHooks(settings, isOurs);
      const next = bare ? (isObj(stripped.hooks) ? stripped.hooks : {}) : stripped;
      writes.push({ path, before: text, after: isEmptyObject(next) ? undefined : jsonEdit(text, next), summary: "remove coding.sh hooks", track: "uninstall", remaining: next });
    }
    return applyWrites(ID, writes, opts.dryRun);
  },
  ...mcpInstaller((env) => ({ agent: ID, file: join(devinConfigDir(env), "mcp_config.json"), format: "json", key: "mcpServers", entry: commandArgsEntry })),
  normalize: normalizeDevin,
  async run(spec: RunSpec): Promise<AgentRunOutput> {
    const bin = findBinary(["devin"], { ...process.env, ...spec.env }) ?? "devin";
    // The export goes outside the work tree, where it would show up in the agent's diff.
    const tmp = mkdtempSync(join(tmpdir(), "csh-devin-"));
    const exportPath = join(tmp, "export.json");
    const args: string[] = [];
    if (!hasFlag(spec.flags, "--permission-mode")) args.push("--permission-mode", "dangerous");
    if (!hasFlag(spec.flags, "--respect-workspace-trust")) args.push("--respect-workspace-trust", "false");
    if (spec.model && !hasFlag(spec.flags, "--model")) args.push("--model", spec.model);
    if (!hasFlag(spec.flags, "--export")) args.push("--export", exportPath);
    // `--` ends the options: an instruction that starts with "-" stays the prompt.
    args.push(...spec.flags, "-p", "--", spec.instruction);
    // Without a login Devin waits at its login picker until the timeout: stop it at the first prompt.
    const login = new AbortController();
    const ambient = currentAbortSignal();
    const signal = ambient ? AbortSignal.any([ambient, login.signal]) : login.signal;
    const onLine = (line: string) => {
      if (!login.signal.aborted && LOGIN_PROMPT.test(line)) login.abort();
    };
    try {
      const r = await spawnAgent({ bin, args, cwd: spec.cwd, stdoutFile: spec.stdoutFile, env: runEnv(spec), timeoutMs: spec.timeoutMs, signal, onLine });
      if (login.signal.aborted) {
        r.exitCode ??= 1;
        r.stderrTail = `${r.stderrTail.replace(/\n?aborted$/, "")}\nDevin CLI is not logged in: it asked how to log in instead of running. Run \`devin auth login\`, then run again.`.trim();
      }
      const x = devinExport(exportPath);
      return toRunOutput(r, x.sessionId, x.usage);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  },
  harnessFiles() {
    const user = ["config.json", "mcp_config.json", "skills/**"];
    return {
      project: ["AGENTS.md", "agents.md", "AGENTS.local.md", "AGENT.md", "**/AGENTS.md", ".windsurfrules", ".devin/**", ".agents/**"],
      // %APPDATA%\devin on Windows, ~/.config/devin elsewhere.
      user: [...user.map((f) => `~/.config/devin/${f}`), ...user.map((f) => `~/AppData/Roaming/devin/${f}`)],
    };
  },
  async overlay(bundle: HarnessBundle, runDir: string) {
    const h = isolatedHome(runDir);
    const cfg = join(h, ".config");
    const dir = join(cfg, "devin");
    // A bundle from Windows holds %APPDATA%\devin: it goes where DEVIN_CONFIG_HOME points too.
    for (const rel of bundleUserFiles(bundle, "~/AppData/Roaming/devin/")) await copyIfExists(join(h, "AppData", "Roaming", "devin", rel), join(dir, rel));
    const path = join(dir, "config.json");
    const merged = mergeClaudeHooks(readJsonObject(path).value, spec(paths().hook));
    // Devin finds Claude Code's, Cursor's, ... files in the real home whatever HOME says (Windows
    // asks the system for the profile folder): a run reads its bundle's files and no other tool's.
    const from = isObj(merged.read_config_from) ? merged.read_config_from : {};
    const read: Json = { ...from };
    for (const k of IMPORTS) read[k] = false;
    merged.read_config_from = read;
    // Since v3000.13.4 a session may run in a background process shared by every Devin client, which
    // runs hooks with its own env, not the run's (CODING_SH_RUN_ID, this config): each run keeps its
    // session in its own process. A config key, not --process-model: an older Devin ignores the key.
    merged.process_model = "in-process";
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, toJson(merged), { mode: 0o600 });
    // The login: on Windows it stays in %APPDATA%\devin, which a run keeps; elsewhere it may sit next
    // to the config, so it is copied there (a keychain login needs nothing).
    await copyIfExists(join(devinConfigDir(), "credentials.toml"), join(dir, "credentials.toml"));
    return { env: { DEVIN_CONFIG_HOME: cfg, DEVIN_SESSIONS_DIR: join(h, "devin-sessions") }, flags: [] };
  },
};
