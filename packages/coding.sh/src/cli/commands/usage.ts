// coding.sh usage [--by agent|model|agent-model|day|repo] [--since 30d] [--agent ...]
//
// Tokens per group with turns, tokens per turn and cache-read share: the CLI
// face of the MCP usage tool (same numbers). `--by agent-model` compares
// harnesses at a fixed model, e.g. T3 Code driving Codex vs Codex directly.
import { parseSince, positiveInt } from "../args.ts";
import { autoIngest, str, withContext } from "../common.ts";
import { CliError } from "../output.ts";
import type { CommandContext } from "../types.ts";

const fmt = (n: number | undefined): string => (n === undefined ? "-" : n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const pct = (n: number | undefined): string => (n === undefined ? "-" : `${Math.round(n * 100)}%`);

export async function run(c: CommandContext): Promise<number> {
  const { out } = c;
  const { usage, USAGE_GROUPS } = await import("../../mcp/data.ts");
  const by = str(c.flags.by) ?? "agent";
  if (!(USAGE_GROUPS as readonly string[]).includes(by)) throw new CliError(`--by must be one of ${USAGE_GROUPS.join(", ")}`, { reason: "bad_flag" });
  const since = parseSince(str(c.flags.since) ?? "30d");
  const limit = positiveInt(c.flags.limit, "limit") ?? 20;
  const agent = str(c.flags.agent);
  return withContext(c, async (ctx) => {
    await autoIngest(ctx);
    const r = (await usage(ctx.index, { since, topLevel: false, ...(agent ? { agent } : {}) }, by as (typeof USAGE_GROUPS)[number], limit)) as {
      groups: { key: string; sessions: number; turns: number; totalTokens: number; outputTokens: number; tokensPerTurn?: number; cacheReadShare?: number; costUsd?: number }[];
      total: { sessions: number; totalTokens: number };
      notes?: string[];
    };
    if (out.json) {
      out.data(r);
      return 0;
    }
    if (!r.groups.length) {
      out.note("No sessions in this window");
      return 0;
    }
    const cost = r.groups.some((g) => g.costUsd !== undefined);
    out.table(
      [by.toUpperCase(), "SESSIONS", "TURNS", "TOKENS", "OUTPUT", "TOK/TURN", "CACHE READ", ...(cost ? ["COST"] : [])],
      r.groups.map((g) => [g.key, String(g.sessions), String(g.turns), fmt(g.totalTokens), fmt(g.outputTokens), fmt(g.tokensPerTurn), pct(g.cacheReadShare), ...(cost ? [g.costUsd !== undefined ? `$${g.costUsd.toFixed(2)}` : "-"] : [])]),
    );
    out.note("CACHE READ = cache reads / all prompt tokens. Subagent sessions count.");
    return 0;
  });
}
