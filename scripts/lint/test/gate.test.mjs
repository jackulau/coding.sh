import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { adapterVersions, branchFresh, repoHygiene } from "../../gate/checks.mjs";
import { buildSteps, interruptCleanup, isolatedEnv, ISOLATED, main, PYTHON_TEST_MODULES, pythonSdk, refusal, runPlan, selectSteps, storePlugins } from "../../gate.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const temps = [];
after(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});
const tmp = (prefix) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(d);
  return d;
};

// ---------------------------------------------------------------- runPlan

const collect = () => {
  const s = { text: "", out: (t) => (s.text += t) };
  return s;
};
const ok = (name, ran) => ({ name, run: async () => (ran.push(name), { status: "pass" }) });
const failing = (name, ran) => ({ name, run: async () => (ran.push(name), { status: "fail", exit: 3, detail: ["it broke"] }) });
const skipping = (name, ran) => ({ name, run: async () => (ran.push(name), { status: "skip", detail: ["Docker is not reachable"] }) });

test("runPlan stops at the first FAIL, names it and prints the rerun command", async () => {
  const ran = [];
  const io = collect();
  const { code } = await runPlan([ok("first", ran), failing("fail", ran), ok("third", ran)], { out: io.out });
  assert.equal(code, 1);
  assert.deepEqual(ran, ["first", "fail"]);
  assert.match(io.text, /gate \[1\/3\] first/);
  assert.match(io.text, /gate \[2\/3\] fail/);
  assert.match(io.text, /gate: FAILED at fail \(exit 3\); rerun: npm run gate -- --only fail/);
  assert.match(io.text, /third\s+NOT RUN/);
});

test("runPlan prints PASS with a time, and exits 0 when every step passes", async () => {
  const io = collect();
  const { code } = await runPlan([ok("a", []), ok("b", [])], { out: io.out });
  assert.equal(code, 0);
  assert.match(io.text, /PASS \(\d+(?:ms|\.\ds)\)/);
  assert.match(io.text, /gate: ok \(2 steps\)/);
});

test("a SKIP prints SKIP and its reason and is listed in the summary; the plan still passes", async () => {
  const io = collect();
  const { code } = await runPlan([ok("a", []), skipping("store-plugins", []), ok("c", [])], { out: io.out });
  assert.equal(code, 0);
  assert.match(io.text, /SKIP \(/);
  assert.match(io.text, /SKIPPED, so these were not checked here:\n  store-plugins: Docker is not reachable/);
  assert.match(io.text, /1 skipped/);
});

test("with strict, a SKIP fails the plan and stops it", async () => {
  const ran = [];
  const io = collect();
  const { code } = await runPlan([skipping("s", ran), ok("after", ran)], { out: io.out, strict: true });
  assert.equal(code, 1);
  assert.deepEqual(ran, ["s"]);
  assert.match(io.text, /--strict: a SKIP fails the gate/);
  assert.match(io.text, /gate: FAILED at s/);
});

test("with strict, a WARN fails the plan", async () => {
  const io = collect();
  const { code } = await runPlan([{ name: "w", run: async () => ({ status: "warn", detail: ["bump parseVersion"] }) }], { out: io.out, strict: true });
  assert.equal(code, 1);
  assert.match(io.text, /--strict: a WARN fails/);
});

test("without strict, a WARN passes and is listed", async () => {
  const io = collect();
  const { code } = await runPlan([{ name: "w", run: async () => ({ status: "warn", detail: ["bump parseVersion"] }) }], { out: io.out });
  assert.equal(code, 0);
  assert.match(io.text, /WARNINGS:\n  w: bump parseVersion/);
});

test("a step that throws is a FAIL with its message", async () => {
  const io = collect();
  const { code } = await runPlan([{ name: "boom", run: async () => { throw new Error("spawn failed"); } }], { out: io.out });
  assert.equal(code, 1);
  assert.match(io.text, /spawn failed/);
});

// ---------------------------------------------------------------- environment

test("isolatedEnv points every home variable into a fresh temp directory and drops store URLs", () => {
  const base = { PATH: "/bin", HOME: "/home/user", CODING_SH_HOME: "/home/user/.coding.sh", CODING_SH_STORE_URL: "postgres://real", CODEX_HOME: "/home/user/.codex" };
  const a = isolatedEnv(base);
  const b = isolatedEnv(base);
  temps.push(a.dir, b.dir);
  for (const key of Object.keys(ISOLATED)) {
    assert.ok(a.env[key].startsWith(a.dir), `${key} is under the temp dir`);
    assert.ok(existsSync(a.env[key]), `${key} exists`);
    assert.notEqual(a.env[key], b.env[key], `${key} is fresh for each call`);
  }
  for (const key of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "COPILOT_HOME", "PI_CODING_AGENT_DIR", "npm_config_prefix"]) assert.ok(key in a.env);
  assert.equal(a.env.PATH, "/bin");
  assert.equal(a.env.CODING_SH_STORE_URL, undefined);
  assert.notEqual(a.env.HOME, "/home/user");
});

