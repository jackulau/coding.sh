// The person's turns by the model that ran them, and edit and shell calls with their real failures
// (core/turn-stats.ts), folded into Session.stats.turnsByModel, edits and shells: synthetic sequences
// for each rule, and recorded fixtures (the Codex rollout, two Claude Code captures made interactive).
// The Claude Code stop capture has two turns the person stopped; the other cancel rules are synthetic, in each agent's shape.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { deserialize, serialize } from "node:v8";
import { claudeCode } from "../../src/adapters/claude-code.ts";
import { codex } from "../../src/adapters/codex.ts";
import { toMetadata } from "../../src/core/redact.ts";
import { buildSession, byTime, foldSession, sessionOf, sessionState } from "../../src/core/sessions.ts";
import { CANCEL_AGENTS } from "../../src/core/turn-stats.ts";
import { decodeLogsJson } from "../../src/otel/json.ts";
import { mapLogs } from "../../src/otel/map.ts";
import { KNOWN_AGENTS, type AgentEvent, type EventKind, type Session } from "../../src/schema/index.ts";
import { collect, FIXTURES, testCtx, tmpEnv, type TmpEnv } from "../adapters/_helpers.ts";
import { fixture } from "../otel/_encode.ts";
import { MemBlobs } from "../otel/_memstore.ts";

const T0 = 1_790_000_000_000;
let n = 0;
/** An event `sec` seconds after T0. */
const ev = (sec: number, kind: EventKind, payload: Record<string, unknown> = {}, over: Partial<AgentEvent> = {}): AgentEvent =>
  ({ id: `t${++n}`, sessionId: "s1", agent: "claude-code", ts: T0 + sec * 1000, kind, cwd: "/work/demo", payload, ...over }) as AgentEvent;
/** A Claude Code start: "cli" is an interactive launch, "sdk-cli" a headless one. */
const begin = (sec: number, payload: Record<string, unknown> = { entrypoint: "cli" }, over: Partial<AgentEvent> = {}) => ev(sec, "session.start", payload, over);
const prompt = (sec: number, text = "add a retry to the fetch helper", over: Partial<AgentEvent> = {}) => ev(sec, "user.message", { text }, over);
const llm = (sec: number, model: string, over: Partial<AgentEvent> = {}) => ev(sec, "llm.call", {}, { model, ...over });
const turnEnd = (sec: number, payload: Record<string, unknown> = {}, over: Partial<AgentEvent> = {}) => ev(sec, "turn.end", payload, over);
const call = (sec: number, tool: string, id: string | undefined, input: unknown = {}, over: Partial<AgentEvent> = {}) =>
  ev(sec, "tool.start", id ? { tool, toolUseId: id, input } : { tool, input }, over);
const done = (sec: number, tool: string, id: string | undefined, ok = true, extra: Record<string, unknown> = {}, over: Partial<AgentEvent> = {}) =>
  ev(sec, "tool.end", { ...(id ? { tool, toolUseId: id } : { tool }), ok, ...extra }, over);
/** T3 Code's link to the thread it hosts: a thread a person started is interactive, whatever the agent's own start says. */
const hostLink = (sec: number, sessionId = "s1") =>
  ({ id: `link${++n}`, v: 0, sessionId, agent: "t3code", ts: T0 + sec * 1000, kind: "notification", payload: { type: "host-link", via: "t3code", launch: "interactive" } }) as AgentEvent;
/** Events as a backfill stores them (core/ingest.ts backfillEvent): source "transcript". */
const transcript = (events: AgentEvent[]): AgentEvent[] => events.map((e) => ({ ...e, source: e.source ?? "transcript" }));

const turns = (events: AgentEvent[]) => buildSession(events).stats.turnsByModel;

