// The coding.sh MCP tools. Read-mostly, small paginated outputs; each tool has
// an inputSchema, an outputSchema, and annotations. eval_from_session is the
// only write and needs `confirm: true`.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "../core/context.ts";
import type { Session } from "../core/types.ts";
import { failureFlags } from "../core/sessions.ts";
import { createRedactor } from "../core/redact.ts";
import { loadReplay, snapshotBaseline, type Replay } from "../core/replay.ts";
import { buildRunTree, buildSessionTree, pageTree, TREE_PAGE_NODES, worstFirst, worstNode, type Tree, type TreeNode } from "../core/tree.ts";
import { parseSince } from "../cli/args.ts";
import { version } from "../cli/meta.ts";
import { noSessionsHint } from "../cli/first-session.ts";
import { nextStepBin } from "../cli/next-steps.ts";
import { isNewer } from "../update/semver.ts";
import { gateHeadline } from "../stats/gate.ts";
import {
  clip,
  collectSessions,
  countNodes,
  currentByCwd,
  failures,
  iso,
  lastActivity,
  latency,
  pageSessions,
  parsePlace,
  pathPlace,
  placeNode,
  round2,
  scanFilter,
  sessionSummary,
  SESSION_ENV_VARS,
  subagentTree,
  type SubagentNode,
  usage,
  type ScanQuery,
  type UsageGroup,
  USAGE_GROUPS,
} from "./data.ts";
import { sessionDigest } from "./digest.ts";
import { facetCounts, searchWhere } from "../query/run.ts";
import { andQuery, FACET_KEYS, parseWhere, QueryError, QueryUnsupported, scopesSubagents, timeBounds, type Node, type Query } from "../query/where.ts";
import { viewQuery, ViewError } from "../query/views.ts";
import { fitAnswer, pageIndex, pageRange, pageStep } from "./replay-page.ts";
import { toolText, ToolError, type ToolDef } from "./protocol.ts";
import { scoreTools } from "../scores/mcp.ts";
import { needYou, readWorkQueue, settleWorkFiles, WORK_WINDOW_MS, workFiles, workItemJson, workJson } from "../core/work.ts";
import { indexAge, indexAgeField, type IndexAge } from "../core/ingest-health.ts";
import { readOverlay } from "../core/work-overlay.ts";
import { AmbiguousRef, findSessionRef, MIN_ID_PREFIX, shortener } from "../core/session-ref.ts";

type Obj = Record<string, unknown>;

/** What every tool handler gets. */
export interface ToolCtx {
  env: NodeJS.ProcessEnv;
  /** The server's working directory (agents launch MCP servers in the project). */
  cwd: string;
  now(): number;
  /** The opened store, with the spool freshly ingested. */
  store(): Promise<Context>;
}

// ------------------------------------------------------------ schema pieces

// Shared argument descriptions, kept short: every tool definition is sent on every
// turn, and the schema already carries defaults and bounds (LIMIT's default and maximum).
const AGENT = { type: "string", description: "Only this agent." };
const REPO = { type: "string", description: "Only sessions under this path or repo name." };
const SINCE = (d: string) => ({ type: "string", description: `Start: 30m, 12h, 7d, today or a date. Default ${d}.` });
const UNTIL = { type: "string", description: "End. Default now." };
const LIMIT = (d: number, max: number) => ({ type: "integer", minimum: 1, maximum: max, default: d, description: "Rows." });
const CURSOR = { type: "string", description: "From nextCursor." };
const PROJECT = { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,62}$", description: 'Only this project (its `coding.sh serve` ingest key; local is "default").' };
const EXP_SESSION = { type: "string", description: "Default: the project's session." };
const WHERE = {
  type: "string",
  description:
    "Filter query: key:value clauses ANDed; OR, ( ), - negates; a,b either; * wildcard; > >= < <= and a..b on numbers; bare words search text. Keys: agent model repo branch title flag skill cost tokens duration turns tools tool.errors since until has:tests|cost|error is:root|child|flagged; event keys tool kind ok mcp error. E.g. model:claude-* cost>0.5 tool:Bash ok:false",
};
const WHERE_SAME = (what: string) => ({ type: "string", description: `Filter query, same language as sessions_list where${what}.` });
const SESSION_ID = { type: "string", minLength: 1, description: 'Id, prefix or "latest".' };

const input = (properties: Obj, required: string[] = []): Obj => ({ type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false });
const out = (properties: Obj, required: string[] = []): Obj => ({ type: "object", properties, ...(required.length ? { required } : {}) });
/** USD by price tier (`batch`, `long-context`, `priority+long-context`, ...). */
const BY_TIER: Obj = { type: "object", additionalProperties: { type: "number" } };

const S = { type: "string" };
const N = { type: "number" };
const I = { type: "integer" };
const B = { type: "boolean" };
const arr = (items: Obj) => ({ type: "array", items });
/** An experiment's weights stamp (`exp run --weights`): the SHA-256 of the checkpoint its task ran. */
const WEIGHTS_OUT = out({ sha256: S });

// Output schemas name the fields worth knowing about; results may carry more
// (objects are open), which keeps every tool definition cheap to send each turn.
const SESSION_OUT = out({ id: S, agent: S, title: S, startedAt: S, toolErrors: I, flags: arr(S) }, ["id", "agent"]);
const WINDOW_OUT = out({ sessions: I, truncated: B });
const DIGEST_OUT = out(
  {
    session: SESSION_OUT,
    turnCount: I,
    turns: arr(out({ turn: I, prompt: S }, ["turn"])),
    timeline: arr(out({ at: N, kind: S, text: S }, ["at", "kind", "text"])),
    nextCursor: S,
  },
  ["session", "timeline"],
);
const NODE_OUT: Obj = out({ type: S, sessionId: S, children: arr({ $ref: "#/$defs/node" }) });
const TREE_NODE_OUT: Obj = out(
  { sessionId: S, parentSessionId: S, role: S, agent: S, model: S, title: S, depth: I, costUsd: N, inputTokens: I, outputTokens: I, durationMs: N, toolCalls: I, toolErrors: I, flags: arr(S), children: arr({ $ref: "#/$defs/treeNode" }) },
  ["sessionId", "depth", "children"],
);

/**
 * One session_tree node: the session's own numbers plus its subagents. `top`: a page's top level, where a
 * subagent names its parent (it was on an earlier page). `short` gives each id as the shortest reference
 * that resolves (core/session-ref.ts), so a page holds more nodes.
 */
function treeNodeJson(n: TreeNode, short: (id: string) => string, top = false): Obj {
  const s = n.session;
  const u = s.stats.usage;
  const head: Obj = { sessionId: short(s.id) };
  if (top && n.depth > 0 && s.parent?.sessionId) head.parentSessionId = short(s.parent.sessionId);
  return {
    ...head,
    role: n.depth === 0 ? "root" : (s.parent?.type ?? "subagent"),
    agent: s.agent,
    ...(s.model ? { model: s.model } : {}),
    ...(s.title ? { title: clip(s.title, 120) } : {}),
    depth: n.depth,
    ...(u?.costUsd !== undefined ? { costUsd: round2(u.costUsd) } : {}),
    ...(u?.inputTokens !== undefined ? { inputTokens: u.inputTokens } : {}),
    ...(u?.outputTokens !== undefined ? { outputTokens: u.outputTokens } : {}),
    ...(s.endedAt !== undefined ? { durationMs: s.endedAt - s.startedAt } : {}),
    toolCalls: s.stats.toolCalls,
    toolErrors: s.stats.toolErrors,
    flags: worstFirst(s.flags),
    children: n.children.map((c) => treeNodeJson(c, short)),
  };
}

// ------------------------------------------------------------ helpers

/** The longest answer a tool sends, in characters of its text (mcp-builder's CHARACTER_LIMIT). */
export const CHARACTER_LIMIT = 25_000;

/**
 * What a page may take of CHARACTER_LIMIT: the server adds `pending` to an answer after the page is cut
 * (mcp/server.ts, when an ingest is still running), and it must not push a full page over the limit.
 * The longest `pending` is about 65 characters.
 */
export const PAGE_LIMIT = CHARACTER_LIMIT - 100;

/**
 * The page `render(limit)` makes, with fewer rows while its text is over PAGE_LIMIT: the largest
 * n whose page fits. Rows are dropped, never cut, so a cursor of offset + n still points at the first
 * row left out. A shortened page carries `limitUsed`; one that already fit is returned as it is. When
 * not even one row fits (the size is in the fixed part of the answer), the page for `limit` comes back
 * whole with `truncated: true`.
 */
export async function fitPage(limit: number, render: (n: number) => Obj | Promise<Obj>): Promise<Obj> {
  const first = await render(limit);
  const len = toolText(first).length;
  if (len <= PAGE_LIMIT) return first;
  const tooLong = (): Obj => ({ ...first, truncated: true, note: `This answer is over ${CHARACTER_LIMIT.toLocaleString("en-US")} characters even with one row: most of it is not in the rows.` });
  if (limit <= 1) return tooLong();
  const fits = async (n: number): Promise<Obj | undefined> => {
    const page = { ...(await render(n)), limitUsed: n };
    return toolText(page).length <= PAGE_LIMIT ? page : undefined;
  };
  // One row first: when it does not fit, no page does.
  let best = await fits(1);
  if (!best) return tooLong();
  // The length grows with n: bisect for the largest n that fits, probing an estimate first.
  let lo = 1;
  let hi = limit;
  for (let n = Math.min(limit - 1, Math.max(2, Math.floor((limit * PAGE_LIMIT * 0.9) / len))); hi - lo > 1; n = lo + Math.floor((hi - lo) / 2)) {
    const page = await fits(n);
    if (page) [lo, best] = [n, page];
    else hi = n;
  }
  return best;
}

/**
 * eval init's errors name its CLI flags; over MCP they name eval_init's arguments,
 * so the calling agent can fix its call. Flags with no argument stay as they are.
 */
export function initErrorArgs(msg: string): string {
  return msg
    .replace(/--command '<cmd>'/g, "`command`")
    .replace(/--url <URL>/g, "`url`")
    .replace(/--skill <DIR>/g, "`skill`")
    .replace(/--session <id>/g, "`sessionIds`")
    .replace(/--cases <FILE> \(JSONL of \{"input", "expected"\}\)/g, '`cases` ([{"input", "expected"}])')
    // eval_init has no --draft: the calling agent writes the cases itself.
    .replace(/, or --describe '<what the app does>' --draft to have a model write them/g, "")
    .replace(/--(command|url)\b(?!-)/g, "`$1`")
    .replace(/--force\b(?!-)/g, "`force: true`");
}

/** The rows a tool with a `limit` returns when none is passed, where the schema's default does not say. */
const LIMIT_DEFAULTS: Record<string, (a: Obj) => number> = { benchmarks: (a) => (a.metric ? 30 : 5) };

/**
 * A tool whose costly part (reading a long session) does not depend on `limit`: `pages` does it once
 * and returns the page for any row count, so fitting a page to PAGE_LIMIT does not read it again.
 */
type PagedTool = ToolDef<ToolCtx> & { pages?(a: Obj, c: ToolCtx): Promise<(n: number) => Obj> };

/** A read-only tool with a `limit` argument, run again with a smaller limit when its answer is too long. */
function withCharacterLimit(t: PagedTool): ToolDef<ToolCtx> {
  const limit = (t.inputSchema.properties as Record<string, { default?: unknown }> | undefined)?.limit;
  if (!limit || t.annotations.readOnlyHint !== true || t.annotations.idempotentHint !== true) return t;
  const outProps = (t.outputSchema.properties ?? {}) as Obj;
  return {
    ...t,
    outputSchema: { ...t.outputSchema, properties: { ...outProps, limitUsed: I } },
    run(a, c) {
      const asked = typeof a.limit === "number" ? a.limit : typeof limit.default === "number" ? limit.default : LIMIT_DEFAULTS[t.name]?.(a);
      if (asked === undefined) return t.run(a, c);
      if (t.pages) return t.pages(a, c).then((page) => fitPage(asked, page));
      return fitPage(asked, (n) => t.run(n === a.limit ? a : { ...a, limit: n }, c));
    },
  };
}

