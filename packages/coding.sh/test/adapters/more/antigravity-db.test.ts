// Antigravity CLI history import with the per-conversation SQLite DB: model, tokens, tool failures
// and workspace come from protobuf blobs the transcript leaves out. The transcripts are fixtures
// shaped like agy 1.5.2's (string tool args, a failed tool step left out of the transcript, a
// RUNNING result, a failed model call, a call still waiting at the end); the DB is built here with
// the real table layout and synthetic protobufs.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { agyTranscriptFiles, agyUserText, antigravityAdapter, pbFields, readAgyConversation } from "../../../src/adapters/more/antigravity.ts";
import type { BackfillFile } from "../../../src/core/types.ts";
import { buildSession } from "../../../src/core/sessions.ts";
import type { AgentEvent } from "../../../src/schema/index.ts";
import type { TmpEnv } from "../_helpers.ts";
import { assertGolden, assertWellFormed, collect, FIXTURES, moreEnv, summarize, testCtx } from "./_helpers.ts";

// ---- a minimal protobuf encoder (varint + length-delimited fields only)
const varint = (n: number): number[] => {
  const out: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
};
const vField = (f: number, v: number): number[] => [...varint(f * 8), ...varint(v)];
const bField = (f: number, b: number[] | string): number[] => {
  const bytes = typeof b === "string" ? [...Buffer.from(b)] : b;
  return [...varint(f * 8 + 2), ...varint(bytes.length), ...bytes];
};
const duration = (ms: number): number[] => [...vField(1, Math.floor(ms / 1000)), ...vField(2, (ms % 1000) * 1e6)];

/** CortexStepGeneratorMetadata for one model call. */
function generation(o: { steps: number[]; model: string; provider: number; input: number; output: number; thinking?: number; cacheRead?: number; ttftMs: number; streamMs: number }): Uint8Array {
  const usage = [...vField(1, 1320), ...vField(2, o.input), ...vField(3, o.output), ...(o.cacheRead !== undefined ? vField(5, o.cacheRead) : []), ...vField(6, o.provider), ...bField(7, "msg-1"), ...(o.thinking !== undefined ? vField(9, o.thinking) : []), ...vField(10, o.output - (o.thinking ?? 0))];
  const kv = (k: string, v: string) => bField(20, [...bField(1, k), ...bField(2, v)]);
  const chat = [...vField(3, 1320), ...bField(4, usage), ...bField(11, duration(o.ttftMs)), ...bField(12, duration(o.streamMs)), ...bField(19, o.model), ...kv("model_enum", "MODEL_PLACEHOLDER_M320"), ...kv("last_step_index", String(o.steps[0]! - 1))];
  return Uint8Array.from([...bField(2, o.steps.flatMap(varint)), ...bField(1, chat), ...bField(4, "exec-1")]);
}

// The real table layout (agy 1.5.2), trimmed to the tables coding.sh reads plus one it ignores.
const DDL = [
  "CREATE TABLE `trajectory_meta` (`trajectory_id` text,`cascade_id` text,`trajectory_type` integer,`source` integer,PRIMARY KEY (`trajectory_id`))",
  "CREATE TABLE `steps` (`idx` integer,`step_type` integer NOT NULL DEFAULT 0,`status` integer NOT NULL DEFAULT 0,`has_subtrajectory` numeric NOT NULL DEFAULT false,`metadata` blob,`error_details` blob,`permissions` blob,`task_details` blob,`render_info` blob,`step_payload` blob,`step_format` integer NOT NULL DEFAULT 0,PRIMARY KEY (`idx`))",
  "CREATE TABLE `gen_metadata` (`idx` integer,`data` blob,`size` integer NOT NULL DEFAULT 0,PRIMARY KEY (`idx`))",
  "CREATE TABLE `executor_metadata` (`idx` integer,`data` blob,PRIMARY KEY (`idx`))",
];
// step_type per step: 14 USER_INPUT, 15 PLANNER_RESPONSE, 132 GENERIC, 17 ERROR_MESSAGE.
const STEP_TYPES = [14, 15, 132, 15, 132, 15, 132, 15, 132, 15, 132, 15, 14, 17, 14, 15];

