// aiSdkTracer(): an OpenTelemetry Tracer-shaped object for the Vercel AI SDK.
//
// AI SDK ≤ 6:  generateText({ …, experimental_telemetry: { isEnabled: true, tracer: aiSdkTracer() } })
// AI SDK 7:    import { OpenTelemetry } from "@ai-sdk/otel";
//              generateText({ …, telemetry: { integrations: new OpenTelemetry({ tracer: aiSdkTracer() }) } })
//              (or registerTelemetry(new OpenTelemetry({ tracer: aiSdkTracer() })) once)
//
// Spans are encoded as OTLP JSON and sent to POST /v1/traces, where the
// server's existing ai.* / gen_ai.* mapping turns them into events. No
// @opentelemetry packages are needed: parents come from the context argument
// (AI SDK 7 passes trace.setSpan(...) contexts) or from the span made active
// by startActiveSpan (AI SDK ≤ 6).
//
// Sessions: spans get `session.id` from aiSdkTracer({ sessionId }), else from
// the surrounding withSession()/trace() session, so the call lands in that
// session; otherwise each AI SDK call is its own session (its trace).
import { AsyncLocalStorage } from "node:async_hooks";
import { config, enqueue } from "./client.ts";
import { currentSessionId } from "./context.ts";
import { isObj, newSpanId, newTraceId, nowMs } from "./util.ts";

/** @opentelemetry/api's context key for the active span (createContextKey uses Symbol.for). */
const SPAN_KEY = Symbol.for("OpenTelemetry Context Key SPAN");

const SESSION_ATTRS = ["gen_ai.conversation.id", "session.id", "ai.telemetry.metadata.sessionId", "ai.telemetry.metadata.session_id", "conversation.id"];

/** Attributes holding prompt/response text or tool I/O, dropped in metadata capture mode. */
const CONTENT_ATTR = /^(ai\.prompt|ai\.response\.(text|object|toolCalls|reasoning)|ai\.toolCall\.(args|result|input|output)|ai\.values?|ai\.embeddings?$|gen_ai\.(input|output)\.messages|gen_ai\.system_instructions|gen_ai\.tool\.call\.(arguments|result)|gen_ai\.(prompt|completion))/;

type AttrValue = string | number | boolean | Array<string | number | boolean | null | undefined> | null | undefined;
type Attributes = Record<string, AttrValue>;

type TimeInput = number | Date | [number, number];

interface SpanContext {
  traceId: string;
  spanId: string;
  traceFlags: number;
  isRemote?: boolean;
}

interface SpanOptionsLike {
  attributes?: Attributes;
  kind?: number;
  startTime?: TimeInput;
  root?: boolean;
  links?: unknown[];
}

interface ContextLike {
  getValue?(key: symbol): unknown;
}

export interface AiSdkTracerOptions {
  /** Session for every span this tracer makes (overrides withSession/trace). */
  sessionId?: string;
}

/** Epoch nanoseconds as a decimal string. */
function nanos(t: TimeInput | undefined): string {
  let ms: number;
  if (t instanceof Date) ms = t.getTime();
  else if (Array.isArray(t)) return (BigInt(Math.trunc(t[0])) * 1_000_000_000n + BigInt(Math.trunc(t[1]))).toString();
  else if (typeof t === "number" && Number.isFinite(t)) {
    // OTel TimeInput numbers are epoch ms, or performance.now() values when small.
    const perf = (globalThis as { performance?: { timeOrigin: number } }).performance;
    ms = t < 1e11 && perf ? perf.timeOrigin + t : t;
  } else ms = nowMs();
  const whole = Math.floor(ms);
  return (BigInt(whole) * 1_000_000n + BigInt(Math.round((ms - whole) * 1e6))).toString();
}

function anyValue(v: unknown): Record<string, unknown> | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { intValue: String(v) } : Number.isFinite(v) ? { doubleValue: v } : { stringValue: String(v) };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(anyValue).filter((x) => x !== undefined) } };
  try {
    return { stringValue: JSON.stringify(v) };
  } catch {
    return undefined;
  }
}

function encodeAttrs(a: Attributes): { key: string; value: Record<string, unknown> }[] {
  const out: { key: string; value: Record<string, unknown> }[] = [];
  for (const [key, v] of Object.entries(a)) {
    const value = anyValue(v);
    if (value) out.push({ key, value });
  }
  return out;
}

class SdkSpan {
  private ended = false;
  private readonly attributes: Attributes = {};
  private readonly events: { name: string; timeUnixNano: string; attributes: Attributes }[] = [];
  private status: { code: number; message?: string } = { code: 0 };
  private readonly start: string;
  private name: string;
  private readonly parentSpanId: string | undefined;
  private readonly kind: number;
  private readonly sessionId: string | undefined;
  readonly ctx: SpanContext;

  constructor(name: string, traceId: string, parentSpanId: string | undefined, kind: number, attrs: Attributes | undefined, startTime: TimeInput | undefined, sessionId: string | undefined) {
    this.name = name;
    this.parentSpanId = parentSpanId;
    this.kind = kind;
    this.sessionId = sessionId;
    this.ctx = { traceId, spanId: newSpanId(), traceFlags: 1 };
    this.start = nanos(startTime);
    if (attrs) this.setAttributes(attrs);
  }

