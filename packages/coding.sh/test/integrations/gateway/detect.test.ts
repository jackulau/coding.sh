import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { buildSession, failureFlags } from "../../../src/core/sessions.ts";
import { createRedactor } from "../../../src/core/redact.ts";
import { detectGatewaySetups, gatewaySettings } from "../../../src/integrations/gateway/config.ts";
import { gatewayFromEnv, generationIdOf, isGatewayEvent, isGatewayUrl, isGenerationId } from "../../../src/integrations/gateway/ids.ts";
import type { AgentEvent } from "../../../src/schema/index.ts";
import { GEN_ID } from "./_fixtures.ts";

const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
const tmp = () => {
  const r = mkdtempSync(join(tmpdir(), "csh-gw-"));
  roots.push(r);
  return r;
};

const ev = (over: Partial<AgentEvent> & { payload?: Record<string, unknown> }): AgentEvent => ({ id: `e${Math.random()}`, v: 0, sessionId: "s1", ts: 1000, agent: "claude-code", kind: "llm.call", payload: {}, ...over });

describe("gateway detection (ids)", () => {
  it("recognises gateway URLs, env routing and generation ids", () => {
    assert.ok(isGatewayUrl("https://ai-gateway.vercel.sh/claude-code"));
    assert.ok(isGatewayUrl("https://ai-gateway.vercel.sh/v1"));
    assert.ok(!isGatewayUrl("https://api.anthropic.com"));
    assert.ok(!isGatewayUrl("https://ai-gateway.vercel.sh.evil.example/v1"));
    assert.ok(!isGatewayUrl("not a url"));
    assert.equal(gatewayFromEnv({ ANTHROPIC_BASE_URL: "https://ai-gateway.vercel.sh/claude-code" }), "vercel");
    assert.equal(gatewayFromEnv({ OPENAI_BASE_URL: "https://ai-gateway.vercel.sh/v1" }), "vercel");
    assert.equal(gatewayFromEnv({ ANTHROPIC_BASE_URL: "https://api.anthropic.com" }), undefined);
    assert.ok(isGenerationId(GEN_ID));
    assert.ok(!isGenerationId("gen_short"));
    assert.ok(!isGenerationId("msg_01JAZ3NDEKTSV4RRFFQ69G5FAV"));
    assert.equal(generationIdOf(ev({ payload: { responseId: GEN_ID } })), GEN_ID);
    assert.equal(generationIdOf(ev({ payload: { messageId: "msg_1" } })), undefined);
  });

  it("tags a session gateway:vercel without counting it as a failure", () => {
    const base = [ev({ kind: "session.start", ts: 1 }), ev({ kind: "turn.end", ts: 3 })];
    assert.ok(!buildSession([...base, ev({ ts: 2 })]).flags.includes("gateway:vercel"));
    for (const signal of [
      ev({ ts: 2, payload: { gateway: "vercel" } }),
      ev({ ts: 2, payload: { responseId: GEN_ID } }),
      ev({ ts: 2, payload: { provider: "vercel" } }),
      ev({ ts: 2, model: "claude-code/openai/gpt-5" }),
      ev({ ts: 2, kind: "notification", payload: { gateway: "vercel" } }),
    ]) {
      assert.ok(isGatewayEvent(signal), JSON.stringify(signal));
      const s = buildSession([...base, signal]);
      assert.ok(s.flags.includes("gateway:vercel"));
      assert.deepEqual(failureFlags(s.flags), s.flags.filter((f) => f !== "gateway:vercel"));
    }
    // A provider name alone on a non-call event is not a signal.
    assert.ok(!isGatewayEvent(ev({ kind: "tool.start", payload: { provider: "vercel" } })));
  });

  it("enrichment events add cost but never move a session's end or shape", () => {
    // Transcript-only (backfill) session: ends at its last captured activity.
    const call = ev({ ts: 2000, source: "transcript", durationMs: 500, usage: { costUsd: 0.01 } });
    const before = buildSession([ev({ kind: "user.message", ts: 1000, source: "transcript", payload: { text: "hi" } }), call]);
    const enrichment = ev({ id: "g1", kind: "span", ts: 9_000, source: "gateway", parentId: call.id, usage: { costUsd: 0.002 }, traceId: "t-gw", payload: { name: "vercel.ai_gateway.generation" } });
    const after = buildSession([ev({ kind: "user.message", ts: 1000, source: "transcript", payload: { text: "hi" } }), call, enrichment]);
    assert.equal(after.endedAt, before.endedAt);
    assert.equal(after.traceIds, undefined);
    assert.equal(after.stats.usage?.costUsd, 0.012);
  });

  it("redacts AI Gateway keys", () => {
    const fake = "vck_" + "x".repeat(8) + "TESTONLY" + "y".repeat(16);
    const out = createRedactor().string(`key ${fake} end`);
    assert.equal(out, "key [redacted:vercel-ai-gateway-key] end");
  });
});

