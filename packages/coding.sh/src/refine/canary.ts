// Canary-model re-test (Z-14, K7). A harness edit that passes every check under
// the loop's model can still remove a safeguard that model did not need: a
// weaker model then fails or misbehaves where the old harness held it. For a
// kept candidate that deletes or rewords existing lines (or every kept
// candidate, with --canary all), stage 3 runs base and candidate again with
// the model swapped for a cheaper canary and rejects the candidate on:
//   - a hard regression: a task the base passed in every attempt that the
//     candidate passes in at most a third of them,
//   - more passing runs flagged for test tampering than the base had,
//   - a paired bootstrap lower bound on the pass-rate change at or below −delta.
// Fewer than 3 discordant tasks per arm and no hard regression leave the
// decision as it was, marked canary-uninformative. A subtractive candidate
// tested with no canary model keeps its decision with a note saying why that
// is weak evidence. Pure, apart from the injected `runArms`.
import { bundleId } from "../runner/bundle.ts";
import { pairedBootstrap } from "../stats/interval.ts";
import type { HarnessBundle } from "../core/types.ts";
import type { RefineVerdict } from "./decide.ts";
import { removedLines } from "./cut.ts";
import type { ArmOutcomes } from "./keep.ts";

export const CANARY_POLICIES = ["subtractive", "all", "off"] as const;
export type CanaryPolicy = (typeof CANARY_POLICIES)[number];
export const DEFAULT_CANARY_DELTA = 0.1;
/** A hard regression: base pass^k = 1 and the candidate passes at most this share. */
export const HARD_REGRESSION_MAX = 1 / 3;
/** Fewer discordant tasks than this on each side says nothing either way. */
export const MIN_DISCORDANT = 3;

/** Agents whose headless driver ignores the bundle's model. */
const NO_MODEL = new Set(["amp"]);

interface TextFile {
  path: string;
  text: string;
}

/** Lines the candidate deletes or rewords in files the base already had. */
export function removedCount(base: readonly TextFile[], cand: readonly TextFile[]): number {
  let n = 0;
  for (const c of cand) {
    const b = base.find((x) => x.path === c.path);
    if (b) n += removedLines(b.text, c.text).length;
  }
  return n;
}

/** Whether the policy asks for stage 3 on this candidate. */
export const canaryWanted = (policy: CanaryPolicy, removed: number): boolean => policy === "all" || (policy === "subtractive" && removed > 0);

/**
 * Why this bundle's agent can't run under another model, or undefined when it
 * can. The wrapper agent can when its command line has a `{model}` slot.
 */
export function canaryRefusal(b: Pick<HarnessBundle, "agent" | "flags">, hasDriver: boolean): string | undefined {
  if (!hasDriver) return `Agent ${b.agent} has no headless driver, so it can't be re-run under a canary model`;
  if (b.agent === "wrapper") return b.flags.some((f) => f.includes("{model}")) ? undefined : "The wrapper agent's command line has no {model} slot, so a canary model can't reach it: add {model} where the command takes its model";
  if (NO_MODEL.has(b.agent)) return `Agent ${b.agent} picks its own model and ignores an override, so a canary model can't be tested`;
  return undefined;
}

/** The bundle with its model swapped: name `<name>@<model>`, its own content id. */
export function canaryBundle(b: HarnessBundle, model: string): HarnessBundle {
  const body = { name: `${b.name}@${model}`, agent: b.agent, model, flags: b.flags, env: b.env, files: b.files, remove: b.remove, ...(b.plugins ? { plugins: b.plugins } : {}) };
  return { ...b, ...body, id: bundleId(body), createdAt: b.createdAt, note: `canary of ${b.name} under ${model}` };
}

export interface CanaryCheck {
  model: string;
  verdict: "pass" | "regression" | "uninformative";
  /** One line for the decision's reasons. */
  reason: string;
  hardRegressions: string[];
  /** Tasks where only that arm did better. */
  discordant: { base: number; cand: number };
  /** Paired bootstrap 95% lower bound of the per-task pass-rate change (candidate − base). */
  lower?: number;
  tampered?: { base: number; cand: number };
}

const rate = (xs: readonly boolean[]): number => xs.filter(Boolean).length / xs.length;
const pct = (x: number): string => `${x > 0 ? "+" : ""}${Math.round(x * 100)} pts`;