test("the gate refuses to start when CODING_SH_DEV_REAL_STORE is set", async () => {
  assert.match(refusal({ CODING_SH_DEV_REAL_STORE: "1" }), /real coding\.sh store/);
  assert.equal(refusal({}), undefined);
  const io = { err: "", out: "" };
  const code = await main(["--only", "lint"], { env: { CODING_SH_DEV_REAL_STORE: "1" }, stdout: { write: (s) => (io.out += s) }, stderr: { write: (s) => (io.err += s) } });
  assert.equal(code, 2);
  assert.match(io.err, /CODING_SH_DEV_REAL_STORE/);
  assert.equal(io.out, "");
});

// ---------------------------------------------------------------- the plan

test("the plan has the steps in order, and --static keeps the ones that need no build", () => {
  const steps = buildSteps(REPO);
  assert.deepEqual(
    steps.map((s) => s.name),
    ["repo-hygiene", "branch-fresh", "lint", "lint-test", "actionlint", "generated-fresh", "coding.sh-check", "coding.sh-build", "store-plugins", "python-sdk", "site", "secret-scan", "adapter-versions"],
  );
  assert.deepEqual(
    selectSteps(steps, { only: [], static: true }).map((s) => s.name),
    ["repo-hygiene", "branch-fresh", "lint", "lint-test", "actionlint", "generated-fresh", "secret-scan"],
  );
  assert.deepEqual(selectSteps(steps, { only: [], from: "site" }).map((s) => s.name), ["site", "secret-scan", "adapter-versions"]);
  assert.deepEqual(selectSteps(steps, { only: ["lint", "site"] }).map((s) => s.name), ["lint", "site"]);
  assert.throws(() => selectSteps(steps, { only: ["nope"] }), /unknown step "nope"/);
  // A selection that would run nothing, or that --static silently drops, is a usage error.
  assert.throws(() => selectSteps(steps, { only: ["site"], static: true }), /site is not a static step/);
  assert.throws(() => selectSteps(steps, { only: [], from: "site", static: true }), /site is not a static step/);
  assert.throws(() => selectSteps(steps, { only: ["lint"], from: "secret-scan" }), /nothing to run/);
});

test("--list --json prints every step", async () => {
  let text = "";
  const code = await main(["--list", "--json"], { stdout: { write: (s) => (text += s) } });
  assert.equal(code, 0);
  const rows = JSON.parse(text);
  assert.equal(rows.length, 13);
  assert.equal(rows.find((r) => r.name === "lint").static, true);
  assert.equal(rows.find((r) => r.name === "site").static, false);
});

test("the lint step runs the allowlist check and the site step requires the dist tests", () => {
  const src = buildSteps(REPO);
  assert.ok(src.find((s) => s.name === "lint"));
  // Source-level proof: the gate names the flag and the variable it relies on.
  const text = spawnSync("grep", ["-c", "strict-allowlist\\|CODING_SH_REQUIRE_DIST", join(REPO, "scripts/gate.mjs")], { encoding: "utf8" }).stdout.trim();
  assert.ok(Number(text) >= 2);
});

// ---------------------------------------------------------------- store plugins

test("store-plugins removes its containers when a plugin's tests fail, and labels them", async () => {
  const calls = [];
  const docker = async (args) => {
    calls.push(args);
    if (args[0] === "info") return { code: 0, out: "" };
    if (args[0] === "run") return { code: 0, out: `id-${args.includes("POSTGRES_DB=coding") ? "pg" : "ch"}\n` };
    if (args[0] === "exec") return { code: 0, out: "" };
    if (args[0] === "ps") return { code: 0, out: "" };
    return { code: 0, out: "" };
  };
  const dirs = [];
  const step = storePlugins();
  const r = await step.run({ root: REPO, docker, wait: async () => {}, say: () => {}, isolated: () => isolatedEnv({}), check: async (dir) => (dirs.push(dir), { code: dir.includes("clickhouse") ? 1 : 0 }) });
  assert.equal(r.status, "fail");
  assert.deepEqual(dirs, ["packages/store-postgres", "packages/store-clickhouse"]);
  const runs = calls.filter((c) => c[0] === "run");
  assert.equal(runs.length, 2);
  for (const c of runs) assert.ok(c.includes(`gate=${process.pid}`), "labeled with the pid");
  assert.ok(calls.some((c) => c[0] === "rm" && c.includes("id-pg") && c.includes("id-ch")), "removed in finally");
});

