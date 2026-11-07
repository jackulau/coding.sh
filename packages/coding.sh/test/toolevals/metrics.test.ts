// §15.5: computeMetrics on hand-built event and tap fixtures, plus the
// tool-call classifier it relies on.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentRunOutput, Session } from "../../src/core/types.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { classifyToolStart, effectiveArgv, parseMcpToolName, shellSegments, shellUse } from "../../src/toolevals/classify.ts";
import { attributeTap, computeMetrics } from "../../src/toolevals/metrics.ts";
import type { TapRecord } from "../../src/toolevals/types.ts";
import { cliTarget, task } from "./helpers.ts";

let n = 0;
function ev(kind: AgentEvent["kind"], ts: number, payload: Record<string, unknown> = {}, extra: Partial<AgentEvent> = {}): AgentEvent {
  return { id: `e${++n}`, v: 0, sessionId: "s1", ts, agent: "claude-code", kind, payload, ...extra } as AgentEvent;
}
const bash = (ts: number, id: string, command: string, dur = 50, extra: Partial<AgentEvent> = {}) => [
  ev("tool.start", ts, { tool: "Bash", toolUseId: id, input: { command } }, extra),
  ev("tool.end", ts + dur, { tool: "Bash", toolUseId: id, ok: true }, extra),
];
const cli = (ts: number, cls: TapRecord["class"], argv: string[], extra: Partial<TapRecord> = {}): TapRecord => ({ ts, durationMs: 20, target: "cli", class: cls, argv, exitCode: cls === "ok" ? 0 : 2, ...extra });
const session = (id: string, extra: Partial<Session> = {}): Session => ({ id, agent: "claude-code", startedAt: 1000, stats: { events: 0, turns: 0, toolCalls: 0, toolErrors: 0 }, ...extra }) as Session;
const run: AgentRunOutput = { exitCode: 0, timedOut: false, durationMs: 4000, stdoutTail: "", stderrTail: "" };

describe("classify", () => {
  it("splits shell lines and finds the binary, including by path", () => {
    assert.equal(shellSegments(`cd x && fake-cli greet "a && b" | head -1; echo done`).length, 4);
    assert.deepEqual(effectiveArgv(shellSegments("FOO=1 env BAR=2 sudo fake-cli greet")[0]!), ["fake-cli", "greet"]);
    const u = shellUse("fake-cli --help && /opt/bin/fake-cli greet; man fake-cli", "fake-cli");
    assert.deepEqual(u, { invocations: 2, byPath: 1, helpLookups: 2, binHelp: 1 });
  });

  it("classifies tool.start events across agents", () => {
    assert.equal(classifyToolStart(ev("tool.start", 0, { tool: "Bash", input: { command: "ls" } })).category, "shell");
    assert.equal(classifyToolStart(ev("tool.start", 0, { tool: "shell", input: { command: ["bash", "-lc", "ls"] } })).category, "shell");
    assert.equal(classifyToolStart(ev("tool.start", 0, { tool: "Read", input: { file_path: "/x/README.md" } })).path, "/x/README.md");
    assert.equal(classifyToolStart(ev("tool.start", 0, { tool: "Task", input: {} })).category, "subagent");
    assert.deepEqual(parseMcpToolName("mcp__fake__echo"), { server: "fake", tool: "echo" });
    assert.deepEqual(classifyToolStart(ev("tool.start", 0, { tool: "mcp__fake__echo", input: {} })).mcp, { server: "fake", tool: "echo" });
  });
});