function writeConversationDb(path: string): void {
  const db = new DatabaseSync(path);
  for (const sql of DDL) db.exec(sql);
  const step = db.prepare("INSERT INTO steps (idx, step_type, status, error_details) VALUES (?, ?, ?, ?)");
  // Step 2 (the failing `npm test`) is CORTEX_STEP_STATUS_ERROR with a short error text; step 10 is RUNNING.
  STEP_TYPES.forEach((t, i) => step.run(i, t, i === 2 ? 7 : i === 10 ? 2 : 3, i === 2 ? Uint8Array.from([...bField(2, "exit status 1"), ...bField(3, "exit status 1 (full)")]) : null));
  const gen = db.prepare("INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)");
  const gens = [
    generation({ steps: [1, 2], model: "gemini-3.8-flash", provider: 24, input: 1200, output: 300, thinking: 100, cacheRead: 8000, ttftMs: 1500, streamMs: 500 }),
    generation({ steps: [3, 4], model: "gemini-3.8-flash", provider: 24, input: 400, output: 20, ttftMs: 900, streamMs: 100 }),
    generation({ steps: [5, 6], model: "gemini-3.8-flash", provider: 24, input: 500, output: 80, cacheRead: 9000, ttftMs: 1000, streamMs: 250 }),
    generation({ steps: [7, 8], model: "gemini-3.8-flash", provider: 24, input: 200, output: 10, ttftMs: 600, streamMs: 50 }),
    generation({ steps: [9, 10], model: "gemini-3.8-flash", provider: 24, input: 300, output: 40, ttftMs: 700, streamMs: 50 }),
    generation({ steps: [11], model: "claude-opus-4-6-thinking", provider: 26, input: 100, output: 30, ttftMs: 2000, streamMs: 300 }),
    generation({ steps: [13], model: "gemini-3.8-flash", provider: 24, input: 50, output: 0, ttftMs: 400, streamMs: 0 }),
    generation({ steps: [15, 16], model: "gemini-3.8-flash", provider: 24, input: 600, output: 15, ttftMs: 800, streamMs: 40 }),
  ];
  gens.forEach((g, i) => gen.run(i, g, g.length));
  // executor_metadata field 10 → 12: the workspace folder.
  db.prepare("INSERT INTO executor_metadata (idx, data) VALUES (0, ?)").run(Uint8Array.from(bField(10, [...bField(1, "cfg"), ...bField(12, "file:///work/agy")])));
  db.close();
}

const HOME_FIXTURE = join(FIXTURES, "antigravity", "db-home");
const CONV = "agy-conv-2";

