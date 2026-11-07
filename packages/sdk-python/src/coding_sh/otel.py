"""OpenTelemetry gen_ai setup for coding.sh, for apps that already emit OTel spans.

coding.sh serve takes OTLP/HTTP at <url>/v1/traces, so plain OTel works with four env vars
(docs/PRODUCTION.md section 4.3). This module only saves the boilerplate:

    from coding_sh.otel import configure
    configure(service="checkout-api")   # TracerProvider + OTLP/HTTP exporter + Bearer key

    # or, for a subprocess / `opentelemetry-instrument`:
    env = {**os.environ, **coding_sh.otel.otel_env()}

configure() resolves the endpoint like this: explicit `url`, then the standard
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT / OTEL_EXPORTER_OTLP_ENDPOINT (left to the exporter, with
OTEL_EXPORTER_OTLP_HEADERS), then CODING_SH_URL + CODING_SH_INGEST_KEY. It also stamps
`gen_ai.conversation.id` on spans started inside coding_sh.with_session(...) or
coding_sh.trace(session_id=...), so OTel spans group into the same conversation session.

Needs `pip install coding-sh[otel]` (opentelemetry-sdk, opentelemetry-exporter-otlp-proto-http).
Without them, configure() warns once and returns None; it never raises into the app.
"""

from __future__ import annotations

import logging
import os
import urllib.parse
from typing import Any, Dict, Optional

from ._trace import current_session_id

log = logging.getLogger("coding_sh")

CONVERSATION_ATTR = "gen_ai.conversation.id"


def _env(name: str) -> Optional[str]:
    v = os.environ.get(name)
    return v if v else None


def otel_env(url: Optional[str] = None, key: Optional[str] = None, service: Optional[str] = None) -> Dict[str, str]:
    """OTEL_* exporter env vars that point any OTel SDK at a coding.sh server.

    Defaults come from CODING_SH_URL, CODING_SH_INGEST_KEY and CODING_SH_SERVICE. The result
    holds the ingest key: pass it to a child process, never log it.
    """
    url = url or _env("CODING_SH_URL")
    key = key or _env("CODING_SH_INGEST_KEY")
    service = service or _env("CODING_SH_SERVICE") or _env("OTEL_SERVICE_NAME")
    env: Dict[str, str] = {}
    if url:
        env["OTEL_EXPORTER_OTLP_ENDPOINT"] = url.rstrip("/")
        env["OTEL_EXPORTER_OTLP_PROTOCOL"] = "http/protobuf"
    if key:
        env["OTEL_EXPORTER_OTLP_HEADERS"] = "Authorization=" + urllib.parse.quote("Bearer " + key)
    if service:
        env["OTEL_SERVICE_NAME"] = service
    return env


class ConversationSpanProcessor:
    """Sets gen_ai.conversation.id from the current coding.sh session on every new span."""

    def on_start(self, span: Any, parent_context: Any = None) -> None:
        try:
            sid = current_session_id()
            if not sid:
                return
            attrs = getattr(span, "attributes", None) or {}
            if CONVERSATION_ATTR not in attrs and "session.id" not in attrs:
                span.set_attribute(CONVERSATION_ATTR, sid)
        except Exception:
            pass

    def on_end(self, span: Any) -> None:
        pass

    def _on_ending(self, span: Any) -> None:  # newer SDKs call this hook
        pass

    def shutdown(self) -> None:
        pass

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        return True


_warned = False


def configure(
    service: Optional[str] = None,
    url: Optional[str] = None,
    key: Optional[str] = None,
    set_global: bool = True,
    batch: bool = True,
) -> Any:
    """Build (and by default install) a TracerProvider that exports to coding.sh.

    Returns the provider, or None when OpenTelemetry is not installed or no endpoint is known.
    Call provider.shutdown() (or rely on the SDK's atexit hook) to flush on exit.
    """
    global _warned
    try:
        from opentelemetry import trace as otel_trace
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor, SimpleSpanProcessor
    except Exception:
        if not _warned:
            _warned = True
            log.warning("coding.sh: OpenTelemetry is not installed; pip install 'coding-sh[otel]'")
        return None
    try:
        exporter_kwargs: Dict[str, Any] = {}
        has_otel_endpoint = bool(_env("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") or _env("OTEL_EXPORTER_OTLP_ENDPOINT"))
        base = url or (None if has_otel_endpoint else _env("CODING_SH_URL"))
        if base:
            base = base.rstrip("/")
            exporter_kwargs["endpoint"] = base if base.endswith("/v1/traces") else base + "/v1/traces"
        elif not has_otel_endpoint:
            if not _warned:
                _warned = True
                log.warning("coding.sh: no endpoint; set CODING_SH_URL or OTEL_EXPORTER_OTLP_ENDPOINT")
            return None
        k = key or (None if (has_otel_endpoint and not url) else _env("CODING_SH_INGEST_KEY"))
        if k:
            exporter_kwargs["headers"] = {"Authorization": "Bearer " + k}
        name = service or _env("OTEL_SERVICE_NAME") or _env("CODING_SH_SERVICE")
        resource = Resource.create({"service.name": name} if name else {})
        provider = TracerProvider(resource=resource)
        provider.add_span_processor(ConversationSpanProcessor())  # type: ignore[arg-type]
        exporter = OTLPSpanExporter(**exporter_kwargs)
        provider.add_span_processor(BatchSpanProcessor(exporter) if batch else SimpleSpanProcessor(exporter))
        if set_global:
            otel_trace.set_tracer_provider(provider)
        return provider
    except Exception as e:
        log.warning("coding.sh: OpenTelemetry setup failed: %s", type(e).__name__)
        return None


__all__ = ["configure", "otel_env", "ConversationSpanProcessor", "CONVERSATION_ATTR"]
