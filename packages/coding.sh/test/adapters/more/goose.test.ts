import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { GOOSE_HOOK_EVENTS, gooseAdapter, gooseConfigDir, gooseDbEvents, gooseSessionsDb } from "../../../src/adapters/more/goose.ts";
import type { TmpEnv } from "../_helpers.ts";
import { assertGolden, assertInstallRoundTrip, assertRunOk, assertWellFormed, collect, fakeBinary, HOOK, moreEnv, normalizeFixture, readArgv, runSpec, summarize, testCtx, writeFile } from "./_helpers.ts";

const T0 = 1790000000; // epoch seconds, as goose stores them

/** A synthetic sessions.db with the v18 tables the adapter reads. */
function makeDb(path: string, opts: { ledger: boolean }): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT, working_dir TEXT, created_at TEXT, updated_at TEXT, provider_name TEXT, model_config_json TEXT, session_type TEXT, parent_session_id TEXT,
    accumulated_input_tokens INTEGER, accumulated_output_tokens INTEGER, accumulated_cache_read_tokens INTEGER, accumulated_cache_write_tokens INTEGER, accumulated_cost REAL);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT, session_id TEXT, role TEXT, content_json TEXT, created_timestamp INTEGER);`);
  if (opts.ledger) db.exec("CREATE TABLE usage_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, created_timestamp INTEGER, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, cost REAL, is_compaction INTEGER)");
  db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("20260921_1", "codingsh-run-42", "/work/demo", "2026-09-21T14:13:20Z", "2026-09-21T14:20:00Z", "anthropic", JSON.stringify({ model_name: "claude-sonnet-4-5" }), "user", null, 3000, 120, 1000, 200, 0.02);
  db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("20260921_2", "find tests", "/work/demo", "2026-09-21T14:13:22Z", "2026-09-21T14:13:23Z", "anthropic", JSON.stringify({ model_name: "claude-haiku-4-5" }), "sub_agent", "20260921_1", 0, 0, 0, 0, 0);
  const msg = db.prepare("INSERT INTO messages (message_id, session_id, role, content_json, created_timestamp) VALUES (?,?,?,?,?)");
  msg.run("g1", "20260921_1", "user", JSON.stringify([{ type: "text", text: "Fix the go test" }]), T0 + 1);
  msg.run(
    "g2",
    "20260921_1",
    "assistant",
    JSON.stringify([
      { type: "text", text: "Editing main.go." },
      { type: "toolRequest", id: "tc-g1", toolCall: { status: "success", value: { name: "developer__text_editor", arguments: { command: "str_replace", path: "/work/demo/main.go", old_str: "-", new_str: "+" } } } },
      { type: "toolRequest", id: "tc-g2", toolCall: { status: "success", value: { name: "developer__shell", arguments: { command: "go test ./..." } } } },
    ]),
    T0 + 2,
  );
  msg.run(
    "g3",
    "20260921_1",
    "user",
    JSON.stringify([
      { type: "toolResponse", id: "tc-g1", toolResult: { status: "success", value: { content: [{ type: "text", text: "edited" }], isError: false } } },
      { type: "toolResponse", id: "tc-g2", toolResult: { status: "success", value: { content: [{ type: "text", text: "--- PASS: TestAdd (0.00s)\n--- FAIL: TestSub (0.00s)\nFAIL" }], isError: true } } },
    ]),
    T0 + 4,
  );
  msg.run("g4", "20260921_1", "assistant", JSON.stringify([{ type: "text", text: "TestSub still fails." }]), T0 + 5);
  msg.run("s1", "20260921_2", "user", JSON.stringify([{ type: "text", text: "List the test files" }]), T0 + 2);
  msg.run("s2", "20260921_2", "assistant", JSON.stringify([{ type: "text", text: "main_test.go" }]), T0 + 3);
  if (opts.ledger) {
    const l = db.prepare("INSERT INTO usage_ledger (session_id, created_timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost, is_compaction) VALUES (?,?,?,?,?,?,?,?,?)");
    l.run("20260921_1", T0 + 2, "claude-sonnet-4-5", 1400, 80, 0, 200, 0.012, 0);
    l.run("20260921_1", T0 + 5, "claude-sonnet-4-5", 1600, 40, 1000, 0, 0.008, 0);
  }
  db.close();
}

describe("goose normalize", () => {
  it("maps hook payloads to golden events", async () => {
    const events = await normalizeFixture(gooseAdapter, "goose/hooks.spool.jsonl");
    assertWellFormed(events);
    assertGolden("goose/golden/hooks.golden.json", summarize(events));
    const changes = events.filter((e) => e.kind === "file.change");
    assert.equal(changes.length, 1, "file edits come only from AfterFileEdit (no guessing from input)");
    assert.deepEqual([changes[0]!.payload.path, changes[0]!.payload.op], ["main.go", "modify"]);
    assert.ok(!events.some((e) => e.kind === "test.result"), "no output, no test summary");
    assert.equal(events.find((e) => e.kind === "tool.end" && e.payload.ok === false)!.payload.tool, "developer__shell");
    assert.equal(events.find((e) => e.kind === "assistant.message")!.payload.text, "Fixed the sign error in main.go.");
  });
});

describe("goose sessions.db", () => {
  let env: TmpEnv;
  before(() => {
    env = moreEnv();
  });
  after(() => env.restore());

  it("backfills messages + usage_ledger to golden events", async () => {
    process.env.GOOSE_PATH_ROOT = join(env.root, "goose-root");
    try {
      const dbPath = gooseSessionsDb();
      assert.equal(dbPath, join(env.root, "goose-root", "data", "sessions", "sessions.db"));
      makeDb(dbPath, { ledger: true });
      const before = readFileSync(dbPath);
      const { ctx } = testCtx();
      const events = await collect(gooseAdapter.backfill!(ctx));
      assertWellFormed(events);
      assertGolden("goose/golden/backfill.golden.json", summarize(events));
      assert.deepEqual(readFileSync(dbPath), before, "the live DB is never written (read from a copy)");
      const calls = events.filter((e) => e.kind === "llm.call");
      assert.equal(calls.length, 2);
      const child = events.find((e) => e.kind === "session.start" && e.sessionId === "20260921_2")!;
      assert.deepEqual([child.payload.parentSessionId, child.payload.subagentId, child.payload.subagentType], ["20260921_1", "20260921_2", "sub_agent"]);
      const sub = events.filter((e) => e.sessionId === "20260921_1" && e.kind.startsWith("subagent."));
      assert.deepEqual(sub.map((e) => [e.kind, e.payload.childSessionId]), [["subagent.start", "20260921_2"], ["subagent.end", "20260921_2"]]);
      assert.equal(sub[1]!.durationMs, 1000);
      assert.equal(events.filter((e) => e.usage).length, 2, "ledger rows only; no session total on top");
      const shell = events.find((e) => e.kind === "tool.end" && e.payload.tool === "developer__shell")!;
      assert.equal(shell.payload.ok, false);
      assert.equal(shell.durationMs, 2000);
      const tr = events.find((e) => e.kind === "test.result")!;
      assert.deepEqual([tr.payload.runner, tr.payload.passed, tr.payload.failed], ["go", 1, 1]);
      assert.ok(events.filter((e) => e.sessionId === "20260921_1" && !e.kind.startsWith("subagent.")).every((e) => e.cwd === "/work/demo" && e.model === "claude-sonnet-4-5"));
    } finally {
      delete process.env.GOOSE_PATH_ROOT;
    }
  });

  it("falls back to the session's accumulated totals without a ledger", async () => {
    const dbPath = join(env.root, "old", "sessions.db");
    makeDb(dbPath, { ledger: false });
    const events = await collect(gooseDbEvents(dbPath, testCtx().ctx));
    const totals = events.filter((e) => e.usage);
    assert.equal(totals.length, 1, "the subagent session has zero totals, so no usage event");
    assert.equal(totals[0]!.payload.kind, "usage.total");
    assert.deepEqual(totals[0]!.usage, { inputTokens: 3000, outputTokens: 120, cacheReadTokens: 1000, cacheWriteTokens: 200, costUsd: 0.02 });
  });

  it("uses the XDG data dir by default (also on macOS)", () => {
    if (process.platform === "win32") return;
    assert.equal(gooseSessionsDb(), join(env.home, ".local", "share", "goose", "sessions", "sessions.db"));
  });

  it("uses %APPDATA%/Block/goose on Windows, for config as well as data", () => {
    const appdata = join(env.root, "AppData", "Roaming");
    assert.equal(gooseConfigDir({ APPDATA: appdata, HOME: env.home }, "win32"), join(appdata, "Block", "goose", "config"));
    assert.equal(gooseSessionsDb({ APPDATA: appdata, HOME: env.home }, "win32"), join(appdata, "Block", "goose", "data", "sessions", "sessions.db"));
    // No APPDATA: the profile's AppData/Roaming, as etcetera falls back to.
    assert.equal(gooseConfigDir({ USERPROFILE: env.home, HOME: env.home }, "win32"), join(env.home, "AppData", "Roaming", "Block", "goose", "config"));
    // GOOSE_PATH_ROOT wins everywhere.
    assert.equal(gooseConfigDir({ APPDATA: appdata, GOOSE_PATH_ROOT: env.root }, "win32"), join(env.root, "config"));
  });
});

describe("goose install", () => {
  let env: TmpEnv;
  before(() => {
    env = moreEnv();
  });
  after(() => env.restore());

  it("writes a plugin under ~/.agents/plugins/coding-sh with match-all hooks", async () => {
    const { installed } = await assertInstallRoundTrip(gooseAdapter, env.root);
    const h = JSON.parse(installed[".agents/plugins/coding-sh/hooks/hooks.json"]!);
    assert.deepEqual(Object.keys(h.hooks), [...GOOSE_HOOK_EVENTS]);
    for (const groups of Object.values(h.hooks) as { matcher?: string }[][]) assert.equal(groups[0]!.matcher, undefined, "a bare * matcher is invalid in goose; omit it");
    assert.equal(h.hooks.PreToolUse[0].hooks[0].command, `node "${HOOK}" goose PreToolUse`);
    assert.ok(installed[".agents/plugins/coding-sh/plugin.json"]);
    assert.ok(!existsSync(join(env.home, ".agents", "plugins", "coding-sh")) || !existsSync(join(env.home, ".agents", "plugins", "coding-sh", "hooks", "hooks.json")));
  });

  it("keeps a user-written plugin.json on uninstall", async () => {
    const manifest = join(env.home, ".agents", "plugins", "coding-sh", "plugin.json");
    writeFile(manifest, '{"name":"coding-sh","note":"mine"}\n');
    await assertInstallRoundTrip(gooseAdapter, env.root);
    assert.equal(readFileSync(manifest, "utf8"), '{"name":"coding-sh","note":"mine"}\n');
  });
});

describe("goose run + overlay", () => {
  let env: TmpEnv;
  before(() => {
    env = moreEnv();
  });
  after(() => env.restore());

  it("drives `goose run` and finds the named session in sessions.db", async () => {
    const bin = join(env.root, "bin");
    fakeBinary(bin, "goose", `console.log(JSON.stringify({type:"message",message:{role:"assistant"}}));console.log(JSON.stringify({type:"complete",total_tokens:130,input_tokens:100,output_tokens:30,cost_usd:0.001}));`);
    const root = join(env.root, "groot");
    makeDb(join(root, "data", "sessions", "sessions.db"), { ledger: true });
    const cwd = join(env.root, "work");
    mkdirSync(cwd, { recursive: true });
    const spec = runSpec(cwd, bin, { model: "claude-sonnet-4-5" });
    spec.env.GOOSE_PATH_ROOT = root;
    const r = await gooseAdapter.run!(spec);
    assertRunOk(r);
    assert.equal(r.sessionId, "20260921_1", "session named codingsh-<runId>");
    assert.deepEqual(r.usage, { inputTokens: 100, outputTokens: 30, costUsd: 0.001 });
    const a = readArgv(bin, "goose");
    assert.deepEqual(a.argv, ["run", "-t", "fix the bug", "--output-format", "stream-json", "-q", "-n", "codingsh-run-42", "--model", "claude-sonnet-4-5"]);
    assert.equal(a.env.GOOSE_MODE, "auto");
  });

  it("overlay roots goose in the run dir and carries config.yaml over", async () => {
    // ~/.config/goose, or %APPDATA%/Block/goose/config on Windows (moreEnv clears APPDATA: under the temp home).
    writeFile(join(gooseConfigDir(), "config.yaml"), "GOOSE_PROVIDER: anthropic\n");
    const runDir = join(env.root, "run");
    const o = await gooseAdapter.overlay!({ files: {}, flags: [] } as never, runDir);
    assert.equal(o.env.GOOSE_PATH_ROOT, join(runDir, "goose"));
    assert.equal(o.env.GOOSE_DISABLE_KEYRING, "1");
    assert.equal(readFileSync(join(runDir, "goose", "config", "config.yaml"), "utf8"), "GOOSE_PROVIDER: anthropic\n");
  });
});
