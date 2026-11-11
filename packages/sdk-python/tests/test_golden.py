"""Golden test: one mock conversation sent through the SDK and through plain OTel gen_ai spans
must give equal Session.stats (docs/PRODUCTION.md section 4).

The OTel side goes through the core package's real OTLP receiver and mapping; the SDK side
through the same buildSession() serve uses (tests/golden/harness.ts). Needs node >= 22.6 and
opentelemetry-sdk + exporter-otlp-proto-http; skipped otherwise.
"""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import time
import unittest
import urllib.error
import urllib.request

import support
from fakes import FakeAnthropic, FakeOpenAI

import coding_sh

HERE = os.path.dirname(os.path.abspath(__file__))
HARNESS = os.path.join(HERE, "golden", "harness.ts")
CORE = os.path.join(support.ROOT, "..", "coding.sh", "src", "core", "sessions.ts")
NODE = shutil.which("node")
HAS_OTEL = importlib.util.find_spec("opentelemetry") is not None and all(
    importlib.util.find_spec(m) is not None for m in ("opentelemetry.sdk", "opentelemetry.exporter.otlp.proto.http")
)


def _node_ok() -> bool:
    if not NODE or not os.path.exists(CORE):
        return False
    try:
        v = subprocess.run([NODE, "-v"], capture_output=True, text=True, timeout=10).stdout.strip().lstrip("v")
        major, minor = (int(x) for x in v.split(".")[:2])
        return (major, minor) >= (22, 6)
    except Exception:
        return False


MSGS = [{"role": "user", "content": "ping"}]
COMPARED = ("events", "turns", "toolCalls", "toolErrors", "filesChanged")


@unittest.skipUnless((HAS_OTEL and _node_ok()) or support.REQUIRE_ALL, "needs node >= 22.6, the core package and opentelemetry")
class GoldenTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        env = dict(os.environ, NODE_NO_WARNINGS="1")
        cls.proc = subprocess.Popen(
            [NODE, "--experimental-strip-types", "--no-warnings", HARNESS],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
            cwd=support.ROOT,
        )
        line = cls.proc.stdout.readline()
        if not line:
            raise RuntimeError("harness failed: " + cls.proc.stderr.read())
        urls = json.loads(line)
        cls.otlp, cls.ingest = urls["otlp"], urls["ingest"]

    @classmethod
    def tearDownClass(cls) -> None:
        coding_sh.shutdown(1.0)
        cls.proc.stdin.close()
        try:
            cls.proc.wait(10)
        except subprocess.TimeoutExpired:
            cls.proc.kill()
        cls.proc.stdout.close()
        cls.proc.stderr.close()

    def _session(self, sid: str, timeout: float = 5.0) -> dict:
        deadline = time.monotonic() + timeout
        q = urllib.request.quote(sid, safe="")
        while True:
            try:
                with urllib.request.urlopen(self.ingest + "/session?id=" + q, timeout=5) as r:
                    return json.loads(r.read())
            except urllib.error.HTTPError as e:
                if e.code != 404 or time.monotonic() > deadline:
                    raise
            time.sleep(0.05)

    # ------------------------------------------------------------------ the two senders

    def _send_sdk(self, sid: str) -> None:
        coding_sh.init(url=self.ingest, key=support.KEY, service="golden", flush_interval_ms=5)
        oa = coding_sh.observe(FakeOpenAI())
        an = coding_sh.observe(FakeAnthropic())
        # Turn 1: a trace with a model call, a tool call and a second model call.
        with coding_sh.trace("golden", session_id=sid, input="ping"):
            oa.chat.completions.create(model="gpt-4o-mini", messages=MSGS)
            with coding_sh.span("tool", "lookup_order", input={"id": 42}) as s:
                s.set_output("shipped")
            an.messages.create(model="claude-x", max_tokens=16, messages=MSGS)
        # Turn 2: an untraced streaming call in the same conversation.
        with coding_sh.with_session(sid):
            list(oa.chat.completions.create(model="gpt-4o-mini", messages=MSGS, stream=True))
        self.assertTrue(coding_sh.flush(5))
        self.assertEqual(coding_sh.stats()["failed"], 0)

    def _send_otel(self, sid: str) -> None:
        from coding_sh.otel import configure

        provider = configure(service="golden", url=self.otlp, key=support.KEY, set_global=False, batch=False)
        tracer = provider.get_tracer("golden")
        inp = json.dumps([{"role": "user", "parts": [{"type": "text", "content": "ping"}]}])
        out = json.dumps([{"role": "assistant", "parts": [{"type": "text", "content": "pong"}]}])

        def chat(model: str, total_in: int, cache_read: int) -> None:
            with tracer.start_as_current_span("chat " + model) as sp:
                sp.set_attribute("gen_ai.operation.name", "chat")
                sp.set_attribute("gen_ai.request.model", model)
                sp.set_attribute("gen_ai.input.messages", inp)
                sp.set_attribute("gen_ai.output.messages", out)
                sp.set_attribute("gen_ai.usage.input_tokens", total_in)  # semconv: includes cached
                sp.set_attribute("gen_ai.usage.cache_read.input_tokens", cache_read)
                sp.set_attribute("gen_ai.usage.output_tokens", 500)

        with coding_sh.with_session(sid):  # ConversationSpanProcessor stamps gen_ai.conversation.id
            with tracer.start_as_current_span("golden") as root:
                root.set_attribute("gen_ai.input.messages", inp)
                chat("gpt-4o-mini", 1200, 200)
                with tracer.start_as_current_span("execute_tool lookup_order") as t:
                    t.set_attribute("gen_ai.operation.name", "execute_tool")
                    t.set_attribute("gen_ai.tool.name", "lookup_order")
                chat("claude-x", 1300, 300)
            chat("gpt-4o-mini", 1200, 200)
        provider.force_flush()
        provider.shutdown()

    # ------------------------------------------------------------------ the check

    def test_sdk_and_otel_give_equal_session_stats(self) -> None:
        self._send_sdk("golden-sdk")
        self._send_otel("golden-otel")
        sdk = self._session("golden-sdk")["stats"]
        otel = self._session("golden-otel")["stats"]
        if os.environ.get("GOLDEN_VERBOSE"):
            print(json.dumps({"sdk": sdk, "otel": otel}, indent=1))
        for k in COMPARED:
            self.assertEqual(sdk[k], otel[k], k)
        self.assertEqual(sdk["usage"], otel["usage"])
        self.assertEqual(sdk["latency"]["llmCalls"], otel["latency"]["llmCalls"])
        tokens = {k: sdk["usage"][k] for k in ("inputTokens", "outputTokens", "cacheReadTokens")}
        self.assertEqual(tokens, {"inputTokens": 3000, "outputTokens": 1500, "cacheReadTokens": 700})
        # The two gpt-4o-mini calls are priced from the built-in table on both paths; claude-x is not.
        self.assertAlmostEqual(sdk["usage"]["costUsd"], 0.00093, places=8)
        self.assertEqual((sdk["turns"], sdk["toolCalls"], sdk["latency"]["llmCalls"]), (2, 1, 3))


if __name__ == "__main__":
    unittest.main()
