// Run: node --no-warnings --test scripts/perf/test/*.test.mjs
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { removeProfile } from "../lighthouse.mjs";

test("removeProfile removes the folder and what is in it", () => {
  const dir = mkdtempSync(join(tmpdir(), "csh-perf-profile-"));
  try {
    writeFileSync(join(dir, "Local State"), "{}");
    removeProfile(dir);
    assert.equal(existsSync(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removeProfile retries, since Chrome can hold a profile file just after kill()", () => {
  const calls = [];
  removeProfile("profile", (path, options) => calls.push({ path, options }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "profile");
  assert.equal(calls[0].options.recursive, true);
  assert.equal(calls[0].options.force, true);
  assert.ok(calls[0].options.maxRetries > 0, "rmSync retries EPERM and EBUSY only when maxRetries is set");
  assert.ok(calls[0].options.retryDelay > 0);
});

test("removeProfile keeps the run going when the folder still won't go", (t) => {
  const error = t.mock.method(console, "error", () => {});
  const locked = () => {
    throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
  };
  assert.doesNotThrow(() => removeProfile("held-profile", locked));
  assert.equal(error.mock.callCount(), 1);
  assert.match(String(error.mock.calls[0].arguments[0]), /held-profile.*EPERM/);
});
