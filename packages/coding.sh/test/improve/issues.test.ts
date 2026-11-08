// What to fix first: command grouping, failure records from events, and the
// ranking (recurring before one-off, then severity), on synthetic sessions.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSession } from "../../src/core/sessions.ts";
import type { Session } from "../../src/core/types.ts";
import { commandHead, errorKey, failureRecords, rankIssues, type FailureRecord } from "../../src/improve/issues.ts";
import { modelProvider, stepsFor } from "../../src/improve/report.ts";
import { claimSession, failingSession, retrySession, sessionEvents } from "../helpers-decision.ts";

const CWD = "/work/demo";
const T0 = 1_790_000_000_000;

function session(id: string, flags: string[], k = 0): Session {
  return { ...buildSession(claimSession(id, { cwd: CWD, startedAt: T0 + k * 3600_000 })), flags };
}

describe("commandHead", () => {
  it("keeps what names the command and drops its arguments", () => {
    assert.equal(commandHead("npm test"), "npm test");
    assert.equal(commandHead("npm run lint -- --fix"), "npm run lint");
    assert.equal(commandHead("cd packages/x && FOO=1 pytest -q tests/a.py"), "pytest");
    assert.equal(commandHead("node --test test/"), "node --test");
    assert.equal(commandHead("./node_modules/.bin/tsc --noEmit -p ."), "tsc");
    assert.equal(commandHead("git status 2>&1 | head"), "git status");
    assert.equal(commandHead("pnpm exec vitest run"), "pnpm exec vitest");
  });

  it("blurs numbers, ids and paths in an error key", () => {
    assert.equal(errorKey("Error: ENOENT: no such file /work/demo/a.js line 12"), errorKey("Error: ENOENT: no such file /tmp/b.js line 99"));
  });
});

describe("failureRecords", () => {
  it("groups a failing command by its head and marks failures before any edit", () => {
    const recs = failureRecords(retrySession("r", { cwd: CWD, startedAt: T0 }));
    assert.deepEqual(
      recs.map((r) => [r.key, r.beforeEdits]),
      [
        ["cmd:npm run biuld", true],
        ["cmd:npm run biuld", true],
      ],
    );
    assert.match(recs[0]!.sample!, /Missing script/);
  });

  it("a failing test run after an edit is not before edits", () => {
    const ev = sessionEvents("e", { cwd: CWD, startedAt: T0 }, [
      ["tool.start", { tool: "Edit", toolUseId: "e1", input: { file_path: `${CWD}/a.js` } }],
      ["tool.end", { tool: "Edit", toolUseId: "e1", ok: true }],
      ["tool.start", { tool: "Bash", toolUseId: "t1", input: { command: "npm test" } }],
      ["tool.end", { tool: "Bash", toolUseId: "t1", ok: false, output: "1 failing" }],
      ["test.result", { passed: 3, failed: 1 }],
    ]);
    const recs = failureRecords(ev);
    assert.equal(recs.length, 1, "the tool error and its test result are one failure");
    assert.equal(recs[0]!.key, "cmd:npm test");
    assert.equal(recs[0]!.tests, true);
    assert.equal(recs[0]!.beforeEdits, false);
  });
});

describe("rankIssues", () => {
  it("puts an issue seen in two or more sessions before a one-off, and words the fix line with the repo's test command", () => {
    const sessions = [session("a", ["no-verification"], 0), session("b", ["no-verification"], 1), session("c", ["premature-completion"], 2), session("d", [], 3)];
    const issues = rankIssues(sessions, new Map(), { testCommand: "npm test" });
    assert.deepEqual(
      issues.map((i) => [i.id, i.sessions]),
      [
        ["flag:no-verification", 2],
        ["flag:premature-completion", 1],
      ],
    );
    assert.ok(issues[1]!.severity.score > issues[0]!.severity.score, "the one-off is more severe, and still second");
    assert.equal(issues[0]!.rule, "Run `npm test` before you say you are done, and say what it printed.");
    assert.equal(issues[0]!.behavior, "unverified-claim");
    assert.equal(issues[0]!.analyzed, 4);
    assert.deepEqual(
      issues[0]!.examples.map((x) => x.sessionId),
      ["b", "a"],
      "newest first",
    );
  });

  it("ignores tags (a colon) and turns a command failing in two sessions into a failure issue", () => {
    const sessions = [session("a", ["skill:pdf"], 0), session("b", [], 1), session("c", [], 2)];
    const fail = (before: boolean): FailureRecord[] => [{ key: "cmd:npm test", label: "npm test", sample: "Cannot find module", tests: true, beforeEdits: before }];
    const issues = rankIssues(sessions, new Map([["a", fail(true)], ["b", fail(true)], ["c", []]]));
    assert.equal(issues.length, 1);
    const i = issues[0]!;
    assert.equal(i.id, "fails:cmd:npm test");
    assert.equal(i.title, "`npm test` already fails before the agent changes anything");
    assert.equal(i.beforeEdits, 2);
    assert.equal(i.severity.level, "high", "a broken test command is a defect of the setup");
    assert.equal(i.rule, undefined, "a broken command needs fixing, not a line");
  });

  it("a failure in one session only is not an issue", () => {
    const sessions = [session("a", [], 0), session("b", [], 1)];
    const issues = rankIssues(sessions, new Map([["a", failureRecords(failingSession("a", { cwd: CWD, startedAt: T0 }))]]));
    assert.deepEqual(issues, []);
  });
});

describe("stepsFor", () => {
  it("names the provider exp ab can call, and falls back to --dry-run with no key", () => {
    const [issue] = rankIssues([session("a", ["no-verification"], 0), session("b", ["no-verification"], 1)], new Map());
    assert.ok(issue?.behavior);
    const ab = (env: NodeJS.ProcessEnv) => stepsFor(issue, 1, { provider: modelProvider(env) }).find((s) => s.command.startsWith("coding.sh exp ab"))?.command;
    assert.equal(ab({ ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k" }), `coding.sh exp ab --behavior ${issue.behavior}`);
    assert.equal(ab({ OPENAI_API_KEY: "k" }), `coding.sh exp ab --behavior ${issue.behavior} --provider openai`);
    assert.equal(ab({ ANTHROPIC_API_KEY: " " }), `coding.sh exp ab --behavior ${issue.behavior} --dry-run`);
  });
});
