// The coding.sh MCP tools. Read-mostly, small paginated outputs; each tool has
// an inputSchema, an outputSchema, and annotations. eval_from_session is the
// only write and needs `confirm: true`.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "../core/context.ts";
import type { Session } from "../core/types.ts";
import { failureFlags } from "../core/sessions.ts";
import { parseSince } from "../cli/args.ts";
import { version } from "../cli/meta.ts";
import { isNewer } from "../update/semver.ts";
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
  sessionSummary,
  SESSION_ENV_VARS,
  subagentTree,
  usage,
  type ScanQuery,
  type UsageGroup,
  USAGE_GROUPS,
} from "./data.ts";
import { sessionDigest } from "./digest.ts";
import { ToolError, type ToolDef } from "./protocol.ts";

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

const AGENT = { type: "string", description: "Only this agent, e.g. claude-code, codex, cursor, opencode, t3code (sessions T3 Code ran)." };
const REPO = { type: "string", description: "Only sessions in this repo or directory: an absolute path (matches at or under it) or a bare repo folder name." };
const SINCE = (d: string) => ({ type: "string", description: `Window start: 30m, 12h, 7d, 2w or an ISO date. Default ${d}.` });
const UNTIL = { type: "string", description: "Window end, same format as since. Default now." };
const LIMIT = (d: number, max: number) => ({ type: "integer", minimum: 1, maximum: max, default: d, description: `Max rows (default ${d}, max ${max}).` });
const CURSOR = { type: "string", description: "nextCursor from the previous call, to get the next page." };
const PROJECT = { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,62}$", description: 'Only this project (a `coding.sh serve` ingest key decides it; local captures are "default"). Default: all projects.' };
const SESSION_ID = { type: "string", minLength: 1, description: 'Session id from sessions_list/search, or "latest" for the newest top-level session.' };

const input = (properties: Obj, required: string[] = []): Obj => ({ type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false });
const out = (properties: Obj, required: string[] = []): Obj => ({ type: "object", properties, ...(required.length ? { required } : {}) });

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

