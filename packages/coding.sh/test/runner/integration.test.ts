// End to end against the real src/core/snapshot.ts: a real repo is snapshotted
// into a shadow repo under a temp CODING_SH_HOME, drafted into a task,
// validated, and run under two harnesses.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Session } from "../../src/core/types.ts";
import { draftTaskFromSession } from "../../src/eval/task.ts";
import { validateTask } from "../../src/eval/validate.ts";
import { compare, runExperiment } from "../../src/runner/experiment.ts";
import { runTask } from "../../src/runner/run.ts";
import { BUGGY, FIXED, HIDDEN_TEST, MemBlobs, MemIndex, fakeAdapter, obedientAgent, tempDir, type Tree } from "../helpers-eval.ts";
import { bundleId } from "../../src/runner/bundle.ts";

const prevHome = process.env.CODING_SH_HOME;
let home = "";
let repo = "";

async function write(dir: string, tree: Tree) {
  for (const [p, c] of Object.entries(tree)) {
    await mkdir(dirname(join(dir, p)), { recursive: true });
    await writeFile(join(dir, p), c);
  }
}
const gitq = (args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: repo, env: { ...process.env, GIT_TRACE2_EVENT: "0" } });

describe("integration with src/core/snapshot.ts", () => {
  before(async () => {
    home = await tempDir("csh-home-");
    process.env.CODING_SH_HOME = home;
    repo = await tempDir("csh-repo-");
    await write(repo, BUGGY);
    gitq(["init", "-q"]);
    gitq(["add", "-A"]);
    gitq(["commit", "-q", "-m", "init"]);
  });
  after(async () => {
    if (prevHome === undefined) delete process.env.CODING_SH_HOME;
    else process.env.CODING_SH_HOME = prevHome;
    for (const d of [home, repo]) await rm(d, { recursive: true, force: true, maxRetries: 5 });
  });

  it("snapshot → draft → validate → A/B run", async () => {
    const { snapshot } = await import("../../src/core/snapshot.ts");
    // Past its 2 s default budget a snapshot drops untracked files (partial), and the hidden
    // test below is untracked: a budget a loaded runner can't run out of keeps it.
    const roomy = { timeoutMs: 120_000 };
    const start = await snapshot(repo, roomy);
    assert.ok(start?.snapshot, "start snapshot taken");
    // The "agent" fixes both bugs and writes a test, uncommitted.
    await write(repo, { ...FIXED, "test/add.test.js": HIDDEN_TEST });
    const end = await snapshot(repo, roomy);
    assert.ok(end?.snapshot && end.snapshot !== start.snapshot);

    const index = new MemIndex();
    const blobs = new MemBlobs();
    const session: Session = {
      id: "s1",
      agent: "claude-code",
      repo: start,
      startedAt: 0,
      stats: { events: 2, turns: 1, toolCalls: 1, toolErrors: 0, filesChanged: 3 },
      flags: [],
      endSnapshot: end.snapshot,
    };
    await index.upsertSession(session);
    await index.putEvents([
      { id: "e1", v: 0, sessionId: "s1", ts: 1, agent: "claude-code", kind: "session.start", payload: {}, repo: start },
      { id: "e2", v: 0, sessionId: "s1", ts: 2, agent: "claude-code", kind: "user.message", payload: { text: "add() and mul() are wrong" } },
      { id: "e3", v: 0, sessionId: "s1", ts: 3, agent: "claude-code", kind: "tool.start", payload: { tool: "Bash", input: { command: `cd ${repo} && node test/add.test.js` } } },
    ]);

    const draft = await draftTaskFromSession({ index, blobs, sessionId: "s1", hiddenTests: ["test/**"], setup: [] });
    assert.equal(draft.verifier.command, "node test/add.test.js");
    assert.deepEqual(Object.keys(draft.verifier.hiddenFiles), ["test/add.test.js"]);

    const workRoot = join(home, "validate");
    const v = await validateTask({ task: draft, blobs, workRoot, k: 2, index });
    assert.deepEqual(v.errors, []);
    assert.deepEqual(v.report.leakage, [], v.report.leakage.join("\n"));
    assert.equal(v.report.ok, true, JSON.stringify(v.report));
    assert.equal(v.task.status, "validated");

    const mk = async (name: string, rules: string) => {
      const body = { name, agent: "fake", flags: [], env: {}, files: { "CLAUDE.md": await blobs.put(rules) }, remove: [] };
      return { id: bundleId(body), createdAt: 0, ...body };
    };
    const A = await mk("lazy", "half effort");
    const B = await mk("diligent", "fix everything");
    const { results } = await runExperiment({ tasks: [v.task], bundles: [A, B], adapterFor: () => obedientAgent(), blobs, index, k: 1, concurrency: 2 });
    assert.deepEqual(results.map((r) => [r.bundleId === A.id ? "A" : "B", r.pass, r.error]), [["A", false, undefined], ["B", true, undefined]]);
    const diff = (await blobs.getText(results[1]?.diffBlob ?? "")) ?? "";
    assert.match(diff, /src\/mul\.js/);
    assert.doesNotMatch(diff, /CLAUDE\.md|add\.test\.js/);
    assert.equal(compare(results, { baseline: A.id, candidate: B.id }).candidate.passes, 1);
    assert.deepEqual(results.map((r) => r.tamper), [{ flagged: false, flags: [] }, { flagged: false, flags: [] }], "clean runs are checked, not flagged");

    // Real snapshot diffs spell statuses "add"/"modify": a planted hidden test and a
    // gutted test script are both flagged.
    const cheater = fakeAdapter({
      act: () => ({ "test/add.test.js": "// passes\n", "package.json": (BUGGY["package.json"] as string).replace('"node --test"', '"exit 0"') }),
    });
    const t = await runTask({ task: v.task, bundle: B, adapter: cheater, blobs, index });
    assert.equal(t.pass, false);
    assert.deepEqual(t.tamper?.flags.map((f) => [f.kind, f.path, f.why]), [["script", "package.json", "package-json"], ["create", "test/add.test.js", "hidden"]]);
  });
});
