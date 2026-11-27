// coding.sh dataset add|import|list|mine|stats|filter
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { scoreNumber } from "../../alerts/measure.ts";
import type { IndexStore, SessionFilter } from "../../core/types.ts";
import {
  computeDatasetStats,
  DEFAULT_NEAR_THRESHOLD,
  filterDatasetCases,
  mineDatasetSessions,
  parseMinScore,
  validateThreshold,
  type Difficulty,
  type MinScoreFilter,
} from "../../datasets/curate.ts";
import { addCases, assignSplits, caseFromSession, createDataset, DatasetError, loadDatasetFile, slugify } from "../../datasets/dataset.ts";
import { FileEvalStore } from "../../datasets/store.ts";
import type { CaseKind, Dataset, Split } from "../../datasets/types.ts";
import { findSessions } from "../../query/run.ts";
import { scopesSubagents } from "../../query/where.ts";
import type { AgentEvent } from "../../schema/index.ts";
import { DatasetConflict } from "../../store/common.ts";
import { parseSinceWhen, positiveInt, UsageError, type FlagValue } from "../args.ts";
import { agentScope, agentsFlag, autoIngest, jsonArg, list, num, queryCliError, readIngest, resolveSession, str, whereFlag, withContext } from "../common.ts";
import { CliError, plural } from "../output.ts";
import type { CommandContext } from "../types.ts";
import { scopesRuns, withRepo } from "./sessions.ts";

/** Tries to save a dataset that other writers keep changing before giving up. */
const SAVE_ATTEMPTS = 20;
/** Maximum sessions fetched per `dataset mine` query. */
const MINE_SCAN_CAP = 10_000;

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

function safeSlug(name: string): string {
  try {
    return slugify(name);
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e), { reason: "invalid_argument" });
  }
}

function nonNegativeInt(v: FlagValue, name: string): number | undefined {
  const n = num(v);
  if (n === undefined) return undefined;
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new UsageError(`--${name} must be a whole number of at least 0, got ${n}`, { reason: "invalid_argument" });
  }
  return n;
}

function thresholdFlag(v: FlagValue, name: string): number | undefined {
  const n = num(v);
  if (n === undefined) return undefined;
  try {
    return validateThreshold(n, `--${name}`);
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e), { reason: "invalid_argument" });
  }
}

function formatBreakdown(droppedBy: Record<string, number | undefined>): string {
  return Object.entries(droppedBy)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([k, n]) => `${k}: ${n}`)
    .join(", ");
}

async function loadSessionScores(
  index: IndexStore,
  sessionIds: ReadonlySet<string>,
  filters: readonly MinScoreFilter[],
): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  if (!filters.length || !sessionIds.size) return out;
  if (!index.listScores) {
    throw new CliError(`this ${index.kind} store keeps no scores, so --min-score cannot be used`, {
      reason: "unsupported_store",
      next: ["coding.sh config get store.index shows which store is in use"],
    });
  }
  const names = [...new Set(filters.map((f) => f.name))];
  for (const name of names) {
    const sums = new Map<string, { sum: number; n: number }>();
    for (const score of await index.listScores({ target: "session", name })) {
      if (!sessionIds.has(score.targetId)) continue;
      const val = scoreNumber(score);
      if (val === undefined) continue;
      const cur = sums.get(score.targetId) ?? { sum: 0, n: 0 };
      cur.sum += val;
      cur.n++;
      sums.set(score.targetId, cur);
    }
    for (const [sid, agg] of sums) {
      let map = out.get(sid);
      if (!map) {
        map = new Map<string, number>();
        out.set(sid, map);
      }
      map.set(name, agg.sum / agg.n);
    }
  }
  return out;
}

