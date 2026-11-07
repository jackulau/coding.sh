"""Model-call recording and stream proxies shared by the provider wrappers.

The wrappers never change what the app sees: return values are the provider's own objects
(streams are proxied, every other attribute passes through), exceptions propagate unchanged,
and recording errors are swallowed.
"""

from __future__ import annotations

import time
from typing import Any, Callable, Dict, List, Optional

from ._client import dumps
from ._trace import Scope, clip, emit, full_capture


def g(obj: Any, key: str, default: Any = None) -> Any:
    """Read a field from a pydantic model, a plain object or a dict."""
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(key, default)
    try:
        return getattr(obj, key, default)
    except Exception:
        return default


def given(v: Any) -> bool:
    """False for None and the SDKs' NOT_GIVEN / omit sentinels."""
    return v is not None and type(v).__name__ not in ("NotGiven", "Omit")


def _num(v: Any) -> Optional[float]:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return v if v >= 0 else None


def content_text(content: Any) -> Optional[str]:
    """Text of a message `content`: a string, or a list of text parts/blocks."""
    if isinstance(content, str):
        return content
    if isinstance(content, (list, tuple)):
        parts = []
        for p in content:
            if isinstance(p, str):
                parts.append(p)
                continue
            t = g(p, "type")
            if t in (None, "text", "input_text", "output_text"):
                txt = g(p, "text")
                if isinstance(txt, str) and txt:
                    parts.append(txt)
        return "\n".join(parts) if parts else None
    return None


def last_user_text(messages: Any) -> Optional[str]:
    if isinstance(messages, str):
        return messages
    if not isinstance(messages, (list, tuple)):
        return None
    for m in reversed(messages):
        if g(m, "role") == "user":
            t = content_text(g(m, "content"))
            if t:
                return t
    return None


class LLMCall(Scope):
    """One model API call: llm.call + assistant.message (plus an implicit root when untraced)."""

    bind_context = False

    def __init__(self, provider: str, request_model: Any, input_fn: Callable[[], Optional[str]]) -> None:
        super().__init__()
        self.provider = provider
        self.operation = "chat"
        self.request_model = request_model if isinstance(request_model, str) else None
        self._input_fn = input_fn
        self.response_model: Optional[str] = None
        self.text_parts: List[str] = []
        self.stop_reason: Optional[str] = None
        self.usage: Optional[Dict[str, float]] = None
        self.tool_calls: Dict[Any, Dict[str, Any]] = {}
        self.ttft_ms: Optional[float] = None
        self.response_id: Optional[str] = None
        self.gateway: Optional[str] = None

    def mark_first_token(self) -> None:
        if self.ttft_ms is None and self._p0:
            self.ttft_ms = round((time.perf_counter() - self._p0) * 1000.0, 3)

    def add_tool_call(self, key: Any, id: Any = None, name: Any = None, arguments: Any = None, args_delta: Any = None) -> None:
        tc = self.tool_calls.setdefault(key, {})
        if isinstance(id, str) and id:
            tc["id"] = id
        if isinstance(name, str) and name:
            tc["name"] = name
        if arguments is not None:
            tc["arguments"] = arguments
        if isinstance(args_delta, str) and args_delta:
            tc["arguments"] = (tc.get("arguments") if isinstance(tc.get("arguments"), str) else "") + args_delta

    def set_response_id(self, v: Any) -> None:
        if isinstance(v, str) and v:
            self.response_id = v

    def _tool_calls_payload(self) -> List[Dict[str, Any]]:
        out = []
        for tc in self.tool_calls.values():
            if not tc.get("name"):
                continue
            o: Dict[str, Any] = {"name": tc["name"]}
            if tc.get("id"):
                o["id"] = tc["id"]
            args = tc.get("arguments")
            if args is not None and full_capture():
                o["arguments"] = clip(args if isinstance(args, str) else dumps(args))
            out.append(o)
        return out

    def _root_name(self) -> str:
        return self.operation + (" " + self.request_model if self.request_model else "")

    def _root_input(self) -> Optional[str]:
        try:
            return self._input_fn()
        except Exception:
            return None

    def _on_end(self, error: Optional[BaseException], duration: float, end_ts: float) -> None:
        if self.node is None:
            return
        from ._trace import error_text

        p: Dict[str, Any] = {
            "provider": self.provider,
            "requestModel": self.request_model,
            "responseModel": self.response_model,
            "operation": self.operation,
            "ttftMs": self.ttft_ms,
            "stopReason": self.stop_reason,
            "ok": error is None,
            "error": error_text(error) if error else None,
            "responseId": self.response_id,
            "gateway": self.gateway,
        }
        calls = self._tool_calls_payload()
        if calls:
            p["toolCalls"] = calls
        out = (self.usage or {}).get("outputTokens")
        if out and duration > 0:
            p["tokensPerSec"] = round(out / (duration / 1000.0), 2)
        model = self.response_model or self.request_model
        nested = not self.is_root
        emit(self.node.event("llm.call", self._t0, p, anchor=nested, child=nested, durationMs=duration, model=model, usage=self.usage or None))
        text = "".join(self.text_parts)
        if text and full_capture():
            emit(self.node.event("assistant.message", end_ts, {"text": clip(text)}, child=nested, model=model))


