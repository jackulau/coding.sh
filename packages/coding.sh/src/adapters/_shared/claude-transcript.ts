// Claude Code transcript (projects/<slug>/<sid>.jsonl) → AgentEvents.
//
// Used two ways:
// - "full" for backfill: every user/assistant/tool/compact/turn event.
// - "assistant" for live Stop/SubagentStop windows: only what hooks cannot
//   see (intermediate assistant text and per-API-call llm.call with usage and
//   timing); tool/prompt events already came from hooks.
// Ids use natural keys (entry uuid, message.id, tool_use id) so live and
// backfilled copies of the same thing dedupe.
//
// Timing: Claude writes one transcript line per content block, all sharing
// message.id and usage. One API call = one message.id. Its start is the
// timestamp of the last non-assistant entry before it (the prompt or tool
// result that triggered the request); ttft ≈ first block line − start;
// duration ≈ last block line − start. Approximate (line write times), but
// derived only from the transcript, so deterministic.
import type { AgentEvent, AgentId, Usage } from "../../schema/index.ts";
import { tierValue } from "../../core/pricing.ts";
import type { NormalizeContext } from "../../core/types.ts";
import { virtualModelId } from "../../integrations/gateway/ids.ts";
import { hookSource } from "./claude-plugins.ts";
import { toMs } from "./jsonl.ts";
import { Emitter, anthropicPriceHints, anthropicUsage, arr, blobList, clipText, clipValue, compact, errorClass, isObj, num, obj, outputText, str } from "./normalize.ts";
import { outputCutOf } from "./cut.ts";
import { emitDerived } from "./tools.ts";

export interface ClaudeConvertOpts {
  agent: AgentId;
  mode: "full" | "assistant";
  /** Session id for emitted events (child-session id for subagent transcripts). */
  sessionId: string;
  subagentId?: string;
  runId?: string;
  /** Source key for line-based ids, e.g. the transcript basename. */
  source: string;
  /**
   * Subagent transcripts mark every entry isSidechain:true. Main transcripts of
   * old versions interleaved sidechains; those are skipped (default false).
   */
  sidechain?: boolean;
  /**
   * Backfill of a finished transcript: when the last entry is older than this
   * (ms), close a turn still open at the end of the file and emit a session.end
   * at the last entry's timestamp. Omitted = never (live windows).
   */
  endIfIdleMs?: number;
  /**
   * Assistant mode only: also emit the prompts that open turns (user.message).
   * Set for a subagent's window: no hook reports a subagent's prompt, so
   * without it the child session has no turn and no title.
   */
  prompts?: boolean;
  /** Hook command → plugin name (pluginHookCommands of the transcript's config dir), to name the plugin behind hook context. */
  pluginHooks?: ReadonlyMap<string, string>;
}

/** A hook run the transcript recorded (hook_success): its command and stdout, to trace later additionalContext back to it. */
interface HookRun {
  event: string;
  command: string;
  stdout: string;
}

/** Hook events whose plain stdout Claude Code adds to the context (for transcripts that do not say what was rendered). */
const STDOUT_CONTEXT_EVENTS = new Set(["SessionStart", "UserPromptSubmit"]);
/** Hook runs remembered to trace additionalContext back to its command. */
const HOOK_RUNS_MAX = 64;
/** Cap on a hook.context event's text (the rest goes to a blob). */
const HOOK_TEXT_MAX = 1024;

interface PendingCall {
  msgId: string;
  startTs: number;
  firstTs: number;
  lastTs: number;
  model?: string;
  usage?: Usage;
  stopReason?: string;
  requestModel?: string;
  /** provider_metadata.gateway.routing on responses through Vercel AI Gateway, when the transcript keeps it. */
  gatewaySessionId?: string;
  servedProvider?: string;
  /** usage.service_tier when not standard ("priority", "batch"), and usage.speed when not standard ("fast"). */
  serviceTier?: string;
  speed?: string;
  /** usage.cache_creation.ephemeral_1h_input_tokens and usage.inference_geo (not global), for pricing. */
  cacheWrite1hTokens?: number;
  inferenceGeo?: string;
}

