// A long session as a few readable phases instead of 50,000 rows.
//
// A phase starts where the session's story turns a corner: the start, a resume
// (`claude --resume`: a second session.start, or events after a
// session.end), a compaction (the model's context was summarized), or a long
// idle gap (the user went away; a transcript-only capture shows a resume this
// way). Days are marked too, so a run that crosses midnight reads in order.
// Pure, over time-sorted events; `coding.sh show`, the viewer and MCP share it.
import type { AgentEvent, Session, SessionDerail, SessionPhase } from "../schema/index.ts";

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
  const phases: Phase[] = [];
  const days: DayMark[] = [];
  let cur: Phase | undefined;
  let lastMain: AgentEvent | undefined;
  let ended = false;
  let day = "";
  const files = new Set<string>();
  const open = (kind: PhaseKind, e: AgentEvent, i: number, extra: Partial<Phase> = {}) => {
    if (cur) cur.to = i;
    files.clear();
    cur = { n: phases.length + 1, kind, startTs: e.ts, endTs: e.ts, from: i, to: i, eventId: e.id, events: 0, prompts: 0, toolCalls: 0, toolErrors: 0, filesChanged: 0, tokens: 0, derails: [], ...extra };
    phases.push(cur);
  };
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i]!;
    const d = localDate(e.ts);
    if (d !== day) {
      if (day) days.push({ date: d, ts: e.ts, index: i, eventId: e.id });
      day = d;
    }
    // Boundaries come from the main agent's own events; a subagent's work sits inside its parent's phase.
    if (!e.subagentId) {
      const gap = lastMain ? e.ts - lastMain.ts : 0;
      if (!cur) open("start", e, i);
      else if (e.kind === "session.start" && e.payload.source !== "compact" && cur.events > 0) open("resume", e, i, { gapMs: gap });
      else if (ended && e.kind !== "session.end") open("resume", e, i, { gapMs: gap });
      else if (e.kind === "context.compact") open("compaction", e, i, { trigger: e.payload.trigger === "manual" ? "manual" : "auto" });
      else if (gap >= idleMs && e.kind !== "session.end") open("idle", e, i, { gapMs: gap });
      ended = e.kind === "session.end";
      lastMain = e;
    } else if (!cur) open("start", e, i);
    const p = cur!;
    p.events++;
    p.endTs = Math.max(p.endTs, e.ts);
    p.to = i + 1;
    if (e.kind === "user.message") {
      p.prompts++;
      if (p.title === undefined && typeof e.payload.text === "string" && e.payload.text.trim()) p.title = e.payload.text.replace(/\s+/g, " ").trim().slice(0, 120);
    } else if (e.kind === "tool.start" && e.payload.wrapper !== true) p.toolCalls++;
    else if (e.kind === "tool.end" && e.payload.ok === false && e.payload.wrapper !== true) p.toolErrors++;
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
  for (const d of derails) {
    const p = phases.findLast((x) => x.startTs <= d.ts) ?? phases[0];
    p?.derails.push(d);
  }
  return { phases, days };
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
