import assert from "node:assert/strict";
import { test } from "node:test";
import { parseToml } from "../lib/toml.mjs";

test("parses the task-file subset", () => {
  const t = parseToml(`
id = "x" # comment
n = 1_000
f = -1.5
ok = true
lit = 'C:\\path'
ml = """
a \\
  b"""
ref = ['''
set -e
echo "hi"
''']
arr = [1, [2, 3], "four",]
inl = { a = 1, b.c = "d" }
[expect]
minTargetCalls = 2
[[check]]
kind = "output"
contains = ["a", "b"]
[[check]]
kind = "state"
`);
  assert.equal(t.id, "x");
  assert.equal(t.n, 1000);
  assert.equal(t.f, -1.5);
  assert.equal(t.ok, true);
  assert.equal(t.lit, "C:\\path");
  assert.equal(t.ml, "a b");
  assert.equal(t.ref[0], 'set -e\necho "hi"\n');
  assert.deepEqual(t.arr, [1, [2, 3], "four"]);
  assert.deepEqual(t.inl, { a: 1, b: { c: "d" } });
  assert.equal(t.expect.minTargetCalls, 2);
  assert.equal(t.check.length, 2);
  assert.deepEqual(t.check[0].contains, ["a", "b"]);
});

test("rejects duplicates and garbage with a line number", () => {
  assert.throws(() => parseToml('a = 1\na = 2\n'), /line 2: duplicate key a/);
  assert.throws(() => parseToml('a = nope\n'), /line 1: unsupported value/);
  assert.throws(() => parseToml('a = "x\n'), /newline in string/);
});