test("store-plugins without Docker skips the database plugins loudly and still runs blob-s3", async () => {
  const dirs = [];
  const docker = async (args) => (args[0] === "info" ? { code: 1, out: "" } : { code: 0, out: "" });
  const r = await storePlugins().run({ root: REPO, docker, wait: async () => {}, say: () => {}, isolated: () => isolatedEnv({}), check: async (dir) => (dirs.push(dir), { code: 0 }) });
  assert.equal(r.status, "skip");
  assert.match(r.detail[0], /Docker is not reachable/);
  assert.deepEqual(dirs, ["packages/blob-s3"]);
});

// ---------------------------------------------------------------- python sdk

/** A fake exec for python-sdk: `missing` is what the module probe prints, `testCode` the unittest exit code. */
const fakePython = (missing, testCode = 0) => {
  const calls = [];
  const exec = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, env: opts.env });
    if (args[0] === "--version") return { code: 0, out: "Python 3.13.0\n" };
    if (args[0] === "-c") return { code: 0, out: `${missing.join(" ")}\n` };
    return { code: testCode, out: "" };
  };
  return { calls, exec };
};
const pyCtx = (exec) => ({ root: REPO, exec, say: () => {}, isolated: () => isolatedEnv({}) });

test("python-sdk requires every optional test to run when python3 has the extras", async () => {
  const { calls, exec } = fakePython([]);
  const r = await pythonSdk().run(pyCtx(exec));
  assert.equal(r.status, "pass");
  const probe = calls.find((c) => c.args[0] === "-c");
  assert.deepEqual(probe.args.slice(2), PYTHON_TEST_MODULES);
  const tests = calls.find((c) => c.args[0] === "-m");
  assert.equal(tests.env.CODING_SH_SDK_REQUIRE_ALL, "1");
});

test("python-sdk without an extra still runs the tests, then SKIPs and names the module and the install", async () => {
  const { calls, exec } = fakePython(["openai", "mypy"]);
  const r = await pythonSdk().run(pyCtx(exec));
  assert.equal(r.status, "skip");
  assert.match(r.detail[0], /openai, mypy/);
  assert.match(r.detail[1], /pip install '\.\[otel,openai,anthropic\]' mypy/);
  const tests = calls.find((c) => c.args[0] === "-m");
  assert.equal(tests.env.CODING_SH_SDK_REQUIRE_ALL, undefined);
});

test("python-sdk fails when the tests fail, even with an extra missing", async () => {
  const { exec } = fakePython(["anthropic"], 1);
  const r = await pythonSdk().run(pyCtx(exec));
  assert.equal(r.status, "fail");
});

test("the module probe python-sdk runs prints only the modules python3 cannot import", { skip: spawnSync("python3", ["--version"]).status !== 0 && "no python3" }, async () => {
  const { exec } = await import("../../gate.mjs");
  const seen = [];
  const spy = async (cmd, args, opts) => {
    const r = await exec(cmd, args, opts);
    if (args[0] === "-c") seen.push(r.out.trim());
    return args[0] === "-m" ? { code: 0, out: "" } : r;
  };
  await pythonSdk().run(pyCtx(spy));
  const missing = seen[0].split(/\s+/).filter(Boolean);
  for (const m of missing) assert.ok(PYTHON_TEST_MODULES.includes(m), m);
  // A submodule whose parent package is missing counts as missing, not as a probe crash.
  const hasOtel = spawnSync("python3", ["-c", "import opentelemetry"]).status === 0;
  if (!hasOtel) assert.ok(missing.includes("opentelemetry.sdk"));
});

