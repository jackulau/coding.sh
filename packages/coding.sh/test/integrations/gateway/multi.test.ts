// Gateways other than Vercel: detection, config, lookups (stubbed fetch, no
// network), enrich, OTLP spans and compare routes.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { parseArgs } from "../../../src/cli/args.ts";
import { buildSession } from "../../../src/core/sessions.ts";
import { allGatewayConfigs, cloudflareIdsFromUrl, defaultGateway, detectGatewaySetups, gatewayConfig } from "../../../src/integrations/gateway/config.ts";
import { enrichSessions, genCacheKey } from "../../../src/integrations/gateway/enrich.ts";
import { gatewayFromEnv, gatewayOfEvent, gatewayRequestOf, isGatewayEvent } from "../../../src/integrations/gateway/ids.ts";
import { createCloudflareClient, createHeliconeClient, createLiteLLMClient, createOpenRouterClient, createPortkeyClient, lookupClient } from "../../../src/integrations/gateway/lookups.ts";
import { gatewayForId, gatewayForUrl, resolveGatewayName } from "../../../src/integrations/gateway/providers.ts";
import { routableAgents, routeVia } from "../../../src/integrations/gateway/route.ts";
import { decodeTraceJson } from "../../../src/otel/json.ts";
import { mapTraces, TraceSessionMap } from "../../../src/otel/map.ts";
import { defaultEnricher } from "../../../src/otel/receiver.ts";
import type { AgentEvent } from "../../../src/schema/index.ts";
import { MemoryIndexStore } from "../../../src/store/memory.ts";
import { MemBlobs } from "../../otel/_memstore.ts";
import { iAttr, otlpSpan, sAttr } from "../../otel/_encode.ts";
import { GEN_ID } from "./_fixtures.ts";
import { CF_ACCOUNT, CF_LOG, cloudflareLog, HELICONE_REQ, heliconeRequest, LITELLM_CALL, liteLLMSpendLogs, OR_GEN, OR_GEN_2, openRouterCredits, openRouterGeneration, PORTKEY_LOG, portkeyLog, stubFetch } from "./_multi.ts";

const KEY = "sk-or-v1-" + "0".repeat(48);
const NO_RETRY = { retries: 0 };
const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
const tmp = () => {
  const r = mkdtempSync(join(tmpdir(), "csh-gwm-"));
  roots.push(r);
  return r;
};

const ev = (over: Partial<AgentEvent> & { payload?: Record<string, unknown> }): AgentEvent => ({ id: `e${Math.random()}`, v: 0, sessionId: "s1", ts: 1000, agent: "codex", kind: "llm.call", payload: {}, ...over });

