import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { claudeCode } from "../../src/adapters/claude-code.ts";
import { aucPec, classifyToolCall, executability, fed, INVALID_KINDS, type InvalidKind } from "../../src/core/executability.ts";
import type { AgentEvent, EventKind } from "../../src/schema/index.ts";
import { collect, FIXTURES, testCtx, tmpEnv, type TmpEnv } from "../adapters/_helpers.ts";

let n = 0;
const ev = (kind: EventKind, payload: Record<string, unknown>, o: Partial<AgentEvent> = {}): AgentEvent => {
  n++;
  return { id: `e${n}`, v: 0, sessionId: "s", ts: 1_000_000 + n * 1000, agent: "claude-code", kind, payload, ...o };
};
const start = (tool: string, input: unknown = {}, id = `tu${n + 1}`, o: Partial<AgentEvent> = {}) => ev("tool.start", { tool, toolUseId: id, input }, o);
const end = (tool: string, id: string, ok: boolean, extra: Record<string, unknown> = {}, o: Partial<AgentEvent> = {}) => ev("tool.end", { tool, toolUseId: id, ok, ...extra }, o);
/** A paired call. */
const call = (tool: string, input: unknown, ok: boolean, extra: Record<string, unknown> = {}, o: Partial<AgentEvent> = {}): AgentEvent[] => {
  const s = start(tool, input, `tu${n + 1}`, o);
  return [s, end(tool, s.payload.toolUseId as string, ok, extra, o)];
};
/** Classify one call. */
const cls = (tool: string, input: unknown, output: unknown, extra: Record<string, unknown> = {}) => {
  const [s, e] = call(tool, input, false, { ...(output !== undefined ? { output } : {}), ...extra });
  return classifyToolCall(s, e!);
};
const kindOf = (tool: string, input: unknown, output: unknown, extra: Record<string, unknown> = {}): string => {
  const c = cls(tool, input, output, extra);
  return c.cls === "invalid" ? c.kind! : c.cls;
};
const bash = (command: string) => ({ command });
const tue = (msg: string) => `<tool_use_error>${msg}</tool_use_error>`;

