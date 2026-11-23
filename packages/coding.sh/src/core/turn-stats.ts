// Turns by the model that ran them, and edit and shell calls with their real failures, folded into
// Session.stats.turnsByModel, edits and shells. The model scorecard (`coding.sh stats --scorecard`)
// adds them up.
//
// A turn is a prompt the person sent and the agent's work until their next prompt. core/wait-stats.ts
// says who sent a prompt: an agent's prompt (a task notification, a delegated result, a prompt a
// host marked as an agent's) goes on with the turn, harness markup is no prompt, and a prompt in a
// subagent's thread is its parent's. A prompt the person sent while the turn ran (a steer) starts
// the next turn.
// - model: the one that made most of the turn's main-thread model calls (the one called first wins
//   a tie), counting the agent's own calls, else the copies its OTLP logs carry, else the proxy's;
//   the session's model when the turn made none.
// - replied, pushback: the person's next prompt answers the turn before it. A prompt with text
//   counts in `replied`, and pushbackKind (core/pushback.ts) names how it pushed back, if it did.
// - cancelled: the person stopped the turn. Claude Code writes a "[Request interrupted by user"
//   prompt; Codex, OpenCode, Cursor and Pi say so on the turn's end (STOPPED). CANCEL_AGENTS names
//   the agents that record it. A turn whose prompt another agent's capture holds counts in
//   cancelNotRecorded instead, never in cancelled: a T3 Code thread built from T3 Code's own store
//   has only T3 Code's events, whatever agent the thread ran.
// - durationsMs: from the prompt to the end of the turn's last work (a model call, a tool call, a
//   message, a turn end the agent recorded, the person stopping it), on every thread, with the time
//   it waited on the person (a permission prompt) or on a background task. A transcript's
//   synthesized turn end and a compaction are not work. A resume ends the turn's work: what comes
//   after it, before the person's next prompt, counts in no turn.
// The turn still running counts as well, with no reply yet. Turns count only in a session launched
// interactively that is not a subagent (sessionOf calls turnsByModelOf for those), as turn waits do.
//
// edits and shells count the file-edit and shell calls (adapters/_shared/tools.ts) that ended, on
// every thread, and the ones that failed for real (core/failures.ts). A call two capture paths
// recorded counts once, by its toolUseId, as core/retrieval.ts counts calls.
import type { AgentEvent, CallTally, PushbackKind, TurnTally } from "../schema/index.ts";
import { isFileEditTool, isShellCall } from "../adapters/_shared/tools.ts";
import type { ToolFailure } from "./failures.ts";
import { modelOf } from "./models.ts";
import { PUSHBACK_KINDS, pushbackKind } from "./pushback.ts";
import type { PromptBy } from "./wait-stats.ts";

/** Turn durations kept per model, for the median and the quartiles. */
const SAMPLES_MAX = 500;
/** Edit and shell calls started and not yet ended, kept by toolUseId; the oldest go first. */
const OPEN_MAX = 256;
/** Calls started with no toolUseId, kept per thread and tool, and how many such queues. */
const IDLESS_MAX = 64;
const QUEUES_MAX = 64;

/**
 * How an agent's turn end says the person stopped the turn. Claude Code says it with a prompt instead.
 * - codex: turn_aborted's reason, or "aborted" when it names none. A turn "replaced" by another or
 *   "review_ended" was not stopped by the person.
 * - opencode: session.execution.interrupted.
 * - cursor: the stop hook's status.
 * - pi: agent_settled's `aborted`, or the session file's stop reason.
 */
const STOPPED = new Map<string, (p: Record<string, unknown>) => boolean>([
  ["codex", (p) => p.status === "interrupted" || p.status === "aborted"],
  ["opencode", (p) => p.status === "interrupted"],
  ["cursor", (p) => p.status === "aborted"],
  ["pi", (p) => p.aborted === true || p.stopReason === "aborted"],
]);

/** Agents whose captures record a turn the person stopped: the scorecard counts cancelled turns only in their sessions. */
export const CANCEL_AGENTS: ReadonlySet<string> = new Set(["claude-code", ...STOPPED.keys()]);

type CallKind = "edit" | "shell";

/** One model's closed turns. */
interface ModelTurns {
  turns: number;
  replied: number;
  pushback: Partial<Record<PushbackKind, number>>;
  cancelled: number;
  /** Turns whose capture does not record a stop: cancelled does not count them. */
  notRecorded: number;
  durations: number[];
}

/** The turn running, or the last one: the person's prompt and the work since. */
interface OpenTurn {
  at: number;
  /** The end of its last work so far. */
  end?: number;
  /** Its main-thread model calls by model, in the order first called: the agent's own, its OTLP logs' copies, the proxy's. */
  own: Map<string, number>;
  otel: Map<string, number>;
  proxy: Map<string, number>;
  /** The person stopped it. */
  cancelled?: true;
  /** Its prompt came from the capture of an agent that does not record a stop (not in CANCEL_AGENTS). */
  notRecorded?: true;
  /** The session was resumed after its last work: nothing more counts in it. */
  idle?: true;
}

