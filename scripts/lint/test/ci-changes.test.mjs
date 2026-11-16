// scripts/ci-changes.mjs: a pull request that only touches docs or the site skips the code-only
// CI jobs; anything else runs them all. Also checks that ci.yml wires every code-only job to it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { needsCode } from "../../ci-changes.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const SCRIPT = join(ROOT, "scripts/ci-changes.mjs");

test("docs, site and root markdown changes skip the code-only jobs", () => {
  assert.equal(needsCode(["docs/perf.md", "apps/site/src/pages/docs/mcp.astro", "CHANGELOG.md", "README.md"]), false);
  assert.equal(needsCode([".github/ISSUE_TEMPLATE/bug.yml", ".github/PULL_REQUEST_TEMPLATE.md", "LICENSE", ""]), false);
});

test("any code, workflow, script or package file runs everything", () => {
  for (const f of [
    "packages/coding.sh/src/cli/registry.ts",
    "packages/coding.sh/skills/debug/SKILL.md", // served by the MCP server, so not docs
    "packages/coding.sh/README.md", // packed into the npm package
    ".github/workflows/ci.yml",
    "scripts/ci-changes.mjs",
    "package-lock.json",
    "action.yml",
    "Dockerfile",
    "install.sh",
  ]) {
    assert.equal(needsCode(["docs/perf.md", f]), true, f);
  }
});

test("no changed paths runs everything", () => {
  assert.equal(needsCode([]), true);
  assert.equal(needsCode(["", "  "]), true);
});

test("the script prints a GITHUB_OUTPUT line", () => {
  const run = (input) => spawnSync(process.execPath, [SCRIPT], { input, encoding: "utf8" });
  assert.equal(run("docs/a.md\napps/site/x.astro\n").stdout, "code=false\n");
  assert.equal(run("docs/a.md\nsrc/x.ts\n").stdout, "code=true\n");
  assert.equal(run("").stdout, "code=true\n");
});

test("ci.yml gates every code-only job on the changes job, and never skips when unsure", () => {
  const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const job = (name) => new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z][a-z-]*:\\n|$)`).exec(ci)?.[1] ?? "";
  const gate = "if: ${{ !cancelled() && needs.changes.outputs.code != 'false' }}";
  for (const name of ["store-postgres", "store-clickhouse", "python-sdk", "runtime-floor", "release-smoke", "action"]) {
    const body = job(name);
    assert.ok(body, `${name} job`);
    assert.match(body, /\n    needs: changes\n/, `${name} needs changes`);
    assert.ok(body.includes(`\n    ${gate}\n`), `${name} runs unless changes says code=false`);
  }
  // The slow jobs run in the full suite only (a push, a manual run, or the `ready` label). Their
  // condition reads the event and the label, so nothing a pull request changes can skip them there.
  const full = "if: ${{ github.event_name != 'pull_request' || contains(github.event.pull_request.labels.*.name, 'ready') }}";
  for (const name of ["windows", "real-capture", "cli-suite", "image"]) {
    const body = job(name);
    assert.ok(body.includes(`\n    ${full}\n`), `${name} runs in the full suite`);
    assert.doesNotMatch(body, /needs\.changes/, `${name} does not read the changes job`);
  }
  // Windows has one shape: both Node versions, and the shard count each leg is told.
  assert.match(job("windows"), /\n        node: \[22\.x, 24\.x\]\n        shard: \[1, 2, 3, 4\]\n/);
  assert.equal([...job("windows").matchAll(/matrix\.shard \}\}\/4\b/g)].length, 2, "the job name and SHARD");
  // A pull request without the label tests Linux on Node 24; the full suite adds Node 22.
  const narrow = "(github.event_name == 'pull_request' && !contains(github.event.pull_request.labels.*.name, 'ready'))";
  assert.ok(job("test").includes(`node: \${{ fromJSON(${narrow} && '["24.x"]' || '["22.x", "24.x"]') }}\n        shard: [1, 2, 3]\n`));
  // The checks that read docs and the site always run.
  for (const name of ["gate-static", "build", "test"]) assert.doesNotMatch(job(name), /needs: changes/, name);
  // Pushes to main, manual runs and the full suite on a pull request never skip.
  assert.match(job("changes"), /if \[ "\$FULL" != true \] && \[ "\$EVENT" = pull_request \] && files=/);
});
