// coding.sh exp run|compare|regrade|aa|sweep|show|list|status: generic dataset experiments (src/experiments).
// Runs are durable (src/cli/jobs.ts): each finished trial is checkpointed, --resume continues.
// `exp run --arm a=… --arm b=…` runs two tasks as one interleaved A/B, optionally
// stopping early (group sequential, src/stats/sequential.ts). `exp compare
// --pairwise` adds a both-order pairwise judge (src/experiments/pairwise.ts);
// `exp sweep` races configs with sequential halving (src/experiments/sweep.ts).
// `exp compare --gate` adds a ship-or-hold decision and exits 1 unless it accepts;
// `--margin D` adds paired non-inferiority and exits 1 unless B is within D of A.
// `exp plateau` runs the restart e-detector over a loop's experiments (src/experiments/plateau.ts).
// `exp metrics` A/Bs two commands that print numbers (src/experiments/metrics.ts).
import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { FileEvalStore } from "../../datasets/store.ts";
import type { Case, Dataset, ExperimentResult, Grader, Split } from "../../datasets/types.ts";
import { aaNoise, taskKey } from "../../experiments/aa.ts";
import { runAb, type AbArm, type AbResult, type RunAbOpts } from "../../experiments/ab.ts";
import { clusterMap, compareExperiments, type CompareOpts } from "../../experiments/compare.ts";
import { MetricRunError, renderMetrics, runMetrics, type MetricArm } from "../../experiments/metrics.ts";
import { runPairwise, summarizePairwise, type PairwiseSummary } from "../../experiments/pairwise.ts";
import { renderAa, renderComparison, renderExperiment, renderPairwise, renderSweep } from "../../experiments/render.ts";
import { replayNoise } from "../../experiments/continuation.ts";
import { plateau, plateauLine, renderPlateau, type PlateauGate, type PlateauResult } from "../../experiments/plateau.ts";
import { regradeExperiment, runExperiment } from "../../experiments/run.ts";
import { regradeDiff, renderRegradeDiff } from "../../experiments/regrade.ts";
import { runSweep, type SweepConfig } from "../../experiments/sweep.ts";
import type { MatrixSpec } from "../../experiments/matrix.ts";
import type { TaskSpec } from "../../experiments/task.ts";
import { createGrader, createPairwiseJudgeFromSpec, type GraderSpec, type PairwiseGraderSpec } from "../../graders/index.ts";
import { FileJudgeCache } from "../../judge/cache.ts";
import { withCalibration } from "../../judge/calibrate.ts";
import { calibratePairwise, PAIRWISE_KIND, parsePairLabels, type PairCalibration, type PairwiseJudge } from "../../judge/pairwise.ts";
import { renderCalibration } from "../../judge/render.ts";
import type { VerifierAudit } from "../../judge/verifier.ts";
import { sortableId } from "../../core/ids.ts";
import { jobConfig, taskFingerprint } from "../../jobs/config.ts";
import type { Job, JobKind } from "../../jobs/store.ts";
import { positiveInt, UsageError } from "../args.ts";
import { finishJob, openJob, resumeField, resumeNote, retryFlag, statusCommand, trialTimeout } from "../jobs.ts";
import { gateFlags, jsonArg, list, num, str, withContext } from "../common.ts";
import { ago, CliError, plural } from "../output.ts";
import type { CommandContext } from "../types.ts";

