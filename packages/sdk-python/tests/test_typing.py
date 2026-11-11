"""The public typing of the SDK: tests/typing/trace_example.py passes mypy --strict.

Skipped (and said so) when mypy is not installed: `pip install mypy` to run it.
"""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest

import support

HERE = os.path.dirname(os.path.abspath(__file__))


@unittest.skipIf(importlib.util.find_spec("mypy") is None and not support.REQUIRE_ALL, "mypy is not installed (pip install mypy); the typing check did not run")
class TypingTest(unittest.TestCase):
    def test_trace_and_span_yield_typed_handles(self) -> None:
        with tempfile.TemporaryDirectory() as cache:
            env = dict(os.environ, MYPYPATH=support.SRC)
            p = subprocess.run(
                # No --python-version: mypy checks for the interpreter it runs on (mypy 2 no longer takes 3.9).
                [sys.executable, "-m", "mypy", "--strict", "--cache-dir", cache, os.path.join(HERE, "typing", "trace_example.py")],
                env=env,
                capture_output=True,
                text=True,
                timeout=300,
            )
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)


if __name__ == "__main__":
    unittest.main()
