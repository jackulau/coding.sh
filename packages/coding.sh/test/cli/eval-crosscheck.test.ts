// `coding.sh eval crosscheck` (Z-3): a fake `wrapper` agent fixes the bug, the
// mock reviewer says valid or invalid, and the counts land in task.meta.crossCheck.
// Runs src/cli/main.ts directly with a temp HOME; no model is called.
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

function cli(args: string[], cwd = home) {
  return spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, cwd, encoding: "utf8", timeout: 60_000 });
}

before(() => {
  if (!gitBin) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-crosscheck-")));
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
  const t = cli(["eval", "new", "latest", "--name", "sum", "--verifier", "node test.js", "--instruction", "make sum add", "--json"], repo);
  assert.equal(t.status, 0, t.stdout + t.stderr);
  git("checkout", "-q", "sum.js");

  // The solver: a valid fix written differently from the reference.
  writeFileSync(join(root, "agent.mjs"), 'import {writeFileSync} from "node:fs";\nwriteFileSync("sum.js", "module.exports = function sum(a, b) { return b + a; };\\n");\n');
  const h = join(root, "harness");
  mkdirSync(h);
  writeFileSync(join(h, "harness.toml"), `name = "solver"\nagent = "wrapper"\nflags = ${JSON.stringify([process.execPath, join(root, "agent.mjs")])}\n`);
  const snap = cli(["harness", "snapshot", "--file", join(h, "harness.toml"), "--json"]);
  assert.equal(snap.status, 0, snap.stdout + snap.stderr);
});
after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

interface CrossCheckJson {
  outcome: string;
  crossCheck: { source: string; checked: number; agree: number; falseAccepts: number; falseRejects: number; reviewer: string; cases: { kind: string; verifierPass: boolean }[]; usage: { calls: number } };
  coupling: unknown[];
}

describe("eval crosscheck", () => {
  it("needs stored runs, solves once with --solver, and stores the shared counts on the task", (t) => {
    if (!gitBin) return t.skip("needs git");
    const none = cli(["eval", "crosscheck", "sum", "--judge", '{"provider":"mock"}']);
    assert.notEqual(none.status, 0);
    assert.match(none.stderr, /No stored runs of sum to cross-check/);
    assert.equal(cli(["eval", "crosscheck", "sum", "--judge", "[1]"]).status, 2, "a non-object --judge is a usage error");

    // The solver passes the verifier; the reviewer says invalid: a false accept.
    const r = cli(["eval", "crosscheck", "sum", "--solver", "solver", "--judge", '{"provider":"mock","mockAnswer":"no"}', "--json"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const j = JSON.parse(r.stdout) as CrossCheckJson;
    assert.equal(j.outcome, "checked");
    assert.deepEqual([j.crossCheck.source, j.crossCheck.checked, j.crossCheck.agree, j.crossCheck.falseAccepts, j.crossCheck.falseRejects], ["blind-solver", 1, 0, 1, 0]);
    assert.equal(j.crossCheck.reviewer, "mock/mock");
    assert.deepEqual(j.crossCheck.cases.map((c) => [c.kind, c.verifierPass]), [["false-accept", true]]);
    assert.deepEqual(j.coupling, []);

    const list = JSON.parse(cli(["eval", "list", "--json"]).stdout) as { tasks: { name: string; crossCheck?: { source: string; falseAccepts: number; disagreements: unknown[] } }[] };
    const stored = list.tasks.find((x) => x.name === "sum")?.crossCheck;
    assert.deepEqual([stored?.source, stored?.falseAccepts, stored?.disagreements.length], ["blind-solver", 1, 1]);

    // The stored run, reviewed again by a reviewer that agrees; plain output.
    const plain = cli(["eval", "crosscheck", "sum", "--judge", '{"provider":"mock"}']);
    assert.equal(plain.status, 0, plain.stdout + plain.stderr);
    assert.match(plain.stdout, /^cross-check of \S+ by mock\/mock: 1 of 1 run\(s\) agree with the verifier; 0 false reject\(s\), 0 false accept\(s\)$/m);
    assert.match(plain.stdout, /^1 model call\(s\)/m);
  });
});
