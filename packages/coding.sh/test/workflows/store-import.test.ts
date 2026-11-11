import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { importClaudeWorkflows } from "../../src/workflows/import.ts";
import { WorkflowStore } from "../../src/workflows/store.ts";
import { workflowStats } from "../../src/workflows/metrics.ts";
import type { WorkflowRun } from "../../src/workflows/types.ts";
import { MemBlobs, MemIndex } from "../otel/_memstore.ts";
import { AGENTS, RESUMED, RUN, RUN_OUTPUT, SCRIPT, SID, writeClaudeWorkflowFixture } from "./_fixtures.ts";

let root = "";
before(() => {
  root = mkdtempSync(join(tmpdir(), "csh-wf-store-"));
});
after(() => rmSync(root, { recursive: true, force: true }));

const mkRun = (id: string, o: Partial<WorkflowRun> = {}): WorkflowRun => {
  const r: WorkflowRun = { id, framework: "command", name: "wf", startedAt: 1000, endedAt: 2000, status: "ok", stats: undefined as unknown as WorkflowRun["stats"], tags: [], ...o };
  r.stats = workflowStats(r, []);
  return r;
};

describe("WorkflowStore", () => {
  it("stores runs, outputs and scripts, lists newest first with filters, last write wins", async () => {
    const store = new WorkflowStore(join(root, "s1"));
    await store.putRun(mkRun("r/1", { startedAt: 1000, name: "a" }), [], { runOutput: { x: 1 }, script: "phase('A')" });
    await store.putRun(mkRun("r2", { startedAt: 3000, name: "b", framework: "langgraph", experimentId: "e1" }), []);
    await store.putRun(mkRun("r3", { startedAt: 2000, name: "a" }), []);
    await store.putRun(mkRun("r3", { startedAt: 2000, name: "a", status: "failed" }), []);
    assert.deepEqual((await store.listRuns()).map((r) => r.id), ["r2", "r3", "r/1"]);
    assert.deepEqual((await store.listRuns({ name: "a" })).map((r) => r.id), ["r3", "r/1"]);
    assert.deepEqual((await store.listRuns({ framework: "langgraph" })).map((r) => r.id), ["r2"]);
    assert.deepEqual((await store.listRuns({ since: 2500 })).map((r) => r.id), ["r2"]);
    assert.deepEqual((await store.listRuns({ experimentId: "e1" })).map((r) => r.id), ["r2"]);
    assert.deepEqual((await store.listRuns({ limit: 1 })).map((r) => r.id), ["r2"]);
    assert.equal((await store.listRuns({ name: "a" }))[0]!.status, "failed");
    const got = (await store.getRun("r/1"))!;
    assert.deepEqual(await store.getValue(got.run.output!), { x: 1 });
    assert.equal(await store.getText(got.run.script!), "phase('A')");
    assert.equal(await store.getRun("missing"), undefined);
    // The index keeps summaries only.
    assert.equal((await store.listRuns())[0]!.stats.perAgent, undefined);
  });

  it("stores experiments", async () => {
    const store = new WorkflowStore(join(root, "s2"));
    await store.putExperiment({ id: "e1", workflow: "w", driver: "command", variants: [{ name: "a" }], caseIds: ["c"], k: 1, runIds: [], scores: {}, createdAt: 1 });
    await store.putExperiment({ id: "e2", workflow: "w", driver: "command", variants: [{ name: "a" }], caseIds: ["c"], k: 1, runIds: ["r"], scores: { r: 1 }, createdAt: 2 });
    assert.deepEqual((await store.listExperiments()).map((e) => e.id), ["e2", "e1"]);
    assert.deepEqual((await store.getExperiment("e2"))!.scores, { r: 1 });
  });

  it("resolves under CODING_SH_HOME", () => {
    const s = WorkflowStore.forEnv({ CODING_SH_HOME: join(root, "home") });
    assert.equal(s.root, join(root, "home", "workflows"));
  });
});

