// coding.sh compare <a> <b>: A/B two harness bundles on eval tasks
// (src/runner/experiment.ts), or re-analyse the stored runs of an experiment.
// `compare <a> --without <path>` derives B as A minus a skill, AGENTS.md or MCP config
// (or a plugin, `plugin:<name>`); `compare <a> --with plugin:<name|path>` derives B as A plus a Claude Code plugin.
// `--gate` adds a ship-or-hold decision and exits 1 unless it accepts; `--by
// <tag-prefix>` also gates each task group, and any group's "don't ship" blocks.
// `--promote` adds the Pareto promotion gate (quality or cost) and exits 1 unless it promotes.
// When B adds or removes exactly one rule, skill or context file, the report adds
// the one-item gate (`--item-gate` makes it decide the exit code, `--no-item-gate` hides it).
// `--repair N` gives each failed run up to N rounds of "Verification failed." in its own
// session (runner/repair.ts); the report adds the pass after repair per arm.
// `--pick N` and `--budget USD` choose the tasks that best tell harnesses apart from
// stored runs (runner/select.ts); `--sequential` carries HOME state from task to task
// (runner/sequence.ts); `--otel` gives each agent an OTLP endpoint tagged with its run.
import { getAdapter } from "../../adapters/index.ts";
import { defaultGateway, gatewayConfig, gatewaySettings, type GatewayConfig } from "../../integrations/gateway/config.ts";
import { GATEWAYS, resolveGatewayName, type GatewayId } from "../../integrations/gateway/providers.ts";
import { gatewayRoute, routableAgents, routeVia, ROUTABLE_AGENTS, ROUTABLE_GATEWAYS } from "../../integrations/gateway/route.ts";
import { ablateBundle, addPlugins, pluginRef, type Ablation } from "../../runner/bundle.ts";
import { claudeDirOf, resolvePlugin, storePlugin } from "../../runner/plugins.ts";
import { harnessItem } from "../../core/exposure.ts";
import { singleItemChange } from "../../runner/gate-item.ts";
import { bundleItemChange, harnessReport, tagPrefixProblem } from "../../runner/harness-report.ts";
import { git } from "../../runner/git.ts";
import { hasGlob } from "../../runner/glob.ts";
import { repairOptsProblem, type RepairOpts } from "../../runner/repair.ts";
import type { AgentRoute } from "../../runner/run.ts";
import { COST_SOURCES, estimateTaskCosts, fitBudget, rankTasks, TaskCostUnknown, type CostSource, type RankedTask, type TaskTier } from "../../runner/select.ts";
import { irtOrderTasks, type IrtTaskFields } from "../../stats/irt.ts";
import { carryRel } from "../../runner/sequence.ts";
import { captureRedactor, failedRuns, renderFailedRuns } from "../../runner/verifier-output.ts";
import type { EvalTask, HarnessBundle, RunResult } from "../../core/types.ts";
import { formatCompare, loadRunSessions, PARETO_NEEDS_COST, planCells, runExperiment, runKey, type BudgetReport } from "../../runner/experiment.ts";
import { formatSignalValidity, hasRepeatedAttempts, signalRows, signalValidity, type SignalRow } from "../../stats/validity.ts";
import { describeSelection, erroredRuns, latestPerSlot, sampleTasks, selectFailing, slotKey, type FailingMode, type Selection } from "../../runner/iterate.ts";
import { sortableId } from "../../core/ids.ts";
import { paint } from "../../experiments/text.ts";
import { jobConfig } from "../../jobs/config.ts";
import { parseAge, positiveInt, UsageError } from "../args.ts";
import { finishedToResume, finishJob, infraStopNote, openJob, resumeField, resumeNote, retryFlag, trialTimeout } from "../jobs.ts";
import { gateFlags, list, promoteFlags, requireConsent, resolveTask, str, withContext } from "../common.ts";
import { ensureHookBin } from "../hookbin.ts";
import { CliError, plural } from "../output.ts";
import type { CommandContext } from "../types.ts";
import type { Context } from "../../core/context.ts";

