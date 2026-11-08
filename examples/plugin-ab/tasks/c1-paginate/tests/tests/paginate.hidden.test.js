const test = require("node:test");
const assert = require("node:assert/strict");
const { paginate } = require("../src/paginate.js");
const xs = Array.from({ length: 7 }, (_, i) => i + 1);
test("pages do not overlap and cover every item", () => {
  const seen = [];
  const { pages } = paginate(xs, 1, 3);
  assert.equal(pages, 3);
  for (let p = 1; p <= pages; p++) seen.push(...paginate(xs, p, 3).items);
  assert.deepEqual(seen, xs);
});
test("exact multiple and empty list", () => {
  assert.equal(paginate([1, 2, 3, 4], 1, 2).pages, 2);
  assert.deepEqual(paginate([1, 2, 3, 4], 2, 2).items, [3, 4]);
  assert.equal(paginate([], 1, 5).pages, 1);
  assert.deepEqual(paginate([], 1, 5).items, []);
});