describe("gateway registry: hosts, ids, providers", () => {
  it("maps base URLs to gateways by host, and self-hosted ones by their URL env var", () => {
    assert.equal(gatewayForUrl("https://openrouter.ai/api/v1"), "openrouter");
    assert.equal(gatewayForUrl("https://openrouter.ai.evil.example/api"), undefined);
    assert.equal(gatewayForUrl(`https://gateway.ai.cloudflare.com/v1/${CF_ACCOUNT}/prod/openai`), "cloudflare");
    assert.equal(gatewayForUrl("https://ai-gateway.helicone.ai"), "helicone");
    assert.equal(gatewayForUrl("https://api.portkey.ai/v1"), "portkey");
    assert.equal(gatewayForUrl("https://router.requesty.ai/v1"), "requesty");
    assert.equal(gatewayForUrl("https://api.router.com/v1"), "ramp");
    assert.equal(gatewayForUrl("http://localhost:4000"), undefined);
    assert.equal(gatewayForUrl("http://localhost:4000", { LITELLM_PROXY_API_BASE: "http://localhost:4000" }), "litellm");
    assert.equal(gatewayForUrl("https://ai-gateway.vercel.sh/v1"), "vercel");
  });

  it("tells Vercel gen_ ids from OpenRouter gen- and Requesty rqsty- ids", () => {
    assert.equal(gatewayForId(GEN_ID), "vercel");
    assert.equal(gatewayForId(OR_GEN), "openrouter");
    assert.equal(gatewayForId(OR_GEN_2), "openrouter");
    assert.equal(gatewayForId("rqsty-cmpl-d08922e2-1b2c-4d5e"), "requesty");
    assert.equal(gatewayForId("chatcmpl-abc"), undefined);
    assert.equal(resolveGatewayName("router.com"), "ramp");
    assert.equal(resolveGatewayName("OpenRouter"), "openrouter");
  });

  it("the hook env names the gateway; Vercel wins when several are set", () => {
    assert.equal(gatewayFromEnv({ OPENAI_BASE_URL: "https://openrouter.ai/api/v1" }), "openrouter");
    assert.equal(gatewayFromEnv({ ANTHROPIC_BASE_URL: "http://127.0.0.1:4000", LITELLM_PROXY_URL: "http://127.0.0.1:4000" }), "litellm");
    assert.equal(gatewayFromEnv({ OPENAI_BASE_URL: "https://openrouter.ai/api/v1", ANTHROPIC_BASE_URL: "https://ai-gateway.vercel.sh/claude-code" }), "vercel");
  });

  it("tags sessions gateway:<id> per gateway and keeps Vercel detection as it was", () => {
    assert.equal(gatewayOfEvent(ev({ payload: { responseId: OR_GEN } })), "openrouter");
    assert.equal(gatewayOfEvent(ev({ payload: { provider: "openrouter" } })), "openrouter");
    assert.equal(gatewayOfEvent(ev({ model: "openrouter/anthropic/claude-sonnet-4.5" })), "openrouter");
    assert.equal(gatewayOfEvent(ev({ kind: "tool.start", payload: { gateway: "litellm" } })), "litellm");
    assert.equal(gatewayOfEvent(ev({ payload: { responseId: GEN_ID } })), "vercel");
    assert.ok(!isGatewayEvent(ev({ payload: { gateway: "openrouter", provider: "openrouter" } })));
    const s = buildSession([ev({ payload: { responseId: OR_GEN } }), ev({ payload: { gateway: "litellm", gatewayGenerationId: LITELLM_CALL } }), ev({ payload: { responseId: GEN_ID } })]);
    assert.deepEqual(s.flags.filter((f) => f.startsWith("gateway:")), ["gateway:vercel", "gateway:openrouter", "gateway:litellm"]);
    assert.deepEqual(gatewayRequestOf(ev({ payload: { gateway: "litellm", gatewayGenerationId: LITELLM_CALL } })), { gateway: "litellm", id: LITELLM_CALL });
  });
});

