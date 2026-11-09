// Case kinds (TB-12): a change to a prompt, a tool description or a build is
// tested on three kinds of case. A `bad` case reproduces the failure the change
// is for: it must fail on the old version and pass on the new one. A `guard`
// case covers behavior that already works near the change and must keep
// passing. A `control` case is one where the fix must not kick in; when it
// breaks, the change overcorrected. Cases without a kind are ordinary cases and
// are left out of everything here.
//
// The helpers take plain per-case outcomes, so `exp` (dataset cases) and
// `toolevals` (tasks) share them.
import { pairedBootstrap, wilson } from "../stats/interval.ts";
import { CASE_KINDS, type Case, type CaseKind, type KindSummary } from "./types.ts";

export function isCaseKind(v: unknown): v is CaseKind {
  return typeof v === "string" && (CASE_KINDS as readonly string[]).includes(v);
}

/** What each kind must do on the old version and on the new one, for help text and reports. */
export const KIND_RULES: Readonly<Record<CaseKind, string>> = {
  bad: "fails on the old version, passes on the new one",
  guard: "passes on both: behavior near the change that already works",
  control: "passes on both: the fix must not kick in here, so a break means overcorrection",
};

/** Case id → kind, for the cases that have one. */
export function kindMap(cases: readonly Pick<Case, "id" | "kind">[]): Map<string, CaseKind> {
  const out = new Map<string, CaseKind>();
  for (const c of cases) if (c.kind) out.set(c.id, c.kind);
  return out;
}

/** Copy each case's kind onto its runs, so a stored result can be split without the dataset. Runs of ordinary cases are left as they are. */
export function stampKinds<R extends { caseId: string; kind?: CaseKind }>(runs: readonly R[], cases: readonly Pick<Case, "id" | "kind">[]): R[] {
  const kinds = kindMap(cases);
  if (!kinds.size) return runs as R[];
  return runs.map((r) => {
    const k = kinds.get(r.caseId);
    return k && r.kind !== k ? { ...r, kind: k } : r;
  });
}

/** The least a run must say to be split by kind. */
export interface KindRun {
  caseId: string;
  kind?: CaseKind;
  pass: boolean;
  ungraded?: boolean;
}

/**
 * Pass rate per kind, over graded runs. One trial per case gets a Wilson
 * interval; several get a bootstrap over per-case rates, since trials of one
 * case are correlated. Undefined when no run has a kind.
 */
export function summarizeKinds(runs: readonly KindRun[], trials: number, boot: { iters: number; seed: number } = { iters: 2000, seed: 0x5eed }): Partial<Record<CaseKind, KindSummary>> | undefined {
  if (!runs.some((r) => r.kind)) return undefined;
  const out: Partial<Record<CaseKind, KindSummary>> = {};
  for (const kind of CASE_KINDS) {
    const mine = runs.filter((r) => r.kind === kind);
    if (!mine.length) continue;
    const graded = mine.filter((r) => !r.ungraded);
    const passed = graded.filter((r) => r.pass).length;
    const ungraded = mine.length - graded.length;
    let passRate = wilson(passed, graded.length);
    if (trials > 1 && graded.length) {
      const rates = [...perCase(graded).values()].map((x) => x.passes / x.trials);
      const b = pairedBootstrap(rates, boot);
      passRate = { p: passed / graded.length, lo: Number.isNaN(b.lo) ? 0 : b.lo, hi: Number.isNaN(b.hi) ? 1 : b.hi };
    }
    out[kind] = { cases: new Set(mine.map((r) => r.caseId)).size, n: mine.length, passed, ...(ungraded ? { ungraded } : {}), passRate };
  }
  return out;
}

function perCase(runs: readonly KindRun[]): Map<string, { passes: number; trials: number }> {
  const m = new Map<string, { passes: number; trials: number }>();
  for (const r of runs) {
    const a = m.get(r.caseId) ?? { passes: 0, trials: 0 };
    a.trials++;
    if (r.pass) a.passes++;
    m.set(r.caseId, a);
  }
  return m;
}

// ---------------------------------------------------------------- old vs new

/** A case passes on a side when more than half its graded trials pass (a case fails at half or more failing). */
const passes = (rate: number): boolean => rate > 0.5;

export interface KindComparison {
  kind: CaseKind;
  /** Cases of this kind graded on both sides. */
  paired: number;
  /** Mean per-case pass rate on the old side (A) and the new side (B). */
  a: number;
  b: number;
  /** bad: failed on A, pass on B. */
  fixed?: string[];
  /** bad: fail on B. */
  stillFailing?: string[];
  /** bad: passed on A already, so they don't show the fix. */
  passedBefore?: string[];
  /** guard / control: passed on A, fail on B. A broken control is overcorrection. */
  broken?: string[];
}

