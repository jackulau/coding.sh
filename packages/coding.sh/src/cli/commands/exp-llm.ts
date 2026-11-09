// exp run --record / --replay / --replay-until (X-11, src/llmcache): the llm
// cache settings from the flags and the spec's "llm" field, and a replay's
// control arm (EM-19): the recorded config replayed at the same boundary (A)
// against the candidate (B), never the candidate against the recording.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { FileEvalStore } from "../../datasets/store.ts";
import type { ExperimentResult } from "../../datasets/types.ts";
import { compareExperiments } from "../../experiments/compare.ts";
import { renderComparison } from "../../experiments/render.ts";
import type { TaskSpec } from "../../experiments/task.ts";
import { controlNoise } from "../../llmcache/report.ts";
import type { LlmRunOpts } from "../../llmcache/run.ts";
import { hasRecordings } from "../../llmcache/store.ts";
import { paths } from "../../core/paths.ts";
import { UsageError } from "../args.ts";
import { num, str } from "../common.ts";
import { resumeField, resumeNote } from "../jobs.ts";
import { CliError } from "../output.ts";
import type { CommandContext } from "../types.ts";

/** The spec's "llm" field. */
export interface LlmSpec {
  record?: boolean;
  /** Experiment id or name whose recordings to replay. */
  replay?: string;
  until?: number;
  upstream?: { anthropic?: string; openai?: string };
  excludeTools?: boolean;
  excludeModel?: boolean;
}

export interface LlmPlan {
  opts: LlmRunOpts;
  /** replay: the experiment replayed. */
  source?: ExperimentResult;
  /** replay: run the recorded config as a control arm (--no-control turns it off). */
  control: boolean;
}

/** Whether any llm flag is set (they run one task or two arms; not a matrix or --watch). */
export const llmFlagsSet = (c: CommandContext): string[] => (["record", "replay", "replay-until"] as const).filter((f) => c.flags[f] !== undefined && c.flags[f] !== false);

async function specLlm(c: CommandContext, specFile: string | undefined): Promise<LlmSpec | undefined> {
  if (!specFile) return undefined;
  try {
    const v = JSON.parse(await readFile(resolve(c.cwd, specFile), "utf8")) as { llm?: unknown };
    if (v?.llm === undefined) return undefined;
    if (!v.llm || typeof v.llm !== "object" || Array.isArray(v.llm)) throw new UsageError(`${specFile}: "llm" must be an object, e.g. {"record": true} or {"replay": "exp_…", "until": 3}`, { reason: "invalid_argument" });
    return v.llm as LlmSpec;
  } catch (e) {
    if (e instanceof UsageError) throw e;
    return undefined; // loadSpec reports an unreadable spec
  }
}

