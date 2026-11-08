const assert = require("node:assert/strict");
const { groupByDay, dayKey } = require("../src/report.js");
const g = groupByDay(["2026-03-01T23:30:00Z", "2026-03-02T00:10:00Z", "2026-03-02T15:00:00Z"]);
assert.deepEqual(Object.keys(g).sort(), ["2026-03-01", "2026-03-02"], process.env.TZ);
assert.equal(dayKey("2026-12-31T23:59:59Z"), "2026-12-31", process.env.TZ);
