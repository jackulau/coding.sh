// Regression tests for the third hands-on QA round on the CLI: typo suggestions for prefixes
// and shell habits.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, test } from "node:test";
import { suggest } from "../../src/cli/args.ts";
import { CLI } from "../_cli.ts";
import { sandbox } from "./_cmd.ts";

describe("typo suggestions", () => {
  test("an unambiguous prefix suggests the whole name", () => {
    assert.equal(suggest("dry", ["dry-run", "json", "older-than"]), "dry-run");
    assert.equal(suggest("dr", ["dry-run", "json"]), undefined, "too short to be a prefix guess");
    assert.equal(suggest("re", ["repo", "reprice"]), undefined);
    assert.equal(suggest("rep", ["repo", "reprice"]), "repo", "edit distance comes first");
  });
  test("shell habits map to the command", () => {
    assert.equal(suggest("ls", ["list", "show", "new"]), "list");
    assert.equal(suggest("rm", ["list", "delete"]), "delete");
    assert.equal(suggest("ls", ["show", "new"]), undefined);
  });
  test("end to end: gc --dry and exp ls", () => {
    const sb = sandbox();
    try {
      const gc = spawnSync(process.execPath, ["--no-warnings", CLI, "gc", "--dry"], { env: sb.env, encoding: "utf8" });
      assert.equal(gc.status, 2);
      assert.match(gc.stderr, /--dry-run/);
      const exp = spawnSync(process.execPath, ["--no-warnings", CLI, "exp", "ls"], { env: sb.env, encoding: "utf8" });
      assert.equal(exp.status, 2);
      assert.match(exp.stderr, /exp list/);
    } finally {
      sb.cleanup();
    }
  });
});