describe("gateway config (read-only scan, settings)", () => {
  it("finds gateway routing in Claude Code, Codex, OpenCode and Pi configs without reading key values", () => {
    const home = tmp();
    const SECRET = "vck_" + "s".repeat(30);
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://ai-gateway.vercel.sh/claude-code", ANTHROPIC_AUTH_TOKEN: SECRET } }));
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      join(home, ".codex", "config.toml"),
      ['model_provider = "openai"', "", "[model_providers.vercel]", 'name = "Vercel"', 'base_url = "https://ai-gateway.vercel.sh/codex/v1"', 'env_key = "AI_GATEWAY_API_KEY"', 'wire_api = "responses"', "", "[profiles.gw]", 'model_provider = "vercel"', ""].join("\n"),
    );
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(join(home, ".config", "opencode", "opencode.json"), JSON.stringify({ model: "vercel/anthropic/claude-sonnet-4.5" }));
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ defaultProvider: "vercel-ai-gateway" }));
    const project = tmp();
    mkdirSync(join(project, ".claude"));
    writeFileSync(join(project, ".claude", "settings.local.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" } }));

    const env = { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), OPENAI_BASE_URL: "https://ai-gateway.vercel.sh/v1" };
    const found = detectGatewaySetups(env, project);
    assert.deepEqual(found.map((f) => f.agent).sort(), ["any", "claude-code", "codex", "opencode", "pi"]);
    const codex = found.find((f) => f.agent === "codex")!;
    assert.equal(codex.active, true, "selected by a profile");
    assert.match(codex.detail, /model_providers\.vercel\.base_url → ai-gateway\.vercel\.sh\/codex\/v1, key from \$AI_GATEWAY_API_KEY/);
    assert.ok(!JSON.stringify(found).includes(SECRET));
  });

  it("reads the key from env first, then [gateway] in config.toml (with ${VAR})", () => {
    const home = tmp();
    const data = join(home, ".coding.sh");
    mkdirSync(data, { recursive: true });
    const env: NodeJS.ProcessEnv = { HOME: home, CODING_SH_HOME: data };
    assert.deepEqual(gatewaySettings(env), { baseUrl: "https://ai-gateway.vercel.sh/v1", apiKeyEnv: "AI_GATEWAY_API_KEY" });
    assert.equal(gatewaySettings({ ...env, AI_GATEWAY_API_KEY: "k-env" }).keySource, "env AI_GATEWAY_API_KEY");
    writeFileSync(join(data, "config.toml"), '[gateway]\napiKeyEnv = "MY_GW_KEY"\napiKey = "${OTHER_KEY}"\nbaseUrl = "http://127.0.0.1:9/v1/"\n');
    const s = gatewaySettings({ ...env, MY_GW_KEY: "k-mine", AI_GATEWAY_API_KEY: "ignored" });
    assert.equal(s.apiKey, "k-mine");
    assert.equal(s.baseUrl, "http://127.0.0.1:9/v1");
    const c = gatewaySettings({ ...env, OTHER_KEY: "k-other" });
    assert.equal(c.apiKey, "k-other");
    assert.equal(c.keySource, "config gateway.apiKey");
    assert.equal(gatewaySettings(env).apiKey, undefined, "unset ${VAR} means no key");
    assert.equal(gatewaySettings({ ...env, CODING_SH_GATEWAY_URL: "http://127.0.0.1:1/v1" }).baseUrl, "http://127.0.0.1:1/v1");
  });
});
