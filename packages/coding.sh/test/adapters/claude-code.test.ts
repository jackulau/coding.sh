import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { claudeCode } from "../../src/adapters/claude-code.ts";
import { ClaudeTranscriptConverter } from "../../src/adapters/_shared/claude-transcript.ts";
import { hookPathForCommand } from "../../src/adapters/_shared/hooks.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { backfill, backfillCursorKey } from "../../src/core/ingest.ts";
import { applyPricing, pricesFor } from "../../src/core/pricing.ts";
import { buildSession } from "../../src/core/sessions.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
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

  it("a subagent's live capture has its prompt as a turn and its description as its title", async () => {
    const { ctx } = testCtx();
    const events = [];
    for (const line of loadSpool("claude-code/hooks.spool.jsonl")) events.push(...(await claudeCode.normalize(line, ctx)));
    const child = events.filter((e) => e.sessionId === `${SID}:sub:abc123`);
    assert.equal(child.find((e) => e.kind === "session.start")!.payload.description, "Find callers");
    const prompt = child.find((e) => e.kind === "user.message")!;
    assert.equal(prompt.payload.text, "List files that import sum.js");
    const s = buildSession(child);
    assert.equal(s.title, "Find callers");
    assert.equal(s.stats.turns, 1);
    // No description (older versions, Workflow agents): the prompt's first line.
    const noDesc = child.map((e) => (e.kind === "session.start" ? { ...e, payload: { ...e.payload, description: undefined } } : e));
    const multi = noDesc.map((e) => (e.kind === "user.message" ? { ...e, payload: { text: "Audit the parser\n\nRead src/a.ts and report." } } : e));
    assert.equal(buildSession(multi).title, "Audit the parser");
  });

  it("drops the SubagentStop of Claude Code's internal forks (no agent type, no transcript)", async () => {
    const { ctx } = testCtx();
    const stop = loadSpool("claude-code/hooks.spool.jsonl").find((l) => (l.raw as { hook_event_name?: string }).hook_event_name === "SubagentStop")!;
    const raw = stop.raw as Record<string, unknown>;
    const ghost = { ...stop, raw: { ...raw, agent_id: "f00d", agent_type: "", agent_transcript_path: "/nonexistent/subagents/agent-f00d.jsonl", last_assistant_message: "<analysis>summary</analysis>" } };
    assert.deepEqual(await claudeCode.normalize(ghost, ctx), []);
    // A real subagent whose transcript is gone keeps its end.
    const gone = { ...stop, raw: { ...raw, agent_transcript_path: "/nonexistent/subagents/agent-abc123.jsonl" } };
    assert.deepEqual((await claudeCode.normalize(gone, ctx)).map((e) => e.kind), ["subagent.end", "session.end"]);
  });

  it("a subagent with no SubagentStart/Stop (web-fetch) is linked from the parent's PostToolUse(Agent); a hooked one is stored once", async () => {
    const { ctx } = testCtx();
    const lines = loadSpool("claude-code/hooks.spool.jsonl");
    const start = lines.find((l) => (l.raw as { hook_event_name?: string }).hook_event_name === "SubagentStart")!;
    const base = start.raw as Record<string, unknown>;
    const at = (ts: number, raw: Record<string, unknown>) => ({ ...start, event: raw.hook_event_name as string, ts, raw: { ...base, agent_id: undefined, agent_type: undefined, ...raw } });
    const agentCall = (id: string, agentId: string, type: string, ts: number, extra: Record<string, unknown> = {}) => [
      at(ts - 6000, { hook_event_name: "PreToolUse", tool_name: "Agent", tool_use_id: id, tool_input: { description: "Read docs", prompt: "Read these pages\nand summarize them", subagent_type: type } }),
      at(ts, { hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: id, tool_input: { description: "Read docs", prompt: "Read these pages\nand summarize them", subagent_type: type }, tool_response: { status: "completed", agentId, agentType: type, content: [{ type: "text", text: "Three pages say the same." }], resolvedModel: "claude-haiku-5-5", totalDurationMs: 5000, ...extra } }),
    ];
    const fetch = (ts: number, id: string) => at(ts, { hook_event_name: "PostToolUse", tool_name: "WebFetch", tool_use_id: id, tool_input: { url: "https://example.com" }, tool_response: { code: 200 }, agent_id: "wf9", agent_type: "web-fetch" });
    const [pre, post] = agentCall("toolu_agent_wf9", "wf9", "web-fetch", 1793527300000);
    const events = [];
    for (const l of [pre!, fetch(1793527296000, "toolu_f1"), fetch(1793527298000, "toolu_f2"), post!]) events.push(...(await claudeCode.normalize(l, ctx)));
    const child = events.filter((e) => e.sessionId === `${SID}:sub:wf9`);
    const s = buildSession(child);
    assert.deepEqual([s.parent?.sessionId, s.title, s.stats.turns, s.stats.toolCalls, s.model, s.endedAt !== undefined], [SID, "Read docs", 1, 2, "claude-haiku-5-5", true]);
    const toolStart = events.find((e) => e.kind === "tool.start" && e.payload.toolUseId === "toolu_agent_wf9")!;
    const sub = events.filter((e) => e.sessionId === SID && e.kind.startsWith("subagent."));
    assert.deepEqual(sub.map((e) => [e.kind, e.parentId === toolStart.id, e.payload.result]), [["subagent.start", true, undefined], ["subagent.end", true, "Three pages say the same."]]);
    assert.equal(sub[0]!.ts, 1793527295000);
    // A background agent returns at once: no end yet.
    const [, launched] = agentCall("toolu_agent_bg", "bg1", "general-purpose", 1793527400000, { status: "async_launched" });
    assert.deepEqual((await claudeCode.normalize(launched!, ctx)).map((e) => e.kind), ["tool.end", "subagent.start", "session.start", "user.message"]);
    // abc123 fires SubagentStart and SubagentStop: its PostToolUse(Agent) adds no second event.
    const hooked: AgentEvent[] = [];
    for (const l of [...lines, agentCall("toolu_agent_abc", "abc123", "Explore", 1793527209000)[1]!]) hooked.push(...(await claudeCode.normalize(l, ctx)));
    const once = (kind: string, sid: string) => new Set(hooked.filter((e) => e.kind === kind && e.sessionId === sid).map((e) => e.id)).size;
    assert.deepEqual([once("subagent.start", SID), once("subagent.end", SID), once("session.start", `${SID}:sub:abc123`), once("session.end", `${SID}:sub:abc123`), once("user.message", `${SID}:sub:abc123`)], [1, 1, 1, 1, 1]);
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
    // A subagent's prompt, read from its transcript on both paths.
    const prompt = live.find((e) => e.kind === "user.message" && e.subagentId === "abc123")!;
    assert.ok(prompt && ids.has(prompt.id), "subagent prompt not deduped");
  });

  it("keeps Claude Code's reported cost (cost-state) on the session.end, and the local price is within 2% of it", async () => {
    // The real capture (scripts/e2e/claude-transcript-capture.mjs) ends with a cost-state line.
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = join(FIXTURES, "claude-code", "real", "config");
    try {
      const { ctx } = testCtx();
      const events = await collect(claudeCode.backfill!(ctx));
      const end = events.find((e) => e.kind === "session.end")!;
      assert.deepEqual(end.payload.reportedUsage, { costUsd: 0.26932500000000004, apiDurationMs: 326, costUsdByModel: { "claude-sonnet-4-5": 0.26932500000000004 } });
      assert.equal(end.usage, undefined, "a reported total is never summed into usage");
      const priced = applyPricing(events, pricesFor());
      const session = buildSession(priced);
      const reported = (end.payload.reportedUsage as { costUsd: number }).costUsd;
      assert.ok(Math.abs(session.stats.usage!.costUsd! - reported) / reported < 0.02, `computed ${session.stats.usage?.costUsd} vs reported ${reported}`);
    } finally {
      process.env.CLAUDE_CONFIG_DIR = prev;
    }
    // The synthetic fixtures have no cost-state: no reportedUsage.
    const { ctx } = testCtx();
    const plain = await collect(claudeCode.backfill!(ctx));
    assert.ok(plain.filter((e) => e.kind === "session.end").every((e) => e.payload.reportedUsage === undefined));
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

describe("claude-code harness loads and Bash edits", () => {
  const TS = "2026-11-07T20:48:10.000Z";
  const att = (uuid: string, attachment: Record<string, unknown>, more: Record<string, unknown> = {}) => ({ type: "attachment", uuid, timestamp: TS, sessionId: "cc-h", cwd: "/w", attachment, ...more });
  const convert = async (lines: Record<string, unknown>[], mode: "full" | "assistant" = "full", sidechain = false) => {
    const { ctx } = testCtx();
    const conv = new ClaudeTranscriptConverter(ctx, { agent: "claude-code", mode, sessionId: "cc-h", source: "cc-h.jsonl", ...(sidechain ? { sidechain: true } : {}) });
    for (const [i, l] of lines.entries()) await conv.add(l, i + 1);
    const events = await conv.finish();
    assertWellFormed(events);
    return events;
  };
  const loads = (events: { kind: string; payload: Record<string, unknown> }[]) => events.filter((e) => e.kind === "notification" && e.payload.kind === "harness.loaded").map((e) => e.payload);
  const lines = [
    att("a1", { type: "nested_memory", path: "/w/sub/CLAUDE.md", displayPath: "sub/CLAUDE.md", content: { path: "/w/sub/CLAUDE.md", type: "Project", content: "SECRET-RULE text" } }),
    att("a2", { type: "dynamic_skill", skillDir: "/w/sub/.claude/skills", skillNames: ["subskill"], displayPath: "sub/.claude/skills" }),
    att("a3", { type: "invoked_skills", skills: [{ name: "greet", path: "projectSettings:greet", content: "Run hi.js" }, { name: "eve", path: "plugin:vercel:eve", content: "x" }] }),
    att("a4", { type: "date", date: "2026-11-07" }),
    att("a5", { type: "environment", cwd: "/w" }),
  ];

  it("nested CLAUDE.md, a listed skills dir and restored skills become harness.loaded, without their text", async () => {
    const events = await convert(lines);
    assert.deepEqual(loads(events), [
      { kind: "harness.loaded", loadedBy: "nested_memory", paths: ["/w/sub/CLAUDE.md"], memoryType: "Project" },
      { kind: "harness.loaded", loadedBy: "dynamic_skill", dir: "/w/sub/.claude/skills", skills: ["subskill"] },
      { kind: "harness.loaded", loadedBy: "invoked_skills", skills: ["greet", "eve"], sources: ["projectSettings:greet", "plugin:vercel:eve"] },
    ]);
    assert.ok(!JSON.stringify(events).includes("SECRET-RULE"), "memory content is not copied");
    assert.equal(events.filter((e) => e.kind === "notification").length, 3, "date and environment attachments give nothing");
  });

  it("live windows read them too, keyed so a re-read or a backfill dedupes", async () => {
    const full = await convert(lines);
    const live = await convert(lines, "assistant");
    assert.deepEqual(
      loads(live).map((p) => p.loadedBy),
      ["nested_memory", "dynamic_skill", "invoked_skills"],
    );
    const ids = (es: typeof full) => es.filter((e) => e.payload.kind === "harness.loaded").map((e) => e.id);
    assert.deepEqual(ids(live), ids(full));
  });

  it("subagent attachments stay out unless sidechains are read; long lists are cut to fit", async () => {
    const side = att("s1", { type: "nested_memory", path: "/w/x/CLAUDE.md", content: { type: "Project" } }, { isSidechain: true });
    assert.equal(loads(await convert([side])).length, 0);
    assert.equal(loads(await convert([side], "full", true)).length, 1);
    const many = att("m1", { type: "invoked_skills", skills: Array.from({ length: 200 }, (_, i) => ({ name: `skill-with-a-long-name-${i}`, path: `projectSettings:skill-with-a-long-name-${i}` })) });
    const [p] = loads(await convert([many]));
    assert.equal(p!.truncated, true);
    assert.ok(JSON.stringify(p).length <= 2048);
  });

  it("a Skill call's loaded skill names its base directory", async () => {
    const events = await convert([
      { type: "user", uuid: "u1", timestamp: TS, message: { role: "user", content: "greet" } },
      { type: "assistant", uuid: "a1", timestamp: TS, message: { id: "m1", role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "tool_use", id: "toolu_s", name: "Skill", input: { skill: "greet" } }], usage: { input_tokens: 5, output_tokens: 2 } } },
      { type: "user", uuid: "u2", timestamp: TS, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_s", content: "Launching skill: greet" }] }, toolUseResult: { success: true, commandName: "greet" } },
      { type: "user", uuid: "u3", timestamp: TS, isMeta: true, sourceToolUseID: "toolu_s", message: { role: "user", content: [{ type: "text", text: "Base directory for this skill: /w/.claude/skills/greet\n\nRun scripts/hi.js." }] } },
    ]);
    assert.deepEqual(loads(events), [{ kind: "harness.loaded", loadedBy: "skill", skills: ["greet"], sources: ["/w/.claude/skills/greet"], toolUseId: "toolu_s" }]);
  });

  it("a Bash call that edited files and then failed still reports the edits", async () => {
    const events = await convert([
      { type: "user", uuid: "u1", timestamp: TS, cwd: "/w", message: { role: "user", content: "go" } },
      { type: "assistant", uuid: "a1", timestamp: TS, cwd: "/w", message: { id: "m1", role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "tool_use", id: "toolu_b", name: "Bash", input: { command: "sed -i s/a/b/ x.txt && false" } }], usage: { input_tokens: 5, output_tokens: 2 } } },
      {
        type: "user",
        uuid: "u2",
        timestamp: TS,
        cwd: "/w",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_b", content: "Exit code 1", is_error: true }] },
        toolUseResult: { stdout: "", stderr: "", bashEditDiff: { files: [{ filePath: "/w/x.txt", hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }] }], moreFiles: 0, changedFiles: ["/w/x.txt"] } },
      },
    ]);
    const end = events.find((e) => e.kind === "tool.end")!;
    assert.equal(end.payload.ok, false);
    assert.deepEqual(
      events.filter((e) => e.kind === "file.change").map((e) => [e.payload.path, e.payload.op, e.payload.additions, e.payload.deletions]),
      [["x.txt", "modify", 1, 1]],
    );
  });
});