describe("gateway config ([gateway.<name>], standard env vars)", () => {
  const base = () => {
    const home = tmp();
    const data = join(home, ".coding.sh");
    mkdirSync(data, { recursive: true });
    return { home, data, env: { HOME: home, CODING_SH_HOME: data } as NodeJS.ProcessEnv };
  };

  it("reads each gateway's standard env var, then [gateway.<name>]", () => {
    const { data, env } = base();
    const or = gatewayConfig("openrouter", { ...env, OPENROUTER_API_KEY: KEY });
    assert.equal(or.apiKey, KEY);
    assert.equal(or.keySource, "env OPENROUTER_API_KEY");
    assert.equal(or.baseUrl, "https://openrouter.ai/api/v1");
    // LiteLLM: LITELLM_PROXY_API_KEY, then LITELLM_API_KEY / LITELLM_MASTER_KEY; URL from LITELLM_PROXY_API_BASE.
    const ll = gatewayConfig("litellm", { ...env, LITELLM_MASTER_KEY: "sk-master-1", LITELLM_PROXY_API_BASE: "http://127.0.0.1:4000/" });
    assert.deepEqual([ll.apiKeyEnv, ll.keySource, ll.baseUrl], ["LITELLM_MASTER_KEY", "env LITELLM_MASTER_KEY", "http://127.0.0.1:4000"]);
    writeFileSync(join(data, "config.toml"), '[gateway]\ndefault = "openrouter"\n\n[gateway.openrouter]\napiKeyEnv = "MY_OR"\n\n[gateway.cloudflare]\napiKey = "${CF_TOKEN}"\ngatewayId = "prod"\n');
    assert.equal(gatewayConfig("openrouter", { ...env, MY_OR: "k-mine", OPENROUTER_API_KEY: "ignored" }).apiKey, "k-mine");
    const cf = gatewayConfig("cloudflare", { ...env, CF_TOKEN: "cf-token-1", CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT });
    assert.deepEqual([cf.apiKey, cf.keySource, cf.accountId, cf.gatewayId, cf.configured], ["cf-token-1", "config gateway.cloudflare.apiKey", CF_ACCOUNT, "prod", true]);
    assert.equal(defaultGateway(env), "openrouter");
    // Vercel's [gateway] scalars are untouched by the sub-tables.
    assert.equal(gatewayConfig("vercel", env).apiKeyEnv, "AI_GATEWAY_API_KEY");
  });

  it("Cloudflare account and gateway come from a gateway.ai.cloudflare.com base URL too", () => {
    const { env } = base();
    const url = `https://gateway.ai.cloudflare.com/v1/${CF_ACCOUNT}/my-gw/anthropic`;
    assert.deepEqual(cloudflareIdsFromUrl(url), { accountId: CF_ACCOUNT, gatewayId: "my-gw" });
    const cf = gatewayConfig("cloudflare", { ...env, ANTHROPIC_BASE_URL: url });
    assert.deepEqual([cf.accountId, cf.gatewayId], [CF_ACCOUNT, "my-gw"]);
  });

  it("--gateway without a name: Vercel when its key is set, else the one other gateway with a key", () => {
    const { env } = base();
    assert.equal(defaultGateway(env), "vercel");
    assert.equal(defaultGateway({ ...env, OPENROUTER_API_KEY: KEY }), "openrouter");
    assert.equal(defaultGateway({ ...env, OPENROUTER_API_KEY: KEY, AI_GATEWAY_API_KEY: "vck" }), "vercel");
    assert.equal(defaultGateway({ ...env, OPENROUTER_API_KEY: KEY, HELICONE_API_KEY: "h" }), "vercel");
    assert.ok(!JSON.stringify(allGatewayConfigs({ ...env, OPENROUTER_API_KEY: KEY }).map(({ apiKey: _k, ...rest }) => rest)).includes(KEY));
  });

  it("finds OpenRouter and LiteLLM routing in agent configs without reading key values", () => {
    const home = tmp();
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://openrouter.ai/api", ANTHROPIC_AUTH_TOKEN: KEY } }));
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), ['model_provider = "litellm"', "", "[model_providers.litellm]", 'base_url = "http://127.0.0.1:4000/v1"', 'env_key = "LITELLM_PROXY_API_KEY"', ""].join("\n"));
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(join(home, ".config", "opencode", "opencode.json"), JSON.stringify({ model: "openrouter/anthropic/claude-sonnet-4.5" }));
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ defaultProvider: "openrouter" }));
    const env = { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), LITELLM_PROXY_URL: "http://127.0.0.1:4000" };
    const found = detectGatewaySetups(env);
    assert.deepEqual(found.map((f) => `${f.agent}:${f.gateway}`).sort(), ["claude-code:openrouter", "codex:litellm", "opencode:openrouter", "pi:openrouter"]);
    assert.ok(!JSON.stringify(found).includes(KEY));
  });
});

