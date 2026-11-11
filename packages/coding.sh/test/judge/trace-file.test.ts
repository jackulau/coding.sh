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
import { readdirSync, readFileSync } from "node:fs";
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
    const ends = t.filter((e) => e.kind === "tool.end");
    assert.equal(ends.length, 3);
    // qa:eval-1: "Process exited with code N" in the output sets ok.
    assert.deepEqual(
      ends.map((e) => e.payload?.ok),
      [true, false, true],
    );
    const cov = traceCoverage(text, t);
    assert.equal(cov.format, "openai-responses");
    assert.equal(cov.ok, true, describeCoverage(cov));
    assert.deepEqual(cov.unmatchedCalls, []);
  });
});

describe("traceFromText: ok for results with no status field (qa:eval-1)", () => {
  const okOf = (content: unknown) => {
    const text = JSON.stringify([
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "shell", arguments: '{"command":"npm test"}' } }] },
      { role: "tool", tool_call_id: "c1", content },
    ]);
    return traceFromText(text).find((e) => e.kind === "tool.end")?.payload?.ok;
  };

  it("an exit code on its own line sets ok: false for non-zero, true for 0", () => {
    assert.equal(okOf("npm ERR! Test failed\nexit code 1"), false);
    assert.equal(okOf("3 passing\nExit code: 0\n"), true);
    assert.equal(okOf("[Process exited with code 137]"), false);
    assert.equal(okOf("Command exited with code 0."), true);
    assert.equal(okOf(JSON.stringify({ output: "cat: a: No such file", metadata: { exit_code: 1, duration_seconds: 0 } })), false);
    assert.equal(okOf(JSON.stringify({ output: "a", metadata: { exit_code: 0 } })), true);
  });

  it("no stated exit code, a mention inside a longer line, or two that disagree leave ok absent", () => {
    assert.equal(okOf("3 passing"), undefined);
    assert.equal(okOf("src/run.ts:12:  // retry when the child returns exit code 1 again"), undefined);
    assert.equal(okOf("exit code 0\nexit code 1"), undefined);
    assert.equal(okOf(""), undefined);
  });

  it("Codex's header line decides over the command's own output", () => {
    const out = (code: number, body: string) => `Chunk ID: 1\nWall time: 0.1 seconds\nProcess exited with code ${code}\nOriginal token count: 4\nOutput:\n${body}\n`;
    const text = JSON.stringify([
      { type: "function_call", name: "exec_command", arguments: '{"cmd":"make"}', call_id: "c1" },
      { type: "function_call_output", call_id: "c1", output: out(2, "lint: exit code 0\nexit code 0") },
    ]);
    assert.equal(traceFromText(text).find((e) => e.kind === "tool.end")?.payload?.ok, false);
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

  // qa:eval-6: a cut trace, unknown records and a file that is no trace were graded as complete.
  it("a trace cut mid-line is not ok and counts the line", () => {
    const text = fixture("codex-exec.jsonl").slice(0, 900);
    const t = traceFromText(text);
    const cov = traceCoverage(text, t);
    assert.deepEqual([cov.format, cov.records, cov.unparsedLines, cov.unreadRecords, cov.ok], ["codex-exec", 6, 1, 0, false]);
    assert.equal(describeCoverage(cov), "1 line(s) are not whole JSON (a cut or partial write)");
    // Cut at the front: the first line is the tail of a record.
    const lines = fixture("codex-exec.jsonl").trim().split("\n");
    const tail = [lines[4]!.slice(40), ...lines.slice(5)].join("\n");
    const back = traceCoverage(tail, traceFromText(tail));
    assert.deepEqual([back.unparsedLines, back.ok], [1, false]);
    // A log line between records is not a cut.
    const noisy = [lines[0], "warning: model metadata not found", ...lines.slice(1)].join("\n");
    const whole = traceCoverage(noisy, traceFromText(noisy));
    assert.deepEqual([whole.records, whole.unparsedLines, whole.ok], [11, 0, true]);
  });

  it("two formats plus a record with no type, role or kind: mixed, not ok, and the record is counted", () => {
    const text = [
      line({ type: "assistant", message: { content: [{ type: "tool_use", id: "u1", name: "Bash", input: { command: "ls" } }] } }),
      line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "u1", content: "a" }] } }),
      // Claude transcripts carry record types the judge has no use for: metadata, not a hole.
      line({ type: "attachment", attachment: { type: "hook_success" } }),
      line({ type: "item.completed", item: { id: "i1", type: "command_execution", command: "npm test", aggregated_output: "ok", exit_code: 0, status: "completed" } }),
      line({ event: "step", name: "bash", detail: "npm run build" }),
    ].join("\n");
    const t = traceFromText(text);
    const cov = traceCoverage(text, t);
    assert.deepEqual([cov.format, cov.records, cov.unparsedLines, cov.unreadRecords, cov.ok], ["mixed", 5, 0, 1, false]);
    assert.equal(describeCoverage(cov), "1 record(s) with no type, role or kind, which the judge does not read");
    const known = text.split("\n").slice(0, 4).join("\n");
    assert.equal(traceCoverage(known, traceFromText(known)).ok, true);
    // Array items that are not objects are records the judge does not read either.
    const arr = JSON.stringify([{ role: "user", content: "hi" }, "stray", 3]);
    assert.deepEqual([traceCoverage(arr, traceFromText(arr)).unreadRecords, traceCoverage(arr, traceFromText(arr)).ok], [2, false]);
  });

  it("text with no JSON record is an unknown format, not a complete trace; an empty file has nothing to drop", () => {
    const cov = traceCoverage("The agent said it was done.", []);
    assert.deepEqual([cov.format, cov.records, cov.unparsedLines, cov.unreadRecords, cov.ok], ["unknown", 0, 0, 0, false]);
    assert.equal(describeCoverage(cov), "the file has no JSON records (not a trace format the judge reads)");
    // A JSON document cut before its first record ends.
    const cut = fixture("openai-responses.json").slice(0, 120);
    const c = traceCoverage(cut, traceFromText(cut));
    assert.deepEqual([c.records, c.ok], [0, false]);
    assert.match(describeCoverage(c), /the file has no JSON records \(not a trace format the judge reads\); \d+ line\(s\) are not whole JSON/);
    for (const empty of ["", " \n"]) assert.equal(traceCoverage(empty, []).ok, true);
  });

  it("real Claude transcripts, with their metadata records, stay complete", () => {
    let seen = 0;
    for (const set of ["real", "subagents", "unapproved"]) {
      const dir = new URL(`../fixtures/adapters/claude-code/${set}/config/projects/-work-demo/`, import.meta.url);
      for (const f of readdirSync(dir).filter((n) => n.endsWith(".jsonl"))) {
        const text = readFileSync(new URL(f, dir), "utf8");
        const cov = traceCoverage(text, traceFromText(text));
        assert.deepEqual([cov.format, cov.unparsedLines, cov.unreadRecords, cov.ok], ["claude", 0, 0, true], `${set}/${f}: ${describeCoverage(cov)}`);
        seen++;
      }
    }
    assert.ok(seen >= 3, `${seen} transcripts`);
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
