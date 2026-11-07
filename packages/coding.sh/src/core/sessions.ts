// Session aggregation and failure-pattern detection. Pure functions over a
// session's full event list, so re-running them after every ingest is exact
// (no incremental state to drift).
import { GATEWAY_FLAG, isGatewayEvent } from "../integrations/gateway/ids.ts";
import type { AgentEvent, LatencyStats, Session, Usage } from "../schema/index.ts";

export const FLAGS = {
  prematureCompletion: "premature-completion",
  repeatedToolFailure: "repeated-tool-failure",
  noVerification: "no-verification",
  compaction: "compaction",
  /** A tag, not a failure: model calls went through Vercel AI Gateway. */
  gateway: GATEWAY_FLAG,
} as const;

/** Flags that name a failure pattern. Namespaced flags ("gateway:vercel") are tags. */
export const failureFlags = (flags: readonly string[]): string[] => flags.filter((f) => !f.includes(":"));

/** Events written by enrichment (`coding.sh gateway enrich`): they never decide a session's shape. */
const isEnrichment = (e: AgentEvent): boolean => e.source === "gateway";

export const TITLE_MAX = 280;
/** Cap on Session.traceIds (a long-lived conversation can span many traces). */
export const MAX_TRACE_IDS = 256;

/** Shell commands that verify work: tests, type checks, linters, builds. */
const VERIFY_COMMAND = new RegExp(
  [
    String.raw`\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|typecheck|lint|build|verify)\b`,
    String.raw`\b(?:pytest|py\.test|tox|nox|jest|vitest|mocha|ava|tap|rspec|phpunit|ctest|tsc|mypy|pyright|ruff|eslint|clippy)\b`,
    String.raw`\b(?:go|cargo|deno|bun|mix|dotnet|swift|zig|gradle|gradlew|mvn|sbt|stack|cabal)\s+(?:\S+\s+)*?test\b`,
    String.raw`\bcargo\s+(?:check|clippy|build)\b`,
    String.raw`\bnode\s+(?:\S+\s+)*?--test\b`,
    String.raw`\bpython3?\s+-m\s+(?:pytest|unittest|mypy)\b`,
    String.raw`\bmake\s+(?:test|check|lint|verify)\b`,
    String.raw`\bnpx\s+(?:tsc|jest|vitest|playwright|eslint)\b`,
  ].join("|"),
  "i",
);

/** Extracts a shell command from common tool input shapes across agents. */
export function commandOf(input: unknown): string | undefined {
  if (typeof input === "string") return input;
  if (typeof input !== "object" || input === null) return undefined;
  const o = input as Record<string, unknown>;
  for (const k of ["command", "cmd", "script", "commandLine"]) {
    const v = o[k];
    if (typeof v === "string") return v;
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v.join(" ");
  }
  return undefined;
}

export function isVerifyCommand(command: string | undefined): boolean {
  return !!command && VERIFY_COMMAND.test(command);
}

/** True for a tool.start whose input runs a test/check (or was marked so before metadata stripping). */
export function isVerifyToolStart(e: AgentEvent): boolean {
  if (e.kind !== "tool.start") return false;
  if (e.payload.verify === true) return true;
  return isVerifyCommand(commandOf(e.payload.input));
}

const byTime = (events: AgentEvent[]): AgentEvent[] =>
  events.map((e, i) => ({ e, i })).sort((a, b) => a.e.ts - b.e.ts || a.i - b.i).map((x) => x.e);

