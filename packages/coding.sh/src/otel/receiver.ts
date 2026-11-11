/**
 * Local OTLP/HTTP receiver: point any OpenTelemetry-instrumented agent at
 * coding.sh and its runs show up as sessions.
 *
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
 *
 * Routes: POST /v1/traces, /v1/logs (mapped to events), /v1/metrics (accepted,
 * dropped). Bodies: application/x-protobuf or application/json, optionally
 * Content-Encoding gzip/deflate/br. Binds to loopback only unless allowRemote.
 *
 * Sessions: one per trace, or one per conversation when spans carry
 * gen_ai.conversation.id / session.id (each trace is then a turn). Spans
 * arrive out of order (the root usually last), so after every batch the
 * touched sessions are rebuilt from all their stored events. Event ids derive
 * from traceId+spanId, so exporter retries and re-exports insert nothing.
 *
 * ## Setup
 *
 * ### Claude Code (and the Claude Agent SDK, which inherits these env vars)
 *
 *   export CLAUDE_CODE_ENABLE_TELEMETRY=1
 *   export OTEL_LOGS_EXPORTER=otlp
 *   export OTEL_EXPORTER_OTLP_PROTOCOL=http/json        # or http/protobuf
 *   export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
 *   export OTEL_LOG_USER_PROMPTS=1         # prompt text (session titles); off by default
 *   export OTEL_LOG_TOOL_DETAILS=1         # tool_parameters (Bash commands, file paths)
 *   export OTEL_LOGS_EXPORT_INTERVAL=1000  # ms, default 5000
 *   # optional, beta: spans too. Model/tool calls seen in both logs and spans
 *   # are de-duplicated by request_id / tool_use_id.
 *   export CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1 OTEL_TRACES_EXPORTER=otlp
 *
 *   Agent SDK (TypeScript): options.env replaces the environment, so spread it:
 *     query({ prompt, options: { env: { ...process.env, CLAUDE_CODE_ENABLE_TELEMETRY: "1",
 *       OTEL_LOGS_EXPORTER: "otlp", OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
 *       OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318" } } })
 *   Agent SDK (Python): ClaudeAgentOptions(env={...same keys...}) is merged over os.environ.
 *   Don't use the console exporter under the SDK: it corrupts the SDK's stdout channel.
 *
 * ### Vercel AI SDK
 *
 *   // instrumentation.ts — npm i @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-proto
 *   import { NodeSDK } from "@opentelemetry/sdk-node";
 *   import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
 *   const sdk = new NodeSDK({ serviceName: "my-agent",
 *     traceExporter: new OTLPTraceExporter({ url: "http://127.0.0.1:4318/v1/traces" }) });
 *   sdk.start();  // short scripts: await sdk.shutdown() before exit to flush
 *   // Next.js instead: registerOTel({ serviceName: "my-agent" }) from @vercel/otel,
 *   // with OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 in the environment.
 *
 *   // AI SDK ≤ 6: per call
 *   await generateText({ model, prompt, experimental_telemetry: { isEnabled: true,
 *     functionId: "my-agent", metadata: { sessionId: "chat-123" } } });
 *   // AI SDK 7: once at startup (npm i @ai-sdk/otel); the per-call option is `telemetry`
 *   import { registerTelemetry } from "ai";
 *   import { OpenTelemetry } from "@ai-sdk/otel";
 *   registerTelemetry(new OpenTelemetry());
 *   // Through AI Gateway (model: "openai/gpt-5" or gateway("…")): calls are tagged
 *   // gateway:vercel with the generation id and billed cost (src/integrations/gateway).
 *
 * ### Vercel AI Gateway trace drain (Pro/Enterprise)
 *
 *   Vercel dashboard → Drains → Traces → OTLP/HTTP endpoint <public URL>/v1/traces
 *   (a tunnel to this port). One llm.call per gateway request, grouped into a
 *   daily `ai-gateway-YYYY-MM-DD` session; `coding.sh gateway enrich` links them
 *   to agent sessions.
 *
 * ### OpenAI Agents SDK (Python, via OpenInference)
 *
 *   # pip install openai-agents openinference-instrumentation-openai-agents \
 *   #   opentelemetry-sdk opentelemetry-exporter-otlp-proto-http
 *   from openinference.instrumentation.openai_agents import OpenAIAgentsInstrumentor
 *   from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
 *   from opentelemetry.sdk.resources import Resource
 *   from opentelemetry.sdk.trace import TracerProvider
 *   from opentelemetry.sdk.trace.export import BatchSpanProcessor
 *   provider = TracerProvider(resource=Resource.create({"service.name": "my-agent"}))
 *   provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint="http://127.0.0.1:4318/v1/traces")))
 *   OpenAIAgentsInstrumentor().instrument(tracer_provider=provider)
 *   # OPENAI_AGENTS_DISABLE_TRACING=1 additionally stops uploads to OpenAI's tracing backend.
 *
 *   TypeScript: npm i @arizeai/openinference-instrumentation-openai-agents
 *   @opentelemetry/exporter-trace-otlp-proto; register a NodeTracerProvider with a
 *   BatchSpanProcessor(new OTLPTraceExporter({ url: "http://127.0.0.1:4318/v1/traces" })),
 *   then new OpenAIAgentsInstrumentation({ tracerProvider }).manuallyInstrument(agents).
 *
 * ### LangChain / LangGraph
 *
 *   # OpenInference: pip install openinference-instrumentation-langchain (+ the
 *   # TracerProvider/OTLPSpanExporter setup above)
 *   from openinference.instrumentation.langchain import LangChainInstrumentor
 *   LangChainInstrumentor().instrument(tracer_provider=provider)
 *
 *   # or LangSmith's OTel exporter: pip install "langsmith[otel]"
 *   export LANGSMITH_OTEL_ENABLED=true LANGSMITH_TRACING=true LANGSMITH_OTEL_ONLY=true
 *   export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 OTEL_SERVICE_NAME=my-agent
 *   # LangGraph thread_id metadata (langsmith.metadata.thread_id) groups traces into one session.
 *
 * ### Any Python app (opentelemetry-exporter-otlp-proto-http)
 *
 *   # pip install opentelemetry-sdk opentelemetry-exporter-otlp-proto-http
 *   export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318   # base URL: SDK appends /v1/traces
 *   export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf           # the Python HTTP exporter speaks protobuf only
 *   export OTEL_SERVICE_NAME=my-agent                          # becomes the agent id (kebab-cased)
 *   # Signal-specific OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is used verbatim: include /v1/traces.
 *   from opentelemetry import trace
 *   from opentelemetry.sdk.trace import TracerProvider
 *   from opentelemetry.sdk.trace.export import BatchSpanProcessor
 *   from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
 *   provider = TracerProvider()
 *   provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
 *   trace.set_tracer_provider(provider)
 *   # logs: from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
 *
 * Group traces into one multi-turn session by setting gen_ai.conversation.id
 * (or session.id; OpenInference: `with using_session("chat-123"):`) on spans.
 * Tag eval runs with OTEL_RESOURCE_ATTRIBUTES=coding_sh.run_id=<id>.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import * as zlib from "node:zlib";
import type { AgentEvent, Session } from "../schema/index.ts";
import type { BlobStore, IndexStore } from "../core/types.ts";
import { createRedactor, redactEventCounted, type Redactor } from "../core/redact.ts";
import { buildSession } from "../core/sessions.ts";
import { decodeLogsJson, decodeTraceJson, parseJson, validateMetricsJson } from "./json.ts";
import { applyPricing, pricesFor, type Prices } from "../core/pricing.ts";
import { enrichFromEve } from "../integrations/eve/map.ts";
import { enrichGatewaySpan } from "../integrations/gateway/otel.ts";
import { type MapContext, type MapResult, mapLogs, mapTraces, type SpanEnricher, SpanTree, TraceSessionMap, traceKvKey } from "./map.ts";
import { OtlpDecodeError, type ResourceLogs, type ResourceSpans } from "./model.ts";
import { decodeLogsRequest, decodeTraceRequest, encodeExportResponse, encodeStatus, validateMessage } from "./proto.ts";

export const DEFAULT_PORT = 4318;
export const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_INLINE_BYTES = 4096;
/** Spans or log records the receiver commits together, at most (one request is never split). */
const GROUP_MAX_ITEMS = 5000;

