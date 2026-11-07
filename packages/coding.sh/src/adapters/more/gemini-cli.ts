// Gemini CLI (google-gemini/gemini-cli). Tier A: settings.json hooks + JSONL chats + headless.
//
// Verified against gemini-cli main (v0.67, 2026-11) source and docs:
// - Hooks: `hooks.<Event>: [{matcher?, hooks:[{type:"command", command, name?, timeout(ms)}]}]`
//   in ~/.gemini/settings.json (user; $GEMINI_CLI_HOME/.gemini when set) or .gemini/settings.json
//   (project; disabled in untrusted folders). On by default (hooksConfig.enabled = true); there
//   is no tools.enableHooks.
// - Events: BeforeTool, AfterTool, BeforeAgent, AfterAgent, BeforeModel, AfterModel,
//   BeforeToolSelection, SessionStart, SessionEnd, PreCompress, Notification.
//   We skip Before/AfterModel and BeforeToolSelection: AfterModel fires once per streaming
//   chunk, and a process per chunk would slow streaming. (normalize still handles them.)
// - stdin: session_id, transcript_path, cwd, hook_event_name, timestamp + per event
//   tool_name/tool_input/tool_response, prompt/prompt_response, source/reason/trigger,
//   llm_request.model, llm_response.usageMetadata. Hook stdout/stderr is parsed or injected,
//   so the hook must print nothing (ours prints nothing and always exits 0).
// - Chats: ~/.gemini/tmp/<slug>/chats/session-<date>-<id8>.jsonl. Line 1 metadata
//   {sessionId,projectHash,startTime,…}; then message records {id,timestamp,type:user|gemini|
//   info|error|warning,content,toolCalls[],tokens{input,output,cached,…},model}. The same id
//   can repeat (last wins); {$set},{$rewindTo},{$patch} control lines. Subagents in
//   chats/<parentSessionId>/<id>.jsonl. Legacy: session-*.json {sessionId,messages[]}.
// - Headless: `gemini -p … -o stream-json -m M --approval-mode yolo --skip-trust`; stream
//   events init{session_id,model}, message, tool_use, tool_result, error, result{stats}.
// - Isolation: GEMINI_CLI_HOME replaces ~ (config, tmp, creds, extensions move with it).
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Adapter, AgentRunOutput, DetectResult, FileChange, HarnessBundle, InstallOpts, NormalizeContext, RunSpec, SpoolLine } from "../../core/types.ts";
import type { AgentEvent, Usage } from "../../schema/index.ts";
import {
  Emitter,
  applyWrites,
  attachRaw,
  binVersion,
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
  jsonLines,
  mergeClaudeHooks,
  mtimeMs,
  num,
  overlayHome,
  parseJsonc,
  rawBlob,
  readJsonObject,
  readJsonl,
  readText,
  runEnv,
  spawnAgent,
  spoolIdParts,
  str,
  stripClaudeHooks,
  textOf,
  toJson,
  toMs,
  toRunOutput,
  usageFrom,
  walkFiles,
} from "./_util.ts";
import type { Json } from "./_util.ts";
import { commandArgsEntry, mcpInstaller } from "../_shared/mcp.ts";
import { isWrapperEvent, normalizeWrapperLine } from "./wrapper.ts";

const ID = "gemini-cli";
const HOOK_NAME = "coding-sh";
export const GEMINI_HOOK_EVENTS = ["SessionStart", "SessionEnd", "BeforeAgent", "AfterAgent", "BeforeTool", "AfterTool", "PreCompress", "Notification"] as const;
const TOOL_EVENTS = new Set(["BeforeTool", "AfterTool"]);

/** ~/.gemini, or $GEMINI_CLI_HOME/.gemini. */
export function geminiDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.GEMINI_CLI_HOME || home(env), ".gemini");
}

export function geminiSettingsPath(opts: { scope: "user" | "project"; projectDir?: string | undefined }, env: NodeJS.ProcessEnv = process.env): string {
  return opts.scope === "project" ? join(opts.projectDir ?? process.cwd(), ".gemini", "settings.json") : join(geminiDir(env), "settings.json");
}

const isOurs = (h: Json): boolean => h.name === HOOK_NAME || isOurCommand(h.command, ID);

