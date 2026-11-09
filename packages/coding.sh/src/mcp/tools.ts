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
import { buildRunTree, buildSessionTree, worstFirst, worstNode, type Tree, type TreeNode } from "../core/tree.ts";
import { parseSince } from "../cli/args.ts";
import { version } from "../cli/meta.ts";
import { noSessionsHint } from "../cli/first-session.ts";
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
  placeNode,
  round2,
  scanFilter,
  sessionSummary,
  SESSION_ENV_VARS,
  subagentTree,
  usage,
  type ScanQuery,
  type UsageGroup,
  USAGE_GROUPS,
} from "./data.ts";
import { sessionDigest } from "./digest.ts";
import { facetCounts, searchWhere } from "../query/run.ts";
import { andQuery, FACET_KEYS, parseWhere, QueryError, QueryUnsupported, type Query } from "../query/where.ts";
import { ToolError, type ToolDef } from "./protocol.ts";
import { scoreTools } from "../scores/mcp.ts";

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
const AGENT = { type: "string", description: "Only this agent, e.g. claude-code, codex, cursor, opencode, t3code." };
const REPO = { type: "string", description: "Only sessions under this path, or in repos with this folder name." };
const SINCE = (d: string) => ({ type: "string", description: `Window start: 30m, 12h, 7d, 2w or an ISO date. Default ${d}.` });
const UNTIL = { type: "string", description: "Window end. Default now." };
const LIMIT = (d: number, max: number) => ({ type: "integer", minimum: 1, maximum: max, default: d, description: "Max rows." });
const CURSOR = { type: "string", description: "nextCursor from the last call." };
const PROJECT = { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,62}$", description: 'Only this project (its `coding.sh serve` ingest key; local is "default"). Default: all.' };
const EXP_SESSION = { type: "string", description: "Session id. Default: the project's session." };
const WHERE = {
  type: "string",
  description:
    "Filter query: key:value clauses ANDed; OR, ( ), - negates; a,b either; * wildcard; > >= < <= and a..b on numbers; bare words search text. Keys: agent model repo branch title flag skill cost tokens duration turns tools tool.errors since until has:tests|cost|error is:root|child|flagged; event keys tool kind ok mcp error. E.g. model:claude-* cost>0.5 tool:Bash ok:false",
};
const WHERE_SAME = (what: string) => ({ type: "string", description: `Filter query, same language as sessions_list where${what}.` });
const SESSION_ID = { type: "string", minLength: 1, description: 'Session id, or "latest" for the newest top-level session.' };

const input = (properties: Obj, required: string[] = []): Obj => ({ type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false });
const out = (properties: Obj, required: string[] = []): Obj => ({ type: "object", properties, ...(required.length ? { required } : {}) });
/** USD by price tier (`batch`, `long-context`, `priority+long-context`, ...). */
const BY_TIER: Obj = { type: "object", additionalProperties: { type: "number" } };

const S = { type: "string" };
const N = { type: "number" };
const I = { type: "integer" };
const B = { type: "boolean" };
const arr = (items: Obj) => ({ type: "array", items });

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
  { sessionId: S, role: S, agent: S, model: S, title: S, depth: I, costUsd: N, inputTokens: I, outputTokens: I, durationMs: N, toolCalls: I, toolErrors: I, flags: arr(S), children: arr({ $ref: "#/$defs/treeNode" }) },
  ["sessionId", "depth", "children"],
);

/** One session_tree node: the session's own numbers plus its subagents. */
function treeNodeJson(n: TreeNode): Obj {
  const s = n.session;
  const u = s.stats.usage;
  return {
    sessionId: s.id,
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
    children: n.children.map(treeNodeJson),
  };
}

// ------------------------------------------------------------ helpers

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

function queryToolError(e: unknown): unknown {
  if (e instanceof QueryError) return new ToolError(`Invalid where at character ${e.offset + 1}: ${e.message}.${e.next.length ? ` ${e.next.join("; ")}` : ""}`, { reason: e.reason, offset: e.offset });
  if (e instanceof QueryUnsupported) return new ToolError(e.message, { reason: e.reason });
  return e;
}

