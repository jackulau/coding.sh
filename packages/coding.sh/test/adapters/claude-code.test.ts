import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { claudeCode } from "../../src/adapters/claude-code.ts";
import { ClaudeTranscriptConverter } from "../../src/adapters/_shared/claude-transcript.ts";
import { hookPathForCommand } from "../../src/adapters/_shared/hooks.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { backfill, backfillCursorKey } from "../../src/core/ingest.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";
import { assertGolden, assertWellFormed, collect, FIXTURES, loadSpool, summarize, testCtx, tmpEnv, writeFile, type TmpEnv } from "./_helpers.ts";

const SID = "11111111-2222-4333-8444-555555555555";

describe("claude-code normalize", () => {
  it("maps hook payloads to golden events", async () => {
    const { ctx } = testCtx();
    const events = [];
    for (const line of loadSpool("claude-code/hooks.spool.jsonl")) events.push(...(await claudeCode.normalize(line, ctx)));
    assertWellFormed(events);
    assertGolden("claude-code/golden/hooks.golden.json", summarize(events));

    const kinds = events.map((e) => e.kind);
    for (const k of ["session.start", "user.message", "tool.start", "tool.end", "file.change", "test.result", "llm.call", "assistant.message", "turn.end", "subagent.start", "subagent.end", "context.compact", "notification", "session.end"]) {
      assert.ok(kinds.includes(k as never), `missing ${k}`);
    }
    const test = events.find((e) => e.kind === "test.result")!;
    assert.deepEqual({ ...test.payload, toolUseId: undefined }, { runner: "vitest", passed: 3, failed: 1, toolUseId: undefined });
    const child = `${SID}:sub:abc123`;
    assert.ok(events.some((e) => e.sessionId === child && e.kind === "tool.start" && e.subagentId === "abc123"), "subagent tool goes to child session");
    const childStart = events.find((e) => e.sessionId === child && e.kind === "session.start")!;
    assert.deepEqual([childStart.payload.parentSessionId, childStart.payload.subagentId, childStart.payload.subagentType], [SID, "abc123", "Explore"]);
    assert.equal(childStart.payload.parentEventId, events.find((e) => e.kind === "subagent.start" && e.sessionId === SID)!.id, "parentEventId → the parent's subagent.start");
    const calls = events.filter((e) => e.kind === "llm.call" && e.sessionId === SID);
    assert.equal(calls.length, 5, "one llm.call per API message in the turn");
    assert.ok(calls.every((c) => c.durationMs !== undefined && c.usage?.outputTokens !== undefined));
  });

  it("drops Claude-format payloads fired by Cursor", async () => {
    const { ctx } = testCtx();
    const foreign = loadSpool("claude-code/hooks.spool.jsonl").at(-1)!;
    assert.deepEqual(await claudeCode.normalize(foreign, ctx), []);
  });

  it("is deterministic (same line → same ids)", async () => {
    const lines = loadSpool("claude-code/hooks.spool.jsonl");
    const a = await claudeCode.normalize(lines[3]!, testCtx().ctx);
    const b = await claudeCode.normalize(lines[3]!, testCtx().ctx);
    assert.deepEqual(a, b);
  });
});

