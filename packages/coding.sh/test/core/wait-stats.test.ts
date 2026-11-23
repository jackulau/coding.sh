// How often and how long a session waited on the person (core/wait-stats.ts), folded into
// Session.stats.waits: synthetic sequences for each rule, and recorded fixtures (the Claude Code
// subagents capture with a live permission prompt spliced into a subagent, the Codex rollout, and
// the Gemini CLI hook fixture's ToolPermission notification). No recorded capture has a real
// permission prompt: the scripts/e2e captures run with permissions bypassed.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { deserialize, serialize } from "node:v8";
import { claudeCode } from "../../src/adapters/claude-code.ts";
import { codex } from "../../src/adapters/codex.ts";
import { geminiCliAdapter } from "../../src/adapters/more/gemini-cli.ts";
import { buildSession, byTime, foldSession, isBackfillEvent, sessionOf, sessionState } from "../../src/core/sessions.ts";
import { foldWaitStats, waitStatsOf, waitStatsState } from "../../src/core/wait-stats.ts";
import { foldWaiting, HOST_QUESTION, HOST_RESOLVED, waitingState } from "../../src/core/waiting.ts";
import type { AgentEvent, EventKind, WaitStats } from "../../src/schema/index.ts";
import { collect, FIXTURES, testCtx, tmpEnv, type TmpEnv } from "../adapters/_helpers.ts";
import { normalizeFixture } from "../adapters/more/_helpers.ts";

const T0 = 1_790_000_000_000;
const MIN = 60_000;
const DAY = 86_400;
let n = 0;
/** An event `sec` seconds after T0. */
const ev = (sec: number, kind: EventKind, payload: Record<string, unknown> = {}, over: Partial<AgentEvent> = {}): AgentEvent =>
  ({ id: `w${++n}`, sessionId: "s1", agent: "claude-code", ts: T0 + sec * 1000, kind, cwd: "/work/demo", payload, ...over }) as AgentEvent;
const prompt = (sec: number, text = "fix the failing test", over: Partial<AgentEvent> = {}) => ev(sec, "user.message", { text }, over);
const turnEnd = (sec: number, payload: Record<string, unknown> = {}, over: Partial<AgentEvent> = {}) => ev(sec, "turn.end", payload, over);
const call = (sec: number, tool: string, id: string, over: Partial<AgentEvent> = {}) => ev(sec, "tool.start", { tool, toolUseId: id, input: {} }, over);
const done = (sec: number, tool: string, id: string, ok = true, over: Partial<AgentEvent> = {}) => ev(sec, "tool.end", { tool, toolUseId: id, ok }, over);
const permission = (sec: number, over: Partial<AgentEvent> = {}) => ev(sec, "notification", { type: "permission_prompt", text: "Claude needs your permission to use Bash" }, over);
const idlePrompt = (sec: number) => ev(sec, "notification", { type: "idle_prompt", text: "Claude is waiting for your input" });
const begin = (sec: number, entrypoint = "cli", payload: Record<string, unknown> = {}) => ev(sec, "session.start", { entrypoint, ...payload });
/** Events as a backfill stores them (core/ingest.ts backfillEvent): source "transcript". */
const transcript = (events: AgentEvent[]): AgentEvent[] => events.map((e) => ({ ...e, source: e.source ?? "transcript" }));

/** Session.stats.waits after folding these events in time order, as the session fold does. */
function stats(events: AgentEvent[], launch: "interactive" | "headless" | null = "interactive", subagent = false): WaitStats | undefined {
  const s = waitStatsState();
  const waiting = waitingState();
  for (const e of byTime(events)) {
    foldWaitStats(s, waiting, e, isBackfillEvent(e));
    foldWaiting(waiting, e, isBackfillEvent(e));
  }
  return waitStatsOf(s, { launch: launch ?? undefined, subagent });
}

