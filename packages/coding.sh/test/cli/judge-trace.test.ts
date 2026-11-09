// `coding.sh judge grade --trace` refuses to grade a trace whose tool calls did
// not reach the judge (AD-1, arXiv 2611.02676), under a throwaway home.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  test("an unrecognised JSONL of tool-call-looking records exits 2 with trace_incomplete", () => {
    const r = run("judge", "grade", "--grader", RAN_CAT, "--output", "out.txt", "--trace", "odd.jsonl", "--json");
    assert.equal(r.status, 2);
    const err = JSON.parse(r.stderr.trim().split("\n").at(-1) as string) as { reason: string; message: string; next: string[] };
    assert.equal(err.reason, "trace_incomplete");
    assert.match(err.message, /trace has 1 tool call\(s\) in unknown records but 0 reached the judge/);
    assert.deepEqual(err.next, ["pass --allow-partial-trace to grade anyway"]);
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

  test("a plain-text trace keeps today's behaviour", () => {
    const r = run("judge", "grade", "--grader", JSON.stringify({ kind: "contains", value: "done" }), "--output", "out.txt", "--trace", "plain.txt", "--json");
    assert.equal(r.status, 0, r.stderr);
    assert.equal((JSON.parse(r.stdout) as { traceCoverage: { records: number; ok: boolean } }).traceCoverage.ok, true);
  });
});
