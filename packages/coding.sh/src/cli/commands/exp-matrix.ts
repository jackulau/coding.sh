// `exp run spec.json` where the spec has "matrix" or "variants" (Z-4,
// src/experiments/matrix.ts and matrix-run.ts): expand the cells, refuse any
// cell that differs from the baseline outside "vary", run every cell
// interleaved, and compare each with the baseline with Holm-adjusted p-values.
// `--plan` prints the cells and stores nothing; `--cell` runs a subset.
import type { FileEvalStore } from "../../datasets/store.ts";
import { expandMatrix, MatrixPlanError, planText, type MatrixPlan, type MatrixSpec } from "../../experiments/matrix.ts";
import { checkExpPointers, runMatrixExperiment } from "../../experiments/matrix-run.ts";
import { renderMatrixRun } from "../../experiments/render.ts";
import { sortableId } from "../../core/ids.ts";
import { taskFingerprint } from "../../jobs/config.ts";
import { UsageError } from "../args.ts";
import { finishJob, openJob, resumeField, resumeNote } from "../jobs.ts";
import { list } from "../common.ts";
import type { CommandContext } from "../types.ts";
import { cancelledWarning, durable, loadSpec, seedFlag, specConfig } from "./exp.ts";

const planJson = (p: MatrixPlan) => ({
  baseline: p.baseline,
  vary: p.vary,
  cells: p.cells.map((c) => ({ name: c.name, ...(c.labels ? { labels: c.labels } : {}), overrides: c.overrides, ...(c.name === p.baseline ? { baseline: true } : {}) })),
});

export async function matrixRun(c: CommandContext, store: FileEvalStore, specFile: string): Promise<number> {
  const { out } = c;
  for (const [flag, set] of [
    ["arm", list(c.flags.arm).length > 0],
    ["watch", c.flags.watch === true],
    ["series", c.flags.series !== undefined],
    ["stop-early", c.flags["stop-early"] === true],
    ["max-cases", c.flags["max-cases"] !== undefined],
  ] as const) {
    if (set) throw new UsageError(`--${flag} does not combine with a matrix spec; the matrix runs every cell against its baseline cell`, { reason: "invalid_argument" });
  }
  const loaded = await loadSpec(c, store, specFile, false);
  const { spec, dataset, graders } = loaded;
  let plan: MatrixPlan;
  try {
    const m: MatrixSpec = {
      ...(spec.vary !== undefined ? { vary: spec.vary } : {}),
      ...(spec.baseline !== undefined ? { baseline: spec.baseline } : {}),
      ...(spec.variants !== undefined ? { variants: spec.variants } : {}),
      ...(spec.matrix !== undefined ? { matrix: spec.matrix } : {}),
    };
    // The pointer check first: "graders are not overridable" says more than a vary mismatch would.
    checkExpPointers(m);
    plan = expandMatrix({ ...(spec.task !== undefined ? { task: spec.task } : {}), ...(spec.trials !== undefined ? { trials: spec.trials } : {}) }, m);
  } catch (e) {
    if (e instanceof MatrixPlanError) throw new UsageError(`Invalid matrix in ${specFile}: ${e.message}`, { reason: "invalid_matrix" });
    throw e;
  }
  const only = list(c.flags.cell);
  for (const n of only) if (!plan.cells.some((x) => x.name === n)) throw new UsageError(`--cell ${n} is not a cell of this matrix: ${plan.cells.map((x) => x.name).join(", ")}`, { reason: "invalid_argument" });
  if (c.flags.plan === true) {
    if (out.json) out.data({ plan: planJson(plan) });
    else out.print(planText(plan));
    return 0;
  }
  const seed = seedFlag(c);
  const runCells = plan.cells.filter((x) => x.name === plan.baseline || !only.length || only.includes(x.name));
  if (runCells.length < 2) throw new UsageError("--cell names only the baseline; name at least one other cell", { reason: "invalid_argument" });
  const config = specConfig(c, loaded, {
    matrix: runCells.map((x) => ({ name: x.name, task: taskFingerprint(x.config.task, c.cwd), trials: x.config.trials ?? 1 })),
    baseline: plan.baseline,
    seed,
  });
  const job = await openJob(c, { kind: "exp matrix", name: loaded.name, config, newId: () => sortableId("mxrun_"), concurrency: spec.concurrency ?? 4 });
  const spin = out.spin(`Running ${runCells.length} cells on ${dataset.name}…`);
  const result = await job
    .guard(() =>
      runMatrixExperiment({
        name: job.header.name,
        dataset,
        graders,
        plan,
        ...(only.length ? { only } : {}),
        ...(spec.split ? { split: spec.split } : {}),
        ...(spec.concurrency ? { concurrency: spec.concurrency } : {}),
        ...(seed !== undefined ? { seed } : {}),
        store,
        signal: c.signal,
        ...durable(c, job),
        onProgress: (_r, _cell, done, total) => spin.update(`Running ${runCells.length} cells on ${dataset.name}… ${done}/${total}`),
      }),
    )
    .finally(() => spin.stop());
  await finishJob(job, result.status === "cancelled");
  const experiments = Object.fromEntries(Object.entries(result.experiments).map(([k, v]) => [k, v.id]));
  if (out.json) {
    out.data({ outcome: result.status, matrix: { id: result.id, seed: result.seed }, plan: planJson(plan), experiments, comparisons: result.comparisons, ...resumeField(job) });
  } else {
    out.print(renderMatrixRun(result, { color: out.color }));
  }
  resumeNote(c, job);
  if (result.status === "cancelled") {
    for (const r of Object.values(result.experiments)) cancelledWarning(c, r);
    return 1;
  }
  const broken = Object.values(result.experiments).some((r) => r.summary.n > 0 && r.summary.errors === r.summary.n);
  return broken ? 1 : 0;
}