describe("turn waits", () => {
  test("a turn wait runs from the turn's end to the person's next prompt, in a session launched interactively", () => {
    const events = [prompt(0), turnEnd(10), prompt(70)];
    assert.deepEqual(stats(events), { count: 1, ms: MIN, byKind: { turn: { count: 1, ms: MIN } } });
    assert.equal(stats(events, "headless"), undefined, "a headless run waits on nobody between turns");
    assert.equal(stats(events, null), undefined, "nor does a session whose launch is unknown");
    assert.equal(stats(events, "interactive", true), undefined, "nor a subagent");
  });

  test("buildSession sets stats.waits by the session's launch, and leaves it out when nothing waited", () => {
    const live = buildSession([begin(0), prompt(0), turnEnd(10), prompt(70)]);
    assert.equal(live.stats.launch, "interactive");
    assert.deepEqual(live.stats.waits, { count: 1, ms: MIN, byKind: { turn: { count: 1, ms: MIN } } });
    const headless = buildSession([begin(0, "sdk-cli"), prompt(0), turnEnd(10), prompt(70)]);
    assert.equal("waits" in headless.stats, false);
  });

  test("the median is the middle wait", () => {
    const events = [prompt(0), turnEnd(10), prompt(40), turnEnd(50), prompt(110), turnEnd(120), prompt(240)];
    assert.deepEqual(stats(events), { count: 3, ms: 210_000, medianMs: MIN, byKind: { turn: { count: 3, ms: 210_000, medianMs: MIN } } });
  });

  test("the session's median spans its kinds, and a wait capped at 12 hours fills ms but leaves the median", () => {
    // A question answered in 30 s, turns answered in 1 and 2 minutes, then a turn picked up the next day.
    const events = [prompt(0), call(5, "AskUserQuestion", "q1"), done(35, "AskUserQuestion", "q1"), turnEnd(40), prompt(100), turnEnd(110), prompt(230), turnEnd(240), prompt(240 + DAY)];
    assert.deepEqual(stats(events), {
      count: 4,
      ms: 30_000 + MIN + 2 * MIN + 12 * 60 * MIN,
      medianMs: MIN,
      byKind: { question: { count: 1, ms: 30_000 }, turn: { count: 3, ms: MIN + 2 * MIN + 12 * 60 * MIN, medianMs: 2 * MIN } },
      capped: 1,
    });
  });

  test("a Stop hook's blocked stop is no end: the wait starts at the turn's real end", () => {
    const events = [prompt(0), turnEnd(10), call(20, "Bash", "b1"), done(25, "Bash", "b1"), turnEnd(30, { stopHookActive: true }), prompt(90)];
    assert.deepEqual(stats(events), { count: 1, ms: MIN, byKind: { turn: { count: 1, ms: MIN } } });
  });

  test("when the agent goes on by itself after a turn's end, the wait before that is not the person's", () => {
    // A call well after the turn's end, then another end: the first wait ended when the agent went on.
    const calls = [prompt(0), turnEnd(10), call(20, "Bash", "b1"), done(25, "Bash", "b1"), turnEnd(30), prompt(90)];
    assert.deepEqual(stats(calls), { count: 1, ms: MIN, byKind: { turn: { count: 1, ms: MIN } }, agent: { count: 1, ms: 10_000 } });
    // A reply well after the turn's end, then the person's prompt: the same, and no steer.
    const reply = [prompt(0), turnEnd(10), ev(20, "assistant.message", { text: "The build finished." }), prompt(90), turnEnd(100), prompt(130)];
    assert.deepEqual(stats(reply), { count: 1, ms: 30_000, byKind: { turn: { count: 1, ms: 30_000 } }, agent: { count: 1, ms: 10_000 } });
  });

  test("a second copy of the same turn end keeps the wait's start", () => {
    const events = [prompt(0), turnEnd(10), turnEnd(12), prompt(70)];
    assert.deepEqual(stats(events), { count: 1, ms: MIN, byKind: { turn: { count: 1, ms: MIN } } });
  });
});

