// coding.sh eval run [suite...]: run eval suites (evals/<name>/suite.json, from
// `eval init`) and print the suite report: pass@1, pass@k, pass^k, per-task
// trials with a transcript to read, flaky and never-passing tasks, saturation.
// Exits 1 when a regression suite has a task that fails most of its trials.
//
// Reuses the existing runners: repo tasks go through runner/experiment.ts (the
// engine behind `compare`) with one harness arm; cases through
// experiments/run.ts (`exp run`); a skill's triggers through `eval trigger`.
import { appendFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { ADAPTERS, getAdapter } from "../../adapters/index.ts";
import { repoRoot } from "../../core/git.ts";
import { sortableId } from "../../core/ids.ts";
import { shortener, wholeRef } from "../../core/session-ref.ts";
import { readTextFile } from "../../core/text-file.ts";
import type { EvalTask, HarnessBundle } from "../../core/types.ts";
import type { Context } from "../../core/context.ts";
import { assignSplits, loadDatasetFile, addCases } from "../../datasets/dataset.ts";
import { FileEvalStore } from "../../datasets/store.ts";
import type { Split } from "../../datasets/types.ts";
import { runExperiment as runCases, selectCases } from "../../experiments/run.ts";
import type { TaskSpec } from "../../experiments/task.ts";
import { referenceRun } from "../../eval/task.ts";
import { createGrader, type GraderSpec } from "../../graders/index.ts";
import { FileJudgeCache } from "../../judge/cache.ts";
import { userHome } from "../../core/paths.ts";
import { bundleFromDir, DEFAULT_INCLUDE } from "../../runner/bundle.ts";
import { runExperiment as runTasks } from "../../runner/experiment.ts";
import { toPosix } from "../../runner/fsutil.ts";
import { latestPerSlot } from "../../runner/iterate.ts";
import { captureRedactor, failedRuns, renderFailedRuns, type FailedRun } from "../../runner/verifier-output.ts";
import { paint } from "../../experiments/text.ts";
import { renderSuiteReport, renderSuitesMarkdown, suiteReport, type SuiteReport, type TaskTrials } from "../../eval/report.ts";
import { CAPTURED_FAILURE_TAG, TODO } from "../../eval/init.ts";
import { capturedFailuresLine, trialsFromExperiment, trialsFromRuns, trialsFromTriggers } from "../../eval/run-suite.ts";
import type { TriggerRunResult } from "./eval-trigger.ts";
import { DEFAULT_TRIALS, resolveSuites, SuiteError, taskDirs, type LoadedSuite } from "../../eval/suite-spec.ts";
import { positiveInt, unknownAgent, UsageError } from "../args.ts";
import { requireConsent, str, withContext } from "../common.ts";
import { nextStepBin, rerunWithYes } from "../next-steps.ts";
import { ensureHookBin } from "../hookbin.ts";
import { infraStopNote, retryFlag, trialTimeout } from "../jobs.ts";
import { CliError, plural } from "../output.ts";
import type { CommandContext } from "../types.ts";
import { commandsForShell, importDir } from "./eval.ts";

interface SuiteOutcome {
  suite: string;
  kind: LoadedSuite["kind"];
  dir: string;
  report?: SuiteReport;
  experimentId?: string;
  harness?: { id: string; name: string; files: number };
  /** Tasks with no reference solution (drafts): a 0% there may be the task, not the agent. */
  unverified?: string[];
  /** Repo-task suites: each failed run with the end of its verifier output. */
  failedRuns?: FailedRun[];
  /** Task names by id, for the failed-run block. */
  names?: Map<string, string>;
  /** A trigger run that ended without a report (cancelled): its exit code. */
  exitCode?: number;
  /** More lines under the report. */
  extra?: string[];
  /** Repo-task suites with tasks from captured failures: the line on them, each source session named by `ref`. */
  captured?: (ref: (id: string) => string) => string | undefined;
  /** Case suites: lines of the cases file left out for repeating an earlier line's input and expected answer. */
  duplicates?: { dropped: string; kept: string }[];
}

export async function evalRun(c: CommandContext): Promise<number> {
  const { out } = c;
  // The commands under the report, named as the user's shell runs them.
  const bin = nextStepBin(c.env);
  const trialsFlag = positiveInt(c.flags.trials, "trials");
  const root = (await repoRoot(c.cwd)) ?? c.cwd;
  let suites: LoadedSuite[];
  try {
    suites = await resolveSuites(c.positionals, c.cwd, root);
  } catch (e) {
    if (e instanceof SuiteError) throw new CliError(e.message, { reason: "not_found", next: ["Create one:", "coding.sh eval init"] });
    throw e;
  }
  const trialsOf = (s: LoadedSuite) => trialsFlag ?? s.spec.trials ?? DEFAULT_TRIALS;
  const outcomes: SuiteOutcome[] = [];
  // Trigger suites run through `eval trigger`, which opens its own store and asks its own consent.
  for (const s of suites.filter((x) => x.kind === "triggers")) outcomes.push(await runTriggers(c, s, trialsOf(s)));
  const rest = suites.filter((x) => x.kind !== "triggers");
  if (rest.length) {
    await withContext(c, async (ctx) => {
      const agentRuns = rest.filter((s) => s.kind === "tasks").map((s) => ({ s, n: taskDirs(s).length * trialsOf(s) }));
      const sessions = agentRuns.reduce((n, x) => n + x.n, 0);
      if (sessions) {
        const what = agentRuns.map((x) => `${x.s.spec.name}: ${plural(taskDirs(x.s).length, "task")} x ${trialsOf(x.s)}`).join(", ");
        await requireConsent(c, `Run ${plural(sessions, "agent session")} (${what})?`, rerunWithYes(c, ["eval", "run", ...c.positionals]));
      }
      for (const s of rest) outcomes.push(s.kind === "tasks" ? await runTaskSuite(c, ctx, s, trialsOf(s), root) : await runCaseSuite(c, ctx, s, trialsOf(s), root));
    });
  }
  const failed = outcomes.some((o) => (o.report ? !o.report.ok : (o.exitCode ?? 0) !== 0));
  const summary = str(c.flags.summary);
  // Each session the text names, by the shortest reference that opens it. --json keeps whole ids.
  const ref = summary || !out.json ? await sessionRefs(c, outcomes) : wholeRef;
  const transcript = (id: string) => `${bin} show ${ref(id)}`;
  const lines = (o: SuiteOutcome) => [...(o.extra ?? []), o.captured?.(ref), ...metaLine(o)].filter((l) => l !== undefined);
  if (summary) {
    const md = renderSuitesMarkdown(
      outcomes.map((o) => ({ suite: o.suite, ...(o.report ? { report: o.report } : { exitCode: o.exitCode ?? 1 }), extra: [...unverifiedLine(o, c.env), ...lines(o)] })),
      { transcript, bin },
    );
    try {
      await appendFile(resolve(c.cwd, summary), md);
    } catch (e) {
      out.warn(`Couldn't write the summary to ${summary}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (out.json) {
    const docs = outcomes.filter((o) => o.report).map(outcomeJson);
    if (docs.length) out.data(docs.length === 1 ? docs[0]! : { suites: docs, ok: !failed });
  } else {
    for (const o of outcomes) {
      if (!o.report) continue;
      out.print("");
      out.print(renderSuiteReport(o.report, { color: out.color, transcript }));
      for (const line of unverifiedLine(o, c.env)) out.print(line);
      const block = renderFailedRuns(o.failedRuns ?? [], { names: (id) => o.names?.get(id) ?? id, dim: (s) => paint(s, "dim", out.color) });
      if (block.length) out.print(["", ...block].join("\n"));
      for (const line of lines(o)) out.print(line);
    }
  }
  return failed ? 1 : 0;
}

/**
 * The shortest reference that opens each session the reports name (core/session-ref.ts), read
 * from the store once every suite ran, so a later suite's sessions can't make a prefix ambiguous.
 * Each id whole (wholeRef) when the reports name none or the store can't be read.
 */
async function sessionRefs(c: CommandContext, outcomes: readonly SuiteOutcome[]): Promise<(id: string) => string> {
  if (!outcomes.some((o) => o.captured || o.report?.rows.some((r) => r.failedSession))) return wholeRef;
  return withContext(c, (ctx) => shortener(ctx.index)).catch(() => wholeRef);
}

// The text names coding.sh as the docs' sample does (the site's docs-samples test reads it here); commandsForShell names the user's.
const unverifiedLine = (o: SuiteOutcome, env: NodeJS.ProcessEnv): string[] =>
  o.unverified?.length
    ? [commandsForShell(`${plural(o.unverified.length, "task")} without a reference solution (${o.unverified.slice(0, 5).join(", ")}${o.unverified.length > 5 ? ", …" : ""}): add reference.patch to the task dir, then coding.sh eval import <task dir> and coding.sh eval validate <task>`, env)]
    : [];

function metaLine(o: SuiteOutcome): string[] {
  const meta = [o.harness ? `harness ${o.harness.name} (${plural(o.harness.files, "file")})` : "", o.experimentId ? `experiment ${o.experimentId}` : ""].filter(Boolean).join(" · ");
  return meta ? [meta] : [];
}

function outcomeJson(o: SuiteOutcome): Record<string, unknown> {
  const doc: Record<string, unknown> = { suite: o.suite, kind: o.kind, dir: o.dir, ...(o.experimentId ? { experimentId: o.experimentId } : {}), ...(o.harness ? { harness: o.harness } : {}), ...(o.unverified?.length ? { unverified: o.unverified } : {}), report: o.report, ...(o.failedRuns?.length ? { failedRuns: o.failedRuns } : {}) };
  if (o.duplicates?.length) doc.duplicates = o.duplicates;
  return doc;
}

/** The harness the suite runs: a stored bundle, else a snapshot of the project's setup for the agent (content-addressed, so a rerun reuses it). */
export async function suiteHarness(c: CommandContext, ctx: Context, s: LoadedSuite, root: string): Promise<HarnessBundle> {
  const ref = str(c.flags.harness) ?? s.spec.harness;
  if (ref) {
    const b = await ctx.index.getBundle(ref);
    if (!b) throw new CliError(`Can't find harness bundle ${JSON.stringify(ref)}`, { reason: "not_found", next: ["List bundles:", "coding.sh harness list"] });
    return b;
  }
  const agent = str(c.flags.agent) ?? s.spec.agent ?? "claude-code";
  const adapter = getAdapter(agent);
  // A suite runs the agent headless: only the agents with a driver are worth naming.
  if (!adapter) throw unknownAgent(agent, ADAPTERS.filter((a) => a.run).map((a) => a.id));
  const hf = adapter.harnessFiles?.();
  const model = str(c.flags.model) ?? s.spec.model;
  const bundle = await bundleFromDir({ name: `${agent}-project`, agent, dir: root, include: hf ? [...hf.project, ...hf.user] : [...DEFAULT_INCLUDE], blobs: ctx.blobs, home: userHome(c.env), ...(model ? { model } : {}) });
  if (!(await ctx.index.getBundle(bundle.id))) await ctx.index.putBundle(bundle);
  return bundle;
}

async function runTaskSuite(c: CommandContext, ctx: Context, s: LoadedSuite, k: number, root: string): Promise<SuiteOutcome> {
  const { out } = c;
  const dirs = taskDirs(s);
  if (!dirs.length) throw new CliError(`Suite ${s.spec.name} has no tasks in ${resolve(s.dir, s.spec.tasks ?? "tasks")}`, { reason: "no_tasks", next: ["Draft tasks from failed sessions:", `coding.sh eval init ${s.spec.name} --sessions`] });
  const tasks: EvalTask[] = [];
  for (const d of dirs) {
    try {
      const imported = await importDir(d, ctx, c.env);
      // The suite tag lets `compare <a> <b> --tag suite:<name>` A/B the same tasks.
      const tag = `suite:${s.spec.name}`;
      const t = imported.tags.includes(tag) ? imported : { ...imported, tags: [...imported.tags, tag] };
      await ctx.index.putTask(t);
      tasks.push(t);
    } catch (e) {
      throw new CliError(`Couldn't read task ${d}: ${commandsForShell(e instanceof Error ? e.message : String(e), c.env)}`, { reason: "invalid_file" });
    }
  }
  const bundle = await suiteHarness(c, ctx, s, root);
  if (!getAdapter(bundle.agent)?.run) throw new CliError(`Agent ${bundle.agent} has no headless driver, so suite ${s.spec.name} can't run`, { reason: "unsupported_agent" });
  if ((await ensureHookBin(c.env)) === "unavailable") out.warn(`The coding.sh hook bin is missing and can't be written, so these runs won't be captured. Run \`${nextStepBin(c.env)} init\` first.`);
  const total = tasks.length * k;
  const spin = out.spin(`${s.spec.name}: 0/${total}…`);
  const timeoutMs = trialTimeout(c);
  const concurrency = positiveInt(c.flags.concurrency, "concurrency");
  const r = await runTasks({
    tasks,
    bundles: [bundle],
    adapterFor: (b) => getAdapter(b.agent)!,
    blobs: ctx.blobs,
    index: ctx.index,
    redactor: captureRedactor(ctx.config, ctx.env),
    k,
    experimentId: sortableId("exp_"),
    ...(concurrency ? { concurrency } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    signal: c.signal,
    ingest: () => ctx.ingest(),
    ...(c.drain ? { drain: c.drain } : {}),
    retry: retryFlag(c),
    onProgress: (p) => spin.update(`${s.spec.name}: ${p.done}/${p.total}…`),
  }).finally(() => spin.stop());
  await ctx.ingest().catch(() => undefined);
  if (r.infraStop) infraStopNote(c, r.infraStop);
  else if (r.cancelled) out.warn(`${s.spec.name}: cancelled; the report covers the runs that finished`);
  const runs = latestPerSlot(r.results).runs;
  const redactor = captureRedactor(ctx.config, ctx.env);
  const trials = trialsFromRuns(tasks, runs, redactor);
  const report = suiteReport(s.spec.name, s.spec.purpose, trials);
  const unverified = tasks.filter((t) => !t.referencePatch && !referenceRun(t)).map((t) => t.name);
  const failed = failedRuns(runs, redactor);
  const outcome: SuiteOutcome = { suite: s.spec.name, kind: "tasks", dir: s.dir, report, ...(failed.length ? { failedRuns: failed, names: new Map(tasks.map((t) => [t.id, t.name])) } : {}), experimentId: r.experimentId, harness: { id: bundle.id, name: bundle.name, files: Object.keys(bundle.files).length }, unverified };
  // Written under the report, once every suite ran and each source session has its reference.
  if (tasks.some((t) => t.tags.includes(CAPTURED_FAILURE_TAG))) outcome.captured = (ref) => capturedFailuresLine(tasks, trials, { ref });
  return outcome;
}

async function runCaseSuite(c: CommandContext, ctx: Context, s: LoadedSuite, trials: number, root: string): Promise<SuiteOutcome> {
  const { out, env } = c;
  const store = new FileEvalStore({ env, index: ctx.index });
  const file = resolve(s.dir, s.spec.cases!);
  let ds;
  try {
    ds = await loadDatasetFile(file, { name: s.spec.dataset ?? s.spec.name });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new CliError(`Suite ${s.spec.name}: can't read ${file}`, { reason: "not_found" });
    throw new CliError(`Suite ${s.spec.name}: couldn't read ${file}: ${e instanceof Error ? e.message : String(e)}`, { reason: "invalid_file" });
  }
  // Same as `dataset import`: the file's cases replace the stored ones (a new version only when they changed).
  const existing = await store.getDataset(ds.id);
  const built = assignSplits(existing ? addCases({ ...existing, cases: [] }, ds.cases) : ds);
  const { version } = await store.putDataset(built);
  const dataset = (await store.getDataset(built.id, version)) ?? built;
  let graders;
  try {
    graders = await Promise.all((s.spec.graders as unknown as GraderSpec[]).map((g) => createGrader(g, { baseDir: s.dir, env, judgeCache: FileJudgeCache.forEnv(env) })));
  } catch (e) {
    throw new UsageError(`Suite ${s.spec.name}: invalid grader: ${e instanceof Error ? e.message : String(e)}`, { reason: "invalid_grader" });
  }
  // A command runs from the project root unless the suite says otherwise.
  const spec = { ...s.spec.task } as Record<string, unknown>;
  if (spec.kind === "command") spec.cwd = resolve(root, typeof spec.cwd === "string" ? spec.cwd : ".");
  // A request case's file sits in the suite; its context files are the project's.
  if (spec.kind === "request") {
    spec.dir = s.dir;
    spec.cwd = resolve(root, typeof spec.cwd === "string" ? spec.cwd : ".");
    spec.env = env;
  }
  const split = s.spec.split as Split | undefined;
  const cases = selectCases(dataset, split);
  const spin = out.spin(`${s.spec.name}: 0/${cases.length * trials}…`);
  const concurrency = positiveInt(c.flags.concurrency, "concurrency") ?? s.spec.concurrency;
  const timeoutMs = trialTimeout(c);
  const result = await runCases({
    name: s.spec.name,
    dataset,
    task: spec as unknown as TaskSpec,
    graders,
    trials,
    ...(concurrency ? { concurrency } : {}),
    ...(split ? { split } : {}),
    store,
    signal: c.signal,
    ...(c.drain ? { drain: c.drain } : {}),
    retry: retryFlag(c),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    metadata: { suite: s.spec.name },
    onProgress: (_r, done, total) => spin.update(`${s.spec.name}: ${done}/${total}…`),
  }).finally(() => spin.stop());
  if (result.infraStop) infraStopNote(c, result.infraStop);
  else if (result.status === "cancelled") out.warn(`${s.spec.name}: cancelled; the report covers the runs that finished`);
  const report = suiteReport(s.spec.name, s.spec.purpose, trialsFromExperiment(cases, result), "case");
  const outcome: SuiteOutcome = { suite: s.spec.name, kind: "cases", dir: s.dir, report, experimentId: result.id };
  // A line with the same input and expected answer as an earlier one ran as that case: say which, as `dataset import` does.
  if (ds.duplicates.length) {
    outcome.duplicates = ds.duplicates;
    outcome.extra = [duplicatesLine(ds.duplicates)];
  }
  return outcome;
}

function duplicatesLine(d: readonly { dropped: string; kept: string }[]): string {
  const each = d.slice(0, 5).map((x) => (x.dropped === x.kept ? `a second ${x.kept}` : `${x.dropped} repeats ${x.kept}`));
  return `${plural(d.length, "line")} left out: ${each.join(", ")}${d.length > 5 ? ", …" : ""} (same input and expected answer)`;
}

async function runTriggers(c: CommandContext, s: LoadedSuite, k: number): Promise<SuiteOutcome> {
  const specFile = resolve(s.dir, s.spec.triggers ?? "triggers.toml");
  const todo = (await readTextFile(specFile).catch(() => "")).split("\n").filter((l) => !l.trimStart().startsWith("#") && l.includes(TODO)).length;
  if (todo) {
    throw new CliError(`Suite ${s.spec.name}: ${plural(todo, "prompt")} in ${toPosix(relative(c.cwd, specFile)) || specFile} still say ${TODO}`, {
      reason: "draft_suite",
      askUser: true,
      next: ["Write real prompts there, or have a model draft them (replaces the file and calls a model):", `coding.sh eval init ${s.spec.name} --skill ${toPosix(relative(c.cwd, resolve(s.dir, s.spec.skill!))) || "."} --draft --force`],
    });
  }
  const flags = { ...c.flags, spec: specFile, k, ...(s.spec.agent && c.flags.agent === undefined ? { agent: s.spec.agent } : {}), ...(s.spec.model && c.flags.model === undefined ? { model: s.spec.model } : {}) };
  delete (flags as Record<string, unknown>).trials;
  const { evalTrigger } = await import("./eval-trigger.ts");
  let result: TriggerRunResult | undefined;
  const exitCode = await evalTrigger({ ...c, flags, positionals: [resolve(s.dir, s.spec.skill!)] }, { onResult: (r) => void (result = r) });
  if (!result) return { suite: s.spec.name, kind: "triggers", dir: s.dir, exitCode: exitCode || 1 };
  const report = suiteReport(s.spec.name, s.spec.purpose, trialsFromTriggers(result.spec, result.observations), "prompt");
  const m = result.report.arms[0]!.metrics;
  const f = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "—");
  return { suite: s.spec.name, kind: "triggers", dir: s.dir, report, experimentId: result.experimentId, extra: [`skill ${result.skill}: precision ${f(m.precision)} · recall ${f(m.recall)} · F1 ${f(m.f1)}`, `trigger report ${result.file}`] };
}
