// The MCP status tool judges a stale index as of its last ingest and settles changed files
// on the top work items it returns, matching CLI `status` and the MCP `work` tool.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import * as statusCmd from "../../src/cli/commands/status.ts";
import * as workCmd from "../../src/cli/commands/work.ts";
import { recordLastIngest } from "../../src/core/ingest-health.ts";
import { workItemId } from "../../src/core/work.ts";
import type { AgentEvent, Session } from "../../src/core/types.ts";
import { createCodingShMcp, type CodingShMcp } from "../../src/mcp/server.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { workList } from "../../src/viewer/work.ts";
import { mkSession, runCmd, sandbox, type Sandbox } from "../cli/_cmd.ts";

const MIN = 60e3;
const HOUR = 60 * MIN;
type Extra = NonNullable<Parameters<typeof mkSession>[2]>;

async function callTool(mcp: CodingShMcp, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const r = await mcp.server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const res = r!.result as { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, unknown> };
  assert.notEqual(res.isError, true, `${name}: ${res.content[0]?.text}`);
  return res.structuredContent!;
}

describe("MCP status work parity", () => {
  const now = Date.now();
  const lastIngest = now - 3 * HOUR;
  const repo = { root: "/work/demo", head: "", branch: "main" } as Extra["repo"];
  const fc = (id: string, sessionId: string, path: string, ts: number): AgentEvent => ({
    id,
    v: 0,
    sessionId,
    ts,
    agent: "claude-code",
    kind: "file.change",
    payload: { path, op: "modify" },
  });

  let sb: Sandbox;
  let mcp: CodingShMcp;
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

  before(async () => {
    sb = sandbox();
    Object.assign(process.env, { HOME: sb.env.HOME, USERPROFILE: sb.env.HOME });
    const sessions: Session[] = [
      // Active 5 minutes before the last ingest: running as of then, stalled only if judged by wall-clock time.
      mkSession("busy", lastIngest - 15 * MIN, {
        endedAt: undefined,
        cwd: "/work/demo",
        title: "keep working",
        stats: { latency: { wallMs: 10 * MIN } } as Extra["stats"],
      }),
      // Multi-session review item editing overlapping files: sum is 4, distinct is 3.
      mkSession("multi", lastIngest - 40 * MIN, {
        endedAt: lastIngest - 35 * MIN,
        cwd: "/work/demo",
        repo,
        title: "multi session edit",
        stats: { filesChanged: 2 },
      }),
      mkSession("multi:sub:1", lastIngest - 39 * MIN, {
        endedAt: lastIngest - 34 * MIN,
        cwd: "/work/demo",
        repo,
        parent: { sessionId: "multi", subagentId: "1" },
        stats: { filesChanged: 2 },
      }),
      // Review item whose only changed file is outside its repo.
      mkSession("outside", lastIngest - 30 * MIN, {
        endedAt: lastIngest - 25 * MIN,
        cwd: "/work/demo",
        repo,
        title: "outside repo edit",
        stats: { filesChanged: 1 },
      }),
      // Running high-risk session with proof telemetry (active 5 min before lastIngest).
      mkSession("drift", lastIngest - 12 * MIN, {
        endedAt: undefined,
        cwd: "/work/proofs",
        title: "lean proof loop",
        stats: {
          filesChanged: 1,
          latency: { wallMs: 7 * MIN },
          contextHygiene: { supervisionRisk: "high", riskReasons: ["tactic-oscillation", "unverified-edits"] },
          verification: {
            checks: 3,
            passed: 2,
            failed: 1,
            maxUnverifiedEdits: 4,
            proof: { langs: ["lean"], checks: 3, passed: 2, failed: 1, escapeRemaining: 1 },
          },
        } as Extra["stats"],
      }),
    ];
    const events: AgentEvent[] = [
      fc("e1", "multi", "a.ts", lastIngest - 38 * MIN),
      fc("e2", "multi", "b.ts", lastIngest - 37 * MIN),
      fc("e3", "multi:sub:1", "a.ts", lastIngest - 36 * MIN),
      fc("e4", "multi:sub:1", "c.ts", lastIngest - 35 * MIN),
      fc("e5", "outside", "/tmp/out.txt", lastIngest - 28 * MIN),
    ];
    await sb.seed(sessions, events);
    recordLastIngest(sb.env.CODING_SH_HOME!, "0.0.0", lastIngest);
    mcp = createCodingShMcp({
      env: sb.env,
      cwd: sb.root,
      log: () => {},
      now: () => now,
      autoIngest: async () => ({ pendingFiles: 0, indexing: false }),
    });
  });

  after(async () => {
    await mcp?.close();
    Object.assign(process.env, saved);
    sb?.cleanup();
  });

  test("judges a stale index as of its last ingest, matching CLI status and MCP work", async () => {
    const st = await callTool(mcp, "status");
    const wk = await callTool(mcp, "work", { limit: 20 });
    const cli = await runCmd(statusCmd, sb, { json: true });
    assert.equal(cli.error, undefined, cli.error?.stack);

    const index = st.index as { stale?: boolean; updatedAt: string };
    assert.equal(index.stale, true);
    assert.equal(index.updatedAt, new Date(lastIngest).toISOString());

    const stWork = st.work as { stalled: number; review: number; items: Record<string, unknown>[] };
    assert.equal(stWork.stalled, 0);
    assert.equal(stWork.stalled, (cli.json.work as { stalled: number }).stalled);
    assert.equal(stWork.stalled, (wk.counts as { stalled: number }).stalled);
    assert.ok(!stWork.items.some((i) => i.id === workItemId("busy")), "running item is not listed as stalled");
  });

  test("settles shown review items' changed files, matching MCP work", async () => {
    const st = await callTool(mcp, "status");
    const wk = await callTool(mcp, "work", { limit: 20 });
    const stItems = (st.work as { items: Record<string, unknown>[] }).items;
    const wkItems = wk.items as Record<string, unknown>[];

    const multiSt = stItems.find((i) => i.id === workItemId("multi"))!;
    const multiWk = wkItems.find((i) => i.id === workItemId("multi"))!;
    assert.equal(multiSt.filesChanged, 3);
    assert.match(String(multiSt.reason), /with 3 files changed$/);
    assert.match(String(multiSt.stageWhy), /^changed 3 files,/);
    assert.deepEqual(multiSt, multiWk);

    const outSt = stItems.find((i) => i.id === workItemId("outside"))!;
    const outWk = wkItems.find((i) => i.id === workItemId("outside"))!;
    assert.match(String(outSt.next), /^review: `\/tmp\/out\.txt` \(outside \/work\/demo\), then `(?:coding\.sh|codingsh) work ack /);
    assert.deepEqual(outSt, outWk);
  });

  test("MCP work tool filters by kind, bucket and q and rejects invalid filter values", async () => {
    const byKind = await callTool(mcp, "work", { kind: "change", limit: 20 });
    assert.deepEqual((byKind.items as { id: string }[]).map((i) => i.id).sort(), [workItemId("multi"), workItemId("outside")].sort());

    const byBucket = await callTool(mcp, "work", { bucket: "review", limit: 20 });
    assert.equal((byBucket.items as unknown[]).length, 2);

    const byQ = await callTool(mcp, "work", { q: "outside repo", limit: 20 });
    assert.deepEqual((byQ.items as { id: string }[]).map((i) => i.id), [workItemId("outside")]);

    const noneBucket = await callTool(mcp, "work", { bucket: "failed", limit: 20 });
    assert.deepEqual(noneBucket.items, []);

    const badKind = await mcp.server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "work", arguments: { kind: "invalid" } } });
    assert.equal((badKind!.result as { isError?: boolean }).isError, true);

    const badBucket = await mcp.server.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "work", arguments: { bucket: "invalid" } } });
    assert.equal((badBucket!.result as { isError?: boolean }).isError, true);

    const byRisk = await callTool(mcp, "work", { risk: "high", limit: 20 });
    const riskItems = byRisk.items as Record<string, unknown>[];
    assert.deepEqual(riskItems.map((i) => i.id), [workItemId("drift")]);
    assert.equal(riskItems[0]!.supervisionRisk, "high");
    assert.deepEqual(riskItems[0]!.riskReasons, ["tactic-oscillation", "unverified-edits"]);
    assert.deepEqual(riskItems[0]!.proof, { langs: ["lean"], checks: 3, passed: 2, failed: 1, escapeRemaining: 1 });

    const cleanItem = (byKind.items as Record<string, unknown>[]).find((i) => i.id === workItemId("outside"))!;
    assert.equal("supervisionRisk" in cleanItem, false);
    assert.equal("proof" in cleanItem, false);

    const badRisk = await mcp.server.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "work", arguments: { risk: "invalid" } } });
    assert.equal((badRisk!.result as { isError?: boolean }).isError, true);
  });

  test("CLI work, /api/work, and MCP work anchor relative since=1h to lastIngest when index is stale", async () => {
    const cli = await runCmd(workCmd, sb, { json: true, flags: { since: "1h", limit: 20 } });
    assert.equal(cli.error, undefined, cli.error?.stack);
    const mcpRes = await callTool(mcp, "work", { since: "1h", limit: 20 });

    const home = sb.env.CODING_SH_HOME!;
    const idx = await SqliteIndexStore.open(join(home, "index.db"));
    let apiRes: Record<string, unknown>;
    try {
      apiRes = await workList(
        idx,
        { overlay: join(home, "work.json"), root: home, home: sb.env.HOME!, cwd: sb.root, now: () => now },
        new URLSearchParams("since=1h&limit=20"),
      );
    } finally {
      await idx.close();
    }

    const expectedSince = new Date(lastIngest - HOUR).toISOString();
    const expectedIds = [workItemId("multi"), workItemId("outside")].sort();
    assert.equal(cli.json.since, expectedSince);
    assert.equal(mcpRes.since, expectedSince);
    assert.equal(apiRes.since, expectedSince);
    assert.deepEqual((cli.json.items as { id: string }[]).map((i) => i.id).sort(), expectedIds);
    assert.deepEqual((mcpRes.items as { id: string }[]).map((i) => i.id).sort(), expectedIds);
    assert.deepEqual((apiRes.items as { id: string }[]).map((i) => i.id).sort(), expectedIds);
  });
});