/** What session_replay's text may take of PAGE_LIMIT: the rest is for `limitUsed` and the page's own keys. */
const REPLAY_TEXT_LIMIT = PAGE_LIMIT - 60;

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

function strArg(a: Obj, k: string): string | undefined {
  const v = a[k];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function numArg(a: Obj, k: string, d: number): number {
  const v = a[k];
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}

function cursorArg(a: Obj): number {
  const c = strArg(a, "cursor");
  if (c === undefined) return 0;
  if (!/^\d{1,9}$/.test(c)) throw new ToolError(`Invalid cursor ${JSON.stringify(c)}: pass the nextCursor value from the previous call unchanged.`);
  return Number(c);
}

/** The `where` argument, parsed; a bad query is a tool error naming where it broke. */
function whereArg(a: Obj, now: number): Query | undefined {
  const raw = strArg(a, "where");
  if (raw === undefined) return undefined;
  try {
    return parseWhere(raw, { now });
  } catch (e) {
    throw queryToolError(e);
  }
}

/**
 * The where query with an `agent:` clause on the session's agent. Wrapped in a group, as the CLI's
 * --agent is, so it filters like SessionFilter.agent and a facet does not drop it.
 */
function agentWhere(agent: string, where: Query | undefined): Query {
  const cmp: Node = { t: "cmp", key: "agent", op: ":", values: [{ raw: agent, quoted: true, kind: "eq" }], at: 0 };
  return andQuery(where ?? {}, { t: "or", items: [cmp] });
}

function queryToolError(e: unknown): unknown {
  if (e instanceof QueryError) return new ToolError(`Invalid where at character ${e.offset + 1}: ${e.message}.${e.next.length ? ` ${e.next.join("; ")}` : ""}`, { reason: e.reason, offset: e.offset });
  if (e instanceof QueryUnsupported) return new ToolError(e.message, { reason: e.reason });
  return e;
}

function viewToolError(e: unknown): unknown {
  if (e instanceof ViewError) return new ToolError(e.reason === "unknown_view" ? `${e.message} Save one with coding.sh views save <name> --where <query>.` : e.message, { reason: e.reason });
  return queryToolError(e);
}

function when(a: Obj, k: string, now: number, dflt?: string): number | undefined {
  const v = strArg(a, k) ?? dflt;
  if (v === undefined) return undefined;
  try {
    return parseSince(v, now);
  } catch {
    throw new ToolError(`Invalid ${k} ${JSON.stringify(v)}: use a duration like 30m, 12h, 7d, 2w, today, yesterday or a date like 2026-01-31 (local time).`);
  }
}

function query(a: Obj, c: ToolCtx, o: { sinceDefault?: string; topLevel: boolean }): ScanQuery {
  const now = c.now();
  const repo = strArg(a, "repo");
  const until = when(a, "until", now);
  // With only until, the default window ends at until, not at now: usage {until: "2026-01-01"} is the 7 days before it.
  const since = strArg(a, "since") === undefined && until !== undefined && o.sinceDefault !== undefined ? until - (now - when(a, "since", now, o.sinceDefault)!) : when(a, "since", now, o.sinceDefault);
  // An empty window is a mistake, not an empty answer: the CLI says "--since must be before --until".
  if (since !== undefined && until !== undefined && !(since < until)) {
    const at = (k: string, ms: number) => `${k} ${strArg(a, k) ?? o.sinceDefault} is ${iso(ms)}`;
    // Equal times make an empty window, which swapping does not change.
    const fix = since === until ? "The window is empty: make until later than since" : "Swap them";
    throw new ToolError(`since must be before until: ${at("since", since)}, ${at("until", until)}. ${fix}, or omit until for a window that ends now.`, { reason: "invalid_argument" });
  }
  const q: ScanQuery = { topLevel: o.topLevel };
  const agent = strArg(a, "agent");
  if (agent) q.agent = agent;
  const project = strArg(a, "project");
  if (project) q.project = project;
  if (since !== undefined) q.since = since;
  if (until !== undefined) q.until = until;
  if (repo) q.place = parsePlace(repo, c.cwd, c.env.HOME || c.env.USERPROFILE || "/");
  return q;
}

/** The experiment session: the `session` arg, else CODING_SH_EXP_SESSION or the nearest .coding-sh/session.json above the server's cwd. */
async function expSession(a: Obj, c: ToolCtx): Promise<{ session: { id: string; name?: string; createdAt?: number }; root: string }> {
  const [{ findSession, timelinePath }, { paths }] = await Promise.all([import("../experiments/session.ts"), import("../core/paths.ts")]);
  const root = paths(c.env).root;
  const id = strArg(a, "session");
  const session = id ? { id } : findSession({ cwd: c.cwd, env: c.env });
  if (!session) {
    throw new ToolError(`No experiment session in ${c.cwd}. Ask the user to start one there: coding.sh exp session new --name <topic>`, {
      reason: "not_found",
      next: "coding.sh exp session new --name <topic>",
    });
  }
  try {
    timelinePath(root, session.id);
  } catch (e) {
    throw new ToolError(`${e instanceof Error ? e.message : String(e)}: pass the id from exp session summary, or omit session.`);
  }
  return { session, root };
}

/** How long one read of the store's ids serves the short ids of later answers: fitPage renders a page several times. */
const SHORT_IDS_MS = 5_000;
const shortIdCache = new WeakMap<object, { at: number; get: Promise<(id: string) => string> }>();

/** The shortest id that resolves for each stored session (core/session-ref.ts shortener), read at most once per SHORT_IDS_MS. */
function shortIds(ctx: Context): Promise<(id: string) => string> {
  const now = Date.now();
  const hit = shortIdCache.get(ctx.index);
  if (hit && now - hit.at < SHORT_IDS_MS) return hit.get;
  const get = shortener(ctx.index);
  shortIdCache.set(ctx.index, { at: now, get });
  get.catch(() => shortIdCache.delete(ctx.index));
  return get;
}

/** The session `id` names, as the CLI resolves it (core/session-ref.ts): exact, "latest", an x_ alias, a unique prefix, an SDK id or a subagent's id. */
async function resolveSession(ctx: Context, id: string): Promise<Session> {
  let s: Session | undefined;
  try {
    s = await findSessionRef(ctx.index, id);
  } catch (e) {
    if (!(e instanceof AmbiguousRef)) throw e;
    const list = e.candidates.map((x) => `${x.shortId} (${x.agent}, ${iso(x.startedAt)}${x.title ? `, ${JSON.stringify(clip(x.title, 60))}` : ""})`);
    const candidates = e.candidates.map((x) => {
      const c: Record<string, unknown> = { sessionId: x.id, shortId: x.shortId, agent: x.agent, startedAt: iso(x.startedAt) };
      if (x.title) c.title = clip(x.title, 120);
      return c;
    });
    const data: Record<string, unknown> = { reason: "ambiguous", candidates };
    if (e.more) data.more = true;
    throw new ToolError(`Session id prefix ${JSON.stringify(id)} matches more than one session: ${list.join("; ")}${e.more ? "; and more" : ""}. Pass one of these ids, or more of the id.`, data);
  }
  if (s) return s;
  if (id === "latest" || id === "last") throw new ToolError(noSessionsHint(ctx.env));
  const short = id.length < MIN_ID_PREFIX ? ` A prefix needs at least ${MIN_ID_PREFIX} characters.` : "";
  throw new ToolError(`No session with id ${JSON.stringify(id)}.${short} Find ids with sessions_list or search; a unique prefix of an id works too.`);
}

/**
 * A tail page of a digest: the `limit` entries before entry `before` (default: the end), oldest
 * first, and a nextCursor naming the first of them while older ones are left. The cursor is an index
 * from the start, so the entries a running session appends after the first page never shift it, and
 * a page cut short to fit (limitUsed) still hands on the first entry it left out.
 */
/**
 * A session_get tail cursor: the first entry of the last page, and for a session past
 * DIGEST_EVENT_CAP the window of events that page read ("<entry>@<first event>:<turns before it>").
 * The window stays put while the session grows, so the next page neither repeats nor skips entries.
 */
interface TailCursor {
  before: number;
  window?: { start: number; turnShift: number };
}

function tailCursorArg(a: Obj): TailCursor | undefined {
  const c = strArg(a, "cursor");
  if (c === undefined) return undefined;
  const m = /^(\d{1,9})(?:@(\d{1,12}):(\d{1,9}))?$/.exec(c);
  if (!m) throw new ToolError(`Invalid cursor ${JSON.stringify(c)}: pass the nextCursor value from the previous call unchanged.`);
  const cursor: TailCursor = { before: Number(m[1]) };
  if (m[2] !== undefined) cursor.window = { start: Number(m[2]), turnShift: Number(m[3]) };
  return cursor;
}

function tailPage(d: Obj & { timeline: unknown[] }, before: number | undefined, limit: number, window?: { start: number; turnShift: number }): void {
  const end = Math.min(before ?? d.timeline.length, d.timeline.length);
  const start = Math.max(0, end - limit);
  d.timeline = d.timeline.slice(start, end);
  if (start > 0) d.nextCursor = window && window.start > 0 ? `${start}@${window.start}:${window.turnShift}` : String(start);
  else delete d.nextCursor;
}

/** session_get: the session is read and its timeline built once; each page is a slice of it. */
async function sessionGetPages(a: Obj, c: ToolCtx): Promise<(limit: number) => Obj> {
  const ctx = await c.store();
  // Turns are 1-based; 0 names no turn, so it is refused rather than read as "the whole session".
  if (a.turn === 0) throw new ToolError("turn must be 1..N (1-based) or negative from the end (-1 = last turn); turn 0 does not exist. Omit turn for the whole session.");
  const s = await resolveSession(ctx, strArg(a, "sessionId")!);
  const tail = a.tail === true;
  const offset = tail ? 0 : cursorArg(a);
  const cursor = tail ? tailCursorArg(a) : undefined;
  const turn = typeof a.turn === "number" ? a.turn : undefined;
  // A tail cursor reads the window its first page read: a plain one came from a session within the cap, read from event 0.
  const pin = cursor && turn === undefined ? { windowStart: cursor.window?.start ?? 0, turnShift: cursor.window?.turnShift ?? 0 } : {};
  const window = { start: 0, turnShift: 0 };
  try {
    // The whole timeline from the cursor on (with tail, all of it) comes back and is paged here.
    const digest = await sessionDigest(ctx.index, s, { turn, limit: Number.MAX_SAFE_INTEGER, offset, from: tail ? "tail" : "head", now: c.now(), ...pin, window });
    // The experiments that ran each weights file the session recorded as a checkpoint, as `coding.sh show --json` has them.
    const hashes = s.stats.weightEdits?.checkpoints;
    if (hashes?.length) {
      const [{ FileEvalStore }, { checkpointRuns }] = await Promise.all([import("../datasets/store.ts"), import("../experiments/checkpoints.ts")]);
      const runs = await checkpointRuns(new FileEvalStore({ env: c.env, index: ctx.index }), hashes);
      if (runs.length) digest.checkpointExperiments = runs;
    }
    const rows = digest.timeline;
    const total = typeof digest.timelineTotal === "number" ? digest.timelineTotal : rows.length;
    return (limit: number): Obj => {
      const page: Obj & { timeline: unknown[] } = { ...digest, timeline: rows };
      // With tail, from the end toward the start; otherwise from the cursor on.
      if (tail) tailPage(page, cursor?.before, limit, turn === undefined ? window : undefined);
      else {
        page.timeline = rows.slice(0, limit);
        delete page.nextCursor;
        if (offset + limit < total) page.nextCursor = String(offset + limit);
      }
      return page;
    };
  } catch (e) {
    if (e instanceof RangeError) throw new ToolError(e.message);
    throw e;
  }
}

/** session_replay's fork: step N's stored model call sent once more with the given context files (`""` drops one). Loaded on use. */
async function forkTool(ctx: Context, env: NodeJS.ProcessEnv, s: Session, replay: Replay, step: number, files: unknown): Promise<Obj> {
  if (typeof files !== "object" || files === null || Array.isArray(files) || !Object.values(files).every((v) => typeof v === "string")) {
    throw new ToolError('fork is an object of context file paths to their new text, e.g. {"AGENTS.md": "…"}; "" drops a file.');
  }
  const [{ ForkError, viewerForks }, { proxySettings }, { pricesFor }] = await Promise.all([import("../experiments/fork.ts"), import("../proxy/state.ts"), import("../core/pricing.ts")]);
  try {
    const forks = viewerForks({ index: ctx.index, blobs: ctx.blobs, env, prices: pricesFor(ctx.config.pricing), upstreams: proxySettings(env).upstreams });
    return { ...(await forks.run(s, replay, step, files as Record<string, string>, 1)) };
  } catch (e) {
    if (e instanceof ForkError) throw new ToolError(e.message);
    throw e;
  }
}

function readUpdateCache(file: string): Obj | undefined {
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined;
  } catch {
    return undefined;
  }
}