/** What the fold keeps. Serializable (node:v8): maps, plain objects and arrays. */
export interface TurnStatsState {
  turn?: OpenTurn;
  /** Closed turns by model, "" for a turn that made no model call (the session's model, in turnsByModelOf). */
  byModel: Map<string, ModelTurns>;
  edits: { calls: number; failed: number };
  shells: { calls: number; failed: number };
  /** Edit and shell calls started and not yet ended, by toolUseId. */
  open: Map<string, CallKind>;
  /** Calls started with no toolUseId, per thread and tool, oldest first: an edit, a shell call, or another (null). */
  idless: Map<string, (CallKind | null)[]>;
}

export function turnStatsState(): TurnStatsState {
  return { byModel: new Map(), edits: { calls: 0, failed: 0 }, shells: { calls: 0, failed: 0 }, open: new Map(), idless: new Map() };
}

/** What foldSession knows about an event that this fold reads. */
export interface TurnFacts {
  /** Who sent a main-thread prompt, as foldWaitStats read it. */
  by?: PromptBy;
  /** A proxy's model call. */
  proxyCall: boolean;
  /** A copy of a model call or tool event that an agent's OTLP logs carry. */
  otelCopy: boolean;
  /** How a failed tool end failed (foldFailure). */
  failure?: ToolFailure;
  /** toolUseIds of the events folded before this one. */
  seen: ReadonlySet<string>;
  /** When what the event describes ended (eventEnd). */
  end: number;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

const noTurns = (): ModelTurns => ({ turns: 0, replied: 0, pushback: {}, cancelled: 0, notRecorded: 0, durations: [] });

/** Folds the next event (in time order). Enrichment events never reach it. */
export function foldTurnStats(s: TurnStatsState, e: AgentEvent, o: TurnFacts): void {
  if (e.kind === "tool.start" || e.kind === "tool.end") foldCall(s, e, o);
  const t = s.turn;
  if (e.kind === "user.message") {
    if (o.by === "person") {
      if (t) close(s, t, str(e.payload.text));
      s.turn = { at: e.ts, own: new Map(), otel: new Map(), proxy: new Map() };
      if (!CANCEL_AGENTS.has(e.agent)) s.turn.notRecorded = true;
    } else if (o.by === "interrupt" && t && !t.idle) {
      t.cancelled = true;
      t.end = Math.max(t.end ?? e.ts, e.ts);
    }
    return;
  }
  if (!t || t.idle || e.kind === "session.end" || e.kind === "notification") return;
  if (e.kind === "session.start") {
    // A resume, not a compaction, after the turn's last work. Ties keep the store's order, so a start
    // stamped with the prompt's time is no resume.
    if (!e.subagentId && e.payload.source !== "compact" && t.end !== undefined && e.ts > t.end) t.idle = true;
    return;
  }
  // Not the turn's work: a transcript's synthesized end (Claude Code) is stamped when the next prompt
  // was written, and a compaction between turns is one the person asked for (/compact). One in the
  // middle of a turn is followed by the work it made room for.
  if (e.kind === "context.compact" || (e.kind === "turn.end" && e.payload.synthesized === true)) return;
  t.end = Math.max(t.end ?? o.end, o.end);
  if (e.subagentId) return;
  if (e.kind === "llm.call") {
    const model = modelOf(e);
    if (!model) return;
    const calls = o.proxyCall ? t.proxy : o.otelCopy ? t.otel : t.own;
    calls.set(model, (calls.get(model) ?? 0) + 1);
  } else if (e.kind === "turn.end" && STOPPED.get(e.agent)?.(e.payload)) t.cancelled = true;
}

/** The model that made most of the turn's calls, the first one called on a tie; "" when it made none. */
function turnModel(t: OpenTurn): string {
  for (const calls of [t.own, t.otel, t.proxy]) {
    let best: string | undefined;
    let most = 0;
    for (const [model, n] of calls) {
      if (n > most) {
        best = model;
        most = n;
      }
    }
    if (best !== undefined) return best;
  }
  return "";
}

/** Counts a turn in its model's tally: the turn, whether the person stopped it (or that its capture does not say), and how long it ran. */
function count(m: ModelTurns, t: OpenTurn): void {
  m.turns++;
  if (t.notRecorded) m.notRecorded++;
  else if (t.cancelled) m.cancelled++;
  const ms = t.end === undefined ? 0 : Math.round(t.end - t.at);
  if (ms > 0 && m.durations.length < SAMPLES_MAX) m.durations.push(ms);
}

/** The person's next prompt closed the turn: it counts, and the prompt is its reply. */
function close(s: TurnStatsState, t: OpenTurn, reply: string | undefined): void {
  const key = turnModel(t);
  let m = s.byModel.get(key);
  if (!m) s.byModel.set(key, (m = noTurns()));
  count(m, t);
  if (!reply?.trim()) return;
  m.replied++;
  const kind = pushbackKind(reply);
  if (kind) m.pushback[kind] = (m.pushback[kind] ?? 0) + 1;
}

/** An edit, a shell call, or neither, from a tool event's own tool and input. */
function callKind(p: Record<string, unknown>): CallKind | undefined {
  const tool = str(p.tool);
  if (!tool) return undefined;
  return isFileEditTool(tool) ? "edit" : isShellCall(tool, p.input) ? "shell" : undefined;
}

const queueOf = (e: AgentEvent): string => `${e.subagentId ?? ""}\u0000${typeof e.payload.tool === "string" ? e.payload.tool.toLowerCase() : ""}`;

/**
 * An edit or shell call counts when it ends, once per toolUseId: its start says what it is, and an
 * end whose start was never seen says it itself. A call with no id pairs with the oldest start of
 * its tool on its thread. A wrapper (a Codex code-mode cell) is not counted; the calls it runs are.
 */
function foldCall(s: TurnStatsState, e: AgentEvent, o: TurnFacts): void {
  const p = e.payload;
  if (p.wrapper === true) return;
  const id = str(p.toolUseId);
  if (e.kind === "tool.start") {
    if (id) {
      if (o.seen.has(id)) return;
      const kind = callKind(p);
      if (!kind) return;
      s.open.set(id, kind);
      if (s.open.size > OPEN_MAX) s.open.delete(s.open.keys().next().value!);
      return;
    }
    const key = queueOf(e);
    let q = s.idless.get(key);
    if (!q) {
      if (s.idless.size >= QUEUES_MAX) s.idless.delete(s.idless.keys().next().value!);
      s.idless.set(key, (q = []));
    }
    q.push(callKind(p) ?? null);
    if (q.length > IDLESS_MAX) q.shift();
    return;
  }
  let kind: CallKind | undefined;
  if (id) {
    kind = s.open.get(id);
    if (kind) s.open.delete(id);
    // A copy of an end already counted, or the end of another tool's call.
    else if (o.seen.has(id)) return;
  } else {
    const key = queueOf(e);
    const q = s.idless.get(key);
    if (q) {
      const started = q.shift();
      if (!q.length) s.idless.delete(key);
      if (!started) return;
      kind = started;
    }
  }
  kind ??= callKind(p);
  if (!kind) return;
  const tally = kind === "edit" ? s.edits : s.shells;
  tally.calls++;
  if (p.ok === false && (!o.failure || o.failure.cls === "real")) tally.failed++;
}

/**
 * Session.stats.turnsByModel: the closed turns and the one still running, by model, with the turns
 * that made no model call under `model` (the session's; "" when it has none). Undefined when the
 * person sent no prompt. Leaves the state as it was.
 */
export function turnsByModelOf(s: TurnStatsState, model: string | undefined): Record<string, TurnTally> | undefined {
  const merged = new Map<string, ModelTurns>();
  const add = (key: string, m: ModelTurns): void => {
    const k = key || model || "";
    let to = merged.get(k);
    if (!to) merged.set(k, (to = noTurns()));
    to.turns += m.turns;
    to.replied += m.replied;
    to.cancelled += m.cancelled;
    to.notRecorded += m.notRecorded;
    for (const kind of PUSHBACK_KINDS) {
      const n = m.pushback[kind];
      if (n) to.pushback[kind] = (to.pushback[kind] ?? 0) + n;
    }
    for (const d of m.durations) {
      if (to.durations.length >= SAMPLES_MAX) break;
      to.durations.push(d);
    }
  };
  for (const [key, m] of s.byModel) add(key, m);
  if (s.turn) {
    const m = noTurns();
    count(m, s.turn);
    add(turnModel(s.turn), m);
  }
  if (!merged.size) return undefined;
  const out: Record<string, TurnTally> = {};
  for (const [k, m] of merged) {
    const t: TurnTally = { turns: m.turns };
    if (m.replied) t.replied = m.replied;
    if (Object.keys(m.pushback).length) t.pushback = m.pushback;
    if (m.cancelled) t.cancelled = m.cancelled;
    if (m.notRecorded) t.cancelNotRecorded = m.notRecorded;
    if (m.durations.length) t.durationsMs = m.durations;
    out[k] = t;
  }
  return out;
}

const tallyOf = (t: { calls: number; failed: number }): CallTally | undefined => (t.calls ? (t.failed ? { calls: t.calls, failed: t.failed } : { calls: t.calls }) : undefined);

/** Session.stats.edits and Session.stats.shells, each unset when no such call ended. */
export function callStatsOf(s: TurnStatsState): { edits?: CallTally; shells?: CallTally } {
  const out: { edits?: CallTally; shells?: CallTally } = {};
  const edits = tallyOf(s.edits);
  const shells = tallyOf(s.shells);
  if (edits) out.edits = edits;
  if (shells) out.shells = shells;
  return out;
}