interface ExpSpec {
  name?: string;
  dataset?: string;
  task?: TaskSpec;
  graders?: GraderSpec[];
  trials?: number;
  concurrency?: number;
  split?: Split;
  /** Extra files (globs, relative to the spec) whose change reruns `exp run --watch`. */
  watch?: string[];
  /** Matrix specs (src/experiments/matrix.ts): one controlled comparison over cells. */
  vary?: MatrixSpec["vary"];
  variants?: MatrixSpec["variants"];
  matrix?: MatrixSpec["matrix"];
  baseline?: MatrixSpec["baseline"];
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Whether a spec file defines a matrix or variants. Unreadable files are left for loadSpec to report. */
async function isMatrixFile(file: string): Promise<boolean> {
  try {
    const v = JSON.parse(await readFile(file, "utf8")) as unknown;
    return isObj(v) && (v.matrix !== undefined || v.variants !== undefined);
  } catch {
    return false;
  }
}

export interface LoadedSpec {
  spec: ExpSpec;
  dataset: Dataset;
  graders: Grader[];
  /** Default experiment name: the spec's, else `<dataset>-<date>`. */
  name: string;
  /** The spec file, when one was given, and its folder (else cwd): graders' relative paths resolve there. */
  file?: string;
  baseDir?: string;
}

/**
 * What a run of this spec measures, for the job's config hash: the dataset
 * version, split, graders, trials and trial timeout, plus the parts of the
 * caller (tasks, seed, stopping rule). Concurrency, retries and the name are
 * left out: they change how fast it runs, not what it measures.
 */
export function specConfig(c: CommandContext, loaded: LoadedSpec, parts: Record<string, unknown>) {
  const { spec, dataset, graders } = loaded;
  return jobConfig({
    dataset: `${dataset.id}@${dataset.version}`,
    split: spec.split,
    graders: graders.map((g) => `${g.id}@${g.version}`),
    trials: spec.trials ?? 1,
    trialTimeoutMs: trialTimeout(c),
    ...parts,
  });
}

/** The durable-run options a runner takes: the job, the graceful-stop signal, retries and the trial timeout. */
export function durable(c: CommandContext, job: Job) {
  const timeoutMs = trialTimeout(c);
  return { job: job.scope(), ...(c.drain ? { drain: c.drain } : {}), retry: retryFlag(c), ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
}

/** The experiment the spec file and flags describe (exp run, exp aa). `needTask` is false when --arm gives the tasks. */
export async function loadSpec(c: CommandContext, store: FileEvalStore, specFile: string | undefined, needTask = true): Promise<LoadedSpec> {
  const { env } = c;
  let spec: ExpSpec = {};
  let baseDir = c.cwd;
  const file = specFile ? resolve(c.cwd, specFile) : undefined;
  if (file) {
    const v = await jsonArg(file, "spec");
    if (!isObj(v)) throw new UsageError(`${file} must hold a JSON object`);
    spec = v as ExpSpec;
    baseDir = dirname(file);
  }
  if (str(c.flags.dataset)) spec.dataset = str(c.flags.dataset);
  if (str(c.flags.name)) spec.name = str(c.flags.name);
  if (str(c.flags.task)) spec.task = (await jsonArg(str(c.flags.task)!, "--task")) as TaskSpec;
  if (list(c.flags.grader).length) spec.graders = (await Promise.all(list(c.flags.grader).map((g) => jsonArg(g, "--grader")))) as GraderSpec[];
  if (num(c.flags.trials) !== undefined) spec.trials = positiveInt(c.flags.trials, "trials");
  if (num(c.flags.concurrency) !== undefined) spec.concurrency = positiveInt(c.flags.concurrency, "concurrency");
  if (str(c.flags.split)) spec.split = str(c.flags.split) as Split;
  if (!spec.dataset) throw new UsageError("Missing --dataset <ID>", { reason: "missing_argument" });
  if (needTask && !isObj(spec.task)) throw new UsageError('Missing --task, e.g. --task \'{"kind":"command","command":"./my-agent"}\'', { reason: "missing_argument" });
  if (!spec.graders?.length) throw new UsageError('Missing --grader, e.g. --grader \'{"kind":"exact"}\'', { reason: "missing_argument" });
  const dataset = await store.getDataset(spec.dataset);
  if (!dataset) throw new CliError(`Can't find dataset ${JSON.stringify(spec.dataset)}`, { reason: "not_found", next: ["List datasets:", "coding.sh dataset list"] });
  const graders = await buildGraders(c, spec.graders, baseDir);
  return { spec, dataset, graders, name: spec.name ?? `${dataset.name}-${new Date().toISOString().slice(0, 10)}`, baseDir, ...(file ? { file } : {}) };
}

/** Graders from their specs; relative paths resolve against `baseDir`. */
async function buildGraders(c: CommandContext, specs: readonly GraderSpec[], baseDir: string): Promise<Grader[]> {
  try {
    return await Promise.all(specs.map((g) => createGrader(g, { baseDir, env: c.env, judgeCache: FileJudgeCache.forEnv(c.env) })));
  } catch (e) {
    throw new UsageError(`Invalid grader: ${e instanceof Error ? e.message : String(e)}`, { reason: "invalid_grader" });
  }
}

/** `exp regrade <experiment> [spec]`: grade the stored outputs again with the spec's (or --grader's) graders. */
async function regradeCmd(c: CommandContext, store: FileEvalStore): Promise<number> {
  const { out } = c;
  const [ref, specFile] = c.positionals as [string, string | undefined];
  const prev = await store.resolveExperiment(ref);
  if (!prev) throw new CliError(`Can't find a completed experiment ${JSON.stringify(ref)}`, { reason: "not_found", next: ["List experiments:", "coding.sh exp list"] });
  let specs: GraderSpec[] = [];
  let baseDir = c.cwd;
  if (specFile) {
    const file = resolve(c.cwd, specFile);
    const v = await jsonArg(file, "spec");
    if (!isObj(v)) throw new UsageError(`${file} must hold a JSON object`);
    if (Array.isArray(v.graders)) specs = v.graders as GraderSpec[];
    baseDir = dirname(file);
  }
  if (list(c.flags.grader).length) specs = (await Promise.all(list(c.flags.grader).map((g) => jsonArg(g, "--grader")))) as GraderSpec[];
  if (!specs.length) throw new UsageError("Missing graders: pass a spec file with \"graders\" or --grader", { reason: "missing_argument", suggestion: `coding.sh exp regrade ${ref} spec.json` });
  const graders = await buildGraders(c, specs, baseDir);
  // The exact dataset version the experiment ran on; the latest one only when that version is gone (it warns).
  const dataset = (await store.getDataset(prev.dataset.id, prev.dataset.version)) ?? (await store.getDataset(prev.dataset.id));
  if (!dataset) throw new CliError(`Can't find dataset ${prev.dataset.id}, which ${prev.id} ran on`, { reason: "not_found" });
  const concurrency = positiveInt(c.flags.concurrency, "concurrency");
  const spin = out.spin(`Regrading ${prev.name}…`);
  const result = await regradeExperiment({
    result: prev,
    dataset,
    graders,
    store,
    signal: c.signal,
    ...(concurrency ? { concurrency } : {}),
    ...(str(c.flags.name) ? { name: str(c.flags.name) } : {}),
    onWarn: (m) => out.warn(m),
    onProgress: (done, total) => spin.update(`Regrading ${prev.name}… ${done}/${total}`),
  }).finally(() => spin.stop());
  if (result.status === "cancelled") {
    out.warn("Cancelled: the regrade stopped before every run was graded; nothing was stored");
    return 1;
  }
  const diff = regradeDiff(prev, result);
  if (out.json) out.data({ outcome: "completed", experiment: result, diff });
  else {
    out.print(renderRegradeDiff(diff, { color: out.color }));
    out.print(result.id);
    out.note(`Compare the old and new graders on the same outputs: coding.sh exp compare ${prev.id} ${result.id}`);
  }
  return 0;
}

/** Run one experiment (exp run without --arm). */
async function runSpec(c: CommandContext, store: FileEvalStore, specFile: string | undefined): Promise<{ result: ExperimentResult; job: Job; loaded: LoadedSpec }> {
  const loaded = await loadSpec(c, store, specFile);
  const { spec, dataset, graders } = loaded;
  // EM-19: a next-turn experiment without a control arm has no replay noise floor to read B against.
  const continuation = (spec.task as { kind?: unknown }).kind === "continuation";
  if (continuation && c.flags.control !== false) {
    throw new UsageError("A continuation task needs a control arm: run the recorded config as A and your change as B in one run, or pass --no-control to run it alone", {
      reason: "no_control",
      suggestion: "coding.sh exp run --arm control=recorded.json --arm cand=cand.json …",
    });
  }
  const config = specConfig(c, loaded, { task: taskFingerprint(spec.task, c.cwd) });
  const job = await openJob(c, { kind: "exp run", name: loaded.name, config, newId: () => sortableId("exp_"), concurrency: spec.concurrency ?? 4 });
  const spin = c.out.spin(`Running ${dataset.name}…`);
  const result = await job
    .guard(() =>
      runExperiment({
        name: job.header.name,
        id: job.id,
        dataset,
        task: spec.task!,
        graders,
        ...(spec.trials ? { trials: spec.trials } : {}),
        ...(spec.concurrency ? { concurrency: spec.concurrency } : {}),
        ...(spec.split ? { split: spec.split } : {}),
        ...(continuation || seriesFlag(c) ? { metadata: { ...(continuation ? { control: "skipped" } : {}), ...(seriesFlag(c) ? { series: seriesFlag(c) } : {}) } } : {}),
        store,
        signal: c.signal,
        ...durable(c, job),
        onProgress: (_r, done, total) => spin.update(`Running ${dataset.name}… ${done}/${total}`),
      }),
    )
    .finally(() => spin.stop());
  await finishJob(job, result.status === "cancelled");
  return { result, job, loaded };
}

const NAME = /^[\w.-]+$/;

/**
 * `NAME=<JSON|FILE>` (or, with `fallback`, a bare `<JSON|FILE>` named by the
 * file or the fallback). The JSON is a task spec, or an exp spec with a task.
 */
async function namedTask(v: string, what: string, fallback?: string): Promise<{ name: string; task: TaskSpec }> {
  const eq = v.indexOf("=");
  let name = eq > 0 && NAME.test(v.slice(0, eq)) ? v.slice(0, eq) : "";
  const ref = name ? v.slice(eq + 1) : v;
  if (!name && fallback !== undefined) name = ref.trim().startsWith("{") ? fallback : basename(ref, extname(ref));
  if (!NAME.test(name)) throw new UsageError(`${what} must be NAME=<JSON|FILE>, e.g. base=task.json (got ${JSON.stringify(v)})`, { reason: "invalid_argument" });
  let task = await jsonArg(ref, `${what} ${name}`);
  if (isObj(task) && task.kind === undefined && isObj(task.task)) task = task.task;
  if (!isObj(task)) throw new UsageError(`${what} ${name} must be a task spec object`, { reason: "invalid_argument" });
  return { name, task: task as unknown as TaskSpec };
}

/** `--arm NAME=<JSON|FILE>`, exactly two. */
async function parseArms(values: string[]): Promise<[AbArm, AbArm]> {
  if (values.length !== 2) throw new UsageError(`--arm takes exactly two arms, A then B (got ${values.length})`, { reason: "invalid_argument" });
  const arms = await Promise.all(values.map((v) => namedTask(v, "--arm")));
  if (arms[0]!.name === arms[1]!.name) throw new UsageError(`the two --arm names must differ (both ${JSON.stringify(arms[0]!.name)})`, { reason: "invalid_argument" });
  return arms as [AbArm, AbArm];
}

/** `exp sweep` configs: `[NAME=]<JSON|FILE>`, at least two, distinct names. */
async function parseConfigs(values: string[]): Promise<SweepConfig[]> {
  if (values.length < 2) throw new UsageError(`exp sweep needs at least two configs (got ${values.length})`, { reason: "missing_argument" });
  const configs = await Promise.all(values.map((v, i) => namedTask(v, "config", `c${i + 1}`)));
  const seen = new Set<string>();
  for (const c of configs) {
    if (seen.has(c.name)) throw new UsageError(`two configs are named ${JSON.stringify(c.name)}; name them with NAME=<JSON|FILE>`, { reason: "invalid_argument" });
    seen.add(c.name);
  }
  return configs;
}

/** `--series NAME` (X-18): the iteration loop an experiment belongs to. */
function seriesFlag(c: CommandContext): string | undefined {
  const v = c.flags.series;
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !v.trim()) throw new UsageError("--series needs a name, e.g. --series prompt-loop", { reason: "invalid_argument" });
  return v.trim();
}

/** A stored series: completed experiments tagged `metadata.series`, oldest first. */
async function storedSeries(store: FileEvalStore, name: string | undefined, datasetId?: string): Promise<ExperimentResult[]> {
  const all = await store.listExperiments(datasetId ? { datasetId } : {});
  return all
    .filter((e) => (e.status ?? "completed") === "completed" && (name === undefined || e.metadata?.series === name))
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

/** `exp plateau`: the series from ids, --series or --dataset, starting at --baseline. */
async function plateauCmd(c: CommandContext, store: FileEvalStore): Promise<number> {
  const { out } = c;
  const name = seriesFlag(c);
  const gate = (str(c.flags.gate) ?? "greedy") as PlateauGate;
  const eps = c.flags.eps === undefined ? 0.05 : num(c.flags.eps);
  const delta = c.flags.delta === undefined ? 0.05 : num(c.flags.delta);
  for (const [flag, v] of [["eps", eps], ["delta", delta]] as const) {
    if (!(v !== undefined && v > 0 && v < 1)) throw new UsageError(`--${flag} must be between 0 and 1, got ${JSON.stringify(c.flags[flag])}`, { reason: "invalid_argument" });
  }
  const resolve = async (ref: string) => {
    const e = await store.resolveExperiment(ref);
    if (!e) throw new CliError(`Can't find experiment ${JSON.stringify(ref)}`, { reason: "not_found", next: ["List experiments:", "coding.sh exp list"] });
    return e;
  };
  let series: ExperimentResult[];
  if (c.positionals.length) series = await Promise.all(c.positionals.map(resolve));
  else if (name !== undefined || str(c.flags.dataset)) {
    const ref = str(c.flags.dataset);
    const datasetId = ref ? ((await store.getDataset(ref))?.id ?? ref) : undefined;
    series = await storedSeries(store, name, datasetId);
  } else {
    throw new UsageError("Name the series: exp plateau <experiment…>, --series NAME (tagged by exp run --series) or --dataset ID", { reason: "missing_argument" });
  }
  const baseRef = str(c.flags.baseline);
  if (baseRef) {
    const base = await resolve(baseRef);
    const rest = series.filter((e) => e.id !== base.id && (c.positionals.length > 0 || e.createdAt >= base.createdAt));
    series = [base, ...rest];
  }
  const result = plateau(series, { eps: eps!, delta: delta!, gate, ...(str(c.flags.bet) ? { bet: str(c.flags.bet) as "agrapa" | "mixture" } : {}) });
  if (out.json) out.data({ ...(name ? { series: name } : {}), plateau: result });
  else out.print(renderPlateau(result, { color: out.color, ...(name ? { series: name } : {}) }));
  return result.status === "stop" ? 3 : result.status === "insufficient" ? 2 : 0;
}

/** After `exp run --series`: the series' stopping status, or undefined. */
async function seriesStatus(store: FileEvalStore, name: string | undefined): Promise<PlateauResult | undefined> {
  return name === undefined ? undefined : plateau(await storedSeries(store, name));
}

/** `--seed`: a non-negative integer, or undefined. */
export function seedFlag(c: CommandContext): number | undefined {
  const seed = c.flags.seed === undefined ? undefined : num(c.flags.seed);
  if (seed !== undefined && !(Number.isInteger(seed) && seed >= 0)) throw new UsageError(`--seed must be a non-negative integer, got ${JSON.stringify(c.flags.seed)}`);
  return seed;
}

/** Stored verifier precision audits (`judge calibrate --grader <verifier>`) for the experiments' graders, by grader version. */
async function verifierAudits(store: FileEvalStore, ...exps: ExperimentResult[]): Promise<Map<string, VerifierAudit>> {
  const out = new Map<string, VerifierAudit>();
  for (const g of exps.flatMap((e) => e.graders)) {
    if (g.calibration || out.has(g.version)) continue; // LLM judges are calibrated, not audited
    const audit = await store.getVerifierAudit(g.version).catch(() => undefined);
    if (audit) out.set(g.version, audit);
  }
  return out;
}

/** Human pairwise labels: a JSON array or JSONL rows. */
async function readPairLabels(file: string) {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    throw new UsageError(`can't read --labels ${JSON.stringify(file)}`, { reason: "invalid_argument" });
  }
  try {
    const t = text.trim();
    const rows = t.startsWith("[") ? (JSON.parse(t) as unknown[]) : t.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as unknown);
    return parsePairLabels(rows);
  } catch (e) {
    throw new UsageError(`--labels ${file}: ${e instanceof Error ? e.message : String(e)}`, { reason: "invalid_argument" });
  }
}

