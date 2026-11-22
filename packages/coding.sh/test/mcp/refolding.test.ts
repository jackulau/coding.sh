// The first MCP calls after an upgrade, on a store whose sessions an older coding.sh folded: they
// answer within 3 s and say the index is being folded again (`index.refolding`); once the refold
// is done a new process answers without it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, describe, it } from "node:test";
import { openContext } from "../../src/core/context.ts";
import { REFOLD_CURSOR } from "../../src/core/ingest.ts";
import { foldStamp } from "../../src/core/sessions.ts";
import { withRefolding } from "../../src/mcp/server.ts";
import type { AgentEvent, Session } from "../../src/schema/index.ts";
import { CLI } from "../_cli.ts";
import { RawClient, cleanup, makeWorld, type World } from "./helpers.ts";

after(cleanup);

const SESSIONS = 420;
const FIRST_CALL_MS = 3000;

async function staleStore(w: World): Promise<void> {
  const ctx = await openContext({ env: w.env, cwd: w.root });
  try {
    const events: AgentEvent[] = [];
    for (let i = 0; i < SESSIONS; i++) {
      const id = `old-${String(i).padStart(4, "0")}`;
      const t0 = w.now - (i + 1) * 60_000;
      const base = { v: 0, sessionId: id, agent: "claude-code", cwd: w.repo } as const;
      events.push(
        { ...base, id: `${id}-0`, ts: t0, kind: "user.message", payload: { text: "Fix the failing parser test" } },
        { ...base, id: `${id}-1`, ts: t0 + 1000, kind: "tool.start", payload: { tool: "Bash", toolUseId: `${id}-t`, input: { command: "npm test" } } },
        { ...base, id: `${id}-2`, ts: t0 + 3000, kind: "tool.end", durationMs: 2000, payload: { tool: "Bash", toolUseId: `${id}-t`, ok: i % 3 !== 0, output: "1 failing" } },
      );
      const s: Session = {
        id,
        agent: "claude-code",
        startedAt: t0,
        endedAt: t0 + 3000,
        title: `session ${i}`,
        cwd: w.repo,
        stats: { events: 3, turns: 1, toolCalls: 1, toolErrors: i % 3 === 0 ? 1 : 0, filesChanged: 0, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } },
        // A flag the old fold set and this one does not: a read before the refold shows the old row, whole.
        flags: ["old-fold-flag"],
      };
      await ctx.index.upsertSession(s);
    }
    await ctx.index.putEvents(events);
    // Folded by an older build: its stamp is not this one's.
    await ctx.index.setCursor(REFOLD_CURSOR, foldStamp() - 1);
  } finally {
    await ctx.close();
  }
}

/** One tools/call, timed from the request to its answer. */
async function timed(c: RawClient, name: string, args: Record<string, unknown> = {}) {
  const t0 = performance.now();
  const r = await c.call(name, args);
  const ms = performance.now() - t0;
  assert.notEqual(r.isError, true, `${name}: ${r.content[0]?.text}`);
  return { ms, structured: r.structuredContent ?? {}, text: r.content.map((x) => x.text).join("\n") };
}

describe("MCP reads while the index is folded again after an upgrade", () => {
  const w = makeWorld();
  // No CLI to start a background ingest from here (the server runs from source, no cli-path): the refold waits for `coding.sh ingest`.
  const env = { ...w.env, CODING_SH_NO_UPDATE_CHECK: "1" };

  it("the first calls of a new process answer within 3 s and carry index.refolding; after the refold a second process does not", async () => {
    await staleStore(w);
    const c = new RawClient(env, w.repo);
    try {
      await c.initialize();
      for (const [name, args] of [["status", {}], ["failures", { since: "30d" }], ["latency", { since: "30d" }], ["session_get", { sessionId: "old-0000" }]] as const) {
        const r = await timed(c, name, args);
        assert.ok(r.ms < FIRST_CALL_MS, `${name} took ${Math.round(r.ms)} ms`);
        assert.equal((r.structured.index as Record<string, unknown> | undefined)?.refolding, true, `${name} says the index is being refolded`);
        assert.match(r.text, /"refolding":true/, `${name}: in its text too`);
      }
      assert.match((await timed(c, "session_get", { sessionId: "old-0003" })).text, /old-fold-flag/, "a session not refolded yet shows its old row");
    } finally {
      await c.close();
    }

    const r = spawnSync(process.execPath, ["--no-warnings", CLI, "ingest"], { env: { ...env, CODING_SH_NO_AUTO_INGEST: "1" }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const ctx = await openContext({ env: w.env, cwd: w.root });
    try {
      assert.equal(await ctx.index.getCursor(REFOLD_CURSOR), foldStamp(), "the ingest refolded every session");
    } finally {
      await ctx.close();
    }

    const c2 = new RawClient(env, w.repo);
    try {
      await c2.initialize();
      for (const name of ["status", "failures"]) {
        const r2 = await timed(c2, name, { since: name === "status" ? undefined : "30d" });
        assert.equal((r2.structured.index as Record<string, unknown> | undefined)?.refolding, undefined, `${name}: no refold left`);
        assert.doesNotMatch(r2.text, /refolding/);
      }
      assert.doesNotMatch((await timed(c2, "session_get", { sessionId: "old-0003" })).text, /old-fold-flag/, "refolded from its events");
    } finally {
      await c2.close();
    }
  });

  it("merges into an index object the answer has, and leaves a non-object index alone", () => {
    assert.deepEqual(withRefolding({ index: { updatedAt: "x", ageMs: 5 } }), { index: { updatedAt: "x", ageMs: 5, refolding: true } });
    assert.deepEqual(withRefolding({ rows: [] }), { rows: [], index: { refolding: true } });
    assert.deepEqual(withRefolding({ index: 3 }), { index: 3 });
    assert.ok(JSON.stringify({ index: { refolding: true } }).length - 2 <= 27, "within the room a page leaves for it");
  });
});
