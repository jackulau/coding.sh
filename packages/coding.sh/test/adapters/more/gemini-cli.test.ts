import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { geminiChatEvents, geminiCliAdapter, GEMINI_HOOK_EVENTS, replayGeminiChat } from "../../../src/adapters/more/gemini-cli.ts";
import type { TmpEnv } from "../_helpers.ts";
import { assertGolden, assertInstallRoundTrip, assertWellFormed, collect, FIXTURES, HOOK, moreEnv, normalizeFixture, summarize, testCtx, writeFile } from "./_helpers.ts";
import { buildHookCommand } from "../../../src/adapters/_shared/hooks.ts";
import { defaultConfig } from "../../../src/core/config.ts";
import { backfill } from "../../../src/core/ingest.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../../src/store/memory.ts";
import { nodeBin } from "../../_bin.ts";

describe("gemini-cli normalize", () => {
  it("maps hook payloads to golden events", async () => {
    const events = await normalizeFixture(geminiCliAdapter, "gemini-cli/hooks.spool.jsonl");
    assertWellFormed(events);
    assertGolden("gemini-cli/golden/hooks.golden.json", summarize(events));
    const kinds = new Set(events.map((e) => e.kind));
    for (const k of ["session.start", "user.message", "tool.start", "tool.end", "file.change", "test.result", "llm.call", "assistant.message", "turn.end", "context.compact", "notification", "session.end"]) assert.ok(kinds.has(k as never), `missing ${k}`);
    assert.deepEqual(events.find((e) => e.kind === "file.change")!.payload, { path: "src/math.ts", op: "modify", tool: "replace" });
    const tr = events.find((e) => e.kind === "test.result")!;
    assert.equal(tr.payload.runner, "node:test");
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

  it("a second backfill over unchanged chat files reads none and counts no sessions", async () => {
    const cenv = { ...process.env };
    const index = new MemoryIndexStore();
    const run = () => backfill({ config: defaultConfig(cenv), index, blobs: new MemoryBlobStore(), adapters: [geminiCliAdapter], env: cenv });
    const first = await run();
    assert.deepEqual(first.errors, []);
    assert.ok(first.events > 0 && first.sessions > 0);
    const again = await run();
    assert.deepEqual(again.errors, []);
    assert.deepEqual([again.events, again.sessions], [0, 0]);
  });
});

describe("gemini-cli backfill: an output count that reads as missing", () => {
  let env: TmpEnv;
  before(() => {
    env = moreEnv();
  });
  after(() => env.restore());

  it("an output count that is not a whole number from 0 to 2^53 - 1 is left out, so the thought count is still output", async () => {
    // A copy of the fixture home: the last record of the first model message (m2) gets a fractional output count.
    const home = join(env.root, "gemini-home");
    cpSync(join(FIXTURES, "gemini-cli", "home"), home, { recursive: true });
    const file = join(home, ".gemini", "tmp", "demo", "chats", "session-2026-09-21T10-00-gemsess1.jsonl");
    const key = `"output":50,"cached":200,"thoughts":10`;
    const text = readFileSync(file, "utf8");
    assert.equal(text.split(key).length, 2, "one record has these counts");
    writeFile(file, text.split(key).join(`"output":50.5,"cached":200,"thoughts":10`));
    process.env.GEMINI_CLI_HOME = home;
    const { ctx } = testCtx();
    const calls = (await collect(geminiCliAdapter.backfill!(ctx))).filter((e) => e.kind === "llm.call" && e.sessionId === "gem-sess-1");
    assert.deepEqual(calls[0]!.usage, { inputTokens: 1000, outputTokens: 10, cacheReadTokens: 200 });
  });
});

describe("gemini-cli cancelled tool calls", () => {
  it("a cancelled call is an interruption; an error still counts", async () => {
    const { buildSession } = await import("../../../src/core/sessions.ts");
    const dir = mkdtempSync(join(tmpdir(), "gem-cancel-"));
    try {
      const real = readFileSync(join(FIXTURES, "gemini-cli", "paired", "home", ".gemini", "tmp", "demo", "chats", "session-2026-11-07T08-00-b7e2c4a1.jsonl"), "utf8");
      const lines = real.split("\n").map((l) => {
        if (l.includes('"id":"replace-2"')) return l.replace('"status":"success"', '"status":"cancelled"');
        if (l.includes('"id":"run_shell_command-3"')) return l.replace('"status":"success"', '"status":"error"');
        return l;
      });
      const file = join(dir, "chats", "session-cancel.jsonl");
      writeFile(file, lines.join("\n"));
      const { ctx } = testCtx();
      const events = await collect(geminiChatEvents(file, ctx, { cwd: "/work/demo" }));
      assertWellFormed(events);
      const ends = events.filter((e) => e.kind === "tool.end");
      const by = (id: string) => ends.find((e) => e.payload.toolUseId === id)!.payload;
      assert.deepEqual([by("replace-2").ok, by("replace-2").error, by("replace-2").interrupted], [false, "cancelled", true]);
      assert.deepEqual([by("run_shell_command-3").ok, by("run_shell_command-3").interrupted], [false, undefined]);
      assert.equal(by("run_shell_command-1").interrupted, undefined);
      const s = buildSession(events);
      assert.equal(s.stats.interruptedToolCalls, 1);
      assert.equal(s.stats.toolErrors, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("gemini-cli detect", () => {
  let env: TmpEnv;
  before(() => {
    env = moreEnv();
  });
  after(() => env.restore());

  // With no npm package.json beside it, the version comes from `gemini --version`, which a busy
  // machine can hold past 5 s.
  it("waits out a gemini --version that takes over 5 s", { timeout: 30_000 }, async () => {
    const bin = join(env.root, "bin");
    nodeBin(bin, "gemini", 'setTimeout(() => console.log("0.9.0"), 6000);\n');
    process.env.PATH = bin;
    const r = await geminiCliAdapter.detect();
    assert.equal(r.binary, join(bin, process.platform === "win32" ? "gemini.cmd" : "gemini"));
    assert.equal(r.version, "0.9.0");
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
    assert.deepEqual(s.hooks.AfterTool, [{ matcher: "*", hooks: [{ type: "command", name: "coding-sh", command: buildHookCommand(HOOK, "gemini-cli", "AfterTool"), timeout: 5000 }] }]);
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
    const runDir = join(env.root, "run1", "work");
    const home = join(env.root, "run1", "home");
    const o = await geminiCliAdapter.overlay!({ files: {}, flags: [] } as never, runDir);
    assert.equal(o.env.GEMINI_CLI_HOME, home);
    assert.equal(readFileSync(join(home, ".gemini", "oauth_creds.json"), "utf8"), '{"token":"t"}');
    assert.deepEqual(JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf8")), { security: { auth: { selectedType: "oauth-personal" } } });
    assert.equal(existsSync(runDir), false, "nothing is written into the work tree");
  });
});

describe("gemini-cli skill loads", () => {
  it("read_file and shell reads of skill files tag the call and the session; other reads tag nothing", async () => {
    const { buildSession } = await import("../../../src/core/sessions.ts");
    const all = await normalizeFixture(geminiCliAdapter, "gemini-cli/skills.spool.jsonl");
    // BeforeTool and AfterTool both emit the call's tool.start (one id): the store keeps one.
    const events = all.filter((e, i) => all.findIndex((o) => o.id === e.id) === i);
    assertWellFormed(events);
    assertGolden("gemini-cli/golden/skills.golden.json", summarize(events));
    const starts = events.filter((e) => e.kind === "tool.start").map((e) => [e.payload.skill, e.payload.skills]);
    assert.deepEqual(starts, [
      ["pdf", undefined],
      ["pdf", ["pdf", "xlsx"]],
      [undefined, undefined], // README.md
      [undefined, undefined], // a substitution, a `..` path and an rm: no literal skill read
    ]);
    assert.deepEqual(buildSession(events).flags.filter((f) => f.startsWith("skill:")), ["skill:pdf", "skill:xlsx"]);
  });
});
