// coding.sh cache doctor [--agent a,b] [--since 30d] [--limit N] [--where <query>]
//
// The prompt cache's health over a window: the hit rate (`usage`'s cacheReadShare, over the same
// sessions), a 0-100 grade, and the cache breaks ranked by what they cost, each with its structural
// cause, the fix, and the two calls to pass to `coding.sh diff-calls`. Analysis: ../cache-health.ts.
import { scanSessions, TOTALS_SCAN_CAP } from "../../mcp/data.ts";
import type { Session } from "../../schema/index.ts";
import { parseSince, positiveInt, UsageError } from "../args.ts";
import { BREAK_EVENT_KINDS, breakTotals, cacheHealth, type CacheHealth, type ClassifiedBreak, hasStoredRequest, sessionBreaks } from "../cache-health.ts";
import { agentScope, agentsFlag, autoIngest, emptyStateNext, pendingField, queryCliError, readIngest, scanCap, stoppedAfter, str, whereFlag, withContext } from "../common.ts";
import { plural, tokens, usd, type Output } from "../output.ts";
import type { CommandContext } from "../types.ts";

/** Sessions with breaks whose stored requests are read, costliest first. The totals, the causes and the grade cover the rest too. */
const DEFAULT_LIMIT = 200;

/** Cache reads / all prompt tokens, rounded as `usage` rounds cacheReadShare. */
export function hitRateOf(sessions: Iterable<Session>): { hitRate?: number; promptTokens: number } {
  const acc = hitRateAcc();
  for (const s of sessions) acc.add(s);
  return acc.rate();
}

