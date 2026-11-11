// `coding.sh refine mine` through src/cli/main.ts with a temp HOME: a repo with
// a suite under evals/, and a store seeded with that suite's eval runs the way
// the runner leaves them (each session in a scratch directory under the
// coding.sh home, each task starting from the shared empty tree).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { EvalTask } from "../../src/core/types.ts";
import { importTaskDir } from "../../src/eval/task.ts";
import { putSession, sessionEvents } from "../helpers-decision.ts";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const DAY = 86_400_000;
let root = "";
let home = "";
let repo = "";
let other = "";
let env: NodeJS.ProcessEnv = {};

function cli(cwd: string, ...args: string[]) {
  const r = spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { cwd, env, encoding: "utf8", timeout: 120_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** A hand-written suite task with no repo/ dir and no start: `eval run` starts it from the empty tree. */
function writeTask(suiteDir: string, name: string): string {
  const dir = join(suiteDir, "tasks", name);
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(join(dir, "task.json"), `${JSON.stringify({ name, verifier: { command: "node check.mjs", timeoutMs: 60_000 } }, null, 2)}\n`);
  writeFileSync(join(dir, "instruction.md"), `Do ${name}.\n`);
  writeFileSync(join(dir, "tests", "check.mjs"), "process.exit(1);\n");
  return dir;
}

function writeSuite(repoDir: string, suite: string, tasks: string[]): string[] {
  const dir = join(repoDir, "evals", suite);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "suite.json"), `${JSON.stringify({ name: suite, purpose: "regression", trials: 2, tasks: "tasks" }, null, 2)}\n`);
  return tasks.map((t) => writeTask(dir, t));
}

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-refine-mine-")));
  home = join(root, "home");
  repo = join(root, "repo");
  other = join(root, "other");
  for (const d of [home, repo, other]) mkdirSync(d);
  env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, CODING_SH_HOME: join(home, ".coding.sh"), XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"), NO_COLOR: "1", CODING_SH_NO_UPDATE_CHECK: "1" };
  for (const d of [repo, other]) assert.equal(spawnSync("git", ["init", "-q"], { cwd: d, env }).status, 0);
  const mine = writeSuite(repo, "chores", ["chore-0", "chore-1"]);
  const theirs = writeSuite(other, "billing", ["invoice-0"]);
  // A suite that can't be read must not stop the command.
  mkdirSync(join(repo, "evals", "broken"));
  writeFileSync(join(repo, "evals", "broken", "suite.json"), "{ not json");

  const { openContext } = await import("../../src/core/context.ts");
  const ctx = await openContext({ env, cwd: repo });
  try {
    // What `eval run` stores: the task dir as imported, starting from the empty tree under the coding.sh home.
    const start: EvalTask["start"] = { repoRoot: join(home, ".coding.sh", "repos", "empty-start"), snapshot: "0".repeat(40), head: "0".repeat(40) };
    const t0 = Date.now() - 3 * DAY;
    let k = 0;
    for (const [dir, suite] of [...mine.map((d) => [d, "chores"] as const), ...theirs.map((d) => [d, "billing"] as const)]) {
      const imported = await importTaskDir(dir, ctx.blobs, { start });
      const task = { ...imported, tags: [`suite:${suite}`] };
      await ctx.index.putTask(task);
      // Two failed attempts on different days, and a passing one that went further.
      for (const [day, pass] of [[0, true], [0, false], [1, false]] as const) {
        const id = `run_${String(k).padStart(3, "0")}`;
        const sid = `${suite}-s${k++}`;
        const startedAt = t0 + day * DAY + k * 1000;
        const tools = pass ? ["Read", "Write", "Bash"] : ["Read"];
        await putSession(ctx.index, sessionEvents(sid, { cwd: join(home, ".coding.sh", "runs", id, "work"), startedAt, runId: id }, [["session.start", {}], ["user.message", { text: task.instruction }], ...tools.map((t, i) => ["tool.start", { tool: t, toolUseId: `${sid}-${i}` }] as ["tool.start", Record<string, unknown>]), ["assistant.message", { text: "Done." }]]), { runId: id });
        await ctx.index.putRun({ id, experimentId: `exp_${suite}`, taskId: task.id, bundleId: "b".repeat(64), attempt: k, sessionId: sid, pass, verifierExit: pass ? 0 : 1, agent: { exitCode: 0, timedOut: false, durationMs: 100, stdoutTail: "", stderrTail: "" }, startedAt, endedAt: startedAt + 100 });
      }
    }
  } finally {
    await ctx.close();
  }
});
after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

interface Mined {
  repo: string;
  analyzed: number;
  evalRuns: number;
  findings: { kind: string; count: number; label: string; examples: { sessionId: string }[] }[];
}

describe("refine mine", () => {
  it("reports this repo's failed eval runs with the default --repo, and leaves another repo's out", () => {
    const r = cli(repo, "refine", "mine", "--min-support", "2", "--json");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const doc = JSON.parse(r.stdout) as Mined;
    assert.equal(doc.repo, repo);
    const evals = doc.findings.filter((f) => f.kind === "eval-failure");
    assert.equal(evals.length, 1, r.stdout);
    assert.equal(evals[0]!.count, 4, "two tasks, two failed attempts each");
    assert.equal(evals[0]!.label, "failed runs diverge at <end>");
    assert.ok(evals[0]!.examples.every((e) => e.sessionId.startsWith("chores-")), JSON.stringify(evals[0]!.examples));
    assert.deepEqual([doc.analyzed, doc.evalRuns], [0, 6]);

    const text = cli(repo, "refine", "mine", "--min-support", "2");
    assert.match(text.stdout, /eval {2}4x in 4 sessions over 2 days: failed runs diverge at <end>/);
    assert.match(text.stderr, /1 pattern in 0 sessions and 6 eval runs since/);
  });

  it("the other repo sees its own runs, --repo all sees both, and a repo with no suite sees none", () => {
    const theirs = JSON.parse(cli(other, "refine", "mine", "--min-support", "2", "--json").stdout) as Mined;
    assert.deepEqual(theirs.findings.filter((f) => f.kind === "eval-failure").map((f) => [f.count, f.examples.every((e) => e.sessionId.startsWith("billing-"))]), [[2, true]]);
    const all = JSON.parse(cli(repo, "refine", "mine", "--min-support", "2", "--repo", "all", "--json").stdout) as Mined;
    assert.deepEqual(all.findings.filter((f) => f.kind === "eval-failure").map((f) => f.count), [6]);
    const bare = join(root, "bare");
    mkdirSync(bare);
    const none = cli(bare, "refine", "mine", "--min-support", "2", "--repo", bare);
    assert.equal(none.status, 0, none.stdout + none.stderr);
    assert.match(none.stderr, /No pattern seen in 2\+ sessions over 2\+ days \(0 sessions since/);
  });
});
