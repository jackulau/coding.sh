import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { RunSpec } from "../../src/core/types.ts";
import { createRedactor } from "../../src/core/redact.ts";
import { readGraderUsage, runTask } from "../../src/runner/run.ts";
import { BUGGY, FIXED, cleanupWorlds, fakeAdapter, obedientAgent, toyWorld } from "../helpers-eval.ts";

after(cleanupWorlds);

describe("runTask", () => {
  it("runs the agent in an overlaid work dir and grades it with hidden tests", async () => {
    const w = await toyWorld();
    const adapter = obedientAgent();
    const bundle = await w.mkBundle("fixer", "always fix bugs");
    const r = await runTask({ task: w.task, bundle, adapter, blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir, attempt: 2, experimentId: "e1", env: { EXTRA: "x" } });
    assert.equal(r.error, undefined);
    assert.equal(r.pass, true);
    assert.equal(r.verifierExit, 0);
    assert.equal(r.attempt, 2);
    assert.equal(r.experimentId, "e1");
    assert.equal(r.sessionId, `sess-${r.id}`);
    assert.deepEqual(w.index.runs, [r]);
    const spec = adapter.specs[0] as RunSpec;
    assert.equal(spec.instruction, "fix add and mul");
    assert.equal(spec.env.CODING_SH_RUN_ID, r.id);
    assert.equal(spec.env.FROM_BUNDLE, "1");
    assert.equal(spec.env.EXTRA, "x");
    assert.equal(spec.env.HOME, undefined, "no ~/ files → no HOME override");
    assert.deepEqual(spec.flags, ["--b", "--fake-overlay"]);
    // Agent's diff only: no overlay (CLAUDE.md, README removal), no setup output, no hidden tests.
    const diff = (await w.blobs.getText(r.diffBlob ?? "")) ?? "";
    assert.match(diff, /src\/add\.js/);
    assert.match(diff, /src\/mul\.js/);
    assert.doesNotMatch(diff, /CLAUDE\.md|README|build\.log|add\.test\.js/);
    assert.deepEqual(await readdir(w.runsDir), [], "run dir cleaned up");
    assert.equal(r.agent.finalText, "done", "no stdout file: the answer comes from the tail");
  });

  it("hands the verifier the agent's answer and whole stdout, outside the work tree, and sums its judge spend", async () => {
    const w = await toyWorld();
    const stream = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "vercel whoami" } }] } }),
      JSON.stringify({ type: "result", result: "Which Vercel team should I audit?" }),
    ];
    const adapter = fakeAdapter({
      act: async (spec) => {
        assert.ok(spec.stdoutFile, "the runner asks the adapter to tee stdout");
        await writeFile(spec.stdoutFile, stream.join("\n") + "\n");
        await writeFile(join(spec.cwd, "notes.txt"), "asked for scope\n");
      },
    });
    const verifier = [
      'test "$CODING_SH_AGENT" = fake',
      'grep -q "^+asked for scope" "$CODING_SH_AGENT_DIFF"',
      'case "$CODING_SH_AGENT_DIFF" in "$PWD"/*) exit 4;; esac',
      'test "$(cat "$CODING_SH_AGENT_OUTPUT")" = "Which Vercel team should I audit?"',
      'grep -q "vercel whoami" "$CODING_SH_AGENT_STDOUT"',
      'test "$CODING_SH_SESSION_ID" = "sess-$CODING_SH_RUN_ID"',
      'case "$CODING_SH_AGENT_OUTPUT" in "$PWD"/*) exit 3;; esac',
      `printf '%s\\n' '{"model":"m","costUsd":0.25,"inputTokens":10,"outputTokens":5}' '{"model":"unknown"}' 'not json' >> "$CODING_SH_GRADER_USAGE"`,
    ].join(" && ");
    const task = { ...w.task, setup: [], verifier: { command: verifier, hiddenFiles: {}, timeoutMs: 30_000 } };
    const r = await runTask({ task, bundle: await w.mkBundle("x", "x"), adapter, blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir });
    assert.equal(r.verifierExit, 0, r.error);
    assert.equal(r.pass, true);
    assert.equal(r.agent.finalText, "Which Vercel team should I audit?");
    assert.deepEqual(r.graderUsage, { calls: 2, costUsd: 0.25, unpriced: 1, inputTokens: 10, outputTokens: 5 });
  });

  it("readGraderUsage: a missing file is no usage", async () => {
    assert.equal(await readGraderUsage("/nonexistent/grader-usage.jsonl"), undefined);
  });

  it("ingests before removing the run dir, so the agent's transcript in it can still be read; an ingest error never fails the run", async () => {
    const w = await toyWorld();
    const seen: boolean[] = [];
    const ingest = async () => {
      const [dir] = await readdir(w.runsDir);
      seen.push(!!dir && existsSync(join(w.runsDir, dir, "work")));
      throw new Error("ingest down");
    };
    const r = await runTask({ task: w.task, bundle: await w.mkBundle("fixer", "always fix bugs"), adapter: obedientAgent(), blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir, ingest });
    assert.deepEqual(seen, [true]);
    assert.equal(r.pass, true);
    assert.equal(r.error, undefined);
    assert.deepEqual(await readdir(w.runsDir), []);
  });

  it("records a failing attempt without throwing", async () => {
    const w = await toyWorld();
    const r = await runTask({ task: w.task, bundle: await w.mkBundle("half", "half effort"), adapter: obedientAgent(), blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir });
    assert.equal(r.pass, false);
    assert.equal(r.verifierExit, 1);
    assert.equal(r.error, undefined);
  });

  it("keeps the end of a failed verifier's output on the run, colour codes removed and secrets redacted", async () => {
    const w = await toyWorld();
    const key = ["sk-ant-", "api03-", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"].join("");
    const script = [
      "for i in $(seq 1 600); do echo \"ok $i\"; done",
      `printf '\\033[31mFAIL\\033[0m expected 5, got -1 (sent ${key})\\n'`,
      "echo 'AssertionError: -1 !== 5' >&2",
      "echo 'order ACME-123456' >&2",
      "exit 1",
    ].join("; ");
    const task = { ...w.task, setup: [], verifier: { command: script, hiddenFiles: {}, timeoutMs: 30_000 } };
    const redactor = createRedactor({ redact: ["secrets"], patterns: ["ACME-\\d{6}"] });
    const r = await runTask({ task, bundle: await w.mkBundle("x", "x"), adapter: obedientAgent(), blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir, redactor });
    assert.equal(r.verifierExit, 1);
    const o = r.verifierOutput;
    assert.ok(o?.stdout && o.stderr, JSON.stringify(o));
    assert.match(o.stdout, /FAIL expected 5, got -1 \(sent \[redacted:anthropic-key\]\)$/);
    assert.doesNotMatch(o.stdout, /\x1b|sk-ant/);
    assert.ok(o.stdout.length <= 4100 && /^…\nok \d+\n/.test(o.stdout), "the start is trimmed to whole lines");
    assert.equal(o.stderr, "AssertionError: -1 !== 5\norder [redacted:pattern]");
    assert.deepEqual(w.index.runs[0]?.verifierOutput, o, "stored with the run");
  });

  it("keeps no verifier output when the verifier printed nothing", async () => {
    const w = await toyWorld();
    const task = { ...w.task, setup: [], verifier: { command: "exit 1", hiddenFiles: {}, timeoutMs: 30_000 } };
    const r = await runTask({ task, bundle: await w.mkBundle("x", "x"), adapter: obedientAgent(), blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir });
    assert.equal(r.verifierExit, 1);
    assert.equal("verifierOutput" in r, false);
  });

  it("an agent that throws becomes an error; the verifier still runs", async () => {
    const w = await toyWorld();
    const r = await runTask({ task: w.task, bundle: await w.mkBundle("x", "x"), adapter: fakeAdapter({ throws: true }), blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir });
    assert.equal(r.pass, false);
    assert.match(r.error ?? "", /agent failed: agent exploded/);
    assert.equal(r.verifierExit, 1);
    assert.equal(w.index.runs.length, 1);
  });

  it("setup failure is recorded and the agent never runs", async () => {
    const w = await toyWorld();
    const adapter = obedientAgent();
    const r = await runTask({ task: { ...w.task, setup: ["exit 9"] }, bundle: await w.mkBundle("x", "fix"), adapter, blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir });
    assert.match(r.error ?? "", /setup `exit 9` exited 9/);
    assert.equal(adapter.specs.length, 0);
    assert.equal(w.index.runs.length, 1);
  });

  it("~/ overlay files get an isolated HOME inside the run dir; keep leaves the dir", async () => {
    const w = await toyWorld();
    const bundle = await w.mkBundle("home", "fix", { files: { "CLAUDE.md": await w.blobs.put("fix"), "~/.claude/CLAUDE.md": await w.blobs.put("user-level") } });
    const adapter = obedientAgent();
    const r = await runTask({ task: w.task, bundle, adapter, blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir, keep: true });
    const home = (adapter.specs[0] as RunSpec).env.HOME ?? "";
    assert.equal(home, join(w.runsDir, r.id, "home"));
    assert.notEqual(home, process.env.HOME);
    assert.equal(await readFile(join(home, ".claude/CLAUDE.md"), "utf8"), "user-level");
    assert.ok(existsSync(join(w.runsDir, r.id, "work", "src/add.js")));
  });

  it("a broken snapshot is an error result, not an exception", async () => {
    const w = await toyWorld();
    const r = await runTask({ task: { ...w.task, start: { ...w.task.start, snapshot: "missing" } }, bundle: await w.mkBundle("x", "x"), adapter: obedientAgent(), blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir });
    assert.match(r.error ?? "", /unknown snapshot/);
    assert.equal(r.pass, false);
  });
});

