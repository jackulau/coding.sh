// Run a task over a dataset, grade every output, aggregate with honest
// uncertainty, and (optionally) persist the result.
import { performance } from "node:perf_hooks";
import { sortableId } from "../core/ids.ts";
import type { FileEvalStore } from "../datasets/store.ts";
import type {
  Case,
  CaseRun,
  Dataset,
  ExperimentResult,
  ExperimentStatus,
  ExperimentSummary,
  Grader,
  GraderOutcome,
  GraderSummary,
  Split,
  TraceEvent,
} from "../datasets/types.ts";
import { mapPool } from "../judge/limit.ts";
import { pairedBootstrap, wilson } from "../stats/interval.ts";
import { summarize } from "../stats/summary.ts";
import { resolveTask, type TaskSpec } from "./task.ts";

/** A task may return `withTrace(output, events)` to hand graders (judges) the agent's trace. */
const TRACED = Symbol.for("coding.sh/traced-output");
export interface TracedOutput {
  [TRACED]: true;
  output: unknown;
  trace: TraceEvent[];
}
export function withTrace(output: unknown, trace: TraceEvent[]): TracedOutput {
  return { [TRACED]: true, output, trace };
}
function isTraced(v: unknown): v is TracedOutput {
  return !!v && typeof v === "object" && (v as Record<symbol, unknown>)[TRACED] === true;
}

export interface RunExperimentOpts {
  name: string;
  dataset: Dataset;
  task: TaskSpec;
  graders: readonly Grader[];
  /** Attempts per case. Default 1. */
  trials?: number;
  /** Concurrent case-trials. Default 4. */
  concurrency?: number;
  /** Only cases in these split(s). */
  split?: Split | readonly Split[];
  filter?: (c: Case) => boolean;
  /**
   * Persist the result here when given. Each finished case-trial is also
   * appended to the experiment's progress log as it finishes, so a killed run
   * leaves its finished work on disk.
   */
  store?: FileEvalStore;
  id?: string;
  metadata?: Record<string, unknown>;
  /**
   * Cancels the run: no new case-trial starts, in-flight tasks and graders are
   * killed, and the result has status "cancelled" with only the case-trials
   * that finished before the abort (never the ones it cut short).
   */
  signal?: AbortSignal;
  onProgress?: (run: CaseRun, done: number, total: number) => void;
  /** For the cluster bootstrap when trials > 1. */
  bootstrapIters?: number;
  seed?: number;
}

/**
 * Persist each LLM judge's version the first time it runs, so `judge
 * calibrate` knows its tuning splits and can record its calibration; a judge
 * already stored keeps its record untouched and grades with the calibration
 * stored there (measured against human labels), not the one it was built with.
 */
async function syncJudges(graders: readonly Grader[], store: FileEvalStore): Promise<Grader[]> {
  return Promise.all(
    graders.map(async (g): Promise<Grader> => {
      if (!g.judgeVersion) return g;
      const stored = await store.getJudge(g.version);
      if (!stored) {
        await store.putJudge(g.judgeVersion);
        return g;
      }
      if (!stored.calibration) return g;
      const calibration = stored.calibration;
      return { id: g.id, version: g.version, kind: g.kind, calibration, judgeVersion: { ...g.judgeVersion, calibration }, grade: (ctx) => g.grade(ctx) };
    }),
  );
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** JSON-safe copy of a task output (functions/symbols/cycles become strings). */
function jsonSafe(v: unknown): unknown {
  if (v === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(v)) as unknown;
  } catch {
    return String(v);
  }
}

