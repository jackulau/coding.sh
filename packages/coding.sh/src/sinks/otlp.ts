// OTLP/HTTP JSON trace exporter (POST {endpoint}/v1/traces).
//
// Mapping (OpenTelemetry GenAI semantic conventions, pinned below because the
// gen_ai.* namespace is still "Development"):
//   session              → span "invoke_agent {agent}"   (root, emitted with session.end; the server
//                                                          mirror also sends it for a session still open,
//                                                          see writeOpenSessions)
//   tool.start/tool.end  → span "execute_tool {tool}"    (child, emitted with tool.end)
//   assistant.message    → span "chat {model}"           (child, carries token usage)
//   weights.edit         → span "weights.edit"           (child, one per edit: coding_sh.weights.*)
// Token usage follows the GenAI gen_ai.usage.* attributes: input_tokens counts the
// whole prompt (uncached + cache reads + cache writes), and the cache parts go to
// cache_read.input_tokens and cache_write.input_tokens (renamed from
// cache_creation.input_tokens in open-telemetry/semantic-conventions-genai#440).
// Usage.inputTokens is the uncached part only, so it also goes to
// coding_sh.usage.uncached_input_tokens.
// Trace and span ids are derived from session/event ids, so a re-sent batch
// produces identical spans and backends can de-duplicate.
import type { AgentEvent, Session, Usage } from "../schema/index.ts";
import type { BlobStore, OpenSession, Sink, SinkAck, SinkConfig } from "../core/types.ts";
import { hashParts } from "../core/ids.ts";
import { sessionToMetadata, toMetadata } from "../core/redact.ts";
import { isWeightsEdit, WEIGHTS_EDIT_KIND, weightsEditAttrs } from "../core/weights.ts";
import { postJson } from "./post.ts";

export const SEMCONV_SCHEMA_URL = "https://opentelemetry.io/schemas/1.37.0";
const SCOPE = { name: "coding.sh", version: "0.0.1" };
const MAX_CONTENT = 8192;

type AnyValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean }
  | { arrayValue: { values: AnyValue[] } };

export interface KeyValue {
  key: string;
  value: AnyValue;
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: KeyValue[];
  status?: { code: number; message?: string };
}

const SPAN_KIND_INTERNAL = 1;
const SPAN_KIND_CLIENT = 3;
const STATUS_OK = 1;
const STATUS_ERROR = 2;

export const traceIdFor = (sessionId: string): string => hashParts("otel-trace", sessionId).slice(0, 32);
export const sessionSpanId = (sessionId: string): string => hashParts("otel-span", "session", sessionId).slice(0, 16);

function nanos(ms: number): string {
  return (BigInt(Math.round(ms)) * 1_000_000n).toString();
}

function anyValue(v: unknown): AnyValue | undefined {
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) {
    const values = v.map(anyValue).filter((x): x is AnyValue => x !== undefined);
    return { arrayValue: { values } };
  }
  return undefined;
}