describe("turns and their models", () => {
  test("a turn is a prompt and the work until the next one, and goes to the model that made most of its calls", () => {
    const events = [
      begin(0),
      prompt(0),
      llm(2, "model-a"),
      llm(4, "model-b"),
      llm(6, "model-b"),
      turnEnd(10),
      prompt(60, "now update the docs"),
      llm(62, "model-a"),
      turnEnd(70),
    ];
    // The second turn is still open: it counts, with no reply yet.
    assert.deepEqual(turns(events), {
      "model-b": { turns: 1, replied: 1, durationsMs: [10_000] },
      "model-a": { turns: 1, durationsMs: [10_000] },
    });
  });

  test("on a tie the model called first wins", () => {
    assert.deepEqual(turns([begin(0), prompt(0), llm(1, "model-b"), llm(2, "model-a"), turnEnd(5)]), { "model-b": { turns: 1, durationsMs: [5_000] } });
  });

  test("a subagent's calls do not pick the model, but its work, even after the turn's end, is the turn's", () => {
    const sub = { subagentId: "a1" };
    const events = [begin(0), prompt(0), llm(1, "model-a"), llm(5, "model-c", sub), llm(8, "model-c", sub), turnEnd(12), llm(45, "model-c", sub)];
    assert.deepEqual(turns(events), { "model-a": { turns: 1, durationsMs: [45_000] } });
  });

  test("a turn that made no model call goes to the session's model, or to \"\" when the session names none", () => {
    const rest = [prompt(0), turnEnd(3), prompt(10, "thanks"), turnEnd(12)];
    assert.deepEqual(turns([begin(0, { entrypoint: "cli" }, { model: "model-s" }), ...rest]), { "model-s": { turns: 2, replied: 1, durationsMs: [3_000, 2_000] } });
    assert.deepEqual(turns([begin(0), ...rest]), { "": { turns: 2, replied: 1, durationsMs: [3_000, 2_000] } });
  });

  test("the agent's own calls decide the model, else its OTLP logs' copies, else the proxy's", () => {
    const proxy = { source: "proxy" } as const;
    const otel = { source: "otel-log" } as const;
    const base = [begin(0), prompt(0), llm(1, "proxy-model", proxy), llm(2, "proxy-model", proxy), turnEnd(9)];
    assert.deepEqual(Object.keys(turns(base)!), ["proxy-model"]);
    assert.deepEqual(Object.keys(turns([...base, llm(3, "otel-model", otel)])!), ["otel-model"], "one copy from the OTLP logs beats two proxy calls");
    assert.deepEqual(Object.keys(turns([...base, llm(3, "otel-model", otel), llm(4, "own-model")])!), ["own-model"]);
  });
});

describe("replies and pushback", () => {
  test("the person's next prompt answers the turn before it, under that turn's model", () => {
    const events = [
      begin(0),
      prompt(0),
      llm(1, "model-a"),
      turnEnd(5),
      prompt(20, "that didn't work, the test still fails"),
      llm(21, "model-b"),
      turnEnd(25),
      prompt(40, "not what I asked, I meant the parser"),
      llm(41, "model-b"),
      turnEnd(45),
      prompt(60, "undo that"),
      llm(61, "model-a"),
      turnEnd(65),
      prompt(80, "try again"),
      llm(81, "model-a"),
      turnEnd(85),
      prompt(100, "looks good, thanks"),
      llm(101, "model-a"),
      turnEnd(105),
    ];
    assert.deepEqual(turns(events), {
      "model-a": { turns: 4, replied: 3, pushback: { broken: 1, redo: 1 }, durationsMs: [5_000, 5_000, 5_000, 5_000] },
      "model-b": { turns: 2, replied: 2, pushback: { intent: 1, undo: 1 }, durationsMs: [5_000, 5_000] },
    });
  });

  test("an agent's prompt and harness markup go on with the turn; a prompt with no text starts a turn but is no reply", () => {
    const events = [
      begin(0),
      prompt(0),
      llm(1, "model-a"),
      turnEnd(5),
      prompt(10, "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>"),
      llm(11, "model-a"),
      turnEnd(15),
      prompt(20, "Delegated task node:n1 [completed]: done"),
      prompt(25, "<local-command-stdout>Set model to model-a</local-command-stdout>"),
      prompt(30, "that didn't work"),
      llm(31, "model-a"),
      turnEnd(35),
      // An image with no text.
      prompt(40, ""),
      llm(41, "model-a"),
      turnEnd(44),
    ];
    assert.deepEqual(turns(events), { "model-a": { turns: 3, replied: 1, pushback: { broken: 1 }, durationsMs: [15_000, 5_000, 4_000] } });
  });

  test("a prompt the person sends while the turn runs (a steer) starts the next turn", () => {
    const events = [begin(0), prompt(0), llm(1, "model-a"), prompt(3, "also handle timeouts"), llm(4, "model-a"), turnEnd(8)];
    assert.deepEqual(turns(events), { "model-a": { turns: 2, replied: 1, durationsMs: [1_000, 5_000] } });
  });
});