describe("prompts an agent made", () => {
  const made: [string, () => AgentEvent][] = [
    ["a delegated task's result", () => prompt(70, "Delegated task node:n1 [completed]: done")],
    ["a background task's notification posted as a prompt", () => prompt(70, "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>")],
    ["a task notification event", () => ev(70, "notification", { kind: "task-notification", text: "Background task b1 completed" })],
    ["a prompt marked from: agent", () => ev(70, "user.message", { text: "Review the diff in the other thread", from: "agent" })],
  ];
  for (const [name, agentPrompt] of made) {
    test(`a turn wait ${name} ended counts apart, not as the person's`, () => {
      const events = [prompt(0), turnEnd(10), agentPrompt(), turnEnd(80), prompt(100)];
      assert.deepEqual(stats(events), { count: 1, ms: 20_000, byKind: { turn: { count: 1, ms: 20_000 } }, agent: { count: 1, ms: MIN } });
      // Only an agent ended a wait: the person never waited.
      assert.equal(stats([prompt(0), turnEnd(10), agentPrompt()]), undefined);
    });
  }

  test("an agent's prompt while the turn runs is no steer", () => {
    const events = [prompt(0), prompt(5, "Delegated task node:n1 [completed]: done"), turnEnd(10), prompt(70)];
    assert.deepEqual(stats(events), { count: 1, ms: MIN, byKind: { turn: { count: 1, ms: MIN } } });
  });

  test("an agent's prompt leaves an open question waiting", () => {
    const events = [prompt(0), call(10, "AskUserQuestion", "q1"), ev(20, "user.message", { text: "Status from the other thread", from: "agent" }), done(40, "AskUserQuestion", "q1")];
    assert.deepEqual(stats(events, "headless"), { count: 1, ms: 30_000, byKind: { question: { count: 1, ms: 30_000 } } });
  });
});

describe("steers", () => {
  test("a prompt the person sends while the turn runs is a steer", () => {
    const events = [prompt(0), prompt(5, "also run the linter"), turnEnd(10), prompt(70)];
    assert.deepEqual(stats(events), { count: 1, ms: MIN, byKind: { turn: { count: 1, ms: MIN } }, steers: 1 });
  });

  test("stopping the turn is a turn end, not a steer", () => {
    const events = [prompt(0), prompt(5, "[Request interrupted by user]"), prompt(20, "use the other file")];
    assert.deepEqual(stats(events), { count: 1, ms: 15_000, byKind: { turn: { count: 1, ms: 15_000 } } });
  });

  test("with no turn end seen, prompts are not steers; nor in a headless run", () => {
    assert.equal(stats([prompt(0), prompt(5), prompt(10)]), undefined);
    assert.equal(stats([prompt(0), prompt(5), turnEnd(10), prompt(70)], "headless"), undefined);
  });
});

describe("permission prompts", () => {
  const asked = () => [prompt(0), call(1, "Bash", "b1"), permission(2)];

  test("a permission prompt waits until its call ends, approved or refused", () => {
    const want = { count: 1, ms: 30_000, byKind: { permission: { count: 1, ms: 30_000 } } };
    assert.deepEqual(stats([...asked(), done(32, "Bash", "b1")], "headless"), want);
    assert.deepEqual(stats([...asked(), done(32, "Bash", "b1", false)], "headless"), want, "a refusal ends it too");
  });

  test("a refused prompt with no end ends at the thread's next call, turn end or prompt", () => {
    const ms = (events: AgentEvent[]) => stats([...asked(), ...events], "headless")?.byKind.permission?.ms;
    assert.equal(ms([call(12, "Read", "r1")]), 10_000);
    assert.equal(ms([turnEnd(22)]), 20_000);
    assert.equal(ms([prompt(42, "no, run npm test instead")]), 40_000);
  });

  test("a reminder of the same prompt is one wait", () => {
    const events = [call(1, "Bash", "b1"), permission(2), permission(5), done(32, "Bash", "b1")];
    assert.deepEqual(stats(events, "headless"), { count: 1, ms: 30_000, byKind: { permission: { count: 1, ms: 30_000 } } });
  });
});

describe("questions and plans", () => {
  test("a question call waits until it ends; a copy of its start is the same wait", () => {
    const events = [prompt(0), call(10, "AskUserQuestion", "q1"), call(11, "AskUserQuestion", "q1"), done(40, "AskUserQuestion", "q1"), call(41, "AskUserQuestion", "q1")];
    assert.deepEqual(stats(events, "headless"), { count: 1, ms: 30_000, byKind: { question: { count: 1, ms: 30_000 } } });
  });

  test("a plan approval waits until it ends", () => {
    const events = [prompt(0), call(10, "ExitPlanMode", "p1"), done(70, "ExitPlanMode", "p1")];
    assert.deepEqual(stats(events, "headless"), { count: 1, ms: MIN, byKind: { plan: { count: 1, ms: MIN } } });
  });
});