function attrs(obj: Record<string, unknown>): KeyValue[] {
  const out: KeyValue[] = [];
  for (const [key, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const value = anyValue(v);
    if (value) out.push({ key, value });
  }
  return out;
}

function usageAttrs(u: Usage | undefined, reasoningTokens?: unknown): Record<string, unknown> {
  if (!u) return {};
  const { inputTokens: uncached, cacheReadTokens: read, cacheWriteTokens: write } = u;
  const anyInput = uncached !== undefined || read !== undefined || write !== undefined;
  return {
    "gen_ai.usage.input_tokens": anyInput ? (uncached ?? 0) + (read ?? 0) + (write ?? 0) : undefined,
    "gen_ai.usage.output_tokens": u.outputTokens,
    "gen_ai.usage.cache_read.input_tokens": read,
    "gen_ai.usage.cache_write.input_tokens": write,
    // The old name for cache writes (still the key in the semconv 1.41 registry), sent through 0.1.5 so existing dashboards keep working.
    "gen_ai.usage.cache_creation.input_tokens": write,
    "gen_ai.usage.reasoning.output_tokens": typeof reasoningTokens === "number" && Number.isFinite(reasoningTokens) ? reasoningTokens : undefined,
    "coding_sh.usage.uncached_input_tokens": uncached,
    "coding_sh.cost_usd": u.costUsd,
  };
}

function content(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > MAX_CONTENT ? `${s.slice(0, MAX_CONTENT)}…` : s;
}

/** Subagent sessions join their parent's trace (walking up as far as the batch knows). */
function rootIn(sessionsById: Map<string, Session>): (id: string) => string {
  return (id) => {
    let cur = id;
    for (let i = 0; i < 16; i++) {
      const parent = sessionsById.get(cur)?.parent?.sessionId;
      if (!parent) break;
      cur = parent;
    }
    return cur;
  };
}

/** Converts a batch to OTLP spans. Pure; exported for tests and custom exporters. */
export function toOtlpSpans(batch: AgentEvent[], sessions: Session[], mode: "full" | "metadata"): OtlpSpan[] {
  const full = mode === "full";
  // An event once per batch: a helper's events come from its parent's Agent call and from its own stop, with the same ids.
  const seenIds = new Set<string>();
  const unique = batch.filter((e) => !seenIds.has(e.id) && seenIds.add(e.id));
  const events = full ? unique : unique.map(toMetadata);
  const sessionsById = new Map(sessions.map((s) => [s.id, full ? s : sessionToMetadata(s)]));
  const starts = new Map<string, AgentEvent>();
  for (const e of events) {
    const id = e.payload.toolUseId;
    if (e.kind === "tool.start" && typeof id === "string") starts.set(`${e.sessionId}\u001f${id}`, e);
  }

  // When a session reports llm.call events, those are the model-call spans;
  // assistant.message spans are only a fallback for agents without them.
  const hasLlmCalls = new Set(events.filter((e) => e.kind === "llm.call").map((e) => e.sessionId));
  for (const s of sessions) if (s.stats.latency?.llmCalls) hasLlmCalls.add(s.id);

  const rootOf = rootIn(sessionsById);

  const spans: OtlpSpan[] = [];
  for (const e of events) {
    const traceId = traceIdFor(rootOf(e.sessionId));
    const parentSpanId = sessionSpanId(e.sessionId);
    if (e.kind === "tool.end") {
      const tool = typeof e.payload.tool === "string" ? e.payload.tool : "unknown";
      const toolUseId = typeof e.payload.toolUseId === "string" ? e.payload.toolUseId : undefined;
      const start = toolUseId ? starts.get(`${e.sessionId}\u001f${toolUseId}`) : undefined;
      const duration = e.durationMs ?? (typeof e.payload.durationMs === "number" ? e.payload.durationMs : undefined);
      const startMs = start?.ts ?? (duration !== undefined ? e.ts - duration : e.ts);
      const ok = e.payload.ok;
      spans.push({
        traceId,
        spanId: hashParts("otel-span", "tool", e.sessionId, toolUseId ?? e.id).slice(0, 16),
        parentSpanId,
        name: `execute_tool ${tool}`,
        kind: SPAN_KIND_INTERNAL,
        startTimeUnixNano: nanos(startMs),
        endTimeUnixNano: nanos(e.ts),
        attributes: attrs({
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": tool,
          "gen_ai.tool.call.id": toolUseId,
          "gen_ai.agent.name": e.agent,
          "coding_sh.event.id": e.id,
          ...(full ? { "gen_ai.tool.call.arguments": content(start?.payload.input), "gen_ai.tool.call.result": content(e.payload.output) } : {}),
        }),
        status: ok === false ? { code: STATUS_ERROR, message: "tool call failed" } : ok === true ? { code: STATUS_OK } : undefined,
      });
    } else if (e.kind === "llm.call") {
      const p = e.payload;
      const model = (typeof p.requestModel === "string" ? p.requestModel : undefined) ?? e.model ?? sessionsById.get(e.sessionId)?.model;
      spans.push({
        traceId,
        spanId: e.spanId && /^[0-9a-f]{16}$/.test(e.spanId) ? e.spanId : hashParts("otel-span", "chat", e.id).slice(0, 16),
        parentSpanId,
        name: model ? `chat ${model}` : "chat",
        kind: SPAN_KIND_CLIENT,
        startTimeUnixNano: nanos(e.ts),
        endTimeUnixNano: nanos(e.ts + (e.durationMs ?? 0)),
        attributes: attrs({
          "gen_ai.operation.name": "chat",
          "gen_ai.provider.name": p.provider,
          "gen_ai.request.model": model,
          "gen_ai.response.model": p.responseModel,
          "gen_ai.response.finish_reasons": typeof p.stopReason === "string" ? [p.stopReason] : undefined,
          "gen_ai.agent.name": e.agent,
          "coding_sh.ttft_ms": p.ttftMs,
          "coding_sh.tokens_per_sec": p.tokensPerSec,
          "coding_sh.event.id": e.id,
          ...usageAttrs(e.usage, p.reasoningTokens),
        }),
        status: p.ok === false ? { code: STATUS_ERROR, message: full && typeof p.error === "string" ? p.error.slice(0, 500) : "model call failed" } : undefined,
      });
    } else if (e.kind === "assistant.message" && !hasLlmCalls.has(e.sessionId) && (e.usage || e.model)) {
      const model = e.model ?? sessionsById.get(e.sessionId)?.model;
      spans.push({
        traceId,
        spanId: hashParts("otel-span", "chat", e.id).slice(0, 16),
        parentSpanId,
        name: model ? `chat ${model}` : "chat",
        kind: SPAN_KIND_CLIENT,
        startTimeUnixNano: nanos(e.ts),
        endTimeUnixNano: nanos(e.ts),
        attributes: attrs({
          "gen_ai.operation.name": "chat",
          "gen_ai.request.model": model,
          "gen_ai.agent.name": e.agent,
          "coding_sh.event.id": e.id,
          ...usageAttrs(e.usage),
          ...(full && typeof e.payload.text === "string"
            ? { "gen_ai.output.messages": content([{ role: "assistant", parts: [{ type: "text", content: e.payload.text }] }]) }
            : {}),
        }),
      });
    } else if (isWeightsEdit(e)) {
      // Metadata mode has already dropped the tensor's name, its shape, both hashes and the note (toMetadata above).
      spans.push({
        traceId,
        spanId: hashParts("otel-span", "weights", e.id).slice(0, 16),
        parentSpanId,
        name: WEIGHTS_EDIT_KIND,
        kind: SPAN_KIND_INTERNAL,
        startTimeUnixNano: nanos(e.ts),
        endTimeUnixNano: nanos(e.ts + (e.durationMs ?? 0)),
        attributes: attrs({ "gen_ai.agent.name": e.agent, "coding_sh.event.id": e.id, ...weightsEditAttrs(e.payload) }),
      });
    } else if (e.kind === "session.end") {
      const s = sessionsById.get(e.sessionId);
      if (!s) continue;
      spans.push(sessionSpan(s, e.ts, full, traceIdFor(rootOf(s.id))));
    }
  }
  return spans;
}

function sessionSpan(s: Session, endMs: number, full: boolean, traceId: string): OtlpSpan {
  return {
    traceId,
    spanId: sessionSpanId(s.id),
    ...(s.parent ? { parentSpanId: sessionSpanId(s.parent.sessionId) } : {}),
    name: `invoke_agent ${s.agent}`,
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: nanos(s.startedAt),
    endTimeUnixNano: nanos(s.endedAt ?? endMs),
    attributes: attrs({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": s.agent,
      "gen_ai.request.model": s.model,
      "gen_ai.conversation.id": s.id,
      ...usageAttrs(s.stats.usage),
      "coding_sh.agent.version": s.agentVersion,
      "coding_sh.run.id": s.runId,
      "coding_sh.session.flags": s.flags.length ? s.flags : undefined,
      "coding_sh.stats.events": s.stats.events,
      "coding_sh.stats.turns": s.stats.turns,
      "coding_sh.stats.tool_calls": s.stats.toolCalls,
      "coding_sh.stats.tool_errors": s.stats.toolErrors,
      "coding_sh.stats.files_changed": s.stats.filesChanged,
      "coding_sh.stats.subagents": s.stats.latency?.subagents,
      "coding_sh.parent.session.id": s.parent?.sessionId,
      "coding_sh.stats.tests_passed": s.stats.testsPassed,
      "coding_sh.stats.tests_failed": s.stats.testsFailed,
      "coding_sh.stats.weight_edits": s.stats.weightEdits?.events,
      "coding_sh.stats.weights_changed": s.stats.weightEdits?.weightsChanged,
      "vcs.ref.head.revision": s.repo?.head || undefined,
      ...(full ? { "coding_sh.session.title": s.title, "coding_sh.repo.root": s.repo?.root } : {}),
    }),
  };
}

/**
 * The invoke_agent span of each session that is still open: the trace and span
 * id its session.end will send, so the spans already sent under it have a parent
 * and the later span is the same span again, with more in it. It ends at the
 * row's endedAt, else at the last event written.
 */
export function toOtlpOpenSessionSpans(open: OpenSession[], mode: "full" | "metadata"): OtlpSpan[] {
  const full = mode === "full";
  const rows = open.map((o) => ({ ...o, session: full ? o.session : sessionToMetadata(o.session) }));
  const rootOf = rootIn(new Map(rows.map((o) => [o.session.id, o.session])));
  return rows.map((o) => sessionSpan(o.session, o.lastEventAt, full, traceIdFor(rootOf(o.session.id))));
}

/** The OTLP ExportTraceServiceRequest body for the open sessions' invoke_agent spans. */
export function toOtlpOpenSessionRequest(open: OpenSession[], mode: "full" | "metadata") {
  return request(toOtlpOpenSessionSpans(open, mode));
}

function request(spans: OtlpSpan[]) {
  return {
    resourceSpans: [
      {
        resource: { attributes: attrs({ "service.name": "coding.sh", "telemetry.sdk.name": "coding.sh", "telemetry.sdk.language": "nodejs" }) },
        scopeSpans: [{ scope: SCOPE, schemaUrl: SEMCONV_SCHEMA_URL, spans }],
        schemaUrl: SEMCONV_SCHEMA_URL,
      },
    ],
  };
}

/** The OTLP ExportTraceServiceRequest body for a batch. */
export function toOtlpRequest(batch: AgentEvent[], sessions: Session[], mode: "full" | "metadata") {
  return request(toOtlpSpans(batch, sessions, mode));
}

export function otlpTracesUrl(endpoint: string): string {
  const base = endpoint.replace(/\/+$/, "");
  return base.endsWith("/v1/traces") ? base : `${base}/v1/traces`;
}

export interface OtlpSinkOptions {
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class OtlpSink implements Sink {
  readonly name: string;
  readonly mode: "full" | "metadata";
  private readonly url: string;
  private readonly headers?: Record<string, string>;
  private readonly opts: OtlpSinkOptions;

  constructor(config: SinkConfig, opts: OtlpSinkOptions = {}) {
    if (!config.endpoint) throw new Error(`otlp sink ${config.name ?? ""} needs an endpoint (e.g. http://localhost:4318)`);
    this.name = config.name ?? config.kind;
    this.mode = config.mode;
    this.url = otlpTracesUrl(config.endpoint);
    this.headers = config.headers;
    this.opts = opts;
  }

  async write(batch: AgentEvent[], sessions: Session[], _blobs: BlobStore): Promise<SinkAck> {
    const body = toOtlpRequest(batch, sessions, this.mode);
    if (!body.resourceSpans[0]!.scopeSpans[0]!.spans.length) return { ok: true };
    return postJson(this.url, body, { headers: this.headers, timeoutMs: this.opts.timeoutMs, fetch: this.opts.fetch });
  }

  async writeOpenSessions(open: OpenSession[], _blobs: BlobStore): Promise<SinkAck> {
    if (!open.length) return { ok: true };
    return postJson(this.url, request(toOtlpOpenSessionSpans(open, this.mode)), { headers: this.headers, timeoutMs: this.opts.timeoutMs, fetch: this.opts.fetch });
  }
}

export function createOtlpSink(config: SinkConfig): Sink {
  return new OtlpSink(config);
}
