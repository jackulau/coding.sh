// Serve's OTLP forward (CODING_SH_FORWARD_URL, [serve.forward]): after the
// writer commits a tick, its traces go on to an OTLP/HTTP collector, so a team
// fills ClickHouse/ClickStack/Grafana from the one central server instead of a
// sink on every laptop.
//
// - Spans received over OTLP keep their own trace and span ids (they line up
//   with the app's other spans in the backend). Native /v1/ingest batches are
//   converted with toOtlpRequest (invoke_agent / execute_tool / chat spans).
// - Every resource gets `coding_sh.project`.
// - Metadata mode is an allowlist (see keepInMetadata); full mode keeps every
//   attribute and runs serve's redactor over every string.
// - Never on the ingest path: a bounded in-memory buffer (oldest dropped) is
//   flushed every second or at 1,000 spans, with backoff from 1 s to 60 s on
//   network errors, 429 and 5xx (Retry-After wins). Other 4xx drop the batch.
import type { AgentEvent, Session } from "../schema/index.ts";
import type { Redactor } from "../core/redact.ts";
import type { OtelValue, ResourceSpans } from "../otel/model.ts";
import type { OpenSession } from "../core/types.ts";
import { otlpTracesUrl, toOtlpOpenSessionRequest, toOtlpRequest } from "../sinks/otlp.ts";
import { DEFAULT_TIMEOUT_MS, parseRetryAfter, redactUrl } from "../sinks/post.ts";
import type { ForwardConfig } from "./config.ts";
import type { Logger } from "./log.ts";
import type { ServeMetrics } from "./metrics.ts";

export const PROJECT_ATTR = "coding_sh.project";
const FLUSH_MS = 1000;
const BATCH_SPANS = 1000;
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;
const WARN_EVERY_MS = 60_000;
const QUIET_MS = 10_000;
const REFRESH_MS = 60_000;

// ---- OTLP/JSON shapes (what the collector receives)

export type AnyValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean }
  | { arrayValue: { values: AnyValue[] } }
  | { kvlistValue: { values: KeyValue[] } }
  | Record<string, never>;

export interface KeyValue {
  key: string;
  value: AnyValue;
}

export interface JsonSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  traceState?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: KeyValue[];
  events?: { timeUnixNano: string; name: string; attributes: KeyValue[] }[];
  links?: { traceId: string; spanId: string; attributes: KeyValue[] }[];
  status?: { code: number; message?: string };
  flags?: number;
}

interface JsonResource {
  attributes: KeyValue[];
}
interface JsonScope {
  name: string;
  version?: string;
  attributes?: KeyValue[];
}

/** One buffered span with the resource and scope it was sent under (shared objects per request). */
interface Item {
  resource: JsonResource;
  resourceSchemaUrl?: string;
  scope: JsonScope;
  scopeSchemaUrl?: string;
  span: JsonSpan;
}

// ---- the metadata allowlist

const KEEP_EXACT = new Set([
  "gen_ai.operation.name",
  "gen_ai.provider.name",
  "gen_ai.system",
  "gen_ai.request.model",
  "gen_ai.response.model",
  "gen_ai.response.id",
  "gen_ai.response.finish_reasons",
  "gen_ai.tool.name",
  "gen_ai.tool.call.id",
  "gen_ai.tool.type",
  "gen_ai.agent.name",
  "gen_ai.agent.id",
  "gen_ai.conversation.id",
  "http.request.method",
  "http.response.status_code",
  "error.type",
]);
const KEEP_PREFIX = ["gen_ai.usage.", "service.", "telemetry.", "coding_sh."];
const DROP_EXACT = new Set(["coding_sh.session.title", "coding_sh.repo.root"]);

const isScalarNonString = (v: AnyValue): boolean => "boolValue" in v || "intValue" in v || "doubleValue" in v;

/** Whether metadata mode forwards this attribute: an allowlisted key, or any boolean or number. */
export function keepInMetadata(key: string, value: AnyValue): boolean {
  if (DROP_EXACT.has(key)) return false;
  if (KEEP_EXACT.has(key) || KEEP_PREFIX.some((p) => key.startsWith(p))) return true;
  return isScalarNonString(value);
}

