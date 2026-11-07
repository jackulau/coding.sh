// Gateway detection: every gateway in the server's registry, by base URL, env
// var, response header and id shape, and the same answers as the server's own
// helpers. End to end, the gateway and its request id land on llm.call as
// payload.gateway / payload.gatewayGenerationId, which the real server turns
// into the `gateway:<name>` session flag and a `gateway enrich` lookup.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { flush, init, observe, observeFetch, withSession } from "../src/index.ts";
import { _reset } from "../src/client.ts";
import { detectGateway, gatewayForUrl } from "../src/gateway.ts";
import { GATEWAY_TABLE } from "../src/gateway-table.ts";
import { GATEWAY_IDS, GATEWAYS, gatewayForId as coreForId, gatewayForUrl as coreForUrl } from "../../coding.sh/src/integrations/gateway/providers.ts";
import { gatewayRequestOf } from "../../coding.sh/src/integrations/gateway/ids.ts";
import { type FakeServe, startFakeServe } from "./helpers/fake-serve.ts";
import { type MockLlm, startMockLlm } from "./helpers/mock-llm.ts";

const VERCEL_ID = "gen_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OPENROUTER_ID = "gen-3bhGkxlo4XFrqiabUM7NDtwDzWwG";
const CF_ID = "0192f4a2-7b1e-7c3d-9a8b-1234567890ab";
const PLAIN = "http://127.0.0.1:9/v1";
const h = (o: Record<string, string>) => new Headers(o);

describe("detectGateway", () => {
  test("the table is the server registry, in order", () => {
    assert.deepEqual(GATEWAY_TABLE.map((g) => g.id), [...GATEWAY_IDS]);
  });

  test("agrees with the server on every host, URL env var and id shape", () => {
    for (const id of GATEWAY_IDS) {
      const g = GATEWAYS[id];
      for (const host of g.hosts) {
        const url = `https://${host.startsWith(".") ? `acme${host}` : host}/v1`;
        assert.equal(gatewayForUrl(url, {}), coreForUrl(url, {}), url);
        assert.equal(gatewayForUrl(url, {}), id, url);
      }
      for (const k of g.urlEnv) {
        const env = { [k]: "http://10.1.2.3:4000" };
        assert.equal(gatewayForUrl("http://10.1.2.3:4000/v1", env), coreForUrl("http://10.1.2.3:4000/v1", env), k);
        assert.equal(gatewayForUrl("http://10.1.2.3:4000/v1", env), id, k);
      }
    }
    for (const rid of [VERCEL_ID, OPENROUTER_ID, "rqsty-cmpl-1234abcd", "chatcmpl-1", "msg_01", "gen_short", "gen-x"]) {
      assert.equal(detectGateway({ responseId: rid, env: {} })?.gateway, coreForId(rid), rid);
    }
  });

  test("hosted gateways by base URL", () => {
    const cases: Record<string, string> = {
      "https://ai-gateway.vercel.sh/v1": "vercel",
      "https://openrouter.ai/api/v1": "openrouter",
      "https://gateway.ai.cloudflare.com/v1/acct/gw/compat": "cloudflare",
      "https://api.portkey.ai/v1": "portkey",
      "https://oai.helicone.ai/v1": "helicone",
      "https://router.requesty.ai/v1": "requesty",
      "https://api.router.com/v1": "ramp",
      "https://gateway.truefoundry.ai": "truefoundry",
      "https://route.withmartian.com/api/openai/v1": "martian",
    };
    for (const [url, want] of Object.entries(cases)) assert.equal(gatewayForUrl(url, {}), want, url);
    for (const url of ["https://api.openai.com/v1", "https://api.anthropic.com", "http://localhost:4000", "", "not a url"]) assert.equal(gatewayForUrl(url, {}), undefined, url);
  });

  test("request id headers and marker headers", () => {
    const cases: [Record<string, string>, { gateway: string; requestId?: string }][] = [
      [{ "x-generation-id": VERCEL_ID }, { gateway: "vercel", requestId: VERCEL_ID }],
      [{ "x-generation-id": OPENROUTER_ID }, { gateway: "openrouter", requestId: OPENROUTER_ID }],
      [{ "x-litellm-call-id": "call-1" }, { gateway: "litellm", requestId: "call-1" }],
      [{ "cf-aig-log-id": CF_ID }, { gateway: "cloudflare", requestId: CF_ID }],
      [{ "x-portkey-trace-id": "trace-1" }, { gateway: "portkey", requestId: "trace-1" }],
      [{ "Helicone-Id": "hel-1" }, { gateway: "helicone", requestId: "hel-1" }],
      [{ "x-kong-request-id": "kong-1" }, { gateway: "kong", requestId: "kong-1" }],
      [{ "x-router-provider": "anthropic" }, { gateway: "ramp" }],
      [{ "x-kong-llm-model": "openai/gpt-5" }, { gateway: "kong" }],
      [{ "x-litellm-response-cost": "0.0012" }, { gateway: "litellm" }],
    ];
    for (const [headers, want] of cases) assert.deepEqual(detectGateway({ url: PLAIN, headers: h(headers), env: {} }), want, JSON.stringify(headers));
    assert.equal(detectGateway({ url: PLAIN, headers: h({ "x-request-id": "req_1" }), env: {} }), undefined);
    assert.equal(detectGateway({ url: PLAIN, headers: h({ "x-generation-id": "abc" }), env: {} }), undefined);
  });

  test("the URL decides, and the id comes from that gateway's header or id shape", () => {
    assert.deepEqual(detectGateway({ url: "https://gateway.ai.cloudflare.com/v1/a/g/compat", headers: h({ "cf-aig-log-id": CF_ID }), responseId: "chatcmpl-1", env: {} }), { gateway: "cloudflare", requestId: CF_ID });
    assert.deepEqual(detectGateway({ url: "https://ai-gateway.vercel.sh/v1", responseId: VERCEL_ID, env: {} }), { gateway: "vercel", requestId: VERCEL_ID });
    assert.deepEqual(detectGateway({ url: "https://ai-gateway.vercel.sh/v1", responseId: "chatcmpl-1", env: {} }), { gateway: "vercel" });
    assert.deepEqual(detectGateway({ url: "https://openrouter.ai/api/v1", headers: h({ "helicone-id": "h1" }), responseId: OPENROUTER_ID, env: {} }), { gateway: "openrouter", requestId: OPENROUTER_ID });
  });
});

