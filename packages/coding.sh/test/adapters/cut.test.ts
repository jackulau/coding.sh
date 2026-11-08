// Harness tool-output cuts (src/adapters/_shared/cut.ts): the strings Codex and
// Claude Code put in what the model got when they cut a tool's output.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { outputCutOf } from "../../src/adapters/_shared/cut.ts";

const rows = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ i, name: `item-${i}` })));

describe("outputCutOf", () => {
  it("reads Codex's head warning and a JSON body cut mid-string", () => {
    const text = `Warning: truncated output (original token count: 27225)\nTotal output lines: 6\n\n${rows(50).slice(0, 300)}`;
    assert.deepEqual(outputCutOf(text), { by: "codex-head", originalTokens: 27225, deliveredBytes: Buffer.byteLength(text), jsonBroken: true });
  });

  it("strips the exec_command preamble before checking the body", () => {
    const body = `${rows(10).slice(0, 120)}…3000 chars truncated…${rows(10).slice(-120)}`;
    const text = `Chunk ID: 08ba0d\nWall time: 0.0000 seconds\nProcess exited with code 0\nOriginal token count: 10696\nOutput:\nWarning: truncated output (original token count: 10696)\nTotal output lines: 1\n\n${body}`;
    assert.deepEqual(outputCutOf(text), { by: "codex-head", originalTokens: 10696, cutChars: 3000, deliveredBytes: Buffer.byteLength(text), jsonBroken: true });
  });

  it("strips a code-mode cell's preamble", () => {
    const text = `Script completed\nWall time 0.1 seconds\nOutput:\n\nWarning: truncated output (original token count: 12973)\nTotal output lines: 1\n\n{"chunk_id":"41`;
    assert.equal(outputCutOf(text)?.jsonBroken, true);
  });

  it("a middle cut that still parses is not jsonBroken", () => {
    // As in the real capture: the elision joined two halves of a key into one string.
    const text = `[{"i":186,"n…32782 chars truncated…name":"item-1333"}]`;
    assert.deepEqual(outputCutOf(text), { by: "middle", cutChars: 32782, deliveredBytes: Buffer.byteLength(text) });
  });

  it("reads a middle cut in tokens; JSON lines are broken only when a line no longer parses", () => {
    const whole = `{"a":1}\n{"b":2}\n…120 tokens truncated…\n{"c":3}`;
    assert.deepEqual(outputCutOf(whole), { by: "middle", cutTokens: 120, deliveredBytes: Buffer.byteLength(whole) });
    assert.equal(outputCutOf(`{"a":1}\n{"b":2}\n[... omitted 4 of 10 lines ...]`)?.jsonBroken, undefined);
    const broken = `{"a":1}\n{"b":…120 tokens truncated…"c":3}`;
    assert.deepEqual(outputCutOf(broken), { by: "middle", cutTokens: 120, deliveredBytes: Buffer.byteLength(broken), jsonBroken: true });
  });

  it("reads Claude Code's persisted output: original size and where it was saved", () => {
    const text = "<persisted-output>\nOutput too large (737.4KB). Full output saved to: /home/user/.claude/projects/-work-demo/s1/tool-results/b2b3okc4t.txt\n\nPreview (first 2KB):\n1\n2\n";
    assert.deepEqual(outputCutOf(text), { by: "persisted", originalBytes: 755098, deliveredBytes: Buffer.byteLength(text), savedTo: "/home/user/.claude/projects/-work-demo/s1/tool-results/b2b3okc4t.txt" });
    assert.equal(outputCutOf(text.replace("737.4KB", "1.2MB"))?.originalBytes, 1258291);
    assert.equal(outputCutOf(text.replace("737.4KB", "900B"))?.originalBytes, 900);
  });

  it("reads omitted lines", () => {
    const text = "a\nb\n[... omitted 120 of 200 lines ...]\nz";
    assert.deepEqual(outputCutOf(text), { by: "lines", omittedLines: 120, deliveredBytes: Buffer.byteLength(text) });
  });

  it("reads byte and character markers", () => {
    const bytes = "head of the output [truncated 5000 bytes]";
    assert.deepEqual(outputCutOf(bytes), { by: "marker", originalBytes: Buffer.byteLength(bytes) + 5000, deliveredBytes: Buffer.byteLength(bytes) });
    const chars = "head…[812 characters omitted]…tail";
    assert.deepEqual(outputCutOf(chars), { by: "marker", cutChars: 812, deliveredBytes: Buffer.byteLength(chars) });
  });

  it("text that only talks about truncation is not a cut", () => {
    for (const t of [
      "src/core/redact.ts:12: truncated: t.truncated || undefined",
      "src/adapters/codex.ts:  // 3 tokens truncated by the tokenizer",
      "Warning: truncated output",
      "The output was truncated (original token count unknown).",
      "persisted-output is a tag Claude Code uses",
      "[truncated bytes]",
    ]) assert.equal(outputCutOf(t), undefined, t);
  });

  it("an uncut output, JSON or not, has no cut", () => {
    assert.equal(outputCutOf(""), undefined);
    assert.equal(outputCutOf(rows(100)), undefined);
    assert.equal(outputCutOf("hello\nworld\n"), undefined);
  });

  it("a cut body that is not JSON is never jsonBroken", () => {
    const text = "Warning: truncated output (original token count: 5000)\nTotal output lines: 3\n\nline one\nline …40 tokens truncated… three";
    assert.equal(outputCutOf(text)?.jsonBroken, undefined);
  });

  it("is fast on a megabyte of uncut output", () => {
    const big = `${"x".repeat(80)}\n`.repeat(13_000);
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) assert.equal(outputCutOf(big), undefined);
    // About 0.3 ms each on an idle laptop; a loose bound so a loaded CI machine passes.
    assert.ok((performance.now() - t0) / 10 < 25);
  });
});
