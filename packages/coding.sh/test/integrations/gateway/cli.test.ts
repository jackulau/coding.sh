// `coding.sh gateway …`, `doctor` and the hook against a fresh bundle, with the
// gateway REST API replaced by a local mock (CODING_SH_GATEWAY_URL).
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { bundle } from "../../../scripts/bundle.mjs";
import { buildSession } from "../../../src/core/sessions.ts";
import type { SpoolLine } from "../../../src/core/types.ts";
import type { AgentEvent } from "../../../src/schema/index.ts";
import { SqliteIndexStore } from "../../../src/store/sqlite.ts";
import { GEN_ID } from "./_fixtures.ts";
import { generationData, startMockGateway, TEST_KEY, type MockGateway } from "./_mock.ts";

let dist = "";
let CLI = "";
let HOOK = "";
let gw: MockGateway;
const roots: string[] = [];

before(async () => {
  dist = realpathSync(mkdtempSync(join(tmpdir(), "csh-gw-dist-")));
  const b = await bundle(dist);
  CLI = b.cli;
  HOOK = b.hook;
  gw = await startMockGateway();
});
after(async () => {
  await gw.close();
  for (const r of [dist, ...roots]) rmSync(r, { recursive: true, force: true });
});

function home() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "csh-gw-cli-")));
  roots.push(root);
  const h = join(root, "home");
  mkdirSync(h);
  const env: Record<string, string> = { HOME: h, USERPROFILE: h, CODING_SH_HOME: join(h, ".coding.sh"), XDG_CONFIG_HOME: join(h, ".config"), PATH: dirname(process.execPath), TMPDIR: tmpdir(), NO_COLOR: "1" };
  return { h, env };
}

/** Async so the in-process mock server can answer. */
function cli(env: Record<string, string>, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env, cwd: env.HOME, timeout: 30_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

async function seed(dataDir: string, events: AgentEvent[]) {
  const index = await SqliteIndexStore.open(join(dataDir, "index.db"));
  try {
    await index.migrate();
    await index.putEvents(events);
    for (const id of new Set(events.map((e) => e.sessionId))) await index.upsertSession(buildSession(await index.listEvents(id)));
  } finally {
    await index.close();
  }
}

const now = Date.now();
const codexCall: AgentEvent = { id: "cx-1", v: 0, sessionId: "codex-s1", ts: now - 60_000, agent: "codex", kind: "llm.call", source: "transcript", model: "openai/gpt-5", usage: { inputTokens: 10, outputTokens: 2 }, payload: { provider: "vercel", responseId: GEN_ID } };
const codexStart: AgentEvent = { id: "cx-0", v: 0, sessionId: "codex-s1", ts: now - 61_000, agent: "codex", kind: "session.start", source: "transcript", payload: {} };

describe("coding.sh gateway (CLI)", () => {
  it("status --json reports routing and key presence without the key value", async () => {
    const { env } = home();
    await seed(env.CODING_SH_HOME!, [codexStart, codexCall]);
    const r = await cli({ ...env, AI_GATEWAY_API_KEY: TEST_KEY, ANTHROPIC_BASE_URL: "https://ai-gateway.vercel.sh/claude-code", CODING_SH_GATEWAY_URL: gw.url }, ["gateway", "status", "--json", "--credits"]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!r.stdout.includes(TEST_KEY) && !r.stderr.includes(TEST_KEY));
    const doc = JSON.parse(r.stdout);
    assert.deepEqual(doc.key, { set: true, source: "env AI_GATEWAY_API_KEY" });
    assert.equal(doc.configured[0].agent, "claude-code");
    assert.deepEqual(doc.sessions, { tagged: 1, drained: 0 });
    assert.deepEqual(doc.credits, { balanceUsd: 95.5, totalUsedUsd: 4.5 });

    const d = await cli({ ...env, AI_GATEWAY_API_KEY: TEST_KEY }, ["doctor", "--json"]);
    const doctor = JSON.parse(d.stdout);
    assert.deepEqual(doctor.gateway.key, { set: true, source: "env AI_GATEWAY_API_KEY" });
    assert.equal(doctor.gateway.sessions, 1);
    assert.ok(!d.stdout.includes(TEST_KEY));
  });

  it("enrich: dry run, then writes billed cost; without a key it asks for one", async () => {
    const { env } = home();
    await seed(env.CODING_SH_HOME!, [codexStart, codexCall]);
    gw.generations.set(GEN_ID, generationData(GEN_ID, { total_cost: 0.25, provider_name: "azure" }));

    const keyless = await cli(env, ["gateway", "enrich", "--json"]);
    assert.equal(keyless.code, 0, keyless.stderr);
    assert.equal(JSON.parse(keyless.stdout).report.needKey, 1);

    const genv = { ...env, AI_GATEWAY_API_KEY: TEST_KEY, CODING_SH_GATEWAY_URL: gw.url };
    const dry = await cli(genv, ["gateway", "enrich", "--dry-run", "--json"]);
    assert.equal(JSON.parse(dry.stdout).report.enriched, 1);
    const real = await cli(genv, ["gateway", "enrich"]);
    assert.equal(real.code, 0, real.stderr);
    const shown = real.stdout + real.stderr; // rows go to stderr, the result to stdout
    assert.match(shown, /enriched 1 call .*billed \$0\.25/);
    assert.match(shown, /Served by\s+azure 1/);
    assert.ok(!shown.includes(TEST_KEY));

    const show = await cli(env, ["sessions", "--json"]);
    const s = JSON.parse(show.stdout).sessions.find((x: { id: string }) => x.id === "codex-s1");
    assert.ok(s.flags.includes("gateway:vercel"));
    assert.equal(s.stats?.usage?.costUsd ?? s.costUsd, 0.25);

    const offline = await cli(genv, ["gateway", "enrich", "--offline", "--json"]);
    assert.equal(JSON.parse(offline.stdout).report.alreadyEnriched, 1);
  });

  it("compare --gateway without a key fails before running anything", async () => {
    const { env } = home();
    const r = await cli(env, ["compare", "a", "b", "--gateway", "--yes"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--gateway needs an AI Gateway key in \$AI_GATEWAY_API_KEY/);
  });
});

describe("hook records gateway routing", () => {
  it("writes SpoolLine.gateway when the agent's env points at the gateway, never the key", () => {
    const { env } = home();
    const run = (extra: Record<string, string>) =>
      spawnSync(process.execPath, [HOOK, "claude-code", "Stop"], { input: JSON.stringify({ session_id: "s1", hook_event_name: "Stop" }), env: { ...env, ...extra }, encoding: "utf8" });
    assert.equal(run({ ANTHROPIC_BASE_URL: "https://ai-gateway.vercel.sh/claude-code", ANTHROPIC_AUTH_TOKEN: TEST_KEY, CODING_SH_NO_AUTO_INGEST: "1" }).status, 0);
    assert.equal(run({ ANTHROPIC_BASE_URL: "https://api.anthropic.com", CODING_SH_NO_AUTO_INGEST: "1" }).status, 0);
    const dir = join(env.CODING_SH_HOME!, "spool", "claude-code");
    const text = readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("");
    const lines = text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as SpoolLine);
    assert.deepEqual(lines.map((l) => l.gateway), ["vercel", undefined]);
    assert.ok(!text.includes(TEST_KEY));
  });
});
