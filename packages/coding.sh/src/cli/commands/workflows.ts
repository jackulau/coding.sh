// coding.sh workflows list|import|show|stats|score|run|compare|replay
// (docs/design/workflows.md §10). Runs live in the workflow store
// (~/.coding.sh/workflows); agent transcripts go to the index as child sessions.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { commandEnv, sh } from "../../runner/exec.ts";
import { median } from "../../stats/index.ts";
import { profileCache } from "../../core/ingest.ts";
import { claudeWorkflowDriver } from "../../workflows/drivers/claude-workflow.ts";
import { commandDriver } from "../../workflows/drivers/command.ts";
import { compareWorkflowVariants, runWorkflowExperiment, scheduleWorkflowJobs } from "../../workflows/experiment.ts";
import { buildGantt, ganttTsv } from "../../workflows/gantt.ts";
import { claudeProjectsDir, importClaudeWorkflows, type ImportResult } from "../../workflows/import.ts";
import { loadCases } from "../../workflows/cases.ts";
import { replayWorkflow } from "../../workflows/replay.ts";
import { extractFindings, matchFindings, type Finding, type FindingsScore } from "../../workflows/score/findings.ts";
import { verifyConfusion, type VerifyEntry, type VerifyScore } from "../../workflows/score/verify.ts";
import { WorkflowStore } from "../../workflows/store.ts";
import { buildWorkflowTree } from "../../workflows/tree.ts";
import { totalTokens } from "../../workflows/metrics.ts";
import type { DeploymentRule, WorkflowCase, WorkflowDriver,WorkflowFramework, WorkflowNode, WorkflowRun, WorkflowVariant } from "../../workflows/types.ts";
import { sortableId } from "../../core/ids.ts";
import { jobConfig, taskFingerprint } from "../../jobs/config.ts";
import { parseSince, positiveInt, UsageError } from "../args.ts";
import { finishJob, openJob, resumeField, resumeNote, retryFlag, trialTimeout } from "../jobs.ts";
import { jsonArg, num, oneLine, list, requireConsent, resolveSession, str, withContext } from "../common.ts";
import { ago, clean, CliError, duration, plural, tokens, usd, type Output } from "../output.ts";
import type { CommandContext } from "../types.ts";

const FRAMEWORKS: WorkflowFramework[] = ["claude-code-workflow", "claude-agent-sdk", "openai-agents", "langgraph", "crewai", "mastra", "otel", "command", "vercel-workflow", "temporal", "inngest", "restate", "dbos"];

export async function run(c: CommandContext): Promise<number> {
  switch (c.action) {
    case "list":
    case undefined:
      return listRuns(c);
    case "import":
      return importRuns(c);
    case "show":
      return show(c);
    case "stats":
      return stats(c);
    case "score":
      return score(c);
    case "run":
      return runExperiment(c);
    case "compare":
      return compare(c);
    case "replay":
      return replay(c);
    default:
      throw new UsageError(`Unknown workflows action ${JSON.stringify(c.action)}`, { reason: "unknown_action" });
  }
}

// ------------------------------------------------------------ helpers

const storeOf = (c: CommandContext) => WorkflowStore.forEnv(c.env);

/** Cost above which `run` and `replay` ask first (CODING_SH_CONFIRM_ABOVE_USD, default $1). */
export function confirmAboveUsd(env: NodeJS.ProcessEnv): number {
  const v = Number(env.CODING_SH_CONFIRM_ABOVE_USD);
  return env.CODING_SH_CONFIRM_ABOVE_USD !== undefined && env.CODING_SH_CONFIRM_ABOVE_USD !== "" && Number.isFinite(v) && v >= 0 ? v : 1;
}

async function getRunOrFail(store: WorkflowStore, id: string): Promise<{ run: WorkflowRun; nodes: WorkflowNode[] }> {
  const r = await store.getRun(id);
  if (!r) throw new CliError(`Can't find workflow run ${JSON.stringify(id)}`, { reason: "not_found", next: ["List workflow runs:", "coding.sh workflows list"] });
  return r;
}

/**
 * A stored workflow run, else the tree of a captured durable workflow session
 * (OTLP spans from Vercel Workflow, Temporal, …: Session.stats.durable), built
 * from its events on the fly.
 */
async function getRunOrSession(c: CommandContext, id: string): Promise<{ run: WorkflowRun; nodes: WorkflowNode[] }> {
  const stored = await storeOf(c).getRun(id);
  if (stored) return stored;
  const fromSession = await withContext(c, async (ctx) => {
    const s = await resolveSession(ctx, id).catch(() => undefined);
    if (!s?.stats.durable) return undefined;
    const spans = (await ctx.index.listEvents(s.id)).filter((e) => e.spanId);
    return spans.length ? buildWorkflowTree({ spans, runId: s.id }) : undefined;
  });
  return fromSession ?? getRunOrFail(storeOf(c), id);
}

function wallOf(run: WorkflowRun): number | undefined {
  return run.stats.wallMs ?? (run.endedAt !== undefined ? run.endedAt - run.startedAt : undefined);
}

function runJson(run: WorkflowRun): Record<string, unknown> {
  return {
    id: run.id,
    framework: run.framework,
    name: run.name,
    status: run.status,
    startedAt: new Date(run.startedAt).toISOString(),
    endedAt: run.endedAt !== undefined ? new Date(run.endedAt).toISOString() : null,
    wallMs: wallOf(run) ?? null,
    agents: run.stats.agents,
    costUsd: run.stats.costUsd ?? null,
    tokens: totalTokens(run.stats.tokens),
    variant: run.variant ?? null,
    experimentId: run.experimentId ?? null,
    caseId: run.caseId ?? null,
    resumedFrom: run.resumedFrom ?? null,
    hostSessionId: run.hostSessionId ?? null,
    tags: run.tags,
  };
}