describe("computeMetrics", () => {
  const events: AgentEvent[] = [
    ev("session.start", 1000),
    ev("llm.call", 1001, { ok: true, ttftMs: 100 }, { durationMs: 400, source: "hook", usage: { inputTokens: 1000, outputTokens: 50 }, model: "m" }),
    ...bash(1100, "u1", "fake-cli greet --bogus"),
    ...bash(1300, "u2", "fake-cli greet"),
    ev("llm.call", 1350, { ok: true, ttftMs: 200 }, { durationMs: 600, source: "hook", usage: { inputTokens: 1500, outputTokens: 80 }, model: "m" }),
    ...bash(1500, "u3", "/usr/local/bin/fake-cli sum 1 2"),
    ...bash(1700, "u4", "/usr/local/bin/fake-cli sum 3 4"),
    ...bash(1800, "u5", "fake-cli --help"),
    ev("subagent.start", 2000, { subagentId: "sa1", type: "general" }),
    ev("subagent.end", 2500, { subagentId: "sa1" }),
    ev("assistant.message", 2600, { text: "done" }),
  ];
  const tap: TapRecord[] = [
    cli(1110, "invalid", ["greet", "--bogus"], { reason: "unknown-flag" }),
    cli(1310, "ok", ["greet"]),
    cli(1810, "help", ["--help"], { stdoutBytes: 300 }),
    cli(2100, "ok", ["sum", "1"]), // inside the subagent window, no parent call in flight
  ];
  const m = computeMetrics({ task: task({ budget: { turns: 10 }, expect: { minTargetCalls: 2 } }), target: cliTarget(), tap, events, sessions: [session("s1", { model: "m" })], run, checksPass: true, prices: { m: { input: 1, output: 10 } } });

  it("counts calls, retries, self-corrections and recovery", () => {
    assert.equal(m.success, true);
    assert.equal(m.turns, 2);
    assert.equal(m.turnsSource, "llm.call");
    assert.equal(m.targetCalls, 4);
    assert.equal(m.invalidCalls, 1);
    assert.equal(m.invalidRate, 0.25);
    assert.deepEqual(m.invalidKinds, { "unknown-flag": 1 });
    assert.equal(m.retries, 1);
    assert.equal(m.selfCorrections, 1);
    assert.equal(m.recoveryRate, 1);
    assert.equal(m.firstCallCorrect, false);
    assert.equal(m.callsToFirstCorrect, 2);
    assert.equal(m.timeToFirstCorrectMs, 310);
    assert.equal(m.efficiency, 2);
  });

  it("counts help lookups once across tap and trace", () => {
    assert.equal(m.helpLookups, 1);
    assert.equal(m.helpBytesRead, 300);
  });

  it("attributes a windowed call to the subagent", () => {
    assert.equal(m.subagents, 1);
    assert.equal(m.subagentTargetCalls, 1);
    const who = attributeTap(tap, events, "s1");
    assert.equal(who[3]!.attribution, "window");
    assert.equal(who[3]!.agentKey, "sub:sa1");
    assert.equal(who[0]!.attribution, "tool");
    assert.equal(who[0]!.subagent, false);
  });

  it("reports tapCoverage below 1 when Bash calls the binary by absolute path", () => {
    // 5 shell invocations (two by absolute path, which the shim does not see), 4 tap records.
    assert.equal(m.tapCoverage, 4 / 5);
    assert.ok(m.tapCoverage! < 1);
  });

  it("derives usage, estimated cost and latency percentiles", () => {
    assert.deepEqual(m.usage, { inputTokens: 2500, outputTokens: 130 });
    assert.equal(m.costSource, "estimated");
    assert.ok(Math.abs(m.costUsd! - (2500 * 1 + 130 * 10) / 1e6) < 1e-12);
    assert.equal(m.latencySource, "hooks");
    assert.equal(typeof m.llmP95Ms, "number");
    assert.equal(typeof m.ttftP50Ms, "number");
    assert.equal(m.targetLatencyP95Ms, 20);
    assert.equal(m.wallMs, 4000);
  });

  it("fails the trial on the first exceeded budget", () => {
    const b = computeMetrics({ task: task({ budget: { turns: 1, tokens: 10 } }), target: cliTarget(), tap, events, sessions: [session("s1")], run, checksPass: true });
    assert.equal(b.success, false);
    assert.equal(b.budgetExceeded, "turns");
    const t = computeMetrics({ task: task(), target: cliTarget(), tap, events, sessions: [session("s1")], run: { ...run, timedOut: true }, checksPass: true });
    assert.equal(t.budgetExceeded, "wallMs");
  });

  it("attributes calls inside a child session's tool span to that subagent", () => {
    const child: AgentEvent[] = [ev("session.start", 1000), ...bash(3000, "c1", "fake-cli greet", 100, { sessionId: "child" })];
    const r = computeMetrics({
      task: task(),
      target: cliTarget(),
      tap: [cli(3010, "ok", ["greet"])],
      events: child,
      sessions: [session("s1"), session("child", { parent: { sessionId: "s1", subagentId: "x" } })],
      run,
      checksPass: true,
    });
    assert.equal(r.subagentTargetCalls, 1);
    assert.equal(r.subagents, 1);
  });
});
