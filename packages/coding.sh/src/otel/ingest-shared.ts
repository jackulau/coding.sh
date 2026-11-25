/**
 * What the spool ingest (core/ingest.ts) shares with the OTLP receiver, kept apart from the
 * receiver's HTTP server, decoders and span mapping: every read command that ingests first
 * loads core/ingest.ts, and node:http alone costs it Node's bundled HTTP client (undici).
 * receiver.ts and map.ts re-export these names.
 */
import type { AgentEvent } from "../schema/index.ts";
import type { IndexStore } from "../core/types.ts";

/** Index kv key of a persisted trace → conversation entry. */
export const traceKvKey = (traceId: string) => `otel-trace:${traceId}`;

/** Ids a failed commit can leave owed (InsertedEvents); past this the oldest are forgotten. */
const OWED_MAX = 100_000;

/**
 * Says which of a commit's events are new to the store, for what runs after
 * the commit: [[sinks]] get an event once, however often its batch is posted.
 * One per writer (the receiver's group commit, serve's ingest queue).
 */
export class InsertedEvents {
  /**
   * Ids stored by a commit that failed after its put (the rebuild threw, the
   * client was answered 503): nothing was handed on, and the retry inserts
   * nothing, so the retry's commit hands them on. In insertion order.
   */
  private readonly owed = new Set<string>();

  /**
   * putEvents, plus the ids it inserted. A store without putEventsReturningIds
   * has the stored ids of the touched sessions read before the put, so call
   * this inside the store's transaction where it has one.
   */
  async put(store: IndexStore, events: AgentEvent[]): Promise<{ inserted: number; ids: Set<string> }> {
    if (!events.length) return { inserted: 0, ids: new Set() };
    if (store.putEventsReturningIds) {
      const r = await store.putEventsReturningIds(events);
      return { inserted: r.inserted, ids: new Set(r.ids) };
    }
    const had = new Set<string>();
    for (const id of new Set(events.map((e) => e.sessionId))) for (const e of await store.listEvents(id)) had.add(e.id);
    const { inserted } = await store.putEvents(events);
    // The count wins where it is certain: nothing inserted means nothing new, whatever the read said.
    return { inserted, ids: new Set(inserted ? events.flatMap((e) => (had.has(e.id) ? [] : [e.id])) : []) };
  }

  /** The commit failed after these ids were put: the next commit that carries them hands them on. */
  owe(ids: Iterable<string>): void {
    for (const id of ids) this.owed.add(id);
    for (const id of this.owed) {
      if (this.owed.size <= OWED_MAX) break;
      this.owed.delete(id);
    }
  }

  /**
   * The events of one request to hand on, in order: those whose id is in `ids`
   * (what the put inserted) or owed. Each id is handed on once: it leaves `ids`
   * and the owed set, so the first request of a commit that carries it gets it.
   */
  take(events: AgentEvent[], ids: Set<string>): AgentEvent[] {
    return events.filter((e) => {
      const inserted = ids.delete(e.id);
      return this.owed.delete(e.id) || inserted;
    });
  }
}
