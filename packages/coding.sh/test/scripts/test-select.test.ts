// scripts/test-select.ts: the test files a pull request's quick CI run needs. Every rule, every
// case that must run everything, the two locks that keep pushes and the full suite out of it, and
// scripts/test-ci.mjs running what was selected.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ALWAYS, selectForRun, selectTests, type Selection } from "../../scripts/test-select.ts";
import { testFiles } from "../../scripts/test-shards.ts";

const PKG = join(import.meta.dirname, "..", "..");
const ROOT = join(PKG, "..", "..");
const RUNNER = join(PKG, "scripts", "test-ci.mjs");
const SELECT = join(PKG, "scripts", "test-select.ts");

const GREEN = `import { it } from "node:test"; it("passes", () => {});`;
const BROKEN = `import { it } from "node:test"; it("always fails", () => { throw new Error("real"); });`;

/** A small repository: a package at pkg/ with tests, helpers and scripts, and files around it. */
const TREE: Record<string, string> = {
  "docs/a.md": "a doc\n",
  "apps/site/index.astro": "a page\n",
  "apps/site/package.json": "{}\n",
  "README.md": "readme\n",
  "CHANGELOG.md": "changes\n",
  "LICENSE": "license\n",
  "Dockerfile": "FROM scratch\n",
  ".github/ISSUE_TEMPLATE/bug.yml": "name: bug\n",
  ".github/PULL_REQUEST_TEMPLATE.md": "template\n",
  ".github/workflows/ci.yml": "name: CI\n",
  "scripts/tool.mjs": "export {};\n",
  "deploy/compose.yml": "services: {}\n",
  "package.json": "{}\n",
  "package-lock.json": "{}\n",
  "packages/sdk/src/index.ts": "export {};\n",
  "packages/sdk/package.json": "{}\n",
  "packages/sdk-python/pyproject.toml": "[project]\n",
  "packages/other/src/index.ts": "export {};\n",
  "pkg/package.json": "{}\n",
  "pkg/tsconfig.json": "{}\n",
  "pkg/README.md": "packed\n",
  "pkg/src/a.ts": "export const a = 1;\n",
  "pkg/skills/debug/SKILL.md": "a skill\n",
  "pkg/scripts/gen.mjs": `// writes docs/a.md\nexport {};\n`,
  "pkg/scripts/test-ci.mjs": "export {};\n",
  "pkg/scripts/test-select.ts": "export {};\n",
  "pkg/test/_helper.ts": `export const one = 1;\n`,
  "pkg/test/_outer.ts": `export { one } from "./_helper.ts";\n`,
  "pkg/test/helpers.ts": "export {};\n",
  "pkg/test/server.mjs": "process.exit(0);\n",
  "pkg/test/unused.ts": "export {};\n",
  "pkg/test/fixtures/session.json": "{}\n",
  "pkg/test/fixtures/agent.mjs": "export {};\n",
  "pkg/test/adapters/golden/out.ts": "export {};\n",
  "pkg/test/tasks/one.toml": "name = 1\n",
  "pkg/test/docs.test.ts": `${GREEN} // reads join(ROOT, "docs", "a.md")`,
  "pkg/test/gen.test.ts": `${GREEN} import "../scripts/gen.mjs";`,
  "pkg/test/site.test.ts": `${GREEN} // reads join(ROOT, "apps", "site")`,
  "pkg/test/readme.test.ts": `${GREEN} // reads join(ROOT, "README.md")`,
  "pkg/test/templates.test.ts": `${GREEN} // reads join(ROOT, ".github", "ISSUE_TEMPLATE")`,
  "pkg/test/sdk.test.ts": `${GREEN} // reads join(ROOT, "packages", "sdk")`,
  "pkg/test/uses-helper.test.ts": `import { one } from "./_helper.ts"; ${GREEN}`,
  "pkg/test/uses-outer.test.ts": `import { one } from "./_outer.ts"; ${GREEN}`,
  "pkg/test/spawns.test.ts": `${GREEN} // spawns join(import.meta.dirname, "server.mjs")`,
  "pkg/test/similar.test.ts": `import "./_helper.ts"; ${GREEN} // _helpers.ts and my-server.mjs are other names`,
  "pkg/test/plain.test.ts": GREEN,
  "pkg/test/imports-plain.test.ts": `import "./plain.test.ts";`,
  "pkg/test/scripts/test-shards.test.ts": GREEN,
  "pkg/test/scripts/test-select.test.ts": GREEN,
};
const ALWAYS_HERE = ALWAYS;

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tree(files: Record<string, string> = TREE): string {
  const root = mkdtempSync(join(tmpdir(), "test-select-"));
  dirs.push(root);
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), body);
  }
  return root;
}

