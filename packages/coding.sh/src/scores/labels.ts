// Labels are human scores: pass and fail are boolean, skip is categorical.
// Stores keep only scores and read labels back through these two functions
// (the SQLite store's `labels` view holds the same rules in SQL).
import type { Label, Score } from "../core/types.ts";

/** The score a label is stored as. scoreToLabel(labelToScore(l)) deep-equals l. */
export function labelToScore(l: Label): Score {
  const s: Score = {
    id: l.id,
    target: l.caseId !== undefined ? "case" : "session",
    targetId: l.caseId ?? l.sessionId,
    sessionId: l.sessionId,
    name: l.criterion,
    dataType: l.value === "skip" ? "categorical" : "boolean",
    value: l.value === "skip" ? "skip" : l.value === "pass",
    source: "human",
    by: l.by,
    ts: l.ts,
  };
  if (l.note !== undefined) s.comment = l.note;
  return s;
}

const LABEL_VALUES = new Set(["pass", "fail", "skip"]);

/** The label a score reads as, or undefined when it is not one (not human, no session, or not pass/fail/skip). */
export function scoreToLabel(s: Score): Label | undefined {
  if (s.source !== "human" || s.sessionId === undefined) return undefined;
  if (s.target !== "session" && s.target !== "case") return undefined;
  let value: Label["value"];
  if (s.dataType === "boolean" && typeof s.value === "boolean") value = s.value ? "pass" : "fail";
  else if (s.dataType === "categorical" && typeof s.value === "string" && LABEL_VALUES.has(s.value)) value = s.value as Label["value"];
  else return undefined;
  const l: Label = { id: s.id, sessionId: s.sessionId, criterion: s.name, value, by: s.by, ts: s.ts };
  if (s.target === "case") l.caseId = s.targetId;
  if (s.comment !== undefined) l.note = s.comment;
  return l;
}
