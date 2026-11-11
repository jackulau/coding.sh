// `refine test|run --suite <name>` and `refine log`'s climb view: harness
// edits judged on an eval suite of repo tasks, on quality and on cost and
// time (src/refine/objectives.ts). A climb is the rounds on one suite, one
// primary objective and one target file. `run --until-plateau` keeps going
// until the e-detector says the climb stopped gaining; an interrupted round is
// continued with `--resume` (the same candidate, the same job).
//
// When the primary objective is cost or time the proposer cuts instead of
// adding (src/refine/cut.ts), shown what made the last runs slow or expensive
// (src/refine/drivers.ts). The protected-line check and the critics run on
// every candidate before any agent session, as in the decision-point loop.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAdapter } from "../../adapters/index.ts";
import { CANARY_POLICIES, canaryBundle, canaryCheck, canaryRefusal, canaryStage, DEFAULT_CANARY_DELTA, removedCount, type CanaryPolicy, type CanaryRecord } from "../../refine/canary.ts";
import { refineCanaryModel } from "../../refine/config.ts";
import type { HarnessBundle } from "../../core/types.ts";
import { runCritics, type CriticCheck } from "../../refine/critics.ts";
import { cutCandidate, cutPrompt, CUT_SCHEMA, cutSections, parseCut, removedLines } from "../../refine/cut.ts";
import { decideRound } from "../../refine/decide.ts";
import { costDrivers } from "../../refine/drivers.ts";
import { preservation } from "../../refine/keep.ts";
import { appendLedger, ledgerFile, LEDGER_VERSION, liveApplies, preservationEntry, readLedger, saveCandidate, sha, tests, type LedgerEntry, type RecheckEntry, type TestEntry } from "../../refine/ledger.ts";
import {
  climbFront,
  climbPlateau,
  climbPlateauLine,
  DEFAULT_MARGIN,
  DEFAULT_MAX_COST_RISE,
  DEFAULT_MIN_GAIN,
  frontKey,
  OBJECTIVE_LABEL,
  parseObjectives,
  parseRise,
  parseShare,
  type ArmPoint,
  type ClimbPlateau,
  type ClimbRound,
  type MetricResult,
  type Objective,
} from "../../refine/objectives.ts";
import { refineMaxCostRise } from "../../refine/config.ts";
import { checkProtected, protectedLines, type ProtectCheck } from "../../refine/protect.ts";
import { skillOf, targetPath } from "../../refine/target.ts";
import { SUITES_DIR } from "../../eval/suite-spec.ts";
import type { ReuseOpts } from "../../runner/cells.ts";
import { parseAge, positiveInt, UsageError } from "../args.ts";
import { list, requireConsent, str } from "../common.ts";
import { CliError, plural } from "../output.ts";
import type { CommandContext } from "../types.ts";
import { money, newSpend, type Arm, type Spend } from "./exp-ab.ts";
import { applyCandidate, baseArm, defaultTarget, printApplied, propose, proposerName, proposerReply, resolveCandidate, spendJson, verdictReasons, type Candidate, type Env } from "./refine-loop.ts";
import { armBundle, armDrivers, clearPending, infraRoundText, loadFitness, readPending, roundsText, runSuiteRound, writePending, type Fitness, type SuiteRound } from "./refine-suite.ts";

const CLIMB_FLAGS = ["suite", "objective", "margin", "min-gain", "max-cost-rise", "until-plateau", "harness", "proposer-command", "reuse", "reuse-max-age", "canary", "canary-model", "canary-delta"] as const;

/** The suite to climb on: --suite, else the target skill's own tasks suite (evals/<skill>). */
function suiteName(c: CommandContext, root: string): string | undefined {
  const s = str(c.flags.suite);
  if (s) return s;
  const skill = skillOf(targetPath(str(c.flags.target), root));
  return skill && existsSync(join(root, SUITES_DIR, skill, "suite.json")) ? skill : undefined;
}

/** Whether this `refine test|run` is a suite climb. */
export function climbing(c: CommandContext, e: Pick<Env, "root">): boolean {
  if (suiteName(c, e.root)) return true;
  const given = CLIMB_FLAGS.filter((f) => f !== "proposer-command" && c.flags[f] !== undefined && c.flags[f] !== false);
  if (given.length) throw new UsageError(`--${given[0]} needs --suite <name>: an eval suite of repo tasks to judge the edits on`, { reason: "missing_argument", suggestion: "coding.sh refine run --suite <name> --objective cost" });
  return false;
}

interface ClimbOpts {
  suite: string;
  objectives: Objective[];
  primary: Objective;
  margin: number;
  minGain: number;
  /** How far a listed objective may rise for a significant pass-rate gain: --max-cost-rise, else refine.maxCostRise, else +50% (Infinity: no limit). */
  maxCostRise: number;
  /** `--reuse`: which arm's earlier runs to copy, and how recent they must be. Absent means run everything fresh. */
  reuse?: { what: "baseline" | "both"; maxAgeMs?: number };
  /** Stage 3 (Z-14): which kept candidates are re-run under the canary model. */
  canary: { policy: CanaryPolicy; model?: string; delta: number };
}

/** --canary, --canary-model (else `[refine] canary_model`) and --canary-delta. */
function canaryOpts(c: CommandContext): ClimbOpts["canary"] {
  const policy = (str(c.flags.canary) ?? "subtractive") as CanaryPolicy;
  if (!CANARY_POLICIES.includes(policy)) throw new UsageError(`--canary takes ${CANARY_POLICIES.join(", ")}, got ${JSON.stringify(policy)}`, { reason: "invalid_argument" });
  let delta = DEFAULT_CANARY_DELTA;
  if (c.flags["canary-delta"] !== undefined) {
    try {
      delta = parseShare(c.flags["canary-delta"] as string | number, "--canary-delta");
    } catch (err) {
      throw new UsageError((err as Error).message, { reason: "invalid_argument" });
    }
  }
  const model = str(c.flags["canary-model"]) ?? refineCanaryModel(c.env);
  if (policy === "all" && !model) throw new UsageError("--canary all needs a model to re-test under", { reason: "missing_argument", suggestion: "coding.sh refine run --suite <name> --canary all --canary-model <cheaper model>" });
  return { policy, ...(model ? { model } : {}), delta };
}

