// Regressions from hands-on QA on real traces: Workflow-tool subagents, local
// slash commands, multi-agent Codex TTFT, clipped tool inputs, diffs on
// file.change, session ends on backfill, and `coding.sh run --agent claude-code`.
import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { buildSession } from "../../src/core/sessions.ts";
import type { SpoolLine } from "../../src/core/types.ts";
import { claudeCode } from "../../src/adapters/claude-code.ts";
import { convertRollout } from "../../src/adapters/codex.ts";
import { clipValue } from "../../src/adapters/_shared/normalize.ts";
import { fileChangesOf } from "../../src/adapters/_shared/tools.ts";
import { assertWellFormed, collect, testCtx, tmpEnv, writeFile, type TmpEnv } from "./_helpers.ts";

const SID = "aaaaaaaa-1111-4222-8333-444444444444";
const T0 = Date.parse("2026-11-01T10:00:00.000Z");
const iso = (dt: number) => new Date(T0 + dt).toISOString();
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const base = { sessionId: SID, cwd: "/work/demo", version: "2.1.300" };
const user = (uuid: string, dt: number, content: unknown, extra: Record<string, unknown> = {}) => ({ ...base, type: "user", uuid, timestamp: iso(dt), message: { role: "user", content }, ...extra });
const asst = (uuid: string, dt: number, id: string, content: unknown[]) => ({ ...base, type: "assistant", uuid, timestamp: iso(dt), message: { id, role: "assistant", model: "claude-opus-4-5", content, usage: { input_tokens: 10, output_tokens: 5 } } });

let env: TmpEnv;
beforeEach(() => {
  env = tmpEnv();
  process.env.CLAUDE_CONFIG_DIR = join(env.root, "claude");
});
afterEach(() => env.restore());
const project = () => join(env.root, "claude", "projects", "-work-demo");

describe("claude-code backfill: Workflow-tool subagents", () => {
  it("ingests <sid>/subagents/workflows/<wf>/agent-*.jsonl as child sessions linked to the Workflow call", async () => {
    const wfDir = join(project(), SID, "subagents", "workflows", "wf_abc-123");
    writeFile(
      join(project(), `${SID}.jsonl`),
      jsonl([
        user("u1", 0, "run the workflow", { promptId: "p1" }),
        asst("a1", 1000, "msg_1", [{ type: "tool_use", id: "toolu_wf", name: "Workflow", input: { scriptPath: "/w/x.js" } }]),
        user("u2", 1500, [{ type: "tool_result", tool_use_id: "toolu_wf", content: `Workflow launched in background. Task ID: t1\nTranscript dir: ${wfDir}\nScript file: /w/x.js` }]),
        asst("a2", 9000, "msg_2", [{ type: "text", text: "done" }]),
      ]),
    );
    writeFile(join(wfDir, "journal.jsonl"), jsonl([{ type: "launched" }, { type: "started", key: "k", agentId: "afb1", label: "qa:install-1", phase: "QA" }, { type: "result", key: "k", agentId: "afb1", result: { ok: true } }]));
    writeFile(join(wfDir, "agent-afb1.meta.json"), JSON.stringify({ agentType: "workflow-subagent", description: "qa:install-1", workflowPhase: "QA" }));
    writeFile(
      join(wfDir, "agent-afb1.jsonl"),
      jsonl([
        { ...user("s1", 2000, "do QA"), isSidechain: true, agentId: "afb1" },
        { ...asst("s2", 3000, "msg_s1", [{ type: "text", text: "QA passed" }]), isSidechain: true, agentId: "afb1" },
      ]),
    );
    // A second agent of the run, still working: no result in the journal, fresh entries.
    writeFile(join(wfDir, "agent-afb2.meta.json"), JSON.stringify({ agentType: "workflow-subagent", description: "qa:viewer-1", workflowPhase: "QA" }));
    writeFile(join(wfDir, "agent-afb2.jsonl"), jsonl([{ ...user("r1", 0, "do more QA"), timestamp: new Date().toISOString(), isSidechain: true, agentId: "afb2" }]));
    const { ctx } = testCtx();
    const events = await collect(claudeCode.backfill!(ctx));
    assertWellFormed(events);
    assert.ok(events.some((e) => e.kind === "subagent.start" && e.payload.subagentId === "afb2"));
    assert.ok(!events.some((e) => (e.kind === "subagent.end" && e.payload.subagentId === "afb2") || (e.kind === "session.end" && e.sessionId === `${SID}:sub:afb2`)), "a running agent has not ended");
    assert.ok(events.some((e) => e.kind === "subagent.end" && e.payload.subagentId === "afb1"), "the journal's result ends afb1");
    const child = `${SID}:sub:afb1`;
    assert.ok(events.some((e) => e.sessionId === child && e.kind === "assistant.message"), "workflow agent transcript ingested");
    const start = events.find((e) => e.kind === "subagent.start" && e.payload.subagentId === "afb1")!;
    assert.equal(start.sessionId, SID);
    assert.deepEqual([start.payload.type, start.payload.description, start.payload.phase, start.payload.workflowId, start.payload.toolUseId], ["workflow-subagent", "qa:install-1", "QA", "wf_abc-123", "toolu_wf"]);
    assert.equal(start.parentId, ctx.id("claude-code", SID, "tool.start", "toolu_wf"), "linked to the parent's Workflow tool call");
    const childStart = events.find((e) => e.sessionId === child && e.kind === "session.start")!;
    assert.equal(childStart.payload.parentSessionId, SID);
    assert.ok(!events.some((e) => e.sessionId === "journal"), "journal.jsonl is not a session");
    assert.deepEqual([...new Set(events.map((e) => e.sessionId))].sort(), [SID, child, `${SID}:sub:afb2`].sort());
  });
});