describe("gateway lookups (documented shapes, stubbed fetch)", () => {
  it("OpenRouter: GET /generation?id= and /credits with the bearer key", async () => {
    const s = stubFetch({ [`/api/v1/generation?id=${OR_GEN}`]: [200, openRouterGeneration()], "/api/v1/credits": [200, openRouterCredits] });
    const c = createOpenRouterClient({ baseUrl: "https://openrouter.ai/api/v1", apiKey: KEY, fetch: s.fetch, retry: NO_RETRY });
    const r = await c.generation(OR_GEN);
    if (r.status !== "ok") return assert.fail("expected a record");
    assert.deepEqual([r.info.totalCostUsd, r.info.provider, r.info.model, r.info.promptTokens, r.info.isByok], [0.0015, "Infermatic", "sao10k/l3-stheno-8b", 10, false]);
    assert.equal(s.calls[0]!.headers.authorization, `Bearer ${KEY}`);
    assert.deepEqual(await c.credits(), { balanceUsd: 37.5, totalUsedUsd: 12.5 });
    assert.deepEqual(await c.generation(OR_GEN_2), { status: "pending" }, "404: not ingested yet");
  });

  it("LiteLLM: GET /spend/logs?request_id= returns a list; spend is USD", async () => {
    const s = stubFetch({ [`/spend/logs?request_id=${LITELLM_CALL}`]: [200, liteLLMSpendLogs()], "/spend/logs?request_id=none": [200, []] });
    const c = createLiteLLMClient({ baseUrl: "http://127.0.0.1:4000", apiKey: "sk-master-1", fetch: s.fetch, retry: NO_RETRY });
    const r = await c.generation(LITELLM_CALL);
    if (r.status !== "ok") return assert.fail("expected a record");
    assert.deepEqual([r.info.totalCostUsd, r.info.provider, r.info.generationMs, r.info.completionTokens], [0.0042, "anthropic", 2500, 100]);
    assert.ok(!JSON.stringify(r.info).includes("88dc28d0"), "hashed key is not kept");
    assert.deepEqual(await c.generation("none"), { status: "pending" });
  });

  it("Cloudflare: GET /accounts/{a}/ai-gateway/gateways/{g}/logs/{id}", async () => {
    const path = `/client/v4/accounts/${CF_ACCOUNT}/ai-gateway/gateways/prod/logs/${CF_LOG}`;
    const s = stubFetch({ [path]: [200, cloudflareLog()] });
    const c = createCloudflareClient({ baseUrl: "https://api.cloudflare.com/client/v4", apiKey: "cf-token-1", accountId: CF_ACCOUNT, gatewayId: "prod", fetch: s.fetch, retry: NO_RETRY });
    const r = await c.generation(CF_LOG);
    if (r.status !== "ok") return assert.fail("expected a record");
    assert.deepEqual([r.info.totalCostUsd, r.info.provider, r.info.promptTokens, r.info.completionTokens, r.info.generationMs], [0.00031, "openai", 500, 80, 1800]);
    assert.equal(new URL(s.calls[0]!.url).pathname, path);
  });

  it("Helicone: GET /v1/request/{id} uses costUSD; Portkey: GET /logs/{id} converts cents", async () => {
    const h = stubFetch({ [`/v1/request/${HELICONE_REQ}?includeBody=false`]: [200, heliconeRequest()] });
    const hr = await createHeliconeClient({ baseUrl: "https://api.helicone.ai", apiKey: "sk-helicone-1", fetch: h.fetch, retry: NO_RETRY }).generation(HELICONE_REQ);
    if (hr.status !== "ok") return assert.fail("expected a record");
    assert.deepEqual([hr.info.totalCostUsd, hr.info.provider, hr.info.model, hr.info.cachedTokens], [0.0021, "openai", "gpt-5-2025-08-07", 512]);
    const p = stubFetch({ [`/v1/logs/${PORTKEY_LOG}`]: [200, portkeyLog()] });
    const pr = await createPortkeyClient({ baseUrl: "https://api.portkey.ai/v1", apiKey: "pk-1", fetch: p.fetch, retry: NO_RETRY }).generation(PORTKEY_LOG);
    if (pr.status !== "ok") return assert.fail("expected a record");
    assert.deepEqual([pr.info.totalCostUsd, pr.info.provider, pr.info.promptTokens], [0.0035, "anthropic", 700]);
    assert.equal(p.calls[0]!.headers["x-portkey-api-key"], "pk-1");
    assert.equal(p.calls[0]!.headers.authorization, undefined);
  });

  it("scrubs the key from errors and says what is missing when no client can be built", async () => {
    const s = stubFetch({ [`/api/v1/generation?id=${OR_GEN}`]: [500, { error: { message: `boom ${KEY}` } }] });
    const c = createOpenRouterClient({ baseUrl: "https://openrouter.ai/api/v1", apiKey: KEY, fetch: s.fetch, retry: NO_RETRY });
    await assert.rejects(c.generation(OR_GEN), (e: Error) => !e.message.includes(KEY));
    const env = { HOME: tmp() };
    assert.deepEqual(lookupClient(gatewayConfig("openrouter", env)), { missing: "key", detail: "export OPENROUTER_API_KEY=…" });
    assert.equal((lookupClient(gatewayConfig("cloudflare", { ...env, CLOUDFLARE_API_TOKEN: "t" })) as { missing: string }).missing, "config");
    assert.equal((lookupClient(gatewayConfig("requesty", { ...env, REQUESTY_API_KEY: "r" })) as { missing: string }).missing, "none");
  });
});

