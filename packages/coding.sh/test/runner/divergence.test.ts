import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentEvent } from "../../src/core/types.ts";
import { firstDivergence, toolSteps } from "../../src/runner/divergence.ts";

let n = 0;
function tool(name: string, input: unknown, extra: Partial<AgentEvent> = {}): AgentEvent {
  n++;
  return { id: `e${n}`, v: 0, sessionId: "s", ts: n, agent: "x", kind: "tool.start", payload: { tool: name, toolUseId: `u${n}`, input }, ...extra };
}
const msg = (text: string): AgentEvent => ({ id: `m${++n}`, v: 0, sessionId: "s", ts: n, agent: "x", kind: "assistant.message", payload: { text } });

describe("firstDivergence", () => {
  it("identical tool sequences → undefined (prose and volatile keys ignored)", () => {
    const a = [msg("Let me look"), tool("Read", { file_path: "src/a.ts" }), tool("Bash", { command: "npm  test", description: "run tests" })];
    const b = [tool("Read", { file_path: "src/a.ts" }), msg("Different words"), tool("Bash", { command: "npm test", description: "Running the suite" })];
    assert.equal(firstDivergence(a, b), undefined);
  });
  it("normalizes per-run absolute paths", () => {
    const a = [tool("Read", { file_path: "/x/runs/run_A/work/src/a.ts" }, { cwd: "/x/runs/run_A/work" })];
    const b = [tool("Read", { file_path: "/y/runs/run_B/work/src/a.ts" }, { cwd: "/y/runs/run_B/work" })];
    assert.equal(firstDivergence(a, b), undefined);
    assert.equal(toolSteps(a)[0]?.input, '{"file_path":"src/a.ts"}');
  });
  it("different tool at step k", () => {
    const d = firstDivergence([tool("Read", { p: 1 }), tool("Bash", { command: "ls" })], [tool("Read", { p: 1 }), tool("Edit", { p: 2 })]);
    assert.equal(d?.index, 1);
    assert.equal(d?.sameTool, false);
    assert.match(d?.description ?? "", /^step 2: A calls Bash .*; B calls Edit/);
  });
  it("same tool, different input", () => {
    const d = firstDivergence([tool("Bash", { command: "npm test" })], [tool("Bash", { command: "pytest" })]);
    assert.equal(d?.index, 0);
    assert.equal(d?.sameTool, true);
    assert.match(d?.description ?? "", /both call Bash with different input/);
  });
  it("one trace stops early", () => {
    const d = firstDivergence([tool("Read", { p: 1 })], [tool("Read", { p: 1 }), tool("Bash", { command: "npm test" })]);
    assert.equal(d?.index, 1);
    assert.equal(d?.a, undefined);
    assert.match(d?.description ?? "", /A stops after 1 tool call\(s\); B continues with Bash/);
  });
  it("orders by timestamp", () => {
    const late = tool("Bash", { command: "b" }, { ts: 100 });
    const early = tool("Read", { p: 1 }, { ts: 1 });
    assert.deepEqual(toolSteps([late, early]).map((s) => s.tool), ["Read", "Bash"]);
  });
});
