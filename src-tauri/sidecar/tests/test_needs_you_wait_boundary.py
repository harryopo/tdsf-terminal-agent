"""Deterministic coverage for approval and caller wait deadlines."""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).parent.parent))

import needs_you
from needs_you import NeedsYouService, NeedsYouStatus


class _Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def time(self) -> float:
        return self.now

    def monotonic(self) -> float:
        return self.now


def _pending_approval(monkeypatch, clock: _Clock):
    monkeypatch.setattr(
        needs_you, "time", SimpleNamespace(time=clock.time, monotonic=clock.monotonic)
    )
    service = NeedsYouService(approval_timeout=0.5)
    request = service.request_approval(
        title="Confirm action", description="Synthetic boundary case", session_id="s1"
    )
    return service, request


def test_wait_rechecks_approval_deadline_after_early_wakeup(monkeypatch):
    clock = _Clock()
    service, request = _pending_approval(monkeypatch, clock)
    waits: list[float | None] = []

    def wait(remaining):
        waits.append(remaining)
        clock.now = 0.49 if len(waits) == 1 else 0.5
        return False

    request._event.wait = wait
    result = service.wait_for_response(request.id, timeout=5.0)

    assert result is request
    assert len(waits) == 2
    assert waits[0] == 0.5
    assert abs(waits[1] - 0.01) < 1e-9
    assert request.status == NeedsYouStatus.TIMEOUT
    assert request.response["timeout"] is True
    assert request.responded_by == "system_timeout"


def test_caller_deadline_does_not_become_approval_timeout(monkeypatch):
    clock = _Clock()
    service, request = _pending_approval(monkeypatch, clock)
    waits: list[float | None] = []

    def wait(remaining):
        waits.append(remaining)
        clock.now = 0.25
        return False

    request._event.wait = wait
    result = service.wait_for_response(request.id, timeout=0.25)

    assert result is request
    assert waits == [0.25]
    assert request.status == NeedsYouStatus.PENDING
    assert request.response is None
    assert request.responded_by is None
