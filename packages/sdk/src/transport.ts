// Non-blocking batched sender (docs/PRODUCTION.md §4.1 "Transport").
//
// - Events queue in memory and go to POST /v1/ingest in batches of ≤ maxBatch
//   events and ≤ 4 MiB; AI SDK spans go to POST /v1/traces as OTLP JSON.
// - One request in flight at a time; timers are unref()'d so the SDK never
//   keeps a process alive on its own.
// - 429 / 5xx / network errors retry with Retry-After, else 1, 2, 4… s up to
//   30 s, at most 5 attempts. 400/401/403 drop the batch and warn once.
// - A full queue drops new events (counted) and warns at most once a minute.
// - Every event already has its client id, so a retried batch is idempotent.
import { type Config, MAX_BATCH_BYTES } from "./config.ts";

export type ItemKind = "event" | "span";

interface Item {
  kind: ItemKind;
  json: string;
  bytes: number;
}

export interface TransportStats {
  queued: number;
  sent: number;
  dropped: number;
  failed: number;
}

const MAX_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;
const GZIP_MIN_BYTES = 1024;
/** Scope of AI SDK spans; "ai" is the scope name the AI SDK's own tracer uses. */
const SPAN_SCOPE = "ai";

const enc = new TextEncoder();

type Timer = ReturnType<typeof setTimeout>;
const unref = (t: Timer): Timer => {
  (t as { unref?: () => void }).unref?.();
  return t;
};

/** Seconds (or an HTTP date) from a Retry-After header, as milliseconds. */
export function retryAfterMs(v: string | null): number | undefined {
  if (!v) return undefined;
  const s = Number(v.trim());
  if (Number.isFinite(s) && s >= 0) return Math.min(s * 1000, 2 * MAX_BACKOFF_MS);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.min(Math.max(0, at - Date.now()), 2 * MAX_BACKOFF_MS) : undefined;
}