function hookSpec(hookCommand: string) {
  return {
    events: GEMINI_HOOK_EVENTS,
    entry: (event: string): Json => ({ type: "command", name: HOOK_NAME, command: hookCmd(hookCommand, ID, event), timeout: 5000 }),
    matcher: (event: string) => (TOOL_EVENTS.has(event) ? "*" : undefined),
    isOurs,
  };
}

function toolOk(resp: unknown): { ok: boolean; error?: string } {
  if (!isObj(resp)) return { ok: true };
  const err = resp.error;
  if (err === undefined || err === null || err === false) return { ok: true };
  return { ok: false, error: str(get(err, "message")) ?? (typeof err === "string" ? err : "tool error") };
}

export async function normalizeGemini(line: SpoolLine, ctx: NormalizeContext): Promise<AgentEvent[]> {
  if (isWrapperEvent(line.event)) return normalizeWrapperLine(line, ctx);
  const raw: Json = isObj(line.raw) ? line.raw : {};
  const sessionId = str(raw.session_id) ?? `gemini-unknown-${line.ppid ?? line.pid}`;
  const cwd = str(raw.cwd) ?? line.cwd;
  const ts = toMs(raw.timestamp) ?? line.ts;
  const model = str(get(raw, "llm_request", "model"));
  const em = new Emitter(ctx, { agent: ID, sessionId, ts, cwd, runId: line.runId, model }, spoolIdParts(line, sessionId, ctx));
  const ev = str(raw.hook_event_name) ?? line.event;
  const tool = str(raw.tool_name) ?? "unknown";
  const toolUseId = str(raw.tool_call_id) ?? str(raw.tool_use_id);
  switch (ev) {
    case "SessionStart":
      em.push("session.start", { source: str(raw.source), transcriptPath: str(raw.transcript_path) });
      break;
    case "SessionEnd":
      em.push("session.end", { reason: str(raw.reason) });
      break;
    case "BeforeAgent": {
      const p = str(raw.prompt);
      if (p) await emitText(em, ctx, "user.message", p);
      break;
    }
    case "AfterAgent": {
      const r = str(raw.prompt_response);
      if (r) await emitText(em, ctx, "assistant.message", r);
      em.push("turn.end", { stopHookActive: raw.stop_hook_active === true ? true : undefined });
      break;
    }
    case "BeforeTool":
      await emitToolStart(em, ctx, tool, toolUseId, raw.tool_input);
      break;
    case "AfterTool": {
      const { ok, error } = toolOk(raw.tool_response);
      const resp = raw.tool_response;
      const output = isObj(resp) ? (resp.llmContent ?? resp.returnDisplay ?? resp) : resp;
      await emitToolEnd(em, ctx, { tool, toolUseId, input: raw.tool_input, output, ok, error }, cwd);
      break;
    }
    case "PreCompress":
      em.push("context.compact", { trigger: raw.trigger === "manual" ? "manual" : "auto" });
      break;
    case "Notification":
      em.push("notification", { kind: str(raw.notification_type) ?? "notification", message: str(raw.message) });
      break;
    case "AfterModel": {
      // One call per streaming chunk: only the chunk with a finishReason closes the model call.
      const resp = raw.llm_response;
      const finish = str(get(resp, "candidates", 0, "finishReason"));
      if (!finish) return [];
      const usage = usageFrom(get(resp, "usageMetadata"));
      em.push("llm.call", { provider: "google", requestModel: model, stopReason: finish, ok: finish === "STOP" || finish === "MAX_TOKENS" }, usage ? { usage } : {});
      break;
    }
    case "BeforeModel":
    case "BeforeToolSelection":
      return [];
    default:
      em.push("notification", { kind: ev });
  }
  return attachRaw(em.events, await rawBlob(ctx, line.raw));
}

// ---------------------------------------------------------------- transcripts

/** Text of a stored tool result: Part[] with functionResponse.response {output|error}, or plain text. */
function toolResultText(result: unknown): string | undefined {
  const parts = Array.isArray(result) ? result : [result];
  const texts = parts.map((p) => {
    const resp = get(p, "functionResponse", "response");
    if (resp !== undefined) return textOf(get(resp, "output") ?? get(resp, "error") ?? resp);
    return textOf(p);
  });
  const out = texts.filter((t): t is string => !!t).join("\n");
  return out || undefined;
}

function partsText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === "string" ? p : str(get(p, "text")) ?? "")).filter(Boolean).join("\n");
  if (isObj(c)) return str(c.text) ?? "";
  return "";
}

