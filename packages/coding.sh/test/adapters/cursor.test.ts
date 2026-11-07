import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { CURSOR_HOOK_EVENTS, cursor, cursorVersionHasHooks } from "../../src/adapters/cursor.ts";
import { claudeCode } from "../../src/adapters/claude-code.ts";
import { PROBE_TIMEOUT_MS } from "../../src/adapters/_shared/detect.ts";
import { assertGolden, assertWellFormed, collect, FIXTURES, loadSpool, summarize, testCtx, tmpEnv, writeFile, type TmpEnv } from "./_helpers.ts";

const CID = "c0ffee00-1111-4222-8333-444455556666";

describe("cursor normalize", () => {
  it("maps hook payloads to golden events", async () => {
    const { ctx } = testCtx();
    const events = [];
    for (const line of loadSpool("cursor/hooks.spool.jsonl")) events.push(...(await cursor.normalize(line, ctx)));
    assertWellFormed(events);
    assertGolden("cursor/golden/hooks.golden.json", summarize(events));

    assert.ok(events.every((e) => e.cwd === "/work/demo"), "cwd from workspace_roots, not the hook's ~/.cursor cwd");
    const start = events.find((e) => e.kind === "tool.start" && e.payload.toolUseId === "call_s1")!;
    assert.equal(start.ts, 1793527200000 + 9000 - 3500, "tool.start reconstructed from postToolUse duration");
    const test = events.find((e) => e.kind === "test.result")!;
    assert.deepEqual([test.payload.runner, test.payload.passed, test.payload.failed, test.payload.skipped], ["jest", 7, 1, 1]);
    const edit = events.find((e) => e.kind === "file.change" && e.payload.op === "modify")!;
    assert.deepEqual([edit.payload.path, edit.payload.additions, edit.payload.deletions], ["src/b.js", 2, 1]);
    assert.ok(events.some((e) => e.kind === "file.change" && e.payload.op === "delete" && e.payload.path === "tmp.txt"));
    const sub = events.find((e) => e.kind === "session.start" && e.sessionId === "sub-9999")!;
    assert.deepEqual([sub.payload.parentSessionId, sub.payload.subagentId, sub.payload.subagentType], [CID, "sub-9999", "explore"]);
    assert.equal(sub.payload.parentEventId, events.find((e) => e.kind === "subagent.start")!.id);
  });

  it("the same event fired as a Claude-format hook is dropped by claude-code (dedupe)", async () => {
    const line = loadSpool("cursor/hooks.spool.jsonl")[4]!;
    const asClaude = { ...line, agent: "claude-code", event: "PostToolUse", raw: { ...(line.raw as object), session_id: CID, hook_event_name: "PostToolUse" } };
    assert.deepEqual(await claudeCode.normalize(asClaude, testCtx().ctx), []);
  });

  it("parses CLI date versions for hook support", () => {
    assert.equal(cursorVersionHasHooks("2025.09.18-7ae6800"), false);
    assert.equal(cursorVersionHasHooks("2026.08.11-abc"), true);
    assert.equal(cursorVersionHasHooks("garbage"), undefined);
  });
});

