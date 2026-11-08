// Mid-session model switches (core/models.ts): stats.models, stats.modelSwitch,
// the model:switch tag and the refusal flag, and the session's model as the
// main thread's most used one rather than the last one seen.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClaudeTranscriptConverter } from "../../src/adapters/_shared/claude-transcript.ts";
import { modelsRow } from "../../src/cli/commands/show.ts";
import { sessionMarkdown } from "../../src/mcp/digest.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { buildSession, failureFlags, FLAGS, foldSession, sessionOf, sessionState } from "../../src/core/sessions.ts";
import type { AgentEvent, EventKind } from "../../src/schema/index.ts";
import { assertWellFormed, testCtx } from "../adapters/_helpers.ts";

const T0 = Date.UTC(2026, 10, 7, 9);
let n = 0;
let clock = T0;
const reset = () => {
  n = 0;
  clock = T0;
};
const ev = (kind: EventKind, payload: Record<string, unknown> = {}, o: Partial<AgentEvent> = {}): AgentEvent => {
  clock += 1000;
  return { id: `e${++n}`, v: 0, sessionId: "s", ts: clock, agent: "claude-code", kind, payload, ...o };
};
const call = (model: string, payload: Record<string, unknown> = {}, o: Partial<AgentEvent> = {}) =>
  ev("llm.call", { ok: true, responseModel: model, ...payload }, { model, usage: { inputTokens: 100, outputTokens: 20 }, ...o });
const times = (k: number, f: () => AgentEvent): AgentEvent[] => Array.from({ length: k }, f);

const SONNET_55 = "claude-sonnet-5-5";
const SONNET_5 = "claude-sonnet-5";
const HAIKU = "claude-haiku-4-5";

