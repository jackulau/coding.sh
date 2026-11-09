// createFetchHandler(): serve's ingest routes as one WHATWG Request → Response
// function, for platforms that run a function per request (Vercel Functions,
// Deno, Bun, Cloudflare Workers with nodejs_compat). Routes: /v1/traces,
// /v1/logs, /v1/metrics (OTLP/HTTP), /v1/ingest (the SDKs), /healthz, /readyz.
// The viewer, /metrics and the proxy stay on `coding.sh serve`.
//
// It runs the same handlers as serve (routes.ts) through a small Node
// request/response shim, and the same queue: map, scope, redact, price, write,
// rebuild, then answer, so a 200 still means committed. Differences:
// - No writer lock: many instances write at once. A store with rebuildSession
//   (Postgres: pg_advisory_xact_lock per session) keeps session stats correct;
//   without it, use one instance.
// - No serve:dirty repair kv and no retention timer; a failed write answers 503
//   and the client's retry rebuilds the same sessions.
// - Every request is treated as remote: ingest needs a key unless
//   CODING_SH_INSECURE=1.
// - The OTLP forward and [[sinks]] mirroring flush through waitUntil (Workers'
//   ctx.waitUntil, or opts.waitUntil such as @vercel/functions'), else on their timers.
import type { IncomingMessage, ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { BlobStore, IndexStore, Sink } from "../core/types.ts";
import type { SpanEnricher } from "../otel/map.ts";
import { canonicalScheme, openBlobStore, openIndexStore, openSink, parseStoreUrl } from "../store/factory.ts";
import { createAuthenticator } from "./auth.ts";
import { MAX_BODY_BYTES, resolveServeConfig, type ServeConfig } from "./config.ts";
import { createLogger, type Logger, safeUrl } from "./log.ts";
import { ServeMetrics } from "./metrics.ts";
import { IngestQueue } from "./queue.ts";
import { type CommitHooks, createCommitHooks, createNativeIngestHandler, createServeOtlpHandler, type HookTiming } from "./routes.ts";
import type { ReadyBody } from "./serve.ts";

export interface FetchHandlerOptions {
  /** Effective config. Default: resolveServeConfig({}, env), i.e. the same env and config.toml as serve. */
  config?: ServeConfig;
  /** Default process.env. */
  env?: NodeJS.ProcessEnv;
  /** Use these stores instead of opening config.core.store (e.g. indexStore() from coding.sh-store-postgres). */
  stores?: { index: IndexStore; blobs: BlobStore };
  /** Mirror to these instead of opening config.core.sinks. */
  sinks?: Sink[];
  log?: Logger;
  enrichSpan?: SpanEnricher | false;
  /** Keeps the forward and sink flush alive after the response (e.g. waitUntil from @vercel/functions). */
  waitUntil?: (p: Promise<unknown>) => void;
  /** Mount point stripped from the path, e.g. "/api/coding-sh" for /api/coding-sh/v1/traces. */
  basePath?: string;
  /** fetch for the OTLP forward. */
  fetch?: typeof fetch;
  /** Events per write (default 5,000). */
  tickEvents?: number;
  /** Forward and sink flush/backoff timing (tests). */
  hookTiming?: HookTiming;
}

export interface FetchHandler {
  /** Workers call fetch(request, env, ctx): a ctx with waitUntil is used for the after-response flush. */
  (request: Request, ...rest: unknown[]): Promise<Response>;
  /** Readiness as /readyz reports it. */
  ready(): Promise<{ status: number; body: ReadyBody }>;
  /** Sends buffered forward/sink work, then closes the stores (tests, a Deno or Bun server shutting down). */
  close(): Promise<void>;
}

interface Core {
  index: IndexStore;
  queue: IngestQueue;
  hooks: CommitHooks;
  close(): Promise<void>;
  otlp: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  native: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}

const OTLP_PATHS = new Set(["/v1/traces", "/v1/logs", "/v1/metrics"]);
const OPS_PATHS = new Set(["/healthz", "/readyz"]);

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });

