// gc's Spool row counts the raw side files it removes, orphans included.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spoolSummary } from "../../src/cli/commands/gc.ts";

test("gc's Spool row names the raw side files, so an orphan-only sweep does not read as nothing", () => {
  assert.equal(spoolSummary({ scanned: 4, deleted: 0, bytes: 2048, rawFiles: 2 }, "would delete"), "would delete 0 files and 2 raw side files (2.0 kB)");
  assert.equal(spoolSummary({ scanned: 4, deleted: 1, bytes: 10, rawFiles: 1 }, "deleted"), "deleted 1 file and 1 raw side file (10 B)");
  assert.equal(spoolSummary({ scanned: 4, deleted: 0, bytes: 0, rawFiles: 0 }, "deleted"), "deleted 0 files");
});
