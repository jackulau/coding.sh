"""weights_edit: one `notification` event with payload.kind "weights.edit", and weights_checkpoint:
one with payload.kind "weights.checkpoint" (docs/reference/api.md).

The unit tests read the batch the SDK posts to a fake ingest endpoint. The parity tests check
those batches against packages/sdk/test/fixtures/weights-edit.json, which the TypeScript SDK's
weights.test.ts checks too. The last test starts a real `coding.sh serve` on a temp
CODING_SH_HOME and reads the events back, redacted.
"""

from __future__ import annotations

import hashlib
import json
import logging
import numbers
import os
import shutil
import subprocess
import time
import unittest
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, List, Optional

import support
from support import IngestServer, by_kind, collect, start_sdk

import coding_sh
from coding_sh import _weights

A = "a" * 64
B = "b" * 64
CLI = os.path.join(support.ROOT, "..", "coding.sh", "src", "cli", "main.ts")
# SHA-256 of a whole weights file and of the file it was edited from, as a script would compute them.
FILE = "58899f90572c" + "0" * 52
FILE_BASE = "0496e5111097" + "f" * 52
# What both SDKs must send for the same edit and the same checkpoint. The TypeScript SDK's tests read the same file.
FIXTURE = os.path.join(support.ROOT, "..", "sdk", "test", "fixtures", "weights-edit.json")
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
        _weights._reset_warned()
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

    def test_a_second_init_does_not_warn_again(self) -> None:
        start_sdk(self.server)
        with self.assertLogs("coding_sh", level="WARNING") as cm:
            _edit(changed=-1)
            coding_sh.shutdown(1.0)
            start_sdk(self.server)
            _edit(changed=-2)
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


def _checkpoint(**kw: Any) -> bool:
    args: Dict[str, Any] = dict(sha256=FILE, base_sha256=FILE_BASE)
    args.update(kw)
    return coding_sh.weights_checkpoint(args.pop("sha256"), **args)


