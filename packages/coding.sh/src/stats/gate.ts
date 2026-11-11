// Plain words for an acceptance gate result (tests.ts acceptanceGate): a
// headline anyone can act on, and a detail line with the numbers behind it.
import type { GateResult } from "./tests.ts";

/**
 * "ship": the gate accepted. "dont-ship": it abstained because B breaks
 * solved items beyond chance: among the items that changed outcome, the
 * losses beat an exact one-sided binomial test at p = 1/2 (breakP < α).
 * "hold": it abstained for lack of evidence, including losses that A/A noise
 * explains as well as a real regression.
 */
export type GateVerdict = "ship" | "hold" | "dont-ship";

export function gateVerdict(g: Pick<GateResult, "decision" | "losses" | "reasons" | "breakP" | "alpha">): GateVerdict {
  if (g.decision === "accept") return "ship";
  if (g.reasons.includes("stratum-regression")) return "dont-ship";
  if (g.losses > 0 && g.breakP < g.alpha) return "dont-ship";
  return "hold";
}

/**
 * The verdict for a guard set (refine's K8): "dont-ship" whenever B breaks
 * more solved items than τ allows or its λ-weighted gain is not positive,
 * without the binomial test. A guard set is the few tasks a kept edit fixed,
 * so losing them is the failure it exists to catch, and four tasks could
 * never reach breakP < α.
 */
export function guardVerdict(g: Pick<GateResult, "decision" | "losses" | "reasons">): GateVerdict {
  if (g.decision === "accept") return "ship";
  if (g.reasons.includes("stratum-regression")) return "dont-ship";
  if (g.losses > 0 && (g.reasons.includes("regression-fraction") || g.reasons.includes("net-gain"))) return "dont-ship";
  return "hold";
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/**
 * One line, no statistics: "Ship it: B wins 14 tasks, loses 1", "Hold: not
 * enough evidence (…)", "Don't ship: B breaks 3 tasks A solved". `noun` is
 * the singular item name ("task", "case").
 */
export function gateHeadline(g: GateResult & { verdict?: GateVerdict }, noun: string): string {
  // A gate that carries its verdict (a task group gated like a guard set) is headed by that verdict.
  switch (g.verdict ?? gateVerdict(g)) {
    case "ship":
      return `Ship it: B wins ${count(g.wins, noun)}, loses ${g.losses}`;
    case "dont-ship":
      return `Don't ship: B breaks ${count(g.losses, noun)} A solved${g.wins ? ` (and wins ${g.wins})` : ""}`;
    default:
      if (g.wins + g.losses === 0) return `Hold: not enough evidence (no ${noun} changed outcome)`;
      if (g.losses >= g.wins) return `Hold: not enough evidence (B wins ${g.wins}, loses ${g.losses}; within chance)`;
      // More wins than losses: name the reason that holds it, most specific first.
      if (g.reasons.includes("regression-fraction")) {
        return `Hold: B wins ${g.wins}, loses ${g.losses}, but breaks ${pctOf(g.regressionFraction)} of the ${count(g.solved, noun)} A solved (over τ ${pctOf(g.tau)})`;
      }
      if (g.losses === 0) return `Hold: not enough evidence (B wins ${g.wins}, loses 0; needs ${g.minCleanWins}+ wins with no losses)`;
      if (g.reasons.includes("net-gain")) return `Hold: B wins ${g.wins}, loses ${g.losses}; with each loss counted ${num(g.lambda)} times, B gains nothing`;
      return `Hold: not enough evidence (B wins ${g.wins}, loses ${g.losses}; within chance)`;
  }
}

const pctOf = (x: number) => `${Math.round(x * 1000) / 10}%`;
const num = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1));

/**
 * The numbers behind the headline, e.g. "abstain (not-significant) · 6 won, 0
 * lost of 6 solved (0%) · net +6 at λ=2 · p = 0.088 ≥ α 0.05 · needs ≥8 clean wins".
 */
export function gateDetail(g: GateResult): string {
  const parts = [g.decision === "accept" ? "accept" : `abstain (${g.reasons.join(", ")})`];
  const over = g.regressionFraction > g.tau ? ` > τ ${pctOf(g.tau)}` : "";
  parts.push(`${g.wins} won, ${g.losses} lost of ${g.solved} solved (${pctOf(g.regressionFraction)}${over})`);
  parts.push(`net ${g.netGain > 0 ? "+" : ""}${num(g.netGain)} at λ=${num(g.lambda)}`);
  const p = g.p < 0.001 ? "p < 0.001" : `p = ${g.p.toFixed(3)}`;
  parts.push(`${p} ${g.p < g.alpha ? "<" : "≥"} α ${g.alpha}`);
  if (g.decision !== "accept" && g.losses > 0) {
    const bp = g.breakP < 0.001 ? "< 0.001" : `= ${g.breakP.toFixed(3)}`;
    parts.push(`breaks p ${bp} ${g.breakP < g.alpha ? "<" : "≥"} α ${g.alpha}`);
  }
  if (g.reasons.includes("not-significant") || g.reasons.includes("no-discordant")) parts.push(`needs ≥${g.minCleanWins} clean wins`);
  return parts.join(" · ");
}

/** Up to `max` ids, then "(+N more)". */
export function idList(ids: readonly string[], max = 5): string {
  return ids.slice(0, max).join(", ") + (ids.length > max ? ` (+${ids.length - max} more)` : "");
}
