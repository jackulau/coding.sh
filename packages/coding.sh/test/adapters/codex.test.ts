import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { CODEX_HOOK_EVENTS, codex, codexExecArgs, codexTrustHash, codexUsage, untrustedHooks } from "../../src/adapters/codex.ts";
import { claudeCode } from "../../src/adapters/claude-code.ts";
import { assertGolden, assertWellFormed, collect, FIXTURES, loadSpool, summarize, testCtx, tmpEnv, writeFile, type TmpEnv } from "./_helpers.ts";

const T0 = 1793527200000;
const SID = "0193aaaa-1111-7222-8333-444455556666";
const SUB = "0193bbbb-1111-7222-8333-444455556666";
const OLD = "0193cccc-1111-7222-8333-444455556666";

async function normalizeAll() {
  const { ctx } = testCtx();
  const events = [];
  for (const line of loadSpool("codex/hooks.spool.jsonl")) events.push(...(await codex.normalize(line, ctx)));
  return events;
}

describe("codex normalize (hooks)", () => {
  it("maps hook payloads to golden events", async () => {
    const events = await normalizeAll();
    assertWellFormed(events);
    assertGolden("codex/golden/hooks.golden.json", summarize(events));

    const end = events.find((e) => e.kind === "tool.end" && e.payload.toolUseId === "call_1")!;
    assert.equal(end.durationMs, 3001 - 900, "tool duration from the rollout's function_call timestamp");
    const test = events.find((e) => e.kind === "test.result" && e.payload.toolUseId === "call_1")!;
    assert.deepEqual([test.payload.runner, test.payload.passed, test.payload.failed], ["vitest", 5, 1]);
    const fc = events.find((e) => e.kind === "file.change" && e.payload.toolUseId === "call_2")!;
    assert.deepEqual([fc.payload.path, fc.payload.op, fc.payload.additions, fc.payload.deletions], ["src/math.ts", "modify", 1, 1]);

    // Stop reads the turn's llm calls from the rollout.
    const calls = events.filter((e) => e.kind === "llm.call" && e.sessionId === SID);
    assert.deepEqual(calls.map((c) => c.payload.responseId), ["resp_1", "resp_2", "resp_3"]);
    assert.deepEqual([calls[0]!.ts, calls[0]!.durationMs, calls[0]!.payload.ttftMs], [T0 + 10, 940, 790]);
    assert.deepEqual(calls[0]!.usage, { inputTokens: 1000, cacheReadTokens: 4000, outputTokens: 120 });
    assert.equal(calls[1]!.ts, T0 + 3000, "next call starts at the tool result");

    // Subagent: tool events route to the child thread; parent gets subagent.start/end.
    assert.ok(events.some((e) => e.kind === "tool.start" && e.sessionId === SUB && e.subagentId === SUB && e.payload.toolUseId === "call_s1"));
    const childStart = events.find((e) => e.kind === "session.start" && e.sessionId === SUB)!;
    assert.deepEqual([childStart.payload.parentSessionId, childStart.payload.subagentType], [SID, "explorer"]);
    assert.equal(childStart.payload.parentEventId, events.find((e) => e.kind === "subagent.start")!.id);
    const subEnd = events.find((e) => e.kind === "subagent.end")!;
    assert.deepEqual([subEnd.sessionId, subEnd.payload.childSessionId, subEnd.payload.result], [SID, SUB, "One caller: src/math.ts."]);
    assert.ok(events.some((e) => e.kind === "llm.call" && e.sessionId === SUB && e.model === "gpt-5.5-mini"), "SubagentStop imports the child rollout");
    assert.ok(!events.some((e) => e.sessionId === SUB && e.kind === "user.message" && e.payload.text === "Fix the failing test"), "forked parent history skipped");
  });

  it("Codex-fired Claude-format hooks are dropped by claude-code (turn_id)", async () => {
    const line = loadSpool("codex/hooks.spool.jsonl")[2]!;
    assert.deepEqual(await claudeCode.normalize({ ...line, agent: "claude-code" }, testCtx().ctx), []);
  });
});

