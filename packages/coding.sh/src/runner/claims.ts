// Claim calibration per arm: how often an agent's final answer says the work is
// done, how often the verifier agrees, and how often it claims success on a run
// the verifier failed (a silent failure). Reads the final answer the runner
// stores on each run (RunResult.agent.finalText) and the verifier's pass.
import { claimsSuccess, reportsFailure } from "../core/failure-report.ts";
import type { RunResult } from "../core/types.ts";
import { infraKind } from "../jobs/retry.ts";

/** What a run's final answer says: it claims success, it reports a failure, or neither. */
export type ClaimKind = "claim" | "failure-report" | "none";

export interface ArmClaims {
  /** Runs counted: not cancelled, not superseded, not lost to infrastructure. */
  runs: number;
  /** Runs whose final answer claims success and reports no failure. */
  claims: number;
  /** Runs whose final answer reports a failing check. */
  failureReports: number;
  /** claims / runs. */
  claimRate: number;
  /** Verifier passes among claims; absent when the arm made no claim. */
  claimPrecision?: number;
  /** Claims the verifier failed. */
  silentFailures: number;
  /** silentFailures / runs. */
  silentFailureRate: number;
}

/** Classify one final answer. */
export function claimKind(text: string | undefined): ClaimKind {
  if (reportsFailure(text)) return "failure-report";
  return claimsSuccess(text) ? "claim" : "none";
}

/** Whether a run says nothing about the agent: interrupted, retried, or lost to infrastructure. */
function uncounted(r: RunResult): boolean {
  return !!(r.cancelled || r.superseded || r.infra || (!r.pass && infraKind(r.error)));
}

/** Claim rate, claim precision and silent-failure rate per arm (bundle id). */
export function claimCalibration(runs: readonly RunResult[]): Map<string, ArmClaims> {
  const out = new Map<string, ArmClaims>();
  const tally = new Map<string, { runs: number; claims: number; reports: number; passed: number }>();
  for (const r of runs) {
    if (uncounted(r)) continue;
    const t = tally.get(r.bundleId) ?? { runs: 0, claims: 0, reports: 0, passed: 0 };
    tally.set(r.bundleId, t);
    t.runs++;
    const k = claimKind(r.agent?.finalText);
    if (k === "failure-report") t.reports++;
    else if (k === "claim") {
      t.claims++;
      if (r.pass) t.passed++;
    }
  }
  for (const [id, t] of tally) {
    const silent = t.claims - t.passed;
    const arm: ArmClaims = {
      runs: t.runs,
      claims: t.claims,
      failureReports: t.reports,
      claimRate: t.runs ? t.claims / t.runs : 0,
      silentFailures: silent,
      silentFailureRate: t.runs ? silent / t.runs : 0,
    };
    if (t.claims) arm.claimPrecision = t.passed / t.claims;
    out.set(id, arm);
  }
  return out;
}

/** An arm with no counted runs. */
export const NO_CLAIMS: ArmClaims = { runs: 0, claims: 0, failureReports: 0, claimRate: 0, silentFailures: 0, silentFailureRate: 0 };
