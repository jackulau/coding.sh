"""observe(client): wrap OpenAI / AsyncOpenAI / Anthropic / AsyncAnthropic clients in place.

Wrapped methods:
  OpenAI     chat.completions.create (+ parse), responses.create   sync and stream
  Anthropic  messages.create (sync and stream=True), messages.stream (the helper manager)

Wrapping is idempotent and patches the client's resource instances, so the client object, its
types and every other method stay exactly as they were. Clients made later with
`client.with_options(...)` are new objects: observe() them too.
"""

from __future__ import annotations

import functools
import inspect
from typing import Any, Callable, Dict, Optional, Tuple

from ._gateway import capturing, hook_responses
from ._llm import AsyncStream, LLMCall, SyncStream, content_text, g, given, last_user_text, _num
from ._trace import enabled

_MARK = "__coding_sh_wrapped__"

# ---------------------------------------------------------------------------- usage


def openai_usage(u: Any) -> Optional[Dict[str, float]]:
    if u is None:
        return None
    total = _num(g(u, "prompt_tokens"))
    if total is None:
        total = _num(g(u, "input_tokens"))
    out = _num(g(u, "completion_tokens"))
    if out is None:
        out = _num(g(u, "output_tokens"))
    details = g(u, "prompt_tokens_details") or g(u, "input_tokens_details")
    cached = _num(g(details, "cached_tokens")) or 0
    usage: Dict[str, float] = {}
    if total is not None:
        usage["inputTokens"] = max(0, total - cached)  # uncached input, the coding.sh convention
    if out is not None:
        usage["outputTokens"] = out
    if cached:
        usage["cacheReadTokens"] = cached
    return usage or None


def anthropic_usage(u: Any, into: Optional[Dict[str, float]] = None) -> Optional[Dict[str, float]]:
    if u is None:
        return into
    usage: Dict[str, float] = dict(into or {})
    for src, dst in (
        ("input_tokens", "inputTokens"),
        ("output_tokens", "outputTokens"),
        ("cache_read_input_tokens", "cacheReadTokens"),
        ("cache_creation_input_tokens", "cacheWriteTokens"),
    ):
        v = _num(g(u, src))
        if v is None:
            continue
        if dst.startswith("cache") and not v:
            usage.pop(dst, None)
            continue
        usage[dst] = v
    return usage or None


# ---------------------------------------------------------------------------- OpenAI chat


def _chat_response(call: LLMCall, resp: Any) -> None:
    m = g(resp, "model")
    if isinstance(m, str):
        call.response_model = m
    call.set_response_id(g(resp, "id"))
    call.usage = openai_usage(g(resp, "usage"))
    choices = g(resp, "choices") or []
    if choices:
        ch = choices[0]
        msg = g(ch, "message")
        text = content_text(g(msg, "content")) or content_text(g(msg, "refusal"))
        if text:
            call.text_parts = [text]
        fr = g(ch, "finish_reason")
        if isinstance(fr, str):
            call.stop_reason = fr
        for i, tc in enumerate(g(msg, "tool_calls") or []):
            fn = g(tc, "function")
            call.add_tool_call(i, g(tc, "id"), g(fn, "name"), g(fn, "arguments"))


def _make_chat_chunk_observer(swallow_usage: bool) -> Callable[[LLMCall, Any], bool]:
    def observe(call: LLMCall, chunk: Any) -> bool:
        m = g(chunk, "model")
        if isinstance(m, str) and m:
            call.response_model = m
        call.set_response_id(g(chunk, "id"))
        usage = g(chunk, "usage")
        if usage is not None:
            call.usage = openai_usage(usage)
        choices = g(chunk, "choices") or []
        for ch in choices:
            if (g(ch, "index", 0) or 0) != 0:
                continue
            delta = g(ch, "delta")
            c = g(delta, "content")
            if isinstance(c, str) and c:
                call.mark_first_token()
                call.text_parts.append(c)
            for tc in g(delta, "tool_calls") or []:
                call.mark_first_token()
                fn = g(tc, "function")
                call.add_tool_call(g(tc, "index", 0), g(tc, "id"), g(fn, "name"), args_delta=g(fn, "arguments"))
            fr = g(ch, "finish_reason")
            if isinstance(fr, str) and fr:
                call.stop_reason = fr
        # The usage-only final chunk exists only because we asked for it: hide it.
        return swallow_usage and not choices and usage is not None

    return observe


# ---------------------------------------------------------------------------- OpenAI responses


