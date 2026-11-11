"""Traces, spans, sessions and the AgentEvent layout.

Event layout matches what src/otel/map.ts produces for the same OTel spans, so an app traced
with this SDK and the same app traced with OTel gen_ai spans yield equal Session.stats:

  trace (root)        session.start {name, traceId, userId?, metadata?}
                      user.message {text}            (trace input, when given)
                      ...children...
                      turn.end {ok, error?, durationMs, output?}
                      session.end {reason, error?}   (only when the session is this trace)
  model call          llm.call {provider, requestModel, responseModel, ttftMs, stopReason, ok,
                                error?, toolCalls?} + usage, model, durationMs
                      assistant.message {text}
  span("tool", n)     tool.start {tool, toolUseId, input} . tool.end {tool, toolUseId, ok, durationMs, output}
  span("step", n)     span {name, ok, error?}  (one event, durationMs on the event)

A model call or span made outside any trace gets an implicit root, exactly like a root OTel span.
Sessions: each top-level trace (or untraced call) is its own session, unless a session id is set
with trace(session_id=...) or with_session(...); then traces are turns of that conversation.
"""

from __future__ import annotations

import contextvars
import functools
import inspect
import os
import threading
import time
import uuid
from typing import Any, Callable, Dict, Optional, TypeVar

from ._client import Config, Transport, dumps

F = TypeVar("F", bound=Callable[..., Any])

MAX_FIELD_CHARS = 64 * 1024

# ---------------------------------------------------------------------------- runtime

_lock = threading.Lock()
_transport: Optional[Transport] = None


def init(
    url: Optional[str] = None,
    key: Optional[str] = None,
    service: Optional[str] = None,
    capture: Optional[str] = None,
    flush_interval_ms: Optional[float] = None,
    max_batch: Optional[int] = None,
    max_queue: Optional[int] = None,
    disabled: Optional[bool] = None,
    debug: Optional[bool] = None,
) -> None:
    """Configure the SDK. Optional: the first event configures it from env vars.

    Env: CODING_SH_URL, CODING_SH_INGEST_KEY, CODING_SH_SERVICE (or OTEL_SERVICE_NAME),
    CODING_SH_CAPTURE_MODE (full|metadata), CODING_SH_DISABLED, CODING_SH_DEBUG.
    Without a URL the SDK does nothing.
    """
    global _transport
    cfg = Config(url, key, service, capture, flush_interval_ms, max_batch, max_queue, disabled, debug)
    with _lock:
        old, _transport = _transport, Transport(cfg)
    if old is not None:
        try:
            old.shutdown(1.0)
        except Exception:
            pass


def _get() -> Transport:
    global _transport
    t = _transport
    if t is None:
        with _lock:
            if _transport is None:
                _transport = Transport(Config())
            t = _transport
    return t


def enabled() -> bool:
    try:
        return _get().cfg.enabled
    except Exception:
        return False


def full_capture() -> bool:
    return _get().cfg.full_capture


def flush(timeout: Optional[float] = None) -> bool:
    """Send everything queued so far. Returns True when the queue drained in time."""
    try:
        return _get().flush(timeout)
    except Exception:
        return False


def shutdown(timeout: Optional[float] = 2.0) -> bool:
    """Flush, then stop accepting events."""
    try:
        return _get().shutdown(timeout)
    except Exception:
        return False


def stats() -> Dict[str, int]:
    """{queued, sent, dropped, failed} event counts for this process."""
    try:
        return _get().stats()
    except Exception:
        return {"queued": 0, "sent": 0, "dropped": 0, "failed": 0}


# ---------------------------------------------------------------------------- helpers


# One clock for every timestamp: perf_counter anchored to wall time. Mixing time.time() for
# starts with perf_counter() for durations lets a thread switch between the two reads order a
# parent's end before its children. The anchor follows wall-clock corrections over 1 s.
_anchor = (time.time(), time.perf_counter())
_anchor_checked = _anchor[1]


