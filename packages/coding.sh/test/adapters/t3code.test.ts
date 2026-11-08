// T3 Code adapter: a synthetic T3 store (real v2/v1 table shapes, made-up rows)
// built in a temp HOME next to Codex and Claude transcripts T3 "ran".
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { claudeCode } from "../../src/adapters/claude-code.ts";
import { codex } from "../../src/adapters/codex.ts";
import { ADAPTERS } from "../../src/adapters/index.ts";
import { backfillT3, t3code, turnUsage } from "../../src/adapters/t3code.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { backfill, ingest } from "../../src/core/ingest.ts";
import { buildSession } from "../../src/core/sessions.ts";
import type { Adapter } from "../../src/core/types.ts";
import { usage } from "../../src/mcp/data.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { hostOf } from "../../src/spool/host.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { FIXTURES, assertWellFormed, collect, testCtx, tmpEnv, type TmpEnv, writeFile } from "./_helpers.ts";

const CODEX_ID = "0193aaaa-1111-7222-8333-444455556666";
const CLAUDE_ID = "11111111-2222-4333-8444-555555555555";
const ROLLOUT = `sessions/2026/11/01/rollout-2026-11-01T10-00-00-${CODEX_ID}.jsonl`;

const V2_SCHEMA = `
CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace_root TEXT NOT NULL, scripts_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, default_model_selection_json TEXT);
CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, default_provider TEXT NOT NULL, runtime_mode TEXT NOT NULL, interaction_mode TEXT NOT NULL, active_provider_thread_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT, deleted_at TEXT, payload_json TEXT NOT NULL, provider_instance_id TEXT);
CREATE TABLE orchestration_v2_projection_runs (run_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, ordinal INTEGER NOT NULL, provider TEXT NOT NULL, provider_thread_id TEXT, status TEXT NOT NULL, requested_at TEXT NOT NULL, completed_at TEXT, payload_json TEXT NOT NULL, provider_instance_id TEXT);
CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT PRIMARY KEY, thread_id TEXT, owner_node_id TEXT, provider TEXT NOT NULL, provider_session_id TEXT, status TEXT NOT NULL, first_run_ordinal INTEGER, last_run_ordinal INTEGER, updated_at TEXT NOT NULL, payload_json TEXT NOT NULL, driver TEXT, provider_instance_id TEXT);
CREATE TABLE orchestration_v2_projection_provider_turns (provider_turn_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, provider_thread_id TEXT NOT NULL, node_id TEXT NOT NULL, run_attempt_id TEXT, ordinal INTEGER NOT NULL, status TEXT NOT NULL, started_at TEXT, completed_at TEXT, payload_json TEXT NOT NULL);
CREATE TABLE orchestration_v2_projection_messages (message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT, node_id TEXT, role TEXT NOT NULL, streaming INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload_json TEXT NOT NULL);
CREATE TABLE orchestration_v2_projection_turn_items (turn_item_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT, node_id TEXT, provider_thread_id TEXT, provider_turn_id TEXT, parent_item_id TEXT, ordinal INTEGER NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL, payload_json TEXT NOT NULL);
`;

const V1_SCHEMA = `
CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace_root TEXT NOT NULL, scripts_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, branch TEXT, worktree_path TEXT, latest_turn_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, model_selection_json TEXT, archived_at TEXT);
CREATE TABLE projection_thread_messages (message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, turn_id TEXT, role TEXT NOT NULL, text TEXT NOT NULL, is_streaming INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, attachments_json TEXT);
CREATE TABLE projection_thread_activities (activity_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, turn_id TEXT, tone TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, sequence INTEGER);
CREATE TABLE projection_thread_sessions (thread_id TEXT PRIMARY KEY, status TEXT NOT NULL, provider_name TEXT, provider_session_id TEXT, provider_thread_id TEXT, active_turn_id TEXT, last_error TEXT, updated_at TEXT NOT NULL);
CREATE TABLE provider_session_runtime (thread_id TEXT PRIMARY KEY, provider_name TEXT NOT NULL, adapter_key TEXT NOT NULL, runtime_mode TEXT NOT NULL DEFAULT 'full-access', status TEXT NOT NULL, last_seen_at TEXT NOT NULL, resume_cursor_json TEXT, runtime_payload_json TEXT);
CREATE TABLE projection_turns (row_id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, turn_id TEXT, pending_message_id TEXT, assistant_message_id TEXT, state TEXT NOT NULL, requested_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, checkpoint_files_json TEXT NOT NULL DEFAULT '[]');
`;

