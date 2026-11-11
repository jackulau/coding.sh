// A workflow run dir copied under a second parent session (a fork, a resumed or
// symlinked run) is the same run. It is imported once, from the session that
// wrote it: one child session per agent, the run's host stays the first
// parent, and the import counts it once.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { copiedSubagentOwner } from "../../src/adapters/claude-code.ts";

const MAIN = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const FIXTURE = fileURLToPath(new URL("../fixtures/workflows/claude-code-running/projects", import.meta.url));
const RUN = "wf_7d3c2a10-5be";
const OWNER = "5a1d7c3e-0b2f-4c6d-9e8f-1a2b3c4d5e6f";
const COPY = "6b2e8d4f-1c3a-4d7e-8f90-2b3c4d5e6f70";
const AGENT = "a3c5e7f9b1d2e4f60";

let root = "";
let projects = "";
let env: NodeJS.ProcessEnv = {};

function cli(args: string[]): any {
  const r = spawnSync(process.execPath, ["--no-warnings", MAIN, ...args, "--json"], { cwd: root, env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-wf-copied-")));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  projects = join(root, "claude", "projects");
  cpSync(FIXTURE, projects, { recursive: true });
  // The second parent holds a byte-identical copy of the run dir and its script.
  cpSync(join(projects, "-work-demo", OWNER), join(projects, "-work-demo", COPY), { recursive: true });
  env = { HOME: home, USERPROFILE: home, CODING_SH_HOME: join(root, "data"), XDG_CONFIG_HOME: join(home, ".config"), CLAUDE_CONFIG_DIR: join(root, "claude"), PATH: process.env.PATH, NO_COLOR: "1", CI: "1" };
});
after(() => rmSync(root, { recursive: true, force: true }));

describe("a workflow run copied under a second parent", () => {
  it("the adapter sees the copy's agent as the owner's", async () => {
    const copy = join(projects, "-work-demo", COPY, "subagents", "workflows", RUN, `agent-${AGENT}.jsonl`);
    assert.equal(await copiedSubagentOwner(copy), OWNER);
    assert.equal(await copiedSubagentOwner(join(projects, "-work-demo", OWNER, "subagents", "workflows", RUN, `agent-${AGENT}.jsonl`)), undefined);
  });

  it("imports once, stores one session per agent under the first parent, and costs the same in usage and workflows list", () => {
    const r = cli(["workflows", "import", projects]);
    assert.equal(r.found, 2);
    assert.equal(r.imported.length, 1);
    const [run] = cli(["workflows", "list", "--no-import"]).runs;
    assert.equal(run.id, RUN);
    assert.equal(run.hostSessionId, OWNER);
    const ids = cli(["sessions", "--where", "is:child"]).sessions.map((s: { id: string }) => s.id);
    assert.deepEqual(ids, [`${OWNER}:sub:${AGENT}`]);
    const sessions = cli(["sessions", "--where", "is:child"]).sessions as { stats: { usage?: { costUsd?: number } } }[];
    const stored = sessions.reduce((a, s) => a + (s.stats.usage?.costUsd ?? 0), 0);
    assert.ok(run.costUsd > 0);
    assert.ok(Math.abs(stored - run.costUsd) < 1e-9, `sessions $${stored} vs workflows list $${run.costUsd}`);
  });

  it("a second import finds nothing new", () => {
    const r = cli(["workflows", "import", projects]);
    assert.equal(r.imported.length, 0);
  });
});
