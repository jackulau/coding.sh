// The proxy's HTTP half: forwards every request to the real API and hands a
// copy of the exchange to the recorder.
//
// - Bytes go to the client as they arrive: each upstream chunk is written to
//   the client first, then read by the side parser. No buffering, no rewriting.
// - The client's own headers (its API key or OAuth token) go upstream unchanged
//   and are never stored. Hop-by-hop headers and `x-coding-sh-*` are dropped.
// - A store failure never reaches the client: recording runs after the
//   response and its errors go to onError.
// - Nothing is pooled or rotated: one client request, one upstream request,
//   with the client's credentials.
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import type { Socket } from "node:net";
import type { Transform } from "node:stream";
import zlib from "node:zlib";
import { hostOf, isLoopbackHost } from "../otel/receiver.ts";
import type { CapturedCall, Recorder } from "./record.ts";
import { SseParser } from "./sse.ts";
import { accumulatorFor, type CallResult, classify, parseJsonResponse, type Route } from "./wire.ts";

export const DEFAULT_PROXY_PORT = 4320;
export const DEFAULT_UPSTREAMS = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
  /** Codex signed in with ChatGPT talks to this backend, not api.openai.com. */
  chatgpt: "https://chatgpt.com/backend-api/codex",
} as const;
/** Request and response bodies larger than this are forwarded but not kept for parsing. */
export const DEFAULT_MAX_CAPTURE_BYTES = 32 * 1024 * 1024;
/** Paths under this prefix are the proxy's own (health), never forwarded. */
export const CONTROL_PREFIX = "/__codingsh/";

export interface Upstreams {
  anthropic: string;
  openai: string;
  chatgpt: string;
}

export interface ProxyHandlerOptions {
  upstreams?: Partial<Upstreams>;
  recorder?: Recorder;
  maxCaptureBytes?: number;
  /** Answer requests whose Host header is not loopback (the DNS-rebinding guard is on otherwise). */
  allowRemote?: boolean;
  /** Extra request headers never forwarded upstream (serve's ingest key header). */
  dropHeaders?: string[];
  onError?: (err: Error) => void;
  /** Health response extras. */
  info?: Record<string, unknown>;
}

export interface ProxyRequestContext {
  /** Path to forward (serve strips its mount prefix). Default req.url. */
  path?: string;
  /** Recorder for this request (serve: one per project). Default the handler's. */
  recorder?: Recorder;
}

export type ProxyHandler = (req: IncomingMessage, res: ServerResponse, ctx?: ProxyRequestContext) => void;

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization", "te", "trailer", "trailers", "transfer-encoding", "upgrade", "host"]);

function hopHeaders(h: IncomingHttpHeaders): Set<string> {
  const out = new Set(HOP_BY_HOP);
  const conn = h.connection;
  if (typeof conn === "string") for (const t of conn.split(",")) if (t.trim()) out.add(t.trim().toLowerCase());
  return out;
}

/** Request headers for the upstream: the client's own, minus hop-by-hop and ours, with Host set to the upstream. */
export function forwardHeaders(req: IncomingMessage, target: URL, drop: readonly string[] = []): Record<string, string | string[]> {
  const skip = hopHeaders(req.headers);
  const out: Record<string, string | string[]> = {};
  const seen = new Map<string, string>();
  const raw = req.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i]!;
    const lower = name.toLowerCase();
    if (skip.has(lower) || lower.startsWith("x-coding-sh-") || drop.includes(lower)) continue;
    const prev = seen.get(lower);
    if (prev === undefined) {
      seen.set(lower, name);
      out[name] = raw[i + 1]!;
    } else {
      const cur = out[prev]!;
      out[prev] = Array.isArray(cur) ? [...cur, raw[i + 1]!] : [cur, raw[i + 1]!];
    }
  }
  out.Host = target.host;
  return out;
}