describe("prompts the OTLP export copies", () => {
  // Three turns whose prompts the agent's own capture records. The OTLP logs copy each prompt under
  // another id, 50 ms before or after it, with its text or with none (the export's default).
  const otelLog = { source: "otel-log" } as const;
  const said = [
    [0, "add a retry to the fetch helper"],
    [20, "try again"],
    [40, "now update the docs"],
  ] as const;
  const shifted = (e: AgentEvent, ms: number): AgentEvent => ({ ...e, ts: e.ts + ms });
  type Copies = (sec: number, text: string) => AgentEvent[];
  const copy = (ms: number, withText: boolean): Copies => (sec, text) => [shifted(ev(sec, "user.message", withText ? { text } : { promptLength: text.length }, otelLog), ms)];
  const session = (source: string, copies: Copies = () => []) => [
    begin(-1),
    ...said.flatMap(([sec, text]) => [prompt(sec, text, { source }), ...copies(sec, text), llm(sec + 1, "model-a"), turnEnd(sec + 5)]),
  ];
  const alone = { "model-a": { turns: 3, replied: 2, pushback: { redo: 1 }, durationsMs: [5_000, 5_000, 5_000] } };
  // The hooks were installed after the first turn: its prompt comes only from the export.
  const late = (withText: boolean) => {
    const [first, ...rest] = said;
    return [
      begin(-1),
      ...copy(0, withText)(...first),
      llm(1, "model-a"),
      turnEnd(5),
      ...rest.flatMap(([sec, text]) => [...copy(-50, withText)(sec, text), prompt(sec, text, { source: "hook" }), llm(sec + 1, "model-a"), turnEnd(sec + 5)]),
    ];
  };
  // That turn counts, though the export cannot show its stop.
  const lateTurns = { "model-a": { ...alone["model-a"], cancelNotRecorded: 1 } };

  test("a prompt the session's own capture records counts once, its copy before or after it, with text or none", () => {
    assert.deepEqual(turns(session("hook")), alone);
    for (const ms of [-50, 50]) {
      for (const withText of [true, false]) {
        const label = `copy ${ms} ms, ${withText ? "with" : "no"} text`;
        assert.deepEqual(turns(session("hook", copy(ms, withText))), alone, `hooks, ${label}`);
        assert.deepEqual(turns(session("transcript", copy(ms, withText))), alone, `transcript, ${label}`);
      }
    }
  });

  test("the copies count while the session has no prompt from its own capture, and stop once one comes", () => {
    const exportedOnly = [begin(-1), ...said.flatMap(([sec, text]) => [prompt(sec, text, otelLog), llm(sec + 1, "model-a"), turnEnd(sec + 5)])];
    // The export cannot show a stop.
    assert.deepEqual(turns(exportedOnly), { "model-a": { ...alone["model-a"], cancelNotRecorded: 3 } });
    // The first hook prompt takes over the turn its copy opened. When the copy had no text, the prompt answers the turn before.
    assert.deepEqual(turns(late(true)), lateTurns);
    assert.deepEqual(turns(late(false)), lateTurns);
    // A copy more than COPY_SLACK_MS before the prompt is another prompt.
    assert.equal(turns(session("hook", copy(-6_000, true)))!["model-a"]!.turns, 4);
  });

  test("a fold saved partway (node:v8) and continued gives the same turns", () => {
    const events = byTime(late(false));
    for (let cut = 1; cut < events.length; cut++) {
      let s = sessionState();
      for (const e of events.slice(0, cut)) foldSession(s, e);
      s = deserialize(serialize(s));
      for (const e of events.slice(cut)) foldSession(s, e);
      assert.deepEqual(sessionOf(s).stats.turnsByModel, lateTurns, `saved after ${cut} events`);
    }
  });

  test("the copy the OTLP log mapper makes of Claude Code's user_prompt starts no turn", async () => {
    const blobs = new MemBlobs();
    const logs = (await mapLogs(decodeLogsJson(fixture("claude-code-logs.json")), { maxInlineBytes: 4096, blob: (d) => blobs.put(d) })).events;
    const [exportedPrompt, ...more] = logs.filter((e) => e.kind === "user.message");
    assert.ok(exportedPrompt && !more.length);
    assert.equal(exportedPrompt.source, "otel-log");
    // The same session's start, prompt and turn end from the hooks, around the logs' model and tool calls.
    const own = { sessionId: exportedPrompt.sessionId, source: "hook" } as const;
    const last = Math.max(...logs.map((e) => e.ts));
    const hooks = [
      { ...begin(0, { entrypoint: "cli" }, own), ts: exportedPrompt.ts - 1_000 },
      { ...prompt(0, "fix the failing test", own), ts: exportedPrompt.ts + 50 },
      { ...turnEnd(0, {}, own), ts: last + 100 },
    ];
    const expected = { "claude-sonnet-4-5": { turns: 1, durationsMs: [last + 100 - (exportedPrompt.ts + 50)] } };
    assert.deepEqual(turns([...hooks, ...logs.filter((e) => e !== exportedPrompt)]), expected);
    assert.deepEqual(turns([...hooks, ...logs]), expected);
  });
});