export async function run(c: CommandContext): Promise<number> {
  const { out } = c;
  // --parity compares two pages, not two harnesses: no store, no runs.
  if (c.flags.parity === true) return (await import("./compare-parity.ts")).run(c);
  if (c.flags["user-agent"] !== undefined) throw new UsageError("--user-agent needs --parity", { reason: "invalid_argument" });
  // Fail on a missing gateway key before touching the store or running anything.
  const gateway = c.flags.gateway === undefined || c.flags.gateway === false ? undefined : requireGateway(c.env, c.flags.gateway === true ? defaultGateway(c.env) : String(c.flags.gateway));
  // Before running anything: a typo in the gate flags must not cost a full A/B.
  const gate = gateFlags(c.flags);
  const promote = promoteFlags(c.flags);
  const gateBy = str(c.flags.by);
  if (c.flags.by !== undefined && !gate) throw new UsageError("--by needs --gate", { reason: "invalid_argument" });
  if (c.flags.by !== undefined && !gateBy) throw new UsageError("--by needs a tag prefix, e.g. --by suite:", { reason: "invalid_argument" });
  const reuseWhat = str(c.flags.reuse) ?? "none";
  if (!["none", "baseline", "both"].includes(reuseWhat)) throw new UsageError(`--reuse takes baseline, both or none, got ${JSON.stringify(reuseWhat)}`, { reason: "invalid_argument" });
  const reuseMaxAgeMs = c.flags["reuse-max-age"] === undefined ? undefined : parseAge(String(c.flags["reuse-max-age"]), "reuse-max-age");
  if (reuseMaxAgeMs !== undefined && reuseWhat === "none") throw new UsageError("--reuse-max-age needs --reuse baseline or --reuse both", { reason: "invalid_argument" });
  if (c.flags.experiment !== undefined && (reuseWhat !== "none" || c.flags["dry-run"] === true)) throw new UsageError("--reuse and --dry-run plan new runs; --experiment re-analyses stored ones", { reason: "invalid_argument" });
  // Iterating on a comparison (X-25): retry a stored one's errored runs, or pick the tasks of a new one.
  const retryErrors = c.flags["retry-errors"] === true;
  if (retryErrors && c.flags.experiment === undefined) throw new UsageError("--retry-errors needs --experiment <ID>: it runs again the runs of that comparison that errored", { reason: "invalid_argument" });
  const failingRef = str(c.flags.failing);
  if (c.flags.failing !== undefined && !failingRef) throw new UsageError("--failing needs an experiment id, e.g. --failing exp_01 or --failing exp_01@base", { reason: "invalid_argument" });
  const failingMode = (str(c.flags["failing-mode"]) ?? "any") as FailingMode;
  if (c.flags["failing-mode"] !== undefined && !failingRef) throw new UsageError("--failing-mode needs --failing", { reason: "invalid_argument" });
  const sampleN = positiveInt(c.flags.sample, "sample");
  const seedFlag = c.flags.seed;
  if (seedFlag !== undefined && (typeof seedFlag !== "number" || !Number.isInteger(seedFlag) || seedFlag < 0)) throw new UsageError(`--seed must be a whole number ≥ 0, got ${JSON.stringify(seedFlag)}`, { reason: "invalid_argument" });
  const repair = repairFlags(c, seedFlag as number | undefined);
  if (seedFlag !== undefined && sampleN === undefined && !repair?.falseAlarm) throw new UsageError("--seed needs --sample or --false-alarm", { reason: "invalid_argument" });
  if (repair && c.flags.experiment !== undefined && !retryErrors) throw new UsageError("--repair runs new runs; --experiment re-analyses stored ones (their repair rounds are reported as they are)", { reason: "invalid_argument" });
  if (c.flags.experiment !== undefined && (failingRef || sampleN !== undefined)) throw new UsageError("--failing and --sample pick tasks for new runs; --experiment re-analyses stored ones", { reason: "invalid_argument" });
  const pickN = positiveInt(c.flags.pick, "pick");
  const budgetUsd = usdFlag(c.flags.budget, "budget", false);
  const pickBy = (str(c.flags["pick-by"]) ?? "separation") as PickBy;
  if (c.flags["pick-by"] !== undefined && pickN === undefined && budgetUsd === undefined) throw new UsageError("--pick-by needs --pick or --budget", { reason: "invalid_argument" });
  const costPerRun = usdFlag(c.flags["cost-per-run"], "cost-per-run", true);
  if ((pickN !== undefined || budgetUsd !== undefined) && list(c.flags.task).length) throw new UsageError("--pick and --budget choose among the tasks; --task names them. Pass one or the other", { reason: "invalid_argument" });
  if (costPerRun !== undefined && budgetUsd === undefined) throw new UsageError("--cost-per-run needs --budget", { reason: "invalid_argument" });
  const sequential = c.flags.sequential === true;
  const carry = list(c.flags.carry);
  if (carry.length && !sequential) throw new UsageError("--carry needs --sequential", { reason: "invalid_argument" });
  for (const p of carry) {
    try {
      carryRel(p);
    } catch (e) {
      throw new UsageError(`--carry: ${(e as Error).message}`, { reason: "invalid_argument" });
    }
  }
  if (sequential && reuseWhat !== "none") throw new UsageError("--sequential runs each arm's tasks in order with carried state; --reuse would copy runs made without it", { reason: "invalid_argument" });
  const newRunOnly = [pickN !== undefined && "--pick", budgetUsd !== undefined && "--budget", sequential && "--sequential", c.flags.otel === true && "--otel", c.flags.isolation === false && "--no-isolation"].filter(Boolean);
  if (c.flags.experiment !== undefined && !retryErrors && newRunOnly.length) throw new UsageError(`${newRunOnly.join(" and ")} apply to new runs; --experiment re-analyses stored ones`, { reason: "invalid_argument" });
  return withContext(c, async (ctx) => {
    const without = list(c.flags.without);
    const withs = list(c.flags.with);
    if (without.length && withs.length) throw new UsageError("Pass --with or --without, not both: each derives the second arm from the first", { reason: "invalid_argument" });
    if (without.length && c.positionals.length > 1) throw new UsageError("--without derives the second arm from the first; pass one bundle", { reason: "invalid_argument" });
    if (withs.length && c.positionals.length > 1) throw new UsageError("--with derives the second arm from the first; pass one bundle", { reason: "invalid_argument" });
    const bad = withs.find((w) => !pluginRef(w));
    if (bad !== undefined) throw new UsageError(`--with takes a Claude Code plugin, plugin:<name|name@marketplace|dir>; got ${JSON.stringify(bad)}`, { reason: "invalid_argument" });
    if (!without.length && !withs.length && c.positionals.length < 2) throw new UsageError("Missing argument <B>. Usage: coding.sh compare <A> <B> (or <A> --without <PATH>, or <A> --with plugin:<NAME>)", { reason: "missing_argument" });
    const bundles: HarnessBundle[] = [];
    for (const ref of c.positionals.slice(0, 2)) {
      const b = await ctx.index.getBundle(ref);
      if (!b) throw new CliError(`Can't find harness bundle ${JSON.stringify(ref)}`, { reason: "not_found", next: ["List bundles:", "coding.sh harness list"] });
      bundles.push(b);
    }
    let ablation: Ablation | undefined;
    /** B derived from A (--without or --with), stored once it is about to run. */
    let derived: HarnessBundle | undefined;
    if (without.length) {
      try {
        ablation = ablateBundle(bundles[0] as HarnessBundle, without);
      } catch (e) {
        throw new UsageError(`--without: ${e instanceof Error ? e.message : String(e)}`, { reason: "invalid_argument" });
      }
      if (!ablation.paths.length) throw new UsageError("--without needs a path", { reason: "invalid_argument" });
      derived = ablation.bundle;
      bundles.push(ablation.bundle);
    }
    if (withs.length) {
      // Each plugin is resolved read-only (installed in the Claude config dir, or a dir) and stored whole.
      const A0 = bundles[0] as HarnessBundle;
      if (A0.agent !== "claude-code") throw new UsageError(`--with plugin: loads Claude Code plugins; bundle ${A0.name} runs ${A0.agent}`, { reason: "invalid_argument" });
      const added = [];
      for (const w of withs) {
        try {
          added.push(await storePlugin(await resolvePlugin(pluginRef(w) as string, { cwd: c.cwd, claudeDir: claudeDirOf(c.env), home: c.env.HOME || undefined }), ctx.blobs));
        } catch (e) {
          throw new CliError(`--with ${w}: ${e instanceof Error ? e.message : String(e)}`, { reason: "invalid_argument" });
        }
      }
      try {
        derived = addPlugins(A0, added);
      } catch (e) {
        throw new UsageError(`--with: ${e instanceof Error ? e.message : String(e)}`, { reason: "invalid_argument" });
      }
      bundles.push(derived);
    }
    const [A, B] = bundles as [HarnessBundle, HarnessBundle];
    if (A.id === B.id) throw new UsageError("Both arms are the same bundle; compare two different harnesses");
    // The one-item gate: B adds or removes exactly one instruction item.
    const itemFlag = c.flags["item-gate"];
    const change = itemFlag === false ? undefined : ablation ? withoutItem(ablation) : bundleItemChange(A, B);
    if (itemFlag === true && !change) {
      throw new UsageError("--item-gate needs B to add or remove exactly one rule, skill or context file and change nothing else", { reason: "invalid_argument" });
    }
    // How to name this comparison again (consent prompt, cancel hint).
    const arms = [...c.positionals.slice(0, 2), ...without.flatMap((p) => ["--without", p]), ...withs.flatMap((p) => ["--with", p])].join(" ");
    /** Store the derived arm once; a rerun finds it by its content id. */
    const storeAblation = async () => {
      if (!derived) return;
      for (const p of ablation?.unmatched ?? []) out.warn(`--without ${p}: not in bundle ${A.name}; it is only removed from each task's repo`);
      if (!(await ctx.index.getBundle(derived.id))) await ctx.index.putBundle(derived);
    };

    let experimentId = str(c.flags.experiment);
    let resume: { resume?: string } = {};
    let taskTags: Map<string, string[]> | undefined;
    let taskNames: Map<string, string> | undefined;
    let results: RunResult[];
    let budget: BudgetReport | undefined;
    let versionNote: string | undefined;
    const notes: string[] = [];
    let selection: Selection | undefined;
    let counts: { planned: number; skipped: number; retried?: number } | undefined;
    const concurrency = positiveInt(c.flags.concurrency, "concurrency");
    const timeoutMs = trialTimeout(c);
    if (experimentId) {
      const exp = experimentId;
      const storedRuns = async () => (await ctx.index.listRuns({ experimentId: exp })).filter((r) => r.bundleId === A.id || r.bundleId === B.id);
      results = await storedRuns();
      if (!results.length) throw new CliError(`Experiment ${experimentId} has no runs for these bundles`, { reason: "not_found" });
      const stored = (await Promise.all([...new Set(results.map((r) => r.taskId))].map((id) => ctx.index.getTask(id)))).filter((t): t is EvalTask => !!t);
      if (gateBy) taskTags = byTagPrefix(stored, gateBy);
      taskNames = new Map(stored.map((t) => [t.id, t.name]));
      await storeAblation();
      if (retryErrors) {
        // Run again, in place, each slot whose run errored; the old run is kept, marked superseded.
        const errored = erroredRuns(results);
        const byId = new Map(stored.map((t) => [t.id, t]));
        const gone = errored.find((r) => !byId.has(r.taskId));
        if (gone) throw new CliError(`Can't retry the errored runs of ${exp}: task ${gone.taskId} is no longer stored`, { reason: "not_found" });
        if (errored.length) {
          for (const b of bundles) if (!getAdapter(b.agent)?.run) throw new CliError(`Agent ${b.agent} has no headless driver, so bundle ${b.name} can't be run`, { reason: "unsupported_agent" });
          const replaces = new Map(errored.map((r) => [slotKey(r), r]));
          // Pass the original run's --gateway and --trial-timeout: the retry runs under what this command line says.
          const route = gateway ? gatewayRouteFor(bundles, gateway) : undefined;
          await requireConsent(c, `Run ${plural(errored.length, "agent session")} again (the runs of ${exp} that errored)?`, `coding.sh compare ${arms} --experiment ${exp} --retry-errors --yes`);
          if ((await ensureHookBin(c.env)) === "unavailable") out.warn("The coding.sh hook bin is missing and can't be written, so these runs won't be captured. Run `coding.sh init` first.");
          const spin = out.spin(`Retrying 0/${errored.length}…`);
          const r = await runExperiment({
            tasks: stored.filter((t) => errored.some((e) => e.taskId === t.id)),
            bundles: [A, B],
            adapterFor: (b) => getAdapter(b.agent)!,
            blobs: ctx.blobs,
            index: ctx.index,
            redactor: captureRedactor(ctx.config, ctx.env),
            k: Math.max(...errored.map((e) => e.attempt)),
            select: (j) => replaces.has(runKey(j)),
            replaces,
            experimentId: exp,
            ...(concurrency ? { concurrency } : {}),
            ...(route ? { route } : {}),
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            signal: c.signal,
            ingest: () => ctx.ingest(),
            ...(c.drain ? { drain: c.drain } : {}),
            retry: retryFlag(c),
            ...(repair ? { repair } : {}),
            onProgress: (p) => spin.update(`Retrying ${p.done}/${p.total}…`),
          }).finally(() => spin.stop());
          counts = { planned: r.planned, skipped: r.skipped, retried: r.retried ?? 0 };
          if (r.cancelled) {
            if (r.infraStop) {
              infraStopNote(c, r.infraStop);
              if (out.json) out.data({ outcome: "stopped", experimentId: exp, infraStop: r.infraStop, retried: r.retried ?? 0 });
              return 1;
            }
            out.warn(`Cancelled after retrying ${plural(r.retried ?? 0, "run")} of ${errored.length}; the rest keep their errored runs. Run the same command again to retry them.`);
            return 1;
          }
          await ctx.ingest().catch(() => undefined);
          results = await storedRuns();
          notes.push(`retried ${plural(r.retried ?? 0, "run")} that errored; the old runs are kept, marked superseded`);
        } else {
          counts = { planned: 0, skipped: 0, retried: 0 };
          if (!out.json) out.note(`No errored runs in ${exp}; nothing to retry`);
        }
      }
    } else {
      const ids = list(c.flags.task);
      const tag = str(c.flags.tag);
      if (ids.length && tag) throw new UsageError("Pass --task or --tag, not both", { reason: "invalid_argument" });
      let tasks: EvalTask[];
      if (ids.length) {
        tasks = [];
        for (const id of ids) {
          const t = await resolveTask(ctx, id);
          tasks.push(t);
        }
      } else if (tag) {
        // Hand-written behaviour tasks have no reference patch to validate, so a tag selects drafts too.
        tasks = (await ctx.index.listTasks({ tag })).filter((t) => t.status !== "archived");
        if (!tasks.length) throw new CliError(`No tasks tagged ${JSON.stringify(tag)}`, { reason: "no_tasks", next: ["List tasks and their tags:", "coding.sh eval list --json"] });
      } else if (!failingRef) tasks = await ctx.index.listTasks({ status: "validated" });
      else tasks = [];
      if (!tasks.length && !failingRef) throw new CliError("No validated tasks to run", { reason: "no_tasks", next: ["Draft and validate one first:", "coding.sh eval new latest"] });
      let from = tasks.length;
      let failing: Selection["failing"];
      if (failingRef) {
        // --failing EXP[@bundle]: the tasks that bundle (default A) failed in a stored comparison.
        const at = failingRef.indexOf("@");
        const expRef = at > 0 ? failingRef.slice(0, at) : failingRef;
        const fb = at > 0 ? await ctx.index.getBundle(failingRef.slice(at + 1)) : A;
        if (!fb) throw new CliError(`Can't find harness bundle ${JSON.stringify(failingRef.slice(at + 1))}`, { reason: "not_found", next: ["List bundles:", "coding.sh harness list"] });
        const prior = await ctx.index.listRuns({ experimentId: expRef });
        if (!prior.length) throw new CliError(`Experiment ${expRef} has no stored runs`, { reason: "not_found" });
        const ran = [...new Set(prior.map((r) => r.bundleId))];
        if (!ran.includes(fb.id)) {
          const names = await Promise.all(ran.map(async (id) => (await ctx.index.getBundle(id))?.name ?? id));
          throw new UsageError(`${expRef} has no runs of ${fb.name}; it ran ${names.join(" and ")}. Name the arm: --failing ${expRef}@<bundle>`, { reason: "bundle_mismatch" });
        }
        const failed = selectFailing(prior, fb.id, failingMode);
        if (ids.length || tag) {
          const set = new Set(failed);
          tasks = tasks.filter((t) => set.has(t.id));
        } else {
          from = new Set(prior.filter((r) => r.bundleId === fb.id).map((r) => r.taskId)).size;
          tasks = (await Promise.all(failed.map((id) => ctx.index.getTask(id)))).filter((t): t is EvalTask => !!t && t.status !== "archived");
        }
        if (!tasks.length) throw new CliError(`${fb.name} failed none of ${ids.length || tag ? "the selected tasks" : "its tasks"} in ${expRef}${failingMode === "majority" ? " in most attempts" : ""}`, { reason: "no_tasks" });
        failing = { experimentId: expRef, bundleId: fb.id, bundle: fb.name, mode: failingMode, matched: tasks.length };
      }
      let sample: Selection["sample"];
      if (sampleN !== undefined) {
        // Recorded in the note, so the same sample can be drawn again (and resumed) with --seed.
        const seed = (seedFlag as number | undefined) ?? Math.floor(Math.random() * 2 ** 32);
        tasks = sampleTasks(tasks, sampleN, seed);
        sample = { n: sampleN, seed };
      }
      if (failing || sample) {
        selection = describeSelection({ from, tasks, ...(failing ? { failing } : {}), ...(sample ? { sample } : {}) });
        notes.push(selection.note);
      }
      let pick: PickReport | undefined;
      if (pickN !== undefined || budgetUsd !== undefined) {
        pick = await pickTasks(ctx, tasks, A, { pick: pickN, budget: budgetUsd, costPerRun, k: positiveInt(c.flags.k, "k") ?? 1, by: pickBy });
        const order = new Map(pick.tasks.map((t, i) => [t.taskId, i]));
        const chosen = new Set(pick.picked);
        tasks = tasks.filter((t) => chosen.has(t.id)).sort((a, b) => (order.get(a.id) as number) - (order.get(b.id) as number));
        if (!tasks.length) throw new CliError(`--budget $${budgetUsd?.toFixed(2)} fits no task: the cheapest costs $${Math.min(...pick.tasks.map((t) => t.costUsd ?? Infinity)).toFixed(2)} a run, times 2 arms x ${positiveInt(c.flags.k, "k") ?? 1}`, { reason: "budget_too_small" });
        notes.push(pick.note);
      }
      const maxCost = c.flags["max-cost"];
      if (maxCost !== undefined && (typeof maxCost !== "number" || !(maxCost > 0))) throw new UsageError("--max-cost needs a positive amount in USD, e.g. --max-cost 15", { reason: "invalid_argument" });
      // --budget is also the spend cap, unless --max-cost names another.
      const capUsd = typeof maxCost === "number" ? maxCost : budgetUsd;
      if (gateBy) taskTags = byTagPrefix(tasks, gateBy);
      taskNames = new Map(tasks.map((t) => [t.id, t.name]));
      if (ablation && !ablation.dropped.length && !(await anyInTaskRepo(tasks, ablation.unmatched, c.env))) {
        throw new UsageError(`nothing to ablate: ${ablation.unmatched.join(", ")} is in neither bundle ${A.name} nor any selected task's repo`, { reason: "nothing_to_ablate" });
      }
      for (const b of bundles) if (!getAdapter(b.agent)?.run) throw new CliError(`Agent ${b.agent} has no headless driver, so bundle ${b.name} can't be run`, { reason: "unsupported_agent" });
      const route = gateway ? gatewayRouteFor(bundles, gateway) : undefined;
      const k = positiveInt(c.flags.k, "k") ?? 1;
      const runs = tasks.length * 2 * k;
      // Finished runs of the same cell (task, bundle, agent version, attempt, timeout, route) from earlier comparisons.
      const reuse = reuseWhat === "none" ? undefined : { bundleIds: reuseWhat === "both" ? [A.id, B.id] : [A.id], ...(reuseMaxAgeMs !== undefined ? { maxAgeMs: reuseMaxAgeMs } : {}) };
      const versions = new Map<string, Promise<string | undefined>>();
      const agentVersion = (b: HarnessBundle) => {
        if (!versions.has(b.agent)) versions.set(b.agent, getAdapter(b.agent)!.detect().then((d) => d.version).catch(() => undefined));
        return versions.get(b.agent)!;
      };
      const cellOpts = { tasks, bundles: [A, B], adapterFor: (b: HarnessBundle) => getAdapter(b.agent)!, index: ctx.index, k, agentVersion, ...(route ? { route } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}), ...(reuse ? { reuse } : {}), ...(repair ? { repair } : {}) };
      // Only reuse needs the cells (and the agent versions behind them): a plain dry run calls no adapter.
      const plan = reuse ? await planCells(cellOpts) : undefined;
      const cachedIn = (b: HarnessBundle) => [...(plan?.cached.keys() ?? [])].filter((i) => plan!.jobs[i]!.bundle.id === b.id).length;
      const cached = plan?.cached.size ?? 0;
      if (c.flags["dry-run"] === true) {
        const arm = (b: HarnessBundle) => ({ bundle: b.id, name: b.name, reused: cachedIn(b), toRun: runs / 2 - cachedIn(b) });
        if (out.json) out.data({ dryRun: true, runs, toRun: runs - cached, baseline: arm(A), candidate: arm(B), ...(plan?.unknownVersion.length ? { unknownVersion: plan.unknownVersion } : {}), ...(selection || pick ? { tasks: tasks.map((t) => t.id) } : {}), ...(selection ? { selection } : {}), ...(pick ? { pick: pickJson(pick) } : {}) });
        else {
          if (selection) out.print(selection.note);
          if (pick) out.print(formatPick(pick, taskNames));
          out.print(`dry run: ${plural(runs, "run")} (${plural(tasks.length, "task")} x 2 arms x ${k}), ${cached} reused, ${runs - cached} to run`);
          const w = Math.max(A.name.length, B.name.length);
          for (const [label, b] of [["baseline ", A], ["candidate", B]] as const) out.print(`${label}  ${b.name.padEnd(w)}  ${cachedIn(b)} reused, ${runs / 2 - cachedIn(b)} to run`);
          if (plan?.unknownVersion.length) out.warn(`agent version unknown for ${plan.unknownVersion.join(", ")}: a reused run may come from another version of the agent`);
        }
        return 0;
      }
      // Durable: each finished run is checkpointed; --resume continues an interrupted comparison.
      // Gateway routing changes what runs (model, flags); its env values (keys) stay out of the hash.
      const routed = route ? [A, B].map((b) => route(b)).map((x) => (x ? { flags: x.flags, model: x.model, env: Object.keys(x.env).sort() } : null)) : undefined;
      const config = jobConfig({ bundles: [A.id, B.id], tasks, k, timeoutMs, route: routed, repair });
      // The prompt counts only the runs still to go: not the reused ones, nor those a resumed job already finished.
      const finished = await finishedToResume(c, "compare", config);
      const extra = [cached ? `${cached} reused` : "", finished ? `${finished} already finished` : ""].filter(Boolean).join(", ");
      const rounds = repair ? `, plus up to ${plural(repair.rounds, "repair round")} per failed run` : "";
      const dollars = pick?.estimateUsd !== undefined ? `, about $${pick.estimateUsd.toFixed(2)}` : "";
      await requireConsent(c, `Run ${plural(Math.max(0, runs - cached - finished), "agent session")} (${plural(tasks.length, "task")} x 2 arms x ${k}${extra ? `, ${extra}` : ""}${rounds}${dollars})?`, `coding.sh compare ${arms} --yes`);
      await storeAblation();
      const job = await openJob(c, { kind: "compare", name: `${A.name} vs ${B.name}`, config, newId: () => sortableId("exp_"), concurrency: concurrency ?? 4 });
      // The isolated agent configs call the hook bin; without it no run is captured (no turns, tokens, divergence or item gate).
      if ((await ensureHookBin(c.env)) === "unavailable") out.warn("The coding.sh hook bin is missing and can't be written, so these runs won't be captured: turns, tokens, trace divergence and the item gate need captured sessions. Run `coding.sh init` first.");
      const spin = out.spin(`Running 0/${runs}…`);
      const r = await job
        .guard(() =>
          runExperiment({
            tasks,
            bundles: [A, B],
            adapterFor: (b) => getAdapter(b.agent)!,
            blobs: ctx.blobs,
            index: ctx.index,
            redactor: captureRedactor(ctx.config, ctx.env),
            k,
            ...(concurrency ? { concurrency } : {}),
            ...(route ? { route } : {}),
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            ...(capUsd !== undefined ? { maxCostUsd: capUsd } : {}),
            ...(sequential ? { sequence: { carry: carry.length ? carry : ["~"] } } : {}),
            ...(c.flags.otel === true ? { otel: true } : {}),
            ...(c.flags.isolation === false ? { isolation: false } : {}),
            signal: c.signal,
            // Each run's hooks are ingested before its dir (and the agent's transcript in it) is removed.
            ingest: () => ctx.ingest(),
            ...(c.drain ? { drain: c.drain } : {}),
            job: job.scope(),
            retry: retryFlag(c),
            ...(repair ? { repair } : {}),
            experimentId: job.id,
            agentVersion,
            ...(reuse ? { reuse } : {}),
            onProgress: (p) => spin.update(`Running ${p.done}/${p.total}…`),
          }),
        )
        .finally(() => spin.stop());
      await finishJob(job, r.cancelled, r.infraStop);
      experimentId = r.experimentId;
      results = r.results;
      budget = r.budget;
      counts = { planned: r.planned, skipped: r.skipped };
      if (r.reuse?.reused && r.reuse.unknownVersion.length) versionNote = `agent version unknown for ${r.reuse.unknownVersion.join(", ")}: a reused run may come from another version of the agent`;
      if (budget) {
        const b = budget;
        const line = `spent $${b.spentUsd.toFixed(2)} of the $${b.capUsd.toFixed(2)} cap${b.unpriced ? `; ${plural(b.unpriced, "run")} reported no cost and count as $0` : ""}`;
        if (b.skipped) out.warn(`Stopped at the spend cap: ${line}; ${plural(b.skipped, "run")} not started. The comparison covers the runs that finished.`);
        else if (!out.json) out.note(line);
      }
      if (r.cancelled) {
        // A partial A/B is not a comparison; main.ts exits 130 (143 for SIGTERM).
        const finished = job.lines.size;
        if (out.json) out.data({ outcome: r.infraStop ? "stopped" : "cancelled", experimentId, finished, total: runs, infraStop: r.infraStop, ...resumeField(job) });
        else if (r.infraStop) {
          infraStopNote(c, r.infraStop);
          resumeNote(c, job);
        } else {
          out.warn(`Cancelled after ${finished}/${runs} runs; no comparison yet. Analyse the stored runs: coding.sh compare ${arms} --experiment ${experimentId}`);
          resumeNote(c, job);
        }
        return 1;
      }
      if (!out.json) resumeNote(c, job);
      resume = resumeField(job);
      // Pull in the sessions the runs' hooks captured.
      await ctx.ingest().catch(() => undefined);
    }
    // One run per task, arm and attempt: when a slot holds several that count, the newest wins.
    const slots = latestPerSlot(results);
    if (slots.dropped.length) {
      results = slots.runs;
      notes.push(`${plural(slots.dropped.length, "older run")} left out: a newer run fills the same task, arm and attempt`);
    }
    const report = await harnessReport(ctx, A, B, results, {
      ...(ablation ? { ablation: { paths: ablation.paths, dropped: ablation.dropped, unmatched: ablation.unmatched } } : {}),
      ...(gate ? { gate } : {}),
      ...(gateBy ? { gateBy, taskTags } : {}),
      ...(promote ? { pareto: promote } : {}),
      ...(change ? { change } : {}),
      ...(c.flags.audited === true ? { audited: true } : {}),
      ...(c.flags["repair-verdict"] === true ? { repairVerdict: true } : {}),
    });
    if (versionNote) report.notes.push(versionNote);
    report.notes.push(...notes);
    // --signals (Z-11): does each trace signal predict failure beyond task difficulty?
    let signalRowsList: SignalRow[] | undefined;
    if (c.flags.signals === true) {
      signalRowsList = signalRows(results, await loadRunSessions(ctx.index, results));
      report.signals = signalValidity(signalRowsList);
    }
    // Each failed run with the end of what its verifier printed (and its agent, when that failed), so a failure reads without a rerun.
    const failedList = failedRuns(results, captureRedactor(ctx.config, ctx.env));
    if (out.json) out.data({ experimentId, report, ...(failedList.length ? { failedRuns: failedList } : {}), ...resume, ...(budget ? { budget } : {}), ...(counts ?? {}), ...(selection ? { selection } : {}) });
    else {
      out.print(formatCompare(report, { color: out.color, arms, taskNames }));
      if (report.signals && signalRowsList) out.print(["", formatSignalValidity(report.signals, { repeated: hasRepeatedAttempts(signalRowsList) })].join("\n"));
      const block = renderFailedRuns(failedList, {
        names: (id) => taskNames?.get(id) ?? id,
        arm: (id) => (id === A.id ? `A ${A.name}` : id === B.id ? `B ${B.name}` : id),
        dim: (s) => paint(s, "dim", out.color),
      });
      if (block.length) out.print(["", ...block].join("\n"));
      out.print(experimentId);
    }
    if (promote && !report.pareto) out.warn(`--promote: ${PARETO_NEEDS_COST}, so nothing is promoted`);
    if (report.pareto?.refused === "release_confound") out.warn("--promote refused (release_confound): baseline and candidate ran on different agent releases, so nothing is promoted");
    // Each requested gate must pass for exit 0: --gate accepts (ship B, or with
    // --without drop the component), --promote promotes, --item-gate keeps or accepts.
    const itemOk = report.itemGate?.verdict === "KEEP" || report.itemGate?.verdict === "ACCEPT";
    const failed = (report.gate && report.gate.decision !== "accept") || (promote && !report.pareto?.promote) || (itemFlag === true && !itemOk);
    return failed ? 1 : 0;
  });
}

