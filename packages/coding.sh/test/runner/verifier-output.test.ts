import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRedactor } from "../../src/core/redact.ts";
import type { RunResult } from "../../src/core/types.ts";
import { cleanStream, failedRuns, outputTail, renderFailedRuns, VERIFIER_OUTPUT_CHARS, verifierOutput } from "../../src/runner/verifier-output.ts";

const KEY = "sk-ant-" + "api03-" + "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const r = createRedactor();

describe("verifier output", () => {
  it("drops colour codes and progress redraws, and trailing blank lines", () => {
    const s = "\x1b[1m\x1b[31mFAIL\x1b[0m test/add.test.js\r\n  ✕ adds \x1b]8;;file:///x\x07link\x1b]8;;\x07\n10%\r50%\r100%\r\n\n\n";
    assert.equal(cleanStream(s, r), "FAIL test/add.test.js\n  ✕ adds link\n100%");
  });

  it("redacts secrets before it trims, so a key cut by the trim is not left half-visible", () => {
    // One long line: the trim cuts into the key, and no line start is near the cut.
    const body = `token ${KEY} ` + "x".repeat(VERIFIER_OUTPUT_CHARS - 20);
    const out = cleanStream(body, r);
    assert.doesNotMatch(out, /sk-ant|0123456789/);
    assert.ok(out.length <= VERIFIER_OUTPUT_CHARS + 2);
    const short = cleanStream(`expected 5, got -1\nAPI key ${KEY}`, r);
    assert.equal(short, "expected 5, got -1\nAPI key [redacted:anthropic-key]");
  });

  it("keeps the end of a long stream and starts it on a whole line", () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");
    const out = cleanStream(lines, r);
    assert.ok(out.length <= VERIFIER_OUTPUT_CHARS + 2, String(out.length));
    assert.match(out, /^…\nline \d+\n/);
    assert.match(out, /line 1999$/);
  });

  it("drops the first line of a tail that filled exec's buffer, where a secret may have been cut in two", () => {
    // Multi-byte text: 8 KB of it is fewer than 4096 characters, so the cut line would survive the trim.
    const cut = KEY.slice(12) + " leaked?\n" + "€".repeat(2800) + "\nFAIL";
    assert.ok(Buffer.byteLength(cut) >= 8192);
    const o = verifierOutput({ stdoutTail: cut, stderrTail: "" });
    assert.doesNotMatch(o?.stdout ?? "", /0123456789|leaked/);
    assert.match(o?.stdout ?? "", /\nFAIL$/);
    assert.equal(verifierOutput({ stdoutTail: `${KEY.slice(12)} short`, stderrTail: "" })?.stdout, `${KEY.slice(12)} short`, "a tail under the buffer size is whole");
  });

  it("uses the capture redactor's own patterns", () => {
    const custom = createRedactor({ redact: ["secrets"], patterns: ["ACME-\\d{6}"] });
    assert.equal(verifierOutput({ stdoutTail: "order ACME-123456 failed", stderrTail: "" }, custom)?.stdout, "order [redacted:pattern] failed");
  });

  it("is absent when the verifier printed nothing, and keeps only the streams that have text", () => {
    assert.equal(verifierOutput({ stdoutTail: "", stderrTail: " \n\x1b[0m\n" }), undefined);
    assert.deepEqual(verifierOutput({ stdoutTail: "", stderrTail: "boom\n" }), { stderr: "boom" });
  });

  it("lists failed runs with their output, leaving out cancelled, superseded and infrastructure failures", () => {
    const base = { bundleId: "b1", agent: {} as RunResult["agent"], endedAt: 0 };
    const runs: RunResult[] = [
      { ...base, id: "r1", taskId: "t1", attempt: 1, pass: true, verifierExit: 0, startedAt: 1 },
      { ...base, id: "r2", taskId: "t1", attempt: 2, pass: false, verifierExit: 1, startedAt: 2, verifierOutput: { stdout: "a\nb\nc", stderr: "AssertionError: 4 !== 5" } },
      { ...base, id: "r3", taskId: "t2", attempt: 1, pass: false, verifierExit: null, startedAt: 3, cancelled: true },
      { ...base, id: "r4", taskId: "t2", attempt: 1, pass: false, verifierExit: null, startedAt: 4, infra: "rate-limit" },
      { ...base, id: "r5", taskId: "t2", attempt: 1, pass: false, verifierExit: 1, startedAt: 5, error: "agent timed out" },
    ];
    const f = failedRuns(runs);
    assert.deepEqual(f.map((x) => x.runId), ["r2", "r5"]);
    assert.deepEqual(f[0]!.verifierOutput, { stdout: "a\nb\nc", stderr: "AssertionError: 4 !== 5" });
    assert.equal(f[1]!.error, "agent timed out");
    assert.equal(f[1]!.verifierOutput, undefined);
    assert.deepEqual(outputTail(f[0]!.verifierOutput, 2), ["c", "AssertionError: 4 !== 5"]);
    const text = renderFailedRuns(f, { names: (id) => (id === "t1" ? "adds" : id), lines: 2 }).join("\n");
    assert.match(text, /^Verifier output of failed runs \(last 2 lines\):\n {2}adds · attempt 2 {2}exit 1 · r2\n {4}│ c\n {4}│ AssertionError: 4 !== 5$/);
    assert.deepEqual(renderFailedRuns([f[1]!]), [], "no block when no failed run kept output");
  });
});
