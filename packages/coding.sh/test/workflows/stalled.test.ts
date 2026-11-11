// workflows show marks a running agent stalled when its transcript has not
// moved for longer than the stall timeout, and its phase is not shown ok.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { markStalled, STALL_MS } from "../../src/workflows/tree.ts";
import type { WorkflowNode } from "../../src/workflows/types.ts";

const MAIN = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const FIXTURE = fileURLToPath(new URL("../fixtures/workflows/claude-code-running/projects", import.meta.url));
const RUN = "wf_7d3c2a10-5be";
const RUN_DIR = ["-work-demo", "5a1d7c3e-0b2f-4c6d-9e8f-1a2b3c4d5e6f", "subagents", "workflows", RUN];

let root = "";
let env: NodeJS.ProcessEnv = {};

function cli(args: string[]): { stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--no-warnings", MAIN, ...args], { cwd: root, env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return { stdout: r.stdout, stderr: r.stderr };
}

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-wf-stalled-")));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const projects = join(root, "claude", "projects");
  cpSync(FIXTURE, projects, { recursive: true });
  // Nothing in the run dir was written for two hours.
  const old = (Date.now() - 2 * 3600_000) / 1000;
  const dir = join(projects, ...RUN_DIR);
  for (const f of readdirSync(dir)) utimesSync(join(dir, f), old, old);
  env = { HOME: home, USERPROFILE: home, CODING_SH_HOME: join(root, "data"), XDG_CONFIG_HOME: join(home, ".config"), CLAUDE_CONFIG_DIR: join(root, "claude"), PATH: process.env.PATH, NO_COLOR: "1", CI: "1" };
  cli(["workflows", "import", projects, "--json"]);
});
after(() => rmSync(root, { recursive: true, force: true }));

describe("stalled agents", () => {
  it("show prints the running agent as stalled and its phase as not ok", () => {
    const { stdout, stderr } = cli(["workflows", "show", RUN]);
    const text = stderr + stdout;
    assert.match(text, /agent review:tests {2}stalled/);
    assert.match(text, /phase Review {2}stalled/);
    assert.doesNotMatch(text, /phase Review {2}ok/);
    assert.match(text, /Status\s+running \(1 agent stalled\)/);
  });

  it("--json carries stalledMs on the agent", () => {
    const doc = JSON.parse(cli(["workflows", "show", RUN, "--json"]).stdout) as { nodes: WorkflowNode[] };
    const a = doc.nodes.find((n) => n.name === "review:tests")!;
    assert.equal(a.status, "running");
    assert.ok(a.stalledMs! > STALL_MS);
  });

  it("an agent with recent activity is not stalled", () => {
    const now = 10 * STALL_MS;
    const nodes: WorkflowNode[] = [
      { id: "r/phase/P", runId: "r", kind: "phase", name: "P", phase: "P", status: "running" },
      { id: "r/agent/0", runId: "r", parentId: "r/phase/P", kind: "agent", name: "a", phase: "P", status: "running", startedAt: 0, lastActivityAt: now - 60_000 },
      { id: "r/agent/1", runId: "r", parentId: "r/phase/P", kind: "agent", name: "b", phase: "P", status: "ok", startedAt: 0, endedAt: 1 },
    ];
    assert.equal(markStalled(nodes, now, () => undefined), 0);
    assert.equal(nodes[1]!.stalledMs, undefined);
    assert.equal(markStalled(nodes, now, () => undefined, 30_000), 1);
    assert.equal(nodes[1]!.stalledMs, 60_000);
    assert.equal(nodes[0]!.stalledMs, 60_000);
  });
});