export async function runExperiment(opts: RunExperimentOpts): Promise<ExperimentResult> {
  const trials = opts.trials ?? 1;
  if (!(Number.isInteger(trials) && trials >= 1)) throw new RangeError(`trials must be a positive integer (got ${trials})`);
  const ids = new Set<string>();
  for (const g of opts.graders) {
    if (ids.has(g.id)) throw new Error(`two graders share the id ${JSON.stringify(g.id)}; give one a distinct name`);
    ids.add(g.id);
  }
  const graders = opts.store ? await syncJudges(opts.graders, opts.store) : opts.graders;
  const want = opts.split === undefined ? undefined : new Set<Split>(typeof opts.split === "string" ? [opts.split] : opts.split);
  const cases = opts.dataset.cases.filter((c) => (!want || (c.split !== undefined && want.has(c.split))) && (!opts.filter || opts.filter(c)));
  const task = resolveTask(opts.task);
  const id = opts.id ?? sortableId("exp_");
  const createdAt = Date.now();
  const jobs: { c: Case; trial: number }[] = [];
  for (const c of cases) for (let t = 1; t <= trials; t++) jobs.push({ c, trial: t });
  const signal = opts.signal;
  const store = opts.store;
  if (store) await store.appendExperimentLog(id, { type: "start", status: "running", id, name: opts.name, total: jobs.length, createdAt });
  let done = 0;

  const settled = await mapPool(jobs, opts.concurrency ?? 4, async ({ c, trial }): Promise<CaseRun | undefined> => {
    if (signal?.aborted) return undefined; // cancelled before it started: not a run
    const startedAt = Date.now();
    const t0 = performance.now();
    let output: unknown;
    let trace: TraceEvent[] | undefined;
    let error: string | undefined;
    try {
      const raw = await task.run(c.input, {
        runId: id,
        caseId: c.id,
        trial,
        ...(c.metadata ? { metadata: c.metadata } : {}),
        ...(signal ? { signal } : {}),
      });
      if (isTraced(raw)) {
        output = raw.output;
        trace = raw.trace;
      } else output = raw;
    } catch (e) {
      error = errMessage(e);
    }
    const latencyMs = Math.round((performance.now() - t0) * 100) / 100;
    const grades: GraderOutcome[] =
      error !== undefined || signal?.aborted
        ? []
        : await Promise.all(
            graders.map(async (g): Promise<GraderOutcome> => {
              try {
                const result = await g.grade({
                  input: c.input,
                  output,
                  expected: c.expected,
                  caseId: c.id,
                  ...(c.metadata ? { metadata: c.metadata } : {}),
                  ...(trace ? { trace } : {}),
                  ...(signal ? { signal } : {}),
                });
                return { graderId: g.id, result };
              } catch (e) {
                return { graderId: g.id, error: errMessage(e) };
              }
            }),
          );
    // The abort cut this case-trial short (killed task or grader): its outcome says nothing about the agent.
    if (signal?.aborted) return undefined;
    const ungraded = error === undefined && grades.some((g) => g.error !== undefined);
    const run: CaseRun = {
      caseId: c.id,
      trial,
      latencyMs,
      grades,
      pass: error === undefined && !ungraded && grades.every((g) => g.result?.pass === true),
      startedAt,
    };
    if (ungraded) run.ungraded = true;
    const safe = jsonSafe(output);
    if (safe !== undefined) run.output = safe;
    if (error !== undefined) run.error = error;
    if (store) await store.appendExperimentLog(id, { type: "run", run });
    done++;
    opts.onProgress?.(run, done, jobs.length);
    return run;
  });
  const runs = settled.filter((r): r is CaseRun => r !== undefined);
  const status: ExperimentStatus = signal?.aborted ? "cancelled" : "completed";

  const result: ExperimentResult = {
    id,
    name: opts.name,
    status,
    dataset: {
      id: opts.dataset.id,
      name: opts.dataset.name,
      version: opts.dataset.version,
      ...(typeof opts.split === "string" ? { split: opts.split } : {}),
    },
    task: task.info,
    graders: graders.map((g) => ({ id: g.id, version: g.version, kind: g.kind, ...(g.calibration ? { calibration: g.calibration } : {}) })),
    trials,
    createdAt,
    finishedAt: Date.now(),
    runs,
    summary: summarizeRuns(runs, graders, trials, { iters: opts.bootstrapIters ?? 2000, seed: opts.seed ?? 0x5eed }),
  };
  if (opts.metadata) result.metadata = opts.metadata;
  if (store) {
    await store.appendExperimentLog(id, { type: "end", status });
    await store.putExperiment(result);
    await store.removeExperimentLog(id); // the stored result now holds every run
  }
  return result;
}

/** Per-case pass rate (fraction of graded trials passed), keyed by case id, in first-seen order. Ungraded runs are left out. */
export function caseRates(runs: readonly CaseRun[]): Map<string, number> {
  const acc = new Map<string, { pass: number; n: number }>();
  for (const r of runs) {
    if (r.ungraded) continue; // outcome unknown: neither a pass nor a fail
    const a = acc.get(r.caseId) ?? { pass: 0, n: 0 };
    a.n++;
    if (r.pass) a.pass++;
    acc.set(r.caseId, a);
  }
  return new Map([...acc].map(([k, v]) => [k, v.pass / v.n]));
}

export function summarizeRuns(
  runs: readonly CaseRun[],
  graders: readonly Pick<Grader, "id" | "kind" | "calibration">[],
  trials: number,
  boot: { iters: number; seed: number } = { iters: 2000, seed: 0x5eed },
): ExperimentSummary {
  const n = runs.length;
  const passed = runs.filter((r) => r.pass).length;
  const errors = runs.filter((r) => r.error !== undefined).length;
  const ungraded = runs.filter((r) => r.ungraded).length;
  const graded = n - ungraded;
  const rates = caseRates(runs);
  let passRate: ExperimentSummary["passRate"];
  let ciMethod: ExperimentSummary["ciMethod"];
  if (trials <= 1) {
    passRate = wilson(passed, graded);
    ciMethod = "wilson";
  } else {
    // Trials of one case are correlated; resample cases, not trials.
    const b = pairedBootstrap([...rates.values()], { iters: boot.iters, seed: boot.seed });
    passRate = { p: graded ? passed / graded : NaN, lo: Number.isNaN(b.lo) ? 0 : b.lo, hi: Number.isNaN(b.hi) ? 1 : b.hi };
    ciMethod = "cluster-bootstrap";
  }
  const gs: GraderSummary[] = graders.map((g) => {
    let gn = 0;
    let gp = 0;
    let ge = 0;
    let sum = 0;
    for (const r of runs) {
      const o = r.grades.find((x) => x.graderId === g.id);
      if (!o) continue;
      if (o.error !== undefined) {
        ge++;
        continue;
      }
      if (!o.result) continue;
      gn++;
      sum += o.result.score;
      if (o.result.pass) gp++;
    }
    const s: GraderSummary = { id: g.id, kind: g.kind, n: gn, passed: gp, errors: ge, meanScore: gn ? sum / gn : NaN, passRate: wilson(gp, gn) };
    if (g.calibration) s.calibration = g.calibration;
    return s;
  });
  const lat = summarize(runs.map((r) => r.latencyMs));
  return {
    n,
    cases: new Set(runs.map((r) => r.caseId)).size,
    passed,
    errors,
    ungraded,
    passRate,
    ciMethod,
    graders: gs,
    latencyMs: { mean: lat.mean, median: lat.median, p90: lat.p90, max: lat.max },
  };
}
