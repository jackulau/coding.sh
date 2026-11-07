// coding.sh compare <a> <b>: A/B two harness bundles on eval tasks
// (src/runner/experiment.ts), or re-analyse the stored runs of an experiment.
// `compare <a> --without <path>` derives B as A minus a skill, AGENTS.md or MCP config.
// `--gate` adds a ship-or-hold decision and exits 1 unless it accepts; `--by
// <tag-prefix>` also gates each task group, and any group's "don't ship" blocks.
// `--promote` adds the Pareto promotion gate (quality or cost) and exits 1 unless it promotes.
// When B adds or removes exactly one rule, skill or context file, the report adds
// the one-item gate (`--item-gate` makes it decide the exit code, `--no-item-gate` hides it).
import { getAdapter } from "../../adapters/index.ts";
import { defaultGateway, gatewayConfig, gatewaySettings, type GatewayConfig } from "../../integrations/gateway/config.ts";
import { GATEWAYS, resolveGatewayName, type GatewayId } from "../../integrations/gateway/providers.ts";
import { gatewayRoute, routableAgents, routeVia, ROUTABLE_AGENTS, ROUTABLE_GATEWAYS } from "../../integrations/gateway/route.ts";
import { ablateBundle, type Ablation } from "../../runner/bundle.ts";
import { harnessItem } from "../../core/exposure.ts";
import { singleItemChange } from "../../runner/gate-item.ts";
import { bundleItemChange, harnessReport, tagPrefixProblem } from "../../runner/harness-report.ts";
import { git } from "../../runner/git.ts";
import { hasGlob } from "../../runner/glob.ts";
import type { AgentRoute } from "../../runner/run.ts";
import type { EvalTask, HarnessBundle, RunResult } from "../../core/types.ts";
import { formatCompare, PARETO_NEEDS_COST, runExperiment } from "../../runner/experiment.ts";
import { sortableId } from "../../core/ids.ts";
import { jobConfig } from "../../jobs/config.ts";
import { positiveInt, UsageError } from "../args.ts";
import { finishJob, openJob, resumeField, resumeNote, retryFlag, trialTimeout } from "../jobs.ts";
import { gateFlags, list, promoteFlags, requireConsent, resolveTask, str, withContext } from "../common.ts";
import { CliError, plural } from "../output.ts";
import type { CommandContext } from "../types.ts";

