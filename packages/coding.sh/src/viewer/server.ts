// Local web viewer served by `coding.sh ui`.
//
// Security model: the server binds loopback only, every request must carry a
// random per-process token (cookie set from the printed ?t= URL, or a Bearer
// header), the Host header must name the loopback address we bound
// (DNS-rebinding defense), and the page runs under a strict nonce CSP with no
// external origins. Captured prompts and tool output are untrusted: the API
// only ever returns them as JSON or text/plain (sandboxed, nosniff), and the
// client renders them with textContent.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { userInfo } from "node:os";
import { benchHome, loadDefinition, NAME_RE } from "../bench/define.ts";
import { buildReport } from "../bench/report.ts";
import { historyRuns, listRuns } from "../bench/store.ts";
import type { BenchRun } from "../bench/types.ts";
import type { IngestStatus } from "../cli/ingest-worker.ts";
import type { BlobStore, IndexStore, Label, Session, SessionFilter } from "../core/types.ts";
import type { ExperimentResult } from "../datasets/types.ts";
import { compareExperiments } from "../experiments/compare.ts";
import { getUpdateStatus, type UpdateStatus } from "../update/index.ts";

export interface ViewerOptions {
  index: IndexStore;
  blobs: BlobStore;
  /** First port to try; the next 10 are tried when it is busy. 0 = any free port. */
  port?: number;
  /** Interface to bind. Loopback by default; anything else is an explicit opt-in. */
  host?: string;
  /** Open the URL in the default browser once listening. */
  open?: boolean;
  /** Fixed token (tests). Default: 32 random bytes, base64url. */
  token?: string;
  /** Extra Host header values (host:port) to accept when binding a non-loopback interface. */
  allowedHosts?: string[];
  /** Environment for the update check behind /api/update (default: process.env). */
  env?: NodeJS.ProcessEnv;
  /** Update status source (tests). Default: getUpdateStatus(env), which checks at most once per 24 h. */
  updateStatus?: () => Promise<UpdateStatus>;
  /** Where dataset experiments live (`coding.sh exp run`). Default: the index, when it stores them. */
  experiments?: ExperimentSource;
  /** Benchmark run records behind /api/benchmarks. Default: `coding.sh bench`'s folder under env's data dir. */
  benchmarks?: BenchmarkSource;
  /** Background ingest progress behind /api/ingest (`coding.sh ui`). Without it the route is 404. */
  ingestStatus?: () => IngestStatus | undefined;
}

/** Read side of the dataset experiment store (FileEvalStore and every full IndexStore fit). */
export interface ExperimentSource {
  listExperiments(filter?: { datasetId?: string; name?: string; limit?: number }): Promise<ExperimentResult[]>;
  getExperiment(id: string): Promise<ExperimentResult | undefined>;
}

/** Read side of `coding.sh bench`: run records per benchmark name. */
export interface BenchmarkSource {
  /** Benchmark names that have a runs folder. */
  names(): Promise<string[]>;
  /** Every run record, oldest first (store.listRuns). */
  runs(name: string): Promise<BenchRun[]>;
  /** The definition's reference contender, when its file can still be read. */
  reference?(name: string, latest: BenchRun): string | undefined;
}

/** Benchmarks under `<data>/benchmarks/<name>/runs`, as `coding.sh bench run` writes them. */
export function benchmarkDir(env: NodeJS.ProcessEnv = process.env): BenchmarkSource {
  return {
    async names() {
      try {
        const dirs = await readdir(benchHome(env), { withFileTypes: true });
        return dirs.filter((d) => d.isDirectory() && NAME_RE.test(d.name) && existsSync(`${benchHome(env)}/${d.name}/runs`)).map((d) => d.name).sort();
      } catch {
        return [];
      }
    },
    runs: (name) => listRuns(name, env),
    reference(name, latest) {
      // The file the run was defined in, else the user-level definition.
      for (const file of [latest.definition.file, `${benchHome(env)}/${name}.toml`]) {
        if (!file || !file.endsWith(".toml") || !existsSync(file)) continue;
        try {
          return loadDefinition(file).reference;
        } catch {
          return undefined;
        }
      }
      return undefined;
    },
  };
}

