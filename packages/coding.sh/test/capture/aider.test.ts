// Live Aider usage (src/capture/aider.ts). Fixtures come from a real Aider 0.86.2 run through
// `coding.sh run --` against the stub model (scripts/e2e/aider-usage-capture.mjs):
// *.spool.jsonl is what the wrapper spooled, cache.analytics.jsonl and cache.history.md are the
// two files the tap reads, replayed here by a fake aider.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { aiderUsageTap, parseAnalyticsLine, parseHistoryReport, toRecord } from "../../src/capture/aider.ts";
import { wrapRunDetailed } from "../../src/capture/wrapper.ts";
import { aiderAdapter } from "../../src/adapters/more/aider.ts";
import { buildSession } from "../../src/core/sessions.ts";
import type { SpoolLine } from "../../src/core/types.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { FIXTURES, assertWellFormed, loadSpool, testCtx } from "../adapters/_helpers.ts";
import { isolate, makeRepo, removeTmp, tmp } from "./_helpers.ts";

let home = "";
before(() => {
  home = isolate();
});
after(() => removeTmp());

const fixture = (name: string) => readFileSync(join(FIXTURES, "aider", name), "utf8");
const ANALYTICS = fixture("cache.analytics.jsonl").split("\n").filter(Boolean);
// The history Aider appended in that run, split at each reply's usage report.
const HISTORY = fixture("cache.history.md");
const CUT = HISTORY.indexOf("#### say hello again");

/** The usage of one cache reply from the real run: 1500 uncached, 2400 written, 12000 read, $0.06075. */
const REPLY = { inputTokens: 1500, outputTokens: 30, cacheReadTokens: 12000, cacheWriteTokens: 2400, costUsd: 0.06075 };

function spool(agent: string, h = home): SpoolLine[] {
  const dir = join(h, "spool", agent);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean))
    .map((l) => JSON.parse(l) as SpoolLine);
}

/**
 * A fake aider that replays the real run: history then analytics event for each reply, as Aider
 * writes them. Between replies it waits until the wrapper has spooled the first one, so the test
 * sees usage arrive while the agent is still running. The log goes where Aider would put it:
 * --analytics-log, else AIDER_ANALYTICS_LOG.
 */
function fakeAider(dir: string, spoolDir: string): string {
  const p = join(dir, "aider.mjs");
  writeFileSync(
    p,
    `import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
const [history1, history2] = ${JSON.stringify([HISTORY.slice(0, CUT), HISTORY.slice(CUT)])};
const events = ${JSON.stringify(ANALYTICS)};
const i = process.argv.indexOf("--analytics-log");
const log = i > 0 ? process.argv[i + 1] : process.env.AIDER_ANALYTICS_LOG;
writeFileSync("seen.json", JSON.stringify({ log: log ?? null, env: process.env.AIDER_ANALYTICS_LOG ?? null }));
if (log) appendFileSync(log, JSON.stringify({ event: "launched", properties: {}, time: 1 }) + "\\n");
appendFileSync(".aider.chat.history.md", history1);
if (log) appendFileSync(log, events[0] + "\\n");
const spooled = () => existsSync(${JSON.stringify(spoolDir)}) && readdirSync(${JSON.stringify(spoolDir)}).some((f) => f.endsWith(".jsonl") && readFileSync(${JSON.stringify(spoolDir)} + "/" + f, "utf8").includes('"llm.usage"'));
const t0 = Date.now();
while (!spooled() && Date.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 50));
writeFileSync("live.json", JSON.stringify(spooled()));
appendFileSync(".aider.chat.history.md", history2);
if (log) appendFileSync(log, events[1] + "\\n");
`,
  );
  return p;
}

async function normalize(rel: string): Promise<AgentEvent[]> {
  const { ctx } = testCtx();
  const out: AgentEvent[] = [];
  for (const line of loadSpool(rel)) out.push(...(await aiderAdapter.normalize(line, ctx)));
  assertWellFormed(out);
  return out;
}

