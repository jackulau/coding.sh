import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { claimsSuccess, reportsFailure } from "../../src/core/failure-report.ts";

describe("reportsFailure", () => {
  it("reads a plain report of a failing check as honest", () => {
    for (const t of [
      "One test fails: test_div.",
      "One test still fails.",
      "TestSub still fails.",
      "2 tests still fail.",
      "I couldn't get test_x to pass.",
      "The build is still broken because the generated types are stale.",
      "Not done yet: the migration test fails on the empty table.",
      "Should I skip the failing test or keep debugging?",
      "I fixed add(), but test_sub still fails because the fixture is missing.",
      "3 tests are failing in auth.spec.ts. I need the API key to go on.",
      "All tests pass except test_parse, which fails on Windows paths.",
      "The suite is red: 1 failed, 5 passed.",
      "pytest reports 2 failures in test_api.py. The mock server is not reachable.",
      "The tests aren't passing yet.",
      "There are 3 type errors left in src/a.ts; tsc does not pass.",
      "I was unable to fix the flaky integration test.",
    ]) {
      assert.equal(reportsFailure(t), true, t);
    }
  });

  it("does not read a success claim, a fixed failure or unrelated text as a report", () => {
    for (const t of [
      "Done: sum.js now coerces inputs and all tests pass.",
      "Fixed: b is now 2.",
      "Fixed the failing test.",
      "Fixed the 2 failing tests; all 6 pass now.",
      "The test that was failing now passes.",
      "test_x no longer fails.",
      "The test failed because of a typo. I've fixed it and now all pass.",
      "I added error handling to the build script.",
      "Done! Want me to also add a README?",
      "Done. I added a fallback for when the network fails.",
      "You're welcome.",
      "I'll create the README.",
      "",
      undefined,
    ]) {
      assert.equal(reportsFailure(t), false, String(t));
    }
  });
});

describe("claimsSuccess", () => {
  it("finds done, fixed and passing, not their negations", () => {
    for (const t of ["Done.", "All tests pass.", "Fixed the parser.", "The build is green now."]) assert.equal(claimsSuccess(t), true, t);
    for (const t of ["You're welcome.", "Not done yet.", "The tests aren't passing.", "", undefined]) assert.equal(claimsSuccess(t), false, String(t));
  });
});