describe("cancelled turns", () => {
  test("Claude Code: the person's interrupt cancels the turn and ends its work", () => {
    const events = [begin(0), prompt(0), llm(2, "model-a"), prompt(9, "[Request interrupted by user]"), prompt(30, "use the other approach")];
    // The open turn made no call: it goes to the session's model, which model-a is.
    assert.deepEqual(turns(events), { "model-a": { turns: 2, replied: 1, cancelled: 1, durationsMs: [9_000] } });
  });

  test("Claude Code: a prompt with no text (metadata mode) or from its OTLP export cannot show a stop, so the turn's stop is not recorded", () => {
    const events = [begin(0), prompt(0), llm(2, "model-a"), prompt(9, "[Request interrupted by user]"), prompt(30, "use the other approach")];
    // With no text the interrupt reads as the person's prompt: it opens a turn, and no turn can say it was stopped.
    assert.deepEqual(turns(events.map(toMetadata)), { "model-a": { turns: 3, cancelNotRecorded: 3, durationsMs: [2_000] } });
    const otelLog = { source: "otel-log" } as const;
    const exported = [begin(0), prompt(0, "add a retry to the fetch helper", otelLog), llm(2, "model-a"), turnEnd(5), prompt(10, "that didn't work", otelLog)];
    assert.deepEqual(turns(exported), { "model-a": { turns: 2, replied: 1, pushback: { broken: 1 }, cancelNotRecorded: 2, durationsMs: [5_000] } });
    // Codex says so on the turn's end, which metadata mode keeps.
    const codexEv = { agent: "codex" } as const;
    const codexEvents = [begin(0, { launch: "cli" }, codexEv), prompt(0, "fix test_div", codexEv), llm(1, "gpt-5", codexEv), turnEnd(4, { status: "interrupted" }, codexEv), prompt(10, "use pytest.approx", codexEv)];
    assert.deepEqual(turns(codexEvents.map(toMetadata)), { "gpt-5": { turns: 2, cancelled: 1, durationsMs: [4_000] } });
  });

  test("Codex: a turn the person interrupted is cancelled; one another turn replaced is not", () => {
    const codexEv = { agent: "codex" } as const;
    const events = [
      begin(0, { launch: "cli" }, codexEv),
      prompt(0, "fix test_div", codexEv),
      llm(1, "gpt-5", codexEv),
      turnEnd(4, { status: "interrupted" }, codexEv),
      prompt(10, "use pytest.approx", codexEv),
      llm(11, "gpt-5", codexEv),
      turnEnd(14, { status: "replaced" }, codexEv),
      prompt(20, "and run it", codexEv),
    ];
    assert.deepEqual(turns(events), { "gpt-5": { turns: 3, replied: 2, cancelled: 1, durationsMs: [4_000, 4_000] } });
  });

  for (const [agent, stopped, finished] of [
    ["opencode", { status: "interrupted" }, { status: "succeeded" }],
    ["cursor", { status: "aborted" }, { status: "completed" }],
    ["pi", { aborted: true }, { aborted: false }],
    ["pi", { stopReason: "aborted" }, { stopReason: "stop" }],
  ] as const) {
    test(`${agent}: the turn's end says the person stopped it (${JSON.stringify(stopped)})`, () => {
      const by = { agent } as const;
      const events = (end: Record<string, unknown>) => [hostLink(0), begin(0, {}, by), prompt(0, "fix test_div", by), llm(1, "model-x", by), turnEnd(4, end, by)];
      assert.deepEqual(turns(events(stopped)), { "model-x": { turns: 1, cancelled: 1, durationsMs: [4_000] } });
      assert.deepEqual(turns(events(finished)), { "model-x": { turns: 1, durationsMs: [4_000] } });
    });
  }

  test("a subagent's stopped turn does not cancel the person's", () => {
    const by = { agent: "codex" } as const;
    const events = [begin(0, { launch: "cli" }, by), prompt(0, "fix test_div", by), llm(1, "gpt-5", by), turnEnd(3, { status: "interrupted" }, { ...by, subagentId: "a1" }), turnEnd(5, {}, by)];
    assert.deepEqual(turns(events), { "gpt-5": { turns: 1, durationsMs: [5_000] } });
  });

  test("a turn whose capture records no stop counts as not recorded, never as cancelled", () => {
    const gemini = { agent: "gemini-cli" } as const;
    const events = [hostLink(0), begin(0, {}, gemini), prompt(0, "fix test_div", gemini), llm(1, "gemini-2.5-pro", gemini), turnEnd(4, {}, gemini), prompt(10, "and run it", gemini)];
    assert.deepEqual(turns(events), { "gemini-2.5-pro": { turns: 2, replied: 1, cancelNotRecorded: 2, durationsMs: [4_000] } });
  });

  test("a T3 Code thread built from T3 Code's store records no stop, though the agent it ran does", () => {
    // Every event is T3 Code's: its host link names the provider thread and the agent, Claude Code.
    const t3 = { agent: "t3code" } as const;
    const link = { ...hostLink(0), payload: { type: "host-link", via: "t3code", provider: "claude-code", t3ProviderThreadId: "pt-1", launch: "interactive" } } as AgentEvent;
    // The turn end built from T3 Code's store says only whether the turn completed (ok): not completing is no stop.
    const events = [link, begin(0, { source: "store", via: "t3code", provider: "claude-code" }, t3), prompt(1, "fix test_div", t3), llm(1, "model-a", t3), turnEnd(4, { ok: false }, t3), prompt(10, "use pytest.approx", t3)];
    const s = buildSession(events);
    assert.deepEqual([s.agent, s.host], ["claude-code", "t3code"]);
    assert.deepEqual(s.stats.turnsByModel, { "model-a": { turns: 2, replied: 1, cancelNotRecorded: 2, durationsMs: [3_000] } });
  });

  test("every known agent records cancelled turns or is named here as recording none", () => {
    // The scorecard prints "not recorded" for these. Adding an agent means deciding which list it is in.
    const none = ["gemini-cli", "antigravity", "copilot-cli", "amp", "droid", "goose", "aider", "devin", "t3code", "wrapper"];
    assert.deepEqual([...CANCEL_AGENTS].sort(), ["claude-code", "codex", "cursor", "opencode", "pi"]);
    assert.deepEqual(KNOWN_AGENTS.filter((a) => !CANCEL_AGENTS.has(a)).sort(), none.sort());
  });
});

