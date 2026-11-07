// Payloads captured from real agent binaries (installed under a throwaway HOME, driven
// against a local stub model that returns one tool call, then text). Paths are scrubbed
// to /work/demo and /home/user. Versions: OpenCode 1.19.5, Goose 1.57.0, Pi 1.5.0,
// Copilot CLI 1.0.107, Factory Droid 1.6.0, Aider 0.86.2 (via `coding.sh run`).
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { aiderAdapter } from "../../src/adapters/more/aider.ts";
import { copilotCliAdapter, copilotSessionEvents } from "../../src/adapters/more/copilot-cli.ts";
import { droidAdapter, droidSessionEvents } from "../../src/adapters/more/droid.ts";
import { gooseAdapter, gooseDbEvents } from "../../src/adapters/more/goose.ts";
import { piAdapter } from "../../src/adapters/more/pi.ts";
import { opencode } from "../../src/adapters/opencode.ts";
import { buildSession } from "../../src/core/sessions.ts";
import type { Adapter } from "../../src/core/types.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { FIXTURES, assertWellFormed, collect, loadSpool, testCtx, tmpEnv, type TmpEnv } from "./_helpers.ts";

const PROMPT = "create hello.txt";
const REPLY = "Done. I wrote hello.txt.";

async function normalize(adapter: Adapter, rel: string, over: { agent?: string } = {}): Promise<AgentEvent[]> {
  const { ctx } = testCtx();
  const out: AgentEvent[] = [];
  for (const line of loadSpool(rel)) out.push(...(await adapter.normalize({ ...line, ...over }, ctx)));
  assertWellFormed(out);
  return out;
}

/** A SQLite file from a dumped {schema, rows} fixture. */
function loadDb(rel: string, path: string): void {
  const dump = JSON.parse(readFileSync(join(FIXTURES, rel), "utf8")) as { schema: string[]; rows: Record<string, Record<string, unknown>[]> };
  mkdirSync(join(path, ".."), { recursive: true });
  // Only the tables the adapter reads are dumped: skip foreign keys to the rest.
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: false });
  for (const sql of dump.schema) db.exec(sql);
  for (const [table, rows] of Object.entries(dump.rows)) {
    for (const r of rows) {
      const cols = Object.keys(r);
      db.prepare(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...(Object.values(r) as (string | number | null)[]));
    }
  }
  db.close();
}

const texts = (events: AgentEvent[], kind: string) => events.filter((e) => e.kind === kind).map((e) => e.payload.text);
const tools = (events: AgentEvent[]) => events.filter((e) => e.kind === "tool.end").map((e) => [e.payload.tool, e.payload.toolUseId, e.payload.ok]);
const files = (events: AgentEvent[]) => events.filter((e) => e.kind === "file.change").map((e) => [e.payload.path, e.payload.op]);

describe("real install: OpenCode 1.19.5", () => {
  let env: TmpEnv;
  before(() => (env = tmpEnv()));
  after(() => env.restore());

  it("v1 plugin events give the turn, the write, the file and both model calls", async () => {
    const events = await normalize(opencode, "opencode/real/hooks.spool.jsonl");
    const s = buildSession(events);
    assert.deepEqual(texts(events, "user.message"), [`"${PROMPT}"`]);
    assert.deepEqual(texts(events, "assistant.message"), [REPLY]);
    assert.deepEqual(tools(events), [["write", "call_mw63javu3", true]]);
    assert.deepEqual(files(events), [["hello.txt", "add"]]);
    assert.equal(s.model, "stub-model");
    assert.equal(s.stats.turns, 1);
    assert.equal(s.stats.latency?.llmCalls, 2);
    assert.deepEqual(s.stats.usage, { inputTokens: 240, outputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 });
  });

  it("backfills the 1.x SQLite tables (session / message / part), keyed like the live events", async () => {
    const dbPath = join(env.root, "opencode.db");
    loadDb("opencode/real/opencode.db.json", dbPath);
    process.env.OPENCODE_DB = dbPath;
    process.env.XDG_DATA_HOME = join(env.root, "empty");
    const events = await collect(opencode.backfill!(testCtx().ctx));
    assertWellFormed(events);
    const s = buildSession(events);
    assert.equal(s.id, "ses_e4b0a0cc8ffe19CiWeM0N8wEWa");
    assert.equal(s.cwd, "/work/demo");
    assert.equal(s.agentVersion, "1.19.5");
    assert.deepEqual(texts(events, "user.message"), [`"${PROMPT}"`]);
    assert.deepEqual(texts(events, "assistant.message"), [REPLY]);
    assert.deepEqual(tools(events), [["write", "call_mw63javu3", true]]);
    assert.equal(events.filter((e) => e.kind === "llm.call").length, 2);
    assert.deepEqual(s.stats.usage, { inputTokens: 240, outputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 });
    const live = await normalize(opencode, "opencode/real/hooks.spool.jsonl");
    for (const kind of ["tool.start", "tool.end", "llm.call", "user.message", "assistant.message"]) {
      const id = live.find((e) => e.kind === kind)!.id;
      assert.ok(events.some((e) => e.id === id), `${kind} dedupes between live and backfill`);
    }
  });
});

