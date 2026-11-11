// `eval init --where` with an event key (tool:Bash) on the SQLite store: the
// pool goes through the store's own query path, which answers event keys,
// instead of the in-memory matcher, which refused them (internal_error).
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { after, describe, it } from "node:test";
import type { AgentEvent, Session } from "../../src/core/types.ts";
import { initSuite } from "../../src/eval/init.ts";
import { parseWhere } from "../../src/query/where.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { BUGGY, FakeSnapshots, FIXED, HIDDEN_TEST, MemBlobs, tempDir } from "../helpers-eval.ts";

const dirs: string[] = [];
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe("initSuite --where on SQLite", () => {
  it("tool:Bash selects the session that ran Bash, and leaves out the one that did not", async () => {
    const root = await tempDir("csh-init-where-");
    dirs.push(root);
    const index = await SqliteIndexStore.open(":memory:");
    try {
      const REPO = "/work/toy";
      let seq = 0;
      const ev = (sessionId: string, kind: AgentEvent["kind"], payload: Record<string, unknown>, extra: Partial<AgentEvent> = {}): AgentEvent => ({ id: `e${++seq}`, v: 0, sessionId, ts: 10_000 + seq, agent: "claude-code", kind, payload, ...extra });
      const session = (id: string): Session => ({
        id,
        agent: "claude-code",
        repo: { root: REPO, head: "abc", snapshot: "start" },
        startedAt: 10_000,
        stats: { events: 3, turns: 1, toolCalls: 1, toolErrors: 0, filesChanged: 1 },
        flags: [],
        endSnapshot: "end",
      });
      for (const [id, tool] of [["bash", "Bash"], ["edit", "Edit"]] as const) {
        await index.upsertSession(session(id));
        await index.putEvents([
          ev(id, "session.start", {}, { repo: { root: REPO, head: "abc", snapshot: "start" } }),
          ev(id, "user.message", { text: `fix add (${id})` }),
          ev(id, "tool.start", { tool, toolUseId: `t-${id}`, input: tool === "Bash" ? { command: "node test/add.test.js" } : { file_path: "src/add.js" } }),
        ]);
      }
      const git = new FakeSnapshots().add("start", BUGGY).add("end", { ...FIXED, "test/add.test.js": HIDDEN_TEST });
      const r = await initSuite(
        { name: "bash-runs", root, source: "sessions", sessionsRepo: "all", where: parseWhere("tool:Bash"), verifier: "node test/add.test.js", since: 5_000 },
        { index, blobs: new MemBlobs(), git, now: 12_000 },
      );
      assert.deepEqual(r.tasks!.map((t) => t.sessionId), ["bash"]);
    } finally {
      await index.close();
    }
  });
});
