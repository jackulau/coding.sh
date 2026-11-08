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
import { repriceStored } from "../../core/reprice.ts";
import { parseSince, positiveInt } from "../args.ts";
import { autoIngest, queryCliError, str, whereFlag, withContext } from "../common.ts";
import { CliError, usd } from "../output.ts";
import type { CommandContext } from "../types.ts";

const fmt = (n: number | undefined): string => (n === undefined ? "-" : n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const pct = (n: number | undefined): string => (n === undefined ? "-" : `${Math.round(n * 100)}%`);

interface Row {
  key: string;
  sessions: number;
  turns: number;
  totalTokens: number;
  outputTokens: number;
  tokensPerTurn?: number;
  cacheReadShare?: number;
  costUsd?: number;
  estimatedCostUsd?: number;
  estimatedCostByTier?: Record<string, number>;
  costPartial?: boolean;
  duplicateFetches?: number;
  duplicateFetchTokens?: number;
  cacheBreaks?: number;
  cacheBreakTokens?: number;
  cacheBreakUsd?: number;
}

/** `$1.23`, `~$1.23` when part of it is estimated, `≥$1.23` (a lower bound) when some sessions in the row have tokens but no cost. */
const costCell = (g: Row): string => (g.costUsd === undefined ? "-" : `${g.costPartial ? "≥" : ""}${g.estimatedCostUsd ? "~" : ""}${usd(g.costUsd)}`);

export async function run(c: CommandContext): Promise<number> {
  const { out } = c;
  const { usage, USAGE_GROUPS } = await import("../../mcp/data.ts");
  const by = str(c.flags.by) ?? "agent";
  if (!(USAGE_GROUPS as readonly string[]).includes(by)) throw new CliError(`--by must be one of ${USAGE_GROUPS.join(", ")}`, { reason: "bad_flag" });
  const since = parseSince(str(c.flags.since) ?? "30d");
  const limit = positiveInt(c.flags.limit, "limit") ?? 20;
  const agent = str(c.flags.agent);
  const where = whereFlag(c);
  return withContext(c, async (ctx) => {
    await autoIngest(ctx);
    const repriced = c.flags.reprice === true ? await repriceStored(ctx.index, ctx.config.pricing, { force: true }) : undefined;
    const r = (await usage(ctx.index, { since, topLevel: false, ...(agent ? { agent } : {}), ...(where ? { query: where } : {}) }, by as (typeof USAGE_GROUPS)[number], limit).catch((e) => Promise.reject(queryCliError(e)))) as {
      groups: Row[];
      total: Row;
      notes?: string[];
      unpricedModels?: Record<string, number>;
    };
    if (out.json) {
      out.data(repriced ? { ...r, repriced: { events: repriced.events, sessions: repriced.sessions } } : r);
      return 0;
    }
    if (repriced) out.note(`Repriced ${repriced.events} model calls in ${repriced.sessions} sessions`);
    if (!r.groups.length) {
      out.note("No sessions in this window");
      return 0;
    }
    const cost = r.groups.some((g) => g.costUsd !== undefined);
    out.table(
      [by.toUpperCase(), "SESSIONS", "TURNS", "TOKENS", "OUTPUT", "TOK/TURN", "CACHE READ", ...(cost ? ["COST"] : [])],
      r.groups.map((g) => [g.key, String(g.sessions), String(g.turns), fmt(g.totalTokens), fmt(g.outputTokens), fmt(g.tokensPerTurn), pct(g.cacheReadShare), ...(cost ? [costCell(g)] : [])]),
    );
    out.note("TURNS = user turns (top-level sessions). TOK/TURN = input + output + cache-write tokens per turn, cache reads left out. CACHE READ = cache reads / all prompt tokens. Subagent tokens count.");
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
    return 0;
  });
}