describe("claude-code backfill: local slash commands and task notifications", () => {
  it("are not prompts, titles or turns", async () => {
    writeFile(
      join(project(), `${SID}.jsonl`),
      jsonl([
        user("c1", 0, "<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>opus</command-args>"),
        user("c2", 10, "<local-command-stdout>Set model to opus</local-command-stdout>"),
        user("u1", 1000, "does this work?", { promptId: "p1" }),
        asst("a1", 2000, "msg_1", [{ type: "text", text: "yes" }]),
        { ...base, type: "system", subtype: "turn_duration", uuid: "td1", timestamp: iso(2100), durationMs: 1100 },
        user("c3", 3000, "<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>"),
        user("n1", 4000, "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background build finished</summary>\n</task-notification>"),
        asst("a2", 5000, "msg_2", [{ type: "text", text: "the build finished" }]),
        user("c4", 6000, "<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>src/</command-args>"),
        user("m1", 6001, "Review the code in src/ ...", { isMeta: true }),
        asst("a3", 7000, "msg_3", [{ type: "text", text: "looks fine" }]),
      ]),
    );
    const events = await collect(claudeCode.backfill!(testCtx().ctx));
    assertWellFormed(events);
    const prompts = events.filter((e) => e.kind === "user.message").map((e) => e.payload.text);
    assert.deepEqual(prompts, ["does this work?", "/review src/"], "only real prompts and prompt commands");
    assert.ok(!prompts.some((p) => String(p).includes("<")), "no raw command XML in prompts");
    const notes = events.filter((e) => e.kind === "notification").map((e) => [e.payload.kind, e.payload.command ?? e.payload.status]);
    assert.deepEqual(notes, [["command", "/model"], ["command-output", undefined], ["command", "/clear"], ["task-notification", "completed"]]);
    const session = buildSession(events);
    assert.equal(session.title, "does this work?");
    assert.equal(session.stats.turns, 3, "prompt, task notification reply, /review — not /model or /clear");
    assert.ok(events.filter((e) => e.kind === "turn.end").every((e) => e.turnId), "no empty turn for local commands");
  });
});