export type Signal = "traces" | "logs" | "metrics";

export interface BatchInfo {
  signal: Signal;
  /** Events mapped from the request (after redaction). */
  events: AgentEvent[];
  /** Events newly stored (0 for a re-post). */
  inserted: number;
  /** The ones of `events` this commit newly stored: what goes on to [[sinks]] (see InsertedEvents). */
  insertedEvents: AgentEvent[];
  /** Sessions rebuilt and upserted. */
  sessions: Session[];
  /** Spans/log records rejected (reported back as partial_success). */
  rejected: number;
}

export interface ReceiverOptions {
  /** Default 127.0.0.1. Non-loopback hosts need allowRemote. */
  host?: string;
  /** Default 4318; 0 picks an ephemeral port. */
  port?: number;
  store: IndexStore;
  blobs: BlobStore;
  /** Payload values larger than this move to blobs. Default 4096. */
  maxInlineBytes?: number;
  /** Request body limit, applied before and after decompression. Default 16 MiB. */
  maxBodyBytes?: number;
  /** Allow binding a non-loopback address and requests with non-local Host headers. */
  allowRemote?: boolean;
  /** Extra browser origins allowed by CORS (http://localhost:* and 127.0.0.1:* always are). */
  corsOrigins?: (string | RegExp)[];
  /** Redaction for event payloads and blobs. Default: built-in secret rules. false disables. */
  redactor?: Redactor | false;
  /**
   * Keep each source span/log as blobs[0]. Default false: a raw blob per span
   * costs a blob write per span, and the mapped events already hold its content.
   */
  keepRaw?: boolean;
  /** Prices for model calls that report tokens but no cost (as serve and ingest do). Default: the built-in table. */
  prices?: Prices;
  /**
   * Per-span enrichment hook. See MapContext.enrichSpan. Default:
   * defaultEnricher, i.e. enrichFromEve (src/integrations/eve) then
   * enrichGatewaySpan (src/integrations/gateway); each only touches its own
   * spans and returns every other span unchanged. Pass false for the plain mapping.
   */
  enrichSpan?: SpanEnricher | false;
  onBatch?: (batch: BatchInfo) => void | Promise<void>;
  /** Extra routes by exact path, answered before the OTLP routes (e.g. eve evals at /v1/evals/eve). Each does its own checks. */
  routes?: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>;
  /** Store failures and onBatch errors. Default: ignored (the client gets a 503). */
  onError?: (err: Error) => void;
}

