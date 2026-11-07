"""Duck-typed stand-ins for the openai and anthropic clients (no packages needed).

Their classes claim the provider's module name, which is how observe() recognizes a client.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

USAGE = {"prompt_tokens": 1200, "completion_tokens": 500, "prompt_tokens_details": {"cached_tokens": 200}}


def _provider(module: str):
    def deco(cls: Any) -> Any:
        cls.__module__ = module
        return cls

    return deco


class FakeStream:
    def __init__(self, items: List[Any]) -> None:
        self._items = items
        self.closed = False
        self.response = "raw-response"

    def __iter__(self) -> Any:
        for i in self._items:
            if isinstance(i, BaseException):
                raise i
            yield i

    def __enter__(self) -> "FakeStream":
        return self

    def __exit__(self, *a: Any) -> None:
        self.close()

    def close(self) -> None:
        self.closed = True


class FakeAsyncStream:
    def __init__(self, items: List[Any]) -> None:
        self._items = items
        self.closed = False
        self.response = "raw-response"

    async def _gen(self) -> Any:
        for i in self._items:
            if isinstance(i, BaseException):
                raise i
            yield i

    def __aiter__(self) -> Any:
        return self._gen()

    async def __aenter__(self) -> "FakeAsyncStream":
        return self

    async def __aexit__(self, *a: Any) -> None:
        await self.close()

    async def close(self) -> None:
        self.closed = True


def chat_completion(model: str, tool_calls: Optional[list] = None) -> Dict[str, Any]:
    msg: Dict[str, Any] = {"role": "assistant", "content": None if tool_calls else "pong"}
    if tool_calls:
        msg["tool_calls"] = tool_calls
    return {
        "id": "c1",
        "model": model + "-2024-07-18",
        "choices": [{"index": 0, "message": msg, "finish_reason": "tool_calls" if tool_calls else "stop"}],
        "usage": dict(USAGE),
    }


def chat_chunks(model: str, include_usage: bool, error: Optional[BaseException] = None) -> List[Any]:
    m = model + "-2024-07-18"
    items: List[Any] = [
        {"model": m, "choices": [{"index": 0, "delta": {"role": "assistant", "content": ""}, "finish_reason": None}], "usage": None},
        {"model": m, "choices": [{"index": 0, "delta": {"content": "po"}, "finish_reason": None}], "usage": None},
    ]
    if error is not None:
        items.append(error)
    items += [
        {"model": m, "choices": [{"index": 0, "delta": {"content": "ng"}, "finish_reason": None}], "usage": None},
        {"model": m, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": None},
    ]
    if include_usage:
        items.append({"model": m, "choices": [], "usage": dict(USAGE)})
    return items


class _Completions:
    def __init__(self, client: "FakeOpenAI") -> None:
        self.client = client

    def create(self, **kw: Any) -> Any:
        self.client.calls.append(kw)
        if self.client.error is not None:
            raise self.client.error
        model = kw["model"]
        if kw.get("stream"):
            inc = bool((kw.get("stream_options") or {}).get("include_usage"))
            return FakeStream(chat_chunks(model, inc, self.client.stream_error))
        return chat_completion(model, self.client.tool_calls)


class _Responses:
    def __init__(self, client: "FakeOpenAI") -> None:
        self.client = client

    def create(self, **kw: Any) -> Any:
        self.client.calls.append(kw)
        resp = {
            "model": kw["model"],
            "status": "completed",
            "output": [
                {"type": "message", "content": [{"type": "output_text", "text": "pong"}]},
                {"type": "function_call", "call_id": "call_9", "name": "lookup"},
            ],
            "usage": {"input_tokens": 1000, "output_tokens": 500, "input_tokens_details": {"cached_tokens": 0}},
        }
        if kw.get("stream"):
            return FakeStream(
                [
                    {"type": "response.created", "response": dict(resp, status="in_progress", output=[], usage=None)},
                    {"type": "response.output_text.delta", "delta": "po"},
                    {"type": "response.output_text.delta", "delta": "ng"},
                    {"type": "response.completed", "response": resp},
                ]
            )
        return resp


class _Chat:
    def __init__(self, client: "FakeOpenAI") -> None:
        self.completions = _Completions(client)


@_provider("openai._client")
class FakeOpenAI:
    def __init__(self) -> None:
        self.calls: List[Dict[str, Any]] = []
        self.error: Optional[BaseException] = None
        self.stream_error: Optional[BaseException] = None
        self.tool_calls: Optional[list] = None
        self.chat = _Chat(self)
        self.responses = _Responses(self)


class _AsyncCompletions:
    def __init__(self, client: "FakeAsyncOpenAI") -> None:
        self.client = client

    async def create(self, **kw: Any) -> Any:
        self.client.calls.append(kw)
        if self.client.error is not None:
            raise self.client.error
        if kw.get("stream"):
            inc = bool((kw.get("stream_options") or {}).get("include_usage"))
            return FakeAsyncStream(chat_chunks(kw["model"], inc))
        return chat_completion(kw["model"])


class _AsyncCompletionsRequiredArgs(_AsyncCompletions):
    """Like openai's real async create: a plain function (decorator) returning a coroutine."""

    def create(self, **kw: Any) -> Any:  # type: ignore[override]
        return _AsyncCompletions.create(self, **kw)