describe("model calls through a gateway", () => {
  let llm: MockLlm;
  let serve: FakeServe;

  before(async () => {
    llm = await startMockLlm();
    serve = await startFakeServe();
  });
  after(async () => {
    assert.deepEqual(serve.rejected, [], "the real server parser accepts every SDK event");
    await llm.close();
    await serve.close();
  });
  beforeEach(() => {
    _reset();
    init({ url: serve.url, flushIntervalMs: 10 });
    llm.headers = {};
  });

  const calls = (sid: string) => serve.events().filter((e) => e.sessionId === sid && e.kind === "llm.call");
  const tagged = (sid: string) => calls(sid).map((c) => [c.payload.gateway, c.payload.gatewayGenerationId]);
  const msgs = [{ role: "user" as const, content: "ping" }];

  test("observe(OpenAI): header id on plain, streaming and responses calls; session flag and enrich lookup", async () => {
    llm.headers = { "cf-aig-log-id": CF_ID };
    const openai = observe(new OpenAI({ apiKey: "mock", baseURL: `${llm.url}/v1`, maxRetries: 0 }));
    await withSession("gw-openai", async () => {
      const r = await openai.chat.completions.create({ model: "mock-gpt", messages: msgs });
      assert.equal(r.choices[0]!.message.content, "pong");
      const s = await openai.chat.completions.create({ model: "mock-gpt", messages: msgs, stream: true });
      for await (const _ of s) void _;
      await openai.responses.create({ model: "mock-gpt", input: "ping" });
      // withResponse() still works and sees the same headers.
      const { response } = await openai.chat.completions.create({ model: "mock-gpt", messages: msgs }).withResponse();
      assert.equal(response.headers.get("cf-aig-log-id"), CF_ID);
    });
    await flush();
    assert.deepEqual(tagged("gw-openai"), Array(4).fill(["cloudflare", CF_ID]));
    assert.ok(serve.session("gw-openai")!.flags?.includes("gateway:cloudflare"));
    assert.deepEqual(gatewayRequestOf(calls("gw-openai")[0]!), { gateway: "cloudflare", id: CF_ID });
  });

  test("observe(Anthropic): create, stream and the stream() helper", async () => {
    llm.headers = { "x-portkey-trace-id": "pk-1" };
    const anthropic = observe(new Anthropic({ apiKey: "mock", baseURL: llm.url, maxRetries: 0 }));
    await withSession("gw-anthropic", async () => {
      await anthropic.messages.create({ model: "mock-claude", max_tokens: 8, messages: msgs });
      const s = await anthropic.messages.create({ model: "mock-claude", max_tokens: 8, messages: msgs, stream: true });
      for await (const _ of s) void _;
      await anthropic.messages.stream({ model: "mock-claude", max_tokens: 8, messages: msgs }).finalMessage();
    });
    await flush();
    assert.deepEqual(tagged("gw-anthropic"), Array(3).fill(["portkey", "pk-1"]));
    assert.ok(serve.session("gw-anthropic")!.flags?.includes("gateway:portkey"));
  });

  test("observeFetch: header id, and a self-hosted gateway named by its URL env var", async () => {
    const f = observeFetch();
    const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    llm.headers = { "helicone-id": "hel-9" };
    await withSession("gw-fetch", async () => {
      const r = await f(`${llm.url}/v1/chat/completions`, post({ model: "mock-gpt", messages: msgs, stream: true }));
      await r.text();
    });
    llm.headers = { "x-litellm-call-id": "call-42" };
    process.env.LITELLM_PROXY_API_BASE = llm.url;
    try {
      await withSession("gw-litellm", async () => {
        const r = await f(`${llm.url}/v1/messages`, post({ model: "mock-claude", max_tokens: 8, messages: msgs }));
        await r.json();
      });
    } finally {
      delete process.env.LITELLM_PROXY_API_BASE;
    }
    await flush();
    assert.deepEqual(tagged("gw-fetch"), [["helicone", "hel-9"]]);
    assert.deepEqual(tagged("gw-litellm"), [["litellm", "call-42"]]);
    assert.ok(serve.session("gw-litellm")!.flags?.includes("gateway:litellm"));
  });

  test("no gateway: no gateway fields, no flag", async () => {
    const openai = observe(new OpenAI({ apiKey: "mock", baseURL: `${llm.url}/v1`, maxRetries: 0 }));
    await withSession("gw-none", () => openai.chat.completions.create({ model: "mock-gpt", messages: msgs }));
    await flush();
    const [c] = calls("gw-none");
    assert.equal(c!.payload.gateway, undefined);
    assert.equal(c!.payload.gatewayGenerationId, undefined);
    assert.ok(!serve.session("gw-none")!.flags?.some((f) => f.startsWith("gateway:")));
  });
});
