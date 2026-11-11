// Sample output in the docs is real output. These checks catch the two ways a
// sample went wrong: a verdict a two-case run does not print, and a report
// line that the code no longer prints.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (p) => readFileSync(`${ROOT}${p}`, "utf8");

/** exp compare samples that show a definite verdict on fewer than 10 paired cases. */
export function smallDefinite(text) {
  const out = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const n = line.match(/\((\d+) paired cases/);
    if (!n || Number(n[1]) >= 10) return;
    const verdict = lines.slice(i, i + 8).find((l) => /^verdict /.test(l));
    if (verdict && /^verdict B is (worse|better)/.test(verdict)) out.push(verdict);
  });
  return out;
}

test("smallDefinite flags the old sample verdict", () => {
  const old = "B − A   -100.0pp [-100.0pp, -100.0pp] (2 paired cases, 95% paired bootstrap)\nmcnemar p=0.500  2 regressed, 0 improved\nverdict B is worse";
  assert.deepEqual(smallDefinite(old), ["verdict B is worse"]);
});

/** The pages that show `exp compare` output. */
const COMPARE_SAMPLES = ["apps/site/src/pages/docs/experiments.astro", "apps/site/src/pages/docs/evals.astro", "docs/how-to/test-agents-md-change.md"];

test("no sample compare of under 10 cases shows a definite verdict", () => {
  for (const f of COMPARE_SAMPLES) assert.deepEqual(smallDefinite(read(f)), [], f);
});

test("the sample verdict wording is one the code prints", () => {
  const src = read("packages/coding.sh/src/experiments/render.ts");
  const samples = COMPARE_SAMPLES.flatMap((f) => [...read(f).matchAll(/^verdict (\w+)/gm)].map((m) => [f, m[1]]));
  assert.ok(samples.length >= 2, "no verdict line in the samples");
  for (const [f, word] of samples) assert.ok(src.includes(word), `${f}: the code never prints "verdict ${word}"`);
});

/** The block under "### The report" in the evals guide. */
export function reportSample(md) {
  const i = md.indexOf("### The report");
  const a = md.indexOf("```", i);
  return md.slice(a, md.indexOf("```", a + 3));
}

test("the evals report sample has the lines eval run prints today", () => {
  const sample = reportSample(read("docs/guides/evals.md"));
  const src = ["cli/commands/eval-run.ts", "runner/verifier-output.ts", "eval/run-suite.ts"].map((f) => read(`packages/coding.sh/src/${f}`)).join("\n");
  const needs = ["without a reference solution", "then coding.sh eval import <task dir> and coding.sh eval validate <task>", "Verifier output of failed runs", "captured failures:"];
  for (const phrase of needs) {
    assert.ok(src.includes(phrase) || src.includes(phrase.replace("<task dir>", "<task ")), `the code no longer prints: ${phrase}`);
    assert.ok(sample.includes(phrase), `the report sample is missing: ${phrase}`);
  }
  const old = "add reference.patch to the task dir, then coding.sh eval validate <task>\nharness";
  assert.ok(!sample.includes(old), "the report sample still has the old reference-solution line");
});
