"""weights_edit: one `notification` event with payload.kind "weights.edit" (docs/reference/api.md).

The unit tests read the batch the SDK posts to a fake ingest endpoint. The last test starts a real
`coding.sh serve` on a temp CODING_SH_HOME and reads the event back, redacted.
"""

from __future__ import annotations

import json
import logging
import numbers
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


class FakeInt:
    """An integer that is not an int, the way numpy's integers are."""

    def __init__(self, v: int) -> None:
        self.v = v

    def __index__(self) -> int:
        return self.v

    __int__ = __index__

    def __lt__(self, o: Any) -> bool:
        return self.v < o

    def __le__(self, o: Any) -> bool:
        return self.v <= o

    def __eq__(self, o: Any) -> bool:
        return self.v == o

    def __hash__(self) -> int:
        return hash(self.v)

    def __repr__(self) -> str:
        return "FakeInt(%d)" % self.v


class FakeFloat:
    """A real number that is not a float, the way numpy's float32 is."""

    def __init__(self, v: float) -> None:
        self.v = v

    def __float__(self) -> float:
        return self.v

    def __lt__(self, o: Any) -> bool:
        return self.v < o

    def __le__(self, o: Any) -> bool:
        return self.v <= o

    def __eq__(self, o: Any) -> bool:
        return self.v == o

    def __hash__(self) -> int:
        return hash(self.v)

    def __repr__(self) -> str:
        return "FakeFloat(%r)" % self.v


numbers.Integral.register(FakeInt)
numbers.Real.register(FakeFloat)


