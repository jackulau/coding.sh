const test = require("node:test");
const assert = require("node:assert/strict");
const { parseDuration, formatDuration } = require("../src/duration.js");
test("units and combinations", () => {
  assert.equal(parseDuration("45s"), 45000);
  assert.equal(parseDuration("1h30m"), 5400000);
  assert.equal(parseDuration("2d"), 172800000);
  assert.equal(parseDuration("1h 5m"), 3900000);
  assert.equal(parseDuration("250ms"), 250);
  assert.equal(parseDuration("1m30s"), 90000);
});
test("bad input throws RangeError", () => {
  for (const bad of ["", "abc", "10", "5x", "-5s", "1h-5m"]) assert.throws(() => parseDuration(bad), RangeError, bad);
});
test("formatDuration still works", () => {
  assert.equal(formatDuration(90000), "1m30s");
});