// A Claude Code transcript: the main thread on claude-sonnet-5-5 until a call
// stops on a refusal, then every later call on claude-sonnet-5 (2.1.310's
// silent fallback). Each call's message.model names the model that served it.
const TS = (s: number) => new Date(T0 + s * 1000).toISOString();
const base = { sessionId: "cc-fallback", cwd: "/work/demo", version: "2.1.310", isSidechain: false };
const prompt = (uuid: string, s: number, text: string) => ({ ...base, type: "user", uuid, timestamp: TS(s), message: { role: "user", content: text } });
const result = (uuid: string, s: number, id: string) => ({ ...base, type: "user", uuid, timestamp: TS(s), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
const reply = (uuid: string, s: number, id: string, model: string, stop: string, content: unknown[]) => ({
  ...base,
  type: "assistant",
  uuid,
  timestamp: TS(s),
  message: { id, role: "assistant", model, stop_reason: stop, content, usage: { input_tokens: 900, output_tokens: 40 } },
});
const read = (id: string) => ({ type: "tool_use", id, name: "Read", input: { file_path: "/work/demo/app.ts" } });
const text = (t: string) => ({ type: "text", text: t });

async function convert(lines: Record<string, unknown>[]): Promise<AgentEvent[]> {
  const { ctx } = testCtx();
  const conv = new ClaudeTranscriptConverter(ctx, { agent: "claude-code", mode: "full", sessionId: "cc-fallback", source: "cc-fallback.jsonl" });
  for (const [i, l] of lines.entries()) await conv.add(l, i + 1);
  const events = await conv.finish(true);
  assertWellFormed(events);
  return events;
}

describe("a refusal, then a silent fallback to another model (Claude Code transcript)", () => {
  const lines = [
    prompt("u1", 0, "fix the parser"),
    reply("a1", 2, "msg_1", SONNET_55, "tool_use", [read("t1")]),
    result("u2", 3, "t1"),
    reply("a2", 5, "msg_2", SONNET_55, "tool_use", [read("t2")]),
    result("u3", 6, "t2"),
    reply("a3", 8, "msg_3", SONNET_55, "refusal", [text("I can't help with that.")]),
    reply("a4", 12, "msg_4", SONNET_5, "end_turn", [text("Fixed the parser.")]),
    prompt("u4", 30, "add a test"),
    reply("a5", 33, "msg_5", SONNET_5, "end_turn", [text("Added one.")]),
  ];

  it("records the switch, its trigger and the calls per model; tags model:switch and flags refusal", async () => {
    const events = await convert(lines);
    const calls = events.filter((e) => e.kind === "llm.call");
    assert.deepEqual(
      calls.map((e) => [e.payload.responseModel, e.payload.stopReason]),
      [
        [SONNET_55, "tool_use"],
        [SONNET_55, "tool_use"],
        [SONNET_55, "refusal"],
        [SONNET_5, "end_turn"],
        [SONNET_5, "end_turn"],
      ],
    );
    const s = buildSession(events);
    assert.deepEqual(s.stats.models, { [SONNET_55]: 3, [SONNET_5]: 2 });
    // Both Sonnets have the same list prices: the two calls on the fallback cost nothing extra.
    assert.deepEqual(s.stats.modelSwitch, { from: SONNET_55, to: SONNET_5, at: calls[3]!.ts, trigger: "refusal", switchedCalls: 2, extraUsd: 0 });
    assert.ok(s.flags.includes(FLAGS.modelSwitch) && s.flags.includes(FLAGS.refusal), s.flags.join(","));
    assert.deepEqual(failureFlags(s.flags).filter((f) => f === "refusal" || f.startsWith("model")), ["refusal"], "model:switch is a tag, refusal a failure");
    // Most calls ran on the configured model: the session is labeled with it, not the fallback seen last.
    assert.equal(s.model, SONNET_55);
  });

  it("`show` and the MCP digest name the models and the switch", async () => {
    const events = await convert(lines);
    const s = buildSession(events);
    const row = modelsRow(s);
    assert.equal(row?.[0], "Models");
    assert.match(row![1], /^claude-sonnet-5-5 3, claude-sonnet-5 2; switched from claude-sonnet-5-5 to claude-sonnet-5 at \+\S+ after a refusal; 2 calls on the other model, at the same list prices as claude-sonnet-5-5$/);
    const index = new MemoryIndexStore();
    await index.putEvents(events);
    await index.upsertSession(s);
    assert.match(await sessionMarkdown(index, s), /- \*\*Models:\*\* claude-sonnet-5-5 3, claude-sonnet-5 2; switched from claude-sonnet-5-5 to claude-sonnet-5 at \+\S+ \(refusal\); 2 calls on the other model, \$0\.0000 over claude-sonnet-5-5's prices/);
    reset();
    assert.equal(modelsRow(buildSession(times(2, () => call(SONNET_55)))), undefined);
  });

  it("a fallback that ran most of the calls labels the session, and the switch still names the first model", async () => {
    const more = [prompt("u5", 60, "and another"), reply("a6", 62, "msg_6", SONNET_5, "end_turn", [text("Done.")]), prompt("u6", 90, "one more"), reply("a7", 92, "msg_7", SONNET_5, "end_turn", [text("Done.")])];
    const s = buildSession(await convert([...lines, ...more]));
    assert.equal(s.model, SONNET_5);
    assert.equal(s.stats.modelSwitch?.from, SONNET_55);
  });

  it("an incremental fold gives the same row as a full build", async () => {
    const events = await convert(lines);
    const sorted = [...events].sort((a, b) => a.ts - b.ts);
    const st = sessionState();
    for (const e of sorted.slice(0, 6)) foldSession(st, e);
    const copy = structuredClone(st);
    for (const e of sorted.slice(6)) foldSession(copy, e);
    assert.deepEqual(sessionOf(copy), buildSession(events));
  });
});

describe("helper models and subagents are not a switch", () => {
  it("Haiku side calls beside the main model (a title first, checks in between, one at the end)", () => {
    reset();
    const events = [
      ev("user.message", { text: "fix it" }),
      call(HAIKU),
      ...times(3, () => call(SONNET_55)),
      call(HAIKU),
      call(HAIKU),
      ...times(3, () => call(SONNET_55)),
      call(HAIKU),
    ];
    const s = buildSession(events);
    assert.equal(s.stats.modelSwitch, undefined);
    assert.ok(!s.flags.includes(FLAGS.modelSwitch));
    assert.deepEqual(s.stats.models, { [SONNET_55]: 6, [HAIKU]: 4 });
    assert.equal(s.model, SONNET_55, "the last call was Haiku's, the session ran on Sonnet");
  });

  it("one helper call before the main model and one after it", () => {
    reset();
    const s = buildSession([call(HAIKU), ...times(4, () => call(SONNET_55)), call(HAIKU)]);
    assert.equal(s.stats.modelSwitch, undefined);
    reset();
    const t = buildSession([call(HAIKU), ...times(4, () => call(SONNET_55))]);
    assert.equal(t.stats.modelSwitch, undefined);
  });

  it("a subagent's calls on another model, after the main thread's last call", () => {
    reset();
    const s = buildSession([...times(3, () => call(SONNET_55)), ...times(4, () => call(HAIKU, {}, { subagentId: "agent-1" }))]);
    assert.equal(s.stats.modelSwitch, undefined);
    assert.deepEqual(s.stats.models, { [HAIKU]: 4, [SONNET_55]: 3 });
    assert.equal(s.model, SONNET_55);
  });

  it("one model: no models, no switch, no flags", () => {
    reset();
    const s = buildSession(times(5, () => call(SONNET_55)));
    assert.equal(s.stats.models, undefined);
    assert.equal(s.stats.modelSwitch, undefined);
    assert.deepEqual(s.flags, []);
  });
});

describe("calls logged by coding.sh proxy", () => {
  const proxied = (model: string, payload: Record<string, unknown> = {}) => call(model, payload, { source: "proxy" });

  it("count only in a session with no other model calls", () => {
    reset();
    // The transcript's calls, and the proxy's copies of them plus two trailing Haiku calls the transcript never sees.
    const both = buildSession([...times(3, () => call(SONNET_55)), ...times(3, () => proxied(SONNET_55)), proxied(HAIKU), proxied(HAIKU)]);
    assert.deepEqual([both.model, both.stats.models, both.stats.modelSwitch], [SONNET_55, undefined, undefined]);
    reset();
    const only = buildSession([...times(2, () => proxied(SONNET_55)), proxied(SONNET_55, { stopReason: "refusal" }), proxied(SONNET_5), proxied(SONNET_5)]);
    assert.deepEqual(only.stats.modelSwitch, { from: SONNET_55, to: SONNET_5, at: T0 + 4000, trigger: "refusal", switchedCalls: 2, extraUsd: 0 });
    assert.deepEqual(only.stats.models, { [SONNET_55]: 3, [SONNET_5]: 2 });
  });
});

describe("switches and their triggers", () => {
  it("a hand-over with nothing before it: two calls or more on each side, no trigger", () => {
    reset();
    const events = [...times(3, () => call(SONNET_55)), ...times(2, () => call(SONNET_5))];
    const s = buildSession(events);
    assert.deepEqual(s.stats.modelSwitch, { from: SONNET_55, to: SONNET_5, at: events[3]!.ts, switchedCalls: 2, extraUsd: 0 });
    assert.ok(!s.flags.includes(FLAGS.refusal));
  });

  it("a failed call (an overload) before a fallback: trigger error, even with one call on each side", () => {
    reset();
    const events = [call(SONNET_55, { ok: false, statusCode: 529, error: "overloaded" }), call(SONNET_5)];
    assert.equal(buildSession(events).stats.modelSwitch?.trigger, "error");
  });

  it("a /model command between: trigger command", () => {
    reset();
    const events = [call(SONNET_55), ev("notification", { kind: "command", command: "/model", args: "sonnet-5" }), call(SONNET_5)];
    assert.deepEqual(buildSession(events).stats.modelSwitch, { from: SONNET_55, to: SONNET_5, at: events[2]!.ts, trigger: "command", switchedCalls: 1, extraUsd: 0 });
  });

  it("a refusal with no switch is still flagged; a content filter stop counts as one", () => {
    reset();
    const s = buildSession([call(SONNET_55), call(SONNET_55, { stopReason: "refusal" })]);
    assert.deepEqual([s.flags.includes(FLAGS.refusal), s.stats.modelSwitch], [true, undefined]);
    reset();
    assert.ok(buildSession([call("gpt-5", { stopReason: "content_filter" })]).flags.includes(FLAGS.refusal));
  });
});

describe("recorded fallbacks, switches and back, and subagents", () => {
  const OPUS_55 = "claude-opus-5-5";
  const OPUS_48 = "claude-opus-4-8";
  // A Claude Code `system/model_refusal_fallback` entry. No capture has one (the stub cannot get
  // 2.1.319 to route a refusal to another model), so its shape is the one 2.1.319 writes:
  // type, subtype, content, level, trigger, direction, scope, originalModel, fallbackModel,
  // requestId, apiRefusalCategory, apiRefusalExplanation, retractedMessageUuids, refusedUserMessageUuid.
  const refusalFallback = (uuid: string, s: number, scope?: string) => ({
    ...base,
    type: "system",
    subtype: "model_refusal_fallback",
    uuid,
    timestamp: TS(s),
    content: "Opus 5.5 declined; Opus 4.8 answered",
    level: "warning",
    trigger: "refusal",
    direction: "retry",
    ...(scope ? { scope } : {}),
    originalModel: OPUS_55,
    fallbackModel: OPUS_48,
    requestId: "req_1",
    apiRefusalCategory: null,
    apiRefusalExplanation: null,
    retractedMessageUuids: ["a3"],
    refusedUserMessageUuid: "u3",
    isMeta: false,
  });

  it("a refusal fallback whose notice comes at the end of the turn, then back: one switch, priced", async () => {
    const lines = [
      prompt("u1", 0, "fix the parser"),
      reply("a1", 2, "msg_1", OPUS_55, "tool_use", [read("t1")]),
      result("u2", 3, "t1"),
      reply("a2", 5, "msg_2", OPUS_55, "end_turn", [text("Read it.")]),
      prompt("u3", 30, "now the lexer"),
      reply("a3", 32, "msg_3", OPUS_55, "refusal", [text("I can't.")]),
      reply("a4", 34, "msg_4", OPUS_48, "end_turn", [text("Done.")]),
      refusalFallback("f1", 35),
      prompt("u4", 60, "and a test"),
      reply("a5", 62, "msg_5", OPUS_55, "tool_use", [read("t2")]),
      result("u5", 63, "t2"),
      reply("a6", 65, "msg_6", OPUS_55, "end_turn", [text("Added.")]),
    ];
    const events = await convert(lines);
    const notes = events.filter((e) => e.kind === "notification" && e.payload.kind === "model.fallback");
    assert.deepEqual(
      notes.map((e) => e.payload),
      [{ kind: "model.fallback", trigger: "refusal", from: OPUS_55, to: OPUS_48, direction: "retry", text: "Opus 5.5 declined; Opus 4.8 answered" }],
    );
    const s = buildSession(events);
    const at = events.find((e) => e.kind === "llm.call" && e.payload.responseModel === OPUS_48)!.ts;
    // One call on claude-opus-4-8: 900 input and 40 output tokens at $5/$25 per M instead of $4/$20.
    assert.deepEqual(s.stats.modelSwitch, { from: OPUS_55, to: OPUS_48, at, trigger: "fallback", reason: "refusal", switchedCalls: 1, extraUsd: (900 * 1 + 40 * 5) / 1e6 });
    assert.ok(s.flags.includes(FLAGS.modelSwitch) && s.flags.includes(FLAGS.modelFallback) && s.flags.includes(FLAGS.refusal), s.flags.join(","));
    assert.equal(s.model, OPUS_55);
    // Folded one event at a time, with the state copied between (live ingest), the row is the same.
    const sorted = [...events].sort((a, b) => a.ts - b.ts);
    let st = sessionState();
    for (const e of sorted) {
      foldSession(st, e);
      st = structuredClone(st);
    }
    assert.deepEqual(sessionOf(st), s);
  });

  it("a fallback recorded before the change, in the main thread, with no refusal: a switch and back", () => {
    reset();
    const events = [
      ...times(2, () => call(OPUS_55)),
      ev("notification", { kind: "model.fallback", trigger: "overloaded", from: OPUS_55, to: OPUS_48 }),
      ...times(2, () => call(OPUS_48)),
      ...times(2, () => call(OPUS_55)),
    ];
    const s = buildSession(events);
    assert.equal(s.stats.modelSwitch?.trigger, "fallback");
    assert.equal(s.stats.modelSwitch?.reason, "overloaded");
    assert.equal(s.stats.modelSwitch?.switchedCalls, 2);
    assert.equal(s.stats.modelSwitch?.count, undefined, "the return is not a second switch");
    // The same calls with no record: a helper-like detour on the main thread, not a switch.
    reset();
    const bare = buildSession([...times(2, () => call(OPUS_55)), ...times(2, () => call(OPUS_48)), ...times(2, () => call(OPUS_55))]);
    assert.deepEqual([bare.stats.modelSwitch, bare.flags], [undefined, []]);
  });

  it("a fallback record with no model change tags model:fallback only", () => {
    reset();
    const s = buildSession([call(OPUS_55), ev("notification", { kind: "model.fallback", trigger: "overloaded", from: OPUS_55, to: OPUS_48 }), call(OPUS_55)]);
    assert.deepEqual([s.stats.modelSwitch, s.flags], [undefined, [FLAGS.modelFallback]]);
  });

  it("a subagent that changes model with no record is a switch; each move off its model counts", () => {
    reset();
    const sub = { subagentId: "agent-1" };
    const once = buildSession([...times(3, () => call(OPUS_55, {}, sub)), ...times(2, () => call(OPUS_48, {}, sub)), call(OPUS_55, {}, sub)]);
    assert.equal(once.stats.modelSwitch?.subagent, true);
    assert.deepEqual([once.stats.modelSwitch?.from, once.stats.modelSwitch?.to, once.stats.modelSwitch?.switchedCalls, once.stats.modelSwitch?.count], [OPUS_55, OPUS_48, 2, undefined]);
    assert.ok(once.flags.includes(FLAGS.modelSwitch) && !once.flags.includes(FLAGS.modelFallback));
    // A subagent's own session (every call has its subagentId): labeled with the model most calls ran on.
    assert.equal(once.model, OPUS_55);
    reset();
    const twice = buildSession([call(OPUS_55, {}, sub), call(OPUS_48, {}, sub), call(OPUS_55, {}, sub), call(OPUS_48, {}, sub)]);
    assert.deepEqual([twice.stats.modelSwitch?.count, twice.stats.modelSwitch?.switchedCalls], [2, 2]);
    // A subagent on its own model throughout is still no switch (the main thread's model is not its reference).
    reset();
    const steady = buildSession([...times(3, () => call(SONNET_55)), ...times(3, () => call(HAIKU, {}, sub))]);
    assert.equal(steady.stats.modelSwitch, undefined);
  });

  it("a model with no price leaves extraUsd out, and switchedCalls in", () => {
    reset();
    const s = buildSession([...times(2, () => call(OPUS_55)), ev("notification", { kind: "model.fallback", trigger: "overloaded", to: "acme-large" }), call("acme-large")]);
    assert.deepEqual([s.stats.modelSwitch?.switchedCalls, s.stats.modelSwitch?.extraUsd, "extraUsd" in s.stats.modelSwitch!], [1, undefined, false]);
  });
});
