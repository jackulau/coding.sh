// Synthetic captured sessions with known decision points, for the decision
// miner and `exp ab` tests. Made up from scratch: no real session content.
import { buildSession } from "../src/core/sessions.ts";
import type { AgentEvent, IndexStore } from "../src/core/types.ts";

export interface SessionOpts {
  cwd: string;
  startedAt: number;
  model?: string;
  agent?: string;
  runId?: string;
}

/** Builds one session's events with ids `<session>-<n>`, a second apart. */
export function sessionEvents(id: string, o: SessionOpts, steps: [AgentEvent["kind"], Record<string, unknown>][]): AgentEvent[] {
  return steps.map(([kind, payload], i) => ({
    id: `${id}-${i}`,
    v: 0,
    sessionId: id,
    ts: o.startedAt + i * 1000,
    agent: (o.agent ?? "claude-code") as AgentEvent["agent"],
    model: o.model ?? "claude-sonnet-5-5",
    cwd: o.cwd,
    kind,
    payload,
    ...(o.runId ? { runId: o.runId } : {}),
  }));
}

/** Edits a file, then says it is done without running anything: one unverified-claim decision point. */
export function claimSession(id: string, o: SessionOpts, file = "src/range.js"): AgentEvent[] {
  return sessionEvents(id, o, [
    ["session.start", {}],
    ["user.message", { text: `range(1, 3) should include 3. Fix ${file}.` }],
    ["assistant.message", { text: "Let me read the file." }],
    ["tool.start", { tool: "Read", toolUseId: `${id}-r`, input: { file_path: `${o.cwd}/${file}` } }],
    ["tool.end", { tool: "Read", toolUseId: `${id}-r`, ok: true, output: "export const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);\n" }],
    ["tool.start", { tool: "Edit", toolUseId: `${id}-e`, input: { file_path: `${o.cwd}/${file}`, old_string: "b - a", new_string: "b - a + 1" } }],
    ["tool.end", { tool: "Edit", toolUseId: `${id}-e`, ok: true, output: "The file has been updated." }],
    ["assistant.message", { text: "Fixed: range() now includes the end value." }],
    ["turn.end", {}],
  ]);
}

/** Runs the tests, sees them fail, and stops anyway: one done-while-failing decision point. */
export function failingSession(id: string, o: SessionOpts): AgentEvent[] {
  return sessionEvents(id, o, [
    ["session.start", {}],
    ["user.message", { text: "Make the parser accept trailing commas." }],
    ["tool.start", { tool: "Bash", toolUseId: `${id}-t`, input: { command: "npm test" } }],
    ["tool.end", { tool: "Bash", toolUseId: `${id}-t`, ok: false, output: "1 failing\n  parse([1,]) expected [1] got SyntaxError" }],
    ["assistant.message", { text: "Trailing commas are supported now." }],
    ["turn.end", {}],
  ]);
}

/** Retries a failed command unchanged: one unchanged-retry decision point. */
export function retrySession(id: string, o: SessionOpts): AgentEvent[] {
  return sessionEvents(id, o, [
    ["session.start", {}],
    ["user.message", { text: "Build the project." }],
    ["tool.start", { tool: "Bash", toolUseId: `${id}-1`, input: { command: "npm run biuld" } }],
    ["tool.end", { tool: "Bash", toolUseId: `${id}-1`, ok: false, output: 'npm error Missing script: "biuld"' }],
    ["tool.start", { tool: "Bash", toolUseId: `${id}-2`, input: { command: "npm run biuld" } }],
    ["tool.end", { tool: "Bash", toolUseId: `${id}-2`, ok: false, output: 'npm error Missing script: "biuld"' }],
    ["assistant.message", { text: "The build script seems broken." }],
    ["turn.end", {}],
  ]);
}

/** Store a session's events and the session row built from them. */
export async function putSession(index: IndexStore, events: AgentEvent[], extra: { runId?: string } = {}): Promise<void> {
  await index.putEvents(events);
  const s = buildSession(events);
  await index.upsertSession(extra.runId ? { ...s, runId: extra.runId } : s);
}
