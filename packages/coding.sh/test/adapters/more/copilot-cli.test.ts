import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { COPILOT_HOOK_EVENTS, copilotCliAdapter } from "../../../src/adapters/more/copilot-cli.ts";
import { installRecord, ownsInstall, sha256 } from "../../../src/adapters/_shared/installs.ts";
import type { TmpEnv } from "../_helpers.ts";
import { assertGolden, assertInstallRoundTrip, assertWellFormed, collect, FIXTURES, HOOK, moreEnv, normalizeFixture, summarize, testCtx, writeFile } from "./_helpers.ts";

describe("copilot-cli normalize", () => {
  it("maps hook payloads (camelCase and snake_case) to golden events", async () => {
    const events = await normalizeFixture(copilotCliAdapter, "copilot-cli/hooks.spool.jsonl");
    assertWellFormed(events);
    assertGolden("copilot-cli/golden/hooks.golden.json", summarize(events));
    const users = events.filter((e) => e.kind === "user.message").map((e) => e.payload.text);
    assert.deepEqual(users, ["Add a README and make the tests pass", "Also keep it short"]);
    const changes = events.filter((e) => e.kind === "file.change").map((e) => [e.payload.path, e.payload.op]);
    assert.deepEqual(changes, [["README.md", "add"], ["src/a.ts", "modify"]]);
    const tr = events.find((e) => e.kind === "test.result")!;
    assert.deepEqual([tr.payload.runner, tr.payload.passed, tr.payload.failed], ["vitest", 4, 1]);
    const fail = events.find((e) => e.kind === "tool.end" && e.payload.tool === "view")!;
    assert.equal(fail.payload.ok, false);
    assert.equal(fail.payload.error, "ENOENT: no such file");
    // subagentStart has no agentId (docs), so both halves key on agentName.
    const subs = events.filter((e) => e.kind.startsWith("subagent."));
    assert.deepEqual(subs.map((e) => [e.kind, e.payload.subagentId, e.payload.type]), [["subagent.start", "explore", "explore"], ["subagent.end", "explore", "explore"]]);
    assert.equal(subs[1]!.payload.agentId, "sub-a1");
    assert.equal(subs[1]!.subagentId, "sub-a1");
    assert.equal(events.find((e) => e.kind === "error")!.payload.message, "rate limited");
  });
});

describe("copilot-cli backfill", () => {
  let env: TmpEnv;
  before(() => {
    env = moreEnv();
    process.env.COPILOT_HOME = join(FIXTURES, "copilot-cli", "home", ".copilot");
  });
  after(() => env.restore());

  it("imports session-state events.jsonl to golden events", async () => {
    const { ctx } = testCtx();
    const events = await collect(copilotCliAdapter.backfill!(ctx));
    assertWellFormed(events);
    assertGolden("copilot-cli/golden/backfill.golden.json", summarize(events));
    const start = events.find((e) => e.kind === "session.start")!;
    assert.deepEqual(start.repo, { root: "/work/demo", head: "0123456789abcdef0123456789abcdef01234567", branch: "main" });
    const end = events.find((e) => e.kind === "session.end")!;
    assert.deepEqual(end.usage, { inputTokens: 3500, outputTokens: 220, cacheReadTokens: 1500, cacheWriteTokens: 100, costUsd: 0.03 });
    assert.equal(events.filter((e) => e.usage).length, 1, "totals live on exactly one event");
    const mcp = events.find((e) => e.kind === "tool.start" && e.payload.toolUseId === "call-3")!;
    assert.equal(mcp.payload.server, "github");
    assert.equal(mcp.subagentId, "sub-a1");
    const subs = events.filter((e) => e.kind.startsWith("subagent."));
    assert.deepEqual(subs.map((e) => [e.kind, e.payload.subagentId, e.payload.type, e.payload.ok]), [["subagent.start", "call-sub", "explore", undefined], ["subagent.end", "call-sub", "explore", true]]);
    assert.equal(subs[1]!.durationMs, 1300);
    assert.equal(subs[1]!.usage, undefined, "child llm.calls carry usage; totalTokens stays in payload");
    const t2 = events.find((e) => e.kind === "tool.end" && e.payload.toolUseId === "call-2")!;
    assert.equal(t2.payload.ok, false);
    assert.equal(t2.durationMs, 2000);
    const tr = events.find((e) => e.kind === "test.result")!;
    assert.deepEqual([tr.payload.runner, tr.payload.passed, tr.payload.failed], ["mocha", 2, 1]);
  });
});