/** A dollar flag: a finite amount above 0 (or at least 0 when `zero` is allowed). */
function usdFlag(v: unknown, name: string, zero: boolean): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || (!zero && v === 0)) throw new UsageError(`--${name} needs ${zero ? "an amount" : "a positive amount"} in USD, e.g. --${name} ${zero ? "0.5" : "10"}`, { reason: "invalid_argument" });
  return v;
}

interface PickReport {
  /** Tasks considered, in rank order, with their tier and estimated cost per run. */
  tasks: { taskId: string; tier: TaskTier; q?: number; p: number; configs: number; runs: number; costUsd?: number; costSource?: CostSource; picked: boolean; difficulty?: number; discrimination?: number; information?: number }[];
  picked: string[];
  pick?: number;
  budgetUsd?: number;
  /** Estimated agent cost of the picked tasks: 2 arms x k x cost per run. */
  estimateUsd?: number;
  k: number;
  note: string;
}

/**
 * `--pick N` / `--budget USD`: rank the tasks by how well stored runs say they
 * tell harnesses apart (runner/select.ts), keep the first N, then fit the
 * budget greedily. A budget with no cost known from any source is a CliError.
 */
async function pickTasks(ctx: Context, tasks: readonly EvalTask[], baseline: HarnessBundle, o: { pick?: number; budget?: number; costPerRun?: number; k: number; by?: PickBy }): Promise<PickReport> {
  const history = (await Promise.all(tasks.map((t) => ctx.index.listRuns({ taskId: t.id })))).flat();
  let ranked: IrtRanked[] = rankTasks(
    tasks.map((t) => t.id),
    history,
  );
  // --pick-by irt (EM-12): item information at the baseline's ability from an IRT fit of the stored runs.
  const irt = o.by === "irt" ? irtOrderTasks(ranked, history, { target: baseline.id }) : undefined;
  if (irt) ranked = irt.tasks;
  const sessionCost = new Map<string, number>();
  for (const t of tasks) {
    if (!t.sourceSessionId) continue;
    const c = (await ctx.index.getSession(t.sourceSessionId).catch(() => undefined))?.stats.usage?.costUsd;
    if (typeof c === "number") sessionCost.set(t.id, c);
  }
  let costs: ReturnType<typeof estimateTaskCosts> | undefined;
  try {
    costs = estimateTaskCosts(tasks, history, { baselineId: baseline.id, sessionCost: (t) => sessionCost.get(t.id), ...(o.costPerRun !== undefined ? { flag: o.costPerRun } : {}) });
  } catch (e) {
    if (!(e instanceof TaskCostUnknown)) throw e;
    if (o.budget !== undefined) {
      throw new CliError(`--budget needs a cost per run, and none is known: ${e.message} (no stored run, source session or other task to estimate from)`, {
        reason: "cost_unknown",
        next: ["Say what one run costs:", `--cost-per-run <USD>`],
      });
    }
  }
  let order = ranked.map((r) => r.taskId);
  if (o.pick !== undefined) order = order.slice(0, o.pick);
  const picked = o.budget !== undefined && costs ? fitBudget(order, costs, { budget: o.budget, arms: 2, k: o.k }).picked : order;
  const chosen = new Set(picked);
  const estimateUsd = costs ? picked.reduce((a, id) => a + 2 * o.k * (costs.get(id)?.usd ?? 0), 0) : undefined;
  const informative = ranked.filter((r) => r.tier === "ranked" && (r.q as number) >= 0.5 && chosen.has(r.taskId)).length;
  const saturated = ranked.filter((r) => r.tier === "saturated" && chosen.has(r.taskId)).length;
  const how = [o.pick !== undefined ? `the first ${o.pick}` : "", o.budget !== undefined ? `what fits $${o.budget.toFixed(2)}` : ""].filter(Boolean).join(" then ");
  const note =
    `picked ${picked.length} of ${tasks.length} tasks (${how}), most informative first from ${plural(history.length, "stored run")}: ` +
    (irt?.fitted ? irt.note : `${informative} informative (q >= 0.5)`) +
    `${saturated ? `, ${saturated} saturated` : ""}${estimateUsd !== undefined ? `; about $${estimateUsd.toFixed(2)} of agent spend` : ""}` +
    (irt && !irt.fitted ? `; ${irt.note}` : "");
  return {
    tasks: ranked.map((r) => {
      const c = costs?.get(r.taskId);
      return { ...r, ...(c ? { costUsd: c.usd, costSource: c.source } : {}), picked: chosen.has(r.taskId) };
    }),
    picked,
    ...(o.pick !== undefined ? { pick: o.pick } : {}),
    ...(o.budget !== undefined ? { budgetUsd: o.budget } : {}),
    ...(estimateUsd !== undefined ? { estimateUsd } : {}),
    k: o.k,
    note,
  };
}