def _responses_response(call: LLMCall, resp: Any) -> None:
    m = g(resp, "model")
    if isinstance(m, str):
        call.response_model = m
    call.set_response_id(g(resp, "id"))
    u = openai_usage(g(resp, "usage"))
    if u:
        call.usage = u
    text = None
    try:
        t = getattr(resp, "output_text", None)  # SDK convenience property
        text = t if isinstance(t, str) and t else None
    except Exception:
        text = None
    parts = []
    for i, item in enumerate(g(resp, "output") or []):
        typ = g(item, "type")
        if typ == "message" and text is None:
            t = content_text(g(item, "content"))
            if t:
                parts.append(t)
        elif typ == "function_call":
            call.add_tool_call(i, g(item, "call_id") or g(item, "id"), g(item, "name"), g(item, "arguments"))
    if text is None and parts:
        text = "".join(parts)
    if text:
        call.text_parts = [text]
    reason = g(g(resp, "incomplete_details"), "reason")
    status = g(resp, "status")
    if isinstance(reason, str) and reason:
        call.stop_reason = reason
    elif isinstance(status, str) and status:
        call.stop_reason = status


def _responses_event(call: LLMCall, ev: Any) -> bool:
    typ = g(ev, "type")
    if typ == "response.output_text.delta":
        d = g(ev, "delta")
        if isinstance(d, str) and d:
            call.mark_first_token()
            call.text_parts.append(d)
    elif typ in ("response.function_call_arguments.delta", "response.output_item.added"):
        call.mark_first_token()
    elif typ in ("response.created", "response.in_progress"):
        m = g(g(ev, "response"), "model")
        if isinstance(m, str):
            call.response_model = m
        call.set_response_id(g(g(ev, "response"), "id"))
    elif typ in ("response.completed", "response.incomplete", "response.failed"):
        streamed = list(call.text_parts)
        _responses_response(call, g(ev, "response"))
        if not call.text_parts and streamed:
            call.text_parts = streamed
    return False


# ---------------------------------------------------------------------------- Anthropic


def _anthropic_message(call: LLMCall, msg: Any) -> None:
    if msg is None:
        return
    m = g(msg, "model")
    if isinstance(m, str):
        call.response_model = m
    call.set_response_id(g(msg, "id"))
    u = anthropic_usage(g(msg, "usage"))
    if u:
        call.usage = u
    parts = []
    for i, block in enumerate(g(msg, "content") or []):
        typ = g(block, "type")
        if typ == "text":
            t = g(block, "text")
            if isinstance(t, str) and t:
                parts.append(t)
        elif typ in ("tool_use", "server_tool_use"):
            call.add_tool_call(i, g(block, "id"), g(block, "name"), g(block, "input"))
    if parts:
        call.text_parts = ["".join(parts)]
    sr = g(msg, "stop_reason")
    if isinstance(sr, str):
        call.stop_reason = sr


def _anthropic_event(call: LLMCall, ev: Any) -> bool:
    typ = g(ev, "type")
    if typ == "message_start":
        msg = g(ev, "message")
        m = g(msg, "model")
        if isinstance(m, str):
            call.response_model = m
        call.set_response_id(g(msg, "id"))
        call.usage = anthropic_usage(g(msg, "usage"), call.usage)
    elif typ == "content_block_start":
        block = g(ev, "content_block")
        if g(block, "type") in ("tool_use", "server_tool_use"):
            call.mark_first_token()
            call.add_tool_call(g(ev, "index", 0), g(block, "id"), g(block, "name"))
        t = g(block, "text")
        if isinstance(t, str) and t:
            call.mark_first_token()
            call.text_parts.append(t)
    elif typ == "content_block_delta":
        d = g(ev, "delta")
        call.mark_first_token()
        if g(d, "type") == "text_delta":
            t = g(d, "text")
            if isinstance(t, str):
                call.text_parts.append(t)
        elif g(d, "type") == "input_json_delta" and g(ev, "index", 0) in call.tool_calls:
            call.add_tool_call(g(ev, "index", 0), args_delta=g(d, "partial_json"))
    elif typ == "message_delta":
        sr = g(g(ev, "delta"), "stop_reason")
        if isinstance(sr, str):
            call.stop_reason = sr
        call.usage = anthropic_usage(g(ev, "usage"), call.usage)
    return False