export interface Receiver {
  readonly host: string;
  readonly port: number;
  /** Base URL, e.g. http://127.0.0.1:4318 (what OTEL_EXPORTER_OTLP_ENDPOINT should be). */
  readonly url: string;
  readonly server: Server;
  /** Stops accepting connections, finishes in-flight requests and pending writes. */
  close(): Promise<void>;
}

// gRPC status codes, used in google.rpc.Status error bodies.
export const RPC = { INVALID_ARGUMENT: 3, NOT_FOUND: 5, PERMISSION_DENIED: 7, RESOURCE_EXHAUSTED: 8, UNIMPLEMENTED: 12, INTERNAL: 13, UNAVAILABLE: 14, UNAUTHENTICATED: 16 } as const;

const ROUTES: Record<string, Signal> = { "/v1/traces": "traces", "/v1/logs": "logs", "/v1/metrics": "metrics" };
const REJECTED_FIELD: Record<Signal, string> = { traces: "rejectedSpans", logs: "rejectedLogRecords", metrics: "rejectedDataPoints" };

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127(?:\.\d{1,3}){3}|\[::1\])(:\d{1,5})?$/i;

export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h) || /^::ffff:127(\.\d{1,3}){3}$/.test(h);
}

/** Hostname part of a Host header ("[::1]:4318" → "::1", "localhost:4318" → "localhost"). */
export function hostOf(header: string): string {
  const m = /^\[([^\]]+)\](?::\d+)?$/.exec(header);
  if (m) return m[1]!;
  return header.replace(/:\d+$/, "");
}

export class HttpError extends Error {
  readonly status: number;
  readonly rpc: number;
  /** Extra response headers (Retry-After, WWW-Authenticate). */
  readonly headers: Record<string, string>;
  constructor(status: number, rpc: number, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.rpc = rpc;
    this.headers = headers;
  }
}

type Format = "json" | "proto";

function formatOf(contentType: string | undefined): Format | undefined {
  const ct = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (ct === "application/json") return "json";
  if (ct === "application/x-protobuf" || ct === "application/protobuf") return "proto";
  return undefined;
}

export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => (tooLarge ? reject(tooBig(limit)) : resolve(Buffer.concat(chunks, size))));
    req.on("error", reject);
  });
}

const tooBig = (limit: number) => new HttpError(413, RPC.RESOURCE_EXHAUSTED, `request body exceeds ${limit} bytes`);

const gunzip = promisify(zlib.gunzip);
const inflate = promisify(zlib.inflate);
const brotli = promisify(zlib.brotliDecompress);

