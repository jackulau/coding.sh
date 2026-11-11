// The model driver honours ANTHROPIC_BASE_URL and OPENAI_BASE_URL when the
// driver sets no baseUrl, so a stub (or a gateway) gets the request instead of
// the real provider. Non-loopback sockets are blocked for the whole file.
import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { anthropicConversation } from "../../src/toolevals/model/anthropic.ts";
import { openaiChatConversation, openaiResponsesConversation } from "../../src/toolevals/model/openai.ts";
import type { ConversationInit } from "../../src/toolevals/model/types.ts";
import { blockRemoteSockets } from "../server/_no-remote.ts";
import { startFakeProvider } from "./fixtures/fake-provider.mjs";

const guard = blockRemoteSockets();
after(() => guard.restore());

const saved = { a: process.env.ANTHROPIC_BASE_URL, o: process.env.OPENAI_BASE_URL };
afterEach(() => {
  for (const [k, v] of [["ANTHROPIC_BASE_URL", saved.a], ["OPENAI_BASE_URL", saved.o]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function init(urls: string[]): ConversationInit {
  const f: typeof fetch = (input, i) => {
    urls.push(String(input));
    return fetch(input, i);
  };
  return { model: "fake-model", system: "s", instruction: "hi", tools: [], apiKey: "k", fetch: f };
}

describe("model driver base URL from the environment", () => {
  it("anthropic: ANTHROPIC_BASE_URL is used when the driver has no baseUrl", async () => {
    const p = await startFakeProvider([{ text: "from the stub" }]);
    try {
      process.env.ANTHROPIC_BASE_URL = `${p.url}/`;
      const urls: string[] = [];
      const turn = await anthropicConversation(init(urls)).call();
      assert.equal(turn.text, "from the stub");
      assert.deepEqual(urls, [`${p.url}/v1/messages`]);
      assert.equal(p.requests.length, 1);
      assert.deepEqual(guard.blocked, []);
    } finally {
      await p.close();
    }
  });

  it("anthropic: the driver's baseUrl still wins over the environment", async () => {
    const p = await startFakeProvider([{ text: "driver" }]);
    try {
      process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9/";
      const urls: string[] = [];
      await anthropicConversation({ ...init(urls), baseUrl: p.url }).call();
      assert.deepEqual(urls, [`${p.url}/v1/messages`]);
    } finally {
      await p.close();
    }
  });

  for (const [name, make] of [["responses", openaiResponsesConversation], ["chat", openaiChatConversation]] as const) {
    it(`openai ${name}: OPENAI_BASE_URL is used when the driver has no baseUrl`, async () => {
      const p = await startFakeProvider([{ text: "from the stub" }]);
      try {
        process.env.OPENAI_BASE_URL = `${p.url}/v1`;
        const urls: string[] = [];
        const turn = await make(init(urls)).call();
        assert.equal(turn.text, "from the stub");
        assert.equal(urls.length, 1);
        assert.ok(urls[0]!.startsWith(`${p.url}/v1/`), urls[0]);
        assert.equal(p.requests.length, 1);
        assert.deepEqual(guard.blocked, []);
      } finally {
        await p.close();
      }
    });
  }
});