describe("which sessions count turns", () => {
  const work = (over: Partial<AgentEvent> = {}) => [
    prompt(0, "add a retry to the fetch helper", over),
    llm(1, "model-a", over),
    call(2, "Bash", "b1", { command: "ls" }, over),
    done(3, "Bash", "b1", true, {}, over),
    turnEnd(5, {}, over),
  ];

  test("only a session launched interactively that is not a subagent; edit and shell calls count in every session", () => {
    const of = (events: AgentEvent[]): Session["stats"] => buildSession(events).stats;
    assert.deepEqual(of([begin(0), ...work()]).turnsByModel, { "model-a": { turns: 1, durationsMs: [5_000] } });
    const others: [string, AgentEvent[]][] = [
      ["headless", [begin(0, { entrypoint: "sdk-cli" }), ...work()]],
      ["launch unknown", work()],
      ["a subagent session", [begin(0, { parentSessionId: "s0", entrypoint: "cli" }), ...work()]],
      ["a subagent's thread", [begin(0, { source: "subagent", parentSessionId: "s0", entrypoint: "cli" }, { sessionId: "s0:sub:a1", subagentId: "a1" }), ...work({ sessionId: "s0:sub:a1", subagentId: "a1" })]],
    ];
    for (const [what, events] of others) {
      const stats = of(events);
      assert.equal("turnsByModel" in stats, false, what);
      assert.deepEqual(stats.shells, { calls: 1 }, what);
    }
  });

  test("a host link makes a thread a person started interactive", () => {
    const by = { agent: "opencode" } as const;
    assert.deepEqual(turns([hostLink(0), begin(0, {}, by), ...work(by)]), { "model-a": { turns: 1, durationsMs: [5_000] } });
    assert.equal(turns([begin(0, {}, by), ...work(by)]), undefined);
  });
});

