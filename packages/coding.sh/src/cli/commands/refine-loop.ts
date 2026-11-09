// coding.sh refine propose|test|apply|rollback|log|run: the harness-edit loop
// (R2-7, R2-8). A candidate is a CLAUDE.md, AGENTS.md, rule or skill edit. A
// round checks it before any model call (protected lines, Z-13; the harmless
// and duplicate critics), A/Bs it against the repo's current files on the
// decision points `exp ab` mines (same runner, judge, cache and acceptance
// gate), holds it to the tasks earlier kept edits won (AB-3), reports what it
// preserved (Y-3), and writes the round to the ledger. `apply` writes a kept
// candidate with a backup; `run` loops propose → test → apply until the
// rounds, the budget or the e-detector (exp plateau) says stop.
import { readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { Context } from "../../core/context.ts";
import { createDataset } from "../../datasets/dataset.ts";
import { FileEvalStore } from "../../datasets/store.ts";
import type { Case, Dataset, ExperimentResult } from "../../datasets/types.ts";
import type { Anchor } from "../../eval/decision.ts";
import { insideDir } from "../../eval/decision.ts";
import type { ContextFile } from "../../experiments/continuation.ts";
import { plateau, plateauLine, type PlateauResult } from "../../experiments/plateau.ts";
import { signedPct } from "../../experiments/text.ts";
import { outcomesByCase } from "../../experiments/turnover.ts";
import { providerFromSpec } from "../../graders/index.ts";
import { runCritics, type CriticCheck } from "../../refine/critics.ts";
import { decideRound, type RoundDecision } from "../../refine/decide.ts";
import { flagFindings, type Finding } from "../../refine/findings.ts";
import { checkGuard, guardSet, type GuardCheck, type GuardSet } from "../../refine/guard.ts";
import { rankKeeps, type Outcomes } from "../../refine/keep.ts";
import {
  appendLedger,
  currentShas,
  guardEntries,
  ledgerFile,
  liveApplies,
  loadCandidate,
  readLedger,
  refineDir,
  saveCandidate,
  sha,
  tests,
  writeApply,
  writeRollback,
  type ApplyEntry,
  type LedgerEntry,
  type TestEntry,
} from "../../refine/ledger.ts";
import { candidateId, parseProposal, proposalCandidate, proposalPrompt, PROPOSAL_SCHEMA } from "../../refine/propose.ts";
import { checkProtected, protectedLines, type HarnessText, type ProtectCheck } from "../../refine/protect.ts";
import type { GateOpts } from "../../stats/tests.ts";
import { positiveInt, UsageError } from "../args.ts";
import { sh } from "../../runner/exec.ts";
import { gateFlags, list, num, str, withContext } from "../common.ts";
import { CliError, plural } from "../output.ts";
import { infraStopNote } from "../jobs.ts";
import { protectOptions, protectOverrides } from "../protect.ts";
import type { CommandContext } from "../types.ts";
import { targetPath as targetPathOf } from "../../refine/target.ts";
import {
  abOptions,
  baseURLFor,
  costText,
  estimatePair,
  gitRoot,
  harnessFilesIn,
  isHarnessPath,
  judgeSpec,
  metered,
  mineDecisionPoints,
  money,
  newSpend,
  pickAnchors,
  providerDefaultModel,
  readyCli,
  resolveArm,
  runPair,
  trialSetup,
  type AbOptions,
  type Arm,
  type Estimate,
  type MinedCases,
  type Spend,
  type TrialSetup,
} from "./exp-ab.ts";

// ---------------------------------------------------------------- setup

export interface Env {
  c: CommandContext;
  ctx: Context;
  store: FileEvalStore;
  /** The repo (git root, else cwd): base files come from here and apply writes here. */
  root: string;
  /** This repo's refine dir: ledger, candidates, backups. */
  dir: string;
  o: AbOptions;
  anchors: Anchor[];
  gate: GateOpts;
  protect: { protect: string[]; autoProtect: boolean };
  allow: string[];
  maxGuard: number;
}

export interface Candidate {
  id: string;
  label: string;
  source: "file" | "proposal";
  /** The candidate's whole harness: the base with its files swapped in. */
  arm: Arm;
  /** Files that differ from the base. */
  changed: HarnessText[];
  findings?: string[];
  rationale?: string;
}

const CANDIDATE_ID = /^r_[0-9a-f]{10}$/;
const pathOrder = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

export async function setupEnv(c: CommandContext, ctx: Context): Promise<Env> {
  const git = gitRoot(c.cwd);
  const root = git ?? c.cwd;
  const o = abOptions(c, git, {});
  if (o.autoProvider && !c.out.json) c.out.note(o.autoProvider);
  if (!o.dryRun) readyCli(o, c.env, (l) => c.out.warn(l));
  const anchors = await pickAnchors(o, c.cwd);
  const { files: _f, ...protect } = protectOptions(c);
  const maxGuard = c.flags["max-guard"] === undefined ? 24 : Number(c.flags["max-guard"]);
  if (!(Number.isInteger(maxGuard) && maxGuard >= 0)) throw new UsageError(`--max-guard must be a whole number of at least 0, got ${String(c.flags["max-guard"])}`, { reason: "invalid_argument" });
  return {
    c,
    ctx,
    store: new FileEvalStore({ env: c.env, index: ctx.index }),
    root,
    dir: refineDir(c.env, root),
    o,
    anchors,
    gate: gateFlags({ ...c.flags, gate: true })!,
    protect,
    allow: protectOverrides(c.flags["allow-protected-edit"]),
    maxGuard,
  };
}

export const baseArm = (root: string): Arm => ({ label: "current files", files: harnessFilesIn(root), watch: [] });

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * A single edited file stands in for the harness file it names: its own
 * repo-relative path when that is a harness path (`.claude/rules/x.md`),
 * else the repo's file with the same name (`./drafts/CLAUDE.md` → `CLAUDE.md`).
 */
function fileCandidate(v: string, cwd: string, root: string, base: Arm): Arm {
  const abs = resolve(cwd, v);
  const rel = relative(root, abs).replace(/\\/g, "/");
  const inside = !rel.startsWith("..") && !isAbsolute(rel);
  const name = basename(abs);
  const path = inside && isHarnessPath(rel) ? rel : base.files.some((f) => f.path === name) || isHarnessPath(name) ? name : undefined;
  if (!path) {
    throw new UsageError(`Candidate ${v} is not a harness file: name it after the file it replaces (CLAUDE.md, AGENTS.md, GEMINI.md), or put it at its repo path (.claude/rules/…, .claude/skills/<name>/SKILL.md)`, {
      reason: "invalid_argument",
      suggestion: "coding.sh refine test ./drafts/AGENTS.md",
    });
  }
  const text = readFileSync(abs, "utf8");
  return { label: v, files: [...base.files.filter((f) => f.path !== path), { path, text }].sort(pathOrder), watch: [] };
}

/** A candidate from `r_…` (a stored candidate), a file, a directory, `git:REV` or a bundle, laid over the base. */
export async function resolveCandidate(e: Pick<Env, "c" | "ctx" | "root" | "dir">, v: string, base: Arm, extra: { source?: "proposal"; findings?: string[]; rationale?: string } = {}): Promise<Candidate> {
  let arm: Arm;
  let source: Candidate["source"] = extra.source ?? "file";
  let findings = extra.findings;
  let rationale = extra.rationale;
  if (CANDIDATE_ID.test(v)) {
    const stored = loadCandidate(e.dir, v);
    if (!stored) throw new UsageError(`No stored candidate ${v} for this repo`, { reason: "not_found", suggestion: "coding.sh refine log" });
    const paths = new Set(stored.files.map((f) => f.path));
    arm = { label: v, files: [...base.files.filter((f) => !paths.has(f.path)), ...stored.files].sort(pathOrder), watch: [] };
    source = stored.source;
    findings ??= stored.findings;
    rationale ??= stored.rationale;
  } else if (isFile(resolve(e.c.cwd, v))) {
    arm = fileCandidate(v, e.c.cwd, e.root, base);
  } else {
    arm = await resolveArm(v, { cwd: e.c.cwd, root: e.root, base: base.files, flag: "candidate", ctx: e.ctx });
  }
  const before = new Map(base.files.map((f) => [f.path, f.text]));
  const removed = base.files.filter((f) => !arm.files.some((x) => x.path === f.path)).map((f) => f.path);
  if (removed.length) {
    throw new UsageError(`Candidate ${v} drops ${removed.join(", ")}: refine tests and applies added or edited files only`, { reason: "invalid_argument", suggestion: "pass the edited file itself, e.g. coding.sh refine test ./drafts/AGENTS.md" });
  }
  const changed = arm.files.filter((f) => before.get(f.path) !== f.text).map((f) => ({ path: f.path, text: f.text }));
  if (!changed.length) throw new UsageError(`Candidate ${v} has the same harness files as the repo: nothing to test`, { reason: "invalid_argument" });
  const id = candidateId(changed);
  saveCandidate(e.dir, { id, files: changed, source, ...(findings ? { findings } : {}), ...(rationale ? { rationale } : {}) });
  return { id, label: CANDIDATE_ID.test(v) ? v : arm.label, source, arm, changed, ...(findings ? { findings } : {}), ...(rationale ? { rationale } : {}) };
}

// ---------------------------------------------------------------- the guard set

interface GuardPlan {
  set: GuardSet;
  /** Guard tasks this round's dev runs already cover. */
  fromDev: string[];
  /** Guard cases from earlier rounds' datasets, run again on both arms. */
  rerun: Case[];
  /** Guard tasks whose case is in no stored dataset. */
  missing: string[];
}

async function guardPlan(e: Env, entries: readonly LedgerEntry[], dev: ReadonlyMap<string, Case>): Promise<GuardPlan> {
  const set = guardSet(guardEntries(entries), { maxGuard: e.maxGuard });
  const fromDev = set.tasks.filter((t) => dev.has(t));
  const want = new Set(set.tasks.filter((t) => !dev.has(t)));
  const found = new Map<string, Case>();
  const seen = new Set<string>();
  for (const t of [...tests(entries)].reverse()) {
    if (!want.size) break;
    if (!t.dataset || !t.guardTasks.some((x) => want.has(x))) continue;
    const key = `${t.dataset.id}@${t.dataset.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const ds = await e.store.getDataset(t.dataset.id, t.dataset.version).catch(() => undefined);
    for (const c of ds?.cases ?? []) {
      if (want.has(c.id)) {
        found.set(c.id, c);
        want.delete(c.id);
      }
    }
  }
  return { set, fromDev, rerun: set.tasks.filter((t) => found.has(t)).map((t) => found.get(t)!), missing: [...want] };
}

/** One line on the guard set for a plan: its size and where its tasks come from. */
function guardPlanText(g: GuardPlan): string {
  if (!g.set.tasks.length) return "none yet (no earlier kept edit won a task)";
  const from = [`${g.fromDev.length} in this round's decision points`, `${g.rerun.length} to rerun`, ...(g.missing.length ? [`${g.missing.length} no longer stored`] : [])];
  return `${plural(g.set.tasks.length, "task")} earlier kept edits won (${from.join(", ")})${g.set.note ? `; ${g.set.note}` : ""}`;
}

async function guardDataset(e: Env, cases: readonly Case[]): Promise<Dataset> {
  const { duplicates: _d, ...ds } = createDataset({ name: `refine-guard-${e.dir.split(/[\\/]/).pop()}`, cases: [...cases], dedupe: false, description: "Decision points earlier kept refine edits won (AB-3 guard set)" });
  await e.store.putDataset(ds);
  return ds;
}

// ---------------------------------------------------------------- one round

interface Plan {
  base: Arm;
  candidates: Candidate[];
  checks: Map<string, { protect: ProtectCheck; critics: CriticCheck }>;
  mined?: MinedCases;
  setup?: TrialSetup;
  guard?: GuardPlan;
  estimate?: { usd: number | undefined; calls: number; uncached: number };
}

const sumEstimates = (xs: readonly Estimate[]) => ({
  usd: xs.some((x) => x.usd === undefined) ? undefined : xs.reduce((s, x) => s + x.usd!, 0),
  calls: xs.reduce((s, x) => s + x.calls + x.judgeCalls, 0),
  uncached: xs.reduce((s, x) => s + x.uncached + x.judgeCalls, 0),
});

/** Everything before the first paid call: checks, decision points, guard set and the estimate. */
async function planRound(e: Env, base: Arm, candidates: Candidate[], entries: readonly LedgerEntry[]): Promise<Plan> {
  const checks = new Map<string, { protect: ProtectCheck; critics: CriticCheck }>();
  for (const k of candidates) checks.set(k.id, { protect: checkProtected(base.files, k.arm.files, { ...e.protect, allow: e.allow }), critics: runCritics(base.files, k.arm.files) });
  const live = candidates.filter((k) => checks.get(k.id)!.protect.ok && checks.get(k.id)!.critics.ok);
  if (!live.length) return { base, candidates, checks };
  const mined = await mineDecisionPoints(e.c, e.o, e.ctx, e.store, e.anchors, "coding.sh refine test");
  const setup = trialSetup(e.o, mined.cases, e.c.env);
  const guard = await guardPlan(e, entries, mined.caseMap);
  const ests: Estimate[] = [];
  for (const k of live) {
    ests.push(estimatePair(setup, base, k.arm, mined.cases));
    if (guard.rerun.length) ests.push(estimatePair(setup, base, k.arm, guard.rerun));
  }
  return { base, candidates, checks, mined, setup, guard, estimate: sumEstimates(ests) };
}

function overBudget(e: Env, plan: Plan, left: number | undefined): void {
  const est = plan.estimate;
  if (left === undefined || est?.usd === undefined || est.usd <= left) return;
  throw new CliError(`Estimated cost ${money(est.usd)} is over the ${money(left)} left of --max-cost (${est.uncached} uncached calls)`, {
    reason: "over_budget",
    next: ["Test on fewer decision points, or raise the cap:", `coding.sh refine test … --limit ${Math.max(1, Math.floor(((plan.mined?.cases.length ?? 1) * left) / est.usd))}`],
  });
}

interface Tested {
  cand: Candidate;
  decision: RoundDecision;
  entry: TestEntry;
}

const solvedMajority = (xs: readonly boolean[]) => xs.filter(Boolean).length * 2 >= xs.length;

/** Runs the planned round, appends one ledger entry per candidate and returns them. */
async function runRound(e: Env, plan: Plan, spend: Spend, cap: number | undefined): Promise<Tested[]> {
  const entries = readLedger(e.dir);
  let round = tests(entries).length;
  const covered = guardEntries(entries).filter((g) => !g.rolledBack).flatMap((g) => g.guardTasks ?? []);
  const results: { cand: Candidate; decision: RoundDecision; effect?: TestEntry["effect"]; gate?: TestEntry["gate"]; guard?: TestEntry["guard"]; experiments?: TestEntry["experiments"]; usd: number; unpriced: number }[] = [];
  const guardDsPromise = plan.guard?.rerun.length ? guardDataset(e, plan.guard.rerun) : undefined;
  for (const cand of plan.candidates) {
    const { protect, critics } = plan.checks.get(cand.id)!;
    const before = { usd: spend.usd + spend.judgeUsd, unpriced: spend.unpriced };
    const cost = () => ({ usd: spend.usd + spend.judgeUsd - before.usd, unpriced: spend.unpriced - before.unpriced });
    if (!protect.ok || !critics.ok || !plan.mined || !plan.setup) {
      results.push({ cand, decision: decideRound({ protect, critics }), ...cost() });
      continue;
    }
    if ((e.c.drain ?? e.c.signal).aborted) break;
    const { mined, setup } = plan;
    const run = await runPair(e.c, e.store, setup, mined.dataset, mined.caseMap, plan.base, cand.arm, { spend, gate: e.gate, ...(cap !== undefined ? { maxCost: cap } : {}), name: `refine-${cand.id}` });
    if (run.limited) e.c.out.warn(`Stopped: ${run.limited}`);
    infraStopNote(e.c, run.ab.a.infraStop);
    const devA = outcomesByCase(run.ab.a.runs);
    const devB = outcomesByCase(run.ab.b.runs);
    const cmp = run.comparison;
    const experiments: NonNullable<TestEntry["experiments"]> = { devA: run.ab.a.id, devB: run.ab.b.id };
    let guardCheck: GuardCheck | undefined;
    let guardStopped: "budget" | "interrupted" | undefined;
    let guardInfo: TestEntry["guard"];
    const g = plan.guard!;
    if (cmp?.gate?.verdict === "ship" && g.set.tasks.length) {
      const base = new Map<string, readonly boolean[]>();
      const candO = new Map<string, readonly boolean[]>();
      for (const t of g.fromDev) {
        if (devA.has(t)) base.set(t, devA.get(t)!);
        if (devB.has(t)) candO.set(t, devB.get(t)!);
      }
      if (g.rerun.length) {
        const ds = await guardDsPromise!;
        const gr = await runPair(e.c, e.store, setup, ds, new Map(g.rerun.map((x) => [x.id, x])), plan.base, cand.arm, { spend, gate: e.gate, ...(cap !== undefined ? { maxCost: cap } : {}), name: `refine-guard-${cand.id}` });
        experiments.guardA = gr.ab.a.id;
        experiments.guardB = gr.ab.b.id;
        if (!gr.comparison) guardStopped = gr.overBudget ? "budget" : "interrupted";
        for (const [t, xs] of outcomesByCase(gr.ab.a.runs)) base.set(t, xs);
        for (const [t, xs] of outcomesByCase(gr.ab.b.runs)) candO.set(t, xs);
      }
      if (!guardStopped) guardCheck = checkGuard(g.set, { base: base as Outcomes, cand: candO as Outcomes }, e.gate);
      guardInfo = {
        size: g.set.tasks.length,
        fromDev: g.fromDev.length,
        rerun: g.rerun.length,
        missing: g.missing.length,
        dropped: g.set.dropped,
        ok: guardCheck?.ok ?? false,
        verdict: guardCheck?.verdict ?? "stopped",
        forgets: guardCheck?.forgets ?? [],
        forgotten: guardCheck?.forgotten ?? [],
      };
    }
    const decision = decideRound({
      protect,
      critics,
      dev: { outcomes: { base: devA, cand: devB }, ...(cmp?.gate ? { gate: cmp.gate } : {}), ...(cmp ? {} : { stopped: run.overBudget ? "budget" : "interrupted" }) },
      ...(guardCheck || guardStopped ? { guard: { ...(guardCheck ? { check: guardCheck } : {}), ...(guardStopped ? { stopped: guardStopped } : {}) } } : {}),
      covered,
    });
    results.push({
      cand,
      decision,
      ...(cmp ? { effect: { mean: cmp.diff.mean, lo: cmp.diff.lo, hi: cmp.diff.hi, paired: cmp.paired } } : {}),
      ...(cmp?.gate ? { gate: { verdict: cmp.gate.verdict, wins: cmp.gate.wins, losses: cmp.gate.losses, solved: cmp.gate.solved, p: cmp.gate.p } } : {}),
      ...(guardInfo ? { guard: guardInfo } : {}),
      experiments,
      ...cost(),
    });
    if (!cmp && !run.overBudget) break; // interrupted: test nothing more
    if (cap !== undefined && spend.usd + spend.judgeUsd > cap) break;
  }

  // Y-3: several keeps from one invocation — only the best is the round's winner.
  const keeps = results.filter((r) => r.decision.verdict === "keep" && r.effect);
  const ranking =
    keeps.length > 1
      ? rankKeeps(
          keeps.map((r) => ({
            id: r.cand.id,
            effect: { mean: r.effect!.mean, lo: r.effect!.lo, hi: r.effect!.hi },
            R: r.decision.preservation?.R ?? 0,
          })),
        )
      : undefined;
  const out: Tested[] = [];
  const at = new Date().toISOString();
  for (const r of results) {
    const d = r.decision;
    const base = r.cand.changed.flatMap((f) => {
      const b = plan.base.files.find((x) => x.path === f.path);
      return b ? [{ path: b.path, sha: sha(b.text) }] : [];
    });
    const pos = ranking?.order.indexOf(r.cand.id) ?? -1;
    const entry: TestEntry = {
      op: "test",
      id: r.cand.id,
      round: ++round,
      at,
      candidate: {
        label: r.cand.label,
        source: r.cand.source,
        files: r.cand.changed.map((f) => ({ path: f.path, sha: sha(f.text) })),
        added: plan.checks.get(r.cand.id)!.critics.added.slice(0, 40).map((a) => a.text),
        ...(r.cand.findings ? { findings: r.cand.findings } : {}),
        ...(r.cand.rationale ? { rationale: r.cand.rationale } : {}),
      },
      base,
      verdict: d.verdict,
      stage: d.stage,
      reasons: d.reasons,
      ...(ranking && pos >= 0 ? { rank: { position: pos + 1, of: ranking.order.length, winner: pos === 0, ...(pos === 0 ? { reason: ranking.reason, tied: ranking.tied } : {}) } } : {}),
      ...(r.effect ? { effect: r.effect } : {}),
      ...(r.gate ? { gate: r.gate } : {}),
      ...(r.guard ? { guard: r.guard } : {}),
      ...(d.preservation ? { preservation: { gained: d.preservation.dev.gained.length, lost: d.preservation.dev.lost.length, regressed: d.preservation.regressed, R: d.preservation.R, reasons: d.preservation.reasons } } : {}),
      ...(d.alternative?.alternative ? { alternative: { uniqueGains: d.alternative.uniqueGains } } : {}),
      guardTasks: d.guardTasks,
      ...(plan.mined && r.experiments ? { dataset: { id: plan.mined.dataset.id, version: plan.mined.dataset.version, cases: plan.mined.cases.length } } : {}),
      ...(r.experiments ? { experiments: r.experiments } : {}),
      ...(plan.setup && r.experiments ? { model: plan.setup.model } : {}),
      cost: { usd: r.usd, unpriced: r.unpriced },
    };
    appendLedger(e.dir, entry);
    out.push({ cand: r.cand, decision: d, entry });
  }
  return out;
}

// ---------------------------------------------------------------- plateau

/** exp plateau over the ledger's dev runs: the first round's baseline, then each candidate, kept winners as accepted. */
async function refinePlateau(store: FileEvalStore, entries: readonly LedgerEntry[]): Promise<PlateauResult | undefined> {
  const rounds = tests(entries).filter((t) => t.experiments);
  if (!rounds.length) return undefined;
  const first = await store.getExperiment(rounds[0]!.experiments!.devA);
  if (!first) return undefined;
  const series: ExperimentResult[] = [first];
  for (const t of rounds) {
    const x = await store.getExperiment(t.experiments!.devB);
    if (!x) continue;
    series.push({ ...x, name: t.id, metadata: { ...x.metadata, accepted: t.verdict === "keep" && (t.rank?.winner ?? true) } });
  }
  return series.length > 1 ? plateau(series) : undefined;
}

const plateauJson = (p: PlateauResult | undefined) =>
  p ? { status: p.status, incumbent: p.incumbent.name, ...(p.recommend ? { recommend: p.recommend.name, changePoint: p.changePoint } : {}), rounds: p.rounds.length, warnings: p.warnings } : undefined;

// ---------------------------------------------------------------- printing

const pp = (x: number) => signedPct(x, 0);
const effectText = (t: TestEntry): string => (t.effect ? `${pp(t.effect.mean)} [${pp(t.effect.lo)}, ${pp(t.effect.hi)}]` : "—");
const guardText = (t: TestEntry): string => {
  const g = t.guard;
  if (!g) return t.stage === "done" ? "no tasks" : "—";
  if (!g.ok) return g.verdict === "stopped" ? "stopped" : `forgets ${g.forgets.join(", ")}`;
  return `holds ${g.size}`;
};

function printTested(c: CommandContext, plan: Plan, done: readonly Tested[]): void {
  const { out } = c;
  for (const { cand, decision: d, entry: t } of done) {
    const chk = plan.checks.get(cand.id)!;
    out.print(`${cand.id}  ${cand.label === cand.id ? "" : `${cand.label} `}(${cand.changed.map((f) => f.path).join(", ")}; +${plural(chk.critics.added.length, "line")})`);
    out.print(`  protected  ${chk.protect.ok ? `ok (${plural(chk.protect.protected.length, "protected line")} in place)` : chk.protect.rejections.map((r) => r.reason).join("; ")}`);
    out.print(`  critics    ${chk.critics.ok ? "ok" : chk.critics.rejections.map((r) => r.reason).join("; ")}`);
    if (t.experiments && plan.mined) {
      const g = t.gate;
      out.print(`  dev        ${plural(plan.mined.cases.length, "decision point")} | effect ${effectText(t)} | ${g ? `B wins ${g.wins}, loses ${g.losses}; A solved ${g.solved}` : "stopped"}`);
      if (t.guard) {
        const gd = t.guard;
        const src = `${gd.fromDev} from this run, ${gd.rerun} rerun${gd.missing ? `, ${gd.missing} missing` : ""}`;
        out.print(`  guard      ${plural(gd.size, "task")} earlier kept edits won (${src}) | ${gd.ok ? `holds (${gd.verdict})` : gd.verdict === "stopped" ? "stopped" : `forgets kept edit ${gd.forgets.join(", ")}`}`);
      }
      if (t.preservation) out.print(`  preserved  gained ${t.preservation.gained}, lost ${t.preservation.lost}, ${plural(t.preservation.R, "task")} regressed`);
    }
    if (t.rank) out.print(`  rank       ${t.rank.position} of ${t.rank.of}${t.rank.winner ? ` (${t.rank.reason})` : ""}`);
    out.print(`  verdict    ${t.verdict}: ${d.reasons.join("; ")}`);
    out.print("");
  }
}

// ---------------------------------------------------------------- propose

interface Proposed {
  cand: Candidate;
  lines: string[];
  findings: Finding[];
}

export function defaultTarget(base: readonly ContextFile[]): string {
  for (const p of ["AGENTS.md", "CLAUDE.md", "GEMINI.md"]) if (base.some((f) => f.path === p)) return p;
  return base[0]?.path ?? "AGENTS.md";
}

async function findingsFor(e: Env): Promise<Finding[]> {
  const sessions = (await e.ctx.index.listSessions({ parentSessionId: null, runId: null, since: e.o.since, limit: 2000 })).filter(
    (s) => s.startedAt >= e.o.since && (!e.o.agents.length || e.o.agents.includes(s.agent)) && (!e.o.repo || insideDir(e.o.repo, s.cwd) || insideDir(e.o.repo, s.repo?.root)),
  );
  return flagFindings(sessions, { limit: 5 });
}

export function proposerModel(e: Env): string {
  const m = str(e.c.flags["proposer-model"]) ?? e.o.judgeModel ?? e.o.model ?? providerDefaultModel(e.o.provider);
  if (!m) throw new UsageError("--provider openai-compatible has no default model: pass --proposer-model", { reason: "missing_argument" });
  return m;
}

/** The prompt for the next proposal (no model call). */
async function proposalInput(e: Env, base: Arm) {
  const findings = await findingsFor(e);
  const targetPath = targetPathOf(str(e.c.flags.target), e.root) ?? defaultTarget(base.files);
  const target = base.files.find((f) => f.path === targetPath) ?? { path: targetPath, text: "" };
  const rejected = tests(readLedger(e.dir))
    .filter((t) => t.verdict !== "keep")
    .map((t) => ({ id: t.id, verdict: t.verdict, reasons: t.reasons, added: t.candidate.added }));
  const prompt = proposalPrompt({ findings, target, protectedLines: protectedLines(base.files, e.protect), rejected });
  return { findings, target, prompt };
}

/**
 * The proposer's reply: from --proposer-command (the system and user prompt on
 * stdin, the reply on stdout), else from the provider's model.
 */
export async function proposerReply(e: Env, spend: Spend, req: { system: string; user: string; schema: Record<string, unknown> }): Promise<string> {
  const cmd = str(e.c.flags["proposer-command"]);
  if (cmd) {
    const r = await sh(cmd, { cwd: e.root, env: e.c.env, stdin: `${req.system}\n\n${req.user}\n`, timeoutMs: 600_000, tailBytes: 1 << 20, signal: e.c.signal });
    if (r.exitCode !== 0) {
      throw new CliError(`--proposer-command exited ${r.timedOut ? "after the 10 minute limit" : String(r.exitCode)}: ${r.stderrTail.trim().slice(-400) || "no output on stderr"}`, { reason: "proposer_failed" });
    }
    return r.stdoutTail;
  }
  const spec = { ...judgeSpec(e.o, baseURLFor(e.o, e.c.env)), model: proposerModel(e), name: "refine-proposer" };
  const provider = metered(providerFromSpec(spec, { env: e.c.env }), spend, () => {});
  const res = await provider.complete({ system: req.system, user: req.user, jsonSchema: req.schema, signal: e.c.signal }).catch((err: unknown) => {
    // The provider's message says "to call the judge"; here it is the proposer.
    const key = /set (\w+) to call the judge/.exec(err instanceof Error ? err.message : "")?.[1];
    if (!key) throw err;
    throw new CliError(`refine asks a model to write the edit: set ${key}`, { reason: "missing_key", next: ["Without an API key, list what to fix and the line that fixes it:", "coding.sh improve"] });
  });
  return res.text;
}

/** Who writes the edits: the --proposer-command, else the proposer model. */
export const proposerName = (e: Env): string => str(e.c.flags["proposer-command"]) ?? proposerModel(e);

export async function propose(e: Env, base: Arm, spend: Spend): Promise<Proposed> {
  const { findings, target, prompt } = await proposalInput(e, base);
  const text = await proposerReply(e, spend, { system: prompt.system, user: prompt.user, schema: PROPOSAL_SCHEMA });
  let p;
  try {
    p = parseProposal(text);
  } catch (err) {
    throw new CliError(`The proposer's reply is not a usable edit: ${(err as Error).message}`, { reason: "bad_proposal", next: ["Try again, or write the edit yourself and test it:", "coding.sh refine test ./drafts/AGENTS.md"] });
  }
  const made = proposalCandidate(target, p);
  saveCandidate(e.dir, { id: made.id, files: [made.file], source: "proposal", findings: findings.map((f) => f.id), rationale: p.rationale });
  const cand = await resolveCandidate(e, made.id, base, { source: "proposal", findings: findings.map((f) => f.id), rationale: p.rationale });
  return { cand, lines: p.lines, findings };
}

// ---------------------------------------------------------------- apply / rollback

interface Applied {
  entry: ApplyEntry;
  test: TestEntry;
}

export function applyCandidate(root: string, dir: string, id: string | undefined, force: boolean): Applied {
  const entries = readLedger(dir);
  const all = tests(entries);
  const live = liveApplies(entries);
  const test = id
    ? [...all].reverse().find((t) => t.id === id)
    : [...all].reverse().find((t) => t.verdict === "keep" && (t.rank?.winner ?? true) && !live.some((a) => a.candidate === t.id));
  if (!test) {
    if (id) throw new CliError(`No refine round tested ${id} in this repo`, { reason: "not_found", next: ["See the rounds:", "coding.sh refine log"] });
    throw new CliError("No kept candidate waiting to be applied", { reason: "not_found", next: ["Test a candidate first:", "coding.sh refine test ./drafts/AGENTS.md"] });
  }
  const forced: string[] = [];
  if (test.verdict !== "keep") {
    if (!force) throw new CliError(`${test.id} was not kept (${test.verdict}: ${test.reasons[0] ?? "no reason"})`, { reason: "not_kept", askUser: true, next: ["Apply it anyway (recorded in the ledger):", `coding.sh refine apply ${test.id} --force`] });
    forced.push(`verdict ${test.verdict}`);
  }
  const stored = loadCandidate(dir, test.id);
  if (!stored) throw new CliError(`The files of ${test.id} are gone from ${join(dir, "candidates")}`, { reason: "not_found" });
  const now = currentShas(root, stored.files.map((f) => f.path));
  if (stored.files.every((f) => now.get(f.path) === sha(f.text))) throw new CliError(`${test.id} is already in the working tree`, { reason: "already_applied", exitCode: 0 });
  const was = new Map(test.base.map((b) => [b.path, b.sha]));
  const moved = stored.files.filter((f) => (now.get(f.path) ?? null) !== (was.get(f.path) ?? null)).map((f) => f.path);
  if (moved.length) {
    if (!force) throw new CliError(`${moved.join(", ")} changed since ${test.id} was tested; its result may not hold for the new text`, { reason: "files_changed", next: ["Test it again on the current files:", `coding.sh refine test ${test.id}`] });
    forced.push(`changed since the test: ${moved.join(", ")}`);
  }
  const applyId = `a_${sha(`${test.id}\u0000${Date.now()}\u0000${process.pid}`).slice(0, 10)}`;
  const files = writeApply(dir, root, applyId, stored.files);
  const entry: ApplyEntry = { op: "apply", id: applyId, candidate: test.id, at: new Date().toISOString(), files, ...(forced.length ? { forced: forced.join("; ") } : {}) };
  appendLedger(dir, entry);
  return { entry, test };
}

export function printApplied(c: CommandContext, dir: string, a: Applied): void {
  const files = a.entry.files.map((f) => `${f.path}${f.before === null ? " (new)" : ""}`).join(", ");
  c.out.ok(`Applied ${a.test.id} to ${files}${a.entry.forced ? ` (forced: ${a.entry.forced})` : ""}`);
  if (a.entry.files.some((f) => f.before !== null)) c.out.note(`Backup in ${join(dir, "backups", a.entry.id)}`);
}

// ---------------------------------------------------------------- commands

async function testCommand(c: CommandContext, e: Env): Promise<number> {
  const { out } = c;
  if (!c.positionals.length) throw new UsageError("Name the candidate(s) to test: a file, a directory, git:REV, a bundle or a stored r_… id", { reason: "missing_argument", suggestion: "coding.sh refine test ./drafts/AGENTS.md" });
  const base = baseArm(e.root);
  const cands: Candidate[] = [];
  for (const v of c.positionals) {
    const k = await resolveCandidate(e, v, base);
    if (!cands.some((x) => x.id === k.id)) cands.push(k);
  }
  const entries = readLedger(e.dir);
  const plan = await planRound(e, base, cands, entries);
  overBudget(e, plan, e.o.maxCost);
  if (e.o.dryRun) return printPlan(c, e, plan);
  if (!out.json && plan.estimate?.uncached) out.note(`About ${plan.estimate.usd === undefined ? "an unknown cost" : costText(plan.estimate.usd, e.o.provider)} for up to ${plan.estimate.uncached} uncached model and judge calls`);
  const spend = newSpend();
  const done = await runRound(e, plan, spend, e.o.maxCost);
  const p = await refinePlateau(e.store, readLedger(e.dir));
  if (out.json) {
    out.data({ ledger: ledgerFile(e.dir), rounds: done.map((d) => d.entry), spent: spendJson(spend), plateau: plateauJson(p) });
  } else {
    printTested(c, plan, done);
    out.print(`Spent ${costText(spend.usd + spend.judgeUsd, e.o.provider)}${spend.unpriced ? "+" : ""} (${spend.cached} of ${spend.calls} next-turn calls cached, ${spend.judgeCalls} judge calls)`);
    if (p) out.print(plateauLine("refine", p));
    const win = done.find((d) => d.entry.verdict === "keep" && (d.entry.rank?.winner ?? true));
    if (win) out.next("Write the kept edit to your files (with a backup)", `coding.sh refine apply ${win.entry.id}`);
    else out.next("See every round", "coding.sh refine log");
  }
  return done.some((d) => d.entry.verdict === "keep") ? 0 : 1;
}

export const spendJson = (s: Spend) => ({ usd: s.usd + s.judgeUsd, model: s.usd, judge: s.judgeUsd, unpriced: s.unpriced, calls: s.calls, cached: s.cached, judgeCalls: s.judgeCalls });

function planJson(e: Env, plan: Plan) {
  return {
    dryRun: true,
    ledger: ledgerFile(e.dir),
    base: { files: plan.base.files.map((f) => f.path) },
    candidates: plan.candidates.map((k) => {
      const chk = plan.checks.get(k.id)!;
      return { id: k.id, label: k.label, files: k.changed.map((f) => f.path), added: chk.critics.added.length, protected: { ok: chk.protect.ok, rejections: chk.protect.rejections.map((r) => r.reason) }, critics: { ok: chk.critics.ok, rejections: chk.critics.rejections.map((r) => r.reason) } };
    }),
    ...(plan.mined ? { dataset: { id: plan.mined.dataset.id, version: plan.mined.dataset.version, cases: plan.mined.cases.length, sessions: plan.mined.mined.sessions }, perAnchor: plan.mined.mined.perAnchor } : {}),
    ...(plan.setup ? { model: plan.setup.model, judgeModel: plan.setup.judgeModel } : {}),
    ...(plan.guard ? { guard: { size: plan.guard.set.tasks.length, fromDev: plan.guard.fromDev.length, rerun: plan.guard.rerun.length, missing: plan.guard.missing.length, dropped: plan.guard.set.dropped, ...(plan.guard.set.note ? { note: plan.guard.set.note } : {}) } } : {}),
    ...(plan.estimate ? { estimate: plan.estimate } : {}),
    ...(e.o.maxCost !== undefined ? { maxCost: e.o.maxCost } : {}),
  };
}

function printPlan(c: CommandContext, e: Env, plan: Plan): number {
  const { out } = c;
  if (out.json) {
    out.data(planJson(e, plan));
    return 0;
  }
  out.print(`Base: ${plan.base.label} (${plural(plan.base.files.length, "file")})`);
  for (const k of plan.candidates) {
    const chk = plan.checks.get(k.id)!;
    const pre = !chk.protect.ok ? `rejected before any call: ${chk.protect.rejections[0]!.reason}` : !chk.critics.ok ? `rejected before any call: ${chk.critics.rejections[0]!.reason}` : "passes the protected-line and critic checks";
    out.print(`${k.id}  ${k.label === k.id ? k.changed.map((f) => f.path).join(", ") : k.label} (+${plural(chk.critics.added.length, "line")}): ${pre}`);
  }
  if (plan.mined && plan.setup && plan.guard && plan.estimate) {
    out.print(`Dev: ${plural(plan.mined.cases.length, "decision point")} from ${plural(plan.mined.mined.sessions, "session")} since ${e.o.sinceText}, ${plan.setup.model}, ${plural(e.o.trials, "trial")} per case and arm`);
    const g = plan.guard;
    out.print(`Guard: ${guardPlanText(g)}`);
    out.print(`Would make up to ${plan.estimate.uncached} uncached model and judge calls: ${plan.estimate.usd === undefined ? "cost unknown (no price for the model)" : `~${costText(plan.estimate.usd, e.o.provider)}`}${e.o.maxCost !== undefined ? ` of --max-cost ${money(e.o.maxCost)}` : ""}`);
  } else out.print("No model calls: every candidate is rejected before the trial");
  return 0;
}

async function proposeCommand(c: CommandContext, e: Env): Promise<number> {
  const { out } = c;
  const base = baseArm(e.root);
  if (e.o.dryRun) {
    const { findings, target, prompt } = await proposalInput(e, base);
    if (out.json) {
      out.data({ dryRun: true, target: target.path, model: proposerModel(e), findings, prompt });
      return 0;
    }
    out.print(`Target: ${target.path}${target.text ? "" : " (new file)"}; proposer ${proposerModel(e)}`);
    out.print(findings.length ? `Findings: ${findings.map((f) => `${f.flag} ${f.diagnosis.severity.level} ${f.diagnosis.severity.score}`).join(", ")}` : "Findings: none (no diagnosed session flags since then)");
    out.print("");
    out.print(prompt.user);
    return 0;
  }
  const spend = newSpend();
  const p = await propose(e, base, spend);
  if (out.json) {
    out.data({ id: p.cand.id, target: p.cand.changed.map((f) => f.path), lines: p.lines, rationale: p.cand.rationale ?? "", findings: p.findings.map((f) => ({ id: f.id, level: f.diagnosis.severity.level, score: f.diagnosis.severity.score, sessions: f.support.sessions })), spent: spendJson(spend) });
    return 0;
  }
  out.print(`${p.cand.id}  ${p.cand.changed.map((f) => f.path).join(", ")} (+${plural(p.lines.length, "line")})`);
  for (const l of p.lines) out.print(`  + ${l}`);
  if (p.cand.rationale) out.print(`Why: ${p.cand.rationale}`);
  out.note(`From ${plural(p.findings.length, "finding")}; spent ${money(spend.judgeUsd)}`);
  out.next("Test it against your current files", `coding.sh refine test ${p.cand.id}`);
  return 0;
}

async function logCommand(c: CommandContext, e: Pick<Env, "dir" | "store">): Promise<number> {
  const { out } = c;
  const entries = readLedger(e.dir);
  const rounds = tests(entries);
  const live = new Set(liveApplies(entries).map((a) => a.candidate));
  const everApplied = new Set(entries.filter((x) => x.op === "apply").map((x) => (x as ApplyEntry).candidate));
  const p = rounds.length ? await refinePlateau(e.store, entries) : undefined;
  // Suite rounds (`--suite`) are shown as climbs, below the decision-point rounds.
  const climb = rounds.some((t) => t.suite) ? await import("./refine-climb.ts") : undefined;
  if (out.json) {
    out.data({ ledger: ledgerFile(e.dir), entries, plateau: plateauJson(p), ...(climb ? { climbs: climb.climbsJson(entries) } : {}) });
    return 0;
  }
  if (!rounds.length) {
    out.note(`No refine rounds in this repo yet (${ledgerFile(e.dir)})`);
    out.next("Test an edit to CLAUDE.md or AGENTS.md", "coding.sh refine test ./drafts/AGENTS.md");
    return 0;
  }
  const decisionRounds = rounds.filter((t) => !t.suite);
  if (climb && decisionRounds.length === 0) {
    climb.printClimbs(c, entries, { live, ever: everApplied });
    return 0;
  }
  out.table(
    ["ROUND", "CANDIDATE", "VERDICT", "EFFECT (95% CI)", "GUARD", "COST", "REASON"],
    decisionRounds.map((t) => {
      const applied = live.has(t.id) ? ", applied" : everApplied.has(t.id) ? ", rolled back" : "";
      const why = t.verdict === "keep" ? t.reasons[0] ?? "" : t.reasons.find((r) => !r.startsWith("dev: Ship")) ?? t.reasons[0] ?? "";
      return [String(t.round), t.id, `${t.verdict}${t.rank && !t.rank.winner ? ` (#${t.rank.position})` : ""}${applied}`, effectText(t), guardText(t), money(t.cost.usd), why];
    }),
  );
  if (p) out.print(plateauLine("refine", p));
  climb?.printClimbs(c, entries, { live, ever: everApplied });
  return 0;
}

async function runCommand(c: CommandContext, e: Env): Promise<number> {
  const { out } = c;
  const rounds = positiveInt(c.flags.rounds, "rounds") ?? 3;
  const given = list(c.flags.candidate);
  const max = given.length ? Math.min(rounds, given.length) : rounds;
  const cap = e.o.maxCost;
  if (e.o.dryRun) {
    const base = baseArm(e.root);
    if (given.length) {
      const k = await resolveCandidate(e, given[0]!, base);
      return printPlan(c, e, await planRound(e, base, [k], readLedger(e.dir)));
    }
    const { findings, target, prompt } = await proposalInput(e, base);
    const mined = await mineDecisionPoints(c, e.o, e.ctx, e.store, e.anchors, "coding.sh refine run");
    const setup = trialSetup(e.o, mined.cases, c.env);
    const guard = await guardPlan(e, readLedger(e.dir), mined.caseMap);
    const est = sumEstimates([estimatePair(setup, base, base, mined.cases), ...(guard.rerun.length ? [estimatePair(setup, base, base, guard.rerun)] : [])]);
    const plan = { rounds: max, target: target.path, proposer: proposerModel(e), findings: findings.map((f) => ({ id: f.id, level: f.diagnosis.severity.level, score: f.diagnosis.severity.score })), promptChars: prompt.user.length, decisionPoints: mined.cases.length, guard: { size: guard.set.tasks.length, fromDev: guard.fromDev.length, rerun: guard.rerun.length }, perRound: est };
    if (out.json) {
      out.data({ dryRun: true, ...plan, ...(cap !== undefined ? { maxCost: cap } : {}) });
      return 0;
    }
    out.print(`Up to ${plural(max, "round")}: propose an edit to ${target.path} with ${plan.proposer}, test it on ${plural(mined.cases.length, "decision point")}, apply it when kept`);
    out.print(findings.length ? `Findings: ${findings.map((f) => `${f.flag} ${f.diagnosis.severity.level} ${f.diagnosis.severity.score}`).join(", ")}` : "Findings: none");
    out.print(`Guard: ${guardPlanText(guard)}`);
    out.print(`Each round: up to ${est.uncached} uncached model and judge calls, ${est.usd === undefined ? "cost unknown" : `~${costText(est.usd, e.o.provider)}`}, plus one proposer call${cap !== undefined ? `; stops at --max-cost ${money(cap)}` : ""}`);
    return 0;
  }
  const spend = newSpend();
  const done: TestEntry[] = [];
  const applied: string[] = [];
  let stopped: "rounds" | "candidates" | "plateau" | "budget" | "interrupted" = given.length && given.length < rounds ? "candidates" : "rounds";
  let p: PlateauResult | undefined;
  for (let i = 0; i < max; i++) {
    if ((c.drain ?? c.signal).aborted) {
      stopped = "interrupted";
      break;
    }
    if (cap !== undefined && spend.usd + spend.judgeUsd >= cap) {
      stopped = "budget";
      break;
    }
    const base = baseArm(e.root);
    let cand: Candidate;
    if (given.length) cand = await resolveCandidate(e, given[i]!, base);
    else {
      const prop = await propose(e, base, spend);
      cand = prop.cand;
      if (!out.json) out.note(`Round ${i + 1}: proposed ${cand.id} (+${prop.lines.length} lines to ${cand.changed.map((f) => f.path).join(", ")})`);
    }
    const plan = await planRound(e, base, [cand], readLedger(e.dir));
    overBudget(e, plan, cap === undefined ? undefined : cap - spend.usd - spend.judgeUsd);
    const tested = await runRound(e, plan, spend, cap);
    if (!out.json) printTested(c, plan, tested);
    for (const t of tested) {
      done.push(t.entry);
      if (t.entry.verdict === "keep") {
        const a = applyCandidate(e.root, e.dir, t.entry.id, false);
        applied.push(t.entry.id);
        if (!out.json) printApplied(c, e.dir, a);
      }
    }
    p = await refinePlateau(e.store, readLedger(e.dir));
    if (p?.status === "stop") {
      stopped = "plateau";
      break;
    }
    if (tested.some((t) => t.entry.reasons.some((r) => r.includes("stopped at --max-cost")))) {
      stopped = "budget";
      break;
    }
    if (tested.some((t) => t.entry.reasons.some((r) => r.includes("interrupted")))) {
      stopped = "interrupted";
      break;
    }
  }
  if (out.json) {
    out.data({ ledger: ledgerFile(e.dir), rounds: done, applied, stopped, spent: spendJson(spend), plateau: plateauJson(p) });
  } else {
    const why = { rounds: `ran ${plural(done.length, "round")}`, candidates: "used every --candidate", plateau: "the e-detector says the loop stopped gaining", budget: "reached --max-cost", interrupted: "interrupted" }[stopped];
    out.print(`Stopped: ${why}. ${plural(done.length, "round")}, ${applied.length} kept and applied, spent ${costText(spend.usd + spend.judgeUsd, e.o.provider)}${spend.unpriced ? "+" : ""}`);
    if (p) out.print(plateauLine("refine", p));
    if (p?.status === "stop" && p.recommend) out.print(`The plateau began at round ${p.changePoint}: the version to keep is ${p.recommend.name}`);
    if (applied.length) out.next("Undo the last applied edit", "coding.sh refine rollback");
  }
  return applied.length ? 0 : 1;
}

function rollbackCommand(c: CommandContext, root: string, dir: string): number {
  const { out } = c;
  const id = c.positionals[0];
  const force = c.flags.force === true;
  const entries = readLedger(dir);
  const live = liveApplies(entries);
  const apply = id ? [...live].reverse().find((a) => a.candidate === id || a.id === id) : live[live.length - 1];
  if (!apply) throw new CliError(id ? `${id} is not applied (or was rolled back already)` : "Nothing applied to roll back", { reason: "not_found", next: ["See the rounds:", "coding.sh refine log"] });
  const later = live.filter((a) => entries.indexOf(a) > entries.indexOf(apply) && a.files.some((f) => apply.files.some((g) => g.path === f.path)));
  if (later.length && !force) throw new CliError(`${later.map((a) => a.candidate).join(", ")} was applied over ${apply.candidate} on the same file; roll ${later.length === 1 ? "it" : "them"} back first`, { reason: "applied_over", askUser: true, next: ["Roll back the newest first:", `coding.sh refine rollback ${later[later.length - 1]!.candidate}`] });
  const now = currentShas(root, apply.files.map((f) => f.path));
  const edited = apply.files.filter((f) => now.get(f.path) !== f.after).map((f) => f.path);
  if (edited.length && !force) throw new CliError(`${edited.join(", ")} changed since ${apply.candidate} was applied; a rollback would drop those edits`, { reason: "files_changed", askUser: true, next: ["Roll back anyway (your later edits to the file are lost):", `coding.sh refine rollback ${apply.candidate} --force`] });
  const files = writeRollback(dir, root, apply);
  appendLedger(dir, { op: "rollback", id: `b_${sha(`${apply.id}\u0000${Date.now()}`).slice(0, 10)}`, apply: apply.id, candidate: apply.candidate, at: new Date().toISOString(), files, ...(edited.length ? { forced: true } : {}) });
  if (out.json) {
    out.data({ rolledBack: apply.candidate, apply: apply.id, files });
    return 0;
  }
  out.ok(`Rolled back ${apply.candidate}: ${files.map((f) => `${f.path}${f.restored === null ? " (removed)" : " (restored)"}`).join(", ")}`);
  out.note("Its won tasks no longer guard later candidates");
  return 0;
}

function applyCommand(c: CommandContext, root: string, dir: string): number {
  const a = applyCandidate(root, dir, c.positionals[0], c.flags.force === true);
  if (c.out.json) {
    c.out.data({ applied: a.test.id, apply: a.entry.id, files: a.entry.files, backups: join(dir, "backups", a.entry.id), ...(a.entry.forced ? { forced: a.entry.forced } : {}) });
    return 0;
  }
  printApplied(c, dir, a);
  c.out.next("Undo it", `coding.sh refine rollback ${a.test.id}`);
  return 0;
}

/** The refine actions that take part in the loop. */
export async function refineLoop(c: CommandContext): Promise<number> {
  const root = gitRoot(c.cwd) ?? c.cwd;
  const dir = refineDir(c.env, root);
  if (c.action === "apply") return applyCommand(c, root, dir);
  if (c.action === "rollback") return rollbackCommand(c, root, dir);
  if (num(c.flags["max-cost"]) !== undefined && !(num(c.flags["max-cost"])! >= 0)) throw new UsageError("--max-cost must be a dollar amount of at least 0", { reason: "invalid_argument" });
  return withContext(c, async (ctx) => {
    if (c.action === "log") return logCommand(c, { dir, store: new FileEvalStore({ env: c.env, index: ctx.index }) });
    const e = await setupEnv(c, ctx);
    if (c.action === "test" || c.action === "run") {
      const climb = await import("./refine-climb.ts");
      if (climb.climbing(c, e)) return c.action === "test" ? climb.climbTest(c, e) : climb.climbRun(c, e);
    }
    if (c.action === "test") return testCommand(c, e);
    if (c.action === "propose") return proposeCommand(c, e);
    if (c.action === "run") return runCommand(c, e);
    throw new UsageError(`Unknown refine command ${c.action}`);
  });
}

