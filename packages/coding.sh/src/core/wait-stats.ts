// How often and how long a session waited on the person, folded into Session.stats.waits.
// core/waiting.ts says what a session waits on now; this module counts every wait from
// its start to its end, by kind:
// - permission: a permission prompt, from the prompt to the call's end (approved, refused) or,
//   with no end, the next call, turn end or prompt on its thread; a host app's approval
//   request (T3 Code) to its resolution.
// - question, plan: an open question or plan-approval call, from its start to its end.
// - request: any other request a host app put to the person (T3 Code's secrets and links).
// - turn: the main thread's turn ended, until the person's next prompt (a session launched
//   interactively, not a subagent: waitStatsOf).
// A turn wait that an agent's prompt ended (a task notification, a delegated result, another
// thread's message), or that ended when the agent went on by itself, counts apart (`agent`).
// A prompt is an agent's when its payload says so (from: "agent"), its text is a harness notice,
// or a host's marker names it (HOST_AGENT_PROMPT: T3 Code's store says who made a prompt that a
// Codex or Claude transcript holds). A marker names the transcript prompt's event; a live copy
// of that prompt (a hook's, with its own id) is the prompt that reads as the person's closest
// to it, within HOST_MARK_SLACK_MS.
// A prompt the person sent while the main thread's turn ran is a steer.
// A wait still open counts up to the session's end, a resume, or the last event, as unanswered.
// A wait counts 12 hours at most: a session with no resume marker (a transcript) picked up days
// later would otherwise count the days.
//
// sessions.ts imports this module and this one imports from it: only functions are
// exported here, and its values are read inside functions.
import type { AgentEvent, WaitKind, WaitStats, WaitTotal } from "../schema/index.ts";
import { DELEGATED_NOTICE, isSyntheticPrompt, percentile } from "./sessions.ts";
import { QUESTION_TOOL, SPAWN_TOOL } from "./unapproved.ts";
import { HOST_AGENT_PROMPT, HOST_MARK_SLACK_MS, HOST_QUESTION, HOST_RESOLVED, isPermissionNotification, PLAN_TOOL, type WaitingState } from "./waiting.ts";

/** A wait counts this long at most: a longer one is the person away (a session picked up days later). */
const WAIT_CAP_MS = 12 * 3600_000;
/**
 * Clock slack between capture paths: a call or reply this long after the turn's end is
 * the agent going on by itself, and a prompt this close to that is the one it answers.
 */
