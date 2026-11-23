// T3 Code adapter: a synthetic T3 store (real v2/v1 table shapes, made-up rows)
// built in a temp HOME next to Codex and Claude transcripts T3 "ran".
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { claudeCode } from "../../src/adapters/claude-code.ts";
import { codex } from "../../src/adapters/codex.ts";
import { SQLITE_COPY_OWNER, SQLITE_COPY_PREFIX } from "../../src/adapters/_shared/sqlite-copies.ts";
import { ADAPTERS } from "../../src/adapters/index.ts";
import { backfillT3, providerAgent, t3code, turnUsage } from "../../src/adapters/t3code.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { backfill, childLinker, ingest, recomputeSession } from "../../src/core/ingest.ts";
import { repoResolver } from "../../src/core/repo-state.ts";
import { reparse } from "../../src/core/reparse.ts";
import { buildSession } from "../../src/core/sessions.ts";
import type { Adapter } from "../../src/core/types.ts";
import { timeline, usage } from "../../src/mcp/data.ts";
import type { AgentEvent, Session } from "../../src/schema/index.ts";
import { buildModel, layoutRows, readRows, type Row } from "../../src/viewer/model.ts";
import * as show from "../../src/cli/commands/show.ts";
import { runCmd, sandbox } from "../cli/_cmd.ts";
import { hostOf } from "../../src/spool/host.ts";
import { CLI } from "../_cli.ts";
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
CREATE TABLE orchestration_v2_projection_runtime_requests (runtime_request_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, node_id TEXT NOT NULL, provider_turn_id TEXT, kind TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT, payload_json TEXT NOT NULL);
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

  it("imports one session per provider thread, attributed to the agent that ran with T3 Code as host", async () => {
    const { index } = await run([t3code]);
    const all = await index.listSessions({});
    const top = await index.listSessions({ parentSessionId: null });
    // Listed T3 threads: codex, claude, grok (+ v1-only thread); subagent and provider switch are children; deleted is gone.
    assert.deepEqual(top.map((s) => s.id).sort(), [CLAUDE_ID, CODEX_ID, "grok-session-1", "v1-codex-thread-not-on-disk"].sort());
    assert.deepEqual(all.map((s) => s.id).sort(), [CLAUDE_ID, CODEX_ID, "grok-session-1", "muse-session-1", "t3code-thr-sub", "v1-codex-thread-not-on-disk"].sort());
    const by = Object.fromEntries(all.map((s) => [s.id, s]));
    // The agent is the one that ran; T3 Code is the host. A thread that never reached a provider stays T3 Code's, with no host.
    const ran = Object.fromEntries(all.map((s) => [s.id, [s.agent, s.host]]));
    assert.deepEqual(ran, {
      [CLAUDE_ID]: ["claude-code", "t3code"],
      [CODEX_ID]: ["codex", "t3code"],
      "grok-session-1": ["grok", "t3code"],
      "muse-session-1": ["muse", "t3code"],
      "t3code-thr-sub": ["t3code", undefined],
      "v1-codex-thread-not-on-disk": ["codex", "t3code"],
    });
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
    // T3's thread title titles the session, not its first prompt.
    assert.equal(g.title, "List files");
    assert.equal(by[CLAUDE_ID]!.title, "Add sum", "a transcript session takes the title of the T3 thread that ran it");
    const link = (await index.listEvents(CLAUDE_ID)).find((e) => e.payload.type === "host-link");
    assert.equal(link?.payload.message, "T3 Code thread: Add sum", "show names the thread");
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
    assert.equal(old.title, "Old thread");
    assert.equal(old.stats.toolCalls, 1);
    const { costUsd, estimatedCostUsd, estimatedCostByTokenType, ...tokens } = old.stats.usage!;
    assert.deepEqual(tokens, { inputTokens: 300, cacheReadTokens: 500, outputTokens: 100 });
    assert.ok(Math.abs(costUsd! - 0.002375) < 1e-12, "priced locally at gpt-5.4");
    assert.equal(estimatedCostUsd, costUsd, "a local price is an estimate");
    assert.deepEqual(estimatedCostByTokenType, { cacheRead: 0.000125, cacheWrite: 0, input: 0.00075, output: 0.0015 }, "the snapshot's estimate is split by token type");
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
      assert.equal(s?.agent, id === CODEX_ID ? "codex" : "claude-code");
      assert.equal(s?.host, "t3code");
      assert.equal(new Set(a).size, a.length);
    }
    // No session appears twice under another id.
    assert.equal((await nativeFirst.index.listSessions({})).filter((s) => s.id.includes(CODEX_ID)).length, 1);
  });

  it("attributes a T3-originated Codex rollout even without the T3 store", async () => {
    const { index } = await run([codex]);
    const s = await index.getSession(CODEX_ID);
    assert.equal(s?.agent, "codex");
    assert.equal(s?.host, "t3code");
    assert.equal(s?.provider, "codex");
  });

  it("skips unchanged threads on the next run", async () => {
    const index = new MemoryIndexStore();
    const first = await run([t3code], index);
    assert.ok(first.r.events > 0);
    const again = await run([t3code], index);
    assert.equal(again.r.events, 0);
  });

  // QA: `ingest --backfill --since` dropped the host-link of a T3-run Claude session that started before the
  // cutoff (it is stamped at the thread's start), so the session showed as claude-code with its raw prompt as title.
  it("a session with activity inside the --since window is imported whole, its T3 link included", async () => {
    const mine = (events: AgentEvent[]) => events.filter((e) => e.sessionId === CLAUDE_ID);
    const all = mine(await collect(backfillT3(testCtx().ctx)));
    const since = Math.max(...all.map((e) => e.ts));
    const link = all.find((e) => e.payload.type === "host-link");
    assert.ok(link && link.ts < since);
    const some = mine(await collect(backfillT3(testCtx().ctx, { since })));
    assert.deepEqual(some.map((e) => e.id).sort(), all.map((e) => e.id).sort());
    const s = buildSession(some);
    assert.equal(s.agent, "claude-code");
    assert.equal(s.host, "t3code");
    assert.equal(s.title, "Add sum");
    // A session with nothing inside the window stays out.
    assert.deepEqual(await collect(backfillT3(testCtx().ctx, { since: Date.now() + 86_400_000 })), []);
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

  it("claude-code hook lines under T3 become a claude-code session hosted by t3code, and backfill adds no duplicate prompts", async () => {
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
    assert.equal(live?.agent, "claude-code");
    assert.equal(live?.host, "t3code");
    assert.equal(live?.provider, "claude-code");
    const hostThread = (await index.listEvents(CLAUDE_ID)).find((e) => e.payload.hostThreadId);
    assert.equal(hostThread?.payload.hostThreadId, "thr-claude");
    await backfill({ config, index, blobs, env: cenv, adapters: [t3code, claudeCode] });
    const prompts = (await index.listEvents(CLAUDE_ID, { kinds: ["user.message"] })).filter((e) => String(e.payload.text).startsWith("Add a sum function"));
    assert.equal(prompts.length, 1);
    assert.equal((await index.getSession(CLAUDE_ID))?.agent, "claude-code");
    assert.equal((await index.getSession(CLAUDE_ID))?.host, "t3code");
  });
});

