// exp replay --session latest resolves the session before it checks --vary, so
// the error names what is missing first: here, any session to replay.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), "csh-replay-order-")));
after(() => rmSync(root, { recursive: true, force: true }));

describe("exp replay --session latest", () => {
  it("with no sessions, says so before reading the --vary file", () => {
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    const env = { HOME: home, USERPROFILE: home, CODING_SH_HOME: join(root, "data"), XDG_CONFIG_HOME: join(home, ".config"), CLAUDE_CONFIG_DIR: join(root, "claude"), CODEX_HOME: join(root, "codex"), PATH: process.env.PATH, NO_COLOR: "1", CODING_SH_NO_AUTO_INGEST: "1", CODING_SH_NO_UPDATE_CHECK: "1" };
    const r = spawnSync(process.execPath, ["--no-warnings", CLI, "exp", "replay", "--session", "latest", "--limit", "10", "--vary", "system=@terse-system.md", "--n", "3", "--dry-run"], { cwd: root, env, encoding: "utf8" });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /Can't find session "latest"/);
    assert.doesNotMatch(r.stderr, /terse-system\.md/);
  });
});