interface ToolUse {
  name: string;
  input: unknown;
  ts: number;
}

const SKIP_MODELS = new Set(["<synthetic>"]);

/** Text of a user entry that is not meta, a tool result or a compact summary. */
function userText(e: Record<string, unknown>): string | undefined {
  if (e.type !== "user" || e.isMeta === true || e.isCompactSummary === true) return undefined;
  const c = obj(e.message).content;
  if (typeof c === "string") return c;
  if (Array.isArray(c) && !c.some((b) => isObj(b) && b.type === "tool_result")) {
    const t = c.map((b) => (isObj(b) && b.type === "text" ? str(b.text) : undefined)).filter(Boolean);
    return t.length ? t.join("\n") : undefined;
  }
  return undefined;
}

/**
 * User entries Claude Code writes that the person did not type as a prompt:
 * - "command": a slash command (<command-name>/model</command-name>…). Local
 *   ones (/clear, /model) never reach the model; prompt commands (/review) do.
 * - "output": a local command's <local-command-stdout|stderr> or caveat.
 * - "task": a <task-notification> (a background task finished; the model replies to it).
 */
export function syntheticUserKind(text: string): "command" | "output" | "task" | undefined {
  const t = text.trimStart();
  if (/^<(?:command-name|command-message|command-args)>/.test(t)) return "command";
  if (/^<local-command-(?:stdout|stderr|caveat)>/.test(t)) return "output";
  if (t.startsWith("<task-notification>")) return "task";
  return undefined;
}

/** Text of a user entry when it is a real prompt (not meta, tool result, compact summary or a synthetic entry above). */
export function promptText(e: Record<string, unknown>): string | undefined {
  const t = userText(e);
  return t !== undefined && syntheticUserKind(t) === undefined ? t : undefined;
}