/** K7 on the canary runs. */
export function canaryCheck(model: string, s: ArmOutcomes, o: { delta?: number; tampered?: { base: number; cand: number }; seed?: number } = {}): CanaryCheck {
  const delta = o.delta ?? DEFAULT_CANARY_DELTA;
  const hard: string[] = [];
  const diffs: number[] = [];
  const discordant = { base: 0, cand: 0 };
  for (const [task, a] of [...s.base].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    const b = s.cand.get(task);
    if (!a.length || !b?.length) continue;
    const ra = rate(a);
    const rb = rate(b);
    diffs.push(rb - ra);
    if (ra > rb) discordant.base++;
    if (rb > ra) discordant.cand++;
    if (ra === 1 && rb <= HARD_REGRESSION_MAX + 1e-9) hard.push(task);
  }
  const base = { model, hardRegressions: hard, discordant, ...(o.tampered ? { tampered: o.tampered } : {}) };
  const fail = (check: string): CanaryCheck => ({ ...base, verdict: "regression", reason: `canary-regression: ${model}: ${check}` });
  if (hard.length) return fail(`hard regression on ${hard.slice(0, 5).join(", ")}${hard.length > 5 ? ` +${hard.length - 5} more` : ""} (the base passed every attempt, the candidate at most a third)`);
  if (o.tampered && o.tampered.cand > o.tampered.base) return fail(`${o.tampered.cand} passing runs tampered with tests (base: ${o.tampered.base})`);
  if (discordant.base < MIN_DISCORDANT && discordant.cand < MIN_DISCORDANT) {
    return { ...base, verdict: "uninformative", reason: `canary-uninformative: ${model} (${discordant.base + discordant.cand} of ${diffs.length} tasks differ between the arms; the canary can't tell them apart)` };
  }
  const ci = pairedBootstrap(diffs, { seed: o.seed ?? 7 });
  const withLower = { ...base, lower: ci.lo };
  if (ci.lo <= -delta) return { ...withLower, verdict: "regression", reason: `canary-regression: ${model}: pass rate ${pct(ci.mean)}, lower bound ${pct(ci.lo)} at or below ${pct(-delta)}` };
  return { ...withLower, verdict: "pass", reason: `canary: ${model} held (pass rate ${pct(ci.mean)}, lower bound ${pct(ci.lo)})` };
}

/** The note a subtractive candidate gets when no canary ran. */
export const subtractiveNote = (removed: number): string =>
  `removes ${removed} existing line${removed === 1 ? "" : "s"}; a success-only gate cannot see masked safeguard loss; re-test with --canary-model <cheaper model>`;

/** What the ledger keeps of stage 3. */
export interface CanaryRecord {
  model: string;
  verdict: CanaryCheck["verdict"] | "inconclusive";
  reason: string;
  experiment?: string;
  /** The canary bundles (their ids differ from the loop's arms). */
  base?: string;
  cand?: string;
  hardRegressions?: string[];
  discordant?: { base: number; cand: number };
  lower?: number;
  spentUsd?: number;
}

/** One canary experiment, run by the caller (the suite runner, or a fake in tests). */
export interface CanaryArmsRun {
  experimentId: string;
  cancelled: boolean;
  /** Runs not started because the spend cap was reached. */
  skipped: number;
  spentUsd: number;
  outcomes: ArmOutcomes;
  tampered?: { base: number; cand: number };
}

export interface CanaryStageInput {
  verdict: RefineVerdict;
  reasons: readonly string[];
  /** Lines the candidate deletes or rewords. */
  removed: number;
  policy: CanaryPolicy;
  model?: string;
  delta?: number;
  base: HarnessBundle;
  cand: HarnessBundle;
  runArms: (base: HarnessBundle, cand: HarnessBundle) => Promise<CanaryArmsRun>;
}

export interface CanaryStageResult {
  verdict: RefineVerdict;
  reasons: string[];
  canary?: CanaryRecord;
  /** True when stage 3 ran an experiment. */
  ran: boolean;
}

/** Stage 3: only for a kept candidate the policy selects, and only with a canary model. */
export async function canaryStage(x: CanaryStageInput): Promise<CanaryStageResult> {
  const same = { verdict: x.verdict, reasons: [...x.reasons], ran: false };
  if (x.verdict !== "keep" || x.policy === "off") return same;
  if (!x.model) return x.removed > 0 ? { ...same, reasons: [...x.reasons, subtractiveNote(x.removed)] } : same;
  if (!canaryWanted(x.policy, x.removed)) return same;
  const A = canaryBundle(x.base, x.model);
  const B = canaryBundle(x.cand, x.model);
  const r = await x.runArms(A, B);
  const rec = { model: x.model, experiment: r.experimentId, base: A.id, cand: B.id, spentUsd: r.spentUsd };
  if (r.cancelled || r.skipped) {
    const reason = `canary: ${x.model} ${r.cancelled ? "was interrupted" : `stopped at the spend cap with ${r.skipped} runs not started`}; inconclusive`;
    return { verdict: "inconclusive", reasons: [...x.reasons, reason], canary: { ...rec, verdict: "inconclusive", reason }, ran: true };
  }
  const k = canaryCheck(x.model, r.outcomes, { ...(x.delta !== undefined ? { delta: x.delta } : {}), ...(r.tampered ? { tampered: r.tampered } : {}) });
  const canary: CanaryRecord = { ...rec, verdict: k.verdict, reason: k.reason, discordant: k.discordant, ...(k.hardRegressions.length ? { hardRegressions: k.hardRegressions } : {}), ...(k.lower !== undefined ? { lower: k.lower } : {}) };
  return { verdict: k.verdict === "regression" ? "reject" : x.verdict, reasons: [...x.reasons, k.reason], canary, ran: true };
}
