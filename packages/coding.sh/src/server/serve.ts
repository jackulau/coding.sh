// `coding.sh serve`: one process, one port. OTLP/HTTP and native ingest go
// through a bounded queue to a single writer; the viewer, its API, health and
// Prometheus metrics are served next to them. See docs/PRODUCTION.md §1.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { BlobStore, IndexStore, Sink, WriterLock } from "../core/types.ts";
import { canonicalScheme, openBlobStore, openIndexStore, openSink, parseStoreUrl } from "../store/factory.ts";
import type { SpanEnricher } from "../otel/map.ts";
import { hostOf, isLoopbackHost, type Signal } from "../otel/receiver.ts";
import { createViewerHandler } from "../viewer/server.ts";
import { createRedactor } from "../core/redact.ts";
import { FileEvalStore } from "../datasets/store.ts";
import { createEveEvalsHandler, EVE_EVALS_PATH } from "../integrations/eve/evals.ts";
import { recorderFor } from "../proxy/index.ts";
import type { Recorder } from "../proxy/record.ts";
import { createProxyHandler, type Upstreams } from "../proxy/server.ts";
import { proxySettings } from "../proxy/state.ts";
import type { UpdateStatus } from "../update/index.ts";
import { createAuthenticator, READ_COOKIE } from "./auth.ts";
import { DRAIN_TIMEOUT_MS, type ServeConfig } from "./config.ts";
import { createLogger, type Logger, safeUrl } from "./log.ts";
import { ServeMetrics } from "./metrics.ts";
import { IngestQueue } from "./queue.ts";
import { startRetention } from "./retention.ts";
import { createCommitHooks, createNativeIngestHandler, createServeOtlpHandler, type HookTiming, sendJson } from "./routes.ts";
import { retryTransient } from "./startup.ts";

/** How long serve waits for a database that refuses connections at startup. */
export const STORE_WAIT_MS = 30_000;

export interface ServeOptions {
  log?: Logger;
  /** Use these stores instead of opening config.core.store (tests). They are closed on shutdown. */
  stores?: { index: IndexStore; blobs: BlobStore };
  enrichSpan?: SpanEnricher | false;
  /** Standby lock retry interval (default 5 s). */
  lockRetryMs?: number;
  /** Writer tick size (default 5,000 events; tests shrink it). */
  tickEvents?: number;
  /** Drain timeout on shutdown (default 25 s). */
  drainMs?: number;
  /** Where the /proxy/* routes forward (default: [proxy] in config.toml, then the public APIs). */
  proxyUpstreams?: Partial<Upstreams>;
  /** Mirror to these instead of opening config.core.sinks (tests). */
  sinks?: Sink[];
  /** fetch for the OTLP forward (tests). */
  fetch?: typeof fetch;
  /** Forward and sink flush/backoff timing (tests). */
  hookTiming?: HookTiming;
}

export interface ServeHandle {
  url: string;
  host: string;
  port: number;
  index: IndexStore;
  blobs: BlobStore;
  queue: IngestQueue;
  metrics: ServeMetrics;
  /** Readiness as /readyz reports it. */
  ready(): Promise<{ status: number; body: ReadyBody }>;
  /** Graceful shutdown: readyz 503, stop accepting, drain up to the timeout, close stores. Idempotent. */
  shutdown(): Promise<{ drained: boolean }>;
}

export interface ReadyBody {
  ok: boolean;
  store: string;
  writer: boolean;
  role: "all" | "viewer";
  queue: { events: number; max: number };
  insecure: boolean;
  reason?: string;
}

const ROUTE_LABELS = new Set(["/v1/traces", "/v1/logs", "/v1/metrics", "/v1/ingest", "/healthz", "/readyz", "/metrics", "/"]);
const routeLabel = (path: string) => (ROUTE_LABELS.has(path) ? path : path.startsWith("/api/") ? "/api" : path.startsWith(PROXY_PREFIX) ? "/proxy" : "other");

/** The model API proxy's mount: `<server>/proxy/v1/messages` is the Anthropic API, and so on. */
export const PROXY_PREFIX = "/proxy/";
/** The ingest key for the proxy routes (Authorization carries the client's own API key, forwarded upstream). */
export const PROXY_KEY_HEADER = "x-coding-sh-key";
const SIGNALS: Record<string, Signal> = { "/v1/traces": "traces", "/v1/logs": "logs", "/v1/metrics": "metrics" };
/** Health and metrics: GET or HEAD only. */
const OPS_PATHS = new Set(["/healthz", "/readyz", "/metrics"]);

