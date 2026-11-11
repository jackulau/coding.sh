// Cross-harness child sessions (TB-7): an agent started from another agent's
// shell tool is linked to that session as a child of type "harness", from the
// env markers the hook records (spawnedBy) or, without them, from the
// parent's shell call that ran the child's CLI while the child started.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import type { AgentEvent, EventKind, Session } from "../../src/schema/index.ts";
import type { Adapter, SpoolLine } from "../../src/core/types.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { childLinker, childLinkKey, childWaitKey, ingest, recomputeSession } from "../../src/core/ingest.ts";
import { repoResolver } from "../../src/core/repo-state.ts";
import { buildSession } from "../../src/core/sessions.ts";
import { PKG_ROOT, loadSpool, tmpEnv } from "../adapters/_helpers.ts";
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
  it("from the child's spawnedBy: the session its hook's env named is its parent, of type harness", async () => {
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
    // The link is the row's: the marker is unchecked when the line is parsed, so the event does not carry it.
    const start = (await index.listEvents("codex-1", { kinds: ["session.start"] }))[0]!;
    assert.deepEqual([start.payload.parentSessionId, start.payload.parentAgent, start.payload.subagentType], [undefined, undefined, undefined]);
  });

  // qa:capture-3: a stale CLAUDE_CODE_SESSION_ID in a hook's env made a top-level session the
  // subagent of a session that is not in the store, so `sessions` and `stats` did not count it.
  it("a marker naming a session that is not in the index, or one that ended before the child started, links nothing", async () => {
    const t = setup();
    const ghost = [{ agent: "claude-code", session: "11111111-2222-4333-8444-000000000000" }];
    t.write("codex", T + 2_000, { session: "no-parent", kind: "session.start" }, { spawnedBy: ghost });
    t.write("codex", T + 3_000, { session: "no-parent", kind: "turn.end" }, { spawnedBy: ghost });
    // claude-old ended at T + 1 s; a shell that outlived it still exports its id.
    const old = [{ agent: "claude-code", session: "claude-old" }];
    t.write("claude-code", T, { session: "claude-old", kind: "session.start" });
    t.write("claude-code", T + 1_000, { session: "claude-old", kind: "session.end" });
    t.write("codex", T + 60_000, { session: "late", kind: "session.start" }, { spawnedBy: old });
    // claude-next starts after the session that names it.
    t.write("codex", T + 70_000, { session: "early", kind: "session.start" }, { spawnedBy: [{ agent: "claude-code", session: "claude-next" }] });
    t.write("claude-code", T + 80_000, { session: "claude-next", kind: "session.start" });
    // claude-open is still running: the link holds.
    t.write("claude-code", T + 90_000, { session: "claude-open", kind: "session.start" });
    t.write("codex", T + 95_000, { session: "child", kind: "session.start" }, { spawnedBy: [{ agent: "claude-code", session: "claude-open" }] });
    const root = mkdtempSync(join(tmpdir(), "csh-spawned-db-"));
    roots.push(root);
    // Each store reads the whole spool: the cursors are the store's.
    for (const index of [new MemoryIndexStore(), await SqliteIndexStore.open(join(root, "idx.db"))]) {
      await ingest({ config: t.config, index, blobs: new MemoryBlobStore(), adapters, env: t.env, lock: false });
      for (const id of ["no-parent", "late", "early"]) assert.equal((await index.getSession(id))?.parent, undefined, id);
      assert.deepEqual((await index.getSession("child"))?.parent, { sessionId: "claude-open", type: "harness" });
      const top = (await index.listSessions({ parentSessionId: null })).map((s) => s.id).sort();
      assert.deepEqual(top, ["claude-next", "claude-old", "claude-open", "early", "late", "no-parent"]);
      await index.close();
    }
  });

  it("a marker links a parent whose spool is read after the child's, and one that reaches the index in a later run", async () => {
    // Spool dirs are read in name order: claude-code (the child here) before codex.
    const t = setup();
    const by = [{ agent: "codex", session: "codex-parent" }];
    t.write("codex", T, { session: "codex-parent", kind: "session.start" });
    t.write("claude-code", T + 2_000, { session: "claude-child", kind: "session.start" }, { spawnedBy: by });
    t.write("claude-code", T + 3_000, { session: "waits", kind: "session.start" }, { spawnedBy: [{ agent: "codex", session: "codex-later" }] });
    const index = new MemoryIndexStore();
    await ingest({ config: t.config, index, blobs: new MemoryBlobStore(), adapters, env: t.env, lock: false });
    assert.deepEqual((await index.getSession("claude-child"))?.parent, { sessionId: "codex-parent", type: "harness" });
    assert.equal((await index.getSession("waits"))?.parent, undefined);
    // The child has no new line: it waits under the id its hooks named.
    t.write("codex", T + 1_000, { session: "codex-later", kind: "session.start" });
    await ingest({ config: t.config, index, blobs: new MemoryBlobStore(), adapters, env: t.env, lock: false });
    assert.deepEqual((await index.getSession("waits"))?.parent, { sessionId: "codex-later", type: "harness" });
    assert.equal(await index.kvGet(childWaitKey("codex-later")), JSON.stringify(["waits"]));
    // The next write of the parent's row finds it linked and stops it waiting.
    t.write("codex", T + 5_000, { session: "codex-later", kind: "turn.end" });
    await ingest({ config: t.config, index, blobs: new MemoryBlobStore(), adapters, env: t.env, lock: false });
    assert.equal(await index.kvGet(childWaitKey("codex-later")), undefined);
    assert.deepEqual((await index.getSession("waits"))?.parent, { sessionId: "codex-later", type: "harness" });
  });

  it("a parent known only from its transcript, read as far as the call that started the child, links the child once it is read further", async () => {
    // A transcript has no end marker: the session ends at its last line so far, which is the
    // call (T + 1 s) until the call returns. The child's hooks have all run by then.
    const t = setup();
    const index = new MemoryIndexStore();
    const transcript = { agent: "codex", source: "transcript" } as const;
    const read = async (events: AgentEvent[]) => {
      await index.putEvents(events);
      const linker = childLinker(index);
      await recomputeSession(index, "codex-parent", { linker, repo: repoResolver() });
      await linker.apply();
    };
    await read([event("codex-parent", "session.start", T, {}, transcript), event("codex-parent", "tool.start", T + 1_000, bash("./review.sh", "tu1"), transcript)]);
    assert.equal((await index.getSession("codex-parent"))?.endedAt, T + 1_000);
    const by = [{ agent: "codex", session: "codex-parent" }];
    t.write("claude-code", T + 2_000, { session: "claude-child", kind: "session.start" }, { spawnedBy: by });
    t.write("claude-code", T + 8_000, { session: "claude-child", kind: "session.end" }, { spawnedBy: by });
    // A session that started after the parent had ended names it too: a shell that outlived it.
    t.write("claude-code", T + 60_000, { session: "claude-late", kind: "session.start" }, { spawnedBy: by });
    await ingest({ config: t.config, index, blobs: new MemoryBlobStore(), adapters, env: t.env, lock: false });
    assert.equal((await index.getSession("claude-child"))?.parent, undefined);
    await read([event("codex-parent", "tool.end", T + 9_000, { tool: "Bash", toolUseId: "tu1" }, transcript)]);
    assert.deepEqual((await index.getSession("claude-child"))?.parent, { sessionId: "codex-parent", type: "harness" });
    assert.equal((await index.getSession("claude-late"))?.parent, undefined);
    assert.deepEqual((await index.listSessions({ parentSessionId: null })).map((s) => s.id).sort(), ["claude-late", "codex-parent"]);
  });

  it("a session an older build stored with such a parent is top-level again once it is folded again; a parent that was open stays", async () => {
    // What 0.1.5 stored: the marker stamped into the start, the row's parent, and the link in kv.
    const root = mkdtempSync(join(tmpdir(), "csh-spawned-db-"));
    roots.push(root);
    const index = await SqliteIndexStore.open(join(root, "idx.db"));
    const stamped = (parent: string) => ({ parentSessionId: parent, parentAgent: "claude-code", subagentType: "harness" });
    await index.putEvents([
      event("claude-1", "session.start", T, {}),
      event("ghosted", "session.start", T + 1_000, stamped("gone"), { agent: "codex" }),
      event("ghosted", "turn.end", T + 2_000, {}, { agent: "codex" }),
      event("kept", "session.start", T + 1_000, stamped("claude-1"), { agent: "codex" }),
    ]);
    await index.upsertSession(session("claude-1", "claude-code", T));
    await index.upsertSession(session("ghosted", "codex", T + 1_000, { parent: { sessionId: "gone", type: "harness" } }));
    await index.upsertSession(session("kept", "codex", T + 1_000, { parent: { sessionId: "claude-1", type: "harness" } }));
    await index.kvSet!(childLinkKey("ghosted"), JSON.stringify({ sessionId: "gone", type: "harness" }));
    await index.kvSet!(childLinkKey("kept"), JSON.stringify({ sessionId: "claude-1", type: "harness" }));
    assert.deepEqual((await index.listSessions({ parentSessionId: null })).map((s) => s.id), ["claude-1"]);
    const linker = childLinker(index);
    for (const id of ["claude-1", "ghosted", "kept"]) await recomputeSession(index, id, { linker, repo: repoResolver() });
    await linker.apply();
    assert.equal((await index.getSession("ghosted"))?.parent, undefined);
    assert.deepEqual((await index.getSession("kept"))?.parent, { sessionId: "claude-1", type: "harness" });
    assert.deepEqual((await index.listSessions({ parentSessionId: null })).map((s) => s.id).sort(), ["claude-1", "ghosted"]);
    await index.close();
  });

  it("a fold of events alone takes no parent from the marker an older build stamped into the start; a subagent's start still names its parent", () => {
    // No index to check the named session against (a trace file, an export): the marker is not a parent.
    const stamped = event("ghosted", "session.start", T, { parentSessionId: "gone", parentAgent: "claude-code", subagentType: "harness" }, { agent: "codex" });
    assert.equal(buildSession([stamped, event("ghosted", "turn.end", T + 1_000, {}, { agent: "codex" })]).parent, undefined);
    const sub = event("claude-1:sub:a1", "session.start", T, { parentSessionId: "claude-1", subagentId: "a1", subagentType: "explore" });
    assert.deepEqual(buildSession([sub]).parent, { sessionId: "claude-1", subagentId: "a1", type: "explore" });
  });

  it("coding.sh sessions lists a Codex session whose hooks ran with a stale CLAUDE_CODE_SESSION_ID", () => {
    const env = tmpEnv();
    try {
      const file = join(env.dataHome, "spool", "codex", "2026-11-01.jsonl");
      mkdirSync(dirname(file), { recursive: true });
      const lines = loadSpool("codex/hooks.spool.jsonl").map((l) => ({ ...l, spawnedBy: [{ agent: "claude-code", session: "11111111-2222-4333-8444-000000000000" }] }));
      writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
      const cliEnv = { HOME: env.home, USERPROFILE: env.home, CODING_SH_HOME: env.dataHome, CODEX_HOME: join(env.root, "codex"), CLAUDE_CONFIG_DIR: join(env.root, "claude"), XDG_CONFIG_HOME: join(env.root, "xdg"), XDG_DATA_HOME: join(env.root, "xdg-data"), PATH: dirname(process.execPath) };
      const cli = (args: string[]) => spawnSync(process.execPath, ["--no-warnings", join(PKG_ROOT, "src", "cli", "main.ts"), ...args], { env: cliEnv, cwd: env.home, encoding: "utf8", timeout: 60_000 });
      const ingested = cli(["ingest"]);
      assert.equal(ingested.status, 0, ingested.stderr);
      const listed = cli(["sessions", "--json", "--since", "2026-10-01"]);
      assert.equal(listed.status, 0, listed.stderr);
      assert.match(listed.stdout, /0193aaaa-1111-7222-8333-444455556666/);
      const stats = cli(["stats", "--json", "--since", "2026-10-01"]);
      assert.equal(stats.status, 0, stats.stderr);
      assert.doesNotMatch(stats.stdout + stats.stderr, /No sessions/);
    } finally {
      env.restore();
    }
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
