// Sampling: same seed → same cases in any input order; a new day → new
// cases; duplicates collapse; seen keys are skipped; caps apply after the
// seeded shuffle; strata get equal shares.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { dedupeKey, resolveSeed, sampleCases, seededShuffle } from "../../src/bench/sample.ts";
import { normalizeCase } from "../../src/datasets/dataset.ts";
import type { Case } from "../../src/datasets/types.ts";

const pool = (n: number, meta: (i: number) => Record<string, unknown> = () => ({})): Case[] => Array.from({ length: n }, (_, i) => normalizeCase({ input: { i }, metadata: meta(i) }));
const ids = (r: ReturnType<typeof sampleCases>) => r.cases.map((c) => c.case.id);

describe("bench sampling", () => {
  test("is deterministic for a seed and independent of input order", () => {
    const p = pool(100);
    const a = sampleCases(p, { n: 10, seed: "arith:2026-11-04" });
    const b = sampleCases([...p].reverse(), { n: 10, seed: "arith:2026-11-04" });
    assert.equal(a.cases.length, 10);
    assert.deepEqual(ids(a), ids(b));
  });

  test("a new day's seed picks different cases", () => {
    const p = pool(200);
    const d1 = new Set(ids(sampleCases(p, { n: 20, seed: resolveSeed("date", { name: "x", date: "2026-11-04", runId: "r" }) })));
    const d2 = ids(sampleCases(p, { n: 20, seed: resolveSeed("date", { name: "x", date: "2026-11-05", runId: "r" }) }));
    const overlap = d2.filter((x) => d1.has(x)).length;
    assert.ok(overlap < 10, `days overlap on ${overlap} of 20`);
  });

  test("seed modes", () => {
    assert.equal(resolveSeed("date", { name: "a", date: "2026-11-04", runId: "r1" }), "a:2026-11-04");
    assert.equal(resolveSeed("run", { name: "a", date: "2026-11-04", runId: "r1" }), "a:r1");
    assert.equal(resolveSeed("fixed-7", { name: "a", date: "2026-11-04", runId: "r1" }), "fixed-7");
  });

  test("duplicates collapse and seen keys are skipped (freshness)", () => {
    const p = [...pool(30), ...pool(5)]; // the last 5 repeat the first 5
    const first = sampleCases(p, { n: 10, seed: "s" });
    assert.equal(first.duplicates, 5);
    const seen = new Set(first.cases.map((c) => c.key));
    const second = sampleCases(p, { n: 10, seed: "s", seen });
    assert.equal(second.excludedSeen, 10);
    assert.ok(second.cases.every((c) => !seen.has(c.key)), "no case repeats");
  });

  test("dedupeBy uses the named field", () => {
    const p = pool(6, (i) => ({ url: `https://x.test/${i % 3}` }));
    assert.equal(dedupeKey(p[0]!, "metadata.url"), "https://x.test/0");
    const r = sampleCases(p, { n: 10, seed: "s", dedupeBy: "metadata.url" });
    assert.equal(r.cases.length, 3);
    assert.equal(r.duplicates, 3);
  });

  test("caps apply in seeded order, so a capped host keeps random pages, not the first ones", () => {
    const p = pool(60, (i) => ({ host: i < 50 ? "big.test" : `h${i}.test` }));
    const a = sampleCases(p, { n: 20, seed: "s1", caps: [{ field: "metadata.host", n: 3 }] });
    assert.equal(a.cases.filter((c) => c.case.metadata!.host === "big.test").length, 3);
    assert.equal(a.cases.length, 13);
    assert.equal(a.capped, 47);
    const b = sampleCases(p, { n: 20, seed: "s2", caps: [{ field: "metadata.host", n: 3 }] });
    const bigOf = (r: typeof a) => r.cases.filter((c) => c.case.metadata!.host === "big.test").map((c) => c.case.id).sort();
    assert.notDeepEqual(bigOf(a), bigOf(b), "different seeds keep different pages of the capped host");
  });

  test("stratify gives each stratum an equal share", () => {
    const p = pool(90, (i) => ({ cat: i < 80 ? "common" : i < 85 ? "rare" : "tiny" }));
    const r = sampleCases(p, { n: 12, seed: "s", stratify: "metadata.cat" });
    assert.deepEqual(r.strata, { common: 4, rare: 4, tiny: 4 });
  });

  test("seededShuffle is a stable permutation", () => {
    const xs = Array.from({ length: 20 }, (_, i) => i);
    const a = seededShuffle(xs, "k");
    assert.deepEqual(a, seededShuffle(xs, "k"));
    assert.deepEqual([...a].sort((x, y) => x - y), xs);
    assert.notDeepEqual(a, seededShuffle(xs, "other"));
  });
});
