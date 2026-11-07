from __future__ import annotations

import importlib.util
import os
import unittest

import support  # noqa: F401
from support import KEY, IngestServer

import coding_sh
from coding_sh import otel

HAS_OTEL = all(
    importlib.util.find_spec(m) is not None
    for m in ("opentelemetry.sdk", "opentelemetry.exporter.otlp.proto.http", "opentelemetry.proto")
) if importlib.util.find_spec("opentelemetry") is not None else False

OTEL_VARS = ("OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "OTEL_EXPORTER_OTLP_HEADERS", "OTEL_EXPORTER_OTLP_PROTOCOL", "OTEL_SERVICE_NAME")


class _FakeSpan:
    def __init__(self, attrs=None) -> None:  # noqa: ANN001
        self.attributes = dict(attrs or {})

    def set_attribute(self, k: str, v: object) -> None:
        self.attributes[k] = v


class OtelHelpersTest(unittest.TestCase):
    def test_otel_env_from_args(self) -> None:
        env = otel.otel_env("https://obs.example.com/", KEY, "checkout-api")
        self.assertEqual(
            env,
            {
                "OTEL_EXPORTER_OTLP_ENDPOINT": "https://obs.example.com",
                "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
                "OTEL_EXPORTER_OTLP_HEADERS": "Authorization=Bearer%20" + KEY,
                "OTEL_SERVICE_NAME": "checkout-api",
            },
        )

    def test_otel_env_from_env(self) -> None:
        os.environ.update({"CODING_SH_URL": "http://127.0.0.1:4318", "CODING_SH_INGEST_KEY": KEY})
        try:
            env = otel.otel_env()
        finally:
            os.environ.pop("CODING_SH_URL")
            os.environ.pop("CODING_SH_INGEST_KEY")
        self.assertEqual(env["OTEL_EXPORTER_OTLP_ENDPOINT"], "http://127.0.0.1:4318")
        self.assertNotIn("OTEL_SERVICE_NAME", env)
        self.assertEqual(otel.otel_env(), {})

    def test_conversation_processor(self) -> None:
        p = otel.ConversationSpanProcessor()
        s = _FakeSpan()
        p.on_start(s)
        self.assertEqual(s.attributes, {})
        with coding_sh.with_session("conv-1"):
            s = _FakeSpan()
            p.on_start(s)
            self.assertEqual(s.attributes, {"gen_ai.conversation.id": "conv-1"})
            s = _FakeSpan({"gen_ai.conversation.id": "mine"})
            p.on_start(s)
            self.assertEqual(s.attributes["gen_ai.conversation.id"], "mine")
        coding_sh.init(url=None)
        with coding_sh.trace("t", session_id="conv-2"):
            s = _FakeSpan()
            p.on_start(s)
            self.assertEqual(s.attributes["gen_ai.conversation.id"], "conv-2")

    @unittest.skipIf(HAS_OTEL, "OpenTelemetry is installed")
    def test_configure_without_otel_returns_none(self) -> None:
        self.assertIsNone(otel.configure(url="http://127.0.0.1:9", key=KEY))


@unittest.skipUnless(HAS_OTEL, "opentelemetry-sdk / exporter-otlp-proto-http not installed")
class OtelExportTest(unittest.TestCase):
    def setUp(self) -> None:
        self.server = IngestServer()
        self.saved = {k: os.environ.pop(k) for k in OTEL_VARS if k in os.environ}

    def tearDown(self) -> None:
        for k in OTEL_VARS:
            os.environ.pop(k, None)
        os.environ.update(self.saved)
        self.server.close()

    def _spans(self):  # noqa: ANN202
        from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest

        out = []
        for r in self.server.requests:
            req = ExportTraceServiceRequest()
            req.ParseFromString(r["raw"])
            for rs in req.resource_spans:
                res = {a.key: a.value.string_value for a in rs.resource.attributes}
                for ss in rs.scope_spans:
                    for sp in ss.spans:
                        attrs = {}
                        for a in sp.attributes:
                            v = a.value
                            attrs[a.key] = v.string_value if v.HasField("string_value") else v.int_value
                        out.append((res, sp.name, attrs))
        return out

    def _chat_span(self, provider) -> None:  # noqa: ANN001
        tracer = provider.get_tracer("app")
        with coding_sh.with_session("j2-otel"):
            with tracer.start_as_current_span("chat mock-gpt") as span:
                span.set_attribute("gen_ai.operation.name", "chat")
                span.set_attribute("gen_ai.request.model", "mock-gpt")
                span.set_attribute("gen_ai.usage.input_tokens", 1000)
                span.set_attribute("gen_ai.usage.output_tokens", 500)
        provider.force_flush()
        provider.shutdown()

    def test_configure_with_coding_sh_args(self) -> None:
        provider = otel.configure(service="j2-otel", url=self.server.url, key=KEY, set_global=False, batch=False)
        self.assertIsNotNone(provider)
        self._chat_span(provider)
        self.assertEqual(self.server.requests[0]["path"], "/v1/traces")
        self.assertEqual(self.server.requests[0]["headers"]["authorization"], "Bearer " + KEY)
        (res, name, attrs), = self._spans()
        self.assertEqual(res["service.name"], "j2-otel")
        self.assertEqual(name, "chat mock-gpt")
        self.assertEqual(attrs["gen_ai.conversation.id"], "j2-otel")
        self.assertEqual(attrs["gen_ai.usage.input_tokens"], 1000)

    def test_configure_honors_standard_otel_env(self) -> None:
        os.environ.update(
            {
                "OTEL_EXPORTER_OTLP_ENDPOINT": self.server.url,
                "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
                "OTEL_EXPORTER_OTLP_HEADERS": "Authorization=Bearer%20" + KEY,
                "OTEL_SERVICE_NAME": "env-svc",
            }
        )
        provider = otel.configure(set_global=False, batch=False)
        self._chat_span(provider)
        self.assertEqual(self.server.requests[0]["path"], "/v1/traces")
        self.assertEqual(self.server.requests[0]["headers"]["authorization"], "Bearer " + KEY)
        (res, _, attrs), = self._spans()
        self.assertEqual(res["service.name"], "env-svc")
        self.assertEqual(attrs["gen_ai.conversation.id"], "j2-otel")

    def test_configure_without_endpoint_returns_none(self) -> None:
        self.assertIsNone(otel.configure(set_global=False))


if __name__ == "__main__":
    unittest.main()
