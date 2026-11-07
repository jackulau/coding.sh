import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { geminiCliAdapter, GEMINI_HOOK_EVENTS, replayGeminiChat } from "../../../src/adapters/more/gemini-cli.ts";
import type { TmpEnv } from "../_helpers.ts";
import { assertGolden, assertInstallRoundTrip, assertWellFormed, collect, FIXTURES, HOOK, moreEnv, normalizeFixture, summarize, testCtx, writeFile } from "./_helpers.ts";

describe("gemini-cli normalize", () => {
  it("maps hook payloads to golden events", async () => {
    const events = await normalizeFixture(geminiCliAdapter, "gemini-cli/hooks.spool.jsonl");
    assertWellFormed(events);
    assertGolden("gemini-cli/golden/hooks.golden.json", summarize(events));
    const kinds = new Set(events.map((e) => e.kind));
    for (const k of ["session.start", "user.message", "tool.start", "tool.end", "file.change", "test.result", "llm.call", "assistant.message", "turn.end", "context.compact", "notification", "session.end"]) assert.ok(kinds.has(k as never), `missing ${k}`);
    assert.deepEqual(events.find((e) => e.kind === "file.change")!.payload, { path: "src/math.ts", op: "modify", tool: "replace" });
    const tr = events.find((e) => e.kind === "test.result")!;
    assert.equal(tr.payload.runner, "node");
    assert.equal(tr.payload.passed, 4);
    const failed = events.filter((e) => e.kind === "tool.end" && e.payload.ok === false);
    assert.equal(failed.length, 1);
    assert.equal(failed[0]!.payload.error, "File not found: /work/demo/missing.ts");
    const calls = events.filter((e) => e.kind === "llm.call");
    assert.equal(calls.length, 1, "only the AfterModel chunk with a finishReason becomes an llm.call");
    assert.deepEqual(calls[0]!.usage, { inputTokens: 1200, outputTokens: 80, cacheReadTokens: 600 });
    assert.equal(calls[0]!.model, "gemini-2.5-pro");
  });

  it("is deterministic and keeps the raw payload as blobs[0]", async () => {
    const a = await normalizeFixture(geminiCliAdapter, "gemini-cli/hooks.spool.jsonl");
    const b = await normalizeFixture(geminiCliAdapter, "gemini-cli/hooks.spool.jsonl");
    assert.deepEqual(a, b);
    assert.ok(a[0]!.blobs?.[0]);
  });
});

describe("gemini-cli chats", () => {
  it("replays upserts, $set and $patch; keeps rewound messages", () => {
    const { meta, messages } = replayGeminiChat([
      { sessionId: "s" },
      { id: "a", type: "gemini", content: "v1", toolCalls: [{ id: "t", status: "executing" }] },
      { id: "a", type: "gemini", content: "v2", toolCalls: [{ id: "t", status: "success" }] },
      { $patch: { id: "a", toolCalls: [{ id: "t", result: "R" }] } },
      { $set: { summary: "S" } },
      { $rewindTo: "a" },
    ]);
    assert.equal(meta.summary, "S");
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.content, "v2");
    assert.deepEqual(messages[0]!.toolCalls, [{ id: "t", status: "success", result: "R" }]);
  });

  let env: TmpEnv;
  before(() => {
    env = moreEnv();
    process.env.GEMINI_CLI_HOME = join(FIXTURES, "gemini-cli", "home");
  });
  after(() => env.restore());

  it("backfills main, subagent and legacy chats to golden events", async () => {
    const { ctx } = testCtx();
    const events = await collect(geminiCliAdapter.backfill!(ctx));
    assertWellFormed(events);
    assertGolden("gemini-cli/golden/backfill.golden.json", summarize(events));
    const main = events.filter((e) => e.sessionId === "gem-sess-1");
    assert.ok(main.every((e) => e.cwd === "/work/demo"), "cwd from .project_root");
    assert.equal(main.filter((e) => e.kind === "llm.call").length, 3);
    assert.ok(events.filter((e) => e.sessionId === "gem-legacy-1").every((e) => e.cwd === "/work/legacy"), "cwd from projects.json");
    const sub = events.find((e) => e.sessionId === "gem-sub-1" && e.kind === "session.start")!;
    assert.equal(sub.payload.parentSessionId, "gem-sess-1");
    assert.equal(sub.payload.subagentId, "gem-sub-1");
    const mirror = main.filter((e) => e.kind.startsWith("subagent."));
    assert.deepEqual(mirror.map((e) => [e.kind, e.payload.childSessionId, e.subagentId]), [["subagent.start", "gem-sub-1", "gem-sub-1"], ["subagent.end", "gem-sub-1", "gem-sub-1"]]);
    assert.equal(mirror[1]!.durationMs, 200);
    // m2 is written twice: one llm.call, with the last version's tokens (output + thoughts).
    const m2 = main.filter((e) => e.kind === "llm.call" && e.ts === Date.parse("2026-09-21T10:00:02.000Z"));
    assert.equal(m2.length, 1);
    assert.deepEqual(m2[0]!.usage, { inputTokens: 1000, outputTokens: 60, cacheReadTokens: 200 });
    // The $patch result reaches the tool.end (and its test summary).
    const tr = main.find((e) => e.kind === "test.result")!;
    assert.deepEqual([tr.payload.passed, tr.payload.failed], [3, 1]);
    assert.equal(main.filter((e) => e.kind === "turn.end").length, 2);
    const since = await collect(geminiCliAdapter.backfill!(ctx, { since: Date.parse("2026-09-21T10:01:00.000Z") }));
    assert.ok(since.length > 0 && since.every((e) => e.ts >= Date.parse("2026-09-21T10:01:00.000Z")));
  });
});