// ---- conversion from the receiver's normalized model

function toAnyValue(v: OtelValue): AnyValue {
  if (v === null) return {};
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toAnyValue) } };
  return { kvlistValue: { values: Object.entries(v).map(([key, x]) => ({ key, value: toAnyValue(x) })) } };
}

const toKvs = (a: Record<string, OtelValue> | undefined): KeyValue[] => Object.entries(a ?? {}).map(([key, v]) => ({ key, value: toAnyValue(v) }));

function deepRedact(v: AnyValue, r: Redactor): AnyValue {
  if ("stringValue" in v) return { stringValue: r.string(v.stringValue) };
  if ("arrayValue" in v) return { arrayValue: { values: v.arrayValue.values.map((x) => deepRedact(x, r)) } };
  if ("kvlistValue" in v) return { kvlistValue: { values: v.kvlistValue.values.map((kv) => ({ key: kv.key, value: deepRedact(kv.value, r) })) } };
  return v;
}

/** Applies the forward mode to a list of attributes (a new list). */
export function scrubAttrs(kvs: KeyValue[] | undefined, mode: "full" | "metadata", r: Redactor): KeyValue[] {
  const out: KeyValue[] = [];
  for (const kv of kvs ?? []) {
    if (mode === "metadata" && !keepInMetadata(kv.key, kv.value)) continue;
    out.push({ key: kv.key, value: deepRedact(kv.value, r) });
  }
  return out;
}

/** Applies the forward mode to one span (a new span). */
export function scrubSpan(s: JsonSpan, mode: "full" | "metadata", r: Redactor): JsonSpan {
  const meta = mode === "metadata";
  const out: JsonSpan = { ...s, name: r.string(s.name), attributes: scrubAttrs(s.attributes, mode, r) };
  if (s.events) {
    out.events = s.events.map((e) => ({
      timeUnixNano: e.timeUnixNano,
      name: e.name,
      // Span event attributes carry prompts, tool output and stack traces; metadata keeps the exception type only.
      attributes: meta ? scrubAttrs(e.attributes.filter((kv) => kv.key === "exception.type"), "full", r) : scrubAttrs(e.attributes, "full", r),
    }));
  }
  if (s.links) out.links = s.links.map((l) => ({ ...l, attributes: scrubAttrs(l.attributes, mode, r) }));
  if (s.status) {
    out.status = { code: s.status.code };
    if (!meta && s.status.message) out.status.message = r.string(s.status.message);
  }
  return out;
}

function withProject(attrs: KeyValue[], project: string): KeyValue[] {
  return [...attrs.filter((kv) => kv.key !== PROJECT_ATTR), { key: PROJECT_ATTR, value: { stringValue: project } }];
}

function fromModelSpan(s: ResourceSpans["scopeSpans"][number]["spans"][number]): JsonSpan | undefined {
  if (!s.traceId || !s.spanId) return undefined;
  const out: JsonSpan = {
    traceId: s.traceId,
    spanId: s.spanId,
    name: s.name,
    kind: s.kind,
    startTimeUnixNano: s.startTimeUnixNano,
    endTimeUnixNano: s.endTimeUnixNano,
    attributes: toKvs(s.attributes),
  };
  if (s.parentSpanId) out.parentSpanId = s.parentSpanId;
  if (s.traceState) out.traceState = s.traceState;
  if (s.flags !== undefined) out.flags = s.flags;
  if (s.events.length) out.events = s.events.map((e) => ({ timeUnixNano: e.timeUnixNano, name: e.name, attributes: toKvs(e.attributes) }));
  const links = s.links.filter((l) => l.traceId && l.spanId);
  if (links.length) out.links = links.map((l) => ({ traceId: l.traceId!, spanId: l.spanId!, attributes: toKvs(l.attributes) }));
  if (s.status.code || s.status.message) out.status = { code: s.status.code, ...(s.status.message ? { message: s.status.message } : {}) };
  return out;
}

