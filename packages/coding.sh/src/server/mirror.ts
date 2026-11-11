// Mirrors committed events to the configured [[sinks]] from processes that do
// not read the spool: `coding.sh serve` (OTLP and native ingest) and the local
// OTLP collector. Local `ingest` keeps its own cursor-based sink delivery
// (core/ingest.ts); this is the in-memory equivalent for events that arrive over
// HTTP, so they never wait on a remote and never block a response.
//
// Ingest is idempotent and clients retry, so the mirror is handed only the
// events a commit newly stored (InsertedEvents in otel/receiver.ts): a request
// that is posted again reaches a sink once.
//
// Per sink: a bounded buffer (oldest dropped past maxEvents), flushed every
// second in batches of the sink's batchSize (default 500), metadata mode as in
// ingest (toMetadata / sessionToMetadata), and backoff on a retryable failure
// (the sink's retryAfterMs, else 1 s doubling to 60 s). A refusal without
// retryAfterMs (a 4xx) drops the batch.
//
// Open sessions. A sink with writeOpenSessions (otlp) sends its session record
// only with session.end, and a session keyed by a conversation id never ends.
// So each lane remembers the sessions whose events it sent without a session.end
// and hands their current rows to writeOpenSessions: once a session has been
// quiet for quietMs (10 s), and at least every refreshMs (60 s) while it stays
// busy. flush() and close() send them all at once, since nothing may run after
// them. One send per burst of activity, not one per batch.
import type { AgentEvent, Session } from "../schema/index.ts";
import type { BlobStore, Config, OpenSession, Sink, SinkAck } from "../core/types.ts";
import { sessionToMetadata, toMetadata } from "../core/redact.ts";
import type { Logger } from "./log.ts";
import type { ServeMetrics } from "./metrics.ts";

const DEFAULT_BATCH = 500;
const DEFAULT_MAX_EVENTS = 20_000;
const FLUSH_MS = 1000;
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;
const WARN_EVERY_MS = 60_000;
const QUIET_MS = 10_000;
const REFRESH_MS = 60_000;

export interface SinkMirrorOptions {
  sinks: Sink[];
  blobs: BlobStore;
  /** For each sink's batchSize ([[sinks]] batchSize). */
  config?: Pick<Config, "sinks">;
  metrics?: ServeMetrics;
  log?: Pick<Logger, "warn">;
  /** Events buffered per sink before the oldest are dropped (default 20,000). */
  maxEvents?: number;
  flushMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** An open session's record is sent once none of its events went out for this long (default 10 s). */
  quietMs?: number;
  /** A session that never goes quiet has its record sent this often (default 60 s). */
  refreshMs?: number;
}

/** An open session whose record is older than the events sent for it. */
interface Stale extends OpenSession {
  /** When its events first went out with no record after them. */
  since: number;
  /** When its events last went out. */
  at: number;
}

interface Lane {
  sink: Sink;
  batchSize: number;
  events: AgentEvent[];
  /** Latest version of each session the buffered events touch. */
  sessions: Map<string, Session>;
  /** Only for a sink with writeOpenSessions. */
  open: Map<string, Stale>;
  retryAt: number;
  backoff: number;
  lastWarn: number;
  running?: Promise<void>;
}

export class SinkMirror {
  private readonly o: SinkMirrorOptions;
  private readonly lanes: Lane[];
  private readonly timer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(o: SinkMirrorOptions) {
    this.o = o;
    this.lanes = o.sinks.map((sink) => ({
      sink,
      batchSize: o.config?.sinks.find((s) => (s.name ?? s.kind) === sink.name)?.batchSize ?? DEFAULT_BATCH,
      events: [],
      sessions: new Map(),
      open: new Map(),
      retryAt: 0,
      backoff: 0,
      lastWarn: 0,
    }));
    if (this.lanes.length) {
      this.timer = setInterval(() => void this.round(false), o.flushMs ?? FLUSH_MS);
      this.timer.unref();
    }
  }

  get size(): number {
    return this.lanes.length;
  }