test("an interrupted gate stops its children and removes its labeled containers and temp homes", () => {
  const calls = [];
  const docker = (args) => {
    calls.push(args);
    return args[0] === "ps" ? { status: 0, stdout: "c1\nc2\n" } : { status: 0, stdout: "" };
  };
  const killed = [];
  const child = { kill: (sig) => killed.push(sig) };
  const home = tmp("gate-home-");
  interruptCleanup({ made: [home], label: "gate=42", children: new Set([child]), docker });
  assert.deepEqual(killed, ["SIGTERM"]);
  assert.deepEqual(calls[0], ["ps", "-aq", "--filter", "label=gate=42"]);
  assert.deepEqual(calls[1], ["rm", "-f", "-v", "c1", "c2"]);
  assert.equal(existsSync(home), false);
});

test("SIGINT during a gate run exits 130 and leaves no temp home", { skip: process.platform === "win32" && "POSIX signals" }, async () => {
  // A child gate whose only step waits; the parent interrupts it once the step has started.
  const script = join(tmp("gate-int-"), "run.mjs");
  writeFileSync(script, `
import { runSteps } from ${JSON.stringify(pathToFileURL(join(REPO, "scripts/gate.mjs")).href)};
const steps = [{ name: "slow", run: async (ctx) => { const { dir } = ctx.isolated(); console.log("HOME " + dir); await new Promise((r) => setTimeout(r, 30000)); return { status: "pass" }; } }];
process.exitCode = await runSteps(steps);
`);
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (b) => (out += b));
  await new Promise((r) => {
    const t = setInterval(() => {
      if (/HOME (\S+)/.test(out)) {
        clearInterval(t);
        r();
      }
    }, 20);
  });
  const home = /HOME (\S+)/.exec(out)[1];
  assert.equal(existsSync(home), true);
  child.kill("SIGINT");
  const code = await new Promise((r) => child.on("close", (c) => r(c)));
  assert.equal(code, 130);
  assert.equal(existsSync(home), false);
});

// ---------------------------------------------------------------- repo-hygiene, in temp git repos

const NOREPLY = "1234+someone@users.noreply.github.com";
const globalConfig = (email = NOREPLY) => {
  const f = join(tmp("gate-gitconfig-"), "gitconfig");
  writeFileSync(f, email ? `[user]\n\temail = ${email}\n\tname = Someone\n` : "");
  return f;
};

/** A git repo whose environment reads a throwaway global config, never yours. */
function repo(files = { ".gitignore": "/.claude/\n", "a.txt": "a\n" }, { email = NOREPLY } = {}) {
  const root = tmp("gate-repo-");
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: globalConfig(email), HOME: root };
  for (const k of ["GIT_AUTHOR_EMAIL", "GIT_AUTHOR_NAME", "GIT_COMMITTER_EMAIL", "GIT_COMMITTER_NAME"]) delete env[k];
  const git = (args, extra = {}) => {
    const r = spawnSync("git", args, { cwd: root, encoding: "utf8", env: { ...env, ...extra } });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git(["init", "-q", "-b", "main"]);
  const write = (files) => {
    for (const [p, body] of Object.entries(files)) {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), body);
    }
  };
  const commit = (msg, files = {}, as) => {
    write(files);
    git(["add", "-A"]);
    const who = as ? { GIT_AUTHOR_EMAIL: as, GIT_COMMITTER_EMAIL: as, GIT_AUTHOR_NAME: "x", GIT_COMMITTER_NAME: "x" } : {};
    git(["commit", "-q", "--allow-empty", "-m", msg], who);
    return git(["rev-parse", "HEAD"]);
  };
  write(files);
  return { root, env, git, commit, write };
}

test("repo-hygiene passes for a noreply author, with the global identity and private files untracked", () => {
  const r = repo();
  r.commit("base");
  r.git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  r.commit("change", { "b.txt": "b\n" });
  const res = repoHygiene(r.root, { env: r.env });
  assert.equal(res.status, "pass", res.detail.join("\n"));
});

test("repo-hygiene fails for a commit authored with a non-noreply email and names the commit", () => {
  const r = repo();
  r.commit("base");
  r.git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  const sha = r.commit("bad", { "b.txt": "b\n" }, "x@example.test");
  const res = repoHygiene(r.root, { env: r.env });
  assert.equal(res.status, "fail");
  assert.match(res.detail.join("\n"), new RegExp(`commit ${sha.slice(0, 10)} is authored by x@example\\.test`));
});

test("repo-hygiene fails when a commit is authored by a different noreply identity than the global one", () => {
  const r = repo();
  r.commit("base");
  r.git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  r.commit("other", { "b.txt": "b\n" }, "9999+other@users.noreply.github.com");
  assert.equal(repoHygiene(r.root, { env: r.env }).status, "fail");
});

