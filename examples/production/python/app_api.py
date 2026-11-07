"""A small production-style API service, observed by coding.sh.

POST /chat {"conversation_id": "c-1", "message": "where is order 42?", "user_id": "u-7"}
-> {"answer": "..."}

Each request is one trace (a turn) in the conversation's session, with a tool span and a
model call. The same three lines work in FastAPI, Flask, Django or a worker:
observe() the client once, wrap the handler in trace(), wrap tools in span().

    pip install coding-sh openai
    CODING_SH_URL=https://obs.example.com CODING_SH_INGEST_KEY=csh_ik_... CODING_SH_SERVICE=support-api \\
      python app_api.py --port 8080
    curl -s localhost:8080/chat -d '{"conversation_id":"c-1","message":"where is order 42?"}'

Sending happens on a daemon thread in batches, so requests never wait on coding.sh. A missing
CODING_SH_URL turns the SDK into a no-op.
"""

import argparse
import json
import os
import signal
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import coding_sh
from openai import OpenAI

llm = coding_sh.observe(
    OpenAI(base_url=os.environ.get("OPENAI_BASE_URL", "http://127.0.0.1:9999/v1"), api_key=os.environ.get("OPENAI_API_KEY", "mock"))
)
MODEL = os.environ.get("OPENAI_MODEL", "mock-gpt")
ORDERS = {"42": "shipped", "43": "processing"}


@coding_sh.span("tool", "lookup_order")
def lookup_order(order_id: str) -> str:
    return ORDERS.get(order_id, "unknown")


def answer(conversation_id: str, message: str, user_id: str = None) -> str:
    with coding_sh.trace("chat", session_id=conversation_id, user_id=user_id, input=message) as t:
        order_id = next((w for w in message.replace("?", " ").split() if w.isdigit()), None)
        status = lookup_order(order_id) if order_id else "no order id given"
        r = llm.chat.completions.create(
            model=MODEL,
            messages=[
                {"role": "system", "content": "You are a support agent. Order status: " + status},
                {"role": "user", "content": message},
            ],
        )
        text = r.choices[0].message.content or ""
        t.set_output(text)
        return text


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # keep request bodies out of logs
        pass

    def _send(self, status, obj):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/healthz":
            self._send(200, {"ok": True, "coding_sh": coding_sh.stats()})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/chat":
            return self._send(404, {"error": "not found"})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            conv = str(body.get("conversation_id") or self.headers.get("X-Conversation-Id") or "")
            msg = str(body["message"])
        except Exception:
            return self._send(400, {"error": "expected JSON {conversation_id, message}"})
        try:
            self._send(200, {"answer": answer(conv or None, msg, body.get("user_id"))})
        except Exception as e:  # the trace already recorded the error
            self._send(502, {"error": type(e).__name__})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8080)
    a = ap.parse_args()
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    # Platforms stop containers with SIGTERM: stop serving, then flush what is queued.
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=srv.shutdown, daemon=True).start())
    print("listening on http://%s:%d" % (a.host, a.port), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
        coding_sh.shutdown(5)  # flush on deploy/stop


if __name__ == "__main__":
    main()
