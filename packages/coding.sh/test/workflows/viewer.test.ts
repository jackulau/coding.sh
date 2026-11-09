// The viewer's workflow routes (docs/design/workflows.md §8): /api/workflows serves the
// same documents `workflows list|show --json` print, and the page has its #/workflows routes.
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { startViewer, type Viewer } from "../../src/viewer/server.ts";
import { buildGantt } from "../../src/workflows/gantt.ts";
import { WorkflowStore } from "../../src/workflows/store.ts";
import type { WorkflowNode } from "../../src/workflows/types.ts";
import { runSummary, workflowsApi, WorkflowApiError } from "../../src/workflows/viewer.ts";
import { FakeBlobs, FakeIndex } from "../viewer/fakes.ts";
import { ganttRunFixture } from "./_fixtures.ts";

let root = "";
let store: WorkflowStore;
let viewer: Viewer;
const fx = ganttRunFixture();

before(async () => {
  root = mkdtempSync(join(tmpdir(), "csh-wf-viewer-"));
  store = new WorkflowStore(join(root, "workflows"));
  await store.putRun(fx.run, fx.nodes);
  viewer = await startViewer({ index: new FakeIndex(), blobs: new FakeBlobs(), port: 0, token: "t".repeat(43), workflows: store, env: { HOME: root, CODING_SH_HOME: join(root, ".coding.sh") }, updateStatus: async () => ({ current: "0.0.0" }) as never });
});
after(async () => {
  await viewer?.close();
  rmSync(root, { recursive: true, force: true });
});

function get(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port: viewer.port, path, headers: { authorization: `Bearer ${"t".repeat(43)}`, host: `127.0.0.1:${viewer.port}` } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null }));
    });
    r.on("error", reject);
    r.end();
  });
}

describe("workflowsApi", () => {
  it("lists runs as `workflows list --json` does", async () => {
    const r = (await workflowsApi(store, undefined, undefined, new URLSearchParams())) as { runs: Record<string, unknown>[] };
    assert.equal(r.runs.length, 1);
    assert.deepEqual(r.runs[0], runSummary((await store.getRun("wf_view01"))!.run));
    assert.equal(r.runs[0]!.costUsd, 3);
  });

  it("serves a run's gantt exactly as buildGantt builds it", async () => {
    const g = await workflowsApi(store, "wf_view01", "gantt", new URLSearchParams());
    const stored = (await store.getRun("wf_view01"))!;
    assert.deepEqual(g, buildGantt(stored.run, stored.nodes));
    const rows = (g as ReturnType<typeof buildGantt>).phases.flatMap((p) => p.rows);
    // The fast finder waited 20 s at the barrier; the slow one is on the critical path.
    assert.equal(rows.find((r) => r.label === "find-a")!.idleAfterMs, 20_000);
    assert.equal(rows.find((r) => r.label === "find-b")!.critical, true);
    assert.equal(rows.find((r) => r.label === "find-a")!.sessionId, "child-a1");
  });

  it("serves a run with stats and agent-level nodes only, as `show --json`", async () => {
    const r = (await workflowsApi(store, "wf_view01", undefined, new URLSearchParams())) as { run: Record<string, any>; nodes: WorkflowNode[] };
    assert.equal(r.run.stats.barrierIdleMs, 20_000);
    assert.equal(r.run.concurrencyCap, 4);
    assert.ok(!r.nodes.some((n) => n.kind === "tool"));
  });

  it("rejects unknown runs, paths and bad queries", async () => {
    await assert.rejects(workflowsApi(store, "nope", undefined, new URLSearchParams()), (e: unknown) => e instanceof WorkflowApiError && e.status === 404);
    await assert.rejects(workflowsApi(store, "wf_view01", "nodes", new URLSearchParams()), (e: unknown) => e instanceof WorkflowApiError && e.status === 404);
    await assert.rejects(workflowsApi(store, undefined, undefined, new URLSearchParams("limit=0")), (e: unknown) => e instanceof WorkflowApiError && e.status === 400);
    await assert.rejects(workflowsApi(store, "x".repeat(300), undefined, new URLSearchParams()), (e: unknown) => e instanceof WorkflowApiError && e.status === 400);
  });
});

describe("viewer /api/workflows", () => {
  it("lists, shows and draws a run over HTTP", async () => {
    const list = await get("/api/workflows");
    assert.equal(list.status, 200);
    assert.equal(list.body.runs[0].id, "wf_view01");
    const one = await get("/api/workflows/wf_view01");
    assert.equal(one.status, 200);
    assert.equal(one.body.run.name, "review");
    const g = await get("/api/workflows/wf_view01/gantt");
    assert.equal(g.status, 200);
    assert.deepEqual(g.body.phases.map((p: { name: string }) => p.name), ["Find", "Verify"]);
    assert.equal(g.body.cap, 4);
    assert.ok(g.body.concurrency.length > 0);
  });

  it("answers 404 for an unknown run and refuses writes", async () => {
    assert.equal((await get("/api/workflows/missing/gantt")).status, 404);
    assert.equal((await get("/api/workflows/wf_view01/gantt/extra")).status, 404);
  });
});

describe("viewer page", () => {
  const page = readFileSync(new URL("../../src/viewer/ui/index.html", import.meta.url), "utf8");
  it("routes #/workflows and #/workflows/:id to their views", () => {
    assert.match(page, /parts\[0\] === "workflows" && parts\[1\]\) return showWorkflow\(seq, parts\[1\]\)/);
    assert.match(page, /parts\[0\] === "workflows"\) return showWorkflows\(seq\)/);
    assert.match(page, /async function showWorkflow\(seq, id\)/);
  });
  it("draws status, cached, critical-path and barrier-idle marks, and links bars to sessions", () => {
    for (const cls of ["s-failed", "s-cached", "s-null", ".critical", "wfg-idle"]) assert.ok(page.includes(cls), cls);
    assert.match(page, /sessionHref\(r\.sessionId\)/);
    assert.match(page, /api\("\/api\/workflows\/" \+ encodeURIComponent\(id\) \+ "\/gantt"\)/);
  });
});
