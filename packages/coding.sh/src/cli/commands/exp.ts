// coding.sh exp run|compare|aa|show|list: generic dataset experiments (src/experiments).
import { dirname, resolve } from "node:path";
import { FileEvalStore } from "../../datasets/store.ts";
import type { ExperimentResult, Split } from "../../datasets/types.ts";
import { aaNoise, taskKey } from "../../experiments/aa.ts";
import { clusterMap, compareExperiments, type CompareOpts } from "../../experiments/compare.ts";
import { renderAa, renderComparison, renderExperiment } from "../../experiments/render.ts";
import { runExperiment } from "../../experiments/run.ts";
import type { TaskSpec } from "../../experiments/task.ts";
import { createGrader, type GraderSpec } from "../../graders/index.ts";
import { FileJudgeCache } from "../../judge/cache.ts";
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

/** Run the experiment the spec file and flags describe (exp run, exp aa). */
async function runSpec(c: CommandContext, store: FileEvalStore, specFile: string | undefined, nameSuffix = ""): Promise<ExperimentResult> {
  const { out, env } = c;
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
  if (!isObj(spec.task)) throw new UsageError('Missing --task, e.g. --task \'{"kind":"command","command":"./my-agent"}\'', { reason: "missing_argument" });
  if (!spec.graders?.length) throw new UsageError('Missing --grader, e.g. --grader \'{"kind":"exact"}\'', { reason: "missing_argument" });
  const dataset = await store.getDataset(spec.dataset);
  if (!dataset) throw new CliError(`Can't find dataset ${JSON.stringify(spec.dataset)}`, { reason: "not_found", next: ["List datasets:", "coding.sh dataset list"] });
  let graders;
  try {
    graders = await Promise.all(spec.graders.map((g) => createGrader(g, { baseDir, env, judgeCache: FileJudgeCache.forEnv(env) })));
  } catch (e) {
    throw new UsageError(`Invalid grader: ${e instanceof Error ? e.message : String(e)}`, { reason: "invalid_grader" });
  }
  const label = `${dataset.name}${nameSuffix}`;
  const spin = out.spin(`Running ${label}…`);
  const result = await runExperiment({
    name: (spec.name ?? `${dataset.name}-${new Date().toISOString().slice(0, 10)}`) + nameSuffix,
    dataset,
    task: spec.task,
    graders,
    ...(spec.trials ? { trials: spec.trials } : {}),
    ...(spec.concurrency ? { concurrency: spec.concurrency } : {}),
    ...(spec.split ? { split: spec.split } : {}),
    store,
    signal: c.signal,
    onProgress: (_r, done, total) => spin.update(`Running ${label}… ${done}/${total}`),
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
        if (out.json) out.data({ comparison: cmp });
        else out.print(renderComparison(cmp, { color: out.color, a: a!, b: b! }));
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
        } else {
          // Same config twice, one after the other (each run is stored like exp run's).
          first = await runSpec(c, store, c.positionals[0], "-aa1");
          if (first.status === "cancelled") {
            cancelledWarning(c, first);
            return 1;
          }
          second = await runSpec(c, store, c.positionals[0], "-aa2");
          if (second.status === "cancelled") {
            cancelledWarning(c, second);
            return 1;
          }
        }
        const aa = aaNoise(first, second);
        await store.putNoise(aa.noise);
        if (out.json) out.data({ noise: aa.noise, plan: aa.plan, warnings: aa.warnings, comparison: aa.comparison });
        else out.print(renderAa(aa, { color: out.color, first, second }));
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
