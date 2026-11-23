// core/shell-diff.ts: the simple commands of a shell line and the folder each runs in, and the
// repo-relative paths the session fold keys files by. Long lines built to be slow check that a
// line is read in linear time.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeTracePath, shellWrites, simpleCommands, traceRoot, underTraceRoot } from "../../src/core/shell-diff.ts";
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
});

describe("normalizeTracePath", () => {
  it("makes a path relative to the cwd, with forward slashes, no leading ./ and no macOS /private", () => {
    const cases: [string, string | undefined, string][] = [
      ["/work/demo/src/a.ts", "/work/demo", "src/a.ts"],
      ["/work/demo/src/a.ts", "/work/demo/", "src/a.ts"],
      ["/work/demo", "/work/demo", ""],
      ["/work/demox/a.ts", "/work/demo", "/work/demox/a.ts"],
      ["C:\\w\\src\\a.ts", "C:\\w\\", "src/a.ts"],
      ["/private/var/x/a.ts", "/var/x", "a.ts"],
      ["/var/x/a.ts", "/private/var/x", "a.ts"],
      ["/private/a.ts", "/", "/private/a.ts"],
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
