// File-backed persistence for the eval engine, under the coding.sh data root:
//
//   <root>/datasets/<id>/versions/<version>.json   immutable, one per content version
//   <root>/datasets/<id>/latest                    text: the latest version id
//   <root>/datasets/<id>/history.jsonl             append-only version log
//   <root>/experiments/<id>.json                   one ExperimentResult per run
//   <root>/judges/<id>.json                        JudgeVersion (status, calibration)
//   <root>/judge-cache/…                           see src/judge/cache.ts
//
// Writes are atomic (tmp + rename) so a crash never leaves a torn JSON file.
//
// When constructed with an IndexStore that implements the optional dataset /
// experiment / judge methods (sqlite and memory do), those are used instead of
// the JSON files, so evals live next to sessions in one queryable index. The
// judge cache always stays on disk under <root>/judge-cache.
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../core/paths.ts";
import type { DatasetListing, IndexStore } from "../core/types.ts";
import { datasetVersion } from "./dataset.ts";
import type { Dataset, DatasetVersionInfo, ExperimentResult, JudgeVersion } from "./types.ts";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,199}$/;

function safeId(kind: string, id: string): string {
  if (!SAFE_ID.test(id) || id.includes("..")) throw new Error(`invalid ${kind} id ${JSON.stringify(id)}`);
  return id;
}

export async function writeFileAtomic(path: string, data: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, data, "utf8");
  await rename(tmp, path);
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
    const file = join(dir, "versions", `${version}.json`);
    const existing = await readJson<Dataset>(file);
    const createdAt = opts.now ?? Date.now();
    let created = false;
    if (existing) {
      if (datasetVersion(existing.cases) !== version) throw new Error(`dataset ${id}@${version}: stored file is corrupt`);
    } else {
      const stored: Dataset = { id, name: ds.name, version, cases: ds.cases, createdAt };
      if (ds.description !== undefined) stored.description = ds.description;
      await writeFileAtomic(file, JSON.stringify(stored, null, 2) + "\n");
      const info: DatasetVersionInfo = { version, cases: ds.cases.length, createdAt };
      if (opts.note) info.note = opts.note;
      await appendFile(join(dir, "history.jsonl"), JSON.stringify(info) + "\n", "utf8");
      created = true;
    }
    await writeFileAtomic(join(dir, "latest"), version + "\n");
    return { version, created };
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
    const t = await readText(join(this.datasetsDir, safeId("dataset", id), "history.jsonl"));
    if (!t) return [];
    return t
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as DatasetVersionInfo);
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
   * By id, else the newest experiment with that name (`exp run --name` is
   * what users remember, and re-running a name is how they iterate).
   */
  async resolveExperiment(ref: string): Promise<ExperimentResult | undefined> {
    let byId: ExperimentResult | undefined;
    try {
      byId = await this.getExperiment(ref);
    } catch {
      // not a valid id (e.g. a name with spaces): try it as a name
    }
    return byId ?? (await this.listExperiments({ name: ref, limit: 1 }))[0];
  }

  /** Newest first (ids are time-sortable). */
  async listExperiments(filter: { datasetId?: string; name?: string; limit?: number } = {}): Promise<ExperimentResult[]> {
    if (this.index) return this.index.listExperiments!(filter);
    const files = (await listDir(this.experimentsDir)).filter((f) => f.endsWith(".json")).sort().reverse();
    const out: ExperimentResult[] = [];
    for (const f of files) {
      const r = await readJson<ExperimentResult>(join(this.experimentsDir, f));
      if (!r) continue;
      if (filter.datasetId && r.dataset.id !== filter.datasetId) continue;
      if (filter.name && r.name !== filter.name) continue;
      out.push(r);
      if (filter.limit && out.length >= filter.limit) break;
    }
    return out;
  }

  // ------------------------------------------------------------ judges

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
