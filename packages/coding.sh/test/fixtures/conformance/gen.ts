// Writes the conformance fixtures: what the adapters emitted before each
// real-data finding was fixed (docs/research/round-1-self.md), rebuilt with
// the adapters' own id scheme (ctx.id = hashParts(agent, session, kind, key)).
// Paths are scrubbed to /work/demo. Run: node --no-warnings test/fixtures/conformance/gen.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashParts } from "../../../src/core/ids.ts";
import type { AgentEvent } from "../../../src/schema/index.ts";

const dir = import.meta.dirname;
const T0 = Date.UTC(2026, 10, 1, 10, 0, 0);
const cwd = "/work/demo";

function ev(agent: string, sessionId: string, kind: AgentEvent["kind"], key: (string | number)[], ts: number, payload: Record<string, unknown>, extra: Partial<AgentEvent> = {}): AgentEvent {
  return { id: hashParts(agent, sessionId, kind, ...key), v: 0, agent, sessionId, kind, ts, cwd, payload, ...extra };
}
const write = (name: string, events: AgentEvent[]) => writeFileSync(join(dir, name), JSON.stringify(events, null, 2) + "\n");

// F1. Claude Code with streaming tool execution writes assistant(tool_use A), user(tool_result A),
// assistant(tool_use B) under ONE message.id. The converter flushed the call on the tool_result
// line, so the second block opened a second llm.call with the same key: same event id, other
// content (a bogus 512 ms TTFT and 789 tok/s). The store kept the first and dropped the second.
{
  const a = "claude-code";
  const s = "a1f1f1f1-1111-4111-8111-111111111111";
  const turn = hashParts(a, s, "turn", "u1");
  const call = (ts: number, payload: Record<string, unknown>, usage: AgentEvent["usage"], durationMs: number) =>
    ev(a, s, "llm.call", ["msg_f1"], ts, { provider: "anthropic", responseModel: "claude-opus-4-5", ok: true, messageId: "msg_f1", ...payload }, { turnId: turn, model: "claude-opus-4-5", durationMs, usage });
  write("f1-claude-llm-call-fragments.json", [
    ev(a, s, "session.start", ["start"], T0, { source: "transcript" }),
    ev(a, s, "user.message", ["u1"], T0 + 10, { text: "Fix the failing test" }, { turnId: turn }),
    call(T0 + 20, { ttftMs: 1100, stopReason: "tool_use", tokensPerSec: 41.2 }, { inputTokens: 1200, outputTokens: 60, cacheReadTokens: 8000, cacheWriteTokens: 0 }, 1400),
    ev(a, s, "tool.start", ["toolu_a"], T0 + 1400, { tool: "Read", toolUseId: "toolu_a", input: { file_path: "/work/demo/sum.js" } }, { turnId: turn }),
    ev(a, s, "tool.end", ["toolu_a"], T0 + 1450, { tool: "Read", toolUseId: "toolu_a", ok: true, output: "module.exports = …" }, { turnId: turn, durationMs: 50 }),
    // The fragment after the tool_result: same message.id, so the same event id.
    call(T0 + 1450, { ttftMs: 512, stopReason: "tool_use", tokensPerSec: 789 }, { inputTokens: 1200, outputTokens: 95, cacheReadTokens: 8000, cacheWriteTokens: 0 }, 120),
    ev(a, s, "tool.start", ["toolu_b"], T0 + 1570, { tool: "Bash", toolUseId: "toolu_b", input: { command: "npm test" } }, { turnId: turn }),
    ev(a, s, "tool.end", ["toolu_b"], T0 + 3570, { tool: "Bash", toolUseId: "toolu_b", ok: true, output: "3 passing" }, { turnId: turn, durationMs: 2000 }),
    ev(a, s, "turn.end", [turn], T0 + 3600, {}, { turnId: turn }),
  ]);
}

