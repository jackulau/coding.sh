// The gateway tag follows the base URL the agent sends its calls to: a gateway's
// URL variable that is set marks a call only when it names the same host and port.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { gatewayForUrl } from "../../../src/integrations/gateway/providers.ts";

describe("gatewayForUrl with gateway URL variables set", () => {
  test("a call to CLIProxyAPI's port is CLIProxyAPI's, though LiteLLM's variable names the same host", () => {
    assert.equal(gatewayForUrl("http://127.0.0.1:8317", { LITELLM_BASE_URL: "http://127.0.0.1:4000" }), "cliproxyapi");
  });

  test("a call to another port on the host a variable names is no gateway's", () => {
    assert.equal(gatewayForUrl("http://127.0.0.1:3000", { CLIPROXYAPI_URL: "http://127.0.0.1:8317" }), undefined);
    assert.equal(gatewayForUrl("http://127.0.0.1:3000/v1", { LITELLM_BASE_URL: "http://127.0.0.1:4000" }), undefined);
  });

  test("the same host and port (paths aside, default ports filled in) still match", () => {
    assert.equal(gatewayForUrl("http://127.0.0.1:4000/anthropic", { LITELLM_BASE_URL: "http://127.0.0.1:4000" }), "litellm");
    assert.equal(gatewayForUrl("https://llm.internal/v1", { LITELLM_BASE_URL: "https://llm.internal:443" }), "litellm");
    assert.equal(gatewayForUrl("http://llm.internal/v1", { LITELLM_BASE_URL: "https://llm.internal" }), undefined);
  });
});