describe("codex backfill (rollouts)", () => {
  let env: TmpEnv;
  before(() => {
    env = tmpEnv();
    process.env.CODEX_HOME = join(FIXTURES, "codex", "home");
  });
  after(() => env.restore());

  it("converts both rollout generations and subagent threads", async () => {
    const events = await collect(codex.backfill!(testCtx().ctx));
    assertWellFormed(events);
    assertGolden("codex/golden/backfill.golden.json", summarize(events));

    // Current generation
    const main = events.filter((e) => e.sessionId === SID);
    assert.equal(main.filter((e) => e.kind === "llm.call").length, 3, "token_usage_record wins over token_count");
    assert.equal(main.filter((e) => e.kind === "file.change").length, 1, "apply_patch + FileChange item dedupe");
    const exec = main.find((e) => e.kind === "tool.end" && e.payload.toolUseId === "exec-1")!;
    assert.deepEqual([exec.durationMs, exec.payload.ok], [2000, true]);
    assert.ok(main.some((e) => e.kind === "test.result" && e.payload.toolUseId === "exec-1" && e.payload.passed === 6));
    const mcp = main.find((e) => e.kind === "tool.start" && e.payload.toolUseId === "mcp-1")!;
    assert.deepEqual([mcp.payload.tool, mcp.payload.server], ["mcp__docs__search", "docs"]);
    const turn = main.find((e) => e.kind === "turn.end")!;
    assert.deepEqual([turn.durationMs, turn.payload.ttftMs, turn.turnId], [9200, 790, "turn-0001"]);
    assert.ok(main.some((e) => e.kind === "context.compact"));
    const sub = events.filter((e) => e.kind === "subagent.start" || e.kind === "subagent.end");
    assert.deepEqual(sub.map((e) => [e.kind, e.sessionId, e.payload.childSessionId]), [["subagent.start", SID, SUB], ["subagent.end", SID, SUB]]);

    // Old generation: user_message/agent_message + deduped token_count
    const old = events.filter((e) => e.sessionId === OLD);
    const oldCalls = old.filter((e) => e.kind === "llm.call");
    assert.deepEqual(oldCalls.map((c) => c.usage), [{ inputTokens: 800, cacheReadTokens: 0, outputTokens: 20 }, { inputTokens: 400, cacheReadTokens: 600, outputTokens: 30 }]);
    const pytest = old.find((e) => e.kind === "test.result")!;
    assert.deepEqual([pytest.payload.runner, pytest.payload.passed, pytest.payload.failed], ["pytest", 3, 1]);
    assert.equal(old.find((e) => e.kind === "tool.end")!.payload.ok, false, "exit_code 1 in JSON output");
    assert.deepEqual(old.filter((e) => e.kind === "user.message").map((e) => e.payload.text), ["Run the tests"]);
  });

  it("shares natural keys with live hook events (dedupe)", async () => {
    const backfilled = new Set((await collect(codex.backfill!(testCtx().ctx))).map((e) => e.id));
    const live = await normalizeAll();
    for (const [kind, pred] of [
      ["tool.start", (p: Record<string, unknown>) => p.toolUseId === "call_1"],
      ["tool.end", (p: Record<string, unknown>) => p.toolUseId === "call_2"],
      ["llm.call", (p: Record<string, unknown>) => p.responseId === "resp_2"],
      ["user.message", () => true],
      ["assistant.message", () => true],
      ["turn.end", () => true],
      ["subagent.start", () => true],
      ["subagent.end", () => true],
      ["file.change", () => true],
    ] as const) {
      const e = live.find((x) => x.kind === kind && x.sessionId === SID && pred(x.payload))!;
      assert.ok(e, `live ${kind}`);
      assert.ok(backfilled.has(e.id), `${kind} id matches the backfilled copy`);
    }
  });

  it("honors since", async () => {
    const events = await collect(codex.backfill!(testCtx().ctx, { since: T0 + 5000 }));
    assert.ok(events.length > 0 && events.every((e) => e.ts >= T0 + 5000));
  });
});

