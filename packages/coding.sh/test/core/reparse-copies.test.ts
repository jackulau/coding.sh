// A store filled by an older Claude Code parse holds a subagent twice: under
// the session that wrote it and under a session that resumed its workflow run
// (a byte copy of the run dir). A re-parse deletes the copy, so its calls and
// cost count once, and still keeps a session whose transcript is really gone.
// Synthetic transcripts under a temp home only.
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { claudeCode } from "../../src/adapters/claude-code.ts";
import type { Adapter, IndexStore } from "../../src/core/types.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { backfill } from "../../src/core/ingest.ts";
import { REPARSE_LAST, pathNamesSession, reparse, reparseKeptKey } from "../../src/core/reparse.ts";
import { MemoryBlobStore } from "../../src/store/memory.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { tmpEnv, writeFile, type TmpEnv } from "../adapters/_helpers.ts";

const A = "aaaaaaaa-0000-4000-8000-00000000000a"; // launched the workflow run: owns agent a1
const B = "bbbbbbbb-0000-4000-8000-00000000000b"; // resumed A's run (resumeFromRunId): a copy of a1, plus its own b1
const D = "dddddddd-0000-4000-8000-00000000000d"; // its own subagent d1, whose transcript is deleted later
const WF = "wf_t0000001-abc";
const T0 = Date.parse("2026-11-01T10:00:00.000Z");
const iso = (dt: number) => new Date(T0 + dt).toISOString();
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const entry = (sid: string, extra: Record<string, unknown>) => ({ parentUuid: null, isSidechain: false, userType: "external", cwd: "/work/demo", sessionId: sid, version: "2.1.300", ...extra });
const user = (sid: string, uuid: string, dt: number, content: unknown, extra: Record<string, unknown> = {}) => entry(sid, { type: "user", uuid, timestamp: iso(dt), message: { role: "user", content }, ...extra });
const asst = (sid: string, uuid: string, dt: number, id: string, content: unknown[], extra: Record<string, unknown> = {}) =>
  entry(sid, { type: "assistant", uuid, timestamp: iso(dt), message: { id, role: "assistant", model: "claude-opus-4-5", content, usage: { input_tokens: 100, output_tokens: 20 } }, ...extra });

let env: TmpEnv;
let index: IndexStore;
beforeEach(async () => {
  env = tmpEnv();
  process.env.CLAUDE_CONFIG_DIR = join(env.root, "claude");
  index = await SqliteIndexStore.open(join(env.root, "index.db"));
});
afterEach(async () => {
  await index.close();
  env.restore();
});
const project = () => join(env.root, "claude", "projects", "-work-demo");
const runDir = (sid: string) => join(project(), sid, "subagents", "workflows", WF);

/** A main transcript; with `input`, a Workflow call whose result names `<sid>`'s run dir. */
function main(sid: string, dt: number, input?: Record<string, unknown>): void {
  const tool = `toolu_wf_${sid.slice(0, 4)}`;
  const rows: unknown[] = [user(sid, `${sid}-u1`, dt, "run the workflow", { promptId: `${sid}-p1` })];
  if (input) {
    rows.push(
      asst(sid, `${sid}-a1`, dt + 1000, `msg_${sid.slice(0, 4)}_1`, [{ type: "tool_use", id: tool, name: "Workflow", input }]),
      user(sid, `${sid}-u2`, dt + 1500, [{ type: "tool_result", tool_use_id: tool, content: `Workflow launched in background. Task ID: t1\nTranscript dir: ${runDir(sid)}\nScript file: /work/demo/wf.js` }]),
    );
  }
  rows.push(asst(sid, `${sid}-a2`, dt + 90_000, `msg_${sid.slice(0, 4)}_2`, [{ type: "text", text: "done" }]));
  writeFile(join(project(), `${sid}.jsonl`), jsonl(rows));
}

function agentLines(writer: string, agentId: string, dt: number, calls: number): unknown[] {
  const rows: unknown[] = [user(writer, `${agentId}-u0`, dt, `task for ${agentId}`, { isSidechain: true, agentId })];
  for (let i = 1; i <= calls; i++) rows.push(asst(writer, `${agentId}-a${i}`, dt + i * 1000, `msg_${agentId}_${i}`, [{ type: "text", text: `step ${i}` }], { isSidechain: true, agentId }));
  return rows;
}

