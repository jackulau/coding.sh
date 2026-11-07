from __future__ import annotations

import asyncio
import gc
import unittest

import support  # noqa: F401
from fakes import FakeAnthropic, FakeAsyncAnthropic, FakeAsyncOpenAI, FakeOpenAI
from support import IngestServer, by_kind, collect, kinds, start_sdk

import coding_sh

MSGS = [{"role": "system", "content": "be brief"}, {"role": "user", "content": "first"}, {"role": "assistant", "content": "ok"},
        {"role": "user", "content": [{"type": "text", "text": "ping"}]}]


class OpenAIWrapperTest(unittest.TestCase):
    def setUp(self) -> None:
        self.server = IngestServer()
        start_sdk(self.server)
        self.client = coding_sh.observe(FakeOpenAI())

    def tearDown(self) -> None:
        coding_sh.shutdown(1.0)
        self.server.close()

    def test_plain_call_layout(self) -> None:
        resp = self.client.chat.completions.create(model="gpt-4o-mini", messages=MSGS)
        self.assertEqual(resp["choices"][0]["message"]["content"], "pong")
        self.assertEqual(self.client.calls[0], {"model": "gpt-4o-mini", "messages": MSGS})  # request untouched
        events = collect(self.server)
        self.assertEqual(
            kinds(events), ["session.start", "user.message", "llm.call", "assistant.message", "turn.end", "session.end"]
        )
        self.assertEqual(by_kind(events, "session.start")[0]["payload"]["name"], "chat gpt-4o-mini")
        self.assertEqual(by_kind(events, "user.message")[0]["payload"]["text"], "ping")
        call = by_kind(events, "llm.call")[0]
        self.assertEqual(call["model"], "gpt-4o-mini-2024-07-18")
        self.assertEqual(call["usage"], {"inputTokens": 1000, "outputTokens": 500, "cacheReadTokens": 200})
        p = call["payload"]
        self.assertEqual(p["provider"], "openai")
        self.assertEqual(p["requestModel"], "gpt-4o-mini")
        self.assertEqual(p["responseModel"], "gpt-4o-mini-2024-07-18")
        self.assertEqual(p["stopReason"], "stop")
        self.assertTrue(p["ok"])
        self.assertNotIn("ttftMs", p)
        self.assertIn("durationMs", call)
        self.assertNotIn("costUsd", call["usage"])  # the SDK never prices
        self.assertEqual(by_kind(events, "assistant.message")[0]["payload"], {"text": "pong"})

    def test_return_value_is_the_providers_object(self) -> None:
        sentinel = object()

        def fake_create(**kw):  # noqa: ANN001
            return sentinel

        client = FakeOpenAI()
        client.chat.completions.create = fake_create
        coding_sh.observe(client)
        self.assertIs(client.chat.completions.create(model="m", messages=MSGS), sentinel)

    def test_stream_injects_usage_and_hides_the_usage_chunk(self) -> None:
        stream = self.client.chat.completions.create(model="gpt-4o-mini", messages=MSGS, stream=True)
        self.assertEqual(self.client.calls[0]["stream_options"], {"include_usage": True})
        self.assertEqual(stream.response, "raw-response")  # attributes pass through
        with stream:
            chunks = list(stream)
        self.assertEqual(len(chunks), 4)  # the usage-only chunk was swallowed
        self.assertTrue(all(c["choices"] for c in chunks))
        self.assertEqual("".join(c["choices"][0]["delta"].get("content") or "" for c in chunks), "pong")
        events = collect(self.server)
        call = by_kind(events, "llm.call")[0]
        self.assertEqual(call["usage"]["outputTokens"], 500)
        self.assertIn("ttftMs", call["payload"])
        self.assertEqual(by_kind(events, "assistant.message")[0]["payload"]["text"], "pong")
        self.assertEqual(kinds(events).count("llm.call"), 1)

    def test_stream_with_user_stream_options_is_left_alone(self) -> None:
        stream = self.client.chat.completions.create(model="m", messages=MSGS, stream=True, stream_options={"include_usage": True})
        chunks = list(stream)
        self.assertEqual(len(chunks), 5)  # the user asked for the usage chunk, so they see it
        self.assertEqual(chunks[-1]["choices"], [])
        stream2 = self.client.chat.completions.create(model="m", messages=MSGS, stream=True, stream_options={"include_usage": False})
        self.assertEqual(len(list(stream2)), 4)
        self.assertEqual(self.client.calls[1]["stream_options"], {"include_usage": False})
        events = collect(self.server)
        calls = by_kind(events, "llm.call")
        self.assertEqual(len(calls), 2)
        self.assertEqual(sum(1 for c in calls if "usage" in c), 1)

    def test_errors_propagate_unchanged(self) -> None:
        err = RuntimeError("rate limited")
        self.client.error = err
        with self.assertRaises(RuntimeError) as ctx:
            self.client.chat.completions.create(model="m", messages=MSGS)
        self.assertIs(ctx.exception, err)
        events = collect(self.server)
        p = by_kind(events, "llm.call")[0]["payload"]
        self.assertFalse(p["ok"])
        self.assertEqual(p["error"], "RuntimeError: rate limited")
        self.assertEqual(by_kind(events, "session.end")[0]["payload"]["reason"], "error")

    def test_error_mid_stream(self) -> None:
        err = ConnectionError("reset")
        self.client.stream_error = err
        stream = self.client.chat.completions.create(model="m", messages=MSGS, stream=True)
        got = []
        with self.assertRaises(ConnectionError) as ctx:
            for c in stream:
                got.append(c)
        self.assertIs(ctx.exception, err)
        self.assertEqual(len(got), 2)
        p = by_kind(collect(self.server), "llm.call")[0]["payload"]
        self.assertFalse(p["ok"])

    def test_closed_or_abandoned_stream_still_records(self) -> None:
        s = self.client.chat.completions.create(model="m", messages=MSGS, stream=True)
        next(s)
        s.close()
        s2 = self.client.chat.completions.create(model="m", messages=MSGS, stream=True)
        next(s2)
        del s2
        gc.collect()
        self.assertEqual(len(by_kind(collect(self.server), "llm.call")), 2)

    def test_tool_calls(self) -> None:
        self.client.tool_calls = [{"id": "call_1", "type": "function", "function": {"name": "lookup_order", "arguments": "{}"}}]
        self.client.chat.completions.create(model="m", messages=MSGS)
        events = collect(self.server)
        self.assertEqual(
            by_kind(events, "llm.call")[0]["payload"]["toolCalls"], [{"name": "lookup_order", "id": "call_1", "arguments": "{}"}]
        )
        self.assertEqual(by_kind(events, "assistant.message"), [])

    def test_streamed_tool_call_arguments_are_joined(self) -> None:
        from fakes import FakeStream

        chunks = [
            {"id": "c9", "model": "m", "choices": [{"index": 0, "delta": {"tool_calls": [{"index": 0, "id": "call_7", "function": {"name": "lookup", "arguments": ""}}]}}]},
            {"id": "c9", "model": "m", "choices": [{"index": 0, "delta": {"tool_calls": [{"index": 0, "function": {"arguments": '{"id":'}}]}}]},
            {"id": "c9", "model": "m", "choices": [{"index": 0, "delta": {"tool_calls": [{"index": 0, "function": {"arguments": "42}"}}]}, "finish_reason": "tool_calls"}]},
        ]
        self.client.chat.completions.create = lambda **kw: FakeStream(chunks)
        coding_sh.observe(self.client)
        list(self.client.chat.completions.create(model="m", messages=MSGS, stream=True))
        p = by_kind(collect(self.server), "llm.call")[0]["payload"]
        self.assertEqual(p["toolCalls"], [{"name": "lookup", "id": "call_7", "arguments": '{"id":42}'}])
        self.assertEqual(p["responseId"], "c9")
        self.assertEqual(p["stopReason"], "tool_calls")

    def test_response_id_parent_links_and_gateway(self) -> None:
        client = FakeOpenAI()
        client.base_url = "https://ai-gateway.vercel.sh/v1/"
        coding_sh.observe(client)
        with coding_sh.trace("t"):
            with coding_sh.span("tool", "outer"):
                client.chat.completions.create(model="m", messages=MSGS)
        events = collect(self.server)
        start = by_kind(events, "session.start")[0]
        tool_start, tool_end = by_kind(events, "tool.start")[0], by_kind(events, "tool.end")[0]
        call, msg = by_kind(events, "llm.call")[0], by_kind(events, "assistant.message")[0]
        self.assertEqual(tool_start["parentId"], start["id"])
        self.assertEqual(tool_end["parentId"], start["id"])
        self.assertEqual(call["parentId"], tool_start["id"])
        self.assertEqual(msg["parentId"], tool_start["id"])
        self.assertEqual(call["parentSpanId"], tool_start["spanId"])
        self.assertEqual(call["payload"]["responseId"], "c1")
        self.assertEqual(call["payload"]["gateway"], "vercel")
        self.assertEqual(len({e["id"] for e in events}), len(events))

    def test_untraced_call_has_no_parent_links(self) -> None:
        self.client.chat.completions.create(model="m", messages=MSGS)
        events = collect(self.server)
        self.assertTrue(all("parentId" not in e for e in events))
        self.assertNotIn("gateway", by_kind(events, "llm.call")[0]["payload"])

    def test_wrapping_is_idempotent(self) -> None:
        coding_sh.observe(self.client)
        coding_sh.observe(self.client)
        self.client.chat.completions.create(model="m", messages=MSGS)
        self.assertEqual(len(by_kind(collect(self.server), "llm.call")), 1)

    def test_disabled_sdk_passes_through(self) -> None:
        coding_sh.init(url=None)
        self.client.chat.completions.create(model="m", messages=MSGS, stream=True)
        self.assertNotIn("stream_options", self.client.calls[0])

    def test_unknown_objects_are_untouched(self) -> None:
        class Twilio:
            class messages:  # noqa: N801
                @staticmethod
                def create(**kw):  # noqa: ANN001, ANN205
                    return "sms"

        t = Twilio()
        before = Twilio.messages.create
        self.assertIs(coding_sh.observe(t), t)
        self.assertIs(Twilio.messages.create, before)
        self.assertIs(coding_sh.observe(None), None)

    def test_inside_trace_and_tool_span(self) -> None:
        with coding_sh.trace("agent", session_id="conv-1", input="help") as t:
            self.client.chat.completions.create(model="m", messages=MSGS)
            with coding_sh.span("tool", "lookup_order"):
                pass
            list(self.client.chat.completions.create(model="m", messages=MSGS, stream=True))
        events = collect(self.server)
        self.assertEqual({e["sessionId"] for e in events}, {"conv-1"})
        self.assertEqual(
            kinds(events),
            ["session.start", "user.message", "llm.call", "assistant.message", "tool.start", "tool.end", "llm.call", "assistant.message", "turn.end"],
        )
        root_span = by_kind(events, "session.start")[0]["spanId"]
        for c in by_kind(events, "llm.call"):
            self.assertEqual(c["parentSpanId"], root_span)
            self.assertEqual(c["traceId"], t.trace_id)

    def test_with_session_groups_untraced_calls(self) -> None:
        with coding_sh.with_session("chat-7"):
            self.client.chat.completions.create(model="m", messages=MSGS)
            self.client.chat.completions.create(model="m", messages=MSGS)
        events = collect(self.server)
        self.assertEqual({e["sessionId"] for e in events}, {"chat-7"})
        self.assertEqual(kinds(events).count("turn.end"), 2)
        self.assertEqual(kinds(events).count("user.message"), 2)
        self.assertNotIn("session.end", kinds(events))

    def test_responses_api(self) -> None:
        r = self.client.responses.create(model="gpt-4.1", input="ping")
        self.assertEqual(r["status"], "completed")
        events = list(self.client.responses.create(model="gpt-4.1", input=[{"role": "user", "content": [{"type": "input_text", "text": "ping2"}]}], stream=True))
        self.assertEqual(len(events), 4)
        evs = collect(self.server)
        calls = by_kind(evs, "llm.call")
        self.assertEqual(len(calls), 2)
        for c in calls:
            self.assertEqual(c["usage"], {"inputTokens": 1000, "outputTokens": 500})
            self.assertEqual(c["payload"]["toolCalls"], [{"name": "lookup", "id": "call_9"}])
            self.assertEqual(c["payload"]["stopReason"], "completed")
        self.assertIn("ttftMs", calls[1]["payload"])
        self.assertEqual(sorted(m["payload"]["text"] for m in by_kind(evs, "user.message")), ["ping", "ping2"])
        self.assertEqual([m["payload"]["text"] for m in by_kind(evs, "assistant.message")], ["pong", "pong"])

    def test_metadata_capture(self) -> None:
        coding_sh.init(url=self.server.url, key=support.KEY, capture="metadata", flush_interval_ms=5)
        self.client.chat.completions.create(model="m", messages=MSGS)
        events = collect(self.server)
        self.assertEqual(by_kind(events, "user.message"), [])
        self.assertEqual(by_kind(events, "assistant.message"), [])
        self.assertEqual(by_kind(events, "llm.call")[0]["usage"]["outputTokens"], 500)