  /** Events waiting, over all sinks. */
  get buffered(): number {
    return this.lanes.reduce((n, l) => n + l.events.length, 0);
  }

  /**
   * Hands the events a commit newly stored (redacted, as stored) and the sessions they touch to every sink.
   * The caller leaves out events the store already had (CommittedEntry.insertedEvents, BatchInfo.insertedEvents),
   * so a batch that is posted again is mirrored once. Never throws.
   */
  add(events: AgentEvent[], sessions: Session[]): void {
    if (this.closed || !events.length) return;
    const max = this.o.maxEvents ?? DEFAULT_MAX_EVENTS;
    for (const lane of this.lanes) {
      lane.events.push(...events);
      for (const s of sessions) lane.sessions.set(s.id, s);
      const over = lane.events.length - max;
      if (over > 0) {
        lane.events.splice(0, over);
        this.o.metrics?.sinkEvents.inc({ sink: lane.sink.name, result: "dropped" }, over);
        this.warn(lane, "sink buffer full; dropped the oldest events", { dropped: over });
      }
    }
  }

  /** One send round on every sink that is not backing off: the buffered events, then every open session's record. */
  async flush(): Promise<void> {
    await this.round(true);
  }

  /** The timer's round sends only the open sessions that are due; flush() and close() send them all. */
  private async round(all: boolean): Promise<void> {
    await Promise.all(this.lanes.map((l) => this.run(l, all)));
  }

  private run(lane: Lane, all: boolean): Promise<void> {
    // A round that asks for every open session waits for the one in flight, which may be past that step.
    if (lane.running) return all ? lane.running.then(() => this.run(lane, all)) : lane.running;
    return (lane.running = this.drain(lane, all).finally(() => (lane.running = undefined)));
  }

  private warn(lane: Lane, msg: string, fields: Record<string, unknown>): void {
    const now = Date.now();
    if (now - lane.lastWarn < WARN_EVERY_MS) return;
    lane.lastWarn = now;
    this.o.log?.warn(msg, { sink: lane.sink.name, ...fields });
  }

  /** One write to the lane's sink. Sent: {}. Retryable: the wait, with the lane backed off. Refused: the error alone. */
  private async send(lane: Lane, write: () => Promise<SinkAck>): Promise<{ error?: string; retryInMs?: number }> {
    let error: string | undefined;
    let retryAfterMs: number | undefined;
    try {
      const ack = await write();
      if (!ack.ok) {
        error = ack.error ?? "sink rejected the batch";
        retryAfterMs = ack.retryAfterMs;
      }
    } catch (e) {
      error = (e as Error).message;
      retryAfterMs = MIN_BACKOFF_MS;
    }
    if (error === undefined) {
      lane.backoff = 0;
      return {};
    }
    if (retryAfterMs === undefined) return { error };
    const max = this.o.maxBackoffMs ?? MAX_BACKOFF_MS;
    lane.backoff = Math.min(max, lane.backoff ? lane.backoff * 2 : (this.o.minBackoffMs ?? MIN_BACKOFF_MS));
    const retryInMs = Math.min(max, Math.max(lane.backoff, retryAfterMs));
    lane.retryAt = Date.now() + retryInMs;
    return { error, retryInMs };
  }

  private async drain(lane: Lane, all: boolean): Promise<void> {
    const { sink } = lane;
    const meta = sink.mode === "metadata";
    while (lane.events.length && Date.now() >= lane.retryAt) {
      const batch = lane.events.splice(0, lane.batchSize);
      const ids = new Set(batch.map((e) => e.sessionId));
      const sessions = [...ids].map((id) => lane.sessions.get(id)).filter((s): s is Session => s !== undefined);
      const { error, retryInMs } = await this.send(lane, () => sink.write(meta ? batch.map(toMetadata) : batch, meta ? sessions.map(sessionToMetadata) : sessions, this.o.blobs));
      if (error === undefined) {
        this.o.metrics?.sinkEvents.inc({ sink: sink.name, result: "sent" }, batch.length);
        if (sink.writeOpenSessions) this.track(lane, batch);
        this.forget(lane);
        continue;
      }
      if (retryInMs !== undefined) {
        lane.events.unshift(...batch);
        this.warn(lane, "mirroring to a sink failed; retrying", { error, retryInMs, buffered: lane.events.length });
        return;
      }
      this.o.metrics?.sinkEvents.inc({ sink: sink.name, result: "failed" }, batch.length);
      this.o.log?.warn("a sink refused mirrored events; dropped the batch", { sink: sink.name, error, events: batch.length });
      this.forget(lane);
    }
    await this.refresh(lane, all);
  }

