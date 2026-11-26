// coding.sh eval candidates: which captured sessions in this repo would make the
// best eval tasks (eval/candidates.ts). Read-only.
import { resolve } from "node:path";
import { repoRoot } from "../../core/git.ts";
import { printedRefs } from "../../core/session-ref.ts";
import { formatCandidates, rankSessions, rejectSummary, startReadable } from "../../eval/candidates.ts";
import { DEFAULT_SESSION_LIMIT, DEFAULT_SINCE_MS, recentSessions } from "../../eval/init.ts";
import { parseAge, positiveInt } from "../args.ts";
import { autoIngest, emptyStateNext, str, withContext } from "../common.ts";
import { cliCommand, widerSince } from "../next-steps.ts";
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
    const ranked = await rankSessions(ctx.index, pool, { now, startReadable: (dir) => startReadable(dir, c.env) });
    const eligible = ranked.filter((x) => x.eligible);
    const shown = showAll ? [...eligible.slice(0, limit), ...ranked.filter((x) => !x.eligible)] : eligible.slice(0, limit);
    if (out.json) {
      out.data({ candidates: shown, considered: ranked.length, eligible: eligible.length, rejected: ranked.length - eligible.length });
      return 0;
    }
    if (!ranked.length) {
      // The window and place as given, and a step that starts further back in the same place (from this repo, in every repo).
      const flagged = flags.flagged === true;
      const span = str(flags.since)?.trim() || `${DEFAULT_SINCE_MS / 86_400_000} days`;
      const place = repo === "all" ? "" : repo ? ` in ${repo}` : " in this repo";
      out.note(`No ${flagged ? "flagged " : ""}sessions in the last ${span}${place}`);
      const wider = ["eval", "candidates", "--since", widerSince(now - since, now), "--repo", repo || "all"];
      if (flagged) wider.push("--flagged");
      await emptyStateNext(out, c.env, ctx.index, { label: repo ? "Look further back" : "Look further back, or in every repo", command: cliCommand(c.env, wider) });
      return 0;
    }
    // Each session by a reference that opens it when pasted (core/session-ref.ts): a row's own session whole when the
    // id pastes as is, and the session a wrapper recorded short, though its first 8 characters can name another session too.
    const refs = await printedRefs(ctx.index, { whole: shown.map((x) => x.sessionId), short: shown.flatMap((x) => (x.wrapped ? [x.wrapped] : [])) });
    out.print(formatCandidates(shown, refs.short, refs.whole));
    const rej = rejectSummary(ranked);
    if (rej && !showAll) out.note(`${ranked.length - eligible.length} session(s) can't become a task: ${rej} (--all lists them)`);
    if (eligible.length) out.next("Turn the best ones into a suite", `coding.sh eval init --sessions${eligible[0]!.verifierGuess ? "" : " --verifier '<CMD>'"}`);
    return 0;
  });
}
