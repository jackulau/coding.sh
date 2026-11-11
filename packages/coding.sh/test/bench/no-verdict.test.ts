// A run that excluded over 10% of its cases draws no verdict. The pair line
// says so and why, instead of "no significant difference" next to p < 0.001.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { assignPlaces, comparePairs, pairVerdictText } from "../../src/bench/stats.ts";
import type { Cell } from "../../src/bench/types.ts";

const cell = (caseId: string, contender: string, pass: boolean): Cell => ({ caseId, contender, trial: 1, position: 0, pass, score: pass ? 1 : 0, latencyMs: 10 });

describe("bench: no verdict when too many cases were excluded", () => {
  const cells = Array.from({ length: 40 }, (_, i) => [cell(`c${i}`, "a", true), cell(`c${i}`, "b", false)]).flat();

  test("the pair carries the reason and the line does not say no significant difference", () => {
    const [p] = comparePairs(cells, ["a", "b"], { trials: 1, dataset: { id: "d", version: "v" }, graders: [], noVerdict: "7 of 47 cases excluded, over 10%", iters: 200 });
    assert.ok(p!.pAdj < 0.001);
    assert.equal(p!.verdict, "no-verdict");
    assert.equal(p!.withheld, "7 of 47 cases excluded, over 10%");
    assert.equal(pairVerdictText(p!), "no verdict (7 of 47 cases excluded, over 10%)");
  });

  test("--json and report.json say no-verdict, not tie, and a withheld pair splits no places", () => {
    const [p] = comparePairs(cells, ["a", "b"], { trials: 1, dataset: { id: "d", version: "v" }, graders: [], noVerdict: "7 of 47 cases excluded, over 10%", iters: 200 });
    const doc = JSON.parse(JSON.stringify({ pairs: [p] })) as { pairs: { verdict: string; withheld?: string }[] };
    assert.equal(doc.pairs[0]!.verdict, "no-verdict");
    const sum = (contender: string, rate: number) => ({ contender, passRate: { p: rate }, meanScore: rate }) as Parameters<typeof assignPlaces>[0][number];
    assert.deepEqual(assignPlaces([sum("a", 1), sum("b", 0)], [p!]).map((s) => s.place), [1, 1]);
  });

  test("a decided pair has no withheld field", () => {
    const [p] = comparePairs(cells, ["a", "b"], { trials: 1, dataset: { id: "d", version: "v" }, graders: [], iters: 200 });
    assert.equal(p!.withheld, undefined);
    assert.equal(pairVerdictText(p!), "a ahead");
    assert.equal(pairVerdictText({ ...p!, verdict: "tie" }), "no significant difference");
  });
});
