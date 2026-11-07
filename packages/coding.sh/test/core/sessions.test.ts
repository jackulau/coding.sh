import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentEvent, EventKind } from "../../src/schema/index.ts";
import {
  buildSession,
  detectFlags,
  FLAGS,
  isSyntheticPrompt,
  isVerifyCommand,
  latencyStats,
  percentile,
  rollupUsage,
  similarInputs,
} from "../../src/core/sessions.ts";

let t = 0;
const ev = (kind: EventKind, payload: Record<string, unknown> = {}, o: Partial<AgentEvent> = {}): AgentEvent => ({
  id: `e${++t}`, v: 0, sessionId: "s", ts: 1000 + t * 10, agent: "codex", kind, payload, ...o,
});
const bash = (command: string, ok: boolean, id = `tu${t + 1}`) => [
  ev("tool.start", { tool: "Bash", toolUseId: id, input: { command } }),
  ev("tool.end", { tool: "Bash", toolUseId: id, ok }),
];

describe("buildSession", () => {
  it("folds stats, usage, title, files, tests and end time", () => {
    const long = "Please   fix\nthe bug " + "x".repeat(400);
    const events = [
      ev("session.start", {}, { cwd: "/w", repo: { root: "/w", head: "h", snapshot: "start-snap" }, agentVersion: "1.0" }),
      ev("user.message", { text: long }),
      ev("assistant.message", { text: "ok" }, { model: "m1", usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.5 } }),
      ...bash("ls", true),
      ...bash("cat x", false),
      ev("file.change", { path: "a.ts", op: "modify" }),
      ev("file.change", { path: "a.ts", op: "modify" }),
      ev("file.change", { path: "b.ts", op: "add" }),
      ev("test.result", { passed: 3, failed: 1 }),
      ev("test.result", { passed: 4, failed: 0 }),
      ev("assistant.message", { text: "done" }, { model: "m2", usage: { inputTokens: 1, cacheReadTokens: 7 } }),
      ev("turn.end"),
      ev("session.end", {}, { repo: { root: "/w", head: "h", snapshot: "end-snap" } }),
    ];
    const s = buildSession([...events].reverse(), { id: "s", agent: "codex", startedAt: 0, stats: {} as never, flags: [], runId: undefined });
    assert.equal(s.id, "s");
    assert.equal(s.startedAt, events[0]!.ts, "events are sorted by ts");
    assert.equal(s.endedAt, events.at(-1)!.ts);
    assert.equal(s.title!.length, 280);
    assert.ok(s.title!.startsWith("Please fix the bug x"));
    assert.ok(s.title!.endsWith("…"));
    assert.equal(s.model, "m2");
    assert.equal(s.agentVersion, "1.0");
    assert.equal(s.cwd, "/w");
    assert.deepEqual(s.repo, { root: "/w", head: "h", snapshot: "start-snap" });
    assert.equal(s.endSnapshot, "end-snap");
    assert.deepEqual(s.stats, {
      events: events.length, turns: 1, toolCalls: 2, toolErrors: 1, filesChanged: 2, testsPassed: 4, testsFailed: 0,
      usage: { inputTokens: 11, outputTokens: 5, costUsd: 0.5, cacheReadTokens: 7 },
      latency: { wallMs: events.at(-1)!.ts - events[0]!.ts, toolMs: 20, toolP95Ms: 10 },
    });
    assert.deepEqual(s.flags, []);
  });

  it("counts turns from prompts when there is no turn.end, and keeps prev-only fields", () => {
    const s = buildSession([ev("user.message", { text: "a" }), ev("user.message", { text: "b" })], {
      id: "s", agent: "codex", startedAt: 0, stats: { events: 0, turns: 0, toolCalls: 0, toolErrors: 0, filesChanged: 0 }, flags: [], endSnapshot: "kept", parent: { sessionId: "p" },
    });
    assert.equal(s.stats.turns, 2);
    assert.equal(s.endSnapshot, "kept");
    assert.deepEqual(s.parent, { sessionId: "p" });
    assert.equal(s.endedAt, undefined);
    assert.throws(() => buildSession([]), /at least one event/);
  });

  it("takes the parent link from session.start", () => {
    const s = buildSession([ev("session.start", { parentSessionId: "p1", parentEventId: "e9", subagentId: "a1", subagentType: "explore" })]);
    assert.deepEqual(s.parent, { sessionId: "p1", eventId: "e9", subagentId: "a1", type: "explore" });
  });
});

