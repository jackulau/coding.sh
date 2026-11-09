// Cross-harness child sessions (TB-7): an agent started from another agent's
// shell tool is linked to that session as a child of type "harness", from the
// env markers the hook records (spawnedBy) or, without them, from the
// parent's shell call that ran the child's CLI while the child started.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { AgentEvent, EventKind, Session } from "../../src/schema/index.ts";
import type { Adapter, SpoolLine } from "../../src/core/types.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { ingest } from "../../src/core/ingest.ts";
import { linkSpawned, spawnedByFromEnv } from "../../src/spool/spawned.ts";
import { MAX_OPEN_MS, matchSpawnedParent, runsAgentCli } from "../../src/spool/spawned-match.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";

const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

describe("spawnedByFromEnv", () => {
  it("reads Claude Code's and Codex's session ids, Codex's call id, and nothing in an eval run or for unsafe ids", () => {
    assert.equal(spawnedByFromEnv({}), undefined);
    assert.deepEqual(spawnedByFromEnv({ CLAUDE_CODE_SESSION_ID: "c-1", CODEX_THREAD_ID: "t-1", CODEX_TOOL_CALL_ID: "call_1" }), [
      { agent: "claude-code", session: "c-1" },
      { agent: "codex", session: "t-1", toolCallId: "call_1" },
    ]);
    assert.deepEqual(spawnedByFromEnv({ CODEX_THREAD_ID: "t-1", CODEX_TOOL_CALL_ID: "bad id" }), [{ agent: "codex", session: "t-1" }]);
    assert.equal(spawnedByFromEnv({ CLAUDE_CODE_SESSION_ID: "c-1", CODING_SH_RUN_ID: "r" }), undefined);
    assert.equal(spawnedByFromEnv({ CLAUDE_CODE_SESSION_ID: 'a"b' }), undefined);
    assert.equal(spawnedByFromEnv({ CLAUDE_CODE_SESSION_ID: "x".repeat(129) }), undefined);
  });
});

describe("linkSpawned", () => {
  it("links to the last marker that is not the session itself or the session it is a subagent of", () => {
    const both = [
      { agent: "claude-code", session: "c-1" },
      { agent: "codex", session: "t-1", toolCallId: "call_1" },
    ] as const;
    assert.deepEqual(linkSpawned([...both], "g-1"), { parentSessionId: "t-1", parentAgent: "codex", subagentType: "harness", parentToolCallId: "call_1" });
    assert.deepEqual(linkSpawned([...both], "t-1"), { parentSessionId: "c-1", parentAgent: "claude-code", subagentType: "harness" }, "Codex's own hooks see its own thread id");
    assert.equal(linkSpawned([{ agent: "claude-code", session: "c-1" }], "c-1"), undefined);
    assert.equal(linkSpawned([{ agent: "claude-code", session: "c-1" }], "c-1:sub:a1"), undefined, "Claude Code's own subagents");
    assert.equal(linkSpawned(undefined, "x"), undefined);
    assert.equal(linkSpawned([{ agent: "codex", session: "" }] as SpoolLine["spawnedBy"], "x"), undefined);
  });
});

describe("runsAgentCli", () => {
  it("matches the agent's CLI where a command starts, not as an argument", () => {
    for (const [cmd, agent] of [
      ["codex exec 'fix the test'", "codex"],
      ["cd /work/demo && codex exec --json hi", "codex"],
      ["npx -y @openai/codex@0.167.0 exec hi", "codex"],
      ["/usr/local/bin/claude -p hi", "claude-code"],
      ['bash -lc "gemini -p hi"', "gemini-cli"],
      ["npx @google/gemini-cli -p hi", "gemini-cli"],
      ["OPENAI_API_KEY=x timeout 600 codex exec hi", "codex"],
      ["echo $(codex exec hi)", "codex"],
    ])
      assert.ok(runsAgentCli(cmd!, agent!), cmd);
    for (const [cmd, agent] of [
      ["grep -r codex src", "codex"],
      ["cat codex.md", "codex"],
      ["ls codex-rs", "codex"],
      ["codexify", "codex"],
      ["echo claude", "claude-code"],
      ["codex exec hi", "unknown-agent"],
    ])
      assert.ok(!runsAgentCli(cmd!, agent!), cmd);
  });
});