/** Imports new or changed Claude Code workflow run dirs (journal + transcripts). */
async function doImport(c: CommandContext, root: string, force: boolean): Promise<ImportResult> {
  const store = storeOf(c);
  // The user-level capture profile: redaction, metadata mode and prices, as backfill uses.
  return withContext(c, (ctx) => importClaudeWorkflows({ root, store, index: ctx.index, blobs: ctx.blobs, force, profile: profileCache(ctx.config, c.env, () => {})(undefined) }));
}

// ------------------------------------------------------------ list / import

async function listRuns(c: CommandContext): Promise<number> {
  const { out } = c;
  const limit = positiveInt(c.flags.limit, "limit") ?? 20;
  const since = str(c.flags.since) !== undefined ? parseSince(str(c.flags.since)!) : undefined;
  const framework = str(c.flags.framework);
  if (framework !== undefined && !FRAMEWORKS.includes(framework as WorkflowFramework)) {
    throw new UsageError(`--framework must be one of ${FRAMEWORKS.join(", ")}`, { reason: "invalid_value" });
  }
  if (c.flags.import !== false) {
    const root = claudeProjectsDir(c.env);
    if (existsSync(root)) {
      const r = await doImport(c, root, false);
      if (r.imported.length) out.note(`Imported ${plural(r.imported.length, "workflow run")}`);
      for (const e of r.errors.slice(0, 3)) out.warn(`Couldn't import ${e.path}: ${e.error}`);
    }
  }
  const runs = await storeOf(c).listRuns({
    ...(framework ? { framework: framework as WorkflowFramework } : {}),
    ...(str(c.flags.name) ? { name: str(c.flags.name)! } : {}),
    ...(str(c.flags.experiment) ? { experimentId: str(c.flags.experiment)! } : {}),
    ...(since !== undefined ? { since } : {}),
    limit,
  });
  if (out.json) {
    out.data({ runs: runs.map(runJson) });
    return 0;
  }
  if (!runs.length) {
    out.note("No workflow runs");
    return 0;
  }
  const tty = out.stdoutTTY;
  out.table(
    ["ID", "NAME", "FRAMEWORK", "STATUS", "STARTED", "WALL", "AGENTS", "COST"],
    runs.map((r) => [
      r.id,
      tty ? oneLine(clean(r.name), 40) : clean(r.name).replace(/[\t\n]+/g, " "),
      r.framework,
      r.status,
      ago(r.startedAt),
      duration(wallOf(r)),
      r.stats.failedAgents || r.stats.nullAgents ? `${r.stats.agents} (${r.stats.failedAgents} failed, ${r.stats.nullAgents} null)` : String(r.stats.agents),
      usd(r.stats.costUsd),
    ]),
  );
  return 0;
}

async function importRuns(c: CommandContext): Promise<number> {
  const { out } = c;
  const root = c.positionals[0] !== undefined ? resolve(c.cwd, c.positionals[0]) : claudeProjectsDir(c.env);
  if (!existsSync(root)) throw new CliError(`Can't find ${root}`, { reason: "not_found", next: ["Pass a Claude Code projects, session or workflow run directory:", "coding.sh workflows import <path>"] });
  const spin = out.spin(`Importing workflow runs from ${root}`);
  let r: ImportResult;
  try {
    r = await doImport(c, root, c.flags.force === true);
  } finally {
    spin.stop();
  }
  if (out.json) {
    out.data({ found: r.found, imported: r.imported.map(runJson), skipped: r.skipped, errors: r.errors });
    return r.errors.length && !r.imported.length && r.found ? 1 : 0;
  }
  for (const run of r.imported) out.print(`${run.id}\t${clean(run.name)}\t${run.status}\t${run.stats.agents} agents`);
  out.ok(`Imported ${plural(r.imported.length, "workflow run")} (${r.skipped} unchanged, ${r.found} found)`);
  for (const e of r.errors) out.warn(`Couldn't import ${e.path}: ${e.error}`);
  return r.errors.length && !r.imported.length && r.found ? 1 : 0;
}

// ------------------------------------------------------------ show / stats

const DETAIL_KINDS = new Set<WorkflowNode["kind"]>(["subagent", "tool", "llm"]);

function nodeLine(n: WorkflowNode): string {
  const dur = n.startedAt !== undefined && n.endedAt !== undefined ? duration(n.endedAt - n.startedAt) : "-";
  const attempt = n.attempt !== undefined && (n.attempts ?? 1) > 1 ? ` #${n.attempt}` : "";
  const label = n.kind === "wait" && n.name === "wait" ? "wait" : `${n.kind} ${clean(n.name) || "(unnamed)"}${attempt}`;
  const parts = [label, n.status, dur];
  if (n.cacheHit) parts.push("replayed on resume");
  if (n.resume) parts.push(n.resume === "wait" ? "resumed after wait" : `resumed after ${n.resume}`);
  if (n.lost) parts.push(n.lostMs ? `lost, then down ${duration(n.lostMs)}` : "lost");
  if (n.usage?.costUsd !== undefined) parts.push(usd(n.usage.costUsd));
  const t = totalTokens(n.usage);
  if (t) parts.push(`${tokens(t)} tok`);
  if (n.model) parts.push(n.model);
  if (n.error) parts.push(`error: ${oneLine(clean(n.error), 60)}`);
  return parts.join("  ");
}

