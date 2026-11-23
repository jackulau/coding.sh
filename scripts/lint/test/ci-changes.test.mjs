// scripts/ci-changes.mjs: a pull request that only touches docs or the site skips the code-only
// CI jobs; anything else runs them all. Also checks that ci.yml wires every code-only job to it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { needsCode, needsSitePerf, SITE_PERF_PATHS, sitePerfPath } from "../../ci-changes.mjs";

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
  assert.equal(run("docs/a.md\napps/site/x.astro\n").stdout, "code=false\nsite_perf=true\n");
  assert.equal(run("docs/a.md\nsrc/x.ts\n").stdout, "code=true\nsite_perf=false\n");
  assert.equal(run("docs/a.md\napps/site/src/content/blog/a.md\n").stdout, "code=false\nsite_perf=false\n");
  assert.equal(run("").stdout, "code=true\nsite_perf=true\n");
});

test("a pull request gets Site perf when it touches what the five measured pages are built from", () => {
  for (const f of [
    "apps/site/src/components/Hero.astro",
    "apps/site/src/data/site.ts",
    "apps/site/astro.config.mjs",
    "apps/site/src/pages/index.astro",
    "apps/site/src/pages/docs/cli.astro",
    "scripts/perf/budgets.json",
    ".github/workflows/site-perf.yml",
  ]) {
    assert.equal(sitePerfPath(f), true, f);
    assert.equal(needsSitePerf(["README.md", f]), true, f);
  }
  for (const f of [
    "apps/site/test/links.test.mjs",
    "apps/site/scripts/shots/home.mjs",
    "apps/site/scripts/perf-budget.mjs",
    "apps/site/src/content/blog/a.md",
    "apps/site/src/pages/docs/mcp.astro", // a page that is not measured
    "apps/site/src/pages/index.astro.bak",
    "apps/sitemap.ts",
    "scripts/performance.mjs",
    "packages/coding.sh/src/cli/registry.ts",
    "CHANGELOG.md",
  ]) {
    assert.equal(sitePerfPath(f), false, f);
  }
  assert.equal(needsSitePerf(["apps/site/test/a.test.mjs", "docs/perf.md"]), false);
  // A diff that cannot be read is measured.
  assert.equal(needsSitePerf([]), true);
  assert.equal(needsSitePerf(["", "  "]), true);
});

test("the Site perf paths are the ones site-perf.yml runs for on a push", () => {
  const yml = readFileSync(join(ROOT, ".github/workflows/site-perf.yml"), "utf8");
  const push = /\n  push:\n    branches: \[main\]\n    paths:\n((?:      .*\n)+)/.exec(yml)?.[1] ?? "";
  const paths = push.split("\n").map((line) => /^      - "(.+)"$/.exec(line)?.[1]).filter(Boolean);
  assert.ok(paths.length > 10, "the push paths of site-perf.yml were read");
  assert.deepEqual(SITE_PERF_PATHS, paths);
  // Each entry is one of the two shapes sitePerfPath understands.
  for (const entry of SITE_PERF_PATHS) assert.match(entry, /^!?[^*!]+(\/\*\*)?$/, entry);
});

test("ci.yml calls Site perf for pull requests, and site-perf.yml no longer starts on one", () => {
  const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const yml = readFileSync(join(ROOT, ".github/workflows/site-perf.yml"), "utf8");
  const body = new RegExp("\\n  site-perf:\\n([\\s\\S]*?)(?=\\n  [a-z][a-z-]*:\\n|$)").exec(ci)?.[1] ?? "";
  assert.ok(body.includes("    needs: changes\n"));
  // With the label the changes job reports site_perf=true without reading the diff; the job
  // runs unless it was told false, and never on a push (site-perf.yml measures main itself).
  assert.ok(body.includes("    if: ${{ !cancelled() && github.event_name == 'pull_request' && needs.changes.outputs.site_perf != 'false' }}\n"));
  assert.ok(body.includes("    uses: ./.github/workflows/site-perf.yml\n"));
  assert.match(ci, /\n      site_perf: \$\{\{ steps\.diff\.outputs\.site_perf \}\}\n/);
  assert.match(ci, /\n          else\n            printf 'code=true\\nsite_perf=true\\n' \| tee -a "\$GITHUB_OUTPUT"\n/);
  // One trigger per event: two Site perf runs on one pull request would cancel each other.
  const on = yml.slice(yml.indexOf("\non:\n"), yml.indexOf("\npermissions:\n"));
  assert.match(on, /\n  workflow_call:\n/);
  assert.doesNotMatch(on, /\n  pull_request/);
});