describe("turn durations", () => {
  test("a resume ends the turn's work; a compaction does not", () => {
    const tail = [llm(3601, "model-a"), prompt(3700, "continue")];
    const resumed = [begin(0), prompt(0), llm(1, "model-a"), turnEnd(5), begin(3600, { entrypoint: "cli", source: "resume" }), ...tail];
    assert.deepEqual(turns(resumed), { "model-a": { turns: 2, replied: 1, durationsMs: [5_000] } });
    const compacted = [begin(0), prompt(0), llm(1, "model-a"), begin(30, { entrypoint: "cli", source: "compact" }), llm(31, "model-a"), turnEnd(40)];
    assert.deepEqual(turns(compacted), { "model-a": { turns: 1, durationsMs: [40_000] } });
  });

  test("a start stamped with the prompt's time is no resume", () => {
    // Ties keep the store's order: a live start can land after the prompt it came with.
    const events = [prompt(0), begin(0), llm(1, "model-a"), turnEnd(6)];
    assert.deepEqual(turns(events), { "model-a": { turns: 1, durationsMs: [6_000] } });
  });

  test("a transcript's synthesized end is no work: it is stamped when the next prompt was written", () => {
    const end = (sec: number) => transcript([turnEnd(sec, { synthesized: true })]);
    const before = [begin(0), prompt(0), llm(1, "model-a"), ...end(10), prompt(10, "thanks"), llm(11, "model-a"), ...end(13)];
    assert.deepEqual(turns(before), { "model-a": { turns: 2, replied: 1, durationsMs: [1_000, 1_000] } });
    // A live prompt can sort before the transcript's end of the turn it answers.
    const after = [begin(0), prompt(0), llm(1, "model-a"), turnEnd(3), prompt(10, "thanks"), ...end(10.5)];
    assert.deepEqual(turns(after), { "model-a": { turns: 2, replied: 1, durationsMs: [3_000] } });
  });

  test("a compaction between turns is no work of the turn before", () => {
    // The person ran /compact after the turn.
    const events = [begin(0), prompt(0), llm(1, "model-a"), turnEnd(3), ev(20, "context.compact", { trigger: "manual" }, { durationMs: 5_000 }), prompt(60, "next")];
    assert.deepEqual(turns(events), { "model-a": { turns: 2, replied: 1, durationsMs: [3_000] } });
  });
});

describe("edit and shell calls", () => {
  test("counts file-edit and shell calls on every thread, and only the ones that failed for real", () => {
    const sub = { subagentId: "a1" };
    const events = [
      begin(0),
      prompt(0),
      call(1, "Edit", "e1", { file_path: "a.ts" }),
      done(2, "Edit", "e1"),
      call(3, "Write", "e2", { file_path: "b.ts" }),
      done(4, "Write", "e2", false, { output: "EACCES: permission denied, open 'b.ts'" }),
      call(5, "Bash", "b1", { command: "npm test" }),
      done(9, "Bash", "b1", false, { output: "Exit code 2\n1 failing", exitCode: 2 }),
      // grep found nothing: not a failure.
      call(10, "Bash", "b2", { command: "grep -q TODO src/a.ts" }),
      done(11, "Bash", "b2", false, { output: "", exitCode: 1 }),
      // The person stopped it: not a failure.
      call(12, "Bash", "b3", { command: "npm run dev" }),
      done(20, "Bash", "b3", false, { interrupted: true }),
      // Neither an edit nor a shell call.
      call(21, "Read", "r1", { file_path: "a.ts" }),
      done(22, "Read", "r1", false),
      call(23, "Bash", "b4", { command: "ls" }, sub),
      done(24, "Bash", "b4", true, {}, sub),
    ];
    const { stats } = buildSession(events);
    assert.deepEqual(stats.edits, { calls: 2, failed: 1 });
    assert.deepEqual(stats.shells, { calls: 4, failed: 1 });
  });

  test("a call two capture paths recorded counts once", () => {
    const live = [call(1, "Bash", "b1", { command: "cat x" }), done(2, "Bash", "b1", false, { output: "cat: x: No such file or directory", exitCode: 1 })];
    const copies = transcript([call(1.2, "Bash", "b1", { command: "cat x" }), done(2.2, "Bash", "b1", false, { output: "cat: x: No such file or directory" })]);
    assert.deepEqual(buildSession([begin(0), prompt(0), ...live, ...copies]).stats.shells, { calls: 1, failed: 1 });
    // The transcript's start, then the live end.
    assert.deepEqual(buildSession([begin(0), prompt(0), copies[0]!, live[1]!, copies[1]!]).stats.shells, { calls: 1, failed: 1 });
  });

  test("a call with no id pairs with its tool's oldest start on its thread", () => {
    // An `exec` call is a shell call only with a command line, which its end leaves out.
    const events = [
      begin(0),
      prompt(0),
      call(1, "exec", undefined, { command: "npm test" }),
      call(2, "exec", undefined, { code: "print(1)" }),
      done(5, "exec", undefined, false, { output: "1 failing" }),
      done(6, "exec", undefined, false, { output: "Traceback" }),
    ];
    assert.deepEqual(buildSession(events).stats.shells, { calls: 1, failed: 1 });
  });

  test("absent when the session made no such call", () => {
    const { stats } = buildSession([begin(0), prompt(0), call(1, "Read", "r1", { file_path: "a.ts" }), done(2, "Read", "r1"), turnEnd(3)]);
    assert.equal("edits" in stats, false);
    assert.equal("shells" in stats, false);
  });
});

