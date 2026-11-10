// Claude Code copies subagent transcripts into other session dirs: a session
// that resumes another session's workflow run (Workflow resumeFromRunId) gets a
// byte copy of the run dir, a fork can symlink run dirs, and a fork copies
// subagents/agent-*.jsonl. The copies keep the writer's sessionId on every
// entry. Backfill stores each subagent once, under the session that wrote it,
// so its calls and cost are not counted again. Synthetic transcripts only.
import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { claudeCode, subagentOwner } from "../../src/adapters/claude-code.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { assertWellFormed, collect, testCtx, tmpEnv, writeFile, type TmpEnv } from "./_helpers.ts";

const A = "aaaaaaaa-0000-4000-8000-00000000000a"; // owner: launched the run
const B = "bbbbbbbb-0000-4000-8000-00000000000b"; // resumed A's run (resumeFromRunId): a byte copy of the run dir, plus its own agent
const C = "cccccccc-0000-4000-8000-00000000000c"; // a fork whose run dir is a symlink to A's
const WF = "wf_t0000001-abc";
const T0 = Date.parse("2026-11-01T10:00:00.000Z");
const iso = (dt: number) => new Date(T0 + dt).toISOString();
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const entry = (sid: string, extra: Record<string, unknown>) => ({ parentUuid: null, isSidechain: false, userType: "external", cwd: "/work/demo", sessionId: sid, version: "2.1.300", ...extra });
const user = (sid: string, uuid: string, dt: number, content: unknown, extra: Record<string, unknown> = {}) => entry(sid, { type: "user", uuid, timestamp: iso(dt), message: { role: "user", content }, ...extra });
const asst = (sid: string, uuid: string, dt: number, id: string, content: unknown[], extra: Record<string, unknown> = {}) =>
  entry(sid, { type: "assistant", uuid, timestamp: iso(dt), message: { id, role: "assistant", model: "claude-opus-4-5", content, usage: { input_tokens: 100, output_tokens: 20 } }, ...extra });

let env: TmpEnv;
beforeEach(() => {
  env = tmpEnv();
  process.env.CLAUDE_CONFIG_DIR = join(env.root, "claude");
});
afterEach(() => env.restore());
const project = () => join(env.root, "claude", "projects", "-work-demo");
const runDir = (sid: string) => join(project(), sid, "subagents", "workflows", WF);

/** A main transcript whose Workflow call's result names `<sid>`'s copy of the run dir. */
function mainWithWorkflow(sid: string, dt: number, input: Record<string, unknown>): void {
  writeFile(
    join(project(), `${sid}.jsonl`),
    jsonl([
      user(sid, `${sid}-u1`, dt, "run the workflow", { promptId: `${sid}-p1` }),
      asst(sid, `${sid}-a1`, dt + 1000, `msg_${sid.slice(0, 4)}_1`, [{ type: "tool_use", id: `toolu_wf_${sid.slice(0, 4)}`, name: "Workflow", input }]),
      user(sid, `${sid}-u2`, dt + 1500, [{ type: "tool_result", tool_use_id: `toolu_wf_${sid.slice(0, 4)}`, content: `Workflow launched in background. Task ID: t1\nTranscript dir: ${runDir(sid)}\nScript file: /work/demo/wf.js` }]),
      asst(sid, `${sid}-a2`, dt + 90_000, `msg_${sid.slice(0, 4)}_2`, [{ type: "text", text: "done" }]),
    ]),
  );
}

/** A workflow agent's transcript: `calls` model responses, every entry tagged with the writer's session id. */
function agentLines(writer: string, agentId: string, dt: number, calls: number): unknown[] {
  const rows: unknown[] = [user(writer, `${agentId}-u0`, dt, `task for ${agentId}`, { isSidechain: true, agentId })];
  for (let i = 1; i <= calls; i++) {
    rows.push(asst(writer, `${agentId}-a${i}`, dt + i * 1000, `msg_${agentId}_${i}`, [{ type: "text", text: `step ${i}` }], { isSidechain: true, agentId }));
  }
  return rows;
}

/** A launches run WF with agent a1; B resumes it (a byte copy of A's run dir) and adds b1; C's run dir is a symlink to A's. */
function buildTree(): { linked: boolean } {
  mainWithWorkflow(A, 0, { scriptPath: "/work/demo/wf.js" });
  writeFile(join(runDir(A), "journal.jsonl"), jsonl([{ type: "launched" }, { type: "started", key: "k1", agentId: "a1", label: "build:1", phase: "Build" }, { type: "result", key: "k1", agentId: "a1", result: { ok: true } }]));
  writeFile(join(runDir(A), "agent-a1.meta.json"), JSON.stringify({ agentType: "workflow-subagent", description: "build:1", workflowPhase: "Build" }));
  writeFile(join(runDir(A), "agent-a1.jsonl"), jsonl(agentLines(A, "a1", 2000, 3)));

  mainWithWorkflow(B, 200_000, { scriptPath: "/work/demo/wf.js", resumeFromRunId: WF });
  mkdirSync(runDir(B), { recursive: true });
  for (const name of readdirSync(runDir(A))) copyFileSync(join(runDir(A), name), join(runDir(B), name));
  appendFileSync(join(runDir(B), "journal.jsonl"), jsonl([{ type: "started", key: "k2", agentId: "b1", label: "check:1", phase: "Check" }, { type: "result", key: "k2", agentId: "b1", result: { ok: true } }]));
  writeFile(join(runDir(B), "agent-b1.meta.json"), JSON.stringify({ agentType: "workflow-subagent", description: "check:1", workflowPhase: "Check" }));
  writeFile(join(runDir(B), "agent-b1.jsonl"), jsonl(agentLines(B, "b1", 202_000, 2)));

  writeFile(join(project(), `${C}.jsonl`), jsonl([user(C, `${C}-u1`, 300_000, "carry on", { promptId: `${C}-p1` }), asst(C, `${C}-a1`, 301_000, "msg_cccc_1", [{ type: "text", text: "ok" }])]));
  mkdirSync(join(project(), C, "subagents", "workflows"), { recursive: true });
  try {
    symlinkSync(runDir(A), runDir(C), process.platform === "win32" ? "junction" : "dir");
    return { linked: true };
  } catch {
    return { linked: false }; // no symlink rights (some Windows setups): the C case is skipped
  }
}