type PickBy = "separation" | "irt";
type IrtRanked = RankedTask & IrtTaskFields;

/** The pick for --json: NaN rates as null, and where costs come from, first to last. */
function pickJson(p: PickReport) {
  return {
    ...p,
    tasks: p.tasks.map((t) => ({ ...t, p: Number.isFinite(t.p) ? t.p : null })),
    costSources: COST_SOURCES,
  };
}

function formatPick(p: PickReport, names?: Map<string, string>): string {
  // --pick-by irt adds each task's fitted difficulty and information.
  const irt = p.tasks.some((t) => t.information !== undefined);
  const irtCells = (t: PickReport["tasks"][number]) => (irt ? [t.difficulty !== undefined ? t.difficulty.toFixed(2) : "", t.information !== undefined ? t.information.toFixed(3) : ""] : []);
  const rows = p.tasks.map((t) => [t.picked ? "+" : " ", names?.get(t.taskId) ?? t.taskId, t.tier, t.q !== undefined ? t.q.toFixed(2) : "", ...irtCells(t), Number.isFinite(t.p) ? `${Math.round(t.p * 100)}%` : "", t.costUsd !== undefined ? `$${t.costUsd.toFixed(3)} (${t.costSource})` : "—"]);
  const head = ["", "task", "tier", "q", ...(irt ? ["difficulty", "info"] : []), "pass", "cost / run"];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] as string).length)));
  const line = (r: string[]) => r.map((x, i) => x.padEnd(w[i] as number)).join("  ").trimEnd();
  return [p.note, line(head), ...rows.map(line), `cost sources, first to last: ${COST_SOURCES.join(", ")}`].join("\n");
}

