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
import { phaseLabel, sessionOutline, storedOutline } from "../core/outline.ts";
import { loadReplay, type Baseline, type Replay } from "../core/replay.ts";
import { buildSessionTree, worstFirst, worstNode, type TreeNode } from "../core/tree.ts";
import type { ExperimentResult } from "../datasets/types.ts";
import { checkpointRuns, checkpointSessions, withSessions } from "../experiments/checkpoints.ts";
import { compareExperiments } from "../experiments/compare.ts";
import { stampedWith, weightsOf } from "../experiments/weights.ts";
import { facetCounts, findEvents, findSessions, searchWhere } from "../query/run.ts";
import type { AgentEvent } from "../schema/index.ts";
import { searchableText, searchTerms, snippet } from "../store/common.ts";
import { andQuery, keyGuide, parseWhere, QueryError, QueryUnsupported, type Node, type Query } from "../query/where.ts";
import { CallRefError, diffCalls, loadCall, previousCall, resolveCall } from "../proxy/calls.ts";
import { getUpdateStatus, type UpdateStatus } from "../update/index.ts";
import { recordStar, STAR_MIN_SESSIONS, starDue } from "../update/star.ts";
import { WorkflowStore } from "../workflows/store.ts";
import { WorkflowApiError, workflowsApi, type WorkflowViewSource } from "../workflows/viewer.ts";
import { BOOT_LIST_PATHS, BOOT_MAX_BYTES, BOOT_SESSION_EVENTS, renderPage, renderSessionsMain, sessionBootPaths } from "./ssr.ts";
import { layoutRows, ModelCache, modelOutline, readRows, ROWS_LIMIT, ROWS_MAX } from "./model.ts";
import { parseRequest as parsePlaygroundRequest, PlaygroundError, rebuildCall, type PlaygroundSource } from "./playground.ts";
import { computeMetrics, DAY_MS, MAX_GROUPS, METRIC_BUCKETS, METRIC_GROUPS, MetricsError, type MetricBucket, type MetricGroup, type MetricsSpec } from "./metrics.ts";
import { parseTime } from "../query/where.ts";
import { getScoreConfigs, getScores, postScore, postScoreConfig, type ApiReply, type ScoresApiCtx } from "../scores/api.ts";
import { ScoreError } from "../scores/scores.ts";

/** Where /api/star keeps its state: this machine's coding.sh home. `now` is for tests. */
export interface StarSource {
  env: NodeJS.ProcessEnv;
  now?: () => number;
}

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
  /** Workflow runs behind /api/workflows (`coding.sh workflows`). Default: the workflow store under env's data dir. */
  workflows?: WorkflowViewSource;
  /** Background ingest progress behind /api/ingest (`coding.sh ui`). Without it the route is 404. */
  ingestStatus?: () => IngestStatus | undefined;
  /** The one-time star prompt behind /api/star (`coding.sh ui` passes its env; it writes <root>/star.json). Without it the route is 404. */
  star?: StarSource;
  /** Start-snapshot content for replays (`coding.sh ui`, which can read this machine's shadow repos). */
  replayBaseline?: (s: Session) => Baseline | undefined;
  /** Forking a replay at a step (`coding.sh ui` only: it calls the model with this machine's key). Without it /fork is 404. */
  fork?: ForkSource;
  /** The LLM-call playground (`coding.sh ui` only: it calls the model with this machine's key). Without it /api/playground is 404. */
  playground?: PlaygroundSource;
  /** Draw the first sessions page on the server and embed the first responses. Default: true. */
  serverRender?: boolean;
}

/** Forks behind /api/sessions/<id>/fork: what a fork at step N starts from, and the fork itself. */
export interface ForkSource {
  preview(s: Session, replay: Replay, step: number): Promise<unknown>;
  run(s: Session, replay: Replay, step: number, files: Record<string, string>, trials: number): Promise<unknown>;
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
  /** Extra fields for the error body (a bad `where`: reason, offset, next). */
  readonly extra?: Record<string, unknown>;
  constructor(status: number, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    if (extra) this.extra = extra;
  }
}

/** `?where=`: the query language (src/query), parsed; a bad one is a 400 with its offset. */
function whereParam(q: URLSearchParams): Query | undefined {
  const raw = q.get("where")?.trim();
  if (!raw) return undefined;
  try {
    return parseWhere(raw);
  } catch (e) {
    throw queryHttpError(e);
  }
}

function queryHttpError(e: unknown): unknown {
  if (e instanceof QueryError) return new HttpError(400, `where: ${e.message}`, { reason: e.reason, offset: e.offset, next: e.next });
  if (e instanceof QueryUnsupported) return new HttpError(400, e.message, { reason: e.reason });
  if (e instanceof RangeError) return new HttpError(400, e.message);
  return e;
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
  /** Workflow runs behind /api/workflows. Default: none (an empty list, 404 for a run). */
  workflows?: WorkflowViewSource;
  /** Background ingest progress behind /api/ingest. Default: none (404). */
  ingestStatus?: () => IngestStatus | undefined;
  /** The star prompt behind /api/star. Default: none (404). */
  star?: StarSource;
  /** Start-snapshot content for replays. Default: none (replays start from what the session showed). */
  replayBaseline?: (s: Session) => Baseline | undefined;
  /** Forks from a replay step. Default: none (404). */
  fork?: ForkSource;
  /** The LLM-call playground. Default: none (404). */
  playground?: PlaygroundSource;
  /** Draw the first sessions page on the server and embed the first responses. Default: true. */
  serverRender?: boolean;
}

