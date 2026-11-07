"""In-process fake servers for the tests: a coding.sh ingest endpoint and a mock LLM API."""

from __future__ import annotations

import gzip
import json
import os
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional, Tuple

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
if SRC not in sys.path:
    sys.path.insert(0, SRC)

# Tests never see a real home or a real coding.sh config.
_tmp_home = tempfile.mkdtemp(prefix="coding-sh-py-test-")
os.environ["HOME"] = _tmp_home
os.environ["CODING_SH_HOME"] = os.path.join(_tmp_home, ".coding.sh")
for _k in ("CODING_SH_URL", "CODING_SH_INGEST_KEY", "CODING_SH_SERVICE", "CODING_SH_DISABLED", "CODING_SH_CAPTURE_MODE", "OTEL_SERVICE_NAME"):
    os.environ.pop(_k, None)

import coding_sh  # noqa: E402
from coding_sh import _client  # noqa: E402

_client.Transport.backoff_base_s = 0.01

KEY = "csh_ik_" + "t" * 43


class _QuietServer(ThreadingHTTPServer):
    def handle_error(self, request: Any, client_address: Any) -> None:
        pass  # clients that time out on purpose (flush/exit tests) leave broken pipes


class _Server:
    def __init__(self, handler_cls: Any, port: int = 0) -> None:
        self.httpd = _QuietServer(("127.0.0.1", port), handler_cls)
        self.httpd.daemon_threads = True
        self.httpd.owner = self  # type: ignore[attr-defined]
        self.thread = threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        self.thread.start()

    @property
    def url(self) -> str:
        host, port = self.httpd.server_address[:2]
        return "http://%s:%d" % (host, port)

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


class IngestServer(_Server):
    """Records every request; answers from a plan of (status, headers, body), then 200."""

    def __init__(self) -> None:
        self.requests: List[Dict[str, Any]] = []
        self.plan: List[Tuple[int, Dict[str, str], Any]] = []
        self.delay = 0.0
        self.lock = threading.Lock()
        super().__init__(_IngestHandler)

    def events(self, ok_only: bool = True) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        seen = set()
        with self.lock:
            for r in self.requests:
                if ok_only and r["status"] != 200:
                    continue
                for e in (r["json"] or {}).get("events", []):
                    if e["id"] in seen:
                        continue
                    seen.add(e["id"])
                    out.append(e)
        return out


