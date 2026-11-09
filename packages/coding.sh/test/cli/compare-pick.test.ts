// X-15 and R2-10 end to end through src/cli/main.ts with a temp HOME:
// `compare --pick/--budget [--dry-run]`, the consent prompt's dollar estimate,
// the usage errors, and a real `--sequential --otel` run. A fake `wrapper`
// agent logs every run it makes, so a dry run can show it made none.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { which } from "../../src/adapters/_shared/detect.ts";
import { posixShell } from "../../src/core/spawn.ts";
import { pathOf } from "../_bin.ts";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const gitBin = which("git") ?? "";
let root = "";
let home = "";
let repo = "";
let env: Record<string, string> = {};
const taskIds: string[] = [];

function cli(args: string[], cwd = home) {
  return spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, cwd, encoding: "utf8", timeout: 120_000 });
}
const runsLog = () => (existsSync(join(root, "runs.log")) ? readFileSync(join(root, "runs.log"), "utf8").trim().split("\n").filter(Boolean) : []);

before(() => {
  if (!gitBin) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-pick-")));
  home = join(root, "home");
  repo = join(root, "repo");
  for (const d of [home, repo, join(root, "tmp")]) mkdirSync(d);
  env = {
    HOME: home,
    USERPROFILE: home,
    CODING_SH_HOME: join(home, ".coding.sh"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    PATH: pathOf(dirname(process.execPath), dirname(gitBin), process.platform === "win32" ? dirname(posixShell() ?? "") : undefined, "/usr/bin", "/bin"),
    TMPDIR: join(root, "tmp"),
    NO_COLOR: "1",
    CODING_SH_NO_UPDATE_CHECK: "1",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  writeFileSync(join(repo, "sum.js"), "module.exports = (a, b) => a - b;\n");
  writeFileSync(join(repo, "test.js"), 'if (require("./sum.js")(2, 3) !== 5) process.exit(1);\n');
  const git = (...a: string[]) => assert.equal(spawnSync(gitBin, ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: repo, env }).status, 0, a.join(" "));
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "init");
  const fix = 'require("fs").writeFileSync("sum.js","module.exports=(a,b)=>a+b;\\n")';
  assert.equal(cli(["run", "--", process.execPath, "-e", fix], repo).status, 0);
  for (const name of ["p1", "p2", "p3", "p4"]) {
    const t = cli(["eval", "new", "latest", "--name", name, "--verifier", "node test.js", "--instruction", `make sum add (${name})`, "--tag", "pick", "--json"], repo);
    assert.equal(t.status, 0, t.stdout + t.stderr);
    const id = /"(task_[A-Za-z0-9]+)"/.exec(t.stdout)?.[1];
    assert.ok(id, t.stdout);
    taskIds.push(id);
  }
  git("checkout", "-q", "sum.js");
  // Logs each run and the OTel endpoint it was given; fixes the bug every time.
  writeFileSync(
    join(root, "agent.mjs"),
    `import {appendFileSync, writeFileSync} from "node:fs";
appendFileSync(${JSON.stringify(join(root, "runs.log"))}, (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ? "otel" : "plain") + "\\n");
writeFileSync("sum.js", "module.exports = (a, b) => a + b;\\n");
`,
  );
  for (const [name, extra] of [
    ["base", []],
    ["other", ["--other"]],
  ] as const) {
    const d = join(root, name);
    mkdirSync(d);
    writeFileSync(join(d, "harness.toml"), `name = "${name}"\nagent = "wrapper"\nflags = ${JSON.stringify([process.execPath, join(root, "agent.mjs"), ...extra])}\n`);
    assert.equal(cli(["harness", "snapshot", "--file", join(d, "harness.toml"), "--json"]).status, 0);
  }
});
after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

type Pick = { picked: string[]; estimateUsd?: number; budgetUsd?: number; costSources: string[]; tasks: { taskId: string; tier: string; costUsd?: number; costSource?: string; picked: boolean; p: number | null }[] };
type DryRun = { dryRun: true; runs: number; tasks: string[]; pick: Pick };

