"""Simulates artifact verification and returns a checksum."""

import hashlib
import json
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
    print("Lambda B2")

    release_input = _parse_release_input(event)
    time.sleep(_sleep_seconds())
    serialized_input = json.dumps(release_input, sort_keys=True).encode("utf-8")
    checksum = hashlib.sha256(serialized_input).hexdigest()

    finished_at = datetime.now(timezone.utc)
    return {
        "taskId": "B2",
        "outcome": "SUCCESS",
        "startedAt": started_at.isoformat(),
        "finishedAt": finished_at.isoformat(),
        "durationMs": int((finished_at - started_at).total_seconds() * 1000),
        "message": "Artifact verification passed",
        "checksum": checksum,
    }
