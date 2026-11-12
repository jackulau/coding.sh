"""Gateway detection: every gateway in the registry, by base URL, env var, response header and id shape.

The real-SDK half checks that the gateway and its request id land on llm.call as payload.gateway
and payload.gatewayGenerationId, the names `coding.sh gateway enrich` and the session flags read.
"""

from __future__ import annotations

import asyncio
import importlib.util
import os
import unittest
from unittest import mock

import support  # noqa: F401
from support import IngestServer, LLMServer, by_kind, collect, start_sdk

import coding_sh
from coding_sh._gateway import detect_gateway, gateway_for_url
from coding_sh._gateway_table import GATEWAY_TABLE

HAS_OPENAI = importlib.util.find_spec("openai") is not None
HAS_ANTHROPIC = importlib.util.find_spec("anthropic") is not None
MSGS = [{"role": "user", "content": "ping"}]

VERCEL_ID = "gen_01ARZ3NDEKTSV4RRFFQ69G5FAV"
OPENROUTER_ID = "gen-3bhGkxlo4XFrqiabUM7NDtwDzWwG"
CF_ID = "0192f4a2-7b1e-7c3d-9a8b-1234567890ab"


class DetectTest(unittest.TestCase):
    def test_table_covers_the_registry(self) -> None:
        ids = [g["id"] for g in GATEWAY_TABLE]
        self.assertEqual(
            ids, ["vercel", "openrouter", "litellm", "cloudflare", "portkey", "helicone", "requesty", "ramp", "truefoundry", "kong", "bifrost", "martian", "cliproxyapi"]
        )

    def test_hosted_gateways_by_base_url(self) -> None:
        cases = {
            "https://ai-gateway.vercel.sh/v1": "vercel",
            "https://openrouter.ai/api/v1": "openrouter",
            "https://gateway.ai.cloudflare.com/v1/acct/gw/compat": "cloudflare",
            "https://api.portkey.ai/v1": "portkey",
            "https://ai-gateway.helicone.ai": "helicone",
            "https://oai.helicone.ai/v1": "helicone",
            "https://router.requesty.ai/v1": "requesty",
            "https://router.eu.requesty.ai/v1": "requesty",
            "https://api.router.com/v1": "ramp",
            "https://gateway.truefoundry.ai": "truefoundry",
            "https://acme.truefoundry.cloud/api/llm": "truefoundry",
            "https://route.withmartian.com/api/openai/v1": "martian",
        }
        for url, want in cases.items():
            self.assertEqual(gateway_for_url(url, {}), want, url)
        for url in ("https://api.openai.com/v1", "https://api.anthropic.com", "http://localhost:4000", "", None, "not a url"):
            self.assertIsNone(gateway_for_url(url, {}), url)

    def test_self_hosted_gateways_by_env(self) -> None:
        url = "http://10.0.0.5:4000/v1"
        cases = {
            "LITELLM_PROXY_API_BASE": "litellm",
            "LITELLM_BASE_URL": "litellm",
            "PORTKEY_GATEWAY_URL": "portkey",
            "RAMP_ROUTER_BASE_URL": "ramp",
            "TFY_GATEWAY_URL": "truefoundry",
            "KONG_PROXY_URL": "kong",
            "BIFROST_URL": "bifrost",
            "BIFROST_BASE_URL": "bifrost",
        }
        for var, want in cases.items():
            self.assertEqual(gateway_for_url(url, {var: "http://10.0.0.5:4000"}), want, var)
        self.assertIsNone(gateway_for_url(url, {"LITELLM_PROXY_API_BASE": "http://10.0.0.6:4000"}))
        with mock.patch.dict(os.environ, {"KONG_PROXY_URL": "http://10.0.0.5:8000"}):
            self.assertEqual(gateway_for_url(url), "kong")

    def test_request_id_headers(self) -> None:
        plain = "http://127.0.0.1:9/v1"
        cases = [
            ({"x-generation-id": VERCEL_ID}, ("vercel", VERCEL_ID)),
            ({"x-generation-id": OPENROUTER_ID}, ("openrouter", OPENROUTER_ID)),
            ({"x-litellm-call-id": "b980d2ab-1d07-4a5c-9b8a-3d1d1b1b6f6a"}, ("litellm", "b980d2ab-1d07-4a5c-9b8a-3d1d1b1b6f6a")),
            ({"cf-aig-log-id": CF_ID}, ("cloudflare", CF_ID)),
            ({"x-portkey-trace-id": "trace-123"}, ("portkey", "trace-123")),
            ({"helicone-id": "5f2c-helicone"}, ("helicone", "5f2c-helicone")),
            ({"x-kong-request-id": "kong-1"}, ("kong", "kong-1")),
            ({"x-router-provider": "anthropic"}, ("ramp", None)),
            ({"x-kong-llm-model": "openai/gpt-5"}, ("kong", None)),
            ({"x-litellm-response-cost": "0.0012"}, ("litellm", None)),
        ]
        for headers, want in cases:
            self.assertEqual(detect_gateway(plain, headers, None, {}), want, headers)
        # A generic id header, or an x-generation-id of no known shape, is not a gateway.
        self.assertIsNone(detect_gateway(plain, {"x-request-id": "req_1"}, None, {}))
        self.assertIsNone(detect_gateway(plain, {"x-generation-id": "abc"}, None, {}))

    def test_response_id_shapes(self) -> None:
        self.assertEqual(detect_gateway(None, None, VERCEL_ID, {}), ("vercel", VERCEL_ID))
        self.assertEqual(detect_gateway(None, None, OPENROUTER_ID, {}), ("openrouter", OPENROUTER_ID))
        self.assertEqual(detect_gateway(None, None, "rqsty-cmpl-1234abcd", {}), ("requesty", "rqsty-cmpl-1234abcd"))
        self.assertIsNone(detect_gateway(None, None, "chatcmpl-abc", {}))

    def test_url_wins_and_takes_its_own_id(self) -> None:
        self.assertEqual(detect_gateway("https://gateway.ai.cloudflare.com/v1/a/g/compat", {"cf-aig-log-id": CF_ID}, "chatcmpl-1", {}), ("cloudflare", CF_ID))
        self.assertEqual(detect_gateway("https://ai-gateway.vercel.sh/v1", {}, VERCEL_ID, {}), ("vercel", VERCEL_ID))
        self.assertEqual(detect_gateway("https://ai-gateway.vercel.sh/v1", {}, "chatcmpl-1", {}), ("vercel", None))
        self.assertEqual(detect_gateway("https://router.requesty.ai/v1", {}, "rqsty-cmpl-1234abcd", {}), ("requesty", "rqsty-cmpl-1234abcd"))
        # Another gateway's header does not count once the URL has decided.
        self.assertEqual(detect_gateway("https://openrouter.ai/api/v1", {"helicone-id": "h1"}, OPENROUTER_ID, {}), ("openrouter", OPENROUTER_ID))