const SLACK_MS = 5_000;
/** Durations kept per kind for the median. */
const SAMPLES_MAX = 500;
/** Host markers kept for prompts not yet seen; the oldest go first. */
const MARKS_MAX = 64;
/** Claude Code's marker for a turn the person stopped (Esc). */
const INTERRUPTED = /^\s*\[Request interrupted by user/;
/** A background task's result, posted to the agent as a prompt (Claude Code). */
const TASK_NOTICE = /^\s*<task-notification>/;
/** T3 Code request kinds that approve an action. */
const APPROVAL_KINDS = new Set(["command", "file-change", "file-read", "permission"]);

/** A wait not yet ended. `thread` is its subagent id, "" for the session's own thread. */
interface OpenWait {
  kind: WaitKind;
  at: number;
  thread: string;
  /** The tool call it waits on. */
  id?: string;
  /** That call's tool, when the call has no id (Devin CLI's hooks name none). */
  tool?: string;
  /** Host requests it is (T3 Code): their resolution ends it. */
  requests?: string[];
  /** A turn wait: when the agent went on by itself (a call or reply well after the turn ended). */
  resumed?: number;
}

interface KindTally {
  count: number;
  ms: number;
  samples: number[];
  open: number;
  openMs: number;
  capped: number;
}

interface Tally {
  kinds: Partial<Record<WaitKind, KindTally>>;
  /** Turn waits an agent's prompt ended, or the agent itself. */
  agent: { count: number; ms: number };
}

/** What the fold keeps. Serializable (node:v8): plain objects and arrays. */
export interface WaitStatsState extends Tally {
  waits: OpenWait[];
  steers: number;
  /** The main thread's turn is running: a prompt came and no turn end since. */
  running: boolean;
  /** A main-thread turn end was seen: without one every prompt would look like a steer. */
  turns: boolean;
  /** The main thread did something other than a notification: a session.start now is a resume. */
  begun?: true;
  /** The last event's time. */
  last?: number;
  /** The person's last prompt. */
  lastPrompt?: number;
  /** Prompts a host marked as an agent's (HOST_AGENT_PROMPT) that have not come yet: the prompt's event id and time. */
  marks?: { id: string; at: number }[];
}

export function waitStatsState(): WaitStatsState {
  return { waits: [], kinds: {}, agent: { count: 0, ms: 0 }, steers: 0, running: false, turns: false };
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** Who sent a main-thread prompt: the person, an agent, or the person stopping the turn. Undefined: harness markup. */
function promptBy(e: AgentEvent): "person" | "agent" | "interrupt" | undefined {
  const text = str(e.payload.text) ?? "";
  if (e.payload.from === "agent" || TASK_NOTICE.test(text) || DELEGATED_NOTICE.test(text)) return "agent";
  if (INTERRUPTED.test(text)) return "interrupt";
  return isSyntheticPrompt(text) ? undefined : "person";
}

/** A host's marker: the prompt it names is an agent's. */
function mark(s: WaitStatsState, e: AgentEvent): void {
  const id = str(e.payload.promptId);
  const at = e.payload.at;
  if (!id || typeof at !== "number") return;
  const marks = (s.marks ??= []);
  marks.push({ id, at });
  if (marks.length > MARKS_MAX) marks.splice(0, marks.length - MARKS_MAX);
}

/**
 * True when a host marked this main-thread prompt as an agent's: its own event, or with `near`
 * (a live copy, which has its own id) the marked prompt closest in time, within HOST_MARK_SLACK_MS.
 * Uses the marker up, and drops markers whose prompt did not come by now.
 */
function marked(s: WaitStatsState, e: AgentEvent, near: boolean): boolean {
  if (!s.marks?.length) return false;
  const marks = s.marks.filter((m) => m.at >= e.ts - HOST_MARK_SLACK_MS);
  let at = marks.findIndex((m) => m.id === e.id);
  if (at < 0 && near) {
    for (let i = 0; i < marks.length; i++) {
      const gap = Math.abs(marks[i]!.at - e.ts);
      if (gap <= HOST_MARK_SLACK_MS && (at < 0 || gap < Math.abs(marks[at]!.at - e.ts))) at = i;
    }
  }
  if (at >= 0) marks.splice(at, 1);
  s.marks = marks.length ? marks : undefined;
  return at >= 0;
}

/** A host request that is not a tool call's: only its resolution ends it. */
const hostOnly = (w: OpenWait): boolean => !!w.requests?.length && w.id === undefined && w.tool === undefined;

const mainTurn = (s: WaitStatsState): OpenWait | undefined => s.waits.find((w) => w.kind === "turn");

/** Counts a wait that ended at `end`: the person's, unanswered ("open"), or an agent's (a turn wait only). */
function tally(t: Tally, w: OpenWait, end: number, how: "person" | "open" | "agent"): void {
  const span = end - w.at;
  if (span <= 0) return;
  const ms = Math.min(span, WAIT_CAP_MS);
  if (how === "agent") {
    t.agent.count++;
    t.agent.ms += ms;
    return;
  }
  const k = (t.kinds[w.kind] ??= { count: 0, ms: 0, samples: [], open: 0, openMs: 0, capped: 0 });
  k.count++;
  k.ms += ms;
  if (k.samples.length < SAMPLES_MAX) k.samples.push(ms);
  if (span > WAIT_CAP_MS) k.capped++;
  if (how === "open") {
    k.open++;
    k.openMs += ms;
  }
}

/** Ends the waits `pick` selects at `end`. Unanswered: counted open (a turn wait the agent went on from: its part before that, as an agent's). */
function close(s: WaitStatsState, pick: (w: OpenWait) => boolean, end: number, how: "person" | "open"): void {
  const keep: OpenWait[] = [];
  for (const w of s.waits) {
    if (!pick(w)) keep.push(w);
    else if (how === "open" && w.resumed !== undefined) tally(s, w, w.resumed, "agent");
    else tally(s, w, end, how);
  }
  s.waits = keep;
}

function open(s: WaitStatsState, w: OpenWait): void {
  s.waits.push(w);
}

/** The agent did something on the main thread: a turn wait open well before it ended when the agent went on. */
function activity(s: WaitStatsState, ts: number): void {
  const w = mainTurn(s);
  if (w && w.resumed === undefined && ts - w.at > SLACK_MS) w.resumed = ts;
}

/** An agent's prompt on the main thread (a task notification, a delegated result, another thread's message) ended the turn wait. */
function agentPrompt(s: WaitStatsState, ts: number): void {
  const w = mainTurn(s);
  if (w) {
    tally(s, w, w.resumed ?? ts, "agent");
    s.waits = s.waits.filter((x) => x !== w);
  }
  s.running = true;
}

/** The main thread's turn ended (or the person stopped it): the turn wait starts, unless one already runs. */
function turnEnded(s: WaitStatsState, ts: number, restart: boolean): void {
  s.running = false;
  s.turns = true;
  const w = mainTurn(s);
  if (!w) open(s, { kind: "turn", at: ts, thread: "" });
  else if (restart) {
    // A Stop a Stop hook blocked was no end: the turn ends now.
    w.at = ts;
    delete w.resumed;
  } else if (w.resumed !== undefined) {
    // The agent went on by itself and ended another turn: the wait before that was not on the person.
    tally(s, w, w.resumed, "agent");
    s.waits = s.waits.filter((x) => x !== w);
    open(s, { kind: "turn", at: ts, thread: "" });
  }
  // Otherwise a second copy of the same end (another capture path): the wait keeps its start.
}

export function foldWaitStats(s: WaitStatsState, waiting: WaitingState, e: AgentEvent, backfill: boolean): void {
  const thread = e.subagentId ?? "";
  // A resume: what waited ended where the session stopped, unanswered.
  if (e.kind === "session.start" && !thread && s.begun && s.last !== undefined && e.payload.source !== "compact") {
    close(s, () => true, s.last, "open");
    s.running = false;
  }
  s.last = Math.max(s.last ?? e.ts, e.ts);
  if (!thread && e.kind !== "notification") s.begun = true;
  if (e.kind === "notification" && str(e.payload.requestId)) {
    hostRequest(s, waiting, e, thread);
    return;
  }
  switch (e.kind) {
    case "user.message": {
      // A subagent's prompt is its parent's, not the person's.
      if (thread) break;
      const by = promptBy(e);
      // A live copy of a marked prompt reads as the person's: only such a prompt is matched by time.
      const agent = by === "agent" || by === "person" ? marked(s, e, by === "person" && !backfill) : false;
      if (by === "agent" || agent) agentPrompt(s, e.ts);
      else if (by === "interrupt") turnEnded(s, e.ts, false);
      else if (by === "person") personPrompt(s, e.ts);
      break;
    }
    case "notification": {
      if (e.payload.type === HOST_AGENT_PROMPT) {
        if (!thread) mark(s, e);
        break;
      }
      if (e.payload.kind === "task-notification") {
        if (!thread) agentPrompt(s, e.ts);
        break;
      }
      // Live hook prompts only: a transcript's notifications never set one.
      if (backfill || !isPermissionNotification(e)) break;
      permissionPrompt(s, waiting, e, thread);
      break;
    }
    case "tool.start": {
      const id = str(e.payload.toolUseId);
      // A copy of a call that already ended.
      if (id && waiting.ended.includes(id)) break;
      const tool = str(e.payload.tool) ?? "";
      // The thread went on: a prompt or question on another call was answered.
      close(s, (w) => w.thread === thread && w.kind !== "turn" && !hostOnly(w) && (id === undefined || w.id !== id), e.ts, "person");
      const kind = QUESTION_TOOL.test(tool) ? "question" : PLAN_TOOL.test(tool) ? "plan" : undefined;
      if (kind && !(id && s.waits.some((w) => w.id === id))) {
        // The host request this call raised, if it sorted first (T3 Code asks a question tool's question itself).
        const host = s.waits.find((w) => w.thread === thread && hostOnly(w) && (w.kind === "question" || w.kind === "request"));
        if (host) Object.assign(host, { kind }, id ? { id } : { tool });
        else open(s, { kind, at: e.ts, thread, ...(id ? { id } : { tool }) });
      }
      if (!thread) activity(s, e.ts);
      break;
    }
    case "tool.end": {
      const id = str(e.payload.toolUseId);
      const tool = str(e.payload.tool);
      // The open call this end closes, found as foldWaiting finds it (it has not seen this event yet).
      const call = id ? waiting.open.find((c) => c.id === id) : waiting.open.findLast((c) => c.thread === thread && (tool === undefined || c.tool === tool));
      close(s, (w) => {
        if (w.kind === "turn" || hostOnly(w)) return false;
        if (w.id !== undefined) return w.id === id;
        return w.thread === thread && call !== undefined && (w.tool === undefined || w.tool === call.tool);
      }, e.ts, "person");
      break;
    }
    case "assistant.message":
      if (!thread) activity(s, e.ts);
      break;
    case "turn.end": {
      // A turn does not end on an open prompt: it was answered (a refusal ends the turn).
      close(s, (w) => w.thread === thread && w.kind !== "turn" && !hostOnly(w), e.ts, "person");
      if (thread) break;
      // A transcript's end written at the next prompt (Claude Code) that sorted after it belongs to the turn before.
      if (e.payload.synthesized === true && s.lastPrompt !== undefined && e.ts >= s.lastPrompt && e.ts - s.lastPrompt <= SLACK_MS && s.running) break;
      turnEnded(s, e.ts, e.payload.stopHookActive === true);
      break;
    }
    case "session.end": {
      // A subagent's end (stored in its parent's session) ends only its own waits.
      if (thread) {
        close(s, (w) => w.thread === thread, e.ts, "open");
        break;
      }
      // A transcript's quiet marker ends nothing: it says when the transcript went quiet, not that
      // anyone answered. Each backfill that finds the transcript quiet stores one at its last entry,
      // so a session resumed later keeps the old ones, and the next prompt still ends the wait.
      if (backfill && e.payload.reason === "idle") break;
      close(s, () => true, e.ts, "open");
      s.running = false;
      break;
    }
  }
}

/** The person's prompt on the main thread: it answers what waited there; sent while the turn ran, it is a steer. */
function personPrompt(s: WaitStatsState, ts: number): void {
  s.lastPrompt = ts;
  const turn = mainTurn(s);
  if (turn?.resumed !== undefined && ts - turn.resumed > SLACK_MS) {
    // The agent went on before this prompt: the wait ended then, not on the person.
    tally(s, turn, turn.resumed, "agent");
    s.waits = s.waits.filter((w) => w !== turn);
  } else if (!turn && s.running) s.steers++;
  close(s, (w) => w.thread === "", ts, "person");
  s.running = true;
}

/** A live permission prompt: the call it asks about, picked as foldWaiting picks it. */
function permissionPrompt(s: WaitStatsState, waiting: WaitingState, e: AgentEvent, thread: string): void {
  const named = str(e.payload.tool);
  const calls = waiting.open.filter((c) => !SPAWN_TOOL.test(c.tool));
  const of = named && calls.some((c) => c.tool === named) ? calls.filter((c) => c.tool === named) : calls;
  const call = of.findLast((c) => c.thread === thread) ?? of.at(-1);
  const on = call?.thread ?? thread;
  const same = (w: OpenWait) => w.kind === "permission" && w.thread === on && (call?.id !== undefined ? w.id === call.id : w.id === undefined && w.tool === call?.tool);
  // The same prompt again (a reminder, or the hook and the host both report it): one wait.
  if (s.waits.some(same)) return;
  // A prompt on another call of the thread: the one before was answered.
  close(s, (w) => w.kind === "permission" && w.thread === on && !hostOnly(w), e.ts, "person");
  // The host's request for this approval sorted first (T3 Code): the prompt joins its wait.
  const host = s.waits.findLast((w) => w.kind === "permission" && w.thread === on && hostOnly(w));
  const wait: OpenWait = host ?? { kind: "permission", at: e.ts, thread: on };
  if (call?.id !== undefined) wait.id = call.id;
  else if (call) wait.tool = call.tool;
  if (!host) open(s, wait);
}

/** What a host request asks for: an approval, a question, or something else (a secret, a link). */
function hostKind(e: AgentEvent): WaitKind {
  const kind = str(e.payload.requestKind);
  if (kind ? APPROVAL_KINDS.has(kind) : e.payload.type !== HOST_QUESTION) return "permission";
  if (e.payload.type === HOST_QUESTION && (kind === undefined || kind === "user_input")) return "question";
  return "request";
}

/** A request from a host app's store (T3 Code): it waits until a resolved notification names its id. */
function hostRequest(s: WaitStatsState, waiting: WaitingState, e: AgentEvent, thread: string): void {
  const id = str(e.payload.requestId)!;
  if (e.payload.type === HOST_RESOLVED) {
    close(s, (w) => w.requests?.includes(id) === true, e.ts, "person");
    return;
  }
  if (e.payload.type !== HOST_QUESTION && !isPermissionNotification(e)) return;
  // Resolved at the time it was asked (the resolution sorted first), or already open.
  if (waiting.ended.includes(id) || s.waits.some((w) => w.requests?.includes(id))) return;
  const kind = hostKind(e);
  // The prompt or call it is about, already waiting on the thread: one wait.
  const same = s.waits.find((w) => w.thread === thread && !w.requests?.length && (kind === "permission" ? w.kind === "permission" : w.kind === "question" || w.kind === "plan"));
  if (same) same.requests = [id];
  else open(s, { kind, at: e.ts, thread, requests: [id] });
}

/**
 * Session.stats.waits, or undefined when the session never waited on the person and nobody
 * steered. Turn waits, `agent` and `steers` count only in a session launched interactively that
 * is not a subagent. Waits still open count up to the last event, as unanswered. Leaves the state as it was.
 */
export function waitStatsOf(s: WaitStatsState | undefined, o: { launch?: "headless" | "interactive"; subagent?: boolean }): WaitStats | undefined {
  if (!s) return undefined;
  const turns = o.launch === "interactive" && !o.subagent;
  const t: Tally = { kinds: structuredClone(s.kinds), agent: { ...s.agent } };
  for (const w of s.waits) tally(t, w, w.resumed ?? s.last ?? w.at, w.resumed !== undefined ? "agent" : "open");
  const byKind: Partial<Record<WaitKind, WaitTotal>> = {};
  const samples: number[] = [];
  let count = 0;
  let ms = 0;
  let openCount = 0;
  let openMs = 0;
  let capped = 0;
  for (const kind of ["permission", "question", "plan", "request", "turn"] as const) {
    const k = t.kinds[kind];
    if (!k?.count || (kind === "turn" && !turns)) continue;
    const total: WaitTotal = { count: k.count, ms: k.ms };
    if (k.count > 1) total.medianMs = percentile(k.samples, 50);
    if (k.open) total.open = k.open;
    byKind[kind] = total;
    samples.push(...k.samples);
    count += k.count;
    ms += k.ms;
    openCount += k.open;
    openMs += k.openMs;
    capped += k.capped;
  }
  const steers = turns && s.turns ? s.steers : 0;
  if (!count && !steers) return undefined;
  const out: WaitStats = { count, ms, byKind };
  const median = count > 1 ? percentile(samples, 50) : undefined;
  if (median !== undefined) out.medianMs = median;
  if (openCount) out.open = { count: openCount, ms: openMs };
  if (turns && t.agent.count) out.agent = t.agent;
  if (steers) out.steers = steers;
  if (capped) out.capped = capped;
  return out;
}
