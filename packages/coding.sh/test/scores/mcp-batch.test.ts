// score_add_batch: up to 100 scores, each checked as score_add checks one, all or none.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { openContext } from "../../src/core/context.ts";
import type { Score } from "../../src/core/types.ts";
import { ToolError } from "../../src/mcp/protocol.ts";
import { scoreTools } from "../../src/scores/mcp.ts";
import { mkSession, sandbox, type Sandbox } from "../cli/_cmd.ts";

const T0 = Date.UTC(2026, 0, 15, 12);
let sb: Sandbox;

before(async () => {
  sb = sandbox();
  await sb.seed([mkSession("sess-a", T0), mkSession("sess-b", T0 + 60_000)]);
});
after(() => sb.cleanup());

const batch = scoreTools().find((t) => t.name === "score_add_batch")!;
const list = scoreTools().find((t) => t.name === "score_list")!;

async function call(tool: typeof batch, args: Record<string, unknown>): Promise<any> {
  const ctx = await openContext({ env: sb.env, cwd: sb.root });
  try {
    return await tool.run(args, { env: sb.env, cwd: sb.root, now: () => T0 + 120_000, store: async () => ctx });
  } finally {
    await ctx.close();
  }
}

const stored = async (): Promise<Score[]> => (await call(list, { limit: 200 })).items;

describe("score_add_batch", () => {
  test("is listed with a small input schema and the write annotations", () => {
    assert.ok(batch);
    assert.equal(batch.annotations?.readOnlyHint, false);
    assert.equal(batch.annotations?.destructiveHint, true);
    assert.equal((batch.inputSchema as { properties: { scores: { maxItems: number } } }).properties.scores.maxItems, 100);
  });

  test("one invalid score stores none of them, and the error names it", async () => {
    const scores = [
      { targetId: "sess-a", name: "outcome", value: true },
      { targetId: "missing", name: "outcome", value: false },
      { targetId: "sess-b", name: "outcome", value: true },
    ];
    await assert.rejects(call(batch, { scores }), (e) => e instanceof ToolError && /^scores\[1\]: .*session not found.*none of the 3 scores were stored/.test(e.message));
    await assert.rejects(call(batch, { scores: [{ targetId: "sess-a", name: "bad name!", value: 1 }] }), (e) => e instanceof ToolError && /^scores\[0\]: /.test(e.message));
    await assert.rejects(call(batch, { scores: ["x"] }), (e) => e instanceof ToolError && /scores\[0\]: must be an object/.test(e.message));
    await assert.rejects(call(batch, { scores: [] }), ToolError);
    await assert.rejects(call(batch, { scores: Array.from({ length: 101 }, () => ({ targetId: "sess-a", name: "n", value: 1 })) }), (e) => e instanceof ToolError && /at most 100/.test(e.message));
    assert.deepEqual(await stored(), []);
  });

  test("a valid batch stores every score; latest works; a repeat changes nothing", async () => {
    const scores = [
      { targetId: "sess-a", name: "outcome", value: true, comment: "done" },
      { targetId: "latest", name: "outcome", value: false },
      { targetId: "sess-a", name: "tone", value: "calm", source: "human" },
    ];
    const r = await call(batch, { scores });
    assert.equal(r.items.length, 3);
    assert.deepEqual(r.items.map((i: { created: boolean }) => i.created), [true, true, true]);
    assert.equal(r.items[1].score.targetId, "sess-b");
    const rows = await stored();
    assert.deepEqual(rows.map((s) => `${s.targetId}:${s.name}:${String(s.value)}`).sort(), ["sess-a:outcome:true", "sess-a:tone:calm", "sess-b:outcome:false"]);
    const again = await call(batch, { scores });
    assert.deepEqual(again.items.map((i: { changed: boolean }) => i.changed), [false, false, false]);
    assert.equal((await stored()).length, 3);
  });

  test("two scores with the same id in one batch store the later one", async () => {
    const r = await call(batch, { scores: [{ targetId: "sess-b", name: "speed", value: 1 }, { targetId: "sess-b", name: "speed", value: 2 }] });
    assert.equal(r.items.length, 2);
    const speed = (await stored()).filter((s) => s.name === "speed");
    assert.deepEqual(speed.map((s) => s.value), [2]);
  });
});
