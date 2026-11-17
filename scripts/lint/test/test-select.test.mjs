// packages/coding.sh/scripts/test-select.ts: the quick run of a pull request runs the test files
// its diff can reach. Pins the rules on this repository, and that ci.yml and scripts/test-ci.mjs
// let nothing but that quick run select. The rules themselves are tested case by case in
// packages/coding.sh/test/scripts/test-select.test.ts.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ALWAYS, OUTSIDE, selectTests } from "../../../packages/coding.sh/scripts/test-select.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
const runner = readFileSync(join(ROOT, "packages/coding.sh/scripts/test-ci.mjs"), "utf8");
const job = (name) => new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z][a-z-]*:\\n|$)`).exec(ci)?.[1] ?? "";
const count = (text, part) => text.split(part).length - 1;

// Every rule there is. A new one is measured first (CONTRIBUTING.md, "Pull requests").
const NARROWS = {
  "docs/reference/cli.md": 'the test files that name "docs"',
  "apps/site/src/pages/index.astro": 'the test files that name "apps"',
  "README.md": 'the test files that name "README.md"',
  "CHANGELOG.md": 'the test files that name "CHANGELOG.md"',
  ".github/PULL_REQUEST_TEMPLATE.md": 'the test files that name ".github"',
  "packages/sdk/src/index.ts": 'the test files that name "sdk"',
  "packages/sdk-python/README.md": 'the test files that name "sdk-python"',
  "packages/store-postgres/src/index.ts": 'the test files that name "store-postgres"',
  "packages/store-clickhouse/src/index.ts": 'the test files that name "store-clickhouse"',
  "packages/blob-s3/README.md": 'the test files that name "blob-s3"',
  "packages/coding.sh/test/scripts/test-ci.test.ts": "a changed test file, and the test files that import it",
  "packages/coding.sh/test/_cli.ts": "the test files that reach a changed helper",
};

const EVERYTHING = {
  "packages/coding.sh/src/cli/registry.ts": "has no rule that narrows it",
  "packages/coding.sh/skills/build-agent-evals/SKILL.md": "has no rule that narrows it",
  "packages/coding.sh/README.md": "has no rule that narrows it",
  "packages/coding.sh/scripts/test-ci.mjs": "has no rule that narrows it",
  "packages/coding.sh/scripts/test-select.ts": "has no rule that narrows it",
  "packages/coding.sh/scripts/test-shards.ts": "has no rule that narrows it",
  "packages/coding.sh/scripts/test-durations.json": "has no rule that narrows it",
  ".github/workflows/ci.yml": "has no rule that narrows it",
  "scripts/ci-changes.mjs": "has no rule that narrows it",
  "scripts/lint/test/test-select.test.mjs": "has no rule that narrows it",
  "action.yml": "has no rule that narrows it",
  "Dockerfile": "has no rule that narrows it",
  "install.sh": "has no rule that narrows it",
  "LICENSE": "has no rule that narrows it",
  "package.json": "is a manifest, a lockfile or a compiler config",
  "package-lock.json": "is a manifest, a lockfile or a compiler config",
  "packages/coding.sh/package.json": "is a manifest, a lockfile or a compiler config",
  "packages/coding.sh/tsconfig.json": "is a manifest, a lockfile or a compiler config",
  "apps/site/package.json": "is a manifest, a lockfile or a compiler config",
  "packages/sdk/package.json": "is a manifest, a lockfile or a compiler config",
  "packages/sdk-python/pyproject.toml": "is a manifest, a lockfile or a compiler config",
  "docs/no-such-page.md": "is deleted or renamed",
  "packages/coding.sh/test/no-such-helper.ts": "is deleted or renamed",
};

test("the rules narrow these paths of this repository, and no others", () => {
  for (const [path, rule] of Object.entries(NARROWS)) {
    assert.ok(existsSync(join(ROOT, path)), `${path} exists`);
    const s = selectTests([path], ROOT);
    assert.equal(s.all, false, `${path}: ${s.all ? s.why : ""}`);
    assert.match(s.why[0], new RegExp(`^${rule.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: \\d+ test files, for `), path);
    for (const f of ALWAYS) assert.ok(s.files.includes(f), `${path} keeps ${f}`);
    for (const f of s.files) assert.ok(existsSync(join(ROOT, "packages/coding.sh", f)), f);
  }
  assert.deepEqual(OUTSIDE.map((o) => o.path.source), [
    "^docs\\/",
    "^apps\\/site\\/",
    "^[^/]+\\.md$",
    "^\\.github\\/(ISSUE_TEMPLATE\\/|[^/]+\\.md$)",
    "^packages\\/(sdk|sdk-python|store-postgres|store-clickhouse|blob-s3)\\/",
  ]);
});

test("every other path runs every test file, alone or beside a path that narrows", () => {
  for (const [path, why] of Object.entries(EVERYTHING)) {
    if (why !== "is deleted or renamed") assert.ok(existsSync(join(ROOT, path)), `${path} exists`);
    for (const changed of [[path], ["docs/README.md", path, "CHANGELOG.md"]]) {
      const s = selectTests(changed, ROOT);
      assert.equal(s.all, true, path);
      assert.equal(s.why, `${path} ${why}`);
    }
  }
  assert.deepEqual(selectTests([], ROOT), { all: true, why: "the diff is empty" });
  // A fixture, a golden and a data file under test/ are found by listing, not by name.
  const fixture = "packages/coding.sh/test/mcp/toolevals/tasks/llm-p95.toml";
  assert.ok(existsSync(join(ROOT, fixture)));
  assert.equal(selectTests([fixture], ROOT).why, `${fixture} is a fixture, a golden or a data file`);
  // A new file at the top of the repository: the CLI lists that directory when a test runs it there.
  assert.equal(selectTests(["README.md"], ROOT, "packages/coding.sh", new Set(["README.md"])).why, "README.md is a new file at the top of the repository");
});

test("ci.yml lets only the quick run of a pull request select", () => {
  // FULL is true on a push, a manual run and with the `ready` label: the only way to 'false' is a
  // pull request without the label.
  assert.ok(ci.includes("\nenv:\n  FULL: ${{ github.event_name != 'pull_request' || contains(github.event.pull_request.labels.*.name, 'ready') }}\n"));
  const body = job("test");
  const step = "\n      - name: Test\n        working-directory: packages/coding.sh\n        env:\n          SHARD: ${{ matrix.shard }}/3\n          TEST_DURATIONS_OUT: ${{ runner.temp }}/test-durations.json\n          TEST_SELECT: ${{ env.FULL == 'false' && 'HEAD^1' || '' }}\n";
  assert.ok(body.includes(step), "the Linux Test step sets TEST_SELECT from FULL");
  // Nothing else sets it: not the Windows legs (the full suite only), not a job or the workflow.
  assert.equal(count(ci, "TEST_SELECT:"), 1);
  assert.equal(count(job("windows"), "TEST_SELECT"), 0);
  // HEAD^1 is the base the pull request is merged with, the commit the changes job diffs against.
  assert.ok(body.includes("\n      - uses: actions/checkout@v5\n        with:\n          fetch-depth: 2\n"), "the test job fetches the base commit");
  assert.ok(job("changes").includes("git diff --name-only --no-renames HEAD^1 HEAD"));
  // No job was added for this and the test legs wait on no other job.
  assert.doesNotMatch(body, /\n    needs:/);
  assert.equal(count(ci, "test-select"), 2, "two comments, no step of its own");
  // A narrowed run writes no run times: the upload finds no file and makes no artifact.
  const upload = body.slice(body.indexOf("uses: actions/upload-artifact"));
  assert.ok(upload.includes("name: test-durations-linux-${{ matrix.shard }}\n          path: ${{ runner.temp }}/test-durations.json\n"));
  assert.ok(upload.includes("if-no-files-found: ignore\n"));
});

test("scripts/test-ci.mjs loads the selection only when TEST_SELECT is set, and fails closed", () => {
  // No static import: without TEST_SELECT a broken selection cannot touch a push or the full suite.
  assert.doesNotMatch(runner, /^import .*test-select/m);
  assert.equal(count(runner, "test-select.ts"), 2, "the header comment and one dynamic import");
  assert.ok(runner.includes('  if (!process.env.TEST_SELECT) return { files: all, narrowed: false, log: ["Running every test file: TEST_SELECT is not set"] };\n  try {\n    return (await import("./test-select.ts")).selectForRun(all, process.env, process.cwd());\n  } catch (err) {\n    return { files: all, narrowed: false, log: ['));
  // The list the shards split, the list a failure is checked against and the list run are one.
  assert.ok(runner.includes("  files = listed = shardFiles(picked.files, readDurations(), i, n);\n"));
  // An empty shard passes only when the run was narrowed.
  assert.ok(runner.includes("  if (files.length === 0 && !narrowed) throw new Error(`shard ${shard} of every test file is empty`);\n  if (files.length === 0) process.exit(0);\n"));
  // A narrowed run writes no run times, removes a file that is there, and keeps the path from its tests.
  assert.ok(runner.includes("if (narrowed) delete process.env.TEST_DURATIONS_OUT;\nif (durationsOut && narrowed) rmSync(durationsOut, { force: true });\nelse if (durationsOut) args.push("));
  // The selection reads the event itself as well: a second lock behind the workflow's.
  const select = readFileSync(join(ROOT, "packages/coding.sh/scripts/test-select.ts"), "utf8");
  assert.ok(select.includes('if (env.GITHUB_EVENT_NAME !== "pull_request") return everything('));
  assert.ok(select.includes('if (labels.some((l) => l.name === "ready")) return everything('));
});
