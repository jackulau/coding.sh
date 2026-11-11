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
It imports no numpy or torch. A bad value drops the event with one warning and returns False:
the SDK never raises into the app. The event lands in the current trace or session, or in a
session of its own when there is none. Payload fields are in docs/reference/api.md.
"""

from __future__ import annotations

import math
import re
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from ._trace import Scope, _get, clip, emit, full_capture

KIND = "weights.edit"
_SHA256 = re.compile(r"^[0-9a-fA-F]{64}$")
MAX_DIMS = 16


def _count(v: Any, what: str) -> int:
    if isinstance(v, bool) or not isinstance(v, int) or v < 0:
        raise ValueError("%s must be a non-negative integer, got %r" % (what, v))
    return v


def _norm(v: Any, what: str) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v < 0:
        raise ValueError("%s must be a finite number >= 0, got %r" % (what, v))
    return float(v)


def _sha(v: Any, what: str) -> str:
    if not isinstance(v, str) or not _SHA256.match(v):
        raise ValueError("%s must be 64 hex characters" % what)
    return v.lower()


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
            raise ValueError("note must be a string")
        if full_capture() and note:
            p["note"] = clip(note)
    return p


class _WeightsEdit(Scope):
    bind_context = False

    def __init__(self, payload: Dict[str, Any]) -> None:
        super().__init__()
        self.payload = payload

    def _root_name(self) -> str:
        return KIND

    def _on_start(self) -> None:
        if self.node is not None:
            emit(self.node.event("notification", self._t0, self.payload, child=True))


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

    Returns True when the event was queued. Returns False, with one warning, when a value is
    invalid or the SDK is off. Never raises.
    """
    try:
        p = _payload(tensor, shape, changed, l2, max_abs, base_sha256, edited_sha256, note)
    except Exception as e:
        try:
            _get()._warn_once("weights_edit", "coding.sh: weights_edit dropped an event: %s" % e)
        except Exception:
            pass
        return False
    try:
        scope = _WeightsEdit(p).start()
        queued = scope.node is not None
        scope.end()
        return queued
    except Exception:
        return False


def _walk(x: Any, shape: List[int], depth: int, out: List[float]) -> None:
    if hasattr(x, "tolist"):
        x = x.tolist()
    if isinstance(x, (list, tuple)):
        if len(shape) == depth:
            shape.append(len(x))
        elif shape[depth] != len(x):
            raise ValueError("ragged array")
        for item in x:
            _walk(item, shape, depth + 1, out)
    else:
        if len(shape) != depth:
            raise ValueError("ragged array")
        out.append(float(x))


def _flatten(x: Any) -> Tuple[List[int], List[float]]:
    shape: List[int] = []
    out: List[float] = []
    _walk(x, shape, 0, out)
    return shape, out


def weights_delta(base: Iterable[Any], edited: Iterable[Any]) -> Dict[str, Any]:
    """{shape, changed, l2, max_abs} for two array-likes of the same shape, in pure Python.

    Takes nested lists or anything with `.tolist()` (numpy, torch). It is slow on large
    tensors: compute big ones with your own library and pass the numbers to weights_edit().
    Unlike weights_edit(), it raises ValueError on a shape mismatch.
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
