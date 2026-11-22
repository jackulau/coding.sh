// Sessions whose tool calls touch pull requests, written by hand in the style of a Claude Code
// transcript (a Bash call's command and its printed result), for the prs stat and WorkItem.prs tests.
import { buildSession } from "../../src/core/sessions.ts";
import type { AgentEvent, EventKind, Session } from "../../src/schema/index.ts";

export const T0 = Date.parse("2026-11-20T10:00:00Z");
export const PR12 = "https://github.com/acme/widgets/pull/12";
/** What `gh pr create` prints: where it went, then the PR's URL. */
export const CREATED = `\nCreating pull request for fix-parser into main in acme/widgets\n\n${PR12}\n`;

let n = 0;
let base = T0;
export const ev = (sessionId: string, kind: EventKind, payload: Record<string, unknown>, o: Partial<AgentEvent> = {}): AgentEvent => ({
  id: `e${++n}`, v: 0, sessionId, ts: base + n * 1000, agent: "claude-code", kind, payload, cwd: "/work/demo", ...o,
});
/** A Bash call and its result. */
export const bash = (sessionId: string, command: string, output: string, ok = true): AgentEvent[] => {
  const id = `tu${n + 1}`;
  return [ev(sessionId, "tool.start", { tool: "Bash", toolUseId: id, input: { command } }), ev(sessionId, "tool.end", { tool: "Bash", toolUseId: id, ok, output })];
};
/** Another tool's call and its result (a host's MCP tool). */
export const tool = (sessionId: string, name: string, input: Record<string, unknown>, output = "", ok = true): AgentEvent[] => {
  const id = `tu${n + 1}`;
  return [ev(sessionId, "tool.start", { tool: name, toolUseId: id, input }), ev(sessionId, "tool.end", { tool: name, toolUseId: id, ok, output })];
};
/** A session's events: its start and prompt before the calls, its end after them. */
export function sessionEvents(id: string, calls: AgentEvent[][], start: Record<string, unknown> = {}): AgentEvent[] {
  const flat = calls.flat();
  const first = flat[0]?.ts ?? base + (n + 1) * 1000;
  return [ev(id, "session.start", start, { ts: first - 2 }), ev(id, "user.message", { text: "ship the fix" }, { ts: first - 1 }), ...flat, ev(id, "session.end", {})];
}
export const session = (id: string, ...calls: AgentEvent[][]): Session => buildSession(sessionEvents(id, calls));

/** The session that opened the PR, and a later one that merged it (a subagent of the first when `child`), from `t0` on. */
export function prSessions(t0 = T0, child = false): { opener: Session; merger: Session; events: AgentEvent[] } {
  const saved = base;
  base = t0;
  const opener = sessionEvents("opener", [
    bash("opener", "git push -u origin fix-parser", "To https://github.com/acme/widgets.git\n * [new branch]      fix-parser -> fix-parser\n"),
    bash("opener", 'gh pr create --title "Fix the parser" --body "Closes #3"', CREATED),
  ]);
  const merger = sessionEvents("merger", [bash("merger", "gh pr merge 12 --squash --delete-branch", "✓ Squashed and merged pull request acme/widgets#12 (Fix the parser)\n✓ Deleted branch fix-parser\n")], child ? { parentSessionId: "opener", subagentType: "general-purpose" } : {});
  if (child) for (const e of merger) e.subagentId = "a1";
  base = saved;
  return { opener: buildSession(opener), merger: buildSession(merger), events: [...opener, ...merger] };
}