describe("latencyStats", () => {
  it("aggregates llm calls, ttft, tool durations (derived when absent) and subagents", () => {
    const events = [
      ev("llm.call", { ok: true, ttftMs: 100 }, { ts: 0, durationMs: 1000 }),
      ev("llm.call", { ok: true, ttftMs: 300 }, { ts: 2000, durationMs: 3000 }),
      ev("llm.call", { ok: false }, { ts: 6000 }),
      ev("tool.start", { tool: "Bash", toolUseId: "a" }, { ts: 7000 }),
      ev("tool.end", { tool: "Bash", toolUseId: "a", ok: true }, { ts: 7500 }),
      ev("tool.end", { tool: "Read", toolUseId: "b", ok: true, durationMs: 40 }, { ts: 8000 }),
      ev("tool.end", { tool: "Read", toolUseId: "c", ok: true }, { ts: 8100, durationMs: 60 }),
      ev("subagent.start", { subagentId: "x" }, { ts: 9000 }),
      ev("subagent.start", { subagentId: "x" }, { ts: 9001 }),
      ev("subagent.start", {}, { ts: 9002, subagentId: "y" }),
    ];
    assert.deepEqual(latencyStats(events), {
      wallMs: 9002, llmCalls: 3, llmMs: 4000, llmP50Ms: 1000, llmP95Ms: 3000, ttftP50Ms: 100,
      toolMs: 600, toolP95Ms: 500, subagents: 2,
    });
    assert.deepEqual(latencyStats([]), {});
  });

  it("percentile uses nearest rank", () => {
    assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
    assert.equal(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 95), 95);
    assert.equal(percentile([], 50), undefined);
  });
});

describe("failure detectors", () => {
  it("premature-completion: ends while failing, cleared by a later green run", () => {
    const failingEnd = [ev("test.result", { passed: 1, failed: 2 }), ev("turn.end")];
    assert.ok(detectFlags(failingEnd).includes(FLAGS.prematureCompletion));
    assert.ok(detectFlags([ev("test.result", { passed: 1, failed: 2 }), ev("session.end")]).includes(FLAGS.prematureCompletion));
    assert.ok(!detectFlags([...failingEnd, ev("user.message", { text: "fix" }), ev("test.result", { passed: 3, failed: 0 }), ev("turn.end")]).includes(FLAGS.prematureCompletion));
    assert.ok(!detectFlags([ev("test.result", { passed: 1, failed: 2 }), ev("test.result", { passed: 3, failed: 0 }), ev("turn.end")]).includes(FLAGS.prematureCompletion));
    assert.ok(!detectFlags([ev("test.result", { passed: 1, failed: 2 })]).includes(FLAGS.prematureCompletion), "still working");
  });

  it("repeated-tool-failure: 3 similar consecutive failures of one tool", () => {
    const stuck = [...bash("npm test -- --grep parser", false), ...bash("npm test -- --grep  parser", false), ev("tool.end", { tool: "Read", ok: true }), ...bash("npm test -- --grep parser", false)];
    assert.ok(detectFlags(stuck).includes(FLAGS.repeatedToolFailure), "other tools in between don't break the streak");
    const recovered = [...bash("npm test", false), ...bash("npm test", false), ...bash("npm test", true), ...bash("npm test", false)];
    assert.ok(!detectFlags(recovered).includes(FLAGS.repeatedToolFailure));
    const varied = [...bash("npm test", false), ...bash("cargo build --release", false), ...bash("ls -la /tmp/x", false)];
    assert.ok(!detectFlags(varied).includes(FLAGS.repeatedToolFailure));
    const noInput = [1, 2, 3].map(() => ev("tool.end", { tool: "Edit", ok: false }));
    assert.ok(detectFlags(noInput).includes(FLAGS.repeatedToolFailure));
    assert.ok(similarInputs("a b c d e", "a b c d f"));
    assert.ok(!similarInputs("a b", "c d"));
  });

  it("no-verification: files changed but nothing checked", () => {
    const changed = ev("file.change", { path: "a.ts" });
    assert.ok(detectFlags([changed]).includes(FLAGS.noVerification));
    assert.ok(!detectFlags([changed, ...bash("pnpm test", true)]).includes(FLAGS.noVerification));
    assert.ok(!detectFlags([changed, ev("test.result", { passed: 1, failed: 0 })]).includes(FLAGS.noVerification));
    assert.ok(!detectFlags([changed, ev("tool.start", { tool: "Bash", verify: true })]).includes(FLAGS.noVerification), "metadata-mode marker");
    assert.ok(detectFlags([changed, ...bash("git status", true)]).includes(FLAGS.noVerification));
    assert.ok(!detectFlags([...bash("ls", true)]).includes(FLAGS.noVerification), "no changes, no flag");
    for (const cmd of ["npm test", "npm run typecheck", "pytest -x tests/", "go test ./...", "cargo test", "npx tsc --noEmit", "node --test test/", "python -m pytest", "make check", "bun test", "vitest run"]) {
      assert.ok(isVerifyCommand(cmd), cmd);
    }
    for (const cmd of ["git diff", "cat test.txt", "ls tests", "echo testing"]) assert.ok(!isVerifyCommand(cmd), cmd);
  });

  it("compaction", () => {
    assert.deepEqual(detectFlags([ev("context.compact", { trigger: "auto" })]), [FLAGS.compaction]);
  });
});