# ---------------------------------------------------------------------------- streams


class SyncStream:
    """Proxy over a provider's sync stream: same items, same attributes, records on the side."""

    def __init__(self, stream: Any, call: LLMCall, observe: Callable[[LLMCall, Any], bool]) -> None:
        self._cs_stream = stream
        self._cs_call = call
        self._cs_observe = observe
        self._cs_it: Any = None

    def _cs_finish(self, error: Optional[BaseException] = None) -> None:
        try:
            self._cs_call.end(error)
        except Exception:
            pass

    def __iter__(self) -> "SyncStream":
        return self

    def __next__(self) -> Any:
        if self._cs_it is None:
            self._cs_it = iter(self._cs_stream)
        while True:
            try:
                item = next(self._cs_it)
            except StopIteration:
                self._cs_finish()
                raise
            except Exception as e:
                self._cs_finish(e)
                raise
            except BaseException:
                self._cs_finish()
                raise
            swallow = False
            try:
                swallow = self._cs_observe(self._cs_call, item)
            except Exception:
                pass
            if not swallow:
                return item

    def __enter__(self) -> "SyncStream":
        enter = getattr(self._cs_stream, "__enter__", None)
        if enter is not None:
            enter()
        return self

    def __exit__(self, *exc: Any) -> Any:
        try:
            ex = getattr(self._cs_stream, "__exit__", None)
            return ex(*exc) if ex is not None else None
        finally:
            self._cs_finish(exc[1] if len(exc) > 1 and isinstance(exc[1], Exception) else None)

    def close(self) -> Any:
        try:
            return self._cs_stream.close()
        finally:
            self._cs_finish()

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_cs_"):
            raise AttributeError(name)
        return getattr(self._cs_stream, name)

    def __del__(self) -> None:
        try:
            self._cs_finish()
        except Exception:
            pass


class AsyncStream:
    """Proxy over a provider's async stream."""

    def __init__(self, stream: Any, call: LLMCall, observe: Callable[[LLMCall, Any], bool]) -> None:
        self._cs_stream = stream
        self._cs_call = call
        self._cs_observe = observe
        self._cs_it: Any = None

    def _cs_finish(self, error: Optional[BaseException] = None) -> None:
        try:
            self._cs_call.end(error)
        except Exception:
            pass

    def __aiter__(self) -> "AsyncStream":
        return self

    async def __anext__(self) -> Any:
        if self._cs_it is None:
            self._cs_it = self._cs_stream.__aiter__()
        while True:
            try:
                item = await self._cs_it.__anext__()
            except StopAsyncIteration:
                self._cs_finish()
                raise
            except Exception as e:
                self._cs_finish(e)
                raise
            except BaseException:
                self._cs_finish()
                raise
            swallow = False
            try:
                swallow = self._cs_observe(self._cs_call, item)
            except Exception:
                pass
            if not swallow:
                return item

    async def __aenter__(self) -> "AsyncStream":
        enter = getattr(self._cs_stream, "__aenter__", None)
        if enter is not None:
            await enter()
        return self

    async def __aexit__(self, *exc: Any) -> Any:
        try:
            ex = getattr(self._cs_stream, "__aexit__", None)
            return (await ex(*exc)) if ex is not None else None
        finally:
            self._cs_finish(exc[1] if len(exc) > 1 and isinstance(exc[1], Exception) else None)

    async def close(self) -> Any:
        try:
            r = self._cs_stream.close()
            if hasattr(r, "__await__"):
                r = await r
            return r
        finally:
            self._cs_finish()

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_cs_"):
            raise AttributeError(name)
        return getattr(self._cs_stream, name)

    def __del__(self) -> None:
        try:
            self._cs_finish()
        except Exception:
            pass