describe("claude-code backfill: session ends", () => {
  it("a finished (idle) transcript gets endedAt at its last entry; children end with their subagent.end", async () => {
    writeFile(join(project(), `${SID}.jsonl`), jsonl([user("u1", 0, "hi", { promptId: "p1" }), asst("a1", 4000, "msg_1", [{ type: "text", text: "hello" }])]));
    writeFile(join(project(), SID, "subagents", "agent-x1.jsonl"), jsonl([{ ...user("s1", 1000, "sub task"), isSidechain: true }, { ...asst("s2", 2500, "msg_s", [{ type: "text", text: "ok" }]), isSidechain: true }]));
    const events = await collect(claudeCode.backfill!(testCtx().ctx));
    const of = (sessionId: string) => events.filter((e) => e.sessionId === sessionId);
    assert.equal(buildSession(of(SID)).endedAt, T0 + 4000);
    assert.equal(buildSession(of(`${SID}:sub:x1`)).endedAt, T0 + 2500);
  });

  it("a transcript still being written gets no end", async () => {
    const now = new Date().toISOString();
    writeFile(join(project(), `${SID}.jsonl`), jsonl([{ ...user("u1", 0, "hi", { promptId: "p1" }), timestamp: now }]));
    const events = await collect(claudeCode.backfill!(testCtx().ctx));
    assert.ok(!events.some((e) => e.kind === "session.end"));
  });
});

describe("codex rollout: multi-agent TTFT", () => {
  it("a message from a subagent is input to the root thread, not its first output", async () => {
    const rid = "01a1a555-b594-7121-9ed2-cd46a64fd276";
    const file = join(env.root, `rollout-2026-11-04T00-00-00-${rid}.jsonl`);
    const rec = (dt: number, type: string, payload: Record<string, unknown>) => ({ timestamp: iso(dt), type, payload });
    writeFile(
      file,
      jsonl([
        rec(0, "session_meta", { id: rid, cwd: "/w", cli_version: "0.166.0" }),
        rec(1, "turn_context", { turn_id: "t1", model: "gpt-5.5" }),
        rec(2, "event_msg", { type: "task_started", turn_id: "t1" }),
        rec(100, "token_usage_record", { turn_id: "t1", response_id: "r0", usage: { input_tokens: 10, output_tokens: 2 } }),
        rec(20_000, "response_item", { type: "agent_message", author: "/root/scope", recipient: "/root", content: [{ type: "input_text", text: "FINAL_ANSWER ..." }] }),
        rec(39_000, "response_item", { type: "reasoning", summary: [] }),
        rec(43_000, "token_usage_record", { turn_id: "t1", response_id: "r1", usage: { input_tokens: 100, output_tokens: 20 } }),
        rec(43_100, "response_item", { type: "agent_message", author: "/root", recipient: "/root/scope", content: [{ type: "input_text", text: "next" }] }),
        rec(44_000, "token_usage_record", { turn_id: "t1", response_id: "r2", usage: { input_tokens: 100, output_tokens: 20 } }),
      ]),
    );
    const events = await convertRollout(testCtx().ctx, file, { mode: "full" });
    const call = events.find((e) => e.kind === "llm.call" && e.payload.responseId === "r1")!;
    assert.equal(call.ts, T0 + 20_000, "the inbound message starts the call");
    assert.equal(call.payload.ttftMs, 19_000, "first real output is the reasoning, 19 s later");
    const out = events.find((e) => e.kind === "llm.call" && e.payload.responseId === "r2")!;
    assert.equal(out.payload.ttftMs, 100, "an agent_message this thread sends is output");
  });
});