/** Indented tree, children in start order (then ordinal). */
export function renderTree(nodes: readonly WorkflowNode[], full: boolean): string[] {
  const keep = nodes.filter((n) => full || !DETAIL_KINDS.has(n.kind));
  const ids = new Set(keep.map((n) => n.id));
  const kids = new Map<string, WorkflowNode[]>();
  const roots: WorkflowNode[] = [];
  for (const n of keep) {
    if (n.parentId !== undefined && ids.has(n.parentId)) kids.set(n.parentId, [...(kids.get(n.parentId) ?? []), n]);
    else roots.push(n);
  }
  const order = (a: WorkflowNode, b: WorkflowNode) => (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity) || (a.ordinal ?? 0) - (b.ordinal ?? 0) || a.id.localeCompare(b.id);
  const lines: string[] = [];
  const walk = (n: WorkflowNode, depth: number) => {
    lines.push(`${"  ".repeat(depth)}${nodeLine(n)}`);
    for (const k of (kids.get(n.id) ?? []).sort(order)) walk(k, depth + 1);
  };
  for (const r of roots.sort(order)) walk(r, 0);
  return lines;
}

async function show(c: CommandContext): Promise<number> {
  const { out } = c;
  const id = c.positionals[0];
  if (!id) throw new UsageError("Missing <run>", { reason: "missing_argument" });
  const { run, nodes } = await getRunOrSession(c, id);
  const gantt = buildGantt(run, nodes);
  if (out.json) {
    const full = c.flags.tree === true;
    out.data({ run: { ...runJson(run), stats: run.stats }, nodes: full ? nodes : nodes.filter((n) => !DETAIL_KINDS.has(n.kind)), ...(c.flags.gantt === true ? { gantt } : {}) });
    return 0;
  }
  if (c.flags.gantt === true) {
    for (const l of ganttTsv(gantt).replace(/\n$/, "").split("\n")) out.print(l);
    return 0;
  }
  out.row("Run", `${run.id} (${run.framework})`);
  out.row("Workflow", clean(run.name));
  out.row("Status", run.status, run.status === "ok" ? "ok" : run.status === "running" ? "none" : "fail");
  out.row("Wall", `${duration(wallOf(run))}${segmentsText(run.stats)}${run.stats.criticalPathMs !== undefined ? `, critical path ${duration(run.stats.criticalPathMs)}${run.stats.criticalPathExact ? "" : " (approx)"}` : ""}`);
  out.row("Cost", `${usd(run.stats.costUsd)}, ${tokens(totalTokens(run.stats.tokens))} tokens`);
  if (run.resumedFrom) out.row("Resumed from", `${run.resumedFrom} (${run.stats.cacheHits} cached)`);
  else if (run.stats.cacheHits) out.row("Cache hits", `${run.stats.cacheHits} replayed on resume${run.stats.resumeSavedMs !== undefined ? `, saved ${duration(run.stats.resumeSavedMs)}${run.stats.resumeSavedUsd !== undefined ? ` and ${usd(run.stats.resumeSavedUsd)}` : ""}` : ""}`);
  const stopped = stoppedText(run.stats);
  if (stopped) out.row("Stopped", `${stopped} (not failures)`);
  if (run.stats.stepRetries !== undefined || run.stats.waitMs !== undefined) {
    const resumes = nodes.filter((n) => n.resume && n.resume !== "wait").map((n) => `${n.resume} at ${clean(n.name)}`);
    const bits = [plural(run.stats.stepRetries ?? 0, "retry", "retries")];
    if (run.stats.waitMs) bits.push(`${duration(run.stats.waitMs)} waiting`);
    if (run.stats.lostMs) bits.push(`${duration(run.stats.lostMs)} lost to crashes`);
    if (resumes.length) bits.push(`resumed after ${resumes.join(", ")}`);
    out.row("Durable", bits.join(", "));
  }
  out.note();
  for (const l of renderTree(nodes, c.flags.tree === true)) out.print(l);
  return 0;
}

const pct = (x: number | undefined) => (x === undefined || !Number.isFinite(x) ? "-" : `${(x * 100).toFixed(0)}%`);

/** " (active 6h42m over 3 segments)" for a run resumed in place, else "". */
function segmentsText(s: { activeMs?: number; segments?: number }): string {
  return s.segments !== undefined && s.activeMs !== undefined ? ` (active ${duration(s.activeMs)} over ${s.segments} segments)` : "";
}

/** "1 cancelled, 6 superseded", or "" when the run stopped no agent. */
function stoppedText(s: { cancelledAgents?: number; supersededAgents?: number; cancelled?: number; superseded?: number }): string {
  const c = s.cancelledAgents ?? s.cancelled;
  const r = s.supersededAgents ?? s.superseded;
  return [c ? `${c} cancelled` : "", r ? `${r} superseded` : ""].filter(Boolean).join(", ");
}

