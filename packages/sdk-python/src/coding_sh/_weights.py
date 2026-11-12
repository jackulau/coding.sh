"""Weight edits: one `notification` event per edit, `payload.kind` "weights.edit".

    coding_sh.weights_edit(
        "model.layers.3.mlp.down_proj.weight",
        shape=[4096, 11008],
        changed=1204,
        l2=0.0183,
        max_abs=0.004,
        base_sha256=sha_before,
        edited_sha256=sha_after,
    )

The caller's script computes the hashes and norms; this module only checks them and sends them.
It imports no numpy or torch; numpy and torch scalars are accepted as numbers. weights_edit()
never raises into the app: a bad value drops the event with a warning (once per process) and it
returns False. weights_delta() is a helper you call on purpose, so it raises ValueError on bad
input. The event lands in the current trace or session, or in a
session of its own when there is none. Payload fields are in docs/reference/api.md.
"""

from __future__ import annotations

import math
import numbers
import operator
import re
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

from ._trace import Scope, _get, clip, emit, full_capture

KIND = "weights.edit"
_SHA256 = re.compile(r"^[0-9a-fA-F]{64}$")
MAX_DIMS = 16


def _scalar(v: Any) -> Any:
    """A 0-d tensor or array (what torch's `.norm()` and numpy's `np.array(x)` give) as the number
    it holds. Anything else is returned unchanged, for the checks below to accept or refuse."""
    if isinstance(v, numbers.Number):
        return v
    try:
        if getattr(v, "ndim", None) == 0 and callable(getattr(v, "item", None)):
            return v.item()
    except Exception:
        pass
    return v


def _count(v: Any, what: str) -> int:
    v = _scalar(v)
    if isinstance(v, bool) or not isinstance(v, numbers.Integral) or operator.index(v) < 0:
        raise ValueError("%s must be a non-negative integer, got %r" % (what, v))
    return operator.index(v)


def _norm(v: Any, what: str) -> float:
    v = _scalar(v)
    if isinstance(v, bool) or not isinstance(v, numbers.Real):
        raise ValueError("%s must be a finite number >= 0, got %r" % (what, v))
    f = float(v)
    if not math.isfinite(f) or f < 0:
        raise ValueError("%s must be a finite number >= 0, got %r" % (what, v))
    return f


def _sha(v: Any, what: str) -> str:
    if not isinstance(v, str) or not _SHA256.fullmatch(v):
        raise ValueError("%s must be 64 hex characters" % what)
    return v.lower()


def _warn(key: str, msg: str) -> None:
    try:
        _get()._warn_once(key, msg)
    except Exception:
        pass


def _payload(
    tensor: Any, shape: Any, changed: Any, l2: Any, max_abs: Any, base_sha256: Any, edited_sha256: Any, note: Any
) -> Dict[str, Any]:
    if not isinstance(tensor, str) or not tensor:
        raise ValueError("tensor must be a non-empty string")
    if isinstance(shape, (str, bytes)) or not isinstance(shape, Sequence) or len(shape) > MAX_DIMS:
        raise ValueError("shape must be a list of at most %d integers" % MAX_DIMS)
    dims = [_count(d, "shape dimension") for d in shape]
    n = _count(changed, "changed")
    total = 1
    for d in dims:
        total *= d
    if n > total:
        raise ValueError("changed (%d) is larger than the tensor (%d weights)" % (n, total))
    p: Dict[str, Any] = {
        "kind": KIND,
        "tensor": clip(tensor),
        "shape": dims,
        "changed": n,
        "l2": _norm(l2, "l2"),
        "maxAbs": _norm(max_abs, "max_abs"),
        "baseSha256": _sha(base_sha256, "base_sha256"),
        "editedSha256": _sha(edited_sha256, "edited_sha256"),
    }
    if note is not None:
        if not isinstance(note, str):
            # The edit is still recorded; only the note is dropped.
            _warn("weights_edit_note", "coding.sh: weights_edit ignored a note that is not a string")
        elif full_capture() and note:
            p["note"] = clip(note)
    return p


class _WeightsEdit(Scope):
    bind_context = False

    def __init__(self, payload: Dict[str, Any]) -> None:
        super().__init__()
        self.payload = payload
        self.queued = False

    def _root_name(self) -> str:
        return KIND

    def _on_start(self) -> None:
        if self.node is not None:
            self.queued = emit(self.node.event("notification", self._t0, self.payload, child=True))


