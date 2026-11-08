// Which part of a compound shell line failed, on commands and outputs shaped
// like the ones agents run (Claude Code's "Exit code N" first line included).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { failingPart, shellParts } from "../../src/core/failing-command.ts";
import { COMPOUND, failureRecords, rankIssues } from "../../src/improve/issues.ts";
import { buildSession } from "../../src/core/sessions.ts";
import { sessionEvents } from "../helpers-decision.ts";

const head = (cmd: string, output: string, exitCode?: number) => failingPart(cmd, { output, ...(exitCode !== undefined ? { exitCode } : {}) })?.argv.slice(0, 2).join(" ");

describe("shellParts", () => {
  it("drops keywords, loop headers, assignments, redirects and wrappers", () => {
    const progs = (cmd: string) => shellParts(cmd).map((p) => p.prog);
    assert.deepEqual(progs("for f in src/*.py; do python3 -m py_compile \"$f\"; done"), ["python3"]);
    assert.deepEqual(progs("cd /work/demo && RUST_LOG=debug cargo build 2>&1 | tail -20"), ["cd", "cargo", "tail"]);
    assert.deepEqual(progs("export PATH=\"$HOME/.cargo/bin:$PATH\" CI=1; timeout 60 sed -n '1,5p' a.txt"), ["export", "sed"]);
    assert.deepEqual(progs("if [ -f x ]; then make; else echo none; fi"), ["[", "make", "echo"]);
    assert.deepEqual(progs("sudo -u app env FOO=1 nohup ./bin/server --port 3000 > /tmp/log 2>&1 &"), ["server"]);
    assert.deepEqual(progs("git ls-files | xargs -n 1 -I {} wc -l {}"), ["git", "wc"]);
  });

  it("joins line continuations, so a flag on the next line is not a command", () => {
    const parts = shellParts("coding.sh show \\\n  --session abc \\\n  --json");
    assert.equal(parts.length, 1);
    assert.equal(parts[0]!.prog, "coding.sh");
    assert.deepEqual(parts[0]!.argv, ["coding.sh", "show", "--session", "abc", "--json"]);
  });

  it("does not split inside quotes, substitutions or a heredoc body", () => {
    const progs = (cmd: string) => shellParts(cmd).map((p) => p.prog);
    assert.deepEqual(progs("grep -E 'a|b; c && d' file.txt"), ["grep"]);
    assert.deepEqual(progs('echo "$(date; whoami)" && make test'), ["echo", "make"]);
    assert.deepEqual(progs("cat > notes.md <<'EOF'\n--session x\nexport FOO=1 && rm -rf /\nEOF\ngit add notes.md"), ["cat", "git"]);
  });
});

describe("failingPart", () => {
  it("files a cargo error under cargo, not the cat before it", () => {
    const out = "Exit code 101\n[package]\nname = \"demo\"\n   Compiling demo v0.1.0\nerror[E0425]: cannot find value `x` in this scope\n --> src/main.rs:2:5\nerror: could not compile `demo`";
    assert.equal(head("cat Cargo.toml && cargo build --release", out), "cargo build");
  });

  it("files a Python warning in a for loop under python", () => {
    const out = "Exit code 1\n/work/demo/a.py:3: DeprecationWarning: invalid escape sequence '\\d'\n  re.compile('\\d+')";
    assert.equal(head("for f in *.py; do python3 \"$f\" --check; done", out), "python3 \"$f\"");
  });

  it("files a timeout (exit 124) under the command timeout ran", () => {
    assert.equal(head("sed -n '1,20p' README.md && timeout 30 npm run e2e", "Exit code 124\n# Quickstart\n...", 124), "npm run");
  });

  it("files an error that names its tool under that tool", () => {
    assert.equal(head("cd /work/demo && cat missing.txt && npm test", "Exit code 1\ncat: missing.txt: No such file or directory"), "cat missing.txt");
    assert.equal(head("ls && fooctl status", "Exit code 127\nREADME.md\n(eval):1: command not found: fooctl"), "fooctl status");
    assert.equal(head("cd packages/web && pnpm build", "Exit code 1\n(eval):cd:1: no such file or directory: packages/web"), "cd packages/web", "zsh");
    assert.equal(head("cd packages/web && pnpm build", "Exit code 1\nbash: line 1: cd: packages/web: No such file or directory"), "cd packages/web");
  });

  it("only the last part of a pipeline sets its status; a self-naming tool the error skips did not fail", () => {
    assert.equal(head("npm run lint 2>&1 | grep -c warning", "Exit code 1\n"), "grep -c", "grep exits 1 on no match, silently");
    assert.equal(head("sleep 20 && gh run view 123 --log-failed | tail -50", "Exit code 1\nrun 123 is still in progress"), "gh run");
    assert.equal(head("ls dist && node scripts/check.mjs", "Exit code 1\ncheck failed: 3 files over budget"), "node scripts/check.mjs");
  });

  it("returns nothing when the evidence leaves more than one part", () => {
    assert.equal(head("npm install && npm run build", "Exit code 1\nsomething went wrong"), undefined);
    assert.equal(head("make && ./bin/app --selftest", "Exit code 2\nboom"), undefined);
  });
});