test("repo-hygiene fails when the repo sets its own user.email", () => {
  const r = repo();
  r.commit("base");
  r.git(["config", "--local", "user.email", "someone@example.test"]);
  const res = repoHygiene(r.root, { env: r.env });
  assert.equal(res.status, "fail");
  assert.match(res.detail.join("\n"), /repo-local git identity set \(user\.email\); unset it, commits use the global one/);
});

test("repo-hygiene fails when the global user.email is missing and the branch has commits", () => {
  const r = repo(undefined, { email: "" });
  r.commit("base", {}, NOREPLY);
  r.git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  assert.equal(repoHygiene(r.root, { env: r.env }).status, "pass", "no commits on the branch: nothing to check");
  r.commit("change", { "b.txt": "b\n" }, NOREPLY);
  const res = repoHygiene(r.root, { env: r.env });
  assert.equal(res.status, "fail");
  assert.match(res.detail.join("\n"), /global git user\.email is not set/);
});

test("repo-hygiene passes a contributor whose global address is not a noreply one, and notes it", () => {
  const dev = "dev@example.test";
  const r = repo(undefined, { email: dev });
  r.commit("base", {}, dev);
  r.git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  const none = repoHygiene(r.root, { env: r.env });
  assert.equal(none.status, "pass", none.detail.join("\n"));
  r.commit("change", { "b.txt": "b\n" }, dev);
  const res = repoHygiene(r.root, { env: r.env });
  assert.equal(res.status, "pass", res.detail.join("\n"));
  assert.match(res.detail.join("\n"), /not a users\.noreply\.github\.com address/);
  r.commit("other", { "c.txt": "c\n" }, "someone@example.test");
  assert.equal(repoHygiene(r.root, { env: r.env }).status, "fail", "a commit by another identity still fails");
});

test("repo-hygiene fails for a force-added agent file and never prints its name", () => {
  const r = repo();
  r.write({ ".claude/skills/x/SKILL.md": "private\n" });
  r.git(["add", "-f", ".claude/skills/x/SKILL.md"]);
  r.commit("oops");
  const res = repoHygiene(r.root, { env: r.env });
  assert.equal(res.status, "fail");
  const text = res.detail.join("\n");
  assert.match(text, /private agent files are tracked: \.claude\/skills \(1 file\)/);
  assert.ok(!text.includes("SKILL.md"));
});

