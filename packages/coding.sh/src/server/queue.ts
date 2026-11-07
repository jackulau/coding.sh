// Serve's ingest pipeline (docs/PRODUCTION.md §1.4): bounded admission, then
// exactly one serial writer. Each tick maps the queued requests, scopes them to
// their project, redacts, prices and offloads them, writes them with one
// putEvents, rebuilds every touched session once, and only then answers the
// requests. A 200 therefore means committed; a store error answers 503 with
// Retry-After, and clients retry (putEvents is idempotent).
import type { AgentEvent } from "../schema/index.ts";
import type { BlobStore, Config, IndexStore } from "../core/types.ts";
import { sha256Hex } from "../core/ids.ts";
import { offloadPayload } from "../core/offload.ts";
import { applyPricing, priceTable, type Prices } from "../core/pricing.ts";
import { createRedactor, redactEventCounted, toMetadata, type Redactor } from "../core/redact.ts";
import { isVerifyToolStart } from "../core/sessions.ts";
import type { ResourceLogs, ResourceSpans } from "../otel/model.ts";
import type { SpanEnricher } from "../otel/map.ts";
import { traceKvKey } from "../otel/map.ts";
import { createOtlpPipeline, HttpError, type OtlpPipeline, rebuildSessions, RPC, type Signal } from "../otel/receiver.ts";
import { WRITER_TICK_EVENTS } from "./config.ts";
import type { Logger } from "./log.ts";
import type { ServeMetrics } from "./metrics.ts";
import { DEFAULT_PROJECT, scopeEvents } from "./project.ts";

export const DIRTY_KEY = "serve:dirty";
/** Event-loop turns the writer yields before forming a tick (see run). */
const LINGER_TURNS = 4;

export type QueueEntry =
  | { kind: "otlp"; project: string; signal: Signal; decoded: ResourceSpans[] | ResourceLogs[]; items: number; bytes: number }
  | { kind: "native"; project: string; events: AgentEvent[]; items: number; bytes: number };

export interface EntryResult {
  /** Events this request newly stored (see apportioning in `tick`). */
  inserted: number;
  /** Events written (after mapping), new or not. */
  stored: number;
  /** OTLP spans/log records the mapper rejected. */
  rejected: number;
  message: string;
}

export interface IngestQueueOptions {
  store: IndexStore;
  blobs: BlobStore;
  /** capture (redaction, metadata mode, maxInlineBytes) and pricing come from here. */
  config: Config;
  maxEvents: number;
  maxBytes: number;
  /** Events per writer tick (default 5,000). */
  tickEvents?: number;
  metrics?: ServeMetrics;
  log?: Logger;
  /** OTLP span enrichment (default: the receiver's defaultEnricher). */
  enrichSpan?: SpanEnricher | false;
  /** Called once when the writer lease is found lost (see setWritable); the queue is standby by then. */
  onLeaseLost?: (err: Error) => void;
}

