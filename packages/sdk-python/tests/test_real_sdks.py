"""The wrappers against the real openai / anthropic packages and a mock LLM HTTP server.

Skipped when the packages are not installed (pip install openai anthropic).
"""

from __future__ import annotations

import asyncio
import importlib.util
import unittest

import support  # noqa: F401
from support import USAGE_IN, USAGE_OUT, IngestServer, LLMServer, by_kind, collect, kinds, start_sdk

import coding_sh

HAS_OPENAI = importlib.util.find_spec("openai") is not None
HAS_ANTHROPIC = importlib.util.find_spec("anthropic") is not None
MSGS = [{"role": "user", "content": "ping"}]


class _Base(unittest.TestCase):
    def setUp(self) -> None:
        self.server = IngestServer()
        self.llm = LLMServer()
        start_sdk(self.server)

    def tearDown(self) -> None:
        coding_sh.shutdown(1.0)
        self.server.close()
        self.llm.close()


@unittest.skipUnless(HAS_OPENAI or support.REQUIRE_ALL, "openai not installed")
class RealOpenAITest(_Base):
    def _client(self, cls_name: str = "OpenAI"):  # noqa: ANN202
        import openai

        return getattr(openai, cls_name)(base_url=self.llm.url + "/v1", api_key="mock", max_retries=0)

    def test_chat_plain_and_stream_match_unobserved_behavior(self) -> None:
        import openai
        from openai.types.chat import ChatCompletion

        plain = self._client()
        observed = coding_sh.observe(self._client())
        self.assertIs(type(observed), openai.OpenAI)

        r = observed.chat.completions.create(model="mock-gpt", messages=MSGS)
        self.assertIsInstance(r, ChatCompletion)
        self.assertEqual(r.choices[0].message.content, "pong")

        def chunks(client):  # noqa: ANN001, ANN202
            out = []
            with client.chat.completions.create(model="mock-gpt", messages=MSGS, stream=True) as s:
                for c in s:
                    out.append((len(c.choices), c.choices[0].delta.content if c.choices else None, c.usage))
            return out

        self.assertEqual(chunks(observed), chunks(plain))  # the usage chunk we asked for stays hidden
        self.assertEqual(self.llm.requests[1]["json"]["stream_options"], {"include_usage": True})
        self.assertNotIn("stream_options", self.llm.requests[2]["json"])

        events = collect(self.server)
        calls = by_kind(events, "llm.call")
        self.assertEqual(len(calls), 2)
        for c in calls:
            self.assertEqual(c["usage"], {"inputTokens": USAGE_IN, "outputTokens": USAGE_OUT})
            self.assertEqual(c["model"], "mock-gpt")
            self.assertEqual(c["payload"]["stopReason"], "stop")
        self.assertIn("ttftMs", calls[1]["payload"])
        self.assertEqual([m["payload"]["text"] for m in by_kind(events, "assistant.message")], ["pong", "pong"])

    def test_responses_plain_and_stream(self) -> None:
        client = coding_sh.observe(self._client())
        r = client.responses.create(model="mock-gpt", input="ping")
        self.assertEqual(r.output_text, "pong")
        types = [e.type for e in client.responses.create(model="mock-gpt", input="ping", stream=True)]
        self.assertEqual(types[-1], "response.completed")
        calls = by_kind(collect(self.server), "llm.call")
        self.assertEqual(len(calls), 2)
        for c in calls:
            self.assertEqual(c["usage"], {"inputTokens": USAGE_IN, "outputTokens": USAGE_OUT})

    def test_api_errors_propagate_with_their_type(self) -> None:
        import openai

        client = coding_sh.observe(self._client())
        self.llm.fail_next = 400
        with self.assertRaises(openai.BadRequestError):
            client.chat.completions.create(model="mock-gpt", messages=MSGS)
        p = by_kind(collect(self.server), "llm.call")[0]["payload"]
        self.assertFalse(p["ok"])
        self.assertIn("BadRequestError", p["error"])

    def test_async_client(self) -> None:
        client = coding_sh.observe(self._client("AsyncOpenAI"))

        async def main() -> str:
            r = await client.chat.completions.create(model="mock-gpt", messages=MSGS)
            s = await client.chat.completions.create(model="mock-gpt", messages=MSGS, stream=True)
            text = ""
            async for c in s:
                self.assertTrue(c.choices)  # usage-only chunk hidden
                text += c.choices[0].delta.content or ""
            await client.close()
            return r.choices[0].message.content + "/" + text

        self.assertEqual(asyncio.run(main()), "pong/pong")
        calls = by_kind(collect(self.server), "llm.call")
        self.assertEqual([c["usage"]["outputTokens"] for c in calls], [USAGE_OUT, USAGE_OUT])

    def test_trace_with_session(self) -> None:
        client = coding_sh.observe(self._client())
        with coding_sh.trace("support", session_id="real-1", input="ping"):
            client.chat.completions.create(model="mock-gpt", messages=MSGS)
            with coding_sh.span("tool", "lookup_order", input={"id": 1}) as s:
                s.set_output("shipped")
        events = collect(self.server)
        self.assertEqual({e["sessionId"] for e in events}, {"real-1"})
        self.assertEqual(kinds(events), ["session.start", "user.message", "llm.call", "assistant.message", "tool.start", "tool.end", "turn.end"])