class WeightsCheckpointTest(unittest.TestCase):
    """weights_checkpoint() follows weights_edit() case for case; weights.test.ts has the same list."""

    def setUp(self) -> None:
        # The warnings are once per process: each test starts with none given.
        _weights._reset_warned()
        self.server = IngestServer()

    def tearDown(self) -> None:
        coding_sh.shutdown(1.0)
        self.server.close()

    def _payloads(self) -> List[Dict[str, Any]]:
        return [e["payload"] for e in by_kind(collect(self.server), "notification")]

    def test_one_notification_with_the_payload(self) -> None:
        start_sdk(self.server)
        self.assertIs(_checkpoint(note="after layer 3"), True)
        events = collect(self.server)
        (e,) = by_kind(events, "notification")
        self.assertEqual(e["payload"], {"kind": "weights.checkpoint", "sha256": FILE, "baseSha256": FILE_BASE, "note": "after layer 3"})
        self.assertEqual(e["source"], "sdk")
        (start,) = by_kind(events, "session.start")  # a session of its own, named after the event
        self.assertEqual(start["payload"]["name"], "weights.checkpoint")

    def test_the_hash_alone_is_enough_and_a_missing_base_is_left_out(self) -> None:
        start_sdk(self.server)
        self.assertIs(coding_sh.weights_checkpoint(FILE), True)
        self.assertIs(_checkpoint(base_sha256=None), True)
        self.assertEqual(self._payloads(), [{"kind": "weights.checkpoint", "sha256": FILE}] * 2)

    def test_base_and_note_are_keyword_only(self) -> None:
        start_sdk(self.server)
        with self.assertRaises(TypeError):
            coding_sh.weights_checkpoint(FILE, FILE_BASE)  # type: ignore[misc]

    def test_joins_the_trace_that_recorded_the_edits(self) -> None:
        start_sdk(self.server)
        with coding_sh.trace("edit-run", session_id="conv-1"):
            _edit()
            _edit(tensor="lm_head.weight")
            _checkpoint()
        events = collect(self.server)
        notes = by_kind(events, "notification")
        self.assertEqual(
            [(n["sessionId"], n["payload"]["kind"]) for n in notes],
            [("conv-1", "weights.edit"), ("conv-1", "weights.edit"), ("conv-1", "weights.checkpoint")],
        )
        self.assertEqual(len(by_kind(events, "session.start")), 1)

    def test_metadata_mode_drops_the_note_only(self) -> None:
        start_sdk(self.server, capture="metadata")
        _checkpoint(note="free text")
        self.assertEqual(self._payloads(), [{"kind": "weights.checkpoint", "sha256": FILE, "baseSha256": FILE_BASE}])

    def test_invalid_values_are_dropped_not_raised(self) -> None:
        start_sdk(self.server)
        bad = [
            dict(sha256="abc"),
            dict(sha256="g" * 64),
            dict(sha256=FILE + "\n"),  # a trailing newline is not 64 hex characters
            dict(sha256="sha256:" + FILE),
            dict(sha256=None),
            dict(sha256=5),
            dict(sha256=bytes.fromhex(FILE)),
            dict(base_sha256="abc"),
            dict(base_sha256=FILE[1:]),
            dict(base_sha256=5),
            dict(base_sha256=""),
        ]
        with self.assertLogs("coding_sh", level="WARNING") as cm:
            for kw in bad:
                self.assertIs(_checkpoint(**kw), False, kw)
        self.assertEqual(len(cm.records), 1)
        self.assertEqual(cm.records[0].getMessage(), "coding.sh: weights_checkpoint dropped an event: sha256 must be 64 hex characters")
        coding_sh.flush(2.0)
        self.assertEqual(by_kind(self.server.events(), "notification"), [])

    def test_uppercase_sha_is_lowercased(self) -> None:
        start_sdk(self.server)
        self.assertIs(_checkpoint(sha256=FILE.upper(), base_sha256=FILE_BASE.upper()), True)
        (p,) = self._payloads()
        self.assertEqual((p["sha256"], p["baseSha256"]), (FILE, FILE_BASE))

    def test_returns_false_when_disabled(self) -> None:
        coding_sh.init(disabled=True)
        self.assertIs(_checkpoint(), False)

    def test_returns_false_without_a_url(self) -> None:
        coding_sh.init(url="")
        self.assertIs(_checkpoint(), False)

    def test_returns_false_after_shutdown(self) -> None:
        start_sdk(self.server)
        self.assertIs(_checkpoint(), True)
        coding_sh.shutdown(2.0)
        self.assertIs(_checkpoint(), False)

    def test_returns_false_when_the_queue_is_full(self) -> None:
        start_sdk(self.server, max_queue=1, flush_interval_ms=60000)
        with coding_sh.trace("full"):  # session.start takes the one slot
            self.assertIs(_checkpoint(), False)

    def test_warns_once_per_process_apart_from_weights_edit(self) -> None:
        start_sdk(self.server)
        with self.assertLogs("coding_sh", level="WARNING") as cm:
            _checkpoint(sha256="abc")
            _checkpoint(base_sha256="abc")
            _checkpoint(sha256=5)
            _edit(changed=-1)
        self.assertEqual(len([r for r in cm.records if "weights_checkpoint dropped" in r.getMessage()]), 1)
        self.assertEqual(len([r for r in cm.records if "weights_edit dropped" in r.getMessage()]), 1)

    def test_note_that_is_not_a_string_is_dropped_with_a_warning_an_empty_one_without(self) -> None:
        start_sdk(self.server)
        with self.assertLogs("coding_sh", level="WARNING") as cm:
            self.assertIs(_checkpoint(note=5), True)
            self.assertIs(_checkpoint(note={"text": "x"}), True)
            self.assertIs(_checkpoint(note=""), True)
            self.assertIs(_checkpoint(note=None), True)
        self.assertEqual([r.getMessage() for r in cm.records], ["coding.sh: weights_checkpoint ignored a note that is not a string"])
        self.assertEqual(self._payloads(), [{"kind": "weights.checkpoint", "sha256": FILE, "baseSha256": FILE_BASE}] * 4)

    def test_inside_with_session(self) -> None:
        start_sdk(self.server)
        with coding_sh.with_session("run-7"):
            _checkpoint()
        self.assertEqual([n["sessionId"] for n in by_kind(collect(self.server), "notification")], ["run-7"])

    def test_inside_a_span_links_to_it(self) -> None:
        start_sdk(self.server)
        with coding_sh.trace("run"):
            with coding_sh.span("tool", "save"):
                _checkpoint()
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
        self.assertIs(_checkpoint(), True)  # queued; delivery fails in the background
        coding_sh.flush(1.0)
        coding_sh.shutdown(1.0)


def _alone(edit: Callable[[], bool], sid: Optional[str]) -> bool:
    return edit()


def _with_session(edit: Callable[[], bool], sid: Optional[str]) -> bool:
    with coding_sh.with_session(str(sid)):
        return edit()


