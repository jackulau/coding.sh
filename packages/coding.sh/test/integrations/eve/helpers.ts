import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent } from "../../../src/schema/index.ts";

export const FIXTURES = join(import.meta.dirname, "fixtures");
/** Real eve 1.0.0-rc.6 output (`eve dev`, mock model), trimmed and scrubbed. */
export const OTLP_EXPORT = join(FIXTURES, "otlp-export.json");
export const APP_DIR = join(FIXTURES, "app");
export const STREAM_2TURNS = join(FIXTURES, "stream", "paris-london-2turns.ndjson");
export const STREAM_TOOL_ERROR = join(FIXTURES, "stream", "atlantis-tool-error.ndjson");

export const ROOT_A = "wrun_01M6S7G7NBA72BPJVP841AXXCR"; // Paris then London, 2 turns, 2 forecaster calls
export const CHILD_A0 = "wrun_01M6S7G7XBC9C1D4PC7JG6Y2GK"; // forecaster child of turn 0
export const CHILD_A1 = "wrun_01M6S7G89R9F2JDPPCF72HXXB6"; // forecaster child of turn 1
export const ROOT_B = "wrun_01M6S7G8HEQ05JQ19CQ9ZJKG7S"; // Atlantis: get_weather fails

export const readJson = (p: string): unknown => JSON.parse(readFileSync(p, "utf8"));

export function bySession(events: AgentEvent[]): Map<string, AgentEvent[]> {
  const out = new Map<string, AgentEvent[]>();
  for (const e of events) out.set(e.sessionId, [...(out.get(e.sessionId) ?? []), e]);
  for (const list of out.values()) list.sort((a, b) => a.ts - b.ts);
  return out;
}

export const ofKind = (events: AgentEvent[], kind: AgentEvent["kind"]) => events.filter((e) => e.kind === kind);