describe("cursor install", () => {
  let env: TmpEnv;
  before(() => (env = tmpEnv()));
  after(() => env.restore());
  const hookCommand = () => join(env.dataHome, "bin", "hook.mjs");
  const file = () => join(env.home, ".cursor", "hooks.json");

  it("never registers permission-gating events (they block on empty stdout)", () => {
    const strict = ["preToolUse", "subagentStart", "beforeShellExecution", "beforeMCPExecution", "beforeReadFile"];
    assert.ok(CURSOR_HOOK_EVENTS.every((e) => !strict.includes(e.event)));
    assert.deepEqual(CURSOR_HOOK_EVENTS.find((e) => e.event === "beforeSubmitPrompt")!.extraArgs, ["--echo-continue"]);
  });

  it("dry run, merge, idempotency, uninstall round-trip", async () => {
    assert.equal((await cursor.install({ hookCommand: hookCommand(), scope: "user", dryRun: true })).length, 1);
    assert.ok(!existsSync(file()));

    const original = JSON.stringify({ version: 1, hooks: { afterFileEdit: [{ command: "./hooks/format.sh" }], beforeShellExecution: [{ command: "./hooks/guard.sh" }] } }, null, 2) + "\n";
    writeFile(file(), original);
    const c = await cursor.install({ hookCommand: hookCommand(), scope: "user", dryRun: false });
    assert.equal(c[0]!.action, "modify");
    const cfg = JSON.parse(readFileSync(file(), "utf8"));
    assert.equal(cfg.hooks.afterFileEdit[0].command, "./hooks/format.sh");
    assert.equal(cfg.hooks.afterFileEdit[1].command, `node "${hookCommand()}" cursor afterFileEdit`);
    assert.equal(cfg.hooks.afterFileEdit[1]._codingsh, undefined, "no unknown keys in Cursor entries");
    assert.equal(cfg.hooks.beforeSubmitPrompt[0].command, `node "${hookCommand()}" cursor beforeSubmitPrompt --echo-continue`);
    assert.equal((await cursor.detect()).hooked, true);
    assert.deepEqual(await cursor.install({ hookCommand: hookCommand(), scope: "user", dryRun: false }), []);

    await cursor.uninstall({ scope: "user", dryRun: false });
    assert.deepEqual(JSON.parse(readFileSync(file(), "utf8")), JSON.parse(original));
  });

  it("deletes a hooks.json that only held our entries", async () => {
    const proj = join(env.root, "p");
    await cursor.install({ hookCommand: hookCommand(), scope: "project", projectDir: proj, dryRun: false });
    assert.equal(JSON.parse(readFileSync(join(proj, ".cursor", "hooks.json"), "utf8")).version, 1);
    const u = await cursor.uninstall({ scope: "project", projectDir: proj, dryRun: false });
    assert.equal(u[0]!.action, "delete");
  });
});

describe("cursor detect", () => {
  let env: TmpEnv;
  before(() => (env = tmpEnv()));
  after(() => env.restore());

  // Regression: on a loaded machine `cursor-agent --version` outran the probe
  // budget, the probe came back empty, and init skipped an installed Cursor.
  it("keeps cursor-agent when its version probe yields nothing, but not a generic `agent`", async () => {
    const bin = join(env.root, "bin");
    writeFile(join(bin, "agent"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(bin, "agent"), 0o755);
    process.env.PATH = bin;
    assert.equal((await cursor.detect()).installed, false, "an unknown `agent` binary is not Cursor");
    writeFile(join(bin, "cursor-agent"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(bin, "cursor-agent"), 0o755);
    const r = await cursor.detect();
    assert.equal(r.installed, true);
    assert.equal(r.binary, join(bin, "cursor-agent"));
  });

  it("gives version probes a budget that survives a busy machine", () => {
    assert.ok(PROBE_TIMEOUT_MS >= 15_000);
  });
});

describe("cursor backfill", () => {
  let env: TmpEnv;
  before(() => {
    env = tmpEnv();
    process.env.CURSOR_CONFIG_DIR = join(FIXTURES, "cursor", "config");
  });
  after(() => env.restore());

  it("imports agent-transcripts (no timestamps: order preserved)", async () => {
    const events = await collect(cursor.backfill!(testCtx().ctx));
    assertWellFormed(events);
    assert.deepEqual(
      events.map((e) => [e.kind, e.sessionId, e.payload.text]),
      [
        ["session.start", CID, undefined],
        ["user.message", CID, "Fix the failing test in b.test.js"],
        ["assistant.message", CID, "Looking at src/b.js first."],
        ["assistant.message", CID, "Fixed: b is now 2."],
      ],
    );
    assert.ok(events.every((e, i) => i === 0 || e.ts >= events[i - 1]!.ts));
  });
});
