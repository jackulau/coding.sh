// HTTP API tap (§2.3, §5.3): a local reverse proxy in front of the API. The
// agent gets its URL (e.g. BILLING_URL); each request becomes one TapRecord
// with method, path template (matched against the OpenAPI paths when given),
// status, latency and bytes. Auth is injected from env so the agent never
// handles the token.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { HttpTarget, TapClass, TapRecord, Variant } from "../types.ts";
import { tapWriter } from "./mcp-proxy.ts";

export interface PathMatcher {
  match(path: string): string | undefined;
  readonly size: number;
}

/** Matches concrete paths against OpenAPI templates (`/users/{id}`), most specific first. */
export function pathMatcher(templates: readonly string[]): PathMatcher {
  const compiled = templates
    .map((t) => ({
      t,
      re: new RegExp("^" + t.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{[^}]+\}/g, "[^/]+") + "/?$"),
      literal: t.replace(/\{[^}]+\}/g, "").length,
    }))
    .sort((a, b) => b.literal - a.literal);
  return {
    size: compiled.length,
    match(path) {
      return compiled.find((c) => c.re.test(path))?.t;
    },
  };
}

/** OpenAPI paths from a parsed document. */
export function openapiPaths(doc: unknown): string[] {
  if (typeof doc !== "object" || doc === null) return [];
  const p = (doc as { paths?: unknown }).paths;
  return typeof p === "object" && p !== null ? Object.keys(p) : [];
}

const DOC_PATH = /^\/(docs?|reference|openapi|swagger)(\/|\.|$)|openapi\.(json|ya?ml)$|swagger\.(json|ya?ml)$/i;

export function classifyHttp(method: string, path: string, status: number, template: string | undefined, hasTemplates: boolean): { class: TapClass; reason?: string } {
  const m = method.toUpperCase();
  if (m === "OPTIONS") return { class: "meta" };
  if (m === "GET" && DOC_PATH.test(path) && status < 400) return { class: "help" };
  if ([400, 405, 415, 422].includes(status)) return { class: "invalid", reason: "http-4xx" };
  if (status === 404) return hasTemplates && template === undefined ? { class: "invalid", reason: "http-4xx" } : { class: "failed", reason: "http-404" };
  if (status >= 500 || status === 401 || status === 403) return { class: "failed", reason: `http-${status}` };
  if (status >= 400) return { class: "failed", reason: `http-${status}` };
  return { class: "ok" };
}

export interface HttpTapHandle {
  url: string;
  close(): Promise<void>;
}

export async function startHttpTap(o: {
  target: HttpTarget;
  variant: Variant;
  tapLog: string;
  templates?: string[];
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
}): Promise<HttpTapHandle> {
  const base = (o.variant.url ?? o.target.baseUrl).replace(/\/$/, "");
  const record = tapWriter(o.tapLog);
  const matcher = pathMatcher(o.templates ?? []);
  const env = o.env ?? process.env;
  const doFetch = o.fetch ?? fetch;
  const server = createServer((req, res) => void handle(req, res));
  const SKIP = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive"]);
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ts = Date.now();
    const t0 = performance.now();
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://x");
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && !SKIP.has(k)) headers[k] = v;
    if (o.target.auth) {
      const token = env[o.target.auth.env];
      if (token) headers[o.target.auth.header] = o.target.auth.header.toLowerCase() === "authorization" && !/^\w+ /.test(token) ? `Bearer ${token}` : token;
    }
    let status = 502;
    let out: Buffer = Buffer.alloc(0);
    try {
      const r = await doFetch(base + url.pathname + url.search, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : body, redirect: "manual" });
      status = r.status;
      out = Buffer.from(await r.arrayBuffer());
      const h: Record<string, string> = {};
      r.headers.forEach((v, k) => {
        if (!SKIP.has(k) && k !== "content-encoding") h[k] = v;
      });
      res.writeHead(status, h);
      res.end(out);
    } catch (e) {
      out = Buffer.from(`tap proxy: ${e instanceof Error ? e.message : String(e)}`);
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(out);
    }
    const template = matcher.match(url.pathname);
    const c = classifyHttp(method, url.pathname, status, template, matcher.size > 0);
    const rec: TapRecord = {
      ts,
      durationMs: Math.round((performance.now() - t0) * 1000) / 1000,
      target: "http",
      class: c.class,
      httpMethod: method,
      pathTemplate: template ?? url.pathname,
      status,
      requestBytes: body.length,
      responseBytes: out.length,
    };
    if (c.reason) rec.reason = c.reason;
    record(rec);
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
