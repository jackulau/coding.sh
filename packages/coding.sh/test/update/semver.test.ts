import assert from "node:assert/strict";
import { test } from "node:test";
import { compareSemver, isNewer, normalizeVersion, parseSemver } from "../../src/update/semver.ts";

test("parses versions with a leading v, prereleases and build metadata", () => {
  assert.deepEqual(parseSemver("v1.2.3"), { major: 1, minor: 2, patch: 3, prerelease: [] });
  assert.deepEqual(parseSemver("1.2.3-beta.2+sha.abc"), { major: 1, minor: 2, patch: 3, prerelease: ["beta", "2"] });
  for (const bad of ["", "1.2", "1.2.3.4", "01.2.3", "1.2.3-01", "latest", "1.2.3-", "v"]) assert.equal(parseSemver(bad), undefined, bad);
  assert.equal(normalizeVersion(" v0.2.0+build "), "0.2.0");
  assert.equal(normalizeVersion("nope"), undefined);
});

test("orders by SemVer precedence, prereleases included", () => {
  // The example chain from semver.org §11.
  const chain = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
  for (let i = 0; i < chain.length - 1; i++) {
    assert.equal(compareSemver(chain[i]!, chain[i + 1]!), -1, `${chain[i]} < ${chain[i + 1]}`);
    assert.equal(compareSemver(chain[i + 1]!, chain[i]!), 1);
  }
  assert.equal(compareSemver("1.10.0", "1.9.9"), 1);
  assert.equal(compareSemver("v2.0.0", "2.0.0+build"), 0);
  assert.equal(compareSemver("0.0.2", "0.0.10"), -1);
  assert.throws(() => compareSemver("1.0", "1.0.0"), TypeError);
});

test("isNewer is strict and false for anything unparseable", () => {
  assert.equal(isNewer("0.2.0", "0.1.0"), true);
  assert.equal(isNewer("0.1.0", "0.1.0"), false);
  assert.equal(isNewer("0.1.0", "0.2.0"), false);
  assert.equal(isNewer("1.0.0", "1.0.0-rc.1"), true, "release beats its own prerelease");
  assert.equal(isNewer("1.0.0-rc.2", "1.0.0-rc.1"), true);
  assert.equal(isNewer("1.0.0-rc.1", "1.0.0"), false);
  assert.equal(isNewer("garbage", "0.1.0"), false);
  assert.equal(isNewer(undefined, "0.1.0"), false);
});