describe("classifyToolCall", () => {
  it("ok unless ok is false", () => {
    const [s, e] = call("Bash", bash("ls"), true, { output: "a\nb" });
    assert.deepEqual(classifyToolCall(s, e!), { cls: "ok" });
    const [s2, e2] = call("Read", { file_path: "a" }, true);
    delete e2!.payload.ok;
    assert.deepEqual(classifyToolCall(s2, e2!), { cls: "ok" });
  });

  it("Claude Code <tool_use_error> messages map to their kind", () => {
    const rules: [string, InvalidKind][] = [
      ["InputValidationError: Edit failed due to the following issue:\nThe required parameter `old_string` is missing", "schema"],
      ["The required parameter `file_path` is missing", "schema"],
      ["An unexpected parameter `foo` was provided", "schema"],
      ["Error: No such tool available: Monitor", "unknown-tool"],
      ["File has not been read yet. Read it first before writing to it.", "precondition"],
      ["File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.", "precondition"],
      ["String to replace not found in file.\nString:   return a + b;", "state"],
      ["Found 3 matches of the string to replace, but replace_all is false.", "state"],
      ["File does not exist. Note: your current working directory is /work/demo.", "missing"],
      ["Permission to use Bash has been denied.", "denied"],
      ["Something new went wrong", "other"],
    ];
    for (const [msg, kind] of rules) assert.equal(kindOf("Edit", { file_path: "/work/demo/a.ts" }, tue(msg)), kind, msg);
    assert.deepEqual(cls("Edit", {}, tue("String to replace not found in file.\nString: x")), { cls: "invalid", kind: "state", detail: "String to replace not found in file." });
  });

  it("schema wins over the later kinds in one message (precedence)", () => {
    assert.equal(kindOf("Write", {}, tue("InputValidationError: file has not been read yet")), "schema");
    assert.equal(kindOf("Edit", {}, tue("File has not been read yet; String to replace not found")), "precondition");
  });

  it("a PreToolUse hook block or permission denial is denied, on any tool", () => {
    assert.equal(kindOf("Bash", bash("git commit -m x"), "PreToolUse:Bash hook error: [node guard.js]: em-dash in commit message"), "denied");
    assert.equal(kindOf("Bash", bash("rm -rf /"), "Blocked by the disk-guard hook"), "denied");
    assert.equal(kindOf("Write", {}, "Permission to use Write has been denied."), "denied");
  });

  it("shell: exit 127 or command not found is missing; any other non-zero exit failed", () => {
    assert.equal(kindOf("Bash", bash("nosuchcmd"), "Error: Exit code 127\n/bin/bash: line 1: nosuchcmd: command not found"), "missing");
    assert.equal(kindOf("Bash", bash("uptime"), "bash: uptime: command not found"), "missing");
    assert.equal(kindOf("exec_command", { cmd: "x" }, "", { exitCode: 127 }), "missing");
    assert.equal(kindOf("Bash", bash("npx vitest run"), "Error: Exit code 1\n Tests  1 failed | 3 passed (4)"), "failed");
    assert.equal(kindOf("shell", bash("pytest"), "Exit code: 2\npydantic validation error in test_model"), "failed", "a command that ran: its output is not a harness message");
    assert.equal(kindOf("exec_command", { cmd: "cat nope" }, "cat: nope: No such file or directory", { exitCode: 1 }), "failed");
    assert.deepEqual(cls("Bash", bash("npx vitest run"), "Error: Exit code 1\nmore"), { cls: "failed", detail: "Error: Exit code 1" });
  });

  it("any agent: unknown tool, schema, apply_patch state, missing file on read or edit", () => {
    assert.equal(kindOf("frobnicate", {}, "unsupported call: unknown tool frobnicate"), "unknown-tool");
    assert.equal(kindOf("search", {}, "Tool search not found"), "unknown-tool");
    assert.equal(kindOf("mcp__x__y", {}, "y not found in registry"), "unknown-tool");
    assert.equal(kindOf("read_file", {}, "failed to parse function arguments: missing field `path`"), "schema");
    assert.equal(kindOf("edit", {}, "Invalid arguments for tool edit"), "schema");
    assert.equal(kindOf("write_file", {}, "params must have required property 'content'"), "schema");
    assert.equal(kindOf("Grep", {}, "1 validation error for GrepInput"), "schema");
    assert.equal(kindOf("exec_command", {}, "failed to parse function arguments: missing field `cmd`"), "schema", "a shell call with no exit code never ran");
    assert.equal(kindOf("apply_patch", {}, "apply_patch verification failed: Failed to find expected lines in a.ts"), "state");
    assert.equal(kindOf("read_file", { path: "a" }, "ENOENT: No such file or directory, open 'a'"), "missing");
    assert.equal(kindOf("write_file", { path: "a/b" }, "No such file or directory"), "missing");
    assert.equal(kindOf("WebFetch", { url: "x" }, "No such file or directory"), "failed", "missing applies to read and edit calls only");
  });

  it("ok:false with no output is failed: hook-only captures are a lower bound", () => {
    assert.deepEqual(cls("Edit", {}, undefined), { cls: "failed" });
    assert.deepEqual(cls("Bash", bash("x"), ""), { cls: "failed" });
  });

  it("reads only the first 2 KB of the output, and objects as JSON", () => {
    assert.equal(kindOf("Bash", bash("x"), `${"x".repeat(2100)} command not found`), "failed");
    assert.equal(kindOf("read_file", {}, { error: "No such file or directory" }), "missing");
  });

  it("an end with no start classifies from the end's tool", () => {
    const e = end("Bash", "lost", false, { output: "Error: Exit code 127" });
    assert.equal(classifyToolCall(undefined, e).kind, "missing");
  });
});

