// X-25: `compare --experiment <id> --retry-errors`, `--failing <exp>[@bundle]`
// and `--sample N --seed S`, end to end through src/cli/main.ts with a temp
// HOME. A fake `wrapper` agent fixes the bug only when the pdf skill is in its
// work dir and the instruction doesn't say BROKEN, logs every run, and fails
// its first run with a rate-limit error while a flag file exists.
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
const WITHOUT = ["--without", ".claude/skills/pdf"];

function cli(args: string[], cwd = home) {
  return spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, cwd, encoding: "utf8", timeout: 120_000 });
}
const runsLog = () => (existsSync(join(root, "runs.log")) ? readFileSync(join(root, "runs.log"), "utf8").trim().split("\n").filter(Boolean) : []);
const clearLog = () => rmSync(join(root, "runs.log"), { force: true });

before(() => {
  if (!gitBin) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-iterate-")));
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
  // Four tasks from one session; the agent refuses the BROKEN one.
  for (const [name, instruction] of [["s1", "make sum add"], ["s2", "make sum add, please"], ["s3", "make sum add now"], ["s4", "make sum add BROKEN"]]) {
    const t = cli(["eval", "new", "latest", "--name", name!, "--verifier", "node test.js", "--instruction", instruction!, "--tag", "iter", "--json"], repo);
    assert.equal(t.status, 0, t.stdout + t.stderr);
  }
  git("checkout", "-q", "sum.js");
  writeFileSync(
    join(root, "agent.mjs"),
    `import {appendFileSync, existsSync, rmSync, writeFileSync} from "node:fs";
const flag = ${JSON.stringify(join(root, "ratelimit.flag"))};
if (existsSync(flag)) { rmSync(flag); process.stderr.write("API error: 429 rate limit exceeded\\n"); process.exit(1); }
const prompt = process.argv.slice(2).join(" ");
const skill = existsSync(".claude/skills/pdf/SKILL.md");
appendFileSync(${JSON.stringify(join(root, "runs.log"))}, (skill ? "with" : "without") + ":" + prompt + "\\n");
if (skill && !prompt.includes("BROKEN")) writeFileSync("sum.js", "module.exports = (a, b) => a + b;\\n");
`,
  );
  const h = join(root, "harness");
  mkdirSync(join(h, ".claude/skills/pdf"), { recursive: true });
  writeFileSync(join(h, ".claude/skills/pdf/SKILL.md"), "fix the sum\n");
  writeFileSync(join(h, "harness.toml"), `name = "base"\nagent = "wrapper"\nflags = ${JSON.stringify([process.execPath, join(root, "agent.mjs")])}\ninclude = [".claude/**"]\n`);
  assert.equal(cli(["harness", "snapshot", "--file", join(h, "harness.toml"), "--json"]).status, 0);
  const o = join(root, "other");
  mkdirSync(o);
  writeFileSync(join(o, "harness.toml"), `name = "other"\nagent = "wrapper"\nflags = ${JSON.stringify([process.execPath, join(root, "agent.mjs"), "--other"])}\n`);
  assert.equal(cli(["harness", "snapshot", "--file", join(o, "harness.toml"), "--json"]).status, 0);
});
after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

type Out = { experimentId: string; planned?: number; skipped?: number; retried?: number; selection?: { from: number; tasks: number; note: string; failing?: { bundle: string; matched: number } }; report: { baseline: { passes: number; runs: number }; candidate: { passes: number; runs: number }; notes: string[] } };

