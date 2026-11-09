// Z-22: real prompt caching on the Anthropic model driver, and cost under both
// pricing models (cache-aware and flat) in metrics, compare and reports.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { effectiveModelDriver, runModelTrial } from "../../src/toolevals/drivers/model.ts";
import { computeMetrics } from "../../src/toolevals/metrics.ts";
import { compareToolArms, summarizeArms } from "../../src/toolevals/compare.ts";
import { formatArms, formatToolCompare } from "../../src/toolevals/report.ts";
import { loadToolEvals } from "../../src/toolevals/config.ts";
import { prepareSandbox } from "../../src/toolevals/sandbox.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import type { Driver } from "../../src/toolevals/types.ts";
import { startFakeProvider, type FakeTurn } from "./fixtures/fake-provider.mjs";
import { cleanup, cliTarget, task, tmp, trial } from "./helpers.ts";

after(cleanup);

type ModelDriver = Extract<Driver, { kind: "model" }>;
const PRICES = { "fake-model": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } };

async function run(script: FakeTurn[], driver: Partial<ModelDriver> = {}) {
  const p = await startFakeProvider(script);
  try {
    const t = task();
    const target = cliTarget();
    const id = `trial_cache_${Math.random().toString(36).slice(2)}`;
    const sb = await prepareSandbox(t, target, { name: "base" }, id, tmp());
    const d: ModelDriver = { kind: "model", provider: "anthropic", model: "fake-model", baseUrl: p.url, apiKeyEnv: "FAKE_KEY", ...driver };
    const out = await runModelTrial({ driver: d, task: t, target, sandbox: sb, index: new MemoryIndexStore(), trialId: id, env: { FAKE_KEY: "k" } });
    return { out, requests: p.requests, task: t, target };
  } finally {
    await p.close();
  }
}

const greet = { name: "shell", input: { command: "fake-cli greet --name bob" } };

describe("Anthropic prompt caching", () => {
  it("the default request body has top-level cache_control ephemeral", async () => {
    const { requests } = await run([{ text: "hi" }]);
    assert.deepEqual(requests[0]!.body.cache_control, { type: "ephemeral" });
  });

  it("promptCache = false on the driver removes it", async () => {
    const { requests } = await run([{ text: "hi" }], { promptCache: false });
    assert.equal("cache_control" in requests[0]!.body, false);
  });

  it("promptCache = false on the variant removes it; true on the variant wins over the driver", async () => {
    const base: ModelDriver = { kind: "model", provider: "anthropic", model: "fake-model", apiKeyEnv: "FAKE_KEY" };
    const off = await run([{ text: "hi" }], effectiveModelDriver(base, { promptCache: false }));
    assert.equal("cache_control" in off.requests[0]!.body, false);
    const on = await run([{ text: "hi" }], effectiveModelDriver({ ...base, promptCache: false }, { promptCache: true }));
    assert.deepEqual(on.requests[0]!.body.cache_control, { type: "ephemeral" });
  });

  it("message_delta's cache counts are final on the llm.call usage", async () => {
    const { out } = await run([{ text: "hi", usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, finalCacheRead: 900, finalCacheWrite: 80 } }]);
    const u = out.events.find((e) => e.kind === "llm.call")!.usage!;
    assert.equal(u.cacheReadTokens, 900);
    assert.equal(u.cacheWriteTokens, 80);
    assert.equal(u.inputTokens, 10);
  });
});

describe("cache-aware vs flat cost", () => {
  it("a 3-turn run's costUsd and flatCostUsd match hand values", async () => {
    const { out, task: t, target } = await run([
      { toolCalls: [greet], usage: { input: 100, output: 20, cacheWrite: 2000 } },
      { toolCalls: [greet], usage: { input: 50, output: 30, cacheRead: 2000, cacheWrite: 300 } },
      { text: "hello bob", usage: { input: 40, output: 10, cacheRead: 1, finalCacheRead: 2300 } },
    ]);
    const m = computeMetrics({ task: t, target, tap: [], events: out.events, sessions: [], run: out, checksPass: true, prices: PRICES });
    // input 190, output 60, cache read 4300, cache write 2300 (per-million prices 3 / 15 / 0.3 / 3.75)
    assert.deepEqual(m.usage, { inputTokens: 190, outputTokens: 60, cacheReadTokens: 4300, cacheWriteTokens: 2300 });
    const want = (190 * 3 + 60 * 15 + 4300 * 0.3 + 2300 * 3.75) / 1e6;
    const wantFlat = (190 * 3 + 60 * 15 + 4300 * 3 + 2300 * 3) / 1e6;
    assert.ok(Math.abs(m.costUsd! - want) / want < 0.001, `${m.costUsd} ~ ${want}`);
    assert.ok(Math.abs(m.flatCostUsd! - wantFlat) / wantFlat < 0.001, `${m.flatCostUsd} ~ ${wantFlat}`);
    assert.equal(m.cacheReadShare, 4300 / 6790);
    assert.equal(m.turns, 3);
  });

  it("cacheReadShare is null with no prompt tokens; flatCostUsd null when cost is reported or unknown", () => {
    const base = { task: task(), target: cliTarget(), tap: [], sessions: [], run: { exitCode: 0, timedOut: false, durationMs: 1, stdoutTail: "", stderrTail: "" }, checksPass: true };
    const none = computeMetrics({ ...base, events: [] });
    assert.equal(none.cacheReadShare, null);
    assert.equal(none.flatCostUsd, null);
    const reported = computeMetrics({ ...base, events: [{ id: "x", v: 0, sessionId: "s", ts: 1, agent: "a", kind: "llm.call", payload: { ok: true }, usage: { inputTokens: 5, costUsd: 0.5 } }] });
    assert.equal(reported.costSource, "reported");
    assert.equal(reported.flatCostUsd, null);
  });
});

