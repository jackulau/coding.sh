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
import { toMs } from "./jsonl.ts";
import { Emitter, anthropicUsage, arr, blobList, clipText, clipValue, isObj, num, obj, outputText, str } from "./normalize.ts";
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
}

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
    if (type !== "user" && type !== "assistant" && type !== "system") return;
    if (entry.isSidechain === true && !this.opts.sidechain) return;
    const ts = toMs(entry.timestamp, this.lastTs);
    this.lastTs = Math.max(this.lastTs, ts);
    this.cwd = str(entry.cwd) ?? this.cwd;
    this.version = str(entry.version) ?? this.version;

    if (this.opts.mode === "full" && !this.started) {
      this.started = true;
      const em = this.em(ts, lineNo);
      const payload: Record<string, unknown> = { source: "transcript", gitBranch: str(entry.gitBranch) };
      em.emit("session.start", payload, { key: ["start"] });
      this.push(em);
    }

    if (type === "assistant") return this.assistant(entry, ts, lineNo);
    await this.flushCall();
    if (type === "user") await this.user(entry, ts, lineNo);
    else await this.system(entry, ts, lineNo);
    this.lastNonAssistantTs = ts;
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
      em.emit("tool.end", { tool, toolUseId: id, ok, durationMs, output: o.value }, { key: [id], durationMs, blobs: blobList(o.blob) });
      await emitDerived(em, { tool, toolUseId: id, input: use?.input, output: isObj(result) || typeof result === "string" ? result : text, ok, cwd: this.cwd });
    }
    this.push(em);
  }

  /** Ends the current turn and starts one; `emit` adds the turn's opening event (full mode only). */
  private async openTurn(key: string, ts: number, lineNo: number | string, emit: (em: Emitter) => Promise<void>): Promise<void> {
    await this.endTurn(ts, lineNo);
    this.turnId = this.ctx.id(this.opts.agent, this.opts.sessionId, "turn", key);
    this.turnStartTs = ts;
    this.turnEnded = false;
    if (this.opts.mode !== "full") return;
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
      em.emit("error", { message: (str(e.content) ?? "api error").slice(0, 1000), source: "api" }, { key: [uuid] });
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
      em.emit("session.end", { reason: "idle" }, { key: ["idle", this.lastTs], turnId: undefined });
      this.push(em);
    }
    return this.out;
  }
}

/** "mcp__server__tool" → "server". */
export function mcpServer(tool: string): string | undefined {
  const m = /^mcp__(.+?)__/.exec(tool);
  return m ? m[1] : undefined;
}
