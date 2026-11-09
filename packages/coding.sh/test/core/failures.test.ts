// Failed tool calls sorted into real, benign (an exit 1 that is an answer) and
// interrupted, on commands and outputs shaped like the ones Claude Code and
// Codex record (Claude Code's "Exit code N" first line, Codex's exitCode field).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyToolFailure, foldFailure, failureState, shellCommandOf, toolFailures } from "../../src/core/failures.ts";
import { buildSession, detectFlags, detectRepeatedToolFailure, FLAGS } from "../../src/core/sessions.ts";
import { sessionOutline } from "../../src/core/outline.ts";
import type { AgentEvent, EventKind } from "../../src/schema/index.ts";

type Row = [label: string, tool: string, command: string | undefined, output: string, exitCode: number | undefined, expect: string];

// expect: "real", "interrupted", or "benign:<reason>".
const TABLE: Row[] = [
  ["rg no match, Claude Code", "Bash", "rg foo src", "Exit code 1", undefined, "benign:no-match"],
  ["rg no match, Codex exit code", "Bash", "rg -n 'TODO' packages", "", 1, "benign:no-match"],
  ["grep no match, no exit code", "Bash", "grep -rn needle .", "", undefined, "benign:no-match"],
  ["grep -q probe", "Bash", "grep -q 'x' a.txt", "Error: Exit code 1", undefined, "benign:no-match"],
  ["git grep", "Bash", "git -C /work/demo grep -n parseArgs", "Exit code 1", undefined, "benign:no-match"],
  ["pipeline into grep", "Bash", "cat package.json | grep vitest", "Exit code 1", undefined, "benign:no-match"],
  ["piped test run into grep", "Bash", "npm test 2>&1 | grep FAIL", "Exit code 1", undefined, "benign:no-match"],
  ["cd then rg", "Bash", "cd /work/demo && rg 'old_name' src", "Exit code 1", undefined, "benign:no-match"],
  ["echo then grep prints", "Bash", "echo checking; grep -c foo a.txt", "Exit code 1\nchecking\n0", undefined, "benign:no-match"],
  ["pgrep", "Bash", "pgrep -f vite", "Exit code 1", undefined, "benign:no-match"],
  ["test -f", "Bash", "test -f dist/cli.mjs", "Exit code 1", undefined, "benign:probe"],
  ["[ -d ]", "Bash", "[ -d node_modules ] && echo yes", "Exit code 1", undefined, "benign:probe"],
  ["which", "Bash", "which bun", "Exit code 1\nbun not found", undefined, "benign:probe"],
  ["command -v", "Bash", "command -v pnpm >/dev/null", "Exit code 1", undefined, "benign:probe"],
  ["diff 1 with a diff", "Bash", "diff -u a.txt b.txt", "Exit code 1\n--- a.txt\n+++ b.txt\n@@ -1 +1 @@\n-a\n+b", undefined, "benign:files-differ"],
  ["cmp", "Bash", "cmp out.bin expected.bin", "Exit code 1\nout.bin expected.bin differ: byte 3, line 1", undefined, "benign:files-differ"],
  ["git diff --exit-code", "Bash", "git diff --exit-code -- src", "Exit code 1\ndiff --git a/src/a.ts b/src/a.ts", undefined, "benign:files-differ"],
  ["Codex bash -lc argv", "shell", undefined, "", 1, "benign:no-match"],
  ["search tool, no files", "Grep", undefined, "No files found", undefined, "benign:no-match"],
  ["vitest exit 1", "Bash", "npx vitest run", "Exit code 1\n FAIL  src/a.test.ts > adds\nAssertionError: expected 3 to be 4", undefined, "real"],
  ["vitest exit 1, no output", "Bash", "npx vitest run", "Exit code 1", undefined, "real"],
  ["npm test, Codex", "Bash", "npm test", "not ok 3 - adds", 1, "real"],
  ["rg exit 2 is an error", "Bash", "rg foo missing/", "Exit code 2\nrg: missing/: No such file or directory (os error 2)", undefined, "real"],
  ["grep on a missing file", "Bash", "grep foo nope.txt", "Exit code 2\ngrep: nope.txt: No such file or directory", undefined, "real"],
  ["grep then a build", "Bash", "grep -q x a.txt && make build", "Exit code 1", undefined, "real"],
  ["cat missing", "Bash", "cat missing.txt", "Exit code 1\ncat: missing.txt: No such file or directory", undefined, "real"],
  ["command not found", "Bash", "fooctl status", "Exit code 127\n(eval):1: command not found: fooctl", undefined, "real"],
  ["tsc errors", "Bash", "npx tsc --noEmit", "Exit code 2\nsrc/a.ts(3,1): error TS2304", undefined, "real"],
  ["timeout 143", "Bash", "npm run e2e", "Error: Exit code 143\nTerminated", undefined, "real"],
  ["explicit exit 1", "Bash", "test -f a || exit 1", "Exit code 1", undefined, "real"],
  ["grep with output and no exit code", "Bash", "grep foo a.txt", "grep: a.txt: Permission denied", undefined, "real"],
  ["Edit tool error", "Edit", undefined, "<tool_use_error>String to replace not found in file.</tool_use_error>", undefined, "real"],
  ["Ctrl-C", "Bash", "npm run dev", "Exit code 130", undefined, "interrupted"],
  ["request interrupted", "Bash", "sleep 100", "[Request interrupted by user for tool use]", undefined, "interrupted"],
  ["rejected prompt", "Write", undefined, "The user doesn't want to proceed with this tool use. The tool use was rejected.", undefined, "interrupted"],
];