async function resolveSession(ctx: Context, id: string): Promise<Session> {
  if (id === "latest" || id === "last") {
    const [s] = await ctx.index.listSessions({ limit: 1, parentSessionId: null });
    if (!s) throw new ToolError("No sessions captured yet. Run `coding.sh init` to install capture hooks, then use an agent.");
    return s;
  }
  const s = await ctx.index.getSession(id);
  if (!s) throw new ToolError(`No session with id ${JSON.stringify(id)}. Find ids with sessions_list or search; ids are exact (no prefixes).`);
  return s;
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
        "List captured agent sessions, newest first, with turns, tool calls/errors, tokens, cost and failure flags. Use to find session ids or browse recent work; use search for text inside sessions.",
      inputSchema: input({
        agent: AGENT,
        repo: REPO,
        since: SINCE("all time"),
        until: UNTIL,
        flag: { type: "string", description: "Only sessions with this failure flag: premature-completion, repeated-tool-failure, no-verification or compaction." },
        flagged: { type: "boolean", description: "Only sessions with any failure flag." },
        includeSubagents: { type: "boolean", default: false, description: "Also list subagent (child) sessions. Default false." },
        project: PROJECT,
        limit: LIMIT(20, 100),
        cursor: CURSOR,
      }),
      outputSchema: out({ sessions: arr(SESSION_OUT), nextCursor: S, truncated: B }, ["sessions"]),
      annotations: READ,
      async run(a, c) {
        const ctx = await c.store();
        const q = query(a, c, { topLevel: a.includeSubagents !== true });
        const flag = strArg(a, "flag");
        if (flag) q.flag = flag;
        if (a.flagged === true) q.where = (s) => failureFlags(s.flags).length > 0;
        const offset = cursorArg(a);
        const limit = numArg(a, "limit", 20);
        const p = await pageSessions(ctx.index, q, offset, limit);
        const now = c.now();
        return { sessions: p.sessions.map((s) => sessionSummary(s, now)), ...(p.hasMore ? { nextCursor: String(offset + limit) } : {}), ...(p.truncated ? { truncated: true } : {}) };
      },
    },
    {
      name: "session_get",
      title: "Get a session",
      description:
        "One session as a digest: summary, per-turn index, and a timeline of prompts, replies, tool calls (with failures and durations), model calls, file changes and tests. Pass turn to zoom into one turn; page with cursor.",
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
        "The session of the agent calling this tool: matched by session id env var, else the most recent (preferably still running: no end seen and active in the last 30 min) session in this working directory or repo. Returns its summary and latest timeline entries.",
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
        if (!hit) throw new ToolError(`No captured session ran in ${cwd}. Check capture with the status tool, or find the session with sessions_list.`);
        return { matchedBy: hit.matchedBy, cwd, ...(await sessionDigest(ctx.index, hit.session, { limit, offset: 0, from: "tail", now: c.now() })) };
      },
    },
    {
      name: "search",
      title: "Search sessions",
      description: "Full-text search over captured prompts, replies and tool input/output across all sessions. Returns matching events with session ids and snippets; open one with session_get.",
      inputSchema: input({ query: { type: "string", minLength: 1, description: "Words to find (all must match)." }, agent: AGENT, project: PROJECT, limit: LIMIT(10, 50), cursor: CURSOR }, ["query"]),
      outputSchema: out({ hits: arr(out({ sessionId: S, kind: S, snippet: S }, ["sessionId", "kind", "snippet"])), nextCursor: S }, ["hits"]),
      annotations: READ,
      async run(a, c) {
        const ctx = await c.store();
        const offset = cursorArg(a);
        const limit = numArg(a, "limit", 10);
        const agent = strArg(a, "agent");
        const project = strArg(a, "project");
        const raw = await ctx.index.search(strArg(a, "query") ?? "", { limit: offset + limit + 1, ...(agent ? { agent } : {}), ...(project ? { project } : {}) });
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
      name: "failures",
      title: "What went wrong",
      description:
        "What went wrong lately: sessions with failure flags or failing tests, the most frequent tool errors (with a sample message), and prompts where the user pushed back on the agent. Default window 7d.",
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
        "Tokens and cost over a window by day (local time), agent, model, agent-model or repo: totals, turns, tokensPerTurn, cacheReadShare, top sessions (by cost, else output tokens). costUsd is omitted when no session reported one (unknown, not $0). Subagents count. Default 7d by day.",
      inputSchema: input({
        since: SINCE("7d"),
        until: UNTIL,
        agent: AGENT,
        repo: REPO,
        groupBy: { type: "string", enum: [...USAGE_GROUPS], default: "day", description: "Group rows by day, agent, model, agent-model (agent + model, to compare harnesses at a fixed model) or repo. Default day." },
        limit: LIMIT(31, 100),
      }),
      outputSchema: out(
        {
          window: WINDOW_OUT,
          groupBy: S,
          total: out({ costUsd: N, totalTokens: N }),
          groups: arr(out({ key: S, costUsd: N, totalTokens: N }, ["key"])),
          topSessions: arr(out({ id: S, costUsd: N }, ["id"])),
          topSessionsRankedBy: { type: "string", enum: ["costUsd", "outputTokens"] },
          notes: arr(S),
        },
        ["window", "groupBy", "total", "groups"],
      ),
      annotations: READ,
      async run(a, c) {
        const ctx = await c.store();
        return usage(ctx.index, query(a, c, { sinceDefault: "7d", topLevel: false }), (strArg(a, "groupBy") ?? "day") as UsageGroup, numArg(a, "limit", 31));
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
          instruction: { type: "string", description: "What the agent is asked to do. Default: the session's first prompt. Required when the session recorded none (e.g. captured with coding.sh run)." },
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
        "Paired comparison of two experiments on the same cases: pass-rate difference with a bootstrap CI, McNemar p-value, verdict (better/worse/inconclusive), regressed and improved cases, per-grader deltas and power warnings.",
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
          warnings: arr(S),
        },
        ["baseline", "candidate", "verdict", "diff", "paired"],
      ),
      annotations: READ,
      async run(a, c) {
        const ctx = await c.store();
        const [{ FileEvalStore }, { compareExperiments }] = await Promise.all([import("../datasets/store.ts"), import("../experiments/compare.ts")]);
        const store = new FileEvalStore({ env: c.env, index: ctx.index });
        const ids = [strArg(a, "baseline")!, strArg(a, "candidate")!];
        const [ea, eb] = await Promise.all(ids.map((id) => store.getExperiment(id).catch(() => undefined)));
        for (const [i, e] of [ea, eb].entries()) if (!e) throw new ToolError(`No experiment with id ${JSON.stringify(ids[i])}. Find ids with experiments_list.`);
        const cmp = compareExperiments(ea!, eb!, { iters: 2000 });
        const limit = numArg(a, "limit", 10);
        const cases = (xs: { caseId: string; a: number; b: number }[]) => xs.slice(0, limit).map((x) => ({ caseId: x.caseId, baseline: round(x.a), candidate: round(x.b) }));
        const warnings = [...(cmp.datasetWarning ? [cmp.datasetWarning] : []), ...cmp.power.warnings.map((w) => w.message)];
        return {
          baseline: { id: cmp.a.id, name: cmp.a.name, passRate: round(cmp.a.passRate) },
          candidate: { id: cmp.b.id, name: cmp.b.name, passRate: round(cmp.b.passRate) },
          verdict: cmp.verdict,
          diff: { mean: round(cmp.diff.mean), lo: round(cmp.diff.lo), hi: round(cmp.diff.hi) },
          paired: cmp.paired,
          onlyInBaseline: cmp.onlyInA.length,
          onlyInCandidate: cmp.onlyInB.length,
          mcnemar: { regressions: cmp.mcnemar.b, improvements: cmp.mcnemar.c, p: round(cmp.mcnemar.p) },
          regressions: cases(cmp.regressions),
          improvements: cases(cmp.improvements),
          graders: cmp.graders.slice(0, limit).map((g) => ({ id: g.id, meanBaseline: round(g.meanA), meanCandidate: round(g.meanB), diff: round(g.diff.mean), lo: round(g.diff.lo), hi: round(g.diff.hi) })),
          warnings,
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
        if (!latest) hints.push("No sessions captured yet: run `coding.sh init` to install capture hooks.");
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
  ];
}

/** 4 decimals; NaN/Infinity (e.g. no paired cases) become undefined so the field is omitted. */
const round = (n: number): number | undefined => (Number.isFinite(n) ? Math.round(n * 10_000) / 10_000 : undefined);
