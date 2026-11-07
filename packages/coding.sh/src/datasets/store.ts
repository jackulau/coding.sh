// File-backed persistence for the eval engine, under the coding.sh data root:
//
//   <root>/datasets/<id>/versions/<version>.json   immutable, one per content version
//   <root>/datasets/<id>/latest                    text: the latest version id
//   <root>/datasets/<id>/history.jsonl             append-only version log
//   <root>/experiments/<id>.json                   one ExperimentResult per run
//   <root>/judges/<id>.json                        JudgeVersion (status, calibration)
//   <root>/noise/<dataset>/<taskKey>.json          A/A noise floor per dataset and task (exp aa)
//   <root>/judge-cache/…                           see src/judge/cache.ts
//
// Writes are atomic (tmp + rename) so a crash never leaves a torn JSON file.
//
// When constructed with an IndexStore that implements the optional dataset /
// experiment / judge methods (sqlite and memory do), those are used instead of
// the JSON files, so evals live next to sessions in one queryable index. The
// judge cache always stays on disk under <root>/judge-cache.
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { acquireLock } from "../core/lock.ts";
import { paths } from "../core/paths.ts";
import { writeFileDurable } from "../store/durable.ts";
import type { DatasetListing, IndexStore } from "../core/types.ts";
import { datasetVersion } from "./dataset.ts";
import type { NoiseFloor } from "../experiments/aa.ts";
import type { VerifierAudit } from "../judge/verifier.ts";
import type { Dataset, DatasetVersionInfo, ExperimentResult, JudgeVersion } from "./types.ts";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,199}$/;

function safeId(kind: string, id: string): string {
  if (!SAFE_ID.test(id) || id.includes("..")) throw new Error(`invalid ${kind} id ${JSON.stringify(id)}`);
  return id;
}

/** Atomic and durable: a crash leaves the old or the new file, never a torn one. */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  await writeFileDurable(path, data);
}

/**
 * history.jsonl entries, first occurrence of each version. Unparsable lines are
 * skipped: older versions appended in place, so a crash could leave a torn line
 * (and a later append could land after it).
 */
