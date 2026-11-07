// Findings for the refine proposer (R2-7): session flags across a repo's recent
// sessions, each diagnosed with the taxonomy (FLAG_DIAGNOSIS) and scored with
// the deterministic signal severity (Y-4). The scope comes from how many
// sessions carry the flag; the semantic factor comes from the sessions' own
// counts, since there is no model in the loop:
//
//   defect, risk   C (or Cp) = defaultConsequence: 40 when the session saw a
//                  failing test, else 25; the largest over the affected sessions
//   inefficiency   W = defaultWasteFactor over tool errors plus repeated
//                  read-only calls; the largest over the affected sessions
//
// Tag flags (with a colon) and context-only flags are not findings. Findings
// rank by severity score, then sessions, then id. Pure.
import type { Session } from "../schema/index.ts";
import { defaultConsequence, defaultWasteFactor, natureScore, signalSeverity, type Diagnosis } from "./severity.ts";
import { FLAG_DIAGNOSIS } from "./taxonomy.ts";

export interface FindingExample {
  sessionId: string;
  startedAt: number;
  title?: string;
}

export interface Finding {
  /** `flag:<name>`: stable across runs. */
  id: string;
  kind: "flag";
  flag: string;
  diagnosis: Diagnosis;
  /** Distinct sessions with the flag, and distinct UTC days they started on. */
  support: { sessions: number; days: number };
  /** Sessions looked at. */
  analyzed: number;
  /** Newest first. */
  examples: FindingExample[];
}

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

function factorFor(nature: Diagnosis["nature"], s: Session): number {
  if (nature === "inefficiency") {
    const wasted = (s.stats.toolErrors ?? 0) + (s.stats.waste?.duplicateFetches ?? 0);
    return defaultWasteFactor({ wastedCalls: wasted, sessionToolCalls: s.stats.toolCalls ?? 0 });
  }
  return defaultConsequence({ outcome: (s.stats.testsFailed ?? 0) > 0 ? "fail" : "unknown" });
}

/** One finding per diagnosed flag seen in `sessions`, highest severity first. */
export function flagFindings(sessions: readonly Session[], opts: { limit?: number; maxExamples?: number } = {}): Finding[] {
  const analyzed = sessions.length;
  const byFlag = new Map<string, Session[]>();
  for (const s of sessions) {
    for (const f of new Set(s.flags ?? [])) {
      if (f.includes(":")) continue;
      const d = FLAG_DIAGNOSIS[f];
      if (!d || d === "context-only") continue;
      const list = byFlag.get(f) ?? [];
      list.push(s);
      byFlag.set(f, list);
    }
  }
  const out: Finding[] = [];
  for (const [flag, list] of byFlag) {
    const d = FLAG_DIAGNOSIS[flag] as Exclude<(typeof FLAG_DIAGNOSIS)[string], "context-only">;
    const factor = Math.max(...list.map((s) => factorFor(d.nature, s)));
    const part = natureScore({ nature: d.nature, factor, affected: list.length, analyzed, ...(d.nature === "risk" ? { reach: d.reach ?? 1 } : {}) });
    const newest = [...list].sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? -1 : 1));
    out.push({
      id: `flag:${flag}`,
      kind: "flag",
      flag,
      diagnosis: { typeIds: [...d.typeIds], nature: d.nature, severity: signalSeverity([part]) },
      support: { sessions: list.length, days: new Set(list.map((s) => day(s.startedAt))).size },
      analyzed,
      examples: newest.slice(0, opts.maxExamples ?? 3).map((s) => ({ sessionId: s.id, startedAt: s.startedAt, ...(s.title ? { title: s.title } : {}) })),
    });
  }
  out.sort((a, b) => b.diagnosis.severity.score - a.diagnosis.severity.score || b.support.sessions - a.support.sessions || (a.id < b.id ? -1 : 1));
  return opts.limit === undefined ? out : out.slice(0, opts.limit);
}
