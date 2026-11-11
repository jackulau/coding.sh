// `coding.sh judge grade --trace` refuses to grade a trace whose tool calls did
// not reach the judge (AD-1, arXiv 2611.02676), under a throwaway home.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const CODEX = fileURLToPath(new URL("../fixtures/judge/trace/codex-exec.jsonl", import.meta.url));
let root = "";
let env: NodeJS.ProcessEnv;

const run = (...args: string[]) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, encoding: "utf8", cwd: root });
const RAN_CAT = JSON.stringify({ kind: "llm-checklist", name: "ran", items: [{ id: "cat", question: "Ran cat?", check: { name: "ran-command", args: { command: "cat missing.txt" } } }] });
const RESPONSES = fileURLToPath(new URL("../fixtures/judge/trace/openai-responses.json", import.meta.url));
const RAN_CAT_OK = JSON.stringify({ kind: "llm-checklist", name: "ran-ok", items: [{ id: "cat", question: "Ran cat and it worked?", check: { name: "ran-command", args: { command: "cat missing.txt", ok: true } } }] });

before(() => {
  root = mkdtempSync(join(tmpdir(), "csh-judge-trace-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  env = {
    ...process.env,
    ["HO" + "ME"]: home,
    USERPROFILE: home,
    CODING_SH_HOME: join(home, ".coding.sh"),
    CLAUDE_CONFIG_DIR: join(root, "claude"),
    CODEX_HOME: join(root, "codex"),
    CODING_SH_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
  };
  delete env.CODING_SH_AGENT_OUTPUT;
  delete env.CODING_SH_AGENT_STDOUT;
  writeFileSync(join(root, "out.txt"), "done\n");
  writeFileSync(
    join(root, "odd.jsonl"),
    [{ event: "tool_call", name: "bash" }, { type: "toolCall", id: "x1", name: "bash", args: { cmd: "cat missing.txt" } }, { event: "tool_result", output: "no such file" }].map((o) => JSON.stringify(o)).join("\n"),
  );
  writeFileSync(join(root, "plain.txt"), "the agent ran cat missing.txt\n");
  writeFileSync(join(root, "codex-trunc.jsonl"), readFileSync(CODEX, "utf8").slice(0, 900));
  writeFileSync(
    join(root, "mixed.jsonl"),
    [
      { type: "assistant", message: { content: [{ type: "tool_use", id: "u1", name: "Bash", input: { command: "cat missing.txt" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "u1", is_error: true, content: "No such file" }] } },
      { type: "item.completed", item: { id: "i1", type: "command_execution", command: "ls", aggregated_output: "a", exit_code: 0, status: "completed" } },
      { event: "step", name: "bash", detail: "npm run build" },
    ].map((o) => JSON.stringify(o)).join("\n"),
  );
  const chat = (result: string) =>
    JSON.stringify({
      model: "gpt-5",
      messages: [
        { role: "user", content: "Run the tests." },
        { role: "assistant", content: null, tool_calls: [{ id: "call_a1", type: "function", function: { name: "shell", arguments: '{"command":"npm test"}' } }] },
        { role: "tool", tool_call_id: "call_a1", content: result },
        { role: "assistant", content: "The tests pass." },
      ],
    });
  writeFileSync(join(root, "chat-fail.json"), chat("npm ERR! Test failed. 1 failing: sum(2, 2) expected 4, got 5\nexit code 1"));
  writeFileSync(join(root, "chat-silent.json"), chat("npm ERR! Test failed. 1 failing: sum(2, 2) expected 4, got 5"));
});
after(() => rmSync(root, { recursive: true, force: true }));

describe("judge grade --trace", () => {
  test("a codex exec --json trace is read: ran-command answers from it, and --json carries traceCoverage", () => {
    const r = run("judge", "grade", "--grader", RAN_CAT, "--output", "out.txt", "--trace", CODEX, "--json");
    assert.equal(r.status, 0, r.stderr);
    const doc = JSON.parse(r.stdout) as { pass: boolean; traceCoverage: { format: string; sourceCalls: number; toolStarts: number; ok: boolean } };
    assert.equal(doc.pass, true);
    assert.deepEqual([doc.traceCoverage.format, doc.traceCoverage.sourceCalls, doc.traceCoverage.toolStarts, doc.traceCoverage.ok], ["codex-exec", 3, 3, true]);
    assert.equal(run("judge", "grade", "--grader", RAN_CAT_OK, "--output", "out.txt", "--trace", CODEX).status, 1, "cat failed");
  });

  // qa:eval-1: a result with no ok field used to count as success.
  test("ran-command with ok never passes a failed command on OpenAI Responses and chat traces", () => {
    const item = (command: string) => JSON.stringify({ kind: "llm-checklist", name: "rules", items: [{ id: "cmd-ok", question: `${command} succeeded?`, check: { name: "ran-command", args: { command, ok: true } } }] });
    type Doc = { pass: boolean; score: number; items: { answer: boolean | null; explanation: string }[] };
    const grade = (command: string, trace: string) => {
      const r = run("judge", "grade", "--grader", item(command), "--output", "out.txt", "--trace", trace, "--json");
      return { status: r.status, doc: JSON.parse(r.stdout) as Doc };
    };
    const cat = grade("cat missing.txt", RESPONSES);
    assert.equal(cat.status, 1);
    assert.deepEqual([cat.doc.pass, cat.doc.score, cat.doc.items[0]!.answer], [false, 0, false]);
    assert.match(cat.doc.items[0]!.explanation, /ran cat missing\.txt but it never succeeded/);
    // A call the output says exited 0 still passes.
    const echo = grade("echo hello from demo", RESPONSES);
    assert.deepEqual([echo.status, echo.doc.pass, echo.doc.items[0]!.answer], [0, true, true]);
    const failed = grade("npm test", "chat-fail.json");
    assert.equal(failed.status, 1);
    assert.deepEqual([failed.doc.pass, failed.doc.items[0]!.answer], [false, false]);
    // No exit code in the result: the trace does not say, so the item is n/a and nothing passes.
    const silent = grade("npm test", "chat-silent.json");
    assert.equal(silent.status, 1);
    assert.deepEqual([silent.doc.pass, silent.doc.items[0]!.answer], [false, null]);
    assert.match(silent.doc.items[0]!.explanation, /does not say whether it succeeded/);
  });

  test("an unrecognised JSONL of tool-call-looking records exits 2 with trace_incomplete", () => {
    const r = run("judge", "grade", "--grader", RAN_CAT, "--output", "out.txt", "--trace", "odd.jsonl", "--json");
    assert.equal(r.status, 2);
    const err = JSON.parse(r.stderr.trim().split("\n").at(-1) as string) as { reason: string; message: string; next: string[] };
    assert.equal(err.reason, "trace_incomplete");
    assert.match(err.message, /trace has 1 tool call\(s\) in unknown records but 0 reached the judge/);
    assert.deepEqual(err.next, ["Did you mean:", "--allow-partial-trace"]);
  });

  test("--allow-partial-trace grades anyway (exit 0/1) and warns", () => {
    const r = run("judge", "grade", "--grader", RAN_CAT, "--output", "out.txt", "--trace", "odd.jsonl", "--allow-partial-trace");
    // ran-command has no tool calls to read: N/A, which fails a checklist with nothing applied.
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /incomplete trace graded anyway/);
    const j = run("judge", "grade", "--grader", JSON.stringify({ kind: "contains", value: "done" }), "--output", "out.txt", "--trace", "odd.jsonl", "--allow-partial-trace", "--json");
    assert.equal(j.status, 0, j.stderr);
    assert.equal((JSON.parse(j.stdout) as { traceCoverage: { ok: boolean } }).traceCoverage.ok, false);
  });

  // qa:eval-6: these three graded as if the trace were whole (exit 0 or 1).
  const refused = (r: ReturnType<typeof run>) => {
    assert.equal(r.status, 2, r.stdout + r.stderr);
    const err = JSON.parse(r.stderr.trim().split("\n").at(-1) as string) as { reason: string; message: string };
    assert.equal(err.reason, "trace_incomplete");
    return err.message;
  };

  test("a trace cut mid-line exits 2 with trace_incomplete; --allow-partial-trace grades it", () => {
    assert.match(refused(run("judge", "grade", "--grader", RAN_CAT, "--output", "out.txt", "--trace", "codex-trunc.jsonl", "--json")), /incomplete trace: 1 line\(s\) are not whole JSON/);
    const warned = run("judge", "grade", "--grader", RAN_CAT, "--output", "out.txt", "--trace", "codex-trunc.jsonl", "--allow-partial-trace");
    assert.equal(warned.status, 0, warned.stderr);
    assert.match(warned.stderr, /incomplete trace graded anyway: 1 line\(s\)/);
    const r = run("judge", "grade", "--grader", RAN_CAT, "--output", "out.txt", "--trace", "codex-trunc.jsonl", "--allow-partial-trace", "--json");
    assert.equal(r.status, 0, r.stderr);
    const cov = (JSON.parse(r.stdout) as { traceCoverage: { records: number; unparsedLines: number; unreadRecords: number; ok: boolean } }).traceCoverage;
    assert.deepEqual([cov.records, cov.unparsedLines, cov.unreadRecords, cov.ok], [6, 1, 0, false]);
  });

  test("two formats plus an unknown record exit 2 with trace_incomplete", () => {
    assert.match(refused(run("judge", "grade", "--grader", RAN_CAT, "--output", "out.txt", "--trace", "mixed.jsonl", "--json")), /1 record\(s\) with no type, role or kind/);
  });

  test("a plain-text file named with --trace is an unknown format: exit 2, not 'no trace'", () => {
    for (const grader of [RAN_CAT, JSON.stringify({ kind: "contains", value: "done" })]) {
      assert.match(refused(run("judge", "grade", "--grader", grader, "--output", "out.txt", "--trace", "plain.txt", "--json")), /incomplete trace: the file has no JSON records \(not a trace format the judge reads\)/);
    }
    const r = run("judge", "grade", "--grader", JSON.stringify({ kind: "contains", value: "done" }), "--output", "out.txt", "--trace", "plain.txt", "--allow-partial-trace", "--json");
    assert.equal(r.status, 0, r.stderr);
  });

  test("the default trace, an agent's plain-text stdout, is still no trace; a cut one is refused", () => {
    const withStdout = (file: string, ...args: string[]) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env: { ...env, CODING_SH_AGENT_STDOUT: join(root, file) }, encoding: "utf8", cwd: root });
    const r = withStdout("plain.txt", "judge", "grade", "--grader", JSON.stringify({ kind: "contains", value: "done" }), "--output", "out.txt", "--json");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "");
    const na = withStdout("plain.txt", "judge", "grade", "--grader", RAN_CAT, "--output", "out.txt");
    assert.equal(na.status, 1, na.stderr);
    assert.match(na.stdout, /n\/a\s+cat: no trace/);
    refused(withStdout("codex-trunc.jsonl", "judge", "grade", "--grader", RAN_CAT, "--output", "out.txt", "--json"));
  });
});