class _AsyncChat:
    def __init__(self, client: "FakeAsyncOpenAI", plain: bool) -> None:
        self.completions = _AsyncCompletionsRequiredArgs(client) if plain else _AsyncCompletions(client)


@_provider("openai._client")
class FakeAsyncOpenAI:
    def __init__(self, plain_def: bool = False) -> None:
        self.calls: List[Dict[str, Any]] = []
        self.error: Optional[BaseException] = None
        self.chat = _AsyncChat(self, plain_def)


# ---------------------------------------------------------------------------- anthropic


def anthropic_message(model: str) -> Dict[str, Any]:
    return {
        "id": "m1",
        "type": "message",
        "model": model,
        "content": [{"type": "text", "text": "pong"}, {"type": "tool_use", "id": "toolu_1", "name": "lookup", "input": {}}],
        "stop_reason": "tool_use",
        "usage": {"input_tokens": 1000, "output_tokens": 500, "cache_read_input_tokens": 300, "cache_creation_input_tokens": 0},
    }


def anthropic_events(model: str) -> List[Dict[str, Any]]:
    return [
        {"type": "message_start", "message": {"model": model, "content": [], "usage": {"input_tokens": 1000, "output_tokens": 1}}},
        {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "po"}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "ng"}},
        {"type": "content_block_stop", "index": 0},
        {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 500}},
        {"type": "message_stop"},
    ]


class FakeMessageStream:
    """Mimics anthropic's MessageStream: iterable events, text_stream, a snapshot."""

    def __init__(self, model: str) -> None:
        self._events = anthropic_events(model)
        self._model = model
        self._consumed = False

    def _consume(self) -> Any:
        for e in self._events:
            yield e
        self._consumed = True

    def __iter__(self) -> Any:
        return self._consume()

    @property
    def text_stream(self) -> Any:
        def gen() -> Any:
            for e in self._consume():
                if e["type"] == "content_block_delta":
                    yield e["delta"]["text"]

        return gen()

    def get_final_message(self) -> Dict[str, Any]:
        for _ in self._consume():
            pass
        return self.current_message_snapshot

    @property
    def current_message_snapshot(self) -> Dict[str, Any]:
        m = anthropic_message(self._model)
        m["content"] = [{"type": "text", "text": "pong"}]
        m["stop_reason"] = "end_turn"
        m["usage"] = {"input_tokens": 1000, "output_tokens": 500}
        return m


class FakeAsyncMessageStream(FakeMessageStream):
    async def _aconsume(self) -> Any:
        for e in self._events:
            yield e

    def __aiter__(self) -> Any:
        return self._aconsume()

    @property
    def text_stream(self) -> Any:
        async def gen() -> Any:
            async for e in self._aconsume():
                if e["type"] == "content_block_delta":
                    yield e["delta"]["text"]

        return gen()


class FakeStreamManager:
    def __init__(self, stream: Any) -> None:
        self.stream = stream
        self.exited = False

    def __enter__(self) -> Any:
        return self.stream

    def __exit__(self, *a: Any) -> None:
        self.exited = True

    async def __aenter__(self) -> Any:
        return self.stream

    async def __aexit__(self, *a: Any) -> None:
        self.exited = True


class _Messages:
    def __init__(self, client: "FakeAnthropic") -> None:
        self.client = client

    def create(self, **kw: Any) -> Any:
        self.client.calls.append(kw)
        if kw.get("stream"):
            return FakeStream(anthropic_events(kw["model"]))
        return anthropic_message(kw["model"])

    def stream(self, **kw: Any) -> Any:
        self.client.calls.append(kw)
        return FakeStreamManager(FakeMessageStream(kw["model"]))


class _AsyncMessages:
    def __init__(self, client: "FakeAsyncAnthropic") -> None:
        self.client = client

    async def create(self, **kw: Any) -> Any:
        self.client.calls.append(kw)
        if kw.get("stream"):
            return FakeAsyncStream(anthropic_events(kw["model"]))
        return anthropic_message(kw["model"])

    def stream(self, **kw: Any) -> Any:
        self.client.calls.append(kw)
        return FakeStreamManager(FakeAsyncMessageStream(kw["model"]))


@_provider("anthropic._client")
class FakeAnthropic:
    def __init__(self) -> None:
        self.calls: List[Dict[str, Any]] = []
        self.messages = _Messages(self)


@_provider("anthropic._client")
class FakeAsyncAnthropic:
    def __init__(self) -> None:
        self.calls: List[Dict[str, Any]] = []
        self.messages = _AsyncMessages(self)
