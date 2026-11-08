const test = require("node:test");
const assert = require("node:assert/strict");
const { makeGetUser, clearCache } = require("../src/users.js");
test("concurrent calls share one request", async () => {
  clearCache();
  let calls = 0;
  const getUser = makeGetUser(async (id) => { calls++; await new Promise((r) => setTimeout(r, 20)); return { id }; });
  const [a, b, c] = await Promise.all([getUser(1), getUser(1), getUser(1)]);
  assert.equal(calls, 1);
  assert.deepEqual([a, b, c], [{ id: 1 }, { id: 1 }, { id: 1 }]);
  await getUser(1);
  assert.equal(calls, 1);
  await getUser(2);
  assert.equal(calls, 2);
});
test("a failure is not cached", async () => {
  clearCache();
  let calls = 0;
  const getUser = makeGetUser(async (id) => { calls++; if (calls === 1) throw new Error("503"); return { id }; });
  await assert.rejects(getUser(7), /503/);
  assert.deepEqual(await getUser(7), { id: 7 });
  assert.equal(calls, 2);
});
