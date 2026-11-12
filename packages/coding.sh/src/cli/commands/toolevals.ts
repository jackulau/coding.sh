// coding.sh toolevals <action>: measure how well agents use a CLI, MCP server
// or HTTP API (docs/TOOL-EVALS.md §12). The answer goes to stdout, progress and
// plans to stderr; --json prints one document.
import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { stringifyToml } from "../../core/toml.ts";
import type { Session } from "../../core/types.ts";
import { positiveInt, UsageError } from "../args.ts";
import { list, num, str, withContext } from "../common.ts";
import { ASK_USER, CliError, plural } from "../output.ts";
import type { CommandContext } from "../types.ts";
import { infraStopNote, retryFlag } from "../jobs.ts";
import { CONFIG_FILE, loadToolEvals, markTaskValidated, parseDriver, ToolEvalsConfigError, VALIDATED_EDIT, withShellModel, type ToolEvalsConfig } from "../../toolevals/config.ts";
import type { Driver, SurfaceReport, Target, ToolTask, TrialResult, Variant } from "../../toolevals/types.ts";

export async function run(c: CommandContext): Promise<number> {
  try {
    switch (c.action) {
      case "init":
        return await init(c);
      case "surface":
        return await surface(c);
      case "validate":
        return await validate(c);
      case "run":
        return await runAction(c);
      case "compare":
        return await compareAction(c);
      case "compress":
        return await compress(c);
      case "show":
        return await show(c);
      case "traces":
        return await traces(c);
      default:
        throw new UsageError(`Unknown command toolevals ${c.action ?? ""}`.trim());
    }
  } catch (e) {
    if (e instanceof ToolEvalsConfigError) throw new CliError(e.message, { reason: "invalid_config", next: [`Fix ${CONFIG_FILE} or the task file named above`] });
    throw e;
  }
}

// ------------------------------------------------------------ shared

function findRepoRoot(cwd: string): string | undefined {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, CONFIG_FILE))) return dir;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

async function loadRepo(c: CommandContext): Promise<{ root: string; cfg: ToolEvalsConfig }> {
  const root = findRepoRoot(c.cwd);
  if (!root) throw new CliError(`No ${CONFIG_FILE} found in ${c.cwd} or its parents`, { reason: "no_config", next: ["Add a target first:", "coding.sh toolevals init --cli <bin>"] });
  const cfg = await loadToolEvals(root);
  for (const p of cfg.problems) c.out.warn(p);
  return { root, cfg };
}

function pickTarget(cfg: ToolEvalsConfig, name: string | undefined): Target {
  if (!name) {
    if (cfg.targets.size === 1) return [...cfg.targets.values()][0]!;
    throw new UsageError(`Name a target: ${[...cfg.targets.keys()].join(", ") || "(none configured)"}`, { reason: "missing_argument" });
  }
  const t = cfg.targets.get(name);
  if (!t) throw new CliError(`No target ${JSON.stringify(name)} in ${CONFIG_FILE}`, { reason: "not_found", next: [`Targets: ${[...cfg.targets.keys()].join(", ") || "(none)"}`] });
  return t;
}

function pickVariant(cfg: ToolEvalsConfig, target: string, name: string): Variant {
  const v = cfg.variants.get(target)?.get(name);
  if (!v) throw new UsageError(`No variant ${JSON.stringify(name)} for ${target}. Variants: ${[...(cfg.variants.get(target)?.keys() ?? ["base"])].join(", ")}`, { reason: "not_found" });
  return v;
}

function parseDrivers(c: CommandContext, cfg: ToolEvalsConfig, values: string[]): Driver[] {
  if (!values.length) throw new UsageError("Pass at least one --driver, e.g. --driver agent:claude-code or --driver model:anthropic/claude-sonnet-5-5", { reason: "missing_argument" });
  const drivers: Driver[] = [];
  for (const v of values) {
    try {
      drivers.push(parseDriver(v, cfg.drivers));
    } catch (e) {
      throw new UsageError(e instanceof Error ? e.message : String(e), { reason: "invalid_driver" });
    }
  }
  for (const d of drivers) {
    if (d.kind === "model" && !c.env[d.apiKeyEnv]) throw new CliError(`Driver model:${d.provider}/${d.model} needs $${d.apiKeyEnv}`, { reason: "missing_api_key", next: [`Export ${d.apiKeyEnv}, or set apiKeyEnv under [toolevals.drivers."model:${d.provider}/${d.model}"]`] });
  }
  return drivers;
}

async function checkAgents(drivers: Driver[]): Promise<void> {
  if (!drivers.some((d) => d.kind === "agent")) return;
  const { getAdapter } = await import("../../adapters/index.ts");
  for (const d of drivers) {
    if (d.kind !== "agent") continue;
    const a = getAdapter(d.agent);
    if (!a) throw new UsageError(`Unknown agent ${JSON.stringify(d.agent)}`, { reason: "invalid_driver" });
    if (!a.run) throw new CliError(`Agent ${d.agent} has no headless driver`, { reason: "unsupported_agent" });
  }
}

function selectTasks(cfg: ToolEvalsConfig, target: string, split: string, ids: string[]): ToolTask[] {
  let tasks = cfg.tasks.filter((t) => t.target === target);
  if (split !== "all") tasks = tasks.filter((t) => t.split === split);
  if (ids.length) {
    for (const id of ids) if (!tasks.some((t) => t.id === id)) throw new CliError(`No task ${JSON.stringify(id)} for ${target} in split ${split}`, { reason: "not_found" });
    tasks = tasks.filter((t) => ids.includes(t.id));
  }
  return tasks;
}

