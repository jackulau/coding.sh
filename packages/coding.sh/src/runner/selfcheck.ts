// What the agent's own tests said before the verifier ran. BOBA (arXiv
// 2611.02207 §5, App. C.2): 59% of misses came right after a clean local test
// run, and a green self-test barely moved the hidden-test pass rate ("agents
// test what they wrote, not what was asked"). compare splits each arm's failed
// runs by the agent's last test result to show those silent misses.
import type { AgentEvent, RunResult, Session } from "../core/types.ts";
import { wilson, type Interval } from "../stats/interval.ts";

/**
 * green: the last test run had 0 failures and some passes, and no file changed after it.
 * stale: green, then files changed. red: the last test run had failures.
 * none: the agent never ran tests (that coding.sh could parse). unknown: no captured session.
 */
export type SelfCheck = "green" | "stale" | "red" | "none" | "unknown";

export interface SelfCheckSummary {
  /** Failed runs (cancelled runs are left out before this). */
  fails: number;
  /** Failed runs by the agent's own last test result; they sum to `fails`. */
  green: number;
  red: number;
  stale: number;
  none: number;
  unknown: number;
  /** All runs (passed or failed) whose own tests were green, and how many passed the verifier. */
  greenRuns: number;
  greenPasses: number;
  /** P(verifier pass | own tests green), Wilson 95%. */
  greenPassRate: Interval;
  /** Every other run with a session (red, stale or none). */
  otherRuns: number;
  otherPasses: number;
  otherPassRate: Interval;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** The agent's own last test verdict for one run. Uses the events when given, else the session's stats. */
export function classifySelfCheck(_run: RunResult, session?: Session, events?: readonly AgentEvent[]): SelfCheck {
  if (!session) return "unknown";
  if (events?.length) {
    const sorted = [...events].sort((a, b) => a.ts - b.ts);
    let last = -1;
    for (let i = 0; i < sorted.length; i++) if (sorted[i]!.kind === "test.result") last = i;
    if (last < 0) return "none";
    const p = sorted[last]!.payload;
    if (num(p.failed) > 0) return "red";
    if (num(p.passed) === 0) return "none";
    return sorted.slice(last + 1).some((e) => e.kind === "file.change") ? "stale" : "green";
  }
  const { testsPassed, testsFailed } = session.stats;
  if (num(testsFailed) > 0) return "red";
  return num(testsPassed) > 0 ? "green" : "none";
}

/** One arm's self-check split. `results` must already exclude cancelled runs. */
export function selfCheckSummary(results: readonly RunResult[], sessions?: ReadonlyMap<string, Session>, events?: ReadonlyMap<string, AgentEvent[]>): SelfCheckSummary {
  const s = { fails: 0, green: 0, red: 0, stale: 0, none: 0, unknown: 0, greenRuns: 0, greenPasses: 0, otherRuns: 0, otherPasses: 0 };
  for (const r of results) {
    const c = classifySelfCheck(r, sessions?.get(r.id), events?.get(r.id));
    if (!r.pass) {
      s.fails++;
      s[c]++;
    }
    if (c === "green") {
      s.greenRuns++;
      if (r.pass) s.greenPasses++;
    } else if (c !== "unknown") {
      s.otherRuns++;
      if (r.pass) s.otherPasses++;
    }
  }
  return { ...s, greenPassRate: wilson(s.greenPasses, s.greenRuns), otherPassRate: wilson(s.otherPasses, s.otherRuns) };
}
