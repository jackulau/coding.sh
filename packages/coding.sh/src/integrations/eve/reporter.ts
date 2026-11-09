// codingShReporter: an eve EvalReporter that sends each `eve eval` run to
// coding.sh as a dataset version and an experiment (see evals.ts).
//
//   // evals/evals.config.ts
//   import { defineEvalConfig } from "eve/evals";
//   import { codingShReporter } from "coding.sh/eve";   // or this file, from source
//   export default defineEvalConfig({ reporters: [codingShReporter({ dataset: "weather" })] });
//
// It posts once, when the run completes, to `<url>/v1/evals/eve`: a running
// `coding.sh collector` (default http://127.0.0.1:4318) or a team's
// `coding.sh serve` (with an ingest key). It never fails the eve run: a
// coding.sh that is down or refuses the upload gets one warning line.
//
// It implements eve's EvalReporter interface structurally (onRunStart,
// onEvalComplete, onRunComplete), so it does not import eve.
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { compactEveResult, EVE_EVALS_PATH, EVE_EVALS_UPLOAD_VERSION, type EveEvalInfo, type EveEvalResultLike, type EveEvalResultUpload, type EveEvalsUpload, type StoredEveRun } from "./upload.ts";

export const DEFAULT_CODING_SH_URL = "http://127.0.0.1:4318";

export interface CodingShReporterOptions {
  /** coding.sh base URL. Default: $CODING_SH_URL, else http://127.0.0.1:4318 (`coding.sh collector`). */
  url?: string;
  /** Ingest key for `coding.sh serve` (Authorization: Bearer). Default: $CODING_SH_INGEST_KEY. */
  key?: string;
  /** Dataset name. Default: "<package.json name> evals" of the eve app (the working directory). */
  dataset?: string;
  /** Experiment name. Default: the dataset name. */
  name?: string;
  /** Stored on the experiment, e.g. {commit, model}. */
  metadata?: Record<string, unknown>;
  /** Give up on the upload after this long. Default 15000 ms. */
  timeoutMs?: number;
  /** Where the one result or warning line goes. Default: stderr. */
  log?: (line: string) => void;
  /** Called with the stored ids once the upload is stored. */
  onStored?: (r: StoredEveRun) => void;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

/** eve's EvalReporter, structurally. */
export interface CodingShReporter {
  onRunStart(evaluations: readonly EveEvalInfo[], target: { kind?: string; url?: string }): void;
  onEvalComplete(result: EveEvalResultLike, context?: { evaluation?: EveEvalInfo }): void;
  onRunComplete(summary: { startedAt: string; completedAt: string; results: readonly EveEvalResultLike[]; target?: { kind?: string; url?: string } }): Promise<void>;
}

/** "<name> evals" from the app's package.json, else from its directory name. */
export function defaultEveDataset(cwd: string): string {
  try {
    const name = (JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { name?: unknown }).name;
    if (typeof name === "string" && name.trim()) return `${name.trim().replace(/^@[^/]+\//, "")} evals`;
  } catch {
    // no package.json
  }
  return `${basename(cwd) || "eve"} evals`;
}

const info = (e: EveEvalInfo): EveEvalInfo => ({
  id: e.id,
  ...(e.description ? { description: e.description } : {}),
  ...(e.tags?.length ? { tags: [...e.tags] } : {}),
  ...(e.metadata ? { metadata: { ...e.metadata } } : {}),
});

export function codingShReporter(opts: CodingShReporterOptions = {}): CodingShReporter {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const evals = new Map<string, EveEvalInfo>();
  let results: EveEvalResultUpload[] = [];
  let target: { kind?: string; url?: string } | undefined;

  return {
    onRunStart(evaluations, t) {
      evals.clear();
      results = [];
      for (const e of evaluations) evals.set(e.id, info(e));
      target = t ? { ...(t.kind ? { kind: t.kind } : {}), ...(t.url ? { url: t.url } : {}) } : undefined;
    },
    onEvalComplete(result, context) {
      if (context?.evaluation && !evals.has(context.evaluation.id)) evals.set(context.evaluation.id, info(context.evaluation));
      results.push(compactEveResult(result));
    },
    async onRunComplete(summary) {
      // A reporter that only saw onRunComplete (or a runner that skips onEvalComplete) still has the summary.
      const sent = results.length ? results : summary.results.map(compactEveResult);
      const t = target ?? summary.target;
      const dataset = opts.dataset ?? defaultEveDataset(opts.cwd ?? process.cwd());
      const upload: EveEvalsUpload = {
        v: EVE_EVALS_UPLOAD_VERSION,
        source: "eve",
        dataset,
        ...(opts.name ? { name: opts.name } : {}),
        ...(opts.metadata ? { metadata: opts.metadata } : {}),
        ...(t ? { target: { ...(t.kind ? { kind: t.kind } : {}), ...(t.url ? { url: t.url } : {}) } } : {}),
        startedAt: summary.startedAt,
        completedAt: summary.completedAt,
        evals: [...evals.values()],
        results: sent,
      };
      const base = (opts.url ?? env.CODING_SH_URL ?? DEFAULT_CODING_SH_URL).replace(/\/+$/, "");
      const key = opts.key ?? env.CODING_SH_INGEST_KEY;
      const doFetch = opts.fetch ?? fetch;
      try {
        const res = await doFetch(`${base}${EVE_EVALS_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
          body: JSON.stringify(upload),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
        });
        const text = await res.text();
        if (!res.ok) {
          let why = text.slice(0, 200);
          try {
            why = (JSON.parse(text) as { error?: string }).error ?? why;
          } catch {
            // not JSON
          }
          log(`coding.sh: the eval run was not stored (${res.status}: ${why})`);
          return;
        }
        const r = JSON.parse(text) as StoredEveRun;
        const e = r.experiment;
        log(`coding.sh: ${e.passed}/${e.n} passed. Experiment ${e.id} on dataset ${r.dataset.id}@${r.dataset.version}${r.dataset.created ? " (new version)" : ""}. See it: coding.sh exp show ${e.id}`);
        opts.onStored?.(r);
      } catch (err) {
        const why = (err as Error).name === "TimeoutError" ? "timed out" : (err as Error).message;
        log(`coding.sh: could not send the eval run to ${base} (${why}). Start one with: coding.sh collector`);
      }
    },
  };
}