function narrowed(s: Selection): { files: string[]; why: string[] } {
  assert.equal(s.all, false, s.all ? `ran everything: ${s.why}` : "");
  return s as { files: string[]; why: string[] };
}
const picks = (root: string, changed: string[]): string[] => narrowed(selectTests(changed, root, "pkg")).files.filter((f) => !ALWAYS_HERE.includes(f));
const everything = (root: string, changed: string[]): string => {
  const s = selectTests(changed, root, "pkg");
  assert.equal(s.all, true, `${changed.join(", ")} was narrowed`);
  return (s as { why: string }).why;
};

describe("scripts/test-select.ts: the rules", () => {
  const root = tree();

  it("a doc runs the test files that name docs, in their own text or in a script they reach", () => {
    assert.deepEqual(picks(root, ["docs/a.md"]), ["test/docs.test.ts", "test/gen.test.ts"]);
  });

  it("the site, a root markdown file and the .github files that are not workflows run the test files that name them", () => {
    assert.deepEqual(picks(root, ["apps/site/index.astro"]), ["test/site.test.ts"]);
    assert.deepEqual(picks(root, ["README.md"]), ["test/readme.test.ts"]);
    assert.deepEqual(picks(root, ["CHANGELOG.md"]), []);
    assert.deepEqual(picks(root, [".github/ISSUE_TEMPLATE/bug.yml"]), ["test/templates.test.ts"]);
    assert.deepEqual(picks(root, [".github/PULL_REQUEST_TEMPLATE.md"]), ["test/templates.test.ts"]);
  });

  it("another package runs the test files that name its directory", () => {
    assert.deepEqual(picks(root, ["packages/sdk/src/index.ts"]), ["test/sdk.test.ts"]);
  });

  it("a changed test file runs, with the test files that import it", () => {
    assert.deepEqual(picks(root, ["pkg/test/docs.test.ts"]), ["test/docs.test.ts"]);
    assert.deepEqual(picks(root, ["pkg/test/plain.test.ts"]), ["test/imports-plain.test.ts", "test/plain.test.ts"]);
  });

  it("a changed helper runs the test files that import it, through other helpers too", () => {
    assert.deepEqual(picks(root, ["pkg/test/_helper.ts"]), ["test/similar.test.ts", "test/uses-helper.test.ts", "test/uses-outer.test.ts"]);
    assert.deepEqual(picks(root, ["pkg/test/_outer.ts"]), ["test/uses-outer.test.ts"]);
  });

  it("a changed helper runs the test files that write its file name, and not a longer name", () => {
    assert.deepEqual(picks(root, ["pkg/test/server.mjs"]), ["test/spawns.test.ts"]);
  });

  it("every narrowed run keeps the tests of the shards and of these rules", () => {
    const s = narrowed(selectTests(["CHANGELOG.md"], root, "pkg"));
    assert.deepEqual(s.files, [...ALWAYS].sort());
    assert.match(s.why.at(-1)!, /every narrowed run: test\/scripts\/test-select\.test\.ts, test\/scripts\/test-shards\.test\.ts/);
  });

  it("a diff of several paths runs the union, and says which rule each path fell under", () => {
    const s = narrowed(selectTests(["docs/a.md", "README.md", "pkg/test/plain.test.ts"], root, "pkg"));
    assert.deepEqual(s.files.filter((f) => !ALWAYS.includes(f)), ["test/docs.test.ts", "test/gen.test.ts", "test/imports-plain.test.ts", "test/plain.test.ts", "test/readme.test.ts"]);
    assert.deepEqual(s.why.slice(0, 3), [
      'the test files that name "docs": 2 test files, for docs/a.md',
      'the test files that name "README.md": 1 test files, for README.md',
      "a changed test file, and the test files that import it: 2 test files, for pkg/test/plain.test.ts",
    ]);
  });
});