function buildTree(): void {
  main(A, 0, { scriptPath: "/work/demo/wf.js" });
  writeFile(join(runDir(A), "journal.jsonl"), jsonl([{ type: "launched" }, { type: "started", key: "k1", agentId: "a1", label: "build:1", phase: "Build" }, { type: "result", key: "k1", agentId: "a1", result: { ok: true } }]));
  writeFile(join(runDir(A), "agent-a1.meta.json"), JSON.stringify({ agentType: "workflow-subagent", description: "build:1", workflowPhase: "Build" }));
  writeFile(join(runDir(A), "agent-a1.jsonl"), jsonl(agentLines(A, "a1", 2000, 3)));

  main(B, 200_000, { scriptPath: "/work/demo/wf.js", resumeFromRunId: WF });
  mkdirSync(runDir(B), { recursive: true });
  for (const name of readdirSync(runDir(A))) copyFileSync(join(runDir(A), name), join(runDir(B), name));
  writeFile(join(runDir(B), "agent-b1.jsonl"), jsonl(agentLines(B, "b1", 202_000, 2)));

  main(D, 400_000);
  writeFile(join(project(), D, "subagents", "agent-d1.jsonl"), jsonl(agentLines(D, "d1", 401_000, 2)));
}

const opts = () => ({ config: defaultConfig(process.env), index, blobs: new MemoryBlobStore(), env: process.env });
/** The parse before AM-8 stored a copy whose owner's file it could not see: A's run dir is hidden for the first import. */
async function storeWithCopy(): Promise<void> {
  const old: Adapter = { ...claudeCode, parseVersion: 12 };
  const hidden = join(env.root, "hidden-run");
  renameSync(runDir(A), hidden);
  await backfill({ ...opts(), adapters: [old] });
  renameSync(hidden, runDir(A));
  await backfill({ ...opts(), adapters: [old] });
}
const subSessions = async () => (await index.listSessions({})).map((s) => s.id).filter((id) => id.includes(":sub:")).sort();
const messageIds = async () => {
  const ids: string[] = [];
  for (const s of await index.listSessions({})) for (const e of await index.listEvents(s.id, { kinds: ["llm.call"] })) ids.push(e.payload.messageId as string);
  return ids;
};

describe("reparse: sessions the adapter now reports as copies of another session", () => {
  it("deletes the copy, keeps the owner's subagent, and keeps a session whose transcript is gone", async () => {
    buildTree();
    await storeWithCopy();
    assert.deepEqual(await subSessions(), [`${A}:sub:a1`, `${B}:sub:a1`, `${B}:sub:b1`, `${D}:sub:d1`], "the old parse stored a1 twice");
    const before = await messageIds();
    assert.equal(before.filter((id) => id.startsWith("msg_a1_")).length, 6);
    rmSync(join(project(), D, "subagents"), { recursive: true }); // d1's transcript is gone (not a copy)

    const r = await reparse({ ...opts(), adapters: new Map([["claude-code", claudeCode]]) });
    assert.deepEqual(r.errors, []);
    assert.equal(r.copiesRemoved, 1);
    assert.deepEqual(await subSessions(), [`${A}:sub:a1`, `${B}:sub:b1`, `${D}:sub:d1`]);
    assert.equal(await index.getSession(`${B}:sub:a1`), undefined);
    assert.deepEqual(await index.listEvents(`${B}:sub:a1`), []);
    assert.equal(await index.kvGet!(reparseKeptKey(`${B}:sub:a1`)), undefined);
    const ids = await messageIds();
    assert.equal(new Set(ids).size, ids.length, "each llm.call message id once");
    assert.equal(ids.filter((id) => id.startsWith("msg_a1_")).length, 3);
    assert.equal((await index.getSession(`${A}:sub:a1`))!.parseVersion, claudeCode.parseVersion);
    assert.equal(r.keptSessions.length, 1);
    assert.deepEqual([r.keptSessions[0]!.id, r.keptSessions[0]!.reason], [`${D}:sub:d1`, "its transcript is gone"]);
    assert.equal((await index.listEvents(`${D}:sub:d1`, { kinds: ["llm.call"] })).length, 2, "a gone transcript's rows stay");
    assert.equal(JSON.parse((await index.kvGet!(REPARSE_LAST))!).copiesRemoved, 1);

    const again = await reparse({ ...opts(), adapters: new Map([["claude-code", claudeCode]]), all: true });
    assert.deepEqual([again.copiesRemoved, again.errors], [0, []]);
    assert.deepEqual(await subSessions(), [`${A}:sub:a1`, `${B}:sub:b1`, `${D}:sub:d1`]);
  });

  it("keeps a copy whose owner is not in the index", async () => {
    buildTree();
    await storeWithCopy();
    await index.deleteSessions!([`${A}:sub:a1`]);
    const r = await reparse({ ...opts(), adapters: new Map([["claude-code", claudeCode]]) });
    assert.equal(r.copiesRemoved, 0);
    assert.ok(await index.getSession(`${B}:sub:a1`));
    assert.ok(r.keptSessions.some((k) => k.id === `${B}:sub:a1`));
  });

  it("keeps a copy that also has rows from another capture path", async () => {
    buildTree();
    await storeWithCopy();
    await index.putEvents([{ id: "otel-1", v: 0, sessionId: `${B}:sub:a1`, ts: T0 + 3000, agent: "claude-code", kind: "llm.call", source: "otel", payload: { model: "claude-opus-4-5" } }]);
    const r = await reparse({ ...opts(), adapters: new Map([["claude-code", claudeCode]]) });
    assert.equal(r.copiesRemoved, 0);
    assert.ok((await index.listEvents(`${B}:sub:a1`)).some((e) => e.id === "otel-1"));
  });
});

