// coding.sh usage [--by agent|model|agent-model|day|repo|mcp|skill|subagent] [--since 30d] [--agent ...] [--repo ...] [--reprice]
//
// Tokens per group with turns, tokens per turn and cache-read share: the CLI
// face of the MCP usage tool (same numbers). `--by agent-model` compares
// harnesses at a fixed model, e.g. T3 Code driving Codex vs Codex directly.
// Costs are reported or gateway-billed where the agent gave one, else tokens
// times list price (marked `~`), at the rates each call ran at (batch, flex,
// priority, long context: `estimatedCostByTier`). `--reprice` recomputes those estimates from the
// current price table first (it also runs by itself when the table changes). Waste totals:
// prompt-cache breaks (tokens billed again, extra USD) and repeated read-only calls.
// `--by mcp`, `--by skill` and `--by subagent` attribute cost to what a session used
// instead (attributedUsage below): every row carries basis "attributed".
import { CACHE_BREAK_FIX, CACHE_IDLE_FIX, CACHE_IDLE_LABEL } from "../../core/cache-breaks.ts";
import type { CacheBreakCause, CacheIdleKind, CostByTokenType } from "../../schema/index.ts";
import { repriceStored } from "../../core/reprice.ts";
import { CACHE_BASELINE_NOTE } from "../../core/cache-baselines.ts";
import { parseSinceWhen, positiveInt, UsageError } from "../args.ts";
import { agentScope, agentsFlag, agentsWithoutSessions, autoIngest, rejectAgentTypos, emptyStateNext, queryCliError, scanCap, stoppedAfter, str, timeWindow, whereFlag, windowJson, windowNote, withContext, pendingField, readIngest } from "../common.ts";
import { Output, bytes, duration, plural, usd } from "../output.ts";
import type { CommandContext } from "../types.ts";
import type { IndexStore } from "../../core/types.ts";
import type { Session } from "../../schema/index.ts";
import { mcpCallsOf, type McpCall } from "../../core/mcp-usage.ts";
import { apportion, lookupPrice, pricesFor, TOKEN_TYPES, type Prices } from "../../core/pricing.ts";
import { parsePlace, SPLIT_LABEL, type ScanQuery } from "../../mcp/data.ts";
import { userHome } from "../../core/paths.ts";

