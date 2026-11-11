// Aider's reply cost: Aider prices the cache tokens of an Anthropic reply twice, so
// a reply is priced from its tokens when the price table has the model. The
// fixture is a real Aider 0.86.2 run against the stub model
// (scripts/e2e/aider-usage-capture.mjs): 1,500 input, 2,400 cache write,
// 12,000 cache hit and 30 output tokens per reply, $0.06075 each by Aider.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { aiderAdapter } from "../../../src/adapters/more/aider.ts";
import { defaultConfig } from "../../../src/core/config.ts";
import { ingest } from "../../../src/core/ingest.ts";
import { costFrom, pricesFor, resolvePrice } from "../../../src/core/pricing.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../../src/store/memory.ts";
import { FIXTURES, tmpEnv } from "../_helpers.ts";

const SPOOL = readFileSync(join(FIXTURES, "aider", "cache.spool.jsonl"), "utf8");
const RECORDED = "anthropic/claude-3-5-sonnet-20241022";
const PRICED = "anthropic/claude-sonnet-4-5";
/** A model no price table has, so Aider's own figure is the only cost there is. */
const UNPRICED = "anthropic/unpriced-test-model";
const SESSION = "aacfecc0-a777-4f09-b27f-4b8a3d7cc2eb";

async function ingestAs(model: string) {
  const env = tmpEnv();
  try {
    const dir = join(env.dataHome, "spool", "aider");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-11-08.jsonl"), SPOOL.replaceAll(RECORDED, model));
    const index = new MemoryIndexStore();
    const res = await ingest({ config: defaultConfig(process.env), index, blobs: new MemoryBlobStore(), adapters: new Map([["aider", aiderAdapter]]), env: process.env, lock: false });
    assert.deepEqual(res.errors, []);
    const calls = await index.listEvents(SESSION, { kinds: ["llm.call"] });
    return { calls, session: await index.getSession(SESSION) };
  } finally {
    env.restore();
  }
}

describe("aider reply cost", () => {
  it("a priced model: each reply's cost comes from its tokens, Aider's figure stays in payload.aiderCostUsd", async () => {
    const price = resolvePrice(PRICED, pricesFor())!.price;
    assert.ok(price);
    const { calls, session } = await ingestAs(PRICED);
    assert.equal(calls.length, 2);
    const tokens = { inputTokens: 1500, outputTokens: 30, cacheReadTokens: 12000, cacheWriteTokens: 2400 };
    const each = costFrom(tokens, price);
    for (const c of calls) {
      assert.deepEqual({ ...c.usage, costUsd: undefined }, { ...tokens, costUsd: undefined });
      assert.ok(Math.abs(c.usage!.costUsd! - each) < 1e-9, `${c.usage!.costUsd} vs ${each}`);
      assert.equal(c.payload.aiderCostUsd, 0.06075);
      assert.equal(c.payload.costEstimated, true);
    }
    assert.ok(Math.abs(session!.stats.usage!.costUsd! - 2 * each) < 1e-9);
    // Sonnet rates ($3 in, $15 out, $0.30 cache read, $3.75 cache write per 1M): $0.01755 a reply, $0.0351 for both.
    if (price.input === 3 && price.output === 15 && price.cacheRead === 0.3 && price.cacheWrite === 3.75) assert.ok(Math.abs(2 * each - 0.0351) < 1e-9);
  });

  it("a model the price table does not have keeps Aider's figure", async () => {
    assert.equal(resolvePrice(UNPRICED, pricesFor()), undefined);
    const { calls } = await ingestAs(UNPRICED);
    assert.deepEqual(calls.map((c) => c.usage?.costUsd), [0.06075, 0.06075]);
    assert.ok(calls.every((c) => c.payload.aiderCostUsd === undefined));
  });

  it("parseVersion is bumped so stored Aider sessions are parsed again", () => {
    assert.ok(aiderAdapter.parseVersion! >= 4);
  });
});