def now_ms() -> float:
    global _anchor, _anchor_checked
    p = time.perf_counter()
    if p - _anchor_checked > 60.0:
        _anchor_checked = p
        wall = time.time()
        if abs(_anchor[0] + (p - _anchor[1]) - wall) > 1.0:
            _anchor = (wall, p)
    return round((_anchor[0] + (p - _anchor[1])) * 1000.0, 3)


def _new_id() -> str:
    return str(uuid.uuid4())


def _hex(nbytes: int) -> str:
    return os.urandom(nbytes).hex()


def clip(text: Optional[str]) -> Optional[str]:
    if text is None:
        return None
    if len(text) > MAX_FIELD_CHARS:
        return text[:MAX_FIELD_CHARS] + "…[truncated]"
    return text


def jsonable(value: Any) -> Any:
    """A JSON-safe, size-bounded copy of an arbitrary input/output value."""
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return clip(value)
    try:
        s = dumps(value)
    except Exception:
        return clip(repr(value))
    if len(s) > MAX_FIELD_CHARS:
        return clip(s)
    try:
        import json

        return json.loads(s)
    except Exception:
        return clip(s)


def error_text(exc: BaseException) -> str:
    msg = str(exc)
    return clip(type(exc).__name__ + (": " + msg if msg else "")) or type(exc).__name__


def emit(event: Dict[str, Any]) -> bool:
    """Queue one event. True when it was queued; never raises."""
    try:
        return bool(_get().enqueue(event))
    except Exception:
        return False


# ---------------------------------------------------------------------------- context

_session_var: "contextvars.ContextVar[Optional[str]]" = contextvars.ContextVar("coding_sh_session", default=None)
_node_var: "contextvars.ContextVar[Optional[Node]]" = contextvars.ContextVar("coding_sh_node", default=None)


def current_session_id() -> Optional[str]:
    """The session the next event would go to, if one is set."""
    n = _node_var.get()
    if n is not None:
        return n.root.session_id
    return _session_var.get()


class Root:
    """One trace: a session, or one turn of a conversation session."""

    __slots__ = ("session_id", "trace_id", "conversation")

    def __init__(self, session_id: Optional[str]) -> None:
        self.trace_id = _hex(16)
        self.conversation = session_id is not None
        self.session_id = session_id if session_id is not None else _new_id()


class Node:
    """A position in the trace tree that events attach to.

    Like the TS SDK, every node has an anchor event (session.start for a root, tool.start / span /
    llm.call for a child) whose id is fixed up front; a child's events point at their parent's
    anchor through parentId.
    """

    __slots__ = ("root", "span_id", "parent_span_id", "anchor_id", "parent_anchor_id")

    def __init__(self, root: Root, parent: Optional["Node"]) -> None:
        self.root = root
        self.span_id = _hex(8)
        self.parent_span_id = parent.span_id if parent is not None else None
        self.anchor_id = _new_id()
        self.parent_anchor_id = parent.anchor_id if parent is not None else None

    def event(
        self, kind: str, ts: float, payload: Dict[str, Any], anchor: bool = False, child: bool = False, **extra: Any
    ) -> Dict[str, Any]:
        """anchor: this is the node's anchor event. child: link it to the parent's anchor."""
        e: Dict[str, Any] = {
            "id": self.anchor_id if anchor else _new_id(),
            "v": 0,
            "sessionId": self.root.session_id,
            "kind": kind,
            "ts": ts,
            "source": "sdk",
            "traceId": self.root.trace_id,
            "spanId": self.span_id,
            "payload": {k: v for k, v in payload.items() if v is not None},
        }
        if self.parent_span_id:
            e["parentSpanId"] = self.parent_span_id
        if child and self.parent_anchor_id:
            e["parentId"] = self.parent_anchor_id
        if self.root.conversation:
            e["turnId"] = self.root.trace_id
        for k, v in extra.items():
            if v is not None:
                e[k] = v
        return e