/** Refuses a canary model the suite's agent can't take, before any run. */
function checkCanary(o: ClimbOpts, harness: HarnessBundle): void {
  if (!o.canary.model || o.canary.policy === "off") return;
  const why = canaryRefusal(harness, !!getAdapter(harness.agent)?.run);
  if (why) throw new CliError(why, { reason: "unsupported_agent", next: ["Run without a canary (subtractive candidates then carry a note):", "coding.sh refine run --suite <name> --canary off"] });
}

/** Up to this many more agent sessions per kept candidate the policy selects, and their cost at the last round's $/run. */
function canaryPlan(e: Env, f: Fitness, o: ClimbOpts): { policy: CanaryPolicy; model: string | null; sessions: number; estimateUsd?: number } {
  const sessions = o.canary.model && o.canary.policy !== "off" ? f.tasks.length * f.k * 2 : 0;
  const last = tests(readLedger(e.dir)).reverse().find((t) => t.suite?.name === o.suite && t.suite.experiment && t.cost.usd > 0);
  const perRun = last ? last.cost.usd / (last.suite!.tasks * last.suite!.k * 2) : undefined;
  return { policy: o.canary.policy, model: o.canary.model ?? null, sessions, ...(sessions && perRun !== undefined ? { estimateUsd: perRun * sessions } : {}) };
}

