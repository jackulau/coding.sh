const test = require("node:test");
const assert = require("node:assert/strict");
const { paginate } = require("../src/paginate.js");
test("first page", () => {
  assert.deepEqual(paginate([1, 2, 3, 4], 1, 2).items, [1, 2]);
});
