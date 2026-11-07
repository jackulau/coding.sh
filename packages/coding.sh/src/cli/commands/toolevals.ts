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
import { CliError, plural } from "../output.ts";
import type { CommandContext } from "../types.ts";
import { CONFIG_FILE, loadToolEvals, markTaskValidated, parseDriver, ToolEvalsConfigError, VALIDATED_EDIT, type ToolEvalsConfig } from "../../toolevals/config.ts";
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
  if (!values.length) throw new UsageError("Pass at least one --driver, e.g. --driver agent:claude-code or --driver model:anthropic/claude-sonnet-5", { reason: "missing_argument" });
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
  if (c.out.json) c.out.data({ status: "action_required", reason: "cost_confirmation_required", message, estimateUsd: estimate, confirmAboveUsd: cfg.confirmAboveUsd, next: "rerun with --yes" });
  else {
    c.out.fail(`${message}. Confirm to continue`);
    c.out.next("Run anyway", rerun);
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
  if (c.out.json) c.out.data({ ok, tasks: results, problems: cfg.problems });
  else c.out.print(`${results.filter((r) => r.ok).length}/${results.length} task(s) valid`);
  return ok ? 0 : 1;
}

// ------------------------------------------------------------ run

async function runAction(c: CommandContext): Promise<number> {
  const { out } = c;
  const { root, cfg } = await loadRepo(c);
  const target = pickTarget(cfg, c.positionals[0]);
  const drivers = parseDrivers(c, cfg, list(c.flags.driver));
  const variantNames = list(c.flags.variant);
  const variants = (variantNames.length ? variantNames : ["base"]).map((v) => pickVariant(cfg, target.name, v));
  const k = positiveInt(c.flags.k, "k") ?? 3;
  const split = str(c.flags.split) ?? "dev";
  const tasks = selectTasks(cfg, target.name, split, list(c.flags.task));
  if (!tasks.length) throw new CliError(`No ${split === "all" ? "" : `${split} `}tasks for ${target.name}`, { reason: "no_tasks", next: ["Add tasks under:", join(root, "evals", "toolevals", target.name, "tasks")] });
  await checkAgents(drivers);
  const arms = variants.length * drivers.length;
  const trials = tasks.length * arms * k;
  const estimate = tasks.reduce((a, t) => a + trialUsd(cfg, t), 0) * arms * k;
  const drafts = tasks.filter((t) => t.status === "draft").length;
  out.note(`${plural(trials, "trial")} (${plural(tasks.length, "task")} x ${plural(arms, "arm")} x k=${k}), estimated ${usd(estimate)}`);
  if (drafts) out.warn(`${plural(drafts, "task")} still draft; run coding.sh toolevals validate ${target.name} to check them and mark the passing ones ${VALIDATED_EDIT}`);
  const stop = await costGate(c, cfg, estimate, `coding.sh toolevals run ${target.name} ${list(c.flags.driver).map((d) => `--driver ${d}`).join(" ")} --yes`);
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
      onProgress: (done, total) => spin.update(`Running ${done}/${total}…`),
    });
    spin.stop();
    const summary = summarizeArms(r.trials);
    if (out.json) out.data({ experimentId: r.experimentId, dir: r.dir, trials: r.trials.length, k, arms: summary });
    else {
      out.print(formatArms(summary, { color: out.color }).trimEnd());
      out.print(r.experimentId);
      if (summary.length > 1) out.next("Compare two arms", `coding.sh toolevals compare ${r.experimentId} --baseline ${summary[0]!.arm} --candidate ${summary[1]!.arm}`);
    }
    return 0;
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

