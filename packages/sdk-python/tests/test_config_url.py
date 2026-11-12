"""A server URL that is not http(s) turns the SDK off with one warning."""

from __future__ import annotations

import unittest

import support  # noqa: F401

import coding_sh
from coding_sh import _client


class ConfigUrlTest(unittest.TestCase):
    def setUp(self) -> None:
        _client._warned_urls.clear()

    def tearDown(self) -> None:
        coding_sh.shutdown(0.5)

    def test_a_url_with_no_scheme_disables_the_sdk_and_warns(self) -> None:
        with self.assertLogs("coding_sh", level="WARNING") as logs:
            coding_sh.init(url="localhost:4318")
        self.assertFalse(_client.Config(url="localhost:4318").enabled)
        self.assertEqual(len(logs.output), 1, logs.output)
        self.assertIn("localhost:4318", logs.output[0])
        self.assertIn("http://", logs.output[0])

    def test_the_warning_is_given_once(self) -> None:
        with self.assertLogs("coding_sh", level="WARNING") as logs:
            coding_sh.init(url="not a url")
            coding_sh.init(url="not a url")
        self.assertEqual(len(logs.output), 1, logs.output)

    def test_credentials_in_the_url_are_not_repeated(self) -> None:
        with self.assertLogs("coding_sh", level="WARNING") as logs:
            _client.Config(url="ftp://user:secret@host/x")
        self.assertNotIn("secret", "\n".join(logs.output))

    def test_a_url_with_no_host_says_so_and_keeps_the_scheme(self) -> None:
        with self.assertLogs("coding_sh", level="WARNING") as logs:
            self.assertFalse(_client.Config(url="https://user:pw@:99").enabled)
        out = "\n".join(logs.output)
        self.assertIn("'https://\u2026@:99' has no host", out)
        self.assertNotIn("must start with", out)
        self.assertNotIn("pw", out)

    def test_a_good_url_and_no_url_are_quiet(self) -> None:
        with self.assertNoLogs("coding_sh", level="WARNING") if hasattr(self, "assertNoLogs") else _nullcontext():
            cfg = _client.Config(url="https://obs.example.com/")
            self.assertTrue(cfg.enabled)
            self.assertFalse(_client.Config().enabled)


class _nullcontext:
    def __enter__(self) -> None:
        return None

    def __exit__(self, *a: object) -> bool:
        return False


if __name__ == "__main__":
    unittest.main()
