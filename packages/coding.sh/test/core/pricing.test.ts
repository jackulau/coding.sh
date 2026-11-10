import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { loadConfig } from "../../src/core/config.ts";
import { applyPricing, BUILTIN_PRICES, DEFAULT_MODELS, callRates, callTier, costFrom, costNote, geoValue, lookupPrice, priceEvent, pricesFor, promptTokens, resolvePrice, tierValue } from "../../src/core/pricing.ts";
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
      ["claude-fable-5-2", "claude-fable-5-2"],
      ["claude-fable-5-2-20261105", "claude-fable-5-2"],
      ["anthropic/claude-mythos-5-2", "claude-mythos-5-2"],
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
    const exact = priceEvent(call({ model: "gpt-6.1-sol", usage: { inputTokens: 250_000 } }), table);
    assert.equal(exact.usage?.costUsd, 0.5);
    assert.equal(exact.payload.costEstimated, true);
    assert.equal(exact.payload.pricedAs, undefined);
    const fb = priceEvent(call({ model: "gpt-6.2-sol", usage: { inputTokens: 250_000 } }), table);
    assert.equal(fb.usage?.costUsd, 0.5);
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

describe("callTier", () => {
  it("reads payload.serviceTier and payload.speed; standard values and unknown tiers are standard", () => {
    const cases: [Record<string, unknown> | undefined, string | undefined][] = [
      [{ serviceTier: "batch" }, "batch"],
      [{ serviceTier: "flex" }, "flex"],
      [{ serviceTier: "Priority" }, "priority"],
      [{ serviceTier: " fast " }, "fast"],
      [{ serviceTier: "ultrafast" }, "ultrafast"],
      [{ speed: "fast" }, "fast"],
      [{ serviceTier: "priority", speed: "fast" }, "fast"],
      [{ serviceTier: "batch", speed: "fast" }, "batch"],
      [{ serviceTier: "standard", speed: "standard" }, undefined],
      [{ serviceTier: "default" }, undefined],
      [{ serviceTier: "auto" }, undefined],
      [{ serviceTier: "scale" }, undefined],
      [{ serviceTier: 3 }, undefined],
      [{}, undefined],
      [undefined, undefined],
    ];
    for (const [pl, want] of cases) assert.equal(callTier(pl), want, JSON.stringify(pl));
  });

  it("tierValue keeps only non-standard values, lowercased", () => {
    assert.deepEqual(["standard", "STANDARD", "default", "auto", "normal", "standard_only", "on_demand", "", undefined, 1].map(tierValue), Array(10).fill(undefined));
    assert.deepEqual(["priority", "Batch", "fast", "flex"].map(tierValue), ["priority", "batch", "fast", "flex"]);
  });
});

