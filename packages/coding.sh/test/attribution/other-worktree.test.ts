// A session that edited the repo through another worktree (since removed) still owns its lines:
// the edited path under that worktree maps to the same repo path under the checkout being attributed.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { lineKey } from "../../src/attribution/lines.ts";
import { editStepKeys } from "../../src/attribution/sources.ts";
import type { Replay } from "../../src/core/replay.ts";
import { removeTestDir } from "../_rm.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "csh-attr-wt-")));
after(() => removeTestDir(root));

const replayAt = (wt: string, path: string): Replay =>
  ({
    root: wt,
    steps: [{ n: 1, files: [{ path, op: "edit" }] }],
    changesAt: async () => [{ path, diff: "--- a\n+++ b\n@@ -0,0 +1 @@\n+export const fromOtherWorktree = 1;\n" }],
  }) as unknown as Replay; // slop-allow chained-as: a replay with only the fields editStepKeys reads

describe("edit steps made in another worktree", () => {
  const main = join(root, "main");
  const gone = join(root, "worktrees", "feature");
  mkdirSync(join(main, "src", "lib"), { recursive: true });
  writeFileSync(join(main, "src", "lib", "x.ts"), "export const fromOtherWorktree = 1;\n");

  test("count under the repo path the file has in this checkout", async () => {
    const keys = await editStepKeys(replayAt(gone, join(gone, "src", "lib", "x.ts")), main);
    assert.deepEqual([...keys.keys()], ["src/lib/x.ts"]);
    assert.deepEqual(keys.get("src/lib/x.ts"), [lineKey("export const fromOtherWorktree = 1;")]);
  });

  test("count nothing when no such file is in this checkout", async () => {
    const keys = await editStepKeys(replayAt(gone, join(gone, "src", "lib", "missing.ts")), main);
    assert.equal(keys.size, 0);
  });
});