describe("failureRecords on compound commands", () => {
  const CWD = "/work/demo";
  const T0 = 1_790_000_000_000;
  const session = (id: string, steps: Parameters<typeof sessionEvents>[2]) => sessionEvents(id, { cwd: CWD, startedAt: T0 }, steps);

  it("groups by the failing part, and calls an unclear one a compound command", () => {
    const recs = failureRecords(
      session("a", [
        ["tool.start", { tool: "Bash", toolUseId: "1", input: { command: "cat Cargo.toml && cargo build" } }],
        ["tool.end", { tool: "Bash", toolUseId: "1", ok: false, output: "Exit code 101\nerror[E0425]: cannot find value `x`" }],
        ["tool.start", { tool: "Bash", toolUseId: "2", input: { command: "npm install && npm run build" } }],
        ["tool.end", { tool: "Bash", toolUseId: "2", ok: false, output: "Exit code 1\nsomething went wrong" }],
      ]),
    );
    assert.deepEqual(recs.map((r) => [r.key, r.label]), [
      ["cmd:cargo build", "cargo build"],
      ["compound:something went wrong", COMPOUND],
    ]);
  });

  it("a test summary that cat printed is not a failing test run, so cat never gets the broken-setup verdict", () => {
    const steps = (id: string): Parameters<typeof sessionEvents>[2] => [
      ["tool.start", { tool: "Bash", toolUseId: `${id}-1`, input: { command: "sleep 30 && cat /tmp/test-output.log | tail -40" } }],
      ["tool.end", { tool: "Bash", toolUseId: `${id}-1`, ok: true, output: "FAILED tests/test_a.py::test_x\n2 failed, 10 passed in 1.2s" }],
      ["test.result", { runner: "pytest", passed: 10, failed: 2, toolUseId: `${id}-1` }],
      ["tool.start", { tool: "Bash", toolUseId: `${id}-2`, input: { command: "cd /work/demo && cat setup.cfg | grep pytest && pytest -q" } }],
      ["tool.end", { tool: "Bash", toolUseId: `${id}-2`, ok: false, output: "Exit code 1\n[tool:pytest]\nF.\n1 failed, 1 passed in 0.1s" }],
      ["test.result", { runner: "pytest", passed: 1, failed: 1, toolUseId: `${id}-2` }],
    ];
    const recs = failureRecords(session("a", steps("a")));
    assert.deepEqual(recs.map((r) => [r.key, r.tests]), [["cmd:pytest -q", true]]);
    const sessions = ["a", "b"].map((id, k) => buildSession(sessionEvents(id, { cwd: CWD, startedAt: T0 + k }, steps(id))));
    const issues = rankIssues(sessions, new Map(sessions.map((s) => [s.id, failureRecords(sessionEvents(s.id, { cwd: CWD, startedAt: T0 }, steps(s.id)))])));
    const titles = issues.filter((i) => i.kind === "failure").map((i) => i.title);
    assert.deepEqual(titles, ["`pytest -q` already fails before the agent changes anything"]);
  });
});