// R1-6: verifier isolation. Each exploit makes the verifier pass without the
// fix when the verifier runs in the agent's tree (isolation off), and fails
// with isolation on; an honest fix still passes.
const hasBin = (b: string) => spawnSync(b, ["--version"], { encoding: "utf8" }).status === 0;
const hasPytest = hasBin("python3") && spawnSync("python3", ["-c", "import pytest"]).status === 0;

/** A start whose `npm test` (and a run_tests.sh) runs the hidden test, so package.json, .npmrc and the script decide what runs. */
async function exploitWorld(extraStart: Record<string, string> = {}) {
  const w = await toyWorld();
  w.git.add("npm-start", {
    ...BUGGY,
    "package.json": JSON.stringify({ name: "toy", version: "1.0.0", type: "module", scripts: { test: "node test/add.test.js" } }, null, 2) + "\n",
    "run_tests.sh": "node test/add.test.js\n",
    ".gitignore": "build/\n",
    ...extraStart,
  });
  const task = (command: string, meta?: Record<string, unknown>) => ({
    ...w.task,
    setup: [],
    start: { ...w.task.start, snapshot: "npm-start" },
    verifier: { ...w.task.verifier, command },
    ...(meta ? { meta } : {}),
  });
  return { w, task };
}

/** An agent that leaves src unfixed and writes these files instead. */
const cheat = (files: Record<string, string>) => fakeAdapter({ act: () => files });