describe("threads", () => {
  const sub = { subagentId: "a1" };

  test("waits on two threads at once each count", () => {
    const events = [
      prompt(0),
      call(1, "Agent", "sp1"),
      call(10, "AskUserQuestion", "q1"),
      call(15, "Bash", "b1", sub),
      permission(20, sub),
      done(40, "AskUserQuestion", "q1"),
      done(50, "Bash", "b1", true, sub),
      done(55, "Agent", "sp1"),
    ];
    assert.deepEqual(stats(events, "headless"), { count: 2, ms: MIN, medianMs: 30_000, byKind: { permission: { count: 1, ms: 30_000 }, question: { count: 1, ms: 30_000 } } });
  });

  test("a subagent's end ends its own waits only, unanswered", () => {
    const events = [prompt(0), call(15, "Bash", "b1", sub), permission(20, sub), call(25, "AskUserQuestion", "q1"), ev(45, "session.end", { reason: "subagent-stop" }, sub), done(55, "AskUserQuestion", "q1")];
    assert.deepEqual(stats(events, "headless"), {
      count: 2,
      ms: 55_000,
      medianMs: 25_000,
      byKind: { permission: { count: 1, ms: 25_000, open: 1 }, question: { count: 1, ms: 30_000 } },
      open: { count: 1, ms: 25_000 },
    });
  });

  test("a subagent's prompt and turn end are its parent's work: no turn wait, no steer", () => {
    const events = [prompt(0), prompt(1, "Find the flaky test", sub), turnEnd(10, {}, sub), prompt(12, "and fix it", sub), turnEnd(20), prompt(80)];
    assert.deepEqual(stats(events), { count: 1, ms: MIN, byKind: { turn: { count: 1, ms: MIN } } });
  });
});

describe("subagent sessions", () => {
  test("a subagent's waits count in its own session, not its parent's", () => {
    const child = { sessionId: "s1:sub:a1", subagentId: "a1" };
    const kid = buildSession([
      ev(1, "session.start", { source: "subagent", parentSessionId: "s1", entrypoint: "cli" }, child),
      ev(1, "user.message", { text: "Find the flaky test" }, child),
      call(10, "AskUserQuestion", "q1", child),
      done(40, "AskUserQuestion", "q1", true, child),
      turnEnd(50, {}, child),
      ev(50, "session.end", { reason: "subagent-stop" }, child),
    ]);
    assert.equal(kid.parent?.sessionId, "s1");
    assert.deepEqual(kid.stats.waits, { count: 1, ms: 30_000, byKind: { question: { count: 1, ms: 30_000 } } });
    const parent = buildSession([begin(0), prompt(0), call(1, "Agent", "sp1"), done(55, "Agent", "sp1"), turnEnd(56), ev(56, "session.end", { reason: "exit" })]);
    assert.equal("waits" in parent.stats, false);
  });

  test("a subagent session with no subagent id on its events gets no turn waits or steers", () => {
    // A child thread with a session of its own (Codex, for one): its prompts are its parent's.
    const child = { sessionId: "c1" };
    const s = buildSession([
      ev(0, "session.start", { parentSessionId: "s1", entrypoint: "cli" }, child),
      prompt(0, "Find the flaky test", child),
      prompt(5, "and fix it", child),
      turnEnd(10, {}, child),
      prompt(70, "now the next one", child),
      call(80, "AskUserQuestion", "q1", child),
      done(90, "AskUserQuestion", "q1", true, child),
    ]);
    assert.equal(s.stats.launch, "interactive");
    assert.deepEqual(s.stats.waits, { count: 1, ms: 10_000, byKind: { question: { count: 1, ms: 10_000 } } });
  });
});

