// `coding.sh judge slop` end to end under a throwaway home: a backfilled
// Claude Code session (diffs from its file.change events), a diff file, stored
// runs of a compare experiment (their work-tree diffs, per arm), and
// `judge grade` with an agent-slop spec and --diff. Exit 0 pass, 1 fail, 2 nothing to grade.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { openContext } from "../../src/core/context.ts";
import { fixtureRun } from "../../src/store/conformance.ts";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const CONFIG = fileURLToPath(new URL("../fixtures/adapters/claude-code/config", import.meta.url));
const SID = "11111111-2222-4333-8444-555555555555";
let root = "";
let env: NodeJS.ProcessEnv;

const run = (...args: string[]) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, encoding: "utf8", cwd: root });
const json = (...args: string[]) => {
  const r = run(...args, "--json");
  return { status: r.status, doc: JSON.parse(r.stdout) as Record<string, unknown> };
};
const added = (path: string, ...lines: string[]) => `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n`;

before(async () => {
  root = mkdtempSync(join(tmpdir(), "csh-slop-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  env = {
    ...process.env,
    ["HO" + "ME"]: home,
    USERPROFILE: home,
    CODING_SH_HOME: join(home, ".coding.sh"),
    CLAUDE_CONFIG_DIR: CONFIG,
    CODEX_HOME: join(root, "codex"),
    T3CODE_HOME: join(root, "t3"),
    CODING_SH_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
  };
  const r = run("ingest", "--backfill", "--agent", "claude-code");
  assert.equal(r.status, 0, r.stderr);
  writeFileSync(join(root, "dirty.diff"), added("src/a.ts", "const x = y as any;", 'console.log("x");', "// TODO: implement"));
  writeFileSync(join(root, "notes.txt"), "not a diff\n");
  // A compare experiment: arm b1 left an `as any`, arm b2 a clean change, and a superseded run that never counts.
  const ctx = await openContext({ env });
  try {
    const dirty = await ctx.blobs.put(added("src/a.ts", "export const f = (v) => v as any;"));
    const clean = await ctx.blobs.put(added("src/a.ts", "export const f = (v: number) => v + 1;"));
    await ctx.index.putRun(fixtureRun({ id: "run_A1", experimentId: "exp_T", bundleId: "b1", taskId: "t1", diffBlob: dirty }));
    await ctx.index.putRun(fixtureRun({ id: "run_B1", experimentId: "exp_T", bundleId: "b2", taskId: "t1", diffBlob: clean }));
    await ctx.index.putRun(fixtureRun({ id: "run_B0", experimentId: "exp_T", bundleId: "b2", taskId: "t1", diffBlob: dirty, superseded: true }));
  } finally {
    await ctx.close();
  }
});
after(() => rmSync(root, { recursive: true, force: true }));

describe("judge slop", () => {
  test("a captured session: graded on its file.change diffs, exit 0 when clean", () => {
    const r = run("judge", "slop", SID);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`^pass  agent-slop  score 1\\.00  session ${SID}  \\(0 errors, 0 warnings in 4 added lines\\)`));
    const { status, doc } = json("judge", "slop", "latest");
    assert.equal(status, 0);
    assert.deepEqual(doc.target, { kind: "session", id: SID, agent: "claude-code" });
    assert.deepEqual([doc.diffs, doc.addedLines, doc.findings], [2, 4, []]);
  });

  test("--diff: findings with rule, path and line; exit 1 on fail, 0 within --max-errors", () => {
    const r = run("judge", "slop", "--diff", "dirty.diff");
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^fail  agent-slop  score 0\.31  dirty\.diff  \(2 errors, 1 warning in 3 added lines\)/);
    assert.match(r.stdout, /error  as-any\s+src\/a\.ts:1  const x = y as any;/);
    assert.match(r.stdout, /warn   debug-print\s+src\/a\.ts:2/);
    assert.match(r.stdout, /error  todo-implement\s+src\/a\.ts:3/);
    assert.equal(run("judge", "slop", "--diff", "dirty.diff", "--max-errors", "2").status, 0);
    assert.equal(run("judge", "slop", "--diff", "dirty.diff", "--max-errors", "2", "--max-warnings", "0").status, 1);
    assert.equal(run("judge", "slop", "--diff", "dirty.diff", "--exclude", "as-any", "--exclude", "todo-implement").status, 0);
    const { doc } = json("judge", "slop", "--diff", "dirty.diff", "--rules", "as-any");
    assert.deepEqual(doc.rules, ["as-any"]);
    assert.deepEqual(doc.findings, [{ rule: "as-any", path: "src/a.ts", line: 1, text: "const x = y as any;", severity: "error" }]);
  });

  test("usage errors exit 2: not a diff, an unknown rule, a target and --diff together", () => {
    assert.equal(run("judge", "slop", "--diff", "notes.txt").status, 2);
    const bad = run("judge", "slop", "--diff", "dirty.diff", "--rules", "as-anything");
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /unknown slop rule "as-anything"/);
    assert.equal(run("judge", "slop", SID, "--diff", "dirty.diff").status, 2);
  });

  test("a compare experiment: per-arm rates from each run's stored diff; superseded runs left out", () => {
    const { status, doc } = json("judge", "slop", "exp_T");
    assert.equal(status, 1);
    const arms = doc.arms as { bundleId: string; runs: number; passed: number; errors: number }[];
    assert.deepEqual(
      arms.map((a) => [a.bundleId, a.runs, a.passed, a.errors]),
      [
        ["b1", 1, 0, 1],
        ["b2", 1, 1, 0],
      ],
    );
    const text = run("judge", "slop", "exp_T").stdout;
    assert.match(text, /^Agent slop in exp_T, by arm\n  b1  0\/1 runs pass  1 error, 0 warnings in 1 added line  100\.0 findings per 100 lines  mean score 0\.50\n  b2  1\/1 runs pass/);
    assert.match(text, /fail  agent-slop  score 0\.50  run run_A1 \(b1, task t1\)/);
  });

  test("one run by id; an experiment with no runs exits 2", () => {
    assert.equal(run("judge", "slop", "run_B1").status, 0);
    assert.equal(run("judge", "slop", "run_A1").status, 1);
    assert.equal(run("judge", "slop", "exp_none").status, 2);
  });

  test("--list-rules prints the catalog with defaults and opt-ins", () => {
    const { doc } = json("judge", "slop", "--list-rules");
    const rules = doc.rules as { id: string; default: boolean }[];
    assert.ok(rules.find((r) => r.id === "as-any")?.default);
    assert.equal(rules.find((r) => r.id === "unknown-param")?.default, false);
  });
});

describe("judge grade with agent-slop", () => {
  test("--diff stands in for --output; exit 1 on slop", () => {
    const r = run("judge", "grade", "--grader", '{"kind":"agent-slop"}', "--diff", "dirty.diff");
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout, /^fail  agent-slop  score 0\.31\n  2 errors, 1 warning in 3 added lines: as-any src\/a\.ts:1, todo-implement src\/a\.ts:3, debug-print src\/a\.ts:2 \(from the diff\)/);
    assert.equal(run("judge", "grade", "--grader", '{"kind":"agent-slop","maxErrors":2}', "--diff", "dirty.diff").status, 0);
  });
});
