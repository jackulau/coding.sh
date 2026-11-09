import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { dependents, precommitPlan, prepushPlan, pushedFiles, workspaces } from "../lib.mjs";
import { main as install } from "../install.mjs";
import { main as runHook } from "../run.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: devNull,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  CODING_SH_SKIP_HOOKS: "",
};
// The hooks spawn git themselves; keep the user's global config out of them too.
for (const k of ["GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL"]) process.env[k] = ENV[k];

const temps = [];
after(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

function write(root, files) {
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), typeof body === "string" ? body : JSON.stringify(body, null, 2));
  }
}

function repo(files = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "slop-hooks-")));
  temps.push(root);
  write(root, files);
  git(root, ["init", "-q", "-b", "main"]);
  return root;
}

function git(root, args, input) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", env: ENV, input });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout.trim() };
}

const sink = () => {
  const s = { text: "", write: (t) => (s.text += t) };
  return s;
};

/** A monorepo shaped like coding.sh: a core package, a store that depends on it, a site, the Python SDK. */
const LAYOUT = {
  "package.json": { name: "root", private: true, workspaces: ["apps/*", "packages/*"] },
  "packages/core/package.json": { name: "core", scripts: { test: "node --test", typecheck: "tsc --noEmit" } },
  "packages/store/package.json": { name: "store", devDependencies: { core: "*" }, scripts: { test: "node --test", typecheck: "tsc --noEmit" } },
  "packages/sdk/package.json": { name: "sdk", scripts: { test: "node --test", typecheck: "tsc --noEmit" } },
  "packages/sdk-python/tests/test_x.py": "",
  "apps/site/package.json": { name: "site", scripts: { check: "astro check", build: "astro build" } },
};

const labels = (plan) => plan.map((s) => s.label);

test("workspaces and dependents follow package.json", () => {
  const root = repo(LAYOUT);
  const spaces = workspaces(root);
  assert.deepEqual(spaces.map((w) => w.dir), ["apps/site", "packages/core", "packages/sdk", "packages/store"]);
  assert.deepEqual(spaces.find((w) => w.name === "store").deps, ["core"]);
  assert.deepEqual(dependents(spaces, ["core"]).map((w) => w.name), ["core", "store"]);
});

test("pre-commit: slop lint on staged files, then typecheck of each touched package", () => {
  const root = repo(LAYOUT);
  assert.deepEqual(precommitPlan(root, []), []);
  assert.deepEqual(labels(precommitPlan(root, ["docs/a.md"])), ["slop lint (staged files)"]);
  const plan = precommitPlan(root, ["packages/core/src/a.ts", "apps/site/src/pages/index.astro"]);
  assert.deepEqual(labels(plan), ["slop lint (staged files)", "typecheck site", "typecheck core"]);
  assert.deepEqual(plan[0].args, ["scripts/lint/slop.mjs", "--staged"]);
  assert.deepEqual([plan[1].cwd, plan[1].args], ["apps/site", ["run", "--silent", "check"]]);
  assert.deepEqual([plan[2].cwd, plan[2].args], ["packages/core", ["run", "--silent", "typecheck"]]);
});

test("pre-push: tests of touched packages and their dependents, Python and script suites", () => {
  const root = repo(LAYOUT);
  assert.deepEqual(labels(prepushPlan(root, ["packages/core/src/a.ts"])), ["test core", "test store (depends on a changed package)"]);
  assert.deepEqual(labels(prepushPlan(root, ["packages/store/src/a.ts"])), ["test store"]);
  assert.deepEqual(labels(prepushPlan(root, ["apps/site/src/a.astro", "README.md"])), []);
  const py = prepushPlan(root, ["packages/sdk-python/src/x.py"]);
  assert.deepEqual(labels(py), ["test coding-sh (Python)"]);
  assert.equal(py[0].cwd, "packages/sdk-python");
  assert.deepEqual(labels(prepushPlan(root, ["scripts/lint/lib/rules.mjs", "scripts/dogfood/score.mjs"])), ["lint and hook tests", "dogfood tests"]);
});