const tag = (text: string, name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim() || undefined;

interface PendingCommand {
  ts: number;
  lineNo: number;
  uuid: string;
  promptId?: string;
  command: string;
  args?: string;
}

export class ClaudeTranscriptConverter {
  readonly ctx: NormalizeContext;
  readonly opts: ClaudeConvertOpts;
  readonly out: AgentEvent[] = [];
  model?: string;
  cwd?: string;
  version?: string;
  private pending?: PendingCall;
  private lastNonAssistantTs?: number;
  private lastTs = 0;
  private tools = new Map<string, ToolUse>();
  private turnId?: string;
  private turnStartTs?: number;
  private turnEnded = true;
  private started = false;
  /** A slash command not yet known to be local (no model call) or a prompt command. */
  private command?: PendingCommand;
  private hookRuns: HookRun[] = [];
  /** What the latest cost-state line reported (full mode), for the session.end. */
  private reported?: Record<string, unknown>;

  constructor(ctx: NormalizeContext, opts: ClaudeConvertOpts) {
    this.ctx = ctx;
    this.opts = opts;
  }

  /** Id of the latest turn opened so far: a hook Stop keys its turn.end by it, as the transcript does. */
  get currentTurnId(): string | undefined {
    return this.turnId;
  }

  /** Timestamp of the latest entry seen (0 before any). */
  get lastEntryTs(): number {
    return this.lastTs;
  }

  /** The transcript has been quiet longer than endIfIdleMs (never, without it). */
  idle(now = Date.now()): boolean {
    const idle = this.opts.endIfIdleMs;
    return idle !== undefined && this.lastTs > 0 && now - this.lastTs > idle;
  }

  private em(ts: number, lineNo: number | string): Emitter {
    return new Emitter(
      this.ctx,
      {
        agent: this.opts.agent,
        sessionId: this.opts.sessionId,
        ts,
        cwd: this.cwd,
        model: this.model,
        agentVersion: this.version,
        runId: this.opts.runId,
        turnId: this.turnId,
        subagentId: this.opts.subagentId,
      },
      ["transcript", this.opts.source, lineNo],
    );
  }

  private push(em: Emitter): void {
    this.out.push(...em.events);
  }

  /** Feed one parsed transcript entry. */
  async add(entry: unknown, lineNo: number): Promise<void> {
    if (!isObj(entry)) return;
    const type = entry.type;
    if (type === "attachment") return this.attachment(entry, lineNo);
    if (type === "cost-state") return this.costState(entry);
    if (type !== "user" && type !== "assistant" && type !== "system") return;
    if (entry.isSidechain === true && !this.opts.sidechain) return;
    const ts = toMs(entry.timestamp, this.lastTs);
    this.lastTs = Math.max(this.lastTs, ts);
    this.begin(entry, ts, lineNo);

    if (type === "assistant") return this.assistant(entry, ts, lineNo);
    await this.flushCall();
    if (type === "user") await this.user(entry, ts, lineNo);
    else await this.system(entry, ts, lineNo);
    this.lastNonAssistantTs = ts;
  }

  /** Notes the entry's cwd and version; in full mode the first entry also starts the session. */
  private begin(entry: Record<string, unknown>, ts: number, lineNo: number): void {
    this.cwd = str(entry.cwd) ?? this.cwd;
    this.version = str(entry.version) ?? this.version;
    if (this.opts.mode !== "full" || this.started) return;
    this.started = true;
    const em = this.em(ts, lineNo);
    const payload: Record<string, unknown> = { source: "transcript", gitBranch: str(entry.gitBranch), entrypoint: str(entry.entrypoint) };
    em.emit("session.start", payload, { key: ["start"] });
    this.push(em);
  }

  private async assistant(e: Record<string, unknown>, ts: number, lineNo: number): Promise<void> {
    const m = obj(e.message);
    const msgId = str(m.id) ?? str(e.requestId) ?? `line-${lineNo}`;
    const model = str(m.model);
    if (model && !SKIP_MODELS.has(model)) this.model = model;
    if (this.pending && this.pending.msgId !== msgId) await this.flushCall();
    if (!this.pending && !(model && SKIP_MODELS.has(model))) {
      this.pending = { msgId, startTs: this.lastNonAssistantTs ?? ts, firstTs: ts, lastTs: ts, requestModel: str(e.requestedModel) };
    }
    if (this.pending) {
      this.pending.lastTs = ts;
      if (model && !SKIP_MODELS.has(model)) this.pending.model = model;
      this.pending.usage = anthropicUsage(m.usage) ?? this.pending.usage;
      this.pending.serviceTier = tierValue(obj(m.usage).service_tier) ?? this.pending.serviceTier;
      this.pending.speed = tierValue(obj(m.usage).speed) ?? this.pending.speed;
      if (isObj(m.usage)) Object.assign(this.pending, anthropicPriceHints(m.usage));
      this.pending.stopReason = str(m.stop_reason) ?? this.pending.stopReason;
      const routing = obj(obj(obj(m.provider_metadata).gateway).routing);
      this.pending.gatewaySessionId = str(routing.clientSessionId) ?? this.pending.gatewaySessionId;
      this.pending.servedProvider = str(routing.finalProvider) ?? this.pending.servedProvider;
    }
    // A model call after a slash command: it was a prompt command, so it opens a turn.
    if (this.command) await this.commandTurn();
    const em = this.em(ts, lineNo);
    const uuid = str(e.uuid) ?? `line-${lineNo}`;
    let i = 0;
    for (const b of arr(m.content)) {
      const bi = i++;
      if (!isObj(b)) continue;
      if (b.type === "text" && str(b.text)) {
        const t = await clipText(this.ctx, b.text as string);
        em.emit("assistant.message", { text: t.value, truncated: t.truncated || undefined, messageId: msgId }, { key: [uuid, bi], blobs: blobList(t.blob) });
      } else if (b.type === "tool_use" && this.opts.mode === "full") {
        const id = str(b.id) ?? `${uuid}:${bi}`;
        const name = str(b.name) ?? "unknown";
        this.tools.set(id, { name, input: b.input, ts });
        const inp = await clipValue(this.ctx, b.input);
        em.emit("tool.start", { tool: name, toolUseId: id, input: inp.value, server: mcpServer(name) }, { key: [id], blobs: blobList(inp.blob) });
      }
    }
    if (e.isApiErrorMessage === true) {
      const text = arr(m.content).map((b) => str(obj(b).text)).filter(Boolean).join("\n");
      em.emit("error", { message: text.slice(0, 1000), source: "api" }, { key: [uuid, "api-error"] });
    }
    this.push(em);
  }

  private async user(e: Record<string, unknown>, ts: number, lineNo: number): Promise<void> {
    const uuid = str(e.uuid) ?? `line-${lineNo}`;
    const text = userText(e);
    const kind = text === undefined ? undefined : syntheticUserKind(text);
    if (text !== undefined && kind !== undefined) return this.synthetic(kind, text, e, uuid, ts, lineNo);
    if (text !== undefined) {
      await this.localCommand();
      await this.openTurn(str(e.promptId) ?? uuid, ts, lineNo, async (em) => {
        const t = await clipText(this.ctx, text);
        em.emit("user.message", { text: t.value, truncated: t.truncated || undefined }, { key: [uuid], blobs: blobList(t.blob) });
      });
      return;
    }
    // Hooks never see what the harness loaded, so live windows record it too.
    if (e.isMeta === true && e.sourceToolUseID !== undefined) await this.skillBase(e, ts, lineNo);
    if (this.opts.mode !== "full") return;
    const em = this.em(ts, lineNo);
    for (const b of arr(obj(e.message).content)) {
      if (!isObj(b) || b.type !== "tool_result") continue;
      const id = str(b.tool_use_id);
      if (!id) continue;
      const use = this.tools.get(id);
      const tool = use?.name ?? "unknown";
      const result = e.toolUseResult;
      const ok = b.is_error !== true;
      const durationMs = num(obj(result).durationMs) ?? (use ? Math.max(0, ts - use.ts) : undefined);
      const text = outputText(b.content) ?? outputText(result) ?? "";
      const o = await clipText(this.ctx, text);
      // The tool_result is what the model got: a large output arrives as a <persisted-output> preview.
      em.emit("tool.end", { tool, toolUseId: id, ok, durationMs, output: o.value, cut: outputCutOf(text) }, { key: [id], durationMs, blobs: blobList(o.blob) });
      await emitDerived(em, { tool, toolUseId: id, input: use?.input, output: isObj(result) || typeof result === "string" ? result : text, ok, cwd: this.cwd });
    }
    this.push(em);
  }

  /** Ends the current turn and starts one; `emit` adds the turn's opening event (full mode, or `prompts`). */
  private async openTurn(key: string, ts: number, lineNo: number | string, emit: (em: Emitter) => Promise<void>): Promise<void> {
    await this.endTurn(ts, lineNo);
    this.turnId = this.ctx.id(this.opts.agent, this.opts.sessionId, "turn", key);
    this.turnStartTs = ts;
    this.turnEnded = false;
    if (this.opts.mode !== "full" && !this.opts.prompts) return;
    const em = this.em(ts, lineNo);
    await emit(em);
    this.push(em);
  }

  /**
   * Slash commands, their local output and task notifications are not prompts:
   * they never title the session or count as user messages. A command opens a
   * turn only if the model answers it (see commandTurn); a task notification
   * does open one (the model replies), recorded as a notification.
   */
  private async synthetic(kind: "command" | "output" | "task", text: string, e: Record<string, unknown>, uuid: string, ts: number, lineNo: number): Promise<void> {
    if (kind === "command") {
      await this.localCommand();
      this.command = { ts, lineNo, uuid, promptId: str(e.promptId), command: tag(text, "command-name") ?? tag(text, "command-message") ?? "command", args: tag(text, "command-args") };
      return;
    }
    if (kind === "output") {
      await this.localCommand();
      if (this.opts.mode !== "full") return;
      const em = this.em(ts, lineNo);
      const out = tag(text, "local-command-stdout") ?? tag(text, "local-command-stderr");
      const t = out ? await clipText(this.ctx, out, 1024) : undefined;
      em.emit("notification", { kind: "command-output", text: t?.value }, { key: [uuid], blobs: blobList(t?.blob) });
      this.push(em);
      return;
    }
    await this.localCommand();
    await this.openTurn(str(e.promptId) ?? uuid, ts, lineNo, async (em) => {
      const t = await clipText(this.ctx, text, 1024);
      em.emit("notification", { kind: "task-notification", text: t.value, status: tag(text, "status"), summary: tag(text, "summary")?.slice(0, 500) }, { key: [uuid], blobs: blobList(t.blob) });
    });
  }

  /** The pending slash command got a model reply: it was a prompt command, so it starts a turn. */
  private async commandTurn(): Promise<void> {
    const c = this.command!;
    this.command = undefined;
    const text = c.args ? `${c.command} ${c.args}` : c.command;
    await this.openTurn(c.promptId ?? c.uuid, c.ts, c.lineNo, async (em) => {
      const t = await clipText(this.ctx, text);
      em.emit("user.message", { text: t.value, truncated: t.truncated || undefined, command: c.command }, { key: [c.uuid], blobs: blobList(t.blob) });
    });
  }

  /** The pending slash command ran locally (no model call): record it, outside any turn. */
  private async localCommand(): Promise<void> {
    const c = this.command;
    if (!c) return;
    this.command = undefined;
    if (this.opts.mode !== "full") return;
    const em = this.em(c.ts, c.lineNo);
    em.emit("notification", { kind: "command", command: c.command, args: c.args?.slice(0, 500) }, { key: [c.uuid], turnId: undefined });
    this.push(em);
  }

  /**
   * Instructions Claude Code loaded mid-session, as a
   * `notification` with `payload.kind: "harness.loaded"`. Only names and paths
   * are kept, never the loaded text:
   * - nested_memory (a CLAUDE.md under a directory the agent touched):
   *   `{loadedBy: "nested_memory", paths: [path], memoryType}`;
   * - dynamic_skill (a nested skills dir became available): `{loadedBy, dir, skills}`;
   * - invoked_skills (skills restored after a compaction or resume): `{loadedBy, skills, sources}`,
   *   sources as Claude Code names them (`projectSettings:<name>`, `userSettings:<name>`,
   *   `plugin:<plugin>:<name>`, `bundled:<name>`, or a path).
   * Other attachment types (instructions, skill_listing, reminders, environment) are skipped.
   * Both modes: hooks never see attachments, and the uuid key dedupes the two copies.
   */
  private async attachment(e: Record<string, unknown>, lineNo: number): Promise<void> {
    if (e.isSidechain === true && !this.opts.sidechain) return;
    const a = obj(e.attachment);
    if (a.type === "hook_success" || a.type === "hook_additional_context") return this.hookContext(e, a, lineNo);
    let payload: Record<string, unknown> | undefined;
    if (a.type === "nested_memory" && str(a.path)) payload = { paths: [a.path], memoryType: str(obj(a.content).type) };
    else if (a.type === "dynamic_skill") payload = { dir: str(a.skillDir), skills: names(a.skillNames) };
    else if (a.type === "invoked_skills") {
      const skills = arr(a.skills).map(obj);
      payload = { skills: names(skills.map((s) => s.name)), sources: names(skills.map((s) => s.path)) };
    }
    if (!payload) return;
    const em = this.em(toMs(e.timestamp, this.lastTs), lineNo);
    em.emit("notification", fitPayload({ kind: "harness.loaded", loadedBy: a.type, ...payload }), { key: [str(e.uuid) ?? `line-${lineNo}`, "harness"] });
    this.push(em);
  }

  /**
   * Text a hook added to the model's context, as a `notification` with
   * `payload.kind: "hook.context"`: `{hookEvent, hookName, hookSource, command,
   * chars, tokens (chars / 4), text}`, one per text. Two attachments carry it:
   * - hook_success: one run of a hook command, with its stdout. Its `content`
   *   reached the model when the entry has `rendered` text (plain stdout of a
   *   SessionStart or UserPromptSubmit hook; in a transcript without
   *   `rendered`, those two events).
   * - hook_additional_context: the additionalContext hooks answered, one string
   *   each. It names no command; the hook_success whose stdout JSON holds the
   *   same additionalContext does.
   * hookSource says whose hook it was (see hookSource). Both modes, keyed by
   * entry uuid; a SessionStart's context belongs to no turn.
   */
  private async hookContext(e: Record<string, unknown>, a: Record<string, unknown>, lineNo: number): Promise<void> {
    const event = str(a.hookEvent) ?? str(a.hookName)?.split(":")[0] ?? "unknown";
    const texts: { text: string; command?: string }[] = [];
    if (a.type === "hook_success") {
      const command = str(a.command);
      if (command) {
        this.hookRuns.push({ event, command, stdout: str(a.stdout) ?? "" });
        if (this.hookRuns.length > HOOK_RUNS_MAX) this.hookRuns.shift();
      }
      const content = str(a.content);
      const rendered = Array.isArray(e.rendered) ? e.rendered.length > 0 : STDOUT_CONTEXT_EVENTS.has(event);
      if (content?.trim() && rendered) texts.push({ text: content, command });
    } else {
      for (const t of arr(a.content)) if (typeof t === "string" && t.trim()) texts.push({ text: t, command: this.contextCommand(event, t) });
    }
    if (!texts.length) return;
    const ts = toMs(e.timestamp, this.lastTs);
    // Hook output can come before the first prompt (SessionStart): the session starts there.
    this.lastTs = Math.max(this.lastTs, ts);
    this.begin(e, ts, lineNo);
    const em = this.em(ts, lineNo);
    const uuid = str(e.uuid) ?? `line-${lineNo}`;
    for (const [i, { text, command }] of texts.entries()) {
      const t = await clipText(this.ctx, text, HOOK_TEXT_MAX);
      em.emit(
        "notification",
        {
          kind: "hook.context",
          hookEvent: event,
          hookName: str(a.hookName),
          hookSource: hookSource(command, this.opts.pluginHooks ?? NO_PLUGINS),
          command: command?.slice(0, 500),
          chars: text.length,
          tokens: Math.ceil(text.length / 4),
          text: t.value,
          truncated: t.truncated || undefined,
        },
        { key: [uuid, "hook", i], blobs: blobList(t.blob), ...(event === "SessionStart" ? { turnId: undefined } : {}) },
      );
    }
    this.push(em);
  }

  /** The command of the latest hook run of `event` whose stdout answered `text` as additionalContext. */
  private contextCommand(event: string, text: string): string | undefined {
    for (let i = this.hookRuns.length - 1; i >= 0; i--) {
      const r = this.hookRuns[i]!;
      if (r.event !== event || !r.stdout.includes("additionalContext")) continue;
      try {
        if (str(obj(obj(JSON.parse(r.stdout.trim())).hookSpecificOutput).additionalContext) === text) return r.command;
      } catch {
        // stdout that is not JSON answered no additionalContext.
      }
    }
    return undefined;
  }

  /**
   * The Skill tool's result: Claude Code adds a meta user entry, linked to the
   * call by sourceToolUseID, that opens with "Base directory for this skill: <dir>".
   * Recorded as harness.loaded `{loadedBy: "skill", skills: [name], sources: [dir], toolUseId}`
   * (the directory only, never the skill's text), so skill scope is known.
   */
  private async skillBase(e: Record<string, unknown>, ts: number, lineNo: number): Promise<void> {
    const id = str(e.sourceToolUseID);
    const c = obj(e.message).content;
    const text = typeof c === "string" ? c : str(obj(arr(c)[0]).text);
    const dir = id && text ? /^Base directory for this skill: ([^\n]+)/.exec(text)?.[1]?.trim() : undefined;
    if (!id || !dir) return;
    const input = obj(this.tools.get(id)?.input);
    const name = str(input.skill) ?? str(input.name) ?? dir.split(/[\\/]/).pop()!;
    const em = this.em(ts, lineNo);
    em.emit("notification", fitPayload({ kind: "harness.loaded", loadedBy: "skill", skills: [name], sources: [dir], toolUseId: id }), { key: [str(e.uuid) ?? `line-${lineNo}`, "harness"] });
    this.push(em);
  }

  /**
   * Claude Code's own cost tally (a `cost-state` line, written when the process
   * exits), kept for the backfilled session.end as `payload.reportedUsage`:
   * `{costUsd, apiDurationMs, costUsdByModel, unknownModelCost?}`. A total, never
   * summed into usage. The latest line wins: a resumed session writes another.
   */
  private costState(e: Record<string, unknown>): void {
    if (this.opts.mode !== "full" || (e.sessionId !== undefined && e.sessionId !== this.opts.sessionId)) return;
    const costUsd = num(e.totalCostUSD);
    if (costUsd === undefined) return;
    const byModel: Record<string, number> = {};
    for (const [m, u] of Object.entries(obj(e.modelUsage))) {
      const c = num(obj(u).costUSD);
      if (c !== undefined) byModel[m] = c;
    }
    this.reported = compact({
      costUsd,
      apiDurationMs: num(e.totalAPIDuration),
      costUsdByModel: Object.keys(byModel).length ? byModel : undefined,
      unknownModelCost: e.hasUnknownModelCost === true || undefined,
    });
  }

  private async system(e: Record<string, unknown>, ts: number, lineNo: number): Promise<void> {
    const uuid = str(e.uuid) ?? `line-${lineNo}`;
    const em = this.em(ts, lineNo);
    if (e.subtype === "compact_boundary") {
      const meta = obj(e.compactMetadata);
      if (this.opts.mode === "full") {
        em.emit("context.compact", { trigger: str(meta.trigger) ?? "auto", tokensBefore: num(meta.preTokens), tokensAfter: num(meta.postTokens) }, { key: [uuid], durationMs: num(meta.durationMs) });
      }
    } else if (e.subtype === "turn_duration") {
      if (this.opts.mode === "full" && !this.turnEnded) {
        const d = num(e.durationMs);
        // Keyed by the turn, like a synthesized end and the hook Stop's turn.end, so all copies of one turn's end dedupe.
        em.emit("turn.end", { durationMs: d }, { key: [this.turnId ?? uuid, "end"], durationMs: d });
        this.turnEnded = true;
      }
    } else if (e.subtype === "api_error" && this.opts.mode === "full") {
      em.emit("error", apiError(e), { key: [uuid] });
    }
    this.push(em);
  }

  private async endTurn(ts: number, lineNo: number | string): Promise<void> {
    await this.flushCall();
    if (this.opts.mode !== "full" || this.turnEnded || !this.turnId) return;
    const em = this.em(ts, lineNo);
    const d = this.turnStartTs !== undefined ? Math.max(0, this.lastTs - this.turnStartTs) : undefined;
    em.emit("turn.end", { durationMs: d, synthesized: true }, { key: [this.turnId, "end"], ts: this.lastTs, durationMs: d });
    this.push(em);
    this.turnEnded = true;
  }

  private async flushCall(): Promise<void> {
    const p = this.pending;
    if (!p) return;
    this.pending = undefined;
    const em = this.em(p.startTs, `call-${p.msgId}`);
    const durationMs = Math.max(0, p.lastTs - p.startTs);
    const out = p.usage?.outputTokens;
    em.emit(
      "llm.call",
      {
        provider: "anthropic",
        requestModel: p.requestModel,
        responseModel: p.model,
        ttftMs: Math.max(0, p.firstTs - p.startTs),
        stopReason: p.stopReason,
        tokensPerSec: out && durationMs > 0 ? Math.round((out / (durationMs / 1000)) * 10) / 10 : undefined,
        ok: true,
        messageId: p.msgId,
        // Through AI Gateway: the session the gateway grouped the call under, the
        // provider that served it, and for a `vmc/` virtual model the model it resolved to.
        gatewaySessionId: p.gatewaySessionId,
        servedProvider: p.servedProvider,
        virtualModel: virtualModelId(p.requestModel),
        resolvedModel: virtualModelId(p.requestModel) ? p.model : undefined,
        // Priced at these rates (pricing.ts callTier): Priority Tier, a batch result, fast mode.
        serviceTier: p.serviceTier,
        speed: p.speed,
        // 1-hour cache writes (2x input, not 1.25x) and US-only inference (1.1x on Claude 4.6+).
        cacheWrite1hTokens: p.cacheWrite1hTokens,
        inferenceGeo: p.inferenceGeo,
      },
      { key: [p.msgId], durationMs, usage: p.usage, model: p.model ?? this.model },
    );
    this.push(em);
  }

  /**
   * Flush pending state at end of input. A turn still open at the end is
   * closed only when `closed` (default: the transcript is idle): a live
   * transcript's open turn ends later, with its real end.
   */
  async finish(closed = this.idle()): Promise<AgentEvent[]> {
    await this.localCommand();
    if (closed) await this.endTurn(this.lastTs, "eof");
    else await this.flushCall();
    if (this.opts.mode === "full" && this.started && this.idle()) {
      const em = this.em(this.lastTs, "eof");
      // Keyed by the last entry's time: a resumed session gets a later end instead of keeping a stale one.
      em.emit("session.end", { reason: "idle", reportedUsage: this.reported }, { key: ["idle", this.lastTs], turnId: undefined });
      this.push(em);
    }
    return this.out;
  }
}

const NO_PLUGINS: ReadonlyMap<string, string> = new Map();

/**
 * A `system/api_error` entry (one failed attempt Claude Code retries) as an error
 * payload: `{message, source: "api", statusCode, errorType, errorClass,
 * rateLimitType, resetsAt (ms), retryAfterMs, retryAttempt, maxRetries}`, so a
 * weekly-limit stall (`429`, `seven_day`) reads apart from one overloaded 529.
 */
function apiError(e: Record<string, unknown>): Record<string, unknown> {
  const err = obj(e.error);
  const status = num(err.status);
  const raw = str(err.message);
  const errorType = raw ? /"type"\s*:\s*"([a-z_]+_error)"/.exec(raw)?.[1] : undefined;
  const conn = err.connection;
  const network = typeof conn === "string" && conn ? conn : isObj(conn) ? (str(conn.code) ?? str(conn.message) ?? "connection error") : err.isNetworkDown === true ? "network down" : undefined;
  const rl = obj(err.rateLimits);
  const resets = num(rl.resetsAt);
  return {
    message: (str(e.content) ?? str(err.formatted) ?? raw ?? "api error").slice(0, 1000),
    source: "api",
    statusCode: status,
    errorType,
    errorClass: errorClass(status, errorType, network),
    rateLimitType: str(rl.rateLimitType),
    // Seconds since the epoch on the wire.
    resetsAt: resets !== undefined ? (resets < 1e12 ? resets * 1000 : resets) : undefined,
    retryAfterMs: num(e.retryInMs),
    retryAttempt: num(e.retryAttempt),
    maxRetries: num(e.maxRetries),
  };
}

/** Cap on each list in a harness.loaded payload, and on the payload's JSON size. */
const HARNESS_LIST_MAX = 50;
const HARNESS_PAYLOAD_MAX = 2048;

/** The strings in `v`, at most HARNESS_LIST_MAX. */
const names = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === "string" && x !== "").slice(0, HARNESS_LIST_MAX);

/** `p` with its lists cut from the end until its JSON fits HARNESS_PAYLOAD_MAX bytes (`truncated: true` when cut). */
function fitPayload(p: Record<string, unknown>): Record<string, unknown> {
  const size = () => Buffer.byteLength(JSON.stringify(p));
  const lists = Object.keys(p).filter((k) => Array.isArray(p[k]));
  while (size() > HARNESS_PAYLOAD_MAX) {
    const k = lists.filter((x) => (p[x] as unknown[]).length > 0).sort((a, b) => (p[b] as unknown[]).length - (p[a] as unknown[]).length)[0];
    if (!k) break;
    p[k] = (p[k] as unknown[]).slice(0, -1);
    p.truncated = true;
  }
  return p;
}

/** "mcp__server__tool" → "server". */
export function mcpServer(tool: string): string | undefined {
  const m = /^mcp__(.+?)__/.exec(tool);
  return m ? m[1] : undefined;
}
