"""coding.sh Python SDK: send LLM calls, traces and tool spans to a coding.sh server.

    import coding_sh
    from openai import OpenAI

    client = coding_sh.observe(OpenAI())        # also AsyncOpenAI, Anthropic, AsyncAnthropic

    with coding_sh.trace("support-reply", session_id=conversation_id, input=question):
        with coding_sh.span("tool", "lookup_order", input={"id": 42}) as s:
            s.set_output(lookup(42))
        client.chat.completions.create(model="gpt-4o-mini", messages=[...])

    coding_sh.weights_edit(name, shape, changed, l2, max_abs, base_sha256, edited_sha256)

Set CODING_SH_URL and CODING_SH_INGEST_KEY. Without a URL the SDK does nothing. It never
changes return values, errors or stream semantics, and never raises into the app.
Stdlib only; one daemon thread sends batches, and an atexit flush is bounded to 2 s.
"""

from ._client import __version__
from ._providers import observe
from ._trace import current_session_id, flush, init, shutdown, span, stats, trace, with_session
from ._weights import weights_checkpoint, weights_delta, weights_edit

__all__ = [
    "__version__",
    "init",
    "observe",
    "trace",
    "span",
    "with_session",
    "current_session_id",
    "flush",
    "shutdown",
    "stats",
    "weights_edit",
    "weights_checkpoint",
    "weights_delta",
]
