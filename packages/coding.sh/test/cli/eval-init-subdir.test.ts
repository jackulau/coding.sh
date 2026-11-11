// `eval init` run from a subdirectory of a git repo: --cases and --skill are
// read where the user typed them, the suite stores them relative to itself,
// and a --command runs from that same directory at `eval run` time.
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
let proj = "";
let web = "";
let env: Record<string, string> = {};
const cli = (args: string[], cwd: string) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, cwd, encoding: "utf8", timeout: 120_000 });

before(() => {
  if (!gitBin) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-init-subdir-")));
  const home = join(root, "home");
  proj = join(root, "proj");
  web = join(proj, "apps", "web");
  for (const d of [home, web, join(root, "tmp"), join(web, "skills", "refunds")]) mkdirSync(d, { recursive: true });
  env = {
    ["HO" + "ME"]: home,
    USERPROFILE: home,
    CODING_SH_HOME: join(home, ".coding.sh"),
    CLAUDE_CONFIG_DIR: join(home, "claude"),
    CODEX_HOME: join(home, "codex"),
    PATH: pathOf(dirname(process.execPath), dirname(gitBin), "/usr/bin", "/bin"),
    TMPDIR: join(root, "tmp"),
    NO_COLOR: "1",
    CODING_SH_NO_UPDATE_CHECK: "1",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  assert.equal(spawnSync(gitBin, ["init", "-q"], { cwd: proj, env }).status, 0);
  writeFileSync(join(web, "echo.mjs"), 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => process.stdout.write(String(JSON.parse(s))));\n');
  writeFileSync(join(web, "cases.jsonl"), ['{"input":"a","expected":"a"}', '{"input":"b","expected":"b"}'].join("\n") + "\n");
  writeFileSync(join(web, "skills", "refunds", "SKILL.md"), "---\nname: refunds\ndescription: Handle refund requests.\n---\nAsk for the order id.\n");
});
after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("eval init from a subdirectory", () => {
  it("reads --cases from the current dir, stores it relative to the suite, and eval run passes", (t) => {
    if (!gitBin) return t.skip("needs git");
    const init = cli(["eval", "init", "echo", "--cases", "cases.jsonl", "--command", "node echo.mjs", "-k", "1"], web);
    assert.equal(init.status, 0, init.stdout + init.stderr);
    const spec = JSON.parse(readFileSync(join(proj, "evals", "echo", "suite.json"), "utf8")) as { cases: string; task: { cwd?: string } };
    assert.equal(spec.cases, "../../apps/web/cases.jsonl");
    assert.equal(spec.task.cwd, "apps/web", "the command runs where eval init was run");
    // The paths it prints are paths from where it ran, and it names the repo root it chose.
    const said = init.stdout + init.stderr;
    assert.match(said, /to \.\.\/\.\.\/evals\/echo\b/, said);
    assert.match(said, /Suites live at the repo root, \.\.\/\.\./, said);
    const printed = said.split("\n").map((l) => l.trim()).filter((l) => l.endsWith("suite.json"));
    assert.ok(printed.length > 0, said);
    for (const p of printed) assert.ok(existsSync(join(web, p)), `${p} does not exist from ${web}`);
    const run = cli(["eval", "run", "echo"], web);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    // From the repo root too: paths in suite.json do not depend on where eval run starts.
    assert.equal(cli(["eval", "run", "echo"], proj).status, 0);
  });

  it("reads --skill from the current dir", (t) => {
    if (!gitBin) return t.skip("needs git");
    const init = cli(["eval", "init", "refunds", "--skill", "skills/refunds"], web);
    assert.equal(init.status, 0, init.stdout + init.stderr);
    const spec = JSON.parse(readFileSync(join(proj, "evals", "refunds", "suite.json"), "utf8")) as { skill: string };
    assert.equal(spec.skill, "../../apps/web/skills/refunds");
  });

  it("names the absolute path it tried when --cases is missing", (t) => {
    if (!gitBin) return t.skip("needs git");
    const bad = cli(["eval", "init", "nope", "--cases", "missing.jsonl", "--command", "node echo.mjs"], web);
    assert.notEqual(bad.status, 0);
    assert.ok((bad.stdout + bad.stderr).includes(join(web, "missing.jsonl")), bad.stdout + bad.stderr);
  });
});