class _Real(unittest.TestCase):
    def setUp(self) -> None:
        self.server = IngestServer()
        self.llm = LLMServer()
        start_sdk(self.server)

    def tearDown(self) -> None:
        coding_sh.shutdown(1.0)
        self.server.close()
        self.llm.close()

    def payloads(self) -> list:
        return [c["payload"] for c in by_kind(collect(self.server), "llm.call")]


@unittest.skipUnless(HAS_OPENAI or support.REQUIRE_ALL, "openai not installed")
class RealOpenAIGatewayTest(_Real):
    def _client(self, cls_name: str = "OpenAI"):  # noqa: ANN202
        import openai

        return getattr(openai, cls_name)(base_url=self.llm.url + "/v1", api_key="mock", max_retries=0)

    def test_header_id_on_plain_stream_and_responses(self) -> None:
        self.llm.extra_headers = {"cf-aig-log-id": CF_ID}
        client = coding_sh.observe(self._client())
        client.chat.completions.create(model="mock-gpt", messages=MSGS)
        list(client.chat.completions.create(model="mock-gpt", messages=MSGS, stream=True))
        client.responses.create(model="mock-gpt", input="ping")
        ps = self.payloads()
        self.assertEqual(len(ps), 3)
        for p in ps:
            self.assertEqual((p["gateway"], p["gatewayGenerationId"]), ("cloudflare", CF_ID))

    def test_self_hosted_by_env_with_call_id(self) -> None:
        self.llm.extra_headers = {"x-litellm-call-id": "call-42"}
        with mock.patch.dict(os.environ, {"LITELLM_PROXY_API_BASE": self.llm.url}):
            client = coding_sh.observe(self._client())
            client.chat.completions.create(model="mock-gpt", messages=MSGS)
        (p,) = self.payloads()
        self.assertEqual((p["gateway"], p["gatewayGenerationId"]), ("litellm", "call-42"))

    def test_async_client(self) -> None:
        self.llm.extra_headers = {"helicone-id": "hel-1"}
        client = coding_sh.observe(self._client("AsyncOpenAI"))

        async def main() -> None:
            await client.chat.completions.create(model="mock-gpt", messages=MSGS)
            s = await client.chat.completions.create(model="mock-gpt", messages=MSGS, stream=True)
            async for _ in s:
                pass
            await client.close()

        asyncio.run(main())
        ps = self.payloads()
        self.assertEqual([(p["gateway"], p["gatewayGenerationId"]) for p in ps], [("helicone", "hel-1")] * 2)

    def test_no_gateway_no_fields(self) -> None:
        client = coding_sh.observe(self._client())
        client.chat.completions.create(model="mock-gpt", messages=MSGS)
        (p,) = self.payloads()
        self.assertNotIn("gateway", p)
        self.assertNotIn("gatewayGenerationId", p)

    def test_hook_is_added_once_and_ignores_unrecorded_calls(self) -> None:
        client = self._client()
        coding_sh.observe(client)
        coding_sh.observe(client)
        self.assertEqual(len(client._client.event_hooks["response"]), 1)
        import openai

        self.llm.extra_headers = {"helicone-id": "hel-2"}
        with self.assertRaises(openai.NotFoundError):
            client.embeddings.create(model="mock-embed", input="ping")  # not recorded: the hook does nothing
        self.assertEqual(self.payloads(), [])


