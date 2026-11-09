// Trials for the suite report (eval/report.ts), from the two kinds of stored
// runs: repo-task runs (runner/experiment.ts RunResult) and dataset case runs
// (experiments/run.ts CaseRun).
import type { EvalTask, RunResult } from "../core/types.ts";
import type { Case, ExperimentResult } from "../datasets/types.ts";
import { failureReason } from "../experiments/render.ts";
import type { TaskTrials, Trial } from "./report.ts";
import type { TriggerObservation, TriggerSpec } from "./trigger.ts";

/** One trial per task and attempt; cancelled and superseded runs are left out, an infrastructure failure is an unknown outcome. */
export function trialsFromRuns(tasks: readonly EvalTask[], runs: readonly RunResult[]): TaskTrials[] {
  return tasks.map((t) => ({
    id: t.id,
    name: t.name,
    trials: runs
      .filter((r) => r.taskId === t.id && !r.cancelled && !r.superseded)
      .sort((a, b) => a.attempt - b.attempt)
      .map((r): Trial => {
        const reason = r.error ?? (r.pass ? undefined : r.verifierExit === null ? "verifier did not finish" : `verifier exit ${r.verifierExit}`);
        return { pass: r.pass, ...(r.infra ? { unknown: true } : {}), ...(r.sessionId ? { sessionId: r.sessionId } : {}), ...(reason ? { reason } : {}) };
      }),
  }));
}

/**
 * Tasks drafted from sessions that went wrong (tag `captured-failure`, see eval/init.ts):
 * which of them the agent now solves in most of its trials. One line, or none when the
 * suite has no such task. The production→CI loop: a failure captured once is checked on
 * every pull request, and the report says when a change fixes it.
 */
export function capturedFailuresLine(tasks: readonly Pick<EvalTask, "id" | "name" | "tags" | "sourceSessionId">[], trials: readonly TaskTrials[], tag = "captured-failure", max = 5): string | undefined {
  const captured = tasks.filter((t) => t.tags.includes(tag));
  if (!captured.length) return undefined;
  const byId = new Map(trials.map((t) => [t.id, t]));
  const now = captured.filter((t) => {
    const known = (byId.get(t.id)?.trials ?? []).filter((x) => !x.unknown);
    return known.length > 0 && known.filter((x) => x.pass).length * 2 > known.length;
  });
  const names = now.slice(0, max).map((t) => `${t.name}${t.sourceSessionId ? ` (session ${t.sourceSessionId})` : ""}`);
  const more = now.length > max ? `, and ${now.length - max} more` : "";
  return `captured failures: ${now.length} of ${captured.length} now pass${names.length ? `: ${names.join(", ")}${more}` : ""}`;
}

const HASH_ID = /^c_[0-9a-f]{16}$/;

/** A case's name in the report: its own id when it was given one, else the start of its input. */
export function caseLabel(c: Pick<Case, "id" | "input">): string {
  if (!HASH_ID.test(c.id)) return c.id;
  const text = typeof c.input === "string" ? c.input : JSON.stringify(c.input);
  const one = (text ?? "").replace(/\s+/g, " ").trim();
  return one.length > 40 ? `${one.slice(0, 39)}…` : one || c.id;
}

/** One trial per case and trial number; a run a grader could not grade is an unknown outcome. */
export function trialsFromExperiment(cases: readonly Case[], r: ExperimentResult): TaskTrials[] {
  return cases.map((c) => ({
    id: c.id,
    name: caseLabel(c),
    trials: r.runs
      .filter((x) => x.caseId === c.id)
      .sort((a, b) => a.trial - b.trial)
      .map((x): Trial => {
        const reason = x.pass ? "" : failureReason(x);
        return { pass: x.pass, ...(x.ungraded ? { unknown: true } : {}), ...(reason ? { reason } : {}) };
      }),
  }));
}

/**
 * One trial per prompt and attempt of the first arm: a should prompt passes
 * when the skill loaded, a should_not prompt when it didn't. A probe that
 * errored is an unknown outcome.
 */
export function trialsFromTriggers(spec: Pick<TriggerSpec, "should" | "shouldNot">, observations: readonly TriggerObservation[]): TaskTrials[] {
  const sides = [
    ...spec.should.map((p, index) => ({ side: "should" as const, index, prompt: p.prompt })),
    ...spec.shouldNot.map((p, index) => ({ side: "should_not" as const, index, prompt: p.prompt })),
  ];
  return sides.map((p) => {
    const one = p.prompt.replace(/\s+/g, " ").trim();
    return {
      id: `${p.side}:${p.index}`,
      name: `${p.side === "should" ? "should" : "should not"}: ${one.length > 40 ? `${one.slice(0, 39)}…` : one}`,
      trials: observations
        .filter((o) => o.arm === 0 && o.side === p.side && o.index === p.index)
        .sort((a, b) => a.attempt - b.attempt)
        .map((o): Trial => {
          if (o.status === "error") return { pass: false, unknown: true, ...(o.sessionId ? { sessionId: o.sessionId } : {}), reason: o.error ?? "probe failed" };
          const pass = p.side === "should" ? o.triggered : !o.triggered;
          const reason = pass ? undefined : p.side === "should" ? `didn't load the skill${o.skills.length ? ` (loaded ${o.skills.join(", ")})` : ""}` : "loaded the skill";
          return { pass, ...(o.sessionId ? { sessionId: o.sessionId } : {}), ...(reason ? { reason } : {}) };
        }),
    };
  });
}