export async function decompress(body: Buffer, encoding: string | undefined, limit: number): Promise<Buffer> {
  const enc = (encoding ?? "identity").trim().toLowerCase();
  if (enc === "" || enc === "identity") return body;
  const run = enc === "gzip" || enc === "x-gzip" ? gunzip : enc === "deflate" ? inflate : enc === "br" ? brotli : undefined;
  if (!run) throw new HttpError(415, RPC.INVALID_ARGUMENT, `unsupported Content-Encoding ${JSON.stringify(enc)}`);
  try {
    return await run(body, { maxOutputLength: limit });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE" || err instanceof RangeError) throw tooBig(limit);
    throw new HttpError(400, RPC.INVALID_ARGUMENT, `invalid ${enc} body: ${(err as Error).message}`);
  }
}

function decode(signal: Signal, format: Format, body: Buffer): ResourceSpans[] | ResourceLogs[] | undefined {
  if (format === "json") {
    const parsed = parseJson(body.toString("utf8"));
    if (signal === "traces") return decodeTraceJson(parsed);
    if (signal === "logs") return decodeLogsJson(parsed);
    validateMetricsJson(parsed);
    return undefined;
  }
  if (signal === "traces") return decodeTraceRequest(body);
  if (signal === "logs") return decodeLogsRequest(body);
  validateMessage(body);
  return undefined;
}

/** The receiver's default span enrichment: eve spans, then AI Gateway spans (each leaves other spans unchanged). */
export const defaultEnricher: SpanEnricher = (span, events, info) => enrichGatewaySpan(span, enrichFromEve(span, events, info), info);

export interface OtlpPipelineOptions {
  store: IndexStore;
  blobs: BlobStore;
  /** Payload values larger than this move to blobs. Default 4096. */
  maxInlineBytes?: number;
  /** Redaction for event payloads and blobs. Undefined: none. */
  redactor?: Redactor;
  /** Keep each source span/log as blobs[0] (default true). */
  keepRaw?: boolean;
  /** Per-span enrichment (see ReceiverOptions.enrichSpan). false: plain mapping. */
  enrichSpan?: SpanEnricher | false;
  /** Replaces the blob write (serve's metadata mode hashes without storing). */
  blob?: (data: Uint8Array | string) => Promise<string>;
  /** kv key for a trace → conversation entry (default traceKvKey); serve prefixes it per project. */
  kvKey?: (traceId: string) => string;
}

export interface OtlpMapOutcome {
  /** Mapped events, redacted. Not stored yet. */
  events: AgentEvent[];
  /** Spans/log records rejected (reported back as partial_success). */
  rejected: number;
  errors: string[];
}

export interface OtlpPipeline {
  /**
   * Seeds trace → conversation entries from the kv, maps one decoded request to
   * events and saves new kv entries. Not serialized: callers run one at a time.
   * `blobs` (a BlobStore.batch() the caller flushes) takes this request's blob
   * writes in place of the pipeline's store.
   */
  map(signal: Signal, decoded: ResourceSpans[] | ResourceLogs[], blobs?: BlobStore): Promise<OtlpMapOutcome>;
}

/** The decode → map → redact half of the receiver, shared with `coding.sh serve`. */
export function createOtlpPipeline(opts: OtlpPipelineOptions): OtlpPipeline {
  const redactor = opts.redactor;
  const traceSessions = new TraceSessionMap();
  const kvKey = opts.kvKey ?? traceKvKey;
  let blobs = opts.blobs;
  const mapCtx: MapContext = {
    maxInlineBytes: opts.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES,
    blob: opts.blob ?? ((data) => blobs.put(data)),
    traceSessions,
    spanTree: new SpanTree(),
    keepRaw: opts.keepRaw ?? true,
  };
  // Blob content is redacted by the mapping, before it is serialized (MapContext.redactor).
  if (redactor) mapCtx.redactor = redactor;
  if (opts.enrichSpan !== false) mapCtx.enrichSpan = opts.enrichSpan ?? defaultEnricher;

  // trace → conversation entries survive restarts in the index kv (when the
  // store has one): misses are looked up before a batch is mapped.
  const seedTraces = async (signal: Signal, decoded: ResourceSpans[] | ResourceLogs[]) => {
    if (!opts.store.kvGet) return;
    const ids = new Set<string>();
    if (signal === "traces") for (const rs of decoded as ResourceSpans[]) for (const ss of rs.scopeSpans) for (const sp of ss.spans) if (sp.traceId) ids.add(sp.traceId);
    if (signal === "logs") for (const rl of decoded as ResourceLogs[]) for (const sl of rl.scopeLogs) for (const r of sl.logRecords) if (r.traceId) ids.add(r.traceId);
    for (const id of ids) {
      if (traceSessions.has(id)) continue;
      const s = await opts.store.kvGet(kvKey(id));
      if (s) traceSessions.seed(id, s);
    }
  };

  return {
    async map(signal, decoded, into) {
      await seedTraces(signal, decoded);
      let mapped: MapResult;
      blobs = into ?? opts.blobs;
      try {
        mapped = signal === "traces" ? await mapTraces(decoded as ResourceSpans[], mapCtx) : await mapLogs(decoded as ResourceLogs[], mapCtx);
      } finally {
        blobs = opts.blobs;
      }
      if (opts.store.kvSet) for (const [t, s] of traceSessions.takeDirty()) await opts.store.kvSet(kvKey(t), s);
      const events = redactor ? mapped.events.map((e) => redactEventCounted(redactor, e)) : mapped.events;
      return { events, rejected: mapped.rejected, errors: mapped.errors };
    },
  };
}