/** The llm cache settings from --record/--replay/--replay-until and the spec's "llm" field; undefined when neither asks for it. */
export async function llmPlan(c: CommandContext, store: FileEvalStore, specFile: string | undefined): Promise<LlmPlan | undefined> {
  const spec = (await specLlm(c, specFile)) ?? {};
  const record = c.flags.record === true || (c.flags.record === undefined && c.flags.replay === undefined && spec.record === true);
  const replayRef = str(c.flags.replay) ?? (c.flags.record === undefined ? spec.replay : undefined);
  if (c.flags.replay !== undefined && !str(c.flags.replay)) throw new UsageError("--replay needs an experiment id or name: the recorded run to replay", { reason: "missing_argument" });
  if (record && replayRef) throw new UsageError("Use either --record or --replay, not both (a replay records too)", { reason: "invalid_argument" });
  const untilRaw = c.flags["replay-until"] !== undefined ? num(c.flags["replay-until"]) : spec.until;
  if (untilRaw !== undefined && !(Number.isInteger(untilRaw) && untilRaw >= 0)) {
    throw new UsageError(`--replay-until must be a call number (0 or more), got ${JSON.stringify(c.flags["replay-until"] ?? spec.until)}`, { reason: "invalid_argument" });
  }
  if (untilRaw !== undefined && !replayRef) throw new UsageError("--replay-until needs --replay <EXPERIMENT>", { reason: "invalid_argument" });
  if (!record && !replayRef) return undefined;
  const dir = paths(c.env).llmCache;
  let warned = 0;
  const onWarn = (m: string) => {
    if (++warned <= 3) c.out.warn(m);
    else if (warned === 4) c.out.warn("llm cache: more case-trials have no source recording; they run live and are left unscored");
  };
  const opts: LlmRunOpts = {
    mode: record ? "record" : "replay",
    dir,
    onWarn,
    ...(spec.upstream ? { upstream: spec.upstream } : {}),
    ...(spec.excludeTools ? { excludeTools: true } : {}),
    ...(spec.excludeModel ? { excludeModel: true } : {}),
  };
  if (!replayRef) return { opts, control: false };
  const source = await store.resolveExperiment(replayRef, { includeCancelled: true });
  if (!source) throw new CliError(`Can't find experiment ${JSON.stringify(replayRef)} to replay`, { reason: "not_found", next: ["List experiments:", "coding.sh exp list"] });
  if (!(await hasRecordings(dir, source.id))) {
    throw new CliError(`${source.id} has no recorded model calls to replay`, { reason: "no_recordings", next: ["Record a run first:", "coding.sh exp run spec.json --record"] });
  }
  opts.source = source.id;
  if (untilRaw !== undefined) opts.until = untilRaw;
  const control = c.flags.control !== false;
  if (!control) {
    opts.meta = { control: "skipped" };
    c.out.warn("Replaying without a control arm (--no-control): compare has no replay noise floor to read the difference against");
  }
  return { opts, source, control };
}

/** The control arm of a replay: the task spec the source recorded. */
export function recordedTask(source: ExperimentResult): TaskSpec | undefined {
  const t = (source.metadata?.llm as { task?: unknown } | undefined)?.task;
  return t && typeof t === "object" ? (t as TaskSpec) : undefined;
}

/** After a replay's A/B: A's divergence from the source recording, stored on A as its noise floor. */
export async function storeControlNoise(store: FileEvalStore, a: ExperimentResult, source: ExperimentResult): Promise<void> {
  const noise = controlNoise(a, source);
  if (!noise) return;
  a.metadata = { ...a.metadata, llm: { ...((a.metadata?.llm as object) ?? {}), noise } };
  await store.putExperiment(a);
}

/** exp run --replay with one task: the recorded config (control) and the candidate as one interleaved A/B. */
export async function replayWithControl(c: CommandContext, store: FileEvalStore, plan: LlmPlan, specFile: string | undefined, seed: number | undefined): Promise<number> {
  const { loadSpec, runArms, cancelledWarning } = await import("./exp.ts");
  const source = plan.source!;
  const control = recordedTask(source);
  if (!control) {
    throw new UsageError(`${source.id} did not record a command or http task spec, so there is no control arm to replay`, {
      reason: "no_control",
      suggestion: `coding.sh exp run --arm control=recorded.json --arm cand=cand.json --replay ${source.id}, or pass --no-control to replay one task alone`,
    });
  }
  const loaded = await loadSpec(c, store, specFile);
  const { result: ab, job } = await runArms(c, store, loaded, [{ name: "control", task: control }, { name: "candidate", task: loaded.spec.task! }], "exp ab", { llm: plan.opts, ...(seed !== undefined ? { seed } : {}) });
  await storeControlNoise(store, ab.a, source);
  const cmp = compareExperiments(ab.a, ab.b, { force: true });
  const cancelled = ab.a.status === "cancelled";
  if (c.out.json) c.out.data({ outcome: cancelled ? "cancelled" : "completed", pair: { id: ab.pairId, seed: ab.seed }, experiments: [ab.a, ab.b], comparison: cmp, ...resumeField(job) });
  else {
    c.out.print(renderComparison(cmp, { color: c.out.color, a: ab.a, b: ab.b }));
    c.out.print(`${ab.a.id} ${ab.b.id}`);
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