/** A session row as the index holds it. */
function session(id: string, agent: string, startedAt: number, o: Partial<Session> = {}): Session {
  return { id, agent, startedAt, cwd: "/work/demo", stats: {}, ...o } as Session;
}
function event(sessionId: string, kind: EventKind, ts: number, payload: Record<string, unknown>, o: Partial<AgentEvent> = {}): AgentEvent {
  return { id: `${sessionId}-${kind}-${ts}`, v: 0, sessionId, ts, agent: "claude-code", kind, payload, ...o };
}
const bash = (command: string, toolUseId: string) => ({ tool: "Bash", toolUseId, input: { command } });

describe("matchSpawnedParent", () => {
  async function store(endTs: number | undefined, command = "codex exec 'fix it'") {
    const index = new MemoryIndexStore();
    await index.upsertSession(session("claude-1", "claude-code", 1_000));
    await index.upsertSession(session("other", "claude-code", 1_500, { cwd: "/elsewhere" }));
    const events = [event("claude-1", "tool.start", 2_000, bash(command, "tu1"))];
    if (endTs !== undefined) events.push(event("claude-1", "tool.end", endTs, { tool: "Bash", toolUseId: "tu1" }));
    events.push(event("other", "tool.start", 2_500, bash(command, "tu2")));
    await index.putEvents(events);
    return index;
  }

  it("links a new session to the shell call that ran its CLI while it started, in the same directory or below", async () => {
    const index = await store(60_000);
    assert.deepEqual(await matchSpawnedParent(index, session("codex-1", "codex", 3_000)), { sessionId: "claude-1", eventId: "claude-1-tool.start-2000", type: "harness" });
    assert.equal((await matchSpawnedParent(index, session("codex-2", "codex", 3_000, { cwd: "/work/demo/pkg" })))?.sessionId, "claude-1");
    assert.equal((await matchSpawnedParent(index, session("codex-3", "codex", 3_000, { cwd: "/elsewhere" })))?.sessionId, "other");
  });

  it("does not link when the times do not overlap, the directory differs, or the command runs another CLI", async () => {
    const index = await store(10_000);
    assert.equal(await matchSpawnedParent(index, session("late", "codex", 10_001)), undefined, "started after the call ended");
    assert.equal(await matchSpawnedParent(index, session("early", "codex", 1_999)), undefined, "started before the call");
    assert.equal(await matchSpawnedParent(index, session("away", "codex", 3_000, { cwd: "/work" })), undefined, "a parent directory of the call's");
    assert.equal(await matchSpawnedParent(index, session("gem", "gemini-cli", 3_000)), undefined);
    assert.equal(await matchSpawnedParent(index, session("run", "codex", 3_000, { runId: "r1" })), undefined, "eval runs are roots");
    assert.equal(await matchSpawnedParent(index, session("linked", "codex", 3_000, { parent: { sessionId: "x" } })), undefined);
  });

  it("a call with no end yet counts for MAX_OPEN_MS", async () => {
    const index = await store(undefined);
    assert.equal((await matchSpawnedParent(index, session("a", "codex", 2_000 + MAX_OPEN_MS)))?.sessionId, "claude-1");
    assert.equal(await matchSpawnedParent(index, session("b", "codex", 2_001 + MAX_OPEN_MS)), undefined);
  });
});

// Ingest, with fake adapters for two agents: raw = { session, kind, ...payload } → one event.
function fake(id: string): Adapter {
  return {
    id,
    displayName: id,
    tier: "A",
    detect: async () => ({ installed: true, hooked: true }),
    install: async () => [],
    uninstall: async () => [],
    async normalize(line, ctx) {
      const { session: sid, kind, ...payload } = line.raw as Record<string, unknown>;
      return [{ id: ctx.id(line.agent, String(sid), line.ts, line.event, 0), v: 0, sessionId: String(sid), ts: line.ts, agent: line.agent, kind: kind as EventKind, cwd: line.cwd, payload }];
    },
  };
}
const adapters = new Map<string, Adapter>([
  ["claude-code", fake("claude-code")],
  ["codex", fake("codex")],
]);