describe("gateway enrich across gateways", () => {
  const call = (sessionId: string, i: number, payload: Record<string, unknown>, costUsd?: number): AgentEvent => ({
    id: `${sessionId}-call-${i}`,
    v: 0,
    sessionId,
    ts: 1_767_225_600_000 + i * 1000,
    agent: "codex",
    kind: "llm.call",
    source: "transcript",
    model: "anthropic/claude-sonnet-4.5",
    usage: { inputTokens: 100, outputTokens: 10, ...(costUsd !== undefined ? { costUsd } : {}) },
    payload,
  });
  const start = (sessionId: string): AgentEvent => ({ id: `${sessionId}-start`, v: 0, sessionId, ts: 1_767_225_599_000, agent: "codex", kind: "session.start", source: "transcript", payload: {} });
  async function store(events: AgentEvent[]) {
    const index = new MemoryIndexStore();
    await index.putEvents(events);
    for (const id of new Set(events.map((e) => e.sessionId))) await index.upsertSession(buildSession(await index.listEvents(id)));
    return index;
  }

  it("links OpenRouter gen- ids and LiteLLM call ids, looks each up with its own client, caches per gateway", async () => {
    const index = await store([
      start("m"),
      call("m", 1, { responseId: OR_GEN }, 0.001),
      call("m", 2, { gateway: "litellm", gatewayGenerationId: LITELLM_CALL }),
      call("m", 3, { responseId: "rqsty-cmpl-d08922e2-1b2c-4d5e", billedCostUsd: 0.0007, servedProvider: "anthropic" }),
      call("m", 4, { responseId: "rqsty-cmpl-aaaaaaaa-1b2c-4d5e" }),
      call("m", 5, { responseId: GEN_ID }),
    ]);
    const or = stubFetch({ [`/api/v1/generation?id=${OR_GEN}`]: [200, openRouterGeneration()] });
    const ll = stubFetch({ [`/spend/logs?request_id=${LITELLM_CALL}`]: [200, liteLLMSpendLogs()] });
    const clients = {
      openrouter: createOpenRouterClient({ baseUrl: "https://openrouter.ai/api/v1", apiKey: KEY, fetch: or.fetch, retry: NO_RETRY }),
      litellm: createLiteLLMClient({ baseUrl: "http://127.0.0.1:4000", apiKey: "sk-master-1", fetch: ll.fetch, retry: NO_RETRY }),
    };
    const sessions = await index.listSessions();
    const r = await enrichSessions({ index, sessions, clients });
    assert.deepEqual({ linkable: r.linkable, enriched: r.enriched, fetched: r.fetched, needKey: r.needKey, noLookup: r.noLookup }, { linkable: 5, enriched: 3, fetched: 2, needKey: 1, noLookup: 1 });
    assert.deepEqual(r.needKeyBy, { vercel: 1 });
    assert.deepEqual(r.byGateway, { openrouter: 1, litellm: 1, requesty: 1 });
    assert.equal(r.billedUsd, 0.0064);
    const gen = (await index.listEvents("m")).filter((e) => e.source === "gateway");
    const orEv = gen.find((e) => e.parentId === "m-call-1")!;
    assert.deepEqual([orEv.payload.name, orEv.payload.gateway, orEv.payload.provider, orEv.usage?.costUsd], ["openrouter.generation", "openrouter", "Infermatic", 0.0005]);
    assert.equal(gen.find((e) => e.parentId === "m-call-2")!.payload.gateway, "litellm");
    assert.equal(gen.find((e) => e.parentId === "m-call-3")!.usage?.costUsd, 0.0007, "in-band cost when there is no lookup API");
    assert.ok(await index.kvGet(genCacheKey(OR_GEN, "openrouter")));
    assert.equal(await index.kvGet(genCacheKey(OR_GEN)), undefined, "cache keys are per gateway");
    const s = (await index.getSession("m"))!;
    assert.ok(["gateway:vercel", "gateway:openrouter", "gateway:litellm", "gateway:requesty"].every((f) => s.flags.includes(f)));

    // --gateway openrouter: only OpenRouter calls are looked at, and they are done.
    const again = await enrichSessions({ index, sessions: await index.listSessions(), clients, only: "openrouter" });
    assert.deepEqual({ linkable: again.linkable, already: again.alreadyEnriched, needKey: again.needKey }, { linkable: 1, already: 1, needKey: 0 });
  });
});

