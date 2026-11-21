// What a session waits on from the user, folded into Session.stats.waiting:
// a permission prompt, an open question or plan-approval call, or (in a session
// launched interactively) the next prompt after the main thread's turn ended.
// core/work.ts reads it to put a work item in "blocked on you" or "your turn".
// Age rules (a wait left for hours) apply on read, not here.
import type { AgentEvent, Waiting } from "../schema/index.ts";
import { redactShown } from "./redact.ts";
import { isPermissionNotification, QUESTION_TOOL } from "./unapproved.ts";

export { isPermissionNotification };

/** A plan the agent asks the user to approve before it starts (Claude Code's plan mode). */
export const PLAN_TOOL = /^(?:ExitPlanMode|exit_plan_mode)$/i;
/** A call that starts a subagent: it stays open while the subagent runs, so a prompt is never about it. */
const SPAWN_TOOL = /^(?:Agent|Task|spawn_agent|run_subagent)$/;
/** Open calls kept per session; the oldest go first. */
const MAX_OPEN = 64;
const TEXT_MAX = 300;

/** A call that started and has not ended. `thread` is its subagent id, "" for the session's own thread. */
interface OpenCall {
  id?: string;
  tool: string;
  thread: string;
}

/** What the fold keeps. Serializable (node:v8): plain objects and arrays. */
export interface WaitingState {
  open: OpenCall[];
  /** Ids of calls that ended, newest last: a copy of a call's start that arrives after its end opens nothing. */
  ended: string[];
  /** `tool`: the open call the wait is on, when that call has no id (Devin CLI's hooks name none). */
  wait?: Waiting & { thread: string; tool?: string };
}

export const waitingState = (): WaitingState => ({ open: [], ended: [] });

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

function clip(s: string | undefined): string | undefined {
  const t = s?.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  const r = redactShown(t);
  return r.length > TEXT_MAX ? `${r.slice(0, TEXT_MAX - 1)}…` : r;
}

/** The question a question tool asks: `question`, or the first of `questions[]`. */
function questionText(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const i = input as Record<string, unknown>;
  if (str(i.question)) return str(i.question);
  if (Array.isArray(i.questions)) {
    const q = i.questions[0] as Record<string, unknown> | string | undefined;
    return typeof q === "string" ? q : str(q?.question) ?? str(q?.header);
  }
  return str(i.prompt) ?? str(i.message);
}

const planText = (input: unknown): string | undefined =>
  input && typeof input === "object" ? str((input as Record<string, unknown>).plan) : undefined;

/** True for a user.message the harness injected (a task notification, a slash-command echo). */
const SYNTHETIC = /^\s*<(?:task-notification|local-command-(?:stdout|stderr|caveat)|system-reminder|bash-(?:input|stdout|stderr)|user-prompt-submit-hook|command-(?:name|message|args))>/;

export function foldWaiting(s: WaitingState, e: AgentEvent, backfill: boolean): void {
  const thread = e.subagentId ?? "";
  const w = s.wait;
  switch (e.kind) {
    case "tool.start": {
      const tool = str(e.payload.tool) ?? "";
      const id = str(e.payload.toolUseId);
      if (id && s.ended.includes(id)) break;
      if (w && w.thread === thread) s.wait = undefined;
      // A hook and a transcript can both report one call: it is open once.
      if (!id || !s.open.some((c) => c.id === id)) s.open.push(id ? { id, tool, thread } : { tool, thread });
      if (s.open.length > MAX_OPEN) s.open.splice(0, s.open.length - MAX_OPEN);
      if (QUESTION_TOOL.test(tool)) s.wait = wait("question", e, thread, id, questionText(e.payload.input));
      else if (PLAN_TOOL.test(tool)) s.wait = wait("plan", e, thread, id, planText(e.payload.input));
      break;
    }
    case "tool.end": {
      const id = str(e.payload.toolUseId);
      const tool = str(e.payload.tool);
      let at = id ? s.open.findIndex((c) => c.id === id) : -1;
      if (at < 0 && !id) at = s.open.findLastIndex((c) => c.thread === thread && (tool === undefined || c.tool === tool));
      const closed = at >= 0 ? s.open.splice(at, 1)[0] : undefined;
      if (id && !s.ended.includes(id)) {
        s.ended.push(id);
        if (s.ended.length > MAX_OPEN) s.ended.splice(0, s.ended.length - MAX_OPEN);
      }
      if (!w || w.kind === "turn") break;
      // The open call the wait is on ended (answered, approved or refused). With no ids, another
      // tool's call ending on the thread (one that ran beside it) leaves the wait.
      if (w.toolUseId !== undefined ? w.toolUseId === id : w.thread === thread && closed !== undefined && (w.tool === undefined || w.tool === closed.tool)) s.wait = undefined;
      break;
    }
    case "user.message": {
      const text = str(e.payload.text);
      if (w && w.thread === thread && !(text && SYNTHETIC.test(text))) s.wait = undefined;
      break;
    }
    case "notification": {
      // Live hook notifications only: a transcript's notifications (task results, usage) never set or clear it.
      if (backfill || !isPermissionNotification(e)) break;
      // The call it asks about: the last open one on this thread, else the last anywhere (a hook
      // notification may not name the subagent), of the tool the prompt names when one of that
      // tool's calls is open (Devin CLI's prompts name it). A subagent's own call stays open while it runs.
      const named = str(e.payload.tool);
      const open = s.open.filter((c) => !SPAWN_TOOL.test(c.tool));
      const calls = named && open.some((c) => c.tool === named) ? open.filter((c) => c.tool === named) : open;
      const call = calls.findLast((c) => c.thread === thread) ?? calls.at(-1);
      s.wait = wait("permission", e, call?.thread ?? thread, call?.id, str(e.payload.text) ?? str(e.payload.message));
      if (call && !call.id) s.wait.tool = call.tool;
      break;
    }
    case "turn.end":
      // The main thread's turn: kept for every session, shown only for one launched interactively (waitingOf).
      if (!thread && (!w || w.kind === "turn")) s.wait = { kind: "turn", at: e.ts, thread };
      break;
    case "session.end": {
      // A subagent's end (stored in its parent's session) ends only a wait on its own thread.
      if (thread && w && w.thread !== thread) break;
      // A transcript's quiet marker (reason "idle") ends a turn wait, not an open prompt:
      // a prompt left open in a terminal stays blocked, and its age is shown on read.
      if (backfill && e.payload.reason === "idle") {
        if (w?.kind === "turn") s.wait = undefined;
        break;
      }
      s.wait = undefined;
      s.open = thread ? s.open.filter((c) => c.thread !== thread) : [];
      break;
    }
  }
}

function wait(kind: Waiting["kind"], e: AgentEvent, thread: string, toolUseId: string | undefined, text: string | undefined): NonNullable<WaitingState["wait"]> {
  const out: NonNullable<WaitingState["wait"]> = { kind, at: e.ts, thread };
  if (toolUseId) out.toolUseId = toolUseId;
  const t = clip(text);
  if (t) out.text = t;
  return out;
}

/** Session.stats.waiting, or undefined when nothing waits. A turn wait counts only in a session launched interactively. */
export function waitingOf(s: WaitingState | undefined, launch: "headless" | "interactive" | undefined): Waiting | undefined {
  const w = s?.wait;
  if (!w || (w.kind === "turn" && launch !== "interactive")) return undefined;
  const { thread: _thread, tool: _tool, ...out } = w;
  return out;
}