describe("copilot-cli install", () => {
  let env: TmpEnv;
  before(() => {
    env = moreEnv();
  });
  after(() => env.restore());

  it("owns a dedicated hook file and round-trips", async () => {
    writeFile(join(env.home, ".copilot", "hooks", "mine.json"), '{"version":1,"hooks":{}}\n');
    const { installed } = await assertInstallRoundTrip(copilotCliAdapter, env.root);
    const f = JSON.parse(installed[".copilot/hooks/coding-sh.json"]!);
    assert.equal(f.version, 1);
    assert.deepEqual(Object.keys(f.hooks), [...COPILOT_HOOK_EVENTS]);
    assert.ok(!("preToolUse" in f.hooks), "preToolUse fails closed, never installed");
    assert.deepEqual(f.hooks.postToolUse[0], { type: "command", bash: `/bin/sh "${HOOK.replace(/hook\.mjs$/, "hook.sh")}" copilot-cli postToolUse`, powershell: `& node "${HOOK}" copilot-cli postToolUse`, timeoutSec: 10 });
    assert.equal(readFileSync(join(env.home, ".copilot", "hooks", "mine.json"), "utf8"), '{"version":1,"hooks":{}}\n');
  });

  it("honours COPILOT_HOME and refuses a foreign coding-sh.json", async () => {
    const ch = join(env.root, "ch");
    process.env.COPILOT_HOME = ch;
    try {
      writeFile(join(ch, "hooks", "coding-sh.json"), JSON.stringify({ version: 1, hooks: { sessionStart: [{ type: "command", bash: "./mine.sh" }] } }));
      await assert.rejects(copilotCliAdapter.install({ hookCommand: HOOK, scope: "user", dryRun: false }), /refusing/);
      assert.deepEqual(await copilotCliAdapter.uninstall({ scope: "user", dryRun: false }), []);
      assert.ok(existsSync(join(ch, "hooks", "coding-sh.json")));
    } finally {
      delete process.env.COPILOT_HOME;
    }
  });

  it("records ownership in installs.json and leaves a user-edited file alone", async () => {
    const file = join(env.home, ".copilot", "hooks", "coding-sh.json");
    await copilotCliAdapter.install({ hookCommand: HOOK, scope: "user", dryRun: false });
    const written = readFileSync(file, "utf8");
    const rec = installRecord(file);
    assert.equal(rec?.agent, "copilot-cli");
    assert.equal(rec?.sha256, sha256(written));
    assert.equal(ownsInstall(file, written), true);
    assert.equal((await copilotCliAdapter.detect()).hooked, true);

    // The user adds a hook of their own: the file is theirs now.
    const edited = JSON.parse(written) as { hooks: Record<string, unknown[]> };
    edited.hooks.sessionStart!.push({ type: "command", bash: "./mine.sh" });
    writeFile(file, JSON.stringify(edited, null, 2) + "\n");
    assert.equal(ownsInstall(file, readFileSync(file, "utf8")), false);
    assert.deepEqual(await copilotCliAdapter.uninstall({ scope: "user", dryRun: false }), []);
    assert.ok(existsSync(file));
    await assert.rejects(copilotCliAdapter.install({ hookCommand: HOOK, scope: "user", dryRun: false }), /refusing/);

    // Restored to what we wrote: ours again, removed, and the record dropped.
    writeFile(file, written);
    const removed = await copilotCliAdapter.uninstall({ scope: "user", dryRun: false });
    assert.deepEqual(removed.map((c) => c.action), ["delete"]);
    assert.equal(existsSync(file), false);
    assert.equal(installRecord(file), undefined);
  });

  it("dry runs never write installs.json", async () => {
    await copilotCliAdapter.install({ hookCommand: HOOK, scope: "user", dryRun: true });
    assert.equal(installRecord(join(env.home, ".copilot", "hooks", "coding-sh.json")), undefined);
  });

  it("installs repo hooks under .github/hooks", async () => {
    const project = join(env.root, "proj");
    writeFile(join(project, "x"), "");
    await assertInstallRoundTrip(copilotCliAdapter, env.root, { scope: "project", projectDir: project });
  });
});