/** Groups buffered spans back into an ExportTraceServiceRequest. */
export function toRequest(items: Item[]): { resourceSpans: unknown[] } {
  const byResource = new Map<JsonResource, { schemaUrl?: string; scopes: Map<JsonScope, { schemaUrl?: string; spans: JsonSpan[] }> }>();
  for (const it of items) {
    let r = byResource.get(it.resource);
    if (!r) byResource.set(it.resource, (r = { ...(it.resourceSchemaUrl ? { schemaUrl: it.resourceSchemaUrl } : {}), scopes: new Map() }));
    let sc = r.scopes.get(it.scope);
    if (!sc) r.scopes.set(it.scope, (sc = { ...(it.scopeSchemaUrl ? { schemaUrl: it.scopeSchemaUrl } : {}), spans: [] }));
    sc.spans.push(it.span);
  }
  return {
    resourceSpans: [...byResource].map(([resource, r]) => ({
      resource,
      scopeSpans: [...r.scopes].map(([scope, sc]) => ({ scope, spans: sc.spans, ...(sc.schemaUrl ? { schemaUrl: sc.schemaUrl } : {}) })),
      ...(r.schemaUrl ? { schemaUrl: r.schemaUrl } : {}),
    })),
  };
}

// ---- the forwarder

export interface ForwarderOptions {
  config: ForwardConfig;
  /** Serve's redactor (capture.redact + redactPatterns). */
  redactor: Redactor;
  metrics?: ServeMetrics;
  log?: Logger;
  fetch?: typeof fetch;
  /** Flush interval (default 1 s; tests shrink it). */
  flushMs?: number;
  /** Spans per POST, and the buffer size that triggers a flush at once (default 1,000). */
  batchSpans?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  timeoutMs?: number;
  /** An open session's invoke_agent span is sent once none of its events went out for this long (default 10 s). */
  quietMs?: number;
  /** A session that never goes quiet has its span sent this often (default 60 s). */
  refreshMs?: number;
}

/** A native session whose events went out with no session.end: its invoke_agent span is still owed. */
interface OpenRecord extends OpenSession {
  project: string;
  /** When its events first went out with no span after them. */
  since: number;
  /** When its events last went out. */
  at: number;
}

type PostResult = { ok: true } | { ok: false; retry: true; afterMs?: number; error: string } | { ok: false; retry: false; error: string };

export class OtlpForwarder {
  readonly url: string;
  private readonly o: ForwarderOptions;
  private readonly mode: "full" | "metadata";
  private readonly items: Item[] = [];
  private readonly timer: NodeJS.Timeout;
  private running: Promise<void> | undefined;
  private retryAt = 0;
  private backoff = 0;
  /** Spans in the request under way: out of `items` until it answers, back in when it is to be retried. */
  private sending = 0;
  private lastWarn = 0;
  private closed = false;
  /** Native sessions that have sent events and not their invoke_agent span (a session.end carries it). */
  private readonly open = new Map<string, OpenRecord>();

  constructor(o: ForwarderOptions) {
    this.o = o;
    this.mode = o.config.mode;
    this.url = otlpTracesUrl(o.config.endpoint);
    this.timer = setInterval(() => {
      this.queueOpen(false);
      void this.pump();
    }, o.flushMs ?? FLUSH_MS);
    this.timer.unref();
  }

  /** Spans waiting to be sent, the batch in a request that has not answered included. */
  get buffered(): number {
    return this.items.length + this.sending;
  }

