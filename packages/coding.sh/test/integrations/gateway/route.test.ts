import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { defaultConfig } from "../../../src/core/config.ts";
import { ingest } from "../../../src/core/ingest.ts";
import type { Adapter, RunSpec } from "../../../src/core/types.ts";
import { providerFromSpec } from "../../../src/graders/index.ts";
import { gatewayModelId, gatewayRoute } from "../../../src/integrations/gateway/route.ts";
import { runTask } from "../../../src/runner/run.ts";
import type { AgentEvent, EventKind } from "../../../src/schema/index.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../../src/store/memory.ts";
import { cleanupWorlds, obedientAgent, toyWorld } from "../../helpers-eval.ts";

const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
after(cleanupWorlds);

const KEY = "test-key-not-real";

describe("gatewayRoute", () => {
  it("Claude Code: base URL + auth token, Anthropic ids pass through, others via claude-code/", () => {
    const r = gatewayRoute("claude-code", "openai/gpt-5", KEY);
    assert.deepEqual(r.env, { ANTHROPIC_BASE_URL: "https://ai-gateway.vercel.sh/claude-code", ANTHROPIC_AUTH_TOKEN: KEY, ANTHROPIC_API_KEY: "" });
    assert.equal(r.model, "claude-code/openai/gpt-5");
    assert.equal(gatewayRoute("claude-code", "claude-sonnet-4-5", KEY).model, "claude-sonnet-4-5");
    assert.equal(gatewayRoute("claude-code", undefined, KEY).model, undefined);
  });

  it("Codex: a vercel provider via -c overrides (no config file), Responses API, key from env", () => {
    const r = gatewayRoute("codex", "gpt-5", KEY);
    assert.equal(r.model, "openai/gpt-5");
    assert.deepEqual(r.env, { AI_GATEWAY_API_KEY: KEY });
    const overrides = r.flags.filter((_, i) => i % 2 === 1);
    assert.ok(r.flags.filter((_, i) => i % 2 === 0).every((f) => f === "-c"));
    assert.ok(overrides.includes('model_provider="vercel"'));
    assert.ok(overrides.includes('model_providers.vercel.base_url="https://ai-gateway.vercel.sh/codex/v1"'));
    assert.ok(overrides.includes('model_providers.vercel.wire_api="responses"'));
    assert.ok(overrides.includes('model_providers.vercel.env_key="AI_GATEWAY_API_KEY"'));
    assert.ok(!r.flags.join(" ").includes(KEY), "the key never goes on the command line");
  });

  it("OpenCode and Pi use their built-in gateway providers; other agents are refused", () => {
    assert.equal(gatewayRoute("opencode", "claude-sonnet-4.5", KEY).model, "vercel/anthropic/claude-sonnet-4.5");
    assert.equal(gatewayRoute("opencode", "vercel/xai/grok-4", KEY).model, "vercel/xai/grok-4");
    assert.deepEqual(gatewayRoute("pi", "gemini-2.5-pro", KEY).flags, ["--provider", "vercel-ai-gateway"]);
    assert.equal(gatewayRoute("pi", "gemini-2.5-pro", KEY).model, "google/gemini-2.5-pro");
    assert.throws(() => gatewayRoute("cursor", "x", KEY), /no AI Gateway route for agent "cursor"/);
    assert.equal(gatewayModelId("o3"), "openai/o3");
    assert.equal(gatewayModelId("mystery-model"), "mystery-model");
  });

  it("runTask applies the route to the agent only (after the overlay), not to setup or the verifier", async () => {
    const w = await toyWorld();
    const adapter = obedientAgent();
    const bundle = await w.mkBundle("fixer", "always fix bugs");
    const r = await runTask({
      task: w.task,
      bundle,
      adapter,
      blobs: w.blobs,
      index: w.index,
      git: w.git,
      runsDir: w.runsDir,
      route: () => ({ env: { ANTHROPIC_BASE_URL: "https://ai-gateway.vercel.sh/claude-code", FROM_BUNDLE: "route-wins" }, flags: ["--routed"], model: "claude-code/openai/gpt-5" }),
    });
    assert.equal(r.error, undefined);
    assert.equal(r.pass, true, "verifier unaffected");
    const spec = adapter.specs[0] as RunSpec;
    assert.equal(spec.env.ANTHROPIC_BASE_URL, "https://ai-gateway.vercel.sh/claude-code");
    assert.equal(spec.env.FROM_BUNDLE, "route-wins");
    assert.equal(spec.model, "claude-code/openai/gpt-5");
    assert.deepEqual(spec.flags.slice(-1), ["--routed"]);
  });
});