class FakeTensor:
    """A tensor the way torch's are: no numbers ABC, a number only through ndim == 0 and item()."""

    def __init__(self, v: Any, ndim: int = 0) -> None:
        self.v = v
        self.ndim = ndim

    def item(self) -> Any:
        if self.ndim != 0:
            raise ValueError("only one element tensors can be converted to Python scalars")
        return self.v

    def __repr__(self) -> str:
        return "tensor(%r)" % (self.v,)


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
            dict(base_sha256=A + "\n"),  # a trailing newline is not 64 hex characters
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

    def test_returns_false_when_disabled(self) -> None:
        coding_sh.init(disabled=True)
        self.assertIs(_edit(), False)

    def test_returns_false_without_a_url(self) -> None:
        coding_sh.init(url="")
        self.assertIs(_edit(), False)

    def test_returns_false_after_shutdown(self) -> None:
        start_sdk(self.server)
        self.assertTrue(_edit())
        coding_sh.shutdown(2.0)
        self.assertIs(_edit(), False)

    def test_returns_false_when_the_queue_is_full(self) -> None:
        start_sdk(self.server, max_queue=1, flush_interval_ms=60000)
        with coding_sh.trace("full"):  # session.start takes the one slot
            self.assertIs(_edit(), False)

    def test_accepts_numpy_like_numbers(self) -> None:
        start_sdk(self.server)
        self.assertTrue(_edit(changed=FakeInt(12), shape=[FakeInt(4), FakeInt(8)], l2=FakeFloat(0.25), max_abs=FakeFloat(0.1)))
        (e,) = by_kind(collect(self.server), "notification")
        p = e["payload"]
        self.assertEqual((p["changed"], p["shape"], p["l2"], p["maxAbs"]), (12, [4, 8], 0.25, 0.1))
        for v in (p["changed"], p["l2"]):
            self.assertIn(type(v), (int, float))
        self.assertIs(_edit(changed=FakeInt(-1)), False)
        self.assertIs(_edit(l2=FakeFloat(float("nan"))), False)

    def test_accepts_zero_dim_tensors(self) -> None:
        # What delta.norm(), delta.abs().max() and (delta != 0).sum() return in torch.
        start_sdk(self.server)
        self.assertTrue(_edit(changed=FakeTensor(12), shape=[FakeTensor(4), 8], l2=FakeTensor(0.25), max_abs=FakeTensor(0.1)))
        (e,) = by_kind(collect(self.server), "notification")
        p = e["payload"]
        self.assertEqual((p["changed"], p["shape"], p["l2"], p["maxAbs"]), (12, [4, 8], 0.25, 0.1))
        for v in (p["changed"], p["l2"], p["maxAbs"]):
            self.assertIn(type(v), (int, float))

    def test_refuses_tensors_that_are_not_one_number(self) -> None:
        start_sdk(self.server)
        self.assertIs(_edit(l2=FakeTensor([0.25, 0.5], ndim=1)), False)
        self.assertIs(_edit(changed=FakeTensor(1.5)), False)
        self.assertIs(_edit(l2=FakeTensor(float("inf"))), False)
        self.assertIs(_edit(max_abs=FakeTensor("0.1")), False)
        self.assertIs(_edit(changed=FakeTensor(True)), False)
        self.assertEqual(by_kind(collect(self.server), "notification"), [])

    def test_warns_once_per_process(self) -> None:
        start_sdk(self.server)
        with self.assertLogs("coding_sh", level="WARNING") as cm:
            _edit(changed=-1)
            _edit(changed=-2)
            _edit(l2=-1.0)
        self.assertEqual(len([r for r in cm.records if "weights_edit dropped" in r.getMessage()]), 1)

    def test_note_that_is_not_a_string_is_dropped_with_a_warning(self) -> None:
        start_sdk(self.server)
        with self.assertLogs("coding_sh", level="WARNING") as cm:
            self.assertTrue(_edit(note=5))
        self.assertIn("note", cm.output[0])
        (e,) = by_kind(collect(self.server), "notification")
        self.assertNotIn("note", e["payload"])
        self.assertEqual(e["payload"]["changed"], 12)

    def test_inside_with_session(self) -> None:
        start_sdk(self.server)
        with coding_sh.with_session("run-7"):
            _edit()
            _edit(tensor="b")
        events = collect(self.server)
        notes = by_kind(events, "notification")
        self.assertEqual([n["sessionId"] for n in notes], ["run-7", "run-7"])

    def test_inside_a_span_links_to_it(self) -> None:
        start_sdk(self.server)
        with coding_sh.trace("run"):
            with coding_sh.span("tool", "patch"):
                _edit()
        events = collect(self.server)
        (note,) = by_kind(events, "notification")
        (tool,) = by_kind(events, "tool.start")
        self.assertEqual(note["parentId"], tool["id"])
        self.assertEqual(note["parentSpanId"], tool["spanId"])

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

    def test_weights_delta_edges(self) -> None:
        self.assertEqual(coding_sh.weights_delta([], []), {"shape": [0], "changed": 0, "l2": 0.0, "max_abs": 0.0})
        self.assertEqual(coding_sh.weights_delta([[], []], [[], []])["shape"], [2, 0])

        class ZeroD:  # like a 0-d numpy array
            def __init__(self, v: float) -> None:
                self.v = v

            def tolist(self) -> float:
                return self.v

        self.assertEqual(coding_sh.weights_delta(ZeroD(1.0), ZeroD(3.0)), {"shape": [], "changed": 1, "l2": 2.0, "max_abs": 2.0})
        self.assertEqual(coding_sh.weights_delta(range(3), [0, 1, 5])["changed"], 1)

    def test_weights_delta_bad_input_raises_value_error(self) -> None:
        deep: Any = []
        for _ in range(40):
            deep = [deep]
        nan, inf = float("nan"), float("inf")
        bad = [
            ([1, [2]], [1, [2]]),
            ([[1], 2], [[1], 2]),
            ([[], [1]], [[], [1]]),
            (["a"], ["a"]),
            ([None], [None]),
            ([True], [True]),
            (None, None),
            (5, 5),
            ("ab", "ab"),
            ((x for x in [1]), [1]),
            ([nan], [1.0]),
            ([1.0], [inf]),
            (deep, deep),
            ([1, 2], [1]),
        ]
        for a, b in bad:
            with self.assertRaises(ValueError, msg=repr(a)[:40]):
                coding_sh.weights_delta(a, b)

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