describe("backfills", () => {
  test("a transcript's permission notifications start no wait; questions and turns still count", () => {
    const events = transcript([begin(0), prompt(0), call(1, "Bash", "b1"), permission(2), done(12, "Bash", "b1"), call(13, "AskUserQuestion", "q1"), done(43, "AskUserQuestion", "q1"), turnEnd(50), prompt(110)]);
    assert.deepEqual(buildSession(events).stats.waits, { count: 2, ms: 90_000, medianMs: 30_000, byKind: { question: { count: 1, ms: 30_000 }, turn: { count: 1, ms: MIN } } });
  });

  test("a transcript's quiet marker ends no wait: the next prompt or call end does", () => {
    // Each backfill that finds a transcript quiet stores a marker at its last entry; a session picked up later keeps it.
    const events = transcript([begin(0), prompt(0), call(10, "AskUserQuestion", "q1"), ev(10, "session.end", { reason: "idle" }), done(50, "AskUserQuestion", "q1"), turnEnd(60), ev(60, "session.end", { reason: "idle" }), prompt(120)]);
    assert.deepEqual(buildSession(events).stats.waits, { count: 2, ms: 100_000, medianMs: 40_000, byKind: { question: { count: 1, ms: 40_000 }, turn: { count: 1, ms: MIN } } });
  });
});

describe("open waits, resumes and the cap", () => {
  test("a wait still open counts up to the last event, as unanswered", () => {
    const events = [prompt(0), call(10, "AskUserQuestion", "q1"), idlePrompt(40)];
    assert.deepEqual(stats(events, "headless"), { count: 1, ms: 30_000, byKind: { question: { count: 1, ms: 30_000, open: 1 } }, open: { count: 1, ms: 30_000 } });
    assert.deepEqual(stats([...events, done(70, "AskUserQuestion", "q1")], "headless"), { count: 1, ms: MIN, byKind: { question: { count: 1, ms: MIN } } }, "answered later, it is the person's");
  });

  test("the session's end closes what waited, unanswered", () => {
    const events = [begin(0), prompt(0), turnEnd(10), ev(70, "session.end", { reason: "prompt_input_exit" })];
    assert.deepEqual(buildSession(events).stats.waits, { count: 1, ms: MIN, byKind: { turn: { count: 1, ms: MIN, open: 1 } }, open: { count: 1, ms: MIN } });
  });

  test("a resume closes what waited at the last event before it, unanswered", () => {
    const events = [begin(0), prompt(0), turnEnd(10), idlePrompt(70), begin(3 * DAY, "cli", { source: "resume" }), prompt(3 * DAY + 5), turnEnd(3 * DAY + 15), prompt(3 * DAY + 75)];
    assert.deepEqual(buildSession(events).stats.waits, { count: 2, ms: 2 * MIN, medianMs: MIN, byKind: { turn: { count: 2, ms: 2 * MIN, medianMs: MIN, open: 1 } }, open: { count: 1, ms: MIN } });
  });

  test("a compaction's session.start is no resume", () => {
    const events = [begin(0), prompt(0), turnEnd(10), begin(40, "cli", { source: "compact" }), prompt(70)];
    assert.deepEqual(buildSession(events).stats.waits, { count: 1, ms: MIN, byKind: { turn: { count: 1, ms: MIN } } });
  });

  test("with no resume marker (a transcript), a wait that spans days counts 12 hours", () => {
    const events = transcript([begin(0), prompt(0), turnEnd(10), ev(10, "session.end", { reason: "idle" }), prompt(3 * DAY)]);
    const cap = 12 * 60 * MIN;
    assert.deepEqual(buildSession(events).stats.waits, { count: 1, ms: cap, byKind: { turn: { count: 1, ms: cap } }, capped: 1 });
  });
});

