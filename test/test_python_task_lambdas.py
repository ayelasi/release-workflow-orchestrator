"""Tests task behavior for the Python artifact and containerized scan Lambdas."""

import contextlib
import io
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lambdas" / "b2-artifact-verify"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lambdas" / "b3-security-scan"))

import handler as artifact_handler
import app as security_handler


RELEASE_INPUT = {
    "version": "latest",
    "environment": "SIT",
    "approved": True,
}


class PythonTaskLambdaTests(unittest.TestCase):
    def invoke_with_fast_sleep(self, task_handler, event):
        output = io.StringIO()
        with patch.dict(
            os.environ,
            {"TASK_SLEEP_SECONDS": "0"},
        ), contextlib.redirect_stdout(output):
            result = task_handler(event, None)
        return result, output.getvalue().splitlines()

    def test_artifact_verification_returns_checksum_and_metadata(self):
        result, logs = self.invoke_with_fast_sleep(
            artifact_handler.handler, RELEASE_INPUT
        )

        self.assertEqual(result["taskId"], "B2")
        self.assertEqual(result["outcome"], "SUCCESS")
        self.assertRegex(result["checksum"], r"^[a-f0-9]{64}$")
        self.assertEqual(logs, ["Lambda B2"])
        self.assertGreaterEqual(result["durationMs"], 0)
        self.assertTrue(result["startedAt"])
        self.assertTrue(result["finishedAt"])

    def test_security_scan_is_clean_for_latest(self):
        result, logs = self.invoke_with_fast_sleep(
            security_handler.handler, RELEASE_INPUT
        )

        self.assertEqual(result["taskId"], "B3")
        self.assertEqual(result["outcome"], "SUCCESS")
        self.assertNotIn("findings", result)
        self.assertEqual(logs, ["Lambda B3"])

    def test_security_scan_reports_critical_finding_for_beta(self):
        result, _ = self.invoke_with_fast_sleep(
            security_handler.handler,
            {**RELEASE_INPUT, "version": "beta"},
        )

        self.assertEqual(result["outcome"], "WARNING")
        self.assertEqual(result["findings"][0]["severity"], "critical")

    def test_handlers_choose_random_delays_from_one_to_ten_seconds(self):
        with patch.dict(os.environ):
            os.environ.pop("TASK_SLEEP_SECONDS", None)
            with (
                patch.object(
                    artifact_handler.random, "randint", return_value=5
                ) as artifact_random,
                patch.object(artifact_handler.time, "sleep") as artifact_sleep,
            ):
                with contextlib.redirect_stdout(io.StringIO()):
                    artifact_handler.handler(RELEASE_INPUT, None)
            with (
                patch.object(
                    security_handler.random, "randint", return_value=8
                ) as security_random,
                patch.object(security_handler.time, "sleep") as security_sleep,
            ):
                with contextlib.redirect_stdout(io.StringIO()):
                    security_handler.handler(RELEASE_INPUT, None)

        artifact_random.assert_called_once_with(1, 10)
        security_random.assert_called_once_with(1, 10)
        artifact_sleep.assert_called_once_with(5)
        security_sleep.assert_called_once_with(8)

    def test_rejects_invalid_input(self):
        with self.assertRaisesRegex(ValueError, "version must be latest or beta"):
            self.invoke_with_fast_sleep(artifact_handler.handler, {})


if __name__ == "__main__":
    unittest.main()