export type ViewerHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/** The viewer page and /api routes as a request handler (used by `coding.sh ui` and `coding.sh serve`). Never throws. */
export async function createViewerHandler(opts: ViewerHandlerOptions): Promise<ViewerHandler> {
  const page = await loadPage();
  const labeller = currentUser();
  const experiments = opts.experiments ?? indexExperiments(opts.index);

  const unauthorizedPage = (res: ServerResponse) => sendUnauthorizedPage(res, opts.unauthorizedText, opts.basicRealm);
  const apiCtx = (access: { by?: string; project?: string }): ApiCtx => ({
    index: opts.index,
    blobs: opts.blobs,
    labeller: access.by ?? labeller,
    checkHost: opts.checkHost,
    updateStatus: opts.updateStatus,
    project: access.project,
    projects: opts.projects,
    experiments,
    benchmarks: opts.benchmarks,
    workflows: opts.workflows,
    ingestStatus: opts.ingestStatus,
    star: opts.star,
    replayBaseline: opts.replayBaseline,
    fork: opts.fork,
    playground: opts.playground,
  });

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
      const access = await opts.authorize(req);
      if (!access) return unauthorizedPage(res);
      const nonce = randomBytes(16).toString("base64");
      let body = page.replaceAll("__CSP_NONCE__", nonce);
      if (opts.serverRender !== false && req.method !== "HEAD") {
        const first = await firstPaint(apiCtx(access)).catch(() => undefined);
        if (first) body = renderPage(body, first.main, first.boot, nonce);
      }
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
    await routeApi(req, res, url, apiCtx(access));
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
      sendJson(res, status, { error: message, status, ...(err instanceof HttpError ? err.extra : {}) });
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
    workflows: opts.workflows ?? WorkflowStore.forEnv(opts.env ?? process.env),
    ...(opts.ingestStatus ? { ingestStatus: opts.ingestStatus } : {}),
    star: opts.star,
    ...(opts.replayBaseline ? { replayBaseline: opts.replayBaseline } : {}),
    ...(opts.fork ? { fork: opts.fork } : {}),
    ...(opts.playground ? { playground: opts.playground } : {}),
    ...(opts.serverRender !== undefined ? { serverRender: opts.serverRender } : {}),
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
  workflows?: WorkflowViewSource;
  ingestStatus?: () => IngestStatus | undefined;
  star?: StarSource;
  replayBaseline?: (s: Session) => Baseline | undefined;
  fork?: ForkSource;
  playground?: PlaygroundSource;
}

/** The index's own experiment methods (sqlite, memory, postgres), or undefined when it has none. */
function indexExperiments(index: IndexStore): ExperimentSource | undefined {
  if (!index.listExperiments || !index.getExperiment) return undefined;
  return { listExperiments: (f) => index.listExperiments!(f), getExperiment: (id) => index.getExperiment!(id) };
}

const projectOf = (s: Session): string => s.project ?? "default";

/** Span models per store (src/viewer/model.ts): outline and rows read through them. */
const MODELS = new WeakMap<IndexStore, ModelCache>();
function modelCache(ctx: ApiCtx): ModelCache {
  let cache = MODELS.get(ctx.index);
  if (!cache) MODELS.set(ctx.index, (cache = new ModelCache()));
  return cache;
}
function cachedModel(ctx: ApiCtx, s: Session) {
  return modelCache(ctx).get(ctx.index, s);
}
/** Sessions up to this many events get their spans folded inline on the outline; longer ones in the background. */
export const OUTLINE_INLINE_EVENTS = 20_000;

/** Recent replays per store: a viewer steps through one session at a time, so a few stay warm. */
const REPLAYS = new WeakMap<IndexStore, Map<string, { key: string; replay: Promise<Replay> }>>();
const REPLAY_CACHE = 4;

/** The session's replay, rebuilt when the session has changed (more events, an end, a re-parse). */
function cachedReplay(ctx: ApiCtx, s: Session): Promise<Replay> {
  let cache = REPLAYS.get(ctx.index);
  if (!cache) REPLAYS.set(ctx.index, (cache = new Map()));
  const key = `${s.stats.events}:${s.endedAt ?? ""}:${s.parseVersion ?? ""}`;
  const hit = cache.get(s.id);
  if (hit && hit.key === key) {
    cache.delete(s.id);
    cache.set(s.id, hit);
    return hit.replay;
  }
  const replay = loadReplay(ctx, s, { baseline: ctx.replayBaseline?.(s) });
  cache.delete(s.id);
  cache.set(s.id, { key, replay });
  replay.catch(() => cache.delete(s.id));
  while (cache.size > REPLAY_CACHE) cache.delete(cache.keys().next().value!);
  return replay;
}

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