/**
 * `exp compare --pairwise`: judge both experiments' outputs side by side.
 * The judge version is stored on first use (like an llm grader's), a stored
 * calibration wins, and `--labels` measures and stores a new one.
 */
async function pairwiseCompare(
  c: CommandContext,
  store: FileEvalStore,
  a: ExperimentResult,
  b: ExperimentResult,
  specArg: string,
  labelsFile: string | undefined,
  cluster: CompareOpts["cluster"],
): Promise<{ summary: PairwiseSummary; calibration?: PairCalibration }> {
  const spec = await jsonArg(specArg, "--pairwise");
  if (!isObj(spec) || spec.kind !== PAIRWISE_KIND) {
    throw new UsageError(`--pairwise must be a pairwise judge spec, e.g. {"kind":"pairwise","name":"quality","rubric":"…","provider":"openai","model":"…"}`, { reason: "invalid_grader" });
  }
  let judge: PairwiseJudge;
  try {
    judge = createPairwiseJudgeFromSpec(spec as unknown as PairwiseGraderSpec, { env: c.env, judgeCache: FileJudgeCache.forEnv(c.env) });
  } catch (e) {
    throw new UsageError(`Invalid pairwise judge: ${e instanceof Error ? e.message : String(e)}`, { reason: "invalid_grader" });
  }
  const labels = labelsFile ? await readPairLabels(resolve(c.cwd, labelsFile)) : undefined;
  const stored = await store.getJudge(judge.version.id);
  if (!stored) await store.putJudge(judge.version);
  const version = stored ?? judge.version;
  // Inputs and splits from the datasets; B's cases win where both versions have one.
  const cases = new Map<string, Case>();
  for (const x of [a, b]) {
    const ds = await store.getDataset(x.dataset.id, x.dataset.version);
    for (const cs of ds?.cases ?? []) cases.set(cs.id, cs);
  }
  const spin = c.out.spin("Judging pairs in both orders…");
  const opts = cluster ? { cluster } : {};
  let summary = await runPairwise(judge, a, b, {
    cases,
    signal: c.signal,
    ...opts,
    ...(version.calibration ? { calibration: version.calibration } : {}),
    onProgress: (done, total) => spin.update(`Judging pairs in both orders… ${done}/${total}`),
  });
  spin.stop();
  if (!summary.n && summary.skipped.judgeErrors) {
    throw new CliError(`The pairwise judge failed on every case: ${summary.skipped.firstError ?? "unknown error"}`, { reason: "judge_error" });
  }
  if (!labels) return { summary };
  const splits = new Map<string, Split>();
  for (const cs of cases.values()) if (cs.split) splits.set(cs.id, cs.split);
  const calibration = calibratePairwise({
    judge: { id: version.id, tunedOn: version.tunedOn, criterion: version.criterion },
    labels,
    verdicts: new Map(summary.cases.map((x) => [x.caseId, x])),
    splits,
  });
  await store.putJudge(withCalibration(version, calibration.report));
  summary = summarizePairwise(summary.cases, { id: version.id, calibration: calibration.report.status }, summary.skipped, opts);
  return { summary, calibration };
}