def weights_edit(
    tensor: str,
    shape: Sequence[int],
    changed: int,
    l2: float,
    max_abs: float,
    base_sha256: str,
    edited_sha256: str,
    note: Optional[str] = None,
) -> bool:
    """Record one weight edit as a `notification` event with `payload.kind` "weights.edit".

    tensor: the tensor's name. shape: its dimensions. changed: how many weights differ.
    l2, max_abs: the L2 norm and the largest absolute value of the change (edited minus base).
    base_sha256, edited_sha256: 64-hex hashes of the tensor before and after. note: free text,
    kept only in full capture mode.

    Returns True only when the event was queued. Returns False when a value is invalid, with
    one warning per process. Returns False without a warning when the SDK is off or shut down
    or the queue is full. Never raises.

    A note that is not a string is dropped with one warning; the edit is still recorded.
    Outside trace() and with_session() the edit gets a session of its own, so group a run of
    edits inside one.
    """
    try:
        p = _payload(tensor, shape, changed, l2, max_abs, base_sha256, edited_sha256, note)
    except Exception as e:
        _warn("weights_edit", "coding.sh: weights_edit dropped an event: %s" % e)
        return False
    try:
        scope = _WeightsEdit(p)
        scope.start()
        queued = scope.queued
        scope.end()
        return queued
    except Exception:
        return False


def _walk(x: Any, shape: List[int], depth: int, out: List[float], leaves: Set[int]) -> None:
    if hasattr(x, "tolist") and not isinstance(x, (list, tuple, range)):
        x = x.tolist()
    if isinstance(x, (list, tuple, range)):
        if depth >= MAX_DIMS:
            raise ValueError("nested more than %d levels deep" % MAX_DIMS)
        if len(shape) == depth:
            shape.append(len(x))
        elif shape[depth] != len(x):
            raise ValueError("ragged array")
        for item in x:
            _walk(item, shape, depth + 1, out, leaves)
    else:
        leaves.add(depth)
        if isinstance(x, bool) or not isinstance(x, numbers.Real):
            raise ValueError("values must be numbers, got %r" % (x,))
        f = float(x)
        if not math.isfinite(f):
            raise ValueError("values must be finite, got %r" % (x,))
        out.append(f)


def _flatten(x: Any) -> Tuple[List[int], List[float]]:
    if not (hasattr(x, "tolist") or isinstance(x, (list, tuple, range))):
        raise ValueError("expected a list, tuple, range or array, got %s" % type(x).__name__)
    shape: List[int] = []
    out: List[float] = []
    try:
        leaves: Set[int] = set()
        _walk(x, shape, 0, out, leaves)
        if leaves and leaves != {len(shape)}:
            raise ValueError("ragged array")
    except ValueError:
        raise
    except Exception as e:  # tolist() or float() failing on an odd object
        raise ValueError("cannot read the values: %s" % type(e).__name__) from e
    return shape, out


def weights_delta(base: Sequence[Any], edited: Sequence[Any]) -> Dict[str, Any]:
    """{shape, changed, l2, max_abs} for two array-likes of the same shape, in pure Python.

    Takes nested lists, tuples, ranges, or anything with `.tolist()` (numpy, torch), up to 16
    levels deep, holding finite numbers. Generators are not accepted. It is slow on large
    tensors: compute big ones with your own library and pass the numbers to weights_edit().

    A pure helper you call on purpose, unlike the never-raise weights_edit(): it raises
    ValueError on bad input (a shape mismatch, ragged or too deep nesting, a non-number, None,
    NaN or inf, or an argument that is not a sequence or array).
    """
    s1, a = _flatten(base)
    s2, b = _flatten(edited)
    if s1 != s2:
        raise ValueError("shapes differ: %r and %r" % (s1, s2))
    changed, sq, peak = 0, 0.0, 0.0
    for x, y in zip(a, b):
        d = abs(y - x)
        if d != 0.0:
            changed += 1
            sq += d * d
            if d > peak:
                peak = d
    return {"shape": s1, "changed": changed, "l2": math.sqrt(sq), "max_abs": peak}
