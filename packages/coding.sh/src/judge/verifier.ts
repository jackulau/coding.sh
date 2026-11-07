// Verifier precision audit (EM-11): how often does a passing test or command
// grader pass work a human would not accept?
//
// A suite that passes is not proof the change is right: METR found SWE-bench
// passes overstated mergeable PRs by 24.2 pp, and 0 of 15 test-passing PRs in
// another study were mergeable. `judge calibrate` measures LLM judges against
// human labels; this does the same for deterministic graders. Humans label a
// seeded sample of passing cases ("would you accept this?"), and the audit
// reports precision = P(human pass | verifier pass) with a Wilson interval,
// plus P(human pass | verifier fail) when failing cases are labelled too.
//
// A verifier is not tuned on the labels, so every labelled case counts: there
// is no held-out split as there is for judges. The counts use the
// VerifierCrossCheck shape that Z-3's blind-solver cross-check stores at
// task.meta.crossCheck, so the two audits share one format.
import type { VerifierCrossCheck } from "../core/types.ts";
import { fixed, pct } from "../experiments/text.ts";
import { wilson } from "../stats/interval.ts";
import { mulberry32 } from "../stats/prng.ts";
import type { HumanLabel, JudgedCase } from "./calibrate.ts";

/** Labelled verifier passes below which precision is reported but flagged as too few. */
export const DEFAULT_MIN_PASSES = 20;

export interface VerifierAudit extends VerifierCrossCheck {
  source: "human";
  graderId: string;
  /** Grader version the audit belongs to; `exp compare` looks audits up by it. */
  graderVersion: string;
  /** Experiment whose verdicts were audited. Precision transfers only roughly to other configs. */
  experimentId: string;
  criterion?: string;
  /** Labelled verifier passes and fails. */
  passes: number;
  fails: number;
  /** P(human pass | verifier pass) with a 95% Wilson interval; absent with no labelled pass. */
  precision?: number;
  precisionLo?: number;
  precisionHi?: number;
  /** P(human pass | verifier fail), absent with no labelled fail. */
  failPassRate?: number;
  failPassLo?: number;
  failPassHi?: number;
  /** "audited" once `passes` reaches the minimum, else "insufficient-data". */
  state: "audited" | "insufficient-data";
  minPasses: number;
  falseAcceptIds: string[];
  falseRejectIds: string[];
}

export interface AuditOpts {
  graderId: string;
  graderVersion: string;
  experimentId: string;
  criterion?: string;
  /** One verdict per case (first trial). */
  verdicts: ReadonlyMap<string, JudgedCase>;
  labels: readonly HumanLabel[];
  minPasses?: number;
  now?: number;
}

/**
 * One human value per case: labels for the criterion (or criterion-free ones), skips
 * dropped, and a case whose labellers disagree dropped as ambiguous.
 */
export function humanValues(labels: readonly HumanLabel[], criterion?: string): Map<string, "pass" | "fail"> {
  const seen = new Map<string, Set<"pass" | "fail">>();
  for (const l of labels) {
    if (l.value === "skip") continue;
    if (criterion !== undefined && l.criterion !== undefined && l.criterion !== criterion) continue;
    const s = seen.get(l.caseId) ?? new Set();
    s.add(l.value);
    seen.set(l.caseId, s);
  }
  const out = new Map<string, "pass" | "fail">();
  for (const [id, s] of seen) if (s.size === 1) out.set(id, [...s][0]!);
  return out;
}

export function auditVerifier(opts: AuditOpts): VerifierAudit {
  const human = humanValues(opts.labels, opts.criterion);
  const minPasses = opts.minPasses ?? DEFAULT_MIN_PASSES;
  let passes = 0;
  let passOk = 0;
  let fails = 0;
  let failOk = 0;
  const falseAcceptIds: string[] = [];
  const falseRejectIds: string[] = [];
  for (const id of [...opts.verdicts.keys()].sort()) {
    const h = human.get(id);
    if (!h) continue;
    if (opts.verdicts.get(id)!.pass) {
      passes++;
      if (h === "pass") passOk++;
      else falseAcceptIds.push(id);
    } else {
      fails++;
      if (h === "pass") {
        failOk++;
        falseRejectIds.push(id);
      }
    }
  }
  const a: VerifierAudit = {
    source: "human",
    graderId: opts.graderId,
    graderVersion: opts.graderVersion,
    experimentId: opts.experimentId,
    ...(opts.criterion !== undefined ? { criterion: opts.criterion } : {}),
    checked: passes + fails,
    agree: passOk + (fails - failOk),
    falseAccepts: falseAcceptIds.length,
    falseRejects: falseRejectIds.length,
    passes,
    fails,
    state: passes >= minPasses ? "audited" : "insufficient-data",
    minPasses,
    falseAcceptIds,
    falseRejectIds,
    ts: opts.now ?? Date.now(),
  };
  if (passes > 0) {
    const w = wilson(passOk, passes);
    Object.assign(a, { precision: w.p, precisionLo: w.lo, precisionHi: w.hi });
  }
  if (fails > 0) {
    const w = wilson(failOk, fails);
    Object.assign(a, { failPassRate: w.p, failPassLo: w.lo, failPassHi: w.hi });
  }
  return a;
}

