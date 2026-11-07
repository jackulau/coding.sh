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
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { userInfo } from "node:os";
import type { BlobStore, IndexStore, Label, Session, SessionFilter } from "../core/types.ts";
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
}

export type ViewerHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/** The viewer page and /api routes as a request handler (used by `coding.sh ui` and `coding.sh serve`). Never throws. */
export async function createViewerHandler(opts: ViewerHandlerOptions): Promise<ViewerHandler> {
  const page = await loadPage();
  const labeller = currentUser();

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
  if (rest.length > 0) throw new HttpError(404, "not found");

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
      throw new HttpError(404, "not found");
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
      return sendJson(res, 200, { items: await ctx.index.search(text, { limit, agent, ...(project ? { project } : {}) }) });
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

    case "stats": {
      get();
      if (id !== undefined) throw new HttpError(404, "not found");
      return sendJson(res, 200, await computeStats(ctx.index, scopeParam(q) === "top", projectParam(ctx, q)));
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

async function listSessions(index: IndexStore, q: URLSearchParams, project?: string) {
  const limit = intParam(q, "limit", 50, 1, 500);
  const offset = intParam(q, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
  const parent = q.get("parent") || undefined;
  if (parent !== undefined) checkId(parent, "parent");
  const filter: SessionFilter = {
    agent: q.get("agent") || undefined,
    repoRoot: q.get("repo") || undefined,
    flag: q.get("flag") || undefined,
  };
  if (project !== undefined) filter.project = project;
  if (parent !== undefined) filter.parentSessionId = parent;
  else if (scopeParam(q) === "top") filter.parentSessionId = null;
  const text = (q.get("q") ?? "").trim().toLowerCase();
  if (text.length > 500) throw new HttpError(400, "q is too long");
  const result = text
    ? await filterSessions(index, filter, text, limit, offset)
    : page(await index.listSessions({ ...filter, limit: limit + 1, offset }), limit, offset);
  return { ...result, items: await withChildCounts(index, result.items, project) };
}

async function filterSessions(index: IndexStore, filter: SessionFilter, text: string, limit: number, offset: number) {
  // Substring filter over list metadata (title, id, repo, model). Full-text
  // search over prompts and output lives at /api/search.
  const matches: Session[] = [];
  for await (const s of scanSessions(index, filter)) {
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

/**
 * Totals and filter facets. With topLevelOnly, `sessions`, the test counts and
 * every facet count top-level sessions only (what the list shows by default);
 * `subagents` counts child sessions, and tool/cost totals cover every session.
 */
async function computeStats(index: IndexStore, topLevelOnly = false, project?: string) {
  const byAgent: Record<string, number> = {};
  const byFlag: Record<string, number> = {};
  const byRepo: Record<string, number> = {};
  let sessions = 0;
  let subagents = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let costUsd = 0;
  let withTests = 0;
  let testsFailing = 0;
  for await (const s of scanSessions(index, project ? { project } : {})) {
    toolCalls += s.stats.toolCalls;
    toolErrors += s.stats.toolErrors;
    costUsd += s.stats.usage?.costUsd ?? 0;
    if (s.parent) subagents++;
    if (topLevelOnly && s.parent) continue;
    sessions++;
    byAgent[s.agent] = (byAgent[s.agent] ?? 0) + 1;
    for (const f of s.flags) byFlag[f] = (byFlag[f] ?? 0) + 1;
    if (s.repo?.root) byRepo[s.repo.root] = (byRepo[s.repo.root] ?? 0) + 1;
    if (s.stats.testsPassed !== undefined || s.stats.testsFailed !== undefined) {
      withTests++;
      if ((s.stats.testsFailed ?? 0) > 0) testsFailing++;
    }
  }
  return { sessions, subagents, byAgent, byFlag, byRepo, toolCalls, toolErrors, costUsd, withTests, testsFailing };
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