class _AnthropicStreamView:
    """What `with client.messages.stream(...) as s` yields: the real MessageStream, observed."""

    def __init__(self, stream: Any, call: LLMCall) -> None:
        self._cs_stream = stream
        self._cs_call = call

    def __iter__(self) -> Any:
        for ev in self._cs_stream:
            if g(ev, "type") in ("text", "content_block_delta", "input_json"):
                self._cs_call.mark_first_token()
            yield ev

    async def __aiter__(self) -> Any:
        async for ev in self._cs_stream:
            if g(ev, "type") in ("text", "content_block_delta", "input_json"):
                self._cs_call.mark_first_token()
            yield ev

    @property
    def text_stream(self) -> Any:
        inner = self._cs_stream.text_stream
        call = self._cs_call
        if hasattr(inner, "__aiter__"):

            async def agen() -> Any:
                async for t in inner:
                    call.mark_first_token()
                    yield t

            return agen()

        def gen() -> Any:
            for t in inner:
                call.mark_first_token()
                yield t

        return gen()

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_cs_"):
            raise AttributeError(name)
        return getattr(self._cs_stream, name)


class _AnthropicStreamManager:
    """Proxy over MessageStreamManager / AsyncMessageStreamManager."""

    def __init__(self, manager: Any, make_call: Callable[[], LLMCall]) -> None:
        self._cs_manager = manager
        self._cs_make_call = make_call
        self._cs_call: Optional[LLMCall] = None
        self._cs_view: Optional[_AnthropicStreamView] = None

    def _cs_finish(self, exc: Any) -> None:
        call = self._cs_call
        if call is None:
            return
        try:
            view = self._cs_view
            if view is not None:
                snap = None
                try:
                    snap = view._cs_stream.current_message_snapshot
                except Exception:
                    snap = None
                _anthropic_message(call, snap)
            call.end(exc if isinstance(exc, Exception) else None)
        except Exception:
            pass

    def __enter__(self) -> Any:
        call = self._cs_call = self._cs_make_call().start()
        try:
            with capturing(call):
                stream = self._cs_manager.__enter__()
        except Exception as e:
            call.end(e)
            raise
        self._cs_view = _AnthropicStreamView(stream, call)
        return self._cs_view

    def __exit__(self, *exc: Any) -> Any:
        try:
            return self._cs_manager.__exit__(*exc)
        finally:
            self._cs_finish(exc[1] if len(exc) > 1 else None)

    async def __aenter__(self) -> Any:
        call = self._cs_call = self._cs_make_call().start()
        try:
            with capturing(call):
                stream = await self._cs_manager.__aenter__()
        except Exception as e:
            call.end(e)
            raise
        self._cs_view = _AnthropicStreamView(stream, call)
        return self._cs_view

    async def __aexit__(self, *exc: Any) -> Any:
        try:
            return await self._cs_manager.__aexit__(*exc)
        finally:
            self._cs_finish(exc[1] if len(exc) > 1 else None)

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_cs_"):
            raise AttributeError(name)
        return getattr(self._cs_manager, name)


# ---------------------------------------------------------------------------- wrapping


Prepared = Tuple[LLMCall, Dict[str, Any], Callable[[LLMCall, Any], bool], Callable[[LLMCall, Any], None]]


def base_url_of(client: Any) -> Optional[str]:
    """The client's base URL, as a string (which gateway, if any, it talks to)."""
    try:
        url = getattr(client, "base_url", None)
        return str(url) if url else None
    except Exception:
        return None


def _prepare(provider: str, kind: str, kwargs: Dict[str, Any], base_url: Optional[str] = None) -> Prepared:
    model = kwargs.get("model")
    if kind == "responses":
        source = kwargs.get("input")
    else:
        source = kwargs.get("messages")
    call = LLMCall(provider, model, lambda: last_user_text(source))
    call.base_url = base_url
    observe: Callable[[LLMCall, Any], bool]
    finish: Callable[[LLMCall, Any], None]
    if kind == "chat":
        swallow = False
        if kwargs.get("stream") is True and not given(kwargs.get("stream_options")):
            kwargs = dict(kwargs)
            kwargs["stream_options"] = {"include_usage": True}
            swallow = True
        observe, finish = _make_chat_chunk_observer(swallow), _chat_response
    elif kind == "responses":
        observe, finish = _responses_event, _responses_response
    else:
        observe, finish = _anthropic_event, _anthropic_message
    return call, kwargs, observe, finish


def _handle(result: Any, call: LLMCall, call_kwargs: Dict[str, Any], observe: Any, finish: Any) -> Any:
    if call_kwargs.get("stream") is True:
        if hasattr(result, "__aiter__") and not hasattr(result, "__iter__"):
            return AsyncStream(result, call, observe)
        if hasattr(result, "__iter__"):
            return SyncStream(result, call, observe)
    try:
        finish(call, result)
    except Exception:
        pass
    call.end(None)
    return result