describe("reparse: reads only the transcripts of the sessions it rebuilds", () => {
  const spy = (read: string[]): Adapter => ({
    ...claudeCode,
    async *backfill(ctx, o) {
      yield* claudeCode.backfill!(ctx, { ...o, changed: async (f) => (await o!.changed!(f)) && (read.push(f.path), true) });
    },
  });

  it("skips the files of sessions that are not stale", async () => {
    buildTree();
    // 30 other sessions the re-parse has no reason to open (a long-used machine has tens of thousands).
    for (let i = 0; i < 30; i++) main(`0000000${i.toString(16).padStart(1, "0")}-0000-4000-8000-${String(i).padStart(12, "0")}`, 600_000 + i * 1000);
    const old: Adapter = { ...claudeCode, parseVersion: 12 };
    await backfill({ ...opts(), adapters: [old] });
    // Only B and its subagents were stored by an older parse than the adapter's.
    for (const s of await index.listSessions({})) if (!s.id.startsWith(B)) await index.upsertSession({ ...s, parseVersion: claudeCode.parseVersion });
    const read: string[] = [];
    const r = await reparse({ ...opts(), adapters: new Map([["claude-code", spy(read)]]) });
    assert.deepEqual(r.errors, []);
    assert.ok(r.reparsed >= 1, "B was rebuilt");
    assert.ok(read.length >= 1 && read.length <= 4, `read ${read.length} of 33+ transcripts: ${read.join(", ")}`);
    assert.ok(read.every((p) => p.includes(B)), "only files under B's id");
  });

  it("matches a path by session id, and a child session by its parent's id", () => {
    const names = pathNamesSession([`${A}:sub:a1`, "plain-id"]);
    assert.equal(names(join("x", "projects", "p", `${A}.jsonl`)), true);
    assert.equal(names(join("x", "p", A.toUpperCase(), "subagents", "agent-a1.jsonl")), true);
    assert.equal(names(join("x", "sessions", `rollout-2026-11-01T10-00-00-${B}.jsonl`)), false);
    assert.equal(names(join("x", "plain-id.jsonl")), true);
    assert.equal(pathNamesSession([`t3code-thread:${"x".repeat(200)}`])("anything.jsonl"), false, "a long foreign id is not matched as text");
  });
});

describe("reparse: a store adapter's covered threads", () => {
  // A T3-style adapter: its backfill skips a thread whose run a transcript adapter stores, and says so with copied().
  const covered = "t3code-thread-covered";
  const store = (): Adapter => ({
    ...claudeCode,
    id: "t3code",
    parseVersion: 8,
    async *backfill(_ctx, o) {
      if (o?.changed && !(await o.changed({ path: "state.sqlite#store", size: 1, mtimeMs: 1 }))) return;
      o?.copied?.(covered, `${A}:sub:a1`);
    },
  });
  const seedStore = async (extra: Record<string, unknown> = {}) => {
    buildTree();
    await backfill({ ...opts(), adapters: [{ ...claudeCode, parseVersion: 12 }] });
    await index.putEvents([{ id: "t3-1", v: 0, sessionId: covered, ts: T0 + 3000, agent: "t3code", kind: "session.start", source: "store", payload: {}, ...extra }]);
    await index.upsertSession({ id: covered, agent: "t3code", startedAt: T0 + 3000, parseVersion: 7, stats: {}, flags: [] } as never);
  };

  for (const mode of ["rebuild --agent t3code", "automatic"] as const) {
    it(`deletes the thread session the adapter now skips as covered (${mode})`, async () => {
      await seedStore();
      const adapters = new Map<string, Adapter>([["claude-code", claudeCode], ["t3code", store()]]);
      const rebuild = mode === "automatic" ? {} : { all: true, agents: ["t3code"] };
      const r = await reparse({ ...opts(), adapters, ...rebuild });
      assert.deepEqual(r.errors, []);
      assert.equal(r.copiesRemoved, 1);
      assert.equal(await index.getSession(covered), undefined);
      assert.deepEqual(await index.listEvents(covered), []);
      assert.ok(await index.getSession(`${A}:sub:a1`), "the owner stays");
      assert.ok(!r.keptSessions.some((k) => k.id === covered));
    });
  }
});