async function stats(c: CommandContext): Promise<number> {
  const { out } = c;
  const id = c.positionals[0];
  if (!id) throw new UsageError("Missing <run>", { reason: "missing_argument" });
  const { run } = await getRunOrSession(c, id);
  const s = run.stats;
  if (out.json) {
    out.data({ runId: run.id, stats: s });
    return 0;
  }
  const rows: [string, string][] = [
    ["wall", `${duration(s.wallMs)}${segmentsText(s)}`],
    ["critical path", `${duration(s.criticalPathMs)}${s.criticalPathExact ? " (exact)" : " (approx)"}`],
    ["orchestration gap", duration(s.orchestrationGapMs)],
    ...(s.waitMs !== undefined ? [["durable waits", duration(s.waitMs)] as [string, string]] : []),
    ...(s.lostMs !== undefined ? [["lost to crashes", duration(s.lostMs)] as [string, string]] : []),
    ...(s.stepRetries !== undefined ? [["step retries", String(s.stepRetries)] as [string, string]] : []),
    ["agent time", duration(s.agentMs)],
    ["parallelism", s.parallelism !== undefined ? s.parallelism.toFixed(2) : "-"],
    ["utilization", `${pct(s.utilization)}${run.concurrencyCap !== undefined ? ` of cap ${run.concurrencyCap}` : ""}`],
    ["peak concurrency", String(s.peakConcurrency)],
    ["barrier idle", duration(s.barrierIdleMs)],
    ["pipeline savings", duration(s.pipelineSavingsMs)],
    ["queue wait", duration(s.queueWaitMs)],
    ["agents", `${s.agents} (${s.failedAgents} failed ${pct(s.failRate)}, ${s.nullAgents} null ${pct(s.nullRate)})`],
    ...(stoppedText(s) ? [["stopped", `${stoppedText(s)} (not failures)`] as [string, string]] : []),
    ["api retries", String(s.apiRetries)],
    ["schema failures", `${s.schemaFailures} (${s.schemaFinalInvalid} still invalid)`],
    ["cache hits", `${s.cacheHits} (${pct(s.cacheHitRate)})`],
    ["resume saved", s.resumeSavedMs !== undefined || s.resumeSavedUsd !== undefined ? `${duration(s.resumeSavedMs)}, ${usd(s.resumeSavedUsd)}` : "-"],
    ["tokens", tokens(totalTokens(s.tokens))],
    ["cost", usd(s.costUsd)],
  ];
  out.table(["METRIC", "VALUE"], rows);
  if (s.perPhase?.length) {
    out.print();
    out.table(
      ["PHASE", "WALL", "AGENTS", "AGENT TIME", "TOKENS", "COST", "SHARE", "FAILED"],
      s.perPhase.map((p) => [clean(p.phase), duration(p.wallMs), String(p.agents), duration(p.agentMs), tokens(p.tokens), usd(p.costUsd), pct(s.costShareByPhase?.[p.phase]), stoppedText(p) ? `${p.failures} (+${stoppedText(p)})` : String(p.failures)]),
    );
  }
  if (s.perAgent?.length) {
    out.print();
    out.table(
      ["AGENT", "PHASE", "STATUS", "TIME", "TOKENS", "COST", "LLM P50", "TOOLS"],
      s.perAgent.map((a) => [
        oneLine(clean(a.label) + ((a.attempt ?? 1) > 1 ? ` #${a.attempt}` : ""), 40),
        clean(a.phase ?? "-"),
        a.status,
        duration(a.durationMs),
        tokens(a.tokens),
        usd(a.costUsd),
        duration(a.llmP50Ms),
        a.toolErrors ? `${a.toolCalls ?? 0} (${a.toolErrors} failed)` : String(a.toolCalls ?? "-"),
      ]),
    );
  }
  return 0;
}

// ------------------------------------------------------------ score

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Findings that entered a verify stage, with whether verify kept them: output.candidates[{…, survived, votes?}]. */
export function verifyEntries(output: unknown): { findings: Finding[]; entered: VerifyEntry[] } | undefined {
  if (!isObj(output) || !Array.isArray(output.candidates)) return undefined;
  const findings: Finding[] = [];
  const entered: VerifyEntry[] = [];
  for (const cand of output.candidates) {
    if (!isObj(cand) || typeof cand.survived !== "boolean") continue;
    const [f] = extractFindings({ findings: [cand] });
    if (!f) continue;
    const e: VerifyEntry = { findingIdx: findings.length, survived: cand.survived };
    if (Array.isArray(cand.votes) && cand.votes.every((v) => typeof v === "boolean")) e.votes = cand.votes as boolean[];
    findings.push(f);
    entered.push(e);
  }
  return entered.length ? { findings, entered } : undefined;
}

export interface ScoreReport {
  runId: string;
  caseId: string;
  kind: WorkflowCase["truth"]["kind"];
  score: number;
  findings?: FindingsScore & { count: number };
  verify?: VerifyScore;
  verifier?: { command: string; exitCode: number | null; timedOut: boolean };
}

