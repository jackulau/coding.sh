// Z-11: `compare --experiment <id> --signals`, end to end through src/cli/main.ts
// with a temp HOME. A fake `wrapper` agent fixes the bug only when the pdf skill
// is in its work dir, so A passes and B (A without the skill) fails.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
let experimentId = "";

function cli(args: string[], cwd = home) {
  return spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, cwd, encoding: "utf8", timeout: 120_000 });
}

before(() => {
  if (!gitBin) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-signals-")));
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
  for (const name of ["s1", "s2"]) {
    const t = cli(["eval", "new", "latest", "--name", name, "--verifier", "node test.js", "--instruction", `make sum add (${name})`, "--tag", "sig", "--json"], repo);
    assert.equal(t.status, 0, t.stdout + t.stderr);
  }
  git("checkout", "-q", "sum.js");
  writeFileSync(join(root, "agent.mjs"), `import {existsSync, writeFileSync} from "node:fs";\nif (existsSync(".claude/skills/pdf/SKILL.md")) writeFileSync("sum.js", "module.exports = (a, b) => a + b;\\n");\n`);
  const h = join(root, "harness");
  mkdirSync(join(h, ".claude/skills/pdf"), { recursive: true });
  writeFileSync(join(h, ".claude/skills/pdf/SKILL.md"), "fix the sum\n");
  writeFileSync(join(h, "harness.toml"), `name = "base"\nagent = "wrapper"\nflags = ${JSON.stringify([process.execPath, join(root, "agent.mjs")])}\ninclude = [".claude/**"]\n`);
  assert.equal(cli(["harness", "snapshot", "--file", join(h, "harness.toml"), "--json"]).status, 0);
  const r = cli(["compare", "base", "--without", ".claude/skills/pdf", "--tag", "sig", "--k", "2", "-c", "2", "--yes", "--json"]);
  assert.ok(r.stdout.trim(), r.stderr);
  experimentId = JSON.parse(r.stdout).experimentId;
});
after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("compare --signals", () => {
  const base = () => ["compare", "base", "--without", ".claude/skills/pdf", "--experiment", experimentId];

  it("--json adds report.signals with the reference rows first, and changes nothing else", (t) => {
    if (!gitBin) return t.skip("needs git");
    const plain = JSON.parse(cli([...base(), "--json"]).stdout);
    const withSignals = JSON.parse(cli([...base(), "--signals", "--json"]).stdout);
    assert.equal(plain.report.signals, undefined);
    const signals = withSignals.report.signals as { signal: string; reference?: true; withinTaskArm: { pairs: number }; verdict: string }[];
    assert.ok(Array.isArray(signals) && signals.length >= 2);
    assert.deepEqual(
      signals.slice(0, 2).map((s) => s.signal),
      ["difficulty(loo)", "arm(loo)"],
    );
    // Every run of an arm has the same outcome: no (failed, passed) pair in the same task and arm.
    assert.ok(signals.every((s) => s.withinTaskArm.pairs === 0 && s.verdict === "too-few-pairs"));
    delete withSignals.report.signals;
    assert.deepEqual(withSignals, plain);
  });

  it("text: the signals table sits after the report; without --signals the output is byte-identical", (t) => {
    if (!gitBin) return t.skip("needs git");
    const a = cli(base()).stdout;
    const b = cli(base()).stdout;
    assert.equal(a, b);
    assert.doesNotMatch(a, /AUROC/);
    const s = cli([...base(), "--signals"]).stdout;
    assert.match(s, /signals {2}pooled AUROC mostly measures task difficulty/);
    assert.match(s, /difficulty\(loo\) \(ref\)/);
    // Drop the blank line, the caption and the table rows: what is left is the plain output.
    const lines = s.split("\n");
    const at = lines.findIndex((l) => l.startsWith("signals  "));
    let end = at + 1;
    while (lines[end]?.startsWith("  ")) end++;
    assert.equal(lines[at - 1], "");
    lines.splice(at - 1, end - at + 1);
    assert.equal(lines.join("\n"), a);
  });
});
