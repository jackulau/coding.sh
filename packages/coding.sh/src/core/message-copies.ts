// Events captured twice: once live (a hook, plugin or OTel) and once from the
// agent's own transcript (backfill). Most events share a natural id across the
// two paths, so the store dedupes them. The ones that cannot are matched here,
// in both directions.
//
// Prompts and replies: a hook prompt has no natural id (Claude's
// UserPromptSubmit carries no entry uuid), so copies are matched by text:
// - backfill: a transcript prompt/reply whose text a live copy of the same
//   session already has is dropped (live wins);
// - spool ingest: a live prompt/reply that a backfill already stored for the
//   same moment is dropped (the live path saw it first, but too late).
// Matching runs on stored form (after redaction and metadata stripping), the
// form the stored copy has. Metadata mode keeps no text, so there two copies
// of one kind match by time alone.
//
// Session start and end: each path records its own (a hook fires SessionStart
// on every resume, a transcript import opens the session at its first line and
// may close it when the file has gone idle), so a session keeps the starts and
// ends of whichever path stored them first:
// - session.start: dropped when the other path already stored one, unless it
//   alone links the session to a parent;
// - session.end: dropped when the other path already stored an end at or
//   after it with no activity in between (a live end that follows a resume
//   the backfill closed early is kept).
import type { AgentEvent } from "../schema/index.ts";
import type { IndexStore } from "./types.ts";
import { isBackfillEvent } from "./sessions.ts";

export const MESSAGE_KINDS = ["user.message", "assistant.message"];
const SESSION_KINDS = ["session.start", "session.end"];

/**
 * Max distance between the two copies of one prompt: the hook fires and the
 * transcript line is written at submit time, milliseconds apart.
 */
export const COPY_SLACK_MS = 5_000;

/** Natural key for a prompt/reply: kind + whitespace-folded text. */
export function messageKey(e: AgentEvent): string | undefined {
  if (!MESSAGE_KINDS.includes(e.kind) || typeof e.payload.text !== "string") return undefined;
  const t = e.payload.text.replace(/\s+/g, " ").trim().slice(0, 4000);
  return t ? `${e.kind}\u0000${t}` : undefined;
}

interface Stored {
  kind: string;
  ts: number;
  key?: string;
  parent?: boolean;
}

interface SessionCopies {
  live: Stored[];
  backfill: Stored[];
  /** Latest stored event that is not a session.end; read only when a live end needs it. */
  lastActivity?: number;
}

export interface CopyFilter {
  /** True when `e` (stored form) is a copy of what the other capture path already stored for its session. */
  isCopy(e: AgentEvent): Promise<boolean>;
}

const hasParent = (e: AgentEvent): boolean => typeof e.payload.parentSessionId === "string" && e.payload.parentSessionId !== "";

/** Per-run filter; each session's stored prompts, replies, starts and ends are read once. */
export function copyFilter(index: IndexStore): CopyFilter {
  const cache = new Map<string, SessionCopies>();
  // Latest event of this run per session (not yet stored, or stored after the cache was read).
  const seen = new Map<string, number>();
  const load = async (sessionId: string) => {
    let c = cache.get(sessionId);
    if (!c) {
      c = { live: [], backfill: [] };
      for (const e of await index.listEvents(sessionId, { kinds: [...MESSAGE_KINDS, ...SESSION_KINDS] })) {
        (isBackfillEvent(e) ? c.backfill : c.live).push({ kind: e.kind, ts: e.ts, key: messageKey(e), parent: hasParent(e) });
      }
      cache.set(sessionId, c);
    }
    return c;
  };
  const lastActivity = async (sessionId: string, c: SessionCopies): Promise<number> => {
    if (c.lastActivity === undefined) {
      c.lastActivity = -Infinity;
      for (const e of await index.listEvents(sessionId)) if (e.kind !== "session.end" && e.ts > c.lastActivity) c.lastActivity = e.ts;
    }
    return Math.max(c.lastActivity, seen.get(sessionId) ?? -Infinity);
  };
  const sessionCopy = async (e: AgentEvent, backfill: boolean): Promise<boolean> => {
    const c = await load(e.sessionId);
    const other = (backfill ? c.live : c.backfill).filter((o) => o.kind === e.kind);
    if (!other.length) return false;
    if (e.kind === "session.start") return !hasParent(e) || other.some((o) => o.parent);
    // A transcript end is a copy of a live end at or after it.
    if (backfill) return other.some((o) => o.ts >= e.ts - COPY_SLACK_MS);
    // A live end is a copy of a transcript end before it when nothing happened in between.
    const before = other.filter((o) => o.ts <= e.ts + COPY_SLACK_MS);
    if (!before.length) return false;
    const last = Math.max(...before.map((o) => o.ts));
    return (await lastActivity(e.sessionId, c)) <= last + COPY_SLACK_MS;
  };
  return {
    async isCopy(e) {
      const backfill = isBackfillEvent(e);
      if (SESSION_KINDS.includes(e.kind)) return sessionCopy(e, backfill);
      if (!backfill) seen.set(e.sessionId, Math.max(e.ts, seen.get(e.sessionId) ?? -Infinity));
      if (!MESSAGE_KINDS.includes(e.kind)) return false;
      const c = await load(e.sessionId);
      const key = messageKey(e);
      const near = (o: Stored) => Math.abs(o.ts - e.ts) <= COPY_SLACK_MS;
      // A transcript copy matches live text anywhere in the session (other live paths stamp their own times).
      // A live event is new: it is a copy only of the same moment's transcript entry. No text: time alone.
      return (backfill ? c.live : c.backfill).some((o) => o.kind === e.kind && (key !== undefined && o.key !== undefined ? o.key === key && (backfill || near(o)) : near(o)));
    },
  };
}
