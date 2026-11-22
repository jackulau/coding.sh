from __future__ import annotations

import calendar
import email.utils
import gzip
import json
import socket
import threading
import time
import unittest
from typing import List, Optional

import support  # noqa: F401  (sets up sys.path and a temp HOME)
from support import KEY, IngestServer, collect, start_sdk

import coding_sh
from coding_sh import _client, _trace


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class _RecordedWaits(threading.Event):
    """Stands in for the sender's halt event: records each retry wait and returns at once."""

    def __init__(self) -> None:
        super().__init__()
        self.waits: List[Optional[float]] = []

    def wait(self, timeout: Optional[float] = None) -> bool:
        self.waits.append(timeout)
        return self.is_set()


class RetryAfterTest(unittest.TestCase):
    """Retry-After is read as in the TS SDK (retryAfterMs in packages/sdk/src/transport.ts)."""

    DATE = "Sun, 06 Nov 1994 08:49:37 GMT"
    AT = float(calendar.timegm((1994, 11, 6, 8, 49, 37)))

    def test_seconds_are_waited_up_to_60(self) -> None:
        for v, want in (("0", 0.0), ("5", 5.0), (" 1.5 ", 1.5), ("60", 60.0), ("61", 60.0), ("1e3", 60.0)):
            with self.subTest(v=v):
                self.assertEqual(_client._parse_retry_after(v), want)

    def test_a_date_is_waited_until_it_passes_up_to_60_s(self) -> None:
        # The three HTTP date forms; asctime has no zone and is read as GMT.
        for date in (self.DATE, "Sunday, 06-Nov-94 08:49:37 GMT", "Sun Nov  6 08:49:37 1994"):
            with self.subTest(date=date):
                self.assertEqual(_client._parse_retry_after(date, now=self.AT - 10), 10.0)
                self.assertEqual(_client._parse_retry_after(date, now=self.AT - 3600), 60.0)
                self.assertEqual(_client._parse_retry_after(date, now=self.AT + 10), 0.0)

    def test_a_value_that_is_neither_falls_back_to_backoff(self) -> None:
        for v in (None, "", "soon", "Infinity", "NaN", "-30", "Sun, 99 Foo 1994 08:49:37 GMT"):
            with self.subTest(v=v):
                self.assertIsNone(_client._parse_retry_after(v))


