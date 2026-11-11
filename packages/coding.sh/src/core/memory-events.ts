// The harness audit's narrow read. Of all a session's events, the audit
// (core/memory-audit.ts auditMemory) uses only the ones that can name a memory
// or instruction file, and of those only a few payload fields. Reading whole
// events to find them took 10 s and 1 GB on a store of 2,800 sessions (EZ-6),
// so a store can answer with just these (IndexStore.memoryEvents). This file
// is that contract: which events, and which fields of each. memoryEventOf is
// the reference; a store's query must give the same rows.
//
// Which events:
// - a `harness.loaded` notification: what the agent loaded, by path or by skill name;
// - a Skill tool call: it names a skill, not a path;
// - a file.change, or any other tool.start, whose payload text contains `.md`.
//   Every memory or instruction file ends in .md or .mdc (memoryKind), and the
//   audit takes a file's name from the payload as written, so an event without
//   that text names none. One case is lost: a tool that reads "." in a
//   session whose own directory is named like such a file.
//
// No imports beyond types: the stores load this file.
import type { AgentEvent } from "../schema/index.ts";

/** Event kinds the audit reads. */
export const MEMORY_EVENT_KINDS = ["tool.start", "notification", "file.change"];

/** The text every memory or instruction file's path contains. */
export const MEMORY_PATH_TEXT = ".md";
/** `payload.kind` of the notification that says what an agent loaded. */
export const HARNESS_LOADED = "harness.loaded";
/** The tool that loads a skill by name (compared in lower case). */
export const SKILL_TOOL = "skill";

/** Payload fields the audit reads, by event kind. */
export const MEMORY_PAYLOAD_KEYS: Readonly<Record<string, readonly string[]>> = {
  notification: ["kind", "loadedBy", "paths", "dir", "skills", "sources"],
  "file.change": ["path", "movedTo"],
  "tool.start": ["tool", "wrapper"],
};

/** Where a tool input names the file it reads or edits. */
export const INPUT_PATH_KEYS = ["file_path", "filePath", "path", "absolute_path", "target_file", "notebook_path"] as const;
/** Where a Skill call names its skill. */
export const SKILL_INPUT_KEYS = ["skill", "name", "command"] as const;
/** Where a tool input holds a shell command, or a REPL cell's code (core/sessions.ts commandOf reads these). */
export const COMMAND_INPUT_KEYS = ["command", "cmd", "script", "commandLine", "code"] as const;
/** Fields of a tool.start's `payload.input` the audit reads. An input that is a string (a bare command) is kept whole. */
export const MEMORY_INPUT_KEYS: readonly string[] = [...new Set<string>([...SKILL_INPUT_KEYS, ...INPUT_PATH_KEYS, ...COMMAND_INPUT_KEYS])];

/** An event as the audit needs it: its payload holds only the fields above. */
export interface MemoryEvent {
  sessionId: string;
  kind: AgentEvent["kind"];
  ts: number;
  payload: Record<string, unknown>;
}

/** The given fields of `o` that are set (a JSON null counts as unset: no field the audit reads means anything as null). */
export function pickSet(o: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) out[k] = o[k];
  return out;
}

/** The event as the audit needs it, or undefined when the audit cannot use it (see the file header). */
export function memoryEventOf(e: Pick<AgentEvent, "sessionId" | "kind" | "ts" | "payload">): MemoryEvent | undefined {
  const keys = MEMORY_PAYLOAD_KEYS[e.kind];
  if (!keys) return undefined;
  const p = e.payload ?? {};
  const named = () => JSON.stringify(p).includes(MEMORY_PATH_TEXT);
  if (e.kind === "notification" ? p.kind !== HARNESS_LOADED : e.kind === "tool.start" ? !(typeof p.tool === "string" && p.tool.toLowerCase() === SKILL_TOOL) && !named() : !named()) return undefined;
  const payload = pickSet(p, keys);
  if (e.kind === "tool.start") {
    const input = p.input;
    if (typeof input === "string") payload.input = input;
    else if (input && typeof input === "object" && !Array.isArray(input)) payload.input = pickSet(input as Record<string, unknown>, MEMORY_INPUT_KEYS);
  }
  return { sessionId: e.sessionId, kind: e.kind, ts: e.ts, payload };
}