async def _ahandle(awaitable: Any, call: LLMCall, call_kwargs: Dict[str, Any], observe: Any, finish: Any) -> Any:
    try:
        with capturing(call):
            result = await awaitable
    except Exception as e:
        call.end(e)
        raise
    return _handle(result, call, call_kwargs, observe, finish)


def _wrap(resource: Any, attr: str, provider: str, kind: str, base_url: Optional[str] = None) -> None:
    orig = getattr(resource, attr, None)
    if orig is None or not callable(orig) or getattr(orig, _MARK, False):
        return

    def begin(kwargs: Dict[str, Any]) -> Optional[Prepared]:
        if not enabled():
            return None
        try:
            prepared = _prepare(provider, kind, kwargs, base_url)
            prepared[0].start()
            return prepared
        except Exception:
            return None

    if inspect.iscoroutinefunction(orig):

        @functools.wraps(orig)
        async def awrapper(*args: Any, **kwargs: Any) -> Any:
            p = begin(kwargs)
            if p is None:
                return await orig(*args, **kwargs)
            call, call_kwargs, observe, finish = p
            return await _ahandle(orig(*args, **call_kwargs), call, call_kwargs, observe, finish)

        wrapper: Any = awrapper
    else:
        # The SDKs' async methods are often plain functions returning a coroutine
        # (openai's @required_args), so an awaitable result is handled here too.
        @functools.wraps(orig)
        def swrapper(*args: Any, **kwargs: Any) -> Any:
            p = begin(kwargs)
            if p is None:
                return orig(*args, **kwargs)
            call, call_kwargs, observe, finish = p
            try:
                with capturing(call):
                    result = orig(*args, **call_kwargs)
            except Exception as e:
                call.end(e)
                raise
            if inspect.isawaitable(result):
                return _ahandle(result, call, call_kwargs, observe, finish)
            return _handle(result, call, call_kwargs, observe, finish)

        wrapper = swrapper
    try:
        setattr(wrapper, _MARK, True)
        setattr(resource, attr, wrapper)
    except Exception:
        pass


def _wrap_stream_helper(resource: Any, base_url: Optional[str] = None) -> None:
    orig = getattr(resource, "stream", None)
    if orig is None or not callable(orig) or getattr(orig, _MARK, False):
        return

    @functools.wraps(orig)
    def stream(*args: Any, **kwargs: Any) -> Any:
        if not enabled():
            return orig(*args, **kwargs)
        manager = orig(*args, **kwargs)
        try:
            messages = kwargs.get("messages")
            model = kwargs.get("model")

            def make_call() -> LLMCall:
                call = LLMCall("anthropic", model, lambda: last_user_text(messages))
                call.base_url = base_url
                return call

            return _AnthropicStreamManager(manager, make_call)
        except Exception:
            return manager

    try:
        setattr(stream, _MARK, True)
        setattr(resource, "stream", stream)
    except Exception:
        pass


def _resource(obj: Any, *path: str) -> Any:
    for p in path:
        try:
            obj = getattr(obj, p)
        except Exception:
            return None
        if obj is None:
            return None
    return obj


def _provider_of(client: Any) -> Optional[str]:
    for cls in type(client).__mro__:
        mod = (getattr(cls, "__module__", "") or "").split(".")[0]
        if mod in ("openai", "anthropic"):
            return mod
    return None


def observe(client: Any) -> Any:
    """Record every model call made through `client`. Returns the same client.

    Supports openai.OpenAI / AsyncOpenAI (and Azure variants) and anthropic.Anthropic /
    AsyncAnthropic (and Bedrock/Vertex variants). Anything else is returned untouched.
    """
    try:
        provider = _provider_of(client)
        base = base_url_of(client) if provider else None
        if provider:
            hook_responses(client)
        if provider == "openai":
            completions = _resource(client, "chat", "completions")
            if completions is not None:
                _wrap(completions, "create", "openai", "chat", base)
                _wrap(completions, "parse", "openai", "chat", base)
            responses = _resource(client, "responses")
            if responses is not None:
                _wrap(responses, "create", "openai", "responses", base)
        elif provider == "anthropic":
            messages = _resource(client, "messages")
            if messages is not None:
                _wrap(messages, "create", "anthropic", "messages", base)
                _wrap_stream_helper(messages, base)
    except Exception:
        pass
    return client