describe("real install: Goose 1.57.0", () => {
  let env: TmpEnv;
  before(() => (env = tmpEnv()));
  after(() => env.restore());

  it("hooks give the turn, the write and the file", async () => {
    const events = await normalize(gooseAdapter, "goose/real/hooks.spool.jsonl");
    assert.deepEqual(texts(events, "user.message"), [PROMPT]);
    assert.deepEqual(texts(events, "assistant.message"), [REPLY]);
    assert.deepEqual(tools(events), [["write", "call_mw63lw8r3", true]]);
    assert.deepEqual(files(events), [["hello.txt", "modify"]]);
    assert.ok(events.some((e) => e.kind === "session.end"));
  });

  it("sessions.db: UTC timestamps, no hidden turn-context prompt, usage per ledger row", async () => {
    const dbPath = join(env.root, "sessions.db");
    loadDb("goose/real/sessions.db.json", dbPath);
    const events = await collect(gooseDbEvents(dbPath, testCtx().ctx));
    assertWellFormed(events);
    const s = buildSession(events);
    // created_at "2026-11-07 07:45:01" is SQLite CURRENT_TIMESTAMP, i.e. UTC.
    assert.equal(events.find((e) => e.kind === "session.start")!.ts, Date.UTC(2026, 10, 7, 7, 45, 1));
    assert.deepEqual(texts(events, "user.message"), [PROMPT], "the <turn-context> message is hidden (userVisible: false)");
    assert.equal(s.title, PROMPT);
    assert.equal(s.stats.turns, 1);
    assert.equal(s.model, "stub-model");
    assert.deepEqual(tools(events), [["write", "call_mw63lw8r3", true]]);
    assert.equal(events.filter((e) => e.kind === "llm.call").length, 2);
    assert.equal(s.stats.usage?.inputTokens, 240);
  });
});

describe("real install: Pi 1.5.0", () => {
  it("extension events give the turn, model calls, the write and the file", async () => {
    const events = await normalize(piAdapter, "pi/real/extension.spool.jsonl");
    const s = buildSession(events);
    assert.equal(s.id, "01a1b4fa-1a11-7283-b288-2d5c05020dce");
    assert.deepEqual(texts(events, "user.message"), [PROMPT]);
    assert.deepEqual(texts(events, "assistant.message"), [REPLY]);
    assert.deepEqual(tools(events), [["write", "call_mw63p4061", true]]);
    assert.deepEqual(files(events), [["hello.txt", "modify"]]);
    assert.equal(s.model, "stub-model");
    assert.equal(s.stats.latency?.llmCalls, 2);
    assert.equal(s.stats.usage?.outputTokens, 60);
  });
});

