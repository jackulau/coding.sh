// Workflow import stores agent transcripts in the index and blob store, so it
// must redact them first, like spool ingest and backfill ("redact before
// writing"). A secret in an agent's prompt, reply and a large tool output (big
// enough to go to a blob), or in the run's script, must not reach either store.
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
import { replayWorkflow } from "../../src/workflows/replay.ts";
import { WorkflowStore } from "../../src/workflows/store.ts";
import type { WorkflowDriver } from "../../src/workflows/types.ts";
import { MemBlobs, MemIndex } from "../otel/_memstore.ts";

const T0 = Date.UTC(2026, 10, 8, 9, 0, 0);
const SID = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const RUN = "wf_redact01";
const TOKEN = ["ghp_", "0123456789abcdefghijABCDEFGHIJ012345"].join("");
const iso = (ms: number) => new Date(ms).toISOString();
// The run's script, which names the token too.
const SCRIPT = `export const meta = { name: "clone" };\nphase("Work");\nconst r = await agent({ label: "clone", prompt: "Use token ${TOKEN} to clone" });\n`;

function writeRun(projects: string): void {
  const sessionDir = join(projects, "-work-demo", SID);
  const runDir = join(sessionDir, "subagents", "workflows", RUN);
  mkdirSync(runDir, { recursive: true });
  // The copy of the script Claude Code keeps in the session dir.
  mkdirSync(join(sessionDir, "workflows", "scripts"), { recursive: true });
  writeFileSync(join(sessionDir, "workflows", "scripts", `clone-${RUN}.js`), SCRIPT);
  const base = { sessionId: SID, cwd: "/work/demo", version: "2.1.319", gitBranch: "main", userType: "external", entrypoint: "cli", isSidechain: true, agentId: "a0" };
  const big = `config dump\nGITHUB_TOKEN=${TOKEN}\n` + "x".repeat(8000);
  const lines = [
    { ...base, type: "user", uuid: "u0", parentUuid: null, timestamp: iso(T0), message: { role: "user", content: `Use token ${TOKEN} to clone` } },
    { ...base, type: "assistant", uuid: "a0", parentUuid: "u0", timestamp: iso(T0 + 1000), message: { id: "msg_a0", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "t0", name: "Bash", input: { command: `echo ${TOKEN}` } }], stop_reason: "tool_use", usage: { input_tokens: 5, output_tokens: 20 } } },
    { ...base, type: "user", uuid: "u1", parentUuid: "a0", timestamp: iso(T0 + 2000), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t0", content: big }] } },
    { ...base, type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: iso(T0 + 3000), message: { id: "msg_a1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: `Cloned with ${TOKEN}` }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 20 } } },
  ];
  writeFileSync(join(runDir, "agent-a0.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const journal = [{ type: "launched", runId: RUN }, { type: "started", key: "v2:a0", agentId: "a0", label: "clone", phase: "Work" }, { type: "result", key: "v2:a0", agentId: "a0", result: { ok: true, note: `cloned with ${TOKEN}` }, toolsUsed: [] }];
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

    // The agent's return value, stored for `workflows score`, takes the same rules.
    const store = new WorkflowStore(join(root, "store"));
    const node = (await store.getRun(RUN))?.nodes.find((n) => n.output);
    assert.ok(node?.output, "the agent's return value is stored");
    assert.deepEqual(await store.getValue(node.output), { ok: true, note: "cloned with [redacted:github-token]" });
    for await (const ref of store.blobs.list()) assert.ok(!(await store.blobs.getText(ref))?.includes(TOKEN), "no raw token in a workflow blob");
    // So does the run's script, kept for `workflows replay`.
    const script = (await store.getRun(RUN))?.run.script;
    assert.ok(script, "the run's script is stored");
    assert.equal(await store.getText(script), SCRIPT.split(TOKEN).join("[redacted:github-token]"));

    // Redaction keeps cost estimation: the profile also prices the calls.
    const child = [...index.sessions.values()].find((s) => s.parent?.sessionId === SID);
    assert.ok(child?.stats.usage?.costUsd !== undefined && child.stats.usage.costUsd > 0);
  });

  it("keeps no agent return values and no script in metadata mode: an imported run is passive capture, like a session", async () => {
    const env = { HOME: join(root, "home"), CODING_SH_HOME: join(root, "csh-meta") };
    const config = defaultConfig(env);
    const profile = profileCache({ ...config, capture: { ...config.capture, mode: "metadata" } }, env, () => {})(undefined);
    const store = new WorkflowStore(join(root, "store-meta"));
    const r = await importClaudeWorkflows({ root: join(root, "projects"), store, index: new MemIndex(), blobs: new MemBlobs(), profile, concurrencyCap: 2 });
    assert.equal(r.imported.length, 1);
    const got = await store.getRun(RUN);
    assert.ok(got && got.nodes.length > 0);
    assert.deepEqual(got.nodes.filter((n) => n.output).map((n) => n.id), []);
    assert.equal(got.run.output, undefined);
    assert.equal(got.run.script, undefined);
  });

  it("predicts replay cache hits from the redacted script as if it were the script on disk", async () => {
    const env = { HOME: join(root, "home"), CODING_SH_HOME: join(root, "csh-replay") };
    const profile = profileCache(defaultConfig(env), env, () => {})(undefined);
    const store = new WorkflowStore(join(root, "store-replay"));
    await importClaudeWorkflows({ root: join(root, "projects"), store, index: new MemIndex(), blobs: new MemBlobs(), profile, concurrencyCap: 2 });
    const base = (await store.getRun(RUN))!;
    const baseScript = (await store.getText(base.run.script!))!;
    const driver: WorkflowDriver = {
      id: "none",
      run: async () => {
        throw new Error("a dry run starts no run");
      },
    };
    const replay = (editedScript: string) => replayWorkflow({ base, baseScript, script: "/work/demo/clone.js", editedScript, redactor: profile.redactor, driver, store, dryRun: true });
    const same = (await replay(SCRIPT)).prediction;
    assert.equal(same.total, 1);
    assert.equal(same.hits, 1, same.reason);
    const edited = (await replay(SCRIPT.split("to clone").join("to fetch"))).prediction;
    assert.equal(edited.hits, 0, edited.reason);
  });
});
