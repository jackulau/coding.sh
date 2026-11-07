// Prompts and replies captured twice: once live (a hook, plugin or OTel) and
// once from the agent's own transcript (backfill). Most events share a natural
// id across the two paths, so the store dedupes them; a hook prompt has none
// (Claude's UserPromptSubmit carries no entry uuid), so the copies are matched
// here, in both directions:
// - backfill: a transcript prompt/reply whose text a live copy of the same
//   session already has is dropped (live wins);
// - spool ingest: a live prompt/reply that a backfill already stored for the
//   same moment is dropped (the live path saw it first, but too late).
// Matching runs on stored form (after redaction and metadata stripping), the
// form the stored copy has. Metadata mode keeps no text, so there two copies
// of one kind match by time alone.
import type { AgentEvent } from "../schema/index.ts";
import type { IndexStore } from "./types.ts";
import { isBackfillEvent } from "./sessions.ts";

export const MESSAGE_KINDS = ["user.message", "assistant.message"];

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
}

export interface CopyFilter {
  /** True when `e` (stored form) is a copy of a prompt/reply the other capture path already stored. */
  isCopy(e: AgentEvent): Promise<boolean>;
}

/** Per-run filter; each session's stored prompts/replies are read once. */
export function copyFilter(index: IndexStore): CopyFilter {
  const cache = new Map<string, { live: Stored[]; backfill: Stored[] }>();
  const load = async (sessionId: string) => {
    let c = cache.get(sessionId);
    if (!c) {
      c = { live: [], backfill: [] };
      for (const e of await index.listEvents(sessionId, { kinds: MESSAGE_KINDS })) {
        (isBackfillEvent(e) ? c.backfill : c.live).push({ kind: e.kind, ts: e.ts, key: messageKey(e) });
      }
      cache.set(sessionId, c);
    }
    return c;
  };
  return {
    async isCopy(e) {
      if (!MESSAGE_KINDS.includes(e.kind)) return false;
      const backfill = isBackfillEvent(e);
      const c = await load(e.sessionId);
      const key = messageKey(e);
      const near = (o: Stored) => Math.abs(o.ts - e.ts) <= COPY_SLACK_MS;
      // A transcript copy matches live text anywhere in the session (other live paths stamp their own times).
      // A live event is new: it is a copy only of the same moment's transcript entry. No text: time alone.
      return (backfill ? c.live : c.backfill).some((o) => o.kind === e.kind && (key !== undefined && o.key !== undefined ? o.key === key && (backfill || near(o)) : near(o)));
    },
  };
}