export interface Viewer {
  /** URL including the token, e.g. http://127.0.0.1:4747/?t=… */
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

export const BLOB_CAP_BYTES = 2 * 1024 * 1024;
export const MAX_BODY_BYTES = 1024 * 1024;
const PORT_ATTEMPTS = 11; // the requested port + the next 10
const SHA_RE = /^[0-9a-f]{64}$/;
// Serve namespaces ids as `<project>/<sessionId>` (project ≤ 63 chars).
const MAX_ID_LEN = 320;
const STATS_SCAN_CAP = 100_000;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------- page

let pageCache: string | undefined;

/** The bundled build inlines index.html (esbuild `.html: text`); from source we read it from disk. */
async function loadPage(): Promise<string> {
  if (pageCache !== undefined) return pageCache;
  try {
    const mod = (await import("./ui/index.html")) as { default: string };
    pageCache = mod.default;
  } catch {
    pageCache = readFileSync(new URL("./ui/index.html", import.meta.url), "utf8");
  }
  return pageCache;
}

function pageCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

// ---------------------------------------------------------------- server

/** Who is asking, as decided by `authorize`. */
export interface ViewerAccess {
  /** Only this project's sessions are visible (a project-scoped read key). Unset: every project. */
  project?: string;
  /** Name recorded on labels this caller creates (default: the OS user). */
  by?: string;
}

export interface ViewerHandlerOptions {
  index: IndexStore;
  blobs: BlobStore;
  /** Access for a request, or undefined (401). Called for the page and every /api route. */
  authorize: (req: IncomingMessage) => ViewerAccess | undefined | Promise<ViewerAccess | undefined>;
  /** Host header check (DNS-rebinding defense); also checks Origin on POSTs. Lower-cased host:port. */
  checkHost: (host: string) => boolean;
  /**
   * `/?t=<token>`: returns the Set-Cookie value that replaces the URL token, or
   * undefined when the token is wrong. Without it, `?t=` is ignored.
   */
  exchangeToken?: (token: string, req: IncomingMessage) => string | undefined;
  /** Ask browsers for Basic credentials on a 401 page (serve with basic auth). */
  basicRealm?: string;
  /** Text of the 401 page. */
  unauthorizedText?: string;
  /** Project ids for GET /api/projects (default: scanned from sessions). */
  projects?: () => Promise<string[]> | string[];
  /** Update status behind /api/update. */
  updateStatus: () => Promise<UpdateStatus>;
  /** Dataset experiments behind /api/experiments. Default: the index, when it stores them; else none. */
  experiments?: ExperimentSource;
  /** Benchmarks behind /api/benchmarks. Default: none. */
  benchmarks?: BenchmarkSource;
  /** Background ingest progress behind /api/ingest. Default: none (404). */
  ingestStatus?: () => IngestStatus | undefined;
}

export type ViewerHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/** The viewer page and /api routes as a request handler (used by `coding.sh ui` and `coding.sh serve`). Never throws. */
export async function createViewerHandler(opts: ViewerHandlerOptions): Promise<ViewerHandler> {
  const page = await loadPage();
  const labeller = currentUser();
  const experiments = opts.experiments ?? indexExperiments(opts.index);

  const unauthorizedPage = (res: ServerResponse) => sendUnauthorizedPage(res, opts.unauthorizedText, opts.basicRealm);

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    setBaseHeaders(res);
    const hostHeader = (req.headers.host ?? "").toLowerCase();
    if (!opts.checkHost(hostHeader)) throw new HttpError(403, "forbidden host");

    const url = new URL(req.url ?? "/", "http://viewer.invalid");
    const path = url.pathname;

    if (path === "/" || path === "/index.html") {
      if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method not allowed");
      const t = url.searchParams.get("t");
      if (t !== null && opts.exchangeToken) {
        const cookie = opts.exchangeToken(t, req);
        if (!cookie) return unauthorizedPage(res);
        // Trade the URL token for a cookie, then drop it from the address bar.
        res.setHeader("Set-Cookie", cookie);
        res.writeHead(302, { Location: "/", "Cache-Control": "no-store" });
        res.end();
        return;
      }
      if (!(await opts.authorize(req))) return unauthorizedPage(res);
      const nonce = randomBytes(16).toString("base64");
      const body = page.replaceAll("__CSP_NONCE__", nonce);
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": pageCsp(nonce),
        "Cache-Control": "no-store",
      });
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }

    if (!path.startsWith("/api/")) throw new HttpError(404, "not found");
    const access = await opts.authorize(req);
    if (!access) {
      if (opts.basicRealm) res.setHeader("WWW-Authenticate", `Basic realm="${opts.basicRealm}", charset="UTF-8"`);
      throw new HttpError(401, "missing or invalid token");
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox; frame-ancestors 'none'");
    await routeApi(req, res, url, {
      index: opts.index,
      blobs: opts.blobs,
      labeller: access.by ?? labeller,
      checkHost: opts.checkHost,
      updateStatus: opts.updateStatus,
      project: access.project,
      projects: opts.projects,
      experiments,
      benchmarks: opts.benchmarks,
      ingestStatus: opts.ingestStatus,
    });
  };

  return (req, res) =>
    handle(req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof HttpError ? err.message : "internal error";
      if (status === 500) process.emitWarning(`coding.sh viewer: ${(err as Error)?.stack ?? String(err)}`);
      sendJson(res, status, { error: message, status });
    });
}

export async function startViewer(opts: ViewerOptions): Promise<Viewer> {
  const host = opts.host ?? "127.0.0.1";
  const token = opts.token ?? randomBytes(32).toString("base64url");
  const tokenBuf = Buffer.from(token);
  const startPort = opts.port ?? 4747;
  let boundPort = 0;
  let cookieName = "csh_t";
  const updateStatus = opts.updateStatus ?? (() => getUpdateStatus(opts.env ?? process.env));

  const allowedHosts = (): Set<string> => {
    const names = ["127.0.0.1", "localhost", "[::1]"];
    if (!isWildcard(host)) names.push(host.includes(":") && !host.startsWith("[") ? `[${host}]` : host);
    const set = new Set(names.map((n) => `${n}:${boundPort}`.toLowerCase()));
    for (const h of opts.allowedHosts ?? []) set.add(h.toLowerCase());
    return set;
  };
  let hostSet = new Set<string>();

  const tokenOk = (candidate: string | undefined): boolean => {
    if (!candidate) return false;
    const b = Buffer.from(candidate);
    return b.length === tokenBuf.length && timingSafeEqual(b, tokenBuf);
  };

  const handle = await createViewerHandler({
    index: opts.index,
    blobs: opts.blobs,
    checkHost: (h) => hostSet.has(h),
    authorize(req) {
      const auth = req.headers.authorization;
      if (auth?.startsWith("Bearer ") && tokenOk(auth.slice(7).trim())) return {};
      return tokenOk(readCookie(req.headers.cookie, cookieName)) ? {} : undefined;
    },
    exchangeToken: (t) => (tokenOk(t) ? `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/` : undefined),
    updateStatus,
    ...(opts.experiments ? { experiments: opts.experiments } : {}),
    benchmarks: opts.benchmarks ?? benchmarkDir(opts.env ?? process.env),
    ...(opts.ingestStatus ? { ingestStatus: opts.ingestStatus } : {}),
  });

  const server = createServer((req, res) => {
    void handle(req, res);
  });
  server.headersTimeout = 20_000;
  server.requestTimeout = 60_000;

  boundPort = await listen(server, startPort, host);
  cookieName = `csh_t_${boundPort}`; // cookies ignore ports; keep two viewers from clobbering each other
  hostSet = allowedHosts();

  const urlHost = isWildcard(host) ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
  const viewerUrl = `http://${urlHost}:${boundPort}/?t=${encodeURIComponent(token)}`;
  if (opts.open) openBrowser(viewerUrl);

  let closed: Promise<void> | undefined;
  return {
    url: viewerUrl,
    port: boundPort,
    token,
    close() {
      closed ??= new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      });
      return closed;
    },
  };
}

