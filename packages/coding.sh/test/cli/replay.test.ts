// `coding.sh replay` on the real Claude Code capture (test/fixtures/adapters/claude-code/real,
// from scripts/e2e/claude-transcript-capture.mjs): the step list, one step with its shell
// command and diff, a file as of a step, and a range, as text and JSON.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const CONFIG = fileURLToPath(new URL("../fixtures/adapters/claude-code/real/config", import.meta.url));
const SID = "cd0185b0-305a-4df2-92fa-6fc6caffdb55";
let root = "";
let env: NodeJS.ProcessEnv;

const exec = (...args: string[]) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, encoding: "utf8" });
const cli = (...args: string[]) => {
  const r = exec(...args);
  assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};

before(() => {
  root = mkdtempSync(join(tmpdir(), "csh-replay-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  env = {
    ...process.env,
    ["HO" + "ME"]: home,
    USERPROFILE: home,
    CODING_SH_HOME: join(home, ".coding.sh"),
    CLAUDE_CONFIG_DIR: CONFIG,
    CODEX_HOME: join(root, "codex"),
    T3CODE_HOME: join(root, "t3"),
    CODING_SH_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
    TZ: "UTC",
  };
  cli("ingest", "--backfill", "--agent", "claude-code");
});
after(() => rmSync(root, { recursive: true, force: true }));

describe("coding.sh replay on a real Claude Code session", () => {
  test("no flags: the numbered steps and the files they touched", () => {
    const text = cli("replay", SID);
    assert.match(text, /^15 steps, 5 files touched$/m);
    assert.match(text, /^ 4 {2}shell .*\$ sed -i 's\/alpha\/beta\/' notes\.txt$/m);
    assert.match(text, /^ {2}A gen\.txt {2}1 change/m);
    assert.match(text, /^ {2}M notes\.txt {2}1 change/m);
    assert.match(text, /^ {2}R sub\/inner\.txt {2}read at step 7$/m);
  });

  test("--step: the shell command, its result and the diff it made", () => {
    const text = cli("replay", SID, "--step", "4");
    assert.match(text, /^Step 4 of 15 {2}shell \(Bash\)/m);
    assert.match(text, /^\$ sed -i 's\/alpha\/beta\/' notes\.txt$/m);
    assert.match(text, /^-alpha\n\+beta\n bravo$/m);
    assert.match(text, /^ {2}M notes\.txt {2}← this step$/m);
  });

  test("--file: the file as of that step; --to: what a range changed", () => {
    assert.match(cli("replay", SID, "--step", "3", "--file", "notes.txt"), /^alpha\nbravo$/m);
    assert.match(cli("replay", SID, "--step", "5", "--file", "notes.txt"), /^beta\nbravo$/m);
    const range = cli("replay", SID, "--step", "2", "--to", "6");
    assert.match(range, /^Steps 2 to 6 of 15: 3 files changed$/m);
    assert.match(range, /^add gen\.txt {2}\(step 5\)\n--- \/dev\/null\n\+\+\+ b\/gen\.txt\n@@ -0,0 \+1,2 @@\n\+one\n\+two$/m);
  });

  test("--json carries the same, and a step past the end is a usage error", () => {
    const idx = JSON.parse(cli("replay", SID, "--json"));
    assert.equal(idx.steps.length, 15);
    assert.deepEqual(idx.files.sort(), ["/home/user/.claude/skills/hello/SKILL.md", "gen.txt", "notes.txt", "out.txt", "sub/inner.txt"]);
    const step = JSON.parse(cli("replay", SID, "--step", "6", "--json"));
    assert.equal(step.detail.shell.command, "echo hi | tee out.txt");
    assert.equal(step.changes[0].path, "out.txt");
    assert.equal(step.changes[0].exact, true);
    const range = JSON.parse(cli("replay", SID, "--step", "1", "--to", "15", "--json"));
    assert.deepEqual(range.files.map((f: { path: string }) => f.path), ["gen.txt", "notes.txt", "out.txt"]);
    const bad = exec("replay", SID, "--step", "99");
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /15 steps/);
  });
});
