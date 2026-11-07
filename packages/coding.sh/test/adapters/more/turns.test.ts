// A session captured by hooks and later backfilled from the agent's own
// transcript counts each turn once. These adapters' hook payloads name no turn
// the transcript knows, so the two paths' turn.end rows have different ids;
// buildSession counts each path's turns and keeps the larger count.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it } from "node:test";
import { copilotCliAdapter } from "../../../src/adapters/more/copilot-cli.ts";
import { droidAdapter } from "../../../src/adapters/more/droid.ts";
import { geminiCliAdapter } from "../../../src/adapters/more/gemini-cli.ts";
import { gooseAdapter } from "../../../src/adapters/more/goose.ts";
import { defaultConfig } from "../../../src/core/config.ts";
import { backfill, ingest } from "../../../src/core/ingest.ts";
import type { Adapter } from "../../../src/core/types.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../../src/store/memory.ts";
import type { TmpEnv } from "../_helpers.ts";
import { FIXTURES, loadSpool, moreEnv } from "./_helpers.ts";

/** A goose sessions.db holding the fixture spool's session: one prompt, one tool call. */
function gooseDb(root: string): void {
  const path = join(root, "data", "sessions", "sessions.db");
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT, working_dir TEXT, created_at TEXT, updated_at TEXT, provider_name TEXT, model_config_json TEXT, session_type TEXT, parent_session_id TEXT,
    accumulated_input_tokens INTEGER, accumulated_output_tokens INTEGER, accumulated_cache_read_tokens INTEGER, accumulated_cache_write_tokens INTEGER, accumulated_cost REAL);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT, session_id TEXT, role TEXT, content_json TEXT, created_timestamp INTEGER);`);
  db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("20260921_1", "run", "/work/demo", "2026-09-21T14:13:20Z", "2026-09-21T14:20:00Z", "anthropic", JSON.stringify({ model_name: "claude-sonnet-4-5" }), "user", null, 0, 0, 0, 0, 0);
  const msg = db.prepare("INSERT INTO messages (message_id, session_id, role, content_json, created_timestamp) VALUES (?,?,?,?,?)");
  msg.run("g1", "20260921_1", "user", JSON.stringify([{ type: "text", text: "Fix the go test" }]), 1790000001);
  msg.run("g2", "20260921_1", "assistant", JSON.stringify([{ type: "text", text: "Fixed the sign error in main.go." }]), 1790000009);
  db.close();
}

const cases: { adapter: Adapter; session: string; turns: number; setup: (env: TmpEnv) => void }[] = [
  { adapter: geminiCliAdapter, session: "gem-sess-1", turns: 2, setup: () => (process.env.GEMINI_CLI_HOME = join(FIXTURES, "gemini-cli", "home")) },
  { adapter: droidAdapter, session: "droid-sess-1", turns: 2, setup: () => (process.env.HOME = join(FIXTURES, "droid", "home")) },
  { adapter: copilotCliAdapter, session: "cop-sess-1", turns: 2, setup: () => (process.env.COPILOT_HOME = join(FIXTURES, "copilot-cli", "home", ".copilot")) },
  {
    adapter: gooseAdapter,
    session: "20260921_1",
    turns: 1,
    setup: (env) => {
      process.env.GOOSE_PATH_ROOT = join(env.root, "goose-root");
      gooseDb(process.env.GOOSE_PATH_ROOT);
    },
  },
];

describe("hooks + transcript of one session count each turn once", () => {
  let env: TmpEnv;
  beforeEach(() => (env = moreEnv()));
  afterEach(() => {
    delete process.env.GOOSE_PATH_ROOT;
    env.restore();
  });

  for (const c of cases) {
    for (const order of ["ingest, backfill", "backfill, ingest"] as const) {
      it(`${c.adapter.id} (${order})`, async () => {
        c.setup(env);
        const spool = join(env.dataHome, "spool", c.adapter.id);
        mkdirSync(spool, { recursive: true });
        writeFileSync(join(spool, "2026-09-21.1.jsonl"), loadSpool(`${c.adapter.id}/hooks.spool.jsonl`).map((l) => JSON.stringify(l) + "\n").join(""));
        const config = defaultConfig({ ...process.env });
        config.snapshot.enabled = false;
        const index = new MemoryIndexStore();
        const blobs = new MemoryBlobStore();
        const run = {
          ingest: () => ingest({ config, index, blobs, adapters: new Map([[c.adapter.id, c.adapter]]), env: { ...process.env }, spoolDir: join(env.dataHome, "spool"), lock: false }),
          backfill: () => backfill({ config, index, blobs, adapters: [c.adapter], env: { ...process.env } }),
        };
        for (const step of order.split(", ") as ("ingest" | "backfill")[]) await run[step]();
        const ends = await index.listEvents(c.session, { kinds: ["turn.end"] });
        assert.ok(ends.some((e) => e.source === "hook") && ends.some((e) => e.source === "transcript"), "both capture paths stored turn ends");
        assert.equal((await index.getSession(c.session))!.stats.turns, c.turns);
      });
    }
  }
});