function isWildcard(host: string): boolean {
  return host === "0.0.0.0" || host === "::" || host === "";
}

async function listen(server: Server, startPort: number, host: string): Promise<number> {
  const attempts = startPort === 0 ? 1 : PORT_ATTEMPTS;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const port = startPort === 0 ? 0 : startPort + i;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          server.off("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
      return (server.address() as AddressInfo).port;
    } catch (err) {
      lastErr = err;
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
    }
  }
  throw new Error(`coding.sh viewer: ports ${startPort}-${startPort + attempts - 1} are all in use`, {
    cause: lastErr,
  });
}

function openBrowser(url: string): void {
  void import("node:child_process").then(({ spawn }) => {
    const [cmd, args] =
      process.platform === "darwin"
        ? ["open", [url]]
        : process.platform === "win32"
          ? ["cmd", ["/c", "start", "", url]]
          : ["xdg-open", [url]];
    try {
      const child = spawn(cmd, args, { stdio: "ignore", detached: true });
      child.on("error", () => {});
      child.unref();
    } catch {
      // Opening a browser is a convenience; the URL is printed regardless.
    }
  });
}

function currentUser(): string {
  try {
    return userInfo().username || "local";
  } catch {
    return "local";
  }
}

// ---------------------------------------------------------------- api

interface ApiCtx {
  index: IndexStore;
  blobs: BlobStore;
  labeller: string;
  checkHost: (host: string) => boolean;
  updateStatus: () => Promise<UpdateStatus>;
  /** Scoped caller: only this project is visible. */
  project?: string;
  projects?: () => Promise<string[]> | string[];
  experiments?: ExperimentSource;
  benchmarks?: BenchmarkSource;
  ingestStatus?: () => IngestStatus | undefined;
}

/** The index's own experiment methods (sqlite, memory, postgres), or undefined when it has none. */
function indexExperiments(index: IndexStore): ExperimentSource | undefined {
  if (!index.listExperiments || !index.getExperiment) return undefined;
  return { listExperiments: (f) => index.listExperiments!(f), getExperiment: (id) => index.getExperiment!(id) };
}

const projectOf = (s: Session): string => s.project ?? "default";

/** The session, or a 404 when it is missing or outside the caller's project. */
async function visibleSession(ctx: ApiCtx, id: string): Promise<Session> {
  const session = await ctx.index.getSession(id);
  if (!session || (ctx.project !== undefined && projectOf(session) !== ctx.project)) throw new HttpError(404, "session not found");
  return session;
}

/** Project filter for lists: a scoped caller's project, else `?project=`. */
function projectParam(ctx: ApiCtx, q: URLSearchParams): string | undefined {
  if (ctx.project !== undefined) return ctx.project;
  const p = q.get("project") || undefined;
  if (p !== undefined && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(p)) throw new HttpError(400, "invalid project");
  return p;
}

// ---------------------------------------------------------------- benchmarks

const BENCH_TREND = 30;

function headlineRun(runs: readonly BenchRun[]): BenchRun {
  return historyRuns(runs).at(-1) ?? runs.filter((r) => (r.status ?? "complete") === "complete").at(-1) ?? runs.at(-1)!;
}

function referenceOf(src: BenchmarkSource, name: string, latest: BenchRun): string {
  const ref = src.reference?.(name, latest);
  return ref && latest.contenders.some((c) => c.name === ref) ? ref : latest.contenders[0]?.name ?? "";
}

/** One card on the Benchmarks page: the latest leaderboard and a short pass-rate trend per contender. */
function benchmarkSummary(name: string, runs: readonly BenchRun[], src: BenchmarkSource) {
  const latest = headlineRun(runs);
  const counted = historyRuns(runs);
  const recent = counted.slice(-BENCH_TREND);
  const models = new Map(latest.contenders.map((c) => [c.name, c.model]));
  return {
    name,
    ...(latest.description ? { description: latest.description } : {}),
    counted: counted.length,
    total: runs.length,
    reference: referenceOf(src, name, latest),
    latest: { id: latest.id, date: latest.date, cases: latest.cases.filter((c) => !c.anchor).length, mode: latest.mode ?? "scheduled", status: latest.status ?? "complete", dataset: `${latest.dataset.id}@${latest.dataset.version}` },
    contenders: [...latest.summaries]
      .sort((a, b) => a.place - b.place || b.passRate.p - a.passRate.p)
      .map((s) => ({ name: s.contender, ...(models.get(s.contender) ? { model: models.get(s.contender) } : {}), place: s.place, n: s.n, passed: s.passed, passRate: s.passRate })),
    trend: Object.fromEntries(latest.contenders.map((c) => [c.name, recent.map((r) => r.summaries.find((x) => x.contender === c.name)?.passRate.p ?? null)])),
  };
}