describe("host app requests (T3 Code)", () => {
  // The T3 Code adapter reports each request to the person as a notification with a requestId, and
  // another when it resolves; they count in a backfill (source "store"): the store is current state.
  const store = { agent: "t3code", source: "store" } as const;
  const asked = (sec: number, id: string, requestKind: string, type = "permission_prompt") => ev(sec, "notification", { type, via: "t3code", requestId: id, requestKind, text: "answer a request" }, store);
  const resolved = (sec: number, id: string) => ev(sec, "notification", { type: HOST_RESOLVED, via: "t3code", requestId: id }, store);

  test("each request waits until it resolves, by what it asks; one still open counts to the last event", () => {
    const events = [
      asked(10, "r1", "command"),
      resolved(40, "r1"),
      asked(50, "r2", "secret"),
      resolved(110, "r2"),
      asked(120, "r3", "user_input", HOST_QUESTION),
      resolved(150, "r3"),
      // Resolved at the time it was asked, and sorted first: no wait.
      resolved(155, "r5"),
      asked(155, "r5", "command"),
      asked(160, "r4", "file-change"),
      ev(200, "assistant.message", { text: "Waiting for approval." }, store),
    ];
    assert.deepEqual(stats(events, null), {
      count: 4,
      ms: 160_000,
      medianMs: 30_000,
      byKind: { permission: { count: 2, ms: 70_000, medianMs: 30_000, open: 1 }, question: { count: 1, ms: 30_000 }, request: { count: 1, ms: MIN } },
      open: { count: 1, ms: 40_000 },
    });
  });

  test("a host's question and the question call it came from are one wait, in either order", () => {
    const hostFirst = [asked(10, "r1", "user_input", HOST_QUESTION), call(11, "AskUserQuestion", "q1"), done(40, "AskUserQuestion", "q1"), resolved(41, "r1")];
    const callFirst = [call(10, "AskUserQuestion", "q1"), asked(11, "r1", "user_input", HOST_QUESTION), resolved(40, "r1"), done(41, "AskUserQuestion", "q1")];
    for (const events of [hostFirst, callFirst]) assert.deepEqual(stats(events, null), { count: 1, ms: 30_000, byKind: { question: { count: 1, ms: 30_000 } } });
  });
});

describe("incremental folds", () => {
  test("a fold saved partway (node:v8) and continued gives the same stats", () => {
    const sub = { subagentId: "a1" };
    const events = byTime([
      begin(0),
      prompt(0),
      prompt(5, "also the docs"),
      call(6, "Agent", "sp1"),
      call(8, "Bash", "b1", sub),
      permission(9, sub),
      done(30, "Bash", "b1", true, sub),
      done(31, "Agent", "sp1"),
      turnEnd(40),
      prompt(100, "Delegated task node:n1 [completed]: done"),
      call(110, "AskUserQuestion", "q1"),
      done(140, "AskUserQuestion", "q1"),
      turnEnd(150),
      prompt(210),
      turnEnd(220),
      idlePrompt(280),
    ]);
    const whole = buildSession(events).stats.waits;
    assert.deepEqual(whole, {
      count: 4,
      ms: 21_000 + 30_000 + MIN + MIN,
      medianMs: 30_000,
      byKind: { permission: { count: 1, ms: 21_000 }, question: { count: 1, ms: 30_000 }, turn: { count: 2, ms: 2 * MIN, medianMs: MIN, open: 1 } },
      open: { count: 1, ms: MIN },
      agent: { count: 1, ms: MIN },
      steers: 1,
    });
    for (let cut = 1; cut < events.length; cut++) {
      let s = sessionState();
      for (const e of events.slice(0, cut)) foldSession(s, e);
      s = deserialize(serialize(s));
      for (const e of events.slice(cut)) foldSession(s, e);
      assert.deepEqual(sessionOf(s).stats.waits, whole, `saved after ${cut} events`);
    }
  });

  test("reading the stats leaves the state as it was", () => {
    const s = waitStatsState();
    const waiting = waitingState();
    for (const e of [prompt(0), call(10, "AskUserQuestion", "q1"), idlePrompt(40)]) {
      foldWaitStats(s, waiting, e, false);
      foldWaiting(waiting, e, false);
    }
    const before = structuredClone(s);
    assert.deepEqual(waitStatsOf(s, { launch: "headless" }), waitStatsOf(s, { launch: "headless" }));
    assert.deepEqual(s, before);
  });
});