const fmt = (n: number | undefined): string => (n === undefined ? "-" : n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const pct = (n: number | undefined): string => (n === undefined ? "-" : `${Math.round(n * 100)}%`);
const ratio = (g: Row): string => (g.cacheReadWriteRatio === undefined ? "-" : `${g.cacheReadWriteRatio}:1`);

/**
 * `usage --cache`: the prompt-cache economics per group. Every number is a
 * captured token count or the per-call-priced extra the breaks cost; there is
 * no blended-rate "savings" guess. Guidance names only what the numbers show.
 */
function renderCache(out: Output, by: string, r: { groups: Row[]; total: Row }): void {
  out.table(
    [by.toUpperCase(), "SESSIONS", "CACHED", "READ", "WRITE", "R:W", "BREAKS", "WASTE"],
    r.groups.map((g) => [g.key, String(g.sessions), pct(g.cacheReadShare), fmt(g.cacheReadTokens), fmt(g.cacheWriteTokens), ratio(g), g.cacheBreaks ? String(g.cacheBreaks) : "-", g.cacheBreakUsd ? `~${usd(g.cacheBreakUsd)}` : "-"]),
  );
  out.note("CACHED = cache reads / all prompt tokens (higher is better). R:W = cache-read tokens per cache-write token; below 1:1 you wrote more cache than you read back. WASTE = extra USD the breaks cost over reading from cache (estimated).");
  const t = r.total;
  const split = costSplitNote(t);
  if (split) out.note(split);
  if (!t.cacheReadTokens && !t.cacheWriteTokens) {
    out.note("No prompt-cache tokens recorded in this window: these agents did not report cache use (or caching is off).");
    return;
  }
  if (t.cacheReadWriteRatio !== undefined && t.cacheReadWriteRatio < 1 && (t.cacheWriteTokens ?? 0) > 0) {
    out.note(`Cache read:write is ${t.cacheReadWriteRatio}:1 — you wrote ${fmt(t.cacheWriteTokens)} prompt-cache tokens but read back only ${fmt(t.cacheReadTokens)}. The cache is being re-created faster than it is reused; keep a stable prompt prefix between turns so it survives.`);
  }
  if (t.cacheLowSessions) out.note(`${t.cacheLowSessions} ${t.cacheLowSessions === 1 ? "session" : "sessions"} tagged cache:low (wrote a cache they barely read back): coding.sh sessions --where 'flag:cache:low'.`);
  if (t.cacheBreaks) {
    const causes = Object.entries(t.cacheBreakCauses ?? {}).sort((a, b) => b[1] - a[1]);
    const causeText = causes.length ? ` Causes: ${causes.map(([k, n]) => `${k} ${n}`).join(", ")}.` : "";
    out.note(`${t.cacheBreaks} cache ${t.cacheBreaks === 1 ? "break" : "breaks"}: ${fmt(t.cacheBreakTokens)} prompt tokens billed again${t.cacheBreakUsd ? ` (~${usd(t.cacheBreakUsd)} extra)` : ""}.${causeText}`);
    const top = causes[0]?.[0] as CacheBreakCause | undefined;
    if (top) out.note(`Top cause ${top}: ${CACHE_BREAK_FIX[top]}.${top === "model-switch" ? " coding.sh harness audit flags a fallback model before it costs anything." : ""}`);
    // Idle breaks mix waits you can shorten with time you were away: each gets its own fix, costliest first.
    const idle = (Object.entries(t.cacheBreakIdle ?? {}) as [CacheIdleKind, { count: number; extraUsd?: number }][]).sort((a, b) => (b[1].extraUsd ?? 0) - (a[1].extraUsd ?? 0) || b[1].count - a[1].count);
    for (const [k, v] of idle) out.note(`Idle, ${CACHE_IDLE_LABEL[k]} (${k}): ${v.count} ${v.count === 1 ? "break" : "breaks"}${v.extraUsd ? `, ~${usd(v.extraUsd)}` : ""}: ${CACHE_IDLE_FIX[k]}.`);
    out.note("Drill in: coding.sh sessions --where 'cache.breaks>0 sort:-cache.cost'; one session: coding.sh show <id>.");
  } else {
    out.note("No cache breaks in this window: the cached prefix held between turns.");
  }
}

/**
 * `usage --cache`: what the estimate paid for, by token type, cache reads first, and
 * what has no split (reported or billed costs, estimates priced without one).
 */
function costSplitNote(t: Row): string | undefined {
  const by = t.estimatedCostByTokenType;
  const share = t.estimatedCostShareByTokenType;
  if (!by || !share) return undefined;
  const pctOf = apportion(share, 100);
  const parts = TOKEN_TYPES.map((k) => `${SPLIT_LABEL[k]} ~${usd(by[k])} (${pctOf[k]}%)`).join(", ");
  const reported = r4((t.costUsd ?? 0) - (t.estimatedCostUsd ?? 0));
  const rest = [t.estimatedCostUnsplitUsd ? `~${usd(t.estimatedCostUnsplitUsd)} of the estimate` : "", reported > 0 ? `${usd(reported)} reported or billed` : ""].filter(Boolean);
  return `Estimated cost by token type: ${parts}; ~${usd(r4(TOKEN_TYPES.reduce((n, k) => n + by[k], 0)))} in all.${rest.length ? ` Not split by token type: ${rest.join(" and ")}.` : ""}`;
}

interface Row {
  key: string;
  sessions: number;
  turns: number;
  totalTokens: number;
  outputTokens: number;
  tokensPerTurn?: number;
  cacheReadShare?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheReadWriteRatio?: number;
  costUsd?: number;
  estimatedCostUsd?: number;
  estimatedCostByTier?: Record<string, number>;
  /** The estimate by token type (USD, 4 decimals) and each part's share of it. */
  estimatedCostByTokenType?: CostByTokenType;
  estimatedCostShareByTokenType?: CostByTokenType;
  /** Part of the estimate with no split by token type. */
  estimatedCostUnsplitUsd?: number;
  costPartial?: boolean;
  duplicateFetches?: number;
  duplicateFetchTokens?: number;
  cacheBreaks?: number;
  cacheBreakTokens?: number;
  cacheBreakUsd?: number;
  cacheBreakCauses?: Record<string, number>;
  cacheBreakIdle?: Record<string, { count: number; extraUsd?: number }>;
  cacheLowSessions?: number;
  cacheBaseline?: { rate: number; source: string; period: string; delta: number };
}

/** `92% (-21pt)`: the published rate and how many points this row's hit rate is above or below it; `-` without one. */
export const vsPublished = (g: Row): string => {
  const b = g.cacheBaseline;
  if (!b) return "-";
  const pt = Math.round(b.delta * 100);
  return `${pct(b.rate)} (${pt > 0 ? "+" : pt < 0 ? "-" : "±"}${Math.abs(pt)}pt)`;
};

/** `$1.23`, `~$1.23` when part of it is estimated, `≥$1.23` (a lower bound) when some sessions in the row have tokens but no cost. */
const costCell = (g: Row): string => (g.costUsd === undefined ? "-" : `${g.costPartial ? "≥" : ""}${g.estimatedCostUsd ? "~" : ""}${usd(g.costUsd)}`);

export async function run(c: CommandContext): Promise<number> {
  const { out } = c;
  const { usage, USAGE_GROUPS, TOTALS_SCAN_CAP } = await import("../../mcp/data.ts");
  const cap = scanCap(c.env) ?? TOTALS_SCAN_CAP;
  const by = str(c.flags.by) ?? "agent";
  const attributed = (ATTRIBUTED_GROUPS as readonly string[]).includes(by);
  const sinceWhen = parseSinceWhen(str(c.flags.since) ?? "30d");
  const since = sinceWhen.ms;
  const limit = positiveInt(c.flags.limit, "limit") ?? 20;
  const agents = agentsFlag(c);
  const { agent, where } = agentScope(agents, whereFlag(c));
  // --repo reads a path or a repo name as sessions --repo and a repo budget do.
  const repo = str(c.flags.repo);
  if (repo !== undefined && !repo.trim()) throw new UsageError("--repo needs a path or a repo name", { reason: "invalid_argument" });
  const place = repo !== undefined ? parsePlace(repo, c.cwd, userHome(c.env)) : undefined;
  const window = timeWindow({ since: sinceWhen }, where);
  const baseline = c.flags.baseline === true;
  if (baseline && by !== "agent" && by !== "agent-model") throw new UsageError("--baseline compares agents: use it with --by agent or --by agent-model", { reason: "invalid_argument" });
  if (baseline && c.flags.cache === true) throw new UsageError("--baseline adds a column to the main table; drop --cache", { reason: "invalid_argument" });
  if (attributed && c.flags.cache === true) throw new UsageError(`--cache reads each session's prompt-cache tokens and does not split them by ${ATTRIBUTED_NOUN[by as AttributedGroup]}: use --cache with --by agent, model, agent-model, day or repo`, { reason: "invalid_argument" });
  return withContext(c, async (ctx) => {
    const backlog = await autoIngest(ctx, readIngest(c));
    const repriced = c.flags.reprice === true ? await repriceStored(ctx.index, ctx.config.pricing, { force: true }) : undefined;
    if (attributed) {
      const scan: ScanQuery = { since, topLevel: false };
      if (agent) scan.agent = agent;
      if (place) scan.place = place;
      if (where) scan.query = where;
      const r = await attributedUsage(ctx.index, scan, by as AttributedGroup, limit, cap, pricesFor(ctx.config.pricing)).catch((e) => Promise.reject(queryCliError(e)));
      if (!r.groups.length) await rejectAgentTypos(ctx.index, agents);
      if (out.json) {
        const data: Record<string, unknown> = { ...r, window: { ...r.window, ...windowJson(window) } };
        if (repriced) data.repriced = { events: repriced.events, sessions: repriced.sessions };
        out.data(Object.assign(data, pendingField(backlog)));
        return 0;
      }
      if (repriced) out.note(`Repriced ${plural(repriced.events, "model call")} in ${plural(repriced.sessions, "session")}`);
      windowNote(out, window);
      if (!r.groups.length) {
        out.note(ATTRIBUTED_EMPTY[by as AttributedGroup]);
        await emptyStateNext(out, c.env, ctx.index, { label: "Widen the window", command: `coding.sh usage --by ${by} --since 90d` });
        return 0;
      }
      renderAttributed(out, by as AttributedGroup, r);
      if (r.window.truncated) out.warn(stoppedAfter(cap));
      return 0;
    }
    const q: ScanQuery = { since, topLevel: false, ...(agent ? { agent } : {}), ...(where ? { query: where } : {}) };
    if (place) q.place = place;
    const r = (await usage(ctx.index, q, by as (typeof USAGE_GROUPS)[number], limit, { cap, baseline }).catch((e) => Promise.reject(queryCliError(e)))) as {
      window: { truncated?: boolean; [k: string]: unknown };
      groups: Row[];
      total: Row;
      notes?: string[];
      unpricedModels?: Record<string, number>;
    };
    if (!r.groups.length) await rejectAgentTypos(ctx.index, agents);
    if (out.json) {
      out.data({ ...r, window: { ...r.window, ...windowJson(window) }, ...(repriced ? { repriced: { events: repriced.events, sessions: repriced.sessions } } : {}), ...pendingField(backlog) });
      return 0;
    }
    if (repriced) out.note(`Repriced ${plural(repriced.events, "model call")} in ${plural(repriced.sessions, "session")}`);
    windowNote(out, window);
    if (!r.groups.length) {
      // An --agent with no session at all emptied it, not the window: point at every agent's usage instead.
      const noneAtAll = agents.length > 0 && (await agentsWithoutSessions(ctx.index, agents)).length === agents.length;
      out.note(noneAtAll ? `No sessions from ${agents.join(", ")} in the store` : "No sessions in this window");
      await emptyStateNext(out, c.env, ctx.index, noneAtAll ? { label: "See every agent's usage", command: "coding.sh usage" } : { label: "Widen the window", command: "coding.sh usage --since 90d" });
      return 0;
    }
    if (c.flags.cache === true) {
      renderCache(out, by, r);
      if (r.window.truncated) out.warn(stoppedAfter(cap));
      return 0;
    }
    const cost = r.groups.some((g) => g.costUsd !== undefined);
    out.table(
      [by.toUpperCase(), "SESSIONS", "TURNS", "TOKENS", "OUTPUT", "TOK/TURN", baseline ? "CACHE HIT" : "CACHE READ", ...(baseline ? ["VS PUBLISHED"] : []), ...(cost ? ["COST"] : [])],
      r.groups.map((g) => [g.key, String(g.sessions), String(g.turns), fmt(g.totalTokens), fmt(g.outputTokens), fmt(g.tokensPerTurn), pct(g.cacheReadShare), ...(baseline ? [vsPublished(g)] : []), ...(cost ? [costCell(g)] : [])]),
    );
    out.note(`TURNS = user turns (top-level sessions). TOK/TURN = top-level sessions' input + output + cache-write tokens per turn; subagents' tokens and cache reads are left out. ${baseline ? "CACHE HIT = the prompt-cache hit rate, " : "CACHE READ = "}cache reads / all prompt tokens. SESSIONS and TOKENS count subagents.`);
    if (baseline) out.note(CACHE_BASELINE_NOTE);
    if (r.groups.some((g) => g.estimatedCostUsd)) out.note("~ = includes cost estimated from tokens × list price (no reported cost).");
    if (r.groups.some((g) => g.costPartial)) out.note("≥ = some sessions in the row have tokens but no price; the cost is a lower bound.");
    const tiers = Object.entries(r.total.estimatedCostByTier ?? {});
    if (tiers.length) out.note(`Estimated at non-standard rates: ${tiers.map(([t, v]) => `${t} ${usd(v)}`).join(", ")}`);
    const t = r.total;
    if (t.cacheBreaks) out.note(`Cache breaks: ${t.cacheBreaks}, ${fmt(t.cacheBreakTokens)} prompt tokens billed again${t.cacheBreakUsd ? ` (~${usd(t.cacheBreakUsd)} extra)` : ""}. Causes per session: coding.sh show <id>.`);
    if (t.duplicateFetches) out.note(`Re-fetches: ${t.duplicateFetches} read-only ${t.duplicateFetches === 1 ? "call" : "calls"} repeated with the same result (~${fmt(t.duplicateFetchTokens)} tokens re-sent).`);
    const unpriced = Object.entries(r.unpricedModels ?? {}).sort((a, b) => b[1] - a[1]);
    if (unpriced.length) {
      const n = unpriced.reduce((s, [, k]) => s + k, 0);
      out.note(cost ? `${n} of ${t.sessions} sessions have tokens but no reported cost; COST counts only the priced ones` : `No session in this window has a cost (none reported one, and their models have no price), so COST is left out; compare TOKENS instead`);
      const named = unpriced.slice(0, 5).map(([m, k]) => `${m} (${k})`).join(", ");
      out.note(`No price for ${named}${unpriced.length > 5 ? ` +${unpriced.length - 5} more` : ""}: add [prices."<model>"] with input and output in USD per 1M tokens to config.toml (coding.sh config path prints where)`);
    }
    if (r.window.truncated) out.warn(stoppedAfter(cap));
    return 0;
  }, { create: false });
}

// ------------------------------------------------------------ attributed groups

/** Groups that attribute cost to what a session used rather than splitting sessions: --cache and --baseline do not apply. */
export const ATTRIBUTED_GROUPS = ["mcp", "skill", "subagent"] as const;
export type AttributedGroup = (typeof ATTRIBUTED_GROUPS)[number];
const ATTRIBUTED_NOUN: Record<AttributedGroup, string> = { mcp: "MCP server", skill: "skill", subagent: "subagent type" };
const ATTRIBUTED_EMPTY: Record<AttributedGroup, string> = {
  mcp: "No MCP tool calls in this window",
  skill: "No sessions tagged skill:<name> in this window",
  subagent: "No subagent sessions in this window",
};

/** The one line under each table, and `attribution` in --json: how each column is attributed. */
export const ATTRIBUTION: Record<AttributedGroup, string> = {
  mcp: "Attributed per call: CALLS and FAILED count the tool calls to each MCP server; RESULT = bytes the calls returned; TOKENS = the stored token count, else RESULT / 4 (~); COST = those tokens at the input price of the session's model (~, estimated).",
  skill: "Attributed per session: SESSIONS, TOKENS and COST are whole sessions tagged skill:<name>. A session with two skills counts in both rows, so the rows do not add up to the total.",
  subagent: "Attributed per child session: COUNT, TOKENS, COST and MEDIAN TIME of the subagent sessions of each type (no type: unnamed). Their parents' own tokens and cost are left out.",
};

/** Bytes per token for a result with no stored count. */
export const BYTES_PER_TOKEN = 4;

interface AttributedResult {
  window: { sessions?: number; truncated?: boolean };
  groupBy: AttributedGroup;
  basis: "attributed";
  attribution: string;
  groups: Record<string, unknown>[];
  total: Record<string, unknown>;
  /** --by skill: a session with two skills is in both rows. */
  rowsOverlap?: true;
}

const r4 = (n: number): number => Math.round(n * 1e4) / 1e4;
/** MCP results are small: their cost keeps six decimals, so a few calls do not round to $0. */
const r6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const sessionTokens = (s: Session): number => {
  const u = s.stats.usage ?? {};
  return (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
};

/** Tokens and cost of whole sessions, added as `usage` adds them: a missing cost is unknown, not $0. */
interface SessionAcc {
  sessions: number;
  totalTokens: number;
  costUsd: number;
  estimatedCostUsd: number;
  priced: number;
  unpriced: number;
  durations: number[];
}
const sessionAcc = (): SessionAcc => ({ sessions: 0, totalTokens: 0, costUsd: 0, estimatedCostUsd: 0, priced: 0, unpriced: 0, durations: [] });
function addSession(a: SessionAcc, s: Session): void {
  const u = s.stats.usage ?? {};
  a.sessions++;
  a.totalTokens += sessionTokens(s);
  if (typeof u.costUsd === "number" && Number.isFinite(u.costUsd)) {
    a.costUsd += u.costUsd;
    a.estimatedCostUsd += u.estimatedCostUsd ?? 0;
    a.priced++;
  } else if (sessionTokens(s) > 0) a.unpriced++;
  if (typeof s.endedAt === "number" && s.endedAt >= s.startedAt) a.durations.push(s.endedAt - s.startedAt);
}
const median = (xs: number[]): number | undefined => {
  if (!xs.length) return undefined;
  const v = [...xs].sort((x, y) => x - y);
  const m = v.length >> 1;
  return v.length % 2 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
};
function sessionRow(a: SessionAcc, withDuration: boolean): Record<string, unknown> {
  const p50 = withDuration ? median(a.durations) : undefined;
  const row: Record<string, unknown> = { sessions: a.sessions, totalTokens: a.totalTokens };
  if (a.priced) {
    row.costUsd = r4(a.costUsd);
    if (a.estimatedCostUsd > 0) row.estimatedCostUsd = r4(a.estimatedCostUsd);
    if (a.unpriced) Object.assign(row, { costPartial: true, unpricedSessions: a.unpriced });
  }
  if (p50 !== undefined) row.medianDurationMs = Math.round(p50);
  return row;
}
/** Costliest first (a row with no cost after every priced one), then most tokens, then by name. */
const byCost = (a: Record<string, unknown>, b: Record<string, unknown>): number =>
  ((b.costUsd as number | undefined) ?? -1) - ((a.costUsd as number | undefined) ?? -1) ||
  (((b.totalTokens ?? b.resultTokens) as number) ?? 0) - (((a.totalTokens ?? a.resultTokens) as number) ?? 0) ||
  String(a.key).localeCompare(String(b.key));

/** Each session in the window, newest first, at most `cap` (truncated when it stopped there). */
async function eachSession(index: IndexStore, q: ScanQuery, cap: number, fn: (s: Session) => void | Promise<void>): Promise<{ sessions: number; truncated: boolean }> {
  const { scanSessions } = await import("../../mcp/data.ts");
  const it = scanSessions(index, q, cap);
  let n = 0;
  for (;;) {
    const next = await it.next();
    if (next.done) return { sessions: n, truncated: next.value.truncated };
    n++;
    await fn(next.value);
  }
}

/** The MCP calls of the sessions in the window: the store's narrow read, else each session's tool events. */
async function readMcpCalls(index: IndexStore, q: ScanQuery, cap: number): Promise<{ calls: McpCall[]; truncated: boolean }> {
  const { scanFilter } = await import("../../mcp/data.ts");
  if (index.mcpCalls) return { calls: await index.mcpCalls(q.query ?? {}, { filter: scanFilter(q) }), truncated: false };
  const calls: McpCall[] = [];
  const { truncated } = await eachSession(index, q, cap, async (s) => {
    calls.push(...mcpCallsOf(await index.listEvents(s.id, { kinds: ["tool.start", "tool.end"] }), s.model));
  });
  return { calls, truncated };
}

/**
 * `usage --by mcp|skill|subagent`. MCP rows add up the calls to each server and the tokens
 * their results put in the context, priced at the session model's input rate. Skill rows
 * hold whole tagged sessions (a session with two skills is in both). Subagent rows hold
 * child sessions by type, without their parents.
 */
export async function attributedUsage(index: IndexStore, q: ScanQuery, by: AttributedGroup, limit: number, cap: number, prices: Prices): Promise<AttributedResult> {
  const head = { groupBy: by, basis: "attributed" as const, attribution: ATTRIBUTION[by] };
  const finish = (rows: Record<string, unknown>[]) => rows.sort(byCost).slice(0, limit).map((r) => ({ ...r, basis: "attributed" }));
  if (by === "mcp") {
    interface McpAcc {
      calls: number;
      failedCalls: number;
      resultBytes: number;
      resultTokens: number;
      estimatedTokens: number;
      clipped: number;
      costUsd: number;
      priced: number;
      unpriced: number;
      sessions: Set<string>;
    }
    const zero = (): McpAcc => ({ calls: 0, failedCalls: 0, resultBytes: 0, resultTokens: 0, estimatedTokens: 0, clipped: 0, costUsd: 0, priced: 0, unpriced: 0, sessions: new Set() });
    const { calls, truncated } = await readMcpCalls(index, q, cap);
    const total = zero();
    const groups = new Map<string, McpAcc>();
    const rates = new Map<string, number | undefined>();
    for (const c of calls) {
      let g = groups.get(c.server);
      if (!g) groups.set(c.server, (g = zero()));
      const stored = c.resultTokens;
      const tokens = stored ?? (c.resultBytes !== undefined ? Math.ceil(c.resultBytes / BYTES_PER_TOKEN) : 0);
      const model = c.model ?? "";
      if (!rates.has(model)) rates.set(model, lookupPrice(c.model, prices)?.input);
      const rate = rates.get(model);
      for (const a of [g, total]) {
        a.calls++;
        a.sessions.add(c.sessionId);
        if (c.ok === false) a.failedCalls++;
        a.resultBytes += c.resultBytes ?? 0;
        a.resultTokens += tokens;
        if (stored === undefined) a.estimatedTokens += tokens;
        if (c.clipped) a.clipped++;
        if (tokens > 0 && rate !== undefined) {
          a.costUsd += (tokens * rate) / 1e6;
          a.priced++;
        } else if (tokens > 0) a.unpriced++;
      }
    }
    const row = (a: McpAcc): Record<string, unknown> => {
      const out: Record<string, unknown> = { sessions: a.sessions.size, calls: a.calls, failedCalls: a.failedCalls, resultBytes: a.resultBytes };
      if (a.clipped) Object.assign(out, { resultBytesPartial: true, clippedResults: a.clipped });
      out.resultTokens = a.resultTokens;
      if (a.estimatedTokens) out.estimatedResultTokens = a.estimatedTokens;
      if (a.priced) Object.assign(out, { costUsd: r6(a.costUsd), estimatedCostUsd: r6(a.costUsd) });
      if (a.priced && a.unpriced) Object.assign(out, { costPartial: true, unpricedCalls: a.unpriced });
      return out;
    };
    return { window: truncated ? { truncated } : {}, ...head, groups: finish([...groups].map(([key, a]) => ({ key, ...row(a) }))), total: row(total) };
  }
  const total = sessionAcc();
  const groups = new Map<string, SessionAcc>();
  const add = (key: string, s: Session) => {
    let g = groups.get(key);
    if (!g) groups.set(key, (g = sessionAcc()));
    addSession(g, s);
  };
  const scan = await eachSession(index, q, cap, (s) => {
    if (by === "skill") {
      // The total is every session in the window, so it shows how far the overlapping rows are from it.
      addSession(total, s);
      for (const k of new Set((s.flags ?? []).filter((f) => f.startsWith("skill:") && f.length > 6).map((f) => f.slice(6)))) add(k, s);
    } else if (s.parent && s.parent.type !== "provider-switch") {
      // A T3 Code thread that switched agents goes on as the same conversation, not a subagent: its cost is the parent's.
      addSession(total, s);
      add(s.parent.type || "unnamed", s);
    }
  });
  const window: AttributedResult["window"] = { sessions: scan.sessions };
  if (scan.truncated) window.truncated = true;
  const rows = finish([...groups].map(([key, a]) => ({ key, ...sessionRow(a, by === "subagent") })));
  const result: AttributedResult = { window, ...head, groups: rows, total: sessionRow(total, by === "subagent") };
  if (by === "skill") result.rowsOverlap = true;
  return result;
}

const cell = (g: Record<string, unknown>): string => {
  const c = g.costUsd as number | undefined;
  if (c === undefined) return "-";
  const mark = `${g.costPartial ? "≥" : ""}${g.estimatedCostUsd !== undefined ? "~" : ""}`;
  return c > 0 && c < 0.00005 ? `${mark}<$0.0001` : `${mark}${usd(c)}`;
};

function renderAttributed(out: Output, by: AttributedGroup, r: AttributedResult): void {
  const cost = r.groups.some((g) => g.costUsd !== undefined);
  const n = (v: unknown) => String(v ?? 0);
  if (by === "mcp") {
    const head = ["SERVER", "CALLS", "FAILED", "RESULT", "TOKENS"];
    if (cost) head.push("COST");
    out.table(
      head,
      r.groups.map((g) => {
        const line = [String(g.key), n(g.calls), g.failedCalls ? n(g.failedCalls) : "-", `${g.resultBytesPartial ? "≥" : ""}${bytes(g.resultBytes as number)}`, `${g.estimatedResultTokens ? "~" : ""}${fmt(g.resultTokens as number)}`];
        if (cost) line.push(cell(g));
        return line;
      }),
    );
  } else {
    const head = [by === "skill" ? "SKILL" : "SUBAGENT", by === "skill" ? "SESSIONS" : "COUNT", "TOKENS"];
    if (cost) head.push("COST");
    if (by === "subagent") head.push("MEDIAN TIME");
    out.table(
      head,
      r.groups.map((g) => {
        const line = [String(g.key), n(g.sessions), fmt(g.totalTokens as number)];
        if (cost) line.push(cell(g));
        if (by === "subagent") line.push(duration(g.medianDurationMs as number | undefined));
        return line;
      }),
    );
  }
  out.note(r.attribution);
  const t = r.total;
  if (by === "skill") out.note(`All ${plural(t.sessions as number, "session")} in the window: ${fmt(t.totalTokens as number)} tokens${t.costUsd !== undefined ? `, ${cell(t)}` : ""}.`);
  if (r.groups.some((g) => g.resultBytesPartial)) out.note("≥ under RESULT = some results were clipped to fit the index; the size is a lower bound.");
  if (r.groups.some((g) => g.costPartial)) out.note(by === "mcp" ? "≥ under COST = some calls ran on a model with no price; the cost is a lower bound." : "≥ = some sessions in the row have tokens but no price; the cost is a lower bound.");
  if (by === "mcp" && !cost) out.note('No call ran on a model with a price, so COST is left out: add [prices."<model>"] to config.toml (coding.sh config path prints where).');
}