export async function run(c: CommandContext): Promise<number> {
  const { out } = c;
  // Fail on a missing gateway key before touching the store or running anything.
  const gateway = c.flags.gateway === undefined || c.flags.gateway === false ? undefined : requireGateway(c.env, c.flags.gateway === true ? defaultGateway(c.env) : String(c.flags.gateway));
  // Before running anything: a typo in the gate flags must not cost a full A/B.
  const gate = gateFlags(c.flags);
  const promote = promoteFlags(c.flags);
  const gateBy = str(c.flags.by);
  if (c.flags.by !== undefined && !gate) throw new UsageError("--by needs --gate", { reason: "invalid_argument" });
  if (c.flags.by !== undefined && !gateBy) throw new UsageError("--by needs a tag prefix, e.g. --by suite:", { reason: "invalid_argument" });
  return withContext(c, async (ctx) => {
    const without = list(c.flags.without);
    if (without.length && c.positionals.length > 1) throw new UsageError("--without derives the second arm from the first; pass one bundle", { reason: "invalid_argument" });
    if (!without.length && c.positionals.length < 2) throw new UsageError("Missing argument <B>. Usage: coding.sh compare <A> <B> (or <A> --without <PATH>)", { reason: "missing_argument" });
    const bundles: HarnessBundle[] = [];
    for (const ref of c.positionals.slice(0, 2)) {
      const b = await ctx.index.getBundle(ref);
      if (!b) throw new CliError(`Can't find harness bundle ${JSON.stringify(ref)}`, { reason: "not_found", next: ["List bundles:", "coding.sh harness list"] });
      bundles.push(b);
    }
    let ablation: Ablation | undefined;
    if (without.length) {
      ablation = ablateBundle(bundles[0] as HarnessBundle, without);
      if (!ablation.paths.length) throw new UsageError("--without needs a path", { reason: "invalid_argument" });
      bundles.push(ablation.bundle);
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
    const arms = [...c.positionals.slice(0, 2), ...without.flatMap((p) => ["--without", p])].join(" ");
    /** Store the derived arm once; a rerun finds it by its content id. */
    const storeAblation = async () => {
      if (!ablation) return;
      for (const p of ablation.unmatched) out.warn(`--without ${p}: not in bundle ${A.name}; it is only removed from each task's repo`);
      if (!(await ctx.index.getBundle(ablation.bundle.id))) await ctx.index.putBundle(ablation.bundle);
    };

    let experimentId = str(c.flags.experiment);
    let resume: { resume?: string } = {};
    let taskTags: Map<string, string[]> | undefined;
    let results: RunResult[];
    if (experimentId) {
      results = (await ctx.index.listRuns({ experimentId })).filter((r) => r.bundleId === A.id || r.bundleId === B.id);
      if (!results.length) throw new CliError(`Experiment ${experimentId} has no runs for these bundles`, { reason: "not_found" });
      if (gateBy) {
        const stored = await Promise.all([...new Set(results.map((r) => r.taskId))].map((id) => ctx.index.getTask(id)));
        taskTags = byTagPrefix(stored.filter((t): t is EvalTask => !!t), gateBy);
      }
      await storeAblation();
    } else {
      const ids = list(c.flags.task);
      let tasks: EvalTask[];
      if (ids.length) {
        tasks = [];
        for (const id of ids) {
          const t = await resolveTask(ctx, id);
          tasks.push(t);
        }
      } else tasks = await ctx.index.listTasks({ status: "validated" });
      if (!tasks.length) throw new CliError("No validated tasks to run", { reason: "no_tasks", next: ["Draft and validate one first:", "coding.sh eval new latest"] });
      if (gateBy) taskTags = byTagPrefix(tasks, gateBy);
      if (ablation && !ablation.dropped.length && !(await anyInTaskRepo(tasks, ablation.unmatched, c.env))) {
        throw new UsageError(`nothing to ablate: ${ablation.unmatched.join(", ")} is in neither bundle ${A.name} nor any selected task's repo`, { reason: "nothing_to_ablate" });
      }
      for (const b of bundles) if (!getAdapter(b.agent)?.run) throw new CliError(`Agent ${b.agent} has no headless driver, so bundle ${b.name} can't be run`, { reason: "unsupported_agent" });
      const route = gateway ? gatewayRouteFor(bundles, gateway) : undefined;
      const k = positiveInt(c.flags.k, "k") ?? 1;
      const runs = tasks.length * 2 * k;
      await requireConsent(c, `Run ${plural(runs, "agent session")} (${plural(tasks.length, "task")} x 2 arms x ${k})?`, `coding.sh compare ${arms} --yes`);
      await storeAblation();
      const concurrency = positiveInt(c.flags.concurrency, "concurrency");
      const timeoutMs = trialTimeout(c);
      // Durable: each finished run is checkpointed; --resume continues an interrupted comparison.
      // Gateway routing changes what runs (model, flags); its env values (keys) stay out of the hash.
      const routed = route ? [A, B].map((b) => route(b)).map((x) => (x ? { flags: x.flags, model: x.model, env: Object.keys(x.env).sort() } : null)) : undefined;
      const config = jobConfig({ bundles: [A.id, B.id], tasks, k, timeoutMs, route: routed });
      const job = await openJob(c, { kind: "compare", name: `${A.name} vs ${B.name}`, config, newId: () => sortableId("exp_"), concurrency: concurrency ?? 4 });
      const spin = out.spin(`Running 0/${runs}…`);
      const r = await job
        .guard(() =>
          runExperiment({
            tasks,
            bundles: [A, B],
            adapterFor: (b) => getAdapter(b.agent)!,
            blobs: ctx.blobs,
            index: ctx.index,
            k,
            ...(concurrency ? { concurrency } : {}),
            ...(route ? { route } : {}),
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            signal: c.signal,
            ...(c.drain ? { drain: c.drain } : {}),
            job: job.scope(),
            retry: retryFlag(c),
            experimentId: job.id,
            onProgress: (p) => spin.update(`Running ${p.done}/${p.total}…`),
          }),
        )
        .finally(() => spin.stop());
      await finishJob(job, r.cancelled);
      experimentId = r.experimentId;
      results = r.results;
      if (r.cancelled) {
        // A partial A/B is not a comparison; main.ts exits 130 (143 for SIGTERM).
        const finished = job.lines.size;
        if (out.json) out.data({ outcome: "cancelled", experimentId, finished, total: runs, ...resumeField(job) });
        else {
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
    const report = await harnessReport(ctx, A, B, results, {
      ...(ablation ? { ablation: { paths: ablation.paths, dropped: ablation.dropped, unmatched: ablation.unmatched } } : {}),
      ...(gate ? { gate } : {}),
      ...(gateBy ? { gateBy, taskTags } : {}),
      ...(promote ? { pareto: promote } : {}),
      ...(change ? { change } : {}),
    });
    if (out.json) out.data({ experimentId, report, ...resume });
    else {
      out.print(formatCompare(report, { color: out.color, arms }));
      out.print(experimentId);
    }
    if (promote && !report.pareto) out.warn(`--promote: ${PARETO_NEEDS_COST}, so nothing is promoted`);
    // Each requested gate must pass for exit 0: --gate accepts (ship B, or with
    // --without drop the component), --promote promotes, --item-gate keeps or accepts.
    const itemOk = report.itemGate?.verdict === "KEEP" || report.itemGate?.verdict === "ACCEPT";
    const failed = (report.gate && report.gate.decision !== "accept") || (promote && !report.pareto?.promote) || (itemFlag === true && !itemOk);
    return failed ? 1 : 0;
  });
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
