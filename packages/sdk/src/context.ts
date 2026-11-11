// Traces, spans and sessions, and the events they produce.
//
// The event layout mirrors what the server's OTLP mapper (src/otel/map.ts in
// the coding.sh package) makes of the equivalent OTel spans, so a conversation
// sent through the SDK and the same one sent through OTel build the same
// Session.stats:
//
//   trace (root)     session.start · user.message (input) · … · turn.end
//                    · session.end (only when the session is the trace itself)
//   model call       llm.call (ts = start, durationMs, usage, model) · assistant.message (ts = end)
//   tool span        tool.start · tool.end
//   step span        span { name, ok }
//
// A model call or tool span outside any trace is its own root (a one-call
// session), unless withSession() names the session it belongs to.
import { AsyncLocalStorage } from "node:async_hooks";
import { config, enqueue } from "./client.ts";
import { detectGateway, type HeaderGetter } from "./gateway.ts";
import { errorMessage, newSpanId, newTraceId, nowMs, safeJson, truncate, uuid } from "./util.ts";

/** Kinds from the coding.sh/trace v0 schema this SDK emits. */
export type EventKind =
  | "session.start"
  | "session.end"
  | "user.message"
  | "assistant.message"
  | "llm.call"
  | "tool.start"
  | "tool.end"
  | "turn.end"
  | "span"
  | "error";

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** What the SDK sends per event (the server adds project, source and agent). */
export interface SdkEvent {
  v: 0;
  id: string;
  sessionId: string;
  kind: EventKind;
  ts: number;
  durationMs?: number;
  turnId?: string;
  parentId?: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  model?: string;
  usage?: Usage;
  payload: Record<string, unknown>;
}

interface TraceState {
  traceId: string;
  sessionId: string;
  /** True when the session is a conversation (named), not the trace itself. */
  conversation: boolean;
}

interface SpanState {
  trace: TraceState;
  spanId: string;
  parentSpanId?: string;
  /** Id of this span's first event: children point at it with parentId. */
  anchorId: string;
}

interface Ctx {
  sessionId?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
  span?: SpanState;
  /** Set while an observed client runs, so observeFetch doesn't record the same call twice. */
  inClientCall?: boolean;
}

const als = new AsyncLocalStorage<Ctx>();

export const currentCtx = (): Ctx | undefined => als.getStore();

export function runInCtx<T>(patch: Partial<Ctx>, fn: () => T): T {
  return als.run({ ...als.getStore(), ...patch }, fn);
}

/** The session id the current context would record into, if one is fixed. */
export function currentSessionId(): string | undefined {
  const c = als.getStore();
  return c?.span?.trace.sessionId ?? c?.sessionId;
}

const metadataMode = (): boolean => config().capture === "metadata";

/** Text for a payload field, truncated; undefined in metadata capture mode. */
function text(p: Record<string, unknown>, key: string, v: unknown): void {
  if (v === undefined || v === null || metadataMode()) return;
  const s = typeof v === "string" ? v : safeJson(v);
  if (!s) return;
  const t = truncate(s);
  p[key] = t.text;
  if (t.truncated) p.truncated = true;
}

/** Structured tool input/output: kept as is when small, else a truncated JSON string. */
function data(p: Record<string, unknown>, key: string, v: unknown): void {
  if (v === undefined || metadataMode()) return;
  if (typeof v === "string") return text(p, key, v);
  const s = safeJson(v);
  const t = truncate(s);
  if (t.truncated) {
    p[key] = t.text;
    p.truncated = true;
  } else {
    try {
      p[key] = JSON.parse(s);
    } catch {
      p[key] = s;
    }
  }
}

function clean(p: Record<string, unknown>): Record<string, unknown> {
  for (const k of Object.keys(p)) if (p[k] === undefined) delete p[k];
  return p;
}

function emit(span: SpanState, kind: EventKind, ts: number, payload: Record<string, unknown>, extra: Partial<SdkEvent> = {}): SdkEvent {
  const e: SdkEvent = {
    v: 0,
    id: extra.id ?? uuid(),
    sessionId: span.trace.sessionId,
    kind,
    // Integer ms, like every other capture path (stores keep ts as an integer).
    ts: Math.floor(ts),
    traceId: span.trace.traceId,
    spanId: span.spanId,
    payload: clean(payload),
  };
  if (span.parentSpanId) e.parentSpanId = span.parentSpanId;
  if (span.trace.conversation) e.turnId = span.trace.traceId;
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && k !== "id") (e as unknown as Record<string, unknown>)[k] = v;
  if (e.durationMs !== undefined) e.durationMs = Math.max(0, Math.round(e.durationMs * 1000) / 1000);
  enqueue("event", e);
  return e;
}

// ---------------------------------------------------------------- traces