describe("host attribution", () => {
  const ev = (o: Partial<AgentEvent>): AgentEvent => ({ id: Math.random().toString(16).slice(2).padEnd(64, "0"), v: 0, sessionId: "s1", ts: 1, agent: "codex", kind: "notification", payload: {}, ...o });

  it("keeps the agent that ran and names the host", () => {
    const s = buildSession([ev({ kind: "session.start", ts: 1 }), ev({ agent: "t3code", ts: 2, payload: { type: "host-link", via: "t3code" } })]);
    assert.equal(s.agent, "codex");
    assert.equal(s.host, "t3code");
    assert.equal(s.provider, "codex");
    const plain = buildSession([ev({ kind: "session.start" })]);
    assert.equal(plain.agent, "codex");
    assert.equal(plain.host, undefined, "a direct session has no host");
    assert.equal(plain.provider, undefined);
  });

  it("titles the session with the host's thread title, before its prompt", () => {
    const prompt = ev({ kind: "user.message", ts: 3, payload: { text: "Context handoff (full_thread_summary): Provider context handoff." } });
    const s = buildSession([ev({ kind: "session.start", ts: 1 }), prompt, ev({ agent: "t3code", ts: 2, payload: { type: "host-link", via: "t3code", title: "Coding.sh 100-Star Milestone Graphic" } })]);
    assert.equal(s.title, "Coding.sh 100-Star Milestone Graphic");
    const untitled = buildSession([ev({ kind: "session.start", ts: 1 }), prompt, ev({ agent: "t3code", ts: 2, payload: { type: "host-link", via: "t3code" } })]);
    assert.equal(untitled.title, "Context handoff (full_thread_summary): Provider context handoff.");
  });

  it("persists host and provider in sqlite", async () => {
    const store = await SqliteIndexStore.open(":memory:");
    const s = buildSession([ev({ kind: "session.start", payload: { via: "t3code" } })]);
    await store.upsertSession(s);
    const back = await store.getSession("s1");
    assert.equal(back?.agent, "codex");
    assert.equal(back?.host, "t3code");
    assert.equal(back?.provider, "codex");
    assert.equal((back?.stats as Record<string, unknown>).provider, undefined);
    assert.equal((back?.stats as Record<string, unknown>).host, undefined);
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

describe("T3 Claude subagent threads", () => {
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

  it("does not store a subagent the claude-code transcript holds a second time", async () => {
    const { claude } = nativeTranscripts(env.home);
    const subDir = join(claude.slice(0, -".jsonl".length), "subagents");
    writeFile(join(subDir, "agent-a111.jsonl"), "{}\n");
    writeFile(join(subDir, "workflows", "wf_1", "agent-ab22.jsonl"), "{}\n");
    const dir = join(env.home, ".t3", "userdata");
    mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(join(dir, "statev2.sqlite"));
    db.exec(V2_SCHEMA);
    db.prepare("INSERT INTO projection_projects VALUES ('proj-1', 'demo', '/work/demo', '[]', ?, ?, NULL, NULL)").run(T(0), T(0));
    thread(db, "mcp:launch:root", { provider: "claudeAgent", title: "Root", created: T(0) });
    providerThread(db, "pt-root", "mcp:launch:root", "claudeAgent", CLAUDE_ID, 1);
    const sub = (id: string, parent: string, title: string) => thread(db, id, { provider: "claudeAgent", title, created: T(1), payload: { lineage: { parentThreadId: parent, relationshipToParent: "subagent", rootThreadId: "mcp:launch:root" } } });
    // T3 ids are percent-encoded; the agent id is the last segment.
    sub("thread:native-thread:pending%3Aroot%3Aa111", "mcp:launch:root", "Smoke test");
    sub("thread:native-thread:pending%3Aroot%3Aa999", "mcp:launch:root", "No transcript for this one");
    sub("thread:native-thread:pending%3Aroot%3Awcsbor", "mcp:launch:root", "Workflow");
    sub("thread:native-thread:pending%3Aroot%3Awcsbor%3Aagent%3A1", "thread:native-thread:pending%3Aroot%3Awcsbor", "ok");
    db.close();

    const { index } = await runAll();
    const ids = (await index.listSessions({})).map((s) => s.id);
    assert.ok(!ids.some((i) => i.endsWith("a111")), "a subagent with a transcript file is the claude-code child only");
    assert.ok(!ids.some((i) => i.includes("%3Aagent%3A1")), "a workflow agent is the claude-code child only");
    assert.ok(ids.some((i) => i.endsWith("a999")), "a subagent without a transcript keeps its t3code session");
    assert.ok(ids.some((i) => i.endsWith("wcsbor")), "the workflow thread has no transcript of its own and stays");
    assert.ok(ids.includes(CLAUDE_ID));
  });

  it("does not store a subagent a later Claude session of the parent thread holds a second time", async () => {
    // A thread that switched to a second Claude session: the subagent ran in the second one, whose
    // transcript holds it. T3 nests the provider thread id in the subagent thread id, encoded again each level.
    const { claude } = nativeTranscripts(env.home);
    const LATER = "b0b0b0b0-0000-4000-8000-000000000002";
    const later = join(dirname(claude), `${LATER}.jsonl`);
    writeFile(later, readFileSync(claude, "utf8").replaceAll(CLAUDE_ID, LATER));
    writeFile(join(later.slice(0, -".jsonl".length), "subagents", "agent-a333.jsonl"), "{}\n");
    const dir = join(env.home, ".t3", "userdata");
    mkdirSync(dir, { recursive: true });
    rmSync(join(dir, "statev2.sqlite"), { force: true });
    const db = new DatabaseSync(join(dir, "statev2.sqlite"));
    db.exec(V2_SCHEMA);
    db.prepare("INSERT INTO projection_projects VALUES ('proj-1', 'demo', '/work/demo', '[]', ?, ?, NULL, NULL)").run(T(0), T(0));
    thread(db, "mcp:launch:root", { provider: "claudeAgent", title: "Root", created: T(0) });
    providerThread(db, "pt-root", "mcp:launch:root", "claudeAgent", CLAUDE_ID, 1);
    const pt2 = "provider:claudeAgent:native-thread:pending%3Arun%3Athread%3Amcp%253Alaunch%253Aroot%3Aordinal%3A15";
    providerThread(db, pt2, "mcp:launch:root", "claudeAgent", LATER, 15);
    const subId = `provider:claudeAgent:native-thread:${encodeURIComponent(`provider-thread:${pt2}`)}%3Aa333`;
    thread(db, subId, { provider: "claudeAgent", title: "Smoke test", created: T(1), payload: { lineage: { parentThreadId: "mcp:launch:root", relationshipToParent: "subagent", rootThreadId: "mcp:launch:root" } } });
    db.close();

    const { index } = await runAll();
    const ids = (await index.listSessions({})).map((s) => s.id);
    assert.ok(!ids.some((i) => i.endsWith("a333")), `the subagent is the claude-code child of the later session only: ${ids.join(", ")}`);
    assert.ok(ids.includes(LATER));
  });

  it("re-parse deletes the t3code copies an older parse stored of subagents the claude-code transcript holds", async () => {
    const { claude } = nativeTranscripts(env.home);
    const subDir = join(claude.slice(0, -".jsonl".length), "subagents");
    const dir = join(env.home, ".t3", "userdata");
    mkdirSync(dir, { recursive: true });
    rmSync(join(dir, "statev2.sqlite"), { force: true });
    const db = new DatabaseSync(join(dir, "statev2.sqlite"));
    db.exec(V2_SCHEMA);
    db.prepare("INSERT INTO projection_projects VALUES ('proj-1', 'demo', '/work/demo', '[]', ?, ?, NULL, NULL)").run(T(0), T(0));
    thread(db, "mcp:launch:root", { provider: "claudeAgent", title: "Root", created: T(0) });
    providerThread(db, "pt-root", "mcp:launch:root", "claudeAgent", CLAUDE_ID, 1);
    thread(db, "thread:native-thread:pending%3Aroot%3Aa222", { provider: "claudeAgent", title: "Smoke test", created: T(1), payload: { lineage: { parentThreadId: "mcp:launch:root", relationshipToParent: "subagent", rootThreadId: "mcp:launch:root" } } });
    db.close();
    const cenv = { ...process.env };
    const index = new MemoryIndexStore();
    const o = { config: defaultConfig(cenv), index, blobs: new MemoryBlobStore(), env: cenv };
    // The older parse did not see the transcript's subagents dir, so it stored the thread as a t3code session.
    await backfill({ ...o, adapters: [{ ...t3code, parseVersion: 7 }] });
    const copy = (await index.listSessions({})).map((s) => s.id).find((i) => i.endsWith("a222"));
    assert.ok(copy, "the older parse stored the copy");
    writeFile(join(subDir, "agent-a222.jsonl"), "{}\n");
    const owner = `${CLAUDE_ID}:sub:a222`;
    await index.putEvents([{ id: "own-1", v: 0, sessionId: owner, ts: Date.parse(T(1)), agent: "claude-code", kind: "session.start", source: "transcript", payload: {} }]);
    await recomputeSession(index, owner, { linker: childLinker(index), repo: repoResolver() });
    assert.ok(await index.getSession(owner));

    const r = await reparse({ ...o, adapters: new Map([["t3code", t3code]]) });
    assert.deepEqual(r.errors, []);
    assert.equal(r.copiesRemoved, 1);
    assert.equal(await index.getSession(copy), undefined);
    assert.ok(await index.getSession(owner));
  });

  const runAll = async () => {
    const cenv = { ...process.env };
    const index = new MemoryIndexStore();
    const r = await backfill({ config: defaultConfig(cenv), index, blobs: new MemoryBlobStore(), adapters: [t3code], env: cenv });
    assert.deepEqual(r.errors, []);
    return { index };
  };
});

// orchestration_v2_projection_subagents, with the columns of a real store.
const SUBAGENTS_SCHEMA = `CREATE TABLE orchestration_v2_projection_subagents (subagent_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT, parent_node_id TEXT, provider TEXT NOT NULL, provider_thread_id TEXT, child_thread_id TEXT, origin TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT, completed_at TEXT, updated_at TEXT NOT NULL, payload_json TEXT NOT NULL, driver TEXT, provider_instance_id TEXT, completion_delivery_state TEXT);`;

describe("T3 Claude subagent runs under resumed transcripts and workflows", () => {
  let env: TmpEnv;
  const saved: Record<string, string | undefined> = {};
  const RESUMED_ID = "22222222-3333-4444-8555-666666666666";
  beforeEach(() => {
    env = tmpEnv();
    for (const k of t3Env) (saved[k] = process.env[k]), delete process.env[k];
  });
  afterEach(() => {
    for (const k of t3Env) if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
    env.restore();
  });

  /** A v2 store with a Claude root thread; returns the open db. */
  const store = () => {
    const dir = join(env.home, ".t3", "userdata");
    mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(join(dir, "statev2.sqlite"));
    db.exec(V2_SCHEMA + SUBAGENTS_SCHEMA);
    db.prepare("INSERT INTO projection_projects VALUES ('proj-1', 'demo', '/work/demo', '[]', ?, ?, NULL, NULL)").run(T(0), T(0));
    thread(db, "mcp:launch:root", { provider: "claudeAgent", title: "Root", created: T(0) });
    providerThread(db, "pt-root", "mcp:launch:root", "claudeAgent", CLAUDE_ID, 1);
    return db;
  };
  const sub = (db: DatabaseSync, id: string, parent: string) =>
    thread(db, id, { provider: "claudeAgent", title: "sub", created: T(1), payload: { lineage: { parentThreadId: parent, relationshipToParent: "subagent", rootThreadId: "mcp:launch:root" } } });
  const copiesOf = async () => {
    const copied: [string, string][] = [];
    const events = await collect(backfillT3(testCtx().ctx, { copied: (s, o) => copied.push([s, o]) }));
    return { copied: copied.sort(), sessions: [...new Set(events.map((e) => e.sessionId))] };
  };

  it("a subagent whose run sits under the resumed conversation's transcript is stored once, and re-parse removes the old copy", async () => {
    const { claude } = nativeTranscripts(env.home);
    const resumed = join(dirname(claude), `${RESUMED_ID}.jsonl`);
    writeFile(resumed, "{}\n");
    const db = store();
    providerThread(db, "pt-root-2", "mcp:launch:root", "claudeAgent", RESUMED_ID, 2);
    const child = "thread:native-thread:pending%3Aroot2%3Ab333";
    sub(db, child, "mcp:launch:root");
    db.close();
    const cenv = { ...process.env };
    const index = new MemoryIndexStore();
    const o = { config: defaultConfig(cenv), index, blobs: new MemoryBlobStore(), env: cenv };
    // Before the agent file is written, the thread is a t3code session (as an older parse stored it).
    await backfill({ ...o, adapters: [{ ...t3code, parseVersion: 8 }] });
    const copy = `t3code-${child}`;
    assert.ok(await index.getSession(copy));
    writeFile(join(resumed.slice(0, -".jsonl".length), "subagents", "agent-b333.jsonl"), "{}\n");
    const owner = `${RESUMED_ID}:sub:b333`;
    assert.deepEqual((await copiesOf()).copied, [[copy, owner]], "the run is the resumed transcript's subagent, not the first one's");
    await index.putEvents([{ id: "own-1", v: 0, sessionId: owner, ts: Date.parse(T(1)), agent: "claude-code", kind: "session.start", source: "transcript", payload: {} }]);
    await recomputeSession(index, owner, { linker: childLinker(index), repo: repoResolver() });

    const r = await reparse({ ...o, adapters: new Map([["t3code", t3code]]) });
    assert.deepEqual(r.errors, []);
    assert.equal(r.copiesRemoved, 1);
    assert.equal(await index.getSession(copy), undefined);
    assert.ok(await index.getSession(RESUMED_ID));
  });

  it("a workflow run and its agents are the claude-code workflow transcripts, named by T3's subagent rows", async () => {
    const { claude } = nativeTranscripts(env.home);
    const wfDir = join(claude.slice(0, -".jsonl".length), "subagents", "workflows");
    writeFile(join(wfDir, "wf_7", "agent-ac33.jsonl"), "{}\n");
    const db = store();
    const run = "thread:native-thread:pending%3Aroot%3Awfrun";
    const other = "thread:native-thread:pending%3Aroot%3Awfother";
    const a1 = `${run}%3Aagent%3A1`;
    const a2 = `${run}%3Aagent%3A2`;
    sub(db, run, "mcp:launch:root");
    sub(db, other, "mcp:launch:root");
    sub(db, a1, run);
    sub(db, a2, run);
    const row = db.prepare("INSERT INTO orchestration_v2_projection_subagents VALUES (?, 'mcp:launch:root', NULL, NULL, 'claudeAgent', 'pt-root', ?, 'provider_native', 'completed', ?, ?, ?, ?, 'claudeAgent', NULL, NULL)");
    const agents = [{ index: 1, label: "one", agentId: "ac33", childThreadId: a1, state: "done" }, { index: 2, label: "two", agentId: "ad44", childThreadId: a2, state: "done" }];
    row.run("sa-1", run, T(1), T(2), T(2), J({ workflow: { name: "review", runHandles: { runId: "wf_7" }, agents } }));
    row.run("sa-2", other, T(1), T(2), T(2), J({ workflow: { name: "review", runHandles: { runId: "wf_8" }, agents: [] } }));
    row.run("sa-3", "x", T(1), T(2), T(2), `{"workflow": {not json`);
    db.close();

    const { copied, sessions } = await copiesOf();
    assert.deepEqual(copied, [
      [`t3code-${a1}`, `${CLAUDE_ID}:sub:ac33`],
      [`t3code-${a2}`, CLAUDE_ID],
      [`t3code-${run}`, CLAUDE_ID],
    ].sort(), "the run belongs to the root, an agent with a transcript is that subagent, one without falls back to the root");
    assert.deepEqual(sessions.sort(), [CLAUDE_ID, `t3code-${other}`].sort(), "a run whose directory is not on disk keeps its t3code session");
  });
});

describe("T3 store-built model calls", () => {
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

  it("one llm.call per finished turn, on the turn's model, with usage only when T3 has it", async () => {
    const dir = join(env.home, ".t3", "userdata");
    mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(join(dir, "statev2.sqlite"));
    db.exec(V2_SCHEMA);
    db.prepare("INSERT INTO projection_projects VALUES ('proj-1', 'demo', '/work/demo', '[]', ?, ?, NULL, NULL)").run(T(0), T(0));
    thread(db, "thr-g", { provider: "grok", title: "List files", created: T(0) });
    // T3 leaves the provider thread's model empty; the thread's default is gpt-5.5.
    providerThread(db, "pt-g", "thr-g", "grok", "grok-session-9", 1, { nativeMetadata: { modelSelection: { model: null } } });
    const turn = db.prepare("INSERT INTO orchestration_v2_projection_provider_turns VALUES (?, 'thr-g', 'pt-g', 'node-1', NULL, ?, ?, ?, ?, ?)");
    turn.run("tu-1", 1, "completed", T(1), T(2), J({ status: "completed", model: "grok-4-fast", turnTokenUsage: { usageStatus: "complete", inputTokens: 100, outputTokens: 10 } }));
    turn.run("tu-2", 2, "completed", T(3), T(4), J({ status: "completed", model: "grok-4", turnTokenUsage: { usageStatus: "unavailable" } }));
    turn.run("tu-3", 3, "completed", T(5), T(6), J({ status: "completed" }));
    turn.run("tu-4", 4, "running", T(7), null, J({ status: "running", model: "grok-4" }));
    db.close();
    const calls = (await collect(backfillT3(testCtx().ctx))).filter((e) => e.kind === "llm.call");
    assert.deepEqual(
      calls.map((e) => [e.payload.providerTurnId, e.payload.responseModel, e.model, e.durationMs, e.usage === undefined]),
      [
        ["tu-1", "grok-4-fast", "grok-4-fast", 60_000, false],
        ["tu-2", "grok-4", "grok-4", 60_000, true],
        ["tu-3", "gpt-5.5", "gpt-5.5", 60_000, true],
      ],
    );
  });

  it("names no thread title for T3's unnamed-thread placeholder", async () => {
    const dir = join(env.home, ".t3", "userdata");
    mkdirSync(dir, { recursive: true });
    rmSync(join(dir, "statev2.sqlite"), { force: true });
    const db = new DatabaseSync(join(dir, "statev2.sqlite"));
    db.exec(V2_SCHEMA);
    db.prepare("INSERT INTO projection_projects VALUES ('proj-1', 'demo', '/work/demo', '[]', ?, ?, NULL, NULL)").run(T(0), T(0));
    thread(db, "thr-new", { provider: "grok", title: "New thread", created: T(0) });
    providerThread(db, "pt-new", "thr-new", "grok", "grok-session-new", 1);
    db.close();
    const link = (await collect(backfillT3(testCtx().ctx))).find((e) => e.sessionId === "grok-session-new" && e.payload.type === "host-link");
    assert.ok(link);
    assert.equal(link.payload.title, undefined);
    assert.equal(link.payload.message, "T3 Code thread");
  });

  it("judges a Codex exec cell as Codex does: a finished or running script is ok, a nonzero chunk or a stale tool request is not", async () => {
    const dir = join(env.home, ".t3", "userdata");
    mkdirSync(dir, { recursive: true });
    rmSync(join(dir, "statev2.sqlite"), { force: true });
    const db = new DatabaseSync(join(dir, "statev2.sqlite"));
    db.exec(V2_SCHEMA);
    db.prepare("INSERT INTO projection_projects VALUES ('proj-1', 'demo', '/work/demo', '[]', ?, ?, NULL, NULL)").run(T(0), T(0));
    thread(db, "thr-x", { provider: "codex", title: "Run the tests", created: T(0) });
    // No rollout on disk for this native id: the session is built from T3's own rows.
    providerThread(db, "pt-x", "thr-x", "codex", "0193bbbb-1111-7222-8333-444455556666", 1);
    const item = db.prepare("INSERT INTO orchestration_v2_projection_turn_items VALUES (?, 'thr-x', NULL, 'node-1', 'pt-x', NULL, NULL, ?, 'dynamic_tool', 'failed', ?, ?)");
    const text = (...t: string[]) => t.map((s) => ({ type: "inputText", text: s }));
    const cell = (id: string, n: number, output: unknown) =>
      item.run(id, n, T(1, n), J({ id, status: "failed", toolName: "exec", input: { code: "text(await tools.exec_command({ cmd: 'npm test' }))" }, output, startedAt: T(1), completedAt: T(1, n) }));
    cell("x-ok", 1, text("Script completed\nWall time: 1.2 seconds\nOutput:", J({ exit_code: 0, output: "2 passing" })));
    cell("x-run", 2, text("Script running with cell ID 7\nWall time: 30.0 seconds\nOutput:"));
    cell("x-fail", 3, text("Script completed\nWall time: 0.8 seconds\nOutput:", J({ exit_code: 2, output: "1 failing" })));
    cell("x-stale", 4, text("Script failed\nError: tool call failed: Codex app-server has no active turn for this tool request."));
    db.close();
    const events = await collect(backfillT3(testCtx().ctx));
    const ends = events.filter((e) => e.kind === "tool.end");
    assert.deepEqual(
      ends.map((e) => [e.payload.toolUseId, e.payload.ok, e.payload.interrupted]),
      [
        ["x-ok", true, undefined],
        ["x-run", true, undefined],
        ["x-fail", false, undefined],
        ["x-stale", false, true],
      ],
    );
    const s = buildSession(events.filter((e) => e.sessionId === "0193bbbb-1111-7222-8333-444455556666"));
    assert.equal(s.stats.toolErrors, 1);
    assert.equal(s.stats.interruptedToolCalls, 1);
  });
});

describe("T3 requests to the user", () => {
  // T3 records a request to the user twice: a runtime request (status pending until resolved,
  // expired or cancelled) and a turn item that carries the prompt or question (status waiting).
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

  const ago = (min: number) => new Date(Date.now() - min * 60e3).toISOString();
  const storePath = () => join(env.home, ".t3", "userdata", "statev2.sqlite");

  /** A thread running Codex that waits on a command approval, and one running Grok that asked a question. */
  function requestStore() {
    mkdirSync(dirname(storePath()), { recursive: true });
    rmSync(storePath(), { force: true });
    const db = new DatabaseSync(storePath());
    db.exec(V2_SCHEMA);
    db.prepare("INSERT INTO projection_projects VALUES ('proj-1', 'demo', '/work/demo', '[]', ?, ?, NULL, NULL)").run(ago(30), ago(30));
    const msg = db.prepare("INSERT INTO orchestration_v2_projection_messages VALUES (?, ?, NULL, 'node-1', 'user', 0, ?, ?, ?)");
    const turn = db.prepare("INSERT INTO orchestration_v2_projection_provider_turns VALUES (?, ?, ?, 'node-1', NULL, 1, 'running', ?, NULL, ?)");
    const item = db.prepare("INSERT INTO orchestration_v2_projection_turn_items VALUES (?, ?, NULL, 'node-1', ?, ?, NULL, 1, ?, 'waiting', ?, ?)");
    const request = db.prepare("INSERT INTO orchestration_v2_projection_runtime_requests VALUES (?, ?, 'node-1', ?, ?, 'pending', ?, NULL, ?)");
    // The Codex thread's rollout is not on disk: its session is built from T3's store.
    thread(db, "thr-ask", { provider: "codex", title: "Publish the package", created: ago(10) });
    providerThread(db, "pt-ask", "thr-ask", "codex", "codex-ask-not-on-disk", 1);
    msg.run("m-ask", "thr-ask", ago(9), ago(9), J({ text: "Publish the package" }));
    turn.run("tu-ask", "thr-ask", "pt-ask", ago(9), J({ status: "running" }));
    item.run("it-ask", "thr-ask", "pt-ask", "tu-ask", "approval_request", ago(2), J({ id: "it-ask", status: "waiting", type: "approval_request", requestId: "req-ask", requestKind: "command", reason: "Run npm publish", startedAt: ago(2) }));
    request.run("req-ask", "thr-ask", "tu-ask", "command", ago(2), J({ id: "req-ask", kind: "command", status: "pending", createdAt: ago(2) }));
    thread(db, "thr-q", { provider: "grok", title: "Pick a database", created: ago(10) });
    providerThread(db, "pt-q", "thr-q", "grok", "grok-q", 1);
    msg.run("m-q", "thr-q", ago(9), ago(9), J({ text: "Set up storage" }));
    turn.run("tu-q", "thr-q", "pt-q", ago(9), J({ status: "running" }));
    const questions = [{ id: "q1", header: "Database", question: "Which database should I use?", options: [{ label: "SQLite" }, { label: "Postgres" }], multiSelect: false }];
    item.run("it-q", "thr-q", "pt-q", "tu-q", "user_input_request", ago(3), J({ id: "it-q", status: "waiting", type: "user_input_request", requestId: "req-q", questions, startedAt: ago(3) }));
    request.run("req-q", "thr-q", "tu-q", "user_input", ago(3), J({ id: "req-q", kind: "user_input", status: "pending", createdAt: ago(3) }));
    // A provider's own tool call is a runtime request too, but not one put to the user.
    request.run("req-tool", "thr-q", "tu-q", "dynamic_tool_call", ago(3), J({ id: "req-tool", kind: "dynamic_tool_call", status: "pending" }));
    db.close();
  }

  const waitOf = (events: AgentEvent[], id: string) => buildSession(events.filter((e) => e.sessionId === id)).stats.waiting;

  it("an open approval is a permission wait and an open question a question, with their text", async () => {
    requestStore();
    const events = await collect(backfillT3(testCtx().ctx));
    assertWellFormed(events);
    const ask = waitOf(events, "codex-ask-not-on-disk");
    assert.equal(ask?.kind, "permission");
    assert.equal(ask?.text, "Run npm publish");
    const q = waitOf(events, "grok-q");
    assert.equal(q?.kind, "question");
    assert.equal(q?.text, "Which database should I use?");
    const note = events.find((e) => e.payload.requestId === "req-ask")!;
    assert.deepEqual([note.payload.type, note.payload.requestKind, note.payload.tool], ["permission_prompt", "command", "shell"]);
    assert.equal(events.some((e) => e.payload.requestId === "req-tool"), false, "a provider's tool call is not a request to the user");
  });

  it("a request T3 resolved leaves no wait, whichever record says so first", async () => {
    requestStore();
    const db = new DatabaseSync(storePath());
    // The approval: its runtime request resolved, its item not yet updated.
    db.prepare("UPDATE orchestration_v2_projection_runtime_requests SET status = 'resolved', resolved_at = ? WHERE runtime_request_id = 'req-ask'").run(ago(1));
    // The question: its item answered, its runtime request still pending.
    db.prepare("UPDATE orchestration_v2_projection_turn_items SET status = 'completed', updated_at = ? WHERE turn_item_id = 'it-q'").run(ago(1));
    db.close();
    const events = await collect(backfillT3(testCtx().ctx));
    assert.equal(waitOf(events, "codex-ask-not-on-disk"), undefined);
    assert.equal(waitOf(events, "grok-q"), undefined);
    assert.equal(events.filter((e) => e.payload.type === "request_resolved").length, 2);
  });

  it("work --json shows the thread blocked on you, and not once T3 resolves the request", () => {
    requestStore();
    const cliEnv = { ...process.env, USERPROFILE: env.home, T3CODE_HOME: join(env.home, ".t3"), CODING_SH_NO_UPDATE_CHECK: "1", CODING_SH_NO_AUTO_INGEST: "1", NO_COLOR: "1" };
    const work = () => {
      const r = spawnSync(process.execPath, ["--no-warnings", CLI, "work", "--json", "--fresh", "--all"], { env: cliEnv, encoding: "utf8", timeout: 120_000 });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout) as { counts: Record<string, number>; noPromptSignal?: string[]; items: { sessionId: string; bucket?: string; waiting?: { kind: string; text?: string } }[] };
    };
    const first = work();
    const item = (id: string, q = first) => q.items.find((i) => i.sessionId === id);
    assert.equal(first.counts.blocked, 2);
    assert.equal(item("codex-ask-not-on-disk")?.bucket, "blocked");
    const ask = item("codex-ask-not-on-disk")?.waiting;
    assert.deepEqual([ask?.kind, ask?.text], ["permission", "Run npm publish"]);
    assert.equal(item("grok-q")?.waiting?.kind, "question");
    assert.deepEqual(first.noPromptSignal ?? [], [], "T3 Code reports its prompts");
    // T3 resolves the approval: only its runtime request row changes (status and resolved_at).
    const db = new DatabaseSync(storePath());
    db.prepare("UPDATE orchestration_v2_projection_runtime_requests SET status = 'resolved', resolved_at = ? WHERE runtime_request_id = 'req-ask'").run(ago(0));
    db.close();
    const later = new Date(Date.now() + 2000);
    utimesSync(storePath(), later, later);
    const second = work();
    assert.equal(second.counts.blocked, 1);
    assert.notEqual(item("codex-ask-not-on-disk", second)?.bucket, "blocked");
    assert.equal(item("grok-q", second)?.bucket, "blocked");
  });
});

describe("T3 store copies", () => {
  let env: TmpEnv;
  const saved: Record<string, string | undefined> = {};
  const TMP = ["TMPDIR", "TEMP", "TMP"];
  let tmp: string;
  before(() => {
    env = tmpEnv();
    for (const k of [...t3Env, ...TMP]) (saved[k] = process.env[k]), delete process.env[k];
    tmp = join(env.root, "tmp");
    mkdirSync(tmp);
    for (const k of TMP) process.env[k] = tmp;
    buildStore(env.home);
  });
  after(() => {
    for (const k of [...t3Env, ...TMP]) if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
    env.restore();
  });
  const copies = () => readdirSync(tmp).filter((n) => n.startsWith(SQLITE_COPY_PREFIX));
  const run = (index = new MemoryIndexStore()) => {
    const cenv = { ...process.env };
    return backfill({ config: defaultConfig(cenv), index, blobs: new MemoryBlobStore(), adapters: [t3code], env: cenv });
  };

  it("removes a copy a killed import left, even when the store is unchanged", async () => {
    const index = new MemoryIndexStore();
    const first = await run(index);
    assert.deepEqual(first.errors, []);
    assert.ok(first.events > 0);
    assert.deepEqual(copies(), [], "its own copy is removed when the import ends");
    // A read's tail child killed at its deadline mid-copy: the copy and its owner file, the owner gone.
    const dead = Number(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout);
    const left = join(tmp, `${SQLITE_COPY_PREFIX}killed`);
    mkdirSync(left);
    writeFileSync(join(left, SQLITE_COPY_OWNER), String(dead));
    writeFileSync(join(left, "statev2.sqlite"), "partial copy");
    const again = await run(index);
    assert.equal(again.events, 0, "the store is unchanged");
    assert.deepEqual(copies(), []);
  });

  it("a store it can't copy is a backfill error, not an import of nothing", async () => {
    // A -wal that can't be copied (a directory), as a full temp volume can't take a 1.7 GB store.
    const wal = join(env.home, ".t3", "userdata", "statev2.sqlite-wal");
    mkdirSync(wal);
    try {
      const r = await run();
      assert.equal(r.events, 0);
      assert.equal(r.errors.length, 1, JSON.stringify(r.errors));
      assert.match(r.errors[0]!.message, /^t3code\.backfill failed: T3 Code's store was not read: could not copy .*statev2\.sqlite/);
      assert.match(r.errors[0]!.message, /temp directory/);
      assert.match(r.agents.find((a) => a.agent === "t3code")?.error ?? "", /could not copy/);
      assert.deepEqual(copies(), []);
    } finally {
      rmSync(wal, { recursive: true, force: true });
    }
  });

  it("threads a pass out of time left are read by the next pass, though T3 Code wrote nothing since", async () => {
    const full = await run();
    assert.deepEqual(full.errors, []);
    const index = new MemoryIndexStore();
    const cenv = { ...process.env };
    const late = () => backfill({ config: defaultConfig(cenv), index, blobs: new MemoryBlobStore(), adapters: [t3code], env: cenv, deadline: Date.now() - 1 });
    const first = await late();
    assert.deepEqual(first.errors, []);
    assert.ok(first.pendingFiles > 0 && first.events < full.events, `${first.events} of ${full.events} events, ${first.pendingFiles} pending`);
    const rest = await run(index);
    assert.deepEqual([rest.errors, rest.pendingFiles], [[], 0]);
    assert.equal(first.events + rest.events, full.events);
    // Every thread read: the store's fingerprint stands for them, so a pass out of time has nothing left to do.
    const idle = await late();
    assert.deepEqual([idle.events, idle.pendingFiles, idle.errors], [0, 0, []]);
  });
});

describe("T3 provider instances", () => {
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

  it("maps an instance id to the agent whose driver kind it starts with, else keeps it", () => {
    const cases: [string, string][] = [
      ["claudeAgent", "claude-code"], ["codex", "codex"], ["claudeHub", "claude-code"], ["ClaudeWork", "claude-code"], ["codex-personal", "codex"],
      ["cursorTeam", "cursor"], ["opencode_2", "opencode"], ["piLocal", "pi"], ["grok", "grok"], ["muse", "muse"], ["toString", "toString"],
    ];
    for (const [id, agent] of cases) assert.equal(providerAgent(id), agent, id);
  });

  it("a v2 thread whose driver is an instance id (claudeHub) is a Claude Code session, with its prompt", async () => {
    const dir = join(env.home, ".t3", "userdata");
    mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(join(dir, "statev2.sqlite"));
    db.exec(V2_SCHEMA);
    db.prepare("INSERT INTO projection_projects VALUES ('proj-1', 'demo', '/work/demo', '[]', ?, ?, NULL, NULL)").run(T(0), T(0));
    thread(db, "thr-hub", { provider: "claudeHub", title: "Add sum", created: T(0) });
    providerThread(db, "pt-hub", "thr-hub", "claudeHub", "hub-session-not-on-disk", 1);
    db.prepare("INSERT INTO orchestration_v2_projection_messages VALUES ('m-hub', 'thr-hub', NULL, 'node-1', 'user', 0, ?, ?, ?)").run(T(1), T(1), J({ text: "add a sum function" }));
    db.close();
    const cenv = { ...process.env };
    const index = new MemoryIndexStore();
    const r = await backfill({ config: defaultConfig(cenv), index, blobs: new MemoryBlobStore(), adapters: [t3code], env: cenv });
    assert.deepEqual(r.errors, []);
    const s = await index.getSession("hub-session-not-on-disk");
    assert.equal(s?.agent, "claude-code");
    assert.equal(s?.host, "t3code");
    assert.equal(s?.provider, "claude-code");
    assert.equal((await index.listEvents("hub-session-not-on-disk", { kinds: ["user.message"] })).length, 1);
  });
});

describe("T3 prompts an agent made, and threads a person started", () => {
  // A v2 message says who made it: createdBy "user" for the person; createdBy "agent", a
  // creationSource (provider, mcp, server) or a field only an agent's message carries
  // (senderThreadId, notification, delegatedCompletion, workflowScript) for an agent.
  let env: TmpEnv;
  const saved: Record<string, string | undefined> = {};
  let events: AgentEvent[];
  before(async () => {
    env = tmpEnv();
    for (const k of t3Env) (saved[k] = process.env[k]), delete process.env[k];
    const dir = join(env.home, ".t3", "userdata");
    mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(join(dir, "statev2.sqlite"));
    db.exec(V2_SCHEMA);
    db.prepare("INSERT INTO projection_projects VALUES ('proj-1', 'demo', '/work/demo', '[]', ?, ?, NULL, NULL)").run(T(0), T(0));
    const msg = db.prepare("INSERT INTO orchestration_v2_projection_messages VALUES (?, ?, NULL, 'node-1', ?, 0, ?, ?, ?)");
    const turn = db.prepare("INSERT INTO orchestration_v2_projection_provider_turns VALUES (?, ?, ?, 'node-1', NULL, ?, 'completed', ?, ?, ?)");
    // A thread a person started: their prompts (one sent while a turn ran), prompts agents made, and a secret request.
    thread(db, "thr-person", { provider: "grok", title: "Fix the flaky test", created: T(1) });
    providerThread(db, "pt-person", "thr-person", "grok", "grok-person", 1);
    const said = (id: string, at: string, role: string, payload: Record<string, unknown>) => msg.run(id, "thr-person", role, at, at, J(payload));
    said("m1", T(1), "user", { text: "Fix the flaky test", createdBy: "user" });
    said("m2", T(1, 20), "assistant", { text: "Fixed: the test waited on a timer." });
    said("m3", T(3), "user", { text: "Review the diff on the other branch", senderThreadId: "thr-other" });
    said("m4", T(3, 10), "assistant", { text: "The diff looks right." });
    said("m5", T(6), "user", { text: "Now run the whole suite", createdBy: "user" });
    said("m10", T(6, 10), "user", { text: "and the linter", createdBy: "user" });
    said("m6", T(7), "user", { text: "Background task finished", notification: { kind: "task" } });
    said("m7", T(7, 30), "user", { text: "The other thread finished the review.", delegatedCompletion: { taskId: "t1" } });
    said("m8", T(8), "user", { text: "Opened the pull request", creationSource: "mcp" });
    said("m9", T(9), "user", { text: "Continue with the next step", createdBy: "agent" });
    turn.run("tu1", "thr-person", "pt-person", 1, T(1), T(1, 30), J({ status: "completed" }));
    turn.run("tu2", "thr-person", "pt-person", 2, T(3), T(3, 30), J({ status: "completed" }));
    turn.run("tu3", "thr-person", "pt-person", 3, T(6), T(6, 30), J({ status: "completed" }));
    db.prepare("INSERT INTO orchestration_v2_projection_runtime_requests VALUES ('req-secret', 'thr-person', 'node-1', 'tu2', 'secret', 'resolved', ?, ?, ?)").run(T(3, 5), T(3, 25), J({ id: "req-secret", kind: "secret", status: "resolved" }));
    // A subagent's thread, even one whose first prompt says the person made it, and a thread that does not say.
    thread(db, "thr-person-sub", { provider: "grok", title: "Find the flaky test", created: T(4), payload: { lineage: { parentThreadId: "thr-person", relationshipToParent: "subagent", rootThreadId: "thr-person" } } });
    providerThread(db, "pt-person-sub", "thr-person-sub", "grok", "grok-person-sub", 1);
    msg.run("ms1", "thr-person-sub", "user", T(4), T(4), J({ text: "Find the flaky test", createdBy: "user" }));
    thread(db, "thr-unknown", { provider: "grok", title: "List files", created: T(2) });
    providerThread(db, "pt-unknown", "thr-unknown", "grok", "grok-unknown", 1);
    msg.run("mu1", "thr-unknown", "user", T(2), T(2), J({ text: "List the files" }));
    // A thread with the other ways a message says an agent made it: a provider's own prompt, T3's server, a
    // workflow step. A field set to null (as a store writes one it leaves empty) says nothing.
    thread(db, "thr-sources", { provider: "grok", title: "Ship the release", created: T(10) });
    providerThread(db, "pt-sources", "thr-sources", "grok", "grok-sources", 1);
    const sent = (id: string, at: string, payload: Record<string, unknown>) => msg.run(id, "thr-sources", "user", at, at, J(payload));
    sent("src1", T(10), { text: "Ship the release", createdBy: "user" });
    sent("src2", T(11), { text: "Check the release notes", creationSource: "provider" });
    sent("src3", T(12), { text: "The release job started", creationSource: "server" });
    sent("src4", T(13), { text: "Tag the release", workflowScript: { name: "release" } });
    sent("src5", T(14), { text: "Publish it", createdBy: "user", workflowScript: null, senderThreadId: null });
    db.close();
    events = await collect(backfillT3(testCtx().ctx));
  });
  after(() => {
    for (const k of t3Env) if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
    env.restore();
  });

  it("marks a prompt an agent made from: agent, and none of the person's", () => {
    assertWellFormed(events);
    const prompts = events.filter((e) => e.sessionId === "grok-person" && e.kind === "user.message").sort((a, b) => a.ts - b.ts);
    assert.deepEqual(
      prompts.map((e) => [e.payload.text, e.payload.from]),
      [
        ["Fix the flaky test", undefined],
        ["Review the diff on the other branch", "agent"],
        ["Now run the whole suite", undefined],
        ["and the linter", undefined],
        ["Background task finished", "agent"],
        ["The other thread finished the review.", "agent"],
        ["Opened the pull request", "agent"],
        ["Continue with the next step", "agent"],
      ],
    );
  });

  it("a provider's prompt, T3's server prompt and a workflow step are an agent's; a field set to null is not", () => {
    const prompts = events.filter((e) => e.sessionId === "grok-sources" && e.kind === "user.message").sort((a, b) => a.ts - b.ts);
    assert.deepEqual(
      prompts.map((e) => [e.payload.text, e.payload.from]),
      [
        ["Ship the release", undefined],
        ["Check the release notes", "agent"],
        ["The release job started", "agent"],
        ["Tag the release", "agent"],
        ["Publish it", undefined],
      ],
    );
  });

  it("a thread a person started is launched interactively; a subagent's thread and one that does not say have no launch", () => {
    const link = (id: string) => events.find((e) => e.sessionId === id && e.payload.type === "host-link");
    const launch = (id: string) => buildSession(events.filter((e) => e.sessionId === id)).stats.launch;
    assert.equal(link("grok-person")?.payload.launch, "interactive");
    assert.equal(launch("grok-person"), "interactive");
    for (const id of ["grok-person-sub", "grok-unknown"]) {
      assert.ok(link(id), id);
      assert.equal(link(id)?.payload.launch, undefined, id);
      assert.equal(launch(id), undefined, id);
    }
  });

  it("stats.waits counts the turn waits the person ended apart from the ones an agent's prompt ended, the steer and the secret request", async () => {
    const cenv = { ...process.env };
    const index = new MemoryIndexStore();
    const r = await backfill({ config: defaultConfig(cenv), index, blobs: new MemoryBlobStore(), adapters: [t3code], env: cenv });
    assert.deepEqual(r.errors, []);
    const s = await index.getSession("grok-person");
    assert.equal(s?.stats.launch, "interactive");
    // Turn waits: 10:01:30 to 10:03 (another thread's message ended it), 10:03:30 to 10:06 (the person),
    // 10:06:30 to 10:07 (a notification). The secret request: 10:03:05 to 10:03:25. The median of
    // the two waits is the lower one, by nearest rank.
    assert.deepEqual(s?.stats.waits, {
      count: 2,
      ms: 170_000,
      medianMs: 20_000,
      byKind: { request: { count: 1, ms: 20_000 }, turn: { count: 1, ms: 150_000 } },
      agent: { count: 2, ms: 120_000 },
      steers: 1,
    });
    // A thread that does not say who started it counts no turn waits.
    assert.equal((await index.getSession("grok-unknown"))?.stats.waits, undefined);
  });
});

describe("T3 prompts an agent made, in a thread read from its Codex or Claude transcript", () => {
  // The transcript does not say who made a prompt; T3's store does. Each thread: the person's
  // prompt and a turn, another thread's message after the turn ended, a notification while the
  // next turn ran, then the person's prompt again.
  const CX = "0193cccc-1111-7222-8333-444455556666";
  const CL = "22222222-3333-4444-8555-666666666666";
  const OC = "ses_0a1b2c3d4e5f60718293a4b5c6";
  const base = Date.parse(T(0));
  const at = (ms: number) => new Date(base + ms).toISOString();
  let env: TmpEnv;
  const saved: Record<string, string | undefined> = {};

  /** A Codex rollout as T3 Code's app-server writes it: item_completed prompts and replies. */
  function rollout(): string {
    const lines: [number, string, Record<string, unknown>][] = [];
    const item = (ms: number, turn: string, id: string, type: "UserMessage" | "AgentMessage", text: string) =>
      lines.push([ms, "event_msg", { type: "item_completed", thread_id: CX, turn_id: turn, item: type === "UserMessage" ? { type, id, content: [{ type: "text", text, text_elements: [] }] } : { type, id, content: [{ type: "Text", text }], phase: "final_answer" }, started_at_ms: base + ms, completed_at_ms: base + ms }]);
    const turn = (id: string, start: number, end: number, body: () => void) => {
      lines.push([start - 1, "turn_context", { turn_id: id, cwd: "/work/demo", model: "gpt-5.5" }]);
      lines.push([start, "event_msg", { type: "task_started", turn_id: id }]);
      body();
      lines.push([end, "event_msg", { type: "task_complete", turn_id: id, last_agent_message: "Done", duration_ms: end - start }]);
    };
    lines.push([0, "session_meta", { id: CX, session_id: CX, timestamp: at(0), cwd: "/work/demo", originator: "T3 Code", cli_version: "0.166.0", model_provider: "openai" }]);
    turn("t1", 100, 60_000, () => {
      item(500, "t1", "um-1", "UserMessage", "Fix the tests");
      item(30_000, "t1", "am-1", "AgentMessage", "Fixed: the test waited on a timer.");
    });
    turn("t2", 180_100, 300_000, () => {
      item(180_200, "t2", "um-2", "UserMessage", "Review the diff on the other branch");
      item(200_000, "t2", "am-2", "AgentMessage", "The diff looks right.");
      item(240_100, "t2", "um-3", "UserMessage", "Background task finished");
      item(250_000, "t2", "am-3", "AgentMessage", "Noted.");
    });
    turn("t3", 480_200, 540_000, () => {
      item(480_300, "t3", "um-4", "UserMessage", "Now run the whole suite");
      item(500_000, "t3", "am-4", "AgentMessage", "All 6 tests pass.");
    });
    return lines.map(([ms, type, payload], ordinal) => J({ timestamp: at(ms), type, payload, ordinal })).join("\n") + "\n";
  }

  /** A Claude transcript as T3 Code's Agent SDK run writes it (entrypoint sdk-ts). */
  function transcript(): string {
    const head = { sessionId: CL, cwd: "/work/demo", version: "2.1.300", gitBranch: "main", userType: "external", entrypoint: "sdk-ts" };
    const lines: Record<string, unknown>[] = [];
    let n = 0;
    const user = (ms: number, text: string) => {
      n++;
      lines.push({ ...head, type: "user", uuid: `u${n}`, parentUuid: null, timestamp: at(ms), message: { role: "user", content: text }, promptId: `p${n}` });
    };
    const reply = (ms: number, text: string) => {
      n++;
      lines.push({ ...head, type: "assistant", uuid: `a${n}`, parentUuid: null, timestamp: at(ms), requestId: `req_${n}`, message: { id: `msg_${n}`, type: "message", role: "assistant", model: "claude-opus-4-5", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
    };
    const ended = (ms: number, durationMs: number) => {
      n++;
      lines.push({ ...head, type: "system", subtype: "turn_duration", uuid: `s${n}`, timestamp: at(ms), durationMs, isMeta: true });
    };
    user(500, "Fix the tests");
    reply(30_000, "Fixed: the test waited on a timer.");
    ended(60_000, 59_500);
    user(180_200, "Review the diff on the other branch");
    reply(200_000, "The diff looks right.");
    user(240_100, "Background task finished");
    reply(250_000, "Noted.");
    ended(300_000, 59_900);
    user(480_300, "Now run the whole suite");
    reply(500_000, "All 6 tests pass.");
    ended(540_000, 59_700);
    return lines.map((l) => J(l)).join("\n") + "\n";
  }

  before(() => {
    env = tmpEnv();
    for (const k of t3Env) (saved[k] = process.env[k]), delete process.env[k];
    const dir = join(env.home, ".t3", "userdata");
    mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(join(dir, "statev2.sqlite"));
    db.exec(V2_SCHEMA);
    db.prepare("INSERT INTO projection_projects VALUES ('proj-1', 'demo', '/work/demo', '[]', ?, ?, NULL, NULL)").run(T(0), T(0));
    const msg = db.prepare("INSERT INTO orchestration_v2_projection_messages VALUES (?, ?, NULL, 'node-1', 'user', 0, ?, ?, ?)");
    for (const [th, driver, nativeId] of [["thr-cx", "codex", CX], ["thr-cl", "claudeAgent", CL]] as const) {
      thread(db, th, { provider: driver, title: "Fix the tests", created: T(0) });
      providerThread(db, `pt-${th}`, th, driver, nativeId, 1);
      const said = (id: string, when: string, payload: Record<string, unknown>) => msg.run(`${th}-${id}`, th, when, when, J(payload));
      said("m1", T(0), { text: "Fix the tests", createdBy: "user" });
      said("m2", T(3), { text: "Review the diff on the other branch", senderThreadId: "thr-other" });
      said("m3", T(4), { text: "Background task finished", notification: { kind: "task" } });
      said("m4", T(8), { text: "Now run the whole suite", createdBy: "user" });
    }
    // A thread a person started whose session OpenCode's own adapter imports: its prompts are not read here.
    thread(db, "thr-oc", { provider: "opencode", title: "create hello.txt", created: T(0) });
    providerThread(db, "pt-oc", "thr-oc", "opencode", OC, 1);
    msg.run("thr-oc-m1", "thr-oc", T(0), T(0), J({ text: "create hello.txt", createdBy: "user" }));
    db.close();
    writeFile(join(env.home, ".codex", `sessions/2026/11/01/rollout-2026-11-01T10-00-00-${CX}.jsonl`), rollout());
    writeFile(join(env.home, ".claude", "projects", "-work-demo", `${CL}.jsonl`), transcript());
    const ocDir = join(env.home, ".local", "share", "opencode");
    mkdirSync(ocDir, { recursive: true });
    const oc = new DatabaseSync(join(ocDir, "opencode.db"));
    oc.exec("CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, time_created INTEGER, time_updated INTEGER)");
    oc.prepare("INSERT INTO session VALUES (?, '/work/demo', 0, 0)").run(OC);
    oc.close();
  });
  after(() => {
    for (const k of t3Env) if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
    env.restore();
  });

  async function run(adapters: Adapter[]) {
    const cenv = { ...process.env };
    const index = new MemoryIndexStore();
    const r = await backfill({ config: defaultConfig(cenv), index, blobs: new MemoryBlobStore(), adapters, env: cenv });
    assert.deepEqual(r.errors, []);
    return index;
  }

  for (const adapters of [[t3code], [codex, claudeCode, t3code]]) {
    const names = adapters.map((a) => a.id).join(", ");
    it(`${names}: an agent's prompt after a turn ended or while one ran ends no wait of the person's and is no steer; the person's next prompt ends one`, async () => {
      const index = await run(adapters);
      // Codex: a turn wait from 10:01:00 to the other thread's message at 10:03:00.2 (an agent's), the
      // notification inside the next turn (no steer), then 10:05:00 to the person's prompt at 10:08:00.3.
      assert.deepEqual((await index.getSession(CX))?.stats.waits, { count: 1, ms: 180_300, byKind: { turn: { count: 1, ms: 180_300 } }, agent: { count: 1, ms: 120_200 } });
      // Claude: the transcript writes no end for the turn the notification came in; the end it gets is
      // stamped at the notification's prompt, so no wait comes between them, and the numbers are Codex's.
      assert.deepEqual((await index.getSession(CL))?.stats.waits, { count: 1, ms: 180_300, byKind: { turn: { count: 1, ms: 180_300 } }, agent: { count: 1, ms: 120_200 } });
      for (const id of [CX, CL]) {
        const events = await index.listEvents(id);
        const prompts = events.filter((e) => e.kind === "user.message");
        const marks = events.filter((e) => e.kind === "notification" && e.payload.type === "agent_prompt");
        assert.deepEqual(marks.map((m) => prompts.find((p) => p.id === m.payload.promptId)?.payload.text), ["Review the diff on the other branch", "Background task finished"], id);
        assert.equal((await index.getSession(id))?.stats.launch, "interactive", id);
      }
    });
  }

  it("the host's markers show in no timeline: show, the MCP timeline, the viewer's rows and turns, and the session page's steps", async () => {
    const index = await run([t3code]);
    const html = readFileSync(fileURLToPath(new URL("../../src/viewer/ui/index.html", import.meta.url)), "utf8");
    // The session page's step builder, with the call-copy fold it runs, as the page runs it.
    const buildTimeline: (events: AgentEvent[]) => { id: string }[] = runInNewContext(`${html.slice(html.indexOf("function callCopies("), html.indexOf("function itemView("))}\nbuildTimeline`, {});
    const said = "Review the diff on the other branch";
    const sessions: Session[] = [];
    const all: AgentEvent[] = [];
    for (const id of [CX, CL]) {
      const s = (await index.getSession(id))!;
      const events = await index.listEvents(id);
      sessions.push(s);
      all.push(...events);
      const marks = new Set(events.filter((e) => e.kind === "notification" && e.payload.type === "agent_prompt").map((e) => e.id));
      assert.equal(marks.size, 2, id);
      const bare = events.filter((e) => !marks.has(e.id));
      const prompt = events.find((e) => e.kind === "user.message" && e.payload.text === said)!;
      // MCP: the timeline is the one the events make without the markers.
      const lines = timeline(events, s.startedAt);
      assert.ok(lines.some((l) => l.text.includes(said)), id);
      assert.deepEqual(lines, timeline(bare, s.startedAt), id);
      // The viewer's rows (unfolded, every turn): no marker's row, the prompt's row kept.
      const m = buildModel(events);
      const rows: Row[] = [];
      for (const t of m.turns) rows.push(...(await readRows(index, id, m, layoutRows(m, t, t.start, 1000, false).slots)));
      const ids = rows.flatMap((r) => ("id" in r ? [r.id] : []));
      assert.ok(ids.includes(prompt.id), id);
      assert.deepEqual(ids.filter((x) => marks.has(x)), [], id);
      assert.equal(ids.length, bare.length, id);
      // A turn ends at its own last event, not at the marker stamped before the next turn's prompt.
      assert.deepEqual(m.turns.map((t) => t.endTs), buildModel(bare).turns.map((t) => t.endTs), id);
      // The session page's steps.
      const steps = Array.from(buildTimeline(events), (it) => it.id);
      assert.ok(steps.includes(prompt.id), id);
      assert.deepEqual(steps.filter((x) => marks.has(x)), [], id);
      assert.deepEqual(steps, Array.from(buildTimeline(bare), (it) => it.id), id);
    }
    // `coding.sh show`: the prompt's line, no marker's.
    const sb = sandbox();
    try {
      await sb.seed(sessions, all);
      for (const id of [CX, CL]) {
        const r = await runCmd(show, sb, { positionals: [id] });
        assert.equal(r.error, undefined, id);
        assert.match(r.stdout, /Review the diff on the other branch/, id);
        assert.doesNotMatch(r.stdout, /an agent sent the next prompt/, id);
      }
    } finally {
      sb.cleanup();
    }
  });

  it("a thread a person started whose session another adapter imports (OpenCode) has no launch: its agents' prompts are not told apart", async () => {
    const index = await run([t3code]);
    const link = (await index.listEvents(OC, { kinds: ["notification"] })).find((e) => e.payload.type === "host-link");
    assert.ok(link);
    assert.equal(link.payload.launch, undefined);
    assert.equal((await index.getSession(OC))?.stats.launch, undefined);
  });
});
