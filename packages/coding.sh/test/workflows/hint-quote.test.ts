// A next-step hint that repeats a name the user typed shell-quotes it, so the
// printed command runs as shown when the name has a space in it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const MAIN = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), "csh-wf-quote-")));
after(() => rmSync(root, { recursive: true, force: true }));

describe("hints quote user-typed names", () => {
  it("workflows run with a spaced name prints the name quoted", () => {
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    const notDir = join(root, "cases.txt");
    writeFileSync(notDir, "not a directory\n");
    const env = { HOME: home, USERPROFILE: home, CODING_SH_HOME: join(root, "data"), XDG_CONFIG_HOME: join(home, ".config"), CLAUDE_CONFIG_DIR: join(root, "claude"), CODEX_HOME: join(root, "codex"), PATH: process.env.PATH, NO_COLOR: "1", CI: "1" };
    const r = spawnSync(process.execPath, ["--no-warnings", MAIN, "workflows", "run", "my flow", "--driver", "command", "--variant", "a=true", "--cases", notDir], { cwd: root, env, encoding: "utf8" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /coding\.sh workflows run 'my flow' --cases <dir>/);
  });
});