export interface TraceOptions {
  /** Groups the turns of one conversation into one session. Default: the trace is its own session. */
  sessionId?: string;
  /** Your user's id, recorded on the turn's session.start event. */
  userId?: string;
  /** Any JSON object, recorded on the turn's session.start event. */
  metadata?: Record<string, unknown>;
  /** The turn's input (a prompt string, or any JSON value); becomes the session's user.message. */
  input?: unknown;
}

export interface TraceHandle {
  traceId: string;
  spanId: string;
  sessionId: string;
}

type Settle = (ok: boolean, value: unknown, err: unknown) => void;

/** Calls fn, then settle() once with its result (sync or async). Never changes what fn returns or throws. */
function around<T>(fn: () => T, settle: Settle): T {
  let r: T;
  try {
    r = fn();
  } catch (err) {
    settle(false, undefined, err);
    throw err;
  }
  if (r && typeof (r as { then?: unknown }).then === "function") {
    (r as unknown as PromiseLike<unknown>).then(
      (v) => settle(true, v, undefined),
      (err) => settle(false, undefined, err),
    );
    return r;
  }
  settle(true, r, undefined);
  return r;
}

function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    // never let observation break the app
  }
}

function openRoot(sessionId: string | undefined): SpanState {
  const traceId = newTraceId();
  return {
    trace: { traceId, sessionId: sessionId ?? traceId, conversation: sessionId !== undefined && sessionId !== traceId },
    spanId: newSpanId(),
    anchorId: uuid(),
  };
}

/**
 * Runs fn as one traced turn. Model calls, tools and steps inside it join the
 * trace. A trace nested inside another trace is recorded as a step span.
 */
export function trace<T>(name: string, fn: (t: TraceHandle) => T, opts: TraceOptions = {}): T {
  const parent = als.getStore();
  if (parent?.span) return span("step", name, () => fn(handle(als.getStore()!.span!)), { input: opts.input });
  let root: SpanState;
  let start: number;
  try {
    root = openRoot(opts.sessionId ?? parent?.sessionId);
    start = nowMs();
    const userId = opts.userId ?? parent?.userId;
    const metadata = opts.metadata ?? parent?.metadata;
    safe(() => {
      emit(root, "session.start", start, { name, traceId: root.trace.traceId, userId, metadata }, { id: root.anchorId });
      if (opts.input !== undefined) {
        const p: Record<string, unknown> = {};
        text(p, "text", opts.input);
        emit(root, "user.message", start, p);
      }
    });
  } catch {
    return fn({ traceId: "", spanId: "", sessionId: "" });
  }
  const ctx: Ctx = { ...parent, span: root };
  if (opts.sessionId) ctx.sessionId = opts.sessionId;
  if (opts.userId) ctx.userId = opts.userId;
  if (opts.metadata) ctx.metadata = opts.metadata;
  return als.run(ctx, () =>
    around(
      () => fn(handle(root)),
      (ok, value, err) =>
        safe(() => {
          const end = nowMs();
          const durationMs = end - start;
          const error = ok ? undefined : errorMessage(err);
          const p: Record<string, unknown> = { ok, error, durationMs };
          if (ok && typeof value === "string") text(p, "output", value);
          emit(root, "turn.end", end, p, { durationMs });
          if (!root.trace.conversation) emit(root, "session.end", end, { reason: ok ? "completed" : "error", error }, { durationMs });
        }),
    ),
  );
}

function handle(s: SpanState): TraceHandle {
  return { traceId: s.trace.traceId, spanId: s.spanId, sessionId: s.trace.sessionId };
}

export interface SpanOptions {
  /** Tool arguments (tool spans) or step input. */
  input?: unknown;
}

/**
 * Runs fn as a tool call (tool.start/tool.end) or a step (span) inside the
 * current trace. Outside a trace it becomes its own one-span trace.
 */
export function span<T>(kind: "tool" | "step", name: string, fn: () => T, opts: SpanOptions = {}): T {
  const parent = als.getStore()?.span;
  if (!parent) return trace(name, () => (kind === "tool" ? span(kind, name, fn, opts) : fn()));
  let s: SpanState;
  let start: number;
  try {
    s = { trace: parent.trace, spanId: newSpanId(), parentSpanId: parent.spanId, anchorId: uuid() };
    start = nowMs();
    if (kind === "tool") {
      const p: Record<string, unknown> = { tool: name, toolUseId: s.spanId };
      data(p, "input", opts.input);
      emit(s, "tool.start", start, p, { id: s.anchorId, parentId: parent.anchorId });
    }
  } catch {
    return fn();
  }
  return als.run({ ...als.getStore(), span: s }, () =>
    around(fn, (ok, value, err) =>
      safe(() => {
        const end = nowMs();
        const durationMs = end - start;
        const error = ok ? undefined : errorMessage(err);
        if (kind === "tool") {
          const p: Record<string, unknown> = { tool: name, toolUseId: s.spanId, ok, durationMs, error };
          if (ok) data(p, "output", value);
          emit(s, "tool.end", end, p, { durationMs, parentId: parent.anchorId });
        } else {
          emit(s, "span", start, { name, ok, error }, { id: s.anchorId, durationMs, parentId: parent.anchorId });
        }
      }),
    ),
  );
}