class TransportTest(unittest.TestCase):
    def setUp(self) -> None:
        self.server = IngestServer()

    def tearDown(self) -> None:
        coding_sh.shutdown(1.0)
        self.server.close()

    def _span(self, name: str = "t") -> None:
        with coding_sh.span("tool", name):
            pass

    def test_batch_shape_auth_and_gzip(self) -> None:
        start_sdk(self.server)
        self._span()
        events = collect(self.server)
        self.assertEqual(len(events), 5)  # session.start, tool.start, tool.end, turn.end, session.end
        req = self.server.requests[0]
        self.assertEqual(req["path"], "/v1/ingest")
        self.assertEqual(req["headers"]["authorization"], "Bearer " + KEY)
        self.assertEqual(req["headers"]["content-encoding"], "gzip")
        self.assertEqual(req["headers"]["content-type"], "application/json")
        self.assertEqual(json.loads(gzip.decompress(req["raw"]))["v"], 0)
        self.assertEqual(req["json"]["service"], "test-svc")
        for e in events:
            self.assertEqual(e["v"], 0)
            self.assertEqual(e["source"], "sdk")
            self.assertIsInstance(e["id"], str)
            self.assertIsInstance(e["ts"], (int, float))
            self.assertNotIn("project", e)
            self.assertNotIn("blobs", e)
        self.assertEqual(coding_sh.stats(), {"queued": 0, "sent": 5, "dropped": 0, "failed": 0})

    def test_url_with_path_suffix_is_accepted(self) -> None:
        start_sdk(self.server, url=self.server.url + "/v1/ingest/")
        self._span()
        collect(self.server)
        self.assertEqual(self.server.requests[0]["path"], "/v1/ingest")

    def test_url_ending_in_v1_traces_sends_to_v1_ingest(self) -> None:
        # The OTLP address of the same server, as the TS SDK takes it.
        start_sdk(self.server, url=self.server.url + "/v1/traces")
        self._span()
        collect(self.server)
        self.assertEqual([r["path"] for r in self.server.requests], ["/v1/ingest"])

    def test_no_url_means_no_op(self) -> None:
        coding_sh.init(url=None, key=KEY)
        self.assertFalse(_trace.enabled())
        self._span()
        self.assertTrue(coding_sh.flush(0.5))
        self.assertEqual(self.server.requests, [])
        self.assertIsNone(_trace._get()._thread)

    def test_disabled_flag(self) -> None:
        start_sdk(self.server, disabled=True)
        self._span()
        self.assertTrue(coding_sh.flush(0.5))
        self.assertEqual(self.server.requests, [])

    def test_retry_on_503_keeps_ids_and_honors_retry_after(self) -> None:
        self.server.plan = [(503, {"Retry-After": "0"}, {"error": "down"}), (429, {"Retry-After": "0"}, {})]
        start_sdk(self.server)
        self._span()
        events = collect(self.server)
        self.assertEqual(len(events), 5)
        self.assertEqual(len(self.server.requests), 3)
        ids = [[e["id"] for e in r["json"]["events"]] for r in self.server.requests]
        self.assertEqual(ids[0], ids[1])
        self.assertEqual(ids[1], ids[2])
        self.assertEqual(coding_sh.stats()["sent"], 5)

    def test_retry_after_value_is_waited(self) -> None:
        self.server.plan = [(429, {"Retry-After": "1"}, {})]
        start_sdk(self.server)
        self._span()
        t0 = time.monotonic()
        collect(self.server)
        self.assertGreaterEqual(time.monotonic() - t0, 0.9)

    def _record_waits(self) -> _RecordedWaits:
        rec = _RecordedWaits()
        _trace._get()._halt = rec
        return rec

    def test_retry_after_seconds_and_dates_are_waited_up_to_60_s(self) -> None:
        soon = email.utils.formatdate(time.time() + 30, usegmt=True)
        later = email.utils.formatdate(time.time() + 3600, usegmt=True)
        self.server.plan = [(503, {"Retry-After": "45"}, {}), (429, {"Retry-After": "120"}, {}), (503, {"Retry-After": soon}, {}), (503, {"Retry-After": later}, {})]
        start_sdk(self.server)
        rec = self._record_waits()
        self._span()
        self.assertEqual(len(collect(self.server)), 5)
        self.assertEqual(len(self.server.requests), 5)
        self.assertEqual(rec.waits[:2], [45.0, 60.0])
        self.assertTrue(25.0 <= (rec.waits[2] or 0) <= 30.0, rec.waits)
        self.assertEqual(rec.waits[3:], [60.0])

    def test_retry_after_in_the_past_retries_at_once_and_one_that_cannot_be_read_backs_off(self) -> None:
        self.server.plan = [(503, {"Retry-After": "Wed, 21 Oct 2015 07:28:00 GMT"}, {}), (503, {"Retry-After": "soon"}, {}), (503, {"Retry-After": "Infinity"}, {})]
        start_sdk(self.server)
        rec = self._record_waits()
        self._span()
        self.assertEqual(len(collect(self.server)), 5)
        b = _client.Transport.backoff_base_s
        self.assertEqual(rec.waits, [0.0, 2 * b, 4 * b])

    def test_gives_up_after_five_attempts(self) -> None:
        self.server.plan = [(500, {}, {})] * 5
        start_sdk(self.server)
        self._span()
        self.assertTrue(coding_sh.flush(5))
        self.assertEqual(len(self.server.requests), 5)
        self.assertEqual(coding_sh.stats()["failed"], 5)
        self.assertEqual(coding_sh.stats()["sent"], 0)

    def test_401_drops_and_warns_once(self) -> None:
        self.server.plan = [(401, {"WWW-Authenticate": "Bearer"}, {}), (401, {}, {})]
        start_sdk(self.server)
        with self.assertLogs("coding_sh", level="WARNING") as logs:
            self._span()
            coding_sh.flush(5)
            self._span()
            coding_sh.flush(5)
        self.assertEqual(len(self.server.requests), 2)  # no retries
        self.assertEqual(len(logs.output), 1)
        self.assertIn("401", logs.output[0])
        self.assertNotIn(KEY, logs.output[0])
        self.assertEqual(coding_sh.stats()["failed"], 10)

    def test_network_error_is_retried(self) -> None:
        port = _free_port()
        coding_sh.init(url="http://127.0.0.1:%d" % port, key=KEY, flush_interval_ms=5)
        self._span()
        # Windows takes about 2 s to refuse a connection to a closed local port, so the five
        # attempts need about 10 s there; elsewhere the refusal is immediate.
        self.assertTrue(coding_sh.flush(5 + 3 * _client.MAX_ATTEMPTS))
        s = coding_sh.stats()
        self.assertEqual(s["failed"], 5)

    def test_server_rejections_are_counted(self) -> None:
        self.server.plan = [(200, {}, {"accepted": 4, "inserted": 4, "rejected": [{"index": 0, "error": "bad ts"}]})]
        start_sdk(self.server)
        with self.assertLogs("coding_sh", level="WARNING"):
            self._span()
            coding_sh.flush(5)
        s = coding_sh.stats()
        self.assertEqual((s["sent"], s["failed"]), (4, 1))

    def test_max_batch_splits_requests(self) -> None:
        start_sdk(self.server, max_batch=3, flush_interval_ms=1000)
        for _ in range(3):
            self._span()  # 15 events
        events = collect(self.server)
        self.assertEqual(len(events), 15)
        self.assertTrue(all(len(r["json"]["events"]) <= 3 for r in self.server.requests))
        self.assertGreaterEqual(len(self.server.requests), 5)

    def test_max_batch_is_capped_at_500(self) -> None:
        cfg = _client.Config(url="http://x", max_batch=10000)
        self.assertEqual(cfg.max_batch, 500)

    def test_queue_full_drops_new_events_and_warns(self) -> None:
        self.server.delay = 0.3
        start_sdk(self.server, max_queue=4, flush_interval_ms=0)
        with self.assertLogs("coding_sh", level="WARNING") as logs:
            for _ in range(4):
                self._span()
            coding_sh.flush(5)
        s = coding_sh.stats()
        self.assertGreater(s["dropped"], 0)
        self.assertEqual(s["sent"] + s["dropped"], 20)
        self.assertEqual(len([m for m in logs.output if "queue full" in m]), 1)

    def test_oversized_event_is_dropped(self) -> None:
        start_sdk(self.server)
        t = _trace._get()
        t.enqueue({"id": "x", "v": 0, "payload": {"blob": "a" * (_client.MAX_BATCH_BYTES + 10)}})
        self.assertEqual(coding_sh.stats()["dropped"], 1)

    def test_batch_bytes_limit_splits(self) -> None:
        start_sdk(self.server, flush_interval_ms=200)
        t = _trace._get()
        big = "b" * (1024 * 1024)
        for i in range(6):
            t.enqueue({"id": "big-%d" % i, "v": 0, "sessionId": "s", "kind": "span", "ts": 1, "payload": {"x": big}})
        self.assertTrue(coding_sh.flush(10))
        self.assertGreaterEqual(len(self.server.requests), 2)
        for r in self.server.requests:
            self.assertLessEqual(len(json.dumps(r["json"])), _client.MAX_BATCH_BYTES)
        self.assertEqual(len(self.server.events()), 6)

    def test_flush_timeout_returns_false(self) -> None:
        self.server.delay = 1.0
        start_sdk(self.server)
        self._span()
        self.assertFalse(coding_sh.flush(0.1))
        self.assertTrue(coding_sh.flush(5))

    def test_bare_flush_waits_at_most_5_s(self) -> None:
        # The quick start ends a script with a bare flush(). A server that is slow or
        # down must not hold the script for the sender's whole retry schedule.
        self.server.delay = 8.0
        start_sdk(self.server)
        self._span()
        start = time.monotonic()
        with self.assertLogs("coding_sh", level="WARNING") as logs:
            ok = coding_sh.flush()
        self.assertFalse(ok)
        self.assertLess(time.monotonic() - start, 7.0)
        self.assertIn("flush() gave up after 5 s", "\n".join(logs.output))

    def test_env_configuration(self) -> None:
        import os

        os.environ.update({"CODING_SH_URL": self.server.url, "CODING_SH_INGEST_KEY": KEY, "CODING_SH_SERVICE": "env-svc"})
        try:
            coding_sh.init(flush_interval_ms=5)
            self._span()
            collect(self.server)
            self.assertEqual(self.server.requests[0]["json"]["service"], "env-svc")
            self.assertEqual(self.server.requests[0]["headers"]["authorization"], "Bearer " + KEY)
        finally:
            for k in ("CODING_SH_URL", "CODING_SH_INGEST_KEY", "CODING_SH_SERVICE"):
                os.environ.pop(k, None)


if __name__ == "__main__":
    unittest.main()
