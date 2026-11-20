// Prometheus text exposition for `coding.sh serve` (§1.7). Label values are
// bounded: routes are a fixed set and projects come from the config.
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { AgentEvent, Session } from "../schema/index.ts";

type Labels = Record<string, string>;

const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
const labelText = (l: Labels) => {
  const keys = Object.keys(l);
  return keys.length ? `{${keys.map((k) => `${k}="${esc(l[k]!)}"`).join(",")}}` : "";
};

class Counter {
  readonly values = new Map<string, { labels: Labels; value: number }>();
  readonly name: string;
  readonly help: string;
  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }
  inc(labels: Labels = {}, by = 1): void {
    const key = labelText(labels);
    const cur = this.values.get(key);
    if (cur) cur.value += by;
    else this.values.set(key, { labels, value: by });
  }
  get(labels: Labels = {}): number {
    return this.values.get(labelText(labels))?.value ?? 0;
  }
  render(): string[] {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const { labels, value } of this.values.values()) out.push(`${this.name}${labelText(labels)} ${value}`);
    return out;
  }
}

/** Label sets per session counter; past it new values count under "other". */
const MAX_SERIES = 500;
/** Ended sessions remembered so each counts once; past it the oldest are forgotten. */
const MAX_SEEN = 200_000;

/** A label value, or "other" once the counter holds MAX_SERIES label sets and this one is new. */
function bounded(c: Counter, labels: Labels): Labels {
  if (c.values.size < MAX_SERIES || c.values.has(labelText(labels))) return labels;
  return Object.fromEntries(Object.keys(labels).map((k) => [k, "other"]));
}