class Scope:
    """Base for anything that opens a node: traces, spans, implicit roots of model calls."""

    def __init__(self) -> None:
        self.node: Optional[Node] = None
        self.is_root = False
        self._token: Optional[contextvars.Token] = None
        self._t0 = 0.0
        self._p0 = 0.0
        self._done = False
        self.output: Any = None
        self.input: Any = None

    # Model calls do not bind the context: a returned stream outlives the call site.
    bind_context = True

    # subclasses
    def _on_start(self) -> None: ...
    def _on_end(self, error: Optional[BaseException], duration_ms: float, end_ts: float) -> None: ...

    def start(self) -> "Scope":
        self._t0 = now_ms()
        self._p0 = time.perf_counter()  # for ttft
        try:
            if enabled():
                parent = _node_var.get()
                if parent is None:
                    root = Root(_session_var.get())
                    self.node = Node(root, None)
                    self.is_root = True
                else:
                    self.node = Node(parent.root, parent)
                if self.bind_context:
                    self._token = _node_var.set(self.node)
                self._root_start()
                self._on_start()
        except Exception:
            self.node = None
        return self

    def end(self, error: Optional[BaseException] = None) -> None:
        if self._done:
            return
        self._done = True
        if self._token is not None:
            try:
                _node_var.reset(self._token)
            except ValueError:  # ended in a different context (generator, thread): leave it
                pass
            self._token = None
        if self.node is None:
            return
        try:
            end_ts = now_ms()
            duration = round(max(0.0, end_ts - self._t0), 3)
            self._on_end(error, duration, end_ts)
            self._root_end(error, duration, end_ts)
        except Exception:
            pass

    # The implicit-root wrapper every top-level scope gets.
    def _root_name(self) -> str:
        return "trace"

    def _root_input(self) -> Optional[str]:
        return None

    def _root_meta(self) -> Dict[str, Any]:
        return {}

    def _root_start(self) -> None:
        if not self.is_root or self.node is None:
            return
        n = self.node
        payload: Dict[str, Any] = {"name": self._root_name(), "traceId": n.root.trace_id}
        payload.update(self._root_meta())
        emit(n.event("session.start", self._t0, payload, anchor=True))
        text = self._root_input()
        if text and full_capture():
            emit(n.event("user.message", self._t0, {"text": clip(text)}))

    def _root_output(self) -> Any:
        return None

    def _root_end(self, error: Optional[BaseException], duration: float, end_ts: float) -> None:
        if not self.is_root or self.node is None:
            return
        n = self.node
        p: Dict[str, Any] = {"ok": error is None, "error": error_text(error) if error else None, "durationMs": duration}
        out = self._root_output()
        if out is not None and full_capture():
            p["output"] = out if isinstance(out, str) else jsonable(out)
            if isinstance(p["output"], str):
                p["output"] = clip(p["output"])
        emit(n.event("turn.end", end_ts, p, durationMs=duration))
        if not n.root.conversation:
            emit(
                n.event(
                    "session.end",
                    end_ts,
                    {"reason": "error" if error else "completed", "error": error_text(error) if error else None},
                    durationMs=duration,
                )
            )

    # Used by the trace/span context managers.
    def set_output(self, value: Any) -> None:
        self.output = value

    def set_input(self, value: Any) -> None:
        self.input = value


# ---------------------------------------------------------------------------- trace / span


