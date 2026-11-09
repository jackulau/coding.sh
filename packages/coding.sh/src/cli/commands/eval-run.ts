// coding.sh eval run [suite...]: run eval suites (evals/<name>/suite.json, from
// `eval init`) and print the suite report: pass@1, pass@k, pass^k, per-task
// trials with a transcript to read, flaky and never-passing tasks, saturation.
// Exits 1 when a regression suite has a task that fails most of its trials.
//
// Reuses the existing runners: repo tasks go through runner/experiment.ts (the
// engine behind `compare`) with one harness arm; cases through
// experiments/run.ts (`exp run`); a skill's triggers through `eval trigger`.
import { appendFile, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { getAdapter } from "../../adapters/index.ts";
import { repoRoot } from "../../core/git.ts";
import { sortableId } from "../../core/ids.ts";
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
import { TODO } from "../../eval/init.ts";
import { trialsFromExperiment, trialsFromRuns, trialsFromTriggers } from "../../eval/run-suite.ts";
import type { TriggerRunResult } from "./eval-trigger.ts";
import { DEFAULT_TRIALS, resolveSuites, SuiteError, taskDirs, type LoadedSuite } from "../../eval/suite-spec.ts";
import { positiveInt, UsageError } from "../args.ts";
import { requireConsent, str, withContext } from "../common.ts";
import { ensureHookBin } from "../hookbin.ts";
import { retryFlag, trialTimeout } from "../jobs.ts";
import { CliError, plural } from "../output.ts";
import type { CommandContext } from "../types.ts";
import { importDir } from "./eval.ts";

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
}

const transcript = (id: string) => `coding.sh show ${id.slice(0, 12)}`;

export async function evalRun(c: CommandContext): Promise<number> {
  const { out } = c;
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
        await requireConsent(c, `Run ${plural(sessions, "agent session")} (${what})?`, `coding.sh eval run ${c.positionals.join(" ")} --yes`.replace(/\s+/g, " "));
      }
      for (const s of rest) outcomes.push(s.kind === "tasks" ? await runTaskSuite(c, ctx, s, trialsOf(s), root) : await runCaseSuite(c, ctx, s, trialsOf(s), root));
    });
  }
  const failed = outcomes.some((o) => (o.report ? !o.report.ok : (o.exitCode ?? 0) !== 0));
  const summary = str(c.flags.summary);
  if (summary) {
    const md = renderSuitesMarkdown(
      outcomes.map((o) => ({ suite: o.suite, ...(o.report ? { report: o.report } : { exitCode: o.exitCode ?? 1 }), extra: [...unverifiedLine(o), ...(o.extra ?? []), ...metaLine(o)] })),
      { transcript },
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
      for (const line of unverifiedLine(o)) out.print(line);
      const block = renderFailedRuns(o.failedRuns ?? [], { names: (id) => o.names?.get(id) ?? id, dim: (s) => paint(s, "dim", out.color) });
      if (block.length) out.print(["", ...block].join("\n"));
      for (const line of [...(o.extra ?? []), ...metaLine(o)]) out.print(line);
    }
  }
  return failed ? 1 : 0;
}

const unverifiedLine = (o: SuiteOutcome): string[] =>
  o.unverified?.length
    ? [`${plural(o.unverified.length, "task")} without a reference solution (${o.unverified.slice(0, 5).join(", ")}${o.unverified.length > 5 ? ", …" : ""}): add reference.patch to the task dir, then coding.sh eval import <task dir> and coding.sh eval validate <task>`]
    : [];

function metaLine(o: SuiteOutcome): string[] {
  const meta = [o.harness ? `harness ${o.harness.name} (${plural(o.harness.files, "file")})` : "", o.experimentId ? `experiment ${o.experimentId}` : ""].filter(Boolean).join(" · ");
  return meta ? [meta] : [];
}

function outcomeJson(o: SuiteOutcome): Record<string, unknown> {
  return { suite: o.suite, kind: o.kind, dir: o.dir, ...(o.experimentId ? { experimentId: o.experimentId } : {}), ...(o.harness ? { harness: o.harness } : {}), ...(o.unverified?.length ? { unverified: o.unverified } : {}), report: o.report, ...(o.failedRuns?.length ? { failedRuns: o.failedRuns } : {}) };
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
  if (!adapter) throw new UsageError(`Unknown agent ${JSON.stringify(agent)}`, { reason: "unknown_agent" });
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
      throw new CliError(`Couldn't read task ${d}: ${e instanceof Error ? e.message : String(e)}`, { reason: "invalid_file" });
    }
  }
  const bundle = await suiteHarness(c, ctx, s, root);
  if (!getAdapter(bundle.agent)?.run) throw new CliError(`Agent ${bundle.agent} has no headless driver, so suite ${s.spec.name} can't run`, { reason: "unsupported_agent" });
  if ((await ensureHookBin(c.env)) === "unavailable") out.warn("The coding.sh hook bin is missing and can't be written, so these runs won't be captured. Run `coding.sh init` first.");
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
  if (r.cancelled) out.warn(`${s.spec.name}: cancelled; the report covers the runs that finished`);
  const runs = latestPerSlot(r.results).runs;
  const report = suiteReport(s.spec.name, s.spec.purpose, trialsFromRuns(tasks, runs));
  const unverified = tasks.filter((t) => !t.referencePatch && !referenceRun(t)).map((t) => t.name);
  const failed = failedRuns(runs, captureRedactor(ctx.config, ctx.env));
  return { suite: s.spec.name, kind: "tasks", dir: s.dir, report, ...(failed.length ? { failedRuns: failed, names: new Map(tasks.map((t) => [t.id, t.name])) } : {}), experimentId: r.experimentId, harness: { id: bundle.id, name: bundle.name, files: Object.keys(bundle.files).length }, unverified };
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
  if (result.status === "cancelled") out.warn(`${s.spec.name}: cancelled; the report covers the runs that finished`);
  const report = suiteReport(s.spec.name, s.spec.purpose, trialsFromExperiment(cases, result), "case");
  return { suite: s.spec.name, kind: "cases", dir: s.dir, report, experimentId: result.id };
}

async function runTriggers(c: CommandContext, s: LoadedSuite, k: number): Promise<SuiteOutcome> {
  const specFile = resolve(s.dir, s.spec.triggers ?? "triggers.toml");
  const todo = (await readFile(specFile, "utf8").catch(() => "")).split("\n").filter((l) => !l.trimStart().startsWith("#") && l.includes(TODO)).length;
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
