// What a session waits on from the user, folded into Session.stats.waiting:
// a permission prompt, an open question or plan-approval call, a request a host app's
// store reports open (T3 Code's approvals and questions), or (in a session launched
// interactively) the next prompt after the main thread's turn ended.
// core/work.ts reads it to put a work item in "blocked on you" or "your turn".
// Age rules (a wait left for hours) apply on read, not here.
import type { AgentEvent, Waiting } from "../schema/index.ts";
import { redactShown } from "./redact.ts";
import { HOST_QUESTION, isPermissionNotification, QUESTION_TOOL, SPAWN_TOOL } from "./unapproved.ts";

export { HOST_QUESTION, isPermissionNotification };

/** A plan the agent asks the user to approve before it starts (Claude Code's plan mode). */
export const PLAN_TOOL = /^(?:ExitPlanMode|exit_plan_mode)$/i;
/**
 * A host app's store (T3 Code) reports a request to the user as a notification with a
 * `requestId`: type `permission_prompt` (an approval) or HOST_QUESTION (a question), and this
 * type once the request is answered, refused or dropped. The store holds current state, not a
 * replay, so these count in a backfill too.
 */
export const HOST_RESOLVED = "request_resolved";
/**
 * A host app's store (T3 Code) says an agent made a prompt that a Codex or Claude transcript holds,
 * where the transcript does not say who made it: a notification of this type, stamped before the
 * prompt, with the prompt's event id (`promptId`) and time (`at`). core/wait-stats.ts reads it.
 */
export const HOST_AGENT_PROMPT = "agent_prompt";
/** A host's marker (HOST_AGENT_PROMPT): no activity of its own, and its time is made up, so timelines leave it out. */
export const isAgentPromptMark = (e: Pick<AgentEvent, "kind" | "payload">): boolean => e.kind === "notification" && e.payload.type === HOST_AGENT_PROMPT;
/** A live copy of a marked prompt (a hook's, with its own id) is this close to `at` at most. The marker is stamped earlier than that. */
export const HOST_MARK_SLACK_MS = 5_000;
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
  /** Ids of calls that ended and of host requests resolved, newest last: a copy of a start that arrives after its end opens nothing. */
  ended: string[];
  /** `tool`: the open call the wait is on, when that call has no id (Devin CLI's hooks name none). `request`: the host request it is. */
  wait?: Waiting & { thread: string; tool?: string; request?: string };
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
  if (e.kind === "notification" && str(e.payload.requestId)) {
    hostRequest(s, e, thread);
    return;
  }
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

/** A request from a host app's store: it waits until a resolved notification names its id. */
function hostRequest(s: WaitingState, e: AgentEvent, thread: string): void {
  const id = str(e.payload.requestId)!;
  const type = str(e.payload.type);
  if (type === HOST_RESOLVED) {
    if (s.wait?.request === id) s.wait = undefined;
    if (!s.ended.includes(id)) {
      s.ended.push(id);
      if (s.ended.length > MAX_OPEN) s.ended.splice(0, s.ended.length - MAX_OPEN);
    }
    return;
  }
  // Resolved at the same time it was asked: the resolution may sort first.
  if (s.ended.includes(id)) return;
  const kind = type === HOST_QUESTION ? "question" : isPermissionNotification(e) ? "permission" : undefined;
  if (!kind) return;
  // The host names the request, not a tool call: its resolution ends it, or the thread moving on.
  s.wait = wait(kind, e, thread, undefined, str(e.payload.text) ?? str(e.payload.message));
  s.wait.request = id;
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
  const { thread: _thread, tool: _tool, request: _request, ...out } = w;
  return out;
}