describe("importClaudeWorkflows", () => {
  it("imports run dirs into the store and agent transcripts into the index, then skips unchanged dirs", async () => {
    const projects = join(root, "projects");
    const dirs = writeClaudeWorkflowFixture(projects);
    const store = new WorkflowStore(join(root, "imp"));
    const index = new MemIndex();
    const blobs = new MemBlobs();
    const seen: string[] = [];
    const r1 = await importClaudeWorkflows({ root: projects, store, index, blobs, concurrencyCap: 4, onRun: (r) => seen.push(r.id) });
    assert.equal(r1.found, 2);
    assert.deepEqual(r1.errors, []);
    assert.deepEqual(r1.imported.map((r) => r.id).sort(), [RESUMED, RUN].sort());
    assert.deepEqual(seen.sort(), [RESUMED, RUN].sort());

    const stored = (await store.getRun(RUN))!;
    assert.equal(stored.run.source?.kind, "journal");
    assert.equal(stored.run.source?.path, dirs.base);
    assert.deepEqual(await store.getValue(stored.run.output!), RUN_OUTPUT);
    assert.equal(await store.getText(stored.run.script!), SCRIPT);
    const findA = stored.nodes.find((n) => n.name === "find-a")!;
    assert.deepEqual(await store.getValue(findA.output!), AGENTS[0]!.result);

    // Child sessions, linked to the host session, one per agent transcript (9 + 2).
    assert.equal(index.sessions.size, 11);
    const child = index.sessions.get(findA.sessionId!)!;
    assert.equal(child.parent?.sessionId, SID);
    assert.equal(child.parent?.subagentId, "a0");

    // Second pass: the resumed run's savings use the stored base run.
    const res = (await store.getRun(RESUMED))!;
    assert.equal(res.run.stats.cacheHits, 7);
    assert.ok(Math.abs(res.run.stats.resumeSavedUsd! - 0.8) < 1e-9);

    const r2 = await importClaudeWorkflows({ root: projects, store, index, concurrencyCap: 4 });
    assert.equal(r2.skipped, 2);
    assert.equal(r2.imported.length, 0);
    const r3 = await importClaudeWorkflows({ root: projects, store, force: true, concurrencyCap: 4 });
    assert.equal(r3.imported.length, 2);
  });

  it("skips an unchanged run dir without reading its agent transcripts", async () => {
    const projects = join(root, "projects-skip");
    writeClaudeWorkflowFixture(projects);
    const store = new WorkflowStore(join(root, "imp-skip"));
    // Every payload goes to the blob store, so reading a transcript shows up as puts.
    let puts = 0;
    const blobs = new MemBlobs();
    const put = blobs.put.bind(blobs);
    blobs.put = (d) => {
      puts++;
      return put(d);
    };
    await importClaudeWorkflows({ root: projects, store, index: new MemIndex(), blobs, maxInlineBytes: 1, concurrencyCap: 4 });
    assert.ok(puts > 0);
    puts = 0;
    const again = await importClaudeWorkflows({ root: projects, store, index: new MemIndex(), blobs, maxInlineBytes: 1, concurrencyCap: 4 });
    assert.equal(again.skipped, 2);
    assert.equal(puts, 0, "no transcript was read");
  });

  it("writes a run's agent events to the index in few large batches", async () => {
    // One agent with 400 tool calls: well over a thousand events. Each index write commits a
    // transaction (and an FTS segment), so 500-event batches made the import ~30% slower.
    const projects = join(root, "projects-batch");
    const runDir = join(projects, "-work-demo", SID, "subagents", "workflows", "wf_batch01");
    mkdirSync(runDir, { recursive: true });
    const t = Date.UTC(2026, 10, 1);
    const base = { sessionId: SID, cwd: "/work/demo", isSidechain: true, agentId: "b0" };
    const lines = [{ ...base, type: "user", uuid: "u", timestamp: new Date(t).toISOString(), message: { role: "user", content: "go" } }];
    for (let i = 0; i < 400; i++) {
      const ts = new Date(t + 1000 * (i + 1)).toISOString();
      lines.push(
        { ...base, type: "assistant", uuid: `a${i}`, timestamp: ts, message: { id: `m${i}`, role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "tool_use", id: `t${i}`, name: "Bash", input: { command: "ls" } }], usage: { input_tokens: 1, output_tokens: 1 } } } as never,
        { ...base, type: "user", uuid: `r${i}`, timestamp: ts, message: { role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "ok" }] } } as never,
      );
    }
    writeFileSync(join(runDir, "agent-b0.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    writeFileSync(join(runDir, "journal.jsonl"), [{ type: "launched" }, { type: "started", key: "k", agentId: "b0", label: "big" }, { type: "result", key: "k", agentId: "b0", result: 1 }].map((x) => JSON.stringify(x)).join("\n") + "\n");
    const index = new MemIndex();
    const sizes: number[] = [];
    const putEvents = index.putEvents.bind(index);
    index.putEvents = (b) => {
      sizes.push(b.length);
      return putEvents(b);
    };
    const r = await importClaudeWorkflows({ root: projects, store: new WorkflowStore(join(root, "imp-batch")), index, concurrencyCap: 4 });
    assert.equal(r.imported.length, 1);
    assert.ok(sizes[0]! > 1000, String(sizes));
    assert.equal(sizes.length, 1);
  });

  it("keeps experiment tags when a changed run dir is re-imported", async () => {
    const projects = join(root, "projects2");
    const dirs = writeClaudeWorkflowFixture(projects);
    const store = new WorkflowStore(join(root, "imp2"));
    await importClaudeWorkflows({ root: dirs.base, store, concurrencyCap: 4 });
    const got = (await store.getRun(RUN))!;
    Object.assign(got.run, { variant: "v1", experimentId: "wfx_1", caseId: "c1", attempt: 2, tags: ["variant:v1"] });
    await store.putRun(got.run, got.nodes);
    appendFileSync(join(dirs.base, "journal.jsonl"), JSON.stringify({ type: "note" }) + "\n");
    const r = await importClaudeWorkflows({ root: dirs.base, store, concurrencyCap: 4 });
    assert.equal(r.imported.length, 1);
    const again = (await store.getRun(RUN))!.run;
    assert.equal(again.variant, "v1");
    assert.equal(again.experimentId, "wfx_1");
    assert.equal(again.caseId, "c1");
    assert.equal(again.attempt, 2);
    assert.deepEqual(again.tags, ["variant:v1"]);
  });

  it("finds nothing under a missing directory", async () => {
    const store = new WorkflowStore(join(root, "imp3"));
    const r = await importClaudeWorkflows({ root: join(root, "nowhere"), store });
    assert.deepEqual(r, { found: 0, imported: [], skipped: 0, copies: 0, errors: [] });
  });
});
