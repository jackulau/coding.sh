// Input and output tokens, and where each cost number came from (#18):
// reported by the contender, costPerRun in the definition, tokens × the
// shared price table (src/core/pricing.ts), or unknown.
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { parseDefinition } from "../../src/bench/define.ts";
import { buildReport, renderReportHtml } from "../../src/bench/report.ts";
import { runBench } from "../../src/bench/run.ts";
import { listRuns, series } from "../../src/bench/store.ts";
import type { BenchRun } from "../../src/bench/types.ts";
import { BUILTIN_PRICES, costFrom, PRICE_SOURCES } from "../../src/core/pricing.ts";
import { tokenUsage, unwrapAnswer } from "../../src/bench/contenders.ts";
import { cleanup, day, project } from "./helpers.ts";

after(cleanup);

const read = `const input = JSON.parse(require("node:fs").readFileSync(0, "utf8"));`;
const answer = (extra: string) => `${read}\nprocess.stdout.write(JSON.stringify({ output: input.a + input.b, ${extra} }));\n`;

describe("bench cost provenance", () => {
  test("envelopes keep token counts by kind", () => {
    const a = unwrapAnswer({ output: 1, usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 100, costUsd: 0.1 }, model: "m" });
    assert.deepEqual(a.usage, { inputTokens: 10, outputTokens: 2, cacheReadTokens: 100 });
    assert.equal(a.tokens, 12);
    assert.equal(tokenUsage({ totalTokens: 5 } as never), undefined);
    assert.equal(unwrapAnswer({ output: 1, usage: {} }).usage, undefined);
  });

  test("reported, costPerRun, price table and unknown, per call and per contender", async () => {
    const p = project();
    p.write("reported.cjs", answer(`usage: { costUsd: 0.002, inputTokens: 30, outputTokens: 4 }, model: "gpt-5"`));
    p.write("configured.cjs", answer(`usage: { inputTokens: 30, outputTokens: 4 }`));
    p.write("table.cjs", answer(`usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000 }, model: "gpt-5"`));
    p.write("custom.cjs", answer(`usage: { inputTokens: 1000, outputTokens: 1000 }, model: "my-model"`));
    p.write("unknown.cjs", answer(`usage: { inputTokens: 7 }, model: "no-such-model"`));
    const toml = `name = "costs"\ncases = 3\n[source]\nkind = "command"\ncommand = "node gen.mjs"\n${["reported", "configured", "table", "custom", "unknown"]
      .map((n) => `[[contenders]]\nname = "${n}"\ncommand = "node ${n}.cjs"${n === "configured" ? "\ncostPerRun = 0.01" : ""}\n`)
      .join("")}[[graders]]\nkind = "exact"\n`;
    const def = parseDefinition(toml, p.write("bench/costs.toml", toml));
    const r = (await runBench({ def, env: p.env, now: day("2026-11-04"), prices: { ...BUILTIN_PRICES, "my-model": { input: 1, output: 2 } } })) as BenchRun;
    const cells = (n: string) => r.cells.filter((x) => x.contender === n);
    assert.ok(cells("reported").every((x) => x.costSource === "reported" && x.costUsd === 0.002), "a reported cost wins over the price table");
    assert.ok(cells("configured").every((x) => x.costSource === "configured" && x.costUsd === 0.01));
    const want = costFrom({ inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000 }, BUILTIN_PRICES["gpt-5"]!);
    assert.ok(cells("table").every((x) => x.costSource === "price-table" && Math.abs(x.costUsd! - want) < 1e-12));
    assert.ok(cells("custom").every((x) => x.costSource === "price-table" && Math.abs(x.costUsd! - 0.003) < 1e-12), "the caller's price table is used");
    assert.ok(cells("unknown").every((x) => x.costUsd === undefined && x.costSource === undefined));
    assert.ok(r.cells.every((x) => x.usage), "token counts are kept on every cell");
    const sum = (n: string) => r.summaries.find((s) => s.contender === n)!;
    assert.deepEqual(sum("reported").costUsd.sources, { reported: 3 });
    assert.deepEqual(sum("configured").costUsd.sources, { configured: 3 });
    assert.deepEqual(sum("table").costUsd.sources, { "price-table": 3 });
    assert.deepEqual(sum("unknown").costUsd.sources, { unknown: 3 });
    assert.equal(sum("unknown").costUsd.known, 0);
    // Input counts cache reads too; output is its own column.
    assert.deepEqual(sum("table").tokensIn, { total: 18000, mean: 6000, known: 3 });
    assert.deepEqual(sum("table").tokensOut, { total: 600, mean: 200, known: 3 });
    assert.equal(sum("unknown").tokensOut.known, 0);
    assert.deepEqual(r.pricing, { updated: Object.fromEntries(Object.entries(PRICE_SOURCES).map(([k, v]) => [k, v.updated])) });
    const runs = await listRuns("costs", p.env);
    assert.deepEqual(series(runs, "tokens-out").table!.map((x) => x.value), [200]);
    assert.deepEqual(series(runs, "tokens-in").reported!.map((x) => x.value), [30]);
    const html = renderReportHtml(buildReport(runs));
    assert.match(html, /Tokens in \/ out/);
    assert.match(html, /<dt>Cost<\/dt><dd>3 reported, 3 costPerRun, 6 price table, 3 unknown calls; price table: tokens × list price per model/);
  });

  test("without tokens or a known model there is nothing to price, and no pricing stamp", async () => {
    const p = project();
    const r = (await runBench({ def: p.def(), env: p.env, now: day("2026-11-04") })) as BenchRun;
    // helpers: good reports cost and tokens; bad reports cost only.
    assert.ok(r.cells.every((x) => x.costSource === "reported"));
    assert.equal(r.pricing, undefined);
    assert.equal(r.summaries.find((s) => s.contender === "bad")!.tokensIn.known, 0);
  });
});