describe("gemini-cli install", () => {
  let env: TmpEnv;
  before(() => {
    env = moreEnv();
  });
  after(() => env.restore());

  it("round-trips a fresh settings.json", async () => {
    const { installed } = await assertInstallRoundTrip(geminiCliAdapter, env.root);
    const s = JSON.parse(installed[".gemini/settings.json"]!);
    assert.deepEqual(Object.keys(s.hooks), [...GEMINI_HOOK_EVENTS]);
    assert.deepEqual(s.hooks.AfterTool, [{ matcher: "*", hooks: [{ type: "command", name: "coding-sh", command: `node "${HOOK}" gemini-cli AfterTool`, timeout: 5000 }] }]);
    assert.equal(s.hooks.SessionStart[0].matcher, undefined);
    assert.ok(!existsSync(join(env.home, ".gemini", "settings.json")));
  });

  it("keeps the user's settings and hooks", async () => {
    const path = join(env.home, ".gemini", "settings.json");
    const user = { theme: "dark", security: { auth: { selectedType: "oauth-personal" } }, hooks: { BeforeTool: [{ matcher: "run_shell_command", hooks: [{ type: "command", command: "./guard.sh" }] }] } };
    writeFile(path, `${JSON.stringify(user, null, 2)}\n`);
    await assertInstallRoundTrip(geminiCliAdapter, env.root);
    await geminiCliAdapter.install({ hookCommand: HOOK, scope: "user", dryRun: false });
    const s = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(s.theme, "dark");
    assert.equal(s.hooks.BeforeTool.length, 2);
    assert.equal(s.hooks.BeforeTool[0].hooks[0].command, "./guard.sh");
    assert.equal((await geminiCliAdapter.detect()).hooked, true);
    await geminiCliAdapter.uninstall({ scope: "user", dryRun: false });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), user);
  });

  it("refuses to clobber unparseable settings", async () => {
    const path = join(env.home, ".gemini", "settings.json");
    writeFile(path, "{ not json");
    await assert.rejects(geminiCliAdapter.install({ hookCommand: HOOK, scope: "user", dryRun: false }));
    assert.equal(readFileSync(path, "utf8"), "{ not json");
  });

  it("installs project hooks under .gemini/settings.json", async () => {
    const project = join(env.root, "proj");
    writeFile(join(project, "README.md"), "x");
    const changes = await geminiCliAdapter.install({ hookCommand: HOOK, scope: "project", projectDir: project, dryRun: false });
    assert.deepEqual(changes.map((c) => c.path), [join(project, ".gemini", "settings.json")]);
  });
});

describe("gemini-cli overlay", () => {
  let env: TmpEnv;
  before(() => {
    env = moreEnv();
  });
  after(() => env.restore());

  it("isolates GEMINI_CLI_HOME and carries over only auth", async () => {
    writeFile(join(env.home, ".gemini", "oauth_creds.json"), '{"token":"t"}');
    writeFile(join(env.home, ".gemini", "settings.json"), JSON.stringify({ security: { auth: { selectedType: "oauth-personal" } }, hooks: { X: [] }, mcpServers: { a: {} } }));
    const runDir = join(env.root, "run1");
    const o = await geminiCliAdapter.overlay!({ files: {}, flags: [] } as never, runDir);
    assert.equal(o.env.GEMINI_CLI_HOME, join(runDir, "home"));
    assert.equal(readFileSync(join(runDir, "home", ".gemini", "oauth_creds.json"), "utf8"), '{"token":"t"}');
    assert.deepEqual(JSON.parse(readFileSync(join(runDir, "home", ".gemini", "settings.json"), "utf8")), { security: { auth: { selectedType: "oauth-personal" } } });
  });
});
