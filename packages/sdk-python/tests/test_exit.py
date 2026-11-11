"""Process-exit behavior: the atexit flush sends what is queued, and is bounded to 2 s."""

from __future__ import annotations

import os
import subprocess
import sys
import textwrap
import time
import unittest

import support
from support import KEY, IngestServer

SCRIPT = textwrap.dedent(
    """
    import os, sys
    sys.path.insert(0, os.environ["SDK_SRC"])
    import coding_sh
    coding_sh.init(url=os.environ["INGEST"], key=os.environ["KEY"], flush_interval_ms=60000)
    with coding_sh.trace("exit-test", session_id="exit-1", input="bye"):
        pass
    print("app output")
    """
)


class ExitTest(unittest.TestCase):
    def setUp(self) -> None:
        self.server = IngestServer()

    def tearDown(self) -> None:
        self.server.close()

    def _run(self) -> "tuple[subprocess.CompletedProcess, float]":
        env = dict(os.environ, SDK_SRC=support.SRC, INGEST=self.server.url, KEY=KEY)
        t0 = time.monotonic()
        p = subprocess.run([sys.executable, "-c", SCRIPT], env=env, capture_output=True, text=True, timeout=30)
        return p, time.monotonic() - t0

    def test_atexit_flushes_queued_events(self) -> None:
        p, _ = self._run()
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(p.stdout, "app output\n")
        self.assertEqual(p.stderr, "")
        events = self.server.events()
        self.assertEqual([e["kind"] for e in events], ["session.start", "user.message", "turn.end"])

    def test_atexit_is_bounded_when_server_hangs(self) -> None:
        self.server.delay = 8.0
        p, elapsed = self._run()
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(p.stdout, "app output\n")
        self.assertLess(elapsed, 5.0)


DEAD_SCRIPT = textwrap.dedent(
    """
    import os, sys, time
    sys.path.insert(0, os.environ["SDK_SRC"])
    import coding_sh
    coding_sh.init(url=os.environ["INGEST"], flush_interval_ms=10)
    with coding_sh.trace("exit-test", input="bye"):
        pass
    drained = coding_sh.flush(0.5)
    sys.stdout.write("%s %f" % (drained, time.time()))
    sys.stdout.flush()
    """
)


class ExitAfterFailedFlushTest(unittest.TestCase):
    def test_exit_does_not_flush_again_after_a_flush_gave_up(self) -> None:
        import socket

        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()  # a port nothing listens on
        env = dict(os.environ, SDK_SRC=support.SRC, INGEST="http://127.0.0.1:%d" % port)
        p = subprocess.run([sys.executable, "-c", DEAD_SCRIPT], env=env, capture_output=True, text=True, timeout=30)
        end = time.time()
        self.assertEqual(p.returncode, 0, p.stderr)
        drained, flushed_at = p.stdout.split()
        self.assertEqual(drained, "False")
        self.assertLess(end - float(flushed_at), 1.2, "the process stayed after flush() gave up")
        self.assertEqual(p.stderr.count("coding.sh"), 1, p.stderr)
        self.assertIn("not sent", p.stderr)


if __name__ == "__main__":
    unittest.main()
