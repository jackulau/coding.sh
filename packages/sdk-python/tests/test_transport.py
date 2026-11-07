from __future__ import annotations

import gzip
import json
import socket
import time
import unittest

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
        self.assertTrue(coding_sh.flush(5))
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