const backfill = async () => {
  const { ctx } = testCtx();
  const events = await collect(claudeCode.backfill!(ctx));
  assertWellFormed(events);
  return { ctx, events };
};
const subSessions = (events: AgentEvent[]) => [...new Set(events.map((e) => e.sessionId).filter((s) => s.includes(":sub:")))].sort();
const messageIds = (events: AgentEvent[]) => events.filter((e) => e.kind === "llm.call").map((e) => e.payload.messageId as string);

describe("claude-code backfill: subagent transcripts copied into other sessions", () => {
  it("stores a resumed or symlinked workflow run's agents once, under the session that wrote them", async (t) => {
    const { linked } = buildTree();
    if (!linked) t.diagnostic("symlinks unavailable: the symlinked fork case is not exercised");
    const { ctx, events } = await backfill();
    assert.deepEqual(subSessions(events), [`${A}:sub:a1`, `${B}:sub:b1`]);
    const ids = messageIds(events);
    assert.equal(new Set(ids).size, ids.length, "each llm.call message id once");
    assert.equal(ids.filter((id) => id.startsWith("msg_a1_")).length, 3);

    // Workflow linking is unchanged: a1 hangs off A's Workflow call, b1 off B's.
    const start = (agentId: string) => events.find((e) => e.kind === "subagent.start" && e.payload.subagentId === agentId)!;
    assert.equal(events.filter((e) => e.kind === "subagent.start" && e.payload.subagentId === "a1").length, 1);
    assert.deepEqual([start("a1").sessionId, start("a1").payload.workflowId, start("a1").payload.toolUseId, start("a1").payload.phase], [A, WF, "toolu_wf_aaaa", "Build"]);
    assert.equal(start("a1").parentId, ctx.id("claude-code", A, "tool.start", "toolu_wf_aaaa"));
    assert.deepEqual([start("b1").sessionId, start("b1").payload.workflowId, start("b1").payload.toolUseId, start("b1").payload.phase], [B, WF, "toolu_wf_bbbb", "Check"]);
  });

  it("keeps a copy whose owner's run dir is gone", async () => {
    buildTree();
    rmSync(runDir(A), { recursive: true, force: true }); // C's symlink now dangles: nothing under C
    const { events } = await backfill();
    assert.deepEqual(subSessions(events), [`${B}:sub:a1`, `${B}:sub:b1`]);
    assert.equal(messageIds(events).filter((id) => id.startsWith("msg_a1_")).length, 3);
  });

  it("stores the owner's longer transcript whole when the agent was resumed in the owner after the copy", async () => {
    buildTree();
    appendFileSync(join(runDir(A), "agent-a1.jsonl"), jsonl(agentLines(A, "a1", 2000, 5).slice(4)));
    const { events } = await backfill();
    assert.deepEqual(subSessions(events), [`${A}:sub:a1`, `${B}:sub:b1`]);
    assert.deepEqual(messageIds(events).filter((id) => id.startsWith("msg_a1_")), ["msg_a1_1", "msg_a1_2", "msg_a1_3", "msg_a1_4", "msg_a1_5"]);
  });

  it("stores a plain subagent copied into a fork's dir under the session that wrote it", async () => {
    const F = "ffffffff-0000-4000-8000-00000000000f";
    writeFile(join(project(), `${A}.jsonl`), jsonl([user(A, "ua", 0, "hi", { promptId: "pa" }), asst(A, "aa", 1000, "msg_A_1", [{ type: "text", text: "hello" }])]));
    writeFile(join(project(), `${F}.jsonl`), jsonl([user(F, "uf", 100_000, "and then", { promptId: "pf" }), asst(F, "af", 101_000, "msg_F_1", [{ type: "text", text: "sure" }])]));
    const transcript = jsonl(agentLines(A, "x", 500, 2));
    writeFile(join(project(), A, "subagents", "agent-x.jsonl"), transcript);
    writeFile(join(project(), F, "subagents", "agent-x.jsonl"), transcript);
    writeFile(join(project(), F, "subagents", "agent-y.jsonl"), jsonl(agentLines(F, "y", 102_000, 1)));
    const { events } = await backfill();
    assert.deepEqual(subSessions(events), [`${A}:sub:x`, `${F}:sub:y`]);
    const ids = messageIds(events);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("reads the owner from the first entry, even when it is longer than the head read", async () => {
    const path = join(env.root, "agent-big.jsonl");
    writeFile(path, jsonl([user(A, "u0", 0, "x".repeat(100_000), { isSidechain: true })]));
    assert.equal(await subagentOwner(path), A);
    writeFile(path, jsonl([{ type: "summary", summary: "no session id" }, user(B, "u1", 0, "task")]));
    assert.equal(await subagentOwner(path), B);
  });
});
