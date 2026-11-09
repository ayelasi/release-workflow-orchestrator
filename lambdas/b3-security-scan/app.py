"""Simulates a containerized security scan and reports findings."""

import os
import random
import time
from datetime import datetime, timezone


def _sleep_seconds():
    configured_seconds = os.environ.get("TASK_SLEEP_SECONDS")
    if configured_seconds is None:
        return random.randint(1, 10)

    try:
        seconds = int(configured_seconds)
    except ValueError as error:
        raise ValueError("TASK_SLEEP_SECONDS must be an integer from 0 to 10") from error

    if seconds < 0 or seconds > 10:
        raise ValueError("Task sleep duration must be between 0 and 10 seconds")
    return seconds


def _parse_release_input(event):
    if not isinstance(event, dict):
        raise ValueError("Task event must be an object containing release input")

    version = event.get("version")
    environment = event.get("environment")
    approved = event.get("approved")

    if version not in ("latest", "beta"):
        raise ValueError("Release input version must be latest or beta")
    if environment not in ("SIT", "PROD"):
        raise ValueError("Release input environment must be SIT or PROD")
    if not isinstance(approved, bool):
        raise ValueError("Release input approved must be a boolean")
    return {
        "version": version,
        "environment": environment,
        "approved": approved,
    }


def handler(event, context):
    started_at = datetime.now(timezone.utc)
    print("Lambda B3")

    release_input = _parse_release_input(event)
    time.sleep(_sleep_seconds())

    result = {
        "taskId": "B3",
        "outcome": "SUCCESS",
        "startedAt": started_at.isoformat(),
        "finishedAt": "",
        "durationMs": 0,
        "message": "Security scan clean",
    }

    if release_input["version"] == "beta":
        result.update(
            {
                "outcome": "WARNING",
                "message": "Critical security findings detected",
                "findings": [
                    {
                        "severity": "critical",
                        "description": "Simulated critical finding",
                    }
                ],
            }
        )

    finished_at = datetime.now(timezone.utc)
    result["finishedAt"] = finished_at.isoformat()
    result["durationMs"] = int((finished_at - started_at).total_seconds() * 1000)
    return result
