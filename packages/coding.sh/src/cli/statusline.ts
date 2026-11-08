// Pure rendering for `coding.sh statusline`. Kept apart from the command's IO so
// the line format and the worst-flag choice can be unit-tested without a store.
import { failureFlags } from "../core/sessions.ts";
import { FLAG_DIAGNOSIS } from "../refine/taxonomy.ts";
import { usd } from "./output.ts";

// Defect first, then risk, then inefficiency (src/refine/severity.ts NATURE_ORDER).
const NATURE_RANK: Record<string, number> = { defect: 0, risk: 1, inefficiency: 2 };

function rank(flag: string): number {
  const d = FLAG_DIAGNOSIS[flag];
  if (d === undefined || d === "context-only") return 9;
  return NATURE_RANK[d.nature] ?? 9;
}

/**
 * The single worst real-failure flag to surface, or undefined. Tags (flags with
 * a colon) and context-only flags are not failures; among the rest, a defect
 * beats a risk beats an inefficiency.
 */
export function worstFailureFlag(flags: readonly string[]): string | undefined {
  const real = failureFlags(flags).filter((f) => FLAG_DIAGNOSIS[f] !== "context-only");
  if (real.length === 0) return undefined;
  return [...real].sort((a, b) => rank(a) - rank(b))[0];
}

export interface StatuslineInput {
  model?: string;
  sessionCostUsd?: number;
  todayCostUsd?: number;
  flags?: readonly string[];
}

/**
 * One compact line: `model  ·  $x session  ·  $y today  ·  ! worst-flag`.
 * The flag part is dropped when there is no real failure to report.
 */
export function statuslineLine(input: StatuslineInput): string {
  const parts: string[] = [];
  if (input.model) parts.push(input.model);
  parts.push(`${usd(input.sessionCostUsd ?? 0)} session`);
  parts.push(`${usd(input.todayCostUsd ?? 0)} today`);
  const worst = input.flags ? worstFailureFlag(input.flags) : undefined;
  if (worst) parts.push(`! ${worst}`);
  return parts.join("  ·  ");
}
