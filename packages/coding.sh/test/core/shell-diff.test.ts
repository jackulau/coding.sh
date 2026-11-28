// core/shell-diff.ts: the simple commands of a shell line and the folder each runs in, and the
// repo-relative paths the session fold keys files by. Long lines built to be slow check that a
// line is read in linear time.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeTracePath, shellCommand, shellDiffOrigin, shellWrites, simpleCommands, traceRoot, underTraceRoot } from "../../src/core/shell-diff.ts";
import type { AgentEvent, EventKind } from "../../src/schema/index.ts";
import { assertCpuUnder } from "../helpers-timing.ts";

/** The folder the last simple command of `cmd` runs in. */
const dirOf = (cmd: string) => simpleCommands(cmd).at(-1)?.dir;
const argv = (cmd: string) => simpleCommands(cmd).map((c) => [c.name, ...c.args]);

describe("simpleCommands", () => {
  it("keeps a quoted word whole, escaped quotes included, and skips a quote that never closes", () => {
    assert.deepEqual(argv('grep "a \\"b\\" c" f.txt'), [["grep", 'a \\"b\\" c', "f.txt"]]);
    assert.deepEqual(argv(`grep "a" "b\\"c" 'd'`), [["grep", "a", 'b\\"c', "d"]]);
    assert.deepEqual(argv('grep "x\\" y" "z'), [["grep", 'x\\" y', "z"]]);
    assert.deepEqual(argv('echo "a\\"b'), [["echo", "a\\", "b"]]);
    assert.deepEqual(argv(`grep "${'\\"'.repeat(3)}`), [["grep", "\\", "\\", "\\"]]);
  });

  it("reads a quote that never closes, with 40,000 escaped quotes after it, in linear time", () => {
    const cmd = `grep "${'\\"'.repeat(40000)}`;
    assertCpuUnder("simpleCommands", () => simpleCommands(cmd));
    assertCpuUnder("shellWrites", () => shellWrites(cmd));
    assert.deepEqual(shellWrites(`${cmd} > a.txt`), [{ path: "a.txt", op: "create" }]);
  });

  it("follows cd and pushd as posix.join does, a trailing slash kept", () => {
    const cases: [string, string | undefined][] = [
      ["cat x", undefined],
      ["cd ./a/ && cat x", "./a/"],
      ["cd a && cd b/ && cat x", "a/b/"],
      ["cd a && cd .. && cat x", "."],
      ["cd a && cd ../.. && cat x", ".."],
      ["cd /a && cd ../.. && cat x", "/"],
      ["cd a && cd /b && cat x", "/b"],
      ["cd a && cd ~/b && cat x", "~/b"],
      ["cd .. && cd a && cat x", "../a"],
      ["cd a/./b && cd c && cat x", "a/b/c"],
      ["cd a && cd ./ && cat x", "a/"],
      ["cd / && cd a && cat x", "/a"],
      ["cd a && cd ../../b/ && cat x", "../b/"],
      ["cd /a && cd ../../b/ && cat x", "/b/"],
      ["cd C:\\w && cd a && cat x", "C:/w/a"],
      ["cd C:/w && cd ../.. && cat x", "."],
      ["pushd a && cd b && cat x", "a/b"],
      ["cd -P a && cat x", undefined],
      ["cd a; cd b\ncat x", "a/b"],
      ["cd 'my dir' && cd b && cat x", "my dir/b"],
      ["cd a && cd b && cd /c && cd d && cat x", "/c/d"],
    ];
    for (const [cmd, dir] of cases) assert.equal(dirOf(cmd), dir, cmd);
  });

  it("follows a chain of 5,000 cd or pushd in linear time", () => {
    const deep = Array(5000).fill("a").join("/");
    for (const step of ["cd a && ", "cd a\n", "pushd a && "]) {
      const cmd = `${step.repeat(5000)}cat x`;
      assertCpuUnder(JSON.stringify(step), () => simpleCommands(cmd));
      assert.equal(dirOf(cmd), deep);
    }
  });

  it("skips 100,000 leading assignments in linear time", () => {
    const cmd = `${"A=1 ".repeat(100000)}cat x`;
    assertCpuUnder("assignments", () => simpleCommands(cmd));
    assert.deepEqual(argv(cmd), [["cat", "x"]]);
    assert.deepEqual(argv("sudo env A=1 /bin/cat x"), [["/bin/cat", "x"]]);
  });

  it("keeps the operator after each command", () => {
    const seps = (cmd: string) => simpleCommands(cmd).map((c) => c.sep);
    assert.deepEqual(seps("a && b | c; d"), ["&&", "|", ";", undefined]);
    assert.deepEqual(seps("a & b\nc || d"), ["&", "\n", "||", undefined]);
    assert.deepEqual(seps("lake build 2>&1 | tail -5"), ["|", undefined]);
  });

  it("drops each `>&N` of a chain, the one right after a digit too", () => {
    assert.deepEqual(argv("cmd 1>&2>&1 x"), [["cmd", "x"]]);
    assert.deepEqual(argv("cmd 2>&1 x 12>&3"), [["cmd", "x"]]);
  });

  it("with quotes, an operator inside quotes splits nothing and a word keeps its quoted parts", () => {
    const quoted = (cmd: string) => simpleCommands(cmd, { quotes: true }).map((c) => [c.name, ...c.args]);
    assert.deepEqual(quoted('make release GIT_FLAGS="--no-verify"'), [["make", "release", "GIT_FLAGS=--no-verify"]]);
    assert.deepEqual(quoted('git commit -am "WIP; lake build still fails"'), [["git", "commit", "-am", "WIP; lake build still fails"]]);
    assert.deepEqual(quoted("echo 'a|b' && lake build\\;x | tail -2"), [["echo", "a|b"], ["lake", "build;x"], ["tail", "-2"]]);
    assert.deepEqual(quoted('echo "a \\"b\\" c" \'d'), [["echo", 'a "b" c', "d"]]);
    assert.deepEqual(argv('git commit -am "WIP; lake build"'), [["git", "commit", "-am", "WIP"], ["lake", "build"]], "without quotes, as before");
  });

  it("drops a redirection to a descriptor, whatever digits name the descriptors", () => {
    assert.deepEqual(argv("npm test 2>&1 | tail -5"), [["npm", "test"], ["tail", "-5"]]);
    assert.deepEqual(argv("seq 100 >&2"), [["seq", "100"]]);
    assert.deepEqual(argv("echo 12 10>&2 345"), [["echo", "12", "345"]]);
    assert.deepEqual(argv("cmd 1>&2>&3 x"), [["cmd", "x"]]);
    assert.deepEqual(argv("echo 2024-01-02 1>&22"), [["echo", "2024-01-02"]]);
    assert.deepEqual(shellWrites("make 2>&1 > build.log"), [{ path: "build.log", op: "create" }]);
    assert.deepEqual(shellWrites("make > build.log 12>&1"), [{ path: "build.log", op: "create" }]);
  });
});

