// coding.sh status: capture totals, pending spool, latest session, and whether
// the ingest the hook starts has stopped (core/ingest-health.ts), and how old the
// index is: when the latest ingest finished. When the store
// can't be opened it still says where the home is, what waits in the spool and
// since when ingest is stopped, then fails with the store's error.
import { indexAge, indexAgeField, indexUpdatedText, ingestStoppedField, readIngestStopped, spoolSize, type IngestStopped } from "../../core/ingest-health.ts";
import { paths } from "../../core/paths.ts";
import { maskStoreUrl } from "../../core/store-url.ts";
import { countsLine, needYou, readWorkQueue, WORK_WINDOW_MS } from "../../core/work.ts";
import { readOverlay } from "../../core/work-overlay.ts";
import { autoIngest, pendingField, readIngest, oneLine, sessionJson, withContext } from "../common.ts";
import { ago, bytes, CliError, plural, type Output } from "../output.ts";
import type { CommandContext } from "../types.ts";
import { noSessionsNext } from "../first-session.ts";
import { cliCommand } from "../next-steps.ts";

/** "stopped 4h ago: why; run coding.sh update" */
export function ingestStoppedText(s: IngestStopped, now = Date.now()): string {
  return `stopped ${ago(s.since, { now })}: ${s.why}${s.next ? `; run ${s.next}` : ""}`;
}

/**
 * The marker with its next step named for this shell (Output.command): the background ingest that
 * wrote it ran in the agent's environment, not the user's.
 */
function forShell(out: Output, s: IngestStopped | undefined): IngestStopped | undefined {
  return s?.next ? { ...s, next: out.command(s.next) } : s;
}

function ingestRow(out: Output, stopped: IngestStopped | undefined, answer = false): void {
  if (stopped) out.row("Ingest", ingestStoppedText(stopped), "warn", answer);
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
    const stopped = forShell(out, readIngestStopped(p.ingestStopped));
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
    const stopped = forShell(out, readIngestStopped(ctx.paths.ingestStopped));
    // A store named by --store or CODING_SH_STORE_URL is filled elsewhere: this home's record says nothing about it.
    const age = ctx.storeOverridden ? undefined : indexAge(ctx.paths.root);
    const day = Date.now() - 86400e3;
    const recent = await ctx.index.listSessions({ since: day, limit: 10_000 });
    const [latest] = await ctx.index.listSessions({ limit: 1, parentSessionId: null });
    const agents = [...new Set(recent.map((s) => s.agent))].sort();
    const spool = spoolSize(ctx.paths.spool);
    // The work queue's counts (core/work.ts), over the window `coding.sh work` reads by default.
    // An old index: the counts are judged as of its last ingest, as `coding.sh work` judges them.
    const { queue } = await readWorkQueue(ctx.index, { since: Date.now() - WORK_WINDOW_MS, overlay: readOverlay(ctx.paths.work), now: age?.stale ? age.at : undefined });
    if (out.json) {
      out.data({ home: ctx.paths.root, store: maskStoreUrl(ctx.config.store.index), last24h: { sessions: recent.length, agents }, work: { ...queue.counts, needYou: needYou(queue) }, spool, latest: latest ? sessionJson(latest) : null, ...pendingField(backlog), ...ingestStoppedField(stopped), ...indexAgeField(age) });
      return 0;
    }
    out.row("Home", ctx.paths.root, "none", true);
    out.row("Store", maskStoreUrl(ctx.config.store.index), "none", true);
    out.row("Last 24h", recent.length ? `${plural(recent.length, "session")} from ${agents.join(", ")}` : "No sessions", "none", true);
    // Files ingest has yet to read (the same count --json gives as pending.files).
    const waiting = backlog.pendingFiles ? `, ${plural(backlog.pendingFiles, "file")} not yet ingested${backlog.indexing ? " (ingest running)" : ""}` : "";
    out.row("Spool", `${plural(spool.files, "file")}, ${bytes(spool.bytes)}${waiting}`, "none", true);
    ingestRow(out, stopped, true);
    if (age) out.row("Index", `${indexUpdatedText(age)}${age.stale ? `; run ${cliCommand(c.env, ["ingest"])}` : ""}`, age.stale ? "warn" : "none", true);
    out.row("Work", `${countsLine(queue.counts)}${needYou(queue) ? ` (${cliCommand(c.env, ["work"])})` : ""}`, needYou(queue) ? "warn" : "none", true);
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