class _IngestHandler(BaseHTTPRequestHandler):
    def log_message(self, *a: Any) -> None:
        pass

    def do_POST(self) -> None:
        srv: IngestServer = self.server.owner  # type: ignore[attr-defined]
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n)
        body = gzip.decompress(raw) if self.headers.get("Content-Encoding") == "gzip" else raw
        try:
            parsed = json.loads(body)
        except Exception:
            parsed = None
        if srv.delay:
            time.sleep(srv.delay)
        with srv.lock:
            status, headers, resp = srv.plan.pop(0) if srv.plan else (200, {}, None)
            srv.requests.append(
                {"path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()}, "raw": raw, "json": parsed, "status": status}
            )
        if resp is None and status == 200:
            k = len((parsed or {}).get("events", []))
            resp = {"accepted": k, "inserted": k, "rejected": []}
        data = json.dumps(resp or {}).encode()
        self.send_response(status)
        for k, v in headers.items():
            self.send_header(k, v)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


# ---------------------------------------------------------------------------- mock LLM

USAGE_IN, USAGE_OUT = 1000, 500


class LLMServer(_Server):
    """OpenAI chat/responses and Anthropic messages, always answering "pong" (1000 in / 500 out)."""

    def __init__(self, port: int = 0) -> None:
        self.requests: List[Dict[str, Any]] = []
        self.fail_next: Optional[int] = None
        super().__init__(_LLMHandler, port)


class _LLMHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a: Any) -> None:
        pass

    def _json(self, status: int, obj: Any) -> None:
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _sse(self, events: List[Tuple[Optional[str], Any]]) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        for name, data in events:
            chunk = ""
            if name:
                chunk += "event: %s\n" % name
            chunk += "data: %s\n\n" % (data if isinstance(data, str) else json.dumps(data))
            self.wfile.write(chunk.encode())
            self.wfile.flush()
        self.close_connection = True

    def do_POST(self) -> None:
        srv: LLMServer = self.server.owner  # type: ignore[attr-defined]
        n = int(self.headers.get("Content-Length") or 0)
        req = json.loads(self.rfile.read(n) or b"{}")
        srv.requests.append({"path": self.path, "json": req})
        if srv.fail_next:
            status, srv.fail_next = srv.fail_next, None
            self._json(status, {"error": {"message": "mock failure", "type": "server_error"}})
            return
        model = req.get("model", "mock")
        path = self.path.split("?")[0]
        if path.endswith("/chat/completions"):
            self._chat(req, model)
        elif path.endswith("/responses"):
            self._responses(req, model)
        elif path.endswith("/messages"):
            self._messages(req, model)
        else:
            self._json(404, {"error": {"message": "not found"}})

    def _chat(self, req: Dict[str, Any], model: str) -> None:
        usage = {"prompt_tokens": USAGE_IN, "completion_tokens": USAGE_OUT, "total_tokens": USAGE_IN + USAGE_OUT}
        if not req.get("stream"):
            self._json(
                200,
                {
                    "id": "chatcmpl-1",
                    "object": "chat.completion",
                    "created": 0,
                    "model": model,
                    "choices": [{"index": 0, "message": {"role": "assistant", "content": "pong"}, "finish_reason": "stop"}],
                    "usage": usage,
                },
            )
            return
        base = {"id": "chatcmpl-1", "object": "chat.completion.chunk", "created": 0, "model": model}
        events: List[Tuple[Optional[str], Any]] = [
            (None, dict(base, choices=[{"index": 0, "delta": {"role": "assistant", "content": ""}, "finish_reason": None}])),
            (None, dict(base, choices=[{"index": 0, "delta": {"content": "po"}, "finish_reason": None}])),
            (None, dict(base, choices=[{"index": 0, "delta": {"content": "ng"}, "finish_reason": None}])),
            (None, dict(base, choices=[{"index": 0, "delta": {}, "finish_reason": "stop"}])),
        ]
        if (req.get("stream_options") or {}).get("include_usage"):
            events.append((None, dict(base, choices=[], usage=usage)))
        events.append((None, "[DONE]"))
        self._sse(events)

    def _responses(self, req: Dict[str, Any], model: str) -> None:
        resp = {
            "id": "resp_1",
            "object": "response",
            "created_at": 0,
            "model": model,
            "status": "completed",
            "output": [
                {
                    "type": "message",
                    "id": "msg_1",
                    "status": "completed",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "pong", "annotations": []}],
                }
            ],
            "parallel_tool_calls": True,
            "tool_choice": "auto",
            "tools": [],
            "usage": {
                "input_tokens": USAGE_IN,
                "input_tokens_details": {"cached_tokens": 0},
                "output_tokens": USAGE_OUT,
                "output_tokens_details": {"reasoning_tokens": 0},
                "total_tokens": USAGE_IN + USAGE_OUT,
            },
        }
        if not req.get("stream"):
            self._json(200, resp)
            return
        created = dict(resp, status="in_progress", output=[], usage=None)
        self._sse(
            [
                ("response.created", {"type": "response.created", "sequence_number": 0, "response": created}),
                (
                    "response.output_text.delta",
                    {"type": "response.output_text.delta", "sequence_number": 1, "item_id": "msg_1", "output_index": 0, "content_index": 0, "delta": "pong", "logprobs": []},
                ),
                ("response.completed", {"type": "response.completed", "sequence_number": 2, "response": resp}),
            ]
        )

    def _messages(self, req: Dict[str, Any], model: str) -> None:
        msg = {
            "id": "msg_1",
            "type": "message",
            "role": "assistant",
            "model": model,
            "content": [{"type": "text", "text": "pong"}],
            "stop_reason": "end_turn",
            "stop_sequence": None,
            "usage": {"input_tokens": USAGE_IN, "output_tokens": USAGE_OUT},
        }
        if not req.get("stream"):
            self._json(200, msg)
            return
        start = dict(msg, content=[], stop_reason=None, usage={"input_tokens": USAGE_IN, "output_tokens": 1})
        self._sse(
            [
                ("message_start", {"type": "message_start", "message": start}),
                ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
                ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "po"}}),
                ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "ng"}}),
                ("content_block_stop", {"type": "content_block_stop", "index": 0}),
                ("message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": USAGE_OUT}}),
                ("message_stop", {"type": "message_stop"}),
            ]
        )


# ---------------------------------------------------------------------------- helpers


def start_sdk(server: IngestServer, **kw: Any) -> None:
    opts = dict(url=server.url, key=KEY, service="test-svc", flush_interval_ms=5)
    opts.update(kw)
    coding_sh.init(**opts)


def collect(server: IngestServer, timeout: float = 5.0) -> List[Dict[str, Any]]:
    assert coding_sh.flush(timeout), "flush timed out"
    return server.events()


def kinds(events: List[Dict[str, Any]]) -> List[str]:
    return [e["kind"] for e in sorted(events, key=lambda e: e["ts"])]


def by_kind(events: List[Dict[str, Any]], kind: str) -> List[Dict[str, Any]]:
    return [e for e in events if e["kind"] == kind]