/**
 * The full report for one benchmark (bench/report.ts), as the local viewer
 * shows it: case text and outputs included (this is the owner's own machine),
 * the frozen case list left out, and each failure marked with whether its
 * session is in the index so the page only links to sessions that open.
 */
async function benchmarkDetail(ctx: ApiCtx, runs: readonly BenchRun[], src: BenchmarkSource) {
  const latest = headlineRun(runs);
  const report = buildReport(runs, { includePrivate: true, reference: referenceOf(src, latest.bench, latest), worst: 25, viewerUrl: "" });
  const { cases: _cases, failures, ...rest } = report;
  const known = new Map<string, boolean>();
  const out: Record<string, unknown[]> = {};
  for (const [name, rows] of Object.entries(failures)) {
    out[name] = [];
    for (const { sessionUrl: _u, ...row } of rows) {
      let has = false;
      if (row.sessionId && /^[\w.:-]{1,200}$/.test(row.sessionId)) {
        if (!known.has(row.sessionId)) known.set(row.sessionId, !!(await ctx.index.getSession(row.sessionId).catch(() => undefined)));
        has = known.get(row.sessionId)!;
      }
      out[name]!.push({ ...row, hasSession: has });
    }
  }
  return { ...rest, failures: out };
}

async function routeApi(req: IncomingMessage, res: ServerResponse, url: URL, ctx: ApiCtx): Promise<void> {
  const parts = url.pathname
    .slice("/api/".length)
    .split("/")
    .map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        throw new HttpError(400, "malformed path");
      }
    });
  const q = url.searchParams;
  const method = req.method ?? "GET";
  const get = () => {
    if (method !== "GET") throw new HttpError(405, "method not allowed");
  };
  const [head, id, sub, ...rest] = parts;
  // Session ids may hold "/" (`team/chat-1`); the viewer encodes them, and a raw "/" is not guessed at.
  const notFound = () => new HttpError(404, head === "sessions" ? 'not found (percent-encode "/" in a session id: /api/sessions/team%2Fchat-1)' : "not found");
  if (rest.length > 0) throw notFound();

  switch (head) {
    case "sessions": {
      get();
      if (id === undefined || (id === "" && sub === undefined)) return sendJson(res, 200, await listSessions(ctx.index, q, projectParam(ctx, q)));
      const sessionId = checkId(id, "session id");
      if (sub === undefined) return sendJson(res, 200, await visibleSession(ctx, sessionId));
      if (sub === "events") {
        await visibleSession(ctx, sessionId);
        const limit = intParam(q, "limit", 5000, 1, 20_000);
        const offset = intParam(q, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
        const kinds = q.get("kinds")?.split(",").filter(Boolean);
        const events = await ctx.index.listEvents(sessionId, { limit: limit + 1, offset, kinds });
        return sendJson(res, 200, page(events, limit, offset));
      }
      throw notFound();
    }

    case "blobs": {
      get();
      if (id === undefined || sub !== undefined) throw new HttpError(404, "not found");
      if (!SHA_RE.test(id)) throw new HttpError(400, "blob ref must be 64 lowercase hex chars");
      const data = await ctx.blobs.get(id);
      if (!data) throw new HttpError(404, "blob not found");
      const full = q.get("full") === "1";
      const truncated = !full && data.byteLength > BLOB_CAP_BYTES;
      const body = truncated ? data.subarray(0, BLOB_CAP_BYTES) : data;
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": body.byteLength,
        "Content-Disposition": "inline",
        "X-Blob-Size": data.byteLength,
        "X-Truncated": truncated ? "1" : "0",
      });
      res.end(body);
      return;
    }

    case "search": {
      get();
      if (id !== undefined) throw new HttpError(404, "not found");
      const text = (q.get("q") ?? "").trim();
      if (!text) throw new HttpError(400, "q is required");
      if (text.length > 500) throw new HttpError(400, "q is too long");
      const limit = intParam(q, "limit", 50, 1, 500);
      const agent = q.get("agent") || undefined;
      const project = projectParam(ctx, q);
      const f = facetParams(q);
      return sendJson(res, 200, { items: await searchSessions(ctx, text, limit, { ...f, agent, project, top: scopeParam(q) === "top" }) });
    }

    case "tasks": {
      get();
      if (id !== undefined) throw new HttpError(404, "not found");
      const status = q.get("status") || undefined;
      if (status !== undefined && status !== "draft" && status !== "validated" && status !== "archived") {
        throw new HttpError(400, "status must be draft, validated or archived");
      }
      const tag = q.get("tag") || undefined;
      // Eval assets belong to no project: a project-scoped key sees none.
      if (ctx.project !== undefined) return sendJson(res, 200, { items: [] });
      return sendJson(res, 200, { items: await ctx.index.listTasks({ status, tag }) });
    }

    case "runs": {
      get();
      if (id !== undefined) throw new HttpError(404, "not found");
      const filter = {
        experimentId: q.get("experimentId") || undefined,
        taskId: q.get("taskId") || undefined,
        bundleId: q.get("bundleId") || undefined,
      };
      if (ctx.project !== undefined) return sendJson(res, 200, { items: [] });
      return sendJson(res, 200, { items: await ctx.index.listRuns(filter) });
    }

    case "bundles": {
      get();
      if (id !== undefined) throw new HttpError(404, "not found");
      if (ctx.project !== undefined) return sendJson(res, 200, { items: [] });
      // Names and metadata only; overlay file contents stay behind /api/blobs.
      const items = (await ctx.index.listBundles()).map((b) => ({
        id: b.id,
        name: b.name,
        agent: b.agent,
        model: b.model,
        createdAt: b.createdAt,
        note: b.note,
      }));
      return sendJson(res, 200, { items });
    }

    case "experiments": {
      get();
      if (sub !== undefined) throw new HttpError(404, "not found");
      // Eval assets belong to no project: a project-scoped key sees none.
      const scoped = ctx.project !== undefined;
      if (id === undefined || id === "") {
        const limit = intParam(q, "limit", 50, 1, 500);
        const datasetId = q.get("dataset") || undefined;
        const name = q.get("name") || undefined;
        if (scoped || !ctx.experiments) return sendJson(res, 200, { items: [] });
        const rows = await ctx.experiments.listExperiments({ limit, ...(datasetId ? { datasetId } : {}), ...(name ? { name } : {}) });
        return sendJson(res, 200, { items: rows.map(experimentSummary) });
      }
      if (!EXPERIMENT_ID_RE.test(id) || id.includes("..")) throw new HttpError(400, "invalid experiment id");
      const exp = scoped || !ctx.experiments ? undefined : await ctx.experiments.getExperiment(id);
      if (!exp) throw new HttpError(404, "experiment not found");
      return sendJson(res, 200, experimentDetail(exp));
    }

    case "benchmarks": {
      get();
      if (sub !== undefined) throw new HttpError(404, "not found");
      // Benchmarks belong to no project: a project-scoped key sees none.
      const src = ctx.project !== undefined ? undefined : ctx.benchmarks;
      if (id === undefined || id === "") {
        if (!src) return sendJson(res, 200, { items: [] });
        const items = [];
        for (const name of await src.names()) {
          const runs = await src.runs(name);
          if (runs.length) items.push(benchmarkSummary(name, runs, src));
        }
        items.sort((a, b) => (a.latest.date < b.latest.date ? 1 : a.latest.date > b.latest.date ? -1 : a.name < b.name ? -1 : 1));
        return sendJson(res, 200, { items });
      }
      if (!NAME_RE.test(id)) throw new HttpError(400, "invalid benchmark name");
      const runs = src ? await src.runs(id) : [];
      if (!runs.length) throw new HttpError(404, "benchmark not found");
      return sendJson(res, 200, await benchmarkDetail(ctx, runs, src!));
    }

    case "compare": {
      get();
      if (id !== undefined) throw new HttpError(404, "not found");
      // Paired comparison of two dataset experiments: stats are computed here,
      // never in the page. a = baseline, b = candidate.
      const ids = [q.get("a") ?? "", q.get("b") ?? ""];
      for (const x of ids) if (!EXPERIMENT_ID_RE.test(x) || x.includes("..")) throw new HttpError(400, "a and b must be experiment ids");
      const [a, b] = ctx.project !== undefined || !ctx.experiments ? [] : await Promise.all(ids.map((x) => ctx.experiments!.getExperiment(x)));
      if (!a || !b) throw new HttpError(404, "experiment not found");
      // A cancelled side still compares (its cases are real), flagged as partial.
      const partial = [a, b].filter((x) => x.status === "cancelled").map((x) => x.id);
      return sendJson(res, 200, { ...compareExperiments(a, b, { iters: 4000, force: true }), partial });
    }

    case "labels": {
      if (id !== undefined) throw new HttpError(404, "not found");
      if (method === "GET") {
        const sessionId = q.get("sessionId") || undefined;
        const criterion = q.get("criterion") || undefined;
        if (sessionId !== undefined && ctx.project !== undefined) await visibleSession(ctx, checkId(sessionId, "sessionId"));
        let items = await ctx.index.listLabels({ sessionId, criterion });
        if (ctx.project !== undefined && sessionId === undefined) {
          const seen = new Map<string, boolean>();
          const visible = async (id: string) => {
            if (!seen.has(id)) {
              const s = await ctx.index.getSession(id);
              seen.set(id, !!s && projectOf(s) === ctx.project);
            }
            return seen.get(id)!;
          };
          const keep: Label[] = [];
          for (const l of items) if (l.sessionId && (await visible(l.sessionId))) keep.push(l);
          items = keep;
        }
        return sendJson(res, 200, { items });
      }
      if (method === "POST") {
        checkOrigin(req, ctx.checkHost);
        const body = await readJson(req, res);
        const label = await createLabel(ctx, body);
        return sendJson(res, 201, label);
      }
      throw new HttpError(405, "method not allowed");
    }

    case "update": {
      get();
      if (id !== undefined) throw new HttpError(404, "not found");
      // Release notes are remote text: the client only ever renders the version fields.
      const u = await ctx.updateStatus();
      return sendJson(res, 200, { current: u.current, latest: u.latest, updateAvailable: u.updateAvailable && u.disabled === null, url: u.url, command: u.command, checkedAt: u.checkedAt });
    }

    case "ingest": {
      get();
      if (id !== undefined) throw new HttpError(404, "not found");
      // `coding.sh serve` ingests over HTTP as events arrive, so it never has a backlog to report.
      return sendJson(res, 200, ctx.ingestStatus?.() ?? { ingesting: false, filesPending: 0, lastIngestAt: null });
    }

    case "stats": {
      get();
      if (id !== undefined) throw new HttpError(404, "not found");
      return sendJson(res, 200, await computeStats(ctx.index, scopeParam(q) === "top", projectParam(ctx, q), facetParams(q)));
    }

    case "projects": {
      get();
      if (id !== undefined) throw new HttpError(404, "not found");
      if (ctx.project !== undefined) return sendJson(res, 200, { items: [ctx.project] });
      const ids = new Set<string>(ctx.projects ? await ctx.projects() : []);
      if (!ctx.projects) for await (const s of scanSessions(ctx.index)) ids.add(projectOf(s));
      ids.add("default");
      return sendJson(res, 200, { items: [...ids].sort() });
    }

    default:
      throw new HttpError(404, "not found");
  }
}

const EXPERIMENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,199}$/;
const MAX_EXPERIMENT_RUNS = 5000;
const MAX_OUTPUT_CHARS = 4000;

/** List row: everything but the per-case runs, which can be large. */
function experimentSummary(e: ExperimentResult) {
  const { runs, ...rest } = e;
  return { ...rest, runCount: runs.length };
}

/** Detail: the summary plus case runs, capped, with long outputs clipped to a preview. */
function experimentDetail(e: ExperimentResult) {
  const runs = e.runs.slice(0, MAX_EXPERIMENT_RUNS).map((r) => {
    if (r.output === undefined) return r;
    const text = typeof r.output === "string" ? r.output : JSON.stringify(r.output) ?? "";
    return text.length > MAX_OUTPUT_CHARS ? { ...r, output: text.slice(0, MAX_OUTPUT_CHARS), outputTruncated: true } : r;
  });
  return { ...experimentSummary(e), runs, runsTruncated: e.runs.length > runs.length };
}

function page<T>(rows: T[], limit: number, offset: number) {
  const hasMore = rows.length > limit;
  return { items: hasMore ? rows.slice(0, limit) : rows, limit, offset, hasMore };
}

/** `scope=top` limits sessions (and stats facets) to top-level sessions; anything else, or none, means all. */
function scopeParam(q: URLSearchParams): "top" | "all" {
  const scope = q.get("scope") || "all";
  if (scope !== "top" && scope !== "all") throw new HttpError(400, "scope must be top or all");
  return scope;
}