const trialUsd = (cfg: ToolEvalsConfig, t: ToolTask) => t.budget.costUsd ?? cfg.trialUsdEstimate;
const usd = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;

/**
 * Cost gate (§12): above confirmAboveUsd a TTY gets a y/N prompt; without a
 * TTY the command stops with action_required (exit 2). Returns an exit code
 * when the command must stop.
 */
async function costGate(c: CommandContext, cfg: ToolEvalsConfig, estimate: number, rerun: string): Promise<number | undefined> {
  if (estimate <= cfg.confirmAboveUsd || c.flags.yes === true) return undefined;
  const message = `Estimated cost ${usd(estimate)} exceeds confirmAboveUsd ${usd(cfg.confirmAboveUsd)}`;
  if (c.out.interactive) {
    if (await c.out.confirm(`${message}. Continue?`)) return undefined;
    throw new CliError("Canceled. Nothing was run", { reason: "canceled", exitCode: 130 });
  }
  if (c.out.json) c.out.data({ status: "action_required", reason: "cost_confirmation_required", message, estimateUsd: estimate, confirmAboveUsd: cfg.confirmAboveUsd, askUser: true, next: "ask the user; rerun with --yes only once they approve the cost" });
  else {
    c.out.fail(`${message}. ${ASK_USER}`);
    c.out.next("With the user's approval, run", rerun);
  }
  return 2;
}

