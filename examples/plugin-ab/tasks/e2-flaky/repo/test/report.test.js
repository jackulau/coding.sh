const test = require("node:test");
const assert = require("node:assert/strict");
const { groupByDay } = require("../src/report.js");
test("groups by UTC day", () => {
  const g = groupByDay(["2026-03-01T23:30:00Z", "2026-03-02T00:10:00Z"]);
  assert.deepEqual(Object.keys(g).sort(), ["2026-03-01", "2026-03-02"]);
});