async function score(c: CommandContext): Promise<number> {
  const { out } = c;
  const id = c.positionals[0];
  if (!id) throw new UsageError("Missing <run>", { reason: "missing_argument" });
  const store = storeOf(c);
  const { run } = await getRunOrFail(store, id);
  const caseId = str(c.flags.case) ?? run.caseId;
  if (!caseId) throw new UsageError("Pass --case <id>: the run is not part of an experiment", { reason: "missing_value" });
  const dir = str(c.flags.cases) !== undefined ? resolve(c.cwd, str(c.flags.cases)!) : join(c.cwd, "evals", "workflows", run.name, "cases");
  let cases: WorkflowCase[];
  try {
    cases = await loadCases(dir, run.name, store.blobs);
  } catch (e) {
    throw new CliError(`Can't read cases from ${dir}: ${e instanceof Error ? e.message : String(e)}`, { reason: "invalid_cases", next: ["Point at the cases directory:", `coding.sh workflows score ${run.id} --case ${caseId} --cases <dir>`] });
  }
  const kase = cases.find((k) => k.id === caseId);
  if (!kase) throw new CliError(`Can't find case ${JSON.stringify(caseId)} in ${dir}`, { reason: "not_found", details: [["cases", cases.map((k) => k.id).join(", ") || "(none)"]] });
  const output = run.output ? await store.getValue(run.output) : undefined;
  const report: ScoreReport = { runId: run.id, caseId, kind: kase.truth.kind, score: 0 };
  if (kase.truth.kind === "seeded-bugs") {
    const slack = num(c.flags.slack);
    const findings = extractFindings(output);
    const m = matchFindings(findings, kase.truth.bugs, slack !== undefined ? { slack } : {});
    report.findings = { ...m, count: findings.length };
    report.score = m.f1;
    const v = verifyEntries(output);
    if (v) {
      const real = new Set(matchFindings(v.findings, kase.truth.bugs, slack !== undefined ? { slack } : {}).matches.map(([i]) => i));
      report.verify = verifyConfusion(v.entered, real);
    }
  } else if (kase.truth.kind === "verifier") {
    const r = await sh(kase.truth.command, { cwd: c.cwd, env: commandEnv({ CODING_SH_WORKFLOW_RUN_ID: run.id }), timeoutMs: 30 * 60_000 });
    report.verifier = { command: kase.truth.command, exitCode: r.exitCode, timedOut: r.timedOut };
    report.score = r.exitCode === 0 ? 1 : 0;
  } else {
    throw new CliError(`Case ${caseId} is graded by a judge; the CLI scores seeded-bugs and verifier cases only`, { reason: "unsupported_truth", next: ["Score judge cases through an eval judge:", "coding.sh judge --help"] });
  }
  if (run.experimentId) {
    if (await store.getExperiment(run.experimentId)) await store.setExperimentScore(run.experimentId, run.id, report.score);
  }
  if (out.json) {
    out.data(report);
    return 0;
  }
  out.row("Run", run.id);
  out.row("Case", `${caseId} (${kase.truth.kind})`);
  out.row("Score", report.score.toFixed(3));
  if (report.findings) {
    const f = report.findings;
    out.table(
      ["METRIC", "VALUE"],
      [
        ["findings", String(f.count)],
        ["precision", f.precision.toFixed(3)],
        ["recall", f.recall.toFixed(3)],
        ["f1", f.f1.toFixed(3)],
        ["weighted recall", f.weightedRecall.toFixed(3)],
        ["duplicates", `${f.duplicates} (${pct(f.duplicateRate)})`],
        ["missed bugs", f.missed.join(", ") || "-"],
        ["unmatched findings", f.unmatched.length ? f.unmatched.join(", ") : "-"],
      ],
    );
  }
  if (report.verify) {
    const v = report.verify;
    out.print();
    out.table(
      ["VERIFY", "VALUE"],
      [
        ["entered", String(v.n)],
        ["refute accuracy", pct(v.refuteAccuracy)],
        ["false kill rate", pct(v.falseKillRate)],
        ["false keep rate", pct(v.falseKeepRate)],
        ["kappa", Number.isFinite(v.kappa) ? v.kappa.toFixed(3) : "-"],
      ],
    );
  }
  if (report.verifier) out.print(`verifier exit ${report.verifier.exitCode ?? "-"}${report.verifier.timedOut ? " (timed out)" : ""}`);
  return 0;
}

// ------------------------------------------------------------ run / compare

/** `name=script` (claude), `name=cmd args…` (command), a JSON object, or a .json path. */
export async function parseVariant(raw: string, driver: "claude" | "command"): Promise<WorkflowVariant> {
  const t = raw.trim();
  let v: unknown;
  if (t.startsWith("{")) v = await jsonArg(t, "--variant");
  else if (!t.includes("=") && extname(t) === ".json") v = await jsonArg(t, "--variant");
  else {
    const eq = t.indexOf("=");
    const name = eq > 0 ? t.slice(0, eq).trim() : basename(t, extname(t));
    const value = eq > 0 ? t.slice(eq + 1).trim() : t;
    if (!name || !value) throw new UsageError(`--variant ${JSON.stringify(raw)} needs a name and a ${driver === "claude" ? "script" : "command"}`, { reason: "invalid_value" });
    return driver === "claude" ? { name, script: value } : { name, command: value.split(/\s+/) };
  }
  if (!isObj(v) || typeof v.name !== "string" || !v.name) throw new UsageError(`--variant JSON needs a "name"`, { reason: "invalid_value" });
  const out: WorkflowVariant = { name: v.name };
  if (typeof v.script === "string") out.script = v.script;
  if (Array.isArray(v.command) && v.command.every((x) => typeof x === "string")) out.command = v.command as string[];
  else if (typeof v.command === "string") out.command = v.command.split(/\s+/);
  if (v.args !== undefined) out.args = v.args;
  if (typeof v.resumeFromRunId === "string") out.resumeFromRunId = v.resumeFromRunId;
  return out;
}

/** Median cost of past runs of this workflow × jobs, when any past run has a cost. */
export async function estimateCost(store: WorkflowStore, workflow: string, jobs: number): Promise<{ perRun: number; total: number; basis: number } | undefined> {
  const costs = (await store.listRuns({ name: workflow, limit: 50 })).map((r) => r.stats.costUsd).filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  if (!costs.length) return undefined;
  const perRun = median(costs);
  return { perRun, total: perRun * jobs, basis: costs.length };
}

async function confirmCost(c: CommandContext, what: string, est: number | undefined, rerun: string): Promise<void> {
  const limit = confirmAboveUsd(c.env);
  if (est !== undefined && est <= limit) return;
  const cost = est === undefined ? "unknown cost" : `estimated ${usd(est)}`;
  await requireConsent(c, `${what} (${cost}, confirm threshold ${usd(limit)})?`, rerun);
}