describe("codex install", () => {
  let env: TmpEnv;
  before(() => (env = tmpEnv()));
  after(() => env.restore());
  const hookCommand = () => join(env.dataHome, "bin", "hook.mjs");
  const file = () => join(env.home, ".codex", "hooks.json");

  it("dry run, merge after user hooks, idempotency, trust notes, uninstall round-trip", async () => {
    const dry = await codex.install({ hookCommand: hookCommand(), scope: "user", dryRun: true });
    assert.equal(dry.length, 1);
    assert.ok(!existsSync(file()));
    assert.match(dry[0]!.summary, /\/hooks/, "tells the user to approve via /hooks");

    const original = JSON.stringify({ description: "mine", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./guard.sh" }] }] } }, null, 2) + "\n";
    writeFile(file(), original);
    writeFile(join(env.home, ".codex", "config.toml"), `model = "gpt-5.5"\n\n[hooks.state."${file()}:pre_tool_use:0:0"]\ntrusted_hash = "sha256:abc"\n`);
    const configBefore = readFileSync(join(env.home, ".codex", "config.toml"), "utf8");

    const c = await codex.install({ hookCommand: hookCommand(), scope: "user", dryRun: false });
    assert.equal(c[0]!.action, "modify");
    const cfg = JSON.parse(readFileSync(file(), "utf8"));
    assert.deepEqual(Object.keys(cfg), ["description", "hooks"], "no unknown top-level keys (Codex denies them)");
    assert.equal(cfg.hooks.PreToolUse[0].hooks[0].command, "./guard.sh", "user hook keeps index 0 (trust state is positional)");
    const ours = cfg.hooks.PreToolUse[1];
    assert.equal(ours.matcher, undefined, "no matcher = all tools");
    assert.deepEqual(ours.hooks[0], { type: "command", command: `node "${hookCommand()}" codex PreToolUse`, timeout: 10, _codingsh: true });
    assert.equal(cfg.hooks.SessionEnd[0].hooks[0].timeout, 3, "SessionEnd is capped at 3s");
    assert.equal(readFileSync(join(env.home, ".codex", "config.toml"), "utf8"), configBefore, "never writes trust state");

    const d = await codex.detect();
    assert.equal(d.hooked, true);
    assert.ok(d.notes?.some((n) => /not trusted yet/.test(n) && n.includes(String(CODEX_HOOK_EVENTS.length))));
    assert.deepEqual(await codex.install({ hookCommand: hookCommand(), scope: "user", dryRun: false }), []);

    await codex.uninstall({ scope: "user", dryRun: false });
    assert.deepEqual(JSON.parse(readFileSync(file(), "utf8")), JSON.parse(original));
  });

  it("recognizes hooks the user trusted (hash matches Codex's formula)", async () => {
    const f = join(env.root, "t", "hooks.json");
    const handler = { type: "command", command: "node x/.coding.sh/bin/hook.mjs codex Stop", timeout: 10, _codingsh: true };
    writeFile(f, JSON.stringify({ hooks: { Stop: [{ hooks: [handler] }] } }));
    writeFile(join(env.home, ".codex", "config.toml"), `[hooks.state."${f}:stop:0:0"]\ntrusted_hash = "${codexTrustHash("Stop", undefined, handler)}"\n`);
    assert.deepEqual(untrustedHooks(f), []);
    writeFile(join(env.home, ".codex", "config.toml"), "");
    assert.deepEqual(untrustedHooks(f), ["Stop"]);
  });

  // Regression: after `init`, a fresh Codex user's sessions were lost until
  // they approved /hooks; reads now import rollouts while hooks can't fire.
  it("tails rollouts only while installed hooks are untrusted or disabled", async () => {
    const cfgPath = join(env.home, ".codex", "config.toml");
    writeFile(cfgPath, "");
    rmSync(file(), { force: true });
    assert.equal(codex.tailWhenUnhooked!(), false, "not set up: nothing to tail");
    const before = Date.now();
    await codex.install({ hookCommand: hookCommand(), scope: "user", dryRun: false });
    const t = codex.tailWhenUnhooked!();
    assert.ok(t && typeof t.since === "number" && t.since >= before - 1000, "imports from the install time, not all history");

    // Trust every handler the way Codex's /hooks would.
    const cfg = JSON.parse(readFileSync(file(), "utf8")) as { hooks: Record<string, { matcher?: string; hooks: Record<string, unknown>[] }[]> };
    const snake = (e: string) => e.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
    const state = Object.entries(cfg.hooks).flatMap(([event, groups]) =>
      groups.flatMap((g, gi) => g.hooks.map((h, hi) => `[hooks.state."${file()}:${snake(event)}:${gi}:${hi}"]\ntrusted_hash = "${codexTrustHash(event, g.matcher, h)}"\n`)),
    );
    writeFile(cfgPath, state.join("\n"));
    assert.deepEqual(untrustedHooks(file()), []);
    assert.equal(codex.tailWhenUnhooked!(), false, "live hooks capture once trusted");

    writeFile(cfgPath, `${state.join("\n")}\n[features]\nhooks = false\n`);
    assert.ok(codex.tailWhenUnhooked!(), "hooks disabled: tail again");
    await codex.uninstall({ scope: "user", dryRun: false });
  });

  it("project scope writes .codex/hooks.json and deletes it when only ours", async () => {
    const proj = join(env.root, "proj");
    const c = await codex.install({ hookCommand: hookCommand(), scope: "project", projectDir: proj, dryRun: false });
    assert.equal(c[0]!.path, join(proj, ".codex", "hooks.json"));
    assert.match(c[0]!.summary, /project's \.codex\/ layer is trusted/);
    const u = await codex.uninstall({ scope: "project", projectDir: proj, dryRun: false });
    assert.equal(u[0]!.action, "delete");
  });

  it("refuses to modify invalid JSON", async () => {
    writeFile(file(), "{ not json");
    await assert.rejects(codex.install({ hookCommand: hookCommand(), scope: "user", dryRun: false }), /refusing to modify/);
  });
});

describe("codex run/overlay helpers", () => {
  it("exec argv: json, hook-trust bypass, sandbox, stdin instruction, no shell", () => {
    const args = codexExecArgs({ cwd: "/w", model: "gpt-5.5", flags: [] }, "--dangerously-bypass-hook-trust");
    assert.deepEqual(args, ["exec", "--json", "--dangerously-bypass-hook-trust", "-s", "workspace-write", "-m", "gpt-5.5", "-C", "/w", "--skip-git-repo-check", "-"]);
    const custom = codexExecArgs({ cwd: "/w", flags: ["--dangerously-bypass-approvals-and-sandbox", "-m", "o3"] }, "");
    assert.deepEqual(custom, ["exec", "--json", "-C", "/w", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-m", "o3", "-"]);
  });

  it("usage: input excludes cached reads and cache writes", () => {
    assert.deepEqual(codexUsage({ input_tokens: 6000, cached_input_tokens: 5000, cache_write_input_tokens: 200, output_tokens: 80 }), { inputTokens: 800, cacheReadTokens: 5000, cacheWriteTokens: 200, outputTokens: 80 });
  });

  it("overlay isolates CODEX_HOME with our hooks", async () => {
    const env = tmpEnv();
    try {
      writeFile(join(env.home, ".codex", "auth.json"), "{}");
      const runDir = join(env.root, "runs", "r1", "work");
      const o = await codex.overlay!({ files: [] } as never, runDir);
      assert.equal(o.env.CODEX_HOME, join(env.root, "runs", "r1", "home", ".codex"));
      assert.ok(existsSync(join(o.env.CODEX_HOME!, "auth.json")));
      const cfg = JSON.parse(readFileSync(join(o.env.CODEX_HOME!, "hooks.json"), "utf8"));
      assert.equal(Object.keys(cfg.hooks).length, CODEX_HOOK_EVENTS.length);
    } finally {
      env.restore();
    }
  });
});