async function gzip(body: string): Promise<Uint8Array | undefined> {
  const CS = (globalThis as { CompressionStream?: typeof CompressionStream }).CompressionStream;
  if (!CS || body.length < GZIP_MIN_BYTES) return undefined;
  try {
    const stream = new Blob([body]).stream().pipeThrough(new CS("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return undefined;
  }
}

export class Transport {
  private readonly q: Item[] = [];
  private inflight: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private timer: Timer | undefined;
  private flushing = 0;
  private closed = false;
  private sent = 0;
  private dropped = 0;
  private failed = 0;
  private readonly warned = new Set<string>();
  private lastDropWarn = 0;
  /** Set while a bounded final flush runs: no retry may outlive it. */
  private deadline: number | undefined;
  private closedHard = false;
  /** The batch being sent, so a close() that gives up can count it exactly once. */
  private current: { n: number; done: boolean } | undefined;
  private wake: (() => void) | undefined;
  /** The backoff timer of the retry sleeping now, so it can stop holding the process open. */
  private sleepTimer: Timer | undefined;
  /** An explicit flush() gave up on a server that did not answer: the exit flush would only wait again. */
  private flushGaveUp = false;
  private readonly cfg: Config;

  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  get enabled(): boolean {
    return !this.closed && this.cfg.url !== undefined;
  }

  /** True after a flush() timed out and nothing has been sent since: the exit flush is skipped. */
  get skipExitFlush(): boolean {
    return this.flushGaveUp;
  }

  stats(): TransportStats {
    return { queued: this.q.length, sent: this.sent, dropped: this.dropped, failed: this.failed };
  }

  /** True when the item was queued; false when it was dropped or the SDK is off or shut down. */
  enqueue(kind: ItemKind, value: unknown): boolean {
    if (!this.enabled) return false;
    if (this.q.length >= this.cfg.maxQueue) {
      this.dropped++;
      const now = Date.now();
      if (now - this.lastDropWarn >= 60_000) {
        this.lastDropWarn = now;
        console.warn(`[coding.sh] queue full (${this.cfg.maxQueue} events), dropping new events`);
      }
      return false;
    }
    let json: string;
    try {
      json = JSON.stringify(value);
    } catch {
      this.dropped++;
      return false;
    }
    const bytes = enc.encode(json).length;
    if (bytes > MAX_BATCH_BYTES - 1024) {
      this.dropped++;
      this.warnOnce("too-large", "[coding.sh] dropped an event larger than 4 MiB");
      return false;
    }
    this.q.push({ kind, json, bytes });
    if (this.q.length >= this.cfg.maxBatch) this.kick();
    else this.schedule();
    return true;
  }

  private schedule(): void {
    if (this.timer || this.inflight) return;
    this.timer = unref(
      setTimeout(() => {
        this.timer = undefined;
        this.kick();
      }, this.cfg.flushIntervalMs),
    );
  }

  private kick(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.inflight || !this.q.length || this.cfg.url === undefined) return;
    this.inflight = this.drain().finally(() => {
      this.inflight = undefined;
      if (this.q.length && !this.closed) this.schedule();
    });
  }

  /** Sends everything queued, one batch at a time. */
  private async drain(): Promise<void> {
    while (this.q.length) {
      if (this.deadline !== undefined && Date.now() >= this.deadline) return;
      const batch = this.take();
      await this.send(batch);
    }
  }

  /** Up to maxBatch items (≤ 4 MiB) of the oldest item's kind, keeping order. */
  private take(): Item[] {
    const kind = this.q[0]!.kind;
    const out: Item[] = [];
    let bytes = 256;
    for (let i = 0; i < this.q.length && out.length < this.cfg.maxBatch; ) {
      const it = this.q[i]!;
      if (it.kind !== kind) {
        i++;
        continue;
      }
      if (out.length && bytes + it.bytes + 1 > MAX_BATCH_BYTES) break;
      out.push(it);
      bytes += it.bytes + 1;
      this.q.splice(i, 1);
    }
    return out;
  }

  private body(batch: Item[]): string {
    const items = batch.map((b) => b.json).join(",");
    if (batch[0]!.kind === "event") {
      const service = this.cfg.service ? `,"service":${JSON.stringify(this.cfg.service)}` : "";
      return `{"v":0${service},"events":[${items}]}`;
    }
    const resource = `{"attributes":[{"key":"service.name","value":{"stringValue":${JSON.stringify(this.cfg.service ?? "sdk")}}}]}`;
    return `{"resourceSpans":[{"resource":${resource},"scopeSpans":[{"scope":{"name":"${SPAN_SCOPE}"},"spans":[${items}]}]}]}`;
  }

  private async send(batch: Item[]): Promise<void> {
    const kind = batch[0]!.kind;
    const url = `${this.cfg.url}${kind === "event" ? "/v1/ingest" : "/v1/traces"}`;
    const text = this.body(batch);
    const gz = await gzip(text);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (gz) headers["content-encoding"] = "gzip";
    if (this.cfg.key) headers.authorization = `Bearer ${this.cfg.key}`;
    const doFetch = this.cfg.fetch ?? globalThis.fetch;
    const n = batch.length;
    const b: { n: number; done: boolean } = (this.current = { n, done: false });
    const settle = (sent: number, failed: number) => {
      if (b.done) return;
      b.done = true;
      this.sent += sent;
      this.failed += failed;
      if (sent > 0) this.flushGaveUp = false;
    };

    for (let attempt = 1; ; attempt++) {
      if (b.done) return; // abandoned by close()
      let status = 0;
      let wait: number | undefined;
      const controller = new AbortController();
      this.controller = controller;
      const timeout = unref(setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS));
      try {
        const res = await doFetch(url, { method: "POST", headers, body: (gz ?? text) as BodyInit, signal: controller.signal });
        status = res.status;
        if (res.ok) {
          const rejected = await this.rejectedCount(res, kind);
          settle(n - rejected, rejected);
          this.log(`sent ${n} ${kind}s (${status}${rejected ? `, ${rejected} rejected` : ""})`);
          return;
        }
        wait = retryAfterMs(res.headers.get("retry-after"));
        await res.arrayBuffer().catch(() => undefined);
      } catch {
        status = 0; // network error or timeout
      } finally {
        clearTimeout(timeout);
        this.controller = undefined;
      }

      const retryable = status === 0 || status === 429 || status >= 500;
      if (!retryable) {
        settle(0, n);
        this.warnOnce(`status-${status}`, `[coding.sh] server answered ${status} to ${url.replace(/^(https?:\/\/[^/]+).*$/, "$1")}/…; dropping ${n} ${kind}s${status === 401 || status === 403 ? " (check CODING_SH_INGEST_KEY)" : ""}`);
        return;
      }
      if (b.done) return;
      if (attempt >= MAX_ATTEMPTS || this.closedHard) {
        settle(0, n);
        this.warnOnce("gave-up", `[coding.sh] could not reach the server after ${attempt} attempts (last status ${status || "network error"}); dropping events`);
        return;
      }
      const delay = wait ?? Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (attempt - 1));
      if (this.deadline !== undefined && Date.now() + delay >= this.deadline) {
        settle(0, n);
        return;
      }
      this.log(`retry ${attempt}/${MAX_ATTEMPTS - 1} in ${Math.round(delay)} ms (status ${status || "network error"})`);
      await this.sleep(delay);
    }
  }

  private async rejectedCount(res: Response, kind: ItemKind): Promise<number> {
    try {
      const body = (await res.json()) as Record<string, unknown> | null;
      if (kind === "event") return Array.isArray(body?.rejected) ? body.rejected.length : 0;
      const ps = body?.partialSuccess as Record<string, unknown> | undefined;
      const r = Number(ps?.rejectedSpans ?? 0);
      return Number.isFinite(r) && r > 0 ? r : 0;
    } catch {
      return 0;
    }
  }

  /** Backoff sleep. It holds the process open only while someone awaits flush(). */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      if (this.flushing === 0) unref(t);
      this.sleepTimer = t;
      const self = this;
      function done() {
        clearTimeout(t);
        if (self.sleepTimer === t) self.sleepTimer = undefined;
        if (self.wake === done) self.wake = undefined;
        resolve();
      }
      this.wake = done;
    });
  }

  /**
   * Resolves once everything queued so far is sent (or given up on), or after
   * timeoutMs. True when the queue drained.
   */
  async flush(timeoutMs = 5000): Promise<boolean> {
    if (this.cfg.url === undefined) return true;
    const deadline = Date.now() + Math.max(0, timeoutMs);
    this.flushing++;
    try {
      while ((this.q.length || this.inflight) && Date.now() < deadline) {
        if (!this.inflight) this.kick();
        const current = this.inflight;
        if (!current) break;
        let t: Timer | undefined;
        await Promise.race([current, new Promise<void>((r) => (t = setTimeout(r, Math.max(1, deadline - Date.now()))))]);
        clearTimeout(t);
      }
    } finally {
      this.flushing--;
      // No flush() waits any more: a retry sleeping on from the one that gave up must not keep the process open.
      if (this.flushing === 0 && this.sleepTimer) unref(this.sleepTimer);
    }
    const drained = this.q.length === 0 && !this.inflight;
    if (!drained && !this.closed) {
      this.flushGaveUp = true;
      // A request the server accepted and never answered would hold the process open until its
      // 10 s timeout. Abort it once no flush() waits: the batch goes back to an unref'd retry.
      if (this.flushing === 0) this.controller?.abort();
      this.warnOnce(
        "flush-timeout",
        `[coding.sh] flush() gave up after ${timeoutMs} ms with ${this.q.length + (this.current && !this.current.done ? this.current.n : 0)} events not sent (the server did not answer); they are retried while the process runs and dropped when it exits`,
      );
    }
    return drained;
  }

  /**
   * Final bounded flush (process exit, shutdown): no retry outlives the
   * deadline and the request in flight is aborted when it passes.
   */
  async close(timeoutMs = 5000): Promise<boolean> {
    if (this.closed) return this.q.length === 0;
    this.deadline = Date.now() + Math.max(0, timeoutMs);
    const ok = await this.flush(timeoutMs);
    this.closed = true;
    this.closedHard = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!ok) {
      // Give up on what is left: count it once, stop the retry loop and the request in flight.
      const c = this.current;
      if (c && !c.done) {
        c.done = true;
        this.failed += c.n;
      }
      this.failed += this.q.length;
      this.q.length = 0;
      this.controller?.abort();
      this.wake?.();
    }
    return ok;
  }

  private warnOnce(key: string, msg: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(msg);
  }

  private log(msg: string): void {
    if (this.cfg.debug) console.error(`[coding.sh] ${msg}`);
  }
}