/** hitRateOf one session at a time, for a scan that keeps no rows. */
function hitRateAcc(): { add(s: Session): void; rate(): { hitRate?: number; promptTokens: number } } {
  let read = 0;
  let prompt = 0;
  return {
    add(s) {
      const u = s.stats.usage ?? {};
      read += u.cacheReadTokens ?? 0;
      prompt += (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
    },
    rate: () => ({ ...(prompt ? { hitRate: Math.round((read / prompt) * 1000) / 1000 } : {}), promptTokens: prompt }),
  };
}

/** "in the last 30d" for a duration, "since 2026-11-01" for a date. */
const windowText = (v: string) => (/^\d+(\.\d+)?\s*[smhdw]$/.test(v.trim()) ? `in the last ${v.trim()}` : `since ${v}`);
const pct = (n: number) => `${Math.round(n * 100)}%`;
const money = (n: number | undefined) => (n === undefined ? "-" : `~${usd(n)}`);

/** The priced total, and how many breaks it leaves out because their model has no price. */
export function extraText(r: CacheHealth): string {
  const left = r.unpricedBreaks ? `${r.unpricedBreaks} ${r.unpricedBreaks === 1 ? "break" : "breaks"} on an unpriced model not counted` : "";
  if (r.extraUsd === undefined) return left ? ` (${left})` : "";
  return ` (${money(r.extraUsd)} extra${left ? `; ${left}` : ""})`;
}

function render(out: Output, r: CacheHealth, sessions: number, sinceText: string): void {
  if (r.hitRate === undefined) {
    out.print(`Prompt cache: no cache tokens in ${plural(sessions, "session")} ${windowText(sinceText)}; these agents did not report cache use, or caching is off`);
    return;
  }
  out.print(`Prompt cache: ${pct(r.hitRate)} hit rate, grade ${r.grade} (${r.score}/100)`);
  if (!r.breaks) {
    out.print(`${plural(sessions, "session")} ${windowText(sinceText)}: no cache breaks; the cached prefix held between calls`);
    return;
  }
  const avoid = r.avoidableTokens ? `, ${tokens(r.avoidableTokens)} of them avoidable (${pct(r.avoidableShare ?? 0)} of all prompt tokens)` : ", none of them avoidable";
  out.print(`${plural(sessions, "session")} ${windowText(sinceText)}: ${plural(r.breaks, "cache break")} re-billed ${tokens(r.lostTokens)} of ${tokens(r.promptTokens)} prompt tokens${extraText(r)}${avoid}`);
  out.print();
  out.table(
    ["CAUSE", "BREAKS", "SESSIONS", "RE-BILLED", "EXTRA"],
    r.causes.map((c) => [c.cause, String(c.count), String(c.sessions), tokens(c.lostTokens), money(c.extraUsd)]),
  );
  out.print();
  r.causes.forEach((c, i) => {
    out.print(`${i + 1}. ${c.cause}${c.avoidable ? "" : " (not avoidable)"}: ${c.fix}`);
    if (c.example) out.print(`   e.g. ${c.example.command}`);
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
    // Every session in the window counts, as in `usage`; only the ones with breaks are kept.
    const cap = scanCap(c.env) ?? TOTALS_SCAN_CAP;
    const rate = hitRateAcc();
    const withBreaks: Session[] = [];
    let count = 0;
    let truncated = false;
    try {
      const it = scanSessions(ctx.index, { since, topLevel: false, ...(agent ? { agent } : {}), ...(where ? { query: where } : {}) }, cap);
      for (;;) {
        const next = await it.next();
        if (next.done) {
          truncated = next.value.truncated;
          break;
        }
        count++;
        rate.add(next.value);
        if ((next.value.stats.cacheBreaks?.count ?? 0) > 0) withBreaks.push(next.value);
      }
    } catch (e) {
      throw queryCliError(e);
    }
    const { hitRate, promptTokens } = rate.rate();
    const broken = withBreaks
      .sort((a, b) => (b.stats.cacheBreaks?.extraUsd ?? 0) - (a.stats.cacheBreaks?.extraUsd ?? 0) || (b.stats.cacheBreaks?.lostTokens ?? 0) - (a.stats.cacheBreaks?.lostTokens ?? 0));
    // Every session with breaks has its calls read, so every break gets a cause and the grade does
    // not move with --limit. The limit bounds the sessions whose stored requests are read too; a
    // session with none takes no place in it, and reads the same either way.
    const breaks: ClassifiedBreak[] = [];
    let read = 0;
    let skipped = 0;
    for (const s of broken) {
      const events = await ctx.index.listEvents(s.id, { kinds: BREAK_EVENT_KINDS });
      const requests = read < limit && events.some(hasStoredRequest);
      if (requests) read++;
      const found = await sessionBreaks(ctx.blobs, events, { requests });
      if (found.some((b) => b.notRead)) skipped++;
      breaks.push(...found);
    }
    const r = cacheHealth({ ...(hitRate !== undefined ? { hitRate } : {}), promptTokens, breaks, totals: breakTotals(broken.map((s) => s.stats.cacheBreaks!)) });
    if (out.json) {
      out.data({ since: new Date(since).toISOString(), sessions: count, ...r, ...(skipped ? { sessionsNotRead: skipped } : {}), ...(truncated ? { truncated: true } : {}), ...pendingField(backlog) });
      return 0;
    }
    if (!count) {
      out.note(`No sessions ${windowText(sinceText)}${agent || where ? " that match" : ""}`);
      await emptyStateNext(out, c.env, ctx.index, { label: "Widen the window", command: "coding.sh cache doctor --since 90d" });
      return 0;
    }
    render(out, r, count, sinceText);
    if (r.degraded) out.note(`${r.degraded} of ${r.breaks} breaks were classified without both stored requests (capture mode metadata, or no coding.sh proxy), from hashes, the model and timing only; run the agent through coding.sh proxy with capture mode full to see tool and system prompt changes`);
    if (skipped) out.note(`Read the stored requests of the ${read} costliest ${read === 1 ? "session" : "sessions"} with breaks; ${skipped} more not read (--limit): ${r.breaksNotRead === 1 ? "1 break is" : `${r.breaksNotRead ?? 0} breaks are`} classified from hashes, message counts, the model and timing there, and the totals and the grade count them`);
    if (truncated) out.warn(stoppedAfter(cap));
    return 0;
  }, { create: false });
}