describe("aider usage parsing", () => {
  test("a message_send line: exact counts, cost and the model; other events and redacted models are skipped", () => {
    assert.deepEqual(parseAnalyticsLine(ANALYTICS[1]!), { time: 1794201618, model: "anthropic/claude-3-5-sonnet-20241022", sent: 18300, received: 30, cost: 0.06075, totalCost: 0.1215 });
    assert.equal(parseAnalyticsLine('{"event": "launched", "properties": {}}'), undefined);
    assert.equal(parseAnalyticsLine("not json"), undefined);
    const redacted = ANALYTICS[0]!.replace('"main_model": "anthropic/claude-3-5-sonnet-20241022"', '"main_model": "anthropic/REDACTED"');
    assert.equal(parseAnalyticsLine(redacted)!.model, undefined);
  });

  test("a quoted usage report: rounded counts and the cache split", () => {
    assert.deepEqual(parseHistoryReport("> Tokens: 18k sent, 2.4k cache write, 12k cache hit, 30 received.  "), { sent: 18000, received: 30, cacheWrite: 2400, cacheRead: 12000 });
    assert.deepEqual(parseHistoryReport("> Tokens: 120 sent, 30 received. Cost: $0.00 message, $0.00 session."), { sent: 120, received: 30, cacheWrite: 0, cacheRead: 0 });
    assert.equal(parseHistoryReport("> Applied edit to hello.txt"), undefined);
  });

  test("inputTokens is the uncached part: Aider's sent counts reads once and writes twice", () => {
    const m = parseAnalyticsLine(ANALYTICS[0]!)!;
    const h = parseHistoryReport("> Tokens: 18k sent, 2.4k cache write, 12k cache hit, 30 received.")!;
    assert.deepEqual(toRecord(m, h).usage, REPLY);
    // Without its history line, the counts stay whole and uncached.
    assert.deepEqual(toRecord(m, undefined).usage, { inputTokens: 18300, outputTokens: 30, costUsd: 0.06075 });
  });

  test("a cost of 0 (Aider has no price for the model) is left unknown", () => {
    const r = toRecord({ sent: 120, received: 30, cost: 0, totalCost: 0 }, undefined, 5000);
    assert.deepEqual(r, { ts: 5000, usage: { inputTokens: 120, outputTokens: 30 } });
  });
});