describe("scripts/test-select.ts: what runs everything", () => {
  const root = tree();

  it("an empty diff", () => {
    assert.equal(everything(root, []), "the diff is empty");
  });

  it("a path no rule knows", () => {
    for (const path of [
      "pkg/src/a.ts",
      "pkg/skills/debug/SKILL.md",
      "pkg/README.md",
      "pkg/scripts/gen.mjs",
      "pkg/scripts/test-ci.mjs", // the runner
      "pkg/scripts/test-select.ts", // the selection itself
      ".github/workflows/ci.yml",
      "scripts/tool.mjs",
      "deploy/compose.yml",
      "packages/other/src/index.ts", // a package that was not measured
      "LICENSE",
      "Dockerfile",
    ]) {
      assert.equal(everything(root, [path]), `${path} has no rule that narrows it`);
    }
  });

  it("a manifest, a lockfile or a compiler config, wherever it is", () => {
    for (const path of ["package.json", "package-lock.json", "pkg/package.json", "pkg/tsconfig.json", "apps/site/package.json", "packages/sdk/package.json", "packages/sdk-python/pyproject.toml"]) {
      assert.equal(everything(root, [path]), `${path} is a manifest, a lockfile or a compiler config`);
    }
    // Not yet on disk: the name decides, before anything is read.
    for (const path of ["docs/package.json", "apps/site/.npmrc", "packages/sdk/tsconfig.build.json", "packages/sdk-python/uv.lock", "apps/site/pnpm-lock.yaml"]) {
      assert.match(everything(root, [path]), /is a manifest, a lockfile or a compiler config$/);
    }
  });

  it("a path that is gone: deleted, or renamed (a rename is a delete and an add)", () => {
    for (const path of ["docs/gone.md", "pkg/test/gone.test.ts", "pkg/test/_gone.ts", "packages/sdk/src/gone.ts", "GONE.md"]) {
      assert.equal(everything(root, [path]), `${path} is deleted or renamed`);
    }
    assert.match(everything(root, ["docs/gone.md", "docs/a.md"]), /^docs\/gone\.md is deleted or renamed$/);
  });

  it("a fixture, a golden or a data file under test/", () => {
    for (const path of ["pkg/test/fixtures/session.json", "pkg/test/fixtures/agent.mjs", "pkg/test/adapters/golden/out.ts", "pkg/test/tasks/one.toml"]) {
      assert.equal(everything(root, [path]), `${path} is a fixture, a golden or a data file`);
    }
  });

  it("a new markdown file at the top of the repository: the CLI lists that directory", () => {
    assert.equal(selectTests(["README.md"], root, "pkg", new Set(["README.md"])).all, true);
    assert.equal((selectTests(["CHANGELOG.md", "README.md"], root, "pkg", new Set(["README.md"])) as { why: string }).why, "README.md is a new file at the top of the repository");
    // A new file under a directory that has a rule narrows as a changed one does.
    assert.equal(selectTests(["docs/a.md", "README.md"], root, "pkg", new Set(["docs/a.md"])).all, false);
  });

  it("a helper no test file imports or names", () => {
    assert.equal(everything(root, ["pkg/test/unused.ts"]), "pkg/test/unused.ts is a helper no test file imports or names");
    // `helpers.ts` is only part of other names in the tree.
    assert.equal(everything(root, ["pkg/test/helpers.ts"]), "pkg/test/helpers.ts is a helper no test file imports or names");
  });

  it("a path that is not a path of the repository", () => {
    for (const path of ["", "/etc/passwd", "../outside.md", "docs/../pkg/src/a.ts", "docs\\a.md"]) {
      assert.match(everything(root, [path]), /is not a path of the repository$/);
    }
  });

  it("one path without a rule among paths that have one", () => {
    assert.equal(everything(root, ["docs/a.md", "pkg/test/plain.test.ts", "pkg/src/a.ts"]), "pkg/src/a.ts has no rule that narrows it");
    assert.equal(everything(root, ["docs/a.md", "pkg/src/a.ts", "LICENSE"]), "pkg/src/a.ts has no rule that narrows it (and 1 more of the 3 changed paths)");
  });
});