@unittest.skipUnless(HAS_ANTHROPIC or support.REQUIRE_ALL, "anthropic not installed")
class RealAnthropicGatewayTest(_Real):
    def _client(self, cls_name: str = "Anthropic"):  # noqa: ANN202
        import anthropic

        return getattr(anthropic, cls_name)(base_url=self.llm.url, api_key="mock", max_retries=0)

    def test_create_stream_and_helper(self) -> None:
        self.llm.extra_headers = {"x-portkey-trace-id": "pk-trace-1"}
        client = coding_sh.observe(self._client())
        client.messages.create(model="mock-claude", max_tokens=16, messages=MSGS)
        list(client.messages.create(model="mock-claude", max_tokens=16, messages=MSGS, stream=True))
        with client.messages.stream(model="mock-claude", max_tokens=16, messages=MSGS) as s:
            s.until_done()
        ps = self.payloads()
        self.assertEqual([(p["gateway"], p["gatewayGenerationId"]) for p in ps], [("portkey", "pk-trace-1")] * 3)

    def test_async_helper(self) -> None:
        self.llm.extra_headers = {"x-generation-id": VERCEL_ID}
        client = coding_sh.observe(self._client("AsyncAnthropic"))

        async def main() -> None:
            async with client.messages.stream(model="mock-claude", max_tokens=16, messages=MSGS) as s:
                async for _ in s.text_stream:
                    pass
            await client.close()

        asyncio.run(main())
        (p,) = self.payloads()
        self.assertEqual((p["gateway"], p["gatewayGenerationId"]), ("vercel", VERCEL_ID))


if __name__ == "__main__":
    unittest.main()