/** slug → project path, from projects.json and tmp/<slug>/.project_root. */
function projectPaths(gdir: string): Map<string, string> {
  const m = new Map<string, string>();
  try {
    const reg = parseJsonc(readFileSync(join(gdir, "projects.json"), "utf8"));
    const projects = get(reg, "projects");
    if (isObj(projects)) for (const [path, slug] of Object.entries(projects)) if (typeof slug === "string") m.set(slug, path);
  } catch {
    // no registry
  }
  return m;
}

function projectRootOf(chatFile: string, registry: Map<string, string>): string | undefined {
  // <tmp>/<slug>/chats/<file> or <tmp>/<slug>/chats/<parent>/<file>
  let d = dirname(chatFile);
  if (basename(d) !== "chats") d = dirname(d);
  const slugDir = dirname(d);
  const marker = readText(join(slugDir, ".project_root"))?.trim();
  return marker || registry.get(basename(slugDir));
}

/** Replay a chat file to its message list (upserts by id; $patch tool results applied; rewinds kept as history). */
export function replayGeminiChat(lines: Json[]): { meta: Json; messages: Json[] } {
  let meta: Json = {};
  const byId = new Map<string, Json>();
  const legacy = lines.length === 1 && Array.isArray(lines[0]?.messages);
  const records = legacy ? ((lines[0]!.messages as unknown[]).filter(isObj) as Json[]) : lines;
  if (legacy) meta = { ...lines[0], messages: undefined };
  for (const r of records) {
    if (isObj(r.$set)) {
      meta = { ...meta, ...r.$set };
      continue;
    }
    if (typeof r.$rewindTo === "string") continue;
    if (isObj(r.$patch)) {
      const patches = [r.$patch, ...(Array.isArray(r.$patch.updates) ? r.$patch.updates.filter(isObj) : [])];
      for (const p of patches) {
        const target = typeof p.id === "string" ? byId.get(p.id) : undefined;
        if (!target) continue;
        const { toolCalls, id: _id, ...rest } = p;
        Object.assign(target, rest);
        if (Array.isArray(toolCalls) && Array.isArray(target.toolCalls)) {
          for (const tp of toolCalls.filter(isObj)) {
            const tc = (target.toolCalls as unknown[]).find((t) => isObj(t) && t.id === tp.id) as Json | undefined;
            if (tc && "result" in tp) tc.result = tp.result;
          }
        }
      }
      continue;
    }
    if (typeof r.id === "string" && typeof r.type === "string") {
      byId.set(r.id, { ...r });
      continue;
    }
    if (typeof r.sessionId === "string" && !legacy) meta = { ...meta, ...r };
  }
  return { meta, messages: [...byId.values()] };
}

