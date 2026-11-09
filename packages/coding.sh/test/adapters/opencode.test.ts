import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentEvent } from "../../src/schema/index.ts";
import { after, before, describe, it } from "node:test";
import { apiForVersion, opencode, opencodeDbNotes, opencodeDbPath, pluginPath, pluginSource, PLUGIN_MARKER } from "../../src/adapters/opencode.ts";
import { assertGolden, assertWellFormed, collect, fakeBin, FIXTURES, loadSpool, summarize, testCtx, tmpEnv, writeFile, type TmpEnv } from "./_helpers.ts";

const T0 = 1793527200000;

async function normalizeAll(rel: string) {
  const { ctx } = testCtx();
  const events = [];
  for (const line of loadSpool(rel)) events.push(...(await opencode.normalize(line, ctx)));
  assertWellFormed(events);
  return events;
}

describe("opencode normalize", () => {
  it("v2 plugin events → golden (tools, llm.call, child session, turn.end)", async () => {
    const events = await normalizeAll("opencode/v2.spool.jsonl");
    assertGolden("opencode/golden/v2.golden.json", summarize(events));

    const end = events.find((e) => e.kind === "tool.end" && e.payload.toolUseId === "call_1")!;
    assert.equal(end.durationMs, 1200);
    const test = events.find((e) => e.kind === "test.result")!;
    assert.deepEqual([test.payload.runner, test.payload.passed, test.payload.failed, test.payload.skipped], ["pytest", 10, 1, 2]);
    const edit = events.find((e) => e.kind === "file.change")!;
    assert.deepEqual([edit.payload.path, edit.payload.op], ["calc.py", "modify"]);
    assert.ok(!events.some((e) => e.kind === "file.change" && e.payload.path === "notes.md"), "failed write is not a file change");

    const llm = events.find((e) => e.kind === "llm.call")!;
    assert.equal(llm.ts, T0 + 4000 - 2400);
    assert.equal(llm.durationMs, 2400);
    assert.deepEqual(llm.usage, { inputTokens: 1000, outputTokens: 250, cacheReadTokens: 3000, cacheWriteTokens: 0, costUsd: 0.0123 });

    const child = events.find((e) => e.kind === "session.start" && e.sessionId === "ses_child")!;
    assert.deepEqual([child.payload.parentSessionId, child.payload.subagentId, child.payload.subagentType], ["ses_main", "ses_child", "general"]);
    const subStart = events.find((e) => e.kind === "subagent.start")!;
    const subEnd = events.find((e) => e.kind === "subagent.end")!;
    assert.deepEqual([subStart.sessionId, subStart.subagentId, subStart.payload.childSessionId], ["ses_main", undefined, "ses_child"]);
    assert.deepEqual([subEnd.sessionId, subEnd.payload.ok, subEnd.payload.childSessionId], ["ses_main", true, "ses_child"]);
    assert.ok(events.filter((e) => e.sessionId === "ses_child").every((e) => e.subagentId === "ses_child"));
    assert.ok(events.some((e) => e.kind === "context.compact"));
  });

  it("v1 plugin events → golden", async () => {
    const events = await normalizeAll("opencode/v1.spool.jsonl");
    assertGolden("opencode/golden/v1.golden.json", summarize(events));
    assert.deepEqual(
      events.map((e) => e.kind),
      ["session.start", "user.message", "tool.start", "tool.end", "file.change", "assistant.message", "llm.call", "turn.end"],
    );
    const llm = events.find((e) => e.kind === "llm.call")!;
    assert.deepEqual([llm.ts, llm.durationMs, llm.payload.provider, llm.model], [T0 + 20, 1485, "openai", "gpt-5"]);
  });

  it("is deterministic", async () => {
    assert.deepEqual(await normalizeAll("opencode/v2.spool.jsonl"), await normalizeAll("opencode/v2.spool.jsonl"));
  });
});