describe("compare and report", () => {
  const D = "model:anthropic/fake-model";
  // The candidate uses fewer tokens but writes far more cache: cheaper flat, dearer cache-aware.
  const arm = (variant: string, costUsd: number, flatCostUsd: number, cacheWriteTokens: number, tokens: number) =>
    ["a", "b", "c"].map((id) => trial(id, variant, D, 1, true, { usage: { inputTokens: tokens, outputTokens: 10, cacheReadTokens: 100, cacheWriteTokens }, costUsd, flatCostUsd, cacheReadShare: 0.1 }));

  it("flatCostUsd is compared, and the flip note appears when the cheaper arm differs", () => {
    const trials = [...arm("big", 0.01, 0.03, 100, 5000), ...arm("lean", 0.02, 0.02, 5000, 1000)];
    const r = compareToolArms(trials, { baseline: `big@${D}`, candidate: `lean@${D}`, seed: 1 });
    assert.ok(r.metrics.flatCostUsd);
    assert.ok(r.notes.some((n) => n.startsWith("winner flips under flat pricing: the baseline is cheaper with cache-aware prices")));
    assert.match(formatToolCompare(r), /cost \(flat\)/);
    const arms = formatArms(summarizeArms(trials));
    assert.match(arms, /big@model:anthropic\/fake-model: cost \$0\.0100 \(cache-aware\) · \$0\.0300 flat · cache hit/);
    assert.match(arms, /winner flips under flat pricing: big@model:anthropic\/fake-model is cheapest cache-aware, lean@model:anthropic\/fake-model flat/);
    // flat cost is not a regression of its own
    assert.ok(!r.regressions.some((g) => g.metric === "flatCostUsd"));
  });

  it("no cache tokens: the report is byte-identical to one without the new metrics", () => {
    const trials = ["a", "b"].flatMap((id) => [trial(id, "x", D, 1, true, { costUsd: 0.01, flatCostUsd: 0.01 }), trial(id, "y", D, 1, false, { costUsd: 0.02, flatCostUsd: 0.02 })]);
    const strip = trials.map((t) => ({ ...t, metrics: { ...t.metrics, flatCostUsd: undefined, cacheReadShare: undefined, outputCuts: undefined } }));
    const a = compareToolArms(trials, { baseline: `x@${D}`, candidate: `y@${D}`, seed: 1 });
    const b = compareToolArms(strip, { baseline: `x@${D}`, candidate: `y@${D}`, seed: 1 });
    assert.equal(formatToolCompare(a), formatToolCompare(b));
    assert.equal(a.metrics.flatCostUsd, undefined);
    assert.equal(formatArms(summarizeArms(trials)), formatArms(summarizeArms(strip)));
    assert.equal(summarizeArms(trials)[0]!.cost, undefined);
  });
});

describe("promptCache config", () => {
  it("rejects a non-boolean promptCache on a driver", async () => {
    const d = tmp();
    writeFileSync(join(d, "coding.sh.toml"), `[toolevals.targets.x]\nkind = "cli"\nbin = "x"\ncommand = ["x"]\n[toolevals.drivers."model:anthropic/m"]\npromptCache = "yes"\n`);
    await assert.rejects(() => loadToolEvals(d), /promptCache must be true or false/);
  });

  it("parses a boolean promptCache on a driver", async () => {
    const d = tmp();
    writeFileSync(join(d, "coding.sh.toml"), `[toolevals.targets.x]\nkind = "cli"\nbin = "x"\ncommand = ["x"]\n[toolevals.drivers."model:anthropic/m"]\npromptCache = false\n`);
    const cfg = await loadToolEvals(d);
    assert.equal(cfg.drivers["model:anthropic/m"]?.promptCache, false);
    const { parseDriver } = await import("../../src/toolevals/config.ts");
    assert.equal((parseDriver("model:anthropic/m", cfg.drivers) as ModelDriver).promptCache, false);
  });
});