/** `--repair N [--repair-signal bit|names] [--false-alarm P] [--seed S]`, checked before anything runs. */
function repairFlags(c: CommandContext, seed: number | undefined): RepairOpts | undefined {
  const f = c.flags;
  if (f.repair === undefined) {
    for (const k of ["repair-signal", "false-alarm"]) if (f[k] !== undefined) throw new UsageError(`--${k} needs --repair <N>`, { reason: "invalid_argument" });
    return undefined;
  }
  const o: RepairOpts = { rounds: typeof f.repair === "number" ? f.repair : NaN, signal: (str(f["repair-signal"]) ?? "bit") as RepairOpts["signal"] };
  if (f["false-alarm"] !== undefined) o.falseAlarm = typeof f["false-alarm"] === "number" ? f["false-alarm"] : NaN;
  if (seed !== undefined) o.seed = seed;
  const problem = repairOptsProblem(o);
  if (problem) throw new UsageError(problem, { reason: "invalid_argument" });
  return o;
}

/**
 * Task tags by id for `--by <prefix>`. A prefix no task's tags start with is a
 * usage error that lists the prefixes the tasks do have (before any run).
 */
function byTagPrefix(tasks: readonly EvalTask[], prefix: string): Map<string, string[]> {
  const problem = tagPrefixProblem(tasks, prefix);
  if (problem) throw new UsageError(`--by ${prefix}: ${problem}`, { reason: "invalid_argument" });
  return new Map(tasks.map((t) => [t.id, t.tags]));
}