class _Trace(Scope):
    def __init__(
        self, name: str, session_id: Optional[str], user_id: Optional[str], metadata: Optional[Dict[str, Any]], input: Any
    ) -> None:
        super().__init__()
        self.name = name
        self.session_id_arg = session_id
        self.user_id = user_id
        self.metadata = metadata
        self.input = input
        self._sess_token: Optional[contextvars.Token] = None
        self._input_sent = False

    @property
    def session_id(self) -> Optional[str]:
        return self.node.root.session_id if self.node else self.session_id_arg

    @property
    def trace_id(self) -> Optional[str]:
        return self.node.root.trace_id if self.node else None

    def start(self) -> "Scope":
        if self.session_id_arg is not None and _node_var.get() is None:
            self._sess_token = _session_var.set(str(self.session_id_arg))
        return super().start()

    def end(self, error: Optional[BaseException] = None) -> None:
        super().end(error)
        if self._sess_token is not None:
            try:
                _session_var.reset(self._sess_token)
            except ValueError:
                pass
            self._sess_token = None

    def _root_name(self) -> str:
        return self.name

    def _root_meta(self) -> Dict[str, Any]:
        m: Dict[str, Any] = {}
        if self.user_id is not None:
            m["userId"] = str(self.user_id)
        if self.metadata:
            m["metadata"] = jsonable(self.metadata)
        return m

    def _root_input(self) -> Optional[str]:
        if self.input is None:
            return None
        self._input_sent = True
        return self.input if isinstance(self.input, str) else dumps(jsonable(self.input))

    def _root_output(self) -> Any:
        return self.output

    def _root_end(self, error: Optional[BaseException], duration: float, end_ts: float) -> None:
        # Input given after start (set_input) still lands at the start of the turn.
        if self.is_root and self.node is not None and not self._input_sent and self.input is not None and full_capture():
            text = self.input if isinstance(self.input, str) else dumps(jsonable(self.input))
            emit(self.node.event("user.message", self._t0, {"text": clip(text)}))
        super()._root_end(error, duration, end_ts)

    def _on_end(self, error: Optional[BaseException], duration: float, end_ts: float) -> None:
        # A trace nested in another trace is a step of it.
        if not self.is_root and self.node is not None:
            _step_event(self.node, self.name, self._t0, duration, error, self.input, self.output, self.is_root)


def _step_event(
    node: Node, name: str, ts: float, duration: float, error: Optional[BaseException], inp: Any, out: Any, is_root: bool = False
) -> None:
    attrs: Dict[str, Any] = {}
    if full_capture():
        if inp is not None:
            attrs["input"] = jsonable(inp)
        if out is not None:
            attrs["output"] = jsonable(out)
    p: Dict[str, Any] = {"name": name, "ok": error is None, "error": error_text(error) if error else None}
    if attrs:
        p["attributes"] = attrs
    emit(node.event("span", ts, p, anchor=not is_root, child=True, durationMs=duration))


class _Span(Scope):
    def __init__(self, kind: str, name: str, input: Any) -> None:
        super().__init__()
        self.kind = "tool" if kind == "tool" else "step"
        self.name = name
        self.input = input

    def _root_name(self) -> str:
        return self.name

    def _on_start(self) -> None:
        if self.kind == "tool" and self.node is not None:
            p: Dict[str, Any] = {"tool": self.name, "toolUseId": self.node.span_id}
            if self.input is not None and full_capture():
                p["input"] = jsonable(self.input)
            emit(self.node.event("tool.start", self._t0, p, anchor=not self.is_root, child=True))

    def _on_end(self, error: Optional[BaseException], duration: float, end_ts: float) -> None:
        if self.node is None:
            return
        if self.kind == "tool":
            p: Dict[str, Any] = {
                "tool": self.name,
                "toolUseId": self.node.span_id,
                "ok": error is None,
                "durationMs": duration,
                "error": error_text(error) if error else None,
            }
            if self.output is not None and full_capture():
                p["output"] = jsonable(self.output)
            emit(self.node.event("tool.end", end_ts, p, child=True, durationMs=duration))
        else:
            _step_event(self.node, self.name, self._t0, duration, error, self.input, self.output, self.is_root)