/** Spans or log records in a decoded request (serve's admission cost). */
export function countOtlpItems(signal: Signal, decoded: ResourceSpans[] | ResourceLogs[] | undefined): number {
  let n = 0;
  if (!decoded) return 0;
  if (signal === "traces") for (const rs of decoded as ResourceSpans[]) for (const ss of rs.scopeSpans) n += ss.spans.length;
  if (signal === "logs") for (const rl of decoded as ResourceLogs[]) for (const sl of rl.scopeLogs) n += sl.logRecords.length;
  return n;
}

/** Stores events and rebuilds every session they touch (once each). */
export async function storeAndRebuild(store: IndexStore, events: AgentEvent[]): Promise<{ inserted: number; sessions: Session[] }> {
  const { inserted } = events.length ? await store.putEvents(events) : { inserted: 0 };
  return { inserted, sessions: await rebuildSessions(store, new Set(events.map((e) => e.sessionId))) };
}

/** Ids a failed commit can leave owed (InsertedEvents); past this the oldest are forgotten. */
const OWED_MAX = 100_000;

/**
 * Says which of a commit's events are new to the store, for what runs after
 * the commit: [[sinks]] get an event once, however often its batch is posted.
 * One per writer (the receiver's group commit, serve's ingest queue).
 */
export class InsertedEvents {
  /**
   * Ids stored by a commit that failed after its put (the rebuild threw, the
   * client was answered 503): nothing was handed on, and the retry inserts
   * nothing, so the retry's commit hands them on. In insertion order.
   */
  private readonly owed = new Set<string>();

  /**
   * putEvents, plus the ids it inserted. A store without putEventsReturningIds
   * has the stored ids of the touched sessions read before the put, so call
   * this inside the store's transaction where it has one.
   */
  async put(store: IndexStore, events: AgentEvent[]): Promise<{ inserted: number; ids: Set<string> }> {
    if (!events.length) return { inserted: 0, ids: new Set() };
    if (store.putEventsReturningIds) {
      const r = await store.putEventsReturningIds(events);
      return { inserted: r.inserted, ids: new Set(r.ids) };
    }
    const had = new Set<string>();
    for (const id of new Set(events.map((e) => e.sessionId))) for (const e of await store.listEvents(id)) had.add(e.id);
    const { inserted } = await store.putEvents(events);
    // The count wins where it is certain: nothing inserted means nothing new, whatever the read said.
    return { inserted, ids: new Set(inserted ? events.flatMap((e) => (had.has(e.id) ? [] : [e.id])) : []) };
  }

  /** The commit failed after these ids were put: the next commit that carries them hands them on. */
  owe(ids: Iterable<string>): void {
    for (const id of ids) this.owed.add(id);
    for (const id of this.owed) {
      if (this.owed.size <= OWED_MAX) break;
      this.owed.delete(id);
    }
  }

  /**
   * The events of one request to hand on, in order: those whose id is in `ids`
   * (what the put inserted) or owed. Each id is handed on once: it leaves `ids`
   * and the owed set, so the first request of a commit that carries it gets it.
   */
  take(events: AgentEvent[], ids: Set<string>): AgentEvent[] {
    return events.filter((e) => {
      const inserted = ids.delete(e.id);
      return this.owed.delete(e.id) || inserted;
    });
  }
}

/**
 * Rebuilds sessions from all their stored events (spans arrive out of order).
 * `stored`: events the caller just stored, all of them new, by session; a
 * session that has no row yet is built from these instead of being read back.
 */
export async function rebuildSessions(store: IndexStore, ids: Iterable<string>, stored?: Map<string, AgentEvent[]>): Promise<Session[]> {
  const sessions: Session[] = [];
  for (const id of ids) {
    if (store.rebuildSession) {
      // The store reads and writes under a per-session lock (concurrent writers).
      const s = await store.rebuildSession(id, (prev, all) => (all.length ? buildSession(all, prev) : undefined));
      if (s) sessions.push(s);
      continue;
    }
    const prev = await store.getSession(id);
    const all = !prev && stored?.get(id) ? stored.get(id)! : await store.listEvents(id);
    if (!all.length) continue;
    const session = buildSession(all, prev);
    await store.upsertSession(session);
    sessions.push(session);
  }
  return sessions;
}