function driverFor(c: CommandContext, kind: "claude" | "command"): WorkflowDriver {
  const bin = str(c.flags.bin);
  const timeoutMs = trialTimeout(c);
  const t = timeoutMs !== undefined ? { timeoutMs } : {};
  return kind === "claude" ? claudeWorkflowDriver({ cwd: c.cwd, env: c.env, ...(bin ? { bin } : {}), ...t }) : commandDriver({ cwd: c.cwd, ...t });
}

async function runExperiment(c: CommandContext): Promise<number> {
  const { out } = c;
  const workflow = c.positionals[0];
  if (!workflow) throw new UsageError("Missing <workflow>", { reason: "missing_argument" });
  const driverKind = (str(c.flags.driver) ?? "claude") as "claude" | "command";
  if (driverKind !== "claude" && driverKind !== "command") throw new UsageError("--driver must be claude or command", { reason: "invalid_value" });
  const rawVariants = list(c.flags.variant);
  if (!rawVariants.length) throw new UsageError("Pass at least one --variant", { reason: "missing_value" });
  const variants = await Promise.all(rawVariants.map((v) => parseVariant(v, driverKind)));
  const names = new Set<string>();
  for (const v of variants) {
    if (names.has(v.name)) throw new UsageError(`Variant name ${JSON.stringify(v.name)} is used twice`, { reason: "invalid_value" });
    names.add(v.name);
    if (driverKind === "claude" && !v.script) throw new UsageError(`Variant ${JSON.stringify(v.name)} needs a script for the claude driver`, { reason: "invalid_value" });
    if (driverKind === "command" && !v.command && !v.script) throw new UsageError(`Variant ${JSON.stringify(v.name)} needs a command`, { reason: "invalid_value" });
  }
  const k = positiveInt(c.flags.k, "k") ?? 3;
  const concurrency = positiveInt(c.flags.concurrency, "concurrency") ?? 1;
  const split = str(c.flags.split) as WorkflowCase["split"] | undefined;
  if (split !== undefined && split !== "dev" && split !== "heldout") throw new UsageError("--split must be dev or heldout", { reason: "invalid_value" });
  const store = storeOf(c);
  const dir = str(c.flags.cases) !== undefined ? resolve(c.cwd, str(c.flags.cases)!) : join(c.cwd, "evals", "workflows", workflow, "cases");
  let cases: WorkflowCase[];
  try {
    cases = await loadCases(dir, workflow, store.blobs, split);
  } catch (e) {
    throw new CliError(`Can't read cases from ${dir}: ${e instanceof Error ? e.message : String(e)}`, { reason: "invalid_cases", next: ["Point at the cases directory:", `coding.sh workflows run ${workflow} --cases <dir> --variant …`] });
  }
  if (!cases.length) throw new CliError(`No cases in ${dir}${split ? ` for split ${split}` : ""}`, { reason: "no_cases", next: ["Add cases as TOML files:", `${dir}/<case>.toml`] });
  const jobs = scheduleWorkflowJobs(cases, variants, k).length;
  const est = await estimateCost(store, workflow, jobs);
  if (est) out.note(`Estimated cost ${usd(est.total)} (${plural(jobs, "run")} × median ${usd(est.perRun)} over ${plural(est.basis, "past run")})`);
  else out.note(`${plural(jobs, "run")}; no past runs of ${workflow} to estimate cost from`);
  await confirmCost(c, `Run ${plural(jobs, "workflow run")}`, est?.total, `coding.sh workflows run ${workflow} … --yes`);
  const driver = driverFor(c, driverKind);
  // Durable: each finished run is checkpointed; --resume continues an interrupted experiment.
  const config = jobConfig({
    workflow,
    driver: driverKind,
    variants: variants.map((v) => ({ ...v, files: taskFingerprint({ kind: "command", command: v.script ?? v.command?.[0] ?? "", args: v.command?.slice(1) ?? [] }, c.cwd) })),
    cases,
    k,
    timeoutMs: trialTimeout(c),
  });
  const job = await openJob(c, { kind: "workflows run", name: workflow, config, newId: () => sortableId("wfx_"), concurrency });
  const spin = out.spin(`Running ${plural(jobs, "workflow run")}`);
  let result: Awaited<ReturnType<typeof runWorkflowExperiment>>;
  try {
    result = await job.guard(() =>
      withContext(c, (ctx) =>
        runWorkflowExperiment({
          workflow,
          variants,
          cases,
          k,
          driver,
          store,
          index: ctx.index,
          concurrency,
          signal: c.signal,
          ...(c.drain ? { drain: c.drain } : {}),
          job: job.scope(),
          retry: retryFlag(c),
          experimentId: job.id,
          onProgress: (p) =>
            spin.update(`Running workflow runs: ${p.done}/${p.total} (${p.run.variant} on ${p.run.caseId}: ${p.run.status}${p.score !== undefined ? `, score ${p.score.toFixed(2)}` : ""})`),
        }),
      ),
    );
  } finally {
    spin.stop();
  }
  await finishJob(job, result.cancelled);
  const failed = result.runs.filter((r) => r.status === "failed").length;
  const infra = result.runs.filter((r) => r.infra).length;
  if (out.json) {
    out.data({
      outcome: result.cancelled ? "cancelled" : "completed",
      experimentId: result.experimentId,
      runs: result.runs.map((r) => ({ ...runJson(r), score: result.scores.get(r.id) ?? null })),
      failed,
      ...(infra ? { infra } : {}),
      ...resumeField(job),
    });
    return result.cancelled ? 1 : 0;
  }
  out.print(result.experimentId);
  if (result.cancelled) {
    out.warn(`Cancelled after ${plural(result.runs.length, "workflow run")} of ${jobs}`);
    resumeNote(c, job);
    return 1;
  }
  out.ok(`Ran ${plural(result.runs.length, "workflow run")}${failed ? `, ${failed} failed` : ""}${infra ? `, ${infra} hit infrastructure errors` : ""}`);
  resumeNote(c, job);
  if (variants.length >= 2) out.next("Compare two variants", `coding.sh workflows compare ${result.experimentId} --baseline ${variants[0]!.name} --candidate ${variants[1]!.name}`);
  return 0;
}