function setup() {
  const root = mkdtempSync(join(tmpdir(), "csh-spawned-"));
  roots.push(root);
  const env = { CODING_SH_HOME: join(root, "home"), HOME: join(root, "user") };
  const write = (agent: string, ts: number, raw: Record<string, unknown>, o: Partial<SpoolLine> = {}) => {
    const dir = join(env.CODING_SH_HOME, "spool", agent);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "2026-11-08.jsonl"), JSON.stringify({ v: 0, agent, event: `${raw.kind}`, ts, pid: 1, cwd: "/work/demo", raw, ...o }) + "\n");
  };
  return { env, config: defaultConfig(env), write };
}
const T = Date.UTC(2026, 10, 8, 10);

describe("ingest links harness children", () => {
  it("from the child's spawnedBy: its session.start names the parent, of type harness", async () => {
    const t = setup();
    t.write("claude-code", T, { session: "claude-1", kind: "session.start" });
    t.write("codex", T + 2_000, { session: "codex-1", kind: "session.start" }, { spawnedBy: [{ agent: "claude-code", session: "claude-1" }] });
    t.write("codex", T + 3_000, { session: "codex-1", kind: "turn.end" }, { spawnedBy: [{ agent: "claude-code", session: "claude-1" }] });
    const index = new MemoryIndexStore();
    await ingest({ config: t.config, index, blobs: new MemoryBlobStore(), adapters, env: t.env, lock: false });
    const child = await index.getSession("codex-1");
    assert.equal(child?.parent?.sessionId, "claude-1");
    assert.equal(child?.parent?.type, "harness");
    assert.equal((await index.getSession("claude-1"))?.parent, undefined);
    const start = (await index.listEvents("codex-1", { kinds: ["session.start"] }))[0]!;
    assert.deepEqual([start.payload.parentSessionId, start.payload.parentAgent, start.payload.subagentType], ["claude-1", "claude-code", "harness"]);
  });

  it("when the child's start was stored earlier without a marker, a later line's marker still links it", async () => {
    const t = setup();
    const root = mkdtempSync(join(tmpdir(), "csh-spawned-db-"));
    roots.push(root);
    const index = await SqliteIndexStore.open(join(root, "idx.db"));
    t.write("claude-code", T, { session: "claude-1", kind: "session.start" });
    t.write("codex", T + 2_000, { session: "codex-1", kind: "session.start" });
    await ingest({ config: t.config, index, blobs: new MemoryBlobStore(), adapters, env: t.env, lock: false });
    assert.equal((await index.getSession("codex-1"))?.parent, undefined);
    t.write("codex", T + 3_000, { session: "codex-1", kind: "turn.end" }, { spawnedBy: [{ agent: "claude-code", session: "claude-1" }] });
    await ingest({ config: t.config, index, blobs: new MemoryBlobStore(), adapters, env: t.env, lock: false });
    assert.deepEqual((await index.getSession("codex-1"))?.parent, { sessionId: "claude-1", type: "harness" });
    await index.close();
  });

  it("without markers: from the parent's shell call, whether the parent's spool is read before or after the child's; never when the times do not overlap", async () => {
    // Spool dirs are read in name order: claude-code before codex.
    for (const [p, c, command] of [
      ["claude-code", "codex", "codex exec 'fix the test'"],
      ["codex", "claude-code", "claude -p 'fix the test'"],
    ] as const) {
      const t = setup();
      t.write(p, T, { session: "parent", kind: "session.start" });
      t.write(p, T + 1_000, { session: "parent", kind: "tool.start", ...bash(command, "tu1") });
      t.write(p, T + 9_000, { session: "parent", kind: "tool.end", tool: "Bash", toolUseId: "tu1" });
      t.write(c, T + 2_000, { session: "child-in", kind: "session.start" });
      t.write(c, T + 20_000, { session: "child-after", kind: "session.start" });
      const index = new MemoryIndexStore();
      await ingest({ config: t.config, index, blobs: new MemoryBlobStore(), adapters, env: t.env, lock: false });
      const call = (await index.listEvents("parent", { kinds: ["tool.start"] }))[0]!;
      assert.deepEqual((await index.getSession("child-in"))?.parent, { sessionId: "parent", eventId: call.id, type: "harness" }, `${p} ran ${c}`);
      assert.equal((await index.getSession("child-after"))?.parent, undefined);
      assert.equal((await index.getSession("parent"))?.parent, undefined);
    }
  });
});