/** Serve's ingest routes as a WHATWG fetch handler. Stores open on the first request. */
export function createFetchHandler(opts: FetchHandlerOptions = {}): FetchHandler {
  const env = opts.env ?? process.env;
  const cfg = opts.config ?? resolveServeConfig({}, env);
  const log = opts.log ?? createLogger({ format: cfg.log, write: (l) => console.error(l) });
  const metrics = new ServeMetrics();
  // A function is reachable from anywhere: open only with --insecure.
  const auth = createAuthenticator(cfg.credentials, { openIngest: cfg.insecure, openRead: false });
  const storeScheme = canonicalScheme(parseStoreUrl(cfg.core.store.index).scheme);
  const base = (opts.basePath ?? "").replace(/\/+$/, "");
  let core: Promise<Core> | undefined;
  let closed = false;

  const open = async (): Promise<Core> => {
    let index: IndexStore;
    let blobs: BlobStore;
    if (opts.stores) ({ index, blobs } = opts.stores);
    else {
      index = await openIndexStore(cfg.core.store.index, cfg.core);
      try {
        blobs = await openBlobStore(cfg.core.store.blobs, cfg.core);
      } catch (e) {
        await index.close().catch(() => {});
        throw e;
      }
    }
    const sinks: Sink[] = opts.sinks ?? [];
    if (!opts.sinks) {
      try {
        for (const sc of cfg.core.sinks) sinks.push(await openSink(sc, cfg.core));
      } catch (e) {
        for (const s of sinks) await s.close?.().catch(() => {});
        await index.close().catch(() => {});
        await blobs.close?.().catch(() => {});
        throw e;
      }
    }
    if (!index.rebuildSession) log.warn("this store has no per-session lock (rebuildSession); concurrent instances can race on session stats; run one instance or use postgres", { store: storeScheme });
    if (!cfg.insecure && cfg.credentials.ingest.size === 0) log.warn("no ingest keys: every ingest request gets 401; set CODING_SH_INGEST_KEYS");
    const hooks = createCommitHooks({ cfg, blobs, sinks, metrics, log, ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(opts.hookTiming ? { timing: opts.hookTiming } : {}) });
    const queue = new IngestQueue({
      store: index,
      blobs,
      config: cfg.core,
      maxEvents: cfg.queueMaxEvents,
      maxBytes: cfg.queueMaxBytes,
      metrics,
      log,
      dirtyKv: false,
      ...(opts.tickEvents !== undefined ? { tickEvents: opts.tickEvents } : {}),
      ...(opts.enrichSpan !== undefined ? { enrichSpan: opts.enrichSpan } : {}),
      ...(hooks.onCommit ? { onCommit: hooks.onCommit } : {}),
    });
    queue.setWritable(true);
    queue.start();
    log.info("store opened", { index: safeUrl(cfg.core.store.index), blobs: safeUrl(cfg.core.store.blobs) });
    const deps = { cfg, auth, queue, metrics, log, allowRemote: true };
    return {
      index,
      queue,
      hooks,
      otlp: createServeOtlpHandler(deps),
      native: createNativeIngestHandler(deps),
      async close() {
        await queue.drain(5000);
        await hooks.close(5000);
        await index.close().catch(() => {});
        await blobs.close?.().catch(() => {});
        metrics.close();
      },
    };
  };

  const getCore = (): Promise<Core> => {
    core ??= open().catch((e: unknown) => {
      core = undefined; // the next request tries again
      throw e;
    });
    return core;
  };

  const ready = async (): Promise<{ status: number; body: ReadyBody }> => {
    let reason: string | undefined;
    let depth = { events: 0, max: cfg.queueMaxEvents };
    try {
      const c = await getCore();
      depth = c.queue.depth;
      await Promise.race([c.index.ping ? c.index.ping() : c.index.listSessions({ limit: 1 }), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 2000).unref?.())]);
    } catch {
      reason = "store did not answer";
    }
    if (!reason && closed) reason = "shutting down";
    if (!reason && !cfg.insecure && cfg.credentials.ingest.size === 0) reason = "no ingest keys: set CODING_SH_INGEST_KEYS (or CODING_SH_INSECURE=1 to run open)";
    if (!reason && depth.events >= 0.9 * depth.max) reason = "ingest queue above 90%";
    const body: ReadyBody = { ok: !reason, store: storeScheme, writer: true, role: "all", queue: { events: depth.events, max: depth.max }, insecure: cfg.insecure };
    if (reason) body.reason = reason;
    return { status: reason ? 503 : 200, body };
  };

  const handler = (async (request: Request, ...rest: unknown[]): Promise<Response> => {
    const url = new URL(request.url);
    let path = url.pathname;
    if (base && (path === base || path.startsWith(`${base}/`))) path = path.slice(base.length) || "/";
    const method = request.method.toUpperCase();
    const label = OPS_PATHS.has(path) || OTLP_PATHS.has(path) || path === "/v1/ingest" ? path : "other";
    const count = (r: Response) => (metrics.httpRequests.inc({ route: label, status: String(r.status) }), r);
    if (OPS_PATHS.has(path)) {
      if (method !== "GET" && method !== "HEAD") return count(json(405, { error: "method not allowed", status: 405 }, { allow: "GET, HEAD" }));
      if (path === "/healthz") return count(json(200, { ok: true }));
      const r = await ready();
      return count(json(r.status, r.body));
    }
    if (!OTLP_PATHS.has(path) && path !== "/v1/ingest") {
      return count(json(404, { error: `no route for ${path}; this handler takes /v1/traces, /v1/logs, /v1/metrics, /v1/ingest, /healthz and /readyz`, status: 404 }));
    }
    if (closed) return count(json(503, { error: "server is shutting down; retry", status: 503 }, { "retry-after": "2" }));
    let c: Core;
    try {
      c = await getCore();
    } catch (e) {
      log.error("store unavailable", { error: (e as Error).message });
      return count(json(503, { error: `store unavailable: ${(e as Error).message}`, status: 503 }, { "retry-after": "2" }));
    }
    const res = await runNode(path === "/v1/ingest" ? c.native : c.otlp, request, url, path);
    // The commit is done; what it handed to the forward and the sinks goes out after the response.
    if (c.hooks.onCommit) {
      const waitUntil = opts.waitUntil ?? findWaitUntil(rest);
      if (waitUntil) waitUntil(c.hooks.flush().catch(() => {}));
    }
    return count(res);
  }) as FetchHandler;

  handler.ready = ready;
  handler.close = async () => {
    if (closed) return;
    closed = true;
    const c = await core?.catch(() => undefined);
    await c?.close();
  };
  return handler;
}