  /** After a batch went out: a session.end in it carried the session's record; any other session's record is now stale. */
  private track(lane: Lane, batch: AgentEvent[]): void {
    const now = Date.now();
    const last = new Map<string, number>();
    const ended = new Set<string>();
    for (const e of batch) {
      last.set(e.sessionId, Math.max(last.get(e.sessionId) ?? 0, e.ts));
      if (e.kind === "session.end") ended.add(e.sessionId);
    }
    for (const [id, ts] of last) {
      if (ended.has(id)) {
        lane.open.delete(id);
        continue;
      }
      const was = lane.open.get(id);
      const session = lane.sessions.get(id) ?? was?.session;
      if (session) lane.open.set(id, { session, lastEventAt: Math.max(was?.lastEventAt ?? 0, ts), since: was?.since ?? now, at: now });
    }
  }

  /** Sends the record of the open sessions that are due (all of them when `all`), a batch at a time. */
  private async refresh(lane: Lane, all: boolean): Promise<void> {
    const { sink } = lane;
    const meta = sink.mode === "metadata";
    const quiet = this.o.quietMs ?? QUIET_MS;
    const every = this.o.refreshMs ?? REFRESH_MS;
    while (sink.writeOpenSessions && lane.open.size && Date.now() >= lane.retryAt) {
      const now = Date.now();
      const due = [...lane.open.values()].filter((o) => all || now - o.at >= quiet || now - o.since >= every).slice(0, lane.batchSize);
      if (!due.length) return;
      const open = due.map(({ session, lastEventAt }) => ({ session: meta ? sessionToMetadata(session) : session, lastEventAt }));
      const { error, retryInMs } = await this.send(lane, () => sink.writeOpenSessions!(open, this.o.blobs));
      if (retryInMs !== undefined) {
        this.warn(lane, "mirroring open sessions to a sink failed; retrying", { error, retryInMs, sessions: due.length });
        return;
      }
      if (error !== undefined) this.o.log?.warn("a sink refused open sessions; dropped them", { sink: sink.name, error, sessions: due.length });
      for (const o of due) lane.open.delete(o.session.id);
    }
  }

  /** Drops session rows no buffered event needs any more. */
  private forget(lane: Lane): void {
    if (!lane.events.length) {
      lane.sessions.clear();
      return;
    }
    if (lane.sessions.size < 1000) return;
    const live = new Set(lane.events.map((e) => e.sessionId));
    for (const id of lane.sessions.keys()) if (!live.has(id)) lane.sessions.delete(id);
  }

  /** Stops the timer, sends what is buffered for up to timeoutMs, then closes the sinks. */
  async close(timeoutMs: number): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const waiting = this.lanes.filter((l) => l.events.length || l.open.size);
      if (!waiting.length || Date.now() >= deadline) break;
      const next = Math.min(...waiting.map((l) => l.retryAt));
      if (next > Date.now()) await new Promise((r) => setTimeout(r, Math.min(next - Date.now(), Math.max(0, deadline - Date.now()))));
      if (Date.now() >= deadline) break;
      await Promise.race([this.flush(), new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now())))]);
    }
    for (const l of this.lanes) {
      if (l.events.length) {
        this.o.metrics?.sinkEvents.inc({ sink: l.sink.name, result: "dropped" }, l.events.length);
        this.o.log?.warn("shut down with events still unmirrored", { sink: l.sink.name, dropped: l.events.length });
        l.events.length = 0;
      }
      l.open.clear();
      await l.sink.close?.().catch(() => {});
    }
  }
}
