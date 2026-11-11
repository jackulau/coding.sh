// The next-step hints replay prints name the session by its full id, so a
// subagent's hint does not resolve to its parent.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const CONFIG = fileURLToPath(new URL("../fixtures/adapters/claude-code/real/config", import.meta.url));
const SID = "cd0185b0-305a-4df2-92fa-6fc6caffdb55";
let root = "";
let env: NodeJS.ProcessEnv;
const exec = (...args: string[]) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, encoding: "utf8" });

before(() => {
  root = mkdtempSync(join(tmpdir(), "csh-replayhint-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  env = { ...process.env, ["HO" + "ME"]: home, USERPROFILE: home, CODING_SH_HOME: join(home, ".coding.sh"), CLAUDE_CONFIG_DIR: CONFIG, CODEX_HOME: join(root, "codex"), T3CODE_HOME: join(root, "t3"), CODING_SH_NO_UPDATE_CHECK: "1", NO_COLOR: "1", TZ: "UTC" };
  assert.equal(exec("ingest", "--backfill", "--agent", "claude-code").status, 0);
});
after(() => rmSync(root, { recursive: true, force: true }));

test("replay hints print the full session id", () => {
  const r = exec("replay", SID);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout + r.stderr, new RegExp(`coding\\.sh replay ${SID} --step \\d+`));
});