describe("antigravity history import with the conversation DB", () => {
  let env: TmpEnv;
  let cli: string;
  let events: AgentEvent[];
  before(async () => {
    env = moreEnv();
    process.env.HOME = env.home;
    cpSync(join(HOME_FIXTURE, ".gemini"), join(env.home, ".gemini"), { recursive: true });
    cli = join(env.home, ".gemini", "antigravity-cli");
    mkdirSync(join(cli, "conversations"), { recursive: true });
    writeConversationDb(join(cli, "conversations", `${CONV}.db`));
    events = await collect(antigravityAdapter.backfill!(testCtx().ctx));
  });
  after(() => env.restore());

  it("imports to golden events", () => {
    assertWellFormed(events);
    assertGolden("antigravity/golden/backfill-db.golden.json", summarize(events));
  });

  it("reads transcript_full.jsonl over the truncated transcript.jsonl", () => {
    assert.deepEqual(agyTranscriptFiles(cli).map((f) => f.split("/").pop()), ["transcript_full.jsonl"]);
    const prompt = events.find((e) => e.kind === "user.message")!;
    assert.equal(prompt.payload.text, "The parser test fails on empty input. Find out why and fix it without changing the public API.");
  });

  it("puts model, tokens and latency on every model call, including a failed one", () => {
    const calls = events.filter((e) => e.kind === "llm.call");
    assert.deepEqual(
      calls.map((e) => [e.model, e.payload.provider, e.payload.ok, e.usage, e.durationMs, e.payload.ttftMs]),
      [
        ["gemini-3.8-flash", "google", true, { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 8000 }, 2000, 1500],
        ["gemini-3.8-flash", "google", true, { inputTokens: 400, outputTokens: 20 }, 1000, 900],
        ["gemini-3.8-flash", "google", true, { inputTokens: 500, outputTokens: 80, cacheReadTokens: 9000 }, 1250, 1000],
        ["gemini-3.8-flash", "google", true, { inputTokens: 200, outputTokens: 10 }, 650, 600],
        ["gemini-3.8-flash", "google", true, { inputTokens: 300, outputTokens: 40 }, 750, 700],
        ["claude-opus-4-6-thinking", "anthropic", true, { inputTokens: 100, outputTokens: 30 }, 2300, 2000],
        ["gemini-3.8-flash", "google", false, { inputTokens: 50, outputTokens: 0 }, 400, 400],
        ["gemini-3.8-flash", "google", true, { inputTokens: 600, outputTokens: 15 }, 840, 800],
      ],
    );
    assert.equal(events.find((e) => e.kind === "error")!.payload.message, "model unavailable, please retry");
  });

  it("pairs each result with its own call and marks failed tools", () => {
    const ends = events.filter((e) => e.kind === "tool.end");
    assert.deepEqual(
      ends.map((e) => [e.payload.tool, e.payload.toolUseId, e.payload.ok, e.payload.error, e.durationMs]),
      [
        // Step 2 is not in the transcript; the DB says it failed. It must not take view_file's result.
        ["run_command", "step-2", false, "exit status 1", 5000],
        ["view_file", "step-4", true, undefined, 1000],
        ["replace_file_content", "step-6", true, undefined, 1000],
        ["run_command", "step-8", true, undefined, 3000],
        // RUNNING: the command went to the background; the model got this result back.
        ["run_command", "step-10", true, undefined, 1000],
      ],
    );
    assert.equal(ends[0]!.model, "gemini-3.8-flash");
    assert.ok(events.some((e) => e.kind === "tool.start" && e.payload.toolUseId === "step-16"), "the call still waiting is a tool.start");
    assert.ok(!ends.some((e) => e.payload.toolUseId === "step-16"));
    assert.deepEqual(events.filter((e) => e.kind === "file.change").map((e) => e.payload.path), ["src/parse.ts"], "relative to the workspace");
    const tr = events.find((e) => e.kind === "test.result")!;
    assert.deepEqual([tr.payload.passed, tr.payload.failed], [2, 0]);
  });

  it("adds the workspace from executor_metadata as cwd", () => {
    assert.ok(events.every((e) => e.cwd === "/work/agy"));
  });

  it("folds into a session with totals a dashboard can measure", () => {
    const s = buildSession(events);
    assert.equal(s.agent, "antigravity");
    assert.equal(s.cwd, "/work/agy");
    assert.equal(s.model, "gemini-3.8-flash");
    assert.deepEqual(s.stats.usage, { inputTokens: 3350, outputTokens: 495, cacheReadTokens: 17000 });
    assert.equal(s.stats.toolCalls, 6);
    assert.equal(s.stats.toolErrors, 1);
  });

  it("keeps event ids when only the truncated transcript exists or the DB is missing", async () => {
    const logs = join(cli, "brain", CONV, ".system_generated", "logs");
    const full = join(env.root, "full.jsonl");
    cpSync(join(logs, "transcript_full.jsonl"), full);
    rmSync(join(logs, "transcript_full.jsonl"));
    const dbPath = join(cli, "conversations", `${CONV}.db`);
    const db = join(env.root, "conv.db");
    cpSync(dbPath, db);
    rmSync(dbPath);
    try {
      const bare = await collect(antigravityAdapter.backfill!(testCtx().ctx));
      // Same ids, so a later import with the DB adds nothing twice. Only what the DB alone knows is
      // new: the failed tool step and the failed model call (pushed after the step's other events).
      const ids = new Set(bare.map((e) => e.id));
      assert.deepEqual(events.filter((e) => !ids.has(e.id)).map((e) => [e.kind, e.payload.ok]), [["tool.end", false], ["llm.call", false]]);
      assert.equal(ids.size, bare.length);
      assert.ok(bare.every((e) => e.usage === undefined && e.cwd === undefined));
      assert.equal(bare.find((e) => e.kind === "user.message")!.payload.text, "The parser test fails on", "the cut closing tag still strips");
    } finally {
      cpSync(full, join(logs, "transcript_full.jsonl"));
      cpSync(db, dbPath);
    }
  });

  it("asks before reading each conversation, sized by its transcript and DB together", async () => {
    const seen: BackfillFile[] = [];
    const skipped = await collect(antigravityAdapter.backfill!(testCtx().ctx, { changed: async (f) => (seen.push(f), false) }));
    assert.deepEqual(skipped, []);
    assert.equal(seen.length, 1);
    assert.match(seen[0]!.path, /agy-conv-2\/\.system_generated\/logs\/transcript_full\.jsonl$/);
    assert.ok(seen[0]!.size > 2000, "transcript + DB bytes");
  });
});

