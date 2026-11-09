// The ingest routes shared by `coding.sh serve` (serve.ts, node:http) and the
// serverless fetch handler (fetch.ts): OTLP/HTTP, native /v1/ingest, and what
// runs after a commit (the OTLP forward and [[sinks]] mirroring).
import type { IncomingMessage, ServerResponse } from "node:http";
import type { BlobStore, Sink } from "../core/types.ts";
import { createRedactor } from "../core/redact.ts";
import type { ResourceSpans } from "../otel/model.ts";
import { createOtlpHandler, decompress, HttpError, type OtlpHandler, readBody, RPC } from "../otel/receiver.ts";
import type { Authenticator } from "./auth.ts";
import { MAX_BODY_BYTES, type ServeConfig } from "./config.ts";
import { OtlpForwarder } from "./forward.ts";
import type { Logger } from "./log.ts";
import type { ServeMetrics } from "./metrics.ts";
import { SinkMirror } from "./mirror.ts";
import { parseNativeBatch } from "./native.ts";
import type { CommittedEntry, IngestQueue } from "./queue.ts";

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": String(Buffer.byteLength(json)), "Cache-Control": "no-store", ...headers });
  res.end(json);
}

export interface IngestRouteDeps {
  cfg: ServeConfig;
  auth: Authenticator;
  queue: IngestQueue;
  metrics: ServeMetrics;
  log: Logger;
  /** Answer requests whose Host header is not loopback. */
  allowRemote: boolean;
}

/** OTLP/HTTP traces, logs and metrics into the queue, scoped to the ingest key's project. */
export function createServeOtlpHandler(d: IngestRouteDeps): OtlpHandler {
  return createOtlpHandler<string>({
    maxBodyBytes: MAX_BODY_BYTES,
    allowRemote: d.allowRemote,
    corsOrigins: d.cfg.corsOrigins,
    allowLocalOrigins: false,
    authorize(req) {
      const project = d.auth.ingest(req);
      if (project === undefined) d.metrics.authFailures.inc({ route: (req.url ?? "").split("?")[0]! });
      return project;
    },
    async submit({ signal, decoded, auth: project, bytes, items }) {
      const r = await d.queue.submit({ kind: "otlp", project, signal, decoded, items: Math.max(items, 1), bytes });
      return { rejected: r.rejected, message: r.message };
    },
    onError: (err) => d.log.error("otlp", { error: err.message }),
  });
}

/** POST /v1/ingest: the SDKs' native batches. serve.cors_origins applies (a browser SDK posts with a preflight). */
export function createNativeIngestHandler(d: IngestRouteDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { cfg, auth, queue, metrics, log } = d;
  return async (req, res) => {
    const cors: Record<string, string> = {};
    try {
      const origin = req.headers.origin;
      if (origin !== undefined) {
        if (!cfg.corsOrigins.includes(origin)) {
          req.resume();
          throw new HttpError(403, RPC.PERMISSION_DENIED, `origin ${origin} is not allowed`);
        }
        cors["Access-Control-Allow-Origin"] = origin;
        cors["Access-Control-Expose-Headers"] = "Retry-After";
        cors.Vary = "Origin";
      }
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          ...cors,
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type, Content-Encoding",
          "Access-Control-Max-Age": "86400",
          "Content-Length": "0",
        });
        res.end();
        return;
      }
      if (req.method !== "POST") throw new HttpError(405, RPC.UNIMPLEMENTED, "use POST", { Allow: "POST, OPTIONS" });
      const project = auth.ingest(req);
      if (project === undefined) {
        metrics.authFailures.inc({ route: "/v1/ingest" });
        req.resume();
        throw new HttpError(401, RPC.UNAUTHENTICATED, "missing or invalid ingest key; send Authorization: Bearer <key>", { "WWW-Authenticate": "Bearer" });
      }
      const ct = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
      if (ct !== "application/json") {
        req.resume();
        throw new HttpError(415, RPC.INVALID_ARGUMENT, "Content-Type must be application/json");
      }
      const raw = await readBody(req, MAX_BODY_BYTES);
      const body = await decompress(raw, req.headers["content-encoding"], MAX_BODY_BYTES);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        throw new HttpError(400, RPC.INVALID_ARGUMENT, "body is not valid JSON");
      }
      const batch = parseNativeBatch(parsed, project);
      let inserted = 0;
      if (batch.events.length) {
        const r = await queue.submit({ kind: "native", project, events: batch.events, items: batch.events.length, bytes: body.byteLength });
        inserted = r.inserted;
      }
      if (batch.rejected.length) metrics.ingestEvents.inc({ project, result: "rejected" }, batch.rejected.length);
      sendJson(res, 200, { accepted: batch.events.length, inserted, rejected: batch.rejected }, cors);
    } catch (err) {
      const e = err instanceof HttpError ? err : new HttpError(500, RPC.INTERNAL, "internal error");
      if (!(err instanceof HttpError)) log.error("ingest", { error: (err as Error).message });
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendJson(res, e.status, { error: e.message, status: e.status }, { ...cors, ...e.headers });
    }
  };
}

/** What runs after a commit: the OTLP forward ([serve.forward]) and [[sinks]] mirroring. */
export interface CommitHooks {
  /** IngestQueueOptions.onCommit; undefined when there is nothing to do. */
  onCommit: ((committed: CommittedEntry[]) => void) | undefined;
  forwarder?: OtlpForwarder;
  mirror?: SinkMirror;
  /** Sends what is buffered now (a serverless function calls this before it freezes). */
  flush(): Promise<void>;
  /** Sends what is buffered for up to timeoutMs, then stops. */
  close(timeoutMs: number): Promise<void>;
}

/** Flush and backoff timing for the forward and the sink mirror (tests shrink them). */
export interface HookTiming {
  flushMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

export function createCommitHooks(o: { cfg: ServeConfig; blobs: BlobStore; sinks: Sink[]; metrics: ServeMetrics; log: Logger; fetch?: typeof fetch; timing?: HookTiming }): CommitHooks {
  const { cfg, metrics, log } = o;
  const forwarder = cfg.forward
    ? new OtlpForwarder({
        config: cfg.forward,
        redactor: createRedactor({ redact: cfg.core.capture.redact, patterns: cfg.core.capture.redactPatterns }),
        metrics,
        log,
        ...(o.fetch ? { fetch: o.fetch } : {}),
        ...o.timing,
      })
    : undefined;
  if (forwarder) metrics.gauges.forwardBufferSpans = () => forwarder.buffered;
  const mirror = o.sinks.length ? new SinkMirror({ sinks: o.sinks, blobs: o.blobs, config: cfg.core, metrics, log, ...o.timing }) : undefined;
  const onCommit =
    forwarder || mirror
      ? (committed: CommittedEntry[]) => {
          for (const c of committed) {
            mirror?.add(c.events, c.sessions);
            if (!forwarder) continue;
            // Traces only (v1): log records and metrics are stored but not forwarded.
            if (c.entry.kind === "otlp") {
              if (c.entry.signal === "traces") forwarder.enqueue(c.entry.decoded as ResourceSpans[], c.entry.project);
            } else forwarder.enqueueNative(c.events, c.sessions, c.entry.project);
          }
        }
      : undefined;
  return {
    onCommit,
    ...(forwarder ? { forwarder } : {}),
    ...(mirror ? { mirror } : {}),
    async flush() {
      await Promise.all([forwarder?.pump(), mirror?.flush()]);
    },
    async close(timeoutMs) {
      await Promise.all([forwarder?.close(timeoutMs), mirror?.close(timeoutMs)]);
    },
  };
}
