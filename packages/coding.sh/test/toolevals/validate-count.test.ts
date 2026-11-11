// `toolevals validate` with one good task file and one that does not parse:
// the summary counts the rejected file, "1/2 task(s) valid", not "1/1".
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { cleanup, FAKE_CLI, tmp } from "./helpers.ts";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const q = (s: string) => JSON.stringify(s);
after(cleanup);

describe("toolevals validate count", () => {
  it("a task file that does not load counts against the total", () => {
    const root = tmp();
    const home = join(root, "home");
    const repo = join(root, "repo");
    const tasks = join(repo, "evals", "toolevals", "fake", "tasks");
    mkdirSync(tasks, { recursive: true });
    mkdirSync(join(root, "tmp"));
    writeFileSync(join(repo, "coding.sh.toml"), ["[toolevals.targets.fake]", 'kind = "cli"', 'bin = "fake-cli"', `command = [${q(process.execPath)}, ${q(FAKE_CLI)}]`, ""].join("\n"));
    writeFileSync(join(tasks, "greet-bob.toml"), ['id = "greet-bob"', 'instruction = "Greet bob using fake-cli."', 'status = "validated"', 'reference = ["fake-cli greet --name bob"]', "", "[[checks]]", 'kind = "output"', 'contains = ["hello bob"]', ""].join("\n"));
    writeFileSync(join(tasks, "broken.toml"), 'id = "broken"\ninstruction = \n');
    const env = { ["HO" + "ME"]: home, USERPROFILE: home, CODING_SH_HOME: join(home, ".coding.sh"), CLAUDE_CONFIG_DIR: join(home, "claude"), CODEX_HOME: join(home, "codex"), PATH: process.env.PATH ?? "", TMPDIR: join(root, "tmp"), NO_COLOR: "1", CODING_SH_NO_UPDATE_CHECK: "1" };
    const r = spawnSync(process.execPath, ["--no-warnings", CLI, "toolevals", "validate", "fake"], { env, cwd: repo, encoding: "utf8", timeout: 120_000 });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^1\/2 task\(s\) valid$/m, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /broken\.toml/);
  });
});
