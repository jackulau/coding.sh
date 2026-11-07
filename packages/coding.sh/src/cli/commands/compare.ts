// coding.sh compare <a> <b>: A/B two harness bundles on eval tasks
// (src/runner/experiment.ts), or re-analyse the stored runs of an experiment.
// `compare <a> --without <path>` derives B as A minus a skill, AGENTS.md or MCP config.
import { getAdapter } from "../../adapters/index.ts";
import { gatewaySettings } from "../../integrations/gateway/config.ts";
import { gatewayRoute, ROUTABLE_AGENTS } from "../../integrations/gateway/route.ts";
import { ablateBundle, type Ablation } from "../../runner/bundle.ts";
import { git } from "../../runner/git.ts";
import { hasGlob } from "../../runner/glob.ts";
import type { AgentRoute } from "../../runner/run.ts";
import type { EvalTask, HarnessBundle, RunResult } from "../../core/types.ts";
import { compare, formatCompare, loadRunEvents, loadRunSessions, runExperiment } from "../../runner/experiment.ts";
import { positiveInt, UsageError } from "../args.ts";
import { list, requireConsent, resolveTask, str, withContext } from "../common.ts";
import { CliError, plural } from "../output.ts";
import type { CommandContext } from "../types.ts";

export async function run(c: CommandContext): Promise<number> {
  const { out } = c;
  // Fail on a missing gateway key before touching the store or running anything.
  const gatewayKey = c.flags.gateway === true ? requireGatewayKey(c.env) : undefined;
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
    // How to name this comparison again (consent prompt, cancel hint).
    const arms = [...c.positionals.slice(0, 2), ...without.flatMap((p) => ["--without", p])].join(" ");
    /** Store the derived arm once; a rerun finds it by its content id. */
    const storeAblation = async () => {
      if (!ablation) return;
      for (const p of ablation.unmatched) out.warn(`--without ${p}: not in bundle ${A.name}; it is only removed from each task's repo`);
      if (!(await ctx.index.getBundle(ablation.bundle.id))) await ctx.index.putBundle(ablation.bundle);
    };

    let experimentId = str(c.flags.experiment);
    let results: RunResult[];
    if (experimentId) {
      results = (await ctx.index.listRuns({ experimentId })).filter((r) => r.bundleId === A.id || r.bundleId === B.id);
      if (!results.length) throw new CliError(`Experiment ${experimentId} has no runs for these bundles`, { reason: "not_found" });
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
      if (ablation && !ablation.dropped.length && !(await anyInTaskRepo(tasks, ablation.unmatched, c.env))) {
        throw new UsageError(`nothing to ablate: ${ablation.unmatched.join(", ")} is in neither bundle ${A.name} nor any selected task's repo`, { reason: "nothing_to_ablate" });
      }
      for (const b of bundles) if (!getAdapter(b.agent)?.run) throw new CliError(`Agent ${b.agent} has no headless driver, so bundle ${b.name} can't be run`, { reason: "unsupported_agent" });
      const route = gatewayKey ? gatewayRouteFor(bundles, gatewayKey) : undefined;
      const k = positiveInt(c.flags.k, "k") ?? 1;
      const runs = tasks.length * 2 * k;
      await requireConsent(c, `Run ${plural(runs, "agent session")} (${plural(tasks.length, "task")} x 2 arms x ${k})?`, `coding.sh compare ${arms} --yes`);
      await storeAblation();
      const spin = out.spin(`Running 0/${runs}…`);
      const concurrency = positiveInt(c.flags.concurrency, "concurrency");
      const r = await runExperiment({
        tasks,
        bundles: [A, B],
        adapterFor: (b) => getAdapter(b.agent)!,
        blobs: ctx.blobs,
        index: ctx.index,
        k,
        ...(concurrency ? { concurrency } : {}),
        ...(route ? { route } : {}),
        signal: c.signal,
        onProgress: (p) => spin.update(`Running ${p.done}/${p.total}…`),
      });
      spin.stop();
      experimentId = r.experimentId;
      results = r.results;
      if (r.cancelled) {
        // A partial A/B is not a comparison; main.ts exits 130 (143 for SIGTERM).
        const finished = results.filter((x) => !x.cancelled).length;
        if (out.json) out.data({ outcome: "cancelled", experimentId, finished, total: runs });
        else out.warn(`Cancelled after ${finished}/${runs} runs; no comparison. Analyse the stored runs: coding.sh compare ${arms} --experiment ${experimentId}`);
        return 1;
      }
      // Pull in the sessions the runs' hooks captured.
      await ctx.ingest().catch(() => undefined);
    }
    const sessions = await loadRunSessions(ctx.index, results);
    const events = await loadRunEvents(ctx.index, sessions);
    const report = compare(results, {
      baseline: A.id,
      candidate: B.id,
      sessions,
      events,
      bundles: { baseline: A, candidate: B },
      ...(ablation ? { ablation: { paths: ablation.paths, dropped: ablation.dropped, unmatched: ablation.unmatched } } : {}),
    });
    if (out.json) out.data({ experimentId, report });
    else {
      out.print(formatCompare(report, { color: out.color }));
      out.print(experimentId);
    }
    return 0;
  });
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

/** `--gateway`: the AI Gateway key from AI_GATEWAY_API_KEY (or [gateway] in config). */
function requireGatewayKey(env: NodeJS.ProcessEnv): string {
  const g = gatewaySettings(env);
  if (!g.apiKey) throw new CliError(`--gateway needs an AI Gateway key in $${g.apiKeyEnv}`, { reason: "missing_key", next: ["Create one at vercel.com/ai-gateway, then:", `export ${g.apiKeyEnv}=...`] });
  return g.apiKey;
}

/** Runs both arms through Vercel AI Gateway, each with its bundle's model. */
function gatewayRouteFor(bundles: HarnessBundle[], key: string): AgentRoute {
  for (const b of bundles) {
    if (!(ROUTABLE_AGENTS as readonly string[]).includes(b.agent)) throw new CliError(`--gateway can't route ${b.agent} (bundle ${b.name}); supported: ${ROUTABLE_AGENTS.join(", ")}`, { reason: "unsupported_agent" });
  }
  return (b) => gatewayRoute(b.agent, b.model, key);
}