describe("antigravity prompt text", () => {
  it("keeps the request and drops the metadata agy wraps around it", () => {
    const raw = "<USER_REQUEST>\nfix the build\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-10-02T09:00:00Z.\n</ADDITIONAL_METADATA>\n<USER_SETTINGS_CHANGE>\nmode\n</USER_SETTINGS_CHANGE>";
    assert.equal(agyUserText(raw), "fix the build");
    assert.equal(agyUserText("<USER_REQUEST>\nfix the bu"), "fix the bu", "closing tag cut by truncation");
    assert.equal(agyUserText("  plain prompt "), "plain prompt", "older or hook text without tags");
    assert.equal(agyUserText("<USER_REQUEST>\n</USER_REQUEST>"), "");
  });

  it("strips the wrapper from the hook's lastUserInput too", async () => {
    const line = { v: 0, agent: "antigravity", event: "PreInvocation", ts: 1790000001000, pid: 1, cwd: "/w", raw: { conversationId: "c1", invocationNum: 0, lastUserInput: "<USER_REQUEST>\nship it\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nx\n</ADDITIONAL_METADATA>" } };
    const events = await antigravityAdapter.normalize!(line as never, testCtx().ctx);
    assert.deepEqual(events.map((e) => [e.kind, e.payload.text]), [["user.message", "ship it"]]);
  });
});

describe("antigravity conversation DB parsing", () => {
  it("rejects bytes that are not a protobuf message", () => {
    assert.equal(pbFields(Uint8Array.from([0x0a, 0x05, 0x61])), undefined, "length past the end");
    assert.equal(pbFields(Uint8Array.from([0x07])), undefined, "wire type 7");
    assert.deepEqual(pbFields(Uint8Array.from([0x08, 0x96, 0x01])), [{ f: 1, v: 150 }]);
  });

  it("tolerates an empty or foreign DB", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE gen_metadata (idx integer, data blob)");
    db.prepare("INSERT INTO gen_metadata VALUES (0, ?)").run(Uint8Array.from([0xff, 0xff]));
    const conv = readAgyConversation(db);
    assert.equal(conv.generations.size, 0);
    assert.equal(conv.failedSteps.size, 0);
    assert.equal(conv.cwd, undefined);
    db.close();
  });
});