/** The one item `--without` drops: one rule or skill from the bundle, or one context file only in the task repos. */
function withoutItem(ab: Ablation): { mode: "remove"; path: string } | undefined {
  // A plugin is many items (skills, hooks, agents); the one-item gate doesn't read it.
  if (ab.plugins.length) return undefined;
  if (ab.dropped.length) {
    if (ab.unmatched.length) return undefined;
    const c = singleItemChange({ added: [], removed: ab.dropped }, false);
    return c ? { mode: "remove", path: c.path } : undefined;
  }
  const only = ab.unmatched.length === 1 ? (ab.unmatched[0] as string) : undefined;
  return only && harnessItem(only, "")?.kind === "context" ? { mode: "remove", path: only } : undefined;
}

/**
 * True when some task's start snapshot holds one of `paths` (repo-relative; a
 * glob uses git's glob pathspec). `~/` paths never live in a task repo. A
 * snapshot that can't be read counts as a hit: never refuse on a guess.
 */
async function anyInTaskRepo(tasks: readonly EvalTask[], paths: readonly string[], env: NodeJS.ProcessEnv): Promise<boolean> {
  const specs = paths.filter((p) => !p.startsWith("~/")).map((p) => (hasGlob(p) ? `:(glob)${p}` : p));
  if (!specs.length) return false;
  const { shadowRepoPath } = await import("../../core/snapshot.ts");
  for (const t of tasks) {
    const rev = t.start.snapshot || t.start.head;
    const r = await git([`--git-dir=${shadowRepoPath(t.start.repoRoot, env)}`, "ls-tree", "-r", "--name-only", rev, "--", ...specs], t.start.repoRoot).catch(() => undefined);
    if (!r || r.exitCode !== 0 || r.stdoutTail.trim()) return true;
  }
  return false;
}