const TICK_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export class ServeMetrics {
  readonly httpRequests = new Counter("coding_sh_http_requests_total", "HTTP requests by route and status.");
  readonly ingestEvents = new Counter("coding_sh_ingest_events_total", "Ingested events by project and result.");
  readonly throttled = new Counter("coding_sh_ingest_throttled_total", "Ingest requests refused with 429 (queue full).");
  readonly authFailures = new Counter("coding_sh_ingest_auth_failures_total", "Ingest requests with a missing or bad key.");
  readonly storeErrors = new Counter("coding_sh_store_errors_total", "Writer ticks that failed on a store error.");
  readonly forwardSpans = new Counter("coding_sh_forward_spans_total", "Spans forwarded to the OTLP collector, by result (sent, dropped, failed).");
  readonly sinkEvents = new Counter("coding_sh_sink_events_total", "Events mirrored to [[sinks]], by sink and result (sent, dropped, failed).");
  readonly sessionCost = new Counter("coding_sh_session_cost_usd_total", "Cost in USD of the sessions serve saw end, by agent and model (subagent sessions included).");
  readonly sessions = new Counter("coding_sh_sessions_total", "Top-level sessions serve saw end, by agent and outcome (failed: the session has a failure flag).");
  readonly sessionFlags = new Counter("coding_sh_session_flags_total", "Failure flags (flags with no colon) on the top-level sessions serve saw end.");
  private readonly seenEnded = new Set<string>();
  private readonly tickCounts = new Array<number>(TICK_BUCKETS.length + 1).fill(0);
  private tickSum = 0;
  private tickCount = 0;
  // Absent on some serverless runtimes (the fetch handler); the lag gauge then reads 0.
  private readonly loop: ReturnType<typeof monitorEventLoopDelay> | undefined = (() => {
    try {
      return monitorEventLoopDelay({ resolution: 20 });
    } catch {
      return undefined;
    }
  })();
  /** Read at render time. */
  gauges: { queueEvents: () => number; queueBytes: () => number; writerLockHeld: () => boolean; forwardBufferSpans?: () => number } = {
    queueEvents: () => 0,
    queueBytes: () => 0,
    writerLockHeld: () => false,
  };

  constructor() {
    this.loop?.enable();
  }

  observeTick(seconds: number): void {
    this.tickSum += seconds;
    this.tickCount++;
    const i = TICK_BUCKETS.findIndex((b) => seconds <= b);
    this.tickCounts[i === -1 ? TICK_BUCKETS.length : i]!++;
  }

  /**
   * After a writer tick: counts the rebuilt sessions whose session.end the tick
   * stored. Never throws; a metrics bug does not fail ingest.
   */
  observeCommit(events: readonly AgentEvent[], sessions: readonly Session[]): void {
    try {
      const ended = new Set<string>();
      for (const e of events) if (e.kind === "session.end") ended.add(e.sessionId);
      if (ended.size) this.observeSessions(sessions.filter((s) => ended.has(s.id)));
    } catch {
      // The counters are best effort.
    }
  }

  /**
   * Counts ended sessions, each once. Cost or flags a session gains after it is
   * counted are not added.
   */
  observeSessions(sessions: readonly Session[]): void {
    for (const s of sessions) {
      const key = `${s.project ?? ""}\0${s.id}`;
      if (this.seenEnded.has(key)) continue;
      this.seenEnded.add(key);
      if (this.seenEnded.size > MAX_SEEN) this.seenEnded.delete(this.seenEnded.values().next().value!);
      const agent = String(s.agent);
      const cost = s.stats.usage?.costUsd;
      if (cost !== undefined && Number.isFinite(cost) && cost > 0) this.sessionCost.inc(bounded(this.sessionCost, { agent, model: s.model || "unknown" }), cost);
      if (s.parent) continue;
      const failures = s.flags.filter((f) => !f.includes(":"));
      this.sessions.inc(bounded(this.sessions, { agent, outcome: failures.length ? "failed" : "ok" }));
      for (const flag of new Set(failures)) this.sessionFlags.inc(bounded(this.sessionFlags, { flag }));
    }
  }

  close(): void {
    this.loop?.disable();
  }

  render(): string {
    const out: string[] = [];
    for (const c of [this.httpRequests, this.ingestEvents, this.throttled, this.authFailures, this.storeErrors]) out.push(...c.render());
    if (this.gauges.forwardBufferSpans) {
      out.push(...this.forwardSpans.render());
      out.push("# HELP coding_sh_forward_buffer_spans Spans waiting to be forwarded.", "# TYPE coding_sh_forward_buffer_spans gauge", `coding_sh_forward_buffer_spans ${this.gauges.forwardBufferSpans()}`);
    }
    if (this.sinkEvents.values.size) out.push(...this.sinkEvents.render());
    for (const c of [this.sessionCost, this.sessions, this.sessionFlags]) if (c.values.size) out.push(...c.render());
    out.push("# HELP coding_sh_queue_events Events waiting for the writer.", "# TYPE coding_sh_queue_events gauge", `coding_sh_queue_events ${this.gauges.queueEvents()}`);
    out.push("# HELP coding_sh_queue_bytes Decoded bytes waiting for the writer.", "# TYPE coding_sh_queue_bytes gauge", `coding_sh_queue_bytes ${this.gauges.queueBytes()}`);
    out.push("# HELP coding_sh_writer_lock_held 1 when this replica holds the writer lock.", "# TYPE coding_sh_writer_lock_held gauge", `coding_sh_writer_lock_held ${this.gauges.writerLockHeld() ? 1 : 0}`);
    out.push("# HELP coding_sh_writer_tick_seconds Writer tick duration.", "# TYPE coding_sh_writer_tick_seconds histogram");
    let cum = 0;
    TICK_BUCKETS.forEach((b, i) => {
      cum += this.tickCounts[i]!;
      out.push(`coding_sh_writer_tick_seconds_bucket{le="${b}"} ${cum}`);
    });
    cum += this.tickCounts[TICK_BUCKETS.length]!;
    out.push(`coding_sh_writer_tick_seconds_bucket{le="+Inf"} ${cum}`, `coding_sh_writer_tick_seconds_sum ${this.tickSum}`, `coding_sh_writer_tick_seconds_count ${this.tickCount}`);
    out.push("# HELP process_resident_memory_bytes Resident memory size in bytes.", "# TYPE process_resident_memory_bytes gauge", `process_resident_memory_bytes ${process.memoryUsage?.rss?.() ?? 0}`);
    const lag = this.loop && Number.isFinite(this.loop.mean) ? this.loop.mean / 1e9 : 0;
    out.push("# HELP nodejs_eventloop_lag_seconds Mean event loop delay.", "# TYPE nodejs_eventloop_lag_seconds gauge", `nodejs_eventloop_lag_seconds ${lag}`);
    this.loop?.reset();
    return out.join("\n") + "\n";
  }
}