describe("executability", () => {
  it("a clean session: every step executable, FED = T+1, AUC-PEC 1", () => {
    const x = executability([...call("Read", {}, true), ...call("Bash", bash("npm test"), false, { output: "Error: Exit code 1" }), ...call("Edit", {}, true)]);
    assert.deepEqual(x, { steps: 3, invalid: 0, kinds: {} });
    assert.equal(fed(x), 4);
    assert.equal(aucPec(x), 1);
  });

  it("first.depth is the 1-based step of the first invalid call; kinds counts each", () => {
    const events = [
      ...call("Read", {}, true),
      ...call("Write", {}, false, { output: tue("File has not been read yet. Read it first before writing to it.") }),
      ...call("Bash", bash("nosuchcmd"), false, { output: "Error: Exit code 127" }),
      ...call("Edit", {}, false, { output: tue("String to replace not found in file.") }),
    ];
    const x = executability(events);
    assert.equal(x.steps, 4);
    assert.equal(x.invalid, 3);
    assert.deepEqual(x.kinds, { precondition: 1, missing: 1, state: 1 });
    assert.deepEqual(x.first, { depth: 2, eventId: events[2]!.id, tool: "Write", kind: "precondition", detail: "File has not been read yet. Read it first before writing to it." });
    assert.equal(fed(x), 2);
    assert.equal(aucPec(x), 0.25);
  });

  it("steps go in tool.start order, paired by toolUseId (an overlapping end does not reorder)", () => {
    const a = start("Read", {}, "a");
    const b = start("Edit", {}, "b");
    const events = [a, b, end("Edit", "b", false, { output: tue("Found 2 matches of the string to replace") }), end("Read", "a", true)];
    const x = executability(events);
    assert.equal(x.steps, 2);
    assert.equal(x.first?.depth, 2);
    assert.equal(x.first?.eventId, b.id, "the start's id");
  });

  it("an end with no start is a step in end order", () => {
    const events = [...call("Read", {}, true), end("Edit", "lost", false, { output: tue("File does not exist.") }), ...call("Bash", bash("ls"), true)];
    const x = executability(events);
    assert.equal(x.steps, 3);
    assert.deepEqual([x.first?.depth, x.first?.kind, x.first?.eventId], [2, "missing", events[2]!.id]);
  });

  it("a start with no end is still a step", () => {
    const x = executability([start("Bash", bash("sleep 999"), "open"), ...call("Edit", {}, false, { output: tue("String to replace not found") })]);
    assert.deepEqual([x.steps, x.first?.depth], [2, 2]);
  });

  it("interrupted calls are not steps", () => {
    const events = [...call("Bash", bash("npm run dev"), false, { interrupted: true, output: "Error: Exit code 127" }), ...call("Edit", {}, false, { output: tue("String to replace not found") })];
    const x = executability(events);
    assert.deepEqual([x.steps, x.invalid, x.first?.depth], [1, 1, 1]);
  });

  it("wrapper calls are not steps; the calls they run are", () => {
    const w = start("exec", {}, "cell", {});
    w.payload.wrapper = true;
    const inner = call("exec_command", { cmd: "nosuchcmd" }, false, { output: "bash: nosuchcmd: command not found" }, { parentId: w.id });
    const wEnd = end("exec", "cell", false, { wrapper: true, output: "unknown tool" });
    const x = executability([w, ...inner, wEnd]);
    assert.deepEqual([x.steps, x.invalid, x.first?.tool, x.first?.kind], [1, 1, "exec_command", "missing"]);
  });

  it("subagent calls are not steps; the main-stream call that spawned it is", () => {
    const events = [
      ...call("Agent", { prompt: "find callers" }, true),
      ...call("Read", {}, false, { output: tue("File does not exist.") }, { subagentId: "sub1" }),
      ...call("Edit", {}, false, { output: tue("String to replace not found") }, { subagentId: "sub1" }),
    ];
    assert.deepEqual(executability(events), { steps: 1, invalid: 0, kinds: {} });
  });

  it("the same call from two capture paths counts once", () => {
    const s = start("Edit", {}, "dup");
    const e = end("Edit", "dup", false, { output: tue("String to replace not found") });
    const s2 = { ...s, id: "e-dup-start" };
    const e2 = { ...e, id: "e-dup-end", payload: { ...e.payload, ok: true } };
    const x = executability([s, s2, e, e2]);
    assert.deepEqual([x.steps, x.invalid], [1, 1]);
  });

  it("only counts the listed kinds", () => {
    const events = [
      ...call("Write", {}, false, { output: tue("File has not been read yet.") }),
      ...call("Bash", bash("nosuchcmd"), false, { output: "Error: Exit code 127" }),
    ];
    const x = executability(events, { only: ["missing"] });
    assert.deepEqual([x.invalid, x.kinds, x.first?.depth, x.first?.kind], [1, { missing: 1 }, 2, "missing"]);
  });

  it("no tool calls: zero steps, FED 1, AUC-PEC 1", () => {
    const x = executability([ev("user.message", { text: "hi" })]);
    assert.deepEqual(x, { steps: 0, invalid: 0, kinds: {} });
    assert.equal(fed(x), 1);
    assert.equal(aucPec(x), 1);
  });

  it("lists every kind", () => {
    assert.deepEqual([...INVALID_KINDS], ["schema", "unknown-tool", "precondition", "state", "missing", "denied", "other"]);
  });
});

describe("executability on the real Claude Code fixture", () => {
  let env: TmpEnv;
  before(() => {
    env = tmpEnv();
    process.env.CLAUDE_CONFIG_DIR = join(FIXTURES, "claude-code", "config");
  });
  after(() => env.restore());

  it("the vitest Exit code 1 is failed, not invalid: 0 invalid calls", async () => {
    const SID = "11111111-2222-4333-8444-555555555555";
    const all = await collect(claudeCode.backfill!(testCtx().ctx));
    const events = all.filter((e) => e.sessionId === SID).sort((a, b) => a.ts - b.ts);
    const errors = events.filter((e) => e.kind === "tool.end" && e.payload.ok === false);
    assert.equal(errors.length, 1, "the fixture's only is_error");
    const vitestStart = events.find((e) => e.kind === "tool.start" && e.payload.toolUseId === errors[0]!.payload.toolUseId);
    assert.deepEqual(classifyToolCall(vitestStart, errors[0]!), { cls: "failed", detail: "Error: Exit code 1" });
    const x = executability(events);
    assert.deepEqual(x, { steps: 4, invalid: 0, kinds: {} });
    assert.equal(aucPec(x), 1);
    // The child session's events (the subagent's own calls) carry subagentId: still 0 invalid with them in.
    assert.equal(executability([...all].sort((a, b) => a.ts - b.ts)).invalid, 0);
  });
});