/** Runs fn with every trace and untraced call inside it recorded into session `id`. */
export function withSession<T>(id: string, fn: () => T): T {
  return als.run({ ...als.getStore(), sessionId: id }, fn);
}

// ---------------------------------------------------------------- model calls

export interface ToolCallInfo {
  id?: string;
  name: string;
  arguments?: string;
}

/** One model API call, normalized from any provider. */
export interface LlmCall {
  provider: string;
  requestModel?: string;
  responseModel?: string;
  start: number;
  end: number;
  ttftMs?: number;
  stopReason?: string;
  ok: boolean;
  error?: string;
  usage?: Usage;
  /** Assistant text. */
  text?: string;
  toolCalls?: ToolCallInfo[];
  /** Last user message of the request (the prompt of an untraced call). */
  input?: string;
  responseId?: string;
  /** Base URL (or request URL) of the call: which gateway, if any, it went to. */
  url?: string;
  /** HTTP response headers: gateway request ids. */
  headers?: HeaderGetter;
  operation?: string;
}

function usageOf(u: Usage | undefined): Usage | undefined {
  if (!u) return undefined;
  const out: Usage = {};
  for (const k of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const) {
    const v = u[k];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Records a finished model call. `ctx` is the context captured when the call
 * started (callbacks that finish it may run elsewhere).
 */
export function recordLlm(call: LlmCall, ctx: Ctx | undefined): void {
  safe(() => {
    const parent = ctx?.span;
    const model = call.responseModel ?? call.requestModel;
    const usage = usageOf(call.usage);
    const durationMs = Math.max(0, call.end - call.start);
    const gw = detectGateway({ url: call.url, headers: call.headers, responseId: call.responseId });
    const p: Record<string, unknown> = {
      provider: call.provider,
      requestModel: call.requestModel,
      responseModel: call.responseModel,
      operation: call.operation ?? "chat",
      ttftMs: call.ttftMs !== undefined ? Math.round(call.ttftMs * 1000) / 1000 : undefined,
      stopReason: call.stopReason,
      ok: call.ok,
      error: call.error,
      responseId: call.responseId,
      // The names the server reads: gateway → the `gateway:<name>` flag; gatewayGenerationId → `gateway enrich`.
      gateway: gw?.gateway,
      gatewayGenerationId: gw?.requestId,
    };
    if (call.toolCalls?.length) {
      p.toolCalls = call.toolCalls.map((t) => {
        const o: Record<string, unknown> = { name: t.name };
        if (t.id) o.id = t.id;
        if (t.arguments !== undefined) text(o, "arguments", t.arguments);
        return o;
      });
    }
    const outTokens = usage?.outputTokens;
    if (outTokens && durationMs > 0) p.tokensPerSec = Math.round((outTokens / (durationMs / 1000)) * 100) / 100;
    const extra = { durationMs, model, usage };

    if (parent) {
      const s: SpanState = { trace: parent.trace, spanId: newSpanId(), parentSpanId: parent.spanId, anchorId: uuid() };
      emit(s, "llm.call", call.start, p, { ...extra, id: s.anchorId, parentId: parent.anchorId });
      if (call.text) emit(s, "assistant.message", call.end, textPayload(call.text), { model, parentId: parent.anchorId });
      return;
    }
    // Untraced: the call is the root of its own trace (session = the trace, or the withSession id).
    const root = openRoot(ctx?.sessionId);
    emit(root, "session.start", call.start, { name: `${call.operation ?? "chat"} ${model ?? ""}`.trim(), traceId: root.trace.traceId, userId: ctx?.userId, metadata: ctx?.metadata }, { id: root.anchorId });
    if (call.input) emit(root, "user.message", call.start, textPayload(call.input));
    emit(root, "llm.call", call.start, p, extra);
    if (call.text) emit(root, "assistant.message", call.end, textPayload(call.text), { model });
    emit(root, "turn.end", call.end, { ok: call.ok, error: call.error, durationMs }, { durationMs });
    if (!root.trace.conversation) emit(root, "session.end", call.end, { reason: call.ok ? "completed" : "error", error: call.error }, { durationMs });
  });
}

function textPayload(s: string): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  text(p, "text", s);
  return p;
}
