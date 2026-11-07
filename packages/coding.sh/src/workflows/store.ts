// Workflow persistence until the IndexStore additions (docs/WORKFLOWS.md §3)
// land: ~/.coding.sh/workflows/
//   index.jsonl          one line per put (last line per id wins), run summaries
//   runs/<id>.json       { run, nodes }
//   experiments/<id>.json
//   blobs/               agent and workflow return values (content-addressed)
//
// The blobs live in their own FsBlobStore, not the main one: the main store's
// gc sweeps blobs no IndexStore row references, and nothing in the index
// references these yet.
import { appendFile, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataHome } from "../core/paths.ts";
import { FsBlobStore } from "../store/fs-blobs.ts";
import type { BlobRef } from "../schema/index.ts";
import type { WorkflowFramework, WorkflowNode, WorkflowRun, WorkflowVariant } from "./types.ts";

export interface WorkflowExperimentRecord {
  id: string;
  workflow: string;
  driver: string;
  variants: WorkflowVariant[];
  caseIds: string[];
  k: number;
  runIds: string[];
  /** runId → quality score (F1, pass rate, judge score), when scored. */
  scores: Record<string, number>;
  createdAt: number;
}

export interface RunFilter {
  framework?: WorkflowFramework;
  name?: string;
  since?: number;
  experimentId?: string;
  limit?: number;
}

interface IndexLine {
  id: string;
  file: string;
  run: WorkflowRun;
  ts: number;
}

/** File-name-safe id. */
const enc = (id: string): string => encodeURIComponent(id).replace(/\*/g, "%2A");

async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, path);
}

/** Run summary for the index: stats without the per-agent/per-phase arrays. */
function summary(run: WorkflowRun): WorkflowRun {
  const { perAgent: _a, perPhase: _p, ...stats } = run.stats;
  return { ...run, stats };
}

export class WorkflowStore {
  readonly root: string;
  readonly blobs: FsBlobStore;

  constructor(root: string) {
    this.root = root;
    this.blobs = new FsBlobStore(join(root, "blobs"));
  }

  static forEnv(env: NodeJS.ProcessEnv = process.env): WorkflowStore {
    return new WorkflowStore(join(dataHome(env), "workflows"));
  }

  private get indexFile(): string {
    return join(this.root, "index.jsonl");
  }

  /** Stores return values as blobs (setting node.output / run.output), then the run document. */
  async putRun(run: WorkflowRun, nodes: WorkflowNode[], extra: { outputs?: Record<string, unknown>; runOutput?: unknown; script?: string } = {}): Promise<void> {
    await mkdir(join(this.root, "runs"), { recursive: true });
    for (const node of nodes) {
      const v = extra.outputs?.[node.id];
      if (v !== undefined) node.output = await this.putValue(v);
    }
    if (extra.runOutput !== undefined && extra.runOutput !== null) run.output = await this.putValue(extra.runOutput);
    if (extra.script !== undefined) run.script = await this.blobs.put(extra.script, { contentType: "text/javascript" });
    const file = `${enc(run.id)}.json`;
    await writeAtomic(join(this.root, "runs", file), JSON.stringify({ run, nodes }));
    const line: IndexLine = { id: run.id, file, run: summary(run), ts: Date.now() };
    await appendFile(this.indexFile, JSON.stringify(line) + "\n");
  }

  async putValue(v: unknown): Promise<BlobRef> {
    return this.blobs.put(JSON.stringify(v), { contentType: "application/json" });
  }

  async getText(ref: BlobRef): Promise<string | undefined> {
    return this.blobs.getText(ref);
  }

  async getValue(ref: BlobRef): Promise<unknown> {
    const t = await this.blobs.getText(ref);
    if (t === undefined) return undefined;
    try {
      return JSON.parse(t) as unknown;
    } catch {
      return t;
    }
  }

  async getRun(id: string): Promise<{ run: WorkflowRun; nodes: WorkflowNode[] } | undefined> {
    try {
      const v = JSON.parse(await readFile(join(this.root, "runs", `${enc(id)}.json`), "utf8")) as { run: WorkflowRun; nodes: WorkflowNode[] };
      return v;
    } catch {
      return undefined;
    }
  }

  private async lines(): Promise<Map<string, IndexLine>> {
    let text = "";
    try {
      text = await readFile(this.indexFile, "utf8");
    } catch {
      return new Map();
    }
    const out = new Map<string, IndexLine>();
    for (const l of text.split("\n")) {
      if (!l.trim()) continue;
      try {
        const v = JSON.parse(l) as IndexLine;
        if (v && typeof v.id === "string" && v.run) out.set(v.id, v);
      } catch {
        // torn last line from a crash: skip
      }
    }
    return out;
  }

  /** Newest first. */
  async listRuns(f: RunFilter = {}): Promise<WorkflowRun[]> {
    let runs = [...(await this.lines()).values()].map((l) => l.run);
    if (f.framework) runs = runs.filter((r) => r.framework === f.framework);
    if (f.name) runs = runs.filter((r) => r.name === f.name);
    if (f.since !== undefined) runs = runs.filter((r) => r.startedAt >= f.since!);
    if (f.experimentId) runs = runs.filter((r) => r.experimentId === f.experimentId);
    runs.sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id));
    return f.limit !== undefined ? runs.slice(0, f.limit) : runs;
  }

  /** Source signature recorded for a run (import skips unchanged run dirs). */
  async signatureOf(id: string): Promise<string | undefined> {
    return (await this.lines()).get(id)?.run.source?.signature;
  }

  async putExperiment(e: WorkflowExperimentRecord): Promise<void> {
    await mkdir(join(this.root, "experiments"), { recursive: true });
    await writeAtomic(join(this.root, "experiments", `${enc(e.id)}.json`), JSON.stringify(e));
  }

  async getExperiment(id: string): Promise<WorkflowExperimentRecord | undefined> {
    try {
      return JSON.parse(await readFile(join(this.root, "experiments", `${enc(id)}.json`), "utf8")) as WorkflowExperimentRecord;
    } catch {
      return undefined;
    }
  }

  /** Newest first. */
  async listExperiments(): Promise<WorkflowExperimentRecord[]> {
    let files: string[] = [];
    try {
      files = await readdir(join(this.root, "experiments"));
    } catch {
      return [];
    }
    const out: WorkflowExperimentRecord[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        out.push(JSON.parse(await readFile(join(this.root, "experiments", f), "utf8")) as WorkflowExperimentRecord);
      } catch {
        // partial write: skip
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }
}
