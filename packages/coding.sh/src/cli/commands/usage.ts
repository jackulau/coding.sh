// coding.sh usage [--by agent|model|agent-model|day|repo] [--since 30d] [--agent ...] [--reprice]
//
// Tokens per group with turns, tokens per turn and cache-read share: the CLI
// face of the MCP usage tool (same numbers). `--by agent-model` compares
// harnesses at a fixed model, e.g. T3 Code driving Codex vs Codex directly.
// Costs are reported or gateway-billed where the agent gave one, else tokens
// times list price (marked `~`), at the rates each call ran at (batch, flex,
// priority, long context: `estimatedCostByTier`). `--reprice` recomputes those estimates from the
// current price table first (it also runs by itself when the table changes). Waste totals:
// prompt-cache breaks (tokens billed again, extra USD) and repeated read-only calls.
import { CACHE_BREAK_FIX, CACHE_IDLE_FIX, CACHE_IDLE_LABEL } from "../../core/cache-breaks.ts";
import type { CacheBreakCause, CacheIdleKind } from "../../schema/index.ts";
import { repriceStored } from "../../core/reprice.ts";
import { CACHE_BASELINE_NOTE } from "../../core/cache-baselines.ts";
import { parseSinceWhen, positiveInt, UsageError } from "../args.ts";
import { agentScope, agentsFlag, autoIngest, emptyStateNext, queryCliError, scanCap, stoppedAfter, str, timeWindow, whereFlag, windowJson, windowNote, withContext, pendingField, readIngest } from "../common.ts";
import { CliError, Output, plural, usd } from "../output.ts";
import type { CommandContext } from "../types.ts";

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
  if (!(USAGE_GROUPS as readonly string[]).includes(by)) throw new CliError(`--by must be one of ${USAGE_GROUPS.join(", ")}`, { reason: "bad_flag" });
  const sinceWhen = parseSinceWhen(str(c.flags.since) ?? "30d");
  const since = sinceWhen.ms;
  const limit = positiveInt(c.flags.limit, "limit") ?? 20;
  const { agent, where } = agentScope(agentsFlag(c), whereFlag(c));
  const window = timeWindow({ since: sinceWhen }, where);
  const baseline = c.flags.baseline === true;
  if (baseline && by !== "agent" && by !== "agent-model") throw new UsageError("--baseline compares agents: use it with --by agent or --by agent-model", { reason: "invalid_argument" });
  if (baseline && c.flags.cache === true) throw new UsageError("--baseline adds a column to the main table; drop --cache", { reason: "invalid_argument" });
  return withContext(c, async (ctx) => {
    const backlog = await autoIngest(ctx, readIngest(c));
    const repriced = c.flags.reprice === true ? await repriceStored(ctx.index, ctx.config.pricing, { force: true }) : undefined;
    const r = (await usage(ctx.index, { since, topLevel: false, ...(agent ? { agent } : {}), ...(where ? { query: where } : {}) }, by as (typeof USAGE_GROUPS)[number], limit, { cap, baseline }).catch((e) => Promise.reject(queryCliError(e)))) as {
      window: { truncated?: boolean; [k: string]: unknown };
      groups: Row[];
      total: Row;
      notes?: string[];
      unpricedModels?: Record<string, number>;
    };
    if (out.json) {
      out.data({ ...r, window: { ...r.window, ...windowJson(window) }, ...(repriced ? { repriced: { events: repriced.events, sessions: repriced.sessions } } : {}), ...pendingField(backlog) });
      return 0;
    }
    if (repriced) out.note(`Repriced ${plural(repriced.events, "model call")} in ${plural(repriced.sessions, "session")}`);
    windowNote(out, window);
    if (!r.groups.length) {
      out.note("No sessions in this window");
      await emptyStateNext(out, c.env, ctx.index, { label: "Widen the window", command: "coding.sh usage --since 90d" });
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
