// Mirrors committed events to the configured [[sinks]] from processes that do
// not read the spool: `coding.sh serve` (OTLP and native ingest) and the local
// OTLP collector. Local `ingest` keeps its own cursor-based sink delivery
// (core/ingest.ts); this is the in-memory equivalent for events that arrive over
// HTTP, so they never wait on a remote and never block a response.
//
// Per sink: a bounded buffer (oldest dropped past maxEvents), flushed every
// second in batches of the sink's batchSize (default 500), metadata mode as in
// ingest (toMetadata / sessionToMetadata), and backoff on a retryable failure
// (the sink's retryAfterMs, else 1 s doubling to 60 s). A refusal without
// retryAfterMs (a 4xx) drops the batch.
import type { AgentEvent, Session } from "../schema/index.ts";
import type { BlobStore, Config, Sink } from "../core/types.ts";
import { sessionToMetadata, toMetadata } from "../core/redact.ts";
import type { Logger } from "./log.ts";
import type { ServeMetrics } from "./metrics.ts";

const DEFAULT_BATCH = 500;
const DEFAULT_MAX_EVENTS = 20_000;
const FLUSH_MS = 1000;
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;
const WARN_EVERY_MS = 60_000;

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
}

interface Lane {
  sink: Sink;
  batchSize: number;
  events: AgentEvent[];
  /** Latest version of each session the buffered events touch. */
  sessions: Map<string, Session>;
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
      retryAt: 0,
      backoff: 0,
      lastWarn: 0,
    }));
    if (this.lanes.length) {
      this.timer = setInterval(() => void this.flush(), o.flushMs ?? FLUSH_MS);
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

  /** Hands committed events (redacted, as stored) and the sessions they touch to every sink. Never throws. */
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

  /** One send round on every sink that is not backing off. */
  async flush(): Promise<void> {
    await Promise.all(this.lanes.map((l) => (l.running ??= this.drain(l).finally(() => (l.running = undefined)))));
  }

  private warn(lane: Lane, msg: string, fields: Record<string, unknown>): void {
    const now = Date.now();
    if (now - lane.lastWarn < WARN_EVERY_MS) return;
    lane.lastWarn = now;
    this.o.log?.warn(msg, { sink: lane.sink.name, ...fields });
  }

  private async drain(lane: Lane): Promise<void> {
    const { sink } = lane;
    const meta = sink.mode === "metadata";
    while (lane.events.length && Date.now() >= lane.retryAt) {
      const batch = lane.events.splice(0, lane.batchSize);
      const ids = new Set(batch.map((e) => e.sessionId));
      const sessions = [...ids].map((id) => lane.sessions.get(id)).filter((s): s is Session => s !== undefined);
      let error: string | undefined;
      let retryAfterMs: number | undefined;
      try {
        const ack = await sink.write(meta ? batch.map(toMetadata) : batch, meta ? sessions.map(sessionToMetadata) : sessions, this.o.blobs);
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
        this.o.metrics?.sinkEvents.inc({ sink: sink.name, result: "sent" }, batch.length);
        this.forget(lane);
        continue;
      }
      if (retryAfterMs !== undefined) {
        lane.events.unshift(...batch);
        const max = this.o.maxBackoffMs ?? MAX_BACKOFF_MS;
        lane.backoff = Math.min(max, lane.backoff ? lane.backoff * 2 : (this.o.minBackoffMs ?? MIN_BACKOFF_MS));
        const wait = Math.min(max, Math.max(lane.backoff, retryAfterMs));
        lane.retryAt = Date.now() + wait;
        this.warn(lane, "mirroring to a sink failed; retrying", { error, retryInMs: wait, buffered: lane.events.length });
        return;
      }
      this.o.metrics?.sinkEvents.inc({ sink: sink.name, result: "failed" }, batch.length);
      this.o.log?.warn("a sink refused mirrored events; dropped the batch", { sink: sink.name, error, events: batch.length });
      this.forget(lane);
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
      const waiting = this.lanes.filter((l) => l.events.length);
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
      await l.sink.close?.().catch(() => {});
    }
  }
}
