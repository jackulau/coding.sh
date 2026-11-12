// CODING_SH_REQUIRE_DIST=1 turns "skipped: no build" into a failure, so a gate
// that builds the site first cannot pass because the build was missing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const run = (env) => {
  // A child test run must not think it is part of this one.
  const base = { ...process.env };
  delete base.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ["--no-warnings", "--test", fileURLToPath(new URL("./docs-readable.test.mjs", import.meta.url))], {
    encoding: "utf8",
    env: { ...base, CODING_SH_REQUIRE_DIST: "", ...env },
  });
};

test("without a build a dist test skips", () => {
  const r = run({ DOCS_DIST: "/nonexistent/dist" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /skipped [1-9]/);
});

test("CODING_SH_REQUIRE_DIST=1 with no build fails with \"no build\"", () => {
  const r = run({ DOCS_DIST: "/nonexistent/dist", CODING_SH_REQUIRE_DIST: "1" });
  assert.notEqual(r.status, 0, "the tests should have failed");
  assert.match(r.stdout, /no build in \/nonexistent\/dist\/docs/);
});