/** Project ids that have sessions: the store's own listing, else a bounded scan of session rows. */
export async function storeProjects(index: IndexStore, cap = 100_000): Promise<string[]> {
  if (index.listProjects) return index.listProjects();
  const ids = new Set<string>();
  const batch = 1000;
  for (let offset = 0; offset < cap; offset += batch) {
    const rows = await index.listSessions({ limit: batch, offset });
    for (const s of rows) ids.add(s.project ?? "default");
    if (rows.length < batch) break;
  }
  return [...ids];
}

// Servers never phone home (update.check is forced off).
const noUpdates = async (): Promise<UpdateStatus> => ({
  current: "",
  latest: null,
  updateAvailable: false,
  url: null,
  notes: null,
  install: null,
  checkedAt: null,
  disabled: "coding.sh serve never checks for updates",
  error: null,
  command: "",
});

export async function startServe(cfg: ServeConfig, o: ServeOptions = {}): Promise<ServeHandle> {
  const log = o.log ?? createLogger({ format: cfg.log });
  const metrics = new ServeMetrics();
  const loopback = isLoopbackHost(cfg.host);
  const open = loopback || cfg.insecure;
  const auth = createAuthenticator(cfg.credentials, { openIngest: open, openRead: open });
  const storeScheme = canonicalScheme(parseStoreUrl(cfg.core.store.index).scheme);

  // ---- stores
  let index: IndexStore;
  let blobs: BlobStore;
  if (o.stores) ({ index, blobs } = o.stores);
  else {
    // A database that is still starting (Compose, platforms) gets 30 s; any other error fails at once.
    index = await retryTransient(() => openIndexStore(cfg.core.store.index, cfg.core), {
      timeoutMs: STORE_WAIT_MS,
      delayMs: 1000,
      onRetry: (e, attempt) => log.warn("store not reachable yet, retrying", { index: safeUrl(cfg.core.store.index), attempt, error: (e as Error).message }),
    });
    try {
      blobs = await openBlobStore(cfg.core.store.blobs, cfg.core);
    } catch (e) {
      await index.close().catch(() => {});
      throw e;
    }
  }
  log.info("store opened", { index: safeUrl(cfg.core.store.index), blobs: safeUrl(cfg.core.store.blobs) });

  // ---- after a commit: the OTLP forward and [[sinks]] mirroring (writer only)
  let sinks: Sink[] = o.sinks ?? [];
  if (!o.sinks && cfg.role === "all") {
    try {
      for (const sc of cfg.core.sinks) sinks.push(await openSink(sc, cfg.core));
    } catch (e) {
      for (const s of sinks) await s.close?.().catch(() => {});
      await index.close().catch(() => {});
      await blobs.close?.().catch(() => {});
      throw e;
    }
  }
  if (cfg.role === "viewer") sinks = [];
  const hooks = createCommitHooks({ cfg: cfg.role === "viewer" ? { ...cfg, forward: undefined } : cfg, blobs, sinks, metrics, log, ...(o.fetch ? { fetch: o.fetch } : {}), ...(o.hookTiming ? { timing: o.hookTiming } : {}) });
  if (hooks.forwarder) log.info("forwarding committed traces", { endpoint: safeUrl(hooks.forwarder.url), mode: cfg.forward!.mode });
  if (hooks.mirror) log.info("mirroring committed events to sinks", { sinks: sinks.map((s) => s.name) });

  const queue = new IngestQueue({
    store: index,
    blobs,
    config: cfg.core,
    maxEvents: cfg.queueMaxEvents,
    maxBytes: cfg.queueMaxBytes,
    metrics,
    log,
    ...(o.tickEvents !== undefined ? { tickEvents: o.tickEvents } : {}),
    ...(o.enrichSpan !== undefined ? { enrichSpan: o.enrichSpan } : {}),
    onLeaseLost: () => void loseWriter(),
    ...(hooks.onCommit ? { onCommit: hooks.onCommit } : {}),
  });

  // ---- writer lock (role all): repair before taking traffic, standby retries every 5 s
  let lock: WriterLock | undefined;
  let lockTimer: NodeJS.Timeout | undefined;
  let stopRetention: (() => void) | undefined;
  let shuttingDown = false;
  const becomeWriter = async (): Promise<boolean> => {
    if (!index.acquireWriterLock) {
      queue.setWritable(true);
    } else {
      lock = await index.acquireWriterLock({ waitMs: 0 });
      if (!lock) return false;
    }
    const repaired = await queue.repair();
    if (repaired) log.info("repaired sessions left dirty by a previous writer", { sessions: repaired });
    const held = lock;
    queue.setWritable(true, held?.assertHeld ? () => held.assertHeld!() : undefined);
    stopRetention = startRetention({ store: index, blobs, config: cfg.core, days: cfg.retentionDays, run: (fn) => queue.runExclusive(fn), log });
    return true;
  };
  Object.assign(metrics.gauges, { queueEvents: () => queue.depth.events, queueBytes: () => queue.depth.bytes, writerLockHeld: () => queue.isWritable });
  const retry = () => {
    lockTimer = setTimeout(async () => {
      if (shuttingDown) return;
      try {
        if (await becomeWriter()) log.info("writer lock acquired");
        else retry();
      } catch (e) {
        log.error("writer lock retry failed", { error: (e as Error).message });
        retry();
      }
    }, o.lockRetryMs ?? 5000);
    lockTimer.unref();
  };
  // The queue found the lease taken over (it is standby already): stop the
  // timers that write, drop our handle (it never removes the new holder's
  // file) and wait to become the writer again.
  const loseWriter = async () => {
    stopRetention?.();
    stopRetention = undefined;
    const l = lock;
    lock = undefined;
    await l?.release().catch(() => {});
    if (!shuttingDown) retry();
  };
  if (cfg.role === "all") {
    try {
      if (!(await becomeWriter())) {
        log.warn("standby: another replica holds the writer lock; retrying every 5s");
        retry();
      }
    } catch (e) {
      await hooks.close(0);
      await index.close().catch(() => {});
      await blobs.close?.().catch(() => {});
      throw e;
    }
    queue.start();
  }

  // ---- handlers
  const routeDeps = { cfg, auth, queue, metrics, log, allowRemote: !loopback };
  const otlp = createServeOtlpHandler(routeDeps);
  const native = createNativeIngestHandler(routeDeps);

  // ---- eve eval runs (codingShReporter): a dataset version and an experiment. Eval assets belong to no project.
  const eveEvals = createEveEvalsHandler({
    store: new FileEvalStore({ index }),
    redactor: createRedactor({ redact: cfg.core.capture.redact, patterns: cfg.core.capture.redactPatterns }),
    allowRemote: !loopback,
    authorize: (req) => {
      const ok = auth.ingest(req) !== undefined;
      if (!ok) metrics.authFailures.inc({ route: EVE_EVALS_PATH });
      return ok;
    },
    unavailable: () => (queue.isWritable ? undefined : "standby: another replica holds the writer lock"),
    onError: (err) => log.error("eve evals", { error: err.message }),
  });

  // ---- the model API proxy at /proxy/*: logs each call into the caller's project
  // (x-coding-sh-key, an ingest key) and forwards the client's own API key upstream.
  const recorders = new Map<string, Recorder>();
  const recorderOf = (project: string): Recorder => {
    let r = recorders.get(project);
    if (!r) {
      r = recorderFor({
        config: cfg.core,
        index,
        blobs,
        project,
        write: async (events) => {
          await queue.submit({ kind: "native", project, events, items: events.length, bytes: events.reduce((n, e) => n + JSON.stringify(e.payload).length, 0) });
        },
        onError: (e) => log.warn("proxy call not recorded", { project, error: e.message }),
      });
      recorders.set(project, r);
    }
    return r;
  };
  const proxyHandler = createProxyHandler({
    upstreams: o.proxyUpstreams ?? proxySettings(process.env).upstreams,
    allowRemote: !loopback,
    dropHeaders: [PROXY_KEY_HEADER],
    onError: (e) => log.warn("proxy", { error: e.message }),
  });
  const proxy = (req: IncomingMessage, res: ServerResponse): void => {
    const h = req.headers[PROXY_KEY_HEADER];
    const project = auth.ingestKey(typeof h === "string" ? h.trim() : undefined);
    if (project === undefined) {
      metrics.authFailures.inc({ route: "/proxy" });
      req.resume();
      // The Anthropic/OpenAI error shape, so agents show the message.
      return sendJson(res, 401, { type: "error", error: { type: "authentication_error", message: `coding.sh serve: missing or invalid ingest key; send it in the ${PROXY_KEY_HEADER} header` } });
    }
    const rest = `/${(req.url ?? "/").slice(PROXY_PREFIX.length)}`;
    proxyHandler(req, res, { path: rest, recorder: recorderOf(project) });
  };

  const secureCookie = (req: IncomingMessage) => cfg.trustProxy && String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]!.trim() === "https";
  const viewer = await createViewerHandler({
    index,
    blobs,
    authorize: (req) => auth.read(req),
    // Loopback binds keep the DNS-rebinding guard; a public bind sits behind a platform's host routing.
    checkHost: (h) => !loopback || isLoopbackHost(hostOf(h)),
    exchangeToken: (t, req) =>
      auth.readScope(t) !== undefined ? `${READ_COOKIE}=${t}; HttpOnly; SameSite=Strict; Path=/${secureCookie(req) ? "; Secure" : ""}` : undefined,
    ...(cfg.credentials.basic ? { basicRealm: "coding.sh" } : {}),
    // A GET form to /?t=…: the same token exchange as a pasted link, which then drops the key from the address bar.
    unauthorizedText:
      "This coding.sh server needs a read key (csh_rk_…).</p>" +
      '<form method=get action="/"><input name=t type=password autocomplete=off required placeholder="csh_rk_…" aria-label="Read key" size=48 style="font:inherit;padding:.4rem"> <button style="font:inherit;padding:.4rem .8rem">Open</button></form>' +
      "<p>Or open <code>/?t=&lt;read key&gt;</code> once, or sign in with the configured user.",
    // Configured projects plus those in the data (a viewer replica, or keys since removed).
    projects: async () => [...new Set([...cfg.projects, ...(await storeProjects(index))])],
    updateStatus: noUpdates,
  });

  let storeOk = true;
  const ready = async (): Promise<{ status: number; body: ReadyBody }> => {
    let reason: string | undefined;
    try {
      await Promise.race([index.ping ? index.ping() : index.listSessions({ limit: 1 }), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 2000).unref())]);
      storeOk = true;
    } catch {
      storeOk = false;
      reason = "store did not answer";
    }
    const depth = queue.depth;
    if (!reason && shuttingDown) reason = "shutting down";
    if (!reason && cfg.role === "all" && !queue.isWritable) reason = "standby: another replica holds the writer lock";
    if (!reason && depth.events >= 0.9 * depth.max) reason = "ingest queue above 90%";
    const body: ReadyBody = { ok: !reason, store: storeScheme, writer: queue.isWritable, role: cfg.role, queue: { events: depth.events, max: depth.max }, insecure: cfg.insecure };
    if (reason) body.reason = reason;
    return { status: reason ? 503 : 200, body };
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? "/").split("?")[0]!;
    res.once("finish", () => metrics.httpRequests.inc({ route: routeLabel(path), status: String(res.statusCode) }));
    if (OPS_PATHS.has(path) && req.method !== "GET" && req.method !== "HEAD") {
      return sendJson(res, 405, { error: "method not allowed", status: 405 }, { Allow: "GET, HEAD" });
    }
    if (path === "/healthz") return sendJson(res, 200, { ok: true });
    if (path === "/readyz") {
      const r = await ready();
      return sendJson(res, r.status, r.body);
    }
    if (path === "/metrics") {
      const access = auth.read(req);
      if (!access) {
        res.setHeader("WWW-Authenticate", cfg.credentials.basic ? 'Basic realm="coding.sh"' : "Bearer");
        return sendJson(res, 401, { error: "missing or invalid read key", status: 401 });
      }
      // Counters carry every project's name and volume: a key scoped to one project gets none of them.
      if (access.project !== undefined) return sendJson(res, 403, { error: 'metrics need a read key for every project ("*") or basic auth', status: 403 });
      const text = metrics.render();
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8", "Content-Length": String(Buffer.byteLength(text)), "Cache-Control": "no-store" });
      res.end(text);
      return;
    }
    if (path === EVE_EVALS_PATH) {
      if (cfg.role === "viewer") return sendJson(res, 404, { error: "this replica runs --role viewer and takes no ingest", status: 404 });
      return eveEvals(req, res);
    }
    if (SIGNALS[path] || path === "/v1/ingest" || path.startsWith(PROXY_PREFIX)) {
      if (cfg.role === "viewer") return sendJson(res, 404, { error: "this replica runs --role viewer and takes no ingest", status: 404 });
      if (path.startsWith(PROXY_PREFIX)) return proxy(req, res);
      return path === "/v1/ingest" ? native(req, res) : otlp(req, res);
    }
    return viewer(req, res);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      log.error("request failed", { error: (err as Error)?.message });
      if (!res.headersSent) sendJson(res, 500, { error: "internal error", status: 500 });
      else res.destroy();
    });
  });
  server.headersTimeout = 20_000;
  server.requestTimeout = 120_000;
  server.keepAliveTimeout = 65_000;
  server.on("clientError", (_err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(cfg.port, cfg.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (e) {
    stopRetention?.();
    await hooks.close(0);
    if (lockTimer) clearTimeout(lockTimer);
    await lock?.release().catch(() => {});
    await index.close().catch(() => {});
    await blobs.close?.().catch(() => {});
    throw e;
  }
  const addr = server.address() as AddressInfo;
  const urlHost = cfg.host === "0.0.0.0" || cfg.host === "::" ? "127.0.0.1" : addr.address.includes(":") ? `[${addr.address}]` : addr.address;
  const url = `http://${urlHost}:${addr.port}`;
  log.info("listening", { url, host: cfg.host, port: addr.port, role: cfg.role, store: storeScheme, projects: cfg.projects.length });
  if (cfg.insecure) log.warn("running with --insecure: anyone who can reach this port can ingest and read", { host: cfg.host });

  // ---- one summary line per minute
  let last = { inserted: 0, throttled: 0 };
  const sum = (c: { values: Map<string, { labels: Record<string, string>; value: number }> }, pred: (l: Record<string, string>) => boolean = () => true) =>
    [...c.values.values()].filter((v) => pred(v.labels)).reduce((n, v) => n + v.value, 0);
  const summary = setInterval(() => {
    const inserted = sum(metrics.ingestEvents, (l) => l.result === "inserted");
    const throttled = sum(metrics.throttled);
    if (inserted !== last.inserted || throttled !== last.throttled || queue.depth.events) {
      log.info("summary", { inserted: inserted - last.inserted, throttled: throttled - last.throttled, queueEvents: queue.depth.events, storeOk });
    }
    last = { inserted, throttled };
  }, 60_000);
  summary.unref();

  let shutdown: Promise<{ drained: boolean }> | undefined;
  return {
    url,
    host: addr.address,
    port: addr.port,
    index,
    blobs,
    queue,
    metrics,
    ready,
    shutdown() {
      shutdown ??= (async () => {
        shuttingDown = true;
        log.info("shutting down", { queueEvents: queue.depth.events });
        clearInterval(summary);
        if (lockTimer) clearTimeout(lockTimer);
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        server.closeIdleConnections();
        // Calls the proxy routes answered reach the queue before it drains.
        await Promise.all([...recorders.values()].map((r) => r.flush().catch(() => {})));
        const drainMs = o.drainMs ?? DRAIN_TIMEOUT_MS;
        const t0 = Date.now();
        const { drained } = cfg.role === "all" ? await queue.drain(drainMs) : { drained: true };
        stopRetention?.();
        // What the drain committed goes on to the collector and sinks within what is left of the timeout.
        await hooks.close(Math.max(1000, drainMs - (Date.now() - t0)));
        // Requests answered during the drain have flushed; drop what is left (keep-alive sockets).
        server.closeAllConnections();
        await closed;
        await lock?.release().catch(() => {});
        await index.close().catch((e: Error) => log.error("closing the store failed", { error: e.message }));
        await blobs.close?.().catch(() => {});
        metrics.close();
        log.info("stopped", { drained });
        return { drained };
      })();
      return shutdown;
    },
  };
}