describe("tier and long-context pricing", () => {
  const priced = (model: string, usage: AgentEvent["usage"], payload: Record<string, unknown> = {}) => priceEvent(call({ model, usage, payload }), table);
  const check = (e: AgentEvent, usd: number, tier: string | undefined) => {
    close(e.usage?.costUsd, usd);
    assert.equal(e.payload.priceTier, tier);
    assert.equal(e.payload.costEstimated, true);
  };

  it("bills a call over 272K prompt tokens at OpenAI's long-context rates, counting cache reads and writes", () => {
    // gpt-6.1-sol long: 4 in, 15 out, 0.2 read, 5 write.
    check(priced("gpt-6.1-sol", { inputTokens: 72_000, cacheReadTokens: 200_000, cacheWriteTokens: 1, outputTokens: M }), (72_000 * 4 + 200_000 * 0.2 + 1 * 5 + M * 15) / M, "long-context");
    // Exactly at the threshold is short context.
    check(priced("gpt-6.1-sol", { inputTokens: 72_000, cacheReadTokens: 200_000 }), (72_000 * 2 + 200_000 * 0.1) / M, undefined);
    check(priced("gpt-5.5", { inputTokens: 300_000 }), 300_000 * 10 / M, "long-context");
    check(priced("gpt-5.4-pro", { inputTokens: 300_000, outputTokens: M }), (300_000 * 60 + M * 270) / M, "long-context");
    // No long-context rate on the page: short rates at any size.
    check(priced("gpt-6-cyber", { inputTokens: 300_000 }), 300_000 * 20 / M, undefined);
    check(priced("gpt-5.2", { inputTokens: 300_000 }), 300_000 * 1.75 / M, undefined);
  });

  it("bills Gemini 3.1 Pro and 2.5 Pro prompts over 200K higher; flat models stay flat", () => {
    check(priced("gemini-3.1-pro-preview", { inputTokens: 250_000, outputTokens: M }), (250_000 * 4 + M * 18) / M, "long-context");
    check(priced("gemini-3.1-pro", { inputTokens: 150_000, outputTokens: M }), (150_000 * 2 + M * 12) / M, undefined);
    check(priced("gemini-2.5-pro", { inputTokens: 100_000, cacheReadTokens: 150_000 }), (100_000 * 2.5 + 150_000 * 0.25) / M, "long-context");
    check(priced("gemini-4-argon", { inputTokens: 500_000 }), 500_000 * 2 / M, undefined);
  });

  it("bills Claude Haiku 5.5 past 100K (cache reads included) and Sonnet 4.5 / 4 past 200K; Claude 4.6+ never", () => {
    check(priced("claude-haiku-5-5", { inputTokens: 1_000, cacheReadTokens: 150_000, outputTokens: M }), (1_000 * 0.5 + 150_000 * 0.05 + M * 2.5) / M, "long-context");
    check(priced("claude-haiku-5-5", { inputTokens: 1_000, cacheReadTokens: 99_000 }), (1_000 * 0.1 + 99_000 * 0.01) / M, undefined);
    check(priced("claude-sonnet-4-5-20250929", { inputTokens: 210_000, cacheWriteTokens: 10_000, outputTokens: M }), (210_000 * 6 + 10_000 * 7.5 + M * 22.5) / M, "long-context");
    check(priced("claude-sonnet-4", { inputTokens: 210_000 }), 210_000 * 6 / M, "long-context");
    check(priced("claude-opus-4-6[1m]", { inputTokens: 900_000 }), 900_000 * 5 / M, undefined);
    check(priced("claude-sonnet-4-6", { inputTokens: 900_000 }), 900_000 * 3 / M, undefined);
  });

  it("prices each model call on its own prompt, not the session's", () => {
    const evs = [call({ id: "a", model: "gpt-6.1-sol", usage: { inputTokens: 200_000 } }), call({ id: "b", model: "gpt-6.1-sol", usage: { inputTokens: 200_000 } }), call({ id: "c", model: "gpt-6.1-sol", usage: { inputTokens: 300_000 } })];
    const out = applyPricing(evs, table);
    assert.deepEqual(out.map((e) => e.payload.priceTier), [undefined, undefined, "long-context"]);
    assert.deepEqual(out.map((e) => e.usage?.costUsd), [0.4, 0.4, 1.2]);
    // A usage snapshot holds running totals: standard rates however big.
    const snap = priceEvent(call({ kind: "notification", model: "gpt-6.1-sol", payload: { type: "usage-summary", serviceTier: "batch" }, usage: { inputTokens: 900_000 } }), table);
    check(snap, 1.8, undefined);
  });

  it("bills batch at half on every Claude model, cache multipliers included, and batch long context on top", () => {
    check(priced("claude-opus-4-5", { inputTokens: M, outputTokens: M, cacheReadTokens: M, cacheWriteTokens: M }, { serviceTier: "batch" }), 2.5 + 12.5 + 0.25 + 3.125, "batch");
    check(priced("claude-opus-5-5", { inputTokens: M, cacheReadTokens: M }, { serviceTier: "batch" }), 2 + 0.1, "batch");
    check(priced("claude-sonnet-4-5", { inputTokens: 300_000, outputTokens: M }, { serviceTier: "batch" }), (300_000 * 3 + M * 11.25) / M, "batch+long-context");
    check(priced("claude-haiku-5-5", { inputTokens: 200_000 }, { serviceTier: "batch" }), 200_000 * 0.25 / M, "batch+long-context");
  });

  it("bills OpenAI batch and flex from the page, with their own long-context rates", () => {
    // Prompt 250K (input + cache), under the 272K threshold.
    check(priced("gpt-6.1-sol", { inputTokens: 100_000, outputTokens: M, cacheReadTokens: 100_000, cacheWriteTokens: 50_000 }, { serviceTier: "batch" }), (100_000 * 1 + M * 5 + 100_000 * 0.05 + 50_000 * 1.25) / M, "batch");
    check(priced("gpt-6.1-sol", { inputTokens: 300_000, outputTokens: M }, { serviceTier: "flex" }), (300_000 * 2 + M * 7.5) / M, "flex+long-context");
    check(priced("gpt-5.4", { inputTokens: 100_000, cacheReadTokens: 100_000 }, { serviceTier: "flex" }), (100_000 * 1.25 + 100_000 * 0.13) / M, "flex");
    check(priced("gpt-5.4", { inputTokens: 300_000, outputTokens: M }, { serviceTier: "batch" }), (300_000 * 2.5 + M * 11.25) / M, "batch+long-context");
    // gpt-5.5-pro lists no long-context batch rate: batch short rates.
    check(priced("gpt-5.5-pro", { inputTokens: 300_000 }, { serviceTier: "batch" }), 300_000 * 15 / M, "batch");
    // Batch lists no cached price for gpt-4.1: cached tokens bill as batch input.
    check(priced("gpt-4.1", { cacheReadTokens: M }, { serviceTier: "batch" }), 1, "batch");
    check(priced("o3", { cacheReadTokens: M }, { serviceTier: "flex" }), 0.25, "flex");
    // A tier the model has no row for keeps standard rates and says nothing.
    check(priced("gpt-4.1", { inputTokens: M }, { serviceTier: "flex" }), 2, undefined);
    check(priced("gpt-5.4", { inputTokens: 300_000 }, { serviceTier: "scale" }), 300_000 * 5 / M, "long-context");
  });

  it("bills OpenAI Fast (priority) and Ultrafast; a `fast` service_tier uses the priority rates", () => {
    check(priced("gpt-5.5", { inputTokens: M, outputTokens: M }, { serviceTier: "priority" }), 12.5 + 75, "priority");
    check(priced("gpt-5.5", { inputTokens: M }, { serviceTier: "fast" }), 12.5, "priority");
    check(priced("gpt-6.1-sol", { inputTokens: 300_000, outputTokens: M }, { serviceTier: "priority" }), (300_000 * 8 + M * 30) / M, "priority+long-context");
    // gpt-5.4 Fast lists no long-context rate.
    check(priced("gpt-5.4", { inputTokens: 300_000 }, { serviceTier: "priority" }), 300_000 * 5 / M, "priority");
    check(priced("gpt-4o-mini", { inputTokens: M, cacheReadTokens: M, outputTokens: M }, { serviceTier: "priority" }), 0.25 + 0.125 + 1, "priority");
    check(priced("gpt-6-astra", { inputTokens: 100_000, outputTokens: M }, { serviceTier: "ultrafast" }), 6 + 300, "ultrafast");
    check(priced("gpt-6.1-sol", { inputTokens: 300_000 }, { serviceTier: "ultrafast" }), 300_000 * 24 / M, "ultrafast+long-context");
    check(priced("gpt-5.5", { inputTokens: 100_000 }, { serviceTier: "ultrafast" }), 0.5, undefined);
  });

  it("bills Anthropic fast mode; Priority Tier (a capacity commitment) keeps standard rates", () => {
    check(priced("claude-opus-5-5", { inputTokens: M, outputTokens: M, cacheReadTokens: M, cacheWriteTokens: M }, { speed: "fast" }), 8 + 40 + 0.4 + 10, "fast");
    check(priced("claude-opus-4-8", { inputTokens: M, outputTokens: M }, { speed: "fast", serviceTier: "priority" }), 10 + 50, "fast");
    check(priced("claude-opus-4-6", { inputTokens: M }, { serviceTier: "priority" }), 5, undefined);
    check(priced("claude-sonnet-5-5", { inputTokens: M }, { speed: "fast" }), 2, undefined);
  });

  it("bills Claude Fable and Mythos 5.2 at their own rates, not Fable 5.1's", () => {
    check(priced("claude-fable-5-2", { inputTokens: M, outputTokens: M }), 8 + 40, undefined);
    check(priced("claude-fable-5-2", { cacheReadTokens: M }), 0.2, undefined);
    check(priced("claude-fable-5-2", { cacheWriteTokens: M }), 10, undefined);
    check(priced("claude-fable-5-2", { cacheWriteTokens: M }, { cacheWrite1hTokens: M }), 16, undefined);
    check(priced("claude-mythos-5-2", { inputTokens: M, outputTokens: M }, { serviceTier: "batch" }), 4 + 20, "batch");
    check(priced("claude-fable-5-2", { inputTokens: M, outputTokens: M, cacheReadTokens: M, cacheWriteTokens: M }, { speed: "fast" }), 16 + 80 + 0.4 + 20, "fast");
    check(priced("claude-fable-5-2", { cacheWriteTokens: M }, { cacheWrite1hTokens: M, speed: "fast" }), 32, "fast");
    check(priced("claude-fable-5-2", { inputTokens: M }, { inferenceGeo: "us", speed: "fast" }), 16 * 1.1, "fast+us-only");
  });

  it("bills Gemini Batch, Flex and Priority, short and long", () => {
    check(priced("gemini-3.8-flash", { inputTokens: M, outputTokens: M }, { serviceTier: "batch" }), 0.375 + 1.875, "batch");
    check(priced("gemini-3.8-flash", { inputTokens: M, outputTokens: M }, { serviceTier: "priority" }), 1.35 + 6.75, "priority");
    check(priced("gemini-3.1-pro", { inputTokens: 300_000, cacheReadTokens: M }, { serviceTier: "flex" }), (300_000 * 2 + M * 0.4) / M, "flex+long-context");
    check(priced("gemini-2.5-pro", { inputTokens: 300_000, outputTokens: M }, { serviceTier: "priority" }), (300_000 * 4.5 + M * 27) / M, "priority+long-context");
    check(priced("gemini-3-flash-preview", { cacheReadTokens: M }, { serviceTier: "batch" }), 0.05, "batch");
  });

  it("drops a stale priceTier when the call is now priced at standard rates", () => {
    const e = priceEvent(call({ model: "gpt-6.1-sol", usage: { inputTokens: 100_000 }, payload: { priceTier: "batch" } }), table);
    check(e, 0.2, undefined);
    assert.equal("priceTier" in e.payload, false);
  });

  it("callRates falls back to the row's long-context threshold for a tier row that omits it", () => {
    const p = { input: 1, output: 1, longContext: { above: 10, input: 2, output: 2 }, tiers: { batch: { input: 0.5, output: 0.5, longContext: { input: 1, output: 1 } } } };
    assert.deepEqual(callRates(p, "batch", 11), { rates: { input: 1, output: 1 }, tier: "batch+long-context" });
    assert.deepEqual(callRates(p, "batch", 10), { rates: p.tiers.batch, tier: "batch" });
    assert.deepEqual(callRates(p, undefined, 11), { rates: p.longContext, tier: "long-context" });
    assert.deepEqual(callRates(p), { rates: p });
    assert.equal(promptTokens({ inputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3, outputTokens: 100 }), 6);
  });
});

