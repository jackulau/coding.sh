// The CI workflows and the Node floor: what the plan says must run does run, and
// every file that names the floor names the same one. Reads files; runs nothing.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const ci = read(".github/workflows/ci.yml");
const jobs = (text) => new Set([...text.matchAll(/^  ([a-z][a-z-]*):$/gm)].map((m) => m[1]));

test("ci.yml runs the static gate, the store plugins, the Python SDK and the release smoke test", () => {
  for (const job of ["gate-static", "stores", "python-sdk", "runtime-floor"]) assert.ok(jobs(ci).has(job), `${job} job`);
  assert.match(ci, /node scripts\/gate\.mjs --static --strict/);
  assert.match(ci, /CODING_SH_TEST_PG_URL: postgres:\/\/postgres:ci@127\.0\.0\.1:5432\/coding/);
  assert.match(read("packages/sdk-python/pyproject.toml"), /requires-python = ">=3\.9"/);
  assert.match(ci, /sh scripts\/release\/smoke\.sh/);
  assert.match(ci, /packages\/blob-s3\n\s+run: npm run check/);
});

test("ci.yml tests the Postgres and ClickHouse stores against real servers in one job", () => {
  assert.ok(!jobs(ci).has("store-postgres") && !jobs(ci).has("store-clickhouse"), "one job, not two");
  const body = /\n  stores:\n([\s\S]*?)(?=\n  [a-z][a-z-]*:\n)/.exec(ci)?.[1] ?? "";
  assert.ok(body, "stores job");
  // Both servers start with the job; each is healthy before the first step runs.
  assert.match(body, /\n      postgres:\n        image: postgres:17\n/);
  assert.match(body, /\n      clickhouse:\n        image: clickhouse\/clickhouse-server:[\d.]+\n/);
  assert.equal(body.match(/--health-cmd /g)?.length, 2, "a health check per server");
  assert.match(body, /\n        id: install\n        run: npm ci\n/);
  // One step per package, each against its own server.
  const steps = body.split(/\n      - /).slice(1).filter((s) => s.includes("run: npm run check"));
  assert.deepEqual(steps.map((s) => /working-directory: (\S+)/.exec(s)?.[1]), ["packages/store-postgres", "packages/blob-s3", "packages/store-clickhouse"]);
  assert.match(steps[0], /CODING_SH_TEST_PG_URL: postgres:\/\/postgres:ci@127\.0\.0\.1:5432\/coding/);
  assert.match(steps[2], /CODING_SH_TEST_CH_URL: clickhouse:\/\/coding:ci@127\.0\.0\.1:8123\/coding/);
  // A red Postgres step does not hide the ClickHouse result: the later steps still run.
  const after = "if: ${{ !cancelled() && steps.install.outcome == 'success' }}";
  assert.ok(!steps[0].includes("\n        if:"), "the first test step has no condition");
  for (const s of steps.slice(1)) assert.ok(s.includes(after), "later steps run after a failed one");
  assert.doesNotMatch(body, /continue-on-error/);
});

test("ci.yml runs the secret scan, the hook budget and a site check that cannot skip", () => {
  assert.match(ci, /node scripts\/gate\.mjs --only secret-scan/);
  assert.match(ci, /bench\.mjs hook --check/);
  assert.match(ci, /name: Site check[\s\S]*?CODING_SH_REQUIRE_DIST: "1"/);
});

test("ci.yml runs the packed CLI on the Node floor itself", () => {
  const floor = JSON.parse(read("packages/coding.sh/package.json")).engines.node.replace(">=", "");
  const job = /\n  runtime-floor:\n([\s\S]*?)\n  [a-z-]+:\n/.exec(ci)?.[1] ?? "";
  assert.match(job, new RegExp(`node-version: ${floor.replaceAll(".", "\\.")}\\.0\\n`));
  assert.match(job, /sh scripts\/release\/runtime-floor\.sh "\$RUNNER_TEMP\/coding\.sh\.tgz"/);
  // The suite runs .ts from source, which the floor can't without a flag: no test leg on it.
  assert.doesNotMatch(ci, new RegExp(`node: \\[[^\\]]*${floor.replaceAll(".", "\\.")}\\.0`));
});