/** Response headers for the client, as the upstream sent them (names keep their case), minus hop-by-hop. */
function responseHeaders(res: IncomingMessage): string[] {
  const skip = hopHeaders(res.headers);
  skip.delete("host");
  const out: string[] = [];
  const raw = res.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2) if (!skip.has(raw[i]!.toLowerCase())) out.push(raw[i]!, raw[i + 1]!);
  return out;
}

/** base + path, without doubling a `/v1` both carry. */
export function joinUpstream(base: string, path: string): URL {
  const u = new URL(base);
  const prefix = u.pathname.replace(/\/+$/, "");
  let p = path.startsWith("/") ? path : `/${path}`;
  if (/\/v1$/.test(prefix) && /^\/v1(?:[/?]|$)/.test(p)) p = p.slice(3) || "/";
  return new URL(`${u.origin}${prefix}${p}`);
}

/** Where a request goes. Codex with a ChatGPT login (chatgpt-account-id) goes to the ChatGPT backend. */
export function upstreamFor(route: Route, headers: IncomingHttpHeaders, path: string, up: Upstreams, explicitOpenai: boolean): URL {
  if (route.provider === "anthropic") return joinUpstream(up.anthropic, path);
  if (headers["chatgpt-account-id"] !== undefined && !explicitOpenai) return joinUpstream(up.chatgpt, path.replace(/^\/v1(?=\/|$)/, ""));
  return joinUpstream(up.openai, path);
}

function decoderFor(encoding: string | undefined): Transform | undefined | null {
  const enc = (encoding ?? "").trim().toLowerCase();
  if (!enc || enc === "identity") return undefined;
  if (enc === "gzip" || enc === "x-gzip") return zlib.createGunzip();
  if (enc === "deflate") return zlib.createInflate();
  if (enc === "br") return zlib.createBrotliDecompress();
  const z = (zlib as unknown as { createZstdDecompress?: () => Transform }).createZstdDecompress;
  if (enc === "zstd" && z) return z();
  // Unknown encoding: forwarded as is, not parsed.
  return null;
}

const jsonError = (status: number, message: string): string => JSON.stringify({ type: "error", error: { type: status === 502 ? "api_error" : "invalid_request_error", message } });

