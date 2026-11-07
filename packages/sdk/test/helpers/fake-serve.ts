// A local stand-in for `coding.sh serve` (docs/PRODUCTION.md §1–§2), enough to
// test the SDK end to end: POST /v1/ingest (native events) and POST /v1/traces
// (OTLP JSON, mapped by the core package's real OTLP mapper). Events are kept
// in memory, de-duplicated by id, and folded into sessions with the core
// package's buildSession, so tests see the same Session.stats the server would.
import { gunzipSync } from "node:zlib";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentEvent, Session } from "../../../coding.sh/src/schema/index.ts";
import { parseNativeBatch } from "../../../coding.sh/src/server/native.ts";
import { decodeTraceJson } from "../../../coding.sh/src/otel/json.ts";
import { decodeTraceRequest, encodeExportResponse } from "../../../coding.sh/src/otel/proto.ts";
import { mapTraces, SpanTree, TraceSessionMap } from "../../../coding.sh/src/otel/map.ts";
import { buildSession } from "../../../coding.sh/src/core/sessions.ts";

export interface ReceivedRequest {
  path: string;
  headers: IncomingMessage["headers"];
  gzip: boolean;
  body: unknown;
  status: number;
}

export interface FakeServe {
  url: string;
  requests: ReceivedRequest[];
  /** Events the real server parser rejected (should stay empty). */
  rejected: { index: number; error: string }[];
  /** Answer the next requests with these statuses (then 200 again). */
  plan(...responses: { status: number; retryAfter?: string }[]): void;
  events(): AgentEvent[];
  sessions(): Map<string, Session>;
  session(id: string): Session | undefined;
  close(): Promise<void>;
}

/** Ingest keys → project, as in CODING_SH_INGEST_KEYS. No keys: open, project "default". */
export async function startFakeServe(opts: { keys?: Record<string, string> } = {}): Promise<FakeServe> {
  const requests: ReceivedRequest[] = [];
  const rejectedEvents: { index: number; error: string }[] = [];
  const store = new Map<string, AgentEvent>();
  const planned: { status: number; retryAfter?: string }[] = [];
  const traceSessions = new TraceSessionMap();
  const spanTree = new SpanTree();

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(text);
  };

  const server = createServer(async (req, res) => {
    const path = (req.url ?? "").split("?")[0]!;
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let raw = Buffer.concat(chunks);
    const gzip = req.headers["content-encoding"] === "gzip";
    const rec: ReceivedRequest = { path, headers: req.headers, gzip, body: undefined, status: 0 };
    requests.push(rec);
    const proto = String(req.headers["content-type"] ?? "").includes("protobuf");
    try {
      if (gzip) raw = gunzipSync(raw);
      rec.body = proto ? decodeTraceRequest(raw) : JSON.parse(raw.toString("utf8"));
    } catch {
      rec.status = 400;
      return send(res, 400, { error: "invalid body" });
    }
    const next = planned.shift();
    if (next) {
      rec.status = next.status;
      return send(res, next.status, { error: "planned" }, next.retryAfter !== undefined ? { "retry-after": next.retryAfter } : {});
    }
    let project = "default";
    if (opts.keys) {
      const m = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""));
      const p = m ? opts.keys[m[1]!] : undefined;
      if (!p) {
        rec.status = 401;
        return send(res, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
      }
      project = p;
    }
    const scope = (id: string) => (project === "default" ? id : `${project}/${id}`);

    if (path === "/v1/ingest") {
      // The real server's envelope parser and per-event validation (src/server/native.ts).
      let batch: ReturnType<typeof parseNativeBatch>;
      try {
        batch = parseNativeBatch(rec.body, project);
      } catch (err) {
        rec.status = 400;
        return send(res, 400, { error: String((err as Error).message) });
      }
      let inserted = 0;
      for (const e of batch.events) {
        const ev: AgentEvent = { ...e, sessionId: scope(e.sessionId) };
        if (!store.has(ev.id)) inserted++;
        store.set(ev.id, ev);
      }
      if (batch.rejected.length) rejectedEvents.push(...batch.rejected);
      rec.status = 200;
      return send(res, 200, { accepted: batch.events.length, inserted, rejected: batch.rejected });
    }
    if (path === "/v1/traces") {
      const result = await mapTraces(proto ? (rec.body as ReturnType<typeof decodeTraceRequest>) : decodeTraceJson(rec.body), { maxInlineBytes: 1 << 20, blob: async () => "0".repeat(64), keepRaw: false, traceSessions, spanTree });
      for (const e of result.events) store.set(e.id, { ...e, sessionId: scope(e.sessionId) });
      rec.status = 200;
      if (proto) {
        res.writeHead(200, { "content-type": "application/x-protobuf" });
        return res.end(encodeExportResponse(result.rejected, result.errors.join("; ")));
      }
      return send(res, 200, result.rejected ? { partialSuccess: { rejectedSpans: result.rejected, errorMessage: result.errors.join("; ") } } : {});
    }
    rec.status = 404;
    send(res, 404, { error: "not found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;

  const sessions = () => {
    const by = new Map<string, AgentEvent[]>();
    for (const e of store.values()) {
      const list = by.get(e.sessionId) ?? [];
      list.push(e);
      by.set(e.sessionId, list);
    }
    return new Map([...by].map(([id, evs]) => [id, buildSession(evs)]));
  };
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    rejected: rejectedEvents,
    plan: (...r) => planned.push(...r),
    events: () => [...store.values()],
    sessions,
    session: (id) => sessions().get(id),
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** Polls until fn() is truthy (or throws after timeoutMs). */
export async function waitFor<T>(fn: () => T | undefined | false, timeoutMs = 3000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
