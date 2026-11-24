// coding.sh ingest [--backfill] [--rebuild] [--agent ...] [--since ...] [--background]
//
// --background is what the hook starts at session end: it takes the ingest
// lock without waiting and exits 0 quietly when another ingest holds it, or
// took it over mid-run (that one re-runs for the hook's wake-up marker, or
// after its last pass starts another background ingest for it, and the next
// read's lazy ingest picks up anything else). It also re-parses
// sessions stored by an older adapter parse, once per upgrade (core/reparse.ts).
// Nobody sees its output, so when it fails (a store this coding.sh can't open)
// it leaves the marker `status`, the status line and `doctor` print as "ingest
// stopped" (core/ingest-health.ts); the next ingest that works removes it.
// `--background --backfill` is what init starts when its import budget runs out:
// it imports the rest of the history under paths.importLock (one at a time).
//
// --rebuild re-parses every session (of --agent) from its transcript and spool now.
//
// The foreground run also folds sessions that have events but no row, and rows
// tagged fold:error (core/ingest.ts repairSessions): the repair `doctor` names.
import { existsSync } from "node:fs";
import { parseSince } from "../args.ts";
import { list, lockContention, oneLine, str, tailIngest, underImportLock, withContext } from "../common.ts";
import { CliError, plural, type Output } from "../output.ts";
import type { CommandContext } from "../types.ts";
import type { Context } from "../../core/context.ts";
import type { IngestResult } from "../../core/ingest.ts";
import type { ReparseResult } from "../../core/reparse.ts";
import type { RunMonitorsResult } from "../../monitor/run.ts";
import { markIngestStopped, type IngestStopped } from "../../core/ingest-health.ts";
import { paths } from "../../core/paths.ts";
import { healHookBin } from "../hookbin.ts";
import { version } from "../meta.ts";
import { pickAdapters } from "./init.ts";

export async function run(c: CommandContext): Promise<number> {
  const agents = list(c.flags.agent);
  if (agents.length) pickAdapters(agents);
  const since = str(c.flags.since) !== undefined ? parseSince(str(c.flags.since)!) : undefined;
  const background = c.flags.background === true;
  const rebuild = c.flags.rebuild === true;
  // After `npm i -g` of a newer version, bring ~/.coding.sh/bin up to this CLI.
  await healHookBin(c.env);
  if (!background) return ingest(c, { agents, since, background, rebuild });
  try {
    return await ingest(c, { agents, since, background, rebuild });
  } catch (e) {
    markIngestStopped(paths(c.env).ingestStopped, ingestFailure(e));
    throw e;
  }
}

/**
 * An ingest the blob store stopped (a write failed; the lines from there on wait) leaves the
 * same marker as one that threw, so status, doctor and the status line say so once it
 * happens twice in a row. The next ingest that gets through removes it.
 */
function markBlobStop(ctx: Context, results: (IngestResult | undefined)[]): boolean {
  const failed = results.find((r) => r?.storeWriteFailed !== undefined)?.storeWriteFailed;
  if (failed === undefined) return false;
  // The next step names where the blob store is set: [store] blobs in the config (or CODING_SH_BLOB_URL).
  markIngestStopped(ctx.paths.ingestStopped, { reason: "blob_write_failed", why: oneLine(failed, 120), next: "coding.sh config path", version: version() });
  return true;
}

/** Why a background ingest failed, as the marker keeps it. */
function ingestFailure(e: unknown): Omit<IngestStopped, "since" | "at" | "failures"> {
  const ce = e instanceof CliError ? e : undefined;
  const why =
    ce?.reason === "store_newer"
      ? "a newer coding.sh migrated the store, and this one can't open it"
      : ce?.reason === "store_owned" || ce?.reason === "store_version"
        ? "the store needs a migration that this coding.sh runs only when asked"
        : oneLine(e instanceof Error ? e.message : String(e), 120);
  const failure: Omit<IngestStopped, "since" | "at" | "failures"> = { reason: ce?.reason ?? "error", why, version: version() };
  const next = ce?.next[1];
  if (next) failure.next = next;
  return failure;
}