describe("codex rollout: compaction", () => {
  it("one compaction is one context.compact, though the rollout writes a compacted item and a context_compacted event", async () => {
    const rid = "01a1a555-b594-7121-9ed2-cd46a64fd277";
    const file = join(env.root, `rollout-2026-11-04T00-00-00-${rid}.jsonl`);
    const rec = (dt: number, type: string, payload: Record<string, unknown>) => ({ timestamp: iso(dt), type, payload });
    writeFile(
      file,
      jsonl([
        rec(0, "session_meta", { id: rid, cwd: "/w", cli_version: "0.166.0" }),
        rec(1, "turn_context", { turn_id: "t1", model: "gpt-5.5" }),
        rec(2, "event_msg", { type: "task_started", turn_id: "t1" }),
        rec(10_000, "compacted", { message: "", window_number: 2, window_id: "w2" }),
        rec(10_001, "event_msg", { type: "context_compacted" }),
        rec(10_002, "event_msg", { type: "warning", message: "long conversation" }),
        rec(12_000, "response_item", { type: "reasoning", summary: [] }),
        rec(30_000, "event_msg", { type: "context_compacted" }),
      ]),
    );
    const events = await convertRollout(testCtx().ctx, file, { mode: "full" });
    assert.deepEqual(events.filter((e) => e.kind === "context.compact").map((e) => e.ts - T0), [10_000, 30_000]);
  });
});

describe("clipped tool inputs keep their shape", () => {
  it("long string fields are cut, the object stays an object, the full JSON goes to a blob", async () => {
    const { ctx, blobs } = testCtx();
    const input = { description: "Analyze realm.computer design", subagent_type: "general-purpose", prompt: "x".repeat(10_000) };
    const c = await clipValue(ctx, input, 1536);
    assert.equal(typeof c.value, "object");
    const v = c.value as Record<string, string>;
    assert.equal(v.description, input.description);
    assert.equal(v.subagent_type, input.subagent_type);
    assert.ok(v.prompt!.endsWith("…") && v.prompt!.length < 1536);
    assert.ok(Buffer.byteLength(JSON.stringify(v)) <= 1536);
    assert.equal(c.truncated, true);
    assert.deepEqual(JSON.parse(blobs.get(c.blob!)!), input);
    const bash = await clipValue(ctx, { command: `P=/private/tmp/x; ${"echo hi; ".repeat(500)}` }, 1536);
    assert.ok(String((bash.value as Record<string, string>).command).startsWith("P=/private/tmp/x;"));
    const many = { findings: Array.from({ length: 60 }, (_, i) => ({ module: "cli", file: `src/f${i}.ts`, severity: "P1", summary: "s".repeat(200) })) };
    const m = await clipValue(ctx, many, 1536);
    const mv = m.value as { findings: unknown[] };
    assert.ok(Array.isArray(mv.findings) && Buffer.byteLength(JSON.stringify(mv)) <= 1536, "array tails dropped, shape kept");
    assert.match(String(mv.findings.at(-1)), /^…\d+ more$/);
  });
});