// One job, not one per Python: the SDK's floor (pyproject requires-python) and the newest, each
// with its own install and its own test step.
test("ci.yml runs the Python SDK's tests on Python 3.9 and on 3.13 in one job", () => {
  const job = /\n  python-sdk:\n([\s\S]*?)\n  [a-z-]+:\n/.exec(ci)?.[1] ?? "";
  assert.doesNotMatch(job, /\n    strategy:\n/, "no matrix: one job");
  // 3.9 has no build for ubuntu-latest.
  assert.match(job, /\n    runs-on: ubuntu-24\.04\n/);
  assert.match(job, /\n          python-version: \|\n            3\.9\n            3\.13\n/);
  const steps = job.split(/\n      - /).slice(1);
  for (const v of ["3.9", "3.13"]) {
    const py = `python${v}`.replace(".", "\\.");
    assert.match(job, new RegExp(`\\n          ${py} -m pip install[^\\n]*"\\.\\[otel,openai,anthropic\\]"[^\\n]*mypy\\n`), `${v}: every extra and mypy are installed`);
    const tests = steps.filter((s) => new RegExp(`\\n          ${py} -m unittest discover -s tests(\\n|$)`).test(s));
    assert.equal(tests.length, 1, `${v}: one test step`);
    assert.match(tests[0], /\n          CODING_SH_SDK_REQUIRE_ALL: "1"\n/, `${v}: a missing tool fails the step`);
    assert.doesNotMatch(tests[0], /continue-on-error/, `${v}: a failed test fails the job`);
    assert.equal(tests[0].match(/-m unittest/g).length, 1, `${v}: the step runs one Python`);
  }
  // The 3.13 tests run when the 3.9 tests fail, as the two jobs did: one run shows both results.
  const last = steps.find((s) => s.includes("python3.13 -m unittest"));
  assert.ok(last.includes("\n        if: ${{ !cancelled() && steps.install.outcome == 'success' }}\n"));
  assert.match(job, /\n        id: install\n/);
});

// One job, not two: the smoke test and the floor share a checkout and an install.
test("ci.yml runs the release smoke test on a current Node, then the floor, in one job", () => {
  assert.ok(!jobs(ci).has("release-smoke"), "no second job");
  const job = /\n  runtime-floor:\n([\s\S]*?)\n  [a-z-]+:\n/.exec(ci)?.[1] ?? "";
  const steps = job.split(/\n      - /).slice(1);
  const at = (re) => steps.findIndex((s) => re.test(s));
  const node24 = at(/node-version: 24\.x\n/), install = at(/\n        run: npm ci(\n|$)/), smoke = at(/\n        run: sh scripts\/release\/smoke\.sh(\n|$)/);
  const pack = at(/npm pack --silent/), floorNode = at(/node-version: 22\.\d+\.0(\n|$)/), floor = at(/scripts\/release\/runtime-floor\.sh/);
  for (const [name, i] of Object.entries({ node24, install, smoke, pack, floorNode, floor })) assert.notEqual(i, -1, `${name} step`);
  // The smoke test runs on Node 24: the switch to the floor comes after it and after the build.
  assert.ok(node24 < install && install < smoke && smoke < pack && pack < floorNode && floorNode < floor, "step order");
  assert.equal(job.match(/uses: actions\/setup-node@/g).length, 2);
  // A failed smoke test fails the job and the floor still runs, as the two jobs did.
  assert.doesNotMatch(job, /continue-on-error/);
  assert.doesNotMatch(steps[smoke], /\n        if:/);
  assert.ok(steps[pack].includes("\n        if: ${{ !cancelled() && steps.install.outcome == 'success' }}\n"));
  for (const i of [floorNode, floor]) assert.ok(steps[i].includes("\n        if: ${{ !cancelled() && steps.pack.outcome == 'success' }}\n"));
  // The packed CLI is built by the package's own build, as a release builds it.
  assert.match(steps[pack], /\n          npm run build\n/);
});

test("ci.yml runs the Python SDK's typing, golden, otel and real-SDK tests instead of skipping them", () => {
  const job = /\n  python-sdk:\n([\s\S]*?)\n  [a-z-]+:\n/.exec(ci)?.[1] ?? "";
  assert.match(job, /uses: actions\/setup-node@/, "the golden test runs the core package on Node");
  assert.match(job, /pip install[^\n]*"\.\[otel,openai,anthropic\]"[^\n]*mypy/, "every extra and mypy are installed");
  assert.match(job, /CODING_SH_SDK_REQUIRE_ALL: "1"/, "a missing tool fails the job");
  assert.match(read("packages/sdk-python/tests/support.py"), /REQUIRE_ALL = os\.environ\.get\("CODING_SH_SDK_REQUIRE_ALL"\) == "1"/);
  // Every test that skips on a missing package must honor REQUIRE_ALL, or CI skips it silently.
  for (const f of ["test_otel.py", "test_gateway.py", "test_real_sdks.py", "test_golden.py"]) {
    for (const m of read(`packages/sdk-python/tests/${f}`).matchAll(/@unittest\.skipUnless\(([^\n]*)\)\n/g)) {
      assert.match(m[1], /REQUIRE_ALL/, `${f}: ${m[1]}`);
    }
  }
});

