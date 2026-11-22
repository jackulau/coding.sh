// Gemini as a judge provider: providerFromSpec({provider: "gemini"}) calls Google's
// OpenAI-compatible endpoint with GEMINI_API_KEY, and the monitor picks it from the key.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { DEFAULT_MODELS } from "../../src/core/pricing.ts";
import { DEFAULT_GEMINI_MODEL, providerFromSpec } from "../../src/graders/index.ts";
import { judgeProviderKind } from "../../src/monitor/run.ts";
import { MONITOR_PROVIDERS } from "../../src/monitor/state.ts";

const reply = (content: string, model = "gemini-test") => JSON.stringify({ model, choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3 } });

describe("gemini provider", () => {
  it("POSTs to the v1beta/openai chat completions endpoint with a bearer key and the google default model", async () => {
    const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
    const fetch = async (url: string, init: RequestInit) => {
      calls.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
      return new Response(reply('{"score":1}'));
    };
    const p = providerFromSpec({ provider: "gemini" }, { env: { GEMINI_API_KEY: "k" }, fetch });
    assert.equal(p.name, "gemini");
    assert.equal(p.model, DEFAULT_GEMINI_MODEL);
    assert.equal(DEFAULT_GEMINI_MODEL, DEFAULT_MODELS.google);
    const r = await p.complete({ system: "s", user: "u" });
    assert.equal(r.text, '{"score":1}');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    assert.equal(calls[0]!.headers.get("authorization"), "Bearer k");
    assert.equal(calls[0]!.body.model, DEFAULT_GEMINI_MODEL);
  });

  it("a missing GEMINI_API_KEY is an error that names it, and no request is sent", async () => {
    let sent = 0;
    const fetch = async () => (sent++, new Response(reply("x")));
    await assert.rejects(providerFromSpec({ provider: "gemini" }, { env: {}, fetch }).complete({ system: "", user: "" }), /GEMINI_API_KEY/);
    assert.equal(sent, 0);
  });

  describe("against a local listener", () => {
    let server: Server;
    let base = "";
    const seen: { url: string; auth: string | undefined; body: Record<string, unknown> }[] = [];
    before(async () => {
      server = createServer((req, res) => {
        let s = "";
        req.on("data", (d) => (s += d));
        req.on("end", () => {
          seen.push({ url: req.url ?? "", auth: req.headers.authorization, body: JSON.parse(s) });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(reply('{"score":0.5}', String(JSON.parse(s).model)));
        });
      });
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1beta/openai`;
    });
    after(() => new Promise<void>((done) => server.close(() => done())));

    it("takes baseURL, apiKeyEnv and model from the spec", async () => {
      const p = providerFromSpec({ provider: "gemini", baseURL: base, apiKeyEnv: "MY_GEMINI", model: "gemini-other" }, { env: { MY_GEMINI: "k2" } });
      const r = await p.complete({ system: "s", user: "u" });
      assert.equal(r.text, '{"score":0.5}');
      assert.equal(r.model, "gemini-other");
      assert.deepEqual(r.usage, { inputTokens: 12, outputTokens: 3 });
      assert.equal(seen.length, 1);
      assert.equal(seen[0]!.url, "/v1beta/openai/chat/completions");
      assert.equal(seen[0]!.auth, "Bearer k2");
      assert.equal(seen[0]!.body.model, "gemini-other");
    });
  });

  it("a monitor may name gemini, and picks it when only GEMINI_API_KEY is set", () => {
    assert.ok((MONITOR_PROVIDERS as readonly string[]).includes("gemini"));
    assert.equal(judgeProviderKind({}, { GEMINI_API_KEY: "k" }), "gemini");
    assert.equal(judgeProviderKind({ provider: "gemini" }, { GEMINI_API_KEY: "k" }), "gemini");
    assert.equal(judgeProviderKind({ provider: "gemini" }, { ANTHROPIC_API_KEY: "k" }), undefined);
    // Gemini is the last choice: another key that is set wins.
    assert.equal(judgeProviderKind({}, { GEMINI_API_KEY: "k", OPENAI_API_KEY: "k" }), "openai");
  });
});