export function createProxyHandler(o: ProxyHandlerOptions = {}): ProxyHandler {
  const up: Upstreams = { ...DEFAULT_UPSTREAMS, ...o.upstreams };
  const explicitOpenai = o.upstreams?.openai !== undefined && o.upstreams.openai !== DEFAULT_UPSTREAMS.openai;
  const max = o.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE_BYTES;
  const drop = (o.dropHeaders ?? []).map((h) => h.toLowerCase());
  const agents = { http: new http.Agent({ keepAlive: true }), https: new https.Agent({ keepAlive: true }) };
  const report = (err: unknown) => {
    try {
      o.onError?.(err instanceof Error ? err : new Error(String(err)));
    } catch {
      // ignore
    }
  };

  return (req, res, ctx) => {
    const startedAt = Date.now();
    const path = ctx?.path ?? req.url ?? "/";
    const recorder = ctx?.recorder ?? o.recorder;
    if (!o.allowRemote && !isLoopbackHost(hostOf(req.headers.host ?? ""))) {
      req.resume();
      res.writeHead(403, { "Content-Type": "application/json" }).end(jsonError(403, "coding.sh proxy: Host header is not a loopback address"));
      return;
    }
    if (path.startsWith(CONTROL_PREFIX)) {
      req.resume();
      if (path.split("?")[0] === `${CONTROL_PREFIX}health`) {
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, service: "coding.sh proxy", upstreams: up, ...o.info }));
      } else res.writeHead(404, { "Content-Type": "application/json" }).end(jsonError(404, `coding.sh proxy: no route ${path}`));
      return;
    }
    // A browser page must not use the proxy (it would log into the store).
    const origin = req.headers.origin;
    if (origin !== undefined && !/^https?:\/\/(localhost|127(?:\.\d{1,3}){3}|\[::1\])(:\d{1,5})?$/i.test(origin)) {
      req.resume();
      res.writeHead(403, { "Content-Type": "application/json" }).end(jsonError(403, "coding.sh proxy: cross-origin requests are not allowed"));
      return;
    }

    const method = req.method ?? "GET";
    const route = classify(method, path, req.headers);
    let target: URL;
    try {
      target = upstreamFor(route, req.headers, path, up, explicitOpenai);
    } catch (err) {
      req.resume();
      res.writeHead(400, { "Content-Type": "application/json" }).end(jsonError(400, `coding.sh proxy: bad path: ${(err as Error).message}`));
      return;
    }
    const capture = !!recorder && route.api !== "other";

    // ---- request: streamed upstream as it arrives; a copy kept for the recorder.
    const reqChunks: Buffer[] = [];
    let reqBytes = 0;
    let reqOver = false;
    if (capture) {
      req.on("data", (c: Buffer) => {
        reqBytes += c.length;
        if (reqOver) return;
        if (reqBytes > max) {
          reqOver = true;
          reqChunks.length = 0;
        } else reqChunks.push(c);
      });
    }

    let done = false;
    let status: number | undefined;
    let resHeaders: IncomingHttpHeaders | undefined;
    let headersAt: number | undefined;
    let firstByteAt: number | undefined;
    let resBytes = 0;
    let stream = false;
    let parse: ((chunk: Buffer, now: number) => void) | undefined;
    let result: (() => CallResult | undefined) | undefined;
    let decoderDone: Promise<void> = Promise.resolve();
    let endDecoder: (() => void) | undefined;

    const finish = (extra: { networkError?: string; aborted?: boolean } = {}) => {
      if (done) return;
      done = true;
      if (!capture) return;
      const endedAt = Date.now();
      endDecoder?.();
      // The decoder (compressed bodies) may still be flushing: wait for it, off the request path.
      const captured = decoderDone.then((): CapturedCall | undefined => {
        try {
          const call: CapturedCall = { route, method, path, upstream: target.origin, reqHeaders: req.headers, reqBytes, resBytes, stream, startedAt, endedAt };
          if (!reqOver && reqChunks.length) call.reqBody = Buffer.concat(reqChunks);
          if (status !== undefined) call.status = status;
          if (resHeaders) call.resHeaders = resHeaders;
          if (headersAt !== undefined) call.headersAt = headersAt;
          if (firstByteAt !== undefined) call.firstByteAt = firstByteAt;
          const r = result?.();
          if (r) call.result = r;
          if (extra.networkError) call.networkError = extra.networkError;
          if (extra.aborted) call.aborted = true;
          return call;
        } catch (err) {
          report(err);
          return undefined;
        }
      });
      recorder!.record(captured);
    };

    const mod = target.protocol === "https:" ? https : http;
    const upReq = mod.request(
      {
        protocol: target.protocol,
        hostname: target.hostname.replace(/^\[|\]$/g, ""),
        port: target.port || undefined,
        path: `${target.pathname}${target.search}`,
        method,
        headers: forwardHeaders(req, target, drop),
        agent: target.protocol === "https:" ? agents.https : agents.http,
      },
      (upRes) => {
        headersAt = Date.now();
        status = upRes.statusCode ?? 502;
        resHeaders = upRes.headers;
        stream = /text\/event-stream/i.test(String(upRes.headers["content-type"] ?? ""));
        res.writeHead(status, upRes.statusMessage ?? "", responseHeaders(upRes));
        res.flushHeaders();

        if (capture) {
          const decoder = decoderFor(upRes.headers["content-encoding"] as string | undefined);
          if (decoder !== null) {
            let sink: (chunk: Buffer, now: number) => void;
            if (stream) {
              const acc = accumulatorFor(route.api);
              const sse = new SseParser();
              sink = (chunk, now) => {
                if (!acc || sse.chars > max) return;
                for (const ev of sse.push(chunk)) acc.feed(ev, now);
              };
              result = () => {
                if (!acc) return undefined;
                const now = Date.now();
                for (const ev of sse.end()) acc.feed(ev, now);
                return acc.result();
              };
            } else {
              const chunks: Buffer[] = [];
              let size = 0;
              sink = (chunk) => {
                size += chunk.length;
                if (size <= max) chunks.push(chunk);
              };
              result = () => (size <= max ? parseJsonResponse(route.api, Buffer.concat(chunks).toString("utf8")) : undefined);
            }
            if (decoder) {
              decoder.on("data", (c: Buffer) => sink(c, Date.now()));
              decoderDone = new Promise<void>((resolve) => {
                decoder.on("end", resolve);
                decoder.on("error", () => {
                  result = undefined;
                  resolve();
                });
              });
              parse = (chunk) => void decoder.write(chunk);
              let ended = false;
              endDecoder = () => {
                if (ended) return;
                ended = true;
                decoder.end();
              };
            } else parse = sink;
          }
        }

        upRes.on("data", (chunk: Buffer) => {
          const now = Date.now();
          firstByteAt ??= now;
          resBytes += chunk.length;
          // Client first: the copy is parsed after the bytes are on their way.
          if (!res.write(chunk)) {
            upRes.pause();
            res.once("drain", () => upRes.resume());
          }
          if (parse) {
            try {
              parse(chunk, now);
            } catch (err) {
              parse = undefined;
              result = undefined;
              report(err);
            }
          }
        });
        upRes.on("end", () => {
          res.end();
          finish();
        });
        upRes.on("aborted", () => {
          res.destroy();
          finish({ networkError: "upstream closed the response early" });
        });
        upRes.on("error", (err) => {
          res.destroy();
          finish({ networkError: err.message });
        });
      },
    );
    upReq.setNoDelay(true);
    upReq.on("error", (err) => {
      const msg = `${(err as NodeJS.ErrnoException).code ?? "error"}: ${err.message}`;
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" }).end(jsonError(502, `coding.sh proxy: upstream ${target.origin} unreachable (${msg})`));
      } else res.destroy();
      finish(done ? {} : { networkError: msg });
    });
    // The client went away (Esc in the agent): stop the upstream call too.
    res.on("close", () => {
      if (res.writableFinished) return;
      upReq.destroy();
      finish({ aborted: true });
    });
    req.on("error", () => upReq.destroy());
    req.pipe(upReq);
  };
}

