// Workflow import stores agent transcripts in the index and blob store, so it
// must redact them first, like spool ingest and backfill ("redact before
// writing"). A secret in an agent's prompt, reply and a large tool output (big
// enough to go to a blob) must not reach either store.
//
// The fixture is synthetic (paths /work/demo, a fake token), never read from a
// real ~/.claude.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { defaultConfig } from "../../src/core/config.ts";
import { profileCache } from "../../src/core/ingest.ts";
import { importClaudeWorkflows } from "../../src/workflows/import.ts";
import { WorkflowStore } from "../../src/workflows/store.ts";
import { MemBlobs, MemIndex } from "../otel/_memstore.ts";

const T0 = Date.UTC(2026, 10, 8, 9, 0, 0);
const SID = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const RUN = "wf_redact01";
const TOKEN = "ghp_" + "0123456789abcdefghijABCDEFGHIJ012345";
const iso = (ms: number) => new Date(ms).toISOString();

function writeRun(projects: string): void {
  const sessionDir = join(projects, "-work-demo", SID);
  const runDir = join(sessionDir, "subagents", "workflows", RUN);
  mkdirSync(runDir, { recursive: true });
  const base = { sessionId: SID, cwd: "/work/demo", version: "2.1.319", gitBranch: "main", userType: "external", entrypoint: "cli", isSidechain: true, agentId: "a0" };
  const big = `config dump\nGITHUB_TOKEN=${TOKEN}\n` + "x".repeat(8000);
  const lines = [
    { ...base, type: "user", uuid: "u0", parentUuid: null, timestamp: iso(T0), message: { role: "user", content: `Use token ${TOKEN} to clone` } },
    { ...base, type: "assistant", uuid: "a0", parentUuid: "u0", timestamp: iso(T0 + 1000), message: { id: "msg_a0", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "t0", name: "Bash", input: { command: `echo ${TOKEN}` } }], stop_reason: "tool_use", usage: { input_tokens: 5, output_tokens: 20 } } },
    { ...base, type: "user", uuid: "u1", parentUuid: "a0", timestamp: iso(T0 + 2000), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t0", content: big }] } },
    { ...base, type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: iso(T0 + 3000), message: { id: "msg_a1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: `Cloned with ${TOKEN}` }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 20 } } },
  ];
  writeFileSync(join(runDir, "agent-a0.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const journal = [{ type: "launched", runId: RUN }, { type: "started", key: "v2:a0", agentId: "a0", label: "clone", phase: "Work" }, { type: "result", key: "v2:a0", agentId: "a0", result: { ok: true }, toolsUsed: [] }];
  writeFileSync(join(runDir, "journal.jsonl"), journal.map((j) => JSON.stringify(j)).join("\n") + "\n");
}

let root = "";
before(() => {
  root = mkdtempSync(join(tmpdir(), "csh-wf-redact-"));
  writeRun(join(root, "projects"));
});
after(() => rmSync(root, { recursive: true, force: true }));

describe("importClaudeWorkflows redaction", () => {
  it("redacts agent events and blobs with the capture profile before storing them", async () => {
    const env = { HOME: join(root, "home"), CODING_SH_HOME: join(root, "csh") };
    const profile = profileCache(defaultConfig(env), env, () => {})(undefined);
    const index = new MemIndex();
    const blobs = new MemBlobs();
    const r = await importClaudeWorkflows({ root: join(root, "projects"), store: new WorkflowStore(join(root, "store")), index, blobs, profile, concurrencyCap: 2 });
    assert.equal(r.imported.length, 1);

    const stored = JSON.stringify([...index.events.values()].map((x) => x.event)) + JSON.stringify([...index.sessions.values()]);
    assert.ok(index.events.size > 0, "agent events reach the index");
    assert.ok(!stored.includes(TOKEN), "no raw token in indexed events or sessions");
    assert.match(stored, /\[redacted:github-token\]/);

    assert.ok(blobs.data.size > 0, "the large tool output went to a blob");
    const dec = new TextDecoder();
    for (const bytes of blobs.data.values()) assert.ok(!dec.decode(bytes).includes(TOKEN), "no raw token in a blob");

    // Redaction keeps cost estimation: the profile also prices the calls.
    const child = [...index.sessions.values()].find((s) => s.parent?.sessionId === SID);
    assert.ok(child?.stats.usage?.costUsd !== undefined && child.stats.usage.costUsd > 0);
  });
});