  /** Spans received over OTLP, as the receiver decoded them, after the tick that stored them committed. */
  enqueue(resourceSpans: ResourceSpans[], project: string): void {
    const r = this.o.redactor;
    const items: Item[] = [];
    for (const rs of resourceSpans) {
      const resource: JsonResource = { attributes: withProject(scrubAttrs(toKvs(rs.resource.attributes), this.mode, r), project) };
      for (const ss of rs.scopeSpans) {
        const scope: JsonScope = { name: ss.scope.name };
        if (ss.scope.version) scope.version = ss.scope.version;
        const sa = scrubAttrs(toKvs(ss.scope.attributes), this.mode, r);
        if (sa.length) scope.attributes = sa;
        for (const sp of ss.spans) {
          const span = fromModelSpan(sp);
          if (!span) continue;
          items.push({
            resource,
            ...(rs.resource.schemaUrl ? { resourceSchemaUrl: rs.resource.schemaUrl } : {}),
            scope,
            ...(ss.scope.schemaUrl ? { scopeSchemaUrl: ss.scope.schemaUrl } : {}),
            span: scrubSpan(span, this.mode, r),
          });
        }
      }
    }
    this.push(items);
  }

  /** Native /v1/ingest events (already scoped and redacted), converted to GenAI spans. */
  enqueueNative(events: AgentEvent[], sessions: Session[], project: string): void {
    this.push(this.nativeItems(toOtlpRequest(events, sessions, this.mode), project));
    this.track(events, sessions, project);
  }

  private nativeItems(req: ReturnType<typeof toOtlpRequest>, project: string): Item[] {
    const r = this.o.redactor;
    const items: Item[] = [];
    for (const rs of req.resourceSpans) {
      const resource: JsonResource = { attributes: withProject(scrubAttrs(rs.resource.attributes as KeyValue[], this.mode, r), project) };
      for (const ss of rs.scopeSpans) {
        const scope: JsonScope = { ...ss.scope };
        for (const span of ss.spans) {
          items.push({ resource, resourceSchemaUrl: rs.schemaUrl, scope, scopeSchemaUrl: ss.schemaUrl, span: scrubSpan(span as JsonSpan, this.mode, r) });
        }
      }
    }
    return items;
  }

  /** After events went out: a session.end carried the session's span; any other session's span is now owed. */
  private track(events: AgentEvent[], sessions: Session[], project: string): void {
    const now = Date.now();
    const byId = new Map(sessions.map((s) => [s.id, s]));
    const last = new Map<string, number>();
    const ended = new Set<string>();
    for (const e of events) {
      last.set(e.sessionId, Math.max(last.get(e.sessionId) ?? 0, e.ts));
      if (e.kind === "session.end") ended.add(e.sessionId);
    }
    for (const [id, ts] of last) {
      if (ended.has(id)) {
        this.open.delete(id);
        continue;
      }
      const was = this.open.get(id);
      const session = byId.get(id) ?? was?.session;
      if (session) this.open.set(id, { session, project, lastEventAt: Math.max(was?.lastEventAt ?? 0, ts), since: was?.since ?? now, at: now });
    }
  }

  /** Buffers the invoke_agent span of the open sessions that are due (all of them when `all`). */
  private queueOpen(all: boolean): void {
    if (!this.open.size) return;
    const now = Date.now();
    const quiet = this.o.quietMs ?? QUIET_MS;
    const every = this.o.refreshMs ?? REFRESH_MS;
    const due = [...this.open.values()].filter((o) => all || now - o.at >= quiet || now - o.since >= every);
    const byProject = new Map<string, OpenRecord[]>();
    for (const o of due) {
      this.open.delete(o.session.id);
      byProject.set(o.project, [...(byProject.get(o.project) ?? []), o]);
    }
    for (const [project, recs] of byProject) this.push(this.nativeItems(toOtlpOpenSessionRequest(recs.map(({ session, lastEventAt }) => ({ session, lastEventAt })), this.mode), project));
  }

  private push(items: Item[]): void {
    if (this.closed || !items.length) return;
    this.items.push(...items);
    this.trim();
    if (this.items.length >= (this.o.batchSpans ?? BATCH_SPANS)) setImmediate(() => void this.pump());
  }

  private trim(): void {
    const over = this.items.length - this.o.config.maxBufferSpans;
    if (over <= 0) return;
    this.items.splice(0, over);
    this.o.metrics?.forwardSpans.inc({ result: "dropped" }, over);
    this.warn("forward buffer full; dropped the oldest spans", { dropped: over, max: this.o.config.maxBufferSpans });
  }