describe("file.change carries a unified diff", () => {
  it("from Claude structuredPatch, Edit strings, MultiEdit and apply_patch", () => {
    const sp = [{ oldStart: 10, oldLines: 2, newStart: 10, newLines: 2, lines: [" keep", "-old", "+new"] }];
    assert.equal(fileChangesOf("Edit", { file_path: "/w/a.ts", old_string: "old", new_string: "new" }, { structuredPatch: sp }, "/w")[0]!.diff, "--- a/a.ts\n+++ b/a.ts\n@@ -10,2 +10,2 @@\n keep\n-old\n+new\n");
    assert.equal(fileChangesOf("Edit", { file_path: "/w/a.ts", old_string: "a\nb\nc", new_string: "a\nB\nc" }, undefined, "/w")[0]!.diff, "--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n");
    const multi = fileChangesOf("MultiEdit", { file_path: "/w/a.ts", edits: [{ old_string: "x", new_string: "y" }, { old_string: "p", new_string: "q" }] }, undefined, "/w")[0]!;
    assert.equal(multi.diff, "--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-x\n+y\n@@ -1,1 +1,1 @@\n-p\n+q\n");
    const patch = "*** Begin Patch\n*** Update File: src/m.ts\n@@\n-  return a - b;\n+  return a + b;\n*** Add File: n.txt\n+hi\n*** End Patch\n";
    const changes = fileChangesOf("apply_patch", { input: patch });
    assert.equal(changes[0]!.diff, "--- a/src/m.ts\n+++ b/src/m.ts\n@@\n-  return a - b;\n+  return a + b;\n");
    assert.equal(changes[1]!.diff, "--- /dev/null\n+++ b/n.txt\n+hi\n");
  });

  it("backfilled Edit/Write steps get payload.diff; long diffs are cut inline and kept whole in a blob", async () => {
    const big = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    writeFile(
      join(project(), `${SID}.jsonl`),
      jsonl([
        user("u1", 0, "edit", { promptId: "p1" }),
        asst("a1", 100, "msg_1", [{ type: "tool_use", id: "toolu_e", name: "Edit", input: { file_path: "/work/demo/todo.md", old_string: "- [ ] a", new_string: "- [x] a" } }]),
        user("u2", 200, [{ type: "tool_result", tool_use_id: "toolu_e", content: "updated" }], { toolUseResult: { filePath: "/work/demo/todo.md", structuredPatch: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ["-- [ ] a", "+- [x] a"] }] } }),
        asst("a2", 300, "msg_2", [{ type: "tool_use", id: "toolu_w", name: "Write", input: { file_path: "/work/demo/big.txt", content: big } }]),
        user("u3", 400, [{ type: "tool_result", tool_use_id: "toolu_w", content: "created" }], { toolUseResult: { type: "create", filePath: "/work/demo/big.txt" } }),
      ]),
    );
    const { ctx, blobs } = testCtx();
    const events = await collect(claudeCode.backfill!(ctx));
    assertWellFormed(events);
    const changes = events.filter((e) => e.kind === "file.change");
    const edit = changes.find((e) => e.payload.path === "todo.md")!;
    assert.equal(edit.payload.diff, "--- a/todo.md\n+++ b/todo.md\n@@ -3,1 +3,1 @@\n-- [ ] a\n+- [x] a\n");
    const write = changes.find((e) => e.payload.path === "big.txt")!;
    assert.equal(write.payload.diffTruncated, true);
    assert.ok(String(write.payload.diff).endsWith("\n") && String(write.payload.diff).startsWith("--- /dev/null\n+++ b/big.txt\n@@ -0,0 +1,400 @@\n+line 0\n"));
    const full = blobs.get(write.blobs!.at(-1)!)!;
    assert.ok(full.endsWith("+line 399\n"));
  });
});

describe("claude-code normalize: `coding.sh run --agent claude-code` wrapper lines", () => {
  it("become the wrapper session under the printed id, with its repo state, files and end", async () => {
    const W = "407e46dc-661f-49af-973d-163162a99935";
    const repo = { root: "/work/demo", head: "0123456789abcdef0123456789abcdef01234567", snapshot: "1111111111111111111111111111111111111111" };
    const line = (event: string, ts: number, raw: Record<string, unknown>): SpoolLine => ({ v: 0, agent: "claude-code", event, ts, pid: 23203, cwd: "/work/demo", raw: { sessionId: W, ...raw } });
    const { ctx } = testCtx();
    const events = [];
    for (const l of [
      line("session.start", T0, { cmd: "./fakeclaude.sh", args: [], cwd: "/work/demo", repo }),
      line("file.change", T0 + 2000, { path: "sum.js", op: "modify", additions: 1, deletions: 1 }),
      line("session.end", T0 + 3000, { exitCode: 0, durationMs: 3000, repo: { ...repo, snapshot: "2222222222222222222222222222222222222222" } }),
    ]) events.push(...(await claudeCode.normalize(l, ctx)));
    assertWellFormed(events);
    assert.ok(events.every((e) => e.sessionId === W && e.agent === "claude-code"), "no ppid-<n> session");
    assert.deepEqual(events.map((e) => e.kind), ["session.start", "file.change", "session.end"]);
    const s = buildSession(events);
    assert.equal(s.endedAt, T0 + 3000);
    assert.equal(s.repo?.snapshot, repo.snapshot);
    assert.equal(s.stats.filesChanged, 1);
  });
});