test("pushedFiles diffs against the remote sha, or the fork point for a new branch", () => {
  const root = repo({ "a.txt": "1" });
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "one"]);
  const base = git(root, ["rev-parse", "HEAD"]).stdout;
  git(root, ["checkout", "-qb", "feature"]);
  write(root, { "packages/core/x.ts": "x", "b.txt": "2" });
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "two"]);
  const head = git(root, ["rev-parse", "HEAD"]).stdout;
  const zero = "0".repeat(40);
  assert.deepEqual(pushedFiles(root, `refs/heads/feature ${head} refs/heads/feature ${base}\n`).sort(), ["b.txt", "packages/core/x.ts"]);
  assert.deepEqual(pushedFiles(root, `refs/heads/feature ${head} refs/heads/feature ${zero}\n`).sort(), ["b.txt", "packages/core/x.ts"]);
  assert.deepEqual(pushedFiles(root, `(delete) ${zero} refs/heads/feature ${head}\n`), []);
  // A remote sha this clone has never seen: fall back to the fork point.
  assert.deepEqual(pushedFiles(root, `refs/heads/feature ${head} refs/heads/feature ${"1".repeat(40)}\n`).sort(), ["b.txt", "packages/core/x.ts"]);
});

test("run: --dry-run prints the plan, CODING_SH_SKIP_HOOKS skips it", () => {
  const root = repo(LAYOUT);
  write(root, { "packages/core/src/a.ts": "export const a = 1;\n" });
  git(root, ["add", "packages/core/src/a.ts"]);
  const out = sink();
  assert.equal(runHook(["pre-commit", "--dry-run", "--json"], { stdout: out, stderr: sink(), cwd: root, env: ENV }), 0);
  const doc = JSON.parse(out.text);
  assert.equal(doc.files, 1);
  assert.deepEqual(labels(doc.plan), ["slop lint (staged files)", "typecheck core"]);
  const err = sink();
  assert.equal(runHook(["pre-commit"], { stdout: sink(), stderr: err, cwd: root, env: { ...ENV, CODING_SH_SKIP_HOOKS: "1" } }), 0);
  assert.match(err.text, /skipped/);
  assert.equal(runHook(["pre-merge"], { stdout: sink(), stderr: sink(), cwd: root, env: ENV }), 2);
});

/** A repo with this checkout's lint and hooks copied in. */
function hookedRepo(extra = {}) {
  const root = repo({ "package.json": { name: "root", private: true, workspaces: ["packages/*"] }, ...extra });
  for (const dir of ["scripts/lint", "scripts/hooks"]) cpSync(join(REPO, dir), join(root, dir), { recursive: true, filter: (p) => !p.includes(`${dir}/test`) });
  write(root, { "scripts/lint/allowlist.json": { entries: [] } });
  return root;
}

test("install: sets core.hooksPath, reports status, uninstalls, and refuses to clobber", () => {
  const root = hookedRepo();
  const run = (args) => {
    const out = sink();
    const err = sink();
    return { code: install(args, { stdout: out, stderr: err, cwd: root }), out: out.text, err: err.text };
  };
  assert.match(run(["--status"]).out, /^not installed/);
  assert.equal(run([]).code, 0);
  assert.equal(git(root, ["config", "--local", "core.hooksPath"]).stdout, "scripts/hooks");
  assert.match(run(["--status"]).out, /^installed/);
  assert.match(run([]).out, /already installed/);
  assert.equal(run(["--uninstall"]).code, 0);
  assert.equal(git(root, ["config", "--local", "core.hooksPath"]).code, 1);

  git(root, ["config", "--local", "core.hooksPath", ".husky"]);
  const clash = run([]);
  assert.equal(clash.code, 1);
  assert.match(clash.err, /already \.husky/);
  assert.match(run(["--uninstall"]).out, /left alone/);
  assert.equal(git(root, ["config", "--local", "core.hooksPath"]).stdout, ".husky");
  git(root, ["config", "--local", "--unset", "core.hooksPath"]);

  write(root, { ".git/hooks/pre-commit": "#!/bin/sh\nexit 0\n" });
  const hidden = run([]);
  assert.equal(hidden.code, 1);
  assert.match(hidden.err, /would stop running: pre-commit/);
  assert.equal(run(["--force"]).code, 0);
  assert.equal(run(["--bogus"]).code, 2);
});