/** One command through each agent's shell tool, shaped as its adapter stores the call. */
const SHELL_CALLS = (command: string): [string, unknown][] => [
  ["Bash", { command }],
  // Antigravity's run_command (test/fixtures/adapters/antigravity).
  ["run_command", { CommandLine: command, Cwd: "/work/demo" }],
  // Droid's Execute (test/fixtures/adapters/droid).
  ["Execute", { command }],
  // Devin's exec.
  ["exec", { command, shell_id: "default" }],
  ["shell_command", { command }],
  ["powershell", { command }],
];
const ev = (kind: EventKind, payload: Record<string, unknown>): AgentEvent => ({ id: `e-${kind}`, v: 0, sessionId: "s", ts: 1000, agent: "claude-code", kind, payload });

describe("shellCommand and shellDiffOrigin read every shell tool", () => {
  it("reads the same command line through each agent's shell tool as through Bash", () => {
    const cmd = "sed -i 's/a/b/' tests/a.py";
    for (const [tool, input] of SHELL_CALLS(cmd)) assert.equal(shellCommand(tool, input), cmd, tool);
    // Still no command: a patch passed as `command`, whatever key holds it.
    assert.equal(shellCommand("run_command", { CommandLine: "*** Begin Patch\n*** End Patch", Cwd: "/work/demo" }), undefined);
    assert.equal(shellCommand("apply_patch", { command: "sed -i 's/a/b/' tests/a.py" }), undefined);
  });

  it("finds the file a shell diff reports in the command, whichever shell tool ran it", () => {
    const origin = (command: string, path: string) =>
      SHELL_CALLS(command).map(([tool, input]) => [tool, shellDiffOrigin(ev("file.change", { path, tool, toolUseId: "x" }), ev("tool.start", { tool, toolUseId: "x", input }))]);
    const all = (o: string) => SHELL_CALLS("").map(([tool]) => [tool, o]);
    assert.deepEqual(origin("sed -i 's/a/b/' tests/a.py", "tests/a.py"), all("named"));
    assert.deepEqual(origin("git -C /w reset --hard", "tests/a.py"), all("vcs"));
    assert.deepEqual(origin("npm test", "tests/a.py"), all("unattributed"));
    // git's -C and -c options come before the subcommand; an option's value is not one.
    for (const cmd of ["git -c x=y pull", "git status; git pull --rebase", "git -C repo -c a=b merge main", "git -C a -C b stash pop", "gh pr checkout 3"]) assert.deepEqual(origin(cmd, "tests/a.py"), all("vcs"), cmd);
    for (const cmd of ["git status", "git log -5", "git -C pull status", "git -c pull"]) assert.deepEqual(origin(cmd, "tests/a.py"), all("unattributed"), cmd);
    // A Codex code-mode cell is an `exec` call whose input is JavaScript: not a shell.
    assert.equal(shellDiffOrigin(ev("file.change", { path: "tests/a.py", tool: "exec", toolUseId: "x" }), ev("tool.start", { tool: "exec", toolUseId: "x", input: "await tools.exec_command({cmd: 'ls'})" })), "edit");
  });
});