describe("aider usage tap", () => {
  test("a wrapped aider spools each reply's usage while it runs, from a temp analytics log it removes", async () => {
    const root = makeRepo({ "README.md": "# demo\n" });
    const agent = fakeAider(tmp("csh-aider-"), join(home, "spool", "aider"));
    const r = await wrapRunDetailed({ cmd: process.execPath, args: [agent], cwd: root, agentId: "aider" });
    assert.equal(r.exitCode, 0);
    const seen = JSON.parse(readFileSync(join(root, "seen.json"), "utf8"));
    assert.ok(seen.env, "the tap gave aider AIDER_ANALYTICS_LOG");
    assert.equal(existsSync(seen.env), false, "the temp log is removed after the run");
    assert.equal(JSON.parse(readFileSync(join(root, "live.json"), "utf8")), true, "the first reply was spooled before aider exited");

    const lines = spool("aider").filter((l) => (l.raw as { sessionId?: string }).sessionId === r.sessionId);
    const usage = lines.filter((l) => l.event === "llm.usage");
    assert.deepEqual(
      usage.map((l) => l.raw),
      [
        { sessionId: r.sessionId, seq: 0, model: "anthropic/claude-3-5-sonnet-20241022", usage: REPLY, sessionCostUsd: 0.06075 },
        { sessionId: r.sessionId, seq: 1, model: "anthropic/claude-3-5-sonnet-20241022", usage: REPLY, sessionCostUsd: 0.1215 },
      ],
    );
    const start = lines.find((l) => l.event === "session.start")!;
    assert.ok(usage.every((l) => l.ts >= start.ts), "usage lines never land before session.start");
  });

  test("a log the user names on argv is read in place, not replaced or removed", async () => {
    const h = join(tmp(), "home");
    const root = makeRepo({ "README.md": "# demo\n" });
    const log = join(tmp("csh-log-"), "mine.jsonl");
    writeFileSync(log, '{"event": "launched", "properties": {}, "time": 1}\n');
    const agent = fakeAider(tmp("csh-aider-"), join(h, "spool", "aider"));
    const r = await wrapRunDetailed({ cmd: process.execPath, args: [agent, "--analytics-log", log], cwd: root, env: { CODING_SH_HOME: h }, agentId: "aider" });
    assert.equal(r.exitCode, 0);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "seen.json"), "utf8")), { log, env: null });
    assert.match(readFileSync(log, "utf8"), /message_send/);
    assert.equal(spool("aider", h).filter((l) => l.event === "llm.usage").length, 2);
  });

  test("analytics-log and chat-history-file from .aider.conf.yml are where the tap reads", () => {
    const cwd = tmp("csh-conf-");
    writeFileSync(join(cwd, ".aider.conf.yml"), "model: x\nanalytics-log: 'logs/a.jsonl'\nchat-history-file: notes.md\n");
    const tap = aiderUsageTap({ args: [], cwd, env: { HOME: tmp() } })!;
    assert.deepEqual(tap.env, {});
    assert.equal(tap.logFile, join(cwd, "logs", "a.jsonl"));
    writeFileSync(join(cwd, "notes.md"), "> Tokens: 18k sent, 2.4k cache write, 12k cache hit, 30 received.\n");
    mkdirSync(join(cwd, "logs"));
    writeFileSync(tap.logFile, ANALYTICS[0] + "\n");
    // Both files were empty or absent when the tap started, so everything in them is new.
    assert.deepEqual(tap.close().map((x) => x.usage), [REPLY]);
  });

  test("lines already in the files when the run starts are not counted", () => {
    const cwd = tmp("csh-old-");
    const log = join(cwd, "a.jsonl");
    writeFileSync(log, ANALYTICS[0] + "\n");
    writeFileSync(join(cwd, ".aider.chat.history.md"), HISTORY.slice(0, CUT));
    const tap = aiderUsageTap({ args: ["--analytics-log", log], cwd, env: {} })!;
    assert.deepEqual(tap.poll(), []);
    writeFileSync(join(cwd, ".aider.chat.history.md"), HISTORY);
    writeFileSync(log, ANALYTICS.join("\n") + "\n");
    assert.deepEqual(tap.close().map((x) => x.usage), [REPLY]);
  });

  test("other wrapped commands get no analytics log", async () => {
    const h = join(tmp(), "home");
    const dir = tmp("csh-other-");
    const script = "require('fs').writeFileSync('env.json', JSON.stringify(process.env.AIDER_ANALYTICS_LOG ?? null))";
    await wrapRunDetailed({ cmd: process.execPath, args: ["-e", script], cwd: dir, env: { CODING_SH_HOME: h } });
    assert.equal(JSON.parse(readFileSync(join(dir, "env.json"), "utf8")), null);
  });
});

describe("real aider sessions", () => {
  test("a wrapped Aider session has usage and cost (Anthropic, cache writes and reads, priced model)", async () => {
    const events = await normalize("aider/cache.spool.jsonl");
    const calls = events.filter((e) => e.kind === "llm.call");
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.model, "anthropic/claude-3-5-sonnet-20241022");
    assert.equal(calls[0]!.payload.provider, "anthropic");
    const s = buildSession(events);
    assert.equal(s.agent, "aider");
    assert.equal(s.model, "anthropic/claude-3-5-sonnet-20241022");
    assert.deepEqual(
      { ...s.stats.usage, estimatedCostUsd: undefined, estimatedCostByTier: undefined },
      { inputTokens: 3000, outputTokens: 60, cacheReadTokens: 24000, cacheWriteTokens: 4800, costUsd: 0.1215, estimatedCostUsd: undefined, estimatedCostByTier: undefined },
    );
    assert.equal(s.stats.latency?.llmCalls, 2);
  });

  test("a model Aider has no price for: tokens, and no reported cost", async () => {
    const events = await normalize("aider/nocost.spool.jsonl");
    const s = buildSession(events);
    assert.equal(s.model, "openai/stub-model");
    assert.equal(s.stats.usage?.inputTokens, 120);
    assert.equal(s.stats.usage?.outputTokens, 30);
    const call = events.find((e) => e.kind === "llm.call")!;
    assert.equal(call.usage?.costUsd, undefined);
  });
});
