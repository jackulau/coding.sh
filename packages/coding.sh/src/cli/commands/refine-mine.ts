// coding.sh refine mine: failure patterns across this repo's recent sessions
// (src/refine/mine.ts): repeated error signatures, repeated user instructions,
// session flags and failed eval runs, ranked, each with an evidence count and
// example sessions. $0: no model call. `--json` is the input `refine propose`
// and agents read.
import { resolve } from "node:path";
import { formatFindings, mineFindings, type MinSupport } from "../../refine/mine.ts";
import { parseSince, positiveInt, UsageError } from "../args.ts";
import { list, str, withContext } from "../common.ts";
import { plural } from "../output.ts";
import type { CommandContext } from "../types.ts";
import { gitRoot } from "./exp-ab.ts";

/** "3" (sessions; days stay 2) or "3,2" (sessions, days). */
export function parseMinSupport(v: string | undefined): Partial<MinSupport> {
  if (v === undefined) return {};
  const m = /^\s*(\d+)\s*(?:,\s*(\d+)\s*)?$/.exec(v);
  if (!m || Number(m[1]) < 1 || (m[2] !== undefined && Number(m[2]) < 1)) throw new UsageError(`--min-support takes SESSIONS or SESSIONS,DAYS (whole numbers of at least 1), got ${JSON.stringify(v)}`, { reason: "invalid_argument", suggestion: "coding.sh refine mine --min-support 3,2" });
  return { sessions: Number(m[1]), ...(m[2] !== undefined ? { days: Number(m[2]) } : {}) };
}

export async function refineMine(c: CommandContext): Promise<number> {
  const { out } = c;
  const since = parseSince(str(c.flags.since) ?? "30d");
  const repoFlag = str(c.flags.repo);
  const repo = repoFlag === "all" ? undefined : repoFlag ? resolve(c.cwd, repoFlag) : (gitRoot(c.cwd) ?? c.cwd);
  const minSupport = parseMinSupport(str(c.flags["min-support"]));
  const limit = positiveInt(c.flags.limit, "limit") ?? 20;
  const agents = list(c.flags.agent);
  return withContext(c, async (ctx) => {
    const r = await mineFindings({ index: ctx.index, since, ...(repo ? { repo } : {}), ...(agents.length ? { agents } : {}), minSupport, limit });
    if (out.json) {
      out.data({ since: new Date(since).toISOString(), repo: repo ?? "all", analyzed: r.analyzed, minSupport: r.minSupport, belowSupport: r.belowSupport, findings: r.findings });
      return 0;
    }
    if (!r.findings.length) {
      out.note(`No pattern seen in ${r.minSupport.sessions}+ sessions over ${r.minSupport.days}+ days (${plural(r.analyzed, "session")} since ${new Date(since).toISOString().slice(0, 10)}${repo ? ` under ${repo}` : ""}; ${plural(r.belowSupport, "pattern")} below that)`);
      if (r.analyzed) out.next("Lower the bar to see rarer patterns", "coding.sh refine mine --min-support 2,1");
      else out.next("Look further back, or in every repo", "coding.sh refine mine --since 90d --repo all");
      return 0;
    }
    for (const l of formatFindings(r.findings)) out.print(l);
    out.note(`${plural(r.findings.length, "pattern")} in ${plural(r.analyzed, "session")} since ${new Date(since).toISOString().slice(0, 10)}${r.belowSupport ? `; ${plural(r.belowSupport, "pattern")} below ${r.minSupport.sessions} sessions over ${r.minSupport.days} days` : ""}`);
    out.next("Write an edit for the top patterns", "coding.sh refine propose");
    return 0;
  });
}
