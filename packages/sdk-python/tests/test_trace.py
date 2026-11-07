from __future__ import annotations

import asyncio
import threading
import unittest

import support  # noqa: F401
from support import IngestServer, by_kind, collect, kinds, start_sdk

import coding_sh


class TraceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.server = IngestServer()
        start_sdk(self.server)

    def tearDown(self) -> None:
        coding_sh.shutdown(1.0)
        self.server.close()

    def test_trace_layout_matches_otel_root_span(self) -> None:
        with coding_sh.trace("checkout", input="where is my order?", user_id="u1", metadata={"plan": "pro"}) as t:
            with coding_sh.span("tool", "lookup_order", input={"id": 42}) as s:
                s.set_output({"status": "shipped"})
            t.set_output("it shipped")
        events = collect(self.server)
        self.assertEqual(
            kinds(events), ["session.start", "user.message", "tool.start", "tool.end", "turn.end", "session.end"]
        )
        self.assertEqual({e["sessionId"] for e in events}, {t.session_id})
        self.assertEqual({e["traceId"] for e in events}, {t.trace_id})
        start = by_kind(events, "session.start")[0]
        self.assertEqual(start["payload"], {"name": "checkout", "traceId": t.trace_id, "userId": "u1", "metadata": {"plan": "pro"}})
        self.assertEqual(by_kind(events, "user.message")[0]["payload"], {"text": "where is my order?"})
        ts, te = by_kind(events, "tool.start")[0], by_kind(events, "tool.end")[0]
        self.assertEqual(ts["payload"]["tool"], "lookup_order")
        self.assertEqual(ts["payload"]["input"], {"id": 42})
        self.assertEqual(ts["payload"]["toolUseId"], te["payload"]["toolUseId"])
        self.assertEqual(te["payload"]["output"], {"status": "shipped"})
        self.assertTrue(te["payload"]["ok"])
        self.assertEqual(ts["parentSpanId"], start["spanId"])
        self.assertIn("durationMs", te)
        end = by_kind(events, "turn.end")[0]
        self.assertEqual(end["payload"]["output"], "it shipped")
        self.assertTrue(end["payload"]["ok"])
        self.assertEqual(by_kind(events, "session.end")[0]["payload"], {"reason": "completed"})
        self.assertNotIn("turnId", start)

    def test_session_id_groups_turns_and_has_no_session_end(self) -> None:
        for i in range(2):
            with coding_sh.trace("turn", session_id="chat-1", input="q%d" % i):
                pass
        events = collect(self.server)
        self.assertEqual({e["sessionId"] for e in events}, {"chat-1"})
        self.assertEqual(kinds(events).count("turn.end"), 2)
        self.assertNotIn("session.end", kinds(events))
        self.assertEqual(len({e["turnId"] for e in events}), 2)

    def test_with_session_applies_to_traces_and_spans(self) -> None:
        with coding_sh.with_session("conv-9") as sid:
            self.assertEqual(sid, "conv-9")
            self.assertEqual(coding_sh.current_session_id(), "conv-9")
            with coding_sh.trace("a"):
                pass
            with coding_sh.span("tool", "untraced"):
                pass
        self.assertIsNone(coding_sh.current_session_id())
        events = collect(self.server)
        self.assertEqual({e["sessionId"] for e in events}, {"conv-9"})

    def test_untraced_span_gets_its_own_session(self) -> None:
        with coding_sh.span("tool", "a"):
            pass
        with coding_sh.span("tool", "b"):
            pass
        events = collect(self.server)
        self.assertEqual(len({e["sessionId"] for e in events}), 2)
        self.assertEqual(kinds(events).count("session.end"), 2)

    def test_exception_marks_error_and_propagates(self) -> None:
        with self.assertRaises(ValueError):
            with coding_sh.trace("boom"):
                with coding_sh.span("tool", "explode"):
                    raise ValueError("bad input")
        events = collect(self.server)
        te = by_kind(events, "tool.end")[0]
        self.assertFalse(te["payload"]["ok"])
        self.assertEqual(te["payload"]["error"], "ValueError: bad input")
        self.assertFalse(by_kind(events, "turn.end")[0]["payload"]["ok"])
        self.assertEqual(by_kind(events, "session.end")[0]["payload"]["reason"], "error")

    def test_step_span_and_nested_trace(self) -> None:
        with coding_sh.trace("outer"):
            with coding_sh.span("step", "rerank"):
                pass
            with coding_sh.trace("inner"):
                pass
        events = collect(self.server)
        spans = by_kind(events, "span")
        self.assertEqual(sorted(s["payload"]["name"] for s in spans), ["inner", "rerank"])
        self.assertEqual(kinds(events).count("session.start"), 1)

    def test_decorators_sync(self) -> None:
        @coding_sh.span("tool", "add")
        def add(a: int, b: int = 2) -> int:
            return a + b

        @coding_sh.trace("job", session_id="dec-1")
        def job() -> str:
            return "sum=%d" % add(1, b=3)

        self.assertEqual(job(), "sum=4")
        self.assertEqual(add.__name__, "add")
        events = collect(self.server)
        self.assertEqual(by_kind(events, "tool.start")[0]["payload"]["input"], {"a": 1, "b": 3})
        self.assertEqual(by_kind(events, "tool.end")[0]["payload"]["output"], 4)
        self.assertEqual(by_kind(events, "turn.end")[0]["payload"]["output"], "sum=4")
        self.assertEqual({e["sessionId"] for e in events}, {"dec-1"})

    def test_decorators_async_and_async_with(self) -> None:
        @coding_sh.span("tool", "fetch")
        async def fetch(x: int) -> int:
            await asyncio.sleep(0)
            return x * 2

        @coding_sh.trace("ajob")
        async def ajob() -> list:
            return list(await asyncio.gather(fetch(1), fetch(2)))

        async def main() -> list:
            async with coding_sh.trace("ctx", session_id="async-ctx"):
                await fetch(5)
            return await ajob()

        self.assertEqual(asyncio.run(main()), [2, 4])
        events = collect(self.server)
        sessions = {e["sessionId"] for e in events}
        self.assertEqual(len(sessions), 2)
        self.assertIn("async-ctx", sessions)
        ajob_events = [e for e in events if e["sessionId"] != "async-ctx"]
        self.assertEqual(kinds(ajob_events).count("tool.end"), 2)

    def test_decorator_records_exception(self) -> None:
        @coding_sh.trace("fails")
        def fails() -> None:
            raise KeyError("k")

        with self.assertRaises(KeyError):
            fails()
        events = collect(self.server)
        self.assertEqual(by_kind(events, "turn.end")[0]["payload"]["error"], "KeyError: 'k'")

    def test_set_input_after_start(self) -> None:
        with coding_sh.trace("late") as t:
            t.set_input("late prompt")
        events = collect(self.server)
        um = by_kind(events, "user.message")[0]
        self.assertEqual(um["payload"]["text"], "late prompt")
        self.assertEqual(um["ts"], by_kind(events, "session.start")[0]["ts"])

    def test_metadata_capture_drops_text(self) -> None:
        coding_sh.init(url=self.server.url, key=support.KEY, capture="metadata", flush_interval_ms=5)
        with coding_sh.trace("m", input="secret prompt") as t:
            with coding_sh.span("tool", "x", input={"q": "secret"}) as s:
                s.set_output("secret out")
            t.set_output("secret answer")
        events = collect(self.server)
        self.assertNotIn("secret", str(events))
        self.assertEqual(kinds(events).count("tool.end"), 1)

    def test_contexts_are_isolated_between_threads(self) -> None:
        def worker(i: int) -> None:
            with coding_sh.trace("t%d" % i, session_id="thread-%d" % i):
                with coding_sh.span("tool", "w"):
                    pass

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
        for th in threads:
            th.start()
        for th in threads:
            th.join()
        events = collect(self.server)
        for i in range(8):
            mine = [e for e in events if e["sessionId"] == "thread-%d" % i]
            self.assertEqual(kinds(mine), ["session.start", "tool.start", "tool.end", "turn.end"])

    def test_large_values_are_clipped(self) -> None:
        with coding_sh.trace("big", input="x" * 200_000):
            pass
        events = collect(self.server)
        text = by_kind(events, "user.message")[0]["payload"]["text"]
        self.assertLess(len(text), 70_000)
        self.assertTrue(text.endswith("[truncated]"))

    def test_unserializable_values_fall_back_to_repr(self) -> None:
        class Thing:
            def __repr__(self) -> str:
                return "<Thing>"

        with coding_sh.span("tool", "obj", input={"t": Thing()}):
            pass
        events = collect(self.server)
        self.assertEqual(by_kind(events, "tool.start")[0]["payload"]["input"], {"t": "<Thing>"})


if __name__ == "__main__":
    unittest.main()
