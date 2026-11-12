// coding.sh dataset add|import|list
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { addCases, assignSplits, caseFromSession, createDataset, loadDatasetFile, slugify } from "../../datasets/dataset.ts";
import { FileEvalStore } from "../../datasets/store.ts";
import { DatasetConflict } from "../../store/common.ts";
import type { CaseKind, Dataset, Split } from "../../datasets/types.ts";
import { UsageError } from "../args.ts";
import { jsonArg, list, resolveSession, str, withContext } from "../common.ts";
import { CliError, plural } from "../output.ts";
import type { CommandContext } from "../types.ts";

/** Tries to save a dataset that other writers keep changing before giving up. */
const SAVE_ATTEMPTS = 20;

function summary(ds: Dataset) {
  const kinds: Partial<Record<CaseKind, number>> = {};
  for (const c of ds.cases) if (c.kind) kinds[c.kind] = (kinds[c.kind] ?? 0) + 1;
  return { id: ds.id, name: ds.name, version: ds.version, cases: ds.cases.length, ...(Object.keys(kinds).length ? { kinds } : {}) };
}

/** A field given in the case JSON (split, kind) wins over the flag; malformed cases pass through for normalizeCase to report. */
function withDefault(v: unknown, key: "split" | "kind", value: string): unknown {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
  const own = (v as Record<string, unknown>)[key];
  return own === undefined || own === null || own === "" ? { ...v, [key]: value } : v;
}

export async function run(c: CommandContext): Promise<number> {
  const { out, env } = c;
  return withContext(c, async (ctx) => {
    const store = new FileEvalStore({ env, index: ctx.index });
    // Read, merge and write with the version read as the parent: a writer that lost a
    // race (DatasetConflict) reads the new latest and merges again, so no case is lost.
    const save = async (id: string, build: (existing: Dataset | undefined) => Dataset & { duplicates: unknown[] }) => {
      const note = str(c.flags.note);
      for (let attempt = 1; ; attempt++) {
        const existing = await store.getDataset(id);
        // Every written version has a split on every case: a case without one is
        // invisible to split-filtered runs and to `judge calibrate`. Splits hash
        // the case id, so they are stable, and splits already set are kept.
        const built = build(existing);
        const ds = { ...assignSplits(built), duplicates: built.duplicates };
        let put;
        try {
          const opts: { note?: string; parent: string | null } = { parent: existing?.version ?? null };
          if (note) opts.note = note;
          put = await store.putDataset(ds, opts);
        } catch (e) {
          if (!(e instanceof DatasetConflict)) throw e;
          if (attempt >= SAVE_ATTEMPTS) throw new CliError(`${ds.name} kept changing while saving (${SAVE_ATTEMPTS} tries). Run the command again`, { reason: "conflict" });
          await delay(10 + Math.random() * 40 * attempt);
          continue;
        }
        const { version, created } = put;
        if (out.json) out.data({ outcome: created ? "created" : "unchanged", dataset: { ...summary(ds), version }, duplicates: ds.duplicates.length });
        else {
          if (ds.duplicates.length) out.warn(`${plural(ds.duplicates.length, "duplicate case")} dropped`);
          out.ok(created ? `${ds.name}: ${plural(ds.cases.length, "case")}` : `${ds.name} is unchanged`);
          out.print(`${ds.id}@${version}`);
        }
        return 0;
      }
    };
    switch (c.action) {
      case "add": {
        const name = c.positionals[0]!;
        // Registry `choices` validates the value.
        const split = str(c.flags.split) as Split | undefined;
        const kind = str(c.flags.kind) as CaseKind | undefined;
        const raw: unknown[] = [];
        for (const j of list(c.flags.case)) {
          let v = await jsonArg(j, "--case");
          if (split) v = withDefault(v, "split", split);
          if (kind) v = withDefault(v, "kind", kind);
          raw.push(v);
        }
        for (const id of list(c.flags.session)) {
          const s = await resolveSession(ctx, id);
          const harvested = caseFromSession(s, await ctx.index.listEvents(s.id), split ? { split } : {});
          raw.push(kind ? { ...harvested, kind } : harvested);
        }
        if (!raw.length) throw new UsageError("Nothing to add. Pass --case <JSON> or --session <ID>", { reason: "missing_argument" });
        return save(slugify(name), (existing) => {
          try {
            return existing ? addCases(existing, raw) : createDataset({ name, cases: raw });
          } catch (e) {
            throw new UsageError(e instanceof Error ? e.message : String(e), { reason: "invalid_case" });
          }
        });
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
        if (!ds.cases.length) throw new CliError(`${file} has no cases`, { reason: "invalid_file" });
        const loaded = ds;
        return save(ds.id, (existing) => (existing ? { ...addCases({ ...existing, cases: [] }, loaded.cases), duplicates: loaded.duplicates } : loaded));
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
  }, { create: c.action !== "list" });
}