describe("Claude 1-hour cache writes and US-only inference", () => {
  const priced = (model: string, usage: AgentEvent["usage"], payload: Record<string, unknown> = {}) => priceEvent(call({ model, usage, payload }), table);
  const check = (e: AgentEvent, usd: number, tier: string | undefined) => {
    close(e.usage?.costUsd, usd);
    assert.equal(e.payload.priceTier, tier);
  };

  it("bills the 1-hour part of the cache writes at 2x input and the rest at 1.25x", () => {
    // Opus 4.5: 5-minute write $6.25, 1-hour write $10.
    check(priced("claude-opus-4-5", { cacheWriteTokens: M }, { cacheWrite1hTokens: 400_000 }), 0.6 * 6.25 + 0.4 * 10, undefined);
    check(priced("claude-opus-4-5", { cacheWriteTokens: M }), 6.25, undefined);
    // More 1-hour tokens than writes: capped at the writes.
    check(priced("claude-opus-4-5", { cacheWriteTokens: M }, { cacheWrite1hTokens: 2 * M }), 10, undefined);
    assert.deepEqual([BUILTIN_PRICES["claude-opus-5-5"]!.cacheWrite1h, BUILTIN_PRICES["claude-haiku-5-5"]!.cacheWrite1h, BUILTIN_PRICES["claude-sonnet-4-6"]!.cacheWrite1h], [8, 0.2, 6]);
  });

  it("stacks the 1-hour multiplier with batch, fast mode and long context", () => {
    check(priced("claude-opus-4-5", { cacheWriteTokens: M }, { cacheWrite1hTokens: M, serviceTier: "batch" }), 5, "batch");
    check(priced("claude-opus-5-5", { cacheWriteTokens: M }, { cacheWrite1hTokens: M, speed: "fast" }), 16, "fast");
    // Haiku 5.5 over 100K: 1-hour write $1.
    check(priced("claude-haiku-5-5", { cacheWriteTokens: 200_000 }, { cacheWrite1hTokens: 200_000 }), 0.2, "long-context");
  });

  it("models with no 1-hour rate bill those tokens as ordinary cache writes", () => {
    check(priced("gpt-6.1-sol", { cacheWriteTokens: 100_000 }, { cacheWrite1hTokens: 100_000 }), 100_000 * 2.5 / M, undefined);
    close(costFrom({ cacheWriteTokens: M }, { input: 1, output: 1 }, M), 1);
  });

  it("bills Claude 4.6+ US-only inference at 1.1x on every token type, on top of tier and long-context rates", () => {
    check(priced("claude-opus-4-6", { inputTokens: M, outputTokens: M, cacheReadTokens: M, cacheWriteTokens: M }, { inferenceGeo: "us" }), (5 + 25 + 0.5 + 6.25) * 1.1, "us-only");
    check(priced("claude-opus-5-5", { inputTokens: M }, { inferenceGeo: "us", speed: "fast" }), 8 * 1.1, "fast+us-only");
    check(priced("claude-opus-4-6", { cacheWriteTokens: M }, { inferenceGeo: "us", cacheWrite1hTokens: M }), 10 * 1.1, "us-only");
    check(priced("claude-haiku-5-5", { inputTokens: 200_000 }, { inferenceGeo: "us", serviceTier: "batch" }), 200_000 * 0.25 * 1.1 / M, "batch+long-context+us-only");
  });

  it("older Claude models, global routing and other providers keep standard rates", () => {
    check(priced("claude-opus-4-5", { inputTokens: M }, { inferenceGeo: "us" }), 5, undefined);
    check(priced("claude-sonnet-4-5", { inputTokens: 100_000 }, { inferenceGeo: "us" }), 0.3, undefined);
    check(priced("claude-opus-4-6", { inputTokens: M }, { inferenceGeo: "global" }), 5, undefined);
    check(priced("gpt-5.5", { inputTokens: 100_000 }, { inferenceGeo: "us" }), 0.5, undefined);
    assert.deepEqual(["us", "US", "global", "not_available", "", undefined, 3].map(geoValue), ["us", "us", undefined, undefined, undefined, undefined, undefined]);
  });
});

