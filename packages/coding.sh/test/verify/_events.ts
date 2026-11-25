// What the adapter checks in this folder hold every list of events to, and how they gather what broke.
import { validEvent } from "../../src/core/ingest.ts";
import type { AgentEvent } from "../../src/schema/index.ts";

/** Problems by kind, each with the first input that showed it (the inputs come smallest first). */
export class Problems {
  readonly seen = new Map<string, { count: number; first: string }>();
  add(kind: string, where: string): void {
    const p = this.seen.get(kind);
    if (p) p.count++;
    else this.seen.set(kind, { count: 1, first: where });
  }
  list(): string[] {
    return [...this.seen].map(([kind, p]) => `${kind} (${p.count} inputs; first: ${p.first})`);
  }
}

/**
 * What is wrong with a list of events: events ingest would drop (core/ingest.ts validEvent), ids that are
 * not 64 hex digits, and (unless `repeats`, for an input that holds a record twice) an id an earlier event in
 * the list has. `from` names where the list came from ("the same line", "the same backfill").
 */
export function eventProblems(events: unknown, from: string, repeats = false): string[] {
  if (!Array.isArray(events)) return ["resolved to no array"];
  const out: string[] = [];
  const ids = new Set<string>();
  for (const e of events as AgentEvent[]) {
    const problem = validEvent(e);
    if (problem) out.push(problem.replace(/\b[0-9a-f]{64}\b/g, "<id>"));
    else if (!/^[0-9a-f]{64}$/.test(e.id)) out.push(`a ${e.kind} event's id ${JSON.stringify(e.id)} is not 64 hex digits`);
    else if (!repeats && ids.has(e.id)) out.push(`a ${e.kind} event has the id of an earlier event from ${from}`);
    if (typeof e?.id === "string") ids.add(e.id);
  }
  return out;
}