export interface ProxyServerOptions extends ProxyHandlerOptions {
  /** Default 127.0.0.1. Non-loopback hosts need allowRemote. */
  host?: string;
  /** Default 4320; 0 picks a free port. */
  port?: number;
}

export interface ProxyServer {
  readonly host: string;
  readonly port: number;
  /** Base URL, e.g. http://127.0.0.1:4320 (what ANTHROPIC_BASE_URL should be). */
  readonly url: string;
  readonly server: http.Server;
  /** Stops accepting connections, waits for in-flight calls and their writes. */
  close(): Promise<void>;
}

export async function startProxy(o: ProxyServerOptions = {}): Promise<ProxyServer> {
  const host = o.host ?? "127.0.0.1";
  if (!o.allowRemote && !isLoopbackHost(host)) throw new Error(`refusing to listen on ${host}: the proxy forwards credentials; bind a loopback address or pass allowRemote`);
  const handler = createProxyHandler(o);
  const server = http.createServer({ noDelay: true }, (req, res) => handler(req, res));
  // WebSocket upgrades (Codex's Responses-over-WebSocket) are not proxied: clients fall back to HTTP.
  server.on("upgrade", (_req, socket: Socket) => {
    socket.end("HTTP/1.1 501 Not Implemented\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  server.on("clientError", (_err, socket: Socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port ?? DEFAULT_PROXY_PORT, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : (o.port ?? DEFAULT_PROXY_PORT);
  const urlHost = host.includes(":") ? `[${host}]` : host;
  return {
    host,
    port,
    url: `http://${urlHost}:${port}`,
    server,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
      });
      await o.recorder?.flush();
    },
  };
}