describe("opencode backfill", () => {
  let env: TmpEnv;
  before(() => (env = tmpEnv()));
  after(() => env.restore());

  it("1.x JSON storage, with natural keys shared with live events", async () => {
    process.env.XDG_DATA_HOME = join(FIXTURES, "opencode", "data");
    const { ctx } = testCtx();
    const events = await collect(opencode.backfill!(ctx));
    assertWellFormed(events);
    assertGolden("opencode/golden/backfill-v1.golden.json", summarize(events));
    const live = await normalizeAll("opencode/v1.spool.jsonl");
    for (const kind of ["tool.start", "tool.end", "llm.call", "user.message", "assistant.message", "session.start"]) {
      const a = live.find((e) => e.kind === kind)!.id;
      assert.ok(events.some((e) => e.id === a), `${kind} dedupes between live and backfill`);
    }
    const child = events.find((e) => e.sessionId === "ses_v1c" && e.kind === "session.start")!;
    assert.equal(child.payload.parentSessionId, "ses_v1");

    const later = await collect(opencode.backfill!(ctx, { since: T0 + 1000 }));
    assert.ok(later.length > 0 && later.every((e) => e.ts >= T0 + 1000));
    assert.ok(!later.some((e) => e.sessionId === "ses_v1c"), "sessions not updated since are skipped");
  });

  it("2.x SQLite database (copied, read-only)", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const dbPath = join(env.root, "opencode.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE session_v2 (id TEXT, parent_id TEXT, title TEXT, directory TEXT, version TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER,
        tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, cost REAL);
      CREATE TABLE session_message (id TEXT, session_id TEXT, seq INTEGER, type TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE session_part (id TEXT, session_id TEXT, message_id TEXT, ordinal INTEGER, type TEXT, call_id TEXT, data TEXT);
    `);
    db.prepare("INSERT INTO session_v2 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("ses_db", null, "DB session", "/work/demo", "2.2.5", "build", T0, T0 + 5000, 500, 40, 10, 100, 0, 0.002);
    db.prepare("INSERT INTO session_message VALUES (?,?,?,?,?,?)").run("m1", "ses_db", 1, "user", T0 + 10, JSON.stringify({ role: "user" }));
    db.prepare("INSERT INTO session_message VALUES (?,?,?,?,?,?)").run("m2", "ses_db", 2, "assistant", T0 + 20, JSON.stringify({ role: "assistant" }));
    db.prepare("INSERT INTO session_part VALUES (?,?,?,?,?,?,?)").run("p1", "ses_db", "m1", 0, "text", null, JSON.stringify({ id: "p1", text: "List files" }));
    db.prepare("INSERT INTO session_part VALUES (?,?,?,?,?,?,?)").run("p2", "ses_db", "m2", 0, "tool", "call_ls", JSON.stringify({ tool: "bash", state: { status: "completed", input: { command: "ls" }, output: "a\nb\n", time: { start: T0 + 100, end: T0 + 150 } } }));
    db.prepare("INSERT INTO session_part VALUES (?,?,?,?,?,?,?)").run("p3", "ses_db", "m2", 1, "text", null, JSON.stringify({ id: "p3", text: "Two files." }));
    db.close();
    process.env.OPENCODE_DB = dbPath;
    process.env.XDG_DATA_HOME = join(env.root, "empty");

    const events = await collect(opencode.backfill!(testCtx().ctx));
    assertWellFormed(events);
    assert.deepEqual(
      events.map((e) => [e.kind, e.ts]),
      [
        ["session.start", T0],
        ["user.message", T0 + 10],
        ["tool.start", T0 + 100],
        ["tool.end", T0 + 150],
        ["assistant.message", T0 + 20],
        ["notification", T0 + 20],
      ],
    );
    assert.deepEqual(events.at(-1)!.usage, { inputTokens: 500, outputTokens: 50, cacheReadTokens: 100, cacheWriteTokens: 0, costUsd: 0.002 }, "session totals when no per-call usage");
    assert.equal(events.find((e) => e.kind === "tool.end")!.durationMs, 50);
    assert.ok(!readdirSync(env.root).some((n) => n.startsWith("csh-opencode-")));
  });
});

describe("opencode plugin", () => {
  let env: TmpEnv;
  before(() => (env = tmpEnv()));
  after(() => env.restore());

  it("maps versions to plugin APIs", () => {
    assert.equal(apiForVersion("1.0.150"), 1);
    assert.equal(apiForVersion("2.2.5"), 2);
    assert.equal(apiForVersion(undefined), 2);
  });

  for (const api of [1, 2] as const) {
    it(`v${api} source is valid JS and forwards events to the hook command`, async () => {
      const out = join(env.root, `forwarded-v${api}`);
      const hook = join(env.root, `hook-v${api}.mjs`);
      writeFile(
        hook,
        `import { appendFileSync } from "node:fs";\nlet s = "";\nprocess.stdin.on("data", (d) => (s += d)).on("end", () => appendFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), payload: JSON.parse(s) }) + "\\n"));\n`,
      );
      const plugin = join(env.root, `plugin-v${api}`, "coding-sh.mjs");
      writeFile(plugin, pluginSource(hook, api));
      execFileSync(process.execPath, ["--check", plugin]);
      assert.ok(readFileSync(plugin, "utf8").startsWith(PLUGIN_MARKER));

      process.env.PATH = dirname(process.execPath);
      const mod = await import(pathToFileURL(plugin).href);
      if (api === 1) {
        const hooks = await mod.CodingSh({ directory: "/work/demo" });
        await hooks["tool.execute.before"]({ tool: "bash", sessionID: "s1", callID: "c1" }, { args: { command: "ls" } });
        await hooks["tool.execute.after"]({ tool: "bash", sessionID: "s1", callID: "c1" }, { output: "a\n", title: "ls", metadata: {} });
        await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
      } else {
        const handlers: Record<string, (e: unknown) => void> = {};
        let release!: () => void;
        const done = new Promise<void>((r) => (release = r));
        const ctx = {
          location: { directory: "/work/demo" },
          tool: { hook: async (name: string, fn: (e: unknown) => void) => void (handlers[name] = fn) },
          event: {
            async *subscribe() {
              yield { id: "e1", type: "session.step.started", created: T0, data: { sessionID: "s1" } };
              yield { id: "e2", type: "session.step.ended", created: T0 + 900, data: { sessionID: "s1", tokens: { input: 1, output: 2 } } };
              release();
            },
          },
        };
        const dispose = await mod.default.setup(ctx);
        handlers["execute.before"]!({ id: "c1", sessionID: "s1", tool: "bash", input: { command: "ls" } });
        handlers["execute.after"]!({ id: "c1", sessionID: "s1", tool: "bash", input: { command: "ls" }, status: "completed", result: { output: "a\n" } });
        await done;
        dispose();
      }
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && (!existsSync(out) || readFileSync(out, "utf8").trim().split("\n").length < 3)) await new Promise((r) => setTimeout(r, 50));
      const got = readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const byEvent = Object.fromEntries(got.map((g) => [g.argv[1], g]));
      assert.ok(got.every((g) => g.argv[0] === "opencode"));
      assert.equal(byEvent["tool.execute.after"].payload.cwd, "/work/demo");
      assert.equal(byEvent["tool.execute.after"].payload.api, api);
      assert.equal(typeof byEvent["tool.execute.after"].payload.durationMs, "number");
      if (api === 1) assert.deepEqual(byEvent["tool.execute.after"].payload.input, { command: "ls" }, "v1 carries args from before → after");
      else assert.equal(byEvent["session.step.ended"].payload.durationMs, 900, "v2 computes step latency from started/ended");
    });
  }

  it("install picks the plugin API from `opencode --version`, round-trips, refuses foreign files", async () => {
    const hookCommand = join(env.dataHome, "bin", "hook.mjs");
    fakeBin(env, "opencode", "1.0.150");
    const v1 = pluginPath({ scope: "user" }, 1);
    const v2 = pluginPath({ scope: "user" }, 2);
    assert.ok(v1.startsWith(env.home), "config under the temp HOME");

    const dry = await opencode.install({ hookCommand, scope: "user", dryRun: true });
    assert.equal(dry.length, 1);
    assert.ok(!existsSync(v1));

    const c = await opencode.install({ hookCommand, scope: "user", dryRun: false });
    assert.deepEqual([c.length, c[0]!.path, c[0]!.action], [1, v1, "create"]);
    assert.match(readFileSync(v1, "utf8"), /api: v1/);
    assert.equal((await opencode.detect()).hooked, true);
    assert.deepEqual(await opencode.install({ hookCommand, scope: "user", dryRun: false }), [], "idempotent");

    // Upgrade to 2.x: the v2 plugin replaces the stale v1 one.
    fakeBin(env, "opencode", "opencode 2.2.5");
    const up = await opencode.install({ hookCommand, scope: "user", dryRun: false });
    assert.deepEqual(up.map((x) => [x.path, x.action]), [[v2, "create"], [v1, "delete"]]);
    assert.ok(existsSync(v2) && !existsSync(v1));

    const un = await opencode.uninstall({ scope: "user", dryRun: false });
    assert.deepEqual(un.map((x) => x.action), ["delete"]);
    assert.ok(!existsSync(v2));
    assert.equal((await opencode.detect()).hooked, false);

    writeFile(v2, "export default {};\n");
    await assert.rejects(opencode.install({ hookCommand, scope: "user", dryRun: false }), /refusing to overwrite/);
    assert.deepEqual(await opencode.uninstall({ scope: "user", dryRun: false }), [], "never removes a user's own plugin");
    assert.equal(readFileSync(v2, "utf8"), "export default {};\n");
  });

  it("project scope writes under .opencode/", async () => {
    fakeBin(env, "opencode", "2.2.5");
    const proj = join(env.root, "proj");
    const c = await opencode.install({ hookCommand: "/x/hook.mjs", scope: "project", projectDir: proj, dryRun: false });
    assert.equal(c[0]!.path, join(proj, ".opencode", "plugins", "coding-sh.js"));
    await opencode.uninstall({ scope: "project", projectDir: proj, dryRun: false });
    assert.ok(!existsSync(c[0]!.path));
  });
});

describe("opencode database discovery (real OpenCode 1.19.5 drizzle database)", () => {
  let env: TmpEnv;
  before(() => (env = tmpEnv()));
  after(() => env.restore());

  /** The real 1.x database (session/message/part tables with JSON data), rebuilt from its dump. */
  async function realDb(path: string): Promise<void> {
    const { DatabaseSync } = await import("node:sqlite");
    const dump = JSON.parse(readFileSync(join(FIXTURES, "opencode", "real", "opencode.db.json"), "utf8")) as { schema: string[]; rows: Record<string, Record<string, unknown>[]> };
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path, { enableForeignKeyConstraints: false });
    for (const sql of dump.schema) db.exec(sql);
    for (const [table, rows] of Object.entries(dump.rows))
      for (const r of rows) {
        const cols = Object.keys(r);
        db.prepare(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...(Object.values(r) as (string | number | null)[]));
      }
    db.close();
  }
  const dataDir = (name: string) => {
    delete process.env.OPENCODE_DB;
    process.env.XDG_DATA_HOME = join(env.root, name);
    return join(env.root, name, "opencode");
  };
  const summary = (events: AgentEvent[]) => events.map((e) => [e.kind, e.payload.tool ?? e.payload.text ?? ""]);
  const BLOCKING = /\bpredates\b|\bwill not run\b|\bnot trusted yet\b/i; // doctor's BLOCKING_NOTE

  it("imports sessions, messages and tool parts from <data>/opencode.db", async () => {
    const dir = dataDir("main");
    await realDb(join(dir, "opencode.db"));
    const events = await collect(opencode.backfill!(testCtx().ctx));
    assertWellFormed(events);
    assertGolden("opencode/golden/backfill-db.golden.json", summarize(events));
    assert.equal(new Set(events.map((e) => e.sessionId)).size, 1);
    for (const kind of ["session.start", "user.message", "assistant.message", "tool.start", "tool.end", "llm.call"]) assert.ok(events.some((e) => e.kind === kind), kind);
    assert.deepEqual(await opencodeDbNotes(), []);
  });

  it("reads the newest database OpenCode set aside after a schema mismatch, and says so", async () => {
    const want = summary(await collect(opencode.backfill!(testCtx().ctx)));
    const dir = dataDir("mismatch");
    const newest = join(dir, "opencode.db.schema-mismatch-1787452268462");
    await realDb(newest);
    writeFileSync(join(dir, "opencode.db.schema-mismatch-1787452268462-wal"), "");
    writeFileSync(join(dir, "opencode.db.schema-mismatch-1700000000000"), "not a database");
    utimesSync(join(dir, "opencode.db.schema-mismatch-1700000000000"), new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    assert.deepEqual(opencodeDbPath(), { path: newest, setAside: true });
    const events = await collect(opencode.backfill!(testCtx().ctx));
    assertWellFormed(events);
    assert.deepEqual(summary(events), want);
    const notes = await opencodeDbNotes();
    assert.equal(notes.length, 1);
    assert.match(notes[0]!, /set its database aside after a schema mismatch \(opencode\.db\.schema-mismatch-1787452268462\)/);
    assert.ok((await opencode.detect()).notes?.includes(notes[0]!));
    assert.ok(!BLOCKING.test(notes[0]!), "a note, not a blocking doctor failure");
    // Once OpenCode writes a new opencode.db, that one is read.
    await realDb(join(dir, "opencode.db"));
    assert.deepEqual(opencodeDbPath(), { path: join(dir, "opencode.db") });
    assert.deepEqual(await opencodeDbNotes(), []);
  });

  it("a database with no session tables imports nothing and doctor names its tables", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const dir = dataDir("unknown");
    mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(join(dir, "opencode.db"));
    db.exec("CREATE TABLE conversation (id TEXT); CREATE TABLE turn (id TEXT);");
    db.close();
    assert.deepEqual(await collect(opencode.backfill!(testCtx().ctx)), []);
    const notes = await opencodeDbNotes();
    assert.deepEqual(notes, ["opencode.db has no session tables coding.sh can read (found: conversation, turn); OpenCode history is not imported"]);
    assert.ok(!BLOCKING.test(notes[0]!));
  });

  it("an unreadable database imports nothing and doctor says why", async () => {
    const dir = dataDir("broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "opencode.db"), "this is not a sqlite file, just text that is long enough to have a header".repeat(4));
    assert.deepEqual(await collect(opencode.backfill!(testCtx().ctx)), []);
    const notes = await opencodeDbNotes();
    assert.equal(notes.length, 1);
    assert.match(notes[0]!, /^cannot read opencode\.db \(.+\); OpenCode history is not imported$/);
  });
});