describe("tier price overrides", () => {
  const roots: string[] = [];
  after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
  const load = (toml: string) => {
    const root = mkdtempSync(join(tmpdir(), "csh-tiers-"));
    roots.push(root);
    const home = join(root, "data");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.toml"), toml);
    return () => loadConfig({ env: { CODING_SH_HOME: home, HOME: root } });
  };

  it("reads long_context and tier tables, each tier with its own long_context", () => {
    const c = load(`
[prices."house-model"]
input = 3
output = 15
cache_read = 0.3

[prices."house-model".long_context]
above = 200_000
input = 6
output = 22.5

[prices."house-model".batch]
input = 1.5
output = 7.5

[prices."house-model".batch.long_context]
input = 3
output = 11.25

[prices."house-model".priority]
input = 6
output = 30
cache_write = 7.5
`)();
    assert.deepEqual(c.pricing!["house-model"], {
      input: 3,
      output: 15,
      cacheRead: 0.3,
      longContext: { above: 200_000, input: 6, output: 22.5 },
      tiers: { batch: { input: 1.5, output: 7.5, longContext: { input: 3, output: 11.25 } }, priority: { input: 6, output: 30, cacheWrite: 7.5 } },
    });
    const t = pricesFor(c.pricing);
    const at = (usage: AgentEvent["usage"], payload: Record<string, unknown> = {}) => priceEvent(call({ model: "house-model", usage, payload }), t);
    let e = at({ inputTokens: 300_000 }, { serviceTier: "batch" });
    assert.deepEqual([e.usage?.costUsd, e.payload.priceTier], [0.9, "batch+long-context"]);
    e = at({ inputTokens: M }, { serviceTier: "priority" });
    assert.deepEqual([e.usage?.costUsd, e.payload.priceTier], [6, "priority"]);
    e = at({ inputTokens: 300_000 });
    assert.deepEqual([e.usage?.costUsd, e.payload.priceTier], [1.8, "long-context"]);
    e = at({ inputTokens: 100_000 }, { serviceTier: "flex" });
    assert.deepEqual([e.usage?.costUsd, e.payload.priceTier], [0.3, undefined]);
  });

  it("an override with no tier keys replaces the whole built-in row, tiers included", () => {
    const t = pricesFor({ "gpt-6.1-sol": { input: 1, output: 1 } });
    const e = priceEvent(call({ model: "gpt-6.1-sol", usage: { inputTokens: 300_000 }, payload: { serviceTier: "batch" } }), t);
    assert.deepEqual([e.usage?.costUsd, e.payload.priceTier], [0.3, undefined]);
  });

  it("reads cache_write_1h and a geo table", () => {
    const c = load(`
[prices."house-claude"]
input = 2
output = 10
cache_write = 2.5
cache_write_1h = 4

[prices."house-claude".geo]
US = 1.1
`)();
    assert.deepEqual(c.pricing!["house-claude"], { input: 2, output: 10, cacheWrite: 2.5, cacheWrite1h: 4, geo: { us: 1.1 } });
    const e = priceEvent(call({ model: "house-claude", usage: { cacheWriteTokens: M }, payload: { cacheWrite1hTokens: 500_000, inferenceGeo: "us" } }), pricesFor(c.pricing));
    close(e.usage?.costUsd, (0.5 * 2.5 + 0.5 * 4) * 1.1);
    assert.equal(e.payload.priceTier, "us-only");
    assert.throws(load(`[prices."m"]\ninput = 1\noutput = 1\n[prices."m".geo]\nus = 0\n`), /prices\."m"\.geo\.us must be a price multiplier > 0/);
    assert.throws(load(`[prices."m"]\ninput = 1\noutput = 1\ngeo = 1.1\n`), /prices\."m"\.geo must be a table of multipliers/);
  });

  it("rejects incomplete tier tables", () => {
    const cases: [string, RegExp][] = [
      [`[prices."m"]\ninput = 1\noutput = 1\n[prices."m".long_context]\ninput = 2\noutput = 2\n`, /prices\."m"\.long_context needs above/],
      [`[prices."m"]\ninput = 1\noutput = 1\n[prices."m".long_context]\nabove = 0\ninput = 2\noutput = 2\n`, /prices\."m"\.long_context\.above must be a number of prompt tokens > 0/],
      [`[prices."m"]\ninput = 1\noutput = 1\n[prices."m".batch]\ninput = 0.5\n`, /prices\."m"\.batch needs both input and output/],
      [`[prices."m"]\ninput = 1\noutput = 1\nflex = 3\n`, /prices\."m"\.flex must be a table/],
      [`[prices."m"]\ninput = 1\noutput = 1\n[prices."m".batch]\ninput = 0.5\noutput = 0.5\n[prices."m".batch.long_context]\ninput = 1\noutput = 1\n`, /prices\."m"\.batch\.long_context needs above, or prices\."m"\.long_context must set it/],
      [`[prices."m"]\ninput = 1\noutput = 1\n[prices."m".priority]\ninput = -1\noutput = 1\n`, /prices\."m"\.priority\.input must be a number >= 0/],
    ];
    for (const [toml, re] of cases) assert.throws(load(toml), re, toml);
  });
});

describe("default models", () => {
  it("names one current model per provider, each with a built-in price row", () => {
    for (const [provider, model] of Object.entries(DEFAULT_MODELS)) assert.ok(BUILTIN_PRICES[model], `${provider}: ${model} has no price row`);
  });
});