  private warn(msg: string, fields: Record<string, unknown>): void {
    const now = Date.now();
    if (now - this.lastWarn < WARN_EVERY_MS) return;
    this.lastWarn = now;
    this.o.log?.warn(msg, { endpoint: redactUrl(this.url), ...fields });
  }

  /** Sends every open session's span too, then what is buffered: nothing may run after a serverless request ends. */
  flush(): Promise<void> {
    this.queueOpen(true);
    return this.pump();
  }

  /** Sends what is buffered (unless backing off). Resolves when this round is done. */
  pump(): Promise<void> {
    this.running ??= this.sendAll().finally(() => (this.running = undefined));
    return this.running;
  }

  private async sendAll(): Promise<void> {
    const size = this.o.batchSpans ?? BATCH_SPANS;
    while (this.items.length && Date.now() >= this.retryAt) {
      const batch = this.items.splice(0, size);
      this.sending = batch.length;
      const r = await this.post(toRequest(batch)).finally(() => (this.sending = 0));
      if (r.ok) {
        this.backoff = 0;
        this.o.metrics?.forwardSpans.inc({ result: "sent" }, batch.length);
        continue;
      }
      if (r.retry) {
        // Back at the front; the buffer cap still holds (the oldest go first).
        this.items.unshift(...batch);
        this.trim();
        const min = this.o.minBackoffMs ?? MIN_BACKOFF_MS;
        const max = this.o.maxBackoffMs ?? MAX_BACKOFF_MS;
        this.backoff = Math.min(max, this.backoff ? this.backoff * 2 : min);
        const wait = r.afterMs !== undefined ? Math.min(r.afterMs, max) : this.backoff;
        this.retryAt = Date.now() + wait;
        this.warn("forwarding traces failed; retrying", { error: r.error, retryInMs: wait, buffered: this.items.length });
        return;
      }
      this.o.metrics?.forwardSpans.inc({ result: "failed" }, batch.length);
      this.o.log?.warn("the collector refused forwarded traces; dropped the batch", { endpoint: redactUrl(this.url), error: r.error, spans: batch.length });
    }
  }

  private async post(body: unknown): Promise<PostResult> {
    const doFetch = this.o.fetch ?? globalThis.fetch;
    const timeout = this.o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let res: Response;
    try {
      res = await doFetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "coding.sh", ...this.o.config.headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      const e = err as Error;
      const reason = e.name === "TimeoutError" ? `timed out after ${timeout}ms` : ((e.cause as Error | undefined)?.message ?? e.message);
      return { ok: false, retry: true, error: `POST ${redactUrl(this.url)} failed: ${reason}` };
    }
    const text = await res.text().catch(() => "");
    if (res.ok) return { ok: true };
    const error = `POST ${redactUrl(this.url)} → ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}`;
    if (res.status === 429 || res.status === 408 || res.status >= 500) {
      const afterMs = parseRetryAfter(res.headers.get("retry-after"));
      return { ok: false, retry: true, error, ...(afterMs !== undefined ? { afterMs } : {}) };
    }
    return { ok: false, retry: false, error };
  }

  /**
   * Stops the timer and sends what is buffered for up to timeoutMs (waiting out
   * backoff inside that window). Spans still buffered after it are dropped.
   */
  async close(timeoutMs: number): Promise<{ left: number }> {
    if (this.closed) return { left: this.items.length };
    this.queueOpen(true);
    this.closed = true;
    clearInterval(this.timer);
    const deadline = Date.now() + timeoutMs;
    while (this.items.length && Date.now() < deadline) {
      const wait = this.retryAt - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait, deadline - Date.now())));
      if (Date.now() >= deadline) break;
      await this.pump();
    }
    if (this.running) await Promise.race([this.running, new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now())))]);
    const left = this.items.length;
    if (left) {
      this.o.metrics?.forwardSpans.inc({ result: "dropped" }, left);
      this.o.log?.warn("shut down with traces still unforwarded", { endpoint: redactUrl(this.url), dropped: left });
      this.items.length = 0;
    }
    return { left };
  }
}
