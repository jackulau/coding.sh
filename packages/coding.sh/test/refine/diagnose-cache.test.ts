// refine diagnose caches a model reply only once it parses: a prose or cut-off
// reply is not reused by the next run, and an unusable cached reply is asked again.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { cachedAsk, cacheKey, ReplyCache, type Calls } from "../../src/refine/diagnose.ts";
import type { ChatProvider } from "../../src/judge/providers.ts";

const dir = mkdtempSync(join(tmpdir(), "csh-diag-cache-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function provider(replies: string[]): ChatProvider & { asked: number } {
  const p: ChatProvider & { asked: number } = {
    name: "stub",
    model: "stub-model",
    params: {},
    asked: 0,
    complete: async () => ({ text: replies[Math.min(p.asked++, replies.length - 1)]!, model: "stub-model", usage: { inputTokens: 1, outputTokens: 1 } }),
  };
  return p;
}

const req = { system: "sys", user: "user", schema: { type: "object" }, label: "t" };
const calls = (): Calls => ({ calls: 0, cached: 0, inputTokens: 0, outputTokens: 0 });

describe("refine diagnose reply cache", () => {
  it("an invalid reply is not cached, so the next run asks again", async () => {
    const cache = new ReplyCache(join(dir, "a"));
    const p = provider(['{"status": "probl', '{"status":"none","occurrences":[]}']);
    assert.equal(await cachedAsk(p, cache, calls())(req), '{"status": "probl');
    assert.equal(cache.get(cacheKey(p.model, req.system, req.user)), undefined);
    const c = calls();
    assert.equal(await cachedAsk(p, cache, c)(req), '{"status":"none","occurrences":[]}');
    assert.deepEqual([p.asked, c.calls, c.cached], [2, 1, 0]);
    const again = calls();
    assert.equal(await cachedAsk(p, cache, again)(req), '{"status":"none","occurrences":[]}');
    assert.deepEqual([p.asked, again.cached], [2, 1], "a valid reply is reused");
  });

  it("an unusable reply already in the cache is asked again", async () => {
    const cache = new ReplyCache(join(dir, "b"));
    const p = provider(['{"status":"none","occurrences":[]}']);
    cache.set(cacheKey(p.model, req.system, req.user), "Sorry, I can't help with that.");
    assert.equal(await cachedAsk(p, cache, calls())(req), '{"status":"none","occurrences":[]}');
    assert.equal(p.asked, 1);
  });
});
