// Reads while a re-parse holds the store (AG-9): with reparse.lock held by a live process and
// 2,000 spool files waiting, every read answers from what is indexed within its budget, skips the
// ingest, wakes the re-parse (the wake marker), and says so: a note on stderr in the human form,
// `pending.reparsing` in the JSON one. The budget is 3 s, or on a loaded machine three times what
// the same read takes right then on a store with no re-parse and no backlog.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { CliError } from "../../src/cli/output.ts";
import { notFoundWithBacklog, pendingField } from "../../src/cli/common.ts";
import { spoolBacklog } from "../../src/core/ingest.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { tmpEnv, type TmpEnv } from "../adapters/_helpers.ts";
import { timeMs } from "../helpers-timing.ts";
import { cli, event, seed, session } from "../query/_seed.ts";

const FILES = 2000;
const NOTE = /2000 files not yet ingested; a re-parse is running/;

describe("reads while a re-parse holds the store", () => {
  let env: TmpEnv;
  let holder: ChildProcess;
  let plainHome: string;
  const now = Date.now();
  const id = "aaaaaaaa-1111-4222-8333-444444444444";

  before(async () => {
    env = tmpEnv();
    const stored = {
      sessions: [session(id, { startedAt: now - 3600e3, endedAt: now - 3000e3, cwd: env.root })],
      events: [event(id, 1, { ts: now - 3600e3 }), event(id, 2, { ts: now - 3500e3, kind: "assistant.message", payload: { text: "done" } })],
    };
    await seed(env.dataHome, stored);
    // The same store with no re-parse and nothing waiting: what each read costs on this machine right now.
    plainHome = join(env.root, "plain");
    await seed(plainHome, stored);
    const dir = join(env.dataHome, "spool", "claude-code");
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < FILES; i++) {
      const sid = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      const line = { v: 0, agent: "claude-code", event: "UserPromptSubmit", ts: now - 60e3 + i, pid: 1000 + i, cwd: "/work/demo", raw: { session_id: sid, hook_event_name: "UserPromptSubmit", prompt: `fix ${i}` } };
      writeFileSync(join(dir, `2026-11-08.${1000 + i}.jsonl`), JSON.stringify(line) + "\n");
    }
    // A live holder: a process that outlives the test's reads.
    holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], { stdio: "ignore" });
    writeFileSync(join(env.dataHome, "reparse.lock"), JSON.stringify({ pid: holder.pid, host: hostname(), ts: Date.now(), nonce: "test" }));
  });
  after(() => {
    holder?.kill();
    env.restore();
  });

  const reads: [string, string[], boolean][] = [
    ["show <id> --json", ["show", id, "--json"], true],
    ["sessions --facets --since 7d", ["sessions", "--facets", "--since", "7d", "--json"], true],
    ["improve --since 2d --json", ["improve", "--since", "2d", "--json"], true],
    ["tree <id>", ["tree", id], false],
    ["usage", ["usage"], false],
    ["harness audit", ["harness", "audit"], false],
  ];
  for (const [name, args, json] of reads) {
    test(`${name} answers in under 3 s, the backlog said off stdout`, () => {
      let r!: ReturnType<typeof cli>;
      let ms = 0;
      let plain = 0;
      // Up to three tries: a burst of load can hit one read and not the plain one after it.
      for (let i = 0; i < 3; i++) {
        ms = timeMs(() => (r = cli(args, { CODING_SH_HOME: env.dataHome, HOME: env.home })));
        if (ms < 3000) break;
        plain = timeMs(() => cli(args, { CODING_SH_HOME: plainHome, HOME: env.home }));
        if (ms < 3 * plain) break;
      }
      assert.equal(r.status, 0, r.stderr);
      assert.ok(ms < 3000 || ms < 3 * plain, `${name} took ${Math.round(ms)} ms (${Math.round(plain)} ms with no re-parse)`);
      assert.doesNotMatch(r.stdout, /not yet ingested/);
      // --json keeps stderr quiet (one document on stdout) and says it in `pending`; the human form notes it on stderr.
      if (json) assert.deepEqual(JSON.parse(r.stdout).pending, { files: FILES, indexing: true, reparsing: true });
      else assert.match(r.stderr, NOTE);
    });
  }

  test("the reads wake the re-parse and leave the spool to it", async () => {
    assert.ok(existsSync(join(env.dataHome, "spool", ".ingest.pending")), "wake marker");
    const store = await SqliteIndexStore.open(join(env.dataHome, "index.db"));
    try {
      assert.equal(await spoolBacklog(store, join(env.dataHome, "spool")), FILES, "no cursor moved");
    } finally {
      await store.close();
    }
  });

  test("a session not indexed yet says it may be in the pending files", () => {
    const r = cli(["show", "ffffffff-0000-4000-8000-000000000000", "--json"], { CODING_SH_HOME: env.dataHome, HOME: env.home });
    assert.equal(r.status, 1);
    const doc = JSON.parse(r.stdout || r.stderr);
    const err = doc.error ?? doc;
    assert.equal(err.reason, "not_found");
    assert.match(err.message, /2000 files not yet ingested/);
  });
});

describe("pendingField and notFoundWithBacklog", () => {
  test("pendingField is absent with nothing pending, and carries reparsing only while one runs", () => {
    assert.deepEqual(pendingField({ pendingFiles: 0, indexing: false }), {});
    assert.deepEqual(pendingField({ pendingFiles: 3, indexing: true }), { pending: { files: 3, indexing: true } });
    assert.deepEqual(pendingField({ pendingFiles: 3, indexing: true, reparsing: true }), { pending: { files: 3, indexing: true, reparsing: true } });
  });
  test("notFoundWithBacklog only rewrites not_found while files wait", () => {
    const nf = new CliError("No session x", { reason: "not_found" });
    assert.equal(notFoundWithBacklog(nf, { pendingFiles: 0, indexing: false }), nf);
    const other = new CliError("boom", { reason: "invalid_argument" });
    assert.equal(notFoundWithBacklog(other, { pendingFiles: 5, indexing: true }), other);
    const e = notFoundWithBacklog(nf, { pendingFiles: 5, indexing: true, reparsing: true }) as CliError;
    assert.equal(e.reason, "not_found");
    assert.match(e.message, /^No session x; it may be in the 5 files not yet ingested/);
    assert.deepEqual((e.data as { pending: unknown }).pending, { files: 5, indexing: true, reparsing: true });
  });
});