describe("OTel session ends and traceIds", () => {
  const ev = (id: string, sessionId: string, traceId: string, kind: EventKind, ts: number, durationMs?: number): AgentEvent => ({
    id,
    v: 0,
    sessionId,
    ts,
    agent: "x",
    kind,
    traceId,
    source: "otel-span",
    payload: {},
    ...(durationMs !== undefined ? { durationMs } : {}),
  });
  it("conversation-keyed sessions end at the last activity and collect their traces", () => {
    const s = buildSession([ev("a", "conv-1", "t1", "llm.call", 1000, 500), ev("b", "conv-1", "t2", "llm.call", 5000, 250)]);
    assert.equal(s.endedAt, 5250);
    assert.deepEqual(s.traceIds, ["t1", "t2"]);
  });
  it("trace-keyed sessions stay open until the root span's session.end", () => {
    assert.equal(buildSession([ev("a", "t1", "t1", "llm.call", 1000, 500)]).endedAt, undefined);
    assert.equal(buildSession([ev("a", "t1", "t1", "llm.call", 1000, 500), ev("b", "t1", "t1", "session.end", 2000)]).endedAt, 2000);
  });
  it("hook sessions never infer an end", () => {
    const s = buildSession([{ ...ev("a", "conv-1", "t1", "llm.call", 1000, 500), source: "hook" }]);
    assert.equal(s.endedAt, undefined);
  });
});

describe("session duration (QA regressions)", () => {
  const otel = (o: Partial<AgentEvent> & Pick<AgentEvent, "id" | "kind" | "ts">, sessionId = "qa-dup-1"): AgentEvent => ({
    v: 0, sessionId, agent: "x", traceId: "t1", source: "otel-span", payload: {}, ...o,
  });

  it("does not count a span's length twice: *.end events are stamped at the end", () => {
    // One 1.5 s chat span keyed by gen_ai.conversation.id: llm.call at the start, turn.end at the end.
    const s = buildSession([
      otel({ id: "a", kind: "session.start", ts: 10_000 }),
      otel({ id: "b", kind: "llm.call", ts: 10_000, durationMs: 1500 }),
      otel({ id: "c", kind: "turn.end", ts: 11_500, durationMs: 1500 }),
    ]);
    assert.equal(s.endedAt! - s.startedAt, 1500);
    assert.equal(s.stats.latency?.wallMs, 1500);
    // Trace-keyed: root span's session.end carries the end time and the span length.
    const t = buildSession([
      otel({ id: "a", kind: "session.start", ts: 0 }, "t1"),
      otel({ id: "b", kind: "turn.end", ts: 5000, durationMs: 5000 }, "t1"),
      otel({ id: "c", kind: "session.end", ts: 5000, durationMs: 5000 }, "t1"),
    ]);
    assert.equal(t.endedAt, 5000);
    assert.equal(t.stats.latency?.wallMs, 5000);
    // A hook tool.end with a filled-in duration is stamped at the end too.
    assert.equal(latencyStats([ev("tool.start", {}, { ts: 0 }), ev("tool.end", {}, { ts: 800, durationMs: 800 })]).wallMs, 800);
    // A span stamped at its start still extends the session past later-starting events.
    assert.equal(latencyStats([ev("llm.call", {}, { ts: 0, durationMs: 3000 }), ev("notification", {}, { ts: 1000 })]).wallMs, 3000);
  });

  it("log-keyed OTel sessions (no traceId) end at their last activity", () => {
    const log = (id: string, ts: number): AgentEvent => ({ id, v: 0, sessionId: "qa-cc-1", agent: "claude-code", kind: "llm.call", ts, source: "otel-log", payload: {} });
    const s = buildSession([log("a", 1000), log("b", 6000)]);
    assert.equal(s.endedAt, 6000);
    assert.equal(s.endedAt! - s.startedAt, 5000);
  });

  it("SDK sessions (source sdk, no session.end) end at their last activity, also mixed with OTel spans", () => {
    const sdk = (id: string, kind: EventKind, ts: number, o: Partial<AgentEvent> = {}): AgentEvent => ({ id, v: 0, sessionId: "demo/chat-1", agent: "my-api", kind, ts, source: "sdk", payload: {}, ...o });
    const s = buildSession([sdk("a", "user.message", 1000), sdk("b", "llm.call", 2000, { durationMs: 1500 })]);
    assert.equal(s.endedAt, 3500, "ends when the last call finished, not running forever");
    // aiSdkTracer() spans for the same conversation arrive over OTLP next to native events.
    const mixed = buildSession([sdk("a", "user.message", 1000), { ...sdk("c", "llm.call", 4000, { durationMs: 1000 }), source: "otel-span", traceId: "t9" }]);
    assert.equal(mixed.endedAt, 5000);
    // An explicit session.end still wins; a client-set non-sdk source keeps waiting for one.
    assert.equal(buildSession([sdk("a", "llm.call", 1000, { durationMs: 9000 }), sdk("e", "session.end", 2000)]).endedAt, 2000);
    assert.equal(buildSession([sdk("a", "llm.call", 1000, { source: "hook" })]).endedAt, undefined);
  });

  it("transcript-only (backfilled) sessions end at their last event; live ones wait for session.end", () => {
    const tr = (kind: EventKind, ts: number, o: Partial<AgentEvent> = {}) => ev(kind, {}, { ts, source: "transcript", ...o });
    const s = buildSession([tr("session.start", 1000), tr("user.message", 1000), tr("turn.end", 375_021, { durationMs: 374_021 })]);
    assert.equal(s.endedAt, 375_021);
    assert.equal(s.endedAt! - s.startedAt, s.stats.latency?.wallMs);
    const live = buildSession([tr("session.start", 1000), ev("turn.end", {}, { ts: 2000, source: "hook" })]);
    assert.equal(live.endedAt, undefined, "a hook-captured session may still be running");
  });
});