const ci = (b: { mean: number; lo: number; hi: number }, f: (x: number) => string) => `${f(b.mean)} [${f(b.lo)}, ${f(b.hi)}]`;
const signedMs = (x: number) => `${x < 0 ? "-" : "+"}${duration(Math.abs(x))}`;
const signedUsd = (x: number) => `${x < 0 ? "-" : "+"}${usd(Math.abs(x))}`;
const fixed3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : "-");

/** --select and its knobs as a DeploymentRule; min-cost defaults to 10 points below the baseline (PS-MinCost). */
function deploymentRule(c: CommandContext, baseline: string): DeploymentRule | undefined {
  const kind = str(c.flags.select);
  const qMin = num(c.flags["q-min"]);
  const qDrop = num(c.flags["q-drop"]);
  const lambda = num(c.flags.lambda);
  const stray = (names: [string, number | undefined][]) => names.filter(([, v]) => v !== undefined).map(([n]) => `--${n}`);
  const usage = (msg: string) => new UsageError(msg, { reason: "invalid_value" });
  if (kind === undefined) {
    const given = stray([["q-min", qMin], ["q-drop", qDrop], ["lambda", lambda]]);
    if (given.length) throw usage(`${given.join(" and ")} needs --select (min-cost for --q-min / --q-drop, weighted for --lambda)`);
    return undefined;
  }
  if (kind === "min-cost") {
    if (lambda !== undefined) throw usage("--lambda goes with --select weighted, not min-cost");
    if (qMin !== undefined && qDrop !== undefined) throw usage("Pass --q-min or --q-drop, not both");
    if (qDrop !== undefined && !(qDrop >= 0)) throw usage("--q-drop is points of quality, 0 or more");
    return qMin !== undefined ? { kind, qMin } : { kind, qDropFrom: { variant: baseline, pp: qDrop ?? 10 } };
  }
  if (kind === "weighted") {
    const given = stray([["q-min", qMin], ["q-drop", qDrop]]);
    if (given.length) throw usage(`${given.join(" and ")} go${given.length === 1 ? "es" : ""} with --select min-cost, not weighted`);
    if (lambda === undefined || !(lambda >= 0)) throw usage("--select weighted needs --lambda <λ ≥ 0> (quality given up per USD)");
    return { kind, lambda };
  }
  if (kind === "pareto") {
    const given = stray([["q-min", qMin], ["q-drop", qDrop], ["lambda", lambda]]);
    if (given.length) throw usage(`--select pareto takes no ${given.join(" or ")}`);
    return { kind };
  }
  throw usage(`--select must be one of min-cost, weighted, pareto, got ${JSON.stringify(kind)}`);
}

async function compare(c: CommandContext): Promise<number> {
  const { out } = c;
  const id = c.positionals[0];
  if (!id) throw new UsageError("Missing <experiment>", { reason: "missing_argument" });
  const baseline = str(c.flags.baseline);
  const candidate = str(c.flags.candidate);
  if (!baseline || !candidate) throw new UsageError("Pass --baseline <variant> and --candidate <variant>", { reason: "missing_value" });
  const select = deploymentRule(c, baseline);
  const store = storeOf(c);
  const exp = await store.getExperiment(id);
  if (!exp) throw new CliError(`Can't find workflow experiment ${JSON.stringify(id)}`, { reason: "not_found", next: ["Start one:", "coding.sh workflows run <workflow> --variant …"] });
  for (const v of [baseline, candidate]) {
    if (!exp.variants.some((x) => x.name === v)) throw new UsageError(`Experiment ${id} has no variant ${JSON.stringify(v)} (variants: ${exp.variants.map((x) => x.name).join(", ")})`, { reason: "invalid_value" });
  }
  // Membership: the record's runs plus any run stored under this experiment that
  // never made it into the record (a crash between putRun and the record append).
  const runIds = new Set([...exp.runIds, ...(await store.listRuns({ experimentId: id })).map((r) => r.id)]);
  const runs: WorkflowRun[] = [];
  for (const rid of runIds) {
    const r = await store.getRun(rid);
    if (r) runs.push(r.run);
  }
  const threshold = num(c.flags.threshold);
  const seed = num(c.flags.seed);
  const report = compareWorkflowVariants(runs, new Map(Object.entries(exp.scores)), { baseline, candidate, ...(threshold !== undefined ? { threshold } : {}), ...(seed !== undefined ? { seed } : {}), ...(select ? { select } : {}) });
  if (out.json) {
    out.data({ experimentId: id, ...report });
    return 0;
  }
  printCompare(out, report);
  return 0;
}

