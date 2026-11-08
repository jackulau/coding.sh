// `refine test|run --suite <name>`: an eval suite of repo tasks (evals/<name>,
// from `eval init` or written by hand) as the fitness of a harness edit. Each
// round runs the suite's tasks k times with the current files (base) and with
// the candidate, interleaved, as one durable job (`--resume` continues it),
// then judges the pair on the objectives (src/refine/objectives.ts): pass rate
// first, and cost, tokens, wall time, LLM time, turns and harness size.
//
// The runner, report and stats are the ones `compare` and `eval run` use:
// runner/experiment.ts, runner/harness-report.ts and src/stats.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAdapter } from "../../adapters/index.ts";
import type { Context } from "../../core/context.ts";
import { sortableId } from "../../core/ids.ts";
import type { EvalTask, HarnessBundle, RunResult, Session } from "../../core/types.ts";
import { resolveSuites, SuiteError, DEFAULT_TRIALS, taskDirs, type LoadedSuite } from "../../eval/suite-spec.ts";
import { jobConfig } from "../../jobs/config.ts";
import { driverRun, type DriverRun } from "../../refine/drivers.ts";
import { armPoint, judgeObjectives, type ArmPoint, type ObjectiveDecision, type Objective, type RunPoint, type TaskPair } from "../../refine/objectives.ts";
import type { HarnessText } from "../../refine/protect.ts";
import { bundleId, instructionSurface } from "../../runner/bundle.ts";
import { loadRunEvents, loadRunSessions, runExperiment, runMetric, type CompareReport } from "../../runner/experiment.ts";
import { harnessReport } from "../../runner/harness-report.ts";
import { latestPerSlot } from "../../runner/iterate.ts";
import type { GateOpts } from "../../stats/tests.ts";
import { positiveInt, UsageError, type FlagValue } from "../args.ts";
import { list, str } from "../common.ts";
import { ensureHookBin } from "../hookbin.ts";
import { finishJob, openJob, resumeCommand, retryFlag, trialTimeout } from "../jobs.ts";
import { CliError, plural } from "../output.ts";
import type { CommandContext } from "../types.ts";
import { importDir } from "./eval.ts";
import { suiteHarness } from "./eval-run.ts";

export interface Fitness {
  suite: LoadedSuite;
  tasks: EvalTask[];
  k: number;
  /** The suite's harness (a stored bundle, or a snapshot of the repo's setup for the agent). */
  harness: HarnessBundle;
}

/** Loads the suite and imports its tasks (tagged suite:<name>, as `eval run` does). */
export async function loadFitness(c: CommandContext, ctx: Context, root: string, name: string): Promise<Fitness> {
  let suite: LoadedSuite;
  try {
    [suite] = (await resolveSuites([name], c.cwd, root)) as [LoadedSuite];
  } catch (e) {
    if (e instanceof SuiteError) throw new CliError(e.message, { reason: "not_found", next: ["Create one from failed sessions, or write the tasks by hand:", `coding.sh eval init ${name} --sessions`] });
    throw e;
  }
  if (suite.kind !== "tasks") {
    const why =
      suite.kind === "triggers"
        ? "a trigger suite checks whether the skill loads, not how well or how cheaply the agent works once it has"
        : "a cases suite grades a command's answers, which a harness file does not change";
    throw new UsageError(`Suite ${suite.spec.name} is a ${suite.kind} suite: ${why}. refine needs a suite of repo tasks the agent runs`, {
      reason: "invalid_argument",
      suggestion: `coding.sh eval init ${suite.spec.name}-tasks --sessions`,
    });
  }
  const dirs = taskDirs(suite);
  if (!dirs.length) throw new CliError(`Suite ${suite.spec.name} has no tasks`, { reason: "no_tasks", next: ["Draft tasks from failed sessions:", `coding.sh eval init ${suite.spec.name} --sessions`] });
  const tasks: EvalTask[] = [];
  const tag = `suite:${suite.spec.name}`;
  for (const d of dirs) {
    try {
      const imported = await importDir(d, ctx, c.env);
      const t = imported.tags.includes(tag) ? imported : { ...imported, tags: [...imported.tags, tag] };
      await ctx.index.putTask(t);
      tasks.push(t);
    } catch (e) {
      throw new CliError(`Couldn't read task ${d}: ${e instanceof Error ? e.message : String(e)}`, { reason: "invalid_file" });
    }
  }
  // suiteHarness reads --harness, --agent and --model the way `eval run` does.
  const agent = list(c.flags.agent)[0];
  const flags: Record<string, FlagValue> = { harness: c.flags.harness, model: c.flags.model, ...(agent ? { agent } : {}) };
  const harness = await suiteHarness({ ...c, flags }, ctx, suite, root);
  if (!getAdapter(harness.agent)?.run) throw new CliError(`Agent ${harness.agent} has no headless driver, so suite ${suite.spec.name} can't run`, { reason: "unsupported_agent" });
  const k = positiveInt(c.flags.trials, "trials") ?? suite.spec.trials ?? DEFAULT_TRIALS;
  return { suite, tasks, k, harness };
}