function parseHistory(text: string | undefined): DatasetVersionInfo[] {
  const out: DatasetVersionInfo[] = [];
  const seen = new Set<string>();
  for (const line of (text ?? "").split("\n")) {
    if (!line.trim()) continue;
    let info: DatasetVersionInfo;
    try {
      info = JSON.parse(line) as DatasetVersionInfo;
    } catch {
      continue;
    }
    if (typeof info?.version !== "string" || seen.has(info.version)) continue;
    seen.add(info.version);
    out.push(info);
  }
  return out;
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

async function listDir(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

export type { DatasetListing };

export class FileEvalStore {
  readonly root: string;
  /** "index" when datasets/experiments/judges go through the IndexStore, else "file". */
  readonly kind: "file" | "index";
  private readonly index?: IndexStore;

  constructor(opts: { root?: string; env?: NodeJS.ProcessEnv; index?: IndexStore } = {}) {
    this.root = opts.root ?? paths(opts.env).root;
    const ix = opts.index;
    // All-or-nothing: a backend that implements only some of the methods keeps files, so
    // a dataset and the experiments that reference it never end up in different places.
    const full = ix && ix.putDataset && ix.getDataset && ix.listDatasets && ix.listDatasetVersions &&
      ix.putExperiment && ix.getExperiment && ix.listExperiments && ix.putJudge && ix.getJudge && ix.listJudges;
    if (full) this.index = ix;
    this.kind = full ? "index" : "file";
  }

  get datasetsDir(): string {
    return join(this.root, "datasets");
  }
  get experimentsDir(): string {
    return join(this.root, "experiments");
  }
  get judgesDir(): string {
    return join(this.root, "judges");
  }
  get noiseDir(): string {
    return join(this.root, "noise"); // always files, like the judge cache
  }
  get verifiersDir(): string {
    return join(this.root, "verifiers"); // always files, like noise floors
  }
  get judgeCacheDir(): string {
    return join(this.root, "judge-cache"); // == paths(env).judgeCache
  }

  // ------------------------------------------------------------ datasets

  /**
   * Store a dataset version and point `latest` at it. Versions are immutable:
   * re-putting the same content is a no-op (`created: false`), and the stored
   * file is never rewritten.
   */
  async putDataset(ds: Dataset, opts: { note?: string; now?: number } = {}): Promise<{ version: string; created: boolean }> {
    const id = safeId("dataset", ds.id);
    const version = datasetVersion(ds.cases);
    if (version !== ds.version) throw new Error(`dataset ${id}: version ${ds.version} does not match its content (${version})`);
    if (this.index) {
      const doc: Dataset = { id, name: ds.name, version, cases: ds.cases };
      if (ds.description !== undefined) doc.description = ds.description;
      return this.index.putDataset!(doc, opts);
    }
    const dir = join(this.datasetsDir, id);
    await mkdir(join(dir, "versions"), { recursive: true });
    // One writer per dataset: the version file, the history entry and `latest` change together.
    const lock = await acquireLock(join(dir, ".lock"));
    try {
      const file = join(dir, "versions", `${version}.json`);
      const existing = await readJson<Dataset>(file);
      let createdAt = opts.now ?? Date.now();
      let created = false;
      if (existing) {
        if (datasetVersion(existing.cases) !== version) throw new Error(`dataset ${id}@${version}: stored file is corrupt`);
        createdAt = existing.createdAt ?? createdAt;
      } else {
        const stored: Dataset = { id, name: ds.name, version, cases: ds.cases, createdAt };
        if (ds.description !== undefined) stored.description = ds.description;
        await writeFileAtomic(file, JSON.stringify(stored, null, 2) + "\n");
        created = true;
      }
      // The history entry is the commit point. It is added whenever it is missing, not
      // only for a new file, so a put that crashed after writing the version file heals
      // on retry; the whole file is rewritten atomically so it can never be torn.
      const historyFile = join(dir, "history.jsonl");
      const history = parseHistory(await readText(historyFile));
      if (!history.some((h) => h.version === version)) {
        const info: DatasetVersionInfo = { version, cases: ds.cases.length, createdAt };
        if (opts.note) info.note = opts.note;
        history.push(info);
        await writeFileAtomic(historyFile, history.map((h) => JSON.stringify(h) + "\n").join(""));
        created = true;
      }
      await writeFileAtomic(join(dir, "latest"), version + "\n");
      return { version, created };
    } finally {
      lock.release();
    }
  }

  /** A stored version; `"latest"` (default) follows the latest pointer. */
  async getDataset(id: string, version = "latest"): Promise<Dataset | undefined> {
    safeId("dataset", id);
    if (version !== "latest") safeId("version", version);
    if (this.index) return this.index.getDataset!(id, version);
    const dir = join(this.datasetsDir, safeId("dataset", id));
    let v = version;
    if (v === "latest") {
      const t = await readText(join(dir, "latest"));
      if (!t) return undefined;
      v = t.trim();
    }
    return readJson<Dataset>(join(dir, "versions", `${safeId("version", v)}.json`));
  }

  async listDatasetVersions(id: string): Promise<DatasetVersionInfo[]> {
    if (this.index) return this.index.listDatasetVersions!(safeId("dataset", id));
    return parseHistory(await readText(join(this.datasetsDir, safeId("dataset", id), "history.jsonl")));
  }

  async listDatasets(): Promise<DatasetListing[]> {
    if (this.index) return this.index.listDatasets!();
    const out: DatasetListing[] = [];
    for (const id of (await listDir(this.datasetsDir)).sort()) {
      if (!SAFE_ID.test(id)) continue;
      const ds = await this.getDataset(id);
      if (!ds) continue;
      out.push({ id, name: ds.name, latest: ds.version, versions: (await this.listDatasetVersions(id)).length, cases: ds.cases.length });
    }
    return out;
  }

  // ------------------------------------------------------------ experiments

  async putExperiment(r: ExperimentResult): Promise<void> {
    if (this.index) return this.index.putExperiment!({ ...r, id: safeId("experiment", r.id) });
    await mkdir(this.experimentsDir, { recursive: true });
    await writeFileAtomic(join(this.experimentsDir, `${safeId("experiment", r.id)}.json`), JSON.stringify(r) + "\n");
  }

  async getExperiment(id: string): Promise<ExperimentResult | undefined> {
    if (this.index) return this.index.getExperiment!(safeId("experiment", id));
    return readJson<ExperimentResult>(join(this.experimentsDir, `${safeId("experiment", id)}.json`));
  }

  /**
   * By id, else the newest completed experiment with that name (`exp run
   * --name` is what users remember, and re-running a name is how they
   * iterate). A cancelled run never shadows the last complete one of the same
   * name unless `includeCancelled`; by id it is returned as is.
   */
  async resolveExperiment(ref: string, opts: { includeCancelled?: boolean } = {}): Promise<ExperimentResult | undefined> {
    let byId: ExperimentResult | undefined;
    try {
      byId = await this.getExperiment(ref);
    } catch {
      // not a valid id (e.g. a name with spaces): try it as a name
    }
    if (byId) return byId;
    if (opts.includeCancelled) return (await this.listExperiments({ name: ref, limit: 1 }))[0];
    return (await this.listExperiments({ name: ref })).find((e) => (e.status ?? "completed") === "completed");
  }

  /** Newest first (ids are time-sortable). */
  async listExperiments(filter: { datasetId?: string; name?: string; limit?: number } = {}): Promise<ExperimentResult[]> {
    if (this.index) return this.index.listExperiments!(filter);
    const files = (await listDir(this.experimentsDir)).filter((f) => f.endsWith(".json")).sort().reverse();
    const out: ExperimentResult[] = [];
    const limit = filter.limit !== undefined && filter.limit >= 0 ? filter.limit : Infinity; // 0 → none
    for (const f of files) {
      if (out.length >= limit) break;
      const r = await readJson<ExperimentResult>(join(this.experimentsDir, f));
      if (!r) continue;
      if (filter.datasetId && r.dataset.id !== filter.datasetId) continue;
      if (filter.name && r.name !== filter.name) continue;
      out.push(r);
    }
    return out;
  }

  // ------------------------------------------------------------ judges

  // ------------------------------------------------------------ verifier audits

  /** Store a verifier precision audit (`judge calibrate --grader <verifier>`); the newest per grader version wins. */
  async putVerifierAudit(a: VerifierAudit): Promise<void> {
    await mkdir(this.verifiersDir, { recursive: true });
    await writeFileAtomic(join(this.verifiersDir, `${safeId("grader version", a.graderVersion)}.json`), JSON.stringify(a, null, 2) + "\n");
  }

  async getVerifierAudit(graderVersion: string): Promise<VerifierAudit | undefined> {
    return readJson<VerifierAudit>(join(this.verifiersDir, `${safeId("grader version", graderVersion)}.json`));
  }

  // ------------------------------------------------------------ noise floors

  /** Store an A/A noise floor; the newest one per (dataset, task) wins. */
  async putNoise(n: NoiseFloor): Promise<void> {
    const dir = join(this.noiseDir, safeId("dataset", n.datasetId));
    await mkdir(dir, { recursive: true });
    await writeFileAtomic(join(dir, `${safeId("task key", n.taskKey)}.json`), JSON.stringify(n, null, 2) + "\n");
  }

  async getNoise(datasetId: string, taskKey: string): Promise<NoiseFloor | undefined> {
    return readJson<NoiseFloor>(join(this.noiseDir, safeId("dataset", datasetId), `${safeId("task key", taskKey)}.json`));
  }

  async putJudge(v: JudgeVersion): Promise<void> {
    if (this.index) return this.index.putJudge!({ ...v, id: safeId("judge", v.id) });
    await mkdir(this.judgesDir, { recursive: true });
    await writeFileAtomic(join(this.judgesDir, `${safeId("judge", v.id)}.json`), JSON.stringify(v, null, 2) + "\n");
  }

  async getJudge(id: string): Promise<JudgeVersion | undefined> {
    if (this.index) return this.index.getJudge!(safeId("judge", id));
    return readJson<JudgeVersion>(join(this.judgesDir, `${safeId("judge", id)}.json`));
  }

  async listJudges(): Promise<JudgeVersion[]> {
    if (this.index) return this.index.listJudges!();
    const out: JudgeVersion[] = [];
    for (const f of (await listDir(this.judgesDir)).filter((x) => x.endsWith(".json")).sort()) {
      const v = await readJson<JudgeVersion>(join(this.judgesDir, f));
      if (v) out.push(v);
    }
    return out;
  }

  /**
   * Mark a judge version production. Refuses unless its latest calibration is
   * held-out and above threshold, unless `force`.
   */
  async promoteJudge(id: string, opts: { force?: boolean } = {}): Promise<JudgeVersion> {
    const v = await this.getJudge(id);
    if (!v) throw new Error(`no judge ${id}`);
    if (!opts.force && v.calibration?.state !== "calibrated") {
      throw new Error(`judge ${id} is ${v.calibration?.state ?? "uncalibrated"}; calibrate it on held-out labels first (or force)`);
    }
    const next: JudgeVersion = { ...v, status: "production" };
    await this.putJudge(next);
    return next;
  }
}
