const test = require("node:test");
const assert = require("node:assert/strict");
const { parseLine } = require("../src/csv.js");
test("plain fields", () => {
  assert.deepEqual(parseLine("a,b,c"), ["a", "b", "c"]);
});
