// harness audit: a memory file a session wrote that is gone from disk is flagged deleted, counted
// apart from write-only, and listed after every file still on disk, flagged or not.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { claudeProjectSlug } from "../../src/core/memory-audit.ts";
import { buildSession } from "../../src/core/sessions.ts";
import { tmpEnv, type TmpEnv } from "../adapters/_helpers.ts";
import { sessionEvents } from "../helpers-decision.ts";
import { ok, seed } from "../query/_seed.ts";

describe("harness audit with a written file gone from disk", () => {
  let env: TmpEnv;
  before(async () => {
    env = tmpEnv();
    const repo = join(env.home, "app");
    const mem = join(env.home, ".claude", "projects", claudeProjectSlug(repo), "memory");
    mkdirSync(mem, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(mem, "kept.md"), "kept\n");
    writeFileSync(join(mem, "notes.md"), "notes\n");
    writeFileSync(join(mem, "stale.md"), "x".repeat(4000));
    // One session writes kept.md and a-scratch.md, which is gone since, and reads notes.md.
    const events = sessionEvents("w", { cwd: repo, startedAt: Date.now() - 86_400_000 }, [
      ["user.message", { text: "note this" }],
      ["tool.start", { tool: "Edit", toolUseId: "e1", input: { file_path: join(mem, "a-scratch.md"), old_string: "a", new_string: "b" } }],
      ["tool.start", { tool: "Edit", toolUseId: "e2", input: { file_path: join(mem, "kept.md"), old_string: "a", new_string: "b" } }],
      ["tool.start", { tool: "Read", toolUseId: "r1", input: { file_path: join(mem, "notes.md") } }],
    ]);
    await seed(env.dataHome, { events, sessions: [buildSession(events)] });
  });
  after(() => env.restore());

  test("counts it apart from write-only and lists it last", () => {
    const r = ok(["harness", "audit", "--since", "7d"]);
    assert.match(r.stderr, /flags: 1 never read, 1 write-only, 1 deleted, 0 skills listed but never read/);
    const rows = r.stdout.split("\n").filter((l) => /\/memory\/[a-z-]+\.md/.test(l));
    const name = (l: string) => /\/memory\/([a-z-]+\.md)/.exec(l)![1];
    assert.deepEqual(rows.map(name).slice(0, 2).sort(), ["kept.md", "stale.md"], "the flagged files on disk first");
    assert.deepEqual(rows.map(name).slice(2), ["notes.md", "a-scratch.md"], "then the file with no flag, then the one gone from disk");
    assert.match(rows.at(-1)!, /\bgone\b.*\bdeleted\b/);
  });
});
