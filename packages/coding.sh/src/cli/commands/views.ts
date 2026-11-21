// coding.sh views save <name> --where <q> | list | rm <name>
//
// A saved --where query, kept in the index (src/query/views.ts). `sessions --view <name>`
// reads it back; so do the MCP sessions_list tool (view) and the viewer (/api/views).
import { QueryError } from "../../query/where.ts";
import { removeView, saveView, viewStore, ViewError } from "../../query/views.ts";
import { UsageError } from "../args.ts";
import { queryCliError, str, withContext } from "../common.ts";
import { ago, CliError } from "../output.ts";
import type { CommandContext } from "../types.ts";

/** A ViewError or QueryError as the CLI reports it: a bad name, query or empty query exits 2. */
export function viewCliError(e: unknown, raw?: string): unknown {
  if (e instanceof QueryError) return queryCliError(e, raw);
  if (e instanceof ViewError) {
    if (e.reason === "unknown_view") return new CliError(e.message, { reason: "not_found", next: ["List the views:", "coding.sh views list"] });
    if (e.reason === "no_views") return new CliError(e.message, { reason: "unsupported_store", next: ["coding.sh config get store.index shows which store is in use"] });
    return new UsageError(e.message, { reason: e.reason === "bad_name" ? "invalid_value" : "missing_value" });
  }
  return e;
}

export async function run(c: CommandContext): Promise<number> {
  switch (c.action) {
    case "save":
      return save(c);
    case "list":
      return list(c);
    case "rm":
      return rm(c);
    default:
      throw new UsageError(`unknown action ${JSON.stringify(c.action)}`);
  }
}

async function save(c: CommandContext): Promise<number> {
  const { out } = c;
  const name = c.positionals[0]!;
  const where = str(c.flags.where);
  // The hint is the query the help's examples use: a bare `flagged` is a word search, not the flag.
  if (where === undefined) throw new UsageError("--where is required: the query to save, e.g. --where 'is:flagged agent:codex'", { reason: "missing_value" });
  if (!where.trim()) throw new UsageError("a view needs a query, e.g. --where 'is:flagged agent:codex'", { reason: "missing_value" });
  return withContext(c, async (ctx) => {
    const r = await saveView(ctx.index, name, where).catch((e) => Promise.reject(viewCliError(e, where.trim())));
    if (out.json) {
      out.data({ view: r.view, replaced: r.replaced });
      return 0;
    }
    out.ok(r.replaced ? `Replaced view ${r.view.name}'s query: ${r.view.where}` : `Saved view ${r.view.name}: ${r.view.where}`);
    out.next("List its sessions", `coding.sh sessions --view ${r.view.name}`);
    return 0;
  });
}

async function list(c: CommandContext): Promise<number> {
  const { out } = c;
  return withContext(c, async (ctx) => {
    let views;
    try {
      views = await viewStore(ctx.index).listViews();
    } catch (e) {
      throw viewCliError(e);
    }
    if (out.json) {
      out.data({ views });
      return 0;
    }
    if (!views.length) {
      out.note("No views are saved");
      out.next("Save a query you run often", "coding.sh views save <name> --where '<query>'");
      return 0;
    }
    out.table(["NAME", "UPDATED", "WHERE"], views.map((v) => [v.name, ago(v.updatedAt), v.where]));
    return 0;
  }, { create: false });
}

async function rm(c: CommandContext): Promise<number> {
  const { out } = c;
  const name = c.positionals[0]!;
  return withContext(c, async (ctx) => {
    await removeView(ctx.index, name).catch((e) => Promise.reject(viewCliError(e)));
    if (out.json) out.data({ removed: name });
    else out.ok(`Removed view ${name}`);
    return 0;
  });
}