describe("copilot-cli traceparent (real capture, Copilot CLI 1.0.107 with OTel on)", () => {
  // scripts/e2e/copilot-otel-capture.mjs: hook stdin carries the agent's W3C traceparent.
  const SID = "30b31f8e-efe1-43bd-b49c-ea31a3a8d520";
  const TRACE = "52d64d522262bb7dfe0a8873681dae65";
  const SPAN = "0a20f5b72c7e2990"; // Copilot's invoke_agent span
  const otlp = (n: string) => JSON.parse(readFileSync(join(FIXTURES, "copilot-cli", "otel", "otlp", `${n}-traces.json`), "utf8"));

  it("hook events carry the trace and the caller span; ids match a line without a traceparent", async () => {
    // preToolUse and postToolUse both emit the call's tool.start (one id): the store keeps one.
    const all = await normalizeFixture(copilotCliAdapter, "copilot-cli/otel/hooks.spool.jsonl");
    const events = all.filter((e, i) => all.findIndex((o) => o.id === e.id) === i);
    assertWellFormed(events);
    assertGolden("copilot-cli/golden/otel.golden.json", summarize(events));
    assert.ok(events.every((e) => e.sessionId === SID));
    const traced = events.filter((e) => e.traceId);
    assert.ok(traced.length >= 4);
    assert.ok(traced.every((e) => e.traceId === TRACE && e.parentSpanId === SPAN && e.spanId === undefined));
    // sessionStart runs before the agent's trace: no traceparent, no trace.
    assert.equal(events.find((e) => e.kind === "session.start")!.traceId, undefined);
    // The traceparent changes no event id (live and backfilled lines still dedupe).
    const lines = readFileSync(join(FIXTURES, "copilot-cli", "otel", "hooks.spool.jsonl"), "utf8").split("\n").filter(Boolean);
    const bare = lines.map((l) => {
      const o = JSON.parse(l);
      delete o.raw.traceparent;
      return JSON.stringify(o);
    });
    // (Ids of spool lines read from a file key on the file and offset, not the line's content.)
    const ids = async (ls: string[]) => {
      const { ctx } = testCtx();
      const out: typeof events = [];
      for (const [i, l] of ls.entries()) out.push(...(await copilotCliAdapter.normalize(JSON.parse(l), { ...ctx, source: { file: "copilot.jsonl", offset: i } })));
      return out;
    };
    const plain = await ids(bare);
    assert.deepEqual(plain.map((e) => e.id), (await ids(lines)).map((e) => e.id));
    assert.ok(plain.every((e) => e.traceId === undefined));
  });

  it("an invalid traceparent sets no trace", async () => {
    const line = JSON.parse(readFileSync(join(FIXTURES, "copilot-cli", "otel", "hooks.spool.jsonl"), "utf8").split("\n")[2]!);
    for (const bad of ["00-00000000000000000000000000000000-0a20f5b72c7e2990-01", "ff-52d64d522262bb7dfe0a8873681dae65-0a20f5b72c7e2990-01", "garbage"]) {
      line.raw.traceparent = bad;
      const out = await copilotCliAdapter.normalize(line, testCtx().ctx);
      assert.ok(out.length && out.every((e) => e.traceId === undefined), bad);
    }
  });

  it("an OTLP span of the hook's trace that names no conversation joins the hook session", async () => {
    const { mkdirSync, copyFileSync, mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { defaultConfig } = await import("../../../src/core/config.ts");
    const { ingest } = await import("../../../src/core/ingest.ts");
    const { MemoryBlobStore, MemoryIndexStore } = await import("../../../src/store/memory.ts");
    const { createOtlpPipeline } = await import("../../../src/otel/receiver.ts");
    const { decodeTraceJson } = await import("../../../src/otel/json.ts");
    const { traceKvKey } = await import("../../../src/otel/map.ts");
    const root = mkdtempSync(join(tmpdir(), "csh-copilot-trace-"));
    try {
      const env = { CODING_SH_HOME: join(root, "home"), HOME: join(root, "user") };
      const dir = join(env.CODING_SH_HOME, "spool", "copilot-cli");
      mkdirSync(dir, { recursive: true });
      copyFileSync(join(FIXTURES, "copilot-cli", "otel", "hooks.spool.jsonl"), join(dir, "2026-11-08.1.jsonl"));
      // A span the hook's own tooling exports under the traceparent it was given: no gen_ai.conversation.id.
      const orphan = () => {
        const body = otlp("000");
        const sp = body.resourceSpans[0].scopeSpans[0].spans[0];
        sp.attributes = sp.attributes.filter((a: { key: string }) => a.key !== "gen_ai.conversation.id");
        sp.spanId = "1111222233334444";
        return decodeTraceJson(body);
      };
      const mapOrphan = async (index: InstanceType<typeof MemoryIndexStore>) =>
        (await createOtlpPipeline({ store: index, blobs: new MemoryBlobStore(), enrichSpan: false }).map("traces", orphan())).events;

      // Without the hook session's trace on record, the span is a session of its own.
      const before = await mapOrphan(new MemoryIndexStore());
      assert.ok(before.length && before.every((e) => e.sessionId === TRACE));

      const index = new MemoryIndexStore();
      await ingest({ config: defaultConfig(env), index, blobs: new MemoryBlobStore(), adapters: new Map([["copilot-cli", copilotCliAdapter]]), env, lock: false });
      assert.equal(await index.kvGet(traceKvKey(TRACE)), SID);
      const joined = await mapOrphan(index);
      assert.ok(joined.length && joined.every((e) => e.sessionId === SID));
      // Copilot's own spans name the conversation and land in the same session.
      const own = (await createOtlpPipeline({ store: index, blobs: new MemoryBlobStore(), enrichSpan: false }).map("traces", decodeTraceJson(otlp("001")))).events;
      assert.ok(own.length && own.every((e) => e.sessionId === SID));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