describe("OTLP spans from other gateways", () => {
  async function mapExport(body: unknown): Promise<AgentEvent[]> {
    const blobs = new MemBlobs();
    const r = await mapTraces(decodeTraceJson(body), { maxInlineBytes: 4096, blob: (d) => blobs.put(d), traceSessions: new TraceSessionMap(), enrichSpan: defaultEnricher });
    assert.deepEqual(r.errors, []);
    return r.events;
  }
  const exportOf = (service: string, attrs: unknown[]) => ({
    resourceSpans: [{ resource: { attributes: [sAttr("service.name", service)] }, scopeSpans: [{ scope: { name: "x" }, spans: [otlpSpan("cc000000000000000000000000000001", "3000000000000001", undefined, "chat gpt-5", attrs as never, 0, 1000)] }] }],
  });
  const dAttr = (key: string, v: number) => ({ key, value: { doubleValue: v } });
  const genAi = [sAttr("gen_ai.operation.name", "chat"), sAttr("gen_ai.request.model", "gpt-5"), iAttr("gen_ai.usage.input_tokens", 50), iAttr("gen_ai.usage.output_tokens", 5)];

  it("LiteLLM proxy spans: litellm.call_id, gen_ai.cost.total_cost and the upstream provider", async () => {
    const evs = await mapExport(exportOf("litellm-proxy", [...genAi, sAttr("gen_ai.provider.name", "openai"), sAttr("litellm.call_id", LITELLM_CALL), dAttr("gen_ai.cost.total_cost", 0.0009)]));
    const c = evs.find((e) => e.kind === "llm.call")!;
    assert.deepEqual([c.payload.gateway, c.payload.gatewayGenerationId, c.payload.servedProvider, c.payload.billedCostUsd, c.usage?.costUsd], ["litellm", LITELLM_CALL, "openai", 0.0009, 0.0009]);
    assert.ok(buildSession(evs).flags.includes("gateway:litellm"));
  });

  it("Cloudflare's exporter (gen_ai.prompt_json, gen_ai.usage.cost) and Portkey's (service.name portkey)", async () => {
    const cf = (await mapExport(exportOf("unknown", [...genAi, sAttr("gen_ai.model.provider", "openai"), sAttr("gen_ai.prompt_json", "[]"), dAttr("gen_ai.usage.cost", 0.0004)]))).find((e) => e.kind === "llm.call")!;
    assert.deepEqual([cf.payload.gateway, cf.payload.servedProvider, cf.usage?.costUsd], ["cloudflare", "openai", 0.0004]);
    const pk = (await mapExport(exportOf("portkey", [...genAi, sAttr("gen_ai.provider.name", "anthropic"), dAttr("portkey.usage.cost", 0.02), sAttr("portkey.usage.cost_currency", "USD")]))).find((e) => e.kind === "llm.call")!;
    assert.deepEqual([pk.payload.gateway, pk.payload.servedProvider, pk.payload.gatewayCost, pk.usage?.costUsd], ["portkey", "anthropic", 0.02, undefined]);
  });

  it("app spans that called OpenRouter: AI SDK provider metadata, or server.address", async () => {
    const meta = { openrouter: { provider: "Anthropic", usage: { promptTokens: 50, completionTokens: 5, cost: 0.0011 } } };
    const sdk = (await mapExport(exportOf("my-app", [sAttr("ai.operationId", "ai.generateText.doGenerate"), sAttr("ai.model.provider", "openrouter.chat"), sAttr("ai.model.id", "anthropic/claude-sonnet-4.5"), sAttr("ai.response.id", OR_GEN), sAttr("ai.response.providerMetadata", JSON.stringify(meta)), ...genAi]))).find((e) => e.kind === "llm.call")!;
    assert.deepEqual([sdk.payload.gateway, sdk.payload.gatewayGenerationId, sdk.payload.servedProvider, sdk.usage?.costUsd], ["openrouter", OR_GEN, "Anthropic", 0.0011]);
    const plain = (await mapExport(exportOf("my-app", [...genAi, sAttr("gen_ai.provider.name", "openai"), sAttr("server.address", "openrouter.ai"), sAttr("gen_ai.response.id", OR_GEN_2)]))).find((e) => e.kind === "llm.call")!;
    assert.deepEqual([plain.payload.gateway, plain.payload.gatewayGenerationId], ["openrouter", OR_GEN_2]);
    const direct = (await mapExport(exportOf("my-app", [...genAi, sAttr("gen_ai.provider.name", "openai"), sAttr("server.address", "api.openai.com")]))).find((e) => e.kind === "llm.call")!;
    assert.equal(direct.payload.gateway, undefined);
  });
});

