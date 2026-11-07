"""Config and transport: a bounded queue drained by one daemon sender thread.

Transport contract (docs/PRODUCTION.md section 4, shared with the TS SDK):

- batches of <= max_batch events and <= 4 MiB go to POST <url>/v1/ingest, gzip-compressed;
- one request in flight at a time, from a daemon thread;
- retries on 429, 5xx and network errors, honoring Retry-After, otherwise backing off
  1, 2, 4 ... s up to 30 s, with at most 5 attempts;
- 400/401/403 (and any other 4xx) drop the batch and warn once per status;
- a full queue drops new events, counts them, and warns at most once a minute;
- an atexit flush is bounded to 2 s;
- event ids are fixed when the event is created, so a retried batch never duplicates.

Nothing here ever raises into the app, and nothing logs the key or a request body.
"""

from __future__ import annotations

import atexit
import collections
import json
import logging
import os
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Deque, Dict, List, Optional

try:  # gzip needs zlib, which a few minimal builds lack.
    import gzip as _gzip
except Exception:  # pragma: no cover
    _gzip = None  # type: ignore[assignment]

__version__ = "0.1.1"

log = logging.getLogger("coding_sh")

MAX_BATCH_BYTES = 4 * 1024 * 1024
MAX_ATTEMPTS = 5
MAX_BACKOFF_S = 30.0
ATEXIT_TIMEOUT_S = 2.0
REQUEST_TIMEOUT_S = 10.0
QUEUE_WARN_INTERVAL_S = 60.0

_TRUE = {"1", "true", "yes", "on"}


def _env(name: str) -> Optional[str]:
    v = os.environ.get(name)
    return v if v not in (None, "") else None


def _env_bool(name: str) -> Optional[bool]:
    v = _env(name)
    return None if v is None else v.strip().lower() in _TRUE


def ingest_url(url: str) -> str:
    """Base URL (https://obs.example.com) -> https://obs.example.com/v1/ingest."""
    u = url.strip().rstrip("/")
    return u if u.endswith("/v1/ingest") else u + "/v1/ingest"


