// The production→CI loop (D-3), end to end on a fixture repo: a flagged session
// in the store → `eval init --where … --validate` drafts a validated task into
// evals/<suite>/ → the task dir is read back (as `eval run` does in CI) and run
// against two branches' harness: the regressed CLAUDE.md fails it, the fixed one
// passes it, and the report line says which captured failures now pass.
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { AgentEvent, Session } from "../../src/core/types.ts";
import { CAPTURED_FAILURE_TAG, initSuite } from "../../src/eval/init.ts";
import { capturedFailuresLine, trialsFromRuns } from "../../src/eval/run-suite.ts";
import { importTaskDir } from "../../src/eval/task.ts";
import { parseWhere } from "../../src/query/where.ts";
import { runExperiment } from "../../src/runner/experiment.ts";
import { BUGGY, cleanupWorlds, FIXED, HIDDEN_TEST, obedientAgent, tempDir, toyWorld } from "../helpers-eval.ts";

const dirs: string[] = [];
after(async () => {
  await cleanupWorlds();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const NOW = Date.UTC(2026, 10, 8);

function sessionWith(id: string, root: string, flags: string[], prompts: string[]): { s: Session; events: AgentEvent[] } {
  const startedAt = NOW - 3_600_000;
  const repo = { root, head: "h", snapshot: "start" };
  const s: Session = { id, agent: "claude-code", repo, startedAt, endedAt: startedAt + 60_000, stats: { events: 6, turns: prompts.length, toolCalls: 2, toolErrors: 0, filesChanged: 3 }, flags, endSnapshot: "end" };
  let i = 0;
  const ev = (kind: AgentEvent["kind"], payload: Record<string, unknown>, extra: Partial<AgentEvent> = {}): AgentEvent => ({ id: `${id}-${i}`, v: 0, sessionId: id, ts: startedAt + i++, agent: "claude-code", kind, payload, ...extra });
  const events = [
    ev("session.start", {}, { repo }),
    ev("user.message", { text: prompts[0] }),
    ev("tool.start", { tool: "Edit", toolUseId: "t1", input: { file_path: `${root}/src/add.js` } }),
    ev("assistant.message", { text: "Done, both functions are fixed." }),
    ...prompts.slice(1).map((text) => ev("user.message", { text })),
    ev("tool.start", { tool: "Bash", toolUseId: "t2", input: { command: "node test/add.test.js" } }),
  ];
  return { s, events };
}

describe("production → CI loop", () => {
  it("turns a flagged session into a validated task that fails on the regressed branch and passes on the fixed one", async () => {
    const w = await toyWorld();
    w.git.add("end", { ...FIXED, "test/add.test.js": HIDDEN_TEST });
    const root = await tempDir("csh-ci-loop-");
    dirs.push(root);
    // The agent claimed done too early (premature-completion); the user pushed back and the session ended fixed.
    const flagged = sessionWith("s-flagged", root, ["premature-completion"], ["add() and mul() return wrong results; fix them", "the tests still fail, mul is wrong too"]);
    const clean = sessionWith("s-clean", root, [], ["rename the README title"]);
    for (const x of [flagged, clean]) {
      await w.index.upsertSession(x.s);
      await w.index.putEvents(x.events);
    }

    const workRoot = await tempDir("csh-ci-loop-validate-");
    dirs.push(workRoot);
    const r = await initSuite(
      { name: "failures", root, source: "sessions", where: parseWhere("flag:premature-completion"), verifier: "node test/add.test.js", hiddenTests: ["test/**"], validate: { workRoot, k: 2, passToPass: false } },
      { index: w.index, blobs: w.blobs, git: w.git, now: NOW },
    );
    assert.deepEqual(r.tasks?.map((t) => t.sessionId), ["s-flagged"], "only the session the query matches");
    assert.match(r.notes[0]!, /^1 of 1 task\(s\) validated/);
    const stored = await w.index.getTask(r.tasks![0]!.id);
    assert.equal(stored?.status, "validated");
    assert.ok(stored?.tags.includes(CAPTURED_FAILURE_TAG));
    assert.ok(stored?.referencePatch, "the session's end state passed the verifier, so its diff is the reference");

    // CI: the suite dir in the checkout is all there is.
    const files = r.files.filter((f) => f.startsWith("evals/failures/tasks/"));
    assert.equal(files.length, 1);
    const task = await importTaskDir(join(root, files[0]!), w.blobs);
    assert.equal(task.status, "validated");
    assert.match(await readFile(join(root, files[0]!, "reference.patch"), "utf8"), /return a \* b/);

    const branch = async (name: string, claude: string) => {
      const bundle = await w.mkBundle(name, claude, { remove: [] });
      const run = await runExperiment({ tasks: [task], bundles: [bundle], adapterFor: () => obedientAgent(), blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir });
      return { pass: run.results.map((x) => x.pass), line: capturedFailuresLine([task], trialsFromRuns([task], run.results)) };
    };
    const regressed = await branch("regressed", "Answer in one line. Never edit files.");
    const fixed = await branch("fixed", "Read the failing test first, then fix the code.");
    assert.deepEqual(regressed.pass, [false]);
    assert.equal(regressed.line, "captured failures: 0 of 1 now pass");
    assert.deepEqual(fixed.pass, [true]);
    assert.equal(fixed.line, `captured failures: 1 of 1 now pass: ${task.name} (session s-flagged)`);
  });

  it("keeps a flagged session whose end state fails the verifier as a near miss", async () => {
    const w = await toyWorld();
    w.git.add("end", { ...BUGGY, "src/add.js": FIXED["src/add.js"] as string, "test/add.test.js": HIDDEN_TEST });
    const root = await tempDir("csh-ci-loop-");
    dirs.push(root);
    const x = sessionWith("s-half", root, ["repeated-tool-failure"], ["add() and mul() return wrong results; fix them"]);
    await w.index.upsertSession(x.s);
    await w.index.putEvents(x.events);
    const workRoot = await tempDir("csh-ci-loop-validate-");
    dirs.push(workRoot);
    const r = await initSuite({ name: "failures", root, source: "sessions", verifier: "node test/add.test.js", hiddenTests: ["test/**"], validate: { workRoot, passToPass: false } }, { index: w.index, blobs: w.blobs, git: w.git, now: NOW });
    const t = await w.index.getTask(r.tasks![0]!.id);
    assert.equal(t?.status, "draft");
    assert.equal(t?.referencePatch, undefined);
    assert.equal(t?.nearMissPatches?.length, 1);
    assert.match(r.notes[0]!, /^0 of 1 task\(s\) validated/);
    assert.ok(r.notes.some((n) => /end state fails the verifier, so its diff is kept as a near miss/.test(n)));
  });
});