describe("compare routes through other gateways", () => {
  const cfg = (id: "openrouter" | "litellm" | "ramp", extra: NodeJS.ProcessEnv = {}) => gatewayConfig(id, { HOME: tmp(), OPENROUTER_API_KEY: KEY, LITELLM_PROXY_API_KEY: "sk-ll", RAMP_ROUTER_API_KEY: "rr-1", ...extra });

  it("OpenRouter: Anthropic skin for Claude Code, Responses for Codex, built-in providers for OpenCode and Pi", () => {
    const c = cfg("openrouter");
    assert.deepEqual(routableAgents("openrouter"), ["claude-code", "codex", "opencode", "pi"]);
    const cc = routeVia(c, "claude-code", "claude-sonnet-4.5");
    assert.deepEqual(cc.env, { ANTHROPIC_BASE_URL: "https://openrouter.ai/api", ANTHROPIC_AUTH_TOKEN: KEY, ANTHROPIC_API_KEY: "" });
    assert.equal(cc.model, "anthropic/claude-sonnet-4.5");
    const cx = routeVia(c, "codex", "gpt-5");
    assert.ok(cx.flags.includes('model_providers.openrouter.base_url="https://openrouter.ai/api/v1"'));
    assert.ok(cx.flags.includes('model_providers.openrouter.wire_api="responses"'));
    assert.deepEqual([cx.env, cx.model], [{ OPENROUTER_API_KEY: KEY }, "openai/gpt-5"]);
    assert.equal(routeVia(c, "opencode", "gemini-2.5-pro").model, "openrouter/google/gemini-2.5-pro");
    assert.deepEqual(routeVia(c, "pi", "grok-4").flags, ["--provider", "openrouter"]);
  });

  it("LiteLLM uses the proxy URL and leaves model names alone; Ramp Router has fixed endpoints; others are refused", () => {
    assert.throws(() => routeVia(cfg("litellm"), "claude-code", "x"), /needs its URL/);
    const ll = cfg("litellm", { LITELLM_PROXY_API_BASE: "http://127.0.0.1:4000/v1" });
    assert.deepEqual(routeVia(ll, "claude-code", "claude-sonnet").env.ANTHROPIC_BASE_URL, "http://127.0.0.1:4000");
    assert.equal(routeVia(ll, "codex", "my-group").model, "my-group");
    assert.ok(routeVia(ll, "codex", "m").flags.includes('model_providers.litellm.base_url="http://127.0.0.1:4000/v1"'));
    assert.throws(() => routeVia(ll, "opencode", "m"), /no LiteLLM proxy route for agent "opencode" \(supported: claude-code, codex\)/);
    assert.equal(routeVia(cfg("ramp"), "claude-code", "m").env.ANTHROPIC_BASE_URL, "https://api.router.com");
    assert.deepEqual(routableAgents("helicone"), []);
  });

  it("parses --gateway with and without a name", () => {
    const spec = [{ name: "gateway", type: "string" as const, optionalValue: true, choices: ["vercel", "openrouter"], desc: "" }];
    assert.deepEqual(parseArgs(["a", "b", "--gateway"], spec), { flags: { gateway: true }, positionals: ["a", "b"], rest: [], sawDashDash: false });
    assert.equal(parseArgs(["a", "b", "--gateway", "openrouter"], spec).flags.gateway, "openrouter");
    assert.deepEqual(parseArgs(["--gateway", "a", "b"], spec).positionals, ["a", "b"]);
    assert.equal(parseArgs(["--gateway=openrouter"], spec).flags.gateway, "openrouter");
    assert.throws(() => parseArgs(["--gateway=nope"], spec), /must be one of vercel, openrouter/);
  });
});
