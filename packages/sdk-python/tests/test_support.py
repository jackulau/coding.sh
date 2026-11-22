"""support.py gives a test run a temp home of its own and removes it when the run ends, also when a
test fails."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from typing import List, Tuple

import support  # noqa: F401

HERE = os.path.dirname(os.path.abspath(__file__))

# A unittest run that imports support, as every test file does. It prints the temp home it got, then
# runs one test that passes or fails (argv: the tests folder, "pass" or "fail").
CHILD = """
import os, sys, unittest
sys.path.insert(0, sys.argv[1])
import support
print(support._tmp_home, flush=True)

class T(unittest.TestCase):
    def test_it(self):
        self.assertTrue(os.path.isdir(support._tmp_home))
        self.assertEqual(sys.argv[2], "pass")

unittest.main(argv=["child"])
"""


class TempHomeTest(unittest.TestCase):
    def _run(self, outcome: str) -> Tuple[subprocess.CompletedProcess, List[str]]:
        """Runs CHILD with a temp folder of its own; returns the run and what it left there."""
        tmp = tempfile.mkdtemp(prefix="coding-sh-py-support-")
        try:
            env = dict(os.environ, TMPDIR=tmp, TEMP=tmp, TMP=tmp)
            p = subprocess.run([sys.executable, "-c", CHILD, HERE, outcome], env=env, capture_output=True, text=True, timeout=60)
            home = p.stdout.strip()
            self.assertEqual(os.path.normcase(os.path.dirname(home)), os.path.normcase(tmp), "the temp home was made in the run's temp folder")
            return p, sorted(os.listdir(tmp))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_a_run_removes_its_temp_home(self) -> None:
        p, left = self._run("pass")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(left, [], "left in the temp folder after the run")

    def test_a_run_with_a_failing_test_removes_its_temp_home_too(self) -> None:
        p, left = self._run("fail")
        self.assertEqual(p.returncode, 1, p.stderr)
        self.assertIn("FAILED", p.stderr)
        self.assertEqual(left, [], "left in the temp folder after the run")


if __name__ == "__main__":
    unittest.main()