export interface KindComparisonReport {
  kinds: KindComparison[];
  /** Guard cases that passed on A and fail on B. */
  regressions: string[];
  /** Control cases that passed on A and fail on B. */
  overcorrections: string[];
  notes: string[];
}

const ids = (xs: readonly string[], max = 5) => (xs.length > max ? `${xs.slice(0, max).join(", ")} and ${xs.length - max} more` : xs.join(", "));

/**
 * Split an old-vs-new comparison by kind. `a` and `b` map case id → pass rate
 * over that side's graded trials. Undefined when no paired case has a kind.
 */
export function compareKinds(kindOf: ReadonlyMap<string, CaseKind>, a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): KindComparisonReport | undefined {
  const kinds: KindComparison[] = [];
  const notes: string[] = [];
  let regressions: string[] = [];
  let overcorrections: string[] = [];
  for (const kind of CASE_KINDS) {
    const paired = [...kindOf].filter(([id, k]) => k === kind && a.has(id) && b.has(id)).map(([id]) => id).sort();
    if (!paired.length) continue;
    const ra = paired.map((id) => a.get(id)!);
    const rb = paired.map((id) => b.get(id)!);
    const k: KindComparison = { kind, paired: paired.length, a: mean(ra), b: mean(rb) };
    if (kind === "bad") {
      k.fixed = paired.filter((id) => !passes(a.get(id)!) && passes(b.get(id)!));
      k.stillFailing = paired.filter((id) => !passes(b.get(id)!));
      k.passedBefore = paired.filter((id) => passes(a.get(id)!));
      if (k.stillFailing.length) notes.push(`${k.stillFailing.length} of ${paired.length} bad case(s) still fail on B: ${ids(k.stillFailing)}`);
      if (k.passedBefore.length) notes.push(`${k.passedBefore.length} bad case(s) already passed on A, so they don't show the fix: ${ids(k.passedBefore)}`);
    } else {
      k.broken = paired.filter((id) => passes(a.get(id)!) && !passes(b.get(id)!));
      if (kind === "guard") regressions = k.broken;
      else overcorrections = k.broken;
      if (k.broken.length) notes.push(kind === "guard" ? `regression: ${k.broken.length} guard case(s) passed on A and fail on B: ${ids(k.broken)}` : `overcorrection: ${k.broken.length} control case(s) passed on A and fail on B: ${ids(k.broken)}`);
    }
    kinds.push(k);
  }
  if (!kinds.length) return undefined;
  return { kinds, regressions, overcorrections, notes };
}

function mean(xs: readonly number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN;
}

// ---------------------------------------------------------------- --against

/** One kinded case's trials on the version it was written against. */
export interface AgainstRow {
  caseId: string;
  kind: CaseKind;
  passes: number;
  trials: number;
  /** The run errored before it could be checked (setup, network): neither a pass nor a fail. */
  error?: string;
}

export interface AgainstCase extends AgainstRow {
  ok: boolean;
  problem?: string;
}

export interface AgainstReport {
  variant: string;
  ok: boolean;
  cases: AgainstCase[];
  /** Cases per kind, and how many hold. */
  counts: Partial<Record<CaseKind, { cases: number; ok: number }>>;
}

/**
 * Check kinded cases on the old version they were written against: a bad case
 * must fail every trial there (else it does not reproduce the failure), and a
 * guard or control must pass every trial there (else it cannot catch a break).
 */
export function checkAgainst(rows: readonly AgainstRow[], variant: string): AgainstReport {
  const cases: AgainstCase[] = rows.map((r) => {
    if (r.error !== undefined || r.trials === 0) return { ...r, ok: false, problem: `couldn't run on ${variant}: ${r.error ?? "no trial finished"}` };
    if (r.kind === "bad") {
      return r.passes === 0 ? { ...r, ok: true } : { ...r, ok: false, problem: `bad case passes on ${variant} (${r.passes}/${r.trials}): it doesn't reproduce the failure it was written for` };
    }
    return r.passes === r.trials ? { ...r, ok: true } : { ...r, ok: false, problem: `${r.kind} case fails on ${variant} (${r.passes}/${r.trials} pass): it can't catch ${r.kind === "control" ? "an overcorrection" : "a regression"} if it already fails` };
  });
  const counts: AgainstReport["counts"] = {};
  for (const c of cases) {
    const x = (counts[c.kind] ??= { cases: 0, ok: 0 });
    x.cases++;
    if (c.ok) x.ok++;
  }
  return { variant, ok: cases.every((c) => c.ok), cases, counts };
}