test("repo-hygiene fails when .gitignore no longer ignores /.claude/", () => {
  const r = repo({ ".gitignore": "node_modules/\n", "a.txt": "a\n" });
  r.commit("base");
  const res = repoHygiene(r.root, { env: r.env });
  assert.equal(res.status, "fail");
  assert.match(res.detail.join("\n"), /\/\.claude\//);
});

test("repo-hygiene in CI checks only the noreply suffix of a pushed range; merges and bots pass", () => {
  const r = repo();
  const base = r.commit("base");
  const sha = r.commit("outside", { "b.txt": "b\n" }, "x@example.test");
  const range = `${base}..${sha}`;
  const res = repoHygiene(r.root, { env: r.env, ci: true, range });
  assert.equal(res.status, "fail");
  const fine = r.commit("inside", { "c.txt": "c\n" }, "5+bot@users.noreply.github.com");
  assert.equal(repoHygiene(r.root, { env: r.env, ci: true, range: `${sha}..${fine}` }).status, "pass");
  // Without a range, CI has no commits to judge.
  assert.equal(repoHygiene(r.root, { env: r.env, ci: true }).status, "pass");
});

test("repo-hygiene in CI checks the pushed commit alone when the push's base is gone (force-push, new branch)", () => {
  const r = repo();
  r.commit("base");
  const good = r.commit("good", { "b.txt": "b\n" });
  for (const before of ["deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", "0000000000000000000000000000000000000000"]) {
    const res = repoHygiene(r.root, { env: r.env, ci: true, range: `${before}..${good}` });
    assert.equal(res.status, "pass", res.detail.join("\n"));
    assert.match(res.detail.join("\n"), /is not in this clone .*checked [0-9a-f]{10} alone/);
  }
  const bad = r.commit("bad", { "c.txt": "c\n" }, "x@example.test");
  const res = repoHygiene(r.root, { env: r.env, ci: true, range: `deadbeefdeadbeefdeadbeefdeadbeefdeadbeef..${bad}` });
  assert.equal(res.status, "fail");
  assert.match(res.detail.join("\n"), new RegExp(`commit ${bad.slice(0, 10)} is authored by x@example\\.test`));
});

test("a tracked agent file does not make repo-hygiene claim .gitignore lacks the line it has", () => {
  const r = repo();
  r.write({ ".claude/skills/x/SKILL.md": "private\n" });
  r.git(["add", "-f", ".claude/skills/x/SKILL.md"]);
  r.commit("oops");
  const text = repoHygiene(r.root, { env: r.env }).detail.join("\n");
  assert.match(text, /private agent files are tracked/);
  assert.doesNotMatch(text, /\.gitignore needs a \/\.claude\/ line/);
});

// ---------------------------------------------------------------- branch-fresh

test("branch-fresh passes when origin/main is an ancestor of HEAD", () => {
  const r = repo();
  r.commit("base");
  r.git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  r.commit("work", { "b.txt": "b\n" });
  assert.equal(branchFresh(r.root, { env: r.env }).status, "pass");
});

test("branch-fresh fails when main added a site test since the branch point", () => {
  const r = repo();
  r.commit("base");
  r.git(["checkout", "-q", "-b", "feature"]);
  r.commit("work", { "b.txt": "b\n" });
  r.git(["checkout", "-q", "main"]);
  r.commit("main adds a test", { "apps/site/test/x.test.mjs": "// x\n" });
  r.git(["update-ref", "refs/remotes/origin/main", "main"]);
  r.git(["checkout", "-q", "feature"]);
  const res = branchFresh(r.root, { env: r.env });
  assert.equal(res.status, "fail");
  assert.match(res.detail.join("\n"), /rebase onto origin\/main/);
  assert.match(res.detail.join("\n"), /apps\/site\/test\/x\.test\.mjs/);
});

test("branch-fresh only warns when main moved but changed no tests or lint rules", () => {
  const r = repo();
  r.commit("base");
  r.git(["checkout", "-q", "-b", "feature"]);
  r.commit("work", { "b.txt": "b\n" });
  r.git(["checkout", "-q", "main"]);
  r.commit("main moves", { "docs/x.md": "x\n" });
  r.git(["update-ref", "refs/remotes/origin/main", "main"]);
  r.git(["checkout", "-q", "feature"]);
  assert.equal(branchFresh(r.root, { env: r.env }).status, "warn");
});

// ---------------------------------------------------------------- adapter-versions

const ADAPTER = "packages/coding.sh/src/adapters/more/aider.ts";
const GOLDEN = "packages/coding.sh/test/fixtures/adapters/aider/golden/x.golden.json";
const adapterRepo = () => {
  const r = repo({ ".gitignore": "/.claude/\n", [ADAPTER]: "export const a = { parseVersion: 3 };\n", [GOLDEN]: "{}\n", "packages/coding.sh/src/core/sessions.ts": "export const SESSION_FOLD_VERSION = 19; // x\n" });
  const base = r.commit("base");
  return { ...r, base };
};

test("adapter-versions warns when an adapter and its golden changed without a parseVersion bump", () => {
  const r = adapterRepo();
  r.commit("parse differently", { [ADAPTER]: "export const a = { parseVersion: 3 }; // changed\n", [GOLDEN]: '{"a":1}\n' });
  const res = adapterVersions(r.root, { env: r.env, base: r.base });
  assert.equal(res.status, "warn");
  assert.match(res.detail.join("\n"), /bump parseVersion/);
});

test("adapter-versions passes when parseVersion changed too", () => {
  const r = adapterRepo();
  r.commit("parse differently", { [ADAPTER]: "export const a = { parseVersion: 4 };\n", [GOLDEN]: '{"a":1}\n' });
  assert.equal(adapterVersions(r.root, { env: r.env, base: r.base }).status, "pass");
});

test("adapter-versions warns when a session-stat golden changed without SESSION_FOLD_VERSION", () => {
  const r = adapterRepo();
  const stats = "packages/coding.sh/test/core/x.golden.json";
  r.commit("stats", { [stats]: '{"stats":{"a":1}}\n' });
  const res = adapterVersions(r.root, { env: r.env, base: r.base });
  assert.equal(res.status, "warn");
  assert.match(res.detail.join("\n"), /SESSION_FOLD_VERSION/);
  r.commit("bump", { "packages/coding.sh/src/core/sessions.ts": "export const SESSION_FOLD_VERSION = 20; // x\n" });
  assert.equal(adapterVersions(r.root, { env: r.env, base: r.base }).status, "pass");
});
