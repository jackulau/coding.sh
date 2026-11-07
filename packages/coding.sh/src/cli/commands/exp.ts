// coding.sh exp run|compare|aa|sweep|show|list: generic dataset experiments (src/experiments).
// `exp run --arm a=… --arm b=…` runs two tasks as one interleaved A/B, optionally
// stopping early (group sequential, src/stats/sequential.ts). `exp compare
// --pairwise` adds a both-order pairwise judge (src/experiments/pairwise.ts);
// `exp sweep` races configs with sequential halving (src/experiments/sweep.ts).
import { readFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { FileEvalStore } from "../../datasets/store.ts";
import type { Case, Dataset, ExperimentResult, Grader, Split } from "../../datasets/types.ts";
import { aaNoise, taskKey } from "../../experiments/aa.ts";
import { runAb, type AbArm, type AbResult, type RunAbOpts } from "../../experiments/ab.ts";
import { clusterMap, compareExperiments, type CompareOpts } from "../../experiments/compare.ts";
import { runPairwise, summarizePairwise, type PairwiseSummary } from "../../experiments/pairwise.ts";
import { renderAa, renderComparison, renderExperiment, renderPairwise, renderSweep } from "../../experiments/render.ts";
import { runExperiment } from "../../experiments/run.ts";
import { runSweep, type SweepConfig } from "../../experiments/sweep.ts";
import type { TaskSpec } from "../../experiments/task.ts";
import { createGrader, createPairwiseJudgeFromSpec, type GraderSpec, type PairwiseGraderSpec } from "../../graders/index.ts";
import { FileJudgeCache } from "../../judge/cache.ts";
import { withCalibration } from "../../judge/calibrate.ts";
import { calibratePairwise, PAIRWISE_KIND, parsePairLabels, type PairCalibration, type PairwiseJudge } from "../../judge/pairwise.ts";
import { renderCalibration } from "../../judge/render.ts";
import { positiveInt, UsageError } from "../args.ts";
import { jsonArg, list, num, str, withContext } from "../common.ts";
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
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

interface LoadedSpec {
  spec: ExpSpec;
  dataset: Dataset;
  graders: Grader[];
  /** Default experiment name: the spec's, else `<dataset>-<date>`. */
  name: string;
}

/** The experiment the spec file and flags describe (exp run, exp aa). `needTask` is false when --arm gives the tasks. */
async function loadSpec(c: CommandContext, store: FileEvalStore, specFile: string | undefined, needTask = true): Promise<LoadedSpec> {
  const { env } = c;
  let spec: ExpSpec = {};
  let baseDir = c.cwd;
  if (specFile) {
    const file = resolve(c.cwd, specFile);
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
  let graders: Grader[];
  try {
    graders = await Promise.all(spec.graders.map((g) => createGrader(g, { baseDir, env, judgeCache: FileJudgeCache.forEnv(env) })));
  } catch (e) {
    throw new UsageError(`Invalid grader: ${e instanceof Error ? e.message : String(e)}`, { reason: "invalid_grader" });
  }
  return { spec, dataset, graders, name: spec.name ?? `${dataset.name}-${new Date().toISOString().slice(0, 10)}` };
}

/** Run one experiment (exp run without --arm). */
async function runSpec(c: CommandContext, store: FileEvalStore, specFile: string | undefined): Promise<ExperimentResult> {
  const { spec, dataset, graders, name } = await loadSpec(c, store, specFile);
  const spin = c.out.spin(`Running ${dataset.name}…`);
  const result = await runExperiment({
    name,
    dataset,
    task: spec.task!,
    graders,
    ...(spec.trials ? { trials: spec.trials } : {}),
    ...(spec.concurrency ? { concurrency: spec.concurrency } : {}),
    ...(spec.split ? { split: spec.split } : {}),
    store,
    signal: c.signal,
    onProgress: (_r, done, total) => spin.update(`Running ${dataset.name}… ${done}/${total}`),
  });
  spin.stop();
  return result;
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

/** `--seed`: a non-negative integer, or undefined. */
function seedFlag(c: CommandContext): number | undefined {
  const seed = c.flags.seed === undefined ? undefined : num(c.flags.seed);
  if (seed !== undefined && !(Number.isInteger(seed) && seed >= 0)) throw new UsageError(`--seed must be a non-negative integer, got ${JSON.stringify(c.flags.seed)}`);
  return seed;
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
async function runArms(c: CommandContext, store: FileEvalStore, loaded: LoadedSpec, arms: readonly [AbArm, AbArm], extra: Partial<RunAbOpts> = {}): Promise<AbResult> {
  const { spec, dataset, graders, name } = loaded;
  const label = `${dataset.name} (${arms[0].name} vs ${arms[1].name}, interleaved)`;
  const spin = c.out.spin(`Running ${label}…`);
  let looked = "";
  const result = await runAb({
    name,
    dataset,
    arms,
    graders,
    ...(spec.trials ? { trials: spec.trials } : {}),
    ...(spec.concurrency ? { concurrency: spec.concurrency } : {}),
    ...(spec.split ? { split: spec.split } : {}),
    store,
    signal: c.signal,
    ...extra,
    onLook: (l) => (looked = `  look ${l.look}: |z| ${Math.abs(l.z).toFixed(2)} vs ${l.bound.toFixed(2)}`),
    onProgress: (_r, _arm, done, total) => spin.update(`Running ${label}… ${done}/${total}${looked}`),
  });
  spin.stop();
  return result;
}

function cancelledWarning(c: CommandContext, result: ExperimentResult): void {
  const kept = result.runs.length ? `with the ${plural(result.runs.length, "case run")} that finished` : "with no finished case runs";
  c.out.warn(`Cancelled: stored ${result.id} as cancelled ${kept}; exp compare refuses it unless --force. See it with: coding.sh exp show ${result.id}`);
}

export async function run(c: CommandContext): Promise<number> {
  const { out, env } = c;
  return withContext(c, async (ctx) => {
    const store = new FileEvalStore({ env, index: ctx.index });
    switch (c.action) {
      case "run": {
        const armFlags = list(c.flags.arm);
        const stopEarly = c.flags["stop-early"] === true;
        const maxCases = positiveInt(c.flags["max-cases"], "max-cases");
        const looks = positiveInt(c.flags.looks, "looks");
        const seed = seedFlag(c);
        if (!armFlags.length) {
          for (const [flag, set] of [["stop-early", stopEarly], ["max-cases", maxCases !== undefined], ["looks", looks !== undefined], ["seed", seed !== undefined]] as const) {
            if (set) throw new UsageError(`--${flag} needs two --arm options (an interleaved A/B)`, { reason: "invalid_argument" });
          }
        }
        if (looks !== undefined && !stopEarly) throw new UsageError("--looks needs --stop-early", { reason: "invalid_argument" });
        if (armFlags.length) {
          if (str(c.flags.task)) throw new UsageError("Use either --task or two --arm options, not both", { reason: "invalid_argument" });
          const arms = await parseArms(armFlags);
          const loaded = await loadSpec(c, store, c.positionals[0], false);
          const ab = await runArms(c, store, loaded, arms, {
            ...(seed !== undefined ? { seed } : {}),
            ...(maxCases !== undefined ? { maxCases } : {}),
            ...(stopEarly ? { stopEarly: looks !== undefined ? { looks } : true } : {}),
          });
          const cancelled = ab.a.status === "cancelled";
          const cmp = compareExperiments(ab.a, ab.b, { force: true });
          if (out.json) {
            out.data({ outcome: cancelled ? "cancelled" : "completed", pair: { id: ab.pairId, seed: ab.seed }, experiments: [ab.a, ab.b], comparison: cmp, ...(ab.sequential ? { sequential: ab.sequential } : {}) });
          } else {
            out.print(renderComparison(cmp, { color: out.color, a: ab.a, b: ab.b }));
            out.print(`${ab.a.id} ${ab.b.id}`);
          }
          if (cancelled) {
            cancelledWarning(c, ab.a);
            cancelledWarning(c, ab.b);
            return 1;
          }
          const broken = (r: ExperimentResult) => r.summary.n > 0 && r.summary.errors === r.summary.n;
          return broken(ab.a) || broken(ab.b) ? 1 : 0;
        }
        const result = await runSpec(c, store, c.positionals[0]);
        const cancelled = result.status === "cancelled";
        if (out.json) out.data({ outcome: cancelled ? "cancelled" : "completed", experiment: result });
        else {
          out.print(renderExperiment(result, { color: out.color }));
          out.print(result.id);
        }
        // main.ts exits 130 (or 143 for SIGTERM) after an interrupt; say what was kept.
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
        const opts: CompareOpts = { force };
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
        const cmp = compareExperiments(a!, b!, opts);
        const pw = pairSpec ? await pairwiseCompare(c, store, a!, b!, pairSpec, labelsFile, opts.cluster) : undefined;
        if (out.json) {
          out.data({ comparison: cmp, ...(pw ? { pairwise: pw.summary } : {}), ...(pw?.calibration ? { pairwiseCalibration: { ...pw.calibration.report, abstained: pw.calibration.abstained } } : {}) });
        } else {
          out.print(renderComparison(cmp, { color: out.color, a: a!, b: b! }));
          if (pw) out.print(`\n${renderPairwise(pw.summary, { color: out.color })}`);
          if (pw?.calibration) {
            out.print(`\n${renderCalibration(pw.calibration.report, { color: out.color })}`);
            if (pw.calibration.abstained) out.print(`${pw.calibration.abstained} human-decisive case(s) the judge called a tie were left out of kappa`);
          }
        }
        return 0;
      }
      case "aa": {
        let first: ExperimentResult;
        let second: ExperimentResult;
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
          const ab = await runArms(c, store, loaded, [
            { name: "aa1", task },
            { name: "aa2", task },
          ]);
          if (ab.a.status === "cancelled") {
            cancelledWarning(c, ab.a);
            cancelledWarning(c, ab.b);
            return 1;
          }
          [first, second] = [ab.a, ab.b];
        }
        const aa = aaNoise(first, second);
        await store.putNoise(aa.noise);
        if (out.json) out.data({ noise: aa.noise, plan: aa.plan, warnings: aa.warnings, comparison: aa.comparison });
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
        const { spec, dataset, graders } = await loadSpec(c, store, undefined, false);
        const name = spec.name ?? `${dataset.name}-sweep-${new Date().toISOString().slice(0, 10)}`;
        const spin = c.out.spin(`Sweeping ${configs.length} configs on ${dataset.name}…`);
        let result;
        try {
          result = await runSweep({
            name,
            dataset,
            configs,
            graders,
            select,
            heldOut,
            store,
            signal: c.signal,
            ...(budget !== undefined ? { budget } : {}),
            ...(seed !== undefined ? { seed } : {}),
            ...(spec.concurrency ? { concurrency: spec.concurrency } : {}),
            onProgress: (stage, done, total) => spin.update(`Sweeping ${dataset.name}: ${stage} ${done}/${total}`),
          });
        } catch (e) {
          if (e instanceof RangeError) throw new UsageError(e.message, { reason: "invalid_argument" });
          throw e;
        } finally {
          spin.stop();
        }
        if (out.json) out.data({ outcome: result.status, sweep: result });
        else out.print(renderSweep(result, { color: out.color }));
        if (result.status === "cancelled") {
          out.warn("Cancelled: the race stopped before a winner was re-scored on held-out cases; finished runs are stored");
          return 1;
        }
        return 0;
      }
      case "show": {
        const ref = c.positionals[0]!;
        const e = await store.resolveExperiment(ref, { includeCancelled: true });
        if (!e) throw new CliError(`Can't find experiment ${JSON.stringify(ref)}`, { reason: "not_found", next: ["List experiments:", "coding.sh exp list"] });
        if (out.json) out.data({ experiment: e });
        else out.print(renderExperiment(e, { color: out.color }));
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