describe("normalizeTracePath", () => {
  it("makes a path relative to the cwd, with forward slashes, no leading ./ and no macOS /private", () => {
    const cases: [string, string | undefined, string][] = [
      ["/work/demo/src/a.ts", "/work/demo", "src/a.ts"],
      ["/work/demo/src/a.ts", "/work/demo/", "src/a.ts"],
      ["/work/demo/src/a.ts", "/work/demo///", "src/a.ts"],
      ["/work/demo", "/work/demo//", ""],
      ["/work/demo", "/work/demo", ""],
      ["/work/demox/a.ts", "/work/demo", "/work/demox/a.ts"],
      ["C:\\w\\src\\a.ts", "C:\\w\\", "src/a.ts"],
      ["C:\\w\\src\\a.ts", "C:\\w\\\\/", "src/a.ts"],
      ["c:\\repos\\proof-repo\\src\\WinPath.lean", "C:\\repos\\proof-repo", "src/WinPath.lean"],
      ["C:\\repos\\proof-repo\\src\\WinPath.lean", "c:\\repos\\proof-repo", "src/WinPath.lean"],
      ["/c/repos/proof-repo/src/WinPath.lean", "C:\\repos\\proof-repo", "src/WinPath.lean"],
      ["c:/repos/proof-repo/src/WinPath.lean", "C:/repos/proof-repo/", "src/WinPath.lean"],
      ["/private/var/x/a.ts", "/var/x", "a.ts"],
      ["/var/x/a.ts", "/private/var/x", "a.ts"],
      ["/private/a.ts", "/", "/private/a.ts"],
      ["/work/demo/a.ts", "//", "/work/demo/a.ts"],
      ["././a.ts", undefined, "a.ts"],
      ["/work/demo/./a.ts", "/work/demo", "a.ts"],
      ["a\\b.ts", "", "a/b.ts"],
    ];
    for (const [p, cwd, key] of cases) {
      assert.equal(normalizeTracePath(p, cwd), key, `${p} in ${cwd}`);
      // traceRoot reads the cwd once for many paths; underTraceRoot gives the same key.
      assert.equal(underTraceRoot(p, traceRoot(cwd)), key, `${p} under ${cwd}`);
    }
  });
});