describe("compare --pick and --budget", () => {
  it("--budget --cost-per-run --dry-run: picks what fits, reports the estimate and the cost sources, runs nothing", (t) => {
    if (!gitBin) return t.skip("needs git");
    const r = cli(["compare", "base", "other", "--tag", "pick", "--budget", "0.5", "--cost-per-run", "0.1", "--dry-run", "--json"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const out = JSON.parse(r.stdout) as DryRun;
    // $0.10 a run x 2 arms = $0.20 a task: two fit $0.50.
    assert.equal(out.pick.picked.length, 2);
    assert.deepEqual(out.tasks, out.pick.picked);
    assert.equal(out.runs, 4);
    assert.equal(Math.round((out.pick.estimateUsd ?? 0) * 100), 40);
    assert.deepEqual(out.pick.costSources, ["baseline", "runs", "session", "pool", "flag"]);
    assert.equal(out.pick.tasks.length, 4);
    for (const x of out.pick.tasks) assert.deepEqual([x.tier, x.costSource, x.costUsd, x.p], ["unseen", "flag", 0.1, null]);
    assert.deepEqual(runsLog(), [], "a dry run calls no agent");
    const text = cli(["compare", "base", "other", "--tag", "pick", "--budget", "0.5", "--cost-per-run", "0.1", "--dry-run"]);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /picked 2 of 4 tasks \(what fits \$0\.50\)/);
    assert.match(text.stdout, /cost sources, first to last: baseline, runs, session, pool, flag/);
    assert.match(text.stdout, /dry run: 4 runs/);
  });

  it("--pick N --dry-run keeps the first N", (t) => {
    if (!gitBin) return t.skip("needs git");
    const r = cli(["compare", "base", "other", "--tag", "pick", "--pick", "3", "--dry-run", "--json"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const out = JSON.parse(r.stdout) as DryRun;
    assert.equal(out.tasks.length, 3);
    assert.equal(out.runs, 6);
    assert.equal(out.pick.estimateUsd, undefined, "no cost known and no budget: no estimate, no error");
  });

  it("--pick-by irt: without runs from 3 configs the separation order stays, with a note; --pick-by alone is a usage error", (t) => {
    if (!gitBin) return t.skip("needs git");
    const sep = JSON.parse(cli(["compare", "base", "other", "--tag", "pick", "--pick", "3", "--dry-run", "--json"]).stdout) as DryRun;
    const r = cli(["compare", "base", "other", "--tag", "pick", "--pick", "3", "--pick-by", "irt", "--dry-run", "--json"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const out = JSON.parse(r.stdout) as DryRun & { pick: { note: string } };
    assert.deepEqual(out.tasks, sep.tasks);
    assert.match(out.pick.note, /--pick-by irt needs stored runs from 3 or more configs \(found 0\)/);
    const bad = cli(["compare", "base", "other", "--tag", "pick", "--pick-by", "irt", "--dry-run", "--json"]);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stdout + bad.stderr, /--pick-by needs --pick or --budget/);
    const typo = cli(["compare", "base", "other", "--tag", "pick", "--pick", "2", "--pick-by", "rasch", "--dry-run", "--json"]);
    assert.notEqual(typo.status, 0);
  });

  it("--budget with no cost known from any source is an error that names --cost-per-run", (t) => {
    if (!gitBin) return t.skip("needs git");
    const r = cli(["compare", "base", "other", "--tag", "pick", "--budget", "1", "--dry-run", "--json"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /cost_unknown/);
    assert.match(r.stdout + r.stderr, /--cost-per-run/);
  });

  it("usage errors: --task with --pick or --budget, --cost-per-run alone, --carry without --sequential, --sequential with --reuse", (t) => {
    if (!gitBin) return t.skip("needs git");
    for (const args of [
      ["--task", taskIds[0]!, "--pick", "2"],
      ["--task", taskIds[0]!, "--budget", "5"],
      ["--cost-per-run", "0.1"],
      ["--carry", "~/.claude"],
      ["--sequential", "--reuse", "baseline"],
      ["--sequential", "--carry", "../x"],
      ["--budget", "0"],
    ]) {
      const r = cli(["compare", "base", "other", ...args, "--dry-run"]);
      assert.equal(r.status, 2, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
    }
    assert.deepEqual(runsLog(), []);
  });

  it("the consent prompt names the dollar estimate", (t) => {
    if (!gitBin) return t.skip("needs git");
    const r = cli(["compare", "base", "other", "--tag", "pick", "--budget", "0.5", "--cost-per-run", "0.1"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Run 4 agent sessions \(2 tasks x 2 arms x 1, about \$0\.40\) needs confirmation/);
    assert.deepEqual(runsLog(), []);
  });

  it("--sequential --otel runs for real: each run gets an OTLP endpoint and the report has a learning curve", (t) => {
    if (!gitBin) return t.skip("needs git");
    const r = cli(["compare", "base", "other", "--tag", "pick", "--pick", "2", "--sequential", "--otel", "--yes", "--json"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const out = JSON.parse(r.stdout) as { report: { learning?: { baseline?: { steps: { rate: number }[] }; candidate?: unknown }; baseline: { runs: number } } };
    assert.deepEqual(runsLog(), ["otel", "otel", "otel", "otel"]);
    assert.equal(out.report.baseline.runs, 2);
    assert.deepEqual(out.report.learning?.baseline?.steps.map((s) => s.rate), [1, 1], r.stdout);
    assert.ok(out.report.learning?.candidate);
  });
});