def _trace(edit: Callable[[], bool], sid: Optional[str]) -> bool:
    with coding_sh.trace("run", session_id=sid):
        return edit()


def _tool_span(edit: Callable[[], bool], sid: Optional[str]) -> bool:
    with coding_sh.trace("run"):
        with coding_sh.span("tool", "patch"):
            return edit()


def _step_span(edit: Callable[[], bool], sid: Optional[str]) -> bool:
    with coding_sh.trace("run"):
        with coding_sh.span("step", "patch"):
            return edit()


# One entry per scenario in the fixture; weights.test.ts has the same list.
SCENARIOS: Dict[str, Callable[[Callable[[], bool], Optional[str]], bool]] = {
    "alone": _alone,
    "withSession": _with_session,
    "trace": _trace,
    "traceWithSessionId": _trace,
    "toolSpan": _tool_span,
    "stepSpan": _step_span,
}


class WeightsEditParityTest(unittest.TestCase):
    """weights_edit() and weights_checkpoint() here send the same events as weightsEdit() and
    weightsCheckpoint() in the TypeScript SDK.

    The fixture holds, for one event in each place it can be recorded, the events in the order
    they are posted: each event's kind, its keys and its payload. Every scenario runs once for
    the edit and once for the checkpoint. A missing fixture is a failure.
    """

    fx: Dict[str, Any] = {}

    @classmethod
    def setUpClass(cls) -> None:
        with open(FIXTURE, encoding="utf-8") as f:
            cls.fx = json.load(f)

    def tearDown(self) -> None:
        coding_sh.shutdown(1.0)

    def _edit(self) -> bool:
        e = self.fx["edit"]
        return coding_sh.weights_edit(
            e["tensor"],
            shape=e["shape"],
            changed=e["changed"],
            l2=e["l2"],
            max_abs=e["maxAbs"],
            base_sha256=e["baseSha256"],
            edited_sha256=e["editedSha256"],
            note=e["note"],
        )

    def _checkpoint(self) -> bool:
        c = self.fx["checkpoint"]
        return coding_sh.weights_checkpoint(c["sha256"], base_sha256=c["baseSha256"], note=c["note"])

    def _posted(self, name: str, record: Callable[[], bool]) -> List[Dict[str, Any]]:
        server = IngestServer()
        try:
            start_sdk(server)
            self.assertIs(SCENARIOS[name](record, self.fx["scenarios"][name]["sessionId"]), True)
            return collect(server)
        finally:
            coding_sh.shutdown(1.0)
            server.close()

    def test_every_scenario_in_the_fixture_runs_here(self) -> None:
        self.assertEqual(sorted(SCENARIOS), sorted(self.fx["scenarios"]))

    def test_the_same_events_as_the_typescript_sdk(self) -> None:
        volatile = set(self.fx["volatilePayloadKeys"])
        ignored = set(self.fx["ignoredEventKeys"])
        # Each scenario once per helper: what is recorded, and the payload the fixture says it sends.
        records = [("weights_edit", self._edit, self.fx["payload"]), ("weights_checkpoint", self._checkpoint, self.fx["checkpointPayload"])]
        for name, sc in self.fx["scenarios"].items():
            for helper, record, payload in records:
                with self.subTest(name, helper=helper):
                    events = self._posted(name, record)
                    got = [
                        {
                            "kind": e["kind"],
                            "keys": sorted(k for k in e if k not in ignored),
                            "payload": {k: "<volatile>" if k in volatile else v for k, v in e["payload"].items()},
                        }
                        for e in events
                    ]
                    # "<kind>" in the fixture: a session the helper opens by itself is named after the event.
                    want = [
                        dict(e, payload=payload)
                        if e["kind"] == "notification"
                        else dict(e, payload=dict(e["payload"], name=payload["kind"]))
                        if e.get("payload", {}).get("name") == "<kind>"
                        else e
                        for e in sc["events"]
                    ]
                    self.assertEqual(got, want)

                    # One trace, one session, and the event hangs off the event the fixture names.
                    first = events[0]
                    (note,) = by_kind(events, "notification")
                    self.assertEqual({e["traceId"] for e in events}, {first["traceId"]})
                    self.assertEqual({e["sessionId"] for e in events}, {sc["sessionId"] or first["sessionId"]})
                    if sc["parent"] is None:
                        self.assertEqual(note["spanId"], first["spanId"])
                    else:
                        (parent,) = by_kind(events, sc["parent"])
                        self.assertEqual(note["parentId"], parent["id"])
                        self.assertEqual(note["parentSpanId"], parent["spanId"])
                        self.assertNotEqual(note["spanId"], parent["spanId"])
                    if "turnId" in note:
                        self.assertEqual(note["turnId"], note["traceId"])

    def test_the_same_delta_as_the_typescript_sdk(self) -> None:
        d = self.fx["delta"]
        got = coding_sh.weights_delta(d["base"], d["edited"])
        got["maxAbs"] = got.pop("max_abs")  # the TypeScript SDK's name for it
        self.assertEqual(got, d["result"])


