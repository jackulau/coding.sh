// What a session waits on from the user (core/waiting.ts), folded into Session.stats.waiting:
// synthetic sequences for each rule, the recorded Claude Code subagents capture with a
// permission prompt spliced in (no real prompt has been recorded: the scripts/e2e captures run
// with permissions bypassed), and the Gemini CLI hook fixture's ToolPermission notification.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { claudeCode } from "../../src/adapters/claude-code.ts";
import { geminiCliAdapter } from "../../src/adapters/more/gemini-cli.ts";
import { buildSession } from "../../src/core/sessions.ts";
import { foldWaiting, isPermissionNotification, waitingOf, waitingState } from "../../src/core/waiting.ts";
import type { AgentEvent, EventKind } from "../../src/schema/index.ts";
import { collect, FIXTURES, testCtx, tmpEnv, type TmpEnv } from "../adapters/_helpers.ts";
import { normalizeFixture } from "../adapters/more/_helpers.ts";

let n = 0;
const ev = (kind: EventKind, payload: Record<string, unknown> = {}, over: Partial<AgentEvent> = {}): AgentEvent =>
  ({ id: `e${++n}`, sessionId: "s1", agent: "claude-code", ts: 1_000 + n, kind, cwd: "/work/demo", payload, ...over }) as AgentEvent;
const start = (tool: string, id: string, input: Record<string, unknown> = {}, over: Partial<AgentEvent> = {}) => ev("tool.start", { tool, toolUseId: id, input }, over);
const end = (tool: string, id: string, over: Partial<AgentEvent> = {}) => ev("tool.end", { tool, toolUseId: id, ok: true }, over);
const permission = (text = "Claude needs your permission to use Bash", over: Partial<AgentEvent> = {}) => ev("notification", { type: "permission_prompt", text }, over);
const idle = (over: Partial<AgentEvent> = {}) => ev("notification", { type: "idle_prompt", text: "Claude is waiting for your input" }, over);
const interactive = (over: Partial<AgentEvent> = {}) => ev("session.start", { entrypoint: "cli" }, over);

/** The wait after folding these events, as Session.stats.waiting has it. */
function fold(events: AgentEvent[], launch: "interactive" | "headless" | "unknown" = "interactive") {
  const s = waitingState();
  for (const e of events) foldWaiting(s, e, e.source === "transcript");
  return waitingOf(s, launch === "unknown" ? undefined : launch);
}

describe("permission", () => {
  test("a permission notification on an open call blocks until that call ends", () => {
    const events = [start("Bash", "t1", { command: "npm publish" }), permission()];
    assert.deepEqual(fold(events), { kind: "permission", at: events[1]!.ts, toolUseId: "t1", text: "Claude needs your permission to use Bash" });
    assert.equal(fold([...events, end("Bash", "t1")]), undefined);
  });

  test("text that reads as a prompt counts without a type; idle_prompt never sets a wait", () => {
    assert.equal(fold([start("Bash", "t1"), ev("notification", { text: "Claude needs your permission to use Bash" })])?.kind, "permission");
    assert.equal(fold([start("Bash", "t1"), idle()]), undefined);
    assert.equal(isPermissionNotification(idle()), false);
    // After a turn end, idle_prompt leaves the turn wait as it was.
    assert.equal(fold([ev("turn.end"), idle()])?.kind, "turn");
  });

  test("a transcript's notifications never set it", () => {
    assert.equal(fold([start("Bash", "t1"), permission(undefined, { source: "transcript" })]), undefined);
  });

  test("events from a sibling subagent do not clear it; its own thread's do", () => {
    const sub = { subagentId: "a1" };
    const base = [start("Agent", "spawn"), start("Bash", "t1", {}, sub), permission(undefined, sub)];
    assert.equal(fold(base)?.toolUseId, "t1", "the prompt is about the subagent's call, not the spawn");
    const sibling = { subagentId: "a2" };
    const noise = [start("Read", "r1", {}, sibling), end("Read", "r1", sibling), ev("user.message", { text: "task" }, sibling), ev("subagent.end", { subagentId: "a2" }), ev("session.end", { reason: "subagent-stop" }, sibling)];
    assert.equal(fold([...base, ...noise])?.kind, "permission");
    assert.equal(fold([...base, ...noise, ev("llm.call", { usage: {} }), ev("notification", { type: "usage" })])?.kind, "permission", "usage summaries and other notifications leave it");
    assert.equal(fold([...base, end("Bash", "t1", sub)]), undefined);
  });

  test("a main-thread tool.start or prompt clears it (the call was refused)", () => {
    const base = [start("Bash", "t1"), permission()];
    assert.equal(fold([...base, ev("user.message", { text: "no, do it differently" })]), undefined);
    assert.equal(fold([...base, start("Read", "r1")]), undefined);
    // A harness-injected message is not the user answering.
    assert.equal(fold([...base, ev("user.message", { text: "<task-notification>done</task-notification>" })])?.kind, "permission");
  });

  test("session.end clears it, except a transcript's quiet marker", () => {
    const base = [start("Bash", "t1"), permission()];
    assert.equal(fold([...base, ev("session.end", { reason: "exit" })]), undefined);
    assert.equal(fold([...base, ev("session.end", { reason: "idle" }, { source: "transcript" })])?.kind, "permission");
    assert.equal(fold([ev("turn.end"), ev("session.end", { reason: "idle" }, { source: "transcript" })]), undefined, "the quiet marker ends a turn wait");
  });

  test("the text is redacted and clipped", () => {
    const key = `sk-ant-api03-${"x".repeat(40)}`;
    const w = fold([start("Bash", "t1"), permission(`Claude needs your permission to use Bash: curl -H "x-api-key: ${key}" ${"y".repeat(400)}`)]);
    assert.ok(w?.text);
    assert.doesNotMatch(w.text, /sk-ant-api03-x{10}/);
    assert.ok(w.text.length <= 300);
  });
});