/** The suite harness with these harness files laid over it (content-addressed, stored once). */
export async function armBundle(ctx: Context, base: HarnessBundle, files: readonly HarnessText[], name: string): Promise<HarnessBundle> {
  const merged: Record<string, HarnessBundle["files"][string]> = { ...base.files };
  for (const f of files) merged[f.path] = await ctx.blobs.put(f.text);
  const sorted: HarnessBundle["files"] = {};
  for (const k of Object.keys(merged).sort()) sorted[k] = merged[k]!;
  const body = { name, agent: base.agent, model: base.model, flags: base.flags, env: base.env, files: sorted, remove: base.remove };
  const b: HarnessBundle = { id: bundleId(body), ...body, createdAt: Date.now(), note: `refine arm over ${base.name}` };
  if (!(await ctx.index.getBundle(b.id))) await ctx.index.putBundle(b);
  return b;
}

export interface SuiteRoundOpts {
  objectives: Objective[];
  margin: number;
  minGain: number;
  gate: GateOpts;
  maxCostUsd?: number;
  /** The --resume value to open this round's job with (false: start a new one). */
  resume: FlagValue;
  /** The candidate, for the job name. */
  label: string;
}

export interface SuiteRound {
  experimentId: string;
  cancelled: boolean;
  /** Runs not started because the spend cap was reached. */
  skipped: number;
  spentUsd: number;
  unpriced: number;
  resume?: string;
  report?: CompareReport;
  decision?: ObjectiveDecision;
  pairs: TaskPair[];
  arms: { base: ArmPoint; cand: ArmPoint };
  sizes: { base: number; cand: number };
}

const counted = (r: RunResult) => !r.cancelled && !r.superseded && !r.infra;

function point(r: RunResult, s: Session | undefined): RunPoint {
  const p: RunPoint = { pass: r.pass };
  const set = (k: keyof Omit<RunPoint, "pass">, v: number | undefined) => {
    if (v !== undefined && Number.isFinite(v)) p[k] = v;
  };
  set("cost", runMetric("cost", r, s));
  set("tokens", runMetric("tokens", r, s));
  set("wall", runMetric("wall", r, s));
  set("llm", runMetric("llmTime", r, s));
  set("turns", runMetric("turns", r, s));
  return p;
}

/** Pairs of runs per task, from a finished experiment's runs. */
export function taskPairs(tasks: readonly EvalTask[], A: string, B: string, runs: readonly RunResult[], sessions: ReadonlyMap<string, Session>): TaskPair[] {
  return tasks.map((t) => ({
    task: t.name,
    base: runs.filter((r) => r.taskId === t.id && r.bundleId === A && counted(r)).map((r) => point(r, sessions.get(r.id))),
    cand: runs.filter((r) => r.taskId === t.id && r.bundleId === B && counted(r)).map((r) => point(r, sessions.get(r.id))),
  }));
}