class Config:
    """Resolved settings. Arguments win over env vars, env vars over defaults."""

    def __init__(
        self,
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
        self.url = url or _env("CODING_SH_URL")
        self.key = key or _env("CODING_SH_INGEST_KEY")
        self.service = service or _env("CODING_SH_SERVICE") or _env("OTEL_SERVICE_NAME")
        mode = (capture or _env("CODING_SH_CAPTURE_MODE") or "full").strip().lower()
        self.capture = "metadata" if mode == "metadata" else "full"
        self.flush_interval_s = max(0.0, float(1000 if flush_interval_ms is None else flush_interval_ms)) / 1000.0
        self.max_batch = max(1, min(500, int(500 if max_batch is None else max_batch)))
        self.max_queue = max(1, int(10000 if max_queue is None else max_queue))
        env_disabled = _env_bool("CODING_SH_DISABLED")
        self.disabled = bool(disabled if disabled is not None else env_disabled) or not self.url
        self.debug = bool(debug if debug is not None else _env_bool("CODING_SH_DEBUG"))

    @property
    def enabled(self) -> bool:
        return not self.disabled

    @property
    def full_capture(self) -> bool:
        return self.capture == "full"


def _json_default(o: Any) -> Any:
    for attr in ("model_dump", "to_dict", "dict"):
        f = getattr(o, attr, None)
        if callable(f):
            try:
                return f()
            except Exception:
                pass
    if isinstance(o, (set, frozenset, tuple)):
        return list(o)
    if isinstance(o, bytes):
        return "<%d bytes>" % len(o)
    return repr(o)


def dumps(o: Any) -> str:
    return json.dumps(o, default=_json_default, ensure_ascii=False, separators=(",", ":"))


class _Result:
    __slots__ = ("status", "retry_after", "body")

    def __init__(self, status: int, retry_after: Optional[float] = None, body: bytes = b"") -> None:
        self.status = status  # 0 = network error
        self.retry_after = retry_after
        self.body = body


def _parse_retry_after(v: Optional[str]) -> Optional[float]:
    if not v:
        return None
    try:
        return max(0.0, min(MAX_BACKOFF_S, float(v.strip())))
    except ValueError:
        return None  # HTTP-date form: fall back to backoff


class Transport:
    """Thread-safe event queue plus a lazily started daemon sender."""

    # Patched by tests to keep retries fast.
    backoff_base_s = 1.0

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self._endpoint = ingest_url(cfg.url) if cfg.url else ""
        self._envelope_head = (
            '{"v":0,' + ('"service":' + dumps(cfg.service) + "," if cfg.service else "") + '"events":['
        ).encode("utf-8")
        self._reset_state()
        self._warned: Dict[str, bool] = {}
        self._last_queue_warn = 0.0
        if cfg.enabled:
            atexit.register(self._atexit)
            if hasattr(os, "register_at_fork"):
                os.register_at_fork(after_in_child=self._after_fork)

    # ------------------------------------------------------------------ state

    def _reset_state(self) -> None:
        # Reentrant: a stream proxy finalized by the GC may enqueue while this thread holds it.
        self._lock = threading.RLock()
        self._cv = threading.Condition(self._lock)
        self._q: Deque[bytes] = collections.deque()  # serialized events
        self._inflight = 0
        self._flush_waiters = 0
        self._thread: Optional[threading.Thread] = None
        self._closed = False
        self._halt = threading.Event()  # set once the process is going away for good
        self._sent = 0
        self._dropped = 0
        self._failed = 0

    def _after_fork(self) -> None:
        # The child gets a copy of the parent's queue, which the parent still sends.
        # Start clean so nothing is sent twice and no dead thread or held lock is inherited.
        self._reset_state()

    # ------------------------------------------------------------------ public

    def enqueue(self, event: Dict[str, Any]) -> None:
        if not self.cfg.enabled:
            return
        try:
            data = dumps(event).encode("utf-8")
        except Exception as e:  # pragma: no cover - dumps has a repr fallback
            self._debug("event not serializable: %s", type(e).__name__)
            return
        warn = False
        with self._cv:
            if self._closed:
                return
            if len(data) + len(self._envelope_head) + 2 > MAX_BATCH_BYTES or len(self._q) >= self.cfg.max_queue:
                self._dropped += 1
                now = time.monotonic()
                if now - self._last_queue_warn >= QUEUE_WARN_INTERVAL_S:
                    self._last_queue_warn = now
                    warn = True
            else:
                self._q.append(data)
                if len(self._q) >= self.cfg.max_batch:
                    self._cv.notify_all()
                self._ensure_thread()
        if warn:
            log.warning("coding.sh: event queue full or event too large; dropping events (dropped=%d)", self._dropped)

    def flush(self, timeout: Optional[float] = None) -> bool:
        """Block until everything queued so far is sent (or given up). True when drained."""
        if not self.cfg.enabled:
            return True
        deadline = None if timeout is None else time.monotonic() + max(0.0, timeout)
        with self._cv:
            if not self._q and not self._inflight:
                return True
            alive = self._thread is not None and self._thread.is_alive()
            if not alive:
                alive = self._ensure_thread()
        if not alive:
            # No thread can be started (interpreter shutdown): send in this thread.
            self._drain_sync(deadline)
            with self._cv:
                return not self._q and not self._inflight
        with self._cv:
            self._flush_waiters += 1
            self._cv.notify_all()
            try:
                while self._q or self._inflight:
                    remaining = None if deadline is None else deadline - time.monotonic()
                    if remaining is not None and remaining <= 0:
                        return False
                    self._cv.wait(remaining if remaining is not None else 0.5)
                return True
            finally:
                self._flush_waiters -= 1

    def shutdown(self, timeout: Optional[float] = ATEXIT_TIMEOUT_S) -> bool:
        ok = self.flush(timeout)
        with self._cv:
            self._closed = True
            self._cv.notify_all()
        return ok

    def stats(self) -> Dict[str, int]:
        with self._lock:
            return {
                "queued": len(self._q) + self._inflight,
                "sent": self._sent,
                "dropped": self._dropped,
                "failed": self._failed,
            }

    # ------------------------------------------------------------------ sender

    def _ensure_thread(self) -> bool:
        """Start the sender if needed. Caller holds the lock."""
        if self._thread is not None and self._thread.is_alive():
            return True
        try:
            t = threading.Thread(target=self._run, name="coding-sh-sender", daemon=True)
            t.start()
        except RuntimeError:  # "can't create new thread at interpreter shutdown"
            self._thread = None
            return False
        self._thread = t
        return True

    def _take_batch(self) -> List[bytes]:
        """Pop up to max_batch events / 4 MiB. Caller holds the lock."""
        batch: List[bytes] = []
        size = len(self._envelope_head) + 2
        while self._q and len(batch) < self.cfg.max_batch:
            data = self._q[0]
            if batch and size + len(data) + 1 > MAX_BATCH_BYTES:
                break
            self._q.popleft()
            batch.append(data)
            size += len(data) + 1
        self._inflight = len(batch)
        return batch

    def _run(self) -> None:
        while True:
            with self._cv:
                while not self._q and not self._closed:
                    self._cv.wait()
                if not self._q:
                    return
                # Give the batch time to fill unless someone is waiting on a flush.
                deadline = time.monotonic() + self.cfg.flush_interval_s
                while len(self._q) < self.cfg.max_batch and not self._flush_waiters and not self._closed:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        break
                    self._cv.wait(remaining)
                batch = self._take_batch()
            try:
                self._deliver(batch)
            except Exception as e:  # pragma: no cover - _deliver handles its own errors
                self._debug("sender error: %s", type(e).__name__)
                with self._cv:
                    self._failed += len(batch)
            finally:
                with self._cv:
                    self._inflight = 0
                    self._cv.notify_all()

    def _drain_sync(self, deadline: Optional[float]) -> None:
        while True:
            with self._cv:
                if not self._q:
                    return
                batch = self._take_batch()
            try:
                self._deliver(batch, deadline)
            finally:
                with self._cv:
                    self._inflight = 0
                    self._cv.notify_all()
            if deadline is not None and time.monotonic() >= deadline:
                return

    def _deliver(self, batch: List[bytes], deadline: Optional[float] = None) -> None:
        if not batch:
            return
        body = self._envelope_head + b",".join(batch) + b"]}"
        n = len(batch)
        for attempt in range(1, MAX_ATTEMPTS + 1):
            res = self._post(body)
            if 200 <= res.status < 300:
                self._on_accepted(n, res.body)
                return
            retryable = res.status == 0 or res.status == 429 or res.status >= 500
            if not retryable:
                self._warn_once(
                    "status:%d" % res.status,
                    "coding.sh: ingest returned HTTP %d; dropping %d events%s"
                    % (res.status, n, " (check CODING_SH_INGEST_KEY)" if res.status in (401, 403) else ""),
                )
                break
            if attempt == MAX_ATTEMPTS:
                self._warn_once("retries", "coding.sh: ingest unavailable after %d attempts; dropping events" % MAX_ATTEMPTS)
                break
            delay = res.retry_after
            if delay is None:
                delay = min(MAX_BACKOFF_S, self.backoff_base_s * (2 ** (attempt - 1)))
            if deadline is not None and time.monotonic() + delay > deadline:
                break
            self._debug("ingest %s, retrying in %.1fs", res.status or "network error", delay)
            if self._halt.wait(delay):
                break
        with self._cv:
            self._failed += n

    def _on_accepted(self, n: int, body: bytes) -> None:
        rejected = 0
        try:
            parsed = json.loads(body.decode("utf-8")) if body else {}
            rej = parsed.get("rejected") if isinstance(parsed, dict) else None
            if isinstance(rej, list) and rej:
                rejected = len(rej)
                first = rej[0] if isinstance(rej[0], dict) else {}
                self._warn_once("rejected", "coding.sh: server rejected %d event(s): %s" % (rejected, str(first.get("error", ""))[:200]))
        except Exception:
            pass
        with self._cv:
            self._sent += n - rejected
            self._failed += rejected

    def _post(self, body: bytes) -> _Result:
        headers = {"Content-Type": "application/json", "User-Agent": "coding-sh-python/" + __version__}
        data = body
        if _gzip is not None:
            try:
                data = _gzip.compress(body, compresslevel=6)
                headers["Content-Encoding"] = "gzip"
            except Exception:
                data = body
        if self.cfg.key:
            headers["Authorization"] = "Bearer " + self.cfg.key
        req = urllib.request.Request(self._endpoint, data=data, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_S) as resp:
                return _Result(resp.status, None, resp.read(1 << 20))
        except urllib.error.HTTPError as e:
            try:
                e.read()
            except Exception:
                pass
            ra = _parse_retry_after(e.headers.get("Retry-After") if e.headers else None)
            try:
                e.close()
            except Exception:
                pass
            return _Result(e.code, ra)
        except Exception as e:  # URLError, timeouts, connection resets
            self._debug("ingest network error: %s", type(e).__name__)
            return _Result(0)

    # ------------------------------------------------------------------ misc

    def _atexit(self) -> None:
        try:
            self.flush(ATEXIT_TIMEOUT_S)
        except Exception:
            pass
        finally:
            self._halt.set()

    def _warn_once(self, key: str, msg: str) -> None:
        if self._warned.get(key):
            self._debug("%s", msg)
            return
        self._warned[key] = True
        log.warning("%s", msg)

    def _debug(self, fmt: str, *args: Any) -> None:
        if self.cfg.debug:
            log.warning("coding.sh debug: " + fmt, *args)
