// `coding.sh gateway …`, `doctor` and the hook against a fresh bundle, with the
// gateway REST API replaced by a local mock (CODING_SH_GATEWAY_URL).
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
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
import { OR_GEN, openRouterCredits, openRouterGeneration } from "./_multi.ts";

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
    const dir = join(env.CODING_SH_HOME!, "spool", "claude-code");
    const spool = () => readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("");
    const gateways = () => spool().split("\n").filter(Boolean).map((l) => (JSON.parse(l) as SpoolLine).gateway);
    // Checked after each run: the two runs may write separate spool files, listed in any order.
    assert.equal(run({ ANTHROPIC_BASE_URL: "https://ai-gateway.vercel.sh/claude-code", ANTHROPIC_AUTH_TOKEN: TEST_KEY, CODING_SH_NO_AUTO_INGEST: "1" }).status, 0);
    assert.deepEqual(gateways(), ["vercel"]);
    assert.equal(run({ ANTHROPIC_BASE_URL: "https://api.anthropic.com", CODING_SH_NO_AUTO_INGEST: "1" }).status, 0);
    assert.deepEqual(gateways().sort(), [undefined, "vercel"].sort());
    assert.ok(!spool().includes(TEST_KEY));
  });
});

describe("coding.sh gateway with other gateways (CLI)", () => {
  const OR_KEY = "sk-or-v1-" + "1".repeat(48);
  let server: Server;
  let orUrl = "";
  const seen: { path: string; auth: string | undefined }[] = [];
  before(async () => {
    // Local stand-in for OpenRouter's /api/v1/generation and /api/v1/credits.
    server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://x");
      seen.push({ path: u.pathname + u.search, auth: req.headers.authorization });
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.headers.authorization !== `Bearer ${OR_KEY}`) return send(401, { error: { message: "No auth credentials found" } });
      if (u.pathname === "/api/v1/credits") return send(200, openRouterCredits);
      if (u.pathname === "/api/v1/generation" && u.searchParams.get("id") === OR_GEN) return send(200, openRouterGeneration(OR_GEN, { total_cost: 0.3, provider_name: "Together" }));
      send(404, { error: { message: "Generation not found" } });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    orUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  const orCall: AgentEvent = { id: "or-1", v: 0, sessionId: "or-s1", ts: now - 30_000, agent: "codex", kind: "llm.call", source: "transcript", model: "anthropic/claude-sonnet-4.5", usage: { inputTokens: 10, outputTokens: 2 }, payload: { provider: "openrouter", responseId: OR_GEN } };
  const orStart: AgentEvent = { id: "or-0", v: 0, sessionId: "or-s1", ts: now - 31_000, agent: "codex", kind: "session.start", source: "transcript", payload: {} };

  it("status lists OpenRouter with its key source, routing and sessions; --credits uses its API", async () => {
    const { env } = home();
    await seed(env.CODING_SH_HOME!, [orStart, orCall]);
    mkdirSync(env.CODING_SH_HOME!, { recursive: true });
    writeFileSync(join(env.CODING_SH_HOME!, "config.toml"), `[gateway.openrouter]\nbaseUrl = "${orUrl}"\n`);
    const genv = { ...env, OPENROUTER_API_KEY: OR_KEY, OPENAI_BASE_URL: "https://openrouter.ai/api/v1" };
    const r = await cli(genv, ["gateway", "status", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!r.stdout.includes(OR_KEY) && !r.stderr.includes(OR_KEY));
    const doc = JSON.parse(r.stdout);
    assert.deepEqual(doc.key, { set: false, env: "AI_GATEWAY_API_KEY" }, "top level stays Vercel's");
    const or = doc.gateways.find((g: { id: string }) => g.id === "openrouter");
    assert.deepEqual([or.key, or.sessions, or.lookup], [{ set: true, source: "env OPENROUTER_API_KEY" }, 1, "generation"]);
    assert.equal(doc.configured[0].gateway, "openrouter");

    const one = JSON.parse((await cli(genv, ["gateway", "status", "--gateway", "openrouter", "--credits", "--json"])).stdout);
    assert.deepEqual(one.credits, { balanceUsd: 37.5, totalUsedUsd: 12.5 });
    assert.deepEqual(one.sessions, { tagged: 1, drained: 0 });
    const text = await cli(genv, ["gateway", "status"]);
    assert.match(text.stdout + text.stderr, /OpenRouter\s+key set \(env OPENROUTER_API_KEY\); lookups on; 1 session tagged gateway:openrouter/);
  });

  it("enrich looks OpenRouter generations up with OPENROUTER_API_KEY; --gateway narrows it", async () => {
    const { env } = home();
    await seed(env.CODING_SH_HOME!, [orStart, orCall, codexStart, codexCall]);
    mkdirSync(env.CODING_SH_HOME!, { recursive: true });
    writeFileSync(join(env.CODING_SH_HOME!, "config.toml"), `[gateway.openrouter]\nbaseUrl = "${orUrl}"\n`);
    const genv = { ...env, OPENROUTER_API_KEY: OR_KEY };
    const dry = JSON.parse((await cli(genv, ["gateway", "enrich", "--dry-run", "--json"])).stdout);
    assert.deepEqual([dry.report.enriched, dry.report.needKeyBy, dry.lookups], [1, { vercel: 1 }, ["openrouter"]]);
    const real = await cli(genv, ["gateway", "enrich", "--gateway", "openrouter"]);
    assert.equal(real.code, 0, real.stderr);
    const shown = real.stdout + real.stderr;
    assert.match(shown, /enriched 1 call .*billed \$0\.30/);
    assert.match(shown, /Served by\s+Together 1/);
    assert.ok(!shown.includes(OR_KEY));
    assert.ok(seen.every((q) => q.auth === `Bearer ${OR_KEY}`));
    const s = JSON.parse((await cli(env, ["sessions", "--json"])).stdout).sessions.find((x: { id: string }) => x.id === "or-s1");
    assert.ok(s.flags.includes("gateway:openrouter"));
    assert.equal(s.stats?.usage?.costUsd ?? s.costUsd, 0.3);
  });

  it("compare --gateway <name>: needs that gateway's key; unknown or non-routing gateways are refused", async () => {
    const { env } = home();
    const r = await cli(env, ["compare", "a", "b", "--gateway", "openrouter", "--yes"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--gateway openrouter needs a key in \$OPENROUTER_API_KEY \(OpenRouter\)/);
    const bad = await cli(env, ["compare", "a", "b", "--gateway=helicone", "--yes"]);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /--gateway must be one of vercel, openrouter, litellm, ramp/);
    // The spaced form leaves the name as a positional; it is refused, not ignored.
    const spaced = await cli(env, ["compare", "a", "b", "--gateway", "helicone", "--yes"]);
    assert.equal(spaced.code, 2);
    assert.match(spaced.stderr, /Unexpected argument "helicone"/);
    // A [gateway] default that can't route is refused before anything runs.
    mkdirSync(env.CODING_SH_HOME!, { recursive: true });
    writeFileSync(join(env.CODING_SH_HOME!, "config.toml"), '[gateway]\ndefault = "helicone"\n');
    const dflt = await cli({ ...env, HELICONE_API_KEY: "hk-test" }, ["compare", "a", "b", "--gateway", "--yes"]);
    assert.equal(dflt.code, 2);
    assert.match(dflt.stderr, /--gateway can route through vercel, openrouter, litellm, ramp; got "helicone"/);
    // Bare --gateway with only an OpenRouter key picks OpenRouter (then fails on the missing bundles, after the key check).
    const picked = await cli({ ...env, OPENROUTER_API_KEY: OR_KEY }, ["compare", "a", "b", "--gateway", "--yes"]);
    assert.doesNotMatch(picked.stderr, /needs .* key/);
    assert.ok(!picked.stderr.includes(OR_KEY));
  });
});