test("end to end: pre-commit blocks a commit with slop and a failing typecheck", { skip: process.platform === "win32" && "sh hooks" }, () => {
  const root = hookedRepo({
    "packages/core/package.json": { name: "core", scripts: { typecheck: "node -e \"process.exit(require('fs').existsSync('BROKEN') ? 1 : 0)\"" } },
  });
  assert.equal(install([], { stdout: sink(), stderr: sink(), cwd: root }), 0);
  git(root, ["add", "package.json", "scripts", "packages"]);
  assert.equal(git(root, ["commit", "-qm", "setup"]).code, 0, "a clean commit passes");

  write(root, { "packages/core/src/a.ts": "declare const raw: string;\nexport const n = raw as unknown as number;\n" });
  git(root, ["add", "packages/core/src/a.ts"]);
  const blocked = git(root, ["commit", "-qm", "slop"]);
  assert.notEqual(blocked.code, 0);
  assert.match(blocked.out, /packages\/core\/src\/a\.ts:2:\d+ {2}chained-as/);
  assert.match(blocked.out, /git commit --no-verify/);

  write(root, { "packages/core/src/a.ts": "export const n = Number('1');\n" });
  git(root, ["add", "packages/core/src/a.ts"]);
  write(root, { "packages/core/BROKEN": "" });
  const typecheck = git(root, ["commit", "-qm", "typed"]);
  assert.notEqual(typecheck.code, 0);
  assert.match(typecheck.out, /typecheck core failed/);
  rmSync(join(root, "packages/core/BROKEN"));
  assert.equal(git(root, ["commit", "-qm", "typed"]).code, 0);

  write(root, { "packages/core/src/b.ts": "export const b = { ...(process.env.X ? { x: 1 } : {}) };\n" });
  git(root, ["add", "packages/core/src/b.ts"]);
  assert.equal(git(root, ["commit", "--no-verify", "-qm", "skip once"]).code, 0, "--no-verify skips the hook");
});

test("end to end: pre-push runs the tests of the packages a push touches", { skip: process.platform === "win32" && "sh hooks" }, () => {
  const failIf = "node -e \"process.exit(require('fs').existsSync('FAIL') ? 1 : 0)\"";
  const root = hookedRepo({
    "packages/core/package.json": { name: "core", scripts: { test: failIf } },
    "packages/other/package.json": { name: "other", scripts: { test: "node -e \"process.exit(1)\"" } },
  });
  const remote = realpathSync(mkdtempSync(join(tmpdir(), "slop-remote-")));
  temps.push(remote);
  git(remote, ["init", "-q", "--bare"]);
  git(root, ["remote", "add", "origin", remote]);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "setup"]);
  assert.equal(git(root, ["push", "-q", "--no-verify", "origin", "main"]).code, 0);
  assert.equal(install([], { stdout: sink(), stderr: sink(), cwd: root }), 0);

  // Touches core only: core's tests run, and "other" (always failing) does not.
  write(root, { "packages/core/src/a.ts": "export const a = 1;\n", "packages/core/FAIL": "" });
  git(root, ["add", "packages/core/src/a.ts"]);
  git(root, ["commit", "-qm", "core"]);
  const blocked = git(root, ["push", "origin", "main"]);
  assert.notEqual(blocked.code, 0);
  assert.match(blocked.out, /test core failed/);
  assert.doesNotMatch(blocked.out, /test other/);
  rmSync(join(root, "packages/core/FAIL"));
  const ok = git(root, ["push", "origin", "main"]);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /pre-push: ok \(1 step/);
});
