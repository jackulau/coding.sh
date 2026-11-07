// coding.sh ingest [--backfill] [--agent ...] [--since ...] [--background]
//
// --background is what the hook starts at session end: it takes the ingest
// lock without waiting and exits 0 quietly when another ingest holds it, or
// took it over mid-run (that one re-runs for the hook's wake-up marker, and
// the next read's lazy ingest picks up anything else).
import { parseSince } from "../args.ts";
import { list, lockContention, str, tailIngest, withContext } from "../common.ts";
import { CliError, plural } from "../output.ts";
import type { CommandContext } from "../types.ts";
import { pickAdapters } from "./init.ts";

export async function run(c: CommandContext): Promise<number> {
  const { out } = c;
  const agents = list(c.flags.agent);
  if (agents.length) pickAdapters(agents);
  const since = str(c.flags.since) !== undefined ? parseSince(str(c.flags.since)!) : undefined;
  const background = c.flags.background === true;
  return withContext(c, async (ctx) => {
    if (background) {
      try {
        const r = await ctx.ingest({ lock: { waitMs: 0 } });
        await tailIngest(ctx);
        if (out.json) out.data({ outcome: "ingested", spool: r, backfill: null });
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
    const errors = r.errors.length + (bf?.errors.length ?? 0);
    if (out.json) {
      out.data({ outcome: "ingested", spool: r, backfill: bf ?? null });
      return errors ? 1 : 0;
    }
    out.row("Spool", `${plural(r.events, "event")}, ${plural(r.sessions, "session")}${r.errors.length ? `, ${plural(r.errors.length, "error")}` : ""}`, r.errors.length ? "warn" : "ok");
    if (bf) out.row("Backfill", `${plural(bf.events, "event")}, ${plural(bf.sessions, "session")}, ${bf.duplicates} already captured${bf.errors.length ? `, ${plural(bf.errors.length, "error")}` : ""}`, bf.errors.length ? "warn" : "ok");
    for (const e of [...r.errors, ...(bf?.errors ?? [])].slice(0, 5)) out.note(typeof e === "string" ? e : JSON.stringify(e));
    out.print(String(r.events + (bf?.events ?? 0)));
    return errors ? 1 : 0;
  });
}