/** The status tool lists this many work items at most; `coding.sh work --json` lists the rest. */
export const STATUS_WORK_ROWS = 5;

/**
 * The index's age (core/ingest-health.ts). A store named by CODING_SH_STORE_URL is filled
 * elsewhere, so this home's record says nothing about it: undefined then, as `coding.sh work` does.
 */
function storeIndexAge(ctx: Context, now: number): IndexAge | undefined {
  return ctx.storeOverridden ? undefined : indexAge(ctx.paths.root, now);
}

/** `index: { updatedAt, ageMs, stale? }` for a tool answer, absent without a record. */
function indexField(age: IndexAge | undefined): { index?: Obj } {
  const f = indexAgeField(age);
  return f.index && age ? { index: { ...f.index, ageMs: age.ageMs } } : {};
}

/**
 * work: the queue `coding.sh work --json` prints, read once; each page is a slice of its items.
 * A stale index judges waits and stalls as of its last ingest, as the CLI does.
 */
async function workPages(a: Obj, c: ToolCtx): Promise<(limit: number) => Obj> {
  const ctx = await c.store();
  const now = c.now();
  const since = when(a, "since", now, "7d")!;
  const all = a.all === true;
  const offset = cursorArg(a);
  const asked = numArg(a, "limit", 20);
  const age = storeIndexAge(ctx, now);
  const stale = age?.stale ? age : undefined;
  const { queue, sessions, truncated } = await readWorkQueue(ctx.index, { since, all, now: stale?.at ?? now, overlay: readOverlay(ctx.paths.work), shortId: await shortIds(ctx) });
  // The page counts and names each item's files as work --json and work show do (core/work.ts settleWorkFiles).
  await settleWorkFiles(ctx.index, queue.items.slice(offset, offset + asked), sessions, stale?.at ?? now);
  return (limit: number): Obj => {
    const doc = workJson(queue, { since, limit: offset + limit, truncated });
    const items = (doc.items as Obj[]).slice(offset);
    const page: Obj = { ...doc, items };
    if (offset + limit < queue.items.length) page.nextCursor = String(offset + limit);
    if (stale) page.asOf = iso(stale.at);
    return { ...page, ...indexField(age) };
  };
}

/**
 * Update availability from the cache the update checker keeps (no network here).
 * `command` names the CLI the way the user's shell runs it (nextStepBin of `env`,
 * the environment the agent started this server with).
 */
export function updateInfo(home: string, current = version(), env: NodeJS.ProcessEnv = process.env): Obj {
  const c = readUpdateCache(join(home, "update.json"));
  const latest = typeof c?.latest === "string" ? c.latest : undefined;
  const available = isNewer(latest, current);
  const install = typeof c?.install === "string" ? c.install : undefined;
  return {
    current,
    latest,
    available,
    checkedAt: typeof c?.checkedAt === "number" ? iso(c.checkedAt) : undefined,
    url: available && typeof c?.url === "string" ? c.url : undefined,
    install: available && install ? `npm install -g ${install}` : undefined,
    command: available ? `${nextStepBin(env)} update` : undefined,
  };
}

function spoolStats(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  if (!existsSync(dir)) return { files, bytes };
  for (const agent of readdirSync(dir)) {
    const sub = join(dir, agent);
    try {
      if (!statSync(sub).isDirectory()) continue;
      for (const f of readdirSync(sub)) {
        if (!f.endsWith(".jsonl")) continue;
        files++;
        bytes += statSync(join(sub, f)).size;
      }
    } catch {
      continue;
    }
  }
  return { files, bytes };
}

function lastSpoolError(file: string): Obj | undefined {
  try {
    const st = statSync(file);
    const text = readFileSync(file, "utf8");
    const last = text.trimEnd().split("\n").pop();
    if (!last) return undefined;
    const e = JSON.parse(last) as Obj;
    return { at: typeof e.ts === "number" ? iso(e.ts) : undefined, error: clip(e.error, 200), bytes: st.size };
  } catch {
    return undefined;
  }
}

/**
 * Child (subagent) sessions a top-level sessions_list leaves out that its filters match: one facet
 * query, as `coding.sh sessions` counts them. 0 when the store cannot count them.
 */
async function hiddenChildren(index: Context["index"], q: ScanQuery, where: Query | undefined, flagged: boolean): Promise<number> {
  // The where in a group, so the agent facet keeps a typed agent: clause.
  let root: Query = andQuery(where?.root ? { root: { t: "or", items: [where.root] } } : {}, { t: "is", name: "child", at: 0 });
  root = andQuery(andQuery(root, q.place ? placeNode(q.place) : undefined), flagged ? { t: "is", name: "flagged", at: 0 } : undefined);
  try {
    const r = await facetCounts(index, root, ["agent"], { filter: scanFilter({ ...q, topLevel: false }), limit: 1000 });
    return (r.agent ?? []).reduce((n, x) => n + x.count, 0);
  } catch {
    return 0;
  }
}

/**
 * The time bounds a sessions_list read, as `coding.sh sessions --json` reports them: since and until
 * and the where's since:/until: clauses, the tighter of each. Undefined when it read all time.
 * Without since the list starts at the first session (the default is all time, not 7 days).
 */
function listWindow(q: ScanQuery, where: Query | undefined): Obj | undefined {
  const t = timeBounds(where);
  const since = Math.max(q.since ?? -Infinity, t.since ?? -Infinity);
  const until = Math.min(q.until ?? Infinity, t.until ?? Infinity);
  if (!Number.isFinite(since) && !Number.isFinite(until)) return undefined;
  const out: Obj = {};
  if (Number.isFinite(since)) out.since = iso(since);
  if (Number.isFinite(until)) out.until = iso(until);
  return out;
}

// ------------------------------------------------------------ tools

export function buildTools(): ToolDef<ToolCtx>[] {
  return toolDefs().map(withCharacterLimit);
}

