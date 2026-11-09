import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BUILTIN_PREDICATES } from "../../src/judge/predicates.ts";
import { traceFromText } from "../../src/judge/trace-file.ts";

const line = (o: unknown) => JSON.stringify(o);

describe("traceFromText", () => {
  it("reads Claude stream-json: tool_use → tool.start, tool_result → tool.end (tool name looked up), text → messages", () => {
    const text = [
      line({ type: "system", subtype: "init", session_id: "s" }),
      line({ type: "assistant", timestamp: "2026-11-07T10:00:00Z", message: { content: [{ type: "text", text: "Checking." }, { type: "tool_use", id: "u1", name: "Bash", input: { command: "python3 scripts/cli_read.py whoami" } }] } }),
      line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "u1", is_error: true, content: [{ type: "text", text: "not logged in" }] }] } }),
      line({ type: "user", message: { content: "which team?" } }),
      "not json",
      line({ type: "result", result: "done" }),
    ].join("\n");
    const t = traceFromText(text);
    assert.deepEqual(
      t.map((e) => [e.id, e.kind]),
      [
        ["e1", "assistant.message"],
        ["e2", "tool.start"],
        ["e3", "tool.end"],
        ["e4", "user.message"],
      ],
    );
    assert.equal(t[1]?.ts, Date.parse("2026-11-07T10:00:00Z"));
    assert.deepEqual(t[1]?.payload, { tool: "Bash", toolUseId: "u1", input: { command: "python3 scripts/cli_read.py whoami" } });
    assert.deepEqual(t[2]?.payload, { tool: "Bash", toolUseId: "u1", ok: false, output: "not logged in" });
    // The predicates read it: the command ran, and it failed.
    const ctx = { input: "", output: "done", trace: t };
    assert.equal((BUILTIN_PREDICATES["ran-command"]!.test(ctx, { command: "cli_read.py whoami" }) as { answer: boolean }).answer, true);
    assert.equal((BUILTIN_PREDICATES["ran-command"]!.test(ctx, { command: "cli_read.py whoami", ok: true }) as { answer: boolean }).answer, false);
  });

  it("passes coding.sh events through, as JSONL or one JSON array; anything else is no events", () => {
    const ev = [{ id: "x1", kind: "tool.start", ts: 5, payload: { tool: "Read", input: { file_path: "a" } } }];
    assert.deepEqual(traceFromText(JSON.stringify(ev)), ev);
    assert.deepEqual(traceFromText(ev.map(line).join("\n")), ev);
    assert.deepEqual(traceFromText("plain text answer"), []);
    assert.deepEqual(traceFromText(""), []);
  });
});

