"""Which LLM gateway a model call went through, and the request id its lookup API takes.

The table (_gateway_table.py) is generated from the server's gateway registry, so the SDK spots
the same gateways the server does. Signals, strongest first:

1. the base URL (or request URL): a gateway host, or a self-hosted gateway whose URL env var
   (LITELLM_PROXY_API_BASE, KONG_PROXY_URL, ...) names the same host;
2. a response header only one gateway sets: its request id header (cf-aig-log-id, helicone-id,
   x-litellm-call-id, x-portkey-trace-id, ...), or a marker header (x-router-provider, ...);
3. a response id with a gateway's shape (Vercel `gen_...`, OpenRouter `gen-...`, Requesty `rqsty-...`).

Response headers come from an httpx response hook added to the observed client's HTTP client.
The hook only reads headers, and only for a call this SDK is recording (a context variable).
"""

from __future__ import annotations

import contextlib
import contextvars
import inspect
import os
import urllib.parse
from typing import Any, Dict, Iterator, Mapping, Optional, Tuple

from ._gateway_table import GATEWAY_TABLE

_HOOKED = "__coding_sh_gateway_hook__"
_current: contextvars.ContextVar[Any] = contextvars.ContextVar("coding_sh_llm_call", default=None)


def _host(url: Any) -> Optional[str]:
    if not url:
        return None
    try:
        host = urllib.parse.urlsplit(str(url)).hostname
    except Exception:
        return None
    return host.lower() if host else None


def _host_matches(host: str, pattern: str) -> bool:
    return host.endswith(pattern) if pattern.startswith(".") else host == pattern or host.endswith("." + pattern)


def gateway_for_url(url: Any, env: Optional[Mapping[str, str]] = None) -> Optional[str]:
    """The gateway a base URL points at: by hostname, or a self-hosted gateway's URL env var on the same host."""
    host = _host(url)
    if not host:
        return None
    env = os.environ if env is None else env
    for g in GATEWAY_TABLE:
        if any(_host_matches(host, h) for h in g["hosts"]):
            return str(g["id"])
        if any(_host(env.get(k)) == host for k in g["url_env"]):
            return str(g["id"])
    return None


def _header(headers: Any, name: str) -> Optional[str]:
    if headers is None:
        return None
    try:
        v = headers.get(name)
    except Exception:
        return None
    return v.strip() if isinstance(v, str) and v.strip() else None


def _shaped(g: Dict[str, Any], v: Optional[str]) -> bool:
    return bool(v) and (g["id_pattern"] is None or g["id_pattern"].search(v) is not None)


def _request_id(g: Dict[str, Any], headers: Any, response_id: Optional[str]) -> Optional[str]:
    for name in g["id_headers"]:
        v = _header(headers, name)
        if _shaped(g, v):
            return v
    if response_id and g["id_pattern"] is not None and g["id_pattern"].search(response_id):
        return response_id
    return None


def detect_gateway(
    url: Any = None, headers: Any = None, response_id: Optional[str] = None, env: Optional[Mapping[str, str]] = None
) -> Optional[Tuple[str, Optional[str]]]:
    """(gateway, request id) for a model call, from its URL, response headers and response id."""
    by_url = gateway_for_url(url, env)
    if by_url:
        g = next(r for r in GATEWAY_TABLE if r["id"] == by_url)
        return by_url, _request_id(g, headers, response_id)
    for g in GATEWAY_TABLE:
        for name in g["id_headers"]:
            v = _header(headers, name)
            if _shaped(g, v):
                return g["id"], v
    for g in GATEWAY_TABLE:
        if any(_header(headers, name) is not None for name in g["mark_headers"]):
            return g["id"], _request_id(g, headers, response_id)
    for g in GATEWAY_TABLE:
        if response_id and g["id_pattern"] is not None and g["id_pattern"].search(response_id):
            return g["id"], response_id
    return None


# ---------------------------------------------------------------------------- response headers


@contextlib.contextmanager
def capturing(call: Any) -> Iterator[None]:
    """Response headers seen inside this block belong to `call`."""
    token = _current.set(call)
    try:
        yield
    finally:
        try:
            _current.reset(token)
        except Exception:
            pass


def _take(response: Any) -> None:
    call = _current.get()
    if call is None:
        return
    try:
        call.response_headers = response.headers
        call.request_url = str(response.request.url)
    except Exception:
        pass


def _sync_hook(response: Any) -> None:
    _take(response)


async def _async_hook(response: Any) -> None:
    _take(response)


setattr(_sync_hook, _HOOKED, True)
setattr(_async_hook, _HOOKED, True)


def hook_responses(client: Any) -> None:
    """Add the header hook to an openai / anthropic client's httpx client (once)."""
    try:
        http = getattr(client, "_client", None)
        hooks = getattr(http, "event_hooks", None)
        if http is None or not isinstance(hooks, dict) or not isinstance(hooks.get("response"), list):
            return
        if any(getattr(h, _HOOKED, False) for h in hooks["response"]):
            return
        hook = _async_hook if inspect.iscoroutinefunction(getattr(http, "send", None)) else _sync_hook
        http.event_hooks = {**hooks, "response": [*hooks["response"], hook]}
    except Exception:
        pass
