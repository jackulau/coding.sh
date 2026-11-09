// coding.sh eval candidates: which captured sessions in this repo would make the
// best eval tasks (eval/candidates.ts). Read-only.
import { resolve } from "node:path";
import { repoRoot } from "../../core/git.ts";
import { formatCandidates, rankSessions, rejectSummary } from "../../eval/candidates.ts";
import { DEFAULT_SESSION_LIMIT, DEFAULT_SINCE_MS, recentSessions } from "../../eval/init.ts";
import { parseAge, positiveInt } from "../args.ts";
import { autoIngest, str, withContext } from "../common.ts";
import type { CommandContext } from "../types.ts";

export async function evalCandidates(c: CommandContext): Promise<number> {
  const { out, flags } = c;
  const since = str(flags.since) ? parseAge(str(flags.since)!, "since") : DEFAULT_SINCE_MS;
  const limit = positiveInt(flags.limit, "limit") ?? DEFAULT_SESSION_LIMIT;
  const repo = str(flags.repo);
  const root = (await repoRoot(c.cwd)) ?? c.cwd;
  const showAll = flags.all === true;
  return withContext(c, async (ctx) => {
    await autoIngest(ctx);
    const now = Date.now();
    const pool = await recentSessions({ root, since, ...(repo ? { sessionsRepo: repo === "all" ? "all" : resolve(c.cwd, repo) } : {}) }, ctx.index, now, flags.flagged === true);
    const ranked = await rankSessions(ctx.index, pool, { now });
    const eligible = ranked.filter((x) => x.eligible);
    const shown = showAll ? [...eligible.slice(0, limit), ...ranked.filter((x) => !x.eligible)] : eligible.slice(0, limit);
    if (out.json) {
      out.data({ candidates: shown, considered: ranked.length, eligible: eligible.length, rejected: ranked.length - eligible.length });
      return 0;
    }
    if (!ranked.length) {
      out.note(`No sessions in the last ${Math.round(since / 86_400_000)} days${repo ? "" : " in this repo"}`);
      out.next("Look further back, or in every repo", `coding.sh eval candidates --since 90d${repo ? "" : " --repo all"}`);
      return 0;
    }
    out.print(formatCandidates(shown));
    const rej = rejectSummary(ranked);
    if (rej && !showAll) out.note(`${ranked.length - eligible.length} session(s) can't become a task: ${rej} (--all lists them)`);
    if (eligible.length) out.next("Turn the best ones into a suite", `coding.sh eval init --sessions${eligible[0]!.verifierGuess ? "" : " --verifier '<CMD>'"}`);
    return 0;
  });
}