test("ci.yml gates every code-only job on the changes job, and never skips when unsure", () => {
  const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const job = (name) => new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z][a-z-]*:\\n|$)`).exec(ci)?.[1] ?? "";
  const gate = "if: ${{ !cancelled() && needs.changes.outputs.code != 'false' }}";
  for (const name of ["stores", "python-sdk", "runtime-floor", "action"]) {
    const body = job(name);
    assert.ok(body, `${name} job`);
    assert.match(body, /\n    needs: changes\n/, `${name} needs changes`);
    assert.ok(body.includes(`\n    ${gate}\n`), `${name} runs unless changes says code=false`);
  }
  // The slow jobs run in the full suite only (the `ready` label, or a manual run). Their
  // condition reads the event and the label, so nothing a pull request changes can skip them there.
  const full = "if: ${{ github.event_name == 'workflow_dispatch' || contains(github.event.pull_request.labels.*.name, 'ready') }}";
  for (const name of ["windows", "cli-suite", "image"]) {
    const body = job(name);
    assert.ok(body.includes(`\n    ${full}\n`), `${name} runs in the full suite`);
    assert.doesNotMatch(body, /needs\.changes/, `${name} does not read the changes job`);
  }
  // A push to main is a merge the full suite passed on, so it runs the quick jobs and one slow
  // job, the real captures: every event but a pull request without the label. Their Windows leg
  // is the push's only Windows job, and it saves the two caches a full suite restores there.
  const andPush = "if: ${{ github.event_name != 'pull_request' || contains(github.event.pull_request.labels.*.name, 'ready') }}";
  assert.ok(job("real-capture").includes(`\n    ${andPush}\n`), "real-capture also runs on a push");
  assert.doesNotMatch(job("real-capture"), /needs\.changes/);
  assert.equal(ci.split(andPush).length - 1, 1, "no other job runs on a push and skips the quick run");
  assert.match(job("real-capture"), /\n          - \{ os: windows-latest, part: 1 \}\n/);
  const winCapture = job("real-capture");
  assert.ok(winCapture.includes("\n      - uses: actions/setup-node@v5\n        with:\n          node-version: 24.x\n          cache: npm\n"), "saves the npm cache");
  assert.ok(winCapture.includes("\n      - uses: astral-sh/setup-uv@v7\n"), "saves the uv cache");
  // Windows has one shape: both Node versions, and the shard count each leg is told.
  assert.match(job("windows"), /\n        node: \[22\.x, 24\.x\]\n        shard: \[1, 2, 3, 4\]\n/);
  assert.equal([...job("windows").matchAll(/matrix\.shard \}\}\/4\b/g)].length, 2, "the job name and SHARD");
  // A pull request without the label and a push test Linux on Node 24; the full suite adds Node 22.
  const wide = "(github.event_name == 'workflow_dispatch' || contains(github.event.pull_request.labels.*.name, 'ready'))";
  assert.ok(job("test").includes(`node: \${{ fromJSON(${wide} && '["22.x", "24.x"]' || '["24.x"]') }}\n`));
  // The quick run of a pull request, the one a person waits on, splits the Linux files into six
  // legs. The full suite and a push keep three per Node. `of` is the count each leg is told: a
  // list that disagreed with it would run some files twice or not at all.
  const quick = "(github.event_name == 'pull_request' && !contains(github.event.pull_request.labels.*.name, 'ready'))";
  const esc = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pick = `\\$\\{\\{ fromJSON\\(${esc(quick)} && '(\\[[^']+\\])' \\|\\| '(\\[[^']+\\])'\\) \\}\\}\\n`;
  const lists = new RegExp(`\\n        shard: ${pick}        of: ${pick}`).exec(job("test"));
  assert.ok(lists, "the shard list and its count read the same condition");
  const [quickShards, restShards, quickOf, restOf] = lists.slice(1).map((x) => JSON.parse(x));
  assert.deepEqual(quickShards, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(restShards, [1, 2, 3]);
  assert.deepEqual(quickOf, [quickShards.length]);
  assert.deepEqual(restOf, [restShards.length]);
  assert.equal([...job("test").matchAll(/matrix\.shard \}\}\/\$\{\{ matrix\.of \}\}/g)].length, 2, "the job name and SHARD");
  assert.doesNotMatch(job("test"), /matrix\.shard \}\}\/\d/, "no leg is told a fixed count");
  // The Node 24 legs launch the bundle they build; the Node 22 legs launch from source. The
  // variable is the one test/_cli.ts reads, and it is written only by that step: a job-level
  // `env:` would hand the Node 22 legs an empty value.
  const cliEnv = /export const TEST_CLI_ENV = "([A-Z_]+)";/.exec(readFileSync(join(ROOT, "packages/coding.sh/test/_cli.ts"), "utf8"))?.[1];
  assert.equal(cliEnv, "CODING_SH_TEST_CLI");
  assert.ok(job("test").includes(`\n      - name: Build the CLI the tests launch\n        if: matrix.node == '24.x'\n        working-directory: packages/coding.sh\n        run: |\n          npm run build\n          echo "${cliEnv}=$PWD/dist/cli.mjs" >> "$GITHUB_ENV"\n\n`));
  assert.ok(job("test").indexOf("Build the CLI the tests launch") < job("test").indexOf("run: node scripts/test-ci.mjs"), "built before the tests run");
  assert.equal([...ci.matchAll(new RegExp(cliEnv, "g"))].length, 2, "the comment and the step, nowhere else");
  // The checks that read docs and the site always run.
  for (const name of ["gate-static", "build", "site", "test"]) {
    assert.ok(job(name), `${name} job`);
    assert.doesNotMatch(job(name), /needs: changes/, name);
  }
  // Pushes to main, manual runs and the full suite on a pull request skip no job for the diff:
  // only a pull request reads its diff, whatever FULL says.
  assert.match(job("changes"), /if \[ "\$FULL" != true \] && \[ "\$EVENT" = pull_request \] && files=/);
  // pipefail (`shell: bash`): a failing scripts/ci-changes.mjs fails the step. On the default
  // shell the step took tee's status and passed, with no output or part of it.
  assert.match(job("changes"), /\n      - name: Docs or code\n        id: diff\n        shell: bash\n/, "the step runs with pipefail");
});

test("ci.yml starts Chrome before the tests in every job that runs them", () => {
  const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const jobs = [...ci.slice(ci.indexOf("\njobs:\n")).matchAll(/\n  ([a-z][a-z-]*):\n([\s\S]*?)(?=\n  [a-z][a-z-]*:\n|$)/g)].map((m) => ({ name: m[1], body: m[2] }));
  const tests = "        run: node scripts/test-ci.mjs\n";
  // The step as it must stay: no retry, no continue-on-error, and a limit of its own.
  const step = "\n      - name: Start Chrome\n        working-directory: packages/coding.sh\n        timeout-minutes: 3\n        run: node scripts/warm-chrome.ts\n\n";
  const running = jobs.filter((j) => j.body.includes(tests));
  assert.deepEqual(running.map((j) => j.name), ["test", "windows"], "a new job that runs the tests starts Chrome first too");
  for (const { name, body } of running) {
    assert.equal(body.split(step).length, 2, `${name} starts Chrome once`);
    assert.ok(body.indexOf(step) < body.indexOf(tests), `${name} starts Chrome before the tests`);
  }
  assert.equal(ci.split("scripts/warm-chrome.ts").length - 1, 3, "the two steps and one comment");
  // On Linux the path is named for the whole job, so a missing Chrome fails both steps.
  assert.match(running[0].body, /\n    env:\n(?:      #.*\n)*      CODING_SH_TEST_CHROME: \/usr\/bin\/google-chrome\n    steps:\n/);
  assert.ok(existsSync(join(ROOT, "packages/coding.sh/scripts/warm-chrome.ts")));
});

test("ci.yml stops the Storage Service before anything else in the Windows job", () => {
  const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const windows = /\n  windows:\n([\s\S]*?)(?=\n  [a-z][a-z-]*:\n|$)/.exec(ci)?.[1] ?? "";
  // The service starts a disk read about 11 minutes after boot; a viewer page that first loads
  // during it outlasts the 5 s a test gives it. The step as it must stay: the first one, the
  // service disabled before the first stop, a failed stop tried again, and a service that is
  // still not stopped fails the job.
  const head = "\n      - name: Stop the Storage Service\n        shell: pwsh\n        run: |\n";
  assert.equal(windows.split(head).length, 2, "the step, once");
  assert.equal(windows.indexOf("\n      - "), windows.indexOf(head), "it is the first step");
  const rest = windows.slice(windows.indexOf(head) + head.length);
  const script = /^(?: {10}.*\n)+/.exec(rest)?.[0] ?? "";
  assert.ok(rest.slice(script.length).startsWith("\n"), "the script is the step's last key: no continue-on-error");
  assert.ok(script.startsWith("          Set-Service -Name StorSvc -StartupType Disabled\n"), "disabled before the first stop");
  assert.match(script, /\n +foreach \(\$try in 1\.\.5\) \{\n +try \{ Stop-Service -Name StorSvc -Force -ErrorAction Stop; break \}\n/, "a failed stop is tried again");
  assert.match(script, /\n +if \(\$service\.Status -ne 'Stopped'\) \{\n.*\n +exit 1\n +\}\n$/, "a service still not stopped fails the step");
});