function printCompare(out: Output, r: ReturnType<typeof compareWorkflowVariants>): void {
  out.print(r.verdict.text);
  out.print();
  const fmt = (key: string) => (key === "costUsd" ? usd : key === "quality" ? fixed3 : duration);
  const signed = (key: string) => (key === "costUsd" ? signedUsd : key === "quality" ? (x: number) => (x >= 0 ? "+" : "") + fixed3(x) : signedMs);
  out.table(
    ["METRIC", r.baseline.toUpperCase(), r.candidate.toUpperCase(), "DIFF [CI]", "PAIRS"],
    [r.quality, ...r.metrics].map((m) => [m.key, fmt(m.key)(m.baseline), fmt(m.key)(m.candidate), m.pairs ? ci(m.diff, signed(m.key)) : "-", String(m.pairs)]),
  );
  out.print(`mcnemar: ${r.mcnemar.b} baseline-only passes, ${r.mcnemar.c} candidate-only passes, p=${fixed3(r.mcnemar.p)}`);
  if (r.pareto.length) {
    out.print();
    out.table(
      ["VARIANT", "CASES", "QUALITY", "COST", "WALL", "PARETO"],
      r.pareto.map((p) => {
        const front = p.pFront !== undefined ? `front ${p.pFront.toFixed(2)}` : "front";
        return [p.variant, String(p.cases), ci(p.quality, fixed3), ci(p.costUsd, usd), ci(p.wallMs, duration), p.dominated ? `dominated by ${(p.dominatedBy ?? []).join(", ")}${p.pFront !== undefined ? ` (${front})` : ""}` : front];
      }),
    );
  }
  if (r.deployment) {
    const d = r.deployment;
    const rule = d.rule.kind === "weighted" ? `weighted λ=${d.rule.lambda}` : d.rule.kind;
    out.print(`deploy: ${d.picked.length ? d.picked.join(", ") : "none"} (${rule}: ${d.reason})`);
  }
  if (r.stages.length) {
    out.print();
    out.table(
      ["PHASE", "COST DIFF", "WALL DIFF", "AGENT TIME DIFF"],
      r.stages.map((s) => [clean(s.phase), s.deltaCostUsd !== undefined ? signedUsd(s.deltaCostUsd) : "-", s.deltaWallMs !== undefined ? signedMs(s.deltaWallMs) : "-", signedMs(s.deltaAgentMs)]),
    );
  }
  if (r.unpairedCases.length) out.warn(`Unpaired cases (left out): ${r.unpairedCases.join(", ")}`);
  for (const n of r.notes) out.note(n);
}

// ------------------------------------------------------------ replay

async function replay(c: CommandContext): Promise<number> {
  const { out } = c;
  const id = c.positionals[0];
  if (!id) throw new UsageError("Missing <run>", { reason: "missing_argument" });
  const scriptFlag = str(c.flags.script);
  if (!scriptFlag) throw new UsageError("Pass --script <path> (the edited workflow script)", { reason: "missing_value" });
  const store = storeOf(c);
  const base = await getRunOrFail(store, id);
  const script = resolve(c.cwd, scriptFlag);
  let editedScript: string;
  try {
    editedScript = await readFile(script, "utf8");
  } catch {
    throw new UsageError(`Can't read --script ${JSON.stringify(scriptFlag)}`, { reason: "invalid_value" });
  }
  let baseScript: string | undefined;
  const baseFlag = str(c.flags["base-script"]);
  if (baseFlag) {
    try {
      baseScript = await readFile(resolve(c.cwd, baseFlag), "utf8");
    } catch {
      throw new UsageError(`Can't read --base-script ${JSON.stringify(baseFlag)}`, { reason: "invalid_value" });
    }
  } else if (base.run.script) baseScript = await store.getText(base.run.script);
  if (baseScript === undefined) throw new CliError(`Run ${id} has no captured script`, { reason: "missing_script", next: ["Pass the script the run used:", `coding.sh workflows replay ${id} --script ${scriptFlag} --base-script <path>`] });
  const args = str(c.flags.args) !== undefined ? await jsonArg(str(c.flags.args)!, "--args") : undefined;
  const dryRun = c.flags["dry-run"] === true;
  const opts = { base, baseScript, script, editedScript, driver: driverFor(c, "claude"), store, dryRun, ...(args !== undefined ? { args } : {}) };
  const predicted = await replayWorkflow({ ...opts, dryRun: true });
  let res = predicted;
  if (!dryRun) {
    const p = predicted.prediction;
    await confirmCost(c, `Replay ${id} (${p.total - p.hits} of ${p.total} agent calls re-run)`, p.estimatedUsd, `coding.sh workflows replay ${id} --script ${scriptFlag} --yes`);
    const spin = out.spin(`Replaying ${id}`);
    try {
      res = await replayWorkflow(opts);
    } finally {
      spin.stop();
    }
  }
  const p = res.prediction;
  if (out.json) {
    out.data({ baseRunId: id, prediction: p, run: res.run ? { ...runJson(res.run), stats: res.run.stats } : null });
    return 0;
  }
  out.row("Cached (est.)", `${p.hits} of ${p.total} agent calls (heuristic)`);
  if (p.firstMiss) out.row("First re-run", `#${p.firstMiss.ordinal} ${clean(p.firstMiss.label)}`);
  if (p.estimatedUsd !== undefined) out.row("Re-run cost", `${usd(p.estimatedUsd)} (from the base run)`);
  out.note(p.reason);
  if (res.run) {
    out.print(res.run.id);
    out.ok(`Replayed: ${res.run.stats.cacheHits} of ${res.run.stats.agents} agent calls cached${res.run.stats.resumeSavedUsd !== undefined ? `, saved ${usd(res.run.stats.resumeSavedUsd)}` : ""}`);
  } else if (!dryRun) {
    out.warn("The replay ran but its run directory was not found; import it later with: coding.sh workflows import");
  }
  return 0;
}
