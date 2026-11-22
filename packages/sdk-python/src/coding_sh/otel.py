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

Inside coding_sh.trace(), a span from the provider's tracers that would be a root (the context it
starts in holds no OTel span) gets the trace's open trace() or span() as parent and
`coding_sh.sdk_parent`, so it is a step of the trace's one turn, not a turn of its own. A span that names another session in its
start attributes stays a root. Spans with an OTel parent keep it.

Needs `pip install coding-sh[otel]` (opentelemetry-sdk, opentelemetry-exporter-otlp-proto-http).
Without them, configure() warns once and returns None; it never raises into the app.
"""

from __future__ import annotations

import logging
import os
import urllib.parse
from typing import Any, Dict, Optional

from ._client import base_url
from ._trace import current_session_id, current_span_ids

log = logging.getLogger("coding_sh")

CONVERSATION_ATTR = "gen_ai.conversation.id"
_SESSION_ATTRS = (CONVERSATION_ATTR, "session.id")

# Set on a span whose parent is a coding_sh.trace() or span(). The SDK sends those as events, never
# as spans, so the server waits for no parent and keeps the span a step of the trace's turn
# (src/otel/map.ts in coding.sh).
_SDK_PARENT_ATTR = "coding_sh.sdk_parent"


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
        env["OTEL_EXPORTER_OTLP_ENDPOINT"] = base_url(url)
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


def _trace_parent(context: Any, attributes: Any) -> Any:
    """A context whose span is the coding_sh.trace() or span() open here, or None.

    None unless the new span would be a root (neither `context` nor the current context holds a
    valid span) and names no session but the trace's.
    """
    from opentelemetry import trace as otel_trace

    ids = current_span_ids()
    if ids is None or otel_trace.get_current_span(context).get_span_context().is_valid:
        return None
    named = next((attributes[k] for k in _SESSION_ATTRS if attributes and attributes.get(k)), None)
    if named is not None and str(named) != current_session_id():
        return None
    flags = otel_trace.TraceFlags(otel_trace.TraceFlags.SAMPLED)
    parent = otel_trace.SpanContext(int(ids[0], 16), int(ids[1], 16), is_remote=False, trace_flags=flags)
    return otel_trace.set_span_in_context(otel_trace.NonRecordingSpan(parent), context) if parent.is_valid else None


def _join_traces(tracer: Any) -> Any:
    """Makes tracer.start_span (which start_as_current_span calls) use _trace_parent."""
    start = getattr(tracer, "start_span", None)
    if start is None or getattr(start, "_coding_sh", False):
        return tracer

    def start_span(name: str, context: Any = None, *args: Any, **kwargs: Any) -> Any:
        try:
            parent = _trace_parent(context, kwargs.get("attributes", args[1] if len(args) > 1 else None))
        except Exception:
            parent = None
        span = start(name, context if parent is None else parent, *args, **kwargs)
        if parent is not None:
            try:
                span.set_attribute(_SDK_PARENT_ATTR, True)
            except Exception:
                pass
        return span

    setattr(start_span, "_coding_sh", True)
    try:
        setattr(tracer, "start_span", start_span)
    except Exception:
        pass
    return tracer


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
            exporter_kwargs["endpoint"] = base_url(base) + "/v1/traces"
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

        class _TracerProvider(TracerProvider):
            def get_tracer(self, *args: Any, **kwargs: Any) -> Any:
                return _join_traces(super().get_tracer(*args, **kwargs))

        provider = _TracerProvider(resource=resource)
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