export interface OtlpSubmitInfo<A> {
  signal: Signal;
  decoded: ResourceSpans[] | ResourceLogs[];
  /** What authorize returned. */
  auth: A;
  /** Decompressed body size. */
  bytes: number;
  /** Spans or log records in the request. */
  items: number;
}

export interface OtlpHandlerOptions<A> {
  /** Request body limit, applied before and after decompression. Default 16 MiB. */
  maxBodyBytes?: number;
  /** Answer requests whose Host header is not loopback (the DNS-rebinding guard is on otherwise). */
  allowRemote?: boolean;
  /** Browser origins allowed by CORS. */
  corsOrigins?: (string | RegExp)[];
  /** Also allow http://localhost:* and 127.0.0.1:* origins (default true; serve turns it off). */
  allowLocalOrigins?: boolean;
  /**
   * Called before the body is read. Returning undefined answers 401 with
   * WWW-Authenticate: Bearer and google.rpc.Status code 16 (UNAUTHENTICATED).
   */
  authorize?: (req: IncomingMessage) => A | undefined | Promise<A | undefined>;
  /**
   * Handles one decoded traces/logs request; resolves once it is committed.
   * Throw an HttpError (e.g. 429/503 with Retry-After) to refuse it.
   */
  submit: (info: OtlpSubmitInfo<A>) => Promise<{ rejected: number; message: string }>;
  onError?: (err: Error) => void;
}

export type OtlpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/** The HTTP half of the receiver: routes, CORS, limits, decode, response encoding. */
export function createOtlpHandler<A = true>(opts: OtlpHandlerOptions<A>): OtlpHandler {
  const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const extraOrigins = opts.corsOrigins ?? [];
  const localOrigins = opts.allowLocalOrigins ?? true;
  const reportError = (err: unknown) => {
    try {
      opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    } catch {
      // never let a logging hook break ingestion
    }
  };

  const allowedOrigin = (origin: string): boolean =>
    (localOrigins && LOCAL_ORIGIN.test(origin)) || extraOrigins.some((o) => (typeof o === "string" ? o === origin : o.test(origin)));

  const send = (res: ServerResponse, status: number, format: Format, body: Uint8Array | string, headers: Record<string, string> = {}) => {
    const buf = typeof body === "string" ? Buffer.from(body) : body;
    res.writeHead(status, {
      "Content-Type": format === "json" ? "application/json" : "application/x-protobuf",
      "Content-Length": String(buf.byteLength),
      ...headers,
    });
    res.end(buf);
  };

  const sendError = (res: ServerResponse, format: Format, err: HttpError, headers: Record<string, string> = {}) => {
    const body = format === "json" ? JSON.stringify({ code: err.rpc, message: err.message }) : encodeStatus(err.rpc, err.message);
    send(res, err.status, format, body, { ...headers, ...err.headers });
  };

  return async (req, res) => {
    const format: Format = formatOf(req.headers["content-type"]) ?? "json";
    const cors: Record<string, string> = {};
    try {
      // DNS-rebinding guard: a loopback server must only answer to loopback names.
      if (!opts.allowRemote && !isLoopbackHost(hostOf(req.headers.host ?? ""))) {
        throw new HttpError(403, RPC.PERMISSION_DENIED, "Host header is not a loopback address");
      }
      const origin = req.headers.origin;
      if (origin !== undefined) {
        if (!allowedOrigin(origin)) throw new HttpError(403, RPC.PERMISSION_DENIED, `origin ${origin} is not allowed`);
        cors["Access-Control-Allow-Origin"] = origin;
        cors.Vary = "Origin";
      }
      const path = (req.url ?? "/").split("?")[0]!;
      const signal = ROUTES[path];
      if (!signal) throw new HttpError(404, RPC.NOT_FOUND, `no route for ${path}; use /v1/traces, /v1/logs or /v1/metrics`);

      if (req.method === "OPTIONS") {
        const asked = req.headers["access-control-request-headers"];
        res.writeHead(204, {
          ...cors,
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": typeof asked === "string" && /^[\w\-, ]*$/.test(asked) && asked ? asked : "Content-Type, Content-Encoding",
          "Access-Control-Max-Age": "86400",
          "Content-Length": "0",
        });
        res.end();
        return;
      }
      if (req.method !== "POST") {
        cors.Allow = "POST, OPTIONS";
        throw new HttpError(405, RPC.UNIMPLEMENTED, `method ${req.method} not allowed`);
      }
      const auth = opts.authorize ? await opts.authorize(req) : (true as A);
      if (auth === undefined) {
        // Drain so the client sees the 401, not a reset mid-upload.
        req.resume();
        throw new HttpError(401, RPC.UNAUTHENTICATED, "missing or invalid ingest key; send Authorization: Bearer <key>", { "WWW-Authenticate": "Bearer" });
      }
      const reqFormat = formatOf(req.headers["content-type"]);
      if (!reqFormat) {
        throw new HttpError(415, RPC.INVALID_ARGUMENT, `unsupported Content-Type ${JSON.stringify(req.headers["content-type"] ?? "")}; use application/x-protobuf or application/json`);
      }
      // Oversize bodies are drained (not buffered) and then refused: answering
      // before the upload finishes makes Node close the socket mid-write, and
      // the client sees a TCP reset instead of the 413. server.requestTimeout
      // bounds a client that never stops sending.
      const raw = await readBody(req, maxBody);
      const body = await decompress(raw, req.headers["content-encoding"], maxBody);
      let decoded;
      try {
        decoded = decode(signal, reqFormat, body);
      } catch (err) {
        if (err instanceof OtlpDecodeError) throw new HttpError(400, RPC.INVALID_ARGUMENT, err.message);
        throw err;
      }

      let rejected = 0;
      let message = "";
      if (decoded) {
        const r = await opts.submit({ signal, decoded, auth, bytes: body.byteLength, items: countOtlpItems(signal, decoded) });
        rejected = r.rejected;
        message = r.message;
      }
      if (reqFormat === "json") {
        const body = rejected > 0 ? { partialSuccess: { [REJECTED_FIELD[signal]]: String(rejected), errorMessage: message } } : {};
        send(res, 200, "json", JSON.stringify(body), cors);
      } else {
        send(res, 200, "proto", encodeExportResponse(rejected, rejected > 0 ? message : ""), cors);
      }
    } catch (err) {
      const e = err instanceof HttpError ? err : new HttpError(500, RPC.INTERNAL, (err as Error).message);
      if (!(err instanceof HttpError)) reportError(err);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendError(res, format, e, cors);
    }
  };
}

