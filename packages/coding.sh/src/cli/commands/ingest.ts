// coding.sh ingest [--backfill] [--rebuild] [--agent ...] [--since ...] [--background]
//
// --background is what the hook starts at session end: it takes the ingest
// lock without waiting and exits 0 quietly when another ingest holds it, or
// took it over mid-run (that one re-runs for the hook's wake-up marker, and
// the next read's lazy ingest picks up anything else). It also re-parses
// sessions stored by an older adapter parse, once per upgrade (core/reparse.ts).
//
// --rebuild re-parses every session (of --agent) from its transcript and spool now.
import { parseSince } from "../args.ts";
import { list, lockContention, str, tailIngest, withContext } from "../common.ts";
import { CliError, plural, type Output } from "../output.ts";
import type { CommandContext } from "../types.ts";
import type { Context } from "../../core/context.ts";
import type { ReparseResult } from "../../core/reparse.ts";
import { pickAdapters } from "./init.ts";

export async function run(c: CommandContext): Promise<number> {
  const { out } = c;
  const agents = list(c.flags.agent);
  if (agents.length) pickAdapters(agents);
  const since = str(c.flags.since) !== undefined ? parseSince(str(c.flags.since)!) : undefined;
  const background = c.flags.background === true;
  const rebuild = c.flags.rebuild === true;
  return withContext(c, async (ctx) => {
    if (background) {
      try {
        const r = await ctx.ingest({ lock: { waitMs: 0 } });
        await tailIngest(ctx);
        let rp: ReparseResult | null = null;
        try {
          if (await ctx.reparseDue()) rp = await ctx.reparse();
        } catch (e) {
          if (!lockContention(e)) throw e; // another re-parse runs, or an ingest kept the lock: the next one does it
        }
        if (out.json) out.data({ outcome: "ingested", spool: r, backfill: null, reparse: rp });
        return r.errors.length ? 1 : 0;
      } catch (e) {
        if (!lockContention(e)) throw e;
        if (out.json) out.data({ outcome: "busy" });
        return 0;
      }
    }
    const spin = out.spin("Ingesting spool…");
    let r;
    try {
      r = await ctx.ingest();
    } catch (e) {
      spin.stop();
      if ((e as Error).name === "LockBusyError") throw new CliError(`Can't ingest: ${(e as Error).message}`, { reason: "locked", next: ["Wait for the other ingest to finish, then run:", "coding.sh ingest"] });
      throw e;
    }
    spin.stop();
    let bf;
    if (c.flags.backfill === true) {
      const s2 = out.spin("Importing transcript history…");
      bf = await ctx.backfill({ ...(agents.length ? { agents } : {}), ...(since !== undefined ? { since } : {}) });
      s2.stop();
    }
    const rp = rebuild ? await reparseWithProgress(ctx, out, { all: true, agents }) : (await ctx.reparseDue()) ? await reparseWithProgress(ctx, out, {}).catch(skipBusy) : undefined;
    const errors = r.errors.length + (bf?.errors.length ?? 0) + (rp?.errors.length ?? 0);
    if (out.json) {
      out.data({ outcome: rebuild ? "rebuilt" : "ingested", spool: r, backfill: bf ?? null, reparse: rp ?? null });
      return errors ? 1 : 0;
    }
    out.row("Spool", `${plural(r.events, "event")}, ${plural(r.sessions, "session")}${r.errors.length ? `, ${plural(r.errors.length, "error")}` : ""}`, r.errors.length ? "warn" : "ok");
    if (bf) out.row("Backfill", `${plural(bf.events, "event")}, ${plural(bf.sessions, "session")}, ${bf.duplicates} already captured${bf.errors.length ? `, ${plural(bf.errors.length, "error")}` : ""}`, bf.errors.length ? "warn" : "ok");
    if (rp) {
      out.row("Re-parsed", `${plural(rp.reparsed, "session")} (${plural(rp.removed, "row")} removed, ${rp.inserted} written)${rp.errors.length ? `, ${plural(rp.errors.length, "error")}` : ""}`, rp.errors.length ? "warn" : "ok");
      out.row("Kept", `${plural(rp.kept, "session")} without a source to re-read`, "ok");
      for (const [reason, n] of keptReasons(rp).slice(0, 3)) out.note(`${n} kept: ${reason}`);
    }
    for (const e of [...r.errors, ...(bf?.errors ?? []), ...(rp?.errors ?? [])].slice(0, 5)) out.note(typeof e === "string" ? e : JSON.stringify(e));
    out.print(String(r.events + (bf?.events ?? 0)));
    return errors ? 1 : 0;
  });
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

async function reparseWithProgress(ctx: Context, out: Output, o: { all?: boolean; agents?: string[] }): Promise<ReparseResult> {
  const spin = out.spin(o.all ? "Re-parsing sessions…" : "Re-parsing sessions stored by an older coding.sh…");
  try {
    return await ctx.reparse({
      ...(o.all ? { all: true } : {}),
      ...(o.agents?.length ? { agents: o.agents } : {}),
      onProgress: (p) => spin.update(p.phase === "spool" ? "Re-reading the spool…" : p.phase === "transcripts" ? `Re-reading ${p.agent} transcripts… (${p.done}/${p.total} sessions)` : `Re-parsing sessions… ${p.done}/${p.total}`),
    });
  } catch (e) {
    if (lockContention(e)) throw new CliError(`Can't re-parse: ${(e as Error).message}`, { reason: "locked", next: ["Wait for the other re-parse or ingest to finish, then run:", "coding.sh ingest --rebuild"] });
    throw e;
  } finally {
    spin.stop();
  }
}
