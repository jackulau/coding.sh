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

test("ci.yml runs the static gate, Postgres, the Python SDK and the release smoke test", () => {
  for (const job of ["gate-static", "store-postgres", "python-sdk", "release-smoke"]) assert.ok(jobs(ci).has(job), `${job} job`);
  assert.match(ci, /node scripts\/gate\.mjs --static --strict/);
  assert.match(ci, /CODING_SH_TEST_PG_URL: postgres:\/\/postgres:ci@127\.0\.0\.1:5432\/coding/);
  assert.match(ci, /python: \["3\.9", "3\.13"\]/);
  assert.match(ci, /sh scripts\/release\/smoke\.sh/);
  assert.match(ci, /packages\/blob-s3\n\s+run: npm run check/);
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
