// `judge grade` exit codes: 0 on pass, 1 on a fail verdict, 2 when the grader
// itself could not grade (no API key, a provider error). A verifier that calls
// judge grade can then tell "the agent failed" from "the judge did not run".
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
let root = "";
let env: NodeJS.ProcessEnv = {};
const run = (...args: string[]) => spawnSync(process.execPath, ["--no-warnings", CLI, "judge", "grade", ...args], { env, cwd: root, encoding: "utf8", timeout: 120_000 });

before(() => {
  root = mkdtempSync(join(tmpdir(), "csh-judge-grade-"));
  const home = join(root, "home");
  mkdirSync(home);
  env = { PATH: process.env.PATH ?? "", ["HO" + "ME"]: home, USERPROFILE: home, CODING_SH_HOME: join(home, ".coding.sh"), CLAUDE_CONFIG_DIR: join(home, "claude"), CODEX_HOME: join(home, "codex"), NO_COLOR: "1", CODING_SH_NO_UPDATE_CHECK: "1" };
  writeFileSync(join(root, "out.txt"), "hello\n");
});
after(() => rmSync(root, { recursive: true, force: true }));

describe("judge grade exit codes", () => {
  it("a fail verdict exits 1", () => {
    const r = run("--grader", '{"kind":"contains","value":"goodbye"}', "--output", "out.txt");
    assert.equal(r.status, 1, r.stderr);
  });

  it("an LLM grader with no API key exits 2, reason grader_error", () => {
    const r = run("--grader", '{"kind":"llm","name":"q","rubric":"Is it good?","provider":"anthropic","model":"claude-x"}', "--output", "out.txt", "--json");
    assert.equal(r.status, 2, r.stdout + r.stderr);
    const err = JSON.parse(r.stderr.trim().split("\n").pop() ?? "{}") as { reason?: string; message?: string };
    assert.equal(err.reason, "grader_error");
    assert.match(err.message ?? "", /ANTHROPIC_API_KEY/);
  });
});