/** Run two tasks as one interleaved A/B (exp run --arm, exp aa). */
export async function runArms(
  c: CommandContext,
  store: FileEvalStore,
  loaded: LoadedSpec,
  arms: readonly [AbArm, AbArm],
  kind: JobKind,
  extra: Partial<RunAbOpts> = {},
): Promise<{ result: AbResult; job: Job }> {
  const { spec, dataset, graders } = loaded;
  const config = specConfig(c, loaded, {
    arms: arms.map((a) => ({ name: a.name, task: taskFingerprint(a.task, c.cwd) })),
    seed: extra.seed,
    maxCases: extra.maxCases,
    stopEarly: extra.stopEarly,
  });
  const job = await openJob(c, { kind, name: loaded.name, config, newId: () => sortableId("pair_"), concurrency: spec.concurrency ?? 4 });
  // The job id doubles as the pair id, so --resume takes either.
  if (job.header.state.pairId === undefined) await job.scope().setState("pairId", job.id);
  const name = job.header.name;
  const label = `${dataset.name} (${arms[0].name} vs ${arms[1].name}, interleaved)`;
  const spin = c.out.spin(`Running ${label}…`);
  let looked = "";
  const result = await job
    .guard(() =>
      runAb({
        name,
        dataset,
        arms,
        graders,
        ...(spec.trials ? { trials: spec.trials } : {}),
        ...(spec.concurrency ? { concurrency: spec.concurrency } : {}),
        ...(spec.split ? { split: spec.split } : {}),
        store,
        signal: c.signal,
        ...durable(c, job),
        ...extra,
        onLook: (l) => (looked = `  look ${l.look}: |z| ${Math.abs(l.z).toFixed(2)} vs ${l.bound.toFixed(2)}`),
        onProgress: (_r, _arm, done, total) => spin.update(`Running ${label}… ${done}/${total}${looked}`),
      }),
    )
    .finally(() => spin.stop());
  await finishJob(job, result.a.status === "cancelled");
  return { result, job };
}

