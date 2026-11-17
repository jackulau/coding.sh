// Regression tests for the QA round on read latency: a read with a pending capture answers at its
// budget (the tail adapters' reads run in a worker it stops waiting for), and `workflows list`
// leaves a live run's big transcripts to a background import instead of reading them itself.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { autoIngest } from "../../src/cli/common.ts";
import { tailWithin } from "../../src/cli/ingest-worker.ts";
import { openContext } from "../../src/core/context.ts";

const MAIN = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const PROJECTS = fileURLToPath(new URL("../fixtures/workflows/claude-code-running/projects", import.meta.url));

const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

function sandbox(): { root: string; env: NodeJS.ProcessEnv } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "csh-qa-r2-lat-")));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    CODING_SH_HOME: join(root, "data"),
    XDG_CONFIG_HOME: join(home, ".config"),
    CLAUDE_CONFIG_DIR: join(root, "claude"),
    CODEX_HOME: join(root, "codex"),
    T3CODE_HOME: join(root, "t3"),
    PATH: process.env.PATH,
    NO_COLOR: "1",
    CI: "1",
    CODING_SH_NO_AUTO_INGEST: "1",
    CODING_SH_NO_UPDATE_CHECK: "1",
  };
  return { root, env };
}

describe("a read with a capture source pending", () => {
  test("autoIngest stops waiting for the tail adapters at its deadline", async () => {
    const { root, env } = sandbox();
    // T3 Code's database is a capture path (Adapter.tail): its presence is what makes the read look at it.
    mkdirSync(join(root, "t3", "userdata"), { recursive: true });
    writeFileSync(join(root, "t3", "userdata", "statev2.sqlite"), "");
    const ctx = await openContext({ env });
    try {
      const started = Date.now();
      await autoIngest(ctx, { budgetMs: 300, env });
      // Read in this thread, T3 Code's database (not a database here) took 27 s to give up on.
      assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
    } finally {
      await ctx.close();
    }
  });

  test("tailWithin resolves late, with the source pending, when the worker is still reading at the deadline", async () => {
    const { env } = sandbox();
    const started = Date.now();
    const r = await tailWithin({ env, cwd: process.cwd(), deadline: Date.now() + 2000, stallMs: 20_000 });
    assert.deepEqual(r, { pending: 1, late: true });
    assert.ok(Date.now() - started < 10_000);
  });

  test("a process whose tail read is stuck in a native call still exits at its deadline", () => {
    // A worker thread blocked in a native call cannot be terminated and holds the process open until it returns
    // (12 to 42 s on a loaded Windows machine); the tail read runs in a child process that is killed instead.
    const { env } = sandbox();
    const script = `import { tailWithin } from ${JSON.stringify(pathToFileURL(fileURLToPath(new URL("../../src/cli/ingest-worker.ts", import.meta.url))).href)};
      const r = await tailWithin({ env: process.env, cwd: process.cwd(), deadline: Date.now() + 4000, stallMs: 30000 });
      console.log(JSON.stringify(r));`;
    const started = Date.now();
    const r = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], { env: { ...process.env, ...env }, encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout.trim()), { pending: 1, late: true });
    assert.ok(Date.now() - started < 20_000, `took ${Date.now() - started} ms`);
  });

  test("tailWithin claims nothing pending when the deadline passes before the worker reads", async () => {
    const { env } = sandbox();
    const r = await tailWithin({ env, cwd: process.cwd(), deadline: Date.now() });
    assert.equal(r.late, false);
  });
});

describe("workflows list during a live run", () => {
  test("a run whose transcripts are big is left to a background import: list answers with the note and pending", () => {
    const { root, env } = sandbox();
    const projects = join(root, "claude", "projects");
    cpSync(PROJECTS, projects, { recursive: true });
    const run = join(projects, "-work-demo", "5a1d7c3e-0b2f-4c6d-9e8f-1a2b3c4d5e6f", "subagents", "workflows", "wf_7d3c2a10-5be");
    // The live run's agent transcript has grown past what a list reads (padding the importer never parses here).
    appendFileSync(join(run, "agent-a3c5e7f9b1d2e4f60.jsonl"), "\n".repeat(3 * 1024 * 1024));
    const cli = (args: string[]) => spawnSync(process.execPath, ["--no-warnings", MAIN, ...args], { cwd: root, env, encoding: "utf8" });
    const r = cli(["workflows", "list", "--json"]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout) as { runs: unknown[]; pending?: { runs: number; importing: boolean } };
    assert.deepEqual(out.runs, []);
    assert.deepEqual(out.pending, { runs: 1, importing: false });
    assert.match(cli(["workflows", "list"]).stderr, /1 workflow run changed since the last import/);
    // An explicit import is not budgeted: it reads the run, and the next list shows it without a pending note.
    const imp = cli(["workflows", "import", projects, "--json"]);
    assert.equal(imp.status, 0, imp.stderr);
    assert.equal(JSON.parse(imp.stdout).imported.length, 1);
    const again = cli(["workflows", "list", "--json"]);
    const j = JSON.parse(again.stdout) as { runs: unknown[]; pending?: unknown };
    assert.equal(j.runs.length, 1);
    assert.equal(again.stderr.includes("changed since the last import"), false);
  });

  test("a small run is imported by the list itself", () => {
    const { root, env } = sandbox();
    const projects = join(root, "claude", "projects");
    cpSync(PROJECTS, projects, { recursive: true });
    const r = spawnSync(process.execPath, ["--no-warnings", MAIN, "workflows", "list", "--json"], { cwd: root, env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout) as { runs: unknown[]; pending?: unknown };
    assert.equal(out.runs.length, 1);
    assert.equal(out.pending, undefined);
  });
});