// A git repository of the small tree, with one more commit that makes `edits`.
function repo(edits: Record<string, string | null>, files: Record<string, string> = TREE): { root: string; git: (...args: string[]) => string } {
  const root = tree(files);
  writeFileSync(join(root, ".gitconfig-test"), "");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: join(root, ".gitconfig-test"), GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args: string[]): string => {
    const r = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8", env });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
  };
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  for (const [name, body] of Object.entries(edits)) {
    if (body === null) rmSync(join(root, name));
    else (mkdirSync(dirname(join(root, name)), { recursive: true }), writeFileSync(join(root, name), body));
  }
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", "change");
  return { root, git };
}

/** The environment of a GitHub Actions run of `event`, for a pull request with `labels`. */
function actions(root: string, event: string, labels: string[], more: Record<string, string> = {}): NodeJS.ProcessEnv {
  const path = join(root, `.event-${event}-${labels.join("-")}.json`);
  writeFileSync(path, JSON.stringify(event === "pull_request" ? { pull_request: { labels: labels.map((name) => ({ name })) } } : { ref: "refs/heads/main" }));
  const env: NodeJS.ProcessEnv = { ...process.env, GITHUB_EVENT_NAME: event, GITHUB_EVENT_PATH: path, TEST_SELECT: "HEAD^1", ...more };
  delete env.NODE_TEST_CONTEXT; // else an inner node --test reports to this test run instead of its own stdout
  return env;
}