function toolDefs(): PagedTool[] {
  return [
    {
      name: "sessions_list",
      title: "List sessions",
      description:
        "List captured agent sessions, newest first, with turns, tool calls/errors, tokens, cost, failure flags and derails (where and when a run went off the rails). For text inside sessions use search.",
      inputSchema: input({
        agent: AGENT,
        repo: REPO,
        since: SINCE("all time"),
        until: UNTIL,
        flag: { type: "string", description: "Only sessions with this flag (premature-completion, no-verification, looping, …) or tag (skill:<name>)." },
        flagged: { type: "boolean", description: "Only sessions with any failure flag." },
        where: WHERE,
        view: { type: "string", description: "A saved view (views list); ANDed with where." },
        facets: { type: "array", items: { type: "string", enum: [...FACET_KEYS] }, description: "Also count matching sessions per value of these keys." },
        includeSubagents: { type: "boolean", default: false, description: "Also list subagent sessions. A where naming id:, parent: or is:child picks them itself." },
        project: PROJECT,
        limit: LIMIT(20, 100),
        cursor: CURSOR,
      }),
      outputSchema: out({ sessions: arr(SESSION_OUT), facets: { type: "object" }, nextCursor: S, truncated: B, hiddenChildren: I, window: { type: "object" } }, ["sessions"]),
      annotations: READ,
      async run(a, c) {
        const ctx = await c.store();
        const typed = whereArg(a, c.now());
        const viewName = strArg(a, "view");
        const where = viewName === undefined ? typed : await viewQuery(ctx.index, viewName, typed, { now: c.now() }).then((r) => r.query, (e) => Promise.reject(viewToolError(e)));
        // A where that names id:, parent:, is:root or is:child picks subagents itself, as the CLI's --where does.
        const q = query(a, c, { topLevel: a.includeSubagents !== true && !scopesSubagents(where?.root) });
        const flag = strArg(a, "flag");
        if (flag) q.flag = flag;
        if (a.flagged === true) q.where = (s) => failureFlags(s.flags).length > 0;
        if (where) q.query = where;
        const offset = cursorArg(a);
        const limit = numArg(a, "limit", 20);
        const keys = Array.isArray(a.facets) ? a.facets.filter((k): k is string => typeof k === "string") : [];
        try {
          const p = await pageSessions(ctx.index, q, offset, limit);
          const facets = keys.length ? await facetCounts(ctx.index, andQuery(andQuery(where ?? {}, q.place ? placeNode(q.place) : undefined), a.flagged === true ? { t: "is", name: "flagged", at: 0 } : undefined), keys, { filter: scanFilter(q), limit: 10 }) : undefined;
          const hidden = q.topLevel ? await hiddenChildren(ctx.index, q, where, a.flagged === true) : 0;
          const now = c.now();
          const page: Obj = {
            sessions: p.sessions.map((s) => sessionSummary(s, now)),
            ...(facets ? { facets } : {}),
            ...(p.hasMore ? { nextCursor: String(offset + limit) } : {}),
            ...(p.truncated ? { truncated: true } : {}),
          };
          const win = listWindow(q, where);
          if (win) page.window = win;
          if (hidden) {
            page.hiddenChildren = hidden;
            page.note = `${hidden} child ${hidden === 1 ? "session" : "sessions"} not shown: pass includeSubagents: true to list them.`;
          }
          return page;
        } catch (e) {
          throw queryToolError(e);
        }
      },
    },
    {
      name: "session_get",
      title: "Get a session",
      description:
        "A session digest: summary (with waste: repeated reads and prompt-cache breaks), skills used, per-turn index, and a timeline of prompts, replies, tool calls (with failures and durations), model calls, file changes, tests and weight edits. Pass turn to zoom in; page with cursor (with tail, backward).",
      inputSchema: input(
        {
          sessionId: SESSION_ID,
          turn: { type: "integer", description: "Only this turn (1-based; -1 = last turn)." },
          limit: LIMIT(40, 200),
          cursor: CURSOR,
          tail: { type: "boolean", default: false, description: "Show the last entries; nextCursor pages back. Default false." },
        },
        ["sessionId"],
      ),
      // With tail, nextCursor pages back (session_current's digest does not page).
      outputSchema: { ...DIGEST_OUT, properties: { ...(DIGEST_OUT.properties as Obj), nextCursor: { type: "string", description: "With tail: older entries." } } },
      annotations: READ,
      async run(a, c) {
        return (await sessionGetPages(a, c))(numArg(a, "limit", 40));
      },
      pages: sessionGetPages,
    },
    {
      name: "session_current",
      title: "Current session",
      description:
        "The calling agent's session: by session id env var, else one in this directory or repo (subagents and worktrees too), active in the last 30 min first, else newest. Its summary and latest timeline.",
      inputSchema: input({
        cwd: { type: "string", description: "Working directory to match. Default: the MCP server's directory (your project)." },
        limit: LIMIT(15, 100),
      }),
      outputSchema: out({ matchedBy: { type: "string", enum: ["env", "cwd-running", "cwd-recent"] }, ...(DIGEST_OUT.properties as Obj) }, ["matchedBy", "session", "timeline"]),
      annotations: READ,
      async run(a, c) {
        const ctx = await c.store();
        const limit = numArg(a, "limit", 15);
        const cwdArg = strArg(a, "cwd");
        if (!cwdArg) {
          for (const k of SESSION_ENV_VARS) {
            const id = c.env[k];
            if (!id) continue;
            const s = await ctx.index.getSession(id);
            if (s) return { matchedBy: "env", ...(await sessionDigest(ctx.index, s, { limit, offset: 0, from: "tail", now: c.now() })) };
          }
        }
        const cwd = cwdArg ?? c.cwd;
        const hit = await currentByCwd(ctx.index, cwd, c.now());
        if (!hit) {
          // An empty store: the agent is in its first session since init (or init never ran). Say which.
          if (!(await ctx.index.listSessions({ limit: 1 })).length) throw new ToolError(noSessionsHint(ctx.env));
          throw new ToolError(`No captured session ran in ${cwd}. Check capture with the status tool, or find the session with sessions_list.`);
        }
        return { matchedBy: hit.matchedBy, cwd, ...(await sessionDigest(ctx.index, hit.session, { limit, offset: 0, from: "tail", now: c.now() })) };
      },
    },
    {
      name: "session_replay",
      title: "Replay a session",
      description:
        "A session as numbered steps, with the files the agent touched rebuilt from its tool calls as of any step. No step: the step list. Paged by files; cut text says truncated.",
      inputSchema: input(
        {
          sessionId: SESSION_ID,
          step: { type: "integer", minimum: 1, description: "One step (1-based): what it did, its diff and the files so far." },
          file: { type: "string", minLength: 1, description: "With step: this file as of that step." },
          from: { type: "integer", minimum: 1, description: "With to: the first step of a range." },
          to: { type: "integer", minimum: 1, description: "With from: the last step (included); each file's diff over the range." },
          fork: { type: "object", description: 'With step: send its model call again with these files ({"AGENTS.md": text}); recorded vs forked next action. Calls the model.' },
          limit: { ...LIMIT(100, 1000), description: "Max files per page (fewer when they are long)." },
          cursor: CURSOR,
        },
        ["sessionId"],
      ),
      outputSchema: out({ sessionId: S, steps: { description: "The step list, or (with step) how many steps there are." }, files: { type: "array" }, total: I, treeTotal: I, changesTotal: I, filesTotal: I, unchanged: arr(S), unchangedTotal: I, step: { type: "object" }, changes: { type: "array" }, tree: { type: "array" }, file: { type: "object" }, from: I, to: I, nextCursor: S, limitUsed: I, truncated: { type: "boolean" }, note: S, trials: { type: "array" } }, ["sessionId"]),
      annotations: { ...READ, idempotentHint: false, openWorldHint: true },
      async run(a, c) {
        const ctx = await c.store();
        const s = await resolveSession(ctx, strArg(a, "sessionId")!);
        const redactor = createRedactor({ redact: ctx.config.capture.redact, patterns: ctx.config.capture.redactPatterns, env: ctx.env });
        // 16 KB of a file and of each diff keeps a step's view near CHARACTER_LIMIT; contentTruncated and diffTruncated say when they were cut.
        const replay = await loadReplay(ctx, s, { baseline: snapshotBaseline(s, ctx.env, redactor), maxContentBytes: 16 * 1024, maxDiffBytes: 16 * 1024 });
        const total = replay.steps.length;
        const stepArg = (k: string): number | undefined => {
          const v = a[k];
          if (v === undefined) return undefined;
          if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > total) throw new ToolError(`${k} must be a step number from 1 to ${total}.`);
          return v;
        };
        const step = stepArg("step");
        const from = stepArg("from");
        const to = stepArg("to");
        const offset = cursorArg(a);
        const limit = numArg(a, "limit", 100);
        if (from !== undefined || to !== undefined) {
          if (from === undefined || to === undefined) throw new ToolError("Pass both from and to for a range.");
          const range = await replay.range(from, to);
          return pageRange(range, offset, limit, REPLAY_TEXT_LIMIT);
        }
        if (a.fork !== undefined) {
          if (step === undefined) throw new ToolError("fork needs a step.");
          return fitAnswer({ ...(await forkTool(ctx, c.env, s, replay, step, a.fork)) }, REPLAY_TEXT_LIMIT);
        }
        const file = strArg(a, "file");
        if (step !== undefined) {
          const view = await replay.at(step, { file });
          return pageStep(view, offset, limit, REPLAY_TEXT_LIMIT);
        }
        if (file) throw new ToolError("file needs a step.");
        const index = replay.index();
        return pageIndex(index, offset, limit, REPLAY_TEXT_LIMIT);
      },
    },
    {
      name: "search",
      title: "Search sessions",
      description: "Full-text search over captured prompts, replies and tool input/output. Returns matching events with session ids and snippets; open one with session_get.",
      inputSchema: input({ query: { type: "string", minLength: 1, description: "Words to find (all must match)." }, agent: AGENT, project: PROJECT, where: WHERE_SAME("; event keys apply to the hit"), limit: LIMIT(10, 50), cursor: CURSOR }, ["query"]),
      outputSchema: out({ hits: arr(out({ sessionId: S, kind: S, snippet: S }, ["sessionId", "kind", "snippet"])), nextCursor: S }, ["hits"]),
      annotations: READ,
      async run(a, c) {
        const ctx = await c.store();
        const offset = cursorArg(a);
        const limit = numArg(a, "limit", 10);
        const agent = strArg(a, "agent");
        const project = strArg(a, "project");
        // agent picks sessions by the session's agent or host, as sessions_list and `coding.sh search --agent` do:
        // a Claude Code session hosted by T3 Code matches claude-code and t3code.
        const userWhere = whereArg(a, c.now());
        const where = agent ? agentWhere(agent, userWhere) : userWhere;
        const opts = { limit: offset + limit + 1, ...(project ? { project } : {}) };
        const text = strArg(a, "query") ?? "";
        const raw = where ? await searchWhere(ctx.index, text, where, opts).catch((e) => Promise.reject(queryToolError(e))) : await ctx.index.search(text, opts);
        const page = raw.slice(offset, offset + limit);
        const sessions = new Map<string, { title?: string; agent?: string }>();
        const short = page.length ? await shortIds(ctx) : (id: string) => id;
        for (const h of page) {
          if (sessions.has(h.event.sessionId)) continue;
          const s = await ctx.index.getSession(h.event.sessionId);
          sessions.set(h.event.sessionId, { title: clip(s?.title, 80), agent: s?.agent });
        }
        // A hit keeps its session's full id, the one an agent compares and keeps; shortId beside it is the shortest that resolves today.
        // shortId, like eventId and at, is not in the output schema: every declared byte costs context in every turn (test/mcp/toolevals.test.ts).
        return {
          hits: page.map((h) => {
            const s = sessions.get(h.event.sessionId);
            return { sessionId: h.event.sessionId, shortId: short(h.event.sessionId), eventId: h.event.id, agent: s?.agent ?? h.event.agent, kind: h.event.kind, at: iso(h.event.ts), snippet: clip(h.snippet, 240) ?? "", sessionTitle: s?.title };
          }),
          ...(raw.length > offset + limit ? { nextCursor: String(offset + limit) } : {}),
        };
      },
    },
    {
      name: "improve",
      title: "What to fix first",
      description:
        "Start here to improve the agent setup: what goes wrong most in this repo's sessions, each with an example session, the AGENTS.md/CLAUDE.md line that fixes it and next commands, plus whether recent changes helped.",
      inputSchema: input({
        repo: { type: "string", description: 'Repo path or folder name; "all" for every repo. Default: the server\'s repo.' },
        since: SINCE("14d"),
        agent: AGENT,
        headless: { type: "boolean", description: "Also headless runs (claude -p, codex exec)." },
        limit: LIMIT(5, 20),
      }),
      outputSchema: out({ scope: out({ sessions: I }), issues: arr(out({ rank: I, id: S, title: S, line: S, next: arr(S) }, ["rank", "id", "title", "next"])), changes: arr(out({ commit: S, verdict: S }, ["commit", "verdict"])) }, ["scope", "issues", "changes"]),
      annotations: READ,
      async run(a, c) {
        const ctx = await c.store();
        const { improveReport } = await import("./improve.ts");
        const limit = a.limit === undefined ? undefined : numArg(a, "limit", 5);
        return improveReport(ctx, { repo: strArg(a, "repo"), since: strArg(a, "since"), agent: strArg(a, "agent"), ...(limit ? { limit } : {}), ...(a.headless === true ? { headless: true } : {}) }, { cwd: c.cwd, env: c.env, now: c.now() });
      },
    },
    {
      name: "harness_changes",
      title: "Did an AGENTS.md change help?",
      description:
        "Did a committed AGENTS.md, CLAUDE.md, rule or skill change help? Per change: lines added, flagged sessions before vs after (and which after, with flags), how often the agent follows each new line, and a verdict. No model calls. Default 30d.",
      inputSchema: input({
        repo: { type: "string", description: "Repo path or folder name. Default: the server's repo." },
        commit: { type: "string", description: "Only this change: a commit sha or prefix." },
        since: SINCE("30d"),
        agent: AGENT,
        limit: LIMIT(5, 20),
      }),
      outputSchema: out({ repo: S, changes: arr(out({ commit: S, verdict: S, reason: S, before: out({ sessions: I, flagged: I }), after: out({ sessions: I, flagged: I, flaggedSessions: arr(out({ sessionId: S, flags: arr(S) }, ["sessionId", "flags"])), moreFlagged: I }) }, ["commit", "verdict", "reason"])) }, ["repo", "changes"]),
      annotations: READ,
      async run(a, c) {
        const ctx = await c.store();
        const { harnessChangesReport } = await import("./improve.ts");
        const limit = a.limit === undefined ? undefined : numArg(a, "limit", 5);
        return harnessChangesReport(ctx, { repo: strArg(a, "repo"), since: strArg(a, "since"), agent: strArg(a, "agent"), commit: strArg(a, "commit"), ...(limit ? { limit } : {}) }, { cwd: c.cwd, env: c.env, now: c.now() });
      },
    },
    {
      name: "harness_audit",
      title: "Trim unused memory and skills",
      description:
        "Audit the setup to trim it: each memory file, AGENTS.md, CLAUDE.md, rule and skill with the sessions that loaded and read it and its load tokens; unused first. After trimming, check: true finds deleted safety lines. Default 30d.",
      inputSchema: input({
        since: SINCE("30d"),
        agent: AGENT,
        limit: LIMIT(20, 200),
        check: { type: "boolean", description: "Instead check uncommitted harness edits vs git HEAD (refine check)." },
      }),
      outputSchema: out({ sessions: I, loadTokensPerSession: I, files: arr(out({ path: S, flags: arr(S) }, ["path", "flags"])), check: out({ ok: B }), next: arr(S) }),
      annotations: READ,
      async run(a, c) {
        const { auditCheck, auditReport } = await import("./audit.ts");
        if (a.check === true) return auditCheck({ cwd: c.cwd, env: c.env });
        const ctx = await c.store();
        const limit = a.limit === undefined ? undefined : numArg(a, "limit", 20);
        return auditReport(ctx, { since: strArg(a, "since"), agent: strArg(a, "agent"), ...(limit ? { limit } : {}) }, { cwd: c.cwd, env: c.env, now: c.now() });
      },
    },
    {
      name: "failures",
      title: "What went wrong",
      description:
        "Raw failure data: sessions with failure flags or failing tests, the most frequent tool errors (with a sample message), and prompts where the user pushed back. For what to fix first, call improve. Default 7d.",
      inputSchema: input({ since: SINCE("7d"), until: UNTIL, agent: AGENT, repo: REPO, limit: LIMIT(10, 50) }),
      outputSchema: out(
        {
          window: WINDOW_OUT,
          flaggedSessions: arr(out({ id: S, flags: arr(S) }, ["id"])),
          flagCounts: { type: "object" },
          topToolErrors: arr(out({ tool: S, errors: I, sample: S }, ["tool", "errors"])),
          pushback: arr(out({ sessionId: S, text: S }, ["sessionId"])),
        },
        ["window", "flaggedSessions", "topToolErrors", "pushback"],
      ),
      annotations: READ,
      async run(a, c) {
        const ctx = await c.store();
        return failures(ctx.index, query(a, c, { sinceDefault: "7d", topLevel: false }), numArg(a, "limit", 10));
      },
    },
    {
      name: "latency",
      title: "Latency",
      description:
        "Latency over a window: model-call p50/p95 and time to first token, overall and per model, plus the slowest tools (p50/p95/max) and slowest calls. Tools that wait on the user or a subagent (AskUserQuestion, Agent, wait_agent) go in waitingTools. Default 7d.",
      inputSchema: input({ since: SINCE("7d"), until: UNTIL, agent: AGENT, repo: REPO, model: { type: "string", description: "Only model calls whose model name contains this." }, limit: LIMIT(10, 50) }),
      outputSchema: out(
        {
          window: out({ sessions: I, truncated: B, sessionsRead: I, eventsRead: I }),
          truncatedNote: S,
          llm: out({ calls: I, p50Ms: N, p95Ms: N, ttftP50Ms: N }, ["calls"]),
          byModel: arr(out({ model: S, calls: I, p95Ms: N }, ["model", "calls"])),
          slowestTools: arr(out({ tool: S, p95Ms: N }, ["tool"])),
          slowestCalls: arr(out({ tool: S, ms: N, sessionId: S }, ["tool", "ms", "sessionId"])),
          waitingTools: arr(out({ tool: S, p95Ms: N, waitsOn: { type: "string", enum: ["human", "subagent", "wait"] } }, ["tool"])),
          note: S,
        },
        ["window", "llm", "byModel", "slowestTools"],
      ),
      annotations: READ,
      async run(a, c) {
        const ctx = await c.store();
        const model = strArg(a, "model");
        return latency(ctx.index, query(a, c, { sinceDefault: "7d", topLevel: false }), { limit: numArg(a, "limit", 10), ...(model ? { model } : {}) });
      },
    },
    {
      name: "usage",
      title: "Token usage and cost",
      description:
        "Tokens and cost over a window by day (local), agent, model, agent-model, repo: totals (subagents count), user turns, tokensPerTurn (top-level, no cache reads), cacheReadShare, top sessions. costUsd: reported, else tokens × list price (estimatedCostUsd); omitted if unknown, not $0. Default 7d by day.",
      inputSchema: input({
        since: SINCE("7d"),
        until: UNTIL,
        agent: AGENT,
        repo: REPO,
        groupBy: { type: "string", enum: [...USAGE_GROUPS], default: "day", description: "Group rows by this; agent-model compares harnesses at a fixed model." },
        baseline: { type: "boolean", default: false, description: "With groupBy agent or agent-model: rows of an agent a published dataset lists carry cacheBaseline {rate, source, period, delta} (delta = cacheReadShare - rate), plus a note on the source and its denominator." },
        where: WHERE_SAME(""),
        limit: LIMIT(31, 100),
      }),
      outputSchema: out(
        {
          window: WINDOW_OUT,
          groupBy: S,
          total: out({ costUsd: N, estimatedCostUsd: N, estimatedCostByTier: BY_TIER, totalTokens: N }),
          groups: arr(out({ key: S, costUsd: N, estimatedCostUsd: N, estimatedCostByTier: BY_TIER, totalTokens: N, cacheBaseline: out({ rate: N, source: S, period: S, delta: N }, ["rate", "source", "period", "delta"]) }, ["key"])),
          topSessions: arr(out({ id: S, costUsd: N, costEstimated: { type: "boolean" } }, ["id"])),
          topSessionsRankedBy: { type: "string", enum: ["costUsd", "outputTokens"] },
          notes: arr(S),
        },
        ["window", "groupBy", "total", "groups"],
      ),
      annotations: READ,
      async run(a, c) {
        const ctx = await c.store();
        const q = query(a, c, { sinceDefault: "7d", topLevel: false });
        const where = whereArg(a, c.now());
        if (where) q.query = where;
        return usage(ctx.index, q, (strArg(a, "groupBy") ?? "day") as UsageGroup, numArg(a, "limit", 31), { baseline: a.baseline === true }).catch((e) => Promise.reject(queryToolError(e)));
      },
    },
    {
      name: "subagents",
      title: "Subagent tree",
      description:
        "The subagents a session spawned, as a tree: type, task description, duration, ok, tool calls and errors, and child session ids to open with session_get. Pages the top-level subagents with limit/cursor; count is the whole tree.",
      inputSchema: input({ sessionId: SESSION_ID, limit: LIMIT(20, 100), cursor: CURSOR }, ["sessionId"]),
      outputSchema: { ...out({ count: I, topLevel: I, subagents: arr({ $ref: "#/$defs/node" }), nextCursor: S, truncated: B }, ["count", "subagents"]), $defs: { node: NODE_OUT } },
      annotations: READ,
      async run(a, c) {
        const ctx = await c.store();
        const s = await resolveSession(ctx, strArg(a, "sessionId")!);
        const offset = cursorArg(a);
        const limit = numArg(a, "limit", 20);
        const tree = await subagentTree(ctx.index, s.id);
        const more = tree.length > offset + limit;
        // Each child by the shortest id that resolves, as session_tree gives it; the session asked about keeps its full id.
        const short = await shortIds(ctx);
        const shorten = (nodes: SubagentNode[]): SubagentNode[] => nodes.map((n) => {
          const out: SubagentNode = { ...n, children: shorten(n.children) };
          if (n.sessionId) out.sessionId = short(n.sessionId);
          return out;
        });
        return { sessionId: s.id, count: countNodes(tree), topLevel: tree.length, subagents: shorten(tree.slice(offset, offset + limit)), ...(more ? { nextCursor: String(offset + limit), truncated: true } : {}) };
      },
    },
    {
      name: "session_tree",
      title: "Whole multi-agent run as a tree",
      description:
        "A whole multi-agent run as one tree: from any session, its top-level agent and every subagent; or with run:true a fan-out sharing a run id. Each node has model, cost, tokens, duration and flags. Paged; totals, the worst flag and worst (the node to fix first) cover the whole tree.",
      inputSchema: input({ sessionId: SESSION_ID, run: { type: "boolean", default: false, description: "Read sessionId as a run id (CODING_SH_RUN_ID)." }, limit: LIMIT(TREE_PAGE_NODES, 200), cursor: CURSOR }, ["sessionId"]),
      outputSchema: {
        ...out(
          {
            runId: S,
            totals: out({ sessions: I, costUsd: N, inputTokens: I, outputTokens: I, toolCalls: I, toolErrors: I, filesChanged: I, durationMs: N, flags: arr(S) }, ["sessions"]),
            worst: out({ sessionId: S, role: S, flags: arr(S) }),
            tree: arr({ $ref: "#/$defs/treeNode" }),
            nextCursor: S,
            truncated: B,
          },
          ["totals", "tree"],
        ),
        $defs: { treeNode: TREE_NODE_OUT },
      },
      annotations: READ,
      async run(a, c) {
        const ctx = await c.store();
        const arg = strArg(a, "sessionId")!;
        let tree: Tree | undefined;
        if (a.run === true) {
          tree = await buildRunTree(ctx.index, arg);
          if (!tree) throw new ToolError(`No sessions in run ${JSON.stringify(arg)}. Set CODING_SH_RUN_ID on your fan-out, or pass a session id with run:false.`);
        } else {
          const s = await resolveSession(ctx, arg);
          tree = await buildSessionTree(ctx.index, s.id);
          if (!tree) throw new ToolError(`No tree for session ${JSON.stringify(arg)}.`);
        }
        const worst = worstNode(tree.roots);
        const t = tree.totals;
        const short = await shortIds(ctx);
        // A page of nodes; a subagent whose parent was on an earlier page is at the top, with parentSessionId.
        const page = pageTree(tree.roots, cursorArg(a), numArg(a, "limit", TREE_PAGE_NODES));
        const doc: Obj = {
          ...(tree.runId ? { runId: tree.runId } : {}),
          totals: {
            sessions: t.sessions,
            ...(t.usage.costUsd !== undefined ? { costUsd: round2(t.usage.costUsd) } : {}),
            ...(t.usage.inputTokens !== undefined ? { inputTokens: t.usage.inputTokens } : {}),
            ...(t.usage.outputTokens !== undefined ? { outputTokens: t.usage.outputTokens } : {}),
            ...(t.usage.cacheReadTokens !== undefined ? { cacheReadTokens: t.usage.cacheReadTokens } : {}),
            toolCalls: t.toolCalls,
            toolErrors: t.toolErrors,
            filesChanged: t.filesChanged,
            ...(t.wallMs !== undefined ? { durationMs: t.wallMs } : {}),
            flags: t.flags,
          },
          ...(worst ? { worst: { sessionId: short(worst.session.id), role: worst.depth === 0 ? "root" : (worst.session.parent?.type ?? "subagent"), flags: worstFirst(worst.session.flags) } } : {}),
          tree: page.roots.map((n) => treeNodeJson(n, short, true)),
        };
        if (page.next !== undefined) Object.assign(doc, { nextCursor: String(page.next), truncated: true });
        return doc;
      },
    },
    {
      name: "eval_from_session",
      title: "Turn a session into an eval",
      description:
        "Draft an eval task from a session: its first prompt becomes the instruction, its start snapshot the starting repo, its end state the reference fix. Writes to the local coding.sh store, so ask the user first and pass confirm: true.",
      inputSchema: input(
        {
          sessionId: SESSION_ID,
          confirm: { type: "boolean", description: "Must be true: the user agreed to create the task." },
          verifier: { type: "string", description: "Shell command that exits 0 when the task is solved, e.g. npm test. Default: guessed from the session or repo." },
          name: { type: "string", description: "Task name. Default: from the prompt." },
          instruction: { type: "string", description: "What the agent is asked to do. Default: the session's first prompt; required when it has none." },
          setup: { type: "array", items: { type: "string" }, maxItems: 20, description: "Setup commands run before the agent, e.g. npm ci. Default: guessed from lockfiles." },
          tags: { type: "array", items: { type: "string" }, maxItems: 20, description: "Extra tags." },
        },
        ["sessionId", "confirm"],
      ),
      outputSchema: out(
        {
          created: B,
          task: out({ id: S, name: S, verifier: S }, ["id", "name"]),
          notes: arr(S),
          next: S,
        },
        ["created", "task"],
      ),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      async run(a, c) {
        // The session is looked up first: the user is not asked to approve an eval from a session that does not exist.
        const ctx = await c.store();
        const s = await resolveSession(ctx, strArg(a, "sessionId")!);
        if (a.confirm !== true) throw new ToolError("Not created: this writes an eval task to the user's coding.sh store. Ask the user, then call again with confirm: true.");
        const { draftTaskFromSession } = await import("../eval/task.ts");
        const strs = (k: string) => (Array.isArray(a[k]) ? (a[k] as unknown[]).filter((x): x is string => typeof x === "string" && x.trim() !== "") : undefined);
        let task;
        try {
          task = await draftTaskFromSession({
            index: ctx.index,
            blobs: ctx.blobs,
            sessionId: s.id,
            ...(strArg(a, "name") ? { name: strArg(a, "name")! } : {}),
            ...(strArg(a, "instruction") ? { instruction: strArg(a, "instruction")! } : {}),
            ...(strArg(a, "verifier") ? { verifierCommand: strArg(a, "verifier")! } : {}),
            ...(strs("setup")?.length ? { setup: strs("setup")! } : {}),
            ...(strs("tags")?.length ? { tags: strs("tags")! } : {}),
          });
        } catch (e) {
          throw new ToolError(`Couldn't draft a task from ${s.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
        const existing = await ctx.index.getTask(task.id);
        if (!existing) await ctx.index.putTask(task);
        const t = existing ?? task;
        return {
          created: !existing,
          task: { id: t.id, name: t.name, status: t.status, sourceSessionId: t.sourceSessionId, repo: t.start.repoRoot, verifier: t.verifier.command || undefined, setup: t.setup, tags: t.tags, hasReference: !!t.referencePatch },
          notes: task.meta.notes,
          next: `coding.sh eval validate ${t.id}`,
        };
      },
    },
    {
      name: "eval_init",
      title: "Build an eval suite",
      description: "Write an eval suite to evals/<name>/: tasks from failed sessions, a skill's trigger prompts, or cases you write. Ask the user first, then pass confirm: true. Returns the run command.",
      inputSchema: input(
        {
          name: { type: "string", description: "Suite name." },
          confirm: { type: "boolean", description: "true once the user agreed." },
          source: { type: "string", enum: ["sessions", "skill", "cases"], description: "What to build it from." },
          purpose: { type: "string", enum: ["capability", "regression"], description: "Default: capability for sessions, else regression." },
          sessionIds: { type: "array", items: { type: "string" }, maxItems: 50, description: "sessions: these instead of recent failed ones." },
          verifier: { type: "string", description: "sessions: exits 0 only when solved, e.g. npm test." },
          skill: { type: "string", description: "skill: its dir." },
          should: { type: "array", items: { type: "string" }, maxItems: 100, description: "skill: prompts that should load it (10+)." },
          shouldNot: { type: "array", items: { type: "string" }, maxItems: 100, description: "skill: near misses that should not." },
          cases: {
            type: "array",
            maxItems: 500,
            description: "cases: expected when there is one exact answer; should: false for a should-not case.",
            items: { type: "object", properties: { input: {}, expected: {}, should: { type: "boolean" } }, required: ["input"], additionalProperties: false },
          },
          command: { type: "string", description: "cases: answers one case, input as JSON on stdin." },
          url: { type: "string", description: "cases: or an HTTP endpoint." },
          description: { type: "string", description: "What it should do; the judge's rubric when cases have no expected." },
          force: { type: "boolean", description: "Replace an existing suite." },
        },
        ["name", "confirm", "source"],
      ),
      outputSchema: out(
        {
          name: S,
          dir: S,
          kind: { type: "string", enum: ["tasks", "cases", "triggers"] },
          purpose: S,
          files: arr(S),
          notes: arr(S),
          drafted: B,
          todo: B,
          run: S,
          ci: S,
        },
        ["name", "dir", "kind", "files", "run"],
      ),
      // destructive: force replaces an existing suite.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      async run(a, c) {
        if (a.confirm !== true) throw new ToolError("Not written: this writes an eval suite into the user's project. Ask the user, then call again with confirm: true.");
        const { initSuite, InitError } = await import("../eval/init.ts");
        const { repoRoot } = await import("../core/git.ts");
        const { isAbsolute, relative } = await import("node:path");
        const root = (await repoRoot(c.cwd)) ?? c.cwd;
        const strs = (k: string) => (Array.isArray(a[k]) ? (a[k] as unknown[]).filter((x): x is string => typeof x === "string" && x.trim() !== "") : undefined);
        const cases = Array.isArray(a.cases) ? (a.cases as { input: unknown; expected?: unknown; should?: boolean }[]) : undefined;
        const ctx = await c.store();
        let r;
        try {
          r = await initSuite(
            {
              name: strArg(a, "name")!,
              root,
              source: strArg(a, "source") as "sessions" | "skill" | "cases",
              draftedBy: "the agent",
              ...(strArg(a, "purpose") ? { purpose: strArg(a, "purpose") as "capability" | "regression" } : {}),
              ...(a.force === true ? { force: true } : {}),
              ...(strs("sessionIds")?.length ? { sessionIds: strs("sessionIds")! } : {}),
              ...(strArg(a, "verifier") ? { verifier: strArg(a, "verifier")! } : {}),
              ...(strArg(a, "skill") ? { skill: strArg(a, "skill")! } : {}),
              ...(strs("should")?.length ? { should: strs("should")! } : {}),
              ...(strs("shouldNot")?.length ? { shouldNot: strs("shouldNot")! } : {}),
              ...(cases?.length ? { cases } : {}),
              ...(strArg(a, "command") ? { command: strArg(a, "command")! } : {}),
              ...(strArg(a, "url") ? { url: strArg(a, "url")! } : {}),
              ...(strArg(a, "description") ? { description: strArg(a, "description")! } : {}),
            },
            { index: ctx.index, blobs: ctx.blobs, now: c.now() },
          );
        } catch (e) {
          // The message says when replacing needs the user's approval; a structured field would cost context on every turn.
          if (e instanceof InitError) throw new ToolError(initErrorArgs(e.message));
          throw e;
        }
        const rel = relative(c.cwd, r.dir);
        return {
          name: r.name,
          dir: rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : r.dir,
          kind: r.kind,
          purpose: r.purpose,
          files: r.files,
          notes: r.notes,
          drafted: r.drafted,
          todo: r.todo,
          run: r.run,
          ...(r.ci ? { ci: r.ci } : {}),
        };
      },
    },
    {
      name: "eval_candidates",
      title: "Rank sessions as eval tasks",
      description:
        "Rank this repo's recent sessions by how good a repo-replay eval task each would make: failure flags, pushback and a guessable verifier score up; subagents, eval runs and sessions with no git start, prompt or edits are rejected.",
      inputSchema: input({
        since: { type: "string", description: "How far back: 30m, 12h, 7d, 2w. Default 14d." },
        limit: LIMIT(10, 50),
        repo: { type: "string", description: "Sessions under this directory, or all. Default: this git repo." },
        flagged: { type: "boolean", description: "Only failed or flagged sessions (what eval_init drafts from)." },
        includeRejected: { type: "boolean", description: "Also return rejected sessions with the reason." },
      }),
      outputSchema: out(
        {
          candidates: arr(out({ sessionId: S, eligible: B, reject: S, score: N, reasons: arr(S), verifierGuess: S }, ["sessionId", "eligible", "score"])),
          considered: N,
          eligible: N,
          next: S,
        },
        ["candidates", "considered", "eligible"],
      ),
      annotations: READ,
      async run(a, c) {
        const ctx = await c.store();
        const { rankSessions } = await import("../eval/candidates.ts");
        const { recentSessions, DEFAULT_SINCE_MS } = await import("../eval/init.ts");
        const { repoRoot } = await import("../core/git.ts");
        const { resolve } = await import("node:path");
        const sinceArg = strArg(a, "since");
        const m = sinceArg ? /^(\d+(?:\.\d+)?)\s*(m|h|d|w)$/.exec(sinceArg.trim()) : null;
        if (sinceArg && !m) throw new ToolError(`since must be a duration such as 12h, 7d or 2w, got ${JSON.stringify(sinceArg)}`);
        const since = m ? Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2] as "m" | "h" | "d" | "w"] : DEFAULT_SINCE_MS;
        const repo = strArg(a, "repo");
        const root = (await repoRoot(c.cwd)) ?? c.cwd;
        const now = c.now();
        // At a checkout's root or in a linked worktree (the default from a worktree): every worktree of the repo, as `repo:<main root>`.
        const dir = repo === "all" ? undefined : repo ? resolve(c.cwd, repo) : root;
        const group = dir ? pathPlace(dir).repo : undefined;
        const pool = group
          ? await recentSessions({ root, since, sessionsRepo: "all" }, ctx.index, now, a.flagged === true, { root: placeNode({ path: group, repo: group }) })
          : await recentSessions({ root, since, ...(repo ? { sessionsRepo: repo === "all" ? "all" : resolve(c.cwd, repo) } : {}) }, ctx.index, now, a.flagged === true);
        const ranked = await rankSessions(ctx.index, pool, { now });
        const eligible = ranked.filter((x) => x.eligible);
        const limit = numArg(a, "limit", 10);
        const shown = [...eligible.slice(0, limit), ...(a.includeRejected === true ? ranked.filter((x) => !x.eligible).slice(0, limit) : [])];
        return {
          candidates: shown.map((x) => ({ ...x, title: clip(x.title, 100), startedAt: new Date(x.startedAt).toISOString() })),
          considered: ranked.length,
          eligible: eligible.length,
          ...(eligible.length ? { next: "eval_init with source: sessions and these sessionIds builds a suite from them (ask the user first)" } : {}),
        };
      },
    },
    {
      name: "experiments_list",
      title: "List experiments",
      description: "List dataset experiments, newest first, with dataset, trials, pass rate with its interval, and weights (a run's checkpoint SHA-256). Compare two with experiment_compare.",
      inputSchema: input({ dataset: { type: "string", description: "Only experiments on this dataset id." }, name: { type: "string", description: "Only experiments with this exact name." }, limit: LIMIT(20, 100), cursor: CURSOR }),
      outputSchema: out(
        {
          experiments: arr(out({ id: S, name: S, dataset: S, passRate: N, weights: WEIGHTS_OUT }, ["id", "name"])),
          nextCursor: S,
        },
        ["experiments"],
      ),
      annotations: READ,
      async run(a, c) {
        const ctx = await c.store();
        const [{ FileEvalStore }, { weightsOf, stampedWith }, { checkpointSessions, withSessions }] = await Promise.all([import("../datasets/store.ts"), import("../experiments/weights.ts"), import("../experiments/checkpoints.ts")]);
        const store = new FileEvalStore({ env: c.env, index: ctx.index });
        const offset = cursorArg(a);
        const limit = numArg(a, "limit", 20);
        const dataset = strArg(a, "dataset");
        const name = strArg(a, "name");
        const all = await store.listExperiments({ limit: offset + limit + 1, ...(dataset ? { datasetId: dataset } : {}), ...(name ? { name } : {}) });
        const page = all.slice(offset, offset + limit);
        const checkpoints = await checkpointSessions(ctx.index, page.map((e) => weightsOf(e)));
        return {
          // Each row carries the checkpoint its run recorded (exp run --weights), with the ids of the sessions that
          // recorded that file (weights.sessions); no key when it recorded none.
          experiments: page.map((e) => withSessions(stampedWith({
            id: e.id,
            name: e.name,
            dataset: e.dataset.id,
            datasetVersion: e.dataset.version,
            task: clip(e.task.ref, 80),
            trials: e.trials,
            runs: e.runs.length,
            cases: e.summary.cases,
            passed: e.summary.passed,
            errors: e.summary.errors,
            passRate: round(e.summary.passRate.p),
            passRateLo: round(e.summary.passRate.lo),
            passRateHi: round(e.summary.passRate.hi),
            createdAt: iso(e.createdAt),
          }, weightsOf(e)), checkpoints)),
          ...(all.length > offset + limit ? { nextCursor: String(offset + limit) } : {}),
        };
      },
    },
    {
      name: "experiment_compare",
      title: "Compare experiments",
      description:
        "Paired comparison of two experiments on the same cases: pass-rate difference with a bootstrap CI, McNemar p-value, verdict (better/worse/inconclusive), regressed and improved cases, cases gained and lost (passed in any trial), per-grader deltas, power warnings and a ship/hold/dont-ship gate.",
      inputSchema: input(
        {
          baseline: { type: "string", minLength: 1, description: "Experiment id of the baseline (A)." },
          candidate: { type: "string", minLength: 1, description: "Experiment id of the candidate (B)." },
          limit: LIMIT(10, 50),
        },
        ["baseline", "candidate"],
      ),
      outputSchema: out(
        {
          baseline: out({ id: S, passRate: N, weights: WEIGHTS_OUT }),
          candidate: out({ id: S, passRate: N, weights: WEIGHTS_OUT }),
          verdict: { type: "string", enum: ["better", "worse", "inconclusive"] },
          diff: out({ mean: N, lo: N, hi: N }),
          paired: I,
          mcnemar: out({ p: N }),
          regressions: arr(out({ caseId: S }, ["caseId"])),
          improvements: arr(out({ caseId: S }, ["caseId"])),
          gate: out({
            verdict: { type: "string", enum: ["ship", "hold", "dont-ship"] },
            decision: { type: "string", enum: ["accept", "abstain"] },
            summary: S,
            wins: I,
            losses: I,
            solved: I,
            p: N,
            reasons: arr(S),
            lostCases: arr(S),
          }),
          coverage: out({ baseline: N, candidate: N, gained: I, lost: I, kept: I, lostCases: arr(S) }),
          warnings: arr(S),
        },
        ["baseline", "candidate", "verdict", "diff", "paired"],
      ),
      annotations: READ,
      async run(a, c) {
        const ctx = await c.store();
        const [{ FileEvalStore }, { compareExperiments, IncompleteExperimentError }, { checkpointSessions, withSessions }] = await Promise.all([import("../datasets/store.ts"), import("../experiments/compare.ts"), import("../experiments/checkpoints.ts")]);
        const store = new FileEvalStore({ env: c.env, index: ctx.index });
        const ids = [strArg(a, "baseline")!, strArg(a, "candidate")!];
        const [ea, eb] = await Promise.all(ids.map((id) => store.getExperiment(id).catch(() => undefined)));
        for (const [i, e] of [ea, eb].entries()) if (!e) throw new ToolError(`No experiment with id ${JSON.stringify(ids[i])}. Find ids with experiments_list.`);
        let cmp: ReturnType<typeof compareExperiments>;
        try {
          cmp = compareExperiments(ea!, eb!, { iters: 2000, gate: {} });
        } catch (e) {
          if (e instanceof IncompleteExperimentError) throw new ToolError(`${e.message}. Compare it with the CLI and --force to include it anyway.`);
          throw e;
        }
        const limit = numArg(a, "limit", 10);
        const cases = (xs: { caseId: string; a: number; b: number }[]) => xs.slice(0, limit).map((x) => ({ caseId: x.caseId, baseline: round(x.a), candidate: round(x.b) }));
        const warnings = [
          ...(cmp.datasetWarning ? [cmp.datasetWarning] : []),
          ...(cmp.gradeWarning ? [cmp.gradeWarning] : []),
          ...cmp.power.warnings.map((w) => w.message),
          ...(cmp.turnover.warning ? [cmp.turnover.warning] : []),
        ];
        // First: with one checkpoint on both sides, nothing below compares two models.
        if (cmp.weightsWarning) warnings.unshift(cmp.weightsWarning);
        const gate = cmp.gate;
        const t = cmp.turnover;
        // Each side's stamp names the sessions that recorded that weights file as a checkpoint (weights.sessions).
        const checkpoints = await checkpointSessions(ctx.index, [cmp.a.weights?.sha256, cmp.b.weights?.sha256]);
        return {
          baseline: withSessions({ ...cmp.a, passRate: round(cmp.a.passRate) }, checkpoints),
          candidate: withSessions({ ...cmp.b, passRate: round(cmp.b.passRate) }, checkpoints),
          verdict: cmp.verdict,
          diff: { mean: round(cmp.diff.mean), lo: round(cmp.diff.lo), hi: round(cmp.diff.hi) },
          paired: cmp.paired,
          onlyInBaseline: cmp.onlyInA.length,
          onlyInCandidate: cmp.onlyInB.length,
          mcnemar: { regressions: cmp.mcnemar.b, improvements: cmp.mcnemar.c, p: round(cmp.mcnemar.p) },
          signFlip: { p: round(cmp.signFlip.p), units: cmp.signFlip.units },
          regressions: cases(cmp.regressions),
          improvements: cases(cmp.improvements),
          graders: cmp.graders.slice(0, limit).map((g) => ({ id: g.id, meanBaseline: round(g.meanA), meanCandidate: round(g.meanB), diff: round(g.diff.mean), lo: round(g.diff.lo), hi: round(g.diff.hi) })),
          ...(gate
            ? {
                gate: {
                  verdict: gate.verdict,
                  decision: gate.decision,
                  summary: gateHeadline(gate, "case"),
                  wins: gate.wins,
                  losses: gate.losses,
                  solved: gate.solved,
                  p: round(gate.p),
                  reasons: gate.reasons,
                  lostCases: gate.lostCases.slice(0, limit),
                  ...(gate.note ? { note: gate.note } : {}),
                },
              }
            : {}),
          // Passed in any trial: cases B stopped solving at all, apart from reliability dips.
          coverage: { baseline: round(t.coverage.a), candidate: round(t.coverage.b), gained: t.gained.length, lost: t.lost.length, kept: t.keptCovered, lostCases: t.lost.slice(0, limit) },
          warnings,
        };
      },
    },
    {
      name: "exp_session_summary",
      title: "Experiment session timeline",
      description:
        "Experiment session timeline, oldest first: notes, commands, and runs with their delta vs the previous run (pass rates, CI, McNemar p, fixed/broke). Read it after a context reset.",
      inputSchema: input({ session: EXP_SESSION, limit: LIMIT(50, 200), cursor: CURSOR }),
      outputSchema: out({ session: out({ id: S }), blocks: arr(out({ kind: S })), total: I, nextCursor: S }),
      annotations: READ,
      async run(a, c) {
        const { session, root } = await expSession(a, c);
        const { findSession, readTimeline, timelinePath } = await import("../experiments/session.ts");
        // A session named by id has a timeline once anything was added to it; the project's own one may still be empty.
        if (strArg(a, "session") !== undefined && !existsSync(timelinePath(root, session.id)) && findSession({ cwd: c.cwd, env: c.env })?.id !== session.id) {
          throw new ToolError(`No experiment session with id ${JSON.stringify(session.id)}. Omit session for the project's session (.coding-sh/session.json), or ask the user to start one: coding.sh exp session new --name <topic>`, {
            reason: "not_found",
            next: "coding.sh exp session new --name <topic>",
          });
        }
        const all = await readTimeline(root, session.id);
        const offset = cursorArg(a);
        const limit = numArg(a, "limit", 50);
        return {
          session: { id: session.id, ...(session.name ? { name: session.name } : {}), ...(session.createdAt ? { createdAt: iso(session.createdAt) } : {}) },
          blocks: all.slice(offset, offset + limit),
          total: all.length,
          ...(all.length > offset + limit ? { nextCursor: String(offset + limit) } : {}),
        };
      },
    },
    {
      name: "exp_session_note",
      title: "Note in experiment session",
      description:
        "Note in the experiment session: the hypothesis before each run, the reading after it. Secrets are redacted.",
      inputSchema: input({ text: { type: "string", minLength: 1, maxLength: 4000, description: "The note." }, session: EXP_SESSION }, ["text"]),
      outputSchema: out({ session: out({ id: S }), block: out({ text: S }) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      async run(a, c) {
        const [{ appendBlock, NOTE_MAX }, { createRedactor }] = await Promise.all([import("../experiments/session.ts"), import("../core/redact.ts")]);
        const raw = strArg(a, "text");
        if (!raw) throw new ToolError("Empty note: pass text, e.g. the hypothesis before a run or what the run showed.");
        if (raw.length > NOTE_MAX) throw new ToolError(`A note is at most ${NOTE_MAX} characters (got ${raw.length}).`);
        const { session, root } = await expSession(a, c);
        const block = { kind: "note" as const, at: c.now(), text: createRedactor({ env: c.env }).string(raw) };
        await appendBlock(root, session.id, block);
        return { session: { id: session.id, ...(session.name ? { name: session.name } : {}) }, block };
      },
    },
    {
      name: "harness_compare",
      title: "Harness A/B results",
      description:
        "Harness A/B results (`coding.sh compare`). No experiment: list them, newest first. With one: pass rates, ship gate (per tag group with by), one-item gate, failed runs split by the agent's own tests, tampered passes split disclosed/stealth.",
      inputSchema: input({
        experiment: { type: "string", description: "Experiment id; omit to list." },
        baseline: { type: "string", description: "Arm A's bundle id or name, if not recorded." },
        by: { type: "string", description: "Tag prefix to gate each group, e.g. suite:" },
        limit: LIMIT(10, 50),
        cursor: CURSOR,
      }),
      outputSchema: out({ experiments: arr(out({ id: S }, ["id"])), nextCursor: S, gate: out({ verdict: S }), itemGate: out({ verdict: S }), ownTests: out({}), tamper: out({}) }),
      annotations: READ,
      async run(a, c) {
        const ctx = await c.store();
        const { harnessCompareList, harnessCompareGet } = await import("./harness.ts");
        const experiment = strArg(a, "experiment");
        const limit = numArg(a, "limit", 10);
        if (!experiment) return harnessCompareList(ctx, c.env, cursorArg(a), limit);
        return harnessCompareGet(ctx, c.env, experiment, { baseline: strArg(a, "baseline"), by: strArg(a, "by"), limit });
      },
    },
    {
      name: "benchmarks",
      title: "Benchmarks",
      description:
        "Dynamic benchmarks (coding.sh bench). No name: list them. Name: one run (latest counted by default) with leaderboard, paired verdicts, cost sources and worst failures. Name + metric: that metric per contender across counted runs, oldest first",
      inputSchema: input({
        name: { type: "string", minLength: 1, description: "Benchmark name. Omit to list benchmarks." },
        run: { type: "string", description: "Run id or YYYY-MM-DD. Default latest counted run." },
        metric: { type: "string", enum: ["pass", "score", "latency", "p95", "cost", "tokens", "tokens-in", "tokens-out", "errors"], description: "Return history for this metric instead of one run: pass rate, mean score, p50 or p95 latency ms, USD per run, tokens (total, in, out) or errors." },
        anchor: { type: "boolean", description: "With metric: numbers from the fixed anchor set instead of the fresh cases." },
        limit: { type: "integer", minimum: 1, maximum: 365, description: "Max failures per contender (default 5), or runs of history (default 30)." },
      }),
      outputSchema: out({
        benchmarks: arr(out({ name: S, source: S, contenders: arr(S), runs: I, lastRun: out({ id: S, date: S, leaders: arr(S) }) }, ["name", "runs"])),
        bench: S,
        run: S,
        date: S,
        seed: S,
        sha256: S,
        metric: S,
        leaderboard: arr(out({ contender: S, place: I, passRate: N, passed: I, n: I }, ["contender", "place"])),
        headToHead: arr(out({ a: S, b: S, verdict: S, p: N }, ["a", "b", "verdict"])),
        failures: { type: "object" },
        runs: arr(out({ id: S, date: S }, ["id", "date"])),
        series: { type: "object" },
        anchor: { type: "object" },
        seedCheck: { type: "object" },
        contentChanges: arr(out({ key: S, from: S, to: S }, ["key"])),
        warnings: arr(S),
      }),
      annotations: READ,
      async run(a, c) {
        const { contentChanges, getRun, historyRuns, listRuns, series } = await import("../bench/store.ts");
        const name = strArg(a, "name");
        if (!name) {
          const { listDefinitions } = await import("../bench/define.ts");
          return {
            benchmarks: await Promise.all(
              listDefinitions({ cwd: c.cwd, env: c.env }).map(async (d) => {
                const runs = await listRuns(d.name, c.env);
                const last = historyRuns(runs).at(-1) ?? runs.at(-1);
                return {
                  name: d.name,
                  file: d.file,
                  scope: d.scope,
                  ...(d.error ? { error: clip(d.error, 200) } : {}),
                  ...(d.def ? { source: d.def.source.kind, cases: d.def.cases, contenders: d.def.contenders.map((x) => x.name) } : {}),
                  runs: runs.length,
                  ...(last ? { lastRun: { id: last.id, date: last.date, leaders: last.summaries.filter((x) => x.place === 1).map((x) => x.contender) } } : {}),
                };
              }),
            ),
          };
        }
        const runs = await listRuns(name, c.env).catch(() => []);
        if (!runs.length) throw new ToolError(`No runs for benchmark ${JSON.stringify(name)}. Call benchmarks with no name to list them; run one with: coding.sh bench run ${name}`);
        const metric = strArg(a, "metric") as "pass" | undefined;
        if (metric) {
          const anchor = a.anchor === true;
          const all = historyRuns(runs);
          const counted = (anchor ? all.filter((r) => r.anchor) : all).slice(-numArg(a, "limit", 30));
          const s = series(counted, metric, { anchor });
          const changes = contentChanges(all);
          return {
            bench: name,
            metric,
            ...(anchor ? { set: "anchor" } : {}),
            runs: counted.map((r) => ({ id: r.id, date: r.date, cases: anchor ? r.anchor!.cases : r.cases.filter((x) => !x.anchor).length, sha256: anchor ? r.anchor!.sha256 : r.dataset.sha256 })),
            series: Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.map((p) => ({ date: p.date, value: p.value === null ? null : round(p.value) ?? null, n: p.n, segment: p.segment ?? 0 }))])),
            ...(changes.length ? { contentChanges: changes.slice(0, 20).map((x) => ({ key: clip(x.key, 120), anchor: x.anchor, from: x.from.date, to: x.to.date })) } : {}),
          };
        }
        const ref = strArg(a, "run") ?? "latest";
        const r = ref === "latest" ? (historyRuns(runs).at(-1) ?? runs.at(-1)) : await getRun(name, ref, c.env);
        if (!r) throw new ToolError(`Benchmark ${name} has no run ${JSON.stringify(ref)}. Latest is ${runs.at(-1)!.id} (${runs.at(-1)!.date}).`);
        const limit = numArg(a, "limit", 5);
        const byCase = new Map(r.cases.map((x) => [x.id, x]));
        const failures: Record<string, unknown[]> = {};
        for (const s of r.summaries) {
          failures[s.contender] = r.cells
            .filter((x) => x.contender === s.contender && !x.pass)
            .sort((x, y) => x.score - y.score)
            .slice(0, limit)
            .map((x) => ({ caseId: x.caseId, failure: x.failure ?? "wrong", input: clip(JSON.stringify(byCase.get(x.caseId)?.input ?? null), 160), detail: clip(x.error ?? x.grades?.find((g) => !g.pass)?.reason ?? x.output, 200), ...(x.sessionId ? { sessionId: x.sessionId } : {}) }));
        }
        const { verifySeed } = await import("../bench/commit.ts");
        const seedCheck = verifySeed(r, runs);
        const board = (xs: typeof r.summaries) =>
          xs.map((s) => ({
            contender: s.contender,
            place: s.place,
            passRate: round(s.passRate.p),
            passRateLo: round(s.passRate.lo),
            passRateHi: round(s.passRate.hi),
            passed: s.passed,
            n: s.n,
          }));
        return {
          bench: r.bench,
          run: r.id,
          date: r.date,
          seed: r.seed,
          ...(seedCheck ? { seedCheck: { ok: seedCheck.ok, checks: seedCheck.checks.map((x) => `${x.ok ? "ok" : "FAILED"}: ${x.detail}`) } } : {}),
          sha256: r.dataset.sha256,
          dataset: `${r.dataset.id}@${r.dataset.version}`,
          cases: r.cases.filter((x) => !x.anchor).length,
          ...(r.anchor ? { anchor: { version: r.anchor.version, cases: r.anchor.cases, leaderboard: board(r.anchor.summaries) } } : {}),
          mode: r.mode ?? "scheduled",
          status: r.status ?? "complete",
          excluded: r.excluded ? { cases: r.excluded.cases, byReason: r.excluded.byReason } : undefined,
          contenders: r.contenders.map((x) => ({ name: x.name, kind: x.kind, model: x.model, version: x.version })),
          leaderboard: r.summaries.map((s) => ({
            contender: s.contender,
            place: s.place,
            passRate: round(s.passRate.p),
            passRateLo: round(s.passRate.lo),
            passRateHi: round(s.passRate.hi),
            passed: s.passed,
            n: s.n,
            meanScore: round(s.meanScore),
            p50Ms: round(s.latencyMs.p50),
            p95Ms: round(s.latencyMs.p95),
            costPerRunUsd: s.costUsd.known ? round(s.costUsd.perRun) : undefined,
            costSources: s.costUsd.sources,
            tokensIn: s.tokensIn?.known ? round(s.tokensIn.mean) : undefined,
            tokensOut: s.tokensOut?.known ? round(s.tokensOut.mean) : undefined,
            errors: s.errors,
            failureModes: s.failures,
            experimentId: s.experimentId,
          })),
          headToHead: r.comparisons.map((p) => ({ a: p.a, b: p.b, verdict: p.verdict === "tie" ? "tie" : `${p.verdict === "a" ? p.a : p.b} ahead`, diff: round(p.diff.mean), lo: round(p.diff.lo), hi: round(p.diff.hi), aOnly: p.aOnly, bOnly: p.bOnly, p: round(p.pAdj) })),
          failures,
          warnings: r.warnings,
        };
      },
    },
    {
      name: "work",
      title: "What needs you",
      description: "What needs you across agents (coding.sh work --json): each item's reason, next step, phases, PRs and supersededBy. Paged.",
      inputSchema: input({
        since: SINCE("7d"),
        all: { type: "boolean", default: false, description: "Also running, done and snoozed items." },
        limit: LIMIT(20, 100),
        cursor: CURSOR,
      }),
      // Open: the answer is work --json's (needYou, counts, ...), with nextCursor and index { updatedAt, ageMs, stale? }.
      outputSchema: out({ items: arr({ type: "object" }), nextCursor: S }, ["items"]),
      annotations: READ,
      async run(a, c) {
        return (await workPages(a, c))(numArg(a, "limit", 20));
      },
      pages: workPages,
    },
    {
      name: "status",
      title: "coding.sh status",
      description:
        "Health of coding.sh: version and update, data dir, 24h sessions and last capture per agent, pending spool, last error, index age, 5h and weekly plan usage. Use when data looks missing or stale. work: what needs you (7d): counts, top 5 items; the work tool has the rest.",
      inputSchema: input({}),
      outputSchema: out(
        {
          version: S,
          update: out({ latest: S, available: B, install: S, command: S }, ["available"]),
          home: S,
          last24h: out({ sessions: I, agents: arr(S) }),
          lastCapture: arr(out({ agent: S, at: S }, ["agent"])),
          latest: SESSION_OUT,
          lastError: out({ error: S }),
          // { updatedAt, ageMs, stale? }; work: { needYou, items (as the work tool's), more, rest }.
          index: { type: "object" },
          work: { type: "object" },
          hints: arr(S),
          // Plan usage, as `coding.sh quota --json` prints it (resetsAt, readAt, ageSeconds and missing too).
          quota: out({ windows: arr(out({ agent: S, window: S, usedPercent: N })) }),
        },
        ["version", "update", "home", "last24h", "work"],
      ),
      annotations: READ,
      async run(_a, c) {
        const ctx = await c.store();
        const now = c.now();
        const day = await collectSessions(ctx.index, { topLevel: false, since: now - 86400e3 }, 10_000);
        const week = await collectSessions(ctx.index, { topLevel: false, since: now - 7 * 86400e3 }, 10_000);
        const lastByAgent = new Map<string, Session>();
        for (const s of week.sessions) {
          const prev = lastByAgent.get(s.agent);
          if (!prev || lastActivity(s) > lastActivity(prev)) lastByAgent.set(s.agent, s);
        }
        const [latest] = await ctx.index.listSessions({ limit: 1, parentSessionId: null });
        const update = updateInfo(ctx.paths.root, version(), ctx.env);
        const bin = nextStepBin(ctx.env);
        const spool = spoolStats(ctx.paths.spool);
        const lastError = lastSpoolError(ctx.paths.spoolErrors);
        // The work queue `coding.sh work` shows (core/work.ts), over its default window, with acks and snoozes applied.
        const short = await shortIds(ctx);
        const { queue, truncated } = await readWorkQueue(ctx.index, { since: now - WORK_WINDOW_MS, now, overlay: readOverlay(ctx.paths.work), shortId: short });
        const hints: string[] = [];
        if (update.available) hints.push(`coding.sh ${update.latest} is available (running ${update.current}). Tell the user; update with: ${update.install ?? update.command}`);
        if (!latest) hints.push(noSessionsHint(ctx.env));
        else if (!day.sessions.length) hints.push(`No sessions in the last 24h: if agents ran, check hooks with \`${bin} doctor\`.`);
        const [{ quotaJson, quotaReport }, { codexHome }] = await Promise.all([import("../quota/index.ts"), import("../adapters/codex.ts")]);
        const quota = quotaJson(quotaReport({ claudeFile: ctx.paths.quota, codexHome: codexHome(ctx.env) }), now);
        return {
          version: version(),
          update,
          home: ctx.paths.root,
          store: ctx.config.store.index,
          last24h: { sessions: day.sessions.length, agents: [...new Set(day.sessions.map((s) => s.agent))].sort() },
          lastCapture: [...lastByAgent].sort((x, y) => x[0].localeCompare(y[0])).map(([agent, s]) => ({ agent, at: iso(lastActivity(s)), sessionId: s.id, shortId: short(s.id) })),
          latest: latest ? sessionSummary(latest, now) : undefined,
          spool,
          lastError,
          ...indexField(storeIndexAge(ctx, now)),
          work: {
            ...queue.counts,
            needYou: needYou(queue),
            items: queue.items.slice(0, STATUS_WORK_ROWS).map(workItemJson),
            more: queue.items.length > STATUS_WORK_ROWS ? queue.items.length - STATUS_WORK_ROWS : undefined,
            rest: queue.items.length > STATUS_WORK_ROWS ? "coding.sh work --json" : undefined,
            truncated: truncated || undefined,
          },
          hints,
          quota,
        };
      },
    },
    ...scoreTools(),
  ];
}

/** 4 decimals; NaN/Infinity (e.g. no paired cases) become undefined so the field is omitted. */
const round = (n: number): number | undefined => (Number.isFinite(n) ? Math.round(n * 10_000) / 10_000 : undefined);
