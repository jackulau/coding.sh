// core/shell-diff.ts: the simple commands of a shell line and the folder each runs in. Long lines
// built to be slow check that a line is read in linear time.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shellWrites, simpleCommands } from "../../src/core/shell-diff.ts";
import { assertCpuUnder } from "../helpers-timing.ts";

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
});