// F2. A nested subagent (spawnDepth 2): its Agent tool_use is in the depth-1 subagent's
// transcript, but convertSubagentFile linked every subagent to the main session from the path.
// Its subagent.start/end landed in the main session with parentId = the main session's id for
// a tool.start that only exists in the child, and Session.parent named the main session.
{
  const a = "claude-code";
  const m = "b2f2f2f2-2222-4222-8222-222222222222";
  const s1 = `${m}:sub:agent1`;
  const s2 = `${m}:sub:agent2`;
  const id = (sid: string, kind: string, key: string) => hashParts(a, sid, kind, key);
  write("f2-claude-nested-subagent-parent.json", [
    ev(a, m, "session.start", ["start"], T0, { source: "transcript" }),
    ev(a, m, "user.message", ["u1"], T0 + 10, { text: "Research the parser, then fix it" }),
    ev(a, m, "tool.start", ["toolu_m1"], T0 + 100, { tool: "Agent", toolUseId: "toolu_m1", input: { subagent_type: "Explore" } }),
    ev(a, m, "subagent.start", ["agent1"], T0 + 110, { subagentId: "agent1", type: "Explore", childSessionId: s1, toolUseId: "toolu_m1" }, { parentId: id(m, "tool.start", "toolu_m1") }),
    ev(a, s1, "session.start", ["start"], T0 + 110, { source: "subagent", parentSessionId: m, parentEventId: id(m, "subagent.start", "agent1"), subagentId: "agent1", subagentType: "Explore" }, { subagentId: "agent1" }),
    ev(a, s1, "user.message", ["u1"], T0 + 120, { text: "Find the parser and spawn a reader for it" }, { subagentId: "agent1" }),
    ev(a, s1, "tool.start", ["toolu_s1"], T0 + 200, { tool: "Agent", toolUseId: "toolu_s1", input: { subagent_type: "general-purpose" } }, { subagentId: "agent1" }),
    // Depth 2, linked to the main session: toolu_s1 is not a tool.start of `m`.
    ev(a, m, "subagent.start", ["agent2"], T0 + 210, { subagentId: "agent2", type: "general-purpose", childSessionId: s2, toolUseId: "toolu_s1" }, { parentId: id(m, "tool.start", "toolu_s1") }),
    ev(a, s2, "session.start", ["start"], T0 + 210, { source: "subagent", parentSessionId: m, parentEventId: id(m, "subagent.start", "agent2"), subagentId: "agent2", subagentType: "general-purpose" }, { subagentId: "agent2" }),
    ev(a, s2, "user.message", ["u1"], T0 + 220, { text: "Read src/parse.ts" }, { subagentId: "agent2" }),
    ev(a, s2, "session.end", ["end"], T0 + 900, { reason: "subagent-stop" }, { subagentId: "agent2" }),
    ev(a, m, "subagent.end", ["agent2"], T0 + 900, { subagentId: "agent2", ok: true, childSessionId: s2 }, { parentId: id(m, "tool.start", "toolu_s1"), durationMs: 690 }),
    ev(a, s1, "tool.end", ["toolu_s1"], T0 + 910, { tool: "Agent", toolUseId: "toolu_s1", ok: true }, { subagentId: "agent1", durationMs: 710 }),
    ev(a, s1, "session.end", ["end"], T0 + 1000, { reason: "subagent-stop" }, { subagentId: "agent1" }),
    ev(a, m, "subagent.end", ["agent1"], T0 + 1000, { subagentId: "agent1", ok: true, childSessionId: s1 }, { parentId: id(m, "tool.start", "toolu_m1"), durationMs: 890 }),
    ev(a, m, "tool.end", ["toolu_m1"], T0 + 1010, { tool: "Agent", toolUseId: "toolu_m1", ok: true }, { durationMs: 910 }),
    ev(a, m, "session.end", ["end"], T0 + 2000, { reason: "idle" }),
  ]);
}