describe("scripts/test-select.ts: only the quick run of a pull request selects", () => {
  const { root } = repo({ "docs/a.md": "a changed doc\n" });
  const cwd = join(root, "pkg");
  const all = testFiles(cwd);
  const run = (env: NodeJS.ProcessEnv) => selectForRun(all, env, cwd);

  it("a pull request without the ready label runs what its diff selects", () => {
    const r = run(actions(root, "pull_request", []));
    assert.equal(r.narrowed, true, r.log.join("\n"));
    assert.deepEqual(r.files, ["test/docs.test.ts", "test/gen.test.ts", "test/scripts/test-select.test.ts", "test/scripts/test-shards.test.ts"]);
    assert.equal(r.log[0], `Selected 4 of ${all.length} test files for the 1 changed paths (HEAD^1..HEAD):`);
    assert.equal(r.log[1], '  the test files that name "docs": 2 test files, for docs/a.md');
    // Another label is not the ready label.
    assert.equal(run(actions(root, "pull_request", ["bug", "not-ready"])).narrowed, true);
  });

  const whole = (env: NodeJS.ProcessEnv, why: RegExp): void => {
    const r = run(env);
    assert.equal(r.narrowed, false);
    assert.deepEqual(r.files, all);
    assert.equal(r.log.length, 1);
    assert.match(r.log[0]!, why);
  };

  it("without TEST_SELECT nothing is selected, whatever the event says", () => {
    whole(actions(root, "pull_request", [], { TEST_SELECT: "" }), /^Running every test file: TEST_SELECT is not set$/);
  });

  it("a push, a manual run and a merge queue run never select, even with TEST_SELECT", () => {
    for (const event of ["push", "workflow_dispatch", "merge_group", ""]) whole(actions(root, event, []), /^Running every test file: the event is (push|workflow_dispatch|merge_group|not known), not pull_request$/);
  });

  it("a pull request with the ready label never selects, even with TEST_SELECT", () => {
    whole(actions(root, "pull_request", ["ready"]), /^Running every test file: the pull request has the ready label$/);
    whole(actions(root, "pull_request", ["bug", "ready"]), /the pull request has the ready label$/);
  });

  it("an event that cannot be read, or says nothing of labels, runs everything", () => {
    whole(actions(root, "pull_request", [], { GITHUB_EVENT_PATH: join(root, "no-such-file.json") }), /^Running every test file: the selection failed \(/);
    whole(actions(root, "pull_request", [], { GITHUB_EVENT_PATH: "" }), /the selection failed \(/);
    writeFileSync(join(root, ".event-odd.json"), JSON.stringify({ pull_request: {} }));
    whole(actions(root, "pull_request", [], { GITHUB_EVENT_PATH: join(root, ".event-odd.json") }), /the selection failed \(/);
    writeFileSync(join(root, ".event-bad.json"), "{");
    whole(actions(root, "pull_request", [], { GITHUB_EVENT_PATH: join(root, ".event-bad.json") }), /the selection failed \(/);
  });

  it("a diff git cannot make runs everything", () => {
    whole(actions(root, "pull_request", [], { TEST_SELECT: "no-such-commit" }), /the selection failed \(git diff failed: /);
    // A shallow clone of one commit has no HEAD^1.
    const single = repo({});
    spawnSync("git", ["checkout", "-q", "--orphan", "alone"], { cwd: single.root });
    single.git("commit", "-q", "-m", "alone");
    const r = selectForRun(all, actions(single.root, "pull_request", []), join(single.root, "pkg"));
    assert.equal(r.narrowed, false);
    assert.match(r.log[0]!, /the selection failed \(git diff failed: /);
  });

  it("an empty diff and a deleted file run everything", () => {
    const same = repo({});
    assert.deepEqual(selectForRun(all, actions(same.root, "pull_request", []), join(same.root, "pkg")).log, ["Running every test file: the diff is empty"]);
    const gone = repo({ "docs/a.md": null });
    assert.deepEqual(selectForRun(all, actions(gone.root, "pull_request", []), join(gone.root, "pkg")).log, ["Running every test file: docs/a.md is deleted or renamed"]);
    const fresh = repo({ "NEW.md": "a new page\n", "docs/new.md": "a new doc\n" });
    assert.deepEqual(selectForRun(all, actions(fresh.root, "pull_request", []), join(fresh.root, "pkg")).log, ["Running every test file: NEW.md is a new file at the top of the repository"]);
    const page = repo({ "docs/new.md": "a new doc\n", "README.md": "readme, changed\n" });
    assert.equal(selectForRun(all, actions(page.root, "pull_request", []), join(page.root, "pkg")).narrowed, true);
    const moved = repo({ "pkg/test/_helper.ts": null, "pkg/test/_moved.ts": TREE["pkg/test/_helper.ts"]! });
    assert.deepEqual(selectForRun(all, actions(moved.root, "pull_request", []), join(moved.root, "pkg")).log, ["Running every test file: pkg/test/_helper.ts is deleted or renamed"]);
  });
});

describe("scripts/test-ci.mjs with TEST_SELECT", () => {
  // The runner in the small repository, as a CI leg calls it.
  function leg(root: string, env: NodeJS.ProcessEnv, shard: string) {
    const durations = join(root, "durations.json");
    writeFileSync(durations, "stale");
    const r = spawnSync(process.execPath, [RUNNER], { cwd: join(root, "pkg"), encoding: "utf8", env: { ...env, SHARD: shard, TEST_DURATIONS_OUT: durations }, timeout: 120_000 });
    return { code: r.status, out: r.stdout + r.stderr, durations: existsSync(durations) };
  }
  const ran = (out: string): number => Number(/^ℹ tests (\d+)$/m.exec(out)?.[1] ?? -1);
  const TESTS = Object.keys(TREE).filter((f) => f.endsWith(".test.ts")).length;
  const RUNS = TESTS; // imports-plain.test.ts has no test of its own: it runs the one of plain.test.ts again

  it("runs the selected files only, says why, and writes no run times", () => {
    const { root } = repo({ "docs/a.md": "a changed doc\n" });
    const r = leg(root, actions(root, "pull_request", []), "1/1");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`^Selected 4 of ${TESTS} test files for the 1 changed paths \\(HEAD\\^1\\.\\.HEAD\\):\\n  the test files that name "docs": 2 test files, for docs/a\\.md\\n`, "m"));
    assert.match(r.out, /^Shard 1\/1: 4 test files\n  test\/docs\.test\.ts\n  test\/gen\.test\.ts\n  test\/scripts\/test-select\.test\.ts\n  test\/scripts\/test-shards\.test\.ts\n/m);
    assert.equal(ran(r.out), 4, r.out);
    assert.equal(r.durations, false, "a narrowed run leaves no run times to upload, not even stale ones");
  });

  it("fails when a selected test fails: the break in a changed test file is run", () => {
    const { root } = repo({ "pkg/test/plain.test.ts": BROKEN });
    const r = leg(root, actions(root, "pull_request", []), "1/1");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /a changed test file, and the test files that import it: 2 test files, for pkg\/test\/plain\.test\.ts/);
    assert.match(r.out, /always fails/);
  });

  it("fails when a changed helper breaks a test file the diff does not touch", () => {
    const { root } = repo({ "pkg/test/_helper.ts": `export const one = 1; throw new Error("the helper is broken");\n` });
    const r = leg(root, actions(root, "pull_request", []), "1/1");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /the test files that reach a changed helper: 3 test files, for pkg\/test\/_helper\.ts/);
    assert.match(r.out, /the helper is broken/);
  });

  it("a shard the selection leaves empty passes, and its siblings run the files", () => {
    const { root } = repo({ "CHANGELOG.md": "more changes\n" });
    const env = actions(root, "pull_request", []);
    const legs = [leg(root, env, "1/3"), leg(root, env, "2/3"), leg(root, env, "3/3")];
    assert.deepEqual(legs.map((l) => l.code), [0, 0, 0], legs.map((l) => l.out).join("\n"));
    assert.deepEqual(legs.map((l) => /^Shard \d\/3: (\d) test files$/m.exec(l.out)?.[1]), ["1", "1", "0"]);
    assert.deepEqual(legs.map((l) => ran(l.out)), [1, 1, -1]);
  });

  it("runs every file and writes the run times on a push, with the ready label, and without TEST_SELECT", () => {
    const { root } = repo({ "docs/a.md": "a changed doc\n" });
    for (const [env, why] of [
      [actions(root, "push", []), "the event is push, not pull_request"],
      [actions(root, "pull_request", ["ready"]), "the pull request has the ready label"],
      [actions(root, "pull_request", [], { TEST_SELECT: "" }), "TEST_SELECT is not set"],
    ] as const) {
      const r = leg(root, env, "1/1");
      assert.equal(r.code, 0, r.out);
      assert.ok(r.out.includes(`Running every test file: ${why}\nShard 1/1: ${TESTS} test files\n`), r.out.slice(0, 400));
      assert.equal(ran(r.out), RUNS, r.out);
      assert.equal(r.durations, true);
    }
  });

  it("runs every file when the diff has a path without a rule", () => {
    const { root } = repo({ "docs/a.md": "a changed doc\n", "pkg/src/a.ts": "export const a = 2;\n" });
    const r = leg(root, actions(root, "pull_request", []), "1/1");
    assert.equal(r.code, 0, r.out);
    assert.ok(r.out.includes(`Running every test file: pkg/src/a.ts has no rule that narrows it\nShard 1/1: ${TESTS} test files\n`), r.out.slice(0, 400));
    assert.equal(ran(r.out), RUNS);
  });

  it("an empty list of files is an error when every file should run", () => {
    const files = Object.fromEntries(Object.entries(TREE).filter(([f]) => !f.endsWith(".test.ts")));
    const { root } = repo({ "docs/a.md": "a changed doc\n" }, { ...files, "pkg/test/keep.txt": "" });
    for (const env of [actions(root, "push", []), actions(root, "pull_request", ["ready"]), actions(root, "pull_request", [], { TEST_SELECT: "" }), actions(root, "pull_request", [])]) {
      const r = leg(root, env, "1/1");
      assert.notEqual(r.code, 0, r.out);
      assert.match(r.out, /shard 1\/1 of every test file is empty/);
    }
  });

  it("prints what a quick run would select, from the command line", () => {
    const { root } = repo({ "docs/a.md": "a changed doc\n" });
    const r = spawnSync(process.execPath, ["--no-warnings", SELECT, "HEAD^1"], { cwd: join(root, "pkg"), encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^Selected 4 of \d+ test files for the 1 changed paths \(HEAD\^1\.\.HEAD\):\n/);
    assert.match(r.stdout, /\ntest\/docs\.test\.ts\ntest\/gen\.test\.ts\n/);
  });
});

// What was measured on this repository: with each path below made unreadable, these test files
// failed or lost their tests, or were seen reading it. The rules must keep selecting them.
describe("scripts/test-select.ts on this repository", () => {
  const MEASURED: Record<string, string[]> = {
    "docs/reference/cli.md": [
      "test/cli/config-doc-keys.test.ts",
      "test/docs/adapters-setup.test.ts",
      "test/docs/api-reference.test.ts",
      "test/docs/cli-reference.test.ts",
      "test/docs/clickhouse-howto.test.ts",
      "test/docs/guide-commands.test.ts",
      "test/docs/query-reference.test.ts",
      "test/docs/reference-drift.test.ts",
      "test/docs/sdk-reference.test.ts",
      "test/docs/troubleshooting.test.ts",
      "test/mcp/skills.test.ts",
    ],
    "apps/site/src/pages/index.astro": ["test/docs/guide-commands.test.ts", "test/docs/reference-drift.test.ts", "test/mcp/skills.test.ts"],
    "README.md": ["test/cli/help.test.ts"],
    "packages/sdk/src/index.ts": ["test/docs/reference-drift.test.ts", "test/docs/sdk-reference.test.ts", "test/integrations/gateway/sdk-tables.test.ts"],
    "packages/sdk-python/README.md": ["test/docs/reference-drift.test.ts", "test/docs/sdk-reference.test.ts", "test/integrations/gateway/sdk-tables.test.ts"],
    "packages/coding.sh/test/mcp/_blocking-server.ts": ["test/mcp/protocol.test.ts"],
  };

  for (const [path, measured] of Object.entries(MEASURED)) {
    it(`${path} selects every test file measured to read it`, () => {
      assert.ok(existsSync(join(ROOT, path)), `${path} is gone: measure again and update this list`);
      const s = narrowed(selectTests([path], ROOT));
      const still = measured.filter((f) => existsSync(join(PKG, f)));
      assert.ok(still.length >= Math.ceil(measured.length / 2), "most of the measured test files still exist");
      assert.deepEqual(still.filter((f) => !s.files.includes(f)), []);
      for (const f of ALWAYS) assert.ok(s.files.includes(f), f);
      assert.ok(s.files.length < testFiles(PKG).length / 2, "a narrowed run is less than half of the suite");
    });
  }

  it("runs everything for the source, the runner, the workflow, the manifests and the fixtures", () => {
    for (const path of [
      "packages/coding.sh/src/cli/registry.ts",
      "packages/coding.sh/scripts/test-ci.mjs",
      "packages/coding.sh/scripts/test-select.ts",
      "packages/coding.sh/scripts/test-shards.ts",
      "packages/coding.sh/scripts/test-durations.json",
      "packages/coding.sh/package.json",
      "packages/coding.sh/tsconfig.json",
      "packages/coding.sh/README.md",
      "packages/coding.sh/test/mcp/toolevals/tasks/llm-p95.toml",
      ".github/workflows/ci.yml",
      "scripts/ci-changes.mjs",
      "package.json",
      "package-lock.json",
      "apps/site/package.json",
      "packages/sdk/package.json",
      "packages/sdk-python/pyproject.toml",
      "action.yml",
      "LICENSE",
    ]) {
      assert.ok(existsSync(join(ROOT, path)), `${path} exists`);
      assert.equal(selectTests(["docs/README.md", path], ROOT).all, true, path);
    }
  });
});