export function cancelledWarning(c: CommandContext, result: ExperimentResult): void {
  const kept = result.runs.length ? `with the ${plural(result.runs.length, "case run")} that finished` : "with no finished case runs";
  c.out.warn(`Cancelled: stored ${result.id} as cancelled ${kept}; exp compare refuses it unless --force. See it with: coding.sh exp show ${result.id}`);
}

/**
 * `--arm NAME=…` for exp metrics: a task spec (JSON), a spec file, or a plain
 * command line. Arms without their own timeout get `timeoutMs`.
 */
function parseMetricArm(v: string, cwd: string, timeoutMs: number): MetricArm {
  const eq = v.indexOf("=");
  const name = eq > 0 ? v.slice(0, eq) : "";
  const body = v.slice(eq + 1).trim();
  if (!/^[\w.-]+$/.test(name) || !body) {
    throw new UsageError(`--arm must be NAME=<command|JSON|FILE>, e.g. --arm base='node bench.mjs' (got ${JSON.stringify(v)})`, { reason: "invalid_argument" });
  }
  let spec: unknown;
  const file = resolve(cwd, body);
  if (body.startsWith("{")) {
    try {
      spec = JSON.parse(body);
    } catch (e) {
      throw new UsageError(`--arm ${name} is not valid JSON: ${(e as Error).message}`, { reason: "invalid_argument" });
    }
  } else if (/\.json$/i.test(body)) {
    if (!existsSync(file)) throw new UsageError(`--arm ${name}: can't read ${JSON.stringify(body)}`, { reason: "invalid_argument" });
    try {
      spec = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      throw new UsageError(`--arm ${name}: ${body} is not valid JSON: ${(e as Error).message}`, { reason: "invalid_argument" });
    }
  } else if (existsSync(file) && statSync(file).isFile() && !/\s/.test(body)) {
    spec = { kind: "command", command: file };
  } else {
    spec = { kind: "command", command: body, cwd };
  }
  if (!isObj(spec) || (spec.kind !== "command" && spec.kind !== "http")) {
    throw new UsageError(`--arm ${name} must be a command line or a {"kind":"command"} / {"kind":"http"} task spec`, { reason: "invalid_argument" });
  }
  if (spec.timeoutMs === undefined) spec.timeoutMs = timeoutMs;
  return { name, task: spec as unknown as TaskSpec };
}

/** exp metrics: no dataset and no store, just two commands and their numbers. */
async function runMetricsCmd(c: CommandContext): Promise<number> {
  const { out } = c;
  const timeout = num(c.flags.timeout) ?? 600;
  if (!(timeout > 0)) throw new UsageError(`--timeout must be a positive number of seconds, got ${JSON.stringify(c.flags.timeout)}`, { reason: "invalid_argument" });
  const values = list(c.flags.arm);
  if (values.length !== 2) {
    throw new UsageError(`exp metrics takes exactly two --arm options, A then B (got ${values.length})`, {
      reason: "missing_argument",
      suggestion: "coding.sh exp metrics --arm a='node bench.mjs' --arm b='node bench.mjs' (an A/A run gives one command twice)",
    });
  }
  const arms = values.map((v) => parseMetricArm(v, c.cwd, Math.round(timeout * 1000))) as [MetricArm, MetricArm];
  if (arms[0].name === arms[1].name) throw new UsageError(`the two --arm names must differ (both ${JSON.stringify(arms[0].name)})`, { reason: "invalid_argument" });
  const pairs = positiveInt(c.flags.pairs, "pairs") ?? 11;
  const warmupRaw = num(c.flags.warmup) ?? 0;
  if (!(Number.isInteger(warmupRaw) && warmupRaw >= 0)) throw new UsageError(`--warmup must be a non-negative integer, got ${JSON.stringify(c.flags.warmup)}`, { reason: "invalid_argument" });
  const seed = c.flags.seed === undefined ? undefined : num(c.flags.seed);
  if (seed !== undefined && !(Number.isInteger(seed) && seed >= 0)) throw new UsageError(`--seed must be a non-negative integer, got ${JSON.stringify(c.flags.seed)}`, { reason: "invalid_argument" });
  const total = 2 * (pairs + warmupRaw);
  const spin = out.spin(`Running ${arms[0].name} vs ${arms[1].name}: ${pairs} pairs…`);
  let result;
  try {
    result = await runMetrics({
      ...(str(c.flags.name) ? { name: str(c.flags.name)! } : {}),
      arms,
      pairs,
      warmup: warmupRaw,
      ...(seed !== undefined ? { seed } : {}),
      higher: list(c.flags.higher),
      only: list(c.flags.metric),
      correction: (str(c.flags.correction) as "holm" | "none" | undefined) ?? "holm",
      signal: c.signal,
      onRun: (r, done) => {
        const what = `${r.warmup ? "warm-up" : `pair ${r.pair}`} ${arms[r.arm].name}`;
        if (out.stdoutTTY) spin.update(`Running ${arms[0].name} vs ${arms[1].name}: ${done}/${total} (${what} ${r.error ? "failed" : `${Math.round(r.durationMs / 1000)}s`})`);
        else out.note(`${done}/${total} ${what}: ${r.error ? `failed: ${r.error.slice(0, 200)}` : `ok in ${Math.round(r.durationMs / 1000)}s`}`);
      },
    });
  } catch (e) {
    spin.stop();
    if (e instanceof MetricRunError) {
      throw new CliError(e.message, {
        reason: "arm_failed",
        next: [`Run arm ${e.arm}'s command by hand; it must exit 0 and print a JSON object of numbers:`, `echo '{"arm":"${e.arm}","pair":1}' | <the arm's command>`],
      });
    }
    throw e;
  }
  spin.stop();
  if (out.json) out.data({ outcome: result.status, experiment: result });
  else out.print(renderMetrics(result, { color: out.color }));
  if (result.status === "cancelled") {
    out.warn(`Cancelled after ${result.summary.pairsComplete} of ${result.pairs} pairs; the result above is partial`);
    return 1;
  }
  if (!result.summary.pairsComplete) {
    throw new CliError("No pair finished in both arms, so there is nothing to compare", {
      reason: "no_pairs",
      next: ["See why the runs failed (the errors are in the report), then rerun:", "coding.sh exp metrics --arm … --arm … --pairs 3"],
    });
  }
  if (c.flags["fail-on-worse"] === true && result.summary.worse > 0) {
    out.warn(`${result.summary.worse} metric(s) worse in ${arms[1].name}`);
    return 1;
  }
  return 0;
}

