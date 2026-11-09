// A long session as a few readable phases instead of 50,000 rows.
//
// A phase starts where the session's story turns a corner: the start, a resume
// (`claude --resume`: a second session.start, or events after a
// session.end), a compaction (the model's context was summarized), or a long
// idle gap (the user went away; a transcript-only capture shows a resume this
// way). Days are marked too, so a run that crosses midnight reads in order.
// A fold over time-sorted events; `coding.sh show`, the viewer, MCP and ingest share it.
import type { AgentEvent, Session, SessionDerail, SessionPhase } from "../schema/index.ts";
import { failureState, foldFailure, type ToolFailure } from "./failures.ts";

/** A gap this long between two events of the main agent opens a new phase. */
export const IDLE_PHASE_MS = 30 * 60_000;

export type PhaseKind = SessionPhase["kind"];

export interface Phase extends SessionPhase {
  derails: SessionDerail[];
}

export interface DayMark {
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  ts: number;
  index: number;
  /** First event of the day. */
  eventId: string;
}

export interface Outline {
  phases: Phase[];
  days: DayMark[];
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Local YYYY-MM-DD. */
export function localDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Phases and day marks of one session. `sorted` must be sorted by time (as listEvents returns them). */
export function sessionOutline(sorted: readonly AgentEvent[], derails: readonly SessionDerail[] = [], idleMs = IDLE_PHASE_MS): Outline {
  const s = outlineState({ idleMs });
  const failures = failureState();
  for (let i = 0; i < sorted.length; i++) foldOutline(s, sorted[i]!, i, foldFailure(failures, sorted[i]!));
  return outlineOf(s, derails);
}

/**
 * Activity this long after a session.end reopens the session (a resume under
 * the same id, or more work after a guessed idle end). The slack covers events
 * stamped just after the end they belong to: hook transcript windows read up
 * to 2 s past their hook's time, and an SDK trace's last spans close after it.
 */
export const REOPEN_SLACK_MS = 5_000;

/**
 * The outline so far, as a fold: phases, the open phase's files, the last
 * main-agent event. Plain data, so live ingest can save it between appends.
 */
export interface OutlineState {
  phases: SessionPhase[];
  /** Files already counted in the open phase. */
  files: Set<string>;
  lastMainTs?: number;
  /** ts of the last session.end, until activity past REOPEN_SLACK_MS reopens the session. */
  endedAt?: number;
  /** Day marks, when asked for (they depend on the local time zone, so ingest leaves them out). */
  days?: DayMark[];
  day: string;
  idleMs: number;
}

export function outlineState(opts: { days?: boolean; idleMs?: number } = {}): OutlineState {
  return { phases: [], files: new Set(), ...(opts.days === false ? {} : { days: [] }), day: "", idleMs: opts.idleMs ?? IDLE_PHASE_MS };
}

/** The outline of the events folded so far, with derails placed in their phases. Leaves the state as it was. */
export function outlineOf(s: OutlineState, derails: readonly SessionDerail[] = []): Outline {
  const phases: Phase[] = s.phases.map((p) => ({ ...p, ...(p.tests ? { tests: { ...p.tests } } : {}), derails: [] }));
  for (const d of derails) {
    const p = phases.findLast((x) => x.startTs <= d.ts) ?? phases[0];
    p?.derails.push(d);
  }
  return { phases, days: [...(s.days ?? [])] };
}

/**
 * Folds the event at index `i` of the session's time-sorted events into the
 * outline. `failure`: how a failed tool.end failed (core/failures.ts); only real
 * failures count as the phase's toolErrors, and undefined counts as real.
 */
export function foldOutline(s: OutlineState, e: AgentEvent, i: number, failure?: ToolFailure): void {
  if (s.days) {
    const d = localDate(e.ts);
    if (d !== s.day) {
      if (s.day) s.days.push({ date: d, ts: e.ts, index: i, eventId: e.id });
      s.day = d;
    }
  }
  const open = (kind: PhaseKind, extra: Partial<SessionPhase> = {}) => {
    const cur = s.phases.at(-1);
    if (cur) cur.to = i;
    s.files.clear();
    s.phases.push({ n: s.phases.length + 1, kind, startTs: e.ts, endTs: e.ts, from: i, to: i, eventId: e.id, events: 0, prompts: 0, toolCalls: 0, toolErrors: 0, filesChanged: 0, tokens: 0, ...extra });
  };
  const files = s.files;
  // Boundaries come from the main agent's own events; a subagent's work sits inside its parent's phase.
  if (!e.subagentId) {
    const cur = s.phases.at(-1);
    const gap = s.lastMainTs !== undefined ? e.ts - s.lastMainTs : 0;
    const reopens = s.endedAt !== undefined && e.kind !== "session.end" && e.ts > s.endedAt + REOPEN_SLACK_MS;
    if (!cur) open("start");
    else if (e.kind === "session.start" && e.payload.source !== "compact" && cur.events > 0) open("resume", { gapMs: gap });
    else if (reopens) open("resume", { gapMs: gap });
    else if (e.kind === "context.compact") open("compaction", { trigger: e.payload.trigger === "manual" ? "manual" : "auto" });
    else if (gap >= s.idleMs && e.kind !== "session.end") open("idle", { gapMs: gap });
    // Events just after the end still belong to it (sessionOf's reopened uses the same slack).
    if (e.kind === "session.end") s.endedAt = e.ts;
    else if (reopens) s.endedAt = undefined;
    s.lastMainTs = e.ts;
  } else if (!s.phases.length) open("start");
  const p = s.phases.at(-1)!;
  p.events++;
  p.endTs = Math.max(p.endTs, e.ts);
  p.to = i + 1;
  if (e.kind === "user.message") {
    p.prompts++;
    if (p.title === undefined && typeof e.payload.text === "string" && e.payload.text.trim()) p.title = e.payload.text.replace(/\s+/g, " ").trim().slice(0, 120);
  } else if (e.kind === "tool.start" && e.payload.wrapper !== true) p.toolCalls++;
  else if (e.kind === "tool.end" && e.payload.ok === false && e.payload.wrapper !== true && (!failure || failure.cls === "real")) p.toolErrors++;
  else if (e.kind === "file.change" && typeof e.payload.path === "string" && !files.has(e.payload.path)) {
    files.add(e.payload.path);
    p.filesChanged++;
  } else if (e.kind === "test.result") p.tests = { passed: num(e.payload.passed), failed: num(e.payload.failed) };
  const u = e.usage;
  if (u) {
    p.tokens += num(u.inputTokens) + num(u.outputTokens) + num(u.cacheReadTokens) + num(u.cacheWriteTokens);
    if (u.costUsd !== undefined) p.costUsd = (p.costUsd ?? 0) + num(u.costUsd);
  }
}

/**
 * The outline kept on the session at ingest (stats.phases), so a reader needs none of its
 * events. Day marks fall on the first phase that starts on a new local date. Undefined
 * when the session has one phase, or was stored before phases were kept.
 */
export function storedOutline(s: Pick<Session, "stats">): Outline | undefined {
  const stored = s.stats.phases;
  if (!stored?.length) return undefined;
  const phases: Phase[] = stored.map((p) => ({ ...p, derails: [] }));
  for (const d of s.stats.derails ?? []) (phases.findLast((x) => x.startTs <= d.ts) ?? phases[0])!.derails.push(d);
  const days: DayMark[] = [];
  let day = localDate(phases[0]!.startTs);
  for (const p of phases) {
    const d = localDate(p.startTs);
    if (d === day) continue;
    days.push({ date: d, ts: p.startTs, index: p.from, eventId: p.eventId });
    day = d;
  }
  return { phases, days };
}

/** Phases to keep on Session.stats.phases: none for a one-phase session. */
export function phasesToStore(o: Outline): SessionPhase[] | undefined {
  return o.phases.length > 1 ? o.phases.map(({ derails: _, ...p }) => p) : undefined;
}

/** "resumed after 47 min", "compacted (auto)", "idle 2.1 h", "start". */
export function phaseLabel(p: Pick<Phase, "kind" | "trigger" | "gapMs">): string {
  const gap = p.gapMs !== undefined ? gapText(p.gapMs) : "";
  switch (p.kind) {
    case "start":
      return "start";
    case "resume":
      return gap ? `resumed after ${gap}` : "resumed";
    case "compaction":
      return `compacted (${p.trigger ?? "auto"})`;
    case "idle":
      return `back after ${gap} idle`;
  }
}

function gapText(ms: number): string {
  if (ms >= 3600_000) return `${(ms / 3600_000).toFixed(1)} h`;
  return `${Math.max(1, Math.round(ms / 60_000))} min`;
}
