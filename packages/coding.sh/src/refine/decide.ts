// The keep rule of one `refine test` round (R2-8), in the order the stages run:
//
//   protected   Z-13: the candidate deletes, rewords or relaxes a protected line → reject
//   critics     C2 harmless, C4 duplicate on the added lines → reject
//   dev         the paired trial on decision points, through the acceptance gate:
//               dont-ship → reject; hold → inconclusive; a run stopped at the
//               spend cap → inconclusive (a partial result is never a keep)
//   guard       AB-3 K8 on the tasks earlier kept edits won: 'dont-ship' → reject
//               ("forgets kept edit <id>")
//   keep        everything passed
//
// Every round that ran the dev stage gets Y-3's preservation report. A round
// that ran it and was not kept becomes 'alternative' when alternativeCheck
// says so (it gained a task no kept edit covers, with no hard regression),
// except a guard reject: forgetting what a kept edit won is a regression.
// Pure.
import { gateHeadline, type GateVerdict } from "../stats/gate.ts";
import type { GateResult } from "../stats/tests.ts";
import type { CriticCheck } from "./critics.ts";
import { guardTasks, type GuardCheck } from "./guard.ts";
import { alternativeCheck, preservation, type AlternativeCheck, type ArmOutcomes, type Preservation } from "./keep.ts";
import type { ProtectCheck } from "./protect.ts";

export type RefineVerdict = "keep" | "reject" | "inconclusive" | "alternative";
export type RefineStage = "protected" | "critics" | "dev" | "guard" | "done";

export interface DevStage {
  /** Absent when the run stopped before it finished. */
  gate?: GateResult & { verdict?: GateVerdict };
  outcomes: ArmOutcomes;
  /** The run stopped short: the spend cap, or an interrupt. */
  stopped?: "budget" | "interrupted";
}

export interface GuardStage {
  check?: GuardCheck;
  stopped?: "budget" | "interrupted";
}

export interface RoundInput {
  protect: ProtectCheck;
  critics: CriticCheck;
  dev?: DevStage;
  guard?: GuardStage;
  /** Tasks kept or applied edits already cover (their guard tasks), for the alternative check. */
  covered?: Iterable<string>;
}

export interface RoundDecision {
  verdict: RefineVerdict;
  /** The stage that decided. */
  stage: RefineStage;
  reasons: string[];
  /** Dev tasks the candidate won: they guard later candidates once it is kept. Empty unless kept. */
  guardTasks: string[];
  preservation?: Preservation;
  alternative?: AlternativeCheck;
}

const stoppedReason = (s: "budget" | "interrupted", where: string): string =>
  s === "budget" ? `${where}: stopped at --max-cost; a partial run is never a keep` : `${where}: interrupted; a partial run is never a keep`;

/** The round's verdict from the stages that ran. */
export function decideRound(x: RoundInput): RoundDecision {
  if (!x.protect.ok) return { verdict: "reject", stage: "protected", reasons: x.protect.rejections.map((r) => r.reason), guardTasks: [] };
  if (!x.critics.ok) return { verdict: "reject", stage: "critics", reasons: x.critics.rejections.map((r) => r.reason), guardTasks: [] };
  const dev = x.dev;
  if (!dev) return { verdict: "inconclusive", stage: "dev", reasons: ["dev: not run"], guardTasks: [] };
  const pres = preservation({ dev: dev.outcomes });
  const notKept = (verdict: "reject" | "inconclusive", stage: RefineStage, reasons: string[], block: string[] = []): RoundDecision => {
    const check = alternativeCheck({ k1: true, dev: dev.outcomes, covered: x.covered ?? [], preservation: pres });
    const alt = block.length ? { ...check, alternative: false, why: [...check.why, ...block] } : check;
    if (alt.alternative) return { verdict: "alternative", stage, reasons: [...reasons, `alternative: gains ${alt.uniqueGains.length} task${alt.uniqueGains.length === 1 ? "" : "s"} no kept edit covers`], guardTasks: [], preservation: pres, alternative: alt };
    return { verdict, stage, reasons, guardTasks: [], preservation: pres, alternative: alt };
  };
  if (dev.stopped || !dev.gate) return notKept("inconclusive", "dev", [stoppedReason(dev.stopped ?? "interrupted", "dev")]);
  const headline = `dev: ${gateHeadline(dev.gate, "decision point")}`;
  const verdict = dev.gate.verdict ?? (dev.gate.decision === "accept" ? "ship" : "hold");
  if (verdict === "dont-ship") return notKept("reject", "dev", [headline]);
  if (verdict === "hold") return notKept("inconclusive", "dev", [headline]);
  const g = x.guard;
  if (g?.stopped) return notKept("inconclusive", "guard", [headline, stoppedReason(g.stopped, "guard")]);
  if (g?.check && !g.check.ok) return notKept("reject", "guard", [headline, `guard: ${g.check.reason}`], [`guard: ${g.check.reason}`]);
  const guardLine = !g?.check || (!g.check.gate && !g.check.forgotten.length) ? "guard: no earlier kept wins to hold" : `guard: holds (${g.check.verdict})`;
  return { verdict: "keep", stage: "done", reasons: [headline, guardLine], guardTasks: guardTasks(dev.outcomes), preservation: pres };
}