export async function* geminiChatEvents(file: string, ctx: NormalizeContext, opts: { since?: number | undefined; cwd?: string | undefined } = {}): AsyncGenerator<AgentEvent> {
  const lines: Json[] = [];
  if (file.endsWith(".json")) {
    try {
      const v = JSON.parse(readFileSync(file, "utf8"));
      if (isObj(v)) lines.push(v);
    } catch {
      return;
    }
  } else {
    for await (const r of readJsonl(file)) lines.push(r.value);
  }
  const { meta, messages } = replayGeminiChat(lines);
  const sessionId = str(meta.sessionId);
  if (!sessionId) return;
  const cwd = opts.cwd;
  const startTs = toMs(meta.startTime) ?? toMs(messages[0]?.timestamp) ?? mtimeMs(file);
  const out: AgentEvent[] = [];
  const parent = basename(dirname(file)) !== "chats" ? basename(dirname(file)) : undefined;
  const head = new Emitter(ctx, { agent: ID, sessionId, ts: startTs, cwd }, ["gemini-file", sessionId, "meta"]);
  const subagentId = parent ? basename(file).replace(/\.jsonl?$/, "") : undefined;
  const subagentType = parent ? (str(meta.agentName) ?? str(meta.agent) ?? str(meta.kind)) : undefined;
  head.push("session.start", { source: "transcript", kind: str(meta.kind), parentSessionId: parent, subagentId, subagentType, summary: str(meta.summary) });
  out.push(...head.events);
  let sawUser = false;
  let lastTs = startTs;
  for (const m of messages) {
    const ts = toMs(m.timestamp) ?? lastTs;
    lastTs = ts;
    const model = str(m.model);
    const em = new Emitter(ctx, { agent: ID, sessionId, ts, cwd, model }, ["gemini-file", sessionId, str(m.id)!]);
    const text = partsText(m.content).trim();
    if (m.type === "user") {
      if (sawUser) em.push("turn.end", {});
      sawUser = true;
      if (text) await emitText(em, ctx, "user.message", text);
    } else if (m.type === "gemini") {
      const t = isObj(m.tokens) ? m.tokens : undefined;
      const usage: Usage | undefined = t ? usageFrom({ input: t.input, output: (num(t.output) ?? 0) + (num(t.thoughts) ?? 0), cached: t.cached }) : undefined;
      em.push("llm.call", { provider: "google", responseModel: model, ok: true }, usage ? { usage } : {});
      if (text) await emitText(em, ctx, "assistant.message", text);
      for (const tc of Array.isArray(m.toolCalls) ? m.toolCalls.filter(isObj) : []) {
        const name = str(tc.name) ?? "unknown";
        const id = str(tc.id);
        const tts = toMs(tc.timestamp) ?? ts;
        const sub = str(tc.agentId);
        const extra = { ts: tts, ...(sub ? { subagentId: sub } : {}) };
        await emitToolStart(em, ctx, name, id, tc.args, extra);
        const status = str(tc.status) ?? "success";
        await emitToolEnd(em, ctx, { tool: name, toolUseId: id, input: tc.args, output: toolResultText(tc.result) ?? tc.resultDisplay, ok: status === "success", error: status === "success" ? undefined : status, extra }, cwd);
      }
    } else if (m.type === "error") {
      em.push("error", { message: text || "error" });
    } else {
      em.push("notification", { kind: str(m.type) ?? "info", message: text || undefined });
    }
    out.push(...em.events);
  }
  if (sawUser) {
    const tail = new Emitter(ctx, { agent: ID, sessionId, ts: lastTs, cwd }, ["gemini-file", sessionId, "tail"]);
    tail.push("turn.end", {});
    out.push(...tail.events);
  }
  if (parent && subagentId) {
    // Mirror the child on the parent's timeline; childSessionId links the two sessions.
    const p = new Emitter(ctx, { agent: ID, sessionId: parent, ts: startTs, cwd, subagentId }, ["gemini-file", parent, "subagent", subagentId]);
    p.push("subagent.start", { subagentId, type: subagentType, childSessionId: sessionId });
    p.push("subagent.end", { subagentId, childSessionId: sessionId, ok: !messages.some((m) => m.type === "error") }, { ts: lastTs, durationMs: Math.max(0, lastTs - startTs) });
    out.push(...p.events);
  }
  for (const e of out) if (opts.since === undefined || e.ts >= opts.since) yield e;
}

// ---------------------------------------------------------------- adapter

