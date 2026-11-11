// Session lookup: a prefix of a parent that also matches its subagents is the
// parent, a bare subagent id opens the subagent, and an SDK id without its
// project prefix resolves under the default project.
import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { resolveSession } from "../../src/cli/common.ts";
import type { CliError } from "../../src/cli/output.ts";
import type { Context } from "../../src/core/context.ts";
import type { Session } from "../../src/core/types.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { tmpEnv, type TmpEnv } from "../adapters/_helpers.ts";

let t: TmpEnv;
beforeEach(() => (t = tmpEnv()));
afterEach(() => t.restore());

function session(id: string, startedAt: number, extra: Partial<Session> & { parentSessionId?: string } = {}): Session {
  return { id, agent: "claude-code", title: id, startedAt, endedAt: startedAt + 1000, stats: { events: 1, turns: 1, toolCalls: 0, toolErrors: 0, filesChanged: 0, subagents: 0 }, ...extra } as unknown as Session; // slop-allow chained-as: a session row with only the fields lookup reads
}

const PARENT = "36d2966a-1c53-47f1-891d-aae1827d0e95";
const AGENT_A = "a33e97aae0b87e2b4";
const AGENT_B = "afa77c104e92d121e";

for (const kind of ["memory", "sqlite"] as const) {
  describe(`${kind} store lookup`, () => {
    async function open() {
      const index = kind === "memory" ? new MemoryIndexStore() : await SqliteIndexStore.open(join(t.root, "index.db"));
      await index.migrate();
      const now = Date.now();
      await index.upsertSession(session(PARENT, now));
      await index.upsertSession(session(`${PARENT}:sub:${AGENT_A}`, now + 1, { parentSessionId: PARENT }));
      await index.upsertSession(session(`${PARENT}:sub:${AGENT_B}`, now + 2, { parentSessionId: PARENT }));
      await index.upsertSession(session("default/tenant-7/conv-123", now + 3));
      return { index, ctx: { index, env: {} } as unknown as Context }; // slop-allow chained-as: lookup reads only index and env
    }

    test("a prefix of a parent that also matches its subagents is the parent", async () => {
      const { index, ctx } = await open();
      try {
        assert.equal((await resolveSession(ctx, PARENT.slice(0, 8))).id, PARENT);
      } finally {
        await index.close();
      }
    });

    test("a bare agent id opens that subagent", async () => {
      const { index, ctx } = await open();
      try {
        assert.equal((await resolveSession(ctx, AGENT_A)).id, `${PARENT}:sub:${AGENT_A}`);
        assert.equal((await resolveSession(ctx, AGENT_B.slice(0, 8))).id, `${PARENT}:sub:${AGENT_B}`, "a prefix of the agent id too");
      } finally {
        await index.close();
      }
    });

    test("an SDK id without its project prefix opens it under the default project", async () => {
      const { index, ctx } = await open();
      try {
        assert.equal((await resolveSession(ctx, "tenant-7/conv-123")).id, "default/tenant-7/conv-123");
        await assert.rejects(resolveSession(ctx, "tenant-7/nope"), (e: CliError) => e.reason === "not_found");
      } finally {
        await index.close();
      }
    });
  });
}

describe("latest", () => {
  const now = Date.now();
  async function open() {
    const index = new MemoryIndexStore();
    await index.migrate();
    return { index, ctx: { index, env: {} } as unknown as Context }; // slop-allow chained-as: lookup reads only index and env
  }

  test("skips a session with nothing in it, as `sessions` does", async () => {
    const { index, ctx } = await open();
    await index.upsertSession(session("with-work", now - 5000));
    await index.upsertSession(session("hook-only", now, { stats: { events: 1, turns: 0, toolCalls: 0, toolErrors: 0, filesChanged: 0, subagents: 0 } } as never));
    assert.equal((await resolveSession(ctx, "latest")).id, "with-work");
  });

  test("with only empty sessions it is the newest of them", async () => {
    const { index, ctx } = await open();
    const stats = { events: 1, turns: 0, toolCalls: 0, toolErrors: 0, filesChanged: 0, subagents: 0 };
    await index.upsertSession(session("old", now - 5000, { stats } as never));
    await index.upsertSession(session("new", now, { stats } as never));
    assert.equal((await resolveSession(ctx, "latest")).id, "new");
  });

  test("an agent run under `coding.sh run` resolves to its wrapper session", async () => {
    const { index, ctx } = await open();
    await index.upsertSession(session("unrelated", now - 3600e3));
    await index.upsertSession(session("wrapper-1", now - 20_000, { agent: "wrapper", endedAt: now, repo: { root: "/r", head: "h", snapshot: "s1" }, endSnapshot: "s2" } as never));
    await index.upsertSession(session("claude-inside", now - 15_000));
    assert.equal((await resolveSession(ctx, "latest")).id, "wrapper-1");
    // A session that started after the wrapper ended is its own latest.
    await index.upsertSession(session("claude-later", now + 5000));
    assert.equal((await resolveSession(ctx, "latest")).id, "claude-later");
  });
});
