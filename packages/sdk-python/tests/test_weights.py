"""weights_edit: one `notification` event with payload.kind "weights.edit" (docs/reference/api.md).

The unit tests read the batch the SDK posts to a fake ingest endpoint. The last test starts a real
`coding.sh serve` on a temp CODING_SH_HOME and reads the event back, redacted.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
import unittest
import urllib.request
from typing import Any, Dict

import support
from support import IngestServer, by_kind, collect, start_sdk

import coding_sh

A = "a" * 64
B = "b" * 64
CLI = os.path.join(support.ROOT, "..", "coding.sh", "src", "cli", "main.ts")
NODE = shutil.which("node")
# Built in pieces so push protection does not flag the test file.
FAKE_TOKEN = "".join(["ghp_", "0123456789", "abcdefghij", "ABCDEFGHIJ", "klmnop"])


def _edit(**kw: Any) -> bool:
    args: Dict[str, Any] = dict(
        tensor="layers.3.mlp.down_proj.weight",
        shape=[4, 8],
        changed=12,
        l2=0.25,
        max_abs=0.1,
        base_sha256=A,
        edited_sha256=B,
    )
    args.update(kw)
    return coding_sh.weights_edit(**args)


class WeightsEditTest(unittest.TestCase):
    def setUp(self) -> None:
        self.server = IngestServer()

    def tearDown(self) -> None:
        coding_sh.shutdown(1.0)
        self.server.close()

    def test_one_notification_with_the_payload(self) -> None:
        start_sdk(self.server)
        self.assertTrue(_edit(note="rank-1 patch"))
        events = collect(self.server)
        (e,) = by_kind(events, "notification")
        self.assertEqual(
            e["payload"],
            {
                "kind": "weights.edit",
                "tensor": "layers.3.mlp.down_proj.weight",
                "shape": [4, 8],
                "changed": 12,
                "l2": 0.25,
                "maxAbs": 0.1,
                "baseSha256": A,
                "editedSha256": B,
                "note": "rank-1 patch",
            },
        )
        self.assertEqual(e["source"], "sdk")
        self.assertEqual(len(by_kind(events, "session.start")), 1)  # a session of its own

    def test_joins_the_current_trace(self) -> None:
        start_sdk(self.server)
        with coding_sh.trace("edit-run", session_id="conv-1"):
            _edit()
            _edit(tensor="lm_head.weight")
        events = collect(self.server)
        notes = by_kind(events, "notification")
        self.assertEqual([n["sessionId"] for n in notes], ["conv-1", "conv-1"])
        self.assertEqual(len(by_kind(events, "session.start")), 1)

    def test_metadata_mode_drops_the_note_only(self) -> None:
        start_sdk(self.server, capture="metadata")
        _edit(note="free text")
        (e,) = by_kind(collect(self.server), "notification")
        self.assertNotIn("note", e["payload"])
        self.assertEqual(e["payload"]["changed"], 12)

    def test_invalid_values_are_dropped_not_raised(self) -> None:
        start_sdk(self.server)
        bad = [
            dict(changed=-1),
            dict(changed=True),
            dict(changed=2.5),
            dict(changed=33),  # more than 4 * 8 weights
            dict(l2=-0.1),
            dict(l2=float("nan")),
            dict(max_abs=float("inf")),
            dict(base_sha256="abc"),
            dict(edited_sha256="g" * 64),
            dict(shape=[4, -1]),
            dict(shape="4x8"),
            dict(tensor=""),
            dict(tensor=None),
        ]
        for kw in bad:
            self.assertIs(_edit(**kw), False, kw)
        coding_sh.flush(2.0)
        self.assertEqual(by_kind(self.server.events(), "notification"), [])

    def test_uppercase_sha_is_lowercased(self) -> None:
        start_sdk(self.server)
        self.assertTrue(_edit(base_sha256="A" * 64))
        (e,) = by_kind(collect(self.server), "notification")
        self.assertEqual(e["payload"]["baseSha256"], A)

    def test_off_without_a_url(self) -> None:
        coding_sh.init(disabled=True)
        self.assertIs(_edit(), False)

    def test_server_down_never_raises(self) -> None:
        dead = IngestServer()
        url = dead.url
        dead.close()
        coding_sh.init(url=url, key=support.KEY, flush_interval_ms=5)
        self.assertIs(_edit(), True)  # queued; delivery fails in the background
        coding_sh.flush(1.0)
        coding_sh.shutdown(1.0)

    def test_weights_delta(self) -> None:
        d = coding_sh.weights_delta([[1.0, 2.0], [3.0, 4.0]], [[1.0, 2.0], [3.0, 7.0]])
        self.assertEqual(d, {"shape": [2, 2], "changed": 1, "l2": 3.0, "max_abs": 3.0})
        d = coding_sh.weights_delta([0.0, 0.0, 0.0], [3.0, 0.0, -4.0])
        self.assertEqual((d["shape"], d["changed"], d["l2"], d["max_abs"]), ([3], 2, 5.0, 4.0))
        with self.assertRaises(ValueError):
            coding_sh.weights_delta([1.0, 2.0], [[1.0, 2.0]])

    def test_weights_delta_feeds_weights_edit(self) -> None:
        start_sdk(self.server)
        d = coding_sh.weights_delta([[0.0, 1.0]], [[0.5, 1.0]])
        self.assertTrue(coding_sh.weights_edit("w", base_sha256=A, edited_sha256=B, **d))


def _node_ok() -> bool:
    if not NODE or not os.path.exists(CLI):
        return False
    try:
        v = subprocess.run([NODE, "-v"], capture_output=True, text=True, timeout=10).stdout.strip().lstrip("v")
        major, minor = (int(x) for x in v.split(".")[:2])
        return (major, minor) >= (22, 15)
    except Exception:
        return False


@unittest.skipUnless(_node_ok(), "needs node >= 22.15 and the core package")
class WeightsEditServerTest(unittest.TestCase):
    """A real coding.sh serve on a temp CODING_SH_HOME: the event comes back with the secret redacted."""

    def test_round_trip_through_serve(self) -> None:
        home = os.path.join(support._tmp_home, ".coding.sh-serve")
        ingest = "csh_ik_" + "w" * 43
        read = "csh_rk_" + "r" * 43
        env = dict(
            os.environ,
            HOME=support._tmp_home,
            CODING_SH_HOME=home,
            CODING_SH_INGEST_KEYS="demo:" + ingest,
            CODING_SH_READ_KEYS="demo:" + read,
            NODE_NO_WARNINGS="1",
        )
        proc = subprocess.Popen(
            [NODE, "--no-warnings", CLI, "serve", "--port", "0"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
            cwd=support.ROOT,
        )
        try:
            url = (proc.stdout.readline() or "").strip()
            if not url.startswith("http://"):
                self.fail("serve did not start: " + (proc.stderr.read() if proc.poll() is not None else url))
            coding_sh.init(url=url, key=ingest, service="weights-test", flush_interval_ms=5)
            self.assertTrue(
                coding_sh.weights_edit(
                    "blocks.0." + FAKE_TOKEN,
                    shape=[2, 3],
                    changed=2,
                    l2=0.5,
                    max_abs=0.4,
                    base_sha256=A,
                    edited_sha256=B,
                    note="deploy with " + FAKE_TOKEN,
                )
            )
            self.assertTrue(coding_sh.flush(5.0))
            self.assertEqual(coding_sh.stats()["failed"], 0)
            items = self._events(url, read)
            (e,) = [i for i in items if i["kind"] == "notification"]
            p = e["payload"]
            self.assertEqual(p["kind"], "weights.edit")
            self.assertEqual((p["shape"], p["changed"], p["l2"], p["maxAbs"]), ([2, 3], 2, 0.5, 0.4))
            self.assertEqual((p["baseSha256"], p["editedSha256"]), (A, B))
            self.assertNotIn(FAKE_TOKEN, json.dumps(e))
            self.assertEqual(p["tensor"], "blocks.0.[redacted:github-token]")
            self.assertEqual(p["note"], "deploy with [redacted:github-token]")
        finally:
            coding_sh.shutdown(1.0)
            proc.terminate()
            try:
                proc.wait(10)
            except subprocess.TimeoutExpired:
                proc.kill()
            proc.stdout.close()
            proc.stderr.close()

    def _events(self, url: str, read: str) -> list:
        deadline = time.monotonic() + 10
        while True:
            req = urllib.request.Request(url + "/api/events?limit=50", headers={"Authorization": "Bearer " + read})
            with urllib.request.urlopen(req, timeout=5) as r:
                body = json.loads(r.read())
            items = body["items"] if isinstance(body, dict) else body
            if any(i.get("kind") == "notification" for i in items) or time.monotonic() > deadline:
                return items
            time.sleep(0.1)


if __name__ == "__main__":
    unittest.main()