/**
 * `--gateway [name]`: the gateway's settings, with its key. Vercel's key comes
 * from AI_GATEWAY_API_KEY (or [gateway] in config); the others from their
 * standard env var or [gateway.<name>].
 */
function requireGateway(env: NodeJS.ProcessEnv, name: string): GatewayConfig {
  const id: GatewayId | undefined = resolveGatewayName(name);
  if (!id || !ROUTABLE_GATEWAYS.includes(id)) {
    throw new UsageError(`--gateway can route through ${ROUTABLE_GATEWAYS.join(", ")}; got ${JSON.stringify(name)}`, { reason: "unsupported_gateway" });
  }
  if (id === "vercel") {
    const g = gatewaySettings(env);
    if (!g.apiKey) throw new CliError(`--gateway needs an AI Gateway key in $${g.apiKeyEnv}`, { reason: "missing_key", next: ["Create one at vercel.com/ai-gateway, then:", `export ${g.apiKeyEnv}=...`] });
    return gatewayConfig("vercel", env);
  }
  const c = gatewayConfig(id, env);
  if (!c.apiKey) throw new CliError(`--gateway ${id} needs a key in $${c.apiKeyEnv} (${GATEWAYS[id].name})`, { reason: "missing_key", next: [`export ${c.apiKeyEnv}=...`] });
  return c;
}

/** Runs both arms through the gateway, each with its bundle's model. */
function gatewayRouteFor(bundles: HarnessBundle[], c: GatewayConfig): AgentRoute {
  const agents = c.id === "vercel" ? [...ROUTABLE_AGENTS] : routableAgents(c.id);
  for (const b of bundles) {
    if (!agents.includes(b.agent)) throw new CliError(`--gateway${c.id === "vercel" ? "" : ` ${c.id}`} can't route ${b.agent} (bundle ${b.name}); supported: ${agents.join(", ")}`, { reason: "unsupported_agent" });
  }
  if (c.id === "vercel") {
    const key = c.apiKey!;
    return (b) => gatewayRoute(b.agent, b.model, key);
  }
  return (b) => routeVia(c, b.agent, b.model);
}