describe("claude-code backfill", () => {
  let env: TmpEnv;
  before(() => {
    env = tmpEnv();
    process.env.CLAUDE_CONFIG_DIR = join(FIXTURES, "claude-code", "config");
  });
  after(() => env.restore());

  it("imports transcripts + subagent transcripts to golden events", async () => {
    const { ctx } = testCtx();
    const events = await collect(claudeCode.backfill!(ctx));
    assertWellFormed(events);
    assertGolden("claude-code/golden/backfill.golden.json", summarize(events));
    const sub = events.find((e) => e.kind === "subagent.start")!;
    assert.equal(sub.sessionId, SID);
    assert.equal(sub.parentId, ctx.id("claude-code", SID, "tool.start", "toolu_04"));
    assert.ok(events.some((e) => e.kind === "context.compact" && e.payload.tokensBefore === 120000));
  });

  it("dedupes with live capture on natural keys (tool calls, llm calls)", async () => {
    const { ctx } = testCtx();
    const live = [];
    for (const line of loadSpool("claude-code/hooks.spool.jsonl")) live.push(...(await claudeCode.normalize(line, ctx)));
    const back = await collect(claudeCode.backfill!(ctx));
    const ids = new Set(back.map((e) => e.id));
    for (const kind of ["tool.start", "tool.end", "llm.call", "subagent.start", "file.change"]) {
      const l = live.filter((e) => e.kind === kind);
      assert.ok(l.length > 0);
      for (const e of l) assert.ok(ids.has(e.id), `${kind} ${JSON.stringify(e.payload).slice(0, 80)} not deduped`);
    }
  });

  it("surfaces failed blob writes instead of dropping transcripts silently", async () => {
    // Small inline limit: the fixture transcripts need blobs.
    const { ctx } = testCtx(16);
    let puts = 0;
    const failing = { ...ctx, blob: async () => { puts++; throw new Error("blob store: SignatureDoesNotMatch"); } };
    await assert.rejects(collect(claudeCode.backfill!(failing)), /SignatureDoesNotMatch/);
    assert.ok(puts > 0);

    // Through core backfill: reported in errors, and no file cursor marks the transcripts as read.
    const index = new MemoryIndexStore();
    const blobs = new MemoryBlobStore();
    blobs.put = async () => { throw new Error("blob store: SignatureDoesNotMatch"); };
    const config = defaultConfig();
    config.capture = { ...config.capture, maxInlineBytes: 16 };
    const r = await backfill({ config, index, blobs, adapters: [claudeCode], env: process.env });
    assert.ok(r.errors.some((e) => /claude-code\.backfill failed: .*SignatureDoesNotMatch/.test(e.message)), JSON.stringify(r.errors));
    assert.equal(r.agents.find((a) => a.agent === "claude-code")?.error?.includes("SignatureDoesNotMatch"), true);
    const transcript = join(FIXTURES, "claude-code", "config", "projects");
    const cursors = await Promise.all(
      readdirSync(transcript, { recursive: true, encoding: "utf8" })
        .filter((p) => p.endsWith(".jsonl"))
        .map((p) => index.getCursor(backfillCursorKey("claude-code", join(transcript, p), "mtime"))),
    );
    assert.ok(cursors.every((c) => c === 0), "a failed file is retried on the next backfill");
  });

  it("honors since", async () => {
    const { ctx } = testCtx();
    const all = await collect(claudeCode.backfill!(ctx));
    const cut = Date.parse("2026-11-01T10:00:25.000Z");
    const some = await collect(claudeCode.backfill!(ctx, { since: cut }));
    assert.ok(some.length > 0 && some.length < all.length);
    assert.ok(some.every((e) => e.ts >= cut));
  });
});

describe("claude-code install", () => {
  let env: TmpEnv;
  before(() => (env = tmpEnv()));
  after(() => env.restore());
  const hookCommand = () => join(env.dataHome, "bin", "hook.mjs");
  const settings = () => join(env.home, ".claude", "settings.json");

  it("dry run writes nothing", async () => {
    const changes = await claudeCode.install({ hookCommand: hookCommand(), scope: "user", dryRun: true });
    assert.equal(changes.length, 1);
    assert.equal(changes[0]!.action, "create");
    assert.ok(!existsSync(settings()));
  });

  it("merges into existing settings, keeps user hooks, backs up, is idempotent, uninstalls cleanly", async () => {
    const original = JSON.stringify(
      {
        model: "opus",
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "~/.claude/hooks/guard.sh" }] }],
          Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
        },
      },
      null,
      4,
    ) + "\n";
    writeFile(settings(), original);

    const c1 = await claudeCode.install({ hookCommand: hookCommand(), scope: "user", dryRun: false });
    assert.equal(c1.length, 1);
    assert.equal(c1[0]!.action, "modify");
    const cfg = JSON.parse(readFileSync(settings(), "utf8"));
    assert.equal(cfg.model, "opus");
    assert.equal(cfg.hooks.PreToolUse[0].hooks[0].command, "~/.claude/hooks/guard.sh", "user hook stays first");
    const ours = cfg.hooks.PreToolUse[1];
    assert.equal(ours.matcher, "*");
    assert.equal(ours.hooks[0]._codingsh, true);
    assert.equal(ours.hooks[0].command, `node "${hookPathForCommand(hookCommand())}" claude-code PreToolUse`);
    assert.ok(readFileSync(settings(), "utf8").startsWith('{\n    "model"'), "indent preserved");
    assert.equal(readdirSync(join(env.dataHome, "backups", "claude-code")).length, 1, "backup written");
    assert.equal((await claudeCode.detect()).hooked, true);

    const c2 = await claudeCode.install({ hookCommand: hookCommand(), scope: "user", dryRun: false });
    assert.deepEqual(c2, [], "second install is a no-op");

    const u = await claudeCode.uninstall({ scope: "user", dryRun: false });
    assert.equal(u.length, 1);
    assert.deepEqual(JSON.parse(readFileSync(settings(), "utf8")), JSON.parse(original));
    assert.deepEqual(await claudeCode.uninstall({ scope: "user", dryRun: false }), []);
    assert.equal((await claudeCode.detect()).hooked, false);
  });

  it("creates and deletes a settings file it fully owns; project scope uses settings.local.json", async () => {
    const proj = join(env.root, "proj");
    const c = await claudeCode.install({ hookCommand: hookCommand(), scope: "project", projectDir: proj, dryRun: false });
    assert.equal(c[0]!.path, join(proj, ".claude", "settings.local.json"));
    const u = await claudeCode.uninstall({ scope: "project", projectDir: proj, dryRun: false });
    assert.equal(u[0]!.action, "delete");
    assert.ok(!existsSync(join(proj, ".claude", "settings.local.json")));
  });

  it("refuses to modify unparseable settings", async () => {
    writeFile(settings(), "{ not json");
    await assert.rejects(claudeCode.install({ hookCommand: hookCommand(), scope: "user", dryRun: false }), /refusing to modify/);
    assert.equal(readFileSync(settings(), "utf8"), "{ not json");
  });
});

