// Sample output in the docs is real output. These checks catch the ways a
// sample went wrong: a verdict a two-case run does not print, a report line
// that the code no longer prints, and a count the CLI words another way.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (p) => readFileSync(`${ROOT}${p}`, "utf8");

/** Every page of the site, as a path from the repo root. */
const SITE_PAGES = readdirSync(`${ROOT}apps/site/src/pages`, { recursive: true })
  .filter((f) => f.endsWith(".astro"))
  .map((f) => `apps/site/src/pages/${f.replaceAll("\\", "/")}`);

/** The site's lines that match re, as "path:line: text". */
const siteLines = (re) =>
  SITE_PAGES.flatMap((f) => read(f).split("\n").flatMap((l, i) => (re.test(l) ? [`${f}:${i + 1}: ${l.trim()}`] : [])));

/**
 * A regex for a sample of the line `out.ok(`template`)` prints: ✓, then the template's text as
 * written, one word for each `${…}`. The sample may open or close a JS template string.
 */
export function okLine(template) {
  const text = template
    .split(/\$\{[^}]*\}/)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\S+");
  return new RegExp(`(^|\`)✓ ${text}(\`;?)?$`);
}

test("okLine matches the line the template prints, and not the old one", () => {
  const line = okLine("Captured session ${r.sessionId} (the command ran ${duration(r.durationMs)}, exit ${r.signal ?? r.exitCode})");
  assert.match("✓ Captured session 7ef38e2f (the command ran 573ms, exit 0)", line);
  assert.match("const out = `✓ Captured session 7ef38e2f (the command ran 2.4s, exit 1)", line);
  assert.doesNotMatch("✓ Captured session 7ef38e2f (573ms, exit 0)", line);
});

test("the coding.sh run samples show the line run prints", () => {
  const template = read("packages/coding.sh/src/cli/commands/run.ts").match(/out\.ok\(`(Captured session [^`]*)`\)/)?.[1];
  assert.ok(template, "run.ts no longer prints a Captured session line");
  const samples = siteLines(/Captured session [0-9a-f]/);
  assert.ok(samples.length >= 2, "no coding.sh run sample on the site");
  assert.deepEqual(samples.filter((s) => !okLine(template).test(s.replace(/^.*?:\d+: /, ""))), []);
});

test("a count of one in a sample is singular, as show and tree print it", () => {
  const words = ["tool call", "tool", "file", "subagent"];
  const src = ["show.ts", "tree.ts"].map((f) => read(`packages/coding.sh/src/cli/commands/${f}`)).join("\n");
  for (const w of words) assert.match(src, new RegExp(`plural\\([^,()]+, "${w}"\\)`), `show and tree no longer count "${w}" with plural()`);
  assert.deepEqual(siteLines(new RegExp(`(?<![\\d.,])\\b1 (${words.join("|")})s\\b`)), []);
});

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