@unittest.skipUnless(HAS_ANTHROPIC or support.REQUIRE_ALL, "anthropic not installed")
class RealAnthropicTest(_Base):
    def _client(self, cls_name: str = "Anthropic"):  # noqa: ANN202
        import anthropic

        return getattr(anthropic, cls_name)(base_url=self.llm.url, api_key="mock", max_retries=0)

    def test_create_stream_and_helper(self) -> None:
        import anthropic
        from anthropic.types import Message

        client = coding_sh.observe(self._client())
        self.assertIs(type(client), anthropic.Anthropic)
        m = client.messages.create(model="mock-claude", max_tokens=16, messages=MSGS)
        self.assertIsInstance(m, Message)
        types = [e.type for e in client.messages.create(model="mock-claude", max_tokens=16, messages=MSGS, stream=True)]
        self.assertEqual(types[0], "message_start")
        with client.messages.stream(model="mock-claude", max_tokens=16, messages=MSGS) as s:
            text = "".join(s.text_stream)
            final = s.get_final_message()
        self.assertEqual(text, "pong")
        self.assertIsInstance(final, Message)
        with client.messages.stream(model="mock-claude", max_tokens=16, messages=MSGS) as s:
            s.until_done()
        events = collect(self.server)
        calls = by_kind(events, "llm.call")
        self.assertEqual(len(calls), 4)
        for c in calls:
            self.assertEqual(c["usage"], {"inputTokens": USAGE_IN, "outputTokens": USAGE_OUT})
            self.assertEqual(c["model"], "mock-claude")
            self.assertEqual(c["payload"]["stopReason"], "end_turn")
            self.assertEqual(c["payload"]["provider"], "anthropic")
        self.assertEqual([m["payload"]["text"] for m in by_kind(events, "assistant.message")], ["pong"] * 4)

    def test_async_client(self) -> None:
        client = coding_sh.observe(self._client("AsyncAnthropic"))

        async def main() -> str:
            m = await client.messages.create(model="mock-claude", max_tokens=16, messages=MSGS)
            out = m.content[0].text
            async with client.messages.stream(model="mock-claude", max_tokens=16, messages=MSGS) as s:
                async for t in s.text_stream:
                    out += t
            stream = await client.messages.create(model="mock-claude", max_tokens=16, messages=MSGS, stream=True)
            async for _ in stream:
                pass
            await client.close()
            return out

        self.assertEqual(asyncio.run(main()), "pongpong")
        calls = by_kind(collect(self.server), "llm.call")
        self.assertEqual([c["usage"]["outputTokens"] for c in calls], [USAGE_OUT] * 3)


if __name__ == "__main__":
    unittest.main()