const verdict = (f: { cls: string; reason?: string }) => (f.reason ? `${f.cls}:${f.reason}` : f.cls);

describe("classifyToolFailure", () => {
  for (const [label, tool, command, output, exitCode, expect] of TABLE) {
    it(`${label} → ${expect}`, () => {
      const input = label === "Codex bash -lc argv" ? { command: ["/bin/bash", "-lc", "rg -n needle src"] } : command !== undefined ? { command } : label === "search tool, no files" ? { pattern: "needle" } : { file_path: "/work/demo/a.ts" };
      assert.equal(verdict(classifyToolFailure(tool, input, output, exitCode)), expect);
    });
  }

  it("has at least 25 cases, real and benign both covered", () => {
    assert.ok(TABLE.length >= 25);
    assert.ok(TABLE.filter((r) => r[5] === "real").length >= 10);
    assert.ok(TABLE.filter((r) => r[5].startsWith("benign")).length >= 10);
  });

  it("an adapter's interrupted flag wins", () => {
    assert.equal(classifyToolFailure("Bash", { command: "npx vitest" }, "Exit code 1", undefined, { interrupted: true }).cls, "interrupted");
  });

  it("a REPL cell is not a shell command", () => {
    assert.equal(shellCommandOf("python_repl", { code: "await bash('rg foo')" }), undefined);
    assert.equal(classifyToolFailure("python_repl", { code: "await bash('rg foo')" }, "", 1).cls, "real");
    assert.equal(shellCommandOf("Bash", "rg foo"), "rg foo");
    assert.equal(shellCommandOf("Read", "a.txt"), undefined);
  });
});

let t = 0;
const ev = (kind: EventKind, payload: Record<string, unknown> = {}): AgentEvent => ({ id: `e${++t}`, v: 0, sessionId: "s", ts: 1000 + t * 10, agent: "claude-code", kind, payload });
/** A Bash call as Claude Code's hooks record it: the end leaves the input out. */
const call = (command: string, ok: boolean, output = "") => {
  const id = `tu${t + 1}`;
  return [ev("tool.start", { tool: "Bash", toolUseId: id, input: { command } }), ev("tool.end", { tool: "Bash", toolUseId: id, ok, output })];
};

describe("sessions fold", () => {
  it("toolErrors counts real failures; benign and interrupted ones get their own stats", () => {
    const events = [
      ev("user.message", { text: "rename parseArgs" }),
      ...call("rg parseArgs src", false, "Exit code 1"),
      ...call("rg parse_args src", false, "Exit code 1"),
      ...call("rg ParseArgs src", false, "Exit code 1"),
      ...call("cat missing.txt", false, "Exit code 1\ncat: missing.txt: No such file or directory"),
      ...call("npm run dev", false, "Exit code 130"),
      ...call("ls", true, "src"),
      ev("turn.end"),
    ];
    const s = buildSession(events);
    assert.equal(s.stats.toolErrors, 1);
    assert.equal(s.stats.benignToolErrors, 3);
    assert.equal(s.stats.interruptedToolCalls, 1);
    assert.equal(s.stats.toolCalls, 6);
    const [phase] = sessionOutline(events).phases;
    assert.equal(phase!.toolErrors, 1, "a phase counts real failures too");
  });

  it("leaves the new stats absent when every failure is real", () => {
    const s = buildSession([...call("npx vitest run", false, "Exit code 1\nFAIL a.test.ts")]);
    assert.equal(s.stats.toolErrors, 1);
    assert.equal("benignToolErrors" in s.stats, false);
    assert.equal("interruptedToolCalls" in s.stats, false);
  });

  it("three rg no-matches do not flag repeated-tool-failure; three failing npm test runs do", () => {
    const noMatch = [...call("rg foo src", false, "Exit code 1"), ...call("rg foo src", false, "Exit code 1"), ...call("rg foo src", false, "Exit code 1")];
    assert.equal(detectRepeatedToolFailure(noMatch), false);
    assert.equal(detectFlags(noMatch).includes(FLAGS.repeatedToolFailure), false);
    assert.equal(buildSession(noMatch).flags.includes(FLAGS.repeatedToolFailure), false);
    const failing = [...call("npm test", false, "Exit code 1\nnot ok 3"), ...call("npm test", false, "Exit code 1\nnot ok 3"), ...call("npm test", false, "Exit code 1\nnot ok 3")];
    assert.equal(detectRepeatedToolFailure(failing), true);
    assert.equal(buildSession(failing).flags.includes(FLAGS.repeatedToolFailure), true);
  });

  it("a no-match between two failing runs neither breaks nor extends the streak", () => {
    const events = [...call("npm test", false, "Exit code 1"), ...call("rg TODO", false, "Exit code 1"), ...call("npm test", false, "Exit code 1"), ...call("npm test", false, "Exit code 1")];
    assert.equal(detectRepeatedToolFailure(events), true);
  });

  it("an end seen twice (live and from the transcript) is classified both times", () => {
    const [start, end] = call("rg foo", false, "Exit code 1");
    const s = failureState();
    foldFailure(s, start!);
    assert.equal(foldFailure(s, end!)?.reason, "no-match");
    assert.equal(foldFailure(s, { ...end!, id: "copy" })?.reason, "no-match");
    assert.equal(toolFailures([start!, end!]).get(end!.id)?.cls, "benign");
  });

  it("the fold keeps a bounded number of started commands", () => {
    const s = failureState();
    for (let i = 0; i < 1000; i++) foldFailure(s, ev("tool.start", { tool: "Bash", toolUseId: `x${i}`, input: { command: `rg ${i}` } }));
    assert.ok(s.commands.size <= 256);
  });
});