describe("real install: GitHub Copilot CLI 1.0.107", () => {
  const SID = "6dfe9f80-9dd6-4735-999d-2c7950f95132";

  it("hooks: one prompt (sessionStart and userPromptSubmitted both carry it), the create and the file", async () => {
    const events = await normalize(copilotCliAdapter, "copilot-cli/real/hooks.spool.jsonl");
    const s = buildSession(events);
    assert.deepEqual(texts(events, "user.message"), [PROMPT]);
    assert.deepEqual(tools(events), [["create", "call_mw63tcbq1", true]]);
    assert.deepEqual(files(events), [["hello.txt", "add"]]);
    assert.equal(s.stats.turns, 1);
  });

  it("events.jsonl: one llm.call per session.usage_record", async () => {
    const file = join(FIXTURES, "copilot-cli", "real", "home", ".copilot", "session-state", SID, "events.jsonl");
    const events = await collect(copilotSessionEvents(file, testCtx().ctx));
    assertWellFormed(events);
    const s = buildSession(events);
    const calls = events.filter((e) => e.kind === "llm.call");
    assert.deepEqual(calls.map((e) => [e.model, e.payload.stopReason, e.durationMs, e.usage?.inputTokens]), [
      ["stub-model", "tool_calls", 43, 120],
      ["stub-model", "stop", 3, 120],
    ]);
    assert.deepEqual(s.stats.usage, { inputTokens: 240, outputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }, "shutdown totals are not added on top");
    assert.deepEqual(texts(events, "assistant.message"), [REPLY]);
    assert.deepEqual(tools(events), [["create", "call_mw63tcbq1", true]]);
  });
});

describe("real install: Factory Droid 1.6.0", () => {
  const SID = "d85436df-cb26-457a-b68e-db3d9efef556";
  const transcript = join(FIXTURES, "droid", "real", "home", ".factory", "sessions", "-work-demo", `${SID}.jsonl`);

  it("hooks without a call id pair through the transcript's tool_use id", async () => {
    const events = await normalize(droidAdapter, "droid/real/hooks.spool.jsonl");
    const s = buildSession(events);
    const starts = events.filter((e) => e.kind === "tool.start").map((e) => e.payload.toolUseId);
    assert.deepEqual(starts, ["call_mw63vlmh1"]);
    assert.deepEqual(tools(events), [["Create", "call_mw63vlmh1", true]]);
    // tool_response is a JSON string: a failure inside it still fails the call.
    const post = loadSpool("droid/real/hooks.spool.jsonl").find((l) => l.event === "PostToolUse")!;
    const failed = await droidAdapter.normalize({ ...post, raw: { ...(post.raw as object), tool_response: JSON.stringify({ success: false, error: "denied" }) } }, testCtx().ctx);
    assert.deepEqual(failed.filter((e) => e.kind === "tool.end").map((e) => [e.payload.ok, e.payload.error]), [[false, "denied"]]);
    assert.deepEqual(files(events), [["hello.txt", "add"]]);
    assert.equal(s.model, "custom:Stub-0");
    assert.equal(s.stats.toolCalls, 1);
  });

  it("transcript: notices, hook bookkeeping and injected reminders are not prompts", async () => {
    const events = await collect(droidSessionEvents(transcript, testCtx().ctx));
    assertWellFormed(events);
    const s = buildSession(events);
    assert.deepEqual(texts(events, "user.message"), [PROMPT]);
    assert.equal(s.stats.turns, 1);
    assert.equal(s.title, PROMPT);
    assert.deepEqual(tools(events), [["Create", "call_mw63vlmh1", true]]);
    assert.equal(s.stats.usage?.inputTokens, 240);
    // Same call id as the hooks: a session seen both ways counts the call once.
    const live = await normalize(droidAdapter, "droid/real/hooks.spool.jsonl");
    assert.equal(buildSession([...live, ...events]).stats.toolCalls, 1);
  });
});

describe("real install: Aider 0.86.2", () => {
  it("`coding.sh run -- aider`: prompt and model come from aider's argv", async () => {
    // Captured before `run` attributed aider by command name, so the line says "wrapper".
    const events = await normalize(aiderAdapter, "wrapper/real/aider.spool.jsonl", { agent: "aider" });
    const s = buildSession(events);
    assert.equal(s.agent, "aider");
    assert.equal(s.model, "openai/stub-model");
    assert.equal(s.title, PROMPT);
    assert.equal(s.stats.turns, 1);
    assert.equal(events.find((e) => e.kind === "session.end")!.payload.exitCode, 0);
  });
});
