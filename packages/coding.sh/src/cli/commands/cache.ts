// coding.sh cache doctor [--agent a,b] [--since 30d] [--limit N] [--where <query>]
//
// The prompt cache's health over a window: the hit rate (`usage`'s cacheReadShare, over the same
// sessions), a 0-100 grade, and the cache breaks ranked by what they cost, each with its structural
// cause, the fix, and the two calls to pass to `coding.sh diff-calls`. Analysis: ../cache-health.ts.
import { collectSessions } from "../../mcp/data.ts";
import type { Session } from "../../schema/index.ts";
import { parseSince, positiveInt, UsageError } from "../args.ts";
import { cacheHealth, type CacheHealth, type ClassifiedBreak, sessionBreaks } from "../cache-health.ts";
import { agentScope, agentsFlag, autoIngest, pendingField, queryCliError, readIngest, str, whereFlag, withContext } from "../common.ts";
import { tokens, usd, type Output } from "../output.ts";
import type { CommandContext } from "../types.ts";

/** Sessions with breaks whose events are read, costliest first. */
const DEFAULT_LIMIT = 200;

/** Cache reads / all prompt tokens, rounded as `usage` rounds cacheReadShare. */
export function hitRateOf(sessions: readonly Session[]): { hitRate?: number; promptTokens: number } {
  let read = 0;
  let prompt = 0;
  for (const s of sessions) {
    const u = s.stats.usage ?? {};
    read += u.cacheReadTokens ?? 0;
    prompt += (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
  }
  return { ...(prompt ? { hitRate: Math.round((read / prompt) * 1000) / 1000 } : {}), promptTokens: prompt };
}

/** "in the last 30d" for a duration, "since 2026-11-01" for a date. */
const windowText = (v: string) => (/^\d+(\.\d+)?\s*[smhdw]$/.test(v.trim()) ? `in the last ${v.trim()}` : `since ${v}`);
const pct = (n: number) => `${Math.round(n * 100)}%`;
const money = (n: number | undefined) => (n === undefined ? "-" : `~${usd(n)}`);

function render(out: Output, r: CacheHealth, sessions: number, sinceText: string): void {
  if (r.hitRate === undefined) {
    out.print(`Prompt cache: no cache tokens in ${sessions} sessions ${windowText(sinceText)}; these agents did not report cache use, or caching is off`);
    return;
  }
  out.print(`Prompt cache: ${pct(r.hitRate)} hit rate, grade ${r.grade} (${r.score}/100)`);
  if (!r.breaks) {
    out.print(`${sessions} sessions ${windowText(sinceText)}: no cache breaks; the cached prefix held between calls`);
    return;
  }
  const avoid = r.avoidableTokens ? `, ${tokens(r.avoidableTokens)} of them avoidable (${pct(r.avoidableShare ?? 0)} of all prompt tokens)` : ", none of them avoidable";
  out.print(`${sessions} sessions ${windowText(sinceText)}: ${r.breaks} cache breaks re-billed ${tokens(r.lostTokens)} of ${tokens(r.promptTokens)} prompt tokens${r.extraUsd !== undefined ? ` (${money(r.extraUsd)} extra)` : ""}${avoid}`);
  out.print();
  out.table(
    ["CAUSE", "BREAKS", "SESSIONS", "RE-BILLED", "EXTRA"],
    r.causes.map((c) => [c.cause, String(c.count), String(c.sessions), tokens(c.lostTokens), money(c.extraUsd)]),
  );
  out.print();
  r.causes.forEach((c, i) => {
    out.print(`${i + 1}. ${c.cause}${c.avoidable ? "" : " (not avoidable)"}: ${c.fix}`);
    out.print(`   e.g. ${c.example.command}`);
  });
}

export async function run(c: CommandContext): Promise<number> {
  const { out } = c;
  if (c.action !== "doctor") throw new UsageError(`Unknown cache command ${JSON.stringify(c.action)}`, { reason: "unknown_command", suggestion: "coding.sh cache doctor" });
  const sinceText = str(c.flags.since) ?? "30d";
  const since = parseSince(sinceText);
  const limit = positiveInt(c.flags.limit, "limit") ?? DEFAULT_LIMIT;
  const { agent, where } = agentScope(agentsFlag(c), whereFlag(c));
  return withContext(c, async (ctx) => {
    const backlog = await autoIngest(ctx, readIngest(c));
    const { sessions, truncated } = await collectSessions(ctx.index, { since, topLevel: false, ...(agent ? { agent } : {}), ...(where ? { query: where } : {}) }).catch((e) => Promise.reject(queryCliError(e)));
    const { hitRate, promptTokens } = hitRateOf(sessions);
    const broken = sessions
      .filter((s) => (s.stats.cacheBreaks?.count ?? 0) > 0)
      .sort((a, b) => (b.stats.cacheBreaks?.extraUsd ?? 0) - (a.stats.cacheBreaks?.extraUsd ?? 0) || (b.stats.cacheBreaks?.lostTokens ?? 0) - (a.stats.cacheBreaks?.lostTokens ?? 0));
    const read = broken.slice(0, limit);
    const breaks: ClassifiedBreak[] = [];
    for (const s of read) breaks.push(...(await sessionBreaks(ctx.blobs, await ctx.index.listEvents(s.id))));
    const r = cacheHealth({ ...(hitRate !== undefined ? { hitRate } : {}), promptTokens, breaks });
    const skipped = broken.length - read.length;
    if (out.json) {
      out.data({ since: new Date(since).toISOString(), sessions: sessions.length, ...r, ...(skipped ? { sessionsNotRead: skipped } : {}), ...(truncated ? { truncated: true } : {}), ...pendingField(backlog) });
      return 0;
    }
    if (!sessions.length) {
      out.note(`No sessions ${windowText(sinceText)}${agent || where ? " that match" : ""}`);
      return 0;
    }
    render(out, r, sessions.length, sinceText);
    if (r.degraded) out.note(`${r.degraded} of ${r.breaks} breaks were classified without both stored requests (capture mode metadata, or no coding.sh proxy), from hashes, the model and timing only; run the agent through coding.sh proxy with capture mode full to see tool and system prompt changes`);
    if (skipped) out.note(`Read the ${read.length} costliest sessions with breaks; ${skipped} more not read (--limit)`);
    if (truncated) out.note("Scanned the newest sessions only; narrow with --since");
    return 0;
  });
}
