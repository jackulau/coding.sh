// coding.sh bench new|run|list|show|history|report|schedule (src/bench).
import { existsSync, realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { BenchDefError, benchHome, checkName, findDefinition, listDefinitions, loadDefinition, parseDefinition, renderDefinition } from "../../bench/define.ts";
import { verifySeed, type SeedCheck } from "../../bench/commit.ts";
import { buildReport, renderReportHtml } from "../../bench/report.ts";
import { gridText } from "../../bench/grid.ts";
import { specializationLines } from "../../bench/specialization.ts";
import { BenchRunError, regradeRun, resumeBench, resumeCommand, resumeTarget, runBench, type DryRunResult } from "../../bench/run.ts";
import { JobStore } from "../../jobs/store.ts";
import { cronLine, envRefs, installCron, systemCrontab, workflowYaml } from "../../bench/schedule.ts";
import { SourceError } from "../../bench/sources.ts";
import { pairVerdictText, pooledGap, powerPlan, type PowerPlan } from "../../bench/stats.ts";
import { contentChanges, getRun, historyRuns, listRuns, series, vsSeries, type ContentChange } from "../../bench/store.ts";
import { pricesFor } from "../../core/pricing.ts";
import { version } from "../meta.ts";
import type { BenchDef, BenchRun, ContenderSpec, ContenderSummary, Metric, PairComparison, SourceSpec } from "../../bench/types.ts";
import { DatasetError } from "../../datasets/dataset.ts";
import { FileEvalStore } from "../../datasets/store.ts";
import type { GraderSpec } from "../../graders/index.ts";
import { FileJudgeCache } from "../../judge/cache.ts";
import { positiveInt, UsageError } from "../args.ts";
import { autoIngest, jsonArg, list, requireConsent, str, withContext, readIngest } from "../common.ts";
import { ago, CliError, plural } from "../output.ts";
import type { CommandContext } from "../types.ts";

const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "-");
const ms = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? "-" : x < 1000 ? `${Math.round(x)}ms` : `${(x / 1000).toFixed(2)}s`);
const usd = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? "-" : `$${x < 1 ? x.toFixed(4) : x.toFixed(2)}`);
const pp = (x: number) => (Number.isFinite(x) ? `${x >= 0 ? "+" : "-"}${Math.abs(x * 100).toFixed(1)}` : "-");

function definitionFor(c: CommandContext, ref: string): BenchDef {
  const file = findDefinition(ref, { cwd: c.cwd, env: c.env });
  if (!file) {
    throw new CliError(`Can't find benchmark ${JSON.stringify(ref)}`, {
      reason: "not_found",
      next: ["Looked in ./bench/ (and parent folders) and ~/.coding.sh/benchmarks/. Create one:", `coding.sh bench new ${/^[a-z0-9][a-z0-9._-]*$/.test(ref) ? ref : "<name>"} --command '<generator>' -c a='<cmd>' -c b='<cmd>'`],
    });
  }
  try {
    return loadDefinition(file);
  } catch (e) {
    throw new CliError(`${file}: ${e instanceof Error ? e.message : String(e)}`, { reason: "invalid_definition" });
  }
}

/** Name for run-record lookups: a definition name, or a bare name with runs but no file (e.g. records copied from CI). */
function benchName(c: CommandContext, ref: string): string {
  const file = findDefinition(ref, { cwd: c.cwd, env: c.env });
  if (file) {
    try {
      return loadDefinition(file).name;
    } catch {
      // fall through: a broken file shouldn't hide stored results
    }
  }
  try {
    return checkName(ref);
  } catch {
    throw new UsageError(`${JSON.stringify(ref)} is not a benchmark name`, { reason: "invalid_argument" });
  }
}

async function runsOrFail(c: CommandContext, name: string): Promise<BenchRun[]> {
  const runs = await listRuns(name, c.env);
  if (!runs.length) throw new CliError(`${name} has no runs yet`, { reason: "not_found", next: ["Run it:", `coding.sh bench run ${name}`] });
  return runs;
}

