// coding.sh handoff <session>: deterministic $0 context-reset brief for a fresh session.
// Prints copy-paste-ready Markdown on stdout (or structured JSON with --json), with status
// notes on stderr. --out writes the brief or JSON to a file cleanly.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildHandoff, DEFAULT_MAX_DEAD_ENDS } from "../../core/handoff.ts";
import { createRedactor } from "../../core/redact.ts";
import { positiveInt, UsageError } from "../args.ts";
import { autoIngest, notFoundWithBacklog, pendingField, readIngest, resolveSession, str, withContext } from "../common.ts";
import { plural } from "../output.ts";
import type { CommandContext } from "../types.ts";

export async function run(c: CommandContext): Promise<number> {
  const { out } = c;
  const ref = c.positionals[0]!;
  const maxDeadEnds = positiveInt(c.flags["max-dead-ends"], "max-dead-ends") ?? DEFAULT_MAX_DEAD_ENDS;
  const outFile = str(c.flags.out)?.trim();
  if (c.flags.out !== undefined && !outFile) {
    throw new UsageError("--out needs a file path, e.g. --out handoff.md", { reason: "missing_argument" });
  }

  return withContext(c, async (ctx) => {
    const backlog = await autoIngest(ctx, readIngest(c));
    let session;
    try {
      session = await resolveSession(ctx, ref);
    } catch (err) {
      throw notFoundWithBacklog(err, backlog);
    }

    const events = await ctx.index.listEvents(session.id);
    const redactor = createRedactor({
      redact: [...new Set(["secrets", ...ctx.config.capture.redact])],
      patterns: ctx.config.capture.redactPatterns,
    });
    const packet = buildHandoff(session, events, { maxDeadEnds, redact: redactor });
    const doc: Record<string, unknown> = { ...packet };
    Object.assign(doc, pendingField(backlog));

    if (outFile) {
      const outPath = resolve(c.cwd, outFile);
      mkdirSync(dirname(outPath), { recursive: true });
      if (out.json) {
        writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
        out.data({ ...doc, path: outPath });
        return 0;
      }
      writeFileSync(outPath, `${packet.markdown}\n`, "utf8");
      out.print(outPath);
      out.note(
        `Wrote handoff brief for ${packet.sessionId} (${plural(packet.progress.filesChanged.length, "file")}, ${plural(packet.deadEnds.length, "dead end")})`,
      );
      return 0;
    }

    if (out.json) {
      out.data(doc);
      return 0;
    }

    out.print(packet.markdown);
    out.note(
      `Handoff brief for ${packet.sessionId} (${plural(packet.progress.filesChanged.length, "file")}, ${plural(packet.deadEnds.length, "dead end")})`,
    );
    return 0;
  }, { create: false });
}
