const test = require("node:test");
const assert = require("node:assert/strict");
const { parseLine } = require("../src/csv.js");
test("quoted fields with commas and doubled quotes", () => {
  assert.deepEqual(parseLine('1,"Acme, Inc.",3'), ["1", "Acme, Inc.", "3"]);
  assert.deepEqual(parseLine('"say ""hi"" now",x'), ['say "hi" now', "x"]);
  assert.deepEqual(parseLine('a,,c'), ["a", "", "c"]);
  assert.deepEqual(parseLine('a,""'), ["a", ""]);
  assert.deepEqual(parseLine(''), [""]);
});
