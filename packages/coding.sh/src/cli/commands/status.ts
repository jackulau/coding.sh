// coding.sh status: capture totals, pending spool, latest session, and whether
// the ingest the hook starts has stopped (core/ingest-health.ts). When the store
// can't be opened it still says where the home is, what waits in the spool and
// since when ingest is stopped, then fails with the store's error.
import { ingestStoppedField, readIngestStopped, spoolSize, type IngestStopped } from "../../core/ingest-health.ts";
import { paths } from "../../core/paths.ts";
import { autoIngest, pendingField, readIngest, oneLine, sessionJson, withContext } from "../common.ts";
import { ago, bytes, CliError, plural, type Output } from "../output.ts";
import type { CommandContext } from "../types.ts";
import { noSessionsNext } from "../first-session.ts";

/** "stopped 4h ago: why; run coding.sh update" */
export function ingestStoppedText(s: IngestStopped, now = Date.now()): string {
  return `stopped ${ago(s.since, { now })}: ${s.why}${s.next ? `; run ${s.next}` : ""}`;
}

function ingestRow(out: Output, stopped: IngestStopped | undefined): void {
  if (stopped) out.row("Ingest", ingestStoppedText(stopped), "warn");
}

export async function run(c: CommandContext): Promise<number> {
  const { out } = c;
  try {
    return await status(c);
  } catch (e) {
    // A store this coding.sh can't open: say what is known without it, then fail as before.
    if (!(e instanceof CliError) || !/^store_/.test(e.reason)) throw e;
    const p = paths(c.env);
    const spool = spoolSize(p.spool);
    const stopped = readIngestStopped(p.ingestStopped);
    if (out.json) out.data({ home: p.root, spool, ...ingestStoppedField(stopped), storeError: e.reason });
    else {
      out.row("Home", p.root);
      out.row("Spool", `${plural(spool.files, "file")}, ${bytes(spool.bytes)}`);
      ingestRow(out, stopped);
    }
    throw e;
  }
}

async function status(c: CommandContext): Promise<number> {
  const { out } = c;
  return withContext(c, async (ctx) => {
    const backlog = await autoIngest(ctx, readIngest(c));
    // Read after the ingest above: one that ran has removed the marker.
    const stopped = readIngestStopped(ctx.paths.ingestStopped);
    const day = Date.now() - 86400e3;
    const recent = await ctx.index.listSessions({ since: day, limit: 10_000 });
    const [latest] = await ctx.index.listSessions({ limit: 1, parentSessionId: null });
    const agents = [...new Set(recent.map((s) => s.agent))].sort();
    const spool = spoolSize(ctx.paths.spool);
    if (out.json) {
      out.data({ home: ctx.paths.root, store: ctx.config.store.index, last24h: { sessions: recent.length, agents }, spool, latest: latest ? sessionJson(latest) : null, ...pendingField(backlog), ...ingestStoppedField(stopped) });
      return 0;
    }
    out.row("Home", ctx.paths.root);
    out.row("Store", ctx.config.store.index);
    out.row("Last 24h", recent.length ? `${plural(recent.length, "session")} from ${agents.join(", ")}` : "No sessions");
    out.row("Spool", `${plural(spool.files, "file")}, ${bytes(spool.bytes)}`);
    ingestRow(out, stopped);
    if (latest) {
      out.print(`${latest.id}  ${latest.agent}  ${ago(latest.startedAt)}  ${oneLine(latest.title, 60)}`);
    } else {
      out.note("No sessions captured yet");
      const n = noSessionsNext(c.env);
      out.next(n.label, n.command);
    }
    return 0;
  });
}