async function ingest(c: CommandContext, o: { agents: string[]; since: number | undefined; background: boolean; rebuild: boolean }): Promise<number> {
  const { out } = c;
  const { agents, since, background, rebuild } = o;
  return withContext(c, async (ctx) => {
    if (background) {
      let r: IngestResult | undefined;
      let rp: ReparseResult | null = null;
      try {
        r = await ctx.ingest({ lock: { waitMs: 0 }, signal: c.signal });
        // Another process reading the transcripts (a read's tail child, another background ingest) has them.
        if (!c.signal.aborted) await tailIngest(ctx, { signal: c.signal, waitMs: 0 });
        try {
          if (!c.signal.aborted && (await ctx.reparseDue())) rp = await ctx.reparse();
        } catch (e) {
          if (!lockContention(e)) throw e; // another re-parse runs, or an ingest kept the lock: the next one does it
        }
      } catch (e) {
        if (!lockContention(e)) throw e;
      }
      // --backfill: the rest of init's history import. It needs no spool lock, so it runs even
      // while another ingest drains the spool; another import running makes it a no-op.
      const bf = c.flags.backfill === true && !c.signal.aborted ? ((await underImportLock(ctx, 5000, () => ctx.backfill({ ...(agents.length ? { agents } : {}), ...(since !== undefined ? { since } : {}), signal: c.signal }))) ?? null) : null;
      if (!r && !bf) {
        if (out.json) out.data({ outcome: "busy" });
        return 0;
      }
      // Monitors score what this pass stored, at most once a minute each; a monitor's failure is never the ingest's.
      const mon = c.signal.aborted ? undefined : await monitorsAfter(ctx, c, false, true);
      const blobStopped = markBlobStop(ctx, [r]);
      if (out.json) out.data(withMonitors({ outcome: blobStopped ? "stopped" : "ingested", spool: r ?? null, backfill: bf, reparse: rp }, mon));
      return (r?.errors.length ?? 0) + (bf?.errors.length ?? 0) ? 1 : 0;
    }
    const spin = out.spin("Ingesting spool…");
    let r;
    try {
      // Ctrl-C stops it at the next line: what was read commits, the lock is released, and main exits 130.
      r = await ctx.ingest({ repair: true, signal: c.signal, lock: { signal: c.signal } });
    } catch (e) {
      spin.stop();
      if ((e as Error).name === "LockBusyError") {
        if (c.signal.aborted) return 130; // Ctrl-C while waiting for the other ingest
        throw new CliError(`Can't ingest: ${(e as Error).message}`, { reason: "locked", next: ["Wait for the other ingest to finish, then run:", "coding.sh ingest"] });
      }
      throw e;
    }
    spin.stop();
    let bf;
    if (c.flags.backfill === true && !c.signal.aborted) {
      const s2 = out.spin("Importing transcript history…");
      bf = await ctx.backfill({ ...(agents.length ? { agents } : {}), ...(since !== undefined ? { since } : {}), signal: c.signal });
      s2.stop();
    }
    if (c.signal.aborted) {
      // Stopped: what was read is stored; the next ingest (or read) resumes from there.
      const left = r.pendingFiles + (bf?.pendingFiles ?? 0);
      if (!out.json) out.note(`Stopped${left ? `: ${plural(left, "file")} left to ingest` : ""}; run coding.sh ingest to finish`);
      else out.data({ outcome: "interrupted", spool: r, backfill: bf ?? null, reparse: null });
      return 130;
    }
    const rp = rebuild ? await reparseWithProgress(ctx, out, { all: true, agents }) : (await ctx.reparseDue()) ? await reparseWithProgress(ctx, out, {}).catch(skipBusy) : undefined;
    const mon = c.signal.aborted ? undefined : await monitorsAfter(ctx, c, true);
    const errors = r.errors.length + (bf?.errors.length ?? 0) + (rp?.errors.length ?? 0);
    const blobStopped = markBlobStop(ctx, [r]);
    if (out.json) {
      out.data(withMonitors({ outcome: blobStopped ? "stopped" : rebuild ? "rebuilt" : "ingested", spool: r, backfill: bf ?? null, reparse: rp ?? null }, mon));
      return errors ? 1 : 0;
    }
    out.row("Spool", `${plural(r.events, "event")}, ${plural(r.sessions, "session")}${r.errors.length ? `, ${plural(r.errors.length, "error")}` : ""}`, r.errors.length ? "warn" : "ok");
    if (r.repaired) out.row("Repaired", `${plural(r.repaired, "session")} that had events but no session row, or a failed fold`, "ok");
    if (bf) out.row("Backfill", `${plural(bf.events, "event")}, ${plural(bf.sessions, "session")}, ${bf.duplicates} already captured${bf.errors.length ? `, ${plural(bf.errors.length, "error")}` : ""}`, bf.errors.length ? "warn" : "ok");
    if (rp) {
      out.row("Re-parsed", `${plural(rp.reparsed, "session")} (${plural(rp.removed, "row")} removed, ${rp.inserted} written)${rp.errors.length ? `, ${plural(rp.errors.length, "error")}` : ""}`, rp.errors.length ? "warn" : "ok");
      out.row("Kept", `${plural(rp.kept, "session")} without a source to re-read`, "ok");
      if (rp.copiesRemoved) out.row("Removed", `${plural(rp.copiesRemoved, "session")} that copied another session`, "ok");
      if (rp.refolded) out.row("Refolded", `${plural(rp.refolded, "session")} from their stored rows (new stats and flags)`, "ok");
      for (const [reason, n] of keptReasons(rp).slice(0, 3)) out.note(`${n} kept: ${reason}`);
    }
    if (mon) monitorRows(out, mon);
    for (const e of [...r.errors, ...(bf?.errors ?? []), ...(rp?.errors ?? [])].slice(0, 5)) out.note(typeof e === "string" ? e : JSON.stringify(e));
    return errors ? 1 : 0;
  });
}