function parseContender(v: string): ContenderSpec {
  const eq = v.indexOf("=");
  if (eq < 1) throw new UsageError(`--contender must be NAME=CMD, NAME=URL or NAME=agent:ID[:MODEL], got ${JSON.stringify(v)}`, { reason: "invalid_argument" });
  const name = v.slice(0, eq).trim();
  const target = v.slice(eq + 1).trim();
  if (/^https?:\/\//.test(target)) return { name, kind: "http", url: target };
  const agent = /^agent:([\w.-]+)(?::(.+))?$/.exec(target);
  if (agent) return { name, kind: "agent", agent: agent[1]!, ...(agent[2] ? { model: agent[2] } : {}) };
  if (!target) throw new UsageError(`--contender ${name}: missing command`, { reason: "invalid_argument" });
  return { name, kind: "command", command: target };
}

function sourceFromFlags(c: CommandContext): SourceSpec {
  const kind = str(c.flags.source) ?? "command";
  const need = (flag: string, what: string): string => {
    const v = str(c.flags[flag]);
    if (!v) throw new UsageError(`--source ${kind} needs --${flag} ${what}`, { reason: "missing_argument" });
    return v;
  };
  switch (kind) {
    case "command":
      return { kind: "command", command: need("command", "<CMD>  (a script that prints one JSON case per line)") };
    case "sessions":
      return { kind: "sessions", since: "7d", select: "failed" };
    case "github":
      return { kind: "github", repo: need("repo", "<OWNER/NAME>"), type: "issues", state: "open", since: "7d" };
    case "urls": {
      const sm = list(c.flags.sitemap);
      if (!sm.length) throw new UsageError("--source urls needs --sitemap <URL>", { reason: "missing_argument" });
      return { kind: "urls", sitemap: sm.length === 1 ? sm[0]! : sm };
    }
    case "dataset":
      return { kind: "dataset", dataset: need("dataset", "<NAME>") };
  }
  throw new UsageError(`Unknown source ${kind}`);
}

function leaderboardRows(summaries: readonly ContenderSummary[]): string[][] {
  return summaries.map((s) => [
    String(s.place),
    s.contender,
    `${pct(s.passRate.p)} (${s.passed}/${s.n})`,
    `${pct(s.passRate.lo)}-${pct(s.passRate.hi)}`,
    ms(s.latencyMs.p50),
    ms(s.latencyMs.p95),
    s.costUsd.known ? usd(s.costUsd.perRun) : "-",
    String(s.errors),
  ]);
}

/** Lines about what a sample size can detect (printed by `new` and `run --dry-run`). */
function planLines(p: PowerPlan): string[] {
  const n = (x: number) => (Number.isFinite(x) ? String(x) : "-");
  return [
    `With ${plural(p.cases, "case")} and ${plural(p.pairs, "pair")}, the smallest pass-rate gap this run can reliably detect is about ${Number.isFinite(p.mde) ? Math.round(p.mde * 100) : "-"} points (80% power, α ${p.alpha < 0.05 ? `${p.alpha.toFixed(3)} per pair after Holm` : "0.05"}).`,
    `To detect a 10-point gap you need about ${n(p.nFor10)} cases; 5 points, about ${n(p.nFor5)} (assuming ${Math.round(p.discordance * 100)}% of cases split the contenders${p.assumed ? ", a guess until the first run" : ", from the last run"}).`,
  ];
}

const COLUMNS = ["#", "CONTENDER", "PASS", "95% CI", "P50", "P95", "COST/RUN", "ERRORS"];

function pairLines(pairs: readonly PairComparison[]): string[] {
  return pairs.map((p) => {
    const verdict = pairVerdictText(p);
    return `${p.a} vs ${p.b}: ${pp(p.diff.mean)} pp (95% CI ${pp(p.diff.lo)} to ${pp(p.diff.hi)}, unadjusted), McNemar p=${p.pAdj < 0.001 ? "<0.001" : p.pAdj.toFixed(3)} (Holm) → ${verdict}`;
  });
}

/** "12 reported, 3 price table, 1 unknown" for one contender's costs. */
export function costSources(s: ContenderSummary): string {
  const label: Record<string, string> = { reported: "reported", configured: "costPerRun", "price-table": "price table", unknown: "unknown" };
  const src: Record<string, number | undefined> = s.costUsd.sources ?? (s.costUsd.known ? { reported: s.costUsd.known } : {});
  return Object.keys(label).filter((k) => src[k]).map((k) => `${src[k]} ${label[k]}`).join(", ") || "-";
}

const tok = (t: ContenderSummary["tokensIn"] | undefined) => (t?.known ? String(Math.round(t.mean)) : "-");

function seedText(r: BenchRun): string {
  return r.seedCommit ? `seed secret (salt ${r.seedCommit.salt.slice(0, 12)}…)` : `seed ${r.seed}`;
}

function printRun(c: CommandContext, r: BenchRun, opts: { failures?: number; cases?: boolean; seedCheck?: SeedCheck } = {}): void {
  const { out } = c;
  const kind = [r.mode === "adhoc" ? "adhoc (not in history)" : undefined, r.status === "incomplete" ? `incomplete: ${r.stopReason ?? "stopped"}` : undefined, r.regradeOf ? `regrade of ${r.regradeOf}` : undefined, r.resumed?.length ? `resumed ${r.resumed.length}x` : undefined].filter(Boolean).join(" · ");
  const fresh = r.cases.filter((x) => !x.anchor).length;
  out.print(`${r.bench} · ${r.date} · ${plural(fresh, "case")}${r.anchor ? ` + ${r.anchor.cases} anchor` : ""} · ${seedText(r)} · sha256 ${r.dataset.sha256.slice(0, 12)}${kind ? ` · ${kind}` : ""}`);
  out.table(COLUMNS, leaderboardRows(r.summaries));
  for (const l of pairLines(r.comparisons)) out.print(l);
  const costly = r.summaries.filter((s) => s.n);
  if (costly.length) out.print(`Cost source: ${costly.map((s) => `${s.contender} ${costSources(s)}`).join("; ")}${r.pricing ? ` (price table checked ${[...new Set(Object.values(r.pricing.updated))].sort().at(-1)})` : ""}`);
  if (costly.some((s) => s.tokensIn?.known || s.tokensOut?.known)) out.print(`Tokens in/out per call: ${costly.map((s) => `${s.contender} ${tok(s.tokensIn)}/${tok(s.tokensOut)}`).join("; ")}`);
  if (r.specialization) {
    out.print("");
    for (const l of specializationLines(r.specialization)) out.print(l);
  }
  if (r.grid) {
    const g = gridText(r.grid);
    out.print("");
    out.print(g.heading);
    out.table(g.columns, g.rows);
    for (const l of g.lines) out.print(l);
  }
  if (r.anchor) {
    out.print("");
    out.print(`Anchor set v${r.anchor.version}: ${plural(r.anchor.cases, "case")}, the same every day since run ${r.anchor.frozenBy} (sha256 ${r.anchor.sha256.slice(0, 12)})`);
    out.table(COLUMNS, leaderboardRows(r.anchor.summaries));
    for (const l of pairLines(r.anchor.comparisons)) out.print(l);
  }
  if (opts.seedCheck) {
    const k = opts.seedCheck;
    if (k.ok) out.print(`Seed: verified. ${k.checks.map((x) => x.detail).join("; ")}`);
    else out.warn(`Seed check failed: ${k.checks.filter((x) => !x.ok).map((x) => x.detail).join("; ")}`);
    if (r.seedCommit?.next) out.print(`Commitment for ${r.seedCommit.next.date}: ${r.seedCommit.next.commitment}`);
  }
  for (const w of r.warnings) out.warn(w);
  if (opts.failures) {
    const byCase = new Map(r.cases.map((x) => [x.id, x]));
    for (const s of r.summaries) {
      const bad = r.cells.filter((x) => x.contender === s.contender && !x.pass).sort((a, b) => a.score - b.score).slice(0, opts.failures);
      if (!bad.length) continue;
      out.print("");
      out.print(`${s.contender} fails on:`);
      for (const x of bad) {
        const input = JSON.stringify(byCase.get(x.caseId)?.input ?? "") ?? "";
        out.print(`  ${x.caseId}  ${x.failure ?? "wrong"}  ${input.length > 60 ? input.slice(0, 59) + "…" : input}${x.sessionId ? `  session ${x.sessionId}` : ""}`);
      }
    }
  }
  if (opts.cases) {
    out.print("");
    out.table(["CASE", "KEY", "SET", "INPUT"], r.cases.map((x) => [x.id, x.key.length > 40 ? x.key.slice(0, 39) + "…" : x.key, x.anchor ? "anchor" : "fresh", (JSON.stringify(x.input) ?? "").slice(0, 80)]));
  }
}

/** Runs pooled for the window estimate: the definition's `window`, else 28. */
function windowFor(c: CommandContext): number {
  const file = findDefinition(c.positionals[0]!, { cwd: c.cwd, env: c.env });
  try {
    return file ? loadDefinition(file).window : 28;
  } catch {
    return 28;
  }
}

/** One warning per changed key (first five), for history. */
function changeLines(changes: readonly ContentChange[]): string[] {
  if (!changes.length) return [];
  const lines = changes.slice(0, 5).map((x) => `${x.anchor ? "anchor case" : "case"} ${x.key.length > 50 ? x.key.slice(0, 49) + "…" : x.key} changed content between ${x.from.date} and ${x.to.date}: its scores before and after measure different things`);
  if (changes.length > 5) lines.push(`… and ${changes.length - 5} more changed cases (--json lists them)`);
  return lines;
}

function runJson(r: BenchRun, withCells = false) {
  const { cells, ...rest } = r;
  return withCells ? r : { ...rest, cells: cells.length };
}

function cliInvocation(): string[] {
  const script = process.argv[1];
  if (script && /(cli\.mjs|main\.ts)$/.test(script) && existsSync(script)) return [process.execPath, realpathSync(script)];
  return ["coding.sh"];
}

export async function run(c: CommandContext): Promise<number> {
  try {
    return await dispatch(c);
  } catch (e) {
    if (e instanceof BenchDefError || e instanceof SourceError || e instanceof DatasetError) throw new CliError(e.message, { reason: e instanceof SourceError ? "source_failed" : "invalid_definition" });
    if (e instanceof BenchRunError) {
      const interrupted = /interrupted/.test(e.message);
      throw new CliError(e.message, { reason: interrupted ? "interrupted" : "run_failed", ...(interrupted ? { exitCode: 130 } : {}), next: e.resume ? ["Continue it:", e.resume] : undefined });
    }
    throw e;
  }
}

async function dispatch(c: CommandContext): Promise<number> {
  const { out, env } = c;
  switch (c.action) {
    case "new": {
      const name = c.positionals[0]!;
      try {
        checkName(name);
      } catch (e) {
        throw new UsageError((e as Error).message, { reason: "invalid_argument" });
      }
      const contenders = list(c.flags.contender).map(parseContender);
      if (contenders.length < 2) {
        throw new UsageError("A benchmark compares at least two contenders: pass --contender NAME=CMD twice", { reason: "missing_argument", suggestion: `coding.sh bench new ${name} --command 'node gen.mjs' -c a='node a.mjs' -c b='node b.mjs'` });
      }
      const graders = (await Promise.all(list(c.flags.grader).map((g) => jsonArg(g, "--grader")))) as GraderSpec[];
      const dir = c.flags.global === true ? benchHome(env) : join(c.cwd, "bench");
      const file = join(dir, `${name}.toml`);
      if (existsSync(file) && c.flags.force !== true) throw new CliError(`${file} already exists`, { reason: "exists", askUser: true, next: ["Edit it, or overwrite it:", `coding.sh bench new ${name} --force …`] });
      const text = renderDefinition({ name, source: sourceFromFlags(c), contenders, graders, cases: positiveInt(c.flags.cases, "cases") ?? 50 });
      try {
        parseDefinition(text, file); // what `run` will parse, checked before writing
      } catch (e) {
        throw new UsageError((e as Error).message, { reason: "invalid_argument" });
      }
      await mkdir(dir, { recursive: true });
      await writeFile(file, text, "utf8");
      const plan = powerPlan(positiveInt(c.flags.cases, "cases") ?? 50, contenders.length);
      if (out.json) out.data({ outcome: "created", name, file, plan });
      else {
        out.ok(`Wrote ${relative(c.cwd, file) || file}`);
        for (const l of planLines(plan)) out.note(l);
        out.next("Run it", `coding.sh bench run ${name}`);
        out.print(file);
      }
      return 0;
    }
    case "run": {
      const def = definitionFor(c, c.positionals[0]!);
      const date = str(c.flags.date);
      const seed = str(c.flags.seed);
      const cases = positiveInt(c.flags.cases, "cases");
      const concurrency = positiveInt(c.flags.concurrency, "concurrency");
      const dryRun = c.flags["dry-run"] === true;
      let resume = c.flags.resume !== undefined && c.flags.resume !== false;
      // --resume <run> and --resume --run <run> are the same.
      const resumeRef = str(c.flags.resume) ?? str(c.flags.run);
      if (str(c.flags.run) && !resume) throw new UsageError("--run picks which run to --resume; add --resume", { reason: "invalid_argument" });
      if (resume) {
        const clash = ["date", "seed", "cases", "adhoc", "dry-run"].filter((f) => c.flags[f] !== undefined && c.flags[f] !== false);
        if (clash.length) throw new UsageError(`--resume continues a stored run with its own seed and cases; drop ${clash.map((f) => `--${f}`).join(", ")}`, { reason: "invalid_argument" });
      }
      // Testing hook: pretend the run starts at this time (simulates daily runs).
      const clock = env.CODING_SH_BENCH_NOW ? (/^\d+$/.test(env.CODING_SH_BENCH_NOW) ? Number(env.CODING_SH_BENCH_NOW) : Date.parse(env.CODING_SH_BENCH_NOW)) : undefined;
      if (clock !== undefined && !Number.isFinite(clock)) throw new UsageError(`CODING_SH_BENCH_NOW must be an ISO time or epoch ms, got ${JSON.stringify(env.CODING_SH_BENCH_NOW)}`);
      // An unfinished run of the same protocol and contenders (crash, Ctrl-C, budget stop): offer to continue it.
      let offered: string | undefined;
      if (!resume && !dryRun && !date && !seed && !cases && c.flags.adhoc !== true) {
        const open = resumeTarget(await listRuns(def.name, env));
        const same = open && open.definition.protocolHash === def.protocolHash && open.contenders.every((x) => !x.hash || x.hash === def.contenderHashes[x.name]) && open.contenders.length === def.contenders.length;
        const live = same ? await JobStore.forEnv(env).get(open.id) : undefined;
        if (same && live?.status !== "running") {
          const what = `${open.id} (${open.date}, ${open.cells.length} calls finished, started ${ago(open.startedAt)})`;
          if (out.interactive) {
            if (await out.confirm(`${def.name} has an unfinished run with the same protocol: ${what}. Resume it?`, { defaultYes: true })) {
              resume = true;
              offered = open.id;
            }
          } else out.note(`${def.name} has an unfinished run with the same protocol: ${what}. Starting a new one; to continue it instead: coding.sh bench run ${def.name} --resume ${open.id}`);
        }
      }
      return withContext(c, async (ctx) => {
        if (def.source.kind === "sessions") await autoIngest(ctx, readIngest(c));
        const evalStore = new FileEvalStore({ env, index: ctx.index });
        const needsAgents = def.contenders.some((x) => x.kind === "agent");
        const adapters = needsAgents ? await import("../../adapters/index.ts") : undefined;
        const spin = out.spin(resume ? `Resuming ${def.name}…` : `Sampling ${def.name}…`);
        let result: BenchRun | DryRunResult;
        const shared = {
          def,
          env,
          ...(concurrency ? { concurrency } : {}),
          ...(clock !== undefined ? { now: clock } : {}),
          index: ctx.index,
          evalStore,
          blobs: ctx.blobs,
          ...(adapters ? { getAdapter: adapters.getAdapter } : {}),
          getBundle: (ref: string) => ctx.index.getBundle(ref),
          graderDeps: { judgeCache: FileJudgeCache.forEnv(env) },
          prices: pricesFor(ctx.config.pricing),
          signal: c.signal,
          ...(c.drain ? { drain: c.drain } : {}),
          onProgress: (done: number, total: number, phase: "sample" | "snapshot" | "run") => spin.update(phase === "sample" ? `Sampling ${def.name}…` : phase === "snapshot" ? `Fetching pages… ${done}/${total}` : `Running ${def.name}… ${done}/${total}`),
        };
        try {
          result = resume
            ? await resumeBench({ ...shared, ...(offered ?? resumeRef ? { run: offered ?? resumeRef! } : {}) })
            : await runBench({
                ...shared,
                ...(date ? { date } : {}),
                ...(seed ? { seed } : {}),
                ...(cases ? { cases } : {}),
                ...(c.flags.adhoc === true ? { adhoc: true } : {}),
                dryRun,
              });
        } finally {
          spin.stop();
        }
        if ("dryRun" in result) {
          const { cases: picked, ...samp } = result.sampling;
          if (out.json) out.data({ outcome: "sampled", ...result, sampling: { ...samp, cases: picked.length } });
          else {
            const fresh = result.cases.filter((x) => !x.anchor).length;
            out.note(`${def.name} · ${result.date} · seed ${result.seed} · ${result.mode} · ${plural(fresh, "case")} from ${result.sampling.candidates} candidates (${result.sampling.excludedSeen} already tested${result.sampling.contentSeen ? `, ${result.sampling.contentSeen} with content already tested` : ""}${result.sampling.capped ? `, ${result.sampling.capped} over a cap` : ""})`);
            if (result.anchor) out.note(`Anchor set v${result.anchor.version}: ${plural(result.anchor.cases, "case")}, ${result.anchor.stored ? "reused from earlier runs" : "picked by this run (then fixed until the version changes)"}`);
            if (result.commitment) out.note(`Secret seed: the salt stays hidden until the run record reveals it (commitment ${result.commitment.slice(0, 16)}…)`);
            out.table(["CASE", "KEY", "INPUT"], result.cases.map((x) => [x.id, x.key.length > 40 ? x.key.slice(0, 39) + "…" : x.key, (JSON.stringify(x.input) ?? "").slice(0, 80)]));
            for (const l of planLines(result.plan)) out.note(l);
            const e = result.estimate;
            out.note(
              e.usd === undefined
                ? `Cost: unknown (no costPerRun and no earlier run reported cost)${result.budgetUsd !== undefined ? `; budget $${result.budgetUsd}` : ""}`
                : `Estimated cost: ${usd(e.usd)} for ${e.calls} calls per contender${e.unknown.length ? ` (unknown for ${e.unknown.join(", ")})` : ""}${result.budgetUsd !== undefined ? `; budget $${result.budgetUsd}${e.usd > result.budgetUsd ? ": over budget, the run would refuse to start" : ""}` : ""}`,
            );
            if (result.redacted) out.warn(`${plural(result.redacted, "case")} contained secrets and would be redacted at freeze`);
          }
          return 0;
        }
        if (out.json) out.data({ outcome: result.status === "incomplete" ? "incomplete" : "completed", run: runJson(result) });
        else {
          const seedCheck = verifySeed(result, await listRuns(def.name, env));
          printRun(c, result, seedCheck ? { seedCheck } : {});
          if (result.status === "incomplete") out.next("Continue it", resumeCommand(def.name, result.id));
          else out.next("See it over time", `coding.sh bench history ${def.name}`);
          out.print(result.id);
        }
        if (result.status === "incomplete") return 1;
        return result.cells.length > 0 && result.cells.every((x) => x.error !== undefined) ? 1 : 0;
      });
    }
    case "list": {
      const defs = listDefinitions({ cwd: c.cwd, env });
      const rows = await Promise.all(
        defs.map(async (d) => {
          const runs = await listRuns(d.name, env);
          const last = historyRuns(runs).at(-1) ?? runs.at(-1);
          return { ...d, runs: runs.length, last };
        }),
      );
      if (out.json) {
        out.data({
          benchmarks: rows.map((d) => ({
            name: d.name,
            file: d.file,
            scope: d.scope,
            ...(d.error ? { error: d.error } : {}),
            ...(d.def ? { source: d.def.source.kind, cases: d.def.cases, contenders: d.def.contenders.map((x) => x.name) } : {}),
            runs: d.runs,
            ...(d.last ? { lastRun: { id: d.last.id, date: d.last.date, leaders: d.last.summaries.filter((s) => s.place === 1).map((s) => s.contender) } } : {}),
          })),
        });
        return 0;
      }
      if (!rows.length) {
        out.note("No benchmarks");
        out.next("Create one", "coding.sh bench new <name> --command '<generator>' -c a='<cmd>' -c b='<cmd>'");
        return 0;
      }
      out.table(
        ["NAME", "SOURCE", "CONTENDERS", "RUNS", "LAST", "LEADER"],
        rows.map((d) => [
          d.name,
          d.def ? d.def.source.kind : `invalid: ${d.error}`,
          d.def ? d.def.contenders.map((x) => x.name).join(", ") : "-",
          String(d.runs),
          d.last?.date ?? "-",
          d.last ? d.last.summaries.filter((s) => s.place === 1).map((s) => s.contender).join(" = ") : "-",
        ]),
      );
      return 0;
    }
    case "show": {
      const name = benchName(c, c.positionals[0]!);
      const all = await runsOrFail(c, name);
      const ref = str(c.flags.run) ?? "latest";
      const r = await getRun(name, ref, env);
      if (!r) throw new CliError(`${name} has no run ${JSON.stringify(ref)}`, { reason: "not_found", next: ["List runs:", `coding.sh bench history ${name}`] });
      const seedCheck = verifySeed(r, all);
      if (out.json) out.data({ run: c.flags.cases === true ? r : runJson(r), ...(seedCheck ? { seedCheck } : {}) });
      else printRun(c, r, { failures: 5, cases: c.flags.cases === true, ...(seedCheck ? { seedCheck } : {}) });
      return seedCheck && !seedCheck.ok ? 1 : 0;
    }
    case "history": {
      const name = benchName(c, c.positionals[0]!);
      const metric = (str(c.flags.metric) ?? "pass") as Metric;
      const limit = positiveInt(c.flags.limit, "limit") ?? 30;
      const all = await runsOrFail(c, name);
      const counted = historyRuns(all);
      const anchor = c.flags.anchor === true;
      const runs = (anchor ? counted.filter((r) => r.anchor) : counted).slice(-limit);
      if (anchor && !runs.length) throw new CliError(`${name} has no counted runs with an anchor set`, { reason: "not_found", next: ["Add one to the definition, then run it:", "[anchor]", "cases = 30"] });
      const vs = str(c.flags.vs);
      if (vs && !runs.some((r) => r.contenders.some((x) => x.name === vs))) throw new UsageError(`--vs ${vs}: no counted run has a contender named ${JSON.stringify(vs)}`, { reason: "invalid_argument" });
      const so = { anchor };
      const s = vs ? vsSeries(runs, vs, so) : series(runs, metric, so);
      const skipped = all.length - counted.length;
      const changes = contentChanges(counted);
      const win = windowFor(c);
      // Window estimate per contender: the last `window` counted runs of its current segment, pooled.
      const pooled = vs
        ? Object.fromEntries(
            Object.entries(s).map(([n, pts]) => {
              const seg = pts.at(-1)?.segment;
              const recent = pts.filter((x) => x.segment === seg && x.value !== null && x.lo !== undefined && x.hi !== undefined).slice(-win);
              return [n, pooledGap(recent.map((x) => ({ value: x.value!, lo: x.lo!, hi: x.hi!, n: x.n })))];
            }),
          )
        : undefined;
      if (out.json) {
        out.data({
          bench: name,
          metric: vs ? "gap" : metric,
          ...(anchor ? { set: "anchor" } : {}),
          ...(vs ? { reference: vs, window: win, pooled } : {}),
          runs: runs.map((r) => ({ id: r.id, date: r.date, seed: r.seed, cases: anchor ? r.anchor!.cases : r.cases.filter((x) => !x.anchor).length, sha256: anchor ? r.anchor!.sha256 : r.dataset.sha256, ...(r.definition.protocolHash ? { protocolHash: r.definition.protocolHash } : {}), ...(r.regradeOf ? { regradeOf: r.regradeOf } : {}) })),
          series: s,
          notCounted: skipped,
          contentChanges: changes,
        });
        return 0;
      }
      if (!runs.length) {
        out.note(`${name} has no counted runs yet: only adhoc or incomplete ones (${all.length}). A plain \`coding.sh bench run ${name}\` starts the history.`);
        return 0;
      }
      const names = Object.keys(s);
      const fmt = (v: number | null) => (v === null ? "-" : vs ? `${pp(v)} pp` : metric === "pass" || metric === "errors" || metric === "score" ? pct(v) : metric === "latency" || metric === "p95" ? ms(v) : metric === "cost" ? usd(v) : String(Math.round(v)));
      const setLabel = anchor ? " · anchor set only (the same cases every day)" : "";
      out.note(vs ? `${name} · pass-rate gap to ${vs} (paired, same cases each day)${setLabel}` : `${name} · ${metric}${setLabel}`);
      out.table(
        ["DATE", "CASES", ...names.map((n) => n.toUpperCase())],
        runs.map((r, i) => [`${r.date}${i > 0 && r.definition.protocolHash && runs[i - 1]!.definition.protocolHash && r.definition.protocolHash !== runs[i - 1]!.definition.protocolHash ? " *" : ""}`, String(anchor ? r.anchor!.cases : r.cases.filter((x) => !x.anchor).length), ...names.map((n) => fmt(s[n]![i]!.value))]),
      );
      if (pooled) {
        for (const [n, g] of Object.entries(pooled)) {
          if (!g) continue;
          out.print(`${n} vs ${vs}, last ${plural(g.k, "run")} pooled: ${pp(g.random.mean)} pp (95% CI ${pp(g.random.lo)} to ${pp(g.random.hi)}${g.predict ? `; a new day: ${pp(g.predict.lo)} to ${pp(g.predict.hi)}` : ""}; day-to-day spread I² ${Math.round(g.i2 * 100)}%)`);
        }
      }
      for (const l of changeLines(changes)) out.warn(l);
      if (runs.some((r, i) => i > 0 && r.definition.protocolHash && runs[i - 1]!.definition.protocolHash && r.definition.protocolHash !== runs[i - 1]!.definition.protocolHash)) out.note("* protocol changed (sampling, source, graders or limits): values before and after are not comparable");
      if (skipped) out.note(`${plural(skipped, "run")} not counted (adhoc, reruns, incomplete or regraded). See them with coding.sh bench show ${name} --run <id>.`);
      return 0;
    }
    case "report": {
      const name = benchName(c, c.positionals[0]!);
      const runs = await runsOrFail(c, name);
      const outDir = resolve(c.cwd, str(c.flags.out) ?? join(benchHome(env), name, "report"));
      const days = positiveInt(c.flags.days, "days") ?? 90;
      const ref = str(c.flags.reference) ?? (() => {
        const file = findDefinition(c.positionals[0]!, { cwd: c.cwd, env });
        try {
          return file ? loadDefinition(file).reference : undefined;
        } catch {
          return undefined;
        }
      })();
      const report = buildReport(runs, { days, viewerUrl: str(c.flags["viewer-url"]) ?? "http://127.0.0.1:4319", ...(ref ? { reference: ref } : {}), window: windowFor(c), includePrivate: c.flags["include-private"] === true });
      await mkdir(outDir, { recursive: true });
      const html = join(outDir, "index.html");
      const json = join(outDir, "report.json");
      await writeFile(json, JSON.stringify(report, null, 2) + "\n", "utf8");
      await writeFile(html, renderReportHtml(report), "utf8");
      if (out.json) out.data({ outcome: "written", html, json, runs: report.runs.length, latest: report.latest.id, private: report.redactedPrivate });
      else {
        out.ok(`${name}: ${plural(report.runs.length, "counted run")}, latest ${report.latest.date}`);
        if (report.redactedPrivate) out.note("Private benchmark: case contents, outputs and session links are left out. Add --include-private for a local-only copy.");
        out.print(html);
      }
      return 0;
    }
    case "regrade": {
      const def = definitionFor(c, c.positionals[0]!);
      const all = await runsOrFail(c, def.name);
      const targets = c.flags.all === true ? historyRuns(all) : [await getRun(def.name, str(c.flags.run) ?? "latest", env)].filter((x): x is BenchRun => !!x);
      if (!targets.length) throw new CliError(`${def.name} has no run ${JSON.stringify(str(c.flags.run) ?? "latest")}`, { reason: "not_found" });
      const done: BenchRun[] = [];
      for (const r of targets) done.push(await regradeRun(r, { def, env, graderDeps: { judgeCache: FileJudgeCache.forEnv(env) }, signal: c.signal }));
      if (out.json) out.data({ outcome: "regraded", runs: done.map((r) => ({ id: r.id, regradeOf: r.regradeOf, date: r.date, leaders: r.summaries.filter((s) => s.place === 1).map((s) => s.contender) })) });
      else {
        for (const r of done) printRun(c, r);
        out.ok(`Regraded ${plural(done.length, "run")} from stored outputs; no contender was called`);
      }
      return 0;
    }
    case "schedule": {
      const def = definitionFor(c, c.positionals[0]!);
      const cwd = def.baseDir;
      const reportDir = str(c.flags["report-dir"]);
      const installing = c.flags["install-cron"] === true || !!str(c.flags["workflow-out"]);
      if (installing && def.budgetUsd === undefined) {
        throw new CliError(`${def.name} has no budget_usd, so it can't be scheduled`, {
          reason: "no_budget",
          next: [`A scheduled run spends money every day with nobody watching. Add a cap to ${relative(c.cwd, def.file) || def.file}:`, "budget_usd = 5", "Printing the schedule (without --install-cron or --workflow-out) works without one."],
        });
      }
      const o = { name: def.name, cwd, cli: cliInvocation(), env, version: version(), secrets: envRefs(def), ...(str(c.flags.at) ? { at: str(c.flags.at)! } : {}), ...(reportDir ? { reportDir: resolve(c.cwd, reportDir) } : {}), ...(str(c.flags.runner) ? { runner: str(c.flags.runner)! } : {}) };
      let line: string;
      let yaml: string;
      try {
        line = cronLine(o);
        yaml = workflowYaml({ ...o, ...(reportDir ? { reportDir } : {}) });
      } catch (e) {
        throw new UsageError((e as Error).message, { reason: "invalid_argument" });
      }
      let installed: { replaced: boolean; changed: boolean } | undefined;
      if (c.flags["install-cron"] === true) {
        await requireConsent(c, `Add a daily ${def.name} run to your crontab?`, `coding.sh bench schedule ${def.name} --install-cron --yes`);
        await mkdir(join(benchHome(env), def.name), { recursive: true });
        installed = installCron(systemCrontab(env), line, def.name);
      }
      const wfOut = str(c.flags["workflow-out"]);
      let workflowFile: string | undefined;
      if (wfOut) {
        workflowFile = resolve(c.cwd, wfOut);
        await mkdir(dirname(workflowFile), { recursive: true });
        await writeFile(workflowFile, yaml, "utf8");
      }
      if (out.json) {
        out.data({ name: def.name, cron: line, workflow: yaml, ...(installed ? { installed: true, replaced: installed.replaced, changed: installed.changed } : { installed: false }), ...(workflowFile ? { workflowFile } : {}) });
        return 0;
      }
      if (def.budgetUsd === undefined) out.warn(`No budget_usd in the definition: add one before installing (--install-cron and --workflow-out refuse without it)`);
      out.print("# crontab line (crontab -e, or rerun with --install-cron):");
      out.print(line);
      out.print("");
      out.print(`# GitHub Actions: .github/workflows/bench-${def.name}.yml`);
      out.print(yaml.trimEnd());
      if (installed) out.ok(installed.changed ? `${installed.replaced ? "Replaced" : "Added"} the ${def.name} line in your crontab` : "Your crontab already has this line");
      if (workflowFile) out.ok(`Wrote ${relative(c.cwd, workflowFile) || workflowFile}`);
      return 0;
    }
  }
  throw new UsageError(`Unknown bench command ${c.action}`);
}