describe("harness-injected prompts (QA regression)", () => {
  const um = (text: string) => ev("user.message", { text });
  const clear = "<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>";
  const note = "<task-notification> <task-id>bigcaph7k</task-id> <status>completed</status></task-notification>";

  it("titles come from the first real prompt, not command echoes or task notifications", () => {
    const s = buildSession([um(clear), um("<local-command-stdout></local-command-stdout>"), um(note), um("Fix the parser"), um(note), um("and add tests")]);
    assert.equal(s.title, "Fix the parser");
    assert.equal(s.stats.turns, 3, "the slash command and the two real prompts; not the notices or the command output");
  });

  it("a session with only slash commands is titled by the command", () => {
    const s = buildSession([um("<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>"), um(note)]);
    assert.equal(s.title, "/model opus");
  });

  it("isSyntheticPrompt", () => {
    for (const t of [clear, note, "<local-command-caveat>Caveat: …</local-command-caveat>", "  <system-reminder>x</system-reminder>"]) assert.ok(isSyntheticPrompt(t), t);
    for (const t of ["Fix <command-name> parsing", "hello", "<div>html question</div>"]) assert.ok(!isSyntheticPrompt(t), t);
  });
});

describe("session usage rollup", () => {
  const llm = (spanId: string, parentSpanId: string | undefined, usage: AgentEvent["usage"], payload: Record<string, unknown> = {}, o: Partial<AgentEvent> = {}) =>
    ev("llm.call", payload, { traceId: "t1", spanId, ...(parentSpanId ? { parentSpanId } : {}), usage, ...o });
  const span = (spanId: string, parentSpanId?: string) => ev("span", { name: "agent" }, { traceId: "t1", spanId, ...(parentSpanId ? { parentSpanId } : {}) });

  it("counts a wrapper span and the provider span inside it once", () => {
    const evs = [llm("a", undefined, { inputTokens: 100, outputTokens: 20, costUsd: 0.01 }), span("mid", "a"), llm("b", "mid", { inputTokens: 100, outputTokens: 20, costUsd: 0.01 })];
    const r = rollupUsage(evs);
    assert.deepEqual(r.usage, { inputTokens: 100, outputTokens: 20, costUsd: 0.01 });
    assert.deepEqual(r.duplicate, { calls: 1, tokens: 120, costUsd: 0.01 });
    assert.deepEqual(buildSession(evs).stats.duplicateUsage, r.duplicate);
  });

  it("sibling calls both count", () => {
    const r = rollupUsage([span("root"), llm("a", "root", { inputTokens: 10 }), llm("b", "root", { inputTokens: 5 })]);
    assert.deepEqual(r, { usage: { inputTokens: 15 } });
  });

  it("a wrapper with no cost (or only an estimate) takes the nested calls' reported cost", () => {
    const r = rollupUsage([llm("a", undefined, { inputTokens: 100, outputTokens: 20 }), llm("b", "a", { inputTokens: 100, outputTokens: 20, costUsd: 0.01 })]);
    assert.deepEqual(r.usage, { inputTokens: 100, outputTokens: 20, costUsd: 0.01 });
    assert.deepEqual(r.duplicate, { calls: 1, tokens: 120 });
    const est = rollupUsage([llm("a", undefined, { inputTokens: 100, costUsd: 0.5 }, { costEstimated: true }), llm("b", "a", { inputTokens: 100, costUsd: 0.01 })]);
    assert.equal(est.usage.costUsd, 0.01);
    assert.equal(est.usage.estimatedCostUsd, undefined);
  });

  it("fills fields the wrapper lacks from its nested calls", () => {
    const r = rollupUsage([llm("a", undefined, { inputTokens: 100 }), llm("b", "a", { inputTokens: 90, cacheReadTokens: 10 }), llm("c", "a", { cacheReadTokens: 5 })]);
    assert.deepEqual(r.usage, { inputTokens: 100, cacheReadTokens: 15 });
    assert.equal(r.duplicate?.calls, 2);
  });

  it("a repeated response id counts once", () => {
    const r = rollupUsage([ev("llm.call", { responseId: "resp_1" }, { usage: { outputTokens: 7 } }), ev("llm.call", { responseId: "resp_1" }, { usage: { outputTokens: 7 } }), ev("llm.call", { responseId: "resp_2" }, { usage: { outputTokens: 3 } })]);
    assert.deepEqual(r, { usage: { outputTokens: 10 }, duplicate: { calls: 1, tokens: 7 } });
  });

  it("calls without trace ids sum as before, and a child seen before its parent folds on rebuild", () => {
    assert.deepEqual(rollupUsage([ev("llm.call", {}, { usage: { inputTokens: 1 } }), ev("llm.call", {}, { usage: { inputTokens: 2 } })]), { usage: { inputTokens: 3 } });
    const child = llm("b", "a", { inputTokens: 100, costUsd: 0.01 });
    assert.equal(buildSession([child]).stats.usage?.inputTokens, 100);
    assert.equal(buildSession([child, llm("a", undefined, { inputTokens: 100, costUsd: 0.01 })]).stats.usage?.inputTokens, 100);
  });

  it("keeps a parent walk bounded on a span cycle", () => {
    const r = rollupUsage([span("x", "y"), span("y", "x"), llm("a", "x", { inputTokens: 1 })]);
    assert.deepEqual(r, { usage: { inputTokens: 1 } });
  });

  it("says which part of the cost is estimated, and never counts a gateway-billed call as estimated", () => {
    const reported = ev("llm.call", {}, { usage: { inputTokens: 10, costUsd: 1 } });
    const estimated = ev("llm.call", { costEstimated: true }, { usage: { inputTokens: 10, costUsd: 0.25 } });
    assert.deepEqual(rollupUsage([reported, estimated]).usage, { inputTokens: 20, costUsd: 1.25, estimatedCostUsd: 0.25 });
    assert.equal(rollupUsage([reported]).usage.estimatedCostUsd, undefined);
    // Gateway enrich: the companion holds billed minus the estimate, so the sum is the bill.
    const gw = ev("span", {}, { source: "gateway", parentId: estimated.id, usage: { costUsd: 0.75 } });
    assert.deepEqual(rollupUsage([estimated, gw]).usage, { inputTokens: 10, costUsd: 1 });
    const snap = ev("notification", { type: "usage-summary", costEstimated: true }, { usage: { outputTokens: 5, costUsd: 0.5 } });
    assert.deepEqual(rollupUsage([snap]).usage, { outputTokens: 5, costUsd: 0.5, estimatedCostUsd: 0.5 });
  });

  it("a gateway companion of a call that was not counted is dropped with it", () => {
    const outer = llm("a", undefined, { inputTokens: 100, costUsd: 0.01 });
    const inner = llm("b", "a", { inputTokens: 100, costUsd: 0.01 });
    const gw = ev("span", {}, { source: "gateway", parentId: inner.id, usage: { costUsd: 0.02 } });
    const r = rollupUsage([outer, inner, gw]);
    assert.equal(r.usage.costUsd, 0.01);
    assert.deepEqual(r.duplicate, { calls: 1, tokens: 100, costUsd: 0.03 });
  });
});