export interface VerifierCorrection {
  /** Corrected pass rate: rate · precision + (1 − rate) · P(human pass | verifier fail). */
  p: number;
  lo: number;
  hi: number;
  /** The verifier's observed pass rate. */
  raw: number;
  precision: number;
  /** Labelled passes behind `precision`. */
  n: number;
  /** No labelled fails, so P(human pass | verifier fail) was taken as 0. */
  assumesNoFalseRejects: boolean;
}

/**
 * Pass rate corrected for the verifier's measured precision (and false-reject rate when
 * failing cases were labelled). The interval is a delta-method 95% band over the observed
 * rate (nTest cases) and the two audited proportions; undefined without a precision.
 */
export function verifierCorrected(rate: number, nTest: number, audit: VerifierAudit, z = 1.959963984540054): VerifierCorrection | undefined {
  if (audit.precision === undefined || !(audit.passes > 0) || !(rate >= 0 && rate <= 1)) return undefined;
  const ppv = audit.precision;
  const fpr = audit.failPassRate ?? 0;
  const p = rate * ppv + (1 - rate) * fpr;
  const varRate = nTest > 0 ? (rate * (1 - rate)) / nTest : 0;
  const varPpv = (ppv * (1 - ppv)) / audit.passes;
  const varFor = audit.fails > 0 ? (fpr * (1 - fpr)) / audit.fails : 0;
  const se = Math.sqrt(rate ** 2 * varPpv + (1 - rate) ** 2 * varFor + (ppv - fpr) ** 2 * varRate);
  return {
    p,
    lo: Math.max(0, p - z * se),
    hi: Math.min(1, p + z * se),
    raw: rate,
    precision: ppv,
    n: audit.passes,
    assumesNoFalseRejects: audit.failPassRate === undefined,
  };
}

/**
 * The labelling queue: verifier passes with no human value yet, in a seeded shuffle so a
 * re-run with the same seed asks for the same cases and the sample stays unbiased.
 */
export function samplePasses(verdicts: ReadonlyMap<string, JudgedCase>, labels: readonly HumanLabel[], n: number, opts: { criterion?: string; seed?: number } = {}): string[] {
  const human = humanValues(labels, opts.criterion);
  const pool = [...verdicts.values()].filter((v) => v.pass && !human.has(v.caseId)).map((v) => v.caseId).sort();
  const rand = mulberry32(opts.seed ?? 0);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, Math.max(0, n));
}

/** Labels from a file: a JSON array or JSONL rows of {"caseId","value":"pass"|"fail"|"skip","criterion"?}. */
export function parseCaseLabels(rows: readonly unknown[]): HumanLabel[] {
  return rows.map((r, i) => {
    if (!r || typeof r !== "object" || Array.isArray(r)) throw new TypeError(`row ${i + 1} must be an object`);
    const o = r as Record<string, unknown>;
    if (typeof o.caseId !== "string" || !o.caseId) throw new TypeError(`row ${i + 1}: caseId must be a non-empty string`);
    if (o.value !== "pass" && o.value !== "fail" && o.value !== "skip") throw new TypeError(`row ${i + 1}: value must be pass, fail or skip`);
    if (o.criterion !== undefined && typeof o.criterion !== "string") throw new TypeError(`row ${i + 1}: criterion must be a string`);
    const l: HumanLabel = { caseId: o.caseId, value: o.value };
    if (typeof o.criterion === "string") l.criterion = o.criterion;
    return l;
  });
}

/** One line, e.g. "verifier precision 0.78 [0.63, 0.88] (n=40); 9 false accepts". */
export function formatVerifierAudit(a: Pick<VerifierAudit, "precision" | "precisionLo" | "precisionHi" | "passes" | "falseAccepts">): string {
  if (a.precision === undefined) return "verifier precision: no labelled passes";
  const fa = `${a.falseAccepts} false accept${a.falseAccepts === 1 ? "" : "s"}`;
  return `verifier precision ${fixed(a.precision)} [${fixed(a.precisionLo)}, ${fixed(a.precisionHi)}] (n=${a.passes}); ${fa}`;
}

/** Plain-text audit report for `judge calibrate --grader <verifier>`. */
export function renderVerifierAudit(a: VerifierAudit): string {
  const lines = [`Verifier ${a.graderId} (${a.graderVersion})${a.criterion ? ` criterion ${a.criterion}` : ""}`, formatVerifierAudit(a)];
  if (a.failPassRate !== undefined) {
    lines.push(`labelled fails a human accepted: ${a.falseRejects} of ${a.fails} (${pct(a.failPassRate)} [${pct(a.failPassLo!)}, ${pct(a.failPassHi!)}])`);
  } else {
    lines.push("no labelled fails: corrected pass rates assume the verifier never rejects good work");
  }
  lines.push(`agreement ${a.agree} of ${a.checked} labelled case(s)`);
  if (a.falseAcceptIds.length) lines.push(`false accepts: ${a.falseAcceptIds.slice(0, 10).join(", ")}${a.falseAcceptIds.length > 10 ? ` (+${a.falseAcceptIds.length - 10} more)` : ""}`);
  if (a.state === "insufficient-data") lines.push(`only ${a.passes} labelled pass(es); label at least ${a.minPasses} (--sample-passes ${a.minPasses - a.passes}) before trusting the number`);
  return lines.join("\n");
}