function canaryPlanLine(p: ReturnType<typeof canaryPlan>): string {
  if (p.policy === "off") return "Canary: off";
  if (!p.model) return "Canary: none (a kept candidate that removes lines gets a note; set --canary-model to re-test it under a cheaper model)";
  return `Canary: ${p.policy === "all" ? "every" : "a"} kept candidate${p.policy === "all" ? "" : " that removes lines"} runs again under ${p.model}, up to ${plural(p.sessions, "agent session")}${p.estimateUsd !== undefined ? ` (about ${money(p.estimateUsd)} at the last round's cost per run)` : ""}`;
}

function climbOpts(c: CommandContext, root: string): ClimbOpts {
  const suite = suiteName(c, root)!;
  let objectives: Objective[];
  let margin: number;
  let minGain: number;
  let maxCostRise: number | undefined;
  try {
    objectives = parseObjectives(list(c.flags.objective));
    margin = c.flags.margin === undefined ? DEFAULT_MARGIN : parseShare(c.flags.margin as string | number, "--margin");
    minGain = c.flags["min-gain"] === undefined ? DEFAULT_MIN_GAIN : parseShare(c.flags["min-gain"] as string | number, "--min-gain");
    maxCostRise = c.flags["max-cost-rise"] === undefined ? undefined : parseRise(c.flags["max-cost-rise"] as string | number, "--max-cost-rise");
  } catch (err) {
    throw new UsageError((err as Error).message, { reason: "invalid_argument" });
  }
  if (!objectives.length) objectives = ["pass"];
  const reuseWhat = str(c.flags.reuse) ?? "none";
  if (!["baseline", "both", "none"].includes(reuseWhat)) throw new UsageError(`--reuse takes baseline, both or none, got ${JSON.stringify(reuseWhat)}`, { reason: "invalid_argument" });
  const reuseMaxAgeMs = c.flags["reuse-max-age"] === undefined ? undefined : parseAge(String(c.flags["reuse-max-age"]), "reuse-max-age");
  if (reuseMaxAgeMs !== undefined && reuseWhat === "none") throw new UsageError("--reuse-max-age needs --reuse baseline or --reuse both", { reason: "invalid_argument" });
  const reuse = reuseWhat !== "none" ? { what: reuseWhat as "baseline" | "both", ...(reuseMaxAgeMs !== undefined ? { maxAgeMs: reuseMaxAgeMs } : {}) } : undefined;
  maxCostRise ??= refineMaxCostRise(c.env, c.cwd) ?? DEFAULT_MAX_COST_RISE;
  return { suite, objectives, primary: objectives[0]!, margin, minGain, maxCostRise, ...(reuse ? { reuse } : {}), canary: canaryOpts(c) };
}

// ---------------------------------------------------------------- the ledger's climbs

interface ClimbKey {
  suite: string;
  primary: Objective;
  path: string;
}

const keyOf = (t: TestEntry): ClimbKey | undefined => (t.suite ? { suite: t.suite.name, primary: t.suite.primary, path: t.candidate.files[0]?.path ?? "" } : undefined);
const sameKey = (a: ClimbKey, b: ClimbKey) => a.suite === b.suite && a.primary === b.primary && a.path === b.path;

/** The rounds of a climb that ran the suite (a candidate rejected before any run has no measurements). */
function climbRounds(entries: readonly LedgerEntry[], key: ClimbKey): ClimbRound[] {
  return climbTests(entries, key)
    .filter((t) => t.objectives)
    .map((t) => ({ id: t.id, round: t.round, kept: t.verdict === "keep", base: t.objectives!.arms.base, cand: t.objectives!.arms.cand, gains: t.objectives!.gains }));
}

// ---------------------------------------------------------------- printing

/** Infinity (no limit) as null in JSON and the ledger. */
const limitJson = (x: number): number | null => (Number.isFinite(x) ? x : null);

const objectivesLine = (o: ClimbOpts): string => {
  const head = `Objectives: ${o.objectives.map((x) => OBJECTIVE_LABEL[x]).join(", ")}; quality margin ${(o.margin * 100).toFixed(1)} pts, smallest gain ${(o.minGain * 100).toFixed(0)}%`;
  if (!o.objectives.some((x) => x !== "pass")) return head;
  return `${head}; a significant pass-rate gain may cost ${Number.isFinite(o.maxCostRise) ? `up to +${Math.round(o.maxCostRise * 100)}% on the others (--max-cost-rise)` : "any rise on the others"}`;
};

const signed = (x: number, digits = 0) => (Number.isFinite(x) ? `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(digits)}%` : "—");
const ptsText = (x: number) => (Number.isFinite(x) ? `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(1)} pts` : "—");

export function fmtValue(o: Objective, v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return "—";
  switch (o) {
    case "pass":
      return `${Math.round(v * 100)}%`;
    case "cost":
      return v < 0.1 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
    case "tokens":
      return String(Math.round(v));
    case "wall":
    case "llm":
      return `${(v / 1000).toFixed(1)}s`;
    case "turns":
      return v.toFixed(1);
    case "size":
      return `${Math.round(v)} B`;
  }
}

function metricLine(m: MetricResult): string {
  const head = `${fmtValue(m.objective, m.base)} → ${fmtValue(m.objective, m.cand)}  ${signed(m.relative)}`;
  const ci = m.objective === "size" ? "" : ` [${signed(m.lo)}, ${signed(m.hi)}] p ${m.p === undefined ? "—" : m.p.toFixed(3)}`;
  return `${head}${ci}${m.better ? "  better" : m.worse ? "  worse" : ""}`;
}

function printRound(c: CommandContext, t: TestEntry, checks?: { protect: ProtectCheck; critics: CriticCheck }): void {
  const { out } = c;
  const o = t.objectives;
  const bytes = o?.arms.base.size !== undefined && o.arms.cand.size !== undefined ? `; ${o.arms.base.size} → ${o.arms.cand.size} instruction bytes` : "";
  out.print(`${t.id}  ${t.candidate.files.map((f) => f.path).join(", ")} (−${plural(t.candidate.removedCount ?? t.candidate.removed?.length ?? 0, "line")}, +${plural(t.candidate.added.length, "line")}${bytes})`);
  if (checks) {
    out.print(`  protected  ${checks.protect.ok ? `ok (${plural(checks.protect.protected.length, "protected line")} in place)` : checks.protect.rejections.map((r) => r.reason).join("; ")}`);
    out.print(`  critics    ${checks.critics.ok ? "ok" : checks.critics.rejections.map((r) => r.reason).join("; ")}`);
  }
  if (t.suite && o) {
    out.print(`  suite      ${t.suite.name}: ${plural(t.suite.tasks, "task")} x ${t.suite.k} x 2 arms (${t.suite.experiment ?? "not run"})`);
    const q = o.quality;
    out.print(`  pass rate  ${fmtValue("pass", q.base)} → ${fmtValue("pass", q.cand)}  ${ptsText(q.mean)} per task [${ptsText(q.lo)}, ${ptsText(q.hi)}]; lower bound ${ptsText(q.lower)} vs margin −${(o.margin * 100).toFixed(1)} pts${q.better ? "  better" : ""}`);
    for (const m of o.metrics) out.print(`  ${OBJECTIVE_LABEL[m.objective].replace(" / run", "/run").padEnd(9)}  ${metricLine(m)}`);
    for (const w of o.warnings) out.print(`  note       ${w}`);
  }
  out.print(`  verdict    ${t.verdict}${o?.branch ? ` (${o.branch})` : ""}: ${verdictReasons(t).join("; ")}`);
  out.print("");
}

const frontText = (rounds: readonly ClimbRound[], key: Exclude<Objective, "pass">): string => {
  const { front } = climbFront(rounds, key);
  return front
    .sort((a, b) => a.value - b.value)
    .map((p) => `${p.id === "base" ? "start" : p.id} (round ${p.round}${p.kept ? "" : ", not kept"}): ${fmtValue("pass", p.pass)} pass, ${fmtValue(key, p.value)}`)
    .join("; ");
};

function climbJson(rounds: readonly ClimbRound[], key: ClimbKey, p: ClimbPlateau) {
  const fk = frontKey(key.primary, rounds);
  return {
    suite: key.suite,
    primary: key.primary,
    target: key.path,
    rounds: rounds.map((r) => ({ id: r.id, round: r.round, kept: r.kept, base: r.base, cand: r.cand })),
    ...(fk ? { front: { objective: fk, points: climbFront(rounds, fk).front } } : {}),
    plateau: { status: p.status, rounds: p.result.rounds, alarm: p.result.alarm, ...(p.result.changePoint !== undefined ? { changePoint: p.result.changePoint } : {}), ...(p.keep ? { keep: p.keep } : {}), ...(p.floor ? { floor: p.floor } : {}), logWealth: p.result.logWealth },
  };
}

// ---------------------------------------------------------------- one round

interface Round {
  entry?: TestEntry;
  stopped?: "interrupted" | "budget" | "infra";
  resume?: string;
  run?: SuiteRound;
  /** Agent spend of the canary experiment (stage 3). */
  canaryUsd?: number;
}

/** Per-task pass lists of one arm of a suite round (tasks both arms ran). */
const armOutcomes = (run: SuiteRound, arm: "base" | "cand") => new Map(run.pairs.filter((p) => p.base.length && p.cand.length).map((p) => [p.task, p[arm].map((x) => x.pass)]));

/** Runs the canary arms on the suite (pass only) inside what is left of the cap. */
function canaryRunner(c: CommandContext, e: Env, f: Fitness, o: Pick<ClimbOpts, "margin" | "minGain">, label: string, cap: number | undefined) {
  return async (A: HarnessBundle, B: HarnessBundle) => {
    if (!c.out.json) c.out.note(`Canary: running ${A.name} and ${B.name} (${roundsText(f)})`);
    const r = await runSuiteRound(c, e.ctx, f, A, B, { objectives: ["pass"], margin: o.margin, minGain: o.minGain, gate: e.gate, ...(cap !== undefined ? { maxCostUsd: cap } : {}), resume: false, label });
    return { experimentId: r.experimentId, cancelled: r.cancelled, skipped: r.skipped, spentUsd: r.spentUsd, outcomes: { base: armOutcomes(r, "base"), cand: armOutcomes(r, "cand") }, tampered: r.tampered };
  };
}

async function climbRound(c: CommandContext, e: Env, f: Fitness, o: ClimbOpts, base: Arm, cand: Candidate, x: { resume: Parameters<typeof runSuiteRound>[5]["resume"]; cap?: number; proposerUsd: number }): Promise<Round> {
  const protect = checkProtected(base.files, cand.arm.files, { ...e.protect, allow: e.allow });
  const critics = runCritics(base.files, cand.arm.files);
  const before = (path: string) => base.files.find((b) => b.path === path)?.text ?? "";
  const removedAll = cand.changed.flatMap((ch) => removedLines(before(ch.path), ch.text));
  const removed = removedAll.slice(0, 40);
  const sections = removedAll.length > 8 ? cand.changed.flatMap((ch) => cutSections(before(ch.path), ch.text).map((s) => ({ path: ch.path, ...s }))) : [];
  const entryBase = (): Omit<TestEntry, "verdict" | "stage" | "reasons" | "cost"> => ({
    op: "test",
    id: cand.id,
    round: tests(readLedger(e.dir)).length + 1,
    at: new Date().toISOString(),
    candidate: {
      label: cand.label,
      source: cand.source,
      files: cand.changed.map((ch) => ({ path: ch.path, sha: sha(ch.text) })),
      added: critics.added.slice(0, 40).map((a) => a.text),
      ...(removed.length ? { removed } : {}),
      ...(removedAll.length > removed.length ? { removedCount: removedAll.length } : {}),
      ...(sections.length ? { sections } : {}),
      ...(cand.findings ? { findings: cand.findings } : {}),
      ...(cand.rationale ? { rationale: cand.rationale } : {}),
    },
    base: cand.changed.flatMap((ch) => {
      const b = base.files.find((y) => y.path === ch.path);
      return b ? [{ path: b.path, sha: sha(b.text) }] : [];
    }),
    guardTasks: [],
  });
  if (!protect.ok || !critics.ok) {
    const d = decideRound({ protect, critics });
    const entry: TestEntry = { ...entryBase(), verdict: d.verdict, stage: d.stage, reasons: d.reasons, suite: { name: o.suite, tasks: f.tasks.length, k: f.k, primary: o.primary }, cost: { usd: x.proposerUsd, unpriced: 0 } };
    appendLedger(e.dir, entry);
    if (!c.out.json) printRound(c, entry, { protect, critics });
    return { entry };
  }
  const A = await armBundle(e.ctx, f.harness, base.files, f.harness.name);
  const B = await armBundle(e.ctx, f.harness, cand.arm.files, `${f.harness.name}+${cand.id}`);
  // Copy the unchanged base's runs from an earlier round (and, with `both`, a candidate that recurs) instead of re-running them.
  const reuse: ReuseOpts | undefined = o.reuse ? { bundleIds: o.reuse.what === "both" ? [A.id, B.id] : [A.id], ...(o.reuse.maxAgeMs !== undefined ? { maxAgeMs: o.reuse.maxAgeMs } : {}) } : undefined;
  writePending(e.dir, { suite: o.suite, candidate: cand.id, base: base.files.map((b) => ({ path: b.path, sha: sha(b.text) })), at: new Date().toISOString() });
  const run = await runSuiteRound(c, e.ctx, f, A, B, { objectives: o.objectives, margin: o.margin, minGain: o.minGain, maxCostRise: o.maxCostRise, gate: e.gate, ...(x.cap !== undefined ? { maxCostUsd: x.cap } : {}), resume: x.resume, label: cand.id, ...(reuse ? { reuse } : {}) });
  // A round lost to infrastructure (a dead login, a broken setup) is no verdict: nothing goes in the ledger, and the climb stops.
  if (run.infraStop || run.void) return { stopped: "infra", run, resume: run.resume };
  if (run.cancelled || run.skipped) return { stopped: run.cancelled ? "interrupted" : "budget", run, ...(run.resume ? { resume: run.resume } : {}) };
  const d = run.decision!;
  // Z-14 stage 3: a kept candidate the canary policy selects runs again under the canary model.
  const capLeft = x.cap === undefined ? undefined : Math.max(0, x.cap - run.spentUsd);
  const st = await canaryStage({
    verdict: d.verdict,
    reasons: d.reasons,
    removed: removedCount(base.files, cand.changed),
    policy: o.canary.policy,
    ...(o.canary.model ? { model: o.canary.model } : {}),
    delta: o.canary.delta,
    base: A,
    cand: B,
    runArms: canaryRunner(c, e, f, o, `${cand.id}@${o.canary.model}`, capLeft),
  });
  const canaryUsd = st.canary?.spentUsd ?? 0;
  // AE-2: which suite tasks the candidate fixed, regressed or left failing, for the next proposal.
  const outcomes = (arm: "base" | "cand") => armOutcomes(run, arm);
  const entry: TestEntry = {
    ...entryBase(),
    v: LEDGER_VERSION,
    verdict: st.verdict,
    stage: st.verdict === "keep" ? "done" : st.ran && st.verdict !== d.verdict ? "canary" : "dev",
    reasons: st.reasons,
    suite: { name: o.suite, tasks: f.tasks.length, k: f.k, primary: o.primary, experiment: run.experimentId, base: A.id, cand: B.id },
    objectives: { list: o.objectives, margin: o.margin, minGain: o.minGain, maxCostRise: limitJson(o.maxCostRise), ...(d.branch ? { branch: d.branch } : {}), ...(d.trade ? { trade: { ...d.trade, limit: limitJson(d.trade.limit) } } : {}), quality: d.quality, metrics: d.metrics, arms: run.arms, gains: d.gains, warnings: d.warnings },
    preservation: preservationEntry(preservation({ dev: { base: outcomes("base"), cand: outcomes("cand") } })),
    ...(A.model ? { model: A.model } : {}),
    ...(st.canary ? { canary: st.canary } : {}),
    cost: { usd: run.spentUsd + canaryUsd + x.proposerUsd, unpriced: run.unpriced },
  };
  appendLedger(e.dir, entry);
  clearPending(e.dir);
  if (!c.out.json) printRound(c, entry, { protect, critics });
  return { entry, run, ...(canaryUsd ? { canaryUsd } : {}) };
}

// ---------------------------------------------------------------- proposing a cut

async function proposeCut(e: Env, f: Fitness, o: ClimbOpts, base: Arm, path: string, spend: Spend): Promise<{ cand: Candidate; edits: number; drivers: string[] }> {
  const target = base.files.find((x) => x.path === path);
  if (!target) throw new UsageError(`${path} is not in this repo: a cut needs a file to cut`, { reason: "not_found", suggestion: "coding.sh refine run --suite <name> --objective cost --target AGENTS.md" });
  const { drivers } = await driversFor(e, f, o, base, path);
  const rejected = climbTests(readLedger(e.dir), { suite: o.suite, primary: o.primary, path })
    .filter((t) => t.verdict !== "keep")
    .map((t) => ({
      id: t.id,
      verdict: t.verdict,
      reasons: t.reasons,
      removed: t.candidate.removed ?? [],
      ...(t.candidate.removedCount !== undefined ? { removedCount: t.candidate.removedCount } : {}),
      ...(t.candidate.sections ? { sections: t.candidate.sections.filter((s) => s.path === path) } : {}),
    }));
  const prompt = cutPrompt({ target, drivers, objective: OBJECTIVE_LABEL[o.primary], protectedLines: protectedLines(base.files, e.protect), rejected });
  const text = await proposerReply(e, spend, { system: prompt.system, user: prompt.user, schema: CUT_SCHEMA });
  let made;
  let cut;
  try {
    cut = parseCut(text);
    made = cutCandidate(target, cut);
  } catch (err) {
    throw new CliError(`The proposer's reply is not a usable cut: ${(err as Error).message}`, { reason: "bad_proposal" });
  }
  saveCandidate(e.dir, { id: made.id, files: [made.file], source: "proposal", ...(cut.rationale ? { rationale: cut.rationale } : {}) });
  const cand = await resolveCandidate(e, made.id, base, { source: "proposal", ...(cut.rationale ? { rationale: cut.rationale } : {}) });
  return { cand, edits: cut.edits.length, drivers };
}

function climbTests(entries: readonly LedgerEntry[], key: ClimbKey): TestEntry[] {
  return tests(entries).filter((t) => {
    const k = keyOf(t);
    return k && sameKey(k, key);
  });
}

/** Drivers from the runs of the current files: the last round's candidate when it was kept, else its base. */
async function driversFor(e: Env, f: Fitness, o: ClimbOpts, base: Arm, path: string): Promise<{ drivers: string[]; from?: string }> {
  const last = climbTests(readLedger(e.dir), { suite: o.suite, primary: o.primary, path })
    .filter((t) => t.suite?.experiment)
    .at(-1);
  const target = base.files.find((x) => x.path === path);
  if (!last?.suite?.experiment) return { drivers: costDrivers([], target) };
  const bundle = (last.verdict === "keep" ? last.suite.cand : last.suite.base)!;
  const runs = await armDrivers(e.ctx, last.suite.experiment, bundle, new Map(f.tasks.map((t) => [t.id, t.name])));
  return { drivers: costDrivers(runs, target), from: last.suite.experiment };
}

// ---------------------------------------------------------------- commands

const isResume = (c: CommandContext) => c.flags.resume !== undefined && c.flags.resume !== false;

export async function climbTest(c: CommandContext, e: Env): Promise<number> {
  const { out } = c;
  if (!c.positionals.length) throw new UsageError("Name the candidate(s) to test: a file, a directory, git:REV, a bundle or a stored r_… id", { reason: "missing_argument", suggestion: "coding.sh refine test ./drafts/AGENTS.md --suite <name>" });
  const o = climbOpts(c, e.root);
  const f = await loadFitness(c, e.ctx, e.root, o.suite);
  checkCanary(o, f.harness);
  const base = baseArm(e.root);
  const cands: Candidate[] = [];
  for (const v of c.positionals) {
    const k = await resolveCandidate(e, v, base);
    if (!cands.some((x) => x.id === k.id)) cands.push(k);
  }
  const sessions = f.tasks.length * f.k * 2 * cands.length;
  if (e.o.dryRun) {
    const checks = cands.map((k) => ({ id: k.id, files: k.changed.map((x) => x.path), removed: removedCount(base.files, k.changed), protect: checkProtected(base.files, k.arm.files, { ...e.protect, allow: e.allow }), critics: runCritics(base.files, k.arm.files) }));
    if (out.json) {
      out.data({ dryRun: true, ledger: ledgerFile(e.dir), suite: o.suite, tasks: f.tasks.length, k: f.k, sessions, harness: f.harness.name, objectives: o.objectives, margin: o.margin, minGain: o.minGain, maxCostRise: limitJson(o.maxCostRise), reuse: o.reuse?.what ?? null, canary: canaryPlan(e, f, o), candidates: checks.map((x) => ({ id: x.id, files: x.files, protected: x.protect.ok, critics: x.critics.ok, removed: x.removed })) });
      return 0;
    }
    out.print(`Suite ${o.suite}: ${roundsText(f)} per candidate, harness ${f.harness.name} (${f.harness.agent})`);
    out.print(objectivesLine(o));
    if (o.reuse) out.print(`Reuse: copy earlier rounds' finished runs of ${o.reuse.what === "both" ? "both arms" : "the base arm"} instead of re-running them (the pair is then not interleaved; drift is not balanced)`);
    for (const x of checks) out.print(`${x.id}  ${x.files.join(", ")}: ${!x.protect.ok ? `rejected before any run: ${x.protect.rejections[0]!.reason}` : !x.critics.ok ? `rejected before any run: ${x.critics.rejections[0]!.reason}` : "passes the protected-line and critic checks"}`);
    out.print(canaryPlanLine(canaryPlan(e, f, o)));
    out.print(`Would run up to ${plural(sessions, "agent session")}`);
    return 0;
  }
  await requireConsent(c, `Run ${plural(sessions, "agent session")} (${o.suite}: ${roundsText(f)}${cands.length > 1 ? ` x ${cands.length} candidates` : ""})?`, `coding.sh refine test ${c.positionals.join(" ")} --suite ${o.suite} --yes`);
  const done: TestEntry[] = [];
  let agentUsd = 0;
  let stopped: Round["stopped"];
  let infra: SuiteRound | undefined;
  let resume: string | undefined;
  for (const [i, cand] of cands.entries()) {
    if ((c.drain ?? c.signal).aborted) {
      stopped = "interrupted";
      break;
    }
    const cap = e.o.maxCost === undefined ? undefined : Math.max(0, e.o.maxCost - agentUsd);
    const r = await climbRound(c, e, f, o, base, cand, { resume: i === 0 && isResume(c) ? c.flags.resume : false, ...(cap !== undefined ? { cap } : {}), proposerUsd: 0 });
    if (r.run) agentUsd += r.run.spentUsd + (r.canaryUsd ?? 0);
    if (r.entry) done.push(r.entry);
    if (r.stopped) {
      stopped = r.stopped;
      if (r.stopped === "infra") infra = r.run;
      resume = r.resume;
      break;
    }
  }
  if (out.json) out.data({ ledger: ledgerFile(e.dir), rounds: done, spent: { usd: agentUsd }, ...(stopped ? { stopped } : {}), ...infraJson(infra), resume });
  else {
    if (stopped === "infra") out.warn(`${infraRoundText(infra!)} Finished runs are saved.${resume ? ` Continue with: ${resume}` : ""}`);
    else if (stopped) out.warn(`${stopped === "budget" ? "Stopped at --max-cost" : "Interrupted"}; finished runs are saved.${resume ? ` Continue with: ${resume}` : ""}`);
    out.print(`Spent ${money(agentUsd)} on agent sessions`);
    const win = done.find((d) => d.verdict === "keep");
    if (win) out.next("Write the kept edit to your files (with a backup)", `coding.sh refine apply ${win.id}`);
    else out.next("See every round", "coding.sh refine log");
  }
  return done.some((d) => d.verdict === "keep") ? 0 : 1;
}

type StopReason = "rounds" | "candidates" | "plateau" | "budget" | "interrupted" | "proposer" | "infra";

/** For --json: why a round lost to infrastructure has no verdict. */
function infraJson(r: SuiteRound | undefined): { infraStop?: SuiteRound["infraStop"]; void?: SuiteRound["void"] } {
  return { infraStop: r?.infraStop, void: r?.void };
}

export async function climbRun(c: CommandContext, e: Env): Promise<number> {
  const { out } = c;
  const o = climbOpts(c, e.root);
  const untilPlateau = c.flags["until-plateau"] === true;
  const maxRounds = positiveInt(c.flags.rounds, "rounds") ?? (untilPlateau ? Infinity : 3);
  const given = list(c.flags.candidate);
  const f = await loadFitness(c, e.ctx, e.root, o.suite);
  checkCanary(o, f.harness);
  const start = baseArm(e.root);
  const path = targetPath(str(c.flags.target), e.root) ?? defaultTarget(start.files);
  const mode = o.primary === "pass" ? "add" : "cut";
  const key = { suite: o.suite, primary: o.primary, path };
  const before = climbPlateau(climbRounds(readLedger(e.dir), key));
  const perRound = f.tasks.length * f.k * 2;
  if (e.o.dryRun) {
    const { drivers, from } = given.length ? { drivers: [] as string[], from: undefined } : await driversFor(e, f, o, start, path);
    const plan = { dryRun: true, ledger: ledgerFile(e.dir), suite: o.suite, tasks: f.tasks.length, k: f.k, sessionsPerRound: perRound, rounds: Number.isFinite(maxRounds) ? maxRounds : null, untilPlateau, target: path, mode, proposer: given.length ? null : proposerName(e), objectives: o.objectives, margin: o.margin, minGain: o.minGain, maxCostRise: limitJson(o.maxCostRise), reuse: o.reuse?.what ?? null, canary: canaryPlan(e, f, o), drivers, ...(from ? { driversFrom: from } : {}), plateau: before.status };
    if (out.json) {
      out.data(plan);
      return 0;
    }
    out.print(`${untilPlateau ? "Until the e-detector says plateau" : `Up to ${plural(maxRounds, "round")}`}: ${given.length ? "test each --candidate" : `${mode === "cut" ? "cut" : "add to"} ${path} with ${proposerName(e)}`}, run ${o.suite} (${roundsText(f)} = ${plural(perRound, "agent session")} a round), apply what is kept`);
    out.print(objectivesLine(o));
    if (o.reuse) out.print(`Reuse: copy earlier rounds' finished runs of ${o.reuse.what === "both" ? "both arms" : "the base arm"} instead of re-running them (the pair is then not interleaved; drift is not balanced)`);
    out.print(canaryPlanLine(canaryPlan(e, f, o)));
    if (drivers.length) {
      out.print(`What the proposer is shown${from ? ` (from ${from})` : ""}:`);
      for (const d of drivers) out.print(`  ${d}`);
    }
    out.print(climbPlateauLine(before));
    return 0;
  }
  if (before.status === "stop" && untilPlateau && !isResume(c)) {
    if (out.json) out.data({ ledger: ledgerFile(e.dir), rounds: [], applied: [], stopped: "plateau", climb: climbJson(climbRounds(readLedger(e.dir), key), key, before) });
    else out.print(`${climbPlateauLine(before)}. Nothing to run: roll back to ${before.keep} or change the target, the suite or the objective to start a new climb`);
    return 1;
  }
  const pending = readPending(e.dir);
  let resumeCand: string | undefined;
  if (isResume(c)) {
    if (!pending) throw new CliError("No unfinished refine round to resume in this repo", { reason: "not_found", next: ["See the rounds:", "coding.sh refine log"] });
    if (pending.suite !== o.suite) throw new CliError(`The unfinished round ran suite ${pending.suite}, not ${o.suite}`, { reason: "invalid_argument", next: ["Resume it with:", `coding.sh refine run --suite ${pending.suite} --resume`] });
    const now = new Map(start.files.map((b) => [b.path, sha(b.text)]));
    const moved = pending.base.filter((b) => now.get(b.path) !== b.sha).map((b) => b.path);
    if (moved.length || pending.base.length !== start.files.length) throw new CliError(`The harness files changed since the unfinished round started (${moved.join(", ") || "files added or removed"}); its runs would mix two bases`, { reason: "config_changed", next: ["Start a new round instead (without --resume)"] });
    resumeCand = pending.candidate;
  } else if (pending && !out.json) out.note(`Round ${pending.candidate} did not finish; starting a new round (continue that one with --resume)`);
  await requireConsent(
    c,
    `Run ${plural(perRound, "agent session")} a round (${o.suite}: ${roundsText(f)})${untilPlateau ? " until the climb plateaus" : `, up to ${plural(given.length ? Math.min(given.length, maxRounds) : maxRounds, "round")}`}?`,
    `coding.sh refine run --suite ${o.suite}${untilPlateau ? " --until-plateau" : ""} --yes`,
  );
  const spend = newSpend();
  let agentUsd = 0;
  const done: TestEntry[] = [];
  const applied: string[] = [];
  let stopped: StopReason = "rounds";
  let infra: SuiteRound | undefined;
  let resume: string | undefined;
  let p = before;
  let badProposals = 0;
  let rounds = 0;
  while (rounds < maxRounds) {
    if ((c.drain ?? c.signal).aborted) {
      stopped = "interrupted";
      break;
    }
    const spent = agentUsd + spend.usd + spend.judgeUsd;
    if (e.o.maxCost !== undefined && spent >= e.o.maxCost) {
      stopped = "budget";
      break;
    }
    const base = baseArm(e.root);
    const proposerBefore = spend.usd + spend.judgeUsd;
    let cand: Candidate;
    let resumeFlag: Parameters<typeof runSuiteRound>[5]["resume"] = false;
    if (resumeCand) {
      cand = await resolveCandidate(e, resumeCand, base);
      resumeFlag = c.flags.resume;
      resumeCand = undefined;
    } else if (given.length) {
      if (rounds >= given.length) {
        stopped = "candidates";
        break;
      }
      cand = await resolveCandidate(e, given[rounds]!, base);
    } else {
      try {
        if (mode === "cut") {
          const made = await proposeCut(e, f, o, base, path, spend);
          cand = made.cand;
          if (!out.json) out.note(`Round ${rounds + 1}: proposed ${cand.id}, ${plural(made.edits, "cut")} to ${path}${cand.rationale ? `: ${cand.rationale}` : ""}`);
        } else {
          const prop = await propose(e, base, spend);
          cand = prop.cand;
          if (!out.json) out.note(`Round ${rounds + 1}: proposed ${cand.id} (+${prop.lines.length} lines to ${cand.changed.map((x) => x.path).join(", ")})`);
        }
        badProposals = 0;
      } catch (err) {
        // A reply that is no usable edit is asked again; anything else (no API key, a failing --proposer-command) stops the climb.
        if (!(err instanceof CliError && err.reason === "bad_proposal")) throw err;
        badProposals++;
        if (!out.json) out.warn(`${(err as Error).message}${badProposals < 3 ? "; asking again" : ""}`);
        if (badProposals >= 3) {
          stopped = "proposer";
          break;
        }
        continue;
      }
    }
    const cap = e.o.maxCost === undefined ? undefined : Math.max(0, e.o.maxCost - agentUsd - spend.usd - spend.judgeUsd);
    const r = await climbRound(c, e, f, o, base, cand, { resume: resumeFlag, ...(cap !== undefined ? { cap } : {}), proposerUsd: spend.usd + spend.judgeUsd - proposerBefore });
    rounds++;
    if (r.run) agentUsd += r.run.spentUsd + (r.canaryUsd ?? 0);
    if (r.stopped) {
      stopped = r.stopped;
      if (r.stopped === "infra") infra = r.run;
      resume = `coding.sh refine run --suite ${o.suite}${o.objectives.length > 1 || o.primary !== "pass" ? ` --objective ${o.objectives.join(",")}` : ""}${untilPlateau ? " --until-plateau" : ""} --resume --yes`;
      break;
    }
    const t = r.entry!;
    done.push(t);
    if (t.verdict === "keep") {
      const a = applyCandidate(e.root, e.dir, t.id, false);
      applied.push(t.id);
      if (!out.json) printApplied(c, e.dir, a);
    }
    p = climbPlateau(climbRounds(readLedger(e.dir), key));
    if (!out.json && p.status !== "insufficient") out.print(climbPlateauLine(p));
    if (p.status === "stop") {
      stopped = "plateau";
      break;
    }
  }
  const all = climbRounds(readLedger(e.dir), key);
  const fk = frontKey(o.primary, all);
  if (out.json) {
    out.data({ ledger: ledgerFile(e.dir), rounds: done, applied, stopped, ...infraJson(infra), spent: { agentUsd, proposer: spendJson(spend) }, ...(resume ? { resume, askUser: true } : {}), climb: climbJson(all, key, p) });
  } else {
    const why: Record<StopReason, string> = {
      rounds: `ran ${plural(rounds, "round")}`,
      candidates: "used every --candidate",
      plateau: "the e-detector says the climb stopped gaining",
      budget: "reached --max-cost",
      interrupted: "interrupted",
      proposer: "the proposer gave 3 unusable replies in a row",
      infra: "a round failed on infrastructure, so it has no verdict",
    };
    if (infra) out.warn(infraRoundText(infra)!);
    out.print(`Stopped: ${why[stopped]}. ${plural(done.length, "round")}, ${applied.length} kept and applied, spent ${money(agentUsd + spend.usd + spend.judgeUsd)} (${money(agentUsd)} on agent sessions)`);
    // The resume command carries --yes and spends more: the user approves it, not an agent.
    if (resume) out.note(`The round's finished runs are saved. Continuing spends more, so ask the user first; with their approval: ${resume}`);
    if (fk && all.length) out.print(`Pareto front (pass rate vs ${OBJECTIVE_LABEL[fk]}): ${frontText(all, fk)}`);
    if (p.status === "stop" && p.keep) out.print(`The plateau began at round ${p.result.changePoint} of this climb: the version to keep is ${p.keep}`);
    if (applied.length) out.next("Undo the last applied edit", "coding.sh refine rollback");
    else out.next("See the climb", "coding.sh refine log");
  }
  return applied.length ? 0 : 1;
}

// ---------------------------------------------------------------- refine log

/** The climbs in a ledger, each with its rounds, front and plateau. */
export function climbsOf(entries: readonly LedgerEntry[]): { key: ClimbKey; rounds: ClimbRound[]; tests: TestEntry[]; plateau: ClimbPlateau }[] {
  const keys: ClimbKey[] = [];
  for (const t of tests(entries)) {
    const k = keyOf(t);
    if (k && !keys.some((x) => sameKey(x, k))) keys.push(k);
  }
  return keys.map((key) => {
    const rounds = climbRounds(entries, key);
    return { key, rounds, tests: climbTests(entries, key), plateau: climbPlateau(rounds) };
  });
}

export const climbsJson = (entries: readonly LedgerEntry[]) => climbsOf(entries).map((x) => climbJson(x.rounds, x.key, x.plateau));

const delta = (o: Objective, a: ArmPoint, b: ArmPoint): string => {
  const x = a[o];
  const y = b[o];
  if (x === undefined || y === undefined) return "—";
  return `${fmtValue(o, x)} → ${fmtValue(o, y)}${o === "pass" ? "" : ` (${signed(x > 0 ? y / x - 1 : NaN)})`}`;
};

/** `refine log`: one table per climb (pass, cost and time per round, kept or dropped), its Pareto front and plateau. */
export function printClimbs(c: CommandContext, entries: readonly LedgerEntry[], applied: { live: Set<string>; ever: Set<string> }): void {
  const { out } = c;
  for (const x of climbsOf(entries)) {
    out.print("");
    out.print(`Climb on ${x.key.suite} (${x.key.path}, primary ${OBJECTIVE_LABEL[x.key.primary]})`);
    out.table(
      ["ROUND", "CANDIDATE", "VERDICT", "PASS", "COST/RUN", "WALL/RUN", "SIZE", "REASON"],
      x.tests.map((t) => {
        const a = t.objectives?.arms;
        const state = applied.live.has(t.id) ? ", applied" : applied.ever.has(t.id) ? ", rolled back" : "";
        const cell = (o: Objective) => (a ? delta(o, a.base, a.cand) : "—");
        return [String(t.round), t.id, `${t.verdict}${t.objectives?.branch ? ` (${t.objectives.branch})` : ""}${state}`, cell("pass"), cell("cost"), cell("wall"), cell("size"), verdictReasons(t)[0] ?? ""];
      }),
    );
    const fk = frontKey(x.key.primary, x.rounds);
    if (fk && x.rounds.length) out.print(`Pareto front (pass rate vs ${OBJECTIVE_LABEL[fk]}): ${frontText(x.rounds, fk)}`);
    out.print(climbPlateauLine(x.plateau));
  }
}

// ---------------------------------------------------------------- refine recheck

/** `refine recheck <id> --model <m>`: a suite round's two arms again under another model (stage 3 on its own), ledgered as op 'recheck'. */
export async function climbRecheck(c: CommandContext, e: Env): Promise<number> {
  const { out } = c;
  const id = c.positionals[0];
  if (!id) throw new UsageError("Name the round to re-check: its r_… id", { reason: "missing_argument", suggestion: "coding.sh refine recheck r_3f9a1c02e1 --model <cheaper model>" });
  const model = str(c.flags.model) ?? refineCanaryModel(c.env);
  if (!model) throw new UsageError("refine recheck needs --model: the model to re-run the round under", { reason: "missing_argument", suggestion: `coding.sh refine recheck ${id} --model <cheaper model>` });
  const o = { margin: DEFAULT_MARGIN, minGain: DEFAULT_MIN_GAIN, canary: canaryOpts({ ...c, flags: { ...c.flags, "canary-model": model, canary: "all" } }) };
  const entries = readLedger(e.dir);
  const t = tests(entries).reverse().find((x) => x.id === id || x.id.startsWith(id));
  if (!t) throw new UsageError(`No round ${id} in this repo's ledger`, { reason: "not_found", suggestion: "coding.sh refine log" });
  if (!t.suite?.base || !t.suite.cand) throw new CliError(`Round ${t.id} did not run a suite, so there are no arms to re-run`, { reason: "invalid_argument", next: ["refine recheck re-runs a --suite round; test the edit on a suite first:", `coding.sh refine test ${t.id} --suite <name>`] });
  const A0 = await e.ctx.index.getBundle(t.suite.base);
  const B0 = await e.ctx.index.getBundle(t.suite.cand);
  if (!A0 || !B0) throw new CliError(`The harness bundles of round ${t.id} are no longer in the store`, { reason: "not_found", next: ["Test the edit again on the suite:", `coding.sh refine test ${t.id} --suite ${t.suite.name}`] });
  const why = canaryRefusal(A0, !!getAdapter(A0.agent)?.run);
  if (why) throw new CliError(why, { reason: "unsupported_agent" });
  const f = await loadFitness(c, e.ctx, e.root, t.suite.name);
  const sessions = f.tasks.length * f.k * 2;
  const applied = liveApplies(entries).some((a) => a.candidate === t.id);
  if (e.o.dryRun) {
    if (out.json) out.data({ dryRun: true, candidate: t.id, suite: t.suite.name, model, applied, tasks: f.tasks.length, k: f.k, sessions });
    else out.print(`Would re-run ${t.id}'s base and candidate on ${t.suite.name} under ${model}: ${roundsText(f)} = ${plural(sessions, "agent session")}`);
    return 0;
  }
  await requireConsent(c, `Run ${plural(sessions, "agent session")} (${t.suite.name}: ${roundsText(f)} under ${model})?`, `coding.sh refine recheck ${t.id} --model ${model} --yes`);
  const A = canaryBundle(A0, model);
  const B = canaryBundle(B0, model);
  const r = await canaryRunner(c, e, f, o, `${t.id}@${model}`, e.o.maxCost)(A, B);
  let canary: CanaryRecord;
  const rec = { model, experiment: r.experimentId, base: A.id, cand: B.id, spentUsd: r.spentUsd };
  if (r.cancelled || r.skipped) canary = { ...rec, verdict: "inconclusive", reason: `canary: ${model} ${r.cancelled ? "was interrupted" : `stopped at --max-cost with ${r.skipped} runs not started`}; inconclusive` };
  else {
    const k = canaryCheck(model, r.outcomes, { delta: o.canary.delta, ...(r.tampered ? { tampered: r.tampered } : {}) });
    canary = { ...rec, verdict: k.verdict, reason: k.reason, discordant: k.discordant, ...(k.hardRegressions.length ? { hardRegressions: k.hardRegressions } : {}), ...(k.lower !== undefined ? { lower: k.lower } : {}) };
  }
  const at = new Date().toISOString();
  const entry: RecheckEntry = { op: "recheck", id: `k_${sha(`${t.id}\u0000${model}\u0000${at}`).slice(0, 10)}`, candidate: t.id, at, canary, applied, cost: { usd: r.spentUsd, unpriced: 0 } };
  appendLedger(e.dir, entry);
  const failed = canary.verdict === "regression" || canary.verdict === "inconclusive";
  if (out.json) out.data({ ledger: ledgerFile(e.dir), recheck: entry });
  else {
    if (canary.verdict === "regression") out.fail(canary.reason);
    else if (canary.verdict === "inconclusive") out.warn(canary.reason);
    else out.ok(canary.reason);
    out.print(`Spent ${money(r.spentUsd)} on agent sessions`);
    if (canary.verdict === "regression" && applied) out.next("Undo the applied edit", `coding.sh refine rollback ${t.id}`);
  }
  return failed ? 1 : 0;
}