// F6a. A Codex 0.160 multi-agent child gets its task as a response_item agent_message from
// /root (encrypted). The adapter read it as model output: the child has no user.message, so
// no title, and draftTaskFromSession throws "has no user prompt".
{
  const a = "codex";
  const p = "0193f6f6-0000-7000-8000-000000000001";
  const c = "0193f6f6-0000-7000-8000-000000000002";
  write("f6-codex-child-without-task.json", [
    ev(a, p, "session.start", ["start"], T0, { source: "rollout" }),
    ev(a, p, "user.message", ["prompt", "t1"], T0 + 5, { text: "Split the work across two agents" }, { turnId: "t1" }),
    ev(a, p, "subagent.start", [c], T0 + 100, { subagentId: c, childSessionId: c }),
    ev(a, c, "session.start", ["start"], T0 + 100, { source: "rollout", parentSessionId: p, parentEventId: hashParts(a, p, "subagent.start", c), subagentId: c }),
    ev(a, c, "llm.call", ["tc", 1], T0 + 110, { provider: "openai", responseModel: "gpt-5", ok: true }, { turnId: "c1", durationMs: 800, usage: { inputTokens: 900, outputTokens: 40 } }),
    ev(a, c, "tool.start", ["call_c1"], T0 + 910, { tool: "shell", toolUseId: "call_c1", input: { command: ["rg", "parse"] } }, { turnId: "c1" }),
    ev(a, c, "tool.end", ["call_c1"], T0 + 1000, { tool: "shell", toolUseId: "call_c1", ok: true, output: "src/parse.ts:1", exitCode: 0 }, { turnId: "c1", durationMs: 90 }),
    ev(a, c, "assistant.message", ["a1"], T0 + 1500, { text: "Found it." }, { turnId: "c1" }),
    ev(a, p, "subagent.end", [c], T0 + 1600, { subagentId: c, ok: true, childSessionId: c }),
    ev(a, p, "session.end", ["idle", T0 + 2000], T0 + 2000, { reason: "idle" }),
  ]);
}

// F6b. Antigravity: 56 tool results said "The command exited with code N≠0", yet 0 of 2513
// tool.end events were ok:false. agyTranscriptEvents only looked at r.error, which is never set.
{
  const a = "antigravity";
  const s = "6b6b6b6b-6666-4666-8666-666666666666";
  write("f6-antigravity-exit-code-ok.json", [
    ev(a, s, "session.start", ["start"], T0, { source: "transcript" }),
    ev(a, s, "user.message", ["step", 0], T0 + 10, { text: "Run the tests" }),
    ev(a, s, "llm.call", ["step", 1], T0 + 20, { provider: "google", ok: true }, { durationMs: 900 }),
    ev(a, s, "tool.start", ["call_1"], T0 + 930, { tool: "run_command", toolUseId: "call_1", input: { CommandLine: "npm test" } }),
    ev(a, s, "tool.end", ["call_1"], T0 + 4000, { tool: "run_command", toolUseId: "call_1", ok: true, output: "The command exited with code 1.\nOutput:\n1 failing" }, { durationMs: 3070 }),
    ev(a, s, "assistant.message", ["step", 3], T0 + 4500, { text: "One test fails." }),
    ev(a, s, "turn.end", ["step", 3], T0 + 4600, {}),
  ]);
}

// F3. OpenCode moved to a drizzle SQLite schema the adapter did not know; backfillSqlite found
// none of its tables, returned, and its catch {} hid the rest: 395 sessions imported as 0 events.
// Rebuilt with tables the adapter still does not know (a future rename), so the same silent path runs.
writeFileSync(
  join(dir, "f3-opencode-unknown-schema.db.json"),
  JSON.stringify(
    {
      schema: [
        "CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at INTEGER)",
        "CREATE TABLE conversation (id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, title TEXT, version TEXT, time_created INTEGER, time_updated INTEGER)",
        "CREATE TABLE conversation_message (id TEXT PRIMARY KEY, conversation_id TEXT, time_created INTEGER, data TEXT)",
        "CREATE TABLE conversation_part (id TEXT PRIMARY KEY, message_id TEXT, conversation_id TEXT, time_created INTEGER, data TEXT)",
      ],
      rows: {
        __drizzle_migrations: [{ id: 1, hash: "0001_conversation", created_at: T0 - 86_400_000 }],
        conversation: [{ id: "ses_f3", project_id: "prj_1", directory: cwd, title: "Add a parser", version: "9.0.0", time_created: T0, time_updated: T0 + 5000 }],
        conversation_message: [
          { id: "msg_u", conversation_id: "ses_f3", time_created: T0 + 10, data: JSON.stringify({ role: "user" }) },
          { id: "msg_a", conversation_id: "ses_f3", time_created: T0 + 1000, data: JSON.stringify({ role: "assistant", modelID: "gpt-5", tokens: { input: 900, output: 40 } }) },
        ],
        conversation_part: [
          { id: "prt_1", message_id: "msg_u", conversation_id: "ses_f3", time_created: T0 + 10, data: JSON.stringify({ type: "text", text: "Add a parser" }) },
          { id: "prt_2", message_id: "msg_a", conversation_id: "ses_f3", time_created: T0 + 1000, data: JSON.stringify({ type: "text", text: "Done." }) },
        ],
      },
    },
    null,
    2,
  ) + "\n",
);
