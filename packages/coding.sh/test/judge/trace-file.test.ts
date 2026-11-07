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