describe("runTask: verifier isolation", () => {
  it("an honest source fix still passes, and nothing is stripped", async () => {
    const { w, task } = await exploitWorld();
    const r = await runTask({ task: task("npm test --silent"), bundle: await w.mkBundle("fixer", "always fix bugs"), adapter: obedientAgent(), blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir });
    assert.equal(r.pass, true, r.verifierOutput?.stderr ?? r.error);
    assert.deepEqual(r.isolation, { carried: 2, stripped: [] });
  });

  it("package.json test script edited to exit 0: passes in the agent's tree, fails isolated; other package.json edits stay", { skip: !hasBin("npm") && "npm not found" }, async () => {
    const { w, task } = await exploitWorld();
    const pkg = JSON.stringify({ name: "toy", version: "1.0.0", type: "module", description: "agent edit", scripts: { test: "exit 0" } }, null, 2) + "\n";
    const bundle = await w.mkBundle("x", "x");
    const open = await runTask({ task: task("npm test --silent", { verifierIsolation: "off" }), bundle, adapter: cheat({ "package.json": pkg }), blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir });
    assert.equal(open.pass, true, "the exploit works without isolation");
    assert.equal(open.isolation, undefined);
    const verify = 'npm test --silent && grep -q "agent edit" package.json';
    const r = await runTask({ task: task(verify), bundle, adapter: cheat({ "package.json": pkg }), blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir, keep: true });
    assert.equal(r.pass, false);
    assert.deepEqual(r.isolation?.stripped, [{ path: "package.json", why: "scripts", change: "modify" }]);
    // The verified tree kept the description but not the script; the agent's tree is untouched.
    const verified = JSON.parse(await readFile(join(w.runsDir, r.id, "verified", "package.json"), "utf8"));
    assert.equal(verified.description, "agent edit");
    assert.equal(verified.scripts.test, "node test/add.test.js");
    assert.equal(JSON.parse(await readFile(join(w.runsDir, r.id, "work", "package.json"), "utf8")).scripts.test, "exit 0");
    assert.ok(!existsSync(join(w.runsDir, r.id, "work", "test/add.test.js")), "hidden tests never land in the agent's tree");
  });

  it(".npmrc node-options=--require: passes in the agent's tree, fails isolated", { skip: !hasBin("npm") && "npm not found" }, async () => {
    const { w, task } = await exploitWorld();
    const files = { ".npmrc": "node-options=--require ./hack.cjs\n", "hack.cjs": "process.exit(0);\n" };
    const bundle = await w.mkBundle("x", "x");
    const open = await runTask({ task: task("npm test --silent", { verifierIsolation: "off" }), bundle, adapter: cheat(files), blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir });
    assert.equal(open.pass, true, "the exploit works without isolation");
    const r = await runTask({ task: task("npm test --silent"), bundle, adapter: cheat(files), blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir });
    assert.equal(r.pass, false);
    assert.deepEqual(r.isolation?.stripped, [{ path: ".npmrc", why: "hook", change: "add" }]);
  });

  it("sitecustomize.py on PYTHONPATH: passes in the agent's tree, fails isolated", { skip: !hasBin("python3") && "python3 not found" }, async () => {
    const { w, task } = await exploitWorld({ "check.py": "import subprocess, sys\nsys.exit(subprocess.call(['node', 'test/add.test.js']))\n" });
    const files = { "sitecustomize.py": "import os\nos._exit(0)\n" };
    const bundle = await w.mkBundle("x", "x");
    const cmd = "PYTHONPATH=. python3 check.py";
    const open = await runTask({ task: task(cmd, { verifierIsolation: "off" }), bundle, adapter: cheat(files), blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir });
    assert.equal(open.pass, true, "the exploit works without isolation");
    const r = await runTask({ task: task(cmd), bundle, adapter: cheat(files), blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir });
    assert.equal(r.pass, false);
    assert.deepEqual(r.isolation?.stripped, [{ path: "sitecustomize.py", why: "hook", change: "add" }]);
  });

  it("a .pth file in a vendored site-packages: stripped", async () => {
    const { w, task } = await exploitWorld();
    const r = await runTask({ task: task("node test/add.test.js"), bundle: await w.mkBundle("x", "x"), adapter: cheat({ ".venv/lib/python3.12/site-packages/zz.pth": "import os; os._exit(0)\n" }), blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir });
    assert.deepEqual(r.isolation?.stripped, [{ path: ".venv/lib/python3.12/site-packages/zz.pth", why: "hook", change: "add" }]);
  });

  it("conftest.py that marks every test passed: passes in the agent's tree, fails isolated", { skip: !hasPytest && "pytest not installed" }, async () => {
    const { w, task } = await exploitWorld({ "test_add.py": "import subprocess\n\ndef test_add():\n    assert subprocess.call(['node', 'test/add.test.js']) == 0\n" });
    const conftest = [
      "import pytest",
      "@pytest.hookimpl(hookwrapper=True)",
      "def pytest_runtest_makereport(item, call):",
      "    outcome = yield",
      "    rep = outcome.get_result()",
      "    rep.outcome = 'passed'",
      "",
    ].join("\n");
    const bundle = await w.mkBundle("x", "x");
    const cmd = "python3 -m pytest -q -p no:cacheprovider test_add.py";
    const open = await runTask({ task: task(cmd, { verifierIsolation: "off" }), bundle, adapter: cheat({ "conftest.py": conftest }), blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir });
    assert.equal(open.pass, true, "the exploit works without isolation");
    const r = await runTask({ task: task(cmd), bundle, adapter: cheat({ "conftest.py": conftest }), blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir });
    assert.equal(r.pass, false);
    assert.deepEqual(r.isolation?.stripped, [{ path: "conftest.py", why: "hook", change: "add" }]);
  });

  it("conftest.py never reaches the verified tree, pytest or not", async () => {
    const { w, task } = await exploitWorld();
    const r = await runTask({ task: task("test ! -e conftest.py && test ! -e tests/conftest.py && node test/add.test.js"), bundle: await w.mkBundle("fixer", "always fix bugs"), adapter: fakeAdapter({ act: () => ({ ...FIXED_SRC, "conftest.py": "x = 1\n", "tests/conftest.py": "x = 1\n" }) }), blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir });
    assert.equal(r.pass, true, r.verifierOutput?.stderr ?? r.error);
    assert.deepEqual(r.isolation?.stripped.map((s) => s.path).sort(), ["conftest.py", "tests/conftest.py"]);
  });

  it("a script the verifier runs is restored from the start; test config and Makefile too", async () => {
    const { w, task } = await exploitWorld({ Makefile: "test:\n\tnode test/add.test.js\n", "pytest.ini": "[pytest]\n" });
    const r = await runTask({ task: task("sh run_tests.sh"), bundle: await w.mkBundle("x", "x"), adapter: cheat({ "run_tests.sh": "exit 0\n", Makefile: "test:\n\ttrue\n", "pytest.ini": "[pytest]\naddopts = -k nothing\n" }), blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir });
    assert.equal(r.pass, false);
    assert.deepEqual(
      r.isolation?.stripped.map((s) => `${s.path}:${s.why}`).sort(),
      ["Makefile:config", "pytest.ini:config", "run_tests.sh:verifier"],
    );
  });

  it("a file the verifier only reads is the deliverable and is carried", async () => {
    const { w, task } = await exploitWorld();
    const r = await runTask({ task: task('test "$(cat answer.txt)" = 42'), bundle: await w.mkBundle("x", "x"), adapter: cheat({ "answer.txt": "42" }), blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir });
    assert.equal(r.pass, true);
    assert.deepEqual(r.isolation, { carried: 1, stripped: [] });
  });

  it("meta.verifierAllow lets a task's agent change a path isolation would restore", async () => {
    const { w, task } = await exploitWorld();
    const r = await runTask({ task: task("sh run_tests.sh", { verifierAllow: ["run_tests.sh"] }), bundle: await w.mkBundle("x", "x"), adapter: cheat({ "run_tests.sh": "exit 0\n" }), blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir });
    assert.equal(r.pass, true);
    assert.deepEqual(r.isolation, { carried: 1, stripped: [] });
  });

  it("files git ignores never reach the verifier; deletions and new source files do", async () => {
    const { w, task } = await exploitWorld();
    const cmd = "test ! -e build/out.js && test ! -e package-lock.json && test -e src/extra.js && node test/add.test.js";
    const adapter = fakeAdapter({
      act: async (spec) => {
        await rm(join(spec.cwd, "package-lock.json"));
        return { ...FIXED_SRC, "build/out.js": "x\n", "src/extra.js": "export const x = 1;\n" };
      },
    });
    const r = await runTask({ task: task(cmd), bundle: await w.mkBundle("x", "x"), adapter, blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir });
    assert.equal(r.pass, true, r.verifierOutput?.stderr ?? r.error);
  });

  it("a symlink out of the tree is left out", { skip: process.platform === "win32" && "symlinks need privileges on Windows" }, async () => {
    const { w, task } = await exploitWorld();
    const adapter = fakeAdapter({
      act: async (spec) => {
        await symlink("/etc/hosts", join(spec.cwd, "hosts"));
        return FIXED_SRC;
      },
    });
    const r = await runTask({ task: task("test ! -e hosts && node test/add.test.js"), bundle: await w.mkBundle("x", "x"), adapter, blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir });
    assert.equal(r.pass, true, r.verifierOutput?.stderr ?? r.error);
    assert.deepEqual(r.isolation?.stripped, [{ path: "hosts", why: "symlink", change: "add" }]);
  });

  it("repair rounds verify each round in a fresh copy; hidden tests stay out of the agent's tree", async () => {
    const { w, task } = await exploitWorld();
    let n = 0;
    const adapter = fakeAdapter({
      act: async (spec) => {
        n++;
        assert.ok(!existsSync(join(spec.cwd, "test/add.test.js")), "no hidden test in the agent's tree");
        return n === 1 ? { "notes.txt": "x\n" } : FIXED_SRC;
      },
    });
    const r = await runTask({ task: task("node test/add.test.js"), bundle: await w.mkBundle("x", "x"), adapter, blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir, repair: { rounds: 2, signal: "bit" } });
    assert.equal(r.pass, false);
    assert.equal(r.repair?.pass, true, JSON.stringify(r.repair));
    assert.equal(r.repair?.rounds.length, 1);
  });

  it("isolation: false verifies in the agent's tree, as before", async () => {
    const { w, task } = await exploitWorld();
    const r = await runTask({ task: task("sh run_tests.sh"), bundle: await w.mkBundle("x", "x"), adapter: cheat({ "run_tests.sh": "exit 0\n" }), blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir, isolation: false });
    assert.equal(r.pass, true);
    assert.equal(r.isolation, undefined);
  });
});

const FIXED_SRC = { "src/add.js": FIXED["src/add.js"] as string, "src/mul.js": FIXED["src/mul.js"] as string };