/** Every list row carries `childCount`: how many subagent sessions name it as their parent. */
async function withChildCounts(index: IndexStore, rows: Session[], project?: string): Promise<(Session & { childCount: number })[]> {
  return Promise.all(
    rows.map(async (s) => ({ ...s, childCount: (await index.listSessions({ parentSessionId: s.id, limit: 10_000, ...(project ? { project } : {}) })).length })),
  );
}

/**
 * Full-text hits, narrowed to sessions that pass the list's filters. The index
 * filters by agent and project; flag, repo and scope live on the session row, so
 * hits are over-fetched and checked against their session.
 */
async function searchSessions(
  ctx: ApiCtx,
  text: string,
  limit: number,
  f: Facets & { project?: string; top: boolean },
) {
  const base = { agent: f.agent, ...(f.project ? { project: f.project } : {}) };
  if (!f.flag && !f.repo && !f.model && !f.top && f.since === undefined && f.until === undefined) return ctx.index.search(text, { limit, ...base });
  const hits = await ctx.index.search(text, { limit: Math.min(2000, limit * 8), ...base });
  const ok = new Map<string, boolean>();
  const out: typeof hits = [];
  for (const h of hits) {
    const id = h.event.sessionId;
    if (!ok.has(id)) {
      const s = await ctx.index.getSession(id);
      ok.set(id, !!s && matchesFacets(s, f) && (!f.top || !s.parent));
    }
    if (ok.get(id)) out.push(h);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Keyset cursor over the list order (started_at DESC, id ASC): "<startedAt>:<id>"
 * of the last row shown. Unlike an offset, sessions ingested between two pages
 * neither repeat nor push rows off the next page.
 */
interface Cursor {
  startedAt: number;
  id: string;
}
function parseCursor(raw: string | null): Cursor | undefined {
  if (raw === null || raw === "") return undefined;
  const m = /^(\d{1,16}):(.+)$/.exec(raw);
  if (!m) throw new HttpError(400, "cursor is malformed");
  return { startedAt: Number(m[1]), id: checkId(m[2]!, "cursor") };
}
const cursorOf = (s: Session) => `${Math.round(s.startedAt)}:${s.id}`;
const afterCursor = (s: Session, c: Cursor) => s.startedAt < c.startedAt || (s.startedAt === c.startedAt && s.id > c.id);

/** One page after the cursor, using only the portable since/until filters. */
async function pageAfter(index: IndexStore, filter: SessionFilter, c: Cursor, limit: number): Promise<Session[]> {
  const out: Session[] = [];
  const batch = limit + 32;
  for (let offset = 0; out.length <= limit && offset < STATS_SCAN_CAP; offset += batch) {
    // Rows at or before the cursor's millisecond sort first; skip past them.
    const rows = await index.listSessions({ ...filter, until: Math.min(filter.until ?? Infinity, c.startedAt + 1), limit: batch, offset });
    for (const s of rows) if (afterCursor(s, c)) out.push(s);
    if (rows.length < batch) break;
  }
  return out.slice(0, limit + 1);
}

async function listSessions(index: IndexStore, q: URLSearchParams, project?: string) {
  const limit = intParam(q, "limit", 50, 1, 500);
  const offset = intParam(q, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
  const cursor = parseCursor(q.get("cursor"));
  const parent = q.get("parent") || undefined;
  if (parent !== undefined) checkId(parent, "parent");
  const f = facetParams(q);
  const filter: SessionFilter = { agent: f.agent, repoRoot: f.repo, flag: f.flag, since: f.since, until: f.until };
  if (project !== undefined) filter.project = project;
  if (parent !== undefined) filter.parentSessionId = parent;
  else if (scopeParam(q) === "top") filter.parentSessionId = null;
  const text = (q.get("q") ?? "").trim().toLowerCase();
  if (text.length > 500) throw new HttpError(400, "q is too long");
  // Model has no store filter: like text, it goes through the scan.
  const result = text || f.model
    ? await filterSessions(index, filter, text, limit, offset, cursor, f.model)
    : page(cursor ? await pageAfter(index, filter, cursor, limit) : await index.listSessions({ ...filter, limit: limit + 1, offset }), limit, offset);
  const last = result.items[result.items.length - 1];
  return {
    ...result,
    items: await withChildCounts(index, result.items, project),
    ...(result.hasMore && last ? { nextCursor: cursorOf(last) } : {}),
  };
}

async function filterSessions(index: IndexStore, filter: SessionFilter, text: string, limit: number, offset: number, cursor?: Cursor, model?: string) {
  // Substring filter over list metadata (title, id, repo, model). Full-text
  // search over prompts and output lives at /api/search.
  const matches: Session[] = [];
  const scan = cursor ? { ...filter, until: Math.min(filter.until ?? Infinity, cursor.startedAt + 1) } : filter;
  for await (const s of scanSessions(index, scan)) {
    if (cursor && !afterCursor(s, cursor)) continue;
    if (model && s.model !== model) continue;
    const hay = [s.title, s.id, s.repo?.root, s.repo?.branch, s.model].filter(Boolean).join("\n").toLowerCase();
    if (hay.includes(text)) matches.push(s);
    if (matches.length > offset + limit) break;
  }
  return page(matches.slice(offset), limit, offset);
}

async function* scanSessions(index: IndexStore, filter: SessionFilter = {}): AsyncIterable<Session> {
  const batch = 1000;
  for (let offset = 0; offset < STATS_SCAN_CAP; offset += batch) {
    const rows = await index.listSessions({ ...filter, limit: batch, offset });
    yield* rows;
    if (rows.length < batch) return;
  }
}

/** List filters shared by /api/sessions, /api/search and /api/stats. */
interface Facets {
  agent?: string;
  flag?: string;
  repo?: string;
  model?: string;
  /** started_at range, ms: since inclusive, until exclusive. */
  since?: number;
  until?: number;
}
function facetParams(q: URLSearchParams): Facets {
  const time = (name: string) => (q.get(name) ? intParam(q, name, 0, 0, 8_640_000_000_000_000) : undefined);
  return {
    agent: q.get("agent") || undefined,
    flag: q.get("flag") || undefined,
    repo: q.get("repo") || undefined,
    model: q.get("model") || undefined,
    since: time("since"),
    until: time("until"),
  };
}
function matchesFacets(s: Session, f: Facets, skip?: keyof Facets | "time"): boolean {
  return (
    (skip === "agent" || !f.agent || s.agent === f.agent) &&
    (skip === "flag" || !f.flag || s.flags.includes(f.flag)) &&
    (skip === "repo" || !f.repo || s.repo?.root === f.repo) &&
    (skip === "model" || !f.model || s.model === f.model) &&
    (skip === "time" || ((f.since === undefined || s.startedAt >= f.since) && (f.until === undefined || s.startedAt < f.until)))
  );
}

const HIST_STEPS = [5, 15, 60, 180, 360, 720, 1440, 2880, 10_080, 43_200].map((m) => m * 60_000);
const HIST_MAX_BUCKETS = 60;
const HIST_WINDOW = 90 * 86_400_000;

/**
 * Sessions over time, for the histogram above the list: every filter but the
 * time range applies, so the chart shows where the selected range sits. Covers
 * at most the 90 days before the newest session, in the smallest step that
 * fits 60 buckets.
 */
function histogram(starts: { t: number; flagged: boolean }[]) {
  if (starts.length === 0) return { step: HIST_STEPS[2]!, from: 0, buckets: [] as { t: number; n: number; flagged: number }[] };
  let max = -Infinity;
  let min = Infinity;
  for (const x of starts) {
    if (x.t > max) max = x.t;
    if (x.t < min) min = x.t;
  }
  min = Math.max(min, max - HIST_WINDOW);
  const step = HIST_STEPS.find((st) => (max - min) / st < HIST_MAX_BUCKETS) ?? HIST_STEPS[HIST_STEPS.length - 1]!;
  const from = Math.floor(min / step) * step;
  const count = Math.floor((max - from) / step) + 1;
  const buckets = Array.from({ length: count }, (_, i) => ({ t: from + i * step, n: 0, flagged: 0 }));
  for (const x of starts) {
    if (x.t < from) continue;
    const b = buckets[Math.floor((x.t - from) / step)]!;
    b.n++;
    if (x.flagged) b.flagged++;
  }
  return { step, from, buckets };
}

/**
 * Totals and filter facets. With topLevelOnly, `sessions`, the test counts and
 * every facet count top-level sessions only (what the list shows by default);
 * `subagents` counts child sessions, and tool/cost totals cover every session.
 *
 * Facets count like a facet sidebar does: each facet's counts apply every
 * other active filter but its own, so picking a value never hides its
 * siblings. Totals apply them all.
 */
async function computeStats(index: IndexStore, topLevelOnly = false, project?: string, f: Facets = {}) {
  const byAgent: Record<string, number> = {};
  const byFlag: Record<string, number> = {};
  const byRepo: Record<string, number> = {};
  const byModel: Record<string, number> = {};
  const starts: { t: number; flagged: boolean }[] = [];
  let sessions = 0;
  let subagents = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let costUsd = 0;
  let priced = 0;
  let llmCalls = 0;
  let withTests = 0;
  let testsFailing = 0;
  const inc = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);
  for await (const s of scanSessions(index, project ? { project } : {})) {
    const all = matchesFacets(s, f);
    if (all) {
      toolCalls += s.stats.toolCalls;
      toolErrors += s.stats.toolErrors;
      llmCalls += s.stats.latency?.llmCalls ?? 0;
      if (typeof s.stats.usage?.costUsd === "number") {
        costUsd += s.stats.usage.costUsd;
        priced++;
      }
      if (s.parent) subagents++;
    }
    if (topLevelOnly && s.parent) continue;
    if (matchesFacets(s, f, "agent")) inc(byAgent, s.agent);
    if (matchesFacets(s, f, "flag")) for (const fl of s.flags) inc(byFlag, fl);
    if (s.repo?.root && matchesFacets(s, f, "repo")) inc(byRepo, s.repo.root);
    if (s.model && matchesFacets(s, f, "model")) inc(byModel, s.model);
    if (matchesFacets(s, f, "time")) starts.push({ t: s.startedAt, flagged: s.flags.length > 0 || (s.stats.testsFailed ?? 0) > 0 });
    if (!all) continue;
    sessions++;
    if (s.stats.testsPassed !== undefined || s.stats.testsFailed !== undefined) {
      withTests++;
      if ((s.stats.testsFailed ?? 0) > 0) testsFailing++;
    }
  }
  return {
    sessions, subagents, byAgent, byFlag, byRepo, byModel, toolCalls, toolErrors, llmCalls, costUsd, pricedSessions: priced,
    withTests, testsFailing, histogram: histogram(starts),
  };
}

async function createLabel(ctx: ApiCtx, body: unknown): Promise<Label> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "body must be a JSON object");
  const b = body as Record<string, unknown>;
  const sessionId = b.sessionId;
  if (typeof sessionId !== "string" || !sessionId) throw new HttpError(400, "sessionId is required");
  checkId(sessionId, "sessionId");
  const criterion = b.criterion ?? "outcome";
  if (typeof criterion !== "string" || !/^[\w.:-]{1,100}$/.test(criterion)) {
    throw new HttpError(400, "criterion must be 1-100 chars of [A-Za-z0-9_.:-]");
  }
  const value = b.value;
  if (value !== "pass" && value !== "fail" && value !== "skip") throw new HttpError(400, "value must be pass, fail or skip");
  const note = b.note;
  if (note !== undefined && note !== null && (typeof note !== "string" || note.length > 4000)) {
    throw new HttpError(400, "note must be a string of at most 4000 chars");
  }
  await visibleSession(ctx, sessionId);
  const by = ctx.labeller;
  const label: Label = {
    // One current label per (session, criterion, person): relabelling replaces it.
    id: createHash("sha256").update(`label\0${sessionId}\0${criterion}\0${by}`).digest("hex"),
    sessionId,
    criterion,
    value,
    by,
    ts: Date.now(),
  };
  if (typeof note === "string" && note) label.note = note;
  await ctx.index.putLabel(label);
  return label;
}

