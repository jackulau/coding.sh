// src/data/compare.ts is example data written by hand, not an experiment's
// export. Its header must not say it is a real experiment unless it names the
// `exp export` it came from, and the landing must not call its numbers measured.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

/** The leading // comment block of a file. */
export function header(ts) {
  const out = [];
  for (const line of ts.split("\n")) {
    if (!line.startsWith("//")) break;
    out.push(line);
  }
  return out.join("\n");
}

/** True when a header presents its data as a real experiment without naming an export it came from. */
export function claimsExperiment(head) {
  const claims = /\b(?:real|actual|measured)\b[^.\n]*\bexperiment\b|\bexperiment\b[^.\n]*\b(?:we|was|were) (?:ran|run|measured)\b|'s experiment:|experiment: coding\.sh/i.test(head);
  const names = /\bexp (?:export|show)\b|exp_[0-9A-Z]{10,}/.test(head);
  return claims && !names;
}

/** Landing lines that call the example numbers measured or ours. */
export function measuredClaims(text) {
  return text.split("\n").filter((l) => /\b(?:we|our team) (?:ran|measured|tested)\b|\bmeasured (?:on|over|across)\b|\bour (?:own )?(?:experiment|results?)\b/i.test(l));
}

test("claimsExperiment flags the old header and passes the reworded one", () => {
  assert.equal(claimsExperiment("// The Compare section's experiment: coding.sh's own AGENTS.md, before and after a\n// rewrite, on 20 coding.sh tasks, 5 runs each."), true);
  assert.equal(claimsExperiment("// A real 20 x 5 experiment on coding.sh tasks."), true);
  assert.equal(claimsExperiment("// A real experiment, exported with `coding.sh exp export exp_01M6T953P384HSAZNNEY1H3PJ6`."), false);
  assert.equal(claimsExperiment("// Example numbers written by hand. Not an experiment export."), false);
});

test("compare.ts does not claim a real experiment", () => {
  const head = header(readFileSync(`${SRC}data/compare.ts`, "utf8"));
  assert.ok(head.length > 0, "no header comment");
  assert.equal(claimsExperiment(head), false, `compare.ts header claims an experiment it does not name:\n${head}`);
  assert.match(head, /by hand|not an experiment/i, "the header should say the numbers are written by hand");
});

test("the landing does not call the compare numbers measured", () => {
  assert.deepEqual(measuredClaims(readFileSync(`${SRC}pages/index.astro`, "utf8")), []);
  assert.deepEqual(measuredClaims("We ran 20 tasks and measured over five runs."), ["We ran 20 tasks and measured over five runs."]);
});

test("the result panel is labeled as what coding.sh reports, not a measurement", () => {
  const page = readFileSync(`${SRC}pages/index.astro`, "utf8");
  assert.match(page, /<p class="result__label">what coding\.sh reports<\/p>/);
});