describe("the Claude Code subagents capture", () => {
  const MAIN = "36d2966a-1c53-47f1-891d-aae1827d0e95";
  const CHILD = `${MAIN}:sub:afa77c104e92d121e`;
  let env: TmpEnv;
  let events: AgentEvent[];
  before(async () => {
    env = tmpEnv();
    process.env.CLAUDE_CONFIG_DIR = join(FIXTURES, "claude-code", "subagents", "config");
    events = transcript(await collect(claudeCode.backfill!(testCtx().ctx)));
  });
  after(() => env.restore());
  const session = (id: string, extra: AgentEvent[] = []) => buildSession([...events.filter((e) => e.sessionId === id), ...extra]);

  test("as recorded, nothing waits on the person", () => {
    const ids = new Set(events.map((e) => e.sessionId));
    assert.equal(ids.size, 3);
    for (const id of ids) assert.equal(session(id).stats.waits, undefined, id);
  });

  test("a live permission prompt in a subagent counts in the subagent's session", () => {
    const read = events.find((e) => e.sessionId === CHILD && e.kind === "tool.start" && e.payload.toolUseId === "toolu_mw8qww9w8");
    const readEnd = events.find((e) => e.sessionId === CHILD && e.kind === "tool.end" && e.payload.toolUseId === "toolu_mw8qww9w8");
    assert.ok(read && readEnd, "the capture has the subagent's Read call");
    // The hook's notification as a live capture stores it (no source), naming the subagent.
    const asked = ev(0, "notification", { type: "permission_prompt", text: "Claude needs your permission to use Read" }, { sessionId: CHILD, subagentId: read.subagentId, ts: read.ts + 5 });
    const ms = readEnd.ts - asked.ts;
    assert.ok(ms > 0);
    assert.deepEqual(session(CHILD, [asked]).stats.waits, { count: 1, ms, byKind: { permission: { count: 1, ms } } });
    assert.equal(session(MAIN).stats.waits, undefined);
    // The same notification from the transcript (a backfill) starts no wait.
    assert.equal(session(CHILD, transcript([{ ...asked, id: "copy" }])).stats.waits, undefined);
  });
});

describe("the Codex rollout", () => {
  let env: TmpEnv;
  let events: AgentEvent[];
  before(async () => {
    env = tmpEnv();
    process.env.CODEX_HOME = join(FIXTURES, "codex", "home");
    events = transcript((await collect(codex.backfill!(testCtx().ctx))).filter((e) => e.sessionId === "0193cccc-1111-7222-8333-444455556666"));
  });
  after(() => env.restore());

  test("as recorded, the turn's end is the last entry: nothing waited", () => {
    const s = buildSession(events);
    assert.equal(s.stats.launch, "interactive");
    assert.equal(s.stats.waits, undefined);
  });

  test("a prompt a minute after the turn's end is a turn wait, past the quiet marker", () => {
    const end = events.findLast((e) => e.kind === "turn.end")!;
    assert.ok(events.some((e) => e.kind === "session.end" && e.payload.reason === "idle" && e.ts === end.ts), "the backfill stored a quiet marker at the turn's end");
    const first = events.find((e) => e.kind === "user.message")!;
    const next = { ...first, id: "next", ts: end.ts + MIN, payload: { text: "Fix test_div" } };
    assert.deepEqual(buildSession([...events, next]).stats.waits, { count: 1, ms: MIN, byKind: { turn: { count: 1, ms: MIN } } });
    const delegated = { ...next, id: "delegated", payload: { text: "Delegated task node:n1 [completed]: test_div fixed" } };
    assert.equal(buildSession([...events, delegated]).stats.waits, undefined, "an agent's prompt ended it: the person never waited");
  });
});

describe("the Gemini CLI hook fixture", () => {
  test("a ToolPermission notification the session ended on is an open permission wait", async () => {
    const events = await normalizeFixture(geminiCliAdapter, "gemini-cli/hooks.spool.jsonl");
    const note = events.find((e) => e.kind === "notification")!;
    const end = events.find((e) => e.kind === "session.end")!;
    const ms = end.ts - note.ts;
    assert.ok(ms > 0);
    assert.deepEqual(buildSession(events).stats.waits, { count: 1, ms, byKind: { permission: { count: 1, ms, open: 1 } }, open: { count: 1, ms } });
  });
});