export async function run(c: CommandContext): Promise<number> {
  const { out, env } = c;
  if (c.action === "metrics") return runMetricsCmd(c);
  if (c.action === "status") return statusCommand(c);
  return withContext(c, async (ctx) => {
    const store = new FileEvalStore({ env, index: ctx.index });
    switch (c.action) {
      case "ab": {
        const { expAb } = await import("./exp-ab.ts");
        return expAb(c, store, ctx);
      }
      case "session": {
        const { sessionCommand } = await import("./exp-session.ts");
        return sessionCommand(c, store);
      }
      case "run": {
        const armFlags = list(c.flags.arm);
        const stopEarly = c.flags["stop-early"] === true;
        const maxCases = positiveInt(c.flags["max-cases"], "max-cases");
        const looks = positiveInt(c.flags.looks, "looks");
        const seed = seedFlag(c);
        // A spec with "matrix" or "variants" runs every cell against its baseline cell.
        if (c.positionals[0] && (await isMatrixFile(resolve(c.cwd, c.positionals[0])))) {
          const { matrixRun } = await import("./exp-matrix.ts");
          return matrixRun(c, store, c.positionals[0]);
        }
        if (c.flags.plan === true || list(c.flags.cell).length) throw new UsageError(`--${c.flags.plan === true ? "plan" : "cell"} needs a spec file with "matrix" or "variants"`, { reason: "invalid_argument" });
        if ((c.flags.reuse !== undefined && c.flags.reuse !== "none") || c.flags["reuse-max-age"] !== undefined) throw new UsageError('--reuse needs a spec file with "matrix" or "variants"', { reason: "invalid_argument" });
        if (!armFlags.length) {
          for (const [flag, set] of [["stop-early", stopEarly], ["max-cases", maxCases !== undefined], ["looks", looks !== undefined], ["seed", seed !== undefined]] as const) {
            if (set) throw new UsageError(`--${flag} needs two --arm options (an interleaved A/B)`, { reason: "invalid_argument" });
          }
        }
        if (looks !== undefined && !stopEarly) throw new UsageError("--looks needs --stop-early", { reason: "invalid_argument" });
        if (armFlags.length && seriesFlag(c) !== undefined) throw new UsageError("--series tags one experiment per loop round; run the candidate alone", { reason: "invalid_argument" });
        if (armFlags.length) {
          if (str(c.flags.task)) throw new UsageError("Use either --task or two --arm options, not both", { reason: "invalid_argument" });
          if (c.flags.watch === true) throw new UsageError("--watch reruns one task; for an A/B of harness edits on save use coding.sh exp ab --watch", { reason: "invalid_argument" });
          const arms = await parseArms(armFlags);
          const loaded = await loadSpec(c, store, c.positionals[0], false);
          const { result: ab, job } = await runArms(c, store, loaded, arms, "exp ab", {
            ...(seed !== undefined ? { seed } : {}),
            ...(maxCases !== undefined ? { maxCases } : {}),
            ...(stopEarly ? { stopEarly: looks !== undefined ? { looks } : true } : {}),
          });
          const cancelled = ab.a.status === "cancelled";
          // Continuation arms: A is the control, so its divergence from the recorded turns is the replay noise floor.
          const replay = ab.a.task.kind === "continuation" ? replayNoise(ab.a, new Map(loaded.dataset.cases.map((x) => [x.id, x]))) : undefined;
          const cmp = compareExperiments(ab.a, ab.b, { force: true, ...(replay ? { replay } : {}) });
          if (out.json) {
            out.data({ outcome: cancelled ? "cancelled" : "completed", pair: { id: ab.pairId, seed: ab.seed }, experiments: [ab.a, ab.b], comparison: cmp, ...(ab.sequential ? { sequential: ab.sequential } : {}), ...resumeField(job) });
          } else {
            out.print(renderComparison(cmp, { color: out.color, a: ab.a, b: ab.b }));
            out.print(`${ab.a.id} ${ab.b.id}`);
          }
          resumeNote(c, job);
          if (cancelled) {
            cancelledWarning(c, ab.a);
            cancelledWarning(c, ab.b);
            return 1;
          }
          const broken = (r: ExperimentResult) => r.summary.n > 0 && r.summary.errors === r.summary.n;
          return broken(ab.a) || broken(ab.b) ? 1 : 0;
        }
        const session = await import("./exp-session.ts");
        if (c.flags.watch === true) {
          if (seriesFlag(c) !== undefined) throw new UsageError("--series tags one experiment per loop round; it does not combine with --watch", { reason: "invalid_argument" });
          return session.watchRun(c, store, c.positionals[0]);
        }
        if (list(c.flags["watch-path"]).length) throw new UsageError("--watch-path needs --watch", { reason: "invalid_argument" });
        const { result, job, loaded } = await runSpec(c, store, c.positionals[0]);
        const cancelled = result.status === "cancelled";
        const series = cancelled ? undefined : await seriesStatus(store, seriesFlag(c));
        // In an experiment session: the run joins its timeline and is compared with the previous one.
        const joined = cancelled ? undefined : await session.recordRun(c, store, result, loaded);
        if (out.json) out.data({ outcome: cancelled ? "cancelled" : "completed", experiment: result, ...(series ? { plateau: series } : {}), ...(joined ? { session: joined } : {}), ...resumeField(job) });
        else {
          out.print(renderExperiment(result, { color: out.color }));
          out.print(result.id);
          if (joined) out.print(`\n${session.deltaText(c, joined)}`);
          if (series) out.note(plateauLine(seriesFlag(c)!, series));
        }
        // main.ts exits 130 (or 143 for SIGTERM) after an interrupt; say what was kept.
        resumeNote(c, job);
        if (cancelled) {
          cancelledWarning(c, result);
          return 1;
        }
        // Every run failing to produce output means the task never worked: not a result.
        return result.summary.n > 0 && result.summary.errors === result.summary.n ? 1 : 0;
      }
      case "compare": {
        const [ida, idb] = c.positionals as [string, string];
        const force = c.flags.force === true;
        const pairSpec = str(c.flags.pairwise);
        const labelsFile = str(c.flags.labels);
        if (labelsFile && !pairSpec) throw new UsageError("--labels needs --pairwise", { reason: "invalid_argument" });
        const gate = gateFlags(c.flags);
        // Without --force a name resolves to its newest completed experiment; when only a
        // cancelled one has that name, find it anyway so the error can say why it is refused.
        const find = async (ref: string) => (await store.resolveExperiment(ref, { includeCancelled: force })) ?? (force ? undefined : await store.resolveExperiment(ref, { includeCancelled: true }));
        const a = await find(ida);
        const b = await find(idb);
        for (const [id, x] of [[ida, a], [idb, b]] as const) {
          if (!x) throw new CliError(`Can't find a completed experiment ${JSON.stringify(id)}`, { reason: "not_found", next: ["List experiments:", "coding.sh exp list"] });
          if (x.status === "cancelled" && !force) {
            throw new CliError(`Experiment ${x.name} (${x.id}) was cancelled after ${plural(x.runs.length, "case run")}; comparing a partial result is misleading`, {
              reason: "cancelled_experiment",
              next: ["Re-run it, or compare the partial result anyway:", `coding.sh exp compare ${ida} ${idb} --force`],
            });
          }
        }
        const margin = num(c.flags.margin);
        if (margin !== undefined && !(margin >= 0 && margin < 1)) throw new UsageError(`--margin must be at least 0 and below 1 (pass-rate points: 0.05 = 5pp), got ${margin}`, { reason: "invalid_argument" });
        const opts: CompareOpts = { force, ...(gate ? { gate } : {}), ...(margin !== undefined ? { margin } : {}) };
        const key = str(c.flags.cluster);
        if (key) {
          // Case metadata lives on the dataset; B's cases fill in ones A's version lacks.
          const of = new Map<string, string>();
          for (const x of [b!, a!]) {
            const ds = await store.getDataset(x.dataset.id, x.dataset.version);
            if (!ds) throw new CliError(`Can't find dataset ${x.dataset.id}@${x.dataset.version} to read --cluster ${key} from`, { reason: "not_found" });
            for (const [k, v] of clusterMap(ds.cases, key)) of.set(k, v);
          }
          opts.cluster = { key, of };
        }
        // The baseline config's A/A noise floor on this dataset, else the candidate's.
        const noise = (await store.getNoise(a!.dataset.id, taskKey(a!.task))) ?? (a!.dataset.id === b!.dataset.id ? await store.getNoise(b!.dataset.id, taskKey(b!.task)) : undefined);
        if (noise) opts.noise = noise;
        const verifiers = await verifierAudits(store, a!, b!);
        if (verifiers.size) opts.verifiers = verifiers;
        // A next-turn A/B: A is the control arm, and its divergence from the recorded turns is the replay noise floor.
        if (a!.task.kind === "continuation" && a!.metadata?.control !== "skipped") {
          const ds = await store.getDataset(a!.dataset.id, a!.dataset.version);
          const replay = ds ? replayNoise(a!, new Map(ds.cases.map((x) => [x.id, x]))) : undefined;
          if (replay) opts.replay = replay;
        }
        const cmp = compareExperiments(a!, b!, opts);
        const pw = pairSpec ? await pairwiseCompare(c, store, a!, b!, pairSpec, labelsFile, opts.cluster) : undefined;
        if (out.json) {
          out.data({ comparison: cmp, ...(pw ? { pairwise: pw.summary } : {}), ...(pw?.calibration ? { pairwiseCalibration: { ...pw.calibration.report, abstained: pw.calibration.abstained } } : {}) });
        } else {
          out.print(renderComparison(cmp, { color: out.color, a: a!, b: b!, matrix: c.flags.matrix === true }));
          if (pw) out.print(`\n${renderPairwise(pw.summary, { color: out.color })}`);
          if (pw?.calibration) {
            out.print(`\n${renderCalibration(pw.calibration.report, { color: out.color })}`);
            if (pw.calibration.abstained) out.print(`${pw.calibration.abstained} human-decisive case(s) the judge called a tie were left out of kappa`);
          }
        }
        // --gate: exit 0 only when the gate accepts B; --margin: only when B is non-inferior.
        return (cmp.gate && cmp.gate.decision !== "accept") || (cmp.nonInferiority && !cmp.nonInferiority.nonInferior) ? 1 : 0;
      }
      case "aa": {
        let first: ExperimentResult;
        let second: ExperimentResult;
        let aaResume: { resume?: string } = {};
        if (c.positionals.length === 2) {
          const found: ExperimentResult[] = [];
          for (const ref of c.positionals) {
            const x = await store.resolveExperiment(ref);
            if (!x) throw new CliError(`Can't find a completed experiment ${JSON.stringify(ref)}`, { reason: "not_found", next: ["List experiments:", "coding.sh exp list"] });
            found.push(x);
          }
          [first, second] = found as [ExperimentResult, ExperimentResult];
          // One run against itself has zero noise by construction and would store a floor of 0.
          if (first.id === second.id) throw new UsageError(`exp aa needs two different runs of the same config; both refer to ${first.id}`);
        } else {
          // Same config twice as one interleaved A/B (each arm is stored like exp run's).
          const loaded = await loadSpec(c, store, c.positionals[0]);
          const task = loaded.spec.task!;
          const { result: ab, job } = await runArms(
            c,
            store,
            loaded,
            [
              { name: "aa1", task },
              { name: "aa2", task },
            ],
            "exp aa",
          );
          resumeNote(c, job);
          aaResume = resumeField(job);
          if (ab.a.status === "cancelled") {
            if (out.json) out.data({ outcome: "cancelled", pair: { id: ab.pairId, seed: ab.seed }, experiments: [ab.a, ab.b], ...aaResume });
            cancelledWarning(c, ab.a);
            cancelledWarning(c, ab.b);
            return 1;
          }
          [first, second] = [ab.a, ab.b];
        }
        const aa = aaNoise(first, second);
        await store.putNoise(aa.noise);
        if (out.json) out.data({ noise: aa.noise, plan: aa.plan, warnings: aa.warnings, comparison: aa.comparison, ...aaResume });
        else out.print(renderAa(aa, { color: out.color, first, second }));
        return 0;
      }
      case "sweep": {
        const configs = await parseConfigs(c.positionals);
        const budget = positiveInt(c.flags.budget, "budget");
        const seed = seedFlag(c);
        const select = (str(c.flags.split) ?? "train") as Split;
        const heldOut = (str(c.flags["held-out"]) ?? "test") as Split;
        if (select === heldOut) throw new UsageError(`--split and --held-out are both ${select}; the held-out split must be one the race never sees`, { reason: "invalid_argument" });
        const loaded = await loadSpec(c, store, undefined, false);
        const { spec, dataset, graders } = loaded;
        const config = specConfig(c, loaded, { configs: configs.map((x) => ({ name: x.name, task: taskFingerprint(x.task, c.cwd) })), budget, seed, select, heldOut });
        const job = await openJob(c, {
          kind: "exp sweep",
          name: spec.name ?? `${dataset.name}-sweep-${new Date().toISOString().slice(0, 10)}`,
          config,
          newId: () => sortableId("sweep_"),
          concurrency: spec.concurrency ?? 4,
        });
        const name = job.header.name;
        const spin = c.out.spin(`Sweeping ${configs.length} configs on ${dataset.name}…`);
        let result;
        try {
          result = await job.guard(() =>
            runSweep({
              name,
              dataset,
              configs,
              graders,
              select,
              heldOut,
              store,
              signal: c.signal,
              ...durable(c, job),
              ...(budget !== undefined ? { budget } : {}),
              ...(seed !== undefined ? { seed } : {}),
              ...(spec.concurrency ? { concurrency: spec.concurrency } : {}),
              onProgress: (stage, done, total) => spin.update(`Sweeping ${dataset.name}: ${stage} ${done}/${total}`),
            }),
          );
        } catch (e) {
          if (e instanceof RangeError) throw new UsageError(e.message, { reason: "invalid_argument" });
          throw e;
        } finally {
          spin.stop();
        }
        await finishJob(job, result.status === "cancelled");
        if (out.json) out.data({ outcome: result.status, sweep: result, ...resumeField(job) });
        else out.print(renderSweep(result, { color: out.color }));
        resumeNote(c, job);
        if (result.status === "cancelled") {
          out.warn("Cancelled: the race stopped before a winner was re-scored on held-out cases; finished runs are stored");
          return 1;
        }
        return 0;
      }
      case "regrade":
        return regradeCmd(c, store);
      case "plateau":
        return plateauCmd(c, store);
      case "show": {
        const ref = c.positionals[0]!;
        const e = await store.resolveExperiment(ref, { includeCancelled: true });
        if (!e) throw new CliError(`Can't find experiment ${JSON.stringify(ref)}`, { reason: "not_found", next: ["List experiments:", "coding.sh exp list"] });
        const verifiers = await verifierAudits(store, e);
        if (out.json) out.data({ experiment: e, ...(verifiers.size ? { verifiers: [...verifiers.values()] } : {}) });
        else out.print(renderExperiment(e, { color: out.color, verifiers }));
        return 0;
      }
      case "list": {
        const limit = positiveInt(c.flags.limit, "limit") ?? 20;
        const all = await store.listExperiments({ limit });
        if (out.json) {
          out.data({ experiments: all.map((e) => ({ id: e.id, name: e.name, status: e.status ?? "completed", dataset: e.dataset, trials: e.trials, runs: e.runs.length, createdAt: new Date(e.createdAt).toISOString(), summary: e.summary })) });
          return 0;
        }
        if (!all.length) {
          out.note("No experiments");
          return 0;
        }
        out.table(
          ["ID", "NAME", "DATASET", "RUNS", "CREATED"],
          all.map((e) => [e.id, e.status === "cancelled" ? `${e.name} (cancelled)` : e.name, `${e.dataset.name}@${e.dataset.version}`, plural(e.runs.length, "run"), ago(e.createdAt)]),
        );
        return 0;
      }
    }
    throw new UsageError(`Unknown exp command ${c.action}`);
  });
}
