// A synthetic Claude Code workflow run, shaped after Claude Code 2.1.319's on-disk layout for a
// run that is still going: the journal, one agent's transcript and meta, and the script persisted
// at workflows/scripts/<name>-<runId>.js, with no run record yet (Claude Code writes that when the
// run ends). Its content is made up: test/fixtures/workflows/claude-code-running. Imported with
// the CLI into a temp store, then read back as a user would.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const MAIN = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const PROJECTS = fileURLToPath(new URL("../fixtures/workflows/claude-code-running/projects", import.meta.url));
const RUN = "wf_7d3c2a10-5be";
const AGENT_SESSION = "5a1d7c3e-0b2f-4c6d-9e8f-1a2b3c4d5e6f:sub:a3c5e7f9b1d2e4f60";

let root = "";
let env: NodeJS.ProcessEnv = {};
before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-wf-running-")));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  env = { HOME: home, USERPROFILE: home, CODING_SH_HOME: join(root, "data"), XDG_CONFIG_HOME: join(home, ".config"), CLAUDE_CONFIG_DIR: join(root, "claude"), PATH: process.env.PATH, NO_COLOR: "1", CI: "1" };
  const r = cli(["workflows", "import", PROJECTS]);
  assert.equal(r.imported.length, 1);
});
after(() => rmSync(root, { recursive: true, force: true }));

function cli(args: string[]): any {
  const r = spawnSync(process.execPath, ["--no-warnings", MAIN, ...args, "--json"], { cwd: root, env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

describe("a workflow run, still running", () => {
  it("sessions --where id: finds a workflow agent's session, as show does", () => {
    assert.equal(cli(["show", AGENT_SESSION, "-n", "1"]).session.id, AGENT_SESSION);
    const ids = (args: string[]) => cli(["sessions", ...args]).sessions.map((s: { id: string }) => s.id);
    assert.deepEqual(ids(["--where", `id:${AGENT_SESSION}`]), [AGENT_SESSION]);
    assert.deepEqual(ids(["--where", "id:5a1d7c3e*"]), [AGENT_SESSION]);
    assert.deepEqual(ids(["--where", "is:child"]), [AGENT_SESSION]);
    assert.deepEqual(ids(["--where", "parent:5a1d7c3e-0b2f-4c6d-9e8f-1a2b3c4d5e6f"]), [AGENT_SESSION]);
    // Without a clause that names it, the list still shows top-level sessions only.
    assert.deepEqual(ids([]), []);
    assert.deepEqual(ids(["--where", "agent:claude-code"]), []);
    assert.deepEqual(ids(["--where", `-id:${AGENT_SESSION}`]), []);
  });

  it("export --where id: exports a workflow agent's session", () => {
    const r = spawnSync(process.execPath, ["--no-warnings", MAIN, "export", "sessions", "--where", `id:${AGENT_SESSION}`], { cwd: root, env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split("\n").map((l) => JSON.parse(l).id), [AGENT_SESSION]);
  });
});
