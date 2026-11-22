// sessions --repo <name> typed in another case: on Windows, where folder names ignore case, it
// matches the same sessions as the exact name (the main checkout and every worktree), as
// `work --repo` does. It used to match only the sessions whose folder matched, and missed every
// worktree and a cwd stored with forward slashes.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { withRepo } from "../../src/cli/commands/sessions.ts";
import { findSessions } from "../../src/query/run.ts";
import type { IndexStore } from "../../src/core/types.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { worktreeSessions } from "../query/_where-fixture.ts";
import { session, T0 } from "../query/_seed.ts";

const sessions = () => [
  ...worktreeSessions(),
  // A hook cwd with forward slashes, and a subfolder of the main checkout.
  session("fwd-slash", { cwd: "C:/work/demo", startedAt: T0 - 9 * 60_000, endedAt: T0 - 8 * 60_000 }),
];
const c = { cwd: "/work", env: { HOME: "/home/user" } as NodeJS.ProcessEnv };

describe("sessions --repo <name> ignores case on Windows", () => {
  for (const [kind, open] of [["sqlite", () => SqliteIndexStore.open(":memory:")], ["scan", async () => new MemoryIndexStore()]] as const) {
    it(kind, async () => {
      const index: IndexStore = await open();
      for (const s of sessions()) await index.upsertSession(s);
      const ids = async (name: string) => (await findSessions(index, withRepo(undefined, name, c, "win32")!, {})).sessions.map((s) => s.id).sort();
      const exact = await ids("demo");
      assert.deepEqual(exact, ["fwd-slash", "wt-claude", "wt-codex", "wt-linked", "wt-main", "wt-t3", "wt-win"]);
      assert.deepEqual(await ids("DEMO"), exact, "another case, the same set");
      assert.deepEqual(await ids("Demo"), exact);
      assert.deepEqual(await ids("other"), ["wt-other"]);
      assert.deepEqual(await ids("dem"), [], "a name is not a prefix");
      await index.close?.();
    });
  }
});