class AsyncOpenAIWrapperTest(unittest.TestCase):
    def setUp(self) -> None:
        self.server = IngestServer()
        start_sdk(self.server)

    def tearDown(self) -> None:
        coding_sh.shutdown(1.0)
        self.server.close()

    def _run(self, plain_def: bool) -> None:
        client = coding_sh.observe(FakeAsyncOpenAI(plain_def=plain_def))

        async def main() -> str:
            r = await client.chat.completions.create(model="m", messages=MSGS)
            s = await client.chat.completions.create(model="m", messages=MSGS, stream=True)
            text = ""
            async with s:
                async for c in s:
                    text += c["choices"][0]["delta"].get("content") or ""
            client.error = ValueError("nope")
            try:
                await client.chat.completions.create(model="m", messages=MSGS)
            except ValueError:
                pass
            return r["choices"][0]["message"]["content"] + "/" + text

        self.assertEqual(asyncio.run(main()), "pong/pong")
        self.assertEqual(client.calls[1]["stream_options"], {"include_usage": True})
        calls = by_kind(collect(self.server), "llm.call")
        self.assertEqual(len(calls), 3)
        self.assertEqual([c["payload"]["ok"] for c in calls], [True, True, False])
        self.assertEqual(calls[1]["usage"]["outputTokens"], 500)

    def test_async_def_create(self) -> None:
        self._run(plain_def=False)

    def test_plain_def_returning_coroutine(self) -> None:
        self._run(plain_def=True)