def _node_ok() -> bool:
    if not NODE or not os.path.exists(CLI):
        return False
    try:
        v = subprocess.run([NODE, "-v"], capture_output=True, text=True, timeout=10).stdout.strip().lstrip("v")
        major, minor = (int(x) for x in v.split(".")[:2])
        return (major, minor) >= (22, 16)
    except Exception:
        return False


@unittest.skipUnless(_node_ok(), "needs node >= 22.16 and the core package")
class WeightsEditServerTest(unittest.TestCase):
    """A real coding.sh serve on a temp CODING_SH_HOME: the events come back with the secret redacted
    and the hashes whole, and the session is found by the checkpoint's hash."""

    def test_round_trip_through_serve(self) -> None:
        home = os.path.join(support._tmp_home, ".coding.sh-serve")
        ingest = "csh_ik_" + "w" * 43
        read = "csh_rk_" + "r" * 43
        # Nothing the server reads or writes is the user's: every home it knows is under the temp home.
        tmp = support._tmp_home
        env = dict(
            os.environ,
            HOME=tmp,
            USERPROFILE=tmp,
            CODING_SH_HOME=home,
            CLAUDE_CONFIG_DIR=os.path.join(tmp, "claude"),
            CODEX_HOME=os.path.join(tmp, "codex"),
            XDG_CONFIG_HOME=os.path.join(tmp, "xdg-config"),
            XDG_DATA_HOME=os.path.join(tmp, "xdg-data"),
            CURSOR_CONFIG_DIR=os.path.join(tmp, "cursor"),
            OPENCODE_CONFIG_DIR=os.path.join(tmp, "opencode"),
            OPENCODE_DB=os.path.join(tmp, "opencode.db"),
            CODING_SH_NO_AUTO_INGEST="1",
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
            # Hashes of real bytes: the server's redactor must leave a SHA-256 alone, or the join on it breaks.
            file = hashlib.sha256(b"edited weights file").hexdigest()
            file_base = hashlib.sha256(b"base weights file").hexdigest()
            with coding_sh.trace("edit-run"):
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
                self.assertTrue(coding_sh.weights_checkpoint(file.upper(), base_sha256=file_base, note="saved with " + FAKE_TOKEN))
            self.assertTrue(coding_sh.flush(5.0))
            self.assertEqual(coding_sh.stats()["failed"], 0)
            items = self._events(url, read)
            (saved,) = [i for i in items if i["payload"].get("kind") == "weights.checkpoint"]
            kept = {k: v for k, v in saved["payload"].items() if k != "redactions"}
            self.assertEqual(
                kept,
                {"kind": "weights.checkpoint", "sha256": file, "baseSha256": file_base, "note": "saved with [redacted:github-token]"},
            )
            self.assertNotIn(FAKE_TOKEN, json.dumps(saved))
            # The session the two events share is found by the file's hash, with the edit it recorded.
            found = self._get(url + "/api/sessions?where=" + urllib.parse.quote("weights.checkpoint:" + file), read)
            sessions = found["items"] if isinstance(found, dict) else found
            self.assertEqual(
                [s["stats"]["weightEdits"] for s in sessions],
                [{"events": 1, "tensors": 1, "weightsChanged": 2, "checkpoints": [file]}],
            )
            (e,) = [i for i in items if i["payload"].get("kind") == "weights.edit"]
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

    def _get(self, url: str, read: str) -> Any:
        req = urllib.request.Request(url, headers={"Authorization": "Bearer " + read})
        with urllib.request.urlopen(req, timeout=5) as r:
            return json.loads(r.read())

    def _events(self, url: str, read: str) -> list:
        deadline = time.monotonic() + 10
        while True:
            body = self._get(url + "/api/events?limit=50", read)
            items = body["items"] if isinstance(body, dict) else body
            if len([i for i in items if i.get("kind") == "notification"]) >= 2 or time.monotonic() > deadline:
                return items
            time.sleep(0.1)


if __name__ == "__main__":
    unittest.main()
