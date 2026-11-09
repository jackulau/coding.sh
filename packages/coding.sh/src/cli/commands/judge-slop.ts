// coding.sh judge slop [session|run|experiment] [--diff FILE|-]: the agent-slop
// rules (src/graders/slop.ts) over captured work, without a grader file. A
// session is graded on the diffs its file.change events carry (and its
// subagents'), a run on its stored work-tree diff, an experiment run by run
// with a rate per arm. Exit 0 on pass, 1 on fail, 2 when there is nothing to grade.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Context } from "../../core/context.ts";
import type { RunResult } from "../../core/types.ts";
import { looksLikeDiff, SLOP_RULES, selectSlopRules, slopFindings, slopScore, traceDiffs, type SlopReport, type SlopRule, type SlopThresholds } from "../../graders/slop.ts";
import { UsageError } from "../args.ts";
import { autoIngest, list, oneLine, resolveSession, str, withContext, notFoundWithBacklog, readIngest } from "../common.ts";
import { CliError } from "../output.ts";
import type { CommandContext } from "../types.ts";

interface Graded extends SlopReport {
  score: number;
  pass: boolean;
}

function grade(patches: string | readonly string[], rules: readonly SlopRule[], t: SlopThresholds): Graded {
  const r = slopFindings(patches, rules);
  return { ...r, ...slopScore(r, t) };
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const counts = (g: Pick<SlopReport, "errors" | "warnings" | "addedLines">) => `${plural(g.errors, "error")}, ${plural(g.warnings, "warning")} in ${plural(g.addedLines, "added line")}`;

function wholeNumber(v: unknown, flag: string): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new UsageError(`--${flag} must be a whole number >= 0, got ${JSON.stringify(v)}`, { reason: "invalid_argument" });
  return v;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** A session's file.change events and those of its subagent sessions (5 levels, like `show`). */
async function sessionChanges(ctx: Context, id: string, depth = 0, seen = new Set<string>()): Promise<Awaited<ReturnType<Context["index"]["listEvents"]>>> {
  if (depth > 5 || seen.has(id)) return [];
  seen.add(id);
  const own = await ctx.index.listEvents(id, { kinds: ["file.change"] });
  const kids = await ctx.index.listSessions({ parentSessionId: id, limit: 500 });
  for (const k of kids.sort((a, b) => a.startedAt - b.startedAt)) own.push(...(await sessionChanges(ctx, k.id, depth + 1, seen)));
  return own;
}

async function runPatch(ctx: Context, r: RunResult): Promise<string> {
  if (!r.diffBlob) return "";
  const text = await ctx.blobs.getText(r.diffBlob);
  if (text === undefined) throw new CliError(`Run ${r.id}: diff blob ${r.diffBlob} is missing`, { reason: "not_found" });
  return text;
}

function printFindings(c: CommandContext, g: Graded, label: string): void {
  const { out } = c;
  const verdict = g.pass ? out.style("pass", "green") : out.style("fail", "red");
  out.print(`${verdict}  agent-slop  score ${g.score.toFixed(2)}  ${label}  (${counts(g)})`);
  const w = Math.max(0, ...g.findings.map((f) => f.rule.length));
  for (const f of g.findings) out.print(`  ${(f.severity === "error" ? out.style("error", "red") : out.style("warn ", "yellow"))}  ${f.rule.padEnd(w)}  ${f.path}:${f.line}  ${oneLine(f.text, 100)}`);
}

export async function slop(c: CommandContext): Promise<number> {
  const { out } = c;
  if (c.flags["list-rules"] === true) {
    if (out.json) out.data({ rules: SLOP_RULES.map((r) => ({ id: r.id, severity: r.severity, default: !r.optIn, langs: r.langs, ...(r.tests ? { tests: r.tests } : {}), description: r.description })) });
    else for (const r of SLOP_RULES) out.print(`${r.id.padEnd(25)} ${r.severity.padEnd(5)} ${r.optIn ? "opt-in " : "default"}  ${r.description}`);
    return 0;
  }
  let rules: SlopRule[];
  try {
    rules = selectSlopRules(list(c.flags.rules), list(c.flags.exclude));
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e), { reason: "invalid_argument" });
  }
  const maxErrors = wholeNumber(c.flags["max-errors"], "max-errors");
  const maxWarnings = wholeNumber(c.flags["max-warnings"], "max-warnings");
  const t: SlopThresholds = { ...(maxErrors !== undefined ? { maxErrors } : {}), ...(maxWarnings !== undefined ? { maxWarnings } : {}) };
  const ruleIds = rules.map((r) => r.id);
  const diffArg = str(c.flags.diff);
  const ref = c.positionals[0];
  if (diffArg !== undefined && ref !== undefined) throw new UsageError("Pass a session, run or experiment, or --diff, not both", { reason: "invalid_argument" });

  const single = (g: Graded, target: Record<string, unknown>, label: string, extra: Record<string, unknown> = {}): number => {
    if (out.json) out.data({ target, pass: g.pass, score: g.score, errors: g.errors, warnings: g.warnings, addedLines: g.addedLines, findings: g.findings, rules: ruleIds, ...extra });
    else printFindings(c, g, label);
    return g.pass ? 0 : 1;
  };

  if (diffArg !== undefined) {
    let text: string;
    if (diffArg === "-") text = await readStdin();
    else {
      try {
        text = await readFile(resolve(c.cwd, diffArg), "utf8");
      } catch {
        throw new UsageError(`can't read --diff ${JSON.stringify(diffArg)}`, { reason: "invalid_argument" });
      }
    }
    if (text.trim() && !looksLikeDiff(text)) throw new UsageError(`--diff ${diffArg} is not a unified diff (no ---/+++ header and @@ hunk)`, { reason: "invalid_argument" });
    return single(grade(text, rules, t), { kind: "diff", file: diffArg }, diffArg === "-" ? "stdin" : diffArg);
  }

  return withContext(c, async (ctx) => {
    const id = ref ?? "latest";
    if (id.startsWith("exp_")) {
      const runs = (await ctx.index.listRuns({ experimentId: id })).filter((r) => !r.superseded && !r.cancelled);
      if (!runs.length) {
        throw new CliError(`No stored runs in experiment ${id}`, { reason: "no_diff", exitCode: 2, next: ["Harness A/B runs (coding.sh compare) keep the agent's diff; list them:", "coding.sh exp status"] });
      }
      runs.sort((a, b) => a.bundleId.localeCompare(b.bundleId) || a.taskId.localeCompare(b.taskId) || a.attempt - b.attempt);
      const graded: (Graded & { run: RunResult })[] = [];
      for (const r of runs) graded.push({ ...grade(await runPatch(ctx, r), rules, t), run: r });
      const arms: { bundleId: string; name: string; runs: number; passed: number; errors: number; warnings: number; addedLines: number; per100: number; score: number }[] = [];
      for (const bundleId of [...new Set(runs.map((r) => r.bundleId))]) {
        const mine = graded.filter((g) => g.run.bundleId === bundleId);
        const sum = (f: (g: Graded) => number) => mine.reduce((n, g) => n + f(g), 0);
        const name = (await ctx.index.getBundle(bundleId))?.name ?? bundleId;
        const added = sum((g) => g.addedLines);
        arms.push({
          bundleId,
          name,
          runs: mine.length,
          passed: mine.filter((g) => g.pass).length,
          errors: sum((g) => g.errors),
          warnings: sum((g) => g.warnings),
          addedLines: added,
          per100: added ? (sum((g) => g.errors + g.warnings) * 100) / added : 0,
          score: sum((g) => g.score) / mine.length,
        });
      }
      const pass = graded.every((g) => g.pass);
      if (out.json) {
        out.data({
          target: { kind: "experiment", id },
          pass,
          rules: ruleIds,
          arms,
          runs: graded.map((g) => ({ id: g.run.id, bundleId: g.run.bundleId, taskId: g.run.taskId, attempt: g.run.attempt, pass: g.pass, score: g.score, errors: g.errors, warnings: g.warnings, addedLines: g.addedLines, findings: g.findings })),
        });
        return pass ? 0 : 1;
      }
      out.print(`Agent slop in ${id}, by arm`);
      const w = Math.max(...arms.map((a) => a.name.length));
      for (const a of arms) {
        out.print(`  ${a.name.padEnd(w)}  ${a.passed}/${a.runs} runs pass  ${counts(a)}  ${a.per100.toFixed(1)} findings per 100 lines  mean score ${a.score.toFixed(2)}`);
      }
      for (const g of graded.filter((x) => x.findings.length)) {
        out.print();
        printFindings(c, g, `run ${g.run.id} (${arms.find((a) => a.bundleId === g.run.bundleId)?.name ?? g.run.bundleId}, task ${g.run.taskId})`);
      }
      return pass ? 0 : 1;
    }
    if (id.startsWith("run_")) {
      const run = (await ctx.index.listRuns()).find((r) => r.id === id);
      if (!run) throw new CliError(`Can't find run ${JSON.stringify(id)}`, { reason: "not_found", next: ["List runs:", "coding.sh exp status"] });
      return single(grade(await runPatch(ctx, run), rules, t), { kind: "run", id: run.id, bundleId: run.bundleId, taskId: run.taskId }, `run ${run.id}`);
    }
    const backlog = await autoIngest(ctx, readIngest(c));
    const s = await resolveSession(ctx, id).catch((e) => Promise.reject(notFoundWithBacklog(e, backlog)));
    const d = await traceDiffs(await sessionChanges(ctx, s.id), (r) => ctx.blobs.getText(r));
    if (!d.patches.length) {
      throw new CliError(`Session ${s.id} has no captured diffs${d.missing ? ` (${plural(d.missing, "file change")} without one: ${s.agent}'s capture does not record diffs)` : ""}`, {
        reason: "no_diff",
        exitCode: 2,
        next: ["Grade a diff directly:", "git diff | coding.sh judge slop --diff -"],
      });
    }
    if (d.missing) out.warn(`${plural(d.missing, "file change")} in this session carried no diff and were not graded`);
    if (d.truncated) out.warn(`${plural(d.truncated, "diff")} were cut to the inline budget and graded in part`);
    return single(grade(d.patches, rules, t), { kind: "session", id: s.id, agent: s.agent }, `session ${s.id}`, { diffs: d.patches.length, missingDiffs: d.missing, truncatedDiffs: d.truncated });
  });
}