const T = (min: number, sec = 0) => `2026-11-01T10:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}.000Z`;
const J = (o: unknown) => JSON.stringify(o);

function thread(db: DatabaseSync, id: string, o: { provider: string; title: string; created: string; deleted?: string; payload?: Record<string, unknown> }) {
  db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?, 'proj-1', ?, ?, 'full-access', 'default', NULL, ?, ?, NULL, ?, ?, NULL)").run(
    id, o.title, o.provider, o.created, o.created, o.deleted ?? null,
    J({ id, projectId: "proj-1", title: o.title, modelSelection: { instanceId: o.provider, model: "gpt-5.5" }, lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id }, historyOrigin: "native", ...o.payload }),
  );
}

function providerThread(db: DatabaseSync, id: string, threadId: string, driver: string, nativeId: string, ordinal: number, extra: Record<string, unknown> = {}) {
  db.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, 'node-1', ?, NULL, 'idle', ?, ?, ?, ?, ?, NULL)").run(
    id, threadId, driver, ordinal, ordinal, T(30), J({ driver, appThreadId: threadId, nativeThreadRef: { driver, nativeId, strength: "strong" }, nativeMetadata: { modelSelection: { model: driver === "codex" ? "gpt-5.5" : `${driver}-model` } }, ...extra }), driver,
  );
}

/** A T3 store with Codex, Claude, Grok (+ a provider switch to Muse), a subagent thread and a deleted thread. */
function buildStore(home: string) {
  const dir = join(home, ".t3", "userdata");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "statev2.sqlite"));
  db.exec(V2_SCHEMA);
  db.prepare("INSERT INTO projection_projects VALUES ('proj-1', 'demo', '/work/demo', '[]', ?, ?, NULL, NULL)").run(T(0), T(0));
  thread(db, "thr-codex", { provider: "codex", title: "Fix the failing test", created: T(0) });
  providerThread(db, "pt-codex", "thr-codex", "codex", CODEX_ID, 1, { contextUsage: { usedTokens: 10, cost: { amount: 0.42, currency: "USD" } } });
  thread(db, "thr-claude", { provider: "claudeAgent", title: "Add sum", created: T(0) });
  providerThread(db, "pt-claude", "thr-claude", "claudeAgent", CLAUDE_ID, 1);
  thread(db, "thr-grok", { provider: "grok", title: "List files", created: T(1) });
  providerThread(db, "pt-grok", "thr-grok", "grok", "grok-session-1", 1);
  providerThread(db, "pt-muse", "thr-grok", "muse", "provider-instance:muse_main:muse-session-1", 2);
  db.prepare("INSERT INTO orchestration_v2_projection_runs VALUES ('run-g1', 'thr-grok', 1, 'grok', 'pt-grok', 'completed', ?, ?, '{}', NULL)").run(T(2), T(3));
  db.prepare("INSERT INTO orchestration_v2_projection_runs VALUES ('run-g2', 'thr-grok', 2, 'muse', 'pt-muse', 'completed', ?, ?, '{}', NULL)").run(T(5), T(6));
  const msg = db.prepare("INSERT INTO orchestration_v2_projection_messages VALUES (?, ?, ?, 'node-1', ?, ?, ?, ?, ?)");
  msg.run("m1", "thr-grok", "run-g1", "user", 0, T(2), T(2), J({ text: "List files and run the tests", createdBy: "user" }));
  msg.run("m2", "thr-grok", "run-g1", "assistant", 0, T(3), T(3), J({ text: "Tests pass." }));
  msg.run("m3", "thr-grok", "run-g1", "assistant", 1, T(3, 30), T(3, 30), J({ text: "still stream" }));
  msg.run("m4", "thr-grok", "run-g2", "user", 0, T(5), T(5), J({ text: "Now with Muse" }));
  msg.run("m5", "thr-sub", null, "user", 0, T(4), T(4), J({ text: "Sub task" }));
  const turn = db.prepare("INSERT INTO orchestration_v2_projection_provider_turns VALUES (?, ?, ?, 'node-1', NULL, ?, ?, ?, ?, ?)");
  turn.run("turn-g1", "thr-grok", "pt-grok", 1, "completed", T(2), T(3), J({ status: "completed", turnTokenUsage: { usageScope: "main_agent", usageStatus: "complete", inputTokens: 1000, cachedInputTokens: 600, cacheCreationTokens: 100, outputTokens: 50, hasSubagents: false } }));
  turn.run("turn-m1", "thr-grok", "pt-muse", 1, "completed", T(5), T(6), J({ status: "completed", turnTokenUsage: { usageScope: "main_agent", usageStatus: "unavailable", hasSubagents: false } }));
  const item = db.prepare("INSERT INTO orchestration_v2_projection_turn_items VALUES (?, 'thr-grok', 'run-g1', 'node-1', 'pt-grok', 'turn-g1', NULL, ?, ?, ?, ?, ?)");
  item.run("it-cmd", 1, "command_execution", "completed", T(2, 30), J({ id: "it-cmd", status: "completed", title: "npm test", input: "npm test", output: "2 passing", exitCode: 0, startedAt: T(2, 10), completedAt: T(2, 30) }));
  item.run("it-edit", 2, "file_change", "completed", T(2, 40), J({ id: "it-edit", status: "completed", fileName: "src/a.ts", additions: 3, deletions: 1, diffStr: "@@\n-a\n+b", startedAt: T(2, 35), completedAt: T(2, 40) }));
  item.run("it-run", 3, "dynamic_tool", "running", T(2, 50), J({ id: "it-run", status: "running", toolName: "browser", input: { url: "http://localhost" }, startedAt: T(2, 50) }));
  item.run("it-sub", 4, "subagent", "completed", T(4, 30), J({ id: "it-sub", status: "completed", prompt: "Sub task", childThreadId: "thr-sub", startedAt: T(4), completedAt: T(4, 30) }));
  thread(db, "thr-sub", { provider: "grok", title: "Sub task", created: T(4), payload: { lineage: { parentThreadId: "thr-grok", relationshipToParent: "subagent", rootThreadId: "thr-grok" } } });
  thread(db, "thr-gone", { provider: "codex", title: "Deleted", created: T(0), deleted: T(9) });
  db.close();
  return dir;
}

