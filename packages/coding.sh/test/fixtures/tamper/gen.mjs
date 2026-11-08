#!/usr/bin/env node
// Regenerate the tamper fixtures from this repository's own history: each case
// is one test file in one commit, as `git show` has it. diff.patch is that
// file's diff against the commit's parent, post is the file at the commit, and
// meta.json says whether the commit only added test cases (by reading the
// commit, not by running the detector).
//
//   node packages/coding.sh/test/fixtures/tamper/gen.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const git = (...a) => execFileSync("git", ["-c", "core.quotePath=false", ...a], { cwd: join(here, "../../../../.."), encoding: "utf8", maxBuffer: 64 << 20 });

/** [name, commit, repo path, only adds tests?, what the commit did] */
const CASES = [
  ["gate-regression-test", "0561e4f", "packages/coding.sh/test/runner/experiment.test.ts", true, "fix(compare): adds one regression test inside an existing describe"],
  ["intent-new-cases", "226699b", "packages/coding.sh/test/core/intent.test.ts", true, "adds test cases to an existing suite"],
  ["purge-new-cases", "0596392", "packages/coding.sh/test/store/purge.test.ts", true, "adds tests to an existing describe"],
  ["judge-new-case", "1c3a5b6", "packages/coding.sh/test/judge/judge.test.ts", true, "adds a test to an existing describe"],
  ["pricing-import-and-describe", "79100ec", "packages/coding.sh/test/core/pricing.test.ts", true, "extends an import line and adds a describe at the end"],
  ["experiment-expectation-changed", "ba563a7", "packages/coding.sh/test/runner/experiment.test.ts", false, "changes an existing assertion's expected note"],
  ["repair-match-changed", "a0014c7", "packages/coding.sh/test/runner/repair.test.ts", false, "changes an existing assert.match pattern"],
];

for (const [name, commit, path, additive, what] of CASES) {
  const dir = join(here, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const sha = git("rev-parse", "--short", commit).trim();
  const patch = git("diff", "--no-color", "--no-renames", "--relative=packages/coding.sh", `${sha}~1`, sha, "--", path);
  const post = git("show", `${sha}:${path}`);
  writeFileSync(join(dir, "diff.patch"), patch);
  writeFileSync(join(dir, "post"), post);
  writeFileSync(join(dir, "meta.json"), `${JSON.stringify({ path: path.replace(/^packages\/coding\.sh\//, ""), additive, commit: sha, what }, null, 2)}\n`);
}