describe("incremental folds", () => {
  const events = byTime([
    begin(0),
    prompt(0),
    llm(1, "model-a"),
    call(2, "Edit", "e1", { file_path: "a.ts" }),
    ...transcript([call(2.1, "Edit", "e1", { file_path: "a.ts" })]),
    done(3, "Edit", "e1", false, { output: "String to replace not found" }),
    call(4, "exec", undefined, { command: "npm test" }),
    done(6, "exec", undefined, false, { output: "1 failing" }),
    prompt(7, "[Request interrupted by user]"),
    prompt(20, "that didn't work"),
    llm(21, "model-b"),
    llm(22, "model-b"),
    turnEnd(25),
    begin(600, { entrypoint: "cli", source: "resume" }),
    prompt(700, "try again"),
    llm(701, "model-a"),
  ]);

  test("a fold saved partway (node:v8) and continued gives the same stats", () => {
    const whole = buildSession(events).stats;
    assert.deepEqual(whole.turnsByModel, {
      "model-a": { turns: 2, replied: 1, pushback: { broken: 1 }, cancelled: 1, durationsMs: [7_000, 1_000] },
      "model-b": { turns: 1, replied: 1, pushback: { redo: 1 }, durationsMs: [5_000] },
    });
    assert.deepEqual(whole.edits, { calls: 1, failed: 1 });
    assert.deepEqual(whole.shells, { calls: 1, failed: 1 });
    for (let cut = 1; cut < events.length; cut++) {
      let s = sessionState();
      for (const e of events.slice(0, cut)) foldSession(s, e);
      s = deserialize(serialize(s));
      for (const e of events.slice(cut)) foldSession(s, e);
      const { stats } = sessionOf(s);
      assert.deepEqual([stats.turnsByModel, stats.edits, stats.shells], [whole.turnsByModel, whole.edits, whole.shells], `saved after ${cut} events`);
    }
  });

  test("reading the stats leaves the state as it was", () => {
    const s = sessionState();
    for (const e of events) foldSession(s, e);
    const before = structuredClone(s.turns);
    assert.deepEqual(sessionOf(s).stats.turnsByModel, sessionOf(s).stats.turnsByModel);
    assert.deepEqual(s.turns, before);
  });
});

