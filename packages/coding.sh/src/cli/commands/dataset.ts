// coding.sh dataset add|import|list
import { resolve } from "node:path";
import { addCases, assignSplits, caseFromSession, createDataset, loadDatasetFile, slugify } from "../../datasets/dataset.ts";
import { FileEvalStore } from "../../datasets/store.ts";
import type { Dataset, Split } from "../../datasets/types.ts";
import { UsageError } from "../args.ts";
import { jsonArg, list, resolveSession, str, withContext } from "../common.ts";
import { CliError, plural } from "../output.ts";
import type { CommandContext } from "../types.ts";

function summary(ds: Dataset) {
  return { id: ds.id, name: ds.name, version: ds.version, cases: ds.cases.length };
}

/** A split given in the case JSON wins over --split; malformed cases pass through for normalizeCase to report. */
function withDefaultSplit(v: unknown, split: Split): unknown {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
  const own = (v as { split?: unknown }).split;
  return own === undefined || own === null || own === "" ? { ...v, split } : v;
}

export async function run(c: CommandContext): Promise<number> {
  const { out, env } = c;
  return withContext(c, async (ctx) => {
    const store = new FileEvalStore({ env, index: ctx.index });
    const save = async (built: Dataset & { duplicates: unknown[] }) => {
      // Every written version has a split on every case: a case without one is
      // invisible to split-filtered runs and to `judge calibrate`. Splits hash
      // the case id, so they are stable, and splits already set are kept.
      const ds = { ...assignSplits(built), duplicates: built.duplicates };
      const note = str(c.flags.note);
      const { version, created } = await store.putDataset(ds, note ? { note } : {});
      if (out.json) out.data({ outcome: created ? "created" : "unchanged", dataset: { ...summary(ds), version }, duplicates: ds.duplicates.length });
      else {
        if (ds.duplicates.length) out.warn(`${plural(ds.duplicates.length, "duplicate case")} dropped`);
        out.ok(created ? `${ds.name}: ${plural(ds.cases.length, "case")}` : `${ds.name} is unchanged`);
        out.print(`${ds.id}@${version}`);
      }
      return 0;
    };
    switch (c.action) {
      case "add": {
        const name = c.positionals[0]!;
        // Registry `choices` validates the value.
        const split = str(c.flags.split) as Split | undefined;
        const raw: unknown[] = [];
        for (const j of list(c.flags.case)) {
          const v = await jsonArg(j, "--case");
          raw.push(split ? withDefaultSplit(v, split) : v);
        }
        for (const id of list(c.flags.session)) {
          const s = await resolveSession(ctx, id);
          raw.push(caseFromSession(s, await ctx.index.listEvents(s.id), split ? { split } : {}));
        }
        if (!raw.length) throw new UsageError("Nothing to add. Pass --case <JSON> or --session <ID>", { reason: "missing_argument" });
        const existing = await store.getDataset(slugify(name));
        let ds;
        try {
          ds = existing ? addCases(existing, raw) : createDataset({ name, cases: raw });
        } catch (e) {
          throw new UsageError(e instanceof Error ? e.message : String(e), { reason: "invalid_case" });
        }
        return save(ds);
      }
      case "import": {
        const file = resolve(c.cwd, c.positionals[0]!);
        const name = str(c.flags.name);
        let ds;
        try {
          ds = await loadDatasetFile(file, name ? { name } : {});
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new CliError(`Can't read ${file}: no such file`, { reason: "not_found" });
          throw new CliError(`Couldn't import ${file}: ${e instanceof Error ? e.message : String(e)}`, { reason: "invalid_file" });
        }
        const existing = await store.getDataset(ds.id);
        if (existing) ds = { ...addCases({ ...existing, cases: [] }, ds.cases), duplicates: ds.duplicates };
        return save(ds);
      }
      case "list": {
        const all = await store.listDatasets();
        if (out.json) {
          out.data({ datasets: all });
          return 0;
        }
        if (!all.length) {
          out.note("No datasets");
          return 0;
        }
        out.table(["ID", "NAME", "LATEST", "VERSIONS", "CASES"], all.map((d) => [d.id, d.name, d.latest, String(d.versions), String(d.cases)]));
        return 0;
      }
    }
    throw new UsageError(`Unknown dataset command ${c.action}`);
  });
}
