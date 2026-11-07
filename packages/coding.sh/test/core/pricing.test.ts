import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { loadConfig } from "../../src/core/config.ts";
import { BUILTIN_PRICES, costFrom, costNote, lookupPrice, priceEvent, pricesFor, resolvePrice } from "../../src/core/pricing.ts";
import type { AgentEvent } from "../../src/schema/index.ts";

const M = 1_000_000;
const table = pricesFor();
const call = (o: Partial<AgentEvent>): AgentEvent => ({ id: "c", v: 0, sessionId: "s", ts: 1, agent: "codex", kind: "llm.call", payload: {}, ...o });
const close = (a: number | undefined, b: number) => assert.ok(a !== undefined && Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

describe("resolvePrice", () => {
  it("resolves ids to their own row (provider prefixes, dated, pinned and mode variants)", () => {
    const cases: [string, string][] = [
      ["gpt-6.1-sol", "gpt-6.1-sol"],
      ["openai/gpt-6.1-sol", "gpt-6.1-sol"],
      ["gpt-6.1-sol-2026-10-01", "gpt-6.1-sol"],
      ["gpt-6-astra", "gpt-6-astra"],
      ["gpt-6-luna", "gpt-6-luna"],
      ["gpt-5.6-terra", "gpt-5.6-terra"],
      ["gpt-6-cyber", "gpt-6-cyber"],
      ["gpt-5.5-cyber", "gpt-5.5-cyber"],
      ["gpt-5.5-pro", "gpt-5.5-pro"],
      ["o3-pro", "o3-pro"],
      ["gpt-4o-2024-08-06", "gpt-4o"],
      ["gpt-5.5-codex", "gpt-5.5"],
      ["claude-opus-4-5-20251101", "claude-opus-4-5"],
      ["claude-opus-4-5@20251101", "claude-opus-4-5"],
      ["us.anthropic.claude-opus-4-5-20251101-v1:0", "claude-opus-4-5"],
      ["claude-opus-4-6[1m]", "claude-opus-4-6"],
      ["claude-opus-4-6-thinking", "claude-opus-4-6"],
      ["Claude-Sonnet-5-5", "claude-sonnet-5-5"],
      ["gemini-3.1-pro-preview", "gemini-3.1-pro"],
      ["google/gemini-3-flash-preview", "gemini-3-flash"],
      ["gemini-3.8-flash", "gemini-3.8-flash"],
      ["moonshotai/kimi-k2.6", "kimi-k2.6"],
      ["MiniMax-M3", "minimax-m3"],
      ["deepseek/deepseek-v4.1-flash-1017", "deepseek-v4.1-flash"],
      ["zai/glm-4.7", "glm-4.7"],
      ["openai/gpt-oss-120b", "gpt-oss-120b"],
    ];
    for (const [id, key] of cases) assert.deepEqual(resolvePrice(id, table), { price: BUILTIN_PRICES[key], key, fallback: false }, id);
  });

  it("falls back to the nearest version in the same family and major, and says so", () => {
    const cases: [string, string][] = [
      ["gpt-6.2-sol", "gpt-6.1-sol"],
      ["gpt-6.1-luna", "gpt-6-luna"],
      ["gpt-5.7-terra", "gpt-5.6-terra"],
      ["gpt-6.2-sol-2026-12-01", "gpt-6.1-sol"],
      ["gpt-5.5-mini", "gpt-5.4-mini"],
      ["gpt-5.7", "gpt-5.5"],
      ["claude-opus-5-6", "claude-opus-5-5"],
      ["claude-sonnet-4-7-thinking", "claude-sonnet-4-6"],
      ["gemini-3-pro", "gemini-3.1-pro"],
      ["gemini-3.7-flash", "gemini-3.6-flash"],
      ["glm-5.4", "glm-5.3"],
    ];
    for (const [id, key] of cases) assert.deepEqual(resolvePrice(id, table), { price: BUILTIN_PRICES[key], key, fallback: true }, id);
  });

  it("never crosses a major version or a family", () => {
    for (const id of ["gpt-5.6-astra", "gpt-7-sol", "claude-opus-6", "gemini-5-flash", "zz-unpriced-model", "gpt-oss-240b", "o1", ""]) assert.equal(resolvePrice(id, table), undefined, id);
    assert.equal(resolvePrice(undefined, table), undefined);
    assert.equal(lookupPrice("claude-haiku-4-5", table), BUILTIN_PRICES["claude-haiku-4-5"]);
  });
});

describe("costFrom", () => {
  it("bills cache writes at 1.25x input on gpt-6.x and gpt-5.6, plain input up to gpt-5.5", () => {
    close(costFrom({ inputTokens: M, cacheWriteTokens: M }, BUILTIN_PRICES["gpt-6.1-sol"]!), 2 + 2.5);
    close(costFrom({ inputTokens: M, cacheWriteTokens: M }, BUILTIN_PRICES["gpt-5.6-cyber"]!), 12.5 + 15.625);
    close(costFrom({ inputTokens: M, cacheWriteTokens: M }, BUILTIN_PRICES["gpt-5.5"]!), 5 + 5);
  });

  it("uses each model's cache-read rate", () => {
    close(costFrom({ cacheReadTokens: M }, BUILTIN_PRICES["gpt-6.1-sol"]!), 0.1);
    close(costFrom({ cacheReadTokens: M, cacheWriteTokens: M }, BUILTIN_PRICES["claude-opus-4-5"]!), 0.5 + 6.25);
    close(costFrom({ cacheReadTokens: M }, BUILTIN_PRICES["claude-sonnet-5-5"]!), 0.1);
    close(costFrom({ cacheReadTokens: M }, BUILTIN_PRICES["claude-fable-5-1"]!), 0.25);
    close(costFrom({ cacheReadTokens: M }, BUILTIN_PRICES["gemini-3.8-flash"]!), 0.075);
    // Pro and gateway rows have no cached price: cached tokens bill as input.
    close(costFrom({ cacheReadTokens: M }, BUILTIN_PRICES["gpt-5.5-pro"]!), 30);
  });

  it("prices a whole call: input, output, cache read and write", () => {
    // gpt-6.1-sol: 2 in, 10 out, 0.1 read, 2.5 write.
    close(costFrom({ inputTokens: 832_163, outputTokens: 135_675, cacheReadTokens: 30_662_784 }, BUILTIN_PRICES["gpt-6.1-sol"]!), (832_163 * 2 + 135_675 * 10 + 30_662_784 * 0.1) / M);
  });
});

describe("priceEvent", () => {
  it("marks computed costs estimated, and names the sibling a fallback used", () => {
    const exact = priceEvent(call({ model: "gpt-6.1-sol", usage: { inputTokens: M } }), table);
    assert.equal(exact.usage?.costUsd, 2);
    assert.equal(exact.payload.costEstimated, true);
    assert.equal(exact.payload.pricedAs, undefined);
    const fb = priceEvent(call({ model: "gpt-6.2-sol", usage: { inputTokens: M } }), table);
    assert.equal(fb.usage?.costUsd, 2);
    assert.deepEqual([fb.payload.costEstimated, fb.payload.pricedAs], [true, "gpt-6.1-sol"]);
  });

  it("prefers any name with its own row over a fallback", () => {
    const e = priceEvent(call({ model: "gpt-5.5", payload: { responseModel: "gpt-5.7" }, usage: { outputTokens: M } }), table);
    assert.equal(e.usage?.costUsd, 30);
    assert.equal(e.payload.pricedAs, undefined);
  });

  it("never touches a reported cost, a call without tokens, or an unknown model", () => {
    for (const e of [
      call({ model: "gpt-6.1-sol", usage: { inputTokens: M, costUsd: 9 } }),
      call({ model: "gpt-6.1-sol", usage: { costUsd: 0 } }),
      call({ model: "gpt-6.1-sol", usage: { inputTokens: 0 } }),
      call({ model: "zz-unpriced-model", usage: { inputTokens: M } }),
      call({ kind: "assistant.message", model: "gpt-6.1-sol", usage: { inputTokens: M } }),
    ])
      assert.equal(priceEvent(e, table), e);
  });
});

describe("price overrides", () => {
  const roots: string[] = [];
  after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

  it("an override replaces a built-in row, adds a model, and anchors its own family", () => {
    const t = pricesFor({ "gpt-6.1-sol": { input: 1, output: 1 }, "my-finetune": { input: 3, output: 15, cacheRead: 0.3 }, "house-coder-2": { input: 1, output: 2 } });
    assert.equal(priceEvent(call({ model: "gpt-6.1-sol", usage: { inputTokens: M } }), t).usage?.costUsd, 1);
    assert.equal(priceEvent(call({ model: "openai/gpt-6.1-sol", usage: { cacheReadTokens: M } }), t).usage?.costUsd, 1, "no cacheRead → input");
    assert.equal(priceEvent(call({ model: "my-finetune", usage: { inputTokens: M, cacheReadTokens: M } }), t).usage?.costUsd, 3.3);
    assert.deepEqual(resolvePrice("house-coder-2.1", t), { price: { input: 1, output: 2 }, key: "house-coder-2", fallback: true });
    assert.equal(pricesFor()["gpt-6.1-sol"]!.input, 2, "the built-in table is untouched");
  });

  it("reads [prices.\"<model>\"] from config.toml, with [pricing] still accepted and [prices] winning", () => {
    const root = mkdtempSync(join(tmpdir(), "csh-prices-"));
    roots.push(root);
    const home = join(root, "data");
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.toml"),
      `
[prices."gpt-6.1-sol"]
input = 1.5
output = 9
cache_read = 0.15
cache_write = 1.875

[pricing."gpt-6.1-sol"]
input = 99
output = 99

[pricing."old-model"]
input = 1
output = 2
`,
    );
    const c = loadConfig({ env: { CODING_SH_HOME: home, HOME: root } });
    assert.deepEqual(c.pricing, { "gpt-6.1-sol": { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 1.875 }, "old-model": { input: 1, output: 2 } });
    writeFileSync(join(home, "config.toml"), `[prices."x"]\ninput = 1\n`);
    assert.throws(() => loadConfig({ env: { CODING_SH_HOME: home, HOME: root } }), /prices\."x" needs both input and output/);
  });
});

describe("costNote", () => {
  it("labels estimated, partly estimated and reported totals", () => {
    assert.equal(costNote({ costUsd: 2, estimatedCostUsd: 2 }), " (estimated)");
    assert.equal(costNote({ costUsd: 2, estimatedCostUsd: 0.5 }), " (incl. $0.5000 estimated)");
    assert.equal(costNote({ costUsd: 2 }), "");
    assert.equal(costNote(undefined), "");
  });
});