// ---------------------------------------------------------------- AD-1: every headless format, and coverage
import { readFileSync } from "node:fs";
import { traceCoverage, describeCoverage } from "../../src/judge/trace-file.ts";
import { renderTrace } from "../../src/judge/prompt.ts";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/judge/trace/${name}`, import.meta.url), "utf8");

describe("traceFromText: Codex, Cursor and OpenAI formats", () => {
  it("codex exec --json (real run): 3 command_execution items → 3 starts and 3 ends with commands and outputs", () => {
    const text = fixture("codex-exec.jsonl");
    const t = traceFromText(text);
    const starts = t.filter((e) => e.kind === "tool.start");
    const ends = t.filter((e) => e.kind === "tool.end");
    assert.equal(starts.length, 3);
    assert.equal(ends.length, 3);
    assert.ok(starts.every((e) => e.payload?.tool === "shell" && typeof (e.payload?.input as { command?: unknown }).command === "string"));
    assert.deepEqual(
      starts.map((e) => /echo hello from demo|cat missing\.txt|\bls\b/.exec(String((e.payload?.input as { command: string }).command))?.[0]),
      ["echo hello from demo", "cat missing.txt", "ls"],
    );
    assert.match(String(ends[0]!.payload?.output), /hello from demo/);
    assert.deepEqual(
      ends.map((e) => e.payload?.ok),
      [true, false, true],
    );
    assert.ok(t.some((e) => e.kind === "assistant.message"));
    const ctx = { input: "", output: "", trace: t };
    assert.equal((BUILTIN_PREDICATES["ran-command"]!.test(ctx, { command: "cat missing.txt" }) as { answer: boolean }).answer, true);
    assert.equal((BUILTIN_PREDICATES["ran-command"]!.test(ctx, { command: "cat missing.txt", ok: true }) as { answer: boolean }).answer, false);
    const cov = traceCoverage(text, t);
    assert.equal(cov.format, "codex-exec");
    assert.equal(cov.sourceCalls, 3);
    assert.equal(cov.sourceResults, 3);
    assert.equal(cov.ok, true, describeCoverage(cov));
  });

  it("codex exec: one start per item even with started and completed records; an item that never completed is an unmatched call", () => {
    const rec = (type: string, item: Record<string, unknown>) => line({ type, item });
    const text = [
      line({ type: "thread.started", thread_id: "t" }),
      rec("item.started", { id: "i1", type: "command_execution", command: "npm test", aggregated_output: "", exit_code: null, status: "in_progress" }),
      rec("item.completed", { id: "i1", type: "command_execution", command: "npm test", aggregated_output: "ok", exit_code: 0, status: "completed" }),
      rec("item.completed", { id: "i2", type: "mcp_tool_call", server: "gh", tool: "search", arguments: { q: "x" }, result: { content: [{ type: "text", text: "3 hits" }] }, status: "completed" }),
      rec("item.completed", { id: "i3", type: "file_change", changes: [{ path: "a.ts", kind: "add" }], status: "completed" }),
      rec("item.completed", { id: "i4", type: "web_search", query: "node test runner" }),
      rec("item.started", { id: "i5", type: "command_execution", command: "sleep 100", aggregated_output: "", exit_code: null, status: "in_progress" }),
      rec("item.completed", { id: "i6", type: "agent_message", text: "done" }),
    ].join("\n");
    const t = traceFromText(text);
    assert.deepEqual(
      t.filter((e) => e.kind === "tool.start").map((e) => e.payload?.tool),
      ["shell", "gh.search", "apply_patch", "web_search", "shell"],
    );
    assert.deepEqual(t.find((e) => e.kind === "tool.end" && e.payload?.tool === "gh.search")?.payload, { tool: "gh.search", toolUseId: "i2", ok: true, output: "3 hits" });
    const cov = traceCoverage(text, t);
    assert.deepEqual(cov.unmatchedCalls, ["i5"]);
    assert.deepEqual(cov.unmatchedResults, []);
    assert.equal(cov.sourceCalls, 5);
    assert.equal(cov.sourceResults, 4);
    assert.equal(cov.ok, true);
  });

  it("Cursor stream-json: assistant text and tool calls (started/completed on call_id)", () => {
    const text = fixture("cursor-stream.jsonl");
    const t = traceFromText(text);
    assert.deepEqual(
      t.map((e) => [e.kind, e.payload?.tool ?? null]),
      [
        ["user.message", null],
        ["assistant.message", null],
        ["tool.start", "read"],
        ["tool.end", "read"],
        ["tool.start", "shell"],
        ["tool.end", "shell"],
        ["tool.start", "write"],
        ["tool.end", "write"],
        ["assistant.message", null],
      ],
    );
    assert.deepEqual(t[4]!.payload?.input, { command: "npm test" });
    assert.equal(t[5]!.payload?.ok, false, "exit code 1");
    assert.equal(t[5]!.payload?.output, "1 failing");
    const cov = traceCoverage(text, t);
    assert.equal(cov.format, "cursor");
    assert.equal(cov.sourceCalls, 3);
    assert.equal(cov.ok, true);
  });

  it("OpenAI chat: tool_calls → tool.start with parsed arguments, role tool → tool.end", () => {
    const text = fixture("openai-chat.json");
    const t = traceFromText(text);
    const starts = t.filter((e) => e.kind === "tool.start");
    assert.equal(starts.length, 3);
    assert.deepEqual(starts[0]!.payload, { tool: "shell", toolUseId: "call_a1", input: { command: "npm test" } });
    assert.deepEqual(starts[1]!.payload?.input, { path: "src/sum.js", old: "a + b + 1", new: "a + b" });
    assert.deepEqual(t.find((e) => e.kind === "tool.end")?.payload, { tool: "shell", toolUseId: "call_a1", output: "1 failing: sum(2, 2) expected 4, got 5" });
    assert.equal(t.filter((e) => e.kind === "assistant.message").length, 2);
    const cov = traceCoverage(text, t);
    assert.equal(cov.format, "openai-chat");
    assert.equal(cov.sourceCalls, 3);
    assert.equal(cov.sourceResults, 3);
    assert.equal(cov.ok, true);
    // and the predicates read it
    assert.equal((BUILTIN_PREDICATES["ran-command"]!.test({ input: "", output: "", trace: t }, { command: "npm test" }) as { answer: boolean }).answer, true);
  });

  it("OpenAI Responses items (real Codex request input): function_call / function_call_output on call_id", () => {
    const text = fixture("openai-responses.json");
    const t = traceFromText(text);
    const starts = t.filter((e) => e.kind === "tool.start");
    assert.equal(starts.length, 3);
    assert.ok(starts.every((e) => typeof (e.payload?.input as { cmd?: unknown }).cmd === "string"));
    assert.equal(t.filter((e) => e.kind === "tool.end").length, 3);
    const cov = traceCoverage(text, t);
    assert.equal(cov.format, "openai-responses");
    assert.equal(cov.ok, true, describeCoverage(cov));
    assert.deepEqual(cov.unmatchedCalls, []);
  });
});

describe("traceCoverage", () => {
  it("reports unmatched calls and results in both directions", () => {
    const text = [
      line({ type: "assistant", message: { content: [{ type: "tool_use", id: "u1", name: "Bash", input: { command: "ls" } }] } }),
      line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "u9", content: "orphan" }] } }),
    ].join("\n");
    const cov = traceCoverage(text, traceFromText(text));
    assert.equal(cov.format, "claude");
    assert.deepEqual(cov.unmatchedCalls, ["u1"]);
    assert.deepEqual(cov.unmatchedResults, ["u9"]);
    assert.equal(cov.ok, true);
  });

  it("an unrecognised JSONL of tool-call-looking records is not ok", () => {
    const text = [line({ event: "tool_call", name: "bash", args: { cmd: "ls" } }), line({ event: "tool_result", name: "bash", output: "a" }), line({ type: "toolCall", id: "x1", name: "bash" })].join("\n");
    const t = traceFromText(text);
    assert.deepEqual(t, []);
    const cov = traceCoverage(text, t);
    assert.equal(cov.format, "unknown");
    assert.equal(cov.ok, false);
    assert.equal(cov.sourceCalls, 1);
    assert.match(describeCoverage(cov), /trace has 1 tool call\(s\) in unknown records but 0 reached the judge; 3 JSON record\(s\) in a format the judge does not read/);
  });

  it("a coding.sh event with payload {} is a blank event and not ok", () => {
    const text = [line({ id: "x1", kind: "tool.start", payload: {} }), line({ id: "x2", kind: "tool.end", payload: { tool: "Bash", ok: true, output: "a" } })].join("\n");
    const t = traceFromText(text);
    const cov = traceCoverage(text, t);
    assert.deepEqual(cov.blankEvents, ["x1"]);
    assert.equal(cov.ok, false);
    assert.match(renderTrace(t), /\[x1\] tool\.start: $/m);
  });

  it("plain text keeps today's behaviour: no records, ok", () => {
    const cov = traceCoverage("The agent said it was done.", []);
    assert.equal(cov.records, 0);
    assert.equal(cov.ok, true);
  });

  it("mutation: dropping any one tool record from a real trace is caught", () => {
    for (const name of ["codex-exec.jsonl", "cursor-stream.jsonl"]) {
      const lines = fixture(name).trim().split("\n");
      const full = traceFromText(lines.join("\n"));
      let tested = 0;
      lines.forEach((l, i) => {
        // A completed record alone carries the whole call, so dropping a started one loses nothing.
        if (!/"item\.completed".*"command_execution"|"tool_call","subtype":"completed"/.test(l)) return;
        tested++;
        // The parser sees the trace without line i; the source still has it (what a lossy renderer would do).
        const dropped = traceFromText(lines.filter((_, j) => j !== i).join("\n"));
        const cov = traceCoverage(lines.join("\n"), dropped);
        assert.equal(cov.ok, false, `${name}: dropping line ${i + 1} was not caught`);
      });
      assert.equal(tested, 3, `${name}: ${tested} tool records`);
      assert.equal(traceCoverage(lines.join("\n"), full).ok, true);
    }
  });

  it("mutation: a parser that drops each tool event in turn is caught", () => {
    const text = fixture("openai-chat.json");
    const t = traceFromText(text);
    t.forEach((e, i) => {
      if (e.kind !== "tool.start" && e.kind !== "tool.end") return;
      assert.equal(traceCoverage(text, t.filter((_, j) => j !== i)).ok, false, `dropping ${e.id}`);
    });
  });
});
