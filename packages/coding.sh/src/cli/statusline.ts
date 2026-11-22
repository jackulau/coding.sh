// Pure rendering for `coding.sh statusline`. Kept apart from the command's IO so
// the line format and the worst-flag choice can be unit-tested without a store.
import { failureFlags } from "../core/sessions.ts";
import { FLAG_DIAGNOSIS } from "../refine/taxonomy.ts";
import { ago, usd } from "./output.ts";

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
  /** How full the context window is, 0 to 100 (Claude Code's context_window.used_percentage). */
  contextPercent?: number;
  /** This session's cost; the part is left out when undefined (a session the store does not know). */
  sessionCostUsd?: number;
  todayCostUsd?: number;
  flags?: readonly string[];
  /** Since when the ingest the hook starts has been failing (core/ingest-health.ts); unset while it works. */
  ingestStoppedSince?: number;
  /** Work items blocked on the user or failed (core/work.ts needYou); the part is left out at 0. */
  needYou?: number;
}

/** `! ingest stopped 4h ago`: the costs on the line are then as old as that. */
export function ingestStoppedPart(since: number, now = Date.now()): string {
  return `! ingest stopped ${ago(since, { now })}`;
}

/** From this fill the context part says `full`: the session is close to compacting. */
export const CONTEXT_FULL_PERCENT = 85;

/** `ctx 62%`, or `ctx 87% full` at 85% or more. */
export function contextPart(percent: number): string {
  const p = Math.round(percent);
  return p >= CONTEXT_FULL_PERCENT ? `ctx ${p}% full` : `ctx ${p}%`;
}

/**
 * One compact line: `model  ·  ctx 62%  ·  $x session  ·  $y today  ·  ! worst-flag`.
 * The context part shows when the agent sent it, the session part when the session is known; the
 * flag part is dropped when there is no real failure to report; a stopped
 * ingest adds `! ingest stopped 4h ago`, and work items blocked on you or failed add `2 need you`.
 */
export function statuslineLine(input: StatuslineInput): string {
  const parts: string[] = [];
  if (input.model) parts.push(input.model);
  if (input.contextPercent !== undefined) parts.push(contextPart(input.contextPercent));
  if (input.sessionCostUsd !== undefined) parts.push(`${usd(input.sessionCostUsd)} session`);
  parts.push(`${usd(input.todayCostUsd ?? 0)} today`);
  const worst = input.flags ? worstFailureFlag(input.flags) : undefined;
  if (worst) parts.push(`! ${worst}`);
  if (input.ingestStoppedSince !== undefined) parts.push(ingestStoppedPart(input.ingestStoppedSince));
  if (input.needYou) parts.push(`${input.needYou} need you`);
  return parts.join("  ·  ");
}