function findWaitUntil(rest: unknown[]): ((p: Promise<unknown>) => void) | undefined {
  for (const r of rest) {
    const w = (r as { waitUntil?: unknown } | null | undefined)?.waitUntil;
    if (typeof w === "function") return (p) => (w as (p: Promise<unknown>) => void).call(r, p);
  }
  return undefined;
}

// ---- the Node shim: an IncomingMessage and a ServerResponse, as far as the ingest handlers use them

/**
 * Reads a request body up to limit+1 bytes, so the handler still answers 413
 * for an oversized body without buffering all of it.
 */
async function readCapped(request: Request, limit: number): Promise<Buffer> {
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return Buffer.concat(chunks, size);
}

class ShimResponse extends EventEmitter {
  statusCode = 200;
  headersSent = false;
  writableEnded = false;
  private readonly headers = new Map<string, { name: string; value: string | string[] }>();
  private readonly chunks: Buffer[] = [];
  private done: ((r: Response) => void) | undefined;
  private fail: ((e: Error) => void) | undefined;
  readonly response: Promise<Response>;
  private readonly head: boolean;

  constructor(head: boolean) {
    super();
    this.head = head;
    this.response = new Promise<Response>((resolve, reject) => {
      this.done = resolve;
      this.fail = reject;
    });
  }

  setHeader(name: string, value: string | number | readonly string[]): this {
    this.headers.set(name.toLowerCase(), { name, value: Array.isArray(value) ? [...value] : String(value) });
    return this;
  }
  getHeader(name: string): string | string[] | undefined {
    return this.headers.get(name.toLowerCase())?.value;
  }
  removeHeader(name: string): void {
    this.headers.delete(name.toLowerCase());
  }
  writeHead(status: number, headers?: Record<string, string | number | readonly string[]>): this {
    this.statusCode = status;
    for (const [k, v] of Object.entries(headers ?? {})) if (v !== undefined) this.setHeader(k, v);
    this.headersSent = true;
    return this;
  }
  write(chunk: string | Uint8Array): boolean {
    this.headersSent = true;
    this.chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
    return true;
  }
  end(chunk?: string | Uint8Array): this {
    if (this.writableEnded) return this;
    if (chunk !== undefined) this.write(chunk);
    this.headersSent = true;
    this.writableEnded = true;
    const h = new Headers();
    for (const { name, value } of this.headers.values()) {
      // The runtime sets the length of what it sends.
      if (name.toLowerCase() === "content-length") continue;
      for (const v of Array.isArray(value) ? value : [value]) h.append(name, v);
    }
    const noBody = this.head || this.statusCode === 204 || this.statusCode === 304;
    this.done?.(new Response(noBody ? null : Buffer.concat(this.chunks), { status: this.statusCode, headers: h }));
    this.emit("finish");
    return this;
  }
  destroy(err?: Error): this {
    if (!this.writableEnded) {
      this.writableEnded = true;
      this.fail?.(err ?? new Error("response destroyed"));
    }
    this.emit("close");
    return this;
  }
}

async function runNode(fn: (req: IncomingMessage, res: ServerResponse) => Promise<void>, request: Request, url: URL, path: string): Promise<Response> {
  const body = request.method === "GET" || request.method === "HEAD" ? Buffer.alloc(0) : await readCapped(request, MAX_BODY_BYTES);
  const req = Readable.from(body.byteLength ? [body] : []) as unknown as IncomingMessage & { headers: Record<string, string> };
  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  headers.host ??= url.host;
  Object.assign(req, { headers, method: request.method.toUpperCase(), url: path + url.search, httpVersion: "1.1" });
  const res = new ShimResponse(request.method === "HEAD");
  try {
    await fn(req, res as unknown as ServerResponse);
  } catch (e) {
    if (!res.writableEnded) return json(500, { error: "internal error", status: 500 });
    throw e;
  }
  if (!res.writableEnded) return json(500, { error: "internal error: the handler did not answer", status: 500 });
  return res.response.catch(() => json(500, { error: "internal error", status: 500 }));
}