async function putWithRetry(
  store: FileEvalStore,
  id: string,
  note: string | undefined,
  build: (existing: Dataset | undefined) => Promise<Dataset>,
): Promise<{ ds: Dataset; version: string; created: boolean }> {
  for (let attempt = 1; ; attempt++) {
    const existing = await store.getDataset(id);
    const ds = assignSplits(await build(existing));
    try {
      const opts: { note?: string; parent: string | null } = { parent: existing?.version ?? null };
      if (note) opts.note = note;
      const put = await store.putDataset(ds, opts);
      return { ds, version: put.version, created: put.created };
    } catch (e) {
      if (!(e instanceof DatasetConflict)) throw e;
      if (attempt >= SAVE_ATTEMPTS) {
        throw new CliError(`${ds.name} kept changing while saving (${SAVE_ATTEMPTS} tries). Run the command again`, { reason: "conflict" });
      }
      await delay(10 + Math.random() * 40 * attempt);
    }
  }
}

export async function run(c: CommandContext): Promise<number> {
  const { out, env } = c;
  // Validate pure flags up front before opening the store so bad usage exits 2 cleanly.
  if (c.action === "mine") {
    safeSlug(c.positionals[0]!);
    whereFlag(c);
    if (str(c.flags.since) !== undefined) parseSinceWhen(str(c.flags.since)!);
    positiveInt(c.flags.limit, "limit");
    nonNegativeInt(c.flags["min-turns"], "min-turns");
    thresholdFlag(c.flags["dedupe-near"], "dedupe-near");
    for (const raw of list(c.flags["min-score"])) {
      try {
        parseMinScore(raw);
      } catch (e) {
        throw new UsageError(e instanceof Error ? e.message : String(e), { reason: "invalid_argument" });
      }
    }
  } else if (c.action === "stats") {
    safeSlug(c.positionals[0]!);
    thresholdFlag(c.flags["near-threshold"], "near-threshold");
  } else if (c.action === "filter") {
    safeSlug(c.positionals[0]!);
    const dst = str(c.flags.out);
    if (!dst) throw new UsageError("Missing --out <DST>", { reason: "missing_argument" });
    safeSlug(dst);
    const minChars = nonNegativeInt(c.flags["min-chars"], "min-chars");
    const maxChars = nonNegativeInt(c.flags["max-chars"], "max-chars");
    if (minChars !== undefined && maxChars !== undefined && minChars > maxChars) {
      throw new UsageError(`--min-chars (${minChars}) cannot exceed --max-chars (${maxChars})`, { reason: "invalid_argument" });
    }
    thresholdFlag(c.flags["dedupe-near"], "dedupe-near");
    positiveInt(c.flags.limit, "limit");
  }

  const createStore = c.action !== "list" && c.action !== "stats" && c.flags["dry-run"] !== true;
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
        if (!raw.length) throw new UsageError("Nothing to add. Pass --case <JSON|FILE> or --session <ID>", { reason: "missing_argument" });
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
          out.next("Add a dataset with its first case", `coding.sh dataset add smoke --case '{"input":"2+2","expected":"4"}'`);
          return 0;
        }
        out.table(["ID", "NAME", "LATEST", "VERSIONS", "CASES"], all.map((d) => [d.id, d.name, d.latest, String(d.versions), String(d.cases)]));
        return 0;
      }
      case "mine": {
        const name = c.positionals[0]!;
        const id = safeSlug(name);
        const typed = whereFlag(c);
        const sinceWhen = str(c.flags.since) !== undefined ? parseSinceWhen(str(c.flags.since)!) : undefined;
        const agents = agentsFlag(c);
        const repo = str(c.flags.repo);
        const limit = positiveInt(c.flags.limit, "limit");
        const minTurns = nonNegativeInt(c.flags["min-turns"], "min-turns");
        const minScores = list(c.flags["min-score"]).map((raw) => parseMinScore(raw));
        const excludeFlagged = c.flags["exclude-flagged"] === true;
        const dedupeNear = thresholdFlag(c.flags["dedupe-near"], "dedupe-near");
        const split = str(c.flags.split) as Split | undefined;
        const tags = list(c.flags.tag);
        const dryRun = c.flags["dry-run"] === true;
        const note = str(c.flags.note);

        await autoIngest(ctx, readIngest(c));
        const scope = agentScope(agents, typed);
        const scoped = withRepo(scope.where, repo, c);
        const filter: SessionFilter = {};
        if (scope.agent) filter.agent = scope.agent;
        if (sinceWhen !== undefined) filter.since = sinceWhen.ms;
        if (!scopesSubagents(typed?.root)) filter.parentSessionId = null;
        if (!scopesRuns(typed?.root)) filter.runId = null;

        let found;
        try {
          found = await findSessions(ctx.index, scoped ?? {}, { filter, limit: MINE_SCAN_CAP });
        } catch (e) {
          throw queryCliError(e);
        }
        const sessions = found.sessions;
        const scores = await loadSessionScores(ctx.index, new Set(sessions.map((s) => s.id)), minScores);
        const eventCache = new Map<string, AgentEvent[]>();
        const getEvents = async (sid: string): Promise<readonly AgentEvent[]> => {
          let evs = eventCache.get(sid);
          if (!evs) {
            evs = await ctx.index.listEvents(sid);
            eventCache.set(sid, evs);
          }
          return evs;
        };

        const runMine = (existing: Dataset | undefined) => {
          const mineOpts: Parameters<typeof mineDatasetSessions>[0] = {
            sessions,
            getEvents,
            scores,
            minScores,
            excludeFlagged,
          };
          if (minTurns !== undefined) mineOpts.minTurns = minTurns;
          if (dedupeNear !== undefined) mineOpts.dedupeNear = dedupeNear;
          if (split) mineOpts.split = split;
          if (tags.length) mineOpts.tags = tags;
          if (limit !== undefined) mineOpts.limit = limit;
          if (existing) mineOpts.existing = existing.cases;
          return mineDatasetSessions(mineOpts);
        };

        if (dryRun) {
          const existing = await store.getDataset(id);
          const report = await runMine(existing);
          if (out.json) {
            out.data({
              outcome: "dry-run",
              dataset: { id, name },
              matched: report.matched,
              kept: report.kept,
              dropped: report.dropped,
              droppedBy: report.droppedBy,
              duplicates: report.duplicates.length,
            });
          } else {
            out.print(`Matched ${plural(report.matched, "session")}: ${report.kept} kept, ${report.dropped} dropped`);
            const detail = formatBreakdown(report.droppedBy);
            if (detail) out.note(`Dropped: ${detail}`);
            out.note("Dry run: nothing written");
          }
          return 0;
        }

        let lastReport: Awaited<ReturnType<typeof runMine>> | undefined;
        let saved: { ds: Dataset; version: string; created: boolean } | undefined;
        let existingWhenEmpty: Dataset | undefined;
        for (let attempt = 1; ; attempt++) {
          const existing = await store.getDataset(id);
          const report = await runMine(existing);
          lastReport = report;
          if (report.kept === 0) {
            existingWhenEmpty = existing;
            break;
          }
          let built: Dataset;
          try {
            built = existing ? addCases(existing, report.cases) : createDataset({ name, cases: report.cases });
          } catch (e) {
            if (e instanceof DatasetError) throw new UsageError(e.message, { reason: "invalid_case" });
            throw e;
          }
          const ds = assignSplits(built);
          try {
            const putOpts: { note?: string; parent: string | null } = { parent: existing?.version ?? null };
            if (note) putOpts.note = note;
            const put = await store.putDataset(ds, putOpts);
            saved = { ds, version: put.version, created: put.created };
            break;
          } catch (e) {
            if (!(e instanceof DatasetConflict)) throw e;
            if (attempt >= SAVE_ATTEMPTS) {
              throw new CliError(`${name} kept changing while saving (${SAVE_ATTEMPTS} tries). Run the command again`, { reason: "conflict" });
            }
            await delay(10 + Math.random() * 40 * attempt);
          }
        }

        const report = lastReport!;
        if (!saved) {
          const outcome = existingWhenEmpty ? "unchanged" : "empty";
          if (out.json) {
            out.data({
              outcome,
              dataset: existingWhenEmpty ? summary(existingWhenEmpty) : null,
              matched: report.matched,
              kept: 0,
              dropped: report.dropped,
              droppedBy: report.droppedBy,
              duplicates: report.duplicates.length,
            });
          } else {
            out.note(`Matched ${plural(report.matched, "session")}: 0 kept, ${report.dropped} dropped`);
            const detail = formatBreakdown(report.droppedBy);
            if (detail) out.note(`Dropped: ${detail}`);
            if (existingWhenEmpty) out.ok(`${existingWhenEmpty.name} is unchanged`);
          }
          return 0;
        }

        if (out.json) {
          out.data({
            outcome: saved.created ? "created" : "unchanged",
            dataset: { ...summary(saved.ds), version: saved.version },
            matched: report.matched,
            kept: report.kept,
            dropped: report.dropped,
            droppedBy: report.droppedBy,
            duplicates: report.duplicates.length,
          });
        } else {
          const detail = formatBreakdown(report.droppedBy);
          if (detail) out.note(`Dropped ${report.dropped} (${detail})`);
          out.ok(saved.created ? `${saved.ds.name}: ${plural(saved.ds.cases.length, "case")} (+${report.kept} mined)` : `${saved.ds.name} is unchanged`);
          out.print(`${saved.ds.id}@${saved.version}`);
        }
        return 0;
      }
      case "stats": {
        const name = c.positionals[0]!;
        const id = safeSlug(name);
        const version = str(c.flags.version) ?? "latest";
        const nearThreshold = thresholdFlag(c.flags["near-threshold"], "near-threshold") ?? DEFAULT_NEAR_THRESHOLD;
        const ds = await store.getDataset(id, version);
        if (!ds) {
          throw new CliError(`Can't find dataset ${JSON.stringify(name)}${version !== "latest" ? `@${version}` : ""}`, {
            reason: "not_found",
            next: ["List datasets:", "coding.sh dataset list"],
          });
        }
        const stats = computeDatasetStats(ds, { nearThreshold });
        if (out.json) {
          out.data(stats);
          return 0;
        }
        const splitParts = [`train ${stats.splits.train}`, `dev ${stats.splits.dev}`, `test ${stats.splits.test}`];
        if (stats.splits.unassigned) splitParts.push(`unassigned ${stats.splits.unassigned}`);
        const rows: [string, string][] = [
          ["Dataset", `${stats.name} (${stats.id}@${stats.version})`],
          ["Cases", String(stats.total)],
          ["Splits", splitParts.join(", ")],
        ];
        if (stats.kinds) {
          rows.push(["Kinds", Object.entries(stats.kinds).map(([k, n]) => `${k} ${n}`).join(", ")]);
        }
        if (stats.difficulty) {
          rows.push(["Difficulty", Object.entries(stats.difficulty).map(([k, n]) => `${k} ${n}`).join(", ")]);
        }
        const tagEntries = Object.entries(stats.tags);
        if (tagEntries.length) {
          const shown = tagEntries.slice(0, 10).map(([k, n]) => `${k} (${n})`).join(", ");
          rows.push(["Tags", tagEntries.length > 10 ? `${shown}, +${tagEntries.length - 10} more` : shown]);
        }
        rows.push([
          "Input chars",
          stats.inputChars ? `min ${stats.inputChars.min}, median ${stats.inputChars.median}, max ${stats.inputChars.max}` : "-",
        ]);
        rows.push([
          "Near-dupes",
          `${plural(stats.nearDuplicates.pairs, "pair")} (threshold ${stats.nearDuplicates.threshold})`,
        ]);
        out.table(["METRIC", "VALUE"], rows);
        return 0;
      }
      case "filter": {
        const src = c.positionals[0]!;
        const dst = str(c.flags.out)!;
        const srcId = safeSlug(src);
        const dstId = safeSlug(dst);
        const version = str(c.flags.version) ?? "latest";
        const splits = list(c.flags.split) as Split[];
        const tags = list(c.flags.tag);
        const difficulties = list(c.flags.difficulty) as Difficulty[];
        const minChars = nonNegativeInt(c.flags["min-chars"], "min-chars");
        const maxChars = nonNegativeInt(c.flags["max-chars"], "max-chars");
        const dedupeNear = thresholdFlag(c.flags["dedupe-near"], "dedupe-near");
        const limit = positiveInt(c.flags.limit, "limit");
        const dryRun = c.flags["dry-run"] === true;
        const note = str(c.flags.note);

        const source = await store.getDataset(srcId, version);
        if (!source) {
          throw new CliError(`Can't find dataset ${JSON.stringify(src)}${version !== "latest" ? `@${version}` : ""}`, {
            reason: "not_found",
            next: ["List datasets:", "coding.sh dataset list"],
          });
        }

        const filterOpts: Parameters<typeof filterDatasetCases>[1] = {};
        if (splits.length) filterOpts.splits = splits;
        if (tags.length) filterOpts.tags = tags;
        if (difficulties.length) filterOpts.difficulties = difficulties;
        if (minChars !== undefined) filterOpts.minChars = minChars;
        if (maxChars !== undefined) filterOpts.maxChars = maxChars;
        if (dedupeNear !== undefined) filterOpts.dedupeNear = dedupeNear;
        if (limit !== undefined) filterOpts.limit = limit;

        const report = filterDatasetCases(source.cases, filterOpts);
        const sourceInfo = { id: source.id, name: source.name, version: source.version };

        if (dryRun) {
          if (out.json) {
            out.data({
              outcome: "dry-run",
              source: sourceInfo,
              destination: { id: dstId, name: dst },
              total: report.total,
              kept: report.kept,
              dropped: report.dropped,
              droppedBy: report.droppedBy,
              duplicates: report.duplicates.length,
            });
          } else {
            out.print(`${source.name}: ${report.kept} of ${plural(report.total, "case")} kept, ${report.dropped} dropped`);
            const detail = formatBreakdown(report.droppedBy);
            if (detail) out.note(`Dropped: ${detail}`);
            out.note("Dry run: nothing written");
          }
          return 0;
        }

        if (report.kept === 0) {
          if (out.json) {
            out.data({
              outcome: "empty",
              source: sourceInfo,
              destination: { id: dstId, name: dst },
              dataset: null,
              total: report.total,
              kept: 0,
              dropped: report.dropped,
              droppedBy: report.droppedBy,
              duplicates: report.duplicates.length,
            });
          } else {
            out.note(`${source.name}: 0 of ${plural(report.total, "case")} kept, ${report.dropped} dropped`);
            const detail = formatBreakdown(report.droppedBy);
            if (detail) out.note(`Dropped: ${detail}`);
          }
          return 0;
        }

        const saved = await putWithRetry(store, dstId, note, async () => createDataset({ name: dst, cases: report.cases, dedupe: false }));
        if (out.json) {
          out.data({
            outcome: saved.created ? "created" : "unchanged",
            source: sourceInfo,
            dataset: { ...summary(saved.ds), version: saved.version },
            total: report.total,
            kept: report.kept,
            dropped: report.dropped,
            droppedBy: report.droppedBy,
            duplicates: report.duplicates.length,
          });
        } else {
          const detail = formatBreakdown(report.droppedBy);
          if (detail) out.note(`Dropped ${report.dropped} (${detail})`);
          out.ok(saved.created ? `${saved.ds.name}: ${plural(saved.ds.cases.length, "case")} from ${source.name}` : `${saved.ds.name} is unchanged`);
          out.print(`${saved.ds.id}@${saved.version}`);
        }
        return 0;
      }
    }
    throw new UsageError(`Unknown dataset command ${c.action}`);
  }, { create: createStore });
}