describe("LLM graders through the gateway", () => {
  it('provider "gateway" calls the OpenAI-compatible endpoint with AI_GATEWAY_API_KEY', async () => {
    const seen: { url: string; auth: string | null; model: unknown }[] = [];
    const fetch = async (url: string, init: RequestInit) => {
      const h = new Headers(init.headers);
      seen.push({ url, auth: h.get("authorization"), model: JSON.parse(String(init.body)).model });
      return new Response(JSON.stringify({ id: "gen_x", choices: [{ message: { content: "yes" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const p = providerFromSpec({ provider: "gateway", model: "anthropic/claude-sonnet-4.5" }, { env: { AI_GATEWAY_API_KEY: KEY }, fetch, retry: { retries: 0 } });
    assert.equal(p.name, "gateway");
    await p.complete({ system: "s", user: "u" });
    assert.deepEqual(seen, [{ url: "https://ai-gateway.vercel.sh/v1/chat/completions", auth: `Bearer ${KEY}`, model: "anthropic/claude-sonnet-4.5" }]);
    assert.throws(() => providerFromSpec({ provider: "nope" as never, model: "m" }), /"gateway"/);
  });
});

describe("hook-seen gateway routing reaches events", () => {
  it("ingest stamps payload.gateway from SpoolLine.gateway and the session is tagged", async () => {
    const root = mkdtempSync(join(tmpdir(), "csh-gw-ingest-"));
    roots.push(root);
    const env = { CODING_SH_HOME: join(root, "home"), HOME: join(root, "user") };
    const config = defaultConfig(env);
    const dir = join(env.CODING_SH_HOME, "spool", "fake");
    mkdirSync(dir, { recursive: true });
    const adapter: Adapter = {
      id: "fake",
      displayName: "Fake",
      tier: "A",
      detect: async () => ({ installed: true, hooked: true }),
      install: async () => [],
      uninstall: async () => [],
      async normalize(line, ctx) {
        const raw = line.raw as { session: string; kinds: EventKind[] };
        return raw.kinds.map((kind, i): AgentEvent => ({ id: ctx.id("fake", raw.session, line.ts, i), v: 0, sessionId: raw.session, ts: line.ts + i, agent: "fake", kind, payload: {} }));
      },
    };
    const line = (session: string, kinds: string[], gateway?: string, ts = 1_700_000_000_000) => JSON.stringify({ v: 0, agent: "fake", event: "Stop", ts, pid: 1, cwd: root, raw: { session, kinds }, ...(gateway ? { gateway } : {}) }) + "\n";
    appendFileSync(join(dir, "2026-11-06.1.jsonl"), line("routed", ["tool.start", "llm.call", "llm.call"], "vercel") + line("direct", ["tool.start", "llm.call"], undefined, 1_700_000_001_000));
    const index = new MemoryIndexStore();
    const r = await ingest({ config, index, blobs: new MemoryBlobStore(), adapters: new Map([["fake", adapter]]), env });
    assert.deepEqual(r.errors, []);
    const routed = await index.listEvents("routed");
    assert.deepEqual(routed.map((e) => [e.kind, e.payload.gateway]), [
      ["tool.start", "vercel"],
      ["llm.call", "vercel"],
      ["llm.call", "vercel"],
    ]);
    assert.ok((await index.getSession("routed"))!.flags.includes("gateway:vercel"));
    assert.ok(!(await index.getSession("direct"))!.flags.includes("gateway:vercel"));
    assert.ok((await index.listEvents("direct")).every((e) => e.payload.gateway === undefined));
  });
});
