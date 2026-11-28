// coding.sh handoff <session> | coding.sh handoff --work <id>:
// Deterministic $0 context-reset brief for a single session or a multi-day work item.
// Prints copy-paste-ready Markdown on stdout (or structured JSON with --json), with status
// notes on stderr. --out writes the brief or JSON to a file cleanly.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AgentEvent, Session } from "../../schema/index.ts";
import {
  buildHandoff,
  buildWorkHandoff,
  DEFAULT_MAX_DEAD_ENDS,
  DEFAULT_MAX_WORK_DEAD_ENDS,
  DEFAULT_MAX_WORK_SESSIONS,
} from "../../core/handoff.ts";
import { indexAge } from "../../core/ingest-health.ts";
import { createRedactor } from "../../core/redact.ts";
import { readOverlay } from "../../core/work-overlay.ts";
import { parseSinceWhen, positiveInt, UsageError } from "../args.ts";
import { autoIngest, notFoundWithBacklog, pendingField, readIngest, resolveSession, str, withContext } from "../common.ts";
import { plural } from "../output.ts";
import type { CommandContext } from "../types.ts";
import { findWorkItem } from "./work.ts";

/** Default window for `handoff --work <id>` so multi-day work items are found cleanly. */
export const WORK_HANDOFF_SINCE = "30d";

export async function run(c: CommandContext): Promise<number> {
  const { out } = c;
  const sessionRef = c.positionals[0]?.trim();
  const workFlagRaw = c.flags.work;
  const workRef = str(workFlagRaw)?.trim();
  if (workFlagRaw !== undefined && !workRef) {
    throw new UsageError("--work needs a work item id, e.g. --work w3f9a1c", { reason: "missing_argument" });
  }
  if (sessionRef && workRef) {
    throw new UsageError("Pass either <session> or --work <id>, not both", { reason: "invalid_argument" });
  }
  if (!sessionRef && !workRef) {
    throw new UsageError(
      `Missing <session> or --work <id>. Usage: ${out.command("coding.sh handoff <session>")} or ${out.command("coding.sh handoff --work <id>")}`,
      { reason: "missing_argument" },
    );
  }

  const maxDeadEnds = positiveInt(c.flags["max-dead-ends"], "max-dead-ends");
  const maxSessions = positiveInt(c.flags["max-sessions"], "max-sessions") ?? DEFAULT_MAX_WORK_SESSIONS;
  const sinceText = str(c.flags.since) ?? WORK_HANDOFF_SINCE;
  const sinceMs = workRef || c.flags.since !== undefined ? parseSinceWhen(sinceText).ms : undefined;
  const outFile = str(c.flags.out)?.trim();
  if (c.flags.out !== undefined && !outFile) {
    throw new UsageError("--out needs a file path, e.g. --out handoff.md", { reason: "missing_argument" });
  }

  return withContext(c, async (ctx) => {
    const backlog = await autoIngest(ctx, readIngest(c));
    const redactor = createRedactor({
      redact: [...new Set(["secrets", ...ctx.config.capture.redact])],
      patterns: ctx.config.capture.redactPatterns,
    });

    if (workRef) {
      const age = ctx.storeOverridden ? undefined : indexAge(ctx.paths.root);
      const stale = age?.stale ? age : undefined;
      const overlay = readOverlay(ctx.paths.work);
      let found;
      try {
        found = await findWorkItem(ctx, workRef, { since: sinceMs!, sinceText }, overlay, stale?.at);
      } catch (err) {
        throw notFoundWithBacklog(err, backlog);
      }

      const byId = new Map(found.sessions.map((s) => [s.id, s]));
      const memberSessions: Session[] = [];
      for (const id of found.item.sessionIds) {
        const s = byId.get(id) ?? (await ctx.index.getSession(id));
        if (s) memberSessions.push(s);
      }
      const eventsBySession = new Map<string, AgentEvent[]>();
      for (const s of memberSessions) {
        eventsBySession.set(s.id, await ctx.index.listEvents(s.id));
      }

      const packet = buildWorkHandoff(found.item, memberSessions, eventsBySession, {
        maxDeadEnds: maxDeadEnds ?? DEFAULT_MAX_WORK_DEAD_ENDS,
        maxSessions,
        shortId: found.shortId,
        redact: redactor,
      });
      const doc: Record<string, unknown> = { ...packet };
      Object.assign(doc, pendingField(backlog));
      const summaryNote = `${plural(packet.totalSessions, "session")}, ${plural(packet.spanDays, "day")}, ${plural(packet.progress.filesChanged.length, "file")}, ${plural(packet.deadEnds.length, "dead end")}`;

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
        out.note(`Wrote work handoff brief for ${packet.workId} (${summaryNote})`);
        return 0;
      }

      if (out.json) {
        out.data(doc);
        return 0;
      }

      out.print(packet.markdown);
      out.note(`Work handoff brief for ${packet.workId} (${summaryNote})`);
      return 0;
    }

    let session;
    try {
      session = await resolveSession(ctx, sessionRef!);
    } catch (err) {
      throw notFoundWithBacklog(err, backlog);
    }

    const events = await ctx.index.listEvents(session.id);
    const packet = buildHandoff(session, events, {
      maxDeadEnds: maxDeadEnds ?? DEFAULT_MAX_DEAD_ENDS,
      redact: redactor,
    });
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