interface Pending {
  entry: QueueEntry;
  resolve: (r: EntryResult) => void;
  reject: (e: Error) => void;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export class IngestQueue {
  private readonly o: IngestQueueOptions;
  private readonly pending: Pending[] = [];
  private readonly exclusive: { fn: () => Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];
  private readonly pipelines = new Map<string, OtlpPipeline>();
  private readonly redactor: Redactor;
  private readonly prices: Prices;
  private readonly metadata: boolean;
  /** Sessions written by a failed tick, rebuilt by the next good one. */
  private readonly dirty = new Set<string>();
  private queuedEvents = 0;
  private queuedBytes = 0;
  /** Observed write rate, events/second (EWMA). */
  private rate = 0;
  private writable = false;
  /** Throws once the writer lease was taken over (WriterLock.assertHeld). */
  private fence: (() => void) | undefined;
  private closing = false;
  private stopped = false;
  private wake: (() => void) | undefined;
  private loop: Promise<void> | undefined;
  private busy = false;

  constructor(o: IngestQueueOptions) {
    this.o = o;
    this.redactor = createRedactor({ redact: o.config.capture.redact, patterns: o.config.capture.redactPatterns });
    this.prices = priceTable(o.config.pricing);
    this.metadata = o.config.capture.mode === "metadata";
  }

  get depth(): { events: number; bytes: number; max: number } {
    return { events: this.queuedEvents, bytes: this.queuedBytes, max: this.o.maxEvents };
  }

  /**
   * True while this replica may write (it holds the writer lock). `fence`
   * throws once the lock was lost: it is checked before every tick and
   * exclusive job, so a writer whose lease another replica broke never commits
   * another write (see leaseLost).
   */
  setWritable(on: boolean, fence?: () => void): void {
    this.writable = on;
    this.fence = on ? fence : undefined;
  }

  get isWritable(): boolean {
    return this.writable;
  }

  /** Seconds a throttled client should wait: queued / write rate, 1..30, default 2. */
  retryAfter(): number {
    if (this.rate <= 0) return 2;
    return clamp(Math.ceil(this.queuedEvents / this.rate), 1, 30);
  }

  /** Admits a request (or throws 429/503) and resolves once it is committed. */
  submit(entry: QueueEntry): Promise<EntryResult> {
    if (this.closing || this.stopped) throw new HttpError(503, RPC.UNAVAILABLE, "server is shutting down; retry", { "Retry-After": "2" });
    if (!this.writable) throw new HttpError(503, RPC.UNAVAILABLE, "standby: another replica holds the writer lock; retry", { "Retry-After": "5" });
    const empty = this.queuedEvents === 0 && this.queuedBytes === 0;
    // An empty queue admits any one request (within the body limits), so a big batch is never starved.
    if (!empty && (this.queuedEvents + entry.items > this.o.maxEvents || this.queuedBytes + entry.bytes > this.o.maxBytes)) {
      this.o.metrics?.throttled.inc({ project: entry.project });
      const s = this.retryAfter();
      throw new HttpError(429, RPC.RESOURCE_EXHAUSTED, `ingest queue is full; retry after ${s}s`, { "Retry-After": String(s) });
    }
    this.queuedEvents += entry.items;
    this.queuedBytes += entry.bytes;
    return new Promise<EntryResult>((resolve, reject) => {
      this.pending.push({ entry, resolve, reject });
      this.kick();
    });
  }

  /** Runs fn between writer ticks (retention, crash repair), so it never races a write. */
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.loop) return fn();
    return new Promise<T>((resolve, reject) => {
      this.exclusive.push({ fn, resolve: resolve as (v: unknown) => void, reject });
      this.kick();
    });
  }

  /** Rebuilds the sessions a crashed writer left in `serve:dirty`. Returns how many. */
  async repair(): Promise<number> {
    const raw = await this.o.store.kvGet?.(DIRTY_KEY);
    if (!raw) return 0;
    let ids: string[] = [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) ids = parsed.filter((x): x is string => typeof x === "string");
    } catch {
      // a torn value: nothing to repair from it
    }
    await rebuildSessions(this.o.store, ids);
    await this.o.store.kvSet?.(DIRTY_KEY, undefined);
    return ids.length;
  }

  start(): void {
    this.loop ??= this.run();
  }

  /**
   * Stops admitting, lets the writer finish what is queued for up to timeoutMs,
   * then fails whatever is left with 503 (clients retry). Resolves when the writer stopped.
   */
  async drain(timeoutMs: number): Promise<{ drained: boolean; left: number }> {
    this.closing = true;
    const deadline = Date.now() + timeoutMs;
    while ((this.pending.length || this.busy) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    const left = this.pending.splice(0);
    for (const p of left) {
      this.release(p.entry);
      p.reject(new HttpError(503, RPC.UNAVAILABLE, "server is shutting down; retry", { "Retry-After": "2" }));
    }
    this.stopped = true;
    this.kick();
    // A tick still in flight past the deadline finishes on its own; don't wait on a hung store.
    if (!this.busy) await this.loop;
    return { drained: left.length === 0, left: left.length };
  }

  private kick(): void {
    const w = this.wake;
    this.wake = undefined;
    w?.();
  }

  private release(e: QueueEntry): void {
    this.queuedEvents = Math.max(0, this.queuedEvents - e.items);
    this.queuedBytes = Math.max(0, this.queuedBytes - e.bytes);
  }

  /**
   * Undefined while this replica still holds the writer lease. Once it is lost:
   * standby, every queued request and job fails with 503 (clients retry against
   * the new writer), onLeaseLost fires, and the error is returned.
   */
  private leaseLost(): HttpError | undefined {
    if (!this.fence) return undefined;
    try {
      this.fence();
      return undefined;
    } catch (cause) {
      this.writable = false;
      this.fence = undefined;
      this.o.log?.warn("lost the writer lock to another replica; standby", { error: (cause as Error).message });
      const err = new HttpError(503, RPC.UNAVAILABLE, "standby: another replica took over the writer lock; retry", { "Retry-After": "5" });
      for (const p of this.pending.splice(0)) {
        this.release(p.entry);
        p.reject(err);
      }
      for (const j of this.exclusive.splice(0)) j.reject(err);
      this.o.onLeaseLost?.(cause as Error);
      return err;
    }
  }

  private async run(): Promise<void> {
    for (;;) {
      if (this.exclusive.length || this.pending.length) this.leaseLost();
      const job = this.exclusive.shift();
      if (job) {
        this.busy = true;
        try {
          job.resolve(await job.fn());
        } catch (e) {
          job.reject(e);
        } finally {
          this.busy = false;
        }
        continue;
      }
      if (!this.pending.length) {
        if (this.stopped) return;
        await new Promise<void>((r) => (this.wake = r));
        continue;
      }
      const max = this.o.tickEvents ?? WRITER_TICK_EVENTS;
      // Give the event loop a few turns to read requests that arrived during the last
      // tick. A synchronous store (node:sqlite) blocks the loop while it writes; without
      // this each tick would hold about one request, so sessions would be rebuilt once
      // per request instead of once per tick, and admission would never see a full queue.
      for (let i = 0; i < LINGER_TURNS && this.queuedEvents < max && !this.closing; i++) await new Promise<void>((r) => setImmediate(r));
      const batch: Pending[] = [this.pending.shift()!];
      let n = batch[0]!.entry.items;
      while (this.pending.length && n + this.pending[0]!.entry.items <= max) {
        const p = this.pending.shift()!;
        n += p.entry.items;
        batch.push(p);
      }
      this.busy = true;
      try {
        await this.tick(batch);
      } finally {
        this.busy = false;
      }
    }
  }

  private pipeline(project: string): OtlpPipeline {
    let p = this.pipelines.get(project);
    if (!p) {
      const { store, blobs, config } = this.o;
      p = createOtlpPipeline({
        store,
        blobs,
        maxInlineBytes: config.capture.maxInlineBytes,
        redactor: this.redactor,
        keepRaw: !this.metadata,
        ...(this.o.enrichSpan !== undefined ? { enrichSpan: this.o.enrichSpan } : {}),
        // Metadata mode keeps no content: hand back the ref, store nothing.
        ...(this.metadata ? { blob: async (d: Uint8Array | string) => sha256Hex(typeof d === "string" ? this.redactor.string(d) : d) } : {}),
        kvKey: (t) => (project === DEFAULT_PROJECT ? traceKvKey(t) : `${project}/${traceKvKey(t)}`),
      });
      this.pipelines.set(project, p);
    }
    return p;
  }

  private strip(e: AgentEvent): AgentEvent {
    const verify = isVerifyToolStart(e);
    const out = toMetadata(e);
    if (verify) out.payload.verify = true;
    if (e.project) out.project = e.project;
    if (e.source) out.source = e.source;
    return out;
  }

  private async prepare(entry: QueueEntry): Promise<{ events: AgentEvent[]; rejected: number; message: string }> {
    let events: AgentEvent[];
    let rejected = 0;
    let message = "";
    if (entry.kind === "otlp") {
      const m = await this.pipeline(entry.project).map(entry.signal, entry.decoded);
      events = m.events;
      rejected = m.rejected;
      message = m.errors.join("; ");
    } else {
      events = entry.events.map((e) => redactEventCounted(this.redactor, e));
    }
    events = scopeEvents(events, entry.project);
    if (this.metadata) events = events.map((e) => this.strip(e));
    events = applyPricing(events, this.prices);
    if (entry.kind === "native") {
      const { blobs, config } = this.o;
      const put = this.metadata ? async (d: string) => sha256Hex(d) : (d: string) => blobs.put(this.redactor.string(d));
      events = await Promise.all(events.map((e) => offloadPayload(e, config.capture.maxInlineBytes, put)));
    }
    return { events, rejected, message };
  }

  private async tick(batch: Pending[]): Promise<void> {
    const started = performance.now();
    const { store, metrics, log } = this.o;
    try {
      const prepared: { events: AgentEvent[]; rejected: number; message: string }[] = [];
      for (const p of batch) prepared.push(await this.prepare(p.entry));
      // Ids repeated inside one tick are written once; the first request owns them.
      const seen = new Set<string>();
      const unique: AgentEvent[] = [];
      const owned = prepared.map((r) => {
        let n = 0;
        for (const e of r.events) {
          if (seen.has(e.id)) continue;
          seen.add(e.id);
          unique.push(e);
          n++;
        }
        return n;
      });
      // Checked again right before the first write: preparing can take a while.
      const lost = this.leaseLost();
      if (lost) {
        for (const p of batch) p.reject(lost);
        return;
      }
      for (const e of unique) this.dirty.add(e.sessionId);
      if (this.dirty.size && store.kvSet) await store.kvSet(DIRTY_KEY, JSON.stringify([...this.dirty]));
      const { inserted } = unique.length ? await store.putEvents(unique) : { inserted: 0 };
      // Every touched session is rebuilt once, from all its stored events. Rebuild
      // keys off the batch, not `inserted`, so a retried batch repairs its sessions too.
      await rebuildSessions(store, this.dirty);
      this.dirty.clear();
      if (store.kvSet) await store.kvSet(DIRTY_KEY, undefined);

      // One putEvents per tick reports one total. It is credited to requests in
      // arrival order, which is exact whenever a tick holds a single request.
      let left = inserted;
      batch.forEach((p, i) => {
        const r = prepared[i]!;
        const ins = Math.min(left, owned[i]!);
        left -= ins;
        const project = p.entry.project;
        if (metrics) {
          if (ins) metrics.ingestEvents.inc({ project, result: "inserted" }, ins);
          if (r.events.length - ins > 0) metrics.ingestEvents.inc({ project, result: "duplicate" }, r.events.length - ins);
          if (r.rejected) metrics.ingestEvents.inc({ project, result: "rejected" }, r.rejected);
        }
        p.resolve({ inserted: ins, stored: r.events.length, rejected: r.rejected, message: r.message });
      });
      const secs = (performance.now() - started) / 1000;
      if (unique.length && secs > 0) {
        const r = unique.length / secs;
        this.rate = this.rate === 0 ? r : 0.8 * this.rate + 0.2 * r;
      }
    } catch (err) {
      metrics?.storeErrors.inc();
      log?.error("writer tick failed", { error: (err as Error).message, requests: batch.length });
      const e = new HttpError(503, RPC.UNAVAILABLE, `store unavailable: ${(err as Error).message}`, { "Retry-After": "2" });
      for (const p of batch) p.reject(e);
    } finally {
      for (const p of batch) this.release(p.entry);
      metrics?.observeTick((performance.now() - started) / 1000);
    }
  }
}
