// What a shell call's text can't claim: a test result picked from a pytest or cargo line inside
// other output (an assertion message, a diff, a printed fixture), a test run from a log's file
// name or a heredoc's body, and file edits a git branch switch or another process made.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Emitter, emitDerived, fileChangesOf, parseTestOutput, runsElsewhere, runsTests, writesNothing } from "../../src/adapters/_shared/index.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { testCtx } from "./_helpers.ts";

async function derived(command: string, output: unknown): Promise<AgentEvent[]> {
  const em = new Emitter(testCtx().ctx, { agent: "claude-code", sessionId: "s1", ts: 1 }, ["t"]);
  await emitDerived(em, { tool: "Bash", toolUseId: "toolu_1", input: { command }, output, ok: true, cwd: "/work/demo" });
  return em.events;
}
const results = (events: AgentEvent[]) => events.filter((e) => e.kind === "test.result").map((e) => [e.payload.runner, e.payload.passed, e.payload.failed]);

describe("a test result comes from the runner's own summary", () => {
  it("node --test whose failing assertion prints a pytest line is node:test 1 passed, 5 failed", async () => {
    const out = "✖ parses a pytest line (1.2ms)\n  AssertionError [ERR_ASSERTION]: 2 passed in 0.01s\nℹ tests 6\nℹ pass 1\nℹ fail 5\nℹ duration_ms 80\n";
    assert.deepEqual(results(await derived("node --no-warnings --test test/a.test.ts 2>&1 | tail -12", out)), [["node:test", 1, 5]]);
  });

  it("a pytest count inside other text is no pytest summary", () => {
    assert.equal(parseTestOutput("  AssertionError: expected 2 passed in 0.01s\n", "npm test"), undefined);
    assert.equal(parseTestOutput("+    \"2 passed in 0.01s\",\n", "npm test"), undefined, "a diff line");
    assert.deepEqual(parseTestOutput("..\n2 passed in 0.01s\n", "npm test"), { runner: "pytest", passed: 2, failed: 0 }, "a bare summary still counts");
  });

  it("a cargo fixture line a command prints is no cargo summary", async () => {
    const fixture = '    ["cargo", "cargo test", "test result: FAILED. 5 passed; 1 failed; 2 ignored; 0 measured"],\n';
    assert.equal(parseTestOutput(fixture, "cargo test"), undefined);
    // An edit script, then node --test: the result is node's.
    const cmd = "python3 - <<'EOF'\nprint(open('test/util.test.ts').read())\nEOF\nnode --test test/util.test.ts | tail -5";
    assert.deepEqual(results(await derived(cmd, `${fixture}ℹ tests 4\nℹ pass 4\nℹ fail 0\n`)), [["node:test", 4, 0]]);
  });
});

describe("runsTests: a heredoc's body and a log's name run nothing", () => {
  it("a script fed by a heredoc runs no tests, even when cut off", () => {
    const body = "python3 -I - <<'EOF'\nimport io\ncases = [\ncargo test\nnpm test\n";
    assert.equal(runsTests(body), false, "cut off inside its body");
    assert.equal(runsTests(`${body}]\nEOF`), false, "closed");
    assert.equal(runsTests(`${body}]\nEOF\nnpm test`), true, "a test run after it");
    assert.equal(runsTests("bash <<'EOF'\nnpm test\nEOF"), true, "a shell reads its heredoc");
  });

  it("waiting on a log and reading it runs nothing, whatever the log is called", () => {
    for (const log of ["D:/cs/s6/ad2028-tsc.log", "/tmp/tsc.log", "/tmp/t.log"]) {
      const cmd = `timeout 260 bash -c 'until grep -qs "^rc=" ${log}; do sleep 15; done'; grep -E "^# (tests|pass|fail)|^rc=|^not ok" ${log}; cat ${log} | tail -20`;
      assert.equal(runsTests(cmd), false, log);
    }
    assert.equal(runsTests("mytool --log D:/cs/s6/ad2028-tsc.log"), false);
    assert.equal(runsTests("until npm test; do sleep 1; done"), true);
    assert.equal(runsTests("if true; then npx tsc --noEmit; fi"), true);
  });

  it("no test.result for the wait-and-read command", async () => {
    const cmd = "timeout 260 bash -c 'until grep -qs \"^rc=\" D:/cs/s6/ad2028-tsc.log; do sleep 15; done'; cat D:/cs/s6/ad2028-tsc.log | tail -20";
    assert.deepEqual(results(await derived(cmd, "not ok 2 - x\n# tests 537\n# pass 536\n# fail 1\nrc=1\n")), []);
  });
});

describe("a shell call's dirty-tree diff holds only its own edits", () => {
  const files = (...paths: string[]) => ({ bashEditDiff: { files: paths.map((p) => ({ filePath: `/work/demo/${p}`, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }] })), moreFiles: 0 } });
  const changed = (command: string, ...paths: string[]) => fileChangesOf("Bash", { command }, files(...paths), "/work/demo").map((c) => c.path);

  it("a branch switch, checkout, merge or rebase edits nothing", () => {
    for (const cmd of [
      "git checkout -b dogfood/sdk origin/main 2>&1 && git log --oneline -3 && git status",
      "git switch -c fix/x origin/main && git status --short | head",
      "git status --porcelain | head -5; git merge --ff-only origin/main 2>&1 | tail -3",
      "git checkout --detach cfac3e8f 2>&1 | tail -3",
      "R=/work/demo; cd $R; git rebase origin/main 2>&1 | tail -8",
    ]) assert.deepEqual(changed(cmd, "AGENTS.md", "src/a.ts"), [], cmd);
  });

  it("a command that writes nothing, or runs in another directory, edits nothing here", () => {
    assert.ok(writesNothing("git fetch origin main 2>&1 | tail -5; git log --oneline -3 > /dev/null"));
    assert.ok(writesNothing("export GH_TOKEN=\"$(gh auth token)\" && git -c credential.helper= -c credential.helper='!f() { echo x; }; f' fetch origin main 2>&1 | tail"));
    assert.ok(!writesNothing("git log > log.txt"));
    assert.ok(!writesNothing("npm run build"));
    assert.deepEqual(changed("git diff --stat a..b | tail -3", "src/a.ts"), []);
    assert.ok(runsElsewhere("cd /d/cs/s4/hookfix/packages/x && node probe.mjs", "C:/Projects/demo"));
    assert.ok(!runsElsewhere("cd /c/projects/demo/packages/x && node probe.mjs", "C:\\Projects\\demo"), "Git Bash form of a folder inside");
    assert.ok(!runsElsewhere("cd packages/x && node probe.mjs", "/work/demo"));
    assert.deepEqual(changed("cd /other/checkout && node gen.mjs", "src/a.ts"), []);
  });

  it("files a command names or a script writes stay", () => {
    assert.deepEqual(changed("git checkout -- src/a.ts", "src/a.ts"), ["src/a.ts"]);
    assert.deepEqual(changed("node scripts/gen.ts && git diff --stat", "docs/cli.md"), ["docs/cli.md"]);
    assert.deepEqual(changed("sed -i s/a/b/ notes.txt", "notes.txt"), ["notes.txt"]);
    assert.deepEqual(changed("cd /work/demo/pkg && npm run build", "pkg/out.js"), ["pkg/out.js"]);
  });

  it("emitDerived stores no file.change for a branch switch", async () => {
    const events = await derived("git switch -c fix/x origin/main", files("AGENTS.md", "src/a.ts"));
    assert.deepEqual(events.filter((e) => e.kind === "file.change"), []);
  });
});