function splitCommand(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (q) {
      if (ch === q) q = null;
      else if (ch === "\\" && q === '"' && i + 1 < s.length) cur += s[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else if (ch === "\\" && i + 1 < s.length) {
      cur += s[++i];
      has = true;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (q) throw new UsageError(`Unterminated quote in ${JSON.stringify(s)}`);
  if (has || cur) out.push(cur);
  return out;
}

// ------------------------------------------------------------ init

async function init(c: CommandContext): Promise<number> {
  const { out } = c;
  const given = (["cli", "mcp", "mcp-url", "http"] as const).filter((k) => str(c.flags[k]) !== undefined);
  if (given.length !== 1) throw new UsageError("Pass exactly one of --cli <bin>, --mcp \"<cmd>\", --mcp-url <url> or --http <url>", { reason: "missing_argument" });
  const kind = given[0]!;
  const value = str(c.flags[kind])!;
  let table: Record<string, unknown>;
  let derived: string;
  if (kind === "cli") {
    const bin = basename(value);
    derived = bin;
    table = { kind: "cli", bin, command: [value.includes("/") ? resolve(c.cwd, value) : value], usageExitCodes: [2], helpCrawl: true };
  } else if (kind === "mcp") {
    const command = splitCommand(value);
    if (!command.length) throw new UsageError("--mcp needs a command");
    derived = basename(command.find((a, i) => i > 0 && !a.startsWith("-") && !/^(-y|--yes)$/.test(a)) ?? command[0]!).replace(/\.[mc]?[jt]s$/, "");
    table = { kind: "mcp", transport: "stdio", command };
  } else {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new UsageError(`--${kind} must be a URL, got ${JSON.stringify(value)}`);
    }
    derived = url.hostname.split(".").filter((x) => x !== "www")[0] ?? "api";
    table = kind === "mcp-url" ? { kind: "mcp", transport: "http", url: value } : { kind: "http", baseUrl: value };
  }
  const name = str(c.flags.name) ?? derived.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new UsageError(`Target name ${JSON.stringify(name)} must use letters, digits, - or _; pass --name`);
  const root = findRepoRoot(c.cwd) ?? resolve(c.cwd);
  const file = join(root, CONFIG_FILE);
  const existing = await loadToolEvals(root).catch(() => undefined);
  if (existing?.targets.has(name)) throw new CliError(`Target ${name} already exists in ${file}`, { reason: "exists", next: ["Pick another name with --name"] });

  const { parseTarget } = await import("../../toolevals/config.ts");
  const target = parseTarget(name, table as never, file);
  const suite = join(root, "evals", "toolevals", name);
  let surf: SurfaceReport | undefined;
  let surfaceError: string | undefined;
  if (target.kind !== "http" || target.openapi) {
    const spin = out.spin(`Crawling the ${name} surface…`);
    try {
      const { measureSurface } = await import("../../toolevals/surface.ts");
      surf = await measureSurface(target, { name: "base" }, { cwd: root, suiteDir: suite });
    } catch (e) {
      surfaceError = e instanceof Error ? e.message : String(e);
    } finally {
      spin.stop();
    }
  }
  const items = surf?.items.map((i) => i.name) ?? [];
  const tasks = starterTasks(target, items);
  const toml = `\n${stringifyToml({ toolevals: { targets: { [name]: table } } })}`;
  const files = tasks.map((t) => ({ path: join(suite, "tasks", `${t.id}.toml`), text: stringifyToml(t) }));
  const plan = { target: name, config: file, append: toml.trim(), files: files.map((f) => f.path), surface: surf ?? null, ...(surfaceError ? { surfaceError } : {}) };
  if (c.flags["dry-run"] === true) {
    if (out.json) out.data({ dryRun: true, ...plan, tasks });
    else {
      out.note(`Would append to ${file}:`);
      out.print(toml.trim());
      for (const f of files) out.note(`Would write ${f.path}`);
      if (surfaceError) out.warn(`Couldn't crawl the surface: ${surfaceError}`);
    }
    return 0;
  }
  await appendFile(file, toml);
  for (const f of files) {
    if (existsSync(f.path)) continue;
    await mkdir(dirname(f.path), { recursive: true });
    await writeFile(f.path, f.text);
  }
  if (out.json) out.data({ dryRun: false, ...plan, tasks });
  else {
    out.ok(`Added target ${name} to ${file}`);
    if (surf) out.note(`surface ${surf.surfaceBytes} B, ${surf.items.length} item(s), ~${surf.surfaceTokens} tokens`);
    if (surfaceError) out.warn(`Couldn't crawl the surface: ${surfaceError}`);
    out.note(`${plural(files.length, "starter task")} (draft) in ${join(suite, "tasks")}`);
    out.next("Edit the tasks, then check them", `coding.sh toolevals validate ${name}`);
    out.print(name);
  }
  return 0;
}

function starterTasks(t: Target, items: string[]): Record<string, unknown>[] {
  const picks = items.slice(0, 3);
  while (picks.length < 3) picks.push("");
  return picks.map((item, i) => {
    const what = t.kind === "cli" ? `the \`${t.bin}\` CLI${item ? ` (\`${item}\`)` : ""}` : t.kind === "mcp" ? `the ${t.name} MCP server${item ? ` (tool \`${item}\`)` : ""}` : `the ${t.name} HTTP API${item ? ` (\`${item}\`)` : ""}`;
    return {
      id: `starter-${i + 1}`,
      target: t.name,
      split: "dev",
      status: "draft",
      tags: ["starter"],
      instruction: `TODO: describe a realistic task that needs ${what}. Ask for a reply the check below can verify.`,
      reference: [],
      check: [{ kind: "output", contains: ["TODO-expected-answer"] }],
      budget: { turns: 20, wallMs: 300000 },
    };
  });
}

// ------------------------------------------------------------ surface

async function surface(c: CommandContext): Promise<number> {
  const { root, cfg } = await loadRepo(c);
  const target = pickTarget(cfg, c.positionals[0]);
  const variant = pickVariant(cfg, target.name, str(c.flags.variant) ?? "base");
  const { measureSurface } = await import("../../toolevals/surface.ts");
  const { formatSurface } = await import("../../toolevals/report.ts");
  let s: SurfaceReport;
  try {
    s = await measureSurface(target, variant, { cwd: root, suiteDir: join(root, "evals", "toolevals", target.name) });
  } catch (e) {
    throw new CliError(`Couldn't read the ${target.name} surface: ${e instanceof Error ? e.message : String(e)}`, { reason: "surface_failed" });
  }
  if (c.out.json) c.out.data({ surface: s });
  else c.out.print(formatSurface(s, { color: c.out.color }).trimEnd());
  return 0;
}

// ------------------------------------------------------------ validate

async function validate(c: CommandContext): Promise<number> {
  if (c.flags.against !== undefined) return validateAgainst(c);
  for (const f of ["driver", "k"] as const) if (c.flags[f] !== undefined) throw new UsageError(`--${f} works with --against <variant>`, { reason: "invalid_argument" });
  const { cfg } = await loadRepo(c);
  const targets = c.positionals[0] ? [pickTarget(cfg, c.positionals[0])] : [...cfg.targets.values()];
  const { validateToolTask } = await import("../../toolevals/validate.ts");
  const { toolevalsRoot } = await import("../../toolevals/experiment.ts");
  const { sortableId } = await import("../../core/ids.ts");
  const root = join(toolevalsRoot(c.env), sortableId("validate_"));
  await mkdir(root, { recursive: true });
  const results = [];
  try {
    for (const t of targets) {
      for (const task of cfg.tasks.filter((x) => x.target === t.name)) {
        const spin = c.out.spin(`Validating ${t.name}/${task.id}…`);
        const r = await validateToolTask(task, t, { root, env: c.env });
        spin.stop();
        // A pass promotes a draft task in its own file, so `run` stops warning.
        let marked = false;
        let markError: string | undefined;
        if (r.ok && task.status !== "validated") {
          try {
            marked = await markTaskValidated(task);
          } catch (e) {
            markError = e instanceof Error ? e.message : String(e);
          }
        }
        results.push({ target: t.name, source: task.source, status: marked ? "validated" : task.status, marked, ...(markError ? { markError } : {}), ...r });
        if (!c.out.json) {
          if (r.ok) c.out.ok(`${t.name}/${task.id}${marked ? " (marked validated)" : ""}`);
          else c.out.fail(`${t.name}/${task.id}: ${r.problems.join("; ")}`);
          if (markError) c.out.warn(`Couldn't mark ${t.name}/${task.id} validated (${markError}); set ${VALIDATED_EDIT} in ${task.source} by hand`);
        }
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
  const ok = results.every((r) => r.ok) && cfg.problems.length === 0;
  // A task file that did not load is a task that is not valid.
  const names = new Set(targets.map((t) => t.name));
  const rejected = (cfg.rejectedTasks ?? []).filter((r) => names.has(r.target)).length;
  if (c.out.json) c.out.data({ ok, tasks: results, problems: cfg.problems, rejected });
  else c.out.print(`${results.filter((r) => r.ok).length}/${results.length + rejected} task(s) valid`);
  return ok ? 0 : 1;
}

// ------------------------------------------------------------ run

/**
 * TB-12: check kinded tasks on the variant they were written against. A bad
 * task must fail there, a guard or control must pass. Without --driver the
 * reference commands run on the variant (a different build, env or URL); a
 * variant that changes only what the agent reads needs agent trials.
 */
async function validateAgainst(c: CommandContext): Promise<number> {
  const { out } = c;
  const { root, cfg } = await loadRepo(c);
  const target = pickTarget(cfg, c.positionals[0]);
  const variantName = str(c.flags.against);
  if (!variantName) throw new UsageError("--against needs a variant name", { reason: "missing_argument" });
  const variant = pickVariant(cfg, target.name, variantName);
  const { againstRows, agentFacingFields, referenceAgainst } = await import("../../toolevals/validate.ts");
  const { checkAgainst } = await import("../../datasets/kinds.ts");
  const all = cfg.tasks.filter((t) => t.target === target.name);
  const tasks = all.filter((t): t is ToolTask & { kind: NonNullable<ToolTask["kind"]> } => t.kind !== undefined);
  if (!tasks.length)
    throw new CliError(`No task of ${target.name} has a kind`, { reason: "no_tasks", next: [`Add kind = "bad" (or "guard", "control") to a task under ${join(root, "evals", "toolevals", target.name, "tasks")}`] });
  const driverFlags = list(c.flags.driver);
  const agentOnly = agentFacingFields(variant);
  if (!driverFlags.length && agentOnly.length)
    throw new UsageError(`Variant ${variant.name} changes what the agent reads (${agentOnly.join(", ")}); its reference commands can't fail on that. Pass --driver to run agent trials`, { reason: "needs_driver" });
  if (!driverFlags.length && c.flags.k !== undefined) throw new UsageError("-k sets agent trials; pass --driver too", { reason: "invalid_argument" });
  let rows: import("../../datasets/kinds.ts").AgainstRow[];
  let experimentId: string | undefined;
  let mode: "reference" | "agent";
  if (!driverFlags.length) {
    mode = "reference";
    const { toolevalsRoot } = await import("../../toolevals/experiment.ts");
    const { sortableId } = await import("../../core/ids.ts");
    const tmp = join(toolevalsRoot(c.env), sortableId("against_"));
    await mkdir(tmp, { recursive: true });
    rows = [];
    try {
      for (const t of tasks) {
        const spin = out.spin(`Reference ${t.id} on ${variant.name}…`);
        rows.push(await referenceAgainst(t, target, { root: tmp, variant, env: c.env }));
        spin.stop();
      }
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  } else {
    mode = "agent";
    const drivers = parseDrivers(c, cfg, driverFlags);
    await checkAgents(drivers);
    const k = positiveInt(c.flags.k, "k") ?? 1;
    const trials = tasks.length * drivers.length * k;
    const estimate = tasks.reduce((a, t) => a + trialUsd(cfg, t), 0) * drivers.length * k;
    out.note(`${plural(trials, "trial")} (${plural(tasks.length, "kinded task")} on ${variant.name} x ${plural(drivers.length, "driver")} x k=${k}), estimated ${usd(estimate)}`);
    const stop = await costGate(c, cfg, estimate, `coding.sh toolevals validate ${target.name} --against ${variant.name} ${driverFlags.map((d) => `--driver ${d}`).join(" ")} --yes`);
    if (stop !== undefined) return stop;
    const { runToolExperiment, toolevalsRoot } = await import("../../toolevals/experiment.ts");
    const { getAdapter } = await import("../../adapters/index.ts");
    const r = await withContext(c, async (ctx) => {
      const spin = out.spin(`Running 0/${trials}…`);
      try {
        return await runToolExperiment({
          tasks,
          target,
          variants: [variant],
          drivers,
          k,
          adapterFor: (a) => getAdapter(a)!,
          index: ctx.index,
          blobs: ctx.blobs,
          root: toolevalsRoot(c.env),
          ingest: () => ctx.ingest(),
          prices: cfg.prices,
          env: c.env,
          bundleFor: (ref) => ctx.index.getBundle(ref),
          meta: { repoRoot: root, against: variant.name },
          signal: c.signal,
          onProgress: (done, total) => spin.update(`Running ${done}/${total}…`),
        });
      } finally {
        spin.stop();
      }
    });
    if (r.cancelled) {
      if (out.json) out.data({ outcome: "cancelled", experimentId: r.experimentId, dir: r.dir, trials: r.trials.length, total: trials });
      else out.warn(`Cancelled after ${r.trials.length}/${trials} trials; finished trials are in ${r.dir}`);
      return 1;
    }
    experimentId = r.experimentId;
    rows = againstRows(tasks, r.trials);
  }
  const report = checkAgainst(rows, variant.name);
  const untagged = all.length - tasks.length;
  if (out.json) out.data({ ok: report.ok, target: target.name, variant: variant.name, mode, ...(experimentId ? { experimentId } : {}), counts: report.counts, cases: report.cases, untagged });
  else {
    for (const x of report.cases) {
      if (x.ok) out.ok(`${target.name}/${x.caseId} (${x.kind}) ${x.kind === "bad" ? "fails" : "passes"} on ${variant.name}${x.trials > 1 ? ` (${x.passes}/${x.trials} pass)` : ""}`);
      else out.fail(`${target.name}/${x.caseId} (${x.kind}): ${x.problem}`);
    }
    const held = report.cases.filter((x) => x.ok).length;
    out.print(`${held}/${report.cases.length} kinded task(s) hold on ${variant.name}${untagged ? ` (${plural(untagged, "task")} without a kind skipped)` : ""}`);
    if (experimentId) out.print(experimentId);
  }
  return report.ok ? 0 : 1;
}

async function runAction(c: CommandContext): Promise<number> {
  const { out } = c;
  const { root, cfg } = await loadRepo(c);
  const target = pickTarget(cfg, c.positionals[0]);
  let drivers = parseDrivers(c, cfg, list(c.flags.driver));
  const shellModel = str(c.flags["shell-model"]);
  if (shellModel !== undefined) {
    if (target.kind !== "cli") throw new UsageError(`--shell-model simulates the shell tool of a CLI target; ${target.name} is ${target.kind}`, { reason: "unsupported_target" });
    if (!/^(anthropic|openai|openai-chat)\/.+/.test(shellModel)) throw new UsageError(`--shell-model must be <anthropic|openai|openai-chat>/<model>, got ${JSON.stringify(shellModel)}`, { reason: "invalid_argument" });
    const agent = drivers.find((d) => d.kind === "agent");
    if (agent) throw new UsageError(`--shell-model works with model drivers only; drop --driver agent:${agent.kind === "agent" ? agent.agent : ""}`, { reason: "invalid_driver" });
    drivers = drivers.map((d) => withShellModel(d, shellModel, cfg.drivers));
    const sim = drivers[0]?.kind === "model" ? drivers[0].shell : undefined;
    if (sim && !c.env[sim.apiKeyEnv]) throw new CliError(`Shell model ${shellModel} needs $${sim.apiKeyEnv}`, { reason: "missing_api_key", next: [`Export ${sim.apiKeyEnv}, or set apiKeyEnv under [toolevals.drivers."model:${shellModel}"]`] });
  }
  const variantNames = list(c.flags.variant);
  const variants = (variantNames.length ? variantNames : ["base"]).map((v) => pickVariant(cfg, target.name, v));
  const adaptive = str(c.flags.samples) === "adaptive";
  if (adaptive && c.flags.k !== undefined) throw new UsageError("--samples adaptive sets the trials (2 per task and arm, a 3rd when they disagree); drop -k", { reason: "invalid_argument" });
  const stopOnRegression = c.flags["stop-on-regression"] === true;
  const baselineId = str(c.flags.baseline);
  if (stopOnRegression && !baselineId) throw new UsageError("--stop-on-regression needs --baseline <EXPERIMENT>", { reason: "missing_argument" });
  if (baselineId && !stopOnRegression) throw new UsageError("--baseline needs --stop-on-regression", { reason: "invalid_argument" });
  const k = adaptive ? 2 : (positiveInt(c.flags.k, "k") ?? 3);
  const split = str(c.flags.split) ?? "dev";
  const tasks = selectTasks(cfg, target.name, split, list(c.flags.task));
  if (!tasks.length) throw new CliError(`No ${split === "all" ? "" : `${split} `}tasks for ${target.name}`, { reason: "no_tasks", next: ["Add tasks under:", join(root, "evals", "toolevals", target.name, "tasks")] });
  let baseline: TrialResult[] | undefined;
  if (baselineId) {
    const { loadExperiment, toolevalsRoot } = await import("../../toolevals/experiment.ts");
    try {
      baseline = (await loadExperiment(baselineId, toolevalsRoot(c.env))).trials;
    } catch {
      throw new CliError(`Can't find tool-eval experiment ${JSON.stringify(baselineId)}`, { reason: "not_found", next: [`Experiments live in ${toolevalsRoot(c.env)}`] });
    }
    if (!baseline.some((t) => tasks.some((x) => x.id === t.taskId))) throw new CliError(`Baseline ${baselineId} ran none of these tasks`, { reason: "invalid_baseline" });
  }
  await checkAgents(drivers);
  const arms = variants.length * drivers.length;
  // Adaptive: 2 trials each, up to 3; the estimate counts the most it can cost.
  const trials = tasks.length * arms * k;
  const estimate = tasks.reduce((a, t) => a + trialUsd(cfg, t), 0) * arms * (adaptive ? 3 : k);
  const drafts = tasks.filter((t) => t.status === "draft").length;
  out.note(
    adaptive
      ? `${plural(trials, "trial")} (${plural(tasks.length, "task")} x ${plural(arms, "arm")} x 2), up to ${tasks.length * arms * 3} with tie-breaks, estimated up to ${usd(estimate)}`
      : `${plural(trials, "trial")} (${plural(tasks.length, "task")} x ${plural(arms, "arm")} x k=${k}), estimated ${usd(estimate)}`,
  );
  if (drafts) out.warn(`${plural(drafts, "task")} still draft; run coding.sh toolevals validate ${target.name} to check them and mark the passing ones ${VALIDATED_EDIT}`);
  const stop = await costGate(c, cfg, estimate, `coding.sh toolevals run ${target.name} ${list(c.flags.driver).map((d) => `--driver ${d}`).join(" ")}${shellModel ? ` --shell-model ${shellModel}` : ""} --yes`);
  if (stop !== undefined) return stop;

  const { runToolExperiment, toolevalsRoot } = await import("../../toolevals/experiment.ts");
  const { summarizeArms } = await import("../../toolevals/compare.ts");
  const { formatArms } = await import("../../toolevals/report.ts");
  const { measureSurface } = await import("../../toolevals/surface.ts");
  const { getAdapter } = await import("../../adapters/index.ts");
  const surfaces: Record<string, SurfaceReport> = {};
  for (const v of variants) {
    try {
      surfaces[v.name] = await measureSurface(target, v, { cwd: root, suiteDir: join(root, "evals", "toolevals", target.name) });
    } catch {
      // surface is informational; the run goes on
    }
  }
  const concurrency = positiveInt(c.flags.concurrency, "concurrency");
  return withContext(c, async (ctx) => {
    const spin = out.spin(`Running 0/${trials}…`);
    const r = await runToolExperiment({
      tasks,
      target,
      variants,
      drivers,
      k,
      ...(adaptive ? { samples: "adaptive" as const } : {}),
      ...(baseline ? { stopOnRegression: baseline } : {}),
      ...(concurrency ? { concurrency } : {}),
      adapterFor: (a) => getAdapter(a)!,
      index: ctx.index,
      blobs: ctx.blobs,
      keep: c.flags.keep === true,
      root: toolevalsRoot(c.env),
      ingest: () => ctx.ingest(),
      prices: cfg.prices,
      env: c.env,
      bundleFor: (ref) => ctx.index.getBundle(ref),
      meta: { repoRoot: root, split, surfaces },
      retry: retryFlag(c),
      signal: c.signal,
      onProgress: (done, total) => spin.update(`Running ${done}/${total}…`),
    });
    spin.stop();
    if (r.cancelled) {
      // main.ts exits 130 (143 for SIGTERM); finished trials stay in trials.jsonl.
      if (out.json) out.data({ outcome: "cancelled", experimentId: r.experimentId, dir: r.dir, trials: r.trials.length, total: trials });
      else out.warn(`Cancelled after ${r.trials.length}/${trials} trials; finished trials are in ${r.dir}`);
      return 1;
    }
    const summary = summarizeArms(r.trials, { adaptive });
    const regression = r.regression ? { ...r.regression, baseline: baselineId! } : undefined;
    if (out.json)
      out.data({
        outcome: r.infraStop ? "stopped" : regression ? "regression" : undefined,
        regression,
        infraStop: r.infraStop,
        experimentId: r.experimentId,
        dir: r.dir,
        trials: r.trials.length,
        k,
        ...(adaptive ? { samples: "adaptive" } : {}),
        arms: summary,
      });
    else {
      out.print(formatArms(summary, { color: out.color }).trimEnd());
      infraStopNote(c, r.infraStop);
      if (regression) out.fail(`regression: task ${regression.taskId} (${regression.arm}) passed every trial of ${regression.baseline} and fails here; the run stopped (--stop-on-regression)`);
      out.print(r.experimentId);
      if (summary.length > 1 && !adaptive && !regression && !r.infraStop) out.next("Compare two arms", `coding.sh toolevals compare ${r.experimentId} --baseline ${summary[0]!.arm} --candidate ${summary[1]!.arm}`);
    }
    return regression || r.infraStop ? 1 : 0;
  });
}

// ------------------------------------------------------------ compare

async function compareAction(c: CommandContext): Promise<number> {
  const id = c.positionals[0]!;
  const baseline = str(c.flags.baseline);
  const candidate = str(c.flags.candidate);
  if (!baseline || !candidate) throw new UsageError("Pass --baseline <arm> and --candidate <arm> (arms are <variant>@<driver>)", { reason: "missing_argument" });
  const { loadExperiment, loadTrialTrace, toolevalsRoot } = await import("../../toolevals/experiment.ts");
  const { compareToolArms, summarizeArms } = await import("../../toolevals/compare.ts");
  const { formatToolCompare } = await import("../../toolevals/report.ts");
  let exp: Awaited<ReturnType<typeof loadExperiment>>;
  try {
    exp = await loadExperiment(id, toolevalsRoot(c.env));
  } catch {
    throw new CliError(`Can't find tool-eval experiment ${JSON.stringify(id)}`, { reason: "not_found", next: [`Experiments live in ${toolevalsRoot(c.env)}`] });
  }
  if (exp.meta.samples === "adaptive")
    throw new CliError(`Experiment ${id} ran adaptive samples: its trial count depends on its outcomes, so a paired CI over it is biased`, {
      reason: "adaptive_samples",
      next: ["Compare arms of a run with a fixed -k:", `coding.sh toolevals run <target> --variant <A> --variant <B> -k 3`],
    });
  const arms = summarizeArms(exp.trials).map((a) => a.arm);
  for (const a of [baseline, candidate]) if (!arms.includes(a)) throw new CliError(`Experiment ${id} has no arm ${JSON.stringify(a)}`, { reason: "not_found", next: [`Arms: ${arms.join(", ") || "(none)"}`] });
  const surfaces = (exp.meta.surfaces ?? {}) as Record<string, SurfaceReport>;
  const variantOf = (arm: string) => arm.slice(0, arm.indexOf("@"));
  const events = new Map<string, import("../../schema/index.ts").AgentEvent[]>();
  await withContext(c, async (ctx) => {
    for (const t of exp.trials) {
      if (!t.sessionId || (t.variant !== variantOf(baseline) && t.variant !== variantOf(candidate))) continue;
      const tr = await loadTrialTrace(ctx.index, t.id, t.sessionId);
      if (tr.events.length) events.set(t.id, tr.events);
    }
  });
  let report;
  try {
    report = compareToolArms(exp.trials, { baseline, candidate, events, surfaces: { baseline: surfaces[variantOf(baseline)], candidate: surfaces[variantOf(candidate)] } });
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e), { reason: "invalid_arms" });
  }
  if (c.out.json) c.out.data({ experimentId: id, report });
  else c.out.print(formatToolCompare(report, { color: c.out.color }).trimEnd());
  return 0;
}

// ------------------------------------------------------------ compress

async function compress(c: CommandContext): Promise<number> {
  const { out } = c;
  const { root, cfg } = await loadRepo(c);
  const target = pickTarget(cfg, c.positionals[0]);
  if (target.kind !== "mcp") throw new UsageError(`compress works on MCP targets; ${target.name} is ${target.kind}`, { reason: "unsupported_target" });
  const driverFlag = str(c.flags.driver);
  const [driver] = parseDrivers(c, cfg, driverFlag ? [driverFlag] : []);
  const k = positiveInt(c.flags.k, "k") ?? 3;
  const margin = num(c.flags.margin) ?? 0.03;
  if (!(margin >= 0 && margin < 1)) throw new UsageError(`--margin must be in [0, 1), got ${margin}`);
  const maxEvals = positiveInt(c.flags["max-evals"], "max-evals") ?? 40;
  const tasks = cfg.tasks.filter((t) => t.target === target.name);
  const dev = tasks.filter((t) => t.split === "dev");
  const heldout = tasks.filter((t) => t.split === "heldout");
  if (!dev.length) throw new CliError(`No dev tasks for ${target.name}`, { reason: "no_tasks" });
  await checkAgents([driver!]);
  const devUsd = dev.reduce((a, t) => a + trialUsd(cfg, t), 0);
  const heldUsd = heldout.reduce((a, t) => a + trialUsd(cfg, t), 0);
  const estimate = devUsd * k * (maxEvals + 1) + heldUsd * Math.max(5, k) * 2;
  out.note(`up to ${maxEvals} candidate eval(s) of ${plural(dev.length, "dev task")} x k=${k}${heldout.length ? `, held-out confirmation on ${plural(heldout.length, "task")} x k=${Math.max(5, k)}` : ""}; estimated up to ${usd(estimate)}`);
  const stop = await costGate(c, cfg, estimate, `coding.sh toolevals compress ${target.name} --driver ${driverFlag} --yes`);
  if (stop !== undefined) return stop;

  const { compressDescriptions, descriptionsFile, modelRewriter } = await import("../../toolevals/compress.ts");
  const { toolevalsRoot } = await import("../../toolevals/experiment.ts");
  const { formatCompress } = await import("../../toolevals/report.ts");
  const { getAdapter } = await import("../../adapters/index.ts");
  let rewrite: ReturnType<typeof modelRewriter> | undefined;
  if (cfg.rewriter) {
    const rd = parseDriver(cfg.rewriter, cfg.drivers);
    if (rd.kind !== "model") throw new CliError(`[toolevals] rewriter must be a model driver, got ${cfg.rewriter}`, { reason: "invalid_config" });
    const key = c.env[rd.apiKeyEnv];
    if (!key) throw new CliError(`Rewriter ${cfg.rewriter} needs $${rd.apiKeyEnv}`, { reason: "missing_api_key" });
    rewrite = modelRewriter(rd, key);
  } else out.warn("No [toolevals] rewriter configured; using rule-based candidates only");
  const base = cfg.variants.get(target.name)?.get("base") ?? { name: "base" };
  return withContext(c, async (ctx) => {
    const spin = out.spin("Baseline…");
    const report = await compressDescriptions({
      target,
      tasks,
      driver: driver!,
      k,
      margin,
      maxEvals,
      batch: c.flags.batch === true,
      ...(rewrite ? { rewrite } : {}),
      base,
      adapterFor: (a) => getAdapter(a)!,
      index: ctx.index,
      blobs: ctx.blobs,
      root: toolevalsRoot(c.env),
      ingest: () => ctx.ingest(),
      prices: cfg.prices,
      env: c.env,
      bundleFor: (ref) => ctx.index.getBundle(ref),
      onStep: (s, n) => spin.update(`Eval ${n}/${maxEvals}: ${s.tool} ${s.fromBytes} → ${s.toBytes} B ${s.accepted ? "accepted" : "rejected"}`),
    });
    spin.stop();
    const file = join(root, "evals", "toolevals", target.name, "variants", "desc-min", "descriptions.json");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(descriptionsFile(report), null, 2) + "\n");
    if (out.json) out.data({ file, report });
    else {
      out.print(formatCompress(report, { color: out.color }).trimEnd());
      out.ok(`Wrote ${file}`);
    }
    return 0;
  });
}

// ------------------------------------------------------------ show

async function show(c: CommandContext): Promise<number> {
  const id = c.positionals[0]!;
  const { loadTrialTrace, toolevalsRoot } = await import("../../toolevals/experiment.ts");
  const { formatTrial } = await import("../../toolevals/report.ts");
  const root = toolevalsRoot(c.env);
  let trial: TrialResult | undefined;
  let experimentDir: string | undefined;
  const dirs = existsSync(root) ? (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort().reverse() : [];
  for (const d of dirs) {
    const f = join(root, d, "trials.jsonl");
    if (!existsSync(f)) continue;
    const text = await readFile(f, "utf8");
    if (!text.includes(id)) continue;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const t = JSON.parse(line) as TrialResult;
        if (t.id === id) {
          trial = t;
          experimentDir = join(root, d);
        }
      } catch {
        // skip partial lines
      }
    }
    if (trial) break;
  }
  if (!trial) throw new CliError(`Can't find trial ${JSON.stringify(id)}`, { reason: "not_found", next: [`Trials are listed in ${root}/<experimentId>/trials.jsonl`] });
  const found = trial;
  return withContext(c, async (ctx) => {
    let tap: import("../../toolevals/types.ts").TapRecord[] = [];
    if (found.tapBlob) {
      const text = await ctx.blobs.getText(found.tapBlob).catch(() => undefined);
      if (text) tap = text.split("\n").filter((l) => l.trim()).flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      });
    }
    const trace = await loadTrialTrace(ctx.index, found.id, found.sessionId);
    const sessions = trace.sessions.map((s: Session) => ({ id: s.id, agent: s.agent, ...(s.parent ? { parent: s.parent.sessionId } : {}), ...(s.title ? { title: s.title } : {}) }));
    if (c.out.json) c.out.data({ trial: found, experimentDir, tap, sessions });
    else c.out.print(formatTrial(found, { tap, sessions }, { color: c.out.color }).trimEnd());
    return 0;
  });
}


// ------------------------------------------------------------ traces

async function traces(c: CommandContext): Promise<number> {
  const name = c.positionals[0];
  if (!name) throw new UsageError("Name a target or MCP server: coding.sh toolevals traces <target> --sessions 'since:30d'", { reason: "missing_argument" });
  const from = str(c.flags.from);
  const sessions = str(c.flags.sessions);
  const arm = str(c.flags.arm);
  if (from === undefined && sessions === undefined) throw new UsageError("Pass --from <experimentId>, --sessions '<filter>', or both", { reason: "missing_argument" });
  if (arm !== undefined && from === undefined) throw new UsageError("--arm picks an arm of --from <experimentId>", { reason: "invalid_argument" });
  const root = findRepoRoot(c.cwd);
  const cfg = root ? await loadToolEvals(root) : undefined;
  const target = cfg?.targets.get(name);
  const server = str(c.flags.server) ?? name;
  const { buildTraceWorkspace, formatHealth, TraceError, writeTraceWorkspace } = await import("../../toolevals/traces.ts");
  const { loadExperiment, toolevalsRoot } = await import("../../toolevals/experiment.ts");
  let experiment: { id: string; meta: Record<string, unknown>; trials: TrialResult[] } | undefined;
  if (from !== undefined) {
    try {
      experiment = { id: from, ...(await loadExperiment(from, toolevalsRoot(c.env))) };
    } catch {
      throw new CliError(`Can't find tool-eval experiment ${JSON.stringify(from)}`, { reason: "not_found", next: [`Experiments live in ${toolevalsRoot(c.env)}`] });
    }
    const expTarget = (experiment.meta.target as { name?: string } | undefined)?.name;
    if (expTarget && expTarget !== name) c.out.warn(`experiment ${from} ran target ${expTarget}, not ${name}`);
  }
  // The server's tools (base variant, or the arm's), for neverCalled and tools.json.
  let tools: import("../../toolevals/types.ts").McpTool[] | undefined;
  if (target?.kind === "mcp" && !c.flags["no-tools"]) {
    const variantName = arm ? arm.slice(0, arm.indexOf("@")) : "base";
    const variant = cfg!.variants.get(target.name)?.get(variantName) ?? { name: variantName };
    const { connectMcp } = await import("../../toolevals/mcp/client.ts");
    const { applyToolOverrides } = await import("../../toolevals/tap/mcp-proxy.ts");
    try {
      const env = { ...(target.env ?? {}), ...(variant.env ?? {}) };
      const client = await connectMcp(target.transport === "stdio" ? { stdio: variant.command ?? target.command, env, cwd: root } : { url: variant.url ?? target.url, headers: target.headers });
      try {
        tools = applyToolOverrides(await client.listTools(), variant);
      } finally {
        await client.close();
      }
    } catch (e) {
      c.out.warn(`couldn't list ${target.name}'s tools (${e instanceof Error ? e.message : String(e)}); tools.json is empty and neverCalled is unknown`);
    }
  }
  return withContext(c, async (ctx) => {
    let ws;
    try {
      ws = await buildTraceWorkspace({ index: ctx.index, blobs: ctx.blobs, server, ...(experiment ? { experiment } : {}), ...(arm ? { arm } : {}), ...(sessions !== undefined ? { sessions } : {}), ...(tools ? { tools } : {}), ...(c.flags.max !== undefined ? { maxTraces: positiveInt(c.flags.max, "max") } : {}) });
    } catch (e) {
      if (e instanceof TraceError) throw new CliError(e.message, { reason: e.reason });
      throw e;
    }
    const outDir = str(c.flags.out);
    if (outDir) await writeTraceWorkspace(ws, resolve(c.cwd, outDir));
    for (const n of ws.notes) c.out.warn(n);
    if (c.out.json) c.out.data({ server: ws.server, matched: ws.matched, health: ws.health, traces: ws.traces.map(({ markdown: _m, ...t }) => t), notes: ws.notes, ...(outDir ? { out: resolve(c.cwd, outDir) } : {}) });
    else {
      if (!ws.matched) c.out.print(`No traces call ${server}. Sessions name MCP tools mcp__<server>__<tool>; pass --server if the agent registered it under another name.`);
      else c.out.print(formatHealth(ws).trimEnd());
      if (outDir) c.out.print(`\nWrote ${plural(ws.traces.length, "trace")} to ${resolve(c.cwd, outDir)}`);
    }
    return 0;
  });
}
