// scripts/ci-full-suite.mjs and the job of ci.yml that runs it: the check main requires passes
// only when every job passed, and does not exist on a pull request without the `ready` label.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { notPassed } from "../../ci-full-suite.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const SCRIPT = join(ROOT, "scripts/ci-full-suite.mjs");
const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
const run = (needs) => spawnSync(process.execPath, [SCRIPT], { env: { ...process.env, NEEDS: needs }, encoding: "utf8" });
const ok = { result: "success", outputs: {} };

test("every job in success passes", () => {
  assert.deepEqual(notPassed({ test: ok, build: ok }), []);
  const r = run(JSON.stringify({ test: ok, build: ok }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "full suite: every job passed\n");
});

test("a failed, cancelled or skipped job fails it and is named", () => {
  for (const result of ["failure", "cancelled", "skipped"]) {
    assert.deepEqual(notPassed({ test: ok, windows: { result } }), [`windows: ${result}`]);
    const r = run(JSON.stringify({ test: ok, windows: { result } }));
    assert.equal(r.status, 1, result);
    assert.match(r.stderr, new RegExp(`full suite: 1 job did not pass\\n  windows: ${result}\\n`));
  }
  assert.deepEqual(notPassed({ a: { result: "failure" }, b: {}, c: ok }), ["a: failure", "b: no result"]);
});

test("a job named in MAY_SKIP may end skipped, and nothing else changes", () => {
  const skipped = { result: "skipped" };
  assert.deepEqual(notPassed({ test: ok, "site-perf": skipped }, ["site-perf"]), []);
  assert.deepEqual(notPassed({ test: ok, "site-perf": ok }, ["site-perf"]), []);
  // Only skipped is excused, and only for the named job.
  for (const result of ["failure", "cancelled"]) assert.deepEqual(notPassed({ test: ok, "site-perf": { result } }, ["site-perf"]), [`site-perf: ${result}`]);
  assert.deepEqual(notPassed({ test: skipped, "site-perf": skipped }, ["site-perf"]), ["test: skipped"]);
  // A name that is not a job is a mistake in the workflow, not a pass.
  assert.throws(() => notPassed({ test: ok }, ["site-perf"]), /MAY_SKIP names site-perf, not a job in NEEDS/);
  const run2 = (maySkip) => spawnSync(process.execPath, [SCRIPT], { env: { ...process.env, NEEDS: JSON.stringify({ test: ok, "site-perf": skipped }), MAY_SKIP: maySkip }, encoding: "utf8" });
  assert.equal(run2("site-perf").status, 0);
  assert.equal(run2("").status, 1);
  assert.match(run2("").stderr, /site-perf: skipped/);
  assert.equal(run2("nope").status, 1);
});

test("no jobs, or a NEEDS that cannot be read, fails it", () => {
  for (const needs of ["", "{}", "[]", "null", "not json"]) assert.equal(run(needs).status, 1, JSON.stringify(needs));
  const env = { ...process.env };
  delete env.NEEDS;
  assert.equal(spawnSync(process.execPath, [SCRIPT], { env, encoding: "utf8" }).status, 1);
});

const jobs = ci.slice(ci.indexOf("\njobs:\n"));
const jobIds = [...jobs.matchAll(/^  ([a-z][a-z-]*):$/gm)].map((m) => m[1]);
// A job's lines, each with the newline before it.
const job = (name) => new RegExp(`\\n  ${name}:(\\n[\\s\\S]*?)(?=\\n  [a-z][a-z-]*:\\n|$)`).exec(jobs)?.[1] ?? "";
const FULL = "github.event_name != 'pull_request' || contains(github.event.pull_request.labels.*.name, 'ready')";

test("ci.yml's full-suite job needs every other job", () => {
  const needs = /\n    needs: \[([^\]]+)\]\n/.exec(job("full-suite"))?.[1].split(",").map((s) => s.trim());
  assert.ok(jobIds.length > 10, "the jobs of ci.yml were read");
  assert.deepEqual([...(needs ?? [])].sort(), jobIds.filter((id) => id !== "full-suite").sort());
  assert.match(job("full-suite"), /NEEDS: \$\{\{ toJSON\(needs\) \}\}\n(?:\s+#.*\n)*\s+MAY_SKIP: .*\n\s+run: node scripts\/ci-full-suite\.mjs\n/);
  // Site perf is the one job that may be skipped, and only off a pull request, where
  // site-perf.yml measures the push itself. The condition reads the event, not a job's output.
  assert.ok(job("full-suite").includes("\n          MAY_SKIP: ${{ github.event_name != 'pull_request' && 'site-perf' || '' }}\n"));
});

test("the check is named \"full suite\" only when the full suite runs, and then it always runs", () => {
  const body = job("full-suite");
  // The name and the condition read the same thing, and neither reads another job's output: a
  // failed job must not be able to skip this one under the required name.
  assert.ok(body.includes(`\n    name: \${{ (${FULL}) && 'full suite' || 'full suite (not run, add the ready label)' }}\n`));
  assert.ok(body.includes(`\n    if: \${{ always() && (${FULL}) }}\n`));
  assert.doesNotMatch(body, /needs\.[a-z-]+\.outputs/);
  // No other job can report under the required name.
  assert.equal([...ci.matchAll(/^    name: .*$/gm)].filter((m) => /'full suite'|name: full suite$/.test(m[0])).length, 1);
});

test("the ready label starts a run, and the full suite skips no job", () => {
  assert.match(ci, /\n  pull_request:\n(?:    #.*\n)*    types: \[opened, synchronize, reopened, labeled\]\n/);
  assert.ok(ci.includes(`\nenv:\n  FULL: \${{ ${FULL} }}\n`));
  assert.match(job("changes"), /if \[ "\$FULL" != true \] && \[ "\$EVENT" = pull_request \] && files=/);
});
