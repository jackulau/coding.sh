// coding.sh blame <path>[:line[-end]]: git blame with the captured agent
// session that wrote each line (src/attribution/blame.ts). Read-only on git.
import { resolve } from "node:path";
import { blameFile, parseBlameTarget } from "../../attribution/blame.ts";
import { shortSessionId, str, withContext } from "../common.ts";
import { cliCommand } from "../next-steps.ts";
import { plural } from "../output.ts";
import type { CommandContext } from "../types.ts";
import { attributionCliError, report } from "./attribution.ts";

export async function run(c: CommandContext): Promise<number> {
  const { out } = c;
  let target: ReturnType<typeof parseBlameTarget>;
  try {
    target = parseBlameTarget(c.positionals[0]!);
  } catch (e) {
    throw attributionCliError(e, "blame", c.env);
  }
  return withContext(c, async (ctx) => {
    const r = await report(c, ctx, {}, "blame");
    let b;
    try {
      b = await blameFile(ctx, { cwd: resolve(c.cwd, str(c.flags.repo) ?? "."), path: resolve(c.cwd, target.path), ...(target.lines ? { lines: target.lines } : {}), report: r });
    } catch (e) {
      throw attributionCliError(e, "blame", c.env);
    }
    if (out.json) {
      out.data({ root: b.root, rev: b.rev, path: b.path, unattributed: b.unattributed, sessions: b.sessions.map((s) => ({ ...s, startedAt: new Date(s.startedAt).toISOString() })), lines: b.rows });
      return 0;
    }
    const by = b.rows.length - b.unattributed;
    out.print(`${b.path} at ${b.rev.slice(0, 8)}: ${by} of ${plural(b.rows.length, "line")} by ${plural(b.sessions.length, "agent session")}`);
    out.print();
    const width = String(b.rows.at(-1)?.line ?? 1).length;
    // A subagent's short id names it, not its parent (a03d2f6b:sub:a7d49789).
    const idWidth = Math.max(8, ...b.rows.map((row) => (row.sessionId ? shortSessionId(row.sessionId).length : 0)));
    for (const row of b.rows) {
      const who = row.sessionId ? `${shortSessionId(row.sessionId).padEnd(idWidth)} ${(row.agent ?? "").padEnd(11)}` : out.style("-".padEnd(idWidth + 12), "faint");
      out.print(`${String(row.line).padStart(width)}  ${row.commit.slice(0, 8)}  ${who}  ${row.text}`);
    }
    if (b.sessions.length) {
      out.print();
      out.table(
        ["SESSION", "AGENT", "MODEL", "LINES"],
        b.sessions.map((s) => [s.id, s.agent, s.model ?? "-", String(s.lines)]),
      );
      out.next("Open the session that wrote the most of it", cliCommand(c.env, ["show", b.sessions[0]!.id]));
    }
    return 0;
  });
}
