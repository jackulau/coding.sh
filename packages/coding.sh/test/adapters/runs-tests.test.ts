// A test result comes only from a command that runs tests: a command that prints a log (tail,
// grep, cat, sed, Get-Content, …) whose text holds a runner's summary gives none.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cursor } from "../../src/adapters/cursor.ts";
import { Emitter, emitDerived, runsTests } from "../../src/adapters/_shared/index.ts";
import { testResultFor } from "../../src/adapters/more/_util.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { testCtx } from "./_helpers.ts";

const OUTPUT = "running 4 tests\ntest a ... ok\ntest b ... FAILED\n\ntest result: FAILED. 3 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out\n";

const READS = [
  "tail -50 ci.log",
  'grep -n "test result" ci.log',
  "cat out.txt",
  "sed -n 1,80p log",
  "gh run view 123 --log-failed | grep -A3 FAIL",
  "Get-Content .\\test.log -Tail 40",
  "type test.log",
  "Select-String -Path log -Pattern fail",
  "findstr /i fail log",
  'grep -rn "npm test" docs',
  "tail -40 vitest.log",
  "cd pkg && cat cargo-test.log",
  "echo 'cargo test' && cat log",
  'bash -c "tail -50 ci.log"',
];
const RUNS = [
  "npm test 2>&1 | tail -40",
  "cd pkg && npx vitest run | tee out.txt",
  'cargo test 2>&1 | grep "test result"',
  'powershell -NoProfile -Command "npm test"',
  "pwsh -c npm test",
  "bash -lc 'cd pkg && cargo test'",
  'cmd /c "npm run test"',
  "CI=1 timeout 120 npm test",
  "time cargo nextest run",
  "(cd pkg && npm test)",
  "git status\nnpm run check",
  'node --no-warnings --test "test/**/*.test.ts"',
  "pnpm --filter web test",
];

async function viaEmitDerived(command: string): Promise<AgentEvent[]> {
  const em = new Emitter(testCtx().ctx, { agent: "claude-code", sessionId: "s1", ts: 1 }, ["t"]);
  await emitDerived(em, { tool: "Bash", toolUseId: "toolu_1", input: { command }, output: OUTPUT, ok: true });
  return em.events.filter((e) => e.kind === "test.result");
}

async function viaCursor(command: string): Promise<AgentEvent[]> {
  const raw = { conversation_id: "c1", hook_event_name: "postToolUse", tool_name: "Shell", tool_use_id: "call_1", tool_input: { command }, tool_output: OUTPUT, duration: 1000, workspace_roots: ["/work/demo"] };
  const events = await cursor.normalize({ v: 0, agent: "cursor", event: "postToolUse", ts: 1_793_527_200_000, pid: 1, ppid: 0, cwd: "/work/demo", raw }, testCtx().ctx);
  return events.filter((e) => e.kind === "test.result");
}

describe("runsTests", () => {
  for (const c of READS) it(`no: ${c}`, () => assert.equal(runsTests(c), false));
  for (const c of RUNS) it(`yes: ${c}`, () => assert.equal(runsTests(c), true));
  it("nothing for no command", () => {
    assert.equal(runsTests(undefined), false);
    assert.equal(runsTests(""), false);
  });
});

describe("a test result needs a command that runs tests", () => {
  it("shared tool calls (Claude Code, Codex, T3 Code, OpenCode)", async () => {
    for (const c of READS) assert.deepEqual(await viaEmitDerived(c), [], c);
    for (const c of RUNS) {
      const got = await viaEmitDerived(c);
      assert.equal(got.length, 1, c);
      assert.deepEqual([got[0]!.payload.runner, got[0]!.payload.passed, got[0]!.payload.failed], ["cargo", 3, 1], c);
    }
  });

  it("Cursor's postToolUse", async () => {
    for (const c of READS) assert.deepEqual(await viaCursor(c), [], c);
    for (const c of RUNS) assert.equal((await viaCursor(c)).length, 1, c);
  });

  it("the more/ adapters (testResultFor)", () => {
    for (const c of READS) assert.equal(testResultFor({ command: c }, OUTPUT), undefined, c);
    for (const c of RUNS) assert.equal(testResultFor({ command: c }, OUTPUT)?.failed, 1, c);
  });
});