/** v1 store: one thread v2 already has (skipped) and one only v1 has. */
function buildV1(dir: string) {
  const db = new DatabaseSync(join(dir, "state.sqlite"));
  db.exec(V1_SCHEMA);
  db.prepare("INSERT INTO projection_projects VALUES ('proj-1', 'demo', '/work/demo', '[]', ?, ?, NULL)").run(T(0), T(0));
  const th = db.prepare("INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at, model_selection_json) VALUES (?, 'proj-1', ?, ?, ?, ?)");
  th.run("thr-codex", "dup of v2", T(0), T(0), J({ provider: "codex", model: "gpt-5.5" }));
  th.run("thr-old", "Old thread", T(10), T(12), J({ provider: "codex", model: "gpt-5.4" }));
  db.prepare("INSERT INTO provider_session_runtime (thread_id, provider_name, adapter_key, status, last_seen_at, resume_cursor_json) VALUES ('thr-old', 'codex', 'codex', 'stopped', ?, ?)").run(T(12), J({ threadId: "v1-codex-thread-not-on-disk" }));
  const m = db.prepare("INSERT INTO projection_thread_messages VALUES (?, 'thr-old', 'turn-o1', ?, ?, 0, ?, ?, NULL)");
  m.run("o1", "user", "Old prompt", T(10), T(10));
  m.run("o2", "assistant", "Old reply", T(11), T(11));
  const a = db.prepare("INSERT INTO projection_thread_activities VALUES (?, 'thr-old', 'turn-o1', ?, ?, ?, ?, ?, ?)");
  a.run("a1", "tool", "tool.started", "ls", J({ itemType: "command_execution", toolCallId: "call-1", status: "inProgress", data: { toolName: "Bash", input: { command: "ls" } } }), T(10, 10), 1);
  a.run("a2", "tool", "tool.completed", "ls", J({ itemType: "command_execution", toolCallId: "call-1", status: "completed", detail: "a.ts" }), T(10, 20), 2);
  a.run("a3", "info", "context-window.updated", "ctx", J({ usedTokens: 900, inputTokens: 800, cachedInputTokens: 500, outputTokens: 100 }), T(11), 3);
  db.prepare("INSERT INTO projection_turns (thread_id, turn_id, state, requested_at, started_at, completed_at) VALUES ('thr-old', 'turn-o1', 'completed', ?, ?, ?)").run(T(10), T(10), T(11));
  db.close();
}

