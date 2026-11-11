// Trial dirs under a folder whose package.json says "type": "module" (a
// CODING_SH_HOME inside a JS project, or a ~/package.json): a task with no
// package.json of its own still runs its CommonJS verifier. Each trial root
// gets a package.json with no "type", so Node stops there.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { EvalTask } from "../../src/core/types.ts";
import { validateTask } from "../../src/eval/validate.ts";
import { runTask } from "../../src/runner/run.ts";
import { prepareSandbox } from "../../src/toolevals/sandbox.ts";
import { FakeSnapshots, MemIndex, cleanupWorlds, fakeAdapter, tempDir, toyWorld } from "../helpers-eval.ts";
import { cliTarget, task as toolTask } from "../toolevals/helpers.ts";

const dirs: string[] = [];
after(async () => {
  await cleanupWorlds();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const CHECK = 'const fs = require("fs");\nprocess.exit(fs.readFileSync("answer.txt", "utf8").trim() === "yes" ? 0 : 1);\n';
const PATCH = ["diff --git a/answer.txt b/answer.txt", "--- a/answer.txt", "+++ b/answer.txt", "@@ -1 +1 @@", "-no", "+yes", ""].join("\n");

/** A dir whose package.json makes every .js below it ESM. */
async function esmParent(): Promise<string> {
  const d = await tempDir("csh-esm-parent-");
  dirs.push(d);
  writeFileSync(join(d, "package.json"), '{ "type": "module" }\n');
  return d;
}

describe("trial dirs under a type:module ancestor", () => {
  it("runTask: a CommonJS verifier passes", async () => {
    const parent = await esmParent();
    const w = await toyWorld();
    const git = new FakeSnapshots().add("start", { "answer.txt": "no\n" });
    const t: EvalTask = { ...w.task, setup: [], verifier: { command: "node check.js", hiddenFiles: { "check.js": await w.blobs.put(CHECK) }, timeoutMs: 30_000 } };
    const agent = fakeAdapter({ act: () => ({ "answer.txt": "yes\n" }) });
    const r = await runTask({ task: t, bundle: await w.mkBundle("x", "x"), adapter: agent, blobs: w.blobs, index: w.index, git, runsDir: join(parent, "runs") });
    assert.equal(r.error, undefined);
    assert.equal(r.pass, true, `verifier exit ${r.verifierExit}`);
  });

  it("validateTask: the reference passes", async () => {
    const parent = await esmParent();
    const w = await toyWorld();
    const git = new FakeSnapshots().add("start", { "answer.txt": "no\n" });
    const t: EvalTask = { ...w.task, status: "draft", setup: [], referencePatch: await w.blobs.put(PATCH), verifier: { command: "node check.js", hiddenFiles: { "check.js": await w.blobs.put(CHECK) }, timeoutMs: 30_000 } };
    const o = await validateTask({ task: t, blobs: w.blobs, git, workRoot: join(parent, "work"), k: 1, index: new MemIndex(), passToPass: false });
    assert.deepEqual(o.report.referencePasses, { passed: 1, of: 1 }, JSON.stringify(o.steps.map((s) => s.outputTail ?? "")));
  });

  it("toolevals sandbox: a CommonJS script in the work dir runs", async () => {
    const parent = await esmParent();
    mkdirSync(join(parent, "te"));
    const sb = await prepareSandbox(toolTask(), cliTarget(), { name: "base" }, "trial_scope", join(parent, "te"));
    writeFileSync(join(sb.work, "check.js"), 'require("fs");\n');
    const r = spawnSync(process.execPath, ["check.js"], { cwd: sb.work, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  });
});
