// coding.sh blame <path>[:line[-end]]: git blame with the captured agent
// session that wrote each line (src/attribution/blame.ts). Read-only on git.
import { resolve } from "node:path";
import { blameFile, parseBlameTarget } from "../../attribution/blame.ts";
import { str, withContext } from "../common.ts";
import { plural } from "../output.ts";
import type { CommandContext } from "../types.ts";
import { attributionCliError, report } from "./attribution.ts";

export async function run(c: CommandContext): Promise<number> {
  const { out } = c;
  let target: ReturnType<typeof parseBlameTarget>;
  try {
    target = parseBlameTarget(c.positionals[0]!);
  } catch (e) {
    throw attributionCliError(e);
  }
  return withContext(c, async (ctx) => {
    const r = await report(c, ctx);
    let b;
    try {
      b = await blameFile(ctx, { cwd: resolve(c.cwd, str(c.flags.repo) ?? "."), path: resolve(c.cwd, target.path), ...(target.lines ? { lines: target.lines } : {}), report: r });
    } catch (e) {
      throw attributionCliError(e);
    }
    if (out.json) {
      out.data({ root: b.root, rev: b.rev, path: b.path, unattributed: b.unattributed, sessions: b.sessions.map((s) => ({ ...s, startedAt: new Date(s.startedAt).toISOString() })), lines: b.rows });
      return 0;
    }
    const by = b.rows.length - b.unattributed;
    out.print(`${b.path} at ${b.rev.slice(0, 8)}: ${by} of ${plural(b.rows.length, "line")} by ${plural(b.sessions.length, "agent session")}`);
    out.print();
    const width = String(b.rows.at(-1)?.line ?? 1).length;
    for (const row of b.rows) {
      const who = row.sessionId ? `${row.sessionId.slice(0, 8).padEnd(8)} ${(row.agent ?? "").padEnd(11)}` : out.style("-".padEnd(20), "faint");
      out.print(`${String(row.line).padStart(width)}  ${row.commit.slice(0, 8)}  ${who}  ${row.text}`);
    }
    if (b.sessions.length) {
      out.print();
      out.table(
        ["SESSION", "AGENT", "MODEL", "LINES"],
        b.sessions.map((s) => [s.id, s.agent, s.model ?? "-", String(s.lines)]),
      );
      out.next("Open the session that wrote the most of it", `coding.sh show ${b.sessions[0]!.id}`);
    }
    return 0;
  });
}