  spanContext(): SpanContext {
    return this.ctx;
  }
  setAttribute(key: string, value: AttrValue): this {
    if (!this.ended && value !== undefined) this.attributes[key] = value;
    return this;
  }
  setAttributes(attrs: Attributes): this {
    if (isObj(attrs)) for (const [k, v] of Object.entries(attrs)) this.setAttribute(k, v);
    return this;
  }
  addEvent(name: string, attrsOrTime?: Attributes | TimeInput, time?: TimeInput): this {
    if (this.ended) return this;
    const isTime = attrsOrTime instanceof Date || typeof attrsOrTime === "number" || Array.isArray(attrsOrTime);
    this.events.push({
      name,
      attributes: !isTime && isObj(attrsOrTime) ? { ...(attrsOrTime as Attributes) } : {},
      timeUnixNano: nanos(isTime ? (attrsOrTime as TimeInput) : time),
    });
    return this;
  }
  addLink(): this {
    return this;
  }
  addLinks(): this {
    return this;
  }
  setStatus(status: { code: number; message?: string }): this {
    if (!this.ended && isObj(status)) this.status = { code: Number(status.code) || 0, ...(typeof status.message === "string" ? { message: status.message } : {}) };
    return this;
  }
  updateName(name: string): this {
    if (!this.ended) this.name = name;
    return this;
  }
  isRecording(): boolean {
    return !this.ended;
  }
  recordException(exc: unknown, time?: TimeInput): void {
    const e = isObj(exc) ? exc : { message: String(exc) };
    const attrs: Attributes = {};
    if (typeof e.name === "string") attrs["exception.type"] = e.name;
    if (typeof e.message === "string") attrs["exception.message"] = e.message;
    if (typeof e.stack === "string") attrs["exception.stacktrace"] = e.stack;
    this.addEvent("exception", attrs, time);
  }
  end(endTime?: TimeInput): void {
    if (this.ended) return;
    this.ended = true;
    try {
      const metadata = config().capture === "metadata";
      const attrs: Attributes = {};
      for (const [k, v] of Object.entries(this.attributes)) if (!(metadata && CONTENT_ATTR.test(k))) attrs[k] = v;
      if (this.sessionId && !SESSION_ATTRS.some((k) => attrs[k] !== undefined && attrs[k] !== "")) attrs["session.id"] = this.sessionId;
      const span: Record<string, unknown> = {
        traceId: this.ctx.traceId,
        spanId: this.ctx.spanId,
        name: this.name,
        // OTel API SpanKind (INTERNAL = 0) → OTLP Span.SpanKind (INTERNAL = 1)
        kind: (Number.isInteger(this.kind) ? this.kind : 0) + 1,
        startTimeUnixNano: this.start,
        endTimeUnixNano: nanos(endTime),
        attributes: encodeAttrs(attrs),
        events: this.events.map((e) => ({ name: e.name, timeUnixNano: e.timeUnixNano, attributes: encodeAttrs(metadata && e.name === "exception" ? {} : e.attributes) })),
        status: this.status,
      };
      if (this.parentSpanId) span.parentSpanId = this.parentSpanId;
      enqueue("span", span);
    } catch {
      // never break the AI SDK call
    }
  }
}

/** spanContext() of the span stored in an OTel context, if any. */
function parentFrom(ctx: unknown): SpanContext | undefined {
  try {
    const c = ctx as ContextLike | undefined;
    const span = typeof c?.getValue === "function" ? c.getValue(SPAN_KEY) : undefined;
    const sc = (span as { spanContext?: () => SpanContext } | undefined)?.spanContext?.();
    return sc && typeof sc.traceId === "string" && typeof sc.spanId === "string" && !/^0*$/.test(sc.traceId) ? sc : undefined;
  } catch {
    return undefined;
  }
}

export interface AiSdkTracer {
  startSpan(name: string, options?: SpanOptionsLike, context?: unknown): SdkSpan;
  startActiveSpan<F extends (span: SdkSpan) => unknown>(name: string, fn: F): ReturnType<F>;
  startActiveSpan<F extends (span: SdkSpan) => unknown>(name: string, options: SpanOptionsLike, fn: F): ReturnType<F>;
  startActiveSpan<F extends (span: SdkSpan) => unknown>(name: string, options: SpanOptionsLike, context: unknown, fn: F): ReturnType<F>;
}

/** An OpenTelemetry Tracer-shaped object that sends AI SDK spans to coding.sh. */
export function aiSdkTracer(opts: AiSdkTracerOptions = {}): AiSdkTracer {
  const active = new AsyncLocalStorage<SdkSpan>();

  const startSpan = (name: string, options: SpanOptionsLike = {}, context?: unknown): SdkSpan => {
    const parent = options?.root ? undefined : (parentFrom(context) ?? active.getStore()?.spanContext());
    const sessionId = opts.sessionId ?? currentSessionId();
    return new SdkSpan(String(name), parent?.traceId ?? newTraceId(), parent?.spanId, Number(options?.kind ?? 0), options?.attributes, options?.startTime, sessionId);
  };

  return {
    startSpan,
    startActiveSpan(name: string, ...args: unknown[]): never {
      const fn = args[args.length - 1] as (span: SdkSpan) => unknown;
      const options = (args.length >= 2 ? args[0] : undefined) as SpanOptionsLike | undefined;
      const context = args.length >= 3 ? args[1] : undefined;
      const span = startSpan(name, options, context);
      return active.run(span, () => fn(span)) as never;
    },
  } as AiSdkTracer;
}