// ---------------------------------------------------------------- helpers

function checkId(id: string, what: string): string {
  if (!id || id.length > MAX_ID_LEN || /[\u0000-\u001f]/.test(id)) throw new HttpError(400, `invalid ${what}`);
  return id;
}

function intParam(q: URLSearchParams, name: string, dflt: number, min: number, max: number): number {
  const raw = q.get(name);
  if (raw === null || raw === "") return dflt;
  if (!/^\d+$/.test(raw)) throw new HttpError(400, `${name} must be a non-negative integer`);
  const n = Number(raw);
  if (n < min || n > max) throw new HttpError(400, `${name} must be between ${min} and ${max}`);
  return n;
}

/** Browsers always send Origin on cross-origin POSTs; when present it must be us. */
function checkOrigin(req: IncomingMessage, checkHost: (host: string) => boolean): void {
  const origin = req.headers.origin;
  if (origin === undefined) return;
  let host: string;
  try {
    const u = new URL(origin);
    // https: serve behind a TLS-terminating proxy.
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("scheme");
    host = u.host.toLowerCase();
  } catch {
    throw new HttpError(403, "forbidden origin");
  }
  if (!checkHost(host)) throw new HttpError(403, "forbidden origin");
}

async function readJson(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  const type = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") throw new HttpError(415, "content-type must be application/json");
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > MAX_BODY_BYTES) {
    res.setHeader("Connection", "close");
    throw new HttpError(413, "request body exceeds 1 MB");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      res.setHeader("Connection", "close");
      throw new HttpError(413, "request body exceeds 1 MB");
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function setBaseHeaders(res: ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

const DEFAULT_UNAUTHORIZED = "This viewer needs its access token. Open the URL printed by <code>coding.sh ui</code>.";

function sendUnauthorizedPage(res: ServerResponse, text = DEFAULT_UNAUTHORIZED, basicRealm?: string): void {
  const body =
    "<!doctype html><meta charset=utf-8><title>coding.sh</title>" +
    "<body style=\"background:#08080a;color:#a8a8ae;font:14px ui-monospace,monospace;padding:3rem\">" +
    `<p>${text}</p>`;
  if (basicRealm) res.setHeader("WWW-Authenticate", `Basic realm="${basicRealm}", charset="UTF-8"`);
  res.writeHead(401, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    "Cache-Control": "no-store",
  });
  res.end(body);
}