class _ScopeCM:
    """Context manager (sync and async) and decorator around a Scope factory."""

    def __init__(self, factory: Callable[[], Scope], capture_args: bool = False) -> None:
        self._factory = factory
        self._capture_args = capture_args
        self._scopes: list = []

    def __enter__(self) -> Scope:
        s = self._factory().start()
        self._scopes.append(s)
        return s

    def __exit__(self, exc_type: Any, exc: Optional[BaseException], tb: Any) -> bool:
        if self._scopes:
            self._scopes.pop().end(exc if isinstance(exc, Exception) else None)
        return False

    async def __aenter__(self) -> Scope:
        return self.__enter__()

    async def __aexit__(self, exc_type: Any, exc: Optional[BaseException], tb: Any) -> bool:
        return self.__exit__(exc_type, exc, tb)

    def __call__(self, fn: F) -> F:
        factory = self._factory
        capture_args = self._capture_args

        def begin(args: Any, kwargs: Any) -> Scope:
            s = factory()
            if capture_args and s.input is None:
                s.input = _bound_args(fn, args, kwargs)
            return s.start()

        if inspect.iscoroutinefunction(fn):

            @functools.wraps(fn)
            async def awrapper(*args: Any, **kwargs: Any) -> Any:
                s = begin(args, kwargs)
                try:
                    result = await fn(*args, **kwargs)
                except Exception as e:
                    s.end(e)
                    raise
                except BaseException:
                    s.end(None)
                    raise
                if s.output is None:
                    s.output = result
                s.end(None)
                return result

            return awrapper  # type: ignore[return-value]

        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            s = begin(args, kwargs)
            try:
                result = fn(*args, **kwargs)
            except Exception as e:
                s.end(e)
                raise
            except BaseException:
                s.end(None)
                raise
            if s.output is None:
                s.output = result
            s.end(None)
            return result

        return wrapper  # type: ignore[return-value]


def _bound_args(fn: Callable[..., Any], args: Any, kwargs: Any) -> Any:
    try:
        bound = inspect.signature(fn).bind_partial(*args, **kwargs)
        out = {k: v for k, v in bound.arguments.items() if k not in ("self", "cls")}
        return out or None
    except Exception:
        return None


def trace(
    name: str = "trace",
    session_id: Optional[str] = None,
    user_id: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
    input: Any = None,
) -> _ScopeCM:
    """A unit of work: `with coding_sh.trace("checkout", session_id=conv_id, input=prompt) as t:`.

    Also a decorator (sync or async). The yielded object has set_input(), set_output(),
    session_id and trace_id. A decorated function's return value becomes the output.
    """
    return _ScopeCM(lambda: _Trace(name, session_id, user_id, metadata, input))


def span(kind: str, name: str, input: Any = None) -> _ScopeCM:
    """A tool call (`span("tool", "lookup_order")`) or a step (`span("step", "rerank")`).

    Context manager or decorator; as a decorator, the call's arguments become the input and
    its return value the output.
    """
    return _ScopeCM(lambda: _Span(kind, name, input), capture_args=True)


class _SessionCM:
    def __init__(self, session_id: str) -> None:
        self.session_id = str(session_id)
        self._tokens: list = []

    def __enter__(self) -> str:
        self._tokens.append(_session_var.set(self.session_id))
        return self.session_id

    def __exit__(self, *exc: Any) -> bool:
        if self._tokens:
            try:
                _session_var.reset(self._tokens.pop())
            except ValueError:
                pass
        return False

    async def __aenter__(self) -> str:
        return self.__enter__()

    async def __aexit__(self, *exc: Any) -> bool:
        return self.__exit__(*exc)

    def __call__(self, fn: F) -> F:
        sid = self.session_id
        if inspect.iscoroutinefunction(fn):

            @functools.wraps(fn)
            async def awrapper(*args: Any, **kwargs: Any) -> Any:
                with _SessionCM(sid):
                    return await fn(*args, **kwargs)

            return awrapper  # type: ignore[return-value]

        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            with _SessionCM(sid):
                return fn(*args, **kwargs)

        return wrapper  # type: ignore[return-value]


def with_session(session_id: str) -> _SessionCM:
    """Group traces and untraced calls into one conversation session (context manager or decorator)."""
    return _SessionCM(session_id)