describe("question and plan", () => {
  test("an open question call blocks with its question; its end clears it", () => {
    const q = start("AskUserQuestion", "q1", { questions: [{ question: "Which database?", header: "DB" }] });
    assert.deepEqual(fold([q]), { kind: "question", at: q.ts, toolUseId: "q1", text: "Which database?" });
    assert.equal(fold([q, end("AskUserQuestion", "q1")]), undefined);
  });

  test("an open plan call blocks with the plan", () => {
    const p = start("ExitPlanMode", "p1", { plan: "1. Add the column\n2. Backfill" });
    assert.deepEqual(fold([p]), { kind: "plan", at: p.ts, toolUseId: "p1", text: "1. Add the column 2. Backfill" });
  });

  test("a copy of a call's start that arrives after its end opens nothing", () => {
    const q = start("AskUserQuestion", "q1", { question: "Ship it?" });
    assert.equal(fold([q, end("AskUserQuestion", "q1"), { ...q, id: "copy", source: "transcript" }]), undefined);
  });
});

describe("turn", () => {
  test("the main thread's turn end waits for the next prompt, in an interactive session only", () => {
    const t = ev("turn.end");
    assert.deepEqual(fold([t], "interactive"), { kind: "turn", at: t.ts });
    assert.equal(fold([t], "headless"), undefined);
    assert.equal(fold([t], "unknown"), undefined);
    assert.equal(fold([ev("turn.end", {}, { subagentId: "a1" })]), undefined, "a subagent's turn end is not the user's turn");
    assert.equal(fold([t, ev("user.message", { text: "next" })]), undefined);
  });

  test("a turn end does not replace an open prompt", () => {
    assert.equal(fold([start("Bash", "t1"), permission(), ev("turn.end")])?.kind, "permission");
  });

  test("Session.stats.waiting is set through the session fold and absent when nothing waits", () => {
    const s = buildSession([interactive(), ev("user.message", { text: "fix the test" }), ev("turn.end")]);
    assert.equal(s.stats.waiting?.kind, "turn");
    const done = buildSession([interactive(), ev("user.message", { text: "fix the test" }), ev("turn.end"), ev("session.end", { reason: "exit" })]);
    assert.equal("waiting" in done.stats, false);
    const headless = buildSession([ev("session.start", { entrypoint: "sdk-cli" }), ev("user.message", { text: "fix" }), ev("turn.end")]);
    assert.equal("waiting" in headless.stats, false);
  });
});

describe("the Claude Code subagents capture with a permission prompt spliced in", () => {
  const MAIN = "36d2966a-1c53-47f1-891d-aae1827d0e95";
  let env: TmpEnv;
  let events: AgentEvent[];
  before(async () => {
    env = tmpEnv();
    process.env.CLAUDE_CONFIG_DIR = join(FIXTURES, "claude-code", "subagents", "config");
    events = (await collect(claudeCode.backfill!(testCtx().ctx))).filter((e) => e.sessionId === MAIN).sort((a, b) => a.ts - b.ts);
  });
  after(() => env.restore());

  test("stays blocked across the subagent's end and clears on the open call's tool.end", () => {
    const subEnd = events.find((e) => e.kind === "subagent.end")!;
    assert.ok(subEnd, "the capture has a subagent.end in the parent session");
    const turnEnd = events.findLast((e) => e.kind === "turn.end")!;
    // A Bash call on the main thread that starts while the subagent runs and asks for approval (live hook events).
    const live = { sessionId: MAIN, agent: "claude-code" } as const;
    const call = ev("tool.start", { tool: "Bash", toolUseId: "toolu_splice", input: { command: "git push" } }, { ...live, ts: subEnd.ts - 50 });
    const prompt = ev("notification", { type: "permission_prompt", text: "Claude needs your permission to use Bash" }, { ...live, ts: subEnd.ts - 40 });
    const done = ev("tool.end", { tool: "Bash", toolUseId: "toolu_splice", ok: true }, { ...live, ts: turnEnd.ts - 5 });
    const upTo = (t: number, extra: AgentEvent[]) => buildSession([...events.filter((e) => e.ts <= t), ...extra]);
    const blocked = upTo(subEnd.ts + 1, [call, prompt]);
    assert.deepEqual(blocked.stats.waiting, { kind: "permission", at: prompt.ts, toolUseId: "toolu_splice", text: "Claude needs your permission to use Bash" });
    // Everything up to the turn end, minus the call's end: still blocked.
    assert.equal(upTo(turnEnd.ts - 1, [call, prompt]).stats.waiting?.kind, "permission");
    // With the call's end, nothing waits (the session was not launched interactively, so no turn wait either).
    const all = buildSession([...events, call, prompt, done]);
    assert.equal(all.stats.waiting, undefined);
  });

  test("the capture as recorded waits on nothing", () => {
    assert.equal(buildSession(events).stats.waiting, undefined);
  });
});

describe("Gemini CLI", () => {
  test("a ToolPermission notification blocks until the session ends", async () => {
    const events = await normalizeFixture(geminiCliAdapter, "gemini-cli/hooks.spool.jsonl");
    const note = events.find((e) => e.kind === "notification")!;
    assert.equal(isPermissionNotification(note), true);
    const before = buildSession(events.filter((e) => e.kind !== "session.end"));
    assert.equal(before.stats.waiting?.kind, "permission");
    assert.match(before.stats.waiting!.text!, /needs your permission/);
    assert.equal(buildSession(events).stats.waiting, undefined);
  });
});
