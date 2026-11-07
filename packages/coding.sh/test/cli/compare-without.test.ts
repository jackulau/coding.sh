// `coding.sh compare <bundle> --without <path>` (Z-9): one-command ablation.
// A fake `wrapper` agent fixes the bug only when the pdf skill is in its work
// dir and counts its runs, so both arms run on every task and the skill's
// effect is +100 pp. Runs src/cli/main.ts directly with a temp HOME.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const gitBin = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
let root = "";
let home = "";
let repo = "";
let env: Record<string, string> = {};

function cli(args: string[], cwd = home) {
  return spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, cwd, encoding: "utf8", timeout: 60_000 });
}

before(() => {
  if (!gitBin) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-without-")));
  home = join(root, "home");
  repo = join(root, "repo");
  for (const d of [home, repo, join(root, "tmp")]) mkdirSync(d);
  env = {
    HOME: home,
    CODING_SH_HOME: join(home, ".coding.sh"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    PATH: `${dirname(process.execPath)}:${dirname(gitBin)}:/usr/bin:/bin`,
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
  // Source session → task (start = the buggy repo), then put the repo back.
  const fix = 'require("fs").writeFileSync("sum.js","module.exports=(a,b)=>a+b;\\n")';
  assert.equal(cli(["run", "--", process.execPath, "-e", fix], repo).status, 0);
  const t = cli(["eval", "new", "latest", "--name", "sum", "--verifier", "node test.js", "--instruction", "make sum add", "--json"], repo);
  assert.equal(t.status, 0, t.stdout + t.stderr);
  git("checkout", "-q", "sum.js");

  // The fake agent: fixes sum.js only when the skill was applied, logs every run.
  writeFileSync(
    join(root, "agent.mjs"),
    `import {appendFileSync, existsSync, writeFileSync} from "node:fs";
const skill = existsSync(".claude/skills/pdf/SKILL.md");
appendFileSync(${JSON.stringify(join(root, "runs.log"))}, (skill ? "with" : "without") + (existsSync("AGENTS.md") ? "+agents" : "") + "\\n");
if (skill) writeFileSync("sum.js", "module.exports = (a, b) => a + b;\\n");
`,
  );
  const h = join(root, "harness");
  mkdirSync(join(h, ".claude/skills/pdf"), { recursive: true });
  writeFileSync(join(h, ".claude/skills/pdf/SKILL.md"), "fix the sum\n");
  writeFileSync(join(h, ".claude/skills/pdf/forms.md"), "forms\n");
  writeFileSync(join(h, "AGENTS.md"), "be brief\n");
  writeFileSync(join(h, "harness.toml"), `name = "base"\nagent = "wrapper"\nflags = ${JSON.stringify([process.execPath, join(root, "agent.mjs")])}\ninclude = [".claude/**", "AGENTS.md"]\n`);
  const snap = cli(["harness", "snapshot", "--file", join(h, "harness.toml"), "--json"]);
  assert.equal(snap.status, 0, snap.stdout + snap.stderr);
});
after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("compare --without", () => {
  it("runs A and A-without-the-skill on every task and reports the skill's effect", (t) => {
    if (!gitBin) return t.skip("needs git");
    const r = cli(["compare", "base", "--without", ".claude/skills/pdf", "-t", "sum", "--k", "2", "--yes", "--json"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const { report } = JSON.parse(r.stdout) as { report: { baseline: { passes: number; runs: number }; candidate: { passes: number; runs: number; name: string }; ablation: { paths: string[]; dropped: string[]; unmatched: string[]; effect: { mean: number } }; anatomy?: unknown } };
    assert.deepEqual(report.ablation.paths, [".claude/skills/pdf"]);
    assert.deepEqual(report.ablation.dropped, [".claude/skills/pdf/SKILL.md", ".claude/skills/pdf/forms.md"]);
    assert.deepEqual(report.ablation.unmatched, []);
    assert.equal(report.ablation.effect.mean, 1);
    assert.deepEqual([report.baseline.passes, report.baseline.runs, report.candidate.passes, report.candidate.runs], [2, 2, 0, 2]);
    assert.equal(report.candidate.name, "base-without-claude-skills-pdf");
    assert.ok(report.anatomy, "k=2 carries the failure anatomy");
    const log = readFileSync(join(root, "runs.log"), "utf8").trim().split("\n").sort();
    assert.deepEqual(log, ["with+agents", "with+agents", "without+agents", "without+agents"], "both arms ran on every attempt; AGENTS.md kept");

    // A second run finds the stored ablation instead of adding another bundle.
    const text = cli(["compare", "base", "--without", ".claude/skills/pdf/", "-t", "sum", "--yes"]);
    assert.equal(text.status, 0, text.stdout + text.stderr);
    assert.match(text.stdout, /^A = base · B = base without \.claude\/skills\/pdf \(2 files dropped\)$/m);
    assert.match(text.stdout, /^effect of \.claude\/skills\/pdf = A − B: \+100\.0 pp/m);
    const list = JSON.parse(cli(["harness", "list", "--json"]).stdout) as { bundles: { name: string }[] };
    assert.deepEqual(list.bundles.map((b) => b.name).sort(), ["base", "base-without-claude-skills-pdf"]);
  });

  it("warns on a path only in the task repo; refuses one that is nowhere, and a second bundle", (t) => {
    if (!gitBin) return t.skip("needs git");
    const repoOnly = cli(["compare", "base", "--without", "test.js", "-t", "sum", "--yes"]);
    assert.equal(repoOnly.status, 0, repoOnly.stdout + repoOnly.stderr);
    assert.match(repoOnly.stderr, /--without test\.js: not in bundle base; it is only removed from each task's repo/);

    const nowhere = cli(["compare", "base", "--without", "nope.md", "-t", "sum", "--yes", "--json"]);
    assert.equal(nowhere.status, 2, nowhere.stdout + nowhere.stderr);
    assert.match(nowhere.stderr, /nothing to ablate/);

    const two = cli(["compare", "base", "base", "--without", "AGENTS.md", "--json"]);
    assert.equal(two.status, 2, two.stdout + two.stderr);
    const one = cli(["compare", "base", "--json"]);
    assert.equal(one.status, 2, one.stdout + one.stderr);
  });
});