function when(a: Obj, k: string, now: number, dflt?: string): number | undefined {
  const v = strArg(a, k) ?? dflt;
  if (v === undefined) return undefined;
  try {
    return parseSince(v, now);
  } catch {
    throw new ToolError(`Invalid ${k} ${JSON.stringify(v)}: use a duration like 30m, 12h, 7d, 2w or an ISO date like 2026-01-31.`);
  }
}

function query(a: Obj, c: ToolCtx, o: { sinceDefault?: string; topLevel: boolean }): ScanQuery {
  const now = c.now();
  const repo = strArg(a, "repo");
  const since = when(a, "since", now, o.sinceDefault);
  const until = when(a, "until", now);
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

async function resolveSession(ctx: Context, id: string): Promise<Session> {
  if (id === "latest" || id === "last") {
    const [s] = await ctx.index.listSessions({ limit: 1, parentSessionId: null });
    if (!s) throw new ToolError(noSessionsHint(ctx.env));
    return s;
  }
  const s = await ctx.index.getSession(id);
  if (!s) throw new ToolError(`No session with id ${JSON.stringify(id)}. Find ids with sessions_list or search; ids are exact (no prefixes).`);
  return s;
}

/** session_replay's fork: step N's stored model call sent once more with the given context files (`""` drops one). Loaded on use. */
async function forkTool(ctx: Context, env: NodeJS.ProcessEnv, s: Session, replay: Replay, step: number, files: unknown): Promise<Obj> {
  if (typeof files !== "object" || files === null || Array.isArray(files) || !Object.values(files).every((v) => typeof v === "string")) {
    throw new ToolError('fork is an object of context file paths to their new text, e.g. {"CLAUDE.md": "…"}; "" drops a file.');
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

/** Update availability from the cache the update checker keeps (no network here). */
export function updateInfo(home: string, current = version()): Obj {
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

// ------------------------------------------------------------ tools

export function buildTools(): ToolDef<ToolCtx>[] {
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
        facets: { type: "array", items: { type: "string", enum: [...FACET_KEYS] }, description: "Also count matching sessions per value of these keys." },
        includeSubagents: { type: "boolean", default: false, description: "Also list subagent (child) sessions. Default false." },
        project: PROJECT,
        limit: LIMIT(20, 100),
        cursor: CURSOR,
      }),
      outputSchema: out({ sessions: arr(SESSION_OUT), facets: { type: "object" }, nextCursor: S, truncated: B }, ["sessions"]),
      annotations: READ,
      async run(a, c) {
        const ctx = await c.store();
        const q = query(a, c, { topLevel: a.includeSubagents !== true });
        const flag = strArg(a, "flag");
        if (flag) q.flag = flag;
        if (a.flagged === true) q.where = (s) => failureFlags(s.flags).length > 0;
        const where = whereArg(a, c.now());
        if (where) q.query = where;
        const offset = cursorArg(a);
        const limit = numArg(a, "limit", 20);
        const keys = Array.isArray(a.facets) ? a.facets.filter((k): k is string => typeof k === "string") : [];
        try {
          const p = await pageSessions(ctx.index, q, offset, limit);
          const facets = keys.length ? await facetCounts(ctx.index, andQuery(andQuery(where ?? {}, q.place ? placeNode(q.place) : undefined), a.flagged === true ? { t: "is", name: "flagged", at: 0 } : undefined), keys, { filter: scanFilter(q), limit: 10 }) : undefined;
          const now = c.now();
          return { sessions: p.sessions.map((s) => sessionSummary(s, now)), ...(facets ? { facets } : {}), ...(p.hasMore ? { nextCursor: String(offset + limit) } : {}), ...(p.truncated ? { truncated: true } : {}) };
        } catch (e) {
          throw queryToolError(e);
        }
      },
    },
    {
      name: "session_get",
      title: "Get a session",
      description:
        "One session as a digest: summary (with waste: repeated reads and prompt-cache breaks), skills used, per-turn index, and a timeline of prompts, replies, tool calls (with failures and durations), model calls, file changes and tests. Pass turn to zoom into one turn; page with cursor.",
      inputSchema: input(
        {
          sessionId: SESSION_ID,
          turn: { type: "integer", description: "Only this turn (1-based; -1 = last turn)." },
          limit: LIMIT(40, 200),
          cursor: CURSOR,
          tail: { type: "boolean", default: false, description: "Show the last entries instead of the first. Default false." },
        },
        ["sessionId"],
      ),
      outputSchema: DIGEST_OUT,
      annotations: READ,
      async run(a, c) {
        const ctx = await c.store();
        const s = await resolveSession(ctx, strArg(a, "sessionId")!);
        try {
          return await sessionDigest(ctx.index, s, { turn: typeof a.turn === "number" ? a.turn : undefined, limit: numArg(a, "limit", 40), offset: cursorArg(a), from: a.tail === true ? "tail" : "head", now: c.now() });
        } catch (e) {
          if (e instanceof RangeError) throw new ToolError(e.message);
          throw e;
        }
      },
    },
    {
      name: "session_current",
      title: "Current session",
      description:
        "The session of the agent calling this tool: matched by session id env var, else the newest session in this directory or repo, preferring one active in the last 30 min. Returns its summary and latest timeline entries.",
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
        "A session as numbered steps, with the files the agent touched rebuilt from its tool calls as of any step. No step: the step list.",
      inputSchema: input(
        {
          sessionId: SESSION_ID,
          step: { type: "integer", minimum: 1, description: "One step (1-based): what it did, its diff and the files so far." },
          file: { type: "string", minLength: 1, description: "With step: this file as of that step." },
          from: { type: "integer", minimum: 1, description: "With to: the first step of a range." },
          to: { type: "integer", minimum: 1, description: "With from: the last step (included); each file's diff over the range." },
          fork: { type: "object", description: 'With step: send its model call again with these files ({"CLAUDE.md": text}); recorded vs forked next action. Calls the model.' },
          limit: LIMIT(100, 1000),
          cursor: CURSOR,
        },
        ["sessionId"],
      ),
      outputSchema: out({ sessionId: S, steps: { description: "The step list, or (with step) how many steps there are." }, files: { type: "array" }, total: I, step: { type: "object" }, changes: { type: "array" }, tree: { type: "array" }, file: { type: "object" }, from: I, to: I, nextCursor: S, trials: { type: "array" } }, ["sessionId"]),
      annotations: { ...READ, idempotentHint: false, openWorldHint: true },
      async run(a, c) {
        const ctx = await c.store();
        const s = await resolveSession(ctx, strArg(a, "sessionId")!);
        const redactor = createRedactor({ redact: ctx.config.capture.redact, patterns: ctx.config.capture.redactPatterns, env: ctx.env });
        const replay = await loadReplay(ctx, s, { baseline: snapshotBaseline(s, ctx.env, redactor), maxContentBytes: 64 * 1024, maxDiffBytes: 64 * 1024 });
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
        if (from !== undefined || to !== undefined) {
          if (from === undefined || to === undefined) throw new ToolError("Pass both from and to for a range.");
          return { ...(await replay.range(from, to)) };
        }
        if (a.fork !== undefined) {
          if (step === undefined) throw new ToolError("fork needs a step.");
          return { ...(await forkTool(ctx, c.env, s, replay, step, a.fork)) };
        }
        const file = strArg(a, "file");
        if (step !== undefined) return { ...(await replay.at(step, { file })) };
        if (file) throw new ToolError("file needs a step.");
        const index = replay.index();
        const offset = cursorArg(a);
        const limit = numArg(a, "limit", 100);
        const page = index.steps.slice(offset, offset + limit);
        return { ...index, steps: page, total, ...(offset + limit < total ? { nextCursor: String(offset + limit) } : {}) };
      },
    },
    {
      name: "search",
      title: "Search sessions",
      description: "Full-text search over captured prompts, replies and tool input/output across all sessions. Returns matching events with session ids and snippets; open one with session_get.",
      inputSchema: input({ query: { type: "string", minLength: 1, description: "Words to find (all must match)." }, agent: AGENT, project: PROJECT, where: WHERE_SAME("; event keys apply to the hit"), limit: LIMIT(10, 50), cursor: CURSOR }, ["query"]),
      outputSchema: out({ hits: arr(out({ sessionId: S, kind: S, snippet: S }, ["sessionId", "kind", "snippet"])), nextCursor: S }, ["hits"]),
      annotations: READ,
      async run(a, c) {
        const ctx = await c.store();
        const offset = cursorArg(a);
        const limit = numArg(a, "limit", 10);
        const agent = strArg(a, "agent");
        const project = strArg(a, "project");
        const where = whereArg(a, c.now());
        const opts = { limit: offset + limit + 1, ...(agent ? { agent } : {}), ...(project ? { project } : {}) };
        const text = strArg(a, "query") ?? "";
        const raw = where ? await searchWhere(ctx.index, text, where, opts).catch((e) => Promise.reject(queryToolError(e))) : await ctx.index.search(text, opts);
        const page = raw.slice(offset, offset + limit);
        const titles = new Map<string, string | undefined>();
        for (const h of page) if (!titles.has(h.event.sessionId)) titles.set(h.event.sessionId, clip((await ctx.index.getSession(h.event.sessionId))?.title, 80));
        return {
          hits: page.map((h) => ({ sessionId: h.event.sessionId, eventId: h.event.id, agent: h.event.agent, kind: h.event.kind, at: iso(h.event.ts), snippet: clip(h.snippet, 240) ?? "", sessionTitle: titles.get(h.event.sessionId) })),
          ...(raw.length > offset + limit ? { nextCursor: String(offset + limit) } : {}),
        };
      },
    },
    {
      name: "improve",
      title: "What to fix first",
      description:
        "Start here to improve the agent setup: what goes wrong most in this repo's sessions, each with an example session, the CLAUDE.md/AGENTS.md line that fixes it and next commands, plus whether recent changes helped.",
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
      title: "Did a CLAUDE.md change help?",
      description:
        "Did a committed CLAUDE.md, AGENTS.md, rule or skill change help? Per change: lines added, flagged sessions before vs after (and which after, with flags), how often the agent follows each new line, and a verdict. No model calls. Default 30d.",
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
        "Audit the setup to trim it: each memory file, CLAUDE.md, AGENTS.md, rule and skill with the sessions that loaded and read it and its load tokens; unused first. After trimming, check: true finds deleted safety lines. Default 30d.",
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
          window: WINDOW_OUT,
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
        return { sessionId: s.id, count: countNodes(tree), topLevel: tree.length, subagents: tree.slice(offset, offset + limit), ...(more ? { nextCursor: String(offset + limit), truncated: true } : {}) };
      },
    },
    {
      name: "session_tree",
      title: "Whole multi-agent run as a tree",
      description:
        "A whole multi-agent run as one tree: from any session, its top-level agent and every subagent; or with run:true a fan-out sharing a run id. Each node has model, cost, tokens, duration and flags. Also rolled-up totals, the worst flag, and worst (the node to fix first).",
      inputSchema: input({ sessionId: SESSION_ID, run: { type: "boolean", default: false, description: "Read sessionId as a run id (CODING_SH_RUN_ID) instead of a session." } }, ["sessionId"]),
      outputSchema: {
        ...out(
          {
            runId: S,
            totals: out({ sessions: I, costUsd: N, inputTokens: I, outputTokens: I, toolCalls: I, toolErrors: I, filesChanged: I, durationMs: N, flags: arr(S) }, ["sessions"]),
            worst: out({ sessionId: S, role: S, flags: arr(S) }),
            tree: arr({ $ref: "#/$defs/treeNode" }),
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
        return {
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
          ...(worst ? { worst: { sessionId: worst.session.id, role: worst.depth === 0 ? "root" : (worst.session.parent?.type ?? "subagent"), flags: worstFirst(worst.session.flags) } } : {}),
          tree: tree.roots.map(treeNodeJson),
        };
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
        if (a.confirm !== true) throw new ToolError("Not created: this writes an eval task to the user's coding.sh store. Ask the user, then call again with confirm: true.");
        const ctx = await c.store();
        const s = await resolveSession(ctx, strArg(a, "sessionId")!);
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
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
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
          if (e instanceof InitError) throw new ToolError(e.message);
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
        const pool = await recentSessions({ root, since, ...(repo ? { sessionsRepo: repo === "all" ? "all" : resolve(c.cwd, repo) } : {}) }, ctx.index, now, a.flagged === true);
        const ranked = await rankSessions(ctx.index, pool, { now });
        const eligible = ranked.filter((x) => x.eligible);
        const limit = numArg(a, "limit", 10);
        const shown = [...eligible.slice(0, limit), ...(a.includeRejected === true ? ranked.filter((x) => !x.eligible) : [])];
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
      description: "List dataset experiments, newest first, with dataset, trials, and pass rate with its confidence interval. Compare two with experiment_compare.",
      inputSchema: input({ dataset: { type: "string", description: "Only experiments on this dataset id." }, name: { type: "string", description: "Only experiments with this exact name." }, limit: LIMIT(20, 100), cursor: CURSOR }),
      outputSchema: out(
        {
          experiments: arr(out({ id: S, name: S, dataset: S, passRate: N }, ["id", "name"])),
          nextCursor: S,
        },
        ["experiments"],
      ),
      annotations: READ,
      async run(a, c) {
        const ctx = await c.store();
        const { FileEvalStore } = await import("../datasets/store.ts");
        const store = new FileEvalStore({ env: c.env, index: ctx.index });
        const offset = cursorArg(a);
        const limit = numArg(a, "limit", 20);
        const dataset = strArg(a, "dataset");
        const name = strArg(a, "name");
        const all = await store.listExperiments({ limit: offset + limit + 1, ...(dataset ? { datasetId: dataset } : {}), ...(name ? { name } : {}) });
        const page = all.slice(offset, offset + limit);
        return {
          experiments: page.map((e) => ({
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
          })),
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
          baseline: out({ id: S, passRate: N }),
          candidate: out({ id: S, passRate: N }),
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
        const [{ FileEvalStore }, { compareExperiments, IncompleteExperimentError }] = await Promise.all([import("../datasets/store.ts"), import("../experiments/compare.ts")]);
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
        const gate = cmp.gate;
        const t = cmp.turnover;
        return {
          baseline: { id: cmp.a.id, name: cmp.a.name, passRate: round(cmp.a.passRate) },
          candidate: { id: cmp.b.id, name: cmp.b.name, passRate: round(cmp.b.passRate) },
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
      outputSchema: out({ session: out({ id: S }), blocks: arr(out({ kind: S })), total: I, nextCursor: S, error: out({ reason: S }) }),
      annotations: READ,
      async run(a, c) {
        const { session, root } = await expSession(a, c);
        const { readTimeline } = await import("../experiments/session.ts");
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
      outputSchema: out({ session: out({ id: S }), block: out({ text: S }), error: out({ reason: S }) }),
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
      name: "status",
      title: "coding.sh status",
      description:
        "Health of coding.sh itself: version and whether an update is available, data dir, sessions captured in the last 24h and per-agent last capture, pending spool and the last capture error. Use when data looks missing or stale.",
      inputSchema: input({}),
      outputSchema: out(
        {
          version: S,
          update: out({ latest: S, available: B, install: S }, ["available"]),
          home: S,
          last24h: out({ sessions: I, agents: arr(S) }),
          lastCapture: arr(out({ agent: S, at: S }, ["agent"])),
          latest: SESSION_OUT,
          lastError: out({ error: S }),
          hints: arr(S),
        },
        ["version", "update", "home", "last24h"],
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
        const update = updateInfo(ctx.paths.root);
        const spool = spoolStats(ctx.paths.spool);
        const lastError = lastSpoolError(ctx.paths.spoolErrors);
        const hints: string[] = [];
        if (update.available) hints.push(`coding.sh ${update.latest} is available (running ${update.current}). Tell the user; update with: ${update.install ?? "coding.sh update"}`);
        if (!latest) hints.push(noSessionsHint(ctx.env));
        else if (!day.sessions.length) hints.push("No sessions in the last 24h: if agents ran, check hooks with `coding.sh doctor`.");
        return {
          version: version(),
          update,
          home: ctx.paths.root,
          store: ctx.config.store.index,
          last24h: { sessions: day.sessions.length, agents: [...new Set(day.sessions.map((s) => s.agent))].sort() },
          lastCapture: [...lastByAgent].sort((x, y) => x[0].localeCompare(y[0])).map(([agent, s]) => ({ agent, at: iso(lastActivity(s)), sessionId: s.id })),
          latest: latest ? sessionSummary(latest, now) : undefined,
          spool,
          lastError,
          hints,
        };
      },
    },
    ...scoreTools(),
  ];
}

/** 4 decimals; NaN/Infinity (e.g. no paired cases) become undefined so the field is omitted. */
const round = (n: number): number | undefined => (Number.isFinite(n) ? Math.round(n * 10_000) / 10_000 : undefined);
