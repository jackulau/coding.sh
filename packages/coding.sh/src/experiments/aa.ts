// A/A runs: the same config run twice on the same dataset, compared as if it
// were an A/B test. Agents are not deterministic, so cases flip between
// identical runs; the delta, flip count and per-case SD of an A/A run show
// how big a "win" plain noise produces. The result is stored per (dataset,
// task) as a noise floor that compare and power planning read.
import { createHash } from "node:crypto";
import type { ExperimentResult, TaskInfo } from "../datasets/types.ts";
import { compareExperiments, type Comparison, type CompareOpts } from "./compare.ts";
import { casesFor, type NoisePrior } from "./power.ts";

export interface NoiseFloor extends NoisePrior {
  datasetId: string;
  datasetVersion: string;
  task: TaskInfo;
  /** taskKey(task): the file the floor is stored under. */
  taskKey: string;
  /** The two experiment ids, first run first. */
  experiments: [string, string];
  trials: number;
  /** Cases whose majority outcome flipped (McNemar's b + c). */
  flips: number;
  /** Second − first pass rate, with its paired bootstrap CI. */
  delta: { mean: number; lo: number; hi: number };
  mcnemarP: number;
  ts: number;
}

export interface AaResult {
  noise: NoiseFloor;
  comparison: Comparison;
  /** Paired cases needed to detect a 5pp and a 10pp effect at this noise (α 0.05, power 80%). */
  plan: { for5: number; for10: number };
  warnings: string[];
}

/** Stable short key for a task config (kind + ref). */
export function taskKey(t: TaskInfo): string {
  return createHash("sha256").update(`${t.kind}\0${t.ref}`).digest("hex").slice(0, 12);
}

/** Noise floor from two runs of the same config. */
export function aaNoise(first: ExperimentResult, second: ExperimentResult, opts: CompareOpts & { now?: number } = {}): AaResult {
  const c = compareExperiments(first, second, opts);
  const warnings: string[] = [];
  if (first.task.kind !== second.task.kind || first.task.ref !== second.task.ref) {
    warnings.push(`the two runs used different tasks (${first.task.ref} vs ${second.task.ref}); an A/A run needs the same config twice`);
  }
  const gv = (r: ExperimentResult) => r.graders.map((g) => `${g.id}=${g.version}`).sort().join(",");
  if (gv(first) !== gv(second)) warnings.push("the two runs used different graders; an A/A run needs the same graders");
  if (first.dataset.id !== second.dataset.id || first.dataset.version !== second.dataset.version) {
    warnings.push(`the two runs used different dataset versions (${first.dataset.version} vs ${second.dataset.version})`);
  }
  if (!c.timing.interleaved && c.timing.warning) {
    warnings.push("the two runs were not interleaved, so drift between them counts as noise here; run exp aa with a spec (not two stored runs) to interleave them");
  }
  if (c.verdict !== "inconclusive") {
    warnings.push("the A/A difference is significant: something besides chance differs between the two runs (order, caching, rate limits, time of day)");
  }
  const sd = Number.isFinite(c.power.sd) ? c.power.sd : 0;
  const noise: NoiseFloor = {
    datasetId: first.dataset.id,
    datasetVersion: first.dataset.version,
    task: first.task,
    taskKey: taskKey(first.task),
    experiments: [first.id, second.id],
    trials: Math.max(first.trials, second.trials),
    paired: c.paired,
    flips: c.mcnemar.n,
    flipRate: c.paired ? c.mcnemar.n / c.paired : NaN,
    sd,
    delta: { mean: c.diff.mean, lo: c.diff.lo, hi: c.diff.hi },
    mcnemarP: c.mcnemar.p,
    ts: opts.now ?? Date.now(),
  };
  return { noise, comparison: c, plan: { for5: casesFor(0.05, sd), for10: casesFor(0.1, sd) }, warnings };
}
