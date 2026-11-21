// exp show prints why each failed run failed: a task error's exit code and
// stderr, not only the task's command (the task line names it already), even
// when the command's path is long enough to fill the reason column.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ExperimentResult } from "../../src/datasets/types.ts";
import { failureReason, renderExperiment } from "../../src/experiments/render.ts";
import { CLI } from "../_cli.ts";

describe("exp show: task errors", () => {
  let root = "";
  let home = "";
  let env: NodeJS.ProcessEnv = {};
  const cli = (args: string[]) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, cwd: home, encoding: "utf8", timeout: 120_000 });

  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "csh-exp-err-")));
    home = join(root, "home");
    mkdirSync(home);
    env = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      HOME: home,
      USERPROFILE: home,
      CODING_SH_HOME: join(home, ".coding.sh"),
      XDG_CONFIG_HOME: join(home, ".config"),
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      CODEX_HOME: join(home, ".codex"),
      NO_COLOR: "1",
      CODING_SH_NO_UPDATE_CHECK: "1",
    };
    assert.equal(cli(["dataset", "add", "d", "--case", JSON.stringify({ id: "a", input: "x", expected: 1 })]).status, 0);
    // A long script name: the command alone is wider than the reason column.
    const agent = join(home, `an-agent-whose-script-name-is-long-enough-to-fill-the-reason-column-${"x".repeat(60)}.mjs`);
    writeFileSync(agent, `console.error("model file missing"); process.exit(3);\n`);
    const task = JSON.stringify({ kind: "command", command: process.execPath, args: [agent] });
    const r = cli(["exp", "run", "-d", "d", "--task", task, "-g", '{"kind":"exact"}', "--name", "crash"]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("the failures table shows the exit code and stderr of a crashed task", () => {
    const r = cli(["exp", "show", "crash"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^failures 1$/m);
    assert.match(r.stdout, /error: exited 3: model file missing/);
  });

  it("--json keeps the whole error, command included", () => {
    const r = cli(["exp", "show", "crash", "--json"]);
    assert.equal(r.status, 0, r.stderr);
    const e = (JSON.parse(r.stdout) as { experiment: ExperimentResult }).experiment;
    assert.match(e.runs[0]!.error!, /an-agent-whose-script-name.*: exited 3: model file missing/);
  });
});

describe("failureReason with the task's ref", () => {
  const run = (error: string) => ({ caseId: "c", trial: 1, error, latencyMs: 1, grades: [], pass: false, startedAt: 0 });

  it("drops the task's command from a task error that starts with it, and only then", () => {
    assert.equal(failureReason(run("node agent.mjs: exited 2: boom"), "node agent.mjs"), "error: exited 2: boom");
    assert.equal(failureReason(run("node agent.mjs: exited 2: boom")), "error: node agent.mjs: exited 2: boom");
    assert.equal(failureReason(run("rate limited"), "node agent.mjs"), "error: rate limited");
  });

  it("renderExperiment shows the reason after the command", () => {
    const ref = `node /work/demo/${"long-dir/".repeat(12)}agent.mjs`;
    const r: ExperimentResult = {
      id: "exp_z",
      name: "z",
      dataset: { id: "d", name: "d", version: "v" },
      task: { kind: "command", ref },
      trials: 1,
      graders: [],
      runs: [{ ...run(`${ref}: exited 3: model file missing`), caseId: "c1" }],
      summary: { n: 1, cases: 1, passed: 0, errors: 1, passRate: { p: 0, lo: 0, hi: 0.8 }, ciMethod: "wilson", latencyMs: { mean: 1, median: 1, p90: 1, max: 1 }, graders: [] },
      createdAt: 0,
      finishedAt: 0,
    };
    assert.match(renderExperiment(r, { color: false }), /^c1 +error: exited 3: model file missing$/m);
  });
});
