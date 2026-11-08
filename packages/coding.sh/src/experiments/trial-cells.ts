// Content-keyed case-trials for `exp run` matrix specs: the same idea as
// `compare --reuse` (runner/cells.ts, X-16) for experiments. One (case,
// trial) of one cell is keyed by everything that changes what it measures:
// the dataset, the case's content, the task spec (with the content of the
// files a command task runs), the graders' versions (content hashes), the
// trial number and the trial timeout. A finished case-trial of the same key
// from an earlier experiment can be copied instead of running the task again,
// so several matrices against one baseline cell pay for the baseline once.
import { sha256Hex } from "../core/ids.ts";
import type { Case, CaseRun, ExperimentResult } from "../datasets/types.ts";
import { canonicalJson } from "../datasets/hash.ts";
import { taskFingerprint } from "../jobs/config.ts";

/** Reused case-trials older than this are not reused by default. */
export const DEFAULT_TRIAL_REUSE_MAX_AGE_MS = 7 * 86_400_000;

/**
 * The content key of a task spec, or undefined when it can't be keyed: a
 * function task is code in memory, so two runs of it can't be shown to be
 * the same.
 */
export function trialTaskKey(spec: unknown, cwd?: string): string | undefined {
  if (typeof spec === "function") return undefined;
  if (!spec || typeof spec !== "object" || (spec as { kind?: unknown }).kind === "function") return undefined;
  return sha256Hex(canonicalJson(taskFingerprint(spec, cwd)));
}

export interface TrialCellParts {
  datasetId: string;
  case: Pick<Case, "id" | "input" | "expected" | "metadata">;
  /** trialTaskKey of the cell's task. */
  taskKey: string;
  graders: readonly { id: string; version: string }[];
  trial: number;
  /** Per-trial timeout; undefined means none. */
  timeoutMs?: number;
}

/** The content key of one case-trial. Two case-trials with the same key measured the same thing. */
export function trialCellKey(p: TrialCellParts): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      dataset: p.datasetId,
      // The id too: two cases with the same content are still two cases.
      case: { id: p.case.id, input: p.case.input ?? null, expected: p.case.expected ?? null, metadata: p.case.metadata ?? null },
      task: p.taskKey,
      graders: [...p.graders].map((g) => `${g.id}@${g.version}`).sort(),
      trial: p.trial,
      timeoutMs: p.timeoutMs ?? null,
    }),
  );
}

/**
 * Whether a stored case-trial may stand in for a new one: an original (not
 * itself a copy) with a known outcome (no task error, every grader answered,
 * no infrastructure failure) that started inside the age limit.
 */
export function reusableTrial(r: CaseRun, notBefore: number): boolean {
  return !!r.cellKey && !r.reusedFrom && r.error === undefined && !r.ungraded && !r.infra && r.startedAt >= notBefore;
}

/** The newest reusable case-trial per cell key over stored experiments, skipping `exclude` (this run's own). */
export function newestTrialByCell(experiments: readonly Pick<ExperimentResult, "id" | "runs">[], notBefore: number, exclude: ReadonlySet<string> = new Set()): Map<string, { run: CaseRun; experimentId: string }> {
  const out = new Map<string, { run: CaseRun; experimentId: string }>();
  for (const e of experiments) {
    if (exclude.has(e.id)) continue;
    for (const r of e.runs) {
      if (!reusableTrial(r, notBefore)) continue;
      const have = out.get(r.cellKey!);
      if (!have || r.startedAt > have.run.startedAt) out.set(r.cellKey!, { run: r, experimentId: e.id });
    }
  }
  return out;
}