function makeTitle(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= TITLE_MAX ? t : `${t.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

/**
 * Markup an agent harness injects as a "user" message (Claude Code: background
 * task completions, local command echoes, reminders). Not something the user typed.
 */
const SYNTHETIC_PROMPT = /^\s*<(task-notification|local-command-(?:stdout|stderr|caveat)|system-reminder|bash-(?:input|stdout|stderr)|user-prompt-submit-hook)>/;
/** A slash command echo: `<command-name>/clear</command-name> <command-message>… <command-args>…`. */
const COMMAND_PROMPT = /^\s*<command-(?:name|message|args)>/;

/** True for a user.message text the harness injected rather than the user typed (incl. slash-command echoes). */
export function isSyntheticPrompt(text: string): boolean {
  return SYNTHETIC_PROMPT.test(text) || COMMAND_PROMPT.test(text);
}

/** "/model opus" from a slash-command echo, else undefined. */
function commandTitle(text: string): string | undefined {
  if (!COMMAND_PROMPT.test(text)) return undefined;
  const name = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(text)?.[1];
  if (!name) return undefined;
  const args = /<command-args>\s*([^<]*?)\s*<\/command-args>/.exec(text)?.[1];
  return makeTitle(args ? `${name} ${args}` : name);
}

/** Event kinds stamped at the END of what they describe (ts = end; durationMs looks back). */
const END_KINDS: ReadonlySet<string> = new Set(["turn.end", "tool.end", "subagent.end", "session.end"]);

/** When the thing an event describes finished: ts for *.end kinds, ts + durationMs for spans stamped at their start. */
export function eventEnd(e: AgentEvent): number {
  return END_KINDS.has(e.kind) ? e.ts : e.ts + (num(e.durationMs) ?? 0);
}

/** Capture paths that replay history (a recorded transcript) rather than observe it live. */
export const BACKFILL_SOURCES: readonly string[] = ["transcript", "backfill", "store"];
export const isBackfillEvent = (e: AgentEvent): boolean => e.source !== undefined && BACKFILL_SOURCES.includes(e.source);

function addUsage(sum: Usage, u: Usage | undefined): void {
  if (!u) return;
  for (const k of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd"] as const) {
    const v = u[k];
    if (typeof v === "number" && Number.isFinite(v)) sum[k] = (sum[k] ?? 0) + v;
  }
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * A usage snapshot: running session totals (T3 Code v1 threads, OpenCode
 * sessions without per-message tokens), re-emitted as the totals grow. Only
 * the latest one counts; summing them would count the same tokens again.
 */
export const isUsageSnapshot = (e: AgentEvent): boolean => e.kind === "notification" && e.payload.type === "usage-summary";

const tokenTotal = (u: Usage | undefined): number => (u?.inputTokens ?? 0) + (u?.outputTokens ?? 0) + (u?.cacheReadTokens ?? 0) + (u?.cacheWriteTokens ?? 0);

/**
 * Activity this long after a session.end reopens the session (a resume under
 * the same id, or more work after a guessed idle end). The slack covers events
 * stamped just after the end they belong to: hook transcript windows read up
 * to 2 s past their hook's time.
 */
export const REOPEN_SLACK_MS = 5_000;

/**
 * Turns from turn.end rows. One capture path: every row is a turn. Both paths,
 * each with keyed rows: rows with a turnId count once per turn (both paths key
 * them alike and the store keeps one copy, so either may hold a given turn);
 * rows without one are each path's own count of the turns it could not key.
 * Otherwise a path that keys none of its turns (an older agent version, a
 * transcript that does not record what the hook keys by) counted the same turns
 * its own way, so the larger count wins (a hook installed mid-session saw fewer).
 */
function turnCount(t: { live: number; backfill: number; liveIdless: number; backfillIdless: number }, turnIds: Set<string>): number {
  if (t.live === 0 || t.backfill === 0) return t.live + t.backfill;
  if (t.live > t.liveIdless && t.backfill > t.backfillIdless) return turnIds.size + Math.max(t.liveIdless, t.backfillIdless);
  return Math.max(t.live, t.backfill);
}

/** The agent a host ran: the first event from another agent, else what the host's own events name. */
function hostProvider(sorted: AgentEvent[], via: string): string | undefined {
  const native = sorted.find((e) => e.agent !== via && !isEnrichment(e));
  if (native) return native.agent;
  for (const e of sorted) if (typeof e.payload.provider === "string" && e.payload.provider) return e.payload.provider;
  return undefined;
}

/**
 * Folds a session's events into a Session row. Fields the events can't
 * provide (e.g. endSnapshot set by the snapshotter) are carried over from `prev`.
 */
export function buildSession(events: AgentEvent[], prev?: Session): Session {
  const sorted = byTime(events);
  const first = sorted[0];
  if (!first && !prev) throw new Error("buildSession needs at least one event or an existing session");
  const id = first?.sessionId ?? prev!.id;

  const usage: Usage = {};
  const files = new Set<string>();
  // Turn ends per capture path. A session seen live (hooks) and from its
  // transcript (backfill) has two turn.end rows per turn wherever the two paths
  // share no natural key (most hook payloads name no turn the transcript knows).
  const turnEnds = { live: 0, backfill: 0, liveIdless: 0, backfillIdless: 0 };
  const turnIds = new Set<string>();
  let userMessages = 0;
  // Tool calls by toolUseId (a call seen only by its start or only by its end
  // still counts once); calls without an id are counted by start/end events.
  const toolIds = new Set<string>();
  let idlessStarts = 0;
  let idlessEnds = 0;
  let toolErrors = 0;
  let snapshot: AgentEvent | undefined;
  let lastActivity: number | undefined;
  let lastTest: { passed: number; failed: number } | undefined;
  let title: string | undefined;
  let fallbackTitle: string | undefined;
  let model: string | undefined;
  let agentVersion: string | undefined;
  let cwd: string | undefined;
  let repo = prev?.repo;
  let runId: string | undefined;
  let endedAt: number | undefined;
  let endSnapshot = prev?.endSnapshot;
  const traceIds = new Set<string>(prev?.traceIds ?? []);
  let lastEnd: number | undefined;
  const captured = sorted.filter((e) => !isEnrichment(e));
  // Live-ingested (OTel or the SDKs' native batches): no adapter emits a session.end.
  let allLive = captured.length > 0;
  let allTranscript = captured.length > 0;

  // Host app that drove the agent (T3 Code): set on events by the host's adapter
  // or the hook's env marker. The session belongs to the host; the agent it ran
  // stays on the session as provider.
  let via: string | undefined;
  for (const e of sorted) {
    if (isUsageSnapshot(e)) {
      // Latest snapshot wins; equal times keep the larger (running totals only grow).
      if (!snapshot || e.ts > snapshot.ts || (e.ts === snapshot.ts && tokenTotal(e.usage) >= tokenTotal(snapshot.usage))) snapshot = e;
    } else addUsage(usage, e.usage);
    if (isEnrichment(e)) continue;
    if (typeof e.payload.via === "string" && e.payload.via) via ??= e.payload.via;
    if (e.traceId && traceIds.size < MAX_TRACE_IDS) traceIds.add(e.traceId);
    const end = eventEnd(e);
    if (lastEnd === undefined || end > lastEnd) lastEnd = end;
    // When it was stamped, not when it ended: a span that began before the end is not a resume.
    if (e.kind !== "session.end" && (lastActivity === undefined || e.ts > lastActivity)) lastActivity = e.ts;
    if (!e.source?.startsWith("otel") && e.source !== "sdk") allLive = false;
    if (!isBackfillEvent(e)) allTranscript = false;
    if (e.model) model = e.model;
    if (e.agentVersion) agentVersion = e.agentVersion;
    cwd ??= e.cwd;
    runId ??= e.runId;
    // Keep the earliest repo state (the pre-agent snapshot evals replay from).
    // session.end carries the end snapshot, which must not become the start state.
    if (e.repo && e.kind !== "session.end" && (!repo || !repo.snapshot)) repo = { ...e.repo };
    switch (e.kind) {
      case "user.message": {
        const text = typeof e.payload.text === "string" ? e.payload.text : undefined;
        // Harness-injected notices (task completions, command output) are not user turns.
        if (text !== undefined && SYNTHETIC_PROMPT.test(text)) break;
        userMessages++;
        if (title !== undefined || !text?.trim()) break;
        if (COMMAND_PROMPT.test(text)) fallbackTitle ??= commandTitle(text);
        else title = makeTitle(text);
        break;
      }
      case "turn.end":
        // A Stop that fired because a Stop hook blocked the previous one continues the same turn.
        if (e.payload.stopHookActive === true) break;
        if (isBackfillEvent(e)) turnEnds.backfill++;
        else turnEnds.live++;
        if (e.turnId) turnIds.add(e.turnId);
        else if (isBackfillEvent(e)) turnEnds.backfillIdless++;
        else turnEnds.liveIdless++;
        break;
      case "tool.start":
      case "tool.end": {
        // A wrapper (Codex code-mode cell) runs other tool calls; those are the ones counted.
        if (e.payload.wrapper === true) break;
        const id = e.payload.toolUseId;
        if (typeof id === "string" && id) toolIds.add(id);
        else if (e.kind === "tool.start") idlessStarts++;
        else idlessEnds++;
        if (e.kind === "tool.end" && e.payload.ok === false) toolErrors++;
        break;
      }
      case "file.change":
        if (typeof e.payload.path === "string") files.add(e.payload.path);
        break;
      case "test.result":
        lastTest = { passed: num(e.payload.passed) ?? 0, failed: num(e.payload.failed) ?? 0 };
        break;
      case "session.end":
        endedAt = e.ts;
        if (e.repo?.snapshot) endSnapshot = e.repo.snapshot;
        break;
    }
  }

  addUsage(usage, snapshot?.usage);
  // A session.end followed by later captured activity was reopened (resumed
  // under the same id): it is not ended, whatever an earlier build stored.
  const reopened = endedAt !== undefined && lastActivity !== undefined && lastActivity > endedAt + REOPEN_SLACK_MS;
  if (reopened) endedAt = undefined;

  const session: Session = {
    id,
    agent: via ?? first?.agent ?? prev!.agent,
    startedAt: first?.ts ?? prev!.startedAt,
    stats: {
      events: sorted.length,
      // Agents without a turn-end hook still have one turn per prompt.
      turns: turnCount(turnEnds, turnIds) || userMessages,
      // A crashed tool has a start without an end, a lost hook line an end without a start.
      toolCalls: toolIds.size + Math.max(idlessStarts, idlessEnds),
      toolErrors,
      filesChanged: files.size,
    },
    flags: detectFlags(sorted),
  };
  if (lastTest) {
    session.stats.testsPassed = lastTest.passed;
    session.stats.testsFailed = lastTest.failed;
  }
  if (Object.keys(usage).length) session.stats.usage = usage;
  const latency = latencyStats(sorted, endedAt);
  if (Object.keys(latency).length) session.stats.latency = latency;
  const set = <K extends keyof Session>(k: K, v: Session[K] | undefined) => {
    if (v !== undefined) session[k] = v;
  };
  set("agentVersion", agentVersion ?? prev?.agentVersion);
  if (via) set("provider", hostProvider(sorted, via) ?? prev?.provider);
  set("model", model ?? prev?.model);
  set("cwd", cwd ?? prev?.cwd);
  set("repo", repo);
  set("title", title ?? fallbackTitle ?? prev?.title);
  // Sessions that never get a session.end end at their last activity seen so far
  // (see Session.endedAt), a value that moves forward as more events arrive:
  // - conversation-keyed OTel sessions (id is a conversation id, not one of its
  //   traces) and log-keyed ones (OTel logs carry no traceId at all);
  // - SDK sessions (source "sdk", alone or mixed with OTel spans): apps send
  //   events per conversation and rarely a session.end;
  // - sessions known only from a recorded transcript (backfill): a transcript
  //   is history, and it has no end marker.
  // Trace-keyed OTel sessions end with the root span's session.end.
  const endsAtLastActivity = (allLive && !traceIds.has(id)) || allTranscript;
  set("endedAt", endedAt ?? (endsAtLastActivity ? lastEnd : undefined) ?? (reopened ? undefined : prev?.endedAt));
  if (traceIds.size) session.traceIds = [...traceIds];
  set("runId", runId ?? prev?.runId);
  set("endSnapshot", endSnapshot);
  set("parent", parentOf(sorted) ?? prev?.parent);
  const project = sorted.find((e) => e.project)?.project ?? prev?.project;
  if (project && project !== "default") session.project = project;
  set("parseVersion", prev?.parseVersion);
  return session;
}

/**
 * Parent link for a subagent session, from its session.start payload
 * ({ parentSessionId, parentEventId?, subagentId?, subagentType? }).
 * Ingest also links children named by a parent's subagent.* childSessionId.
 */
export function parentOf(sorted: AgentEvent[]): Session["parent"] | undefined {
  const start = sorted.find((e) => e.kind === "session.start" && typeof e.payload.parentSessionId === "string");
  if (!start) return undefined;
  const p = start.payload;
  const parent: NonNullable<Session["parent"]> = { sessionId: p.parentSessionId as string };
  if (typeof p.parentEventId === "string") parent.eventId = p.parentEventId;
  const subagentId = typeof p.subagentId === "string" ? p.subagentId : start.subagentId;
  if (subagentId) parent.subagentId = subagentId;
  if (typeof p.subagentType === "string") parent.type = p.subagentType;
  return parent;
}

/** Nearest-rank percentile of an unsorted list. */
export function percentile(values: number[], p: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

const round = (n: number) => Math.round(n * 10) / 10;

/**
 * Latency aggregates. Tool durations come from tool.end (event.durationMs,
 * then payload.durationMs, then end − matching tool.start ts).
 */
export function latencyStats(sorted: AgentEvent[], endedAt?: number): LatencyStats {
  const out: LatencyStats = {};
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first && last) {
    let end = endedAt ?? last.ts;
    for (const e of sorted) end = Math.max(end, eventEnd(e));
    out.wallMs = Math.max(0, end - first.ts);
  }

  const llm: number[] = [];
  const ttft: number[] = [];
  let llmCalls = 0;
  const toolStartTs = new Map<string, number>();
  const tools: number[] = [];
  const subagents = new Set<string>();
  let anonymousSubagents = 0;

  for (const e of sorted) {
    if (e.kind === "llm.call") {
      llmCalls++;
      const d = num(e.durationMs);
      if (d !== undefined) llm.push(d);
      const t = num(e.payload.ttftMs);
      if (t !== undefined) ttft.push(t);
    } else if (e.kind === "tool.start") {
      if (typeof e.payload.toolUseId === "string") toolStartTs.set(e.payload.toolUseId, e.ts);
    } else if (e.kind === "tool.end" && e.payload.wrapper !== true) {
      let d = num(e.durationMs) ?? num(e.payload.durationMs);
      if (d === undefined && typeof e.payload.toolUseId === "string") {
        const startTs = toolStartTs.get(e.payload.toolUseId);
        if (startTs !== undefined && e.ts >= startTs) d = e.ts - startTs;
      }
      if (d !== undefined) tools.push(d);
    } else if (e.kind === "subagent.start") {
      const id = typeof e.payload.subagentId === "string" ? e.payload.subagentId : e.subagentId;
      if (id) subagents.add(id);
      else anonymousSubagents++;
    }
  }

  if (llmCalls) {
    out.llmCalls = llmCalls;
    if (llm.length) {
      out.llmMs = round(llm.reduce((a, b) => a + b, 0));
      out.llmP50Ms = percentile(llm, 50);
      out.llmP95Ms = percentile(llm, 95);
    }
    if (ttft.length) out.ttftP50Ms = percentile(ttft, 50);
  }
  if (tools.length) {
    out.toolMs = round(tools.reduce((a, b) => a + b, 0));
    out.toolP95Ms = percentile(tools, 95);
  }
  const subagentCount = subagents.size + anonymousSubagents;
  if (subagentCount) out.subagents = subagentCount;
  return out;
}

// ---------------------------------------------------------------- detectors

export function detectFlags(events: AgentEvent[]): string[] {
  const sorted = byTime(events);
  const flags: string[] = [];
  if (detectPrematureCompletion(sorted)) flags.push(FLAGS.prematureCompletion);
  if (detectRepeatedToolFailure(sorted)) flags.push(FLAGS.repeatedToolFailure);
  if (detectNoVerification(sorted)) flags.push(FLAGS.noVerification);
  if (sorted.some((e) => e.kind === "context.compact")) flags.push(FLAGS.compaction);
  if (sorted.some(isGatewayEvent)) flags.push(FLAGS.gateway);
  return flags;
}

/** The agent ended a turn/session while the latest test run was failing, and tests never went green afterwards. */
export function detectPrematureCompletion(sorted: AgentEvent[]): boolean {
  let failing = false;
  let endedWhileFailing = false;
  for (const e of sorted) {
    if (e.kind === "test.result") {
      failing = (num(e.payload.failed) ?? 0) > 0;
      // A later green run means the work was eventually finished.
      if (!failing) endedWhileFailing = false;
    } else if ((e.kind === "turn.end" || e.kind === "session.end") && failing) {
      endedWhileFailing = true;
    }
  }
  return endedWhileFailing;
}

function signature(tool: string, input: unknown): string {
  const cmd = commandOf(input);
  if (cmd !== undefined) return cmd;
  if (input === undefined) return tool;
  return typeof input === "string" ? input : JSON.stringify(input);
}

function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9_./-]+/).filter(Boolean));
}

/** Jaccard similarity of token sets ≥ 0.6, or exact match after whitespace normalization. */
export function similarInputs(a: string, b: string): boolean {
  if (a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim()) return true;
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return false;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter) >= 0.6;
}

/** ≥3 consecutive failures of the same tool with similar input (the agent is stuck retrying). */
export function detectRepeatedToolFailure(sorted: AgentEvent[], threshold = 3): boolean {
  const inputs = new Map<string, unknown>();
  const streaks = new Map<string, { count: number; sig: string }>();
  for (const e of sorted) {
    const id = typeof e.payload.toolUseId === "string" ? e.payload.toolUseId : undefined;
    if (e.kind === "tool.start" && id) inputs.set(id, e.payload.input);
    if (e.kind !== "tool.end") continue;
    const tool = typeof e.payload.tool === "string" ? e.payload.tool : "?";
    if (e.payload.ok !== false) {
      streaks.delete(tool);
      continue;
    }
    const sig = signature(tool, e.payload.input ?? (id ? inputs.get(id) : undefined));
    const prev = streaks.get(tool);
    const count = prev && similarInputs(prev.sig, sig) ? prev.count + 1 : 1;
    if (count >= threshold) return true;
    streaks.set(tool, { count, sig });
  }
  return false;
}

/** Files were changed but nothing was ever run to check them. */
export function detectNoVerification(sorted: AgentEvent[]): boolean {
  if (!sorted.some((e) => e.kind === "file.change")) return false;
  return !sorted.some((e) => e.kind === "test.result" || isVerifyToolStart(e));
}
