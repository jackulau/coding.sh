// A Claude Code workflow run whose agent transcripts carry tokens but no
// reported cost (the real shape: Claude Code never writes a per-call cost).
// Importing with the effective prices fills an estimated cost on every node,
// phase and child session; importing without prices leaves them uncosted.
//
// The fixture is synthetic (paths /work/demo, model names only), never read
// from a real ~/.claude.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { importClaudeWorkflows } from "../../src/workflows/import.ts";
import { WorkflowStore } from "../../src/workflows/store.ts";
import { pricesFor } from "../../src/core/pricing.ts";
import { MemBlobs, MemIndex } from "../otel/_memstore.ts";

const T0 = Date.UTC(2026, 10, 8, 9, 0, 0);
const SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SLUG = "-work-demo";
const RUN = "wf_price001";
const MODEL = "claude-opus-4-8";
const iso = (ms: number) => new Date(ms).toISOString();

interface Spec {
  id: string;
  label: string;
  phase: string;
  start: number;
  end: number;
}

const SPECS: Spec[] = [
  { id: "s0", label: "scout:a", phase: "Scout", start: T0, end: T0 + 60_000 },
  { id: "s1", label: "scout:b", phase: "Scout", start: T0 + 100, end: T0 + 70_000 },
  { id: "y0", label: "synthesize", phase: "Synthesize", start: T0 + 71_000, end: T0 + 110_000 },
];

/** A subagent transcript: a prompt and one assistant message with usage but no cost_usd. */
function transcript(a: Spec): string {
  const base = { sessionId: SID, cwd: "/work/demo", version: "2.1.319", gitBranch: "main", userType: "external", entrypoint: "cli", isSidechain: true, agentId: a.id };
  const usage = { input_tokens: 5, output_tokens: 300, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 4000 };
  const lines: unknown[] = [
    { ...base, type: "user", uuid: `${a.id}-u0`, parentUuid: null, timestamp: iso(a.start), message: { role: "user", content: `Task: ${a.label}` } },
    { ...base, type: "assistant", uuid: `${a.id}-a0`, parentUuid: `${a.id}-u0`, timestamp: iso(a.end - 500), message: { id: `msg_${a.id}`, type: "message", role: "assistant", model: MODEL, content: [{ type: "text", text: `Done ${a.label}` }], stop_reason: "end_turn", usage } },
  ];
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

function writeRun(projects: string): string {
  const sessionDir = join(projects, SLUG, SID);
  const runDir = join(sessionDir, "subagents", "workflows", RUN);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(join(sessionDir, "workflows"), { recursive: true });
  const journal: unknown[] = [{ type: "launched", runId: RUN }];
  for (const a of SPECS) journal.push({ type: "started", key: `v2:${a.id}`, agentId: a.id, label: a.label, phase: a.phase });
  for (const a of SPECS) {
    journal.push({ type: "result", key: `v2:${a.id}`, agentId: a.id, result: { ok: a.label }, toolsUsed: [] });
    writeFileSync(join(runDir, `agent-${a.id}.jsonl`), transcript(a));
    writeFileSync(join(runDir, `agent-${a.id}.meta.json`), JSON.stringify({ agentType: "workflow-subagent", description: a.label, workflowPhase: a.phase, spawnDepth: 1, pickedEffortModel: MODEL }));
  }
  writeFileSync(join(runDir, "journal.jsonl"), journal.map((j) => JSON.stringify(j)).join("\n") + "\n");
  writeFileSync(join(sessionDir, "workflows", `${RUN}.json`), JSON.stringify({ runId: RUN, workflowName: "research", status: "completed", startTime: T0 }));
  return projects;
}

let root = "";
let projects = "";
before(() => {
  root = mkdtempSync(join(tmpdir(), "csh-wf-price-"));
  projects = writeRun(join(root, "projects"));
});
after(() => rmSync(root, { recursive: true, force: true }));

describe("importClaudeWorkflows pricing", () => {
  it("estimates cost on every node, phase and child session when prices are passed", async () => {
    const store = new WorkflowStore(join(root, "priced"));
    const index = new MemIndex();
    const r = await importClaudeWorkflows({ root: projects, store, index, blobs: new MemBlobs(), prices: pricesFor(), concurrencyCap: 4 });
    assert.equal(r.imported.length, 1);

    const { run, nodes } = (await store.getRun(RUN))!;
    const s = run.stats;
    assert.ok(s.costUsd !== undefined && s.costUsd > 0, `run cost ${s.costUsd}`);

    // Every phase carries cost, and the shares sum to one.
    assert.ok(s.perPhase && s.perPhase.length === 2);
    assert.ok(s.perPhase.every((p) => p.costUsd !== undefined && p.costUsd > 0));
    const shares = Object.values(s.costShareByPhase ?? {});
    assert.equal(shares.length, 2);
    assert.ok(Math.abs(shares.reduce((a, b) => a + b, 0) - 1) < 1e-6);

    // Every agent carries cost.
    assert.ok(s.perAgent && s.perAgent.length === 3);
    assert.ok(s.perAgent.every((a) => a.costUsd !== undefined && a.costUsd > 0));
    const node = nodes.find((n) => n.kind === "agent" && n.name === "scout:a")!;
    assert.ok(node.usage?.costUsd !== undefined && node.usage.costUsd > 0);

    // The child session written to the index carries an estimated cost, so
    // `coding.sh tree` rolls it up under the host session too.
    const child = [...index.sessions.values()].find((x) => x.parent?.sessionId === SID && x.parent?.subagentId === "s0")!;
    assert.ok(child, "child session in index");
    assert.ok(child.stats.usage?.costUsd !== undefined && child.stats.usage.costUsd > 0);
    assert.ok(child.stats.usage.estimatedCostUsd !== undefined && child.stats.usage.estimatedCostUsd > 0);
  });

  it("leaves cost unset when no prices are passed (a reported cost would win)", async () => {
    const store = new WorkflowStore(join(root, "unpriced"));
    const r = await importClaudeWorkflows({ root: projects, store, concurrencyCap: 4 });
    assert.equal(r.imported.length, 1);
    const { run } = (await store.getRun(RUN))!;
    assert.equal(run.stats.costUsd, undefined);
    assert.equal(run.stats.costShareByPhase, undefined);
    assert.ok((run.stats.perAgent ?? []).every((a) => a.costUsd === undefined));
  });
});
