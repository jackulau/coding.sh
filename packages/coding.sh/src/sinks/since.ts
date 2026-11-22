// A sink's `since` ([[sinks]] since = "<time>", which `coding.sh init --remote` writes): a session
// that started before it stays on this machine, including what it does after that time. openSink
// wraps every sink that sets one, so it holds wherever sinks are fed: local ingest (the spool and
// transcript imports, the one inside init too), `coding.sh serve` and the collector.
//
// A session is new when every sign says it started at or after `since`: its row's startedAt, the
// earliest of its events in the batch, and no earlier batch having found it older. The events it
// leaves out are acknowledged as `skipped`, so the caller's cursors move past them and a later run
// never sends them.
import type { AgentEvent, Session } from "../schema/index.ts";
import type { BlobStore, OpenSession, Sink, SinkAck } from "../core/types.ts";

/** Older sessions remembered per sink, so a later batch of one, with no row and only newer events, stays out too. */
const REMEMBER = 10_000;

export function sinceSink(inner: Sink, since: number): Sink {
  const older = new Set<string>();
  const sink: Sink = {
    name: inner.name,
    mode: inner.mode,
    async write(batch: AgentEvent[], sessions: Session[], blobs: BlobStore): Promise<SinkAck> {
      const first = new Map<string, number>();
      for (const e of batch) first.set(e.sessionId, Math.min(first.get(e.sessionId) ?? Infinity, e.ts));
      const rows = new Map(sessions.map((s) => [s.id, s]));
      const isNew = new Map<string, boolean>();
      for (const id of new Set([...first.keys(), ...rows.keys()])) {
        const row = rows.get(id);
        const yes = !older.has(id) && (row === undefined || row.startedAt >= since) && (first.get(id) ?? Infinity) >= since;
        isNew.set(id, yes);
        if (yes) continue;
        older.delete(id);
        older.add(id);
        if (older.size > REMEMBER) older.delete(older.values().next().value!);
      }
      const events = batch.filter((e) => isNew.get(e.sessionId));
      const keep = sessions.filter((s) => isNew.get(s.id));
      const skipped = batch.length - events.length;
      if (!events.length && !keep.length) return skipped ? { ok: true, skipped } : { ok: true };
      const ack = await inner.write(events, keep, blobs);
      return ack.ok && skipped ? { ...ack, skipped: (ack.skipped ?? 0) + skipped } : ack;
    },
  };
  if (inner.writeOpenSessions) {
    const writeOpen = inner.writeOpenSessions.bind(inner);
    sink.writeOpenSessions = (open: OpenSession[], blobs: BlobStore): Promise<SinkAck> => {
      const keep = open.filter((o) => o.session.startedAt >= since && !older.has(o.session.id));
      return keep.length ? writeOpen(keep, blobs) : Promise.resolve({ ok: true });
    };
  }
  if (inner.close) sink.close = inner.close.bind(inner);
  return sink;
}