class AnthropicWrapperTest(unittest.TestCase):
    def setUp(self) -> None:
        self.server = IngestServer()
        start_sdk(self.server)

    def tearDown(self) -> None:
        coding_sh.shutdown(1.0)
        self.server.close()

    def test_create(self) -> None:
        client = coding_sh.observe(FakeAnthropic())
        msg = client.messages.create(model="claude-x", max_tokens=10, messages=[{"role": "user", "content": "ping"}])
        self.assertEqual(msg["content"][0]["text"], "pong")
        events = collect(self.server)
        call = by_kind(events, "llm.call")[0]
        self.assertEqual(call["usage"], {"inputTokens": 1000, "outputTokens": 500, "cacheReadTokens": 300})
        self.assertEqual(call["payload"]["provider"], "anthropic")
        self.assertEqual(call["payload"]["stopReason"], "tool_use")
        self.assertEqual(call["payload"]["toolCalls"], [{"name": "lookup", "id": "toolu_1", "arguments": "{}"}])
        self.assertEqual(by_kind(events, "assistant.message")[0]["payload"]["text"], "pong")

    def test_create_stream(self) -> None:
        client = coding_sh.observe(FakeAnthropic())
        evs = list(client.messages.create(model="claude-x", max_tokens=10, messages=[{"role": "user", "content": "ping"}], stream=True))
        self.assertEqual(len(evs), 7)
        self.assertNotIn("stream_options", client.calls[0])
        call = by_kind(collect(self.server), "llm.call")[0]
        self.assertEqual(call["usage"], {"inputTokens": 1000, "outputTokens": 500})
        self.assertEqual(call["payload"]["stopReason"], "end_turn")
        self.assertIn("ttftMs", call["payload"])

    def test_stream_helper(self) -> None:
        client = coding_sh.observe(FakeAnthropic())
        with client.messages.stream(model="claude-x", max_tokens=10, messages=[{"role": "user", "content": "ping"}]) as s:
            text = "".join(s.text_stream)
            final = s.get_final_message()
        self.assertEqual(text, "pong")
        self.assertEqual(final["stop_reason"], "end_turn")
        with client.messages.stream(model="claude-x", max_tokens=10, messages=[{"role": "user", "content": "ping"}]) as s:
            s.get_final_message()  # consumed without the proxy seeing events
        events = collect(self.server)
        calls = by_kind(events, "llm.call")
        self.assertEqual(len(calls), 2)
        for c in calls:
            self.assertEqual(c["usage"], {"inputTokens": 1000, "outputTokens": 500})
            self.assertEqual(c["payload"]["stopReason"], "end_turn")
        self.assertIn("ttftMs", calls[0]["payload"])
        self.assertEqual([m["payload"]["text"] for m in by_kind(events, "assistant.message")], ["pong", "pong"])

    def test_async(self) -> None:
        client = coding_sh.observe(FakeAsyncAnthropic())
        m = [{"role": "user", "content": "ping"}]

        async def main() -> str:
            await client.messages.create(model="claude-x", max_tokens=10, messages=m)
            out = ""
            async for e in await client.messages.create(model="claude-x", max_tokens=10, messages=m, stream=True):
                if e["type"] == "content_block_delta":
                    out += e["delta"]["text"]
            async with client.messages.stream(model="claude-x", max_tokens=10, messages=m) as s:
                async for t in s.text_stream:
                    out += t
            return out

        self.assertEqual(asyncio.run(main()), "pongpong")
        calls = by_kind(collect(self.server), "llm.call")
        self.assertEqual(len(calls), 3)
        self.assertTrue(all(c["usage"]["outputTokens"] == 500 for c in calls))


if __name__ == "__main__":
    unittest.main()