describe("compare: iterate on a comparison", () => {
  let first = "";

  it("--retry-errors runs the rate-limited run again in place, and the slot counts once", (t) => {
    if (!gitBin) return t.skip("needs git");
    writeFileSync(join(root, "ratelimit.flag"), "");
    const r = cli(["compare", "base", ...WITHOUT, "--tag", "iter", "--retries", "0", "-c", "1", "--yes", "--json"]);
    const out = JSON.parse(r.stdout) as Out;
    first = out.experimentId;
    assert.deepEqual([out.planned, out.skipped], [8, 0]);
    assert.equal(out.report.baseline.runs + out.report.candidate.runs, 7, "the infra-failed run is left out");
    assert.equal(runsLog().length, 7);
    clearLog();
    const retry = cli(["compare", "base", ...WITHOUT, "--experiment", first, "--retry-errors", "--yes", "--json"]);
    assert.equal(retry.status, 0, retry.stdout + retry.stderr);
    const again = JSON.parse(retry.stdout) as Out;
    assert.equal(again.experimentId, first);
    assert.deepEqual([again.planned, again.retried], [1, 1]);
    assert.equal(runsLog().length, 1, "one agent run");
    assert.equal(again.report.baseline.runs + again.report.candidate.runs, 8, "every slot counts once");
    assert.ok(again.report.notes.some((n) => /retried 1 run that errored/.test(n)), again.report.notes.join("\n"));
    assert.deepEqual([again.report.baseline.passes, again.report.candidate.passes], [3, 0]);
    // Nothing errored now: no run, the same report.
    clearLog();
    const none = cli(["compare", "base", ...WITHOUT, "--experiment", first, "--retry-errors", "--yes", "--json"]);
    assert.equal((JSON.parse(none.stdout) as Out).retried, 0);
    assert.equal(runsLog().length, 0);
  });

  it("--failing runs only the tasks A failed, and says the rates are conditioned on it", (t) => {
    if (!gitBin) return t.skip("needs git");
    clearLog();
    const r = cli(["compare", "base", ...WITHOUT, "--failing", first, "--yes", "--json"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const out = JSON.parse(r.stdout) as Out;
    assert.deepEqual([out.selection?.from, out.selection?.tasks, out.selection?.failing?.bundle], [4, 1, "base"]);
    assert.deepEqual(runsLog().sort(), ["with:make sum add BROKEN", "without:make sum add BROKEN"]);
    assert.ok(out.report.notes.some((n) => /^selection: 1 of 4 tasks: the 1 task base failed in exp_\w+\. The B − A difference holds for these tasks; both pass rates are conditioned on base having failed them/.test(n)), out.report.notes.join("\n"));
    const text = cli(["compare", "base", ...WITHOUT, "--failing", `${first}@base-without-claude-skills-pdf`, "--dry-run"]);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /^selection: 4 of 4 tasks: the 4 tasks base-without-claude-skills-pdf failed in exp_\w+\./m);
    assert.match(text.stdout, /dry run: 8 runs \(4 tasks x 2 arms x 1\)/);
  });

  it("--failing refuses a bundle the comparison didn't run, and a comparison A never failed in", (t) => {
    if (!gitBin) return t.skip("needs git");
    const other = cli(["compare", "base", ...WITHOUT, "--failing", `${first}@other`, "--yes"]);
    assert.equal(other.status, 2, other.stderr);
    assert.match(other.stderr, new RegExp(`${first} has no runs of other; it ran base and base-without-claude-skills-pdf`));
    const missing = cli(["compare", "base", ...WITHOUT, "--failing", "exp_nope", "--yes"]);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /exp_nope has no stored runs/);
    const passing = cli(["compare", "base", ...WITHOUT, "--failing", first, "--tag", "iter", "-t", "s1", "--yes"]);
    assert.equal(passing.status, 2, "--task and --tag still exclude each other");
  });

  it("--sample draws the same tasks for the same seed", (t) => {
    if (!gitBin) return t.skip("needs git");
    const draw = (seed: string) => JSON.parse(cli(["compare", "base", ...WITHOUT, "--tag", "iter", "--sample", "2", "--seed", seed, "--dry-run", "--json"]).stdout) as { runs: number; tasks: string[]; selection: { note: string } };
    const a = draw("7");
    assert.equal(a.runs, 4);
    assert.equal(a.tasks.length, 2);
    assert.deepEqual(draw("7").tasks, a.tasks);
    assert.match(a.selection.note, /^selection: 2 of 4 tasks: a sample of 2 \(seed 7\)/);
  });

  it("refuses the flags where they mean nothing", (t) => {
    if (!gitBin) return t.skip("needs git");
    const cases: [string[], RegExp][] = [
      [["--retry-errors"], /--retry-errors needs --experiment/],
      [["--experiment", "exp_1", "--failing", "exp_1"], /--failing and --sample pick tasks for new runs/],
      [["--experiment", "exp_1", "--sample", "2"], /--failing and --sample pick tasks for new runs/],
      [["--seed", "3"], /--seed needs --sample/],
      [["--failing-mode", "majority"], /--failing-mode needs --failing/],
      [["--sample", "0"], /--sample must be an integer of at least 1/],
    ];
    for (const [flags, re] of cases) {
      const r = cli(["compare", "base", ...WITHOUT, ...flags, "--yes"]);
      assert.equal(r.status, 2, `${flags.join(" ")}: ${r.stderr}`);
      assert.match(r.stderr, re);
    }
  });
});
