"""Type-checked with mypy --strict by tests/test_typing.py. Not run."""

from __future__ import annotations

from typing import Optional

import coding_sh


def reply(question: str) -> str:
    with coding_sh.trace("reply", session_id="s1", input=question) as t:
        sid: Optional[str] = t.session_id
        tid: Optional[str] = t.trace_id
        t.set_input(question)
        with coding_sh.span("tool", "lookup", input={"q": question}) as s:
            s.set_output({"ok": True})
        t.set_output("done")
        print(sid, tid)
    return "done"


async def areply(question: str) -> str:
    async with coding_sh.trace("areply") as t:
        print(t.session_id, t.trace_id)
    return question


@coding_sh.trace("decorated")
def decorated(x: int) -> int:
    return x + 1


@coding_sh.span("tool", "double")
async def double(x: int) -> int:
    return x * 2


n: int = decorated(1)
