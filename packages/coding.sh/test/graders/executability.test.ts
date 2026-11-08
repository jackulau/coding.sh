import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { executabilityGrader } from "../../src/graders/builtin.ts";
import { createGrader } from "../../src/graders/index.ts";
import type { AgentEvent, EventKind } from "../../src/schema/index.ts";

let n = 0;
const ev = (kind: EventKind, payload: Record<string, unknown>): AgentEvent => {
  n++;
  return { id: `e${n}`, v: 0, sessionId: "s", ts: 1_000_000 + n * 1000, agent: "claude-code", kind, payload };
};
const call = (tool: string, input: unknown, ok: boolean, output?: string): AgentEvent[] => {
  const id = `tu${n + 1}`;
  return [ev("tool.start", { tool, toolUseId: id, input }), ev("tool.end", { tool, toolUseId: id, ok, ...(output !== undefined ? { output } : {}) })];
};
const ok = (tool = "Read") => call(tool, { file_path: "a.ts" }, true, "contents");
const testFails = () => call("Bash", { command: "npx vitest run" }, false, "Error: Exit code 1\n Tests  1 failed | 3 passed (4)");
const notFound = () => call("Edit", { file_path: "a.ts" }, false, "<tool_use_error>String to replace not found in file.\nString: return a + b;</tool_use_error>");
const noCmd = () => call("Bash", { command: "nosuchcmd" }, false, "Error: Exit code 127\nbash: nosuchcmd: command not found");
const grade = async (spec: Record<string, unknown>, trace?: AgentEvent[]) =>
  (await createGrader({ kind: "executability", ...spec } as never)).grade({ input: null, output: null, ...(trace ? { trace: trace as never } : {}) });

describe("executability grader", () => {
  it("a clean run scores 1 and passes", async () => {
    const r = await grade({}, [ev("session.start", {}), ...ok(), ...ok("Edit"), ...ok("Bash")]);
    assert.deepEqual([r.score, r.pass, r.reason], [1, true, "all 3 tool calls executable"]);
  });

  it("a run whose only error is a shell exit 1 passes with score 1", async () => {
    const r = await grade({}, [...ok(), ...testFails(), ...ok("Edit")]);
    assert.deepEqual([r.score, r.pass, r.reason], [1, true, "all 3 tool calls executable"]);
  });

  it("the first invalid call at step 2 of 4 scores 0.25 and fails", async () => {
    const r = await grade({}, [...ok(), ...notFound(), ...testFails(), ...ok("Edit")]);
    assert.deepEqual([r.score, r.pass], [0.25, false]);
    assert.equal(r.reason, "first invalid call at step 2 of 4: Edit (state): String to replace not found in file.");
  });

  it("maxInvalid lets that many invalid calls pass; the score still marks the first", async () => {
    const trace = [...ok(), ...notFound(), ...noCmd(), ...ok()];
    const one = await grade({ maxInvalid: 1 }, trace);
    assert.deepEqual([one.score, one.pass], [0.25, false]);
    const two = await grade({ maxInvalid: 2 }, trace);
    assert.deepEqual([two.score, two.pass], [0.25, true]);
  });

  it("kinds counts only the listed kinds", async () => {
    const trace = [...ok(), ...notFound(), ...noCmd(), ...ok()];
    const missing = await grade({ kinds: ["missing"] }, trace);
    assert.deepEqual([missing.score, missing.pass], [0.5, false]);
    assert.match(missing.reason!, /^first invalid call at step 3 of 4: Bash \(missing\): Error: Exit code 127$/);
    const schema = await grade({ kinds: ["schema"] }, trace);
    assert.deepEqual([schema.score, schema.pass, schema.reason], [1, true, "all 4 tool calls executable"]);
  });

  it("no tool calls: score 1, pass", async () => {
    const r = await grade({}, [ev("session.start", {}), ev("user.message", { text: "hi" }), ev("assistant.message", { text: "hello" })]);
    assert.deepEqual([r.score, r.pass, r.reason], [1, true, "no tool calls"]);
  });

  it("no timed trace: score 0, fail", async () => {
    for (const trace of [undefined, [], [{ kind: "tool.start", payload: {} } as unknown as AgentEvent]]) {
      const r = await grade({}, trace);
      assert.deepEqual([r.score, r.pass, r.reason], [0, false, "no timed trace to check tool calls on"]);
    }
  });

  it("sorts the trace by time and keeps the detail to 160 characters", async () => {
    const long = call("Edit", {}, false, `<tool_use_error>String to replace not found in file. ${"x".repeat(300)}</tool_use_error>`);
    const r = await grade({}, [...long, ...ok()].reverse());
    assert.equal(r.score, 0);
    assert.ok(r.reason!.length <= 160, String(r.reason!.length));
    assert.match(r.reason!, /^first invalid call at step 1 of 2: Edit \(state\): String to replace not found in file\. x+…$/);
  });

  it("bad specs throw a RangeError that lists the valid kinds", () => {
    assert.throws(() => executabilityGrader({ kinds: ["nope" as never] }), (e: unknown) => e instanceof RangeError && /unknown invalid-call kind "nope" \(expected schema, unknown-tool, precondition, state, missing, denied, other\)/.test(e.message));
    assert.throws(() => executabilityGrader({ kinds: "schema" as never }), RangeError);
    for (const maxInvalid of [-1, 1.5, Number.NaN, "2" as never]) assert.throws(() => executabilityGrader({ maxInvalid }), /maxInvalid must be a whole number >= 0/);
  });

  it("is registered: createGrader builds it from a spec, versioned by its config", async () => {
    const g = await createGrader({ kind: "executability", kinds: ["state"], maxInvalid: 1 });
    assert.equal(g.kind, "executability");
    assert.equal(g.id, "executability");
    assert.equal(g.version, executabilityGrader({ kinds: ["state"], maxInvalid: 1 }).version);
    assert.notEqual(g.version, executabilityGrader().version);
    assert.equal((await createGrader({ kind: "executability", name: "exec" })).id, "exec");
    await assert.rejects(createGrader({ kind: "executability", kinds: ["nope" as never] }), /unknown invalid-call kind/);
  });
});
