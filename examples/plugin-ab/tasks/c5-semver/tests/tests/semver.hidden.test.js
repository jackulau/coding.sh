const test = require("node:test");
const assert = require("node:assert/strict");
const { compareVersions } = require("../src/semver.js");
const sign = (x) => Math.sign(x);
test("numeric parts", () => {
  assert.equal(sign(compareVersions("1.10.0", "1.9.0")), 1);
  assert.equal(sign(compareVersions("1.2.3", "1.2.3")), 0);
  assert.equal(sign(compareVersions("0.9.9", "1.0.0")), -1);
});
test("prerelease precedence", () => {
  const order = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
  const shuffled = [...order].reverse();
  assert.deepEqual(shuffled.sort(compareVersions), order);
  assert.equal(sign(compareVersions("2.0.0-beta.2", "2.0.0")), -1);
});
test("build metadata ignored", () => {
  assert.equal(sign(compareVersions("1.0.0+build.5", "1.0.0+build.9")), 0);
});