export const geminiCliAdapter: Adapter = {
  id: ID,
  displayName: "Gemini CLI",
  tier: "A",
  async detect(): Promise<DetectResult> {
    const binary = findBinary(["gemini"]);
    const dir = geminiDir();
    let hooked = false;
    try {
      hooked = hasClaudeHooks(readJsonObject(geminiSettingsPath({ scope: "user" })).value, isOurs);
    } catch {
      // unparseable settings: not hooked
    }
    // ~/.gemini alone is no evidence: the Antigravity adapter writes ~/.gemini/config/hooks.json.
    const r: DetectResult = { installed: !!binary || existsSync(geminiSettingsPath({ scope: "user" })), hooked };
    if (binary) {
      r.binary = binary;
      const v = await binVersion(binary);
      if (v) r.version = v;
    }
    if (existsSync(dir)) r.configDir = dir;
    r.notes = [
      "Consumer/free Gemini CLI tiers moved to Antigravity CLI (agy) on 2026-06-18; API-key and enterprise use continues. agy has its own adapter.",
      "Project-level hooks only run in trusted folders.",
    ];
    return r;
  },
  async install(opts: InstallOpts): Promise<FileChange[]> {
    const path = geminiSettingsPath(opts);
    const { text, value } = readJsonObject(path);
    const next = mergeClaudeHooks(value, hookSpec(opts.hookCommand));
    const summary = `add coding.sh hooks (${GEMINI_HOOK_EVENTS.join(", ")})${opts.scope === "project" ? "; project hooks need a trusted folder" : ""}`;
    return applyWrites(ID, [{ path, before: text, after: toJson(next), summary, track: "install", pristine: !hasClaudeHooks(value, isOurs) }], opts.dryRun);
  },
  async uninstall(opts): Promise<FileChange[]> {
    const path = geminiSettingsPath(opts);
    const { text, value } = readJsonObject(path);
    if (text === undefined || !hasClaudeHooks(value, isOurs)) return [];
    const next = stripClaudeHooks(value, isOurs);
    return applyWrites(ID, [{ path, before: text, after: isEmptyObject(next) ? undefined : toJson(next), summary: "remove coding.sh hooks", track: "uninstall", remaining: next }], opts.dryRun);
  },
  // mcpServers in the user settings.json (the same file as the hooks).
  ...mcpInstaller((env) => ({ agent: ID, file: geminiSettingsPath({ scope: "user" }, env), format: "json", key: "mcpServers", entry: commandArgsEntry })),
  normalize: normalizeGemini,
  async *backfill(ctx: NormalizeContext, opts?: { since?: number }): AsyncIterable<AgentEvent> {
    const gdir = geminiDir();
    const registry = projectPaths(gdir);
    const files = walkFiles(join(gdir, "tmp"), (n, full) => /^session-.*\.jsonl?$/.test(n) || (n.endsWith(".jsonl") && full.includes(`${"/"}chats${"/"}`)), 4);
    for (const f of files) {
      if (opts?.since !== undefined && mtimeMs(f) < opts.since) continue;
      yield* geminiChatEvents(f, ctx, { since: opts?.since, cwd: projectRootOf(f, registry) });
    }
  },
  async run(spec: RunSpec): Promise<AgentRunOutput> {
    const bin = findBinary(["gemini"], { ...process.env, ...spec.env }) ?? "gemini";
    const args = ["-p", spec.instruction, "-o", "stream-json"];
    if (!hasFlag(spec.flags, "--approval-mode", "-y", "--yolo")) args.push("--approval-mode", "yolo");
    if (!hasFlag(spec.flags, "--skip-trust")) args.push("--skip-trust");
    if (spec.model && !hasFlag(spec.flags, "-m", "--model")) args.push("-m", spec.model);
    args.push(...spec.flags);
    let sessionId: string | undefined;
    let usage: Usage | undefined;
    const onLine = jsonLines((o) => {
      if (o.type === "init") sessionId ??= str(o.session_id);
      if (o.type === "result" && isObj(o.stats)) usage = usageFrom({ input_tokens: o.stats.input_tokens, output_tokens: o.stats.output_tokens, cached: o.stats.cached });
    });
    const r = await spawnAgent({ bin, args, cwd: spec.cwd, env: runEnv(spec, { GEMINI_CLI_TRUST_WORKSPACE: "true" }), timeoutMs: spec.timeoutMs, onLine });
    return toRunOutput(r, sessionId, usage);
  },
  harnessFiles() {
    return {
      project: ["GEMINI.md", "AGENTS.md", "**/GEMINI.md", ".gemini/settings.json", ".gemini/system.md", ".gemini/commands/**", ".gemini/extensions/**", ".gemini/agents/**", ".geminiignore"],
      user: ["~/.gemini/GEMINI.md", "~/.gemini/settings.json", "~/.gemini/commands/**", "~/.gemini/extensions/**", "~/.gemini/agents/**"],
    };
  },
  async overlay(_bundle: HarnessBundle, runDir: string) {
    const h = overlayHome(runDir);
    copyAuth([".gemini/oauth_creds.json", ".gemini/google_accounts.json", ".gemini/installation_id"], h);
    // Keep the user's auth method (and only that) when the bundle brings no settings.json.
    const dst = join(h, ".gemini", "settings.json");
    if (!existsSync(dst)) {
      try {
        const real = readJsonObject(join(geminiDir(), "settings.json")).value;
        const auth = get(real, "security", "auth");
        const legacy = real.selectedAuthType;
        if (auth !== undefined || legacy !== undefined) {
          mkdirSync(dirname(dst), { recursive: true });
          writeFileSync(dst, toJson({ ...(auth !== undefined ? { security: { auth } } : {}), ...(legacy !== undefined ? { selectedAuthType: legacy } : {}) }), { mode: 0o600 });
        }
      } catch {
        // no readable user settings
      }
    }
    return { env: { GEMINI_CLI_HOME: h, GEMINI_CLI_TRUST_WORKSPACE: "true" }, flags: [] };
  },
};