/**
 * Runs the monitors (src/monitor) after an ingest pass; undefined when there are none. Never throws.
 * Each monitor error is shown once, from the result (its summary row, or monitors[] with --json): the
 * log lines that repeat one are dropped, and the rest (a state that could not be saved) are kept.
 */
async function monitorsAfter(ctx: Context, c: CommandContext, force: boolean, background = false): Promise<(RunMonitorsResult & { logs: string[] }) | undefined> {
  if (!existsSync(ctx.paths.monitors)) return undefined;
  const { monitorsAfterIngest } = await import("../../monitor/run.ts");
  const lines: string[] = [];
  const r = await monitorsAfterIngest(ctx, { force, signal: c.signal, log: (m) => lines.push(m) });
  if (!r) return undefined;
  const shown = new Set(r.monitors.flatMap((m) => (m.error ? [`monitor ${m.name}: ${m.error}`] : [])));
  if (r.error) shown.add(`monitors: ${r.error}`);
  const logs = lines.filter((l) => !shown.has(l));
  // With --json stdout is the document: the lines no result carries go to stderr. A background
  // ingest shows no summary rows, so its stderr keeps every line.
  for (const l of c.out.json ? logs : background ? lines : []) process.stderr.write(`${l}\n`);
  return { ...r, logs };
}

function monitorRows(out: Output, mon: RunMonitorsResult & { logs: string[] }): void {
  for (const l of mon.logs) out.note(l);
  if (mon.error) return out.row("Monitors", mon.error, "warn");
  if (mon.busy) return out.row("Monitors", "another process is running them", "ok");
  for (const m of mon.monitors) {
    const parts = [`${m.scored} scored`, m.failed ? `${m.failed} failed` : "", m.stopped === "budget" ? "daily spend limit reached" : "", m.stopped === "no-provider" ? "no judge provider" : ""].filter(Boolean);
    out.row(`Monitor ${m.name}`, parts.join(", "), m.error ? "warn" : "ok");
    if (m.error) out.note(`${m.name}: ${m.error}`);
  }
}

/** An automatic re-parse another process is running (or a held ingest lock) is not this command's failure. */
function skipBusy(e: unknown): undefined {
  if (e instanceof CliError && e.reason === "locked") return undefined;
  if (lockContention(e)) return undefined;
  throw e;
}

/** Kept sessions grouped by reason, most common first. */
function keptReasons(rp: ReparseResult): [string, number][] {
  const n = new Map<string, number>();
  for (const k of rp.keptSessions) n.set(k.reason, (n.get(k.reason) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1]);
}

/** The ingest's JSON, with the monitors' results when monitors ran. */
function withMonitors(data: Record<string, unknown>, mon: { monitors: unknown } | undefined): Record<string, unknown> {
  if (mon) data.monitors = mon.monitors;
  return data;
}

async function reparseWithProgress(ctx: Context, out: Output, o: { all?: boolean; agents?: string[] }): Promise<ReparseResult> {
  const spin = out.spin(o.all ? "Re-parsing sessions…" : "Re-parsing sessions stored by an older coding.sh…");
  try {
    return await ctx.reparse({
      ...(o.all ? { all: true } : {}),
      ...(o.agents?.length ? { agents: o.agents } : {}),
      onProgress: (p) => spin.update(p.phase === "spool" ? "Re-reading the spool…" : p.phase === "transcripts" ? `Re-reading ${p.agent} transcripts… (${p.done}/${p.total} sessions)` : p.phase === "refold" ? `Refolding sessions… ${p.done}/${p.total}` : `Re-parsing sessions… ${p.done}/${p.total}`),
    });
  } catch (e) {
    if (lockContention(e)) throw new CliError(`Can't re-parse: ${(e as Error).message}`, { reason: "locked", next: ["Wait for the other re-parse or ingest to finish, then run:", "coding.sh ingest --rebuild"] });
    throw e;
  } finally {
    spin.stop();
  }
}
