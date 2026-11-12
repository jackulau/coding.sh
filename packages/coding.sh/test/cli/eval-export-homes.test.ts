// `eval export` writes a task another home can import: the start tree goes in
// repo/ and task.json names no path on this machine. Importing an old export
// whose start snapshot this home does not have fails with a next step.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { which } from "../../src/adapters/_shared/detect.ts";
import { pathOf } from "../_bin.ts";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const gitBin = which("git") ?? "";
let root = "";

function homeEnv(name: string): Record<string, string> {
  const home = join(root, name);
  mkdirSync(join(home, "tmp"), { recursive: true });
  return {
    ["HO" + "ME"]: home,
    USERPROFILE: home,
    CODING_SH_HOME: join(home, ".coding.sh"),
    CLAUDE_CONFIG_DIR: join(home, "claude"),
    CODEX_HOME: join(home, "codex"),
    PATH: pathOf(dirname(process.execPath), dirname(gitBin), "/usr/bin", "/bin"),
    TMPDIR: join(home, "tmp"),
    NO_COLOR: "1",
    CODING_SH_NO_UPDATE_CHECK: "1",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}
const cli = (env: Record<string, string>, args: string[]) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, cwd: env.TMPDIR, encoding: "utf8", timeout: 120_000 });

before(() => {
  if (gitBin) root = realpathSync(mkdtempSync(join(tmpdir(), "csh-export-homes-")));
});
after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

/** A hand-written task: repo/answer.txt says "no", the reference patch makes it "yes", tests/check.js checks it. */
function writeTask(dir: string): void {
  mkdirSync(join(dir, "repo"), { recursive: true });
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(join(dir, "task.json"), JSON.stringify({ name: "says-yes", verifier: { command: "node check.js", timeoutMs: 30_000 } }, null, 2));
  writeFileSync(join(dir, "instruction.md"), "Make answer.txt say yes.\n");
  writeFileSync(join(dir, "repo", "answer.txt"), "no\n");
  writeFileSync(join(dir, "tests", "check.js"), 'const fs = require("fs");\nprocess.exit(fs.readFileSync("answer.txt", "utf8").trim() === "yes" ? 0 : 1);\n');
  writeFileSync(join(dir, "reference.patch"), ["diff --git a/answer.txt b/answer.txt", "--- a/answer.txt", "+++ b/answer.txt", "@@ -1 +1 @@", "-no", "+yes", ""].join("\n"));
}

describe("eval export, then import in another home", () => {
  it("export from home A, import into home B, validate passes", (t) => {
    if (!gitBin) return t.skip("needs git");
    const a = homeEnv("a");
    const b = homeEnv("b");
    const src = join(root, "src-task");
    writeTask(src);
    const imp = cli(a, ["eval", "import", src, "--json"]);
    assert.equal(imp.status, 0, imp.stdout + imp.stderr);
    const id = (JSON.parse(imp.stdout) as { tasks: { id: string }[] }).tasks[0]!.id;

    const out = join(root, "exported");
    const exp = cli(a, ["eval", "export", id, "--out", out]);
    assert.equal(exp.status, 0, exp.stdout + exp.stderr);
    assert.equal(readFileSync(join(out, "repo", "answer.txt"), "utf8"), "no\n", "the start tree is in repo/");
    assert.equal(existsSync(join(out, "repo", ".git")), false, "repo/ is a plain tree");
    const json = JSON.parse(readFileSync(join(out, "task.json"), "utf8")) as { start?: { repoRoot?: string } };
    assert.equal(json.start?.repoRoot, undefined, "task.json names no path on this machine");
    assert.doesNotMatch(readFileSync(join(out, "task.json"), "utf8"), new RegExp(root.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));

    // The source dir and home A are gone: home B has only the export.
    rmSync(src, { recursive: true, force: true });
    rmSync(a.CODING_SH_HOME!, { recursive: true, force: true });
    const imp2 = cli(b, ["eval", "import", out, "--json"]);
    assert.equal(imp2.status, 0, imp2.stdout + imp2.stderr);
    const val = cli(b, ["eval", "validate", id, "--k", "1", "--json"]);
    assert.equal(val.status, 0, val.stdout + val.stderr);
    assert.equal((JSON.parse(val.stdout) as { outcome?: string; tasks?: { outcome: string }[] }).outcome ?? "", "validated");
  });

  it("an export with a start snapshot this home lacks fails at import with a next step", (t) => {
    if (!gitBin) return t.skip("needs git");
    const c = homeEnv("c");
    const dir = join(root, "old-export");
    writeTask(dir);
    rmSync(join(dir, "repo"), { recursive: true, force: true });
    const json = JSON.parse(readFileSync(join(dir, "task.json"), "utf8")) as Record<string, unknown>;
    const sha = "0123456789abcdef0123456789abcdef01234567";
    writeFileSync(join(dir, "task.json"), JSON.stringify({ ...json, start: { repoRoot: join(root, "gone"), snapshot: sha, head: sha } }));
    const imp = cli(c, ["eval", "import", dir]);
    assert.equal(imp.status, 1, imp.stdout + imp.stderr);
    assert.match(imp.stderr + imp.stdout, /start snapshot/);
    assert.match(imp.stderr + imp.stdout, /eval export/);
  });
});
