import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { RunSpec } from "../../src/core/types.ts";
import { runTask } from "../../src/runner/run.ts";
import { cleanupWorlds, fakeAdapter, obedientAgent, toyWorld } from "../helpers-eval.ts";

after(cleanupWorlds);

describe("runTask", () => {
  it("runs the agent in an overlaid work dir and grades it with hidden tests", async () => {
    const w = await toyWorld();
    const adapter = obedientAgent();
    const bundle = await w.mkBundle("fixer", "always fix bugs");
    const r = await runTask({ task: w.task, bundle, adapter, blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir, attempt: 2, experimentId: "e1", env: { EXTRA: "x" } });
    assert.equal(r.error, undefined);
    assert.equal(r.pass, true);
    assert.equal(r.verifierExit, 0);
    assert.equal(r.attempt, 2);
    assert.equal(r.experimentId, "e1");
    assert.equal(r.sessionId, `sess-${r.id}`);
    assert.deepEqual(w.index.runs, [r]);
    const spec = adapter.specs[0] as RunSpec;
    assert.equal(spec.instruction, "fix add and mul");
    assert.equal(spec.env.CODING_SH_RUN_ID, r.id);
    assert.equal(spec.env.FROM_BUNDLE, "1");
    assert.equal(spec.env.EXTRA, "x");
    assert.equal(spec.env.HOME, undefined, "no ~/ files → no HOME override");
    assert.deepEqual(spec.flags, ["--b", "--fake-overlay"]);
    // Agent's diff only: no overlay (CLAUDE.md, README removal), no setup output, no hidden tests.
    const diff = (await w.blobs.getText(r.diffBlob ?? "")) ?? "";
    assert.match(diff, /src\/add\.js/);
    assert.match(diff, /src\/mul\.js/);
    assert.doesNotMatch(diff, /CLAUDE\.md|README|build\.log|add\.test\.js/);
    assert.deepEqual(await readdir(w.runsDir), [], "run dir cleaned up");
  });

  it("records a failing attempt without throwing", async () => {
    const w = await toyWorld();
    const r = await runTask({ task: w.task, bundle: await w.mkBundle("half", "half effort"), adapter: obedientAgent(), blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir });
    assert.equal(r.pass, false);
    assert.equal(r.verifierExit, 1);
    assert.equal(r.error, undefined);
  });

  it("an agent that throws becomes an error; the verifier still runs", async () => {
    const w = await toyWorld();
    const r = await runTask({ task: w.task, bundle: await w.mkBundle("x", "x"), adapter: fakeAdapter({ throws: true }), blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir });
    assert.equal(r.pass, false);
    assert.match(r.error ?? "", /agent failed: agent exploded/);
    assert.equal(r.verifierExit, 1);
    assert.equal(w.index.runs.length, 1);
  });

  it("setup failure is recorded and the agent never runs", async () => {
    const w = await toyWorld();
    const adapter = obedientAgent();
    const r = await runTask({ task: { ...w.task, setup: ["exit 9"] }, bundle: await w.mkBundle("x", "fix"), adapter, blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir });
    assert.match(r.error ?? "", /setup `exit 9` exited 9/);
    assert.equal(adapter.specs.length, 0);
    assert.equal(w.index.runs.length, 1);
  });

  it("~/ overlay files get an isolated HOME inside the run dir; keep leaves the dir", async () => {
    const w = await toyWorld();
    const bundle = await w.mkBundle("home", "fix", { files: { "CLAUDE.md": await w.blobs.put("fix"), "~/.claude/CLAUDE.md": await w.blobs.put("user-level") } });
    const adapter = obedientAgent();
    const r = await runTask({ task: w.task, bundle, adapter, blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir, keep: true });
    const home = (adapter.specs[0] as RunSpec).env.HOME ?? "";
    assert.equal(home, join(w.runsDir, r.id, "home"));
    assert.notEqual(home, process.env.HOME);
    assert.equal(await readFile(join(home, ".claude/CLAUDE.md"), "utf8"), "user-level");
    assert.ok(existsSync(join(w.runsDir, r.id, "work", "src/add.js")));
  });

  it("a broken snapshot is an error result, not an exception", async () => {
    const w = await toyWorld();
    const r = await runTask({ task: { ...w.task, start: { ...w.task.start, snapshot: "missing" } }, bundle: await w.mkBundle("x", "x"), adapter: obedientAgent(), blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir });
    assert.match(r.error ?? "", /unknown snapshot/);
    assert.equal(r.pass, false);
  });
});