/** One /api/sessions/<id>/tree node: the session's own numbers and its subagents. */
function treeNode(n: TreeNode): Record<string, unknown> {
  const s = n.session;
  return {
    id: s.id,
    agent: s.agent,
    role: n.depth === 0 ? "root" : (s.parent?.type ?? "subagent"),
    model: s.model ?? null,
    title: s.title ?? null,
    depth: n.depth,
    startedAt: s.startedAt,
    endedAt: s.endedAt ?? null,
    durationMs: s.endedAt !== undefined ? s.endedAt - s.startedAt : null,
    usage: s.stats.usage ?? null,
    toolCalls: s.stats.toolCalls,
    toolErrors: s.stats.toolErrors,
    filesChanged: s.stats.filesChanged,
    flags: worstFirst(s.flags),
    children: n.children.map(treeNode),
  };
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
      if (sub !== "fork") get();
      if (id === undefined || (id === "" && sub === undefined)) return sendJson(res, 200, await listSessions(ctx.index, q, projectParam(ctx, q)));
      const sessionId = checkId(id, "session id");
      if (sub === undefined) {
        const s = await visibleSession(ctx, sessionId);
        // The experiments that ran each weights file the session recorded as a checkpoint, as `coding.sh show --json`
        // has them. Eval assets belong to no project: a project-scoped key sees none.
        const hashes = s.stats.weightEdits?.checkpoints;
        const runs = hashes?.length && ctx.project === undefined && ctx.experiments ? await checkpointRuns(ctx.experiments, hashes) : [];
        return sendJson(res, 200, runs.length ? { ...s, checkpointExperiments: runs } : s);
      }
      if (sub === "events") {
        await visibleSession(ctx, sessionId);
        const limit = intParam(q, "limit", 5000, 1, 20_000);
        const offset = intParam(q, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
        const kinds = q.get("kinds")?.split(",").filter(Boolean);
        const events = await ctx.index.listEvents(sessionId, { limit: limit + 1, offset, kinds });
        return sendJson(res, 200, page(events, limit, offset));
      }
      if (sub === "replay") {
        const s = await visibleSession(ctx, sessionId);
        const replay = await cachedReplay(ctx, s);
        const total = replay.steps.length;
        const stepOf = (name: string) => (q.has(name) ? intParam(q, name, 1, 1, Math.max(1, total)) : undefined);
        const from = stepOf("from");
        const to = stepOf("to");
        const step = stepOf("step");
        const file = q.get("file") || undefined;
        if (!total && (from !== undefined || to !== undefined || step !== undefined)) throw new HttpError(400, "this session has no steps");
        if (from !== undefined || to !== undefined) {
          if (from === undefined || to === undefined) throw new HttpError(400, "from and to go together");
          return sendJson(res, 200, await replay.range(from, to));
        }
        if (step !== undefined) return sendJson(res, 200, await replay.at(step, { file }));
        if (file !== undefined) throw new HttpError(400, "file needs a step");
        return sendJson(res, 200, { ...replay.index(), ...(ctx.fork ? { canFork: true } : {}) });
      }
      if (sub === "fork") {
        // GET ?step=N: the call a fork at step N starts from and the context files it carried. POST {step, files, trials}: the fork.
        if (!ctx.fork) throw new HttpError(404, "forking is only in the local viewer (coding.sh ui)");
        const s = await visibleSession(ctx, sessionId);
        const replay = await cachedReplay(ctx, s);
        const total = replay.steps.length;
        if (!total) throw new HttpError(400, "this session has no steps");
        if (method === "GET") return sendJson(res, 200, await ctx.fork.preview(s, replay, intParam(q, "step", total, 1, total)).catch(forkHttpError));
        if (method !== "POST") throw new HttpError(405, "method not allowed");
        checkOrigin(req, ctx.checkHost);
        const body = await readJson(req, res);
        const b = (typeof body === "object" && body !== null ? body : {}) as { step?: unknown; files?: unknown; trials?: unknown };
        if (typeof b.step !== "number" || !Number.isInteger(b.step) || b.step < 1 || b.step > total) throw new HttpError(400, `step must be from 1 to ${total}`);
        const files = b.files ?? {};
        if (typeof files !== "object" || files === null || Array.isArray(files) || !Object.values(files).every((v) => typeof v === "string")) throw new HttpError(400, "files maps a context file path to its text");
        const trials = b.trials === undefined ? 1 : b.trials;
        if (typeof trials !== "number" || !Number.isInteger(trials) || trials < 1 || trials > 5) throw new HttpError(400, "trials is from 1 to 5");
        return sendJson(res, 200, await ctx.fork.run(s, replay, b.step, files as Record<string, string>, trials).catch(forkHttpError));
      }
      if (sub === "outline") {
        // Phases (start, resumes, compactions, idle gaps), day marks and derails: a long session at a glance.
        const s = await visibleSession(ctx, sessionId);
        const derails = s.stats.derails ?? [];
        const o = storedOutline(s) ?? sessionOutline(await ctx.index.listEvents(sessionId), derails);
        // The span fields come with the outline once the model is built; a long session's first
        // build runs in the background ("spans": "building"), so the outline never waits on it.
        let m = await modelCache(ctx).peek(ctx.index, s);
        if (!m && (s.stats.events ?? 0) <= OUTLINE_INLINE_EVENTS) m = await cachedModel(ctx, s);
        // After the response: a SQLite read of every event runs synchronously.
        else if (!m) setImmediate(() => cachedModel(ctx, s).catch(() => undefined));
        return sendJson(res, 200, { phases: o.phases.map((p) => ({ ...p, label: phaseLabel(p) })), days: o.days, derails, events: s.stats.events, ...(m ? modelOutline(m) : { spans: "building" }) });
      }
      if (sub === "rows") {
        // One page of a turn's rows: events, with long runs of routine ones folded (never a failure).
        const s = await visibleSession(ctx, sessionId);
        const m = await cachedModel(ctx, s);
        if (!m.turns.length) return sendJson(res, 200, { turn: null, rows: [] });
        const t = m.turns[intParam(q, "turn", 0, 0, m.turns.length - 1)]!;
        const after = q.has("after") ? intParam(q, "after", t.start - 1, t.start - 1, t.end) : t.start - 1;
        const limit = intParam(q, "limit", ROWS_LIMIT, 1, ROWS_MAX);
        const fold = q.get("fold") !== "0";
        const { slots, next } = layoutRows(m, t, after + 1, limit, fold);
        return sendJson(res, 200, { turn: t, rows: await readRows(ctx.index, sessionId, m, slots), ...(next !== undefined ? { next: next - 1 } : {}) });
      }
      if (sub === "tree") {
        // The whole multi-agent run this session belongs to: its top-level agent
        // and every subagent under it, with per-node numbers and rolled-up totals.
        await visibleSession(ctx, sessionId);
        const tree = await buildSessionTree(ctx.index, sessionId);
        if (!tree) throw notFound();
        const worst = worstNode(tree.roots);
        const t = tree.totals;
        return sendJson(res, 200, {
          root: tree.roots[0]?.session.id ?? sessionId,
          totals: {
            sessions: t.sessions,
            usage: t.usage,
            toolCalls: t.toolCalls,
            toolErrors: t.toolErrors,
            filesChanged: t.filesChanged,
            durationMs: t.wallMs ?? null,
            flags: t.flags,
          },
          worst: worst ? { sessionId: worst.session.id, role: worst.depth === 0 ? "root" : (worst.session.parent?.type ?? "subagent"), flags: worstFirst(worst.session.flags) } : null,
          tree: tree.roots.map(treeNode),
        });
      }
      throw notFound();
    }

    case "calls": {
      // One model call logged by coding.sh proxy (request and response re-read from blobs), or its diff with another.
      get();
      const diff = sub === "diff";
      if (id === undefined || id === "" || (sub !== undefined && !diff)) throw notFound();
      const call = async (ref: string) => {
        checkId(ref, "call id");
        try {
          const e = await resolveCall(ctx.index, ref);
          await visibleSession(ctx, e.sessionId);
          return e;
        } catch (err) {
          if (err instanceof CallRefError) throw new HttpError(404, err.reason === "ambiguous" ? "call id prefix is ambiguous" : "call not found");
          if (err instanceof HttpError) throw new HttpError(404, "call not found");
          throw err;
        }
      };
      const b = await call(id);
      if (!diff) {
        const l = await loadCall(ctx.blobs, b);
        return sendJson(res, 200, { call: b, request: l.request ?? null, response: l.response ?? null });
      }
      const withRef = q.get("with");
      let a = withRef ? await call(withRef) : undefined;
      if (!a) {
        a = await previousCall(ctx.index, b);
        if (!a) throw new HttpError(404, "no earlier model call in this session; pass ?with=<call id>");
      }
      return sendJson(res, 200, diffCalls(await loadCall(ctx.blobs, a), await loadCall(ctx.blobs, b)));
    }

    case "blobs": {
      get();
      if (id === undefined || sub !== undefined) throw new HttpError(404, "not found");
      if (!SHA_RE.test(id)) throw new HttpError(400, "blob ref must be 64 lowercase hex chars");
      const data = await ctx.blobs.get(id);
      if (!data) throw new HttpError(404, "blob not found");
      const range = blobRange(q.get("range") ?? (req.headers.range?.startsWith("bytes=") ? req.headers.range.slice(6) : null), data.byteLength);
      if (range === "unsatisfiable") {
        res.writeHead(416, { "Content-Type": "application/json; charset=utf-8", "Content-Range": `bytes */${data.byteLength}` });
        res.end(JSON.stringify({ error: `range is outside the blob's ${data.byteLength} bytes` }));
        return;
      }
      if (range) {
        // A byte range (inclusive), as HTTP Range has it: a long output read a piece at a time.
        const [a, b] = range;
        const part = data.subarray(a, b + 1);
        res.writeHead(206, {
          "Content-Type": "application/octet-stream",
          "Content-Length": part.byteLength,
          "Content-Range": `bytes ${a}-${b}/${data.byteLength}`,
          "Accept-Ranges": "bytes",
          "X-Blob-Size": data.byteLength,
        });
        res.end(part);
        return;
      }
      const full = q.get("full") === "1";
      const truncated = !full && data.byteLength > BLOB_CAP_BYTES;
      const body = truncated ? data.subarray(0, BLOB_CAP_BYTES) : data;
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": body.byteLength,
        "Content-Disposition": "inline",
        "X-Blob-Size": data.byteLength,
        "X-Truncated": truncated ? "1" : "0",
        "Accept-Ranges": "bytes",
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
      const where = whereParam(q);
      if (where) {
        // The other list filters join the query as session clauses; search applies it at event level.
        const hits = await searchWhere(ctx.index, text, withFacets(where, f, scopeParam(q) === "top"), { limit, ...(agent ? { agent } : {}), ...(project !== undefined ? { project } : {}) }).catch((e) => Promise.reject(queryHttpError(e)));
        return sendJson(res, 200, { items: hits });
      }
      return sendJson(res, 200, { items: await searchSessions(ctx, text, limit, { ...f, agent, project, top: scopeParam(q) === "top" }) });
    }

    case "facets": {
      // Session counts per value of each key, over the query without that key's own clauses.
      get();
      if (id !== undefined) throw new HttpError(404, "not found");
      const keys = (q.get("keys") ?? "agent,model,repo,flag").split(",").map((k) => k.trim()).filter(Boolean);
      if (keys.length > 12) throw new HttpError(400, "at most 12 keys");
      const project = projectParam(ctx, q);
      const filter: SessionFilter = scopeParam(q) === "top" ? { parentSessionId: null } : {};
      if (project !== undefined) filter.project = project;
      const { since, until } = facetParams(q);
      if (since !== undefined) filter.since = since;
      if (until !== undefined) filter.until = until;
      // Autocomplete: only values starting with what was typed.
      const prefix = q.get("prefix") ?? "";
      if (prefix.length > 200) throw new HttpError(400, "prefix is too long");
      const facets = await facetCounts(ctx.index, whereParam(q) ?? {}, keys, { filter, limit: intParam(q, "limit", 20, 1, 200), ...(prefix ? { prefix } : {}) }).catch((e) => Promise.reject(queryHttpError(e)));
      return sendJson(res, 200, { facets });
    }

    case "where": {
      // The query language's keys, for the query bar's completions.
      get();
      if (id !== undefined) throw new HttpError(404, "not found");
      return sendJson(res, 200, { keys: keyGuide() });
    }

    case "events": {
      // `where` at event level: matching events across sessions, newest first, keyset-paged.
      get();
      if (id !== undefined) {
        // One event by id, whole (rows carry a line; this is what a row opens to).
        if (sub !== undefined || id === "") throw notFound();
        const ref = checkId(id, "event id");
        const hit = ctx.index.eventsByIdPrefix ? (await ctx.index.eventsByIdPrefix(ref, 2)).find((e) => e.id === ref) : undefined;
        if (!hit) throw new HttpError(404, "event not found");
        await visibleSession(ctx, hit.sessionId).catch(() => Promise.reject(new HttpError(404, "event not found")));
        return sendJson(res, 200, hit);
      }
      const where = whereParam(q) ?? {};
      const limit = intParam(q, "limit", 50, 1, 200);
      const cursor = q.get("cursor") || undefined;
      if (cursor !== undefined && cursor.length > 80) throw new HttpError(400, "cursor is malformed");
      const project = projectParam(ctx, q);
      const filter: SessionFilter = project !== undefined ? { project } : {};
      // scope=top leaves out subagent sessions' events, as the list leaves out their rows.
      if (scopeParam(q) === "top") filter.parentSessionId = null;
      // A time range picks the sessions (by start), as on the list.
      const { since, until } = facetParams(q);
      if (since !== undefined) filter.since = since;
      if (until !== undefined) filter.until = until;
      // Counted on the first page only, up to EVENTS_COUNT_CAP ("10,000+" past it).
      const r = await findEvents(ctx.index, where, { filter, limit, ...(cursor ? { cursor } : { countUpTo: EVENTS_COUNT_CAP }) }).catch((e) => Promise.reject(queryHttpError(e)));
      const sessions = new Map<string, Session | undefined>();
      for (const e of r.items) if (!sessions.has(e.sessionId)) sessions.set(e.sessionId, await ctx.index.getSession(e.sessionId).catch(() => undefined));
      const terms = textTerms(where.root);
      return sendJson(res, 200, {
        items: r.items.map((e) => eventRow(e, sessions.get(e.sessionId), terms)),
        ...(r.next ? { next: r.next } : {}),
        ...(r.total !== undefined ? { total: r.total, totalCapped: !!r.totalCapped } : {}),
      });
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
      // Next to the stored record, as `exp show --json`: the stamp with the sessions that recorded that weights file as a checkpoint.
      const { weights } = withSessions(stampedWith({}, weightsOf(exp)), await checkpointSessions(ctx.index, [weightsOf(exp)]));
      return sendJson(res, 200, weights?.sessions ? { ...experimentDetail(exp), weights } : experimentDetail(exp));
    }

    case "workflows": {
      // Workflow runs (docs/design/workflows.md §8); they belong to no project, like benchmarks.
      get();
      const src = ctx.project !== undefined ? undefined : ctx.workflows;
      if (!src) {
        if (id === undefined || id === "") return sendJson(res, 200, { runs: [] });
        throw new HttpError(404, "not found");
      }
      try {
        return sendJson(res, 200, await workflowsApi(src, id, sub, q));
      } catch (e) {
        if (e instanceof WorkflowApiError) throw new HttpError(e.status, e.message);
        throw e;
      }
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
      const cmp = compareExperiments(a, b, { iters: 4000, force: true });
      // Each side's stamp names the sessions that recorded that weights file as a checkpoint (weights.sessions).
      const checkpoints = await checkpointSessions(ctx.index, [cmp.a.weights?.sha256, cmp.b.weights?.sha256]);
      withSessions(cmp.a, checkpoints);
      withSessions(cmp.b, checkpoints);
      return sendJson(res, 200, { ...cmp, partial });
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

    case "scores": {
      if (id !== undefined) throw new HttpError(404, "not found");
      if (method === "GET") return sendScores(res, () => getScores(scoresCtx(ctx), q));
      if (method === "POST") {
        checkOrigin(req, ctx.checkHost);
        const body = await readJson(req, res);
        return sendScores(res, () => postScore(scoresCtx(ctx), body));
      }
      throw new HttpError(405, "method not allowed");
    }

    case "score-configs": {
      if (id !== undefined) throw new HttpError(404, "not found");
      if (method === "GET") return sendScores(res, () => getScoreConfigs(scoresCtx(ctx)));
      if (method === "POST") {
        checkOrigin(req, ctx.checkHost);
        const body = await readJson(req, res);
        return sendScores(res, () => postScoreConfig(scoresCtx(ctx), body));
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

    case "star": {
      if (id !== undefined) throw new HttpError(404, "not found");
      // Only `coding.sh ui` passes a star source: it keeps its state in this machine's home.
      if (!ctx.star) throw new HttpError(404, "not found");
      const star = ctx.star;
      if (method === "GET") {
        if (!starDue(star.env, star.now)) return sendJson(res, 200, { show: false });
        // Five top-level sessions is the bar (subagents do not count); reading five rows is all the count it needs.
        const count = (await ctx.index.listSessions({ limit: STAR_MIN_SESSIONS, parentSessionId: null })).length;
        return sendJson(res, 200, { show: count >= STAR_MIN_SESSIONS });
      }
      if (method === "POST") {
        checkOrigin(req, ctx.checkHost);
        const body = await readJson(req, res, 1024);
        const action = body && typeof body === "object" ? (body as Record<string, unknown>).action : undefined;
        if (action !== "dismiss" && action !== "starred") throw new HttpError(400, 'action must be "dismiss" or "starred"');
        recordStar(star.env, action, star.now);
        return sendJson(res, 200, { ok: true });
      }
      throw new HttpError(405, "method not allowed");
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
      const project = projectParam(ctx, q);
      return sendJson(res, 200, await computeStats(ctx.index, scopeParam(q) === "top", project, facetParams(q), whereParam(q)).catch((e) => Promise.reject(queryHttpError(e))));
    }

    case "metrics": {
      // Sessions, failures, cost, tokens, tool calls and latency per day or week, optionally split.
      get();
      if (id !== undefined) throw new HttpError(404, "not found");
      const project = projectParam(ctx, q);
      const spec = metricsParams(q);
      const filter: MetricsSpec["filter"] = scopeParam(q) === "top" ? { parentSessionId: null } : {};
      if (project !== undefined) filter.project = project;
      const where = whereParam(q);
      return sendJson(res, 200, await computeMetrics(ctx.index, { ...spec, filter, ...(where ? { where } : {}) }).catch((e) => Promise.reject(e instanceof MetricsError ? new HttpError(400, e.message, { reason: e.reason }) : queryHttpError(e))));
    }

    case "playground": {
      // GET: providers and datasets. GET calls/<id>: a call rebuilt for editing. POST run, POST save.
      if (!ctx.playground) throw new HttpError(404, "the playground is only in the local viewer (coding.sh ui)");
      const pg = ctx.playground;
      if (id === undefined || id === "") {
        get();
        return sendJson(res, 200, { providers: pg.providers(), datasets: await pg.datasets() });
      }
      if (id === "calls") {
        get();
        if (!sub) throw notFound();
        const ref = checkId(sub, "call id");
        const sessionId = q.get("session");
        let event: AgentEvent | undefined;
        if (sessionId) {
          await visibleSession(ctx, checkId(sessionId, "session id"));
          event = (await ctx.index.listEvents(sessionId, { kinds: ["llm.call"] })).find((e) => e.id === ref);
        } else {
          event = await resolveCall(ctx.index, ref).catch(() => undefined);
          if (event) await visibleSession(ctx, event.sessionId);
        }
        if (!event) throw new HttpError(404, "call not found");
        return sendJson(res, 200, await rebuildCall(ctx.index, ctx.blobs, event).catch(playgroundHttpError));
      }
      // POST run and POST save take an edited request from the viewer's own page.
      const posted = async () => {
        if (sub !== undefined) throw notFound();
        checkOrigin(req, ctx.checkHost);
        const body = await readJson(req, res, PLAYGROUND_BODY_BYTES);
        const b = (typeof body === "object" && body !== null && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
        try {
          return { b, request: parsePlaygroundRequest(b.request) };
        } catch (e) {
          return playgroundHttpError(e);
        }
      };
      if (id === "run") {
        if (method !== "POST") throw new HttpError(405, "method not allowed");
        const { b, request } = await posted();
        if (typeof b.provider !== "string") throw new HttpError(400, "provider is required");
        return sendJson(res, 200, await pg.run(b.provider, request).catch(playgroundHttpError));
      }
      if (id === "save") {
        if (method !== "POST") throw new HttpError(405, "method not allowed");
        const { b, request } = await posted();
        if (typeof b.dataset !== "string") throw new HttpError(400, "dataset is required");
        const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
        const sessionId = str(b.sessionId);
        const callId = str(b.callId);
        return sendJson(res, 200, await pg.save({ dataset: b.dataset, request, ...(b.expected !== undefined ? { expected: b.expected } : {}), ...(sessionId ? { sessionId } : {}), ...(callId ? { callId } : {}) }).catch(playgroundHttpError));
      }
      throw notFound();
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

const EVENTS_COUNT_CAP = 10_000;
const ROW_TEXT_CAP = 240;

/** A copy of a payload small enough for a list row: strings clipped, nesting cut at two levels. */
function clipPayload(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return v.length > ROW_TEXT_CAP ? `${v.slice(0, ROW_TEXT_CAP - 1)}…` : v;
  if (Array.isArray(v)) return depth >= 2 ? `[${v.length}]` : v.slice(0, 8).map((x) => clipPayload(x, depth + 1));
  if (v && typeof v === "object") {
    if (depth >= 2) return "{…}";
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v).slice(0, 16)) out[k] = clipPayload(x, depth + 1);
    return out;
  }
  return v;
}

/** The words of every positive text clause, folded as the full-text index folds them (for snippets). */
function textTerms(n: Node | undefined): string[] {
  if (!n || n.t === "not") return [];
  if (n.t === "text") return n.words.flatMap((w) => searchTerms(w));
  if (n.t === "and" || n.t === "or") return n.items.flatMap(textTerms);
  return [];
}

/** One /api/events row: the event with its payload clipped, its session's name, and a snippet for text queries. */
function eventRow(e: AgentEvent, s: Session | undefined, terms: string[]) {
  const { payload, blobs: _b, repo: _r, ...rest } = e;
  const text = terms.length ? searchableText(e) : undefined;
  return {
    ...rest,
    payload: clipPayload(payload ?? {}),
    session: s ? { id: s.id, title: s.title, agent: s.agent, model: s.model, ...(s.parent ? { parent: s.parent.sessionId, type: s.parent.type } : {}) } : null,
    ...(text ? { snippet: snippet(text, terms) } : {}),
  };
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

/**
 * Every list row carries `childCount`: how many subagent sessions name it as
 * their parent. One grouped query for the page (store.childCounts); stores
 * without it fall back to one listSessions per row.
 */
async function withChildCounts(index: IndexStore, rows: Session[], project?: string): Promise<(Session & { childCount: number })[]> {
  if (!rows.length) return [];
  const opts = project ? { project } : {};
  const counts: Record<string, number> = index.childCounts
    ? await index.childCounts(rows.map((s) => s.id), opts)
    : Object.fromEntries(await Promise.all(rows.map(async (s) => [s.id, (await index.listSessions({ parentSessionId: s.id, limit: 10_000, ...opts })).length] as const)));
  return rows.map((s) => ({ ...s, childCount: counts[s.id] ?? 0 }));
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
  const where = whereParam(q);
  if (where) {
    if (cursor) throw new HttpError(400, "cursor does not apply with where; page with offset");
    // A query pages by offset (its order may be a stat, not the keyset cursor's start time).
    const qq = f.model ? withFacets(where, { model: f.model }, false) : where;
    // With q too, the substring filter runs over the matches before paging.
    const r = await findSessions(index, qq, text ? { filter, limit: STATS_SCAN_CAP } : { filter, limit: limit + 1, offset }).catch((e) => Promise.reject(queryHttpError(e)));
    const rows = text ? r.sessions.filter((s) => [s.title, s.id, s.repo?.root, s.repo?.branch, s.model].filter(Boolean).join("\n").toLowerCase().includes(text)).slice(offset) : r.sessions;
    const result = page(rows, limit, offset);
    return { ...result, items: await withChildCounts(index, result.items, project) };
  }
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

/** The list filters as query clauses, and-ed onto a `where` query (exact values, as matchesFacets). */
function withFacets(q: Query, f: Facets, top: boolean): Query {
  const items: Node[] = [];
  const eq = (key: string, raw: string): Node => ({ t: "cmp", key, op: ":", values: [{ raw, quoted: true, kind: "eq" }], at: 0 });
  if (f.agent) items.push(eq("agent", f.agent));
  if (f.flag) items.push(eq("flag", f.flag));
  if (f.model) items.push(eq("model", f.model));
  if (f.repo) items.push(eq("repo", f.repo));
  if (f.since !== undefined) items.push({ t: "cmp", key: "since", op: ":", values: [{ raw: String(f.since), quoted: false, kind: "eq", n: f.since }], at: 0 });
  if (f.until !== undefined) items.push({ t: "cmp", key: "until", op: ":", values: [{ raw: String(f.until), quoted: false, kind: "eq", n: f.until }], at: 0 });
  if (top) items.push({ t: "is", name: "root", at: 0 });
  return items.length ? andQuery(q, { t: "and", items }) : q;
}

/**
 * /api/metrics range and split: since/until as epoch ms, a date or an age (30d),
 * default the last 30 days; bucket day|week; by agent|model|repo|flag; tz as
 * Date#getTimezoneOffset minutes. A date without a zone (2026-11-09, yesterday) is midnight in
 * `tz`, the zone the buckets use, or in the server's zone without `tz`. Anything else is a 400.
 */
export function metricsParams(q: URLSearchParams, now = Date.now()): Pick<MetricsSpec, "since" | "until" | "bucket" | "by" | "tzOffsetMin" | "maxGroups"> {
  const tzRaw = q.get("tz");
  let tz: number | undefined;
  if (tzRaw !== null && tzRaw !== "") {
    if (!/^-?\d{1,4}$/.test(tzRaw) || Math.abs(Number(tzRaw)) > 840) throw new HttpError(400, "tz must be minutes from -840 to 840 (Date#getTimezoneOffset)");
    tz = Number(tzRaw);
  }
  const time = (name: string): number | undefined => {
    const raw = q.get(name);
    if (raw === null || raw === "") return undefined;
    const t = /^\d{1,16}$/.test(raw) ? Number(raw) : parseTime(raw, now, tz);
    if (t === undefined || !Number.isFinite(t) || t < 0 || t > 8_640_000_000_000_000) throw new HttpError(400, `${name} must be epoch ms, a date or an age such as 30d`);
    return t;
  };
  const until = time("until") ?? now;
  const since = time("since") ?? until - 30 * DAY_MS;
  if (!(since < until)) throw new HttpError(400, "since must be before until");
  const bucket = q.get("bucket") || "day";
  if (!(METRIC_BUCKETS as readonly string[]).includes(bucket)) throw new HttpError(400, `bucket must be ${METRIC_BUCKETS.join(" or ")}`);
  const by = q.get("by") || undefined;
  if (by !== undefined && !(METRIC_GROUPS as readonly string[]).includes(by)) throw new HttpError(400, `by must be one of ${METRIC_GROUPS.join(", ")}`);
  const maxGroups = q.get("groups") ? intParam(q, "groups", MAX_GROUPS, 1, 50) : MAX_GROUPS;
  return { since, until, bucket: bucket as MetricBucket, ...(by ? { by: by as MetricGroup } : {}), tzOffsetMin: tz ?? 0, maxGroups };
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
 * siblings. Totals apply them all. A `where` query narrows everything,
 * facets and histogram included (its sort: and limit: do not apply).
 */
async function computeStats(index: IndexStore, topLevelOnly = false, project?: string, f: Facets = {}, where?: Query) {
  const only = where?.root ? new Set((await findSessions(index, { root: where.root }, { filter: project ? { project } : {} })).sessions.map((s) => s.id)) : undefined;
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
  let estimatedCostUsd = 0;
  let priced = 0;
  let llmCalls = 0;
  let withTests = 0;
  let testsFailing = 0;
  const inc = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);
  for await (const s of scanSessions(index, project ? { project } : {})) {
    if (only && !only.has(s.id)) continue;
    const all = matchesFacets(s, f);
    if (all) {
      toolCalls += s.stats.toolCalls;
      toolErrors += s.stats.toolErrors;
      llmCalls += s.stats.latency?.llmCalls ?? 0;
      if (typeof s.stats.usage?.costUsd === "number") {
        costUsd += s.stats.usage.costUsd;
        estimatedCostUsd += s.stats.usage.estimatedCostUsd ?? 0;
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
    sessions, subagents, byAgent, byFlag, byRepo, byModel, toolCalls, toolErrors, llmCalls, costUsd, estimatedCostUsd, pricedSessions: priced,
    withTests, testsFailing, histogram: histogram(starts),
  };
}

/** The scores API's view of this caller (src/scores/api.ts). */
function scoresCtx(ctx: ApiCtx): ScoresApiCtx {
  return {
    index: ctx.index,
    by: ctx.labeller,
    project: ctx.project,
    sessionVisible: (sid) => visibleSession(ctx, checkId(sid, "sessionId")).then(() => true, (e) => (e instanceof HttpError && e.status === 404 ? false : Promise.reject(e))),
  };
}

/** Sends a scores API reply; its ScoreErrors become HTTP errors. */
async function sendScores(res: ServerResponse, fn: () => Promise<ApiReply>): Promise<void> {
  let reply: ApiReply;
  try {
    reply = await fn();
  } catch (e) {
    if (e instanceof ScoreError) throw new HttpError(e.status, e.message);
    throw e;
  }
  sendJson(res, reply.status, reply.body);
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

/** A GET through the API router without a socket: the JSON body of a 200, else undefined. */
async function internalGet(ctx: ApiCtx, path: string): Promise<unknown> {
  let status = 0;
  let body = "";
  const res = {
    headersSent: false,
    setHeader() {},
    writeHead(s: number) { status = s; return res; },
    end(b?: string | Buffer) { body = b === undefined ? "" : String(b); },
  } as unknown as ServerResponse;
  const req = { method: "GET", headers: {}, url: path } as unknown as IncomingMessage;
  try {
    await routeApi(req, res, new URL(path, "http://viewer.invalid"), ctx);
  } catch {
    return undefined;
  }
  if (status !== 200) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/**
 * The sessions page's first paint: its rows as HTML and the responses its script asks for
 * first, plus the first row's session when it is small. Read the same way the API answers them.
 */
async function firstPaint(ctx: ApiCtx): Promise<{ main: string; boot: Record<string, unknown> }> {
  const boot: Record<string, unknown> = {};
  const got = await Promise.all(BOOT_LIST_PATHS.map((p) => internalGet(ctx, p)));
  BOOT_LIST_PATHS.forEach((p, k) => { if (got[k] !== undefined) boot[p] = got[k]; });
  const list = got[0] as { items?: Session[]; total?: number } | undefined;
  const items = list?.items ?? [];
  const first = items[0];
  let bytes = JSON.stringify(boot).length;
  if (first && (first.stats.events ?? 0) <= BOOT_SESSION_EVENTS) {
    const paths = sessionBootPaths(first.id);
    const detail = await Promise.all(paths.map((p) => internalGet(ctx, p)));
    const size = JSON.stringify(detail).length;
    if (detail.every((d) => d !== undefined) && bytes + size <= BOOT_MAX_BYTES) {
      paths.forEach((p, k) => { boot[p] = detail[k]; });
      bytes += size;
    }
  }
  return { main: renderSessionsMain(items, list?.total), boot };
}

/** BLOB_RANGE_MAX caps one range read; a bigger one is cut to it (Content-Range says what came back). */
export const BLOB_RANGE_MAX = 4 * 1024 * 1024;

/**
 * `a-b` (inclusive), `a-` (to the end) or `-n` (the last n bytes) against a blob of `size`
 * bytes: the byte span, "unsatisfiable" past the end, or null when there is no range. A
 * malformed range is a 400.
 */
export function blobRange(raw: string | null, size: number): [number, number] | "unsatisfiable" | null {
  if (raw === null || raw === "") return null;
  const m = /^(\d{0,15})-(\d{0,15})$/.exec(raw.trim());
  if (!m || (m[1] === "" && m[2] === "")) throw new HttpError(400, "range must be a-b, a- or -n (bytes)");
  let a: number;
  let b: number;
  if (m[1] === "") {
    const n = Number(m[2]);
    if (n === 0) return "unsatisfiable";
    a = Math.max(0, size - n);
    b = size - 1;
  } else {
    a = Number(m[1]);
    b = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
    if (m[2] !== "" && Number(m[2]) < a) throw new HttpError(400, "range end comes before its start");
  }
  if (a >= size) return "unsatisfiable";
  return [a, Math.min(b, a + BLOB_RANGE_MAX - 1)];
}

function intParam(q: URLSearchParams, name: string, dflt: number, min: number, max: number): number {
  const raw = q.get(name);
  if (raw === null || raw === "") return dflt;
  if (!/^\d+$/.test(raw)) throw new HttpError(400, `${name} must be a non-negative integer`);
  const n = Number(raw);
  if (n < min || n > max) throw new HttpError(400, `${name} must be between ${min} and ${max}`);
  return n;
}

/** Playground POSTs carry a whole conversation: up to 8 MB, where the rest of the API takes 1 MB. */
export const PLAYGROUND_BODY_BYTES = 8 * 1024 * 1024;

/** A playground problem with its status and reason; a provider failure is a 502. */
function playgroundHttpError(e: unknown): never {
  if (e instanceof PlaygroundError) throw new HttpError(e.status, e.message, { reason: e.reason });
  if (e instanceof Error && e.name === "DatasetError") throw new HttpError(400, e.message, { reason: "invalid_request" });
  throw e;
}

/** A fork that can't start (no stored calls, no key) is the caller's to fix: 400 with the reason. */
function forkHttpError(e: unknown): never {
  if (e instanceof Error && e.name === "ForkError") throw new HttpError(400, e.message);
  throw e;
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

async function readJson(req: IncomingMessage, res: ServerResponse, max = MAX_BODY_BYTES): Promise<unknown> {
  const type = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") throw new HttpError(415, "content-type must be application/json");
  const declared = Number(req.headers["content-length"] ?? 0);
  const tooBig = `request body exceeds ${max < 1024 * 1024 ? `${Math.round(max / 1024)} KB` : `${Math.round(max / 1024 / 1024)} MB`}`;
  if (declared > max) {
    res.setHeader("Connection", "close");
    throw new HttpError(413, tooBig);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > max) {
      res.setHeader("Connection", "close");
      throw new HttpError(413, tooBig);
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