describe("claude-code overlay + harness", () => {
  let env: TmpEnv;
  before(() => (env = tmpEnv()));
  after(() => env.restore());

  it("isolates CLAUDE_CONFIG_DIR next to the work dir with our hooks", async () => {
    const work = join(env.root, "runs", "r1", "work");
    const bundle = { id: "b", name: "b", agent: "claude-code", flags: [], env: {}, files: {}, remove: [], createdAt: 0 };
    const o = await claudeCode.overlay!(bundle, work);
    assert.equal(o.env.CLAUDE_CONFIG_DIR, join(env.root, "runs", "r1", "home", ".claude"));
    const s = JSON.parse(readFileSync(join(o.env.CLAUDE_CONFIG_DIR!, "settings.json"), "utf8"));
    assert.ok(s.hooks.PostToolUse[0].hooks[0].command.includes("claude-code PostToolUse"));
    assert.ok(!existsSync(join(env.home, ".claude")), "user config untouched");
    assert.ok(claudeCode.harnessFiles!().project.includes("CLAUDE.md"));
  });
});

// core/pricing.ts callTier reads these to price a call at batch or fast-mode rates.
describe("claude-code transcript service tier", () => {
  const callFor = async (usage: Record<string, unknown>) => {
    const { ctx } = testCtx();
    const conv = new ClaudeTranscriptConverter(ctx, { agent: "claude-code", mode: "assistant", sessionId: "cc-tier", source: "cc-tier.jsonl" });
    await conv.add({ type: "user", uuid: "u1", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "hi" } }, 1);
    await conv.add({ type: "assistant", uuid: "a1", timestamp: "2026-01-01T00:00:02.000Z", message: { id: "msg_tier_1", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "hello" }], usage: { input_tokens: 5, output_tokens: 2, ...usage } } }, 2);
    return (await conv.finish()).find((e) => e.kind === "llm.call")!;
  };

  it("keeps usage.service_tier and usage.speed when they are not standard", async () => {
    const batch = await callFor({ service_tier: "batch" });
    assert.equal(batch.payload.serviceTier, "batch");
    const fast = await callFor({ service_tier: "priority", speed: "fast" });
    assert.deepEqual([fast.payload.serviceTier, fast.payload.speed], ["priority", "fast"]);
  });

  it("leaves standard tiers out of the payload", async () => {
    const c = await callFor({ service_tier: "standard", speed: "standard", inference_geo: "global" });
    assert.ok(!("serviceTier" in c.payload) && !("speed" in c.payload) && !("inferenceGeo" in c.payload));
  });

  it("keeps the 1-hour cache writes and US-only inference for pricing", async () => {
    const c = await callFor({ cache_creation_input_tokens: 300, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 }, inference_geo: "us" });
    assert.equal(c.usage?.cacheWriteTokens, 300);
    assert.deepEqual([c.payload.cacheWrite1hTokens, c.payload.inferenceGeo], [200, "us"]);
    // Only the split: its sum is the total.
    const split = await callFor({ cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 0 } });
    assert.equal(split.usage?.cacheWriteTokens, 40);
    assert.ok(!("cacheWrite1hTokens" in split.payload));
  });
});