export async function startReceiver(opts: ReceiverOptions): Promise<Receiver> {
  const host = opts.host ?? "127.0.0.1";
  if (!opts.allowRemote && !isLoopbackHost(host)) {
    throw new Error(`refusing to bind OTLP receiver to non-loopback address ${host}; pass allowRemote: true to expose it`);
  }
  const redactor = opts.redactor === false ? undefined : (opts.redactor ?? createRedactor());
  const pipeline = createOtlpPipeline({
    store: opts.store,
    blobs: opts.blobs,
    ...(opts.maxInlineBytes !== undefined ? { maxInlineBytes: opts.maxInlineBytes } : {}),
    ...(redactor ? { redactor } : {}),
    keepRaw: opts.keepRaw ?? false,
    ...(opts.enrichSpan !== undefined ? { enrichSpan: opts.enrichSpan } : {}),
  });
  const reportError = (err: unknown) => {
    try {
      opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    } catch {
      // never let a logging hook break ingestion
    }
  };

  // Requests are persisted by one worker, a group at a time (group commit):
  // every request that arrived while the previous group was being written is
  // mapped in arrival order, its blobs written together and flushed once, its
  // events stored, and each session the group touched rebuilt once. Session
  // rebuilds read-modify-write the session row, so they never interleave.
  // A request is answered once its group is durable.
  const prices = opts.prices ?? pricesFor();
  type Job = {
    signal: Signal;
    decoded: ResourceSpans[] | ResourceLogs[];
    items: number;
    resolve: (r: { batch: BatchInfo; errors: string[] }) => void;
    reject: (err: unknown) => void;
  };
  const waiting: Job[] = [];
  let working: Promise<void> | undefined;
  const insertedEvents = new InsertedEvents();
  const commit = async (group: Job[]): Promise<void> => {
    const batch = opts.blobs.batch?.();
    const done: { job: Job; events: AgentEvent[]; rejected: number; errors: string[] }[] = [];
    for (const job of group) {
      try {
        const mapped = await pipeline.map(job.signal, job.decoded, batch);
        done.push({ job, events: applyPricing(mapped.events, prices), rejected: mapped.rejected, errors: mapped.errors });
      } catch (err) {
        job.reject(err);
      }
    }
    // What each request's put inserted, kept out here: a commit that fails after a put owes those ids.
    const puts: { inserted: number; ids: Set<string> }[] = [];
    try {
      await batch?.flush();
      // The group's events and session rows commit together (one transaction
      // where the store has them), and each request still counts its own inserts.
      const write = async () => {
        for (const d of done) puts.push(await insertedEvents.put(opts.store, d.events));
        // A session with no row yet whose events were all new is built from the
        // events in hand, without reading them back from the store.
        const fresh = done.every((d, i) => puts[i]!.inserted === d.events.length);
        const touched = new Map<string, AgentEvent[]>();
        for (const d of done) for (const e of d.events) (touched.get(e.sessionId) ?? touched.set(e.sessionId, []).get(e.sessionId)!).push(e);
        return new Map((await rebuildSessions(opts.store, touched.keys(), fresh ? touched : undefined)).map((s) => [s.id, s]));
      };
      const rebuilt = opts.store.transaction ? await opts.store.transaction(write) : await write();
      done.forEach((d, i) => {
        const sessions = [...new Set(d.events.map((e) => e.sessionId))].flatMap((id) => rebuilt.get(id) ?? []);
        const { inserted, ids } = puts[i]!;
        d.job.resolve({ batch: { signal: d.job.signal, events: d.events, inserted, insertedEvents: insertedEvents.take(d.events, ids), sessions, rejected: d.rejected }, errors: d.errors });
      });
    } catch (err) {
      // A store with no transaction keeps what was put: the retry inserts nothing and hands these on.
      for (const p of puts) insertedEvents.owe(p.ids);
      for (const d of done) d.job.reject(err);
    }
  };
  const work = async (): Promise<void> => {
    while (waiting.length) {
      // Up to GROUP_MAX_ITEMS spans or log records per group, and at least one request.
      let n = 1;
      for (let items = waiting[0]!.items; n < waiting.length && items + waiting[n]!.items <= GROUP_MAX_ITEMS; n++) items += waiting[n]!.items;
      await commit(waiting.splice(0, n));
    }
    working = undefined;
  };
  const persist = (signal: Signal, decoded: ResourceSpans[] | ResourceLogs[]): Promise<{ batch: BatchInfo; errors: string[] }> =>
    new Promise((resolve, reject) => {
      waiting.push({ signal, decoded, items: countOtlpItems(signal, decoded), resolve, reject });
      working ??= work();
    });

  const handle = createOtlpHandler<true>({
    ...(opts.maxBodyBytes !== undefined ? { maxBodyBytes: opts.maxBodyBytes } : {}),
    ...(opts.allowRemote !== undefined ? { allowRemote: opts.allowRemote } : {}),
    ...(opts.corsOrigins ? { corsOrigins: opts.corsOrigins } : {}),
    onError: reportError,
    async submit({ signal, decoded }) {
      let result;
      try {
        result = await persist(signal, decoded);
      } catch (err) {
        reportError(err);
        // 503 is retryable per the OTLP spec, so the exporter will re-send.
        throw new HttpError(503, RPC.UNAVAILABLE, `store unavailable: ${(err as Error).message}`);
      }
      const { batch, errors } = result;
      if (opts.onBatch) {
        try {
          await opts.onBatch(batch);
        } catch (err) {
          reportError(err);
        }
      }
      return { rejected: batch.rejected, message: errors.join("; ") };
    },
  });

  // Responses not yet sent. close() turns their keep-alive off, so a client whose
  // request was in flight gets Connection: close instead of an idle socket that
  // holds close() open for keepAliveTimeout.
  const live = new Set<ServerResponse>();
  let stopping = false;
  const server = createServer((req, res) => {
    if (stopping) res.shouldKeepAlive = false;
    live.add(res);
    res.once("close", () => live.delete(res));
    const route = opts.routes && Object.hasOwn(opts.routes, (req.url ?? "/").split("?")[0]!) ? opts.routes[(req.url ?? "/").split("?")[0]!] : undefined;
    void (route ?? handle)(req, res);
  });
  server.on("clientError", (_err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? DEFAULT_PORT, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address() as AddressInfo;
  const urlHost = addr.family === "IPv6" || addr.address.includes(":") ? `[${addr.address}]` : addr.address;

  let closing: Promise<void> | undefined;
  return {
    host: addr.address,
    port: addr.port,
    url: `http://${urlHost}:${addr.port}`,
    server,
    close() {
      stopping = true;
      for (const res of live) if (!res.headersSent) res.shouldKeepAlive = false;
      closing ??= new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeIdleConnections();
      }).then(async () => {
        while (working) await working;
      });
      return closing;
    },
  };
}
