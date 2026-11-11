// impossibleMutations flips only values a test compares against. A word like
// "should" inside a log message does not make a line an assertion, and a
// literal in console.* / print / exit calls is never flipped: changing a
// message or an exit code can't turn a pass into a fail.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { impossibleMutations } from "../../src/eval/impossible.ts";

const one = (text: string) => impossibleMutations([{ path: "test/add.test.js", text }]);

describe("impossibleMutations leaves messages and exit codes alone", () => {
  it('console.error("add should be 5") gives no mutation', () => {
    assert.deepEqual(one('if (add(2, 3) !== 5) console.error("add should be 5");\n'), []);
  });

  it("a one-line check that exits 1 gives no mutation", () => {
    assert.deepEqual(one('if (add(2, 3) !== 5) { console.error("add should be 5"); process.exit(1); }\n'), []);
  });

  it("an assert.equal literal still mutates, and its message is left alone", () => {
    const m = one('assert.equal(add(2, 3), 5, "add should be 5");\n');
    assert.deepEqual(m.map((x) => x.after), ['assert.equal(add(2, 3), 6, "add should be 5");']);
  });

  it("an assertion with a log call on the same line flips the assertion's value", () => {
    const m = one('assert.equal(add(2, 3), 5); console.log("checked", 1);\n');
    assert.deepEqual(m.map((x) => x.after), ['assert.equal(add(2, 3), 6); console.log("checked", 1);']);
  });

  it("Python: print() literals stay, the assert value flips", () => {
    const m = impossibleMutations([{ path: "tests/test_add.py", text: 'print("should be 5")\nassert add(2, 3) == 5\n' }]);
    assert.deepEqual(m.map((x) => x.after), ["assert add(2, 3) == 6"]);
  });
});