/** Runs base and candidate on the suite, interleaved, and judges the pair. */
export async function runSuiteRound(c: CommandContext, ctx: Context, f: Fitness, A: HarnessBundle, B: HarnessBundle, o: SuiteRoundOpts): Promise<SuiteRound> {
  const { out } = c;
  const timeoutMs = trialTimeout(c);
  const concurrency = positiveInt(c.flags.concurrency, "concurrency");
  const config = jobConfig({ bundles: [A.id, B.id], tasks: f.tasks.map((t) => t.id), k: f.k, timeoutMs });
  const job = await openJob({ ...c, flags: { ...c.flags, resume: o.resume } }, { kind: "refine run", name: `${f.suite.spec.name} ${o.label}`, config, newId: () => sortableId("exp_"), concurrency: concurrency ?? 4 });
  if ((await ensureHookBin(c.env)) === "unavailable") out.warn("The coding.sh hook bin is missing and can't be written, so these runs won't be captured: cost, tokens, turns and LLM time need captured sessions. Run `coding.sh init` first.");
  const total = f.tasks.length * 2 * f.k;
  const spin = out.spin(`${f.suite.spec.name}: 0/${total}…`);
  const r = await job
    .guard(() =>
      runExperiment({
        tasks: f.tasks,
        bundles: [A, B],
        adapterFor: (b) => getAdapter(b.agent)!,
        blobs: ctx.blobs,
        index: ctx.index,
        k: f.k,
        ...(concurrency ? { concurrency } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(o.maxCostUsd !== undefined ? { maxCostUsd: o.maxCostUsd } : {}),
        signal: c.signal,
        ingest: () => ctx.ingest(),
        ...(c.drain ? { drain: c.drain } : {}),
        job: job.scope(),
        retry: retryFlag(c),
        experimentId: job.id,
        onProgress: (p) => spin.update(`${f.suite.spec.name}: ${p.done}/${p.total}…`),
      }),
    )
    .finally(() => spin.stop());
  await finishJob(job, r.cancelled);
  await ctx.ingest().catch(() => undefined);
  const runs = latestPerSlot(r.results).runs;
  const spent = runs.reduce((s, x) => s + (x.agent.usage?.costUsd ?? 0), 0);
  const unpriced = runs.filter((x) => x.agent.usage?.costUsd === undefined).length;
  const sizes = { base: (await instructionSurface(A, ctx.blobs)).bytes, cand: (await instructionSurface(B, ctx.blobs)).bytes };
  const sessions = await loadRunSessions(ctx.index, runs);
  const pairs = taskPairs(f.tasks, A.id, B.id, runs, sessions);
  const arms = { base: armPoint(pairs, "base", sizes.base), cand: armPoint(pairs, "cand", sizes.cand) };
  const base = { experimentId: r.experimentId, skipped: r.budget?.skipped ?? 0, spentUsd: r.budget?.spentUsd ?? spent, unpriced: r.budget?.unpriced ?? unpriced, pairs, arms, sizes };
  const status = job.header.status;
  const resume = status === "completed" || status === "running" ? undefined : resumeCommand(job.header);
  if (r.cancelled || (r.budget?.skipped ?? 0) > 0) return { ...base, cancelled: r.cancelled, ...(resume ? { resume } : {}) };
  const report = await harnessReport(ctx, A, B, runs, { gate: o.gate });
  const decision = judgeObjectives(pairs, { objectives: o.objectives, margin: o.margin, minGain: o.minGain, alpha: o.gate.alpha ?? 0.05, size: sizes, ...(report.gate ? { gate: report.gate.verdict } : {}) });
  // The pass-rate power analysis `compare` runs: what this suite can detect at all.
  const pw = report.power;
  if (pw && Number.isFinite(pw.mde)) decision.warnings.push(`the smallest pass-rate change this suite detects with ${Math.round(pw.power * 100)}% power is ${(pw.mde * 100).toFixed(0)} pts (MDE over ${plural(pw.n, "task")})`);
  for (const w of pw?.warnings ?? []) if (w.code === "below-mde" || w.code === "no-power") decision.warnings.push(w.message);
  return { ...base, cancelled: false, ...(resume ? { resume } : {}), report, decision };
}

/** What made the runs of one arm of an experiment slow or expensive, for the cut proposer. */
export async function armDrivers(ctx: Context, experimentId: string, bundleId: string, tasks: ReadonlyMap<string, string>): Promise<DriverRun[]> {
  const runs = latestPerSlot(await ctx.index.listRuns({ experimentId })).runs.filter((r) => r.bundleId === bundleId && counted(r));
  const sessions = await loadRunSessions(ctx.index, runs);
  const events = await loadRunEvents(ctx.index, sessions);
  // The capture clips long tool outputs and keeps the whole output in a blob: measure those.
  const outChars = new Map<string, number>();
  let lookups = 0;
  for (const evs of events.values()) {
    for (const e of evs) {
      const id = e.payload.toolUseId;
      const ref = e.blobs?.[0];
      if (e.kind !== "tool.end" || typeof id !== "string" || !ref || lookups >= MAX_BLOB_LOOKUPS) continue;
      lookups++;
      const text = await ctx.blobs.getText(ref).catch(() => undefined);
      if (text) outChars.set(id, text.length);
    }
  }
  return runs.map((r) => {
    const s = sessions.get(r.id);
    const cost = runMetric("cost", r, s);
    const tokens = runMetric("tokens", r, s);
    return driverRun(tasks.get(r.taskId) ?? r.taskId, r.pass, r.endedAt - r.startedAt, s, events.get(r.id) ?? [], { ...(cost !== undefined ? { cost } : {}), ...(tokens !== undefined ? { tokens } : {}), outChars });
  });
}

/** Clipped tool outputs measured per call to armDrivers, at most. */
const MAX_BLOB_LOOKUPS = 500;

// ---------------------------------------------------------------- the pending round (--resume)

/** A round that started and did not finish: `refine run --resume` tests the same candidate against the same base. */
export interface PendingRound {
  suite: string;
  candidate: string;
  /** The sha of every base harness file when the round started. */
  base: { path: string; sha: string }[];
  experimentId?: string;
  at: string;
}

const pendingFile = (dir: string) => join(dir, "pending.json");

export function readPending(dir: string): PendingRound | undefined {
  try {
    const p = JSON.parse(readFileSync(pendingFile(dir), "utf8")) as PendingRound;
    return p && typeof p.candidate === "string" && Array.isArray(p.base) ? p : undefined;
  } catch {
    return undefined;
  }
}

export function writePending(dir: string, p: PendingRound): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(pendingFile(dir), `${JSON.stringify(p, null, 2)}\n`);
}

export function clearPending(dir: string): void {
  rmSync(pendingFile(dir), { force: true });
}

export const roundsText = (f: Fitness): string => `${plural(f.tasks.length, "task")} x ${f.k} x 2 arms`;