describe("the Codex rollout", () => {
  const ID = "0193cccc-1111-7222-8333-444455556666";
  let env: TmpEnv;
  let events: AgentEvent[];
  before(async () => {
    env = tmpEnv();
    process.env.CODEX_HOME = join(FIXTURES, "codex", "home");
    events = transcript((await collect(codex.backfill!(testCtx().ctx))).filter((e) => e.sessionId === ID));
  });
  after(() => env.restore());

  test("as recorded: one turn on gpt-5, from the prompt to the turn's end, and one shell call that failed", () => {
    const first = events.find((e) => e.kind === "user.message")!;
    const end = events.findLast((e) => e.kind === "turn.end")!;
    assert.equal(end.ts - first.ts, 2_695);
    const { stats } = buildSession(events);
    assert.equal(stats.launch, "interactive");
    assert.deepEqual(stats.turnsByModel, { "gpt-5": { turns: 1, durationsMs: [2_695] } });
    assert.deepEqual(stats.shells, { calls: 1, failed: 1 });
    assert.equal("edits" in stats, false);
  });

  test("a reply that says it didn't work is pushback on the turn", () => {
    const end = events.findLast((e) => e.kind === "turn.end")!;
    const first = events.find((e) => e.kind === "user.message")!;
    const next = { ...first, id: "next", ts: end.ts + 60_000, payload: { text: "that didn't work, test_div still fails" } };
    assert.deepEqual(buildSession([...events, next]).stats.turnsByModel, { "gpt-5": { turns: 2, replied: 1, pushback: { broken: 1 }, durationsMs: [2_695] } });
  });

  test("a turn the person interrupted is cancelled", () => {
    const end = events.findLast((e) => e.kind === "turn.end")!;
    const stopped = events.map((e) => (e === end ? { ...e, payload: { ...e.payload, status: "interrupted" } } : e));
    assert.deepEqual(buildSession(stopped).stats.turnsByModel, { "gpt-5": { turns: 1, cancelled: 1, durationsMs: [2_695] } });
  });
});

describe("the Claude Code capture", () => {
  let env: TmpEnv;
  let events: AgentEvent[];
  before(async () => {
    env = tmpEnv();
    process.env.CLAUDE_CONFIG_DIR = join(FIXTURES, "claude-code", "real", "config");
    events = transcript(await collect(claudeCode.backfill!(testCtx().ctx)));
  });
  after(() => env.restore());

  test("run through the Agent SDK it is headless: no turns, its shell calls still count", () => {
    const { stats } = buildSession(events);
    assert.equal(stats.launch, "headless");
    assert.equal("turnsByModel" in stats, false);
    assert.deepEqual(stats.shells, { calls: 4 });
  });

  test("launched from the terminal: two turns, each ending with the agent's last message", () => {
    const cli = events.map((e) => (e.kind === "session.start" ? { ...e, payload: { ...e.payload, entrypoint: "cli" } } : e));
    const [first, second, ...more] = cli.filter((e) => e.kind === "user.message");
    assert.ok(first && second && !more.length, "two prompts; the skill's text the first turn loaded is no prompt");
    const said = cli.filter((e) => e.kind === "assistant.message");
    assert.equal(said.length, 2);
    // Between the turns the person ran /compact, and the transcript's end of the first turn is stamped
    // with the second prompt's time: neither is the first turn's work.
    assert.ok(cli.some((e) => e.kind === "context.compact" && e.ts > said[0]!.ts && e.ts < second.ts));
    assert.equal(cli.find((e) => e.kind === "turn.end")!.ts, second.ts);
    assert.deepEqual(buildSession(cli).stats.turnsByModel, {
      "claude-sonnet-4-5": { turns: 2, replied: 1, durationsMs: [said[0]!.ts - first.ts, said[1]!.ts - second.ts] },
    });
  });
});

describe("the Claude Code stop capture", () => {
  let env: TmpEnv;
  let events: AgentEvent[];
  before(async () => {
    env = tmpEnv();
    process.env.CLAUDE_CONFIG_DIR = join(FIXTURES, "claude-code", "stop", "config");
    events = transcript(await collect(claudeCode.backfill!(testCtx().ctx)));
  });
  after(() => env.restore());

  test("run through the Agent SDK it is headless: no turns, its stopped shell call still counts", () => {
    const { stats } = buildSession(events);
    assert.equal(stats.launch, "headless");
    assert.equal("turnsByModel" in stats, false);
    assert.deepEqual(stats.shells, { calls: 1 });
  });

  test("launched from the terminal: the turn stopped while the model wrote and the one stopped during its shell call are cancelled", () => {
    const cli = events.map((e) => (e.kind === "session.start" ? { ...e, payload: { ...e.payload, entrypoint: "cli" } } : e));
    const said = cli.filter((e) => e.kind === "user.message");
    assert.deepEqual(said.map((e) => e.payload.text), ["Summarize notes.txt.", "[Request interrupted by user]", "Run the slow check.", "[Request interrupted by user for tool use]", "Say done."]);
    const last = cli.findLast((e) => e.kind === "assistant.message")!;
    assert.deepEqual(buildSession(cli).stats.turnsByModel, {
      "claude-sonnet-4-5": { turns: 3, replied: 2, cancelled: 2, durationsMs: [said[1]!.ts - said[0]!.ts, said[3]!.ts - said[2]!.ts, last.ts - said[4]!.ts] },
    });
  });
});