/** Copy the Codex/Claude fixture transcripts into HOME as the sessions T3 ran. */
function nativeTranscripts(home: string, originator = "T3 Code") {
  const rollout = readFileSync(join(FIXTURES, "codex", "home", ROLLOUT), "utf8").replace('"originator": "codex_exec"', `"originator": ${J(originator)}`);
  writeFile(join(home, ".codex", ROLLOUT), rollout);
  const claude = join(home, ".claude", "projects", "-work-demo", `${CLAUDE_ID}.jsonl`);
  writeFile(claude, readFileSync(join(FIXTURES, "claude-code", "config", "projects", "-work-demo", `${CLAUDE_ID}.jsonl`), "utf8"));
  return { claude };
}

const t3Env = ["T3CODE_HOME", "T3CODE_THREAD_ID", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE"];

describe("t3code adapter", () => {
  let env: TmpEnv;
  const saved: Record<string, string | undefined> = {};
  before(() => {
    env = tmpEnv();
    for (const k of t3Env) (saved[k] = process.env[k]), delete process.env[k];
    const dir = buildStore(env.home);
    buildV1(dir);
    nativeTranscripts(env.home);
  });
  after(() => {
    for (const k of t3Env) if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
    env.restore();
  });

  const run = async (adapters: Adapter[], index = new MemoryIndexStore()) => {
    const cenv = { ...process.env };
    const r = await backfill({ config: defaultConfig(cenv), index, blobs: new MemoryBlobStore(), adapters, env: cenv });
    assert.deepEqual(r.errors, []);
    return { index, r };
  };

  it("is registered, tier B, installs nothing", async () => {
    assert.ok(ADAPTERS.includes(t3code));
    assert.equal(t3code.tier, "B");
    assert.deepEqual(await t3code.install({ hookCommand: "x", scope: "user", dryRun: true }), []);
    const d = await t3code.detect();
    assert.equal(d.installed, true);
    assert.equal(d.hooked, true);
    assert.match(d.notes?.[0] ?? "", /coding\.sh init --agent codex --agent claude-code/);
    assert.equal(t3code.tail?.(), true);
  });

  it("splits T3 turn input into uncached, cache read and cache write", () => {
    assert.deepEqual(turnUsage({ usageStatus: "complete", inputTokens: 1000, cachedInputTokens: 600, cacheCreationTokens: 100, outputTokens: 50 }), { inputTokens: 300, outputTokens: 50, cacheReadTokens: 600, cacheWriteTokens: 100 });
    assert.equal(turnUsage({ usageStatus: "unavailable" }), undefined);
  });

  it("imports one session per provider thread, attributed to t3code", async () => {
    const { index } = await run([t3code]);
    const all = await index.listSessions({});
    const top = await index.listSessions({ parentSessionId: null });
    // Listed T3 threads: codex, claude, grok (+ v1-only thread); subagent and provider switch are children; deleted is gone.
    assert.deepEqual(top.map((s) => s.id).sort(), [CLAUDE_ID, CODEX_ID, "grok-session-1", "v1-codex-thread-not-on-disk"].sort());
    assert.deepEqual(all.map((s) => s.id).sort(), [CLAUDE_ID, CODEX_ID, "grok-session-1", "muse-session-1", "t3code-thr-sub", "v1-codex-thread-not-on-disk"].sort());
    for (const s of all) assert.equal(s.agent, "t3code", s.id);
    const by = Object.fromEntries(all.map((s) => [s.id, s]));
    assert.equal(by[CODEX_ID]!.provider, "codex");
    assert.equal(by[CLAUDE_ID]!.provider, "claude-code");
    assert.equal(by["grok-session-1"]!.provider, "grok");
    assert.equal(by["muse-session-1"]!.parent?.sessionId, "grok-session-1");
    assert.equal(by["t3code-thr-sub"]!.parent?.sessionId, "grok-session-1");
    // Codex/Claude content comes from their transcripts (same converter as their adapters).
    assert.ok((by[CODEX_ID]!.stats.usage?.outputTokens ?? 0) > 0);
    assert.ok(by[CLAUDE_ID]!.stats.toolCalls > 0);
    // Store-built Grok session: messages, tools, file change, per-turn usage.
    const g = by["grok-session-1"]!;
    assert.equal(g.title, "List files and run the tests");
    assert.equal(g.cwd, "/work/demo");
    assert.equal(g.model, "grok-model");
    assert.deepEqual(g.stats.usage, { inputTokens: 300, outputTokens: 50, cacheReadTokens: 600, cacheWriteTokens: 100 });
    assert.equal(g.stats.toolCalls, 3);
    assert.equal(g.stats.filesChanged, 1);
    assert.equal(g.stats.turns, 1);
    const gEvents = await index.listEvents("grok-session-1");
    assert.ok(!gEvents.some((e) => e.payload.text === "still stream"), "streaming messages are skipped");
    assert.equal(gEvents.filter((e) => e.kind === "tool.end").length, 2, "a running tool has no end yet");
    // T3's running cost is reported, never summed: session cost is the local estimate of its model calls.
    const codexCalls = (await index.listEvents(CODEX_ID, { kinds: ["llm.call"] })).reduce((n, e) => n + (e.usage?.costUsd ?? 0), 0);
    assert.ok(codexCalls > 0 && Math.abs(by[CODEX_ID]!.stats.usage!.costUsd! - codexCalls) < 1e-9);
    const report = (await index.listEvents(CODEX_ID)).find((e) => e.payload.type === "usage-report");
    assert.deepEqual(report?.payload.reportedUsage, { costUsd: 0.42 });
    // v1-only thread: store messages, tool activity, totals from the last context snapshot.
    const old = by["v1-codex-thread-not-on-disk"]!;
    assert.equal(old.title, "Old prompt");
    assert.equal(old.stats.toolCalls, 1);
    const { costUsd, estimatedCostUsd, ...tokens } = old.stats.usage!;
    assert.deepEqual(tokens, { inputTokens: 300, cacheReadTokens: 500, outputTokens: 100 });
    assert.ok(Math.abs(costUsd! - 0.002375) < 1e-12, "priced locally at gpt-5.4");
    assert.equal(estimatedCostUsd, costUsd, "a local price is an estimate");
  });

  it("emits well-formed events", async () => {
    const { ctx } = testCtx();
    assertWellFormed(await collect(backfillT3(ctx)));
  });

  it("dedupes against the codex and claude-code adapters in either order", async () => {
    const t3First = await run([t3code]);
    const before = { codex: (await t3First.index.listEvents(CODEX_ID)).length, claude: (await t3First.index.listEvents(CLAUDE_ID)).length };
    const second = await run([codex, claudeCode], t3First.index);
    assert.equal((await second.index.listEvents(CODEX_ID)).length, before.codex, "codex adapter adds nothing to a T3 session");
    assert.equal((await second.index.listEvents(CLAUDE_ID)).length, before.claude, "claude-code adapter adds nothing to a T3 session");

    const nativeFirst = await run([codex, claudeCode]);
    await run([t3code], nativeFirst.index);
    for (const id of [CODEX_ID, CLAUDE_ID]) {
      const a = (await t3First.index.listEvents(id)).map((e) => e.id).sort();
      const b = (await nativeFirst.index.listEvents(id)).map((e) => e.id).sort();
      assert.deepEqual(b, a, `same events for ${id} whichever adapter ran first`);
      const s = await nativeFirst.index.getSession(id);
      assert.equal(s?.agent, "t3code");
      assert.equal(new Set(a).size, a.length);
    }
    // No session appears twice under another id.
    assert.equal((await nativeFirst.index.listSessions({})).filter((s) => s.id.includes(CODEX_ID)).length, 1);
  });

  it("attributes a T3-originated Codex rollout even without the T3 store", async () => {
    const { index } = await run([codex]);
    const s = await index.getSession(CODEX_ID);
    assert.equal(s?.agent, "t3code");
    assert.equal(s?.provider, "codex");
  });

  it("skips unchanged threads on the next run", async () => {
    const index = new MemoryIndexStore();
    const first = await run([t3code], index);
    assert.ok(first.r.events > 0);
    const again = await run([t3code], index);
    assert.equal(again.r.events, 0);
  });
});

describe("T3 live capture", () => {
  let env: TmpEnv;
  before(() => {
    env = tmpEnv();
    delete process.env.T3CODE_HOME;
    buildStore(env.home);
  });
  after(() => env.restore());

  it("reads the host marker from the provider's env", () => {
    assert.deepEqual(hostOf({ T3CODE_THREAD_ID: "thr-1" }), { id: "t3code", thread: "thr-1" });
    assert.deepEqual(hostOf({ CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "T3 Code" }), { id: "t3code" });
    assert.deepEqual(hostOf({ CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "t3code_desktop" }), { id: "t3code" });
    assert.equal(hostOf({ CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "codex_vscode" }), undefined);
    assert.equal(hostOf({}), undefined);
  });

  it("claude-code hook lines under T3 become a t3code session, and backfill adds no duplicate prompts", async () => {
    const { claude } = nativeTranscripts(env.home);
    const lines = readFileSync(join(FIXTURES, "claude-code", "hooks.spool.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l.split("${FIXTURES}/claude-code/config/projects/-work-demo/" + `${CLAUDE_ID}.jsonl`).join(JSON.stringify(claude).slice(1, -1))))
      .map((l) => J({ ...l, host: { id: "t3code", thread: "thr-claude" } }));
    const cenv = { ...process.env };
    const spool = join(env.dataHome, "spool", "claude-code");
    mkdirSync(spool, { recursive: true });
    writeFileSync(join(spool, "2026-11-01.1.jsonl"), lines.join("\n") + "\n");
    const index = new MemoryIndexStore();
    const blobs = new MemoryBlobStore();
    const config = defaultConfig(cenv);
    const r = await ingest({ config, index, blobs, env: cenv, adapters: new Map(ADAPTERS.map((a) => [a.id, a])), lock: false });
    assert.deepEqual(r.errors, []);
    const live = await index.getSession(CLAUDE_ID);
    assert.equal(live?.agent, "t3code");
    assert.equal(live?.provider, "claude-code");
    const hostThread = (await index.listEvents(CLAUDE_ID)).find((e) => e.payload.hostThreadId);
    assert.equal(hostThread?.payload.hostThreadId, "thr-claude");
    await backfill({ config, index, blobs, env: cenv, adapters: [t3code, claudeCode] });
    const prompts = (await index.listEvents(CLAUDE_ID, { kinds: ["user.message"] })).filter((e) => String(e.payload.text).startsWith("Add a sum function"));
    assert.equal(prompts.length, 1);
    assert.equal((await index.getSession(CLAUDE_ID))?.agent, "t3code");
  });
});

describe("host attribution", () => {
  const ev = (o: Partial<AgentEvent>): AgentEvent => ({ id: Math.random().toString(16).slice(2).padEnd(64, "0"), v: 0, sessionId: "s1", ts: 1, agent: "codex", kind: "notification", payload: {}, ...o });

  it("gives the session to the host and keeps the provider", () => {
    const s = buildSession([ev({ kind: "session.start", ts: 1 }), ev({ agent: "t3code", ts: 2, payload: { type: "host-link", via: "t3code" } })]);
    assert.equal(s.agent, "t3code");
    assert.equal(s.provider, "codex");
    const plain = buildSession([ev({ kind: "session.start" })]);
    assert.equal(plain.agent, "codex");
    assert.equal(plain.provider, undefined);
  });

  it("persists provider in sqlite", async () => {
    const store = await SqliteIndexStore.open(":memory:");
    const s = buildSession([ev({ kind: "session.start", payload: { via: "t3code" } })]);
    await store.upsertSession(s);
    const back = await store.getSession("s1");
    assert.equal(back?.agent, "t3code");
    assert.equal(back?.provider, "codex");
    assert.equal((back?.stats as Record<string, unknown>).provider, undefined);
    await store.close();
  });

  it("usage groups by agent and model with tokens per turn and cache share", async () => {
    const index = new MemoryIndexStore();
    const mk = (id: string, agent: string, turns: number, u: { inputTokens: number; outputTokens: number; cacheReadTokens: number }, parent?: string) =>
      index.upsertSession({ id, agent, model: "gpt-5.5", startedAt: Date.now() - 1000, stats: { events: 1, turns, toolCalls: 0, toolErrors: 0, filesChanged: 0, usage: u }, flags: [], ...(parent ? { parent: { sessionId: parent } } : {}) });
    await mk("a", "t3code", 2, { inputTokens: 100, outputTokens: 100, cacheReadTokens: 800 });
    await mk("b", "codex", 4, { inputTokens: 400, outputTokens: 200, cacheReadTokens: 400 });
    // A subagent of b: its tokens count in TOKENS, its prompt is not a user turn.
    await mk("b:sub:1", "codex", 1, { inputTokens: 200, outputTokens: 0, cacheReadTokens: 4000 }, "b");
    const r = (await usage(index, { topLevel: false, since: 0 }, "agent-model", 10)) as { groups: { key: string; turns: number; totalTokens: number; tokensPerTurn: number; cacheReadShare: number }[] };
    const g = Object.fromEntries(r.groups.map((x) => [x.key, x]));
    // Tokens per user turn leave cache reads and subagents out: (100 + 100) / 2, (400 + 200) / 4.
    assert.deepEqual([g["t3code gpt-5.5"]!.turns, g["t3code gpt-5.5"]!.tokensPerTurn, g["t3code gpt-5.5"]!.cacheReadShare], [2, 100, 0.889]);
    assert.deepEqual([g["codex gpt-5.5"]!.turns, g["codex gpt-5.5"]!.tokensPerTurn, g["codex gpt-5.5"]!.cacheReadShare], [4, 150, 0.88]);
    assert.equal(g["codex gpt-5.5"]!.totalTokens, 400 + 200 + 400 + 200 + 4000, "TOKENS still counts the subagent");
  });

  it("a subagent in another group than its parent does not divide by the parent's turns", async () => {
    const index = new MemoryIndexStore();
    const mk = (id: string, model: string, turns: number, inputTokens: number, parent?: string) =>
      index.upsertSession({ id, agent: "claude-code", model, startedAt: Date.now() - 1000, stats: { events: 1, turns, toolCalls: 0, toolErrors: 0, filesChanged: 0, usage: { inputTokens, outputTokens: 0 } }, flags: [], ...(parent ? { parent: { sessionId: parent } } : {}) });
    // One prompt on Opus whose subagents ran 7.9M tokens on Sonnet: the Sonnet row has no user turn.
    await mk("p", "claude-opus-5-5", 1, 1000);
    await mk("p:sub:1", "claude-sonnet-5", 1, 7_900_000, "p");
    const r = (await usage(index, { topLevel: false, since: 0 }, "model", 10)) as { groups: { key: string; turns: number; tokensPerTurn?: number }[]; total: { turns: number; tokensPerTurn?: number } };
    const g = Object.fromEntries(r.groups.map((x) => [x.key, x]));
    assert.deepEqual([g["claude-sonnet-5"]!.turns, g["claude-sonnet-5"]!.tokensPerTurn], [0, undefined]);
    assert.deepEqual([g["claude-opus-5-5"]!.turns, g["claude-opus-5-5"]!.tokensPerTurn], [1, 1000]);
    assert.deepEqual([r.total.turns, r.total.tokensPerTurn], [1, 1000], "not 7.9M tokens per turn");
  });
});

describe("t3code v1 usage snapshots", () => {
  let env: TmpEnv;
  const saved: Record<string, string | undefined> = {};
  before(() => {
    env = tmpEnv();
    for (const k of t3Env) (saved[k] = process.env[k]), delete process.env[k];
  });
  after(() => {
    for (const k of t3Env) if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
    env.restore();
  });

  it("a later, larger thread total replaces the first one (not frozen, not summed)", async () => {
    const dir = join(env.home, ".t3", "userdata");
    mkdirSync(dir, { recursive: true });
    buildV1(dir);
    const config = defaultConfig({ ...process.env });
    const index = new MemoryIndexStore();
    const run = () => backfill({ config, index, blobs: new MemoryBlobStore(), adapters: [t3code], env: { ...process.env } });
    const sid = "v1-codex-thread-not-on-disk";
    await run();
    assert.equal((await index.getSession(sid))!.stats.usage?.outputTokens, 100);
    const db = new DatabaseSync(join(dir, "state.sqlite"));
    db.prepare("INSERT INTO projection_thread_activities VALUES ('a4', 'thr-old', 'turn-o1', 'info', 'context-window.updated', 'ctx', ?, ?, 4)").run(J({ inputTokens: 90_000, cachedInputTokens: 50_000, outputTokens: 7000 }), T(13));
    db.close();
    utimesSync(join(dir, "state.sqlite"), new Date(), new Date(Date.now() + 5000));
    await run();
    const u = (await index.getSession(sid))!.stats.usage!;
    assert.deepEqual([u.inputTokens, u.cacheReadTokens, u.outputTokens], [40_000, 50_000, 7000]);
    // gpt-5.4: 40K × $2.50 + 50K × $0.25 + 7K × $15 per 1M, the latest snapshot priced once.
    assert.ok(Math.abs(u.costUsd! - 0.2175) < 1e-9, String(u.costUsd));
  });
});

// Native id shapes seen on a real install (T3 0.1.7 driving Pi 1.5.0; OpenCode 1.19.5's opencode.db).
describe("t3code native ids from real installs", () => {
  let env: TmpEnv;
  const saved: Record<string, string | undefined> = {};
  const PI_ID = "01a1b505-0d47-77fa-8dac-f35329f7818e";
  const OC_ID = "ses_e4b0a0cc8ffe19CiWeM0N8wEWa";
  before(() => {
    env = tmpEnv();
    for (const k of t3Env) (saved[k] = process.env[k]), delete process.env[k];
  });
  after(() => {
    for (const k of t3Env) if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
    env.restore();
  });

  it("Pi's native id is its session file path; OpenCode 1.x sessions live in the session table", async () => {
    const dir = join(env.home, ".t3", "userdata");
    mkdirSync(dir, { recursive: true });
    const piFile = join(env.home, ".pi", "agent", "sessions", "--work-demo--", `2026-11-07T07-59-29-608Z_${PI_ID}.jsonl`);
    writeFile(piFile, `${J({ type: "session", version: 3, id: PI_ID, timestamp: T(0), cwd: "/work/demo" })}\n`);
    const ocDir = join(env.home, ".local", "share", "opencode");
    mkdirSync(ocDir, { recursive: true });
    const oc = new DatabaseSync(join(ocDir, "opencode.db"));
    oc.exec("CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, time_created INTEGER, time_updated INTEGER)");
    oc.prepare("INSERT INTO session VALUES (?, '/work/demo', 0, 0)").run(OC_ID);
    oc.close();
    const db = new DatabaseSync(join(dir, "statev2.sqlite"));
    db.exec(V2_SCHEMA);
    db.prepare("INSERT INTO projection_projects VALUES ('proj-1', 'demo', '/work/demo', '[]', ?, ?, NULL, NULL)").run(T(0), T(0));
    thread(db, "thr-pi", { provider: "pi", title: "create hello.txt", created: T(0) });
    providerThread(db, "pt-pi", "thr-pi", "pi", piFile, 1);
    thread(db, "thr-oc", { provider: "opencode", title: "create hello.txt", created: T(1) });
    providerThread(db, "pt-oc", "thr-oc", "opencode", OC_ID, 1);
    db.prepare("INSERT INTO orchestration_v2_projection_messages VALUES ('m-oc', 'thr-oc', NULL, 'node-1', 'user', 0, ?, ?, ?)").run(T(1), T(1), J({ text: "create hello.txt" }));
    db.close();
    const cenv = { ...process.env };
    const index = new MemoryIndexStore();
    const r = await backfill({ config: defaultConfig(cenv), index, blobs: new MemoryBlobStore(), adapters: [t3code], env: cenv });
    assert.deepEqual(r.errors, []);
    const ids = (await index.listSessions({})).map((s) => s.id).sort();
    assert.deepEqual(ids, [OC_ID, PI_ID].sort(), "linked to the provider's own session ids, never a file path");
    // Found natively: the provider's own capture has the content, so T3 adds only the link.
    assert.equal((await index.listEvents(OC_ID, { kinds: ["user.message"] })).length, 0);
  });
});
