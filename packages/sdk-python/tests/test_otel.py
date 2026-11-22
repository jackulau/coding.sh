from __future__ import annotations

import importlib.util
import os
import sys
import unittest

import support  # noqa: F401
from support import KEY, IngestServer, by_kind, collect, start_sdk

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

    def test_otel_env_takes_the_base_of_a_url_ending_in_v1_traces_or_v1_ingest(self) -> None:
        # The exporter adds /v1/traces to OTEL_EXPORTER_OTLP_ENDPOINT itself.
        for url in ("https://obs.example.com/v1/traces", "https://obs.example.com/v1/ingest/"):
            with self.subTest(url=url):
                self.assertEqual(otel.otel_env(url)["OTEL_EXPORTER_OTLP_ENDPOINT"], "https://obs.example.com")

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

    def test_configure_without_otel_returns_none(self) -> None:
        # Hide OpenTelemetry (a None entry in sys.modules makes the import fail), so this runs
        # whether or not the otel extra is installed.
        hidden = {k: v for k, v in sys.modules.items() if k == "opentelemetry" or k.startswith("opentelemetry.")}
        try:
            for k in hidden:
                del sys.modules[k]
            sys.modules["opentelemetry"] = None  # type: ignore[assignment]
            self.assertIsNone(otel.configure(url="http://127.0.0.1:9", key=KEY))
        finally:
            del sys.modules["opentelemetry"]
            sys.modules.update(hidden)


@unittest.skipUnless(HAS_OTEL or support.REQUIRE_ALL, "opentelemetry-sdk / exporter-otlp-proto-http not installed")
class OtelExportTest(unittest.TestCase):
    def setUp(self) -> None:
        self.server = IngestServer()
        self.saved = {k: os.environ.pop(k) for k in OTEL_VARS if k in os.environ}

    def tearDown(self) -> None:
        for k in OTEL_VARS:
            os.environ.pop(k, None)
        os.environ.update(self.saved)
        self.server.close()

    def _records(self):  # noqa: ANN202
        """Every exported span: its resource attributes, name, attributes and ids (hex, "" for none)."""
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
                            which = a.value.WhichOneof("value")
                            attrs[a.key] = getattr(a.value, which) if which else None
                        out.append(
                            {
                                "resource": res,
                                "name": sp.name,
                                "attrs": attrs,
                                "trace_id": sp.trace_id.hex(),
                                "span_id": sp.span_id.hex(),
                                "parent_span_id": sp.parent_span_id.hex(),
                            }
                        )
        return out

    def _spans(self):  # noqa: ANN202
        return [(s["resource"], s["name"], s["attrs"]) for s in self._records()]

    def _with_sdk(self, body):  # noqa: ANN001, ANN202
        """Runs body(tracer) while the SDK sends its native events to a second fake server.

        Returns the spans exported to self.server by name, the native events, and what body returned.
        """
        native = IngestServer()
        try:
            start_sdk(native)
            provider = otel.configure(service="j2-otel", url=self.server.url, key=KEY, set_global=False, batch=False)
            result = body(provider.get_tracer("app"))
            provider.force_flush()
            provider.shutdown()
            events = collect(native)
        finally:
            coding_sh.shutdown(1.0)
            native.close()
        return {s["name"]: s for s in self._records()}, events, result

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

    def test_configure_with_a_url_ending_in_v1_ingest_exports_to_v1_traces(self) -> None:
        provider = otel.configure(service="j2-otel", url=self.server.url + "/v1/ingest", key=KEY, set_global=False, batch=False)
        self._chat_span(provider)
        self.assertEqual([r["path"] for r in self.server.requests], ["/v1/traces"])

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

    # A coding_sh.trace() sends events, never a span. A span that would be a root inside it gets the
    # trace's id, the trace's open trace or step span as parent, and coding_sh.sdk_parent, so the
    # server maps it as a step of the trace's one turn instead of a turn of its own.

    def test_a_span_that_would_be_a_root_inside_trace_is_a_step_of_it(self) -> None:
        from opentelemetry.context import Context

        def body(tracer):  # noqa: ANN001, ANN202
            with coding_sh.trace("handler", input="handle it") as t:
                with tracer.start_as_current_span("chat mock-gpt"):
                    with tracer.start_as_current_span("POST /v1/chat/completions"):
                        pass
                # start_span with a context that holds no span, passed by position
                tracer.start_span("embeddings mock-embed", Context()).end()
            return t

        spans, events, t = self._with_sdk(body)
        root = by_kind(events, "session.start")[0]
        for name in ("chat mock-gpt", "embeddings mock-embed"):
            with self.subTest(name=name):
                s = spans[name]
                self.assertEqual((s["trace_id"], s["parent_span_id"]), (t.trace_id, root["spanId"]))
                self.assertIs(s["attrs"]["coding_sh.sdk_parent"], True)
                self.assertEqual(s["attrs"]["gen_ai.conversation.id"], t.session_id)
        # A span with an OTel parent keeps it.
        nested = spans["POST /v1/chat/completions"]
        self.assertEqual((nested["trace_id"], nested["parent_span_id"]), (t.trace_id, spans["chat mock-gpt"]["span_id"]))
        self.assertNotIn("coding_sh.sdk_parent", nested["attrs"])

    def test_a_span_inside_a_step_span_has_the_step_as_parent(self) -> None:
        def body(tracer):  # noqa: ANN001, ANN202
            with coding_sh.trace("handler", session_id="conv-x") as t:
                with coding_sh.span("step", "plan"):
                    with tracer.start_as_current_span("chat mock-gpt"):
                        pass
            return t

        spans, events, t = self._with_sdk(body)
        step = by_kind(events, "span")[0]
        chat = spans["chat mock-gpt"]
        self.assertEqual((chat["trace_id"], chat["parent_span_id"]), (t.trace_id, step["spanId"]))
        self.assertIs(chat["attrs"]["coding_sh.sdk_parent"], True)
        self.assertEqual(chat["attrs"]["gen_ai.conversation.id"], "conv-x")

    def test_spans_outside_trace_naming_another_session_or_under_an_otel_span_are_unchanged(self) -> None:
        def body(tracer):  # noqa: ANN001, ANN202
            with tracer.start_as_current_span("outside"):
                pass
            with coding_sh.trace("handler") as t:
                with tracer.start_as_current_span("other session", attributes={"gen_ai.conversation.id": "conv-other"}):
                    pass
            with tracer.start_as_current_span("request"):  # opened before the trace
                with coding_sh.trace("handler 2"):
                    with tracer.start_as_current_span("under request"):
                        pass
            return t

        spans, _, t = self._with_sdk(body)
        for name in ("outside", "other session", "request"):
            with self.subTest(name=name):
                s = spans[name]
                self.assertEqual(s["parent_span_id"], "")
                self.assertNotEqual(s["trace_id"], t.trace_id)
                self.assertNotIn("coding_sh.sdk_parent", s["attrs"])
        self.assertEqual(spans["other session"]["attrs"]["gen_ai.conversation.id"], "conv-other")
        under, request = spans["under request"], spans["request"]
        self.assertEqual((under["trace_id"], under["parent_span_id"]), (request["trace_id"], request["span_id"]))
        self.assertNotIn("coding_sh.sdk_parent", under["attrs"])


if __name__ == "__main__":
    unittest.main()