test("a green action run carries no error annotation from the expected failure", () => {
  const bad = /\n      - name: Failing suite\n([\s\S]*?)\n\n/.exec(ci)?.[1] ?? "";
  // continue-on-error still leaves GitHub's "Process completed with exit code 1" on the run.
  assert.doesNotMatch(bad, /continue-on-error/);
  assert.match(bad, /fail: "false"/);
  assert.match(ci, /test "\$BAD" = 1\n\s*test "\$BAD_OUTCOME" = success/);
  const action = read("action.yml");
  assert.match(action, /annotate:[\s\S]*default: "true"/);
  assert.match(action, /\n  fail:\n[^\n]*\n[^\n]*\n    default: "true"/);
  assert.match(action, /- name: Fail on the command's exit code\n      if: inputs\.fail != 'false' && /);
});

test("site.yml deploys when the docs, the CLI reference sources or the SDK change", () => {
  const site = read(".github/workflows/site.yml");
  for (const p of ["docs/**", "packages/coding.sh/src/cli/registry.ts", "packages/coding.sh/src/**/cli-spec.ts", "packages/coding.sh/src/schema/**", "packages/sdk/**"]) {
    assert.ok(site.includes(`- "${p}"`), p);
  }
});

/** The push paths of a workflow, as regexps over repo paths (GitHub's glob: ** any depth, * one segment). */
function pushPaths(yml) {
  const block = /\n {2}push:\n(?: {4}.*\n)*? {4}paths:\n((?: {6}- .*\n)+)/.exec(yml)[1];
  return [...block.matchAll(/- "([^"]+)"/g)].map((m) => ({
    glob: m[1],
    re: new RegExp(`^${m[1].replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*")}$`),
  }));
}

test("every site.yml push path matches a file, and every repo file the site imports is covered", () => {
  const paths = pushPaths(read(".github/workflows/site.yml"));
  for (const { glob } of paths) {
    // The part before the first wildcard must exist (a file, or the folder the glob reads).
    const fixed = glob.split("*")[0].replace(/\/$/, "");
    assert.ok(fixed && existsSync(join(ROOT, fixed)), `site.yml path ${glob} names ${fixed}, which does not exist`);
  }
  // Imports out of apps/site (`../../../../CHANGELOG.md?raw`, the schema, install.sh) are part of the build.
  const src = readdirSync(join(ROOT, "apps/site/src"), { recursive: true })
    .map((f) => `apps/site/src/${String(f).split(sep).join("/")}`)
    .filter((f) => /\.(astro|ts|mjs|js)$/.test(f));
  const outside = new Set();
  for (const f of src) {
    for (const m of read(f).matchAll(/from\s+["']((?:\.\.\/)+[^"'?]+)/g)) {
      const target = posix.normalize(posix.join(posix.dirname(f), m[1]));
      if (!target.startsWith("apps/site/")) outside.add(target);
    }
  }
  assert.ok(outside.size >= 3, "found the site's imports from outside apps/site");
  for (const t of outside) assert.ok(paths.some(({ re }) => re.test(t)), `site.yml does not deploy on a change to ${t}, which the site imports`);
});

test("every file that names the Node floor names the same one", () => {
  const floor = JSON.parse(read("package.json")).engines.node.replace(">=", "");
  for (const p of ["packages/coding.sh", "packages/blob-s3", "packages/store-postgres", "packages/store-clickhouse"]) {
    assert.equal(JSON.parse(read(`${p}/package.json`)).engines.node, `>=${floor}`, p);
  }
  const [maj, min] = floor.split(".");
  assert.match(read("install.sh"), new RegExp(`maj === ${maj} && min >= ${min}`));
  // Development runs .ts from source: type stripping is on by default from 22.18.
  for (const p of ["AGENTS.md", "CONTRIBUTING.md"]) {
    assert.ok(read(p).includes("Node 22.18 or newer"), `${p} names the dev floor`);
    assert.ok(read(p).includes(`Node ${floor}`), `${p} names the runtime floor`);
  }
  for (const p of ["install.sh", "action.yml", "AGENTS.md", "CONTRIBUTING.md", "scripts/release/smoke.sh"]) assert.ok(!read(p).includes("22.15"), `${p} still says 22.15`);
});
