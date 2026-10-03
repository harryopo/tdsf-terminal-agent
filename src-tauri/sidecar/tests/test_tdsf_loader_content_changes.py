from __future__ import annotations

from pathlib import Path

import pytest

import tdsf_loader
from tdsf_loader import TDSFContent, TDSFWatcher


def content(global_text: str = "", project_text: str = "", *, g_mtime=1.0, p_mtime=2.0):
    parts = [text.strip() for text in (global_text, project_text) if text.strip()]
    return TDSFContent(
        global_content=global_text,
        project_content=project_text,
        combined_content="\n\n---\n\n".join(parts),
        global_path=Path("global/TDSF.md"),
        project_path=Path("project/TDSF.md"),
        global_mtime=g_mtime,
        project_mtime=p_mtime,
    )


@pytest.mark.parametrize("field", ["global_content", "project_content"])
def test_same_mtime_content_change_notifies_once(monkeypatch, field):
    argument = {"global_content": "global_text", "project_content": "project_text"}[field]
    old = content(**{argument: "old"})
    new = content(**{argument: "new"})
    snapshots = iter((old, new, new))
    monkeypatch.setattr(tdsf_loader, "load_tdsf", lambda *args, **kwargs: next(snapshots))
    seen = []
    watcher = TDSFWatcher(callback=seen.append)

    watcher._check_and_notify()
    watcher._check_and_notify()
    watcher._check_and_notify()

    assert len(seen) == 2
    assert seen[-1] is new
    assert getattr(seen[-1], field) == "new"


def test_unchanged_empty_snapshot_does_not_notify_again(monkeypatch):
    empty = content()
    snapshots = iter((empty, empty))
    monkeypatch.setattr(tdsf_loader, "load_tdsf", lambda *args, **kwargs: next(snapshots))
    seen = []
    watcher = TDSFWatcher(callback=seen.append)

    watcher._check_and_notify()
    watcher._check_and_notify()

    assert seen == [empty]


def test_mtime_change_with_same_content_still_notifies(monkeypatch):
    old = content("same", g_mtime=1.0)
    changed_mtime = content("same", g_mtime=3.0)
    snapshots = iter((old, changed_mtime))
    monkeypatch.setattr(tdsf_loader, "load_tdsf", lambda *args, **kwargs: next(snapshots))
    seen = []
    watcher = TDSFWatcher(callback=seen.append)

    watcher._check_and_notify()
    watcher._check_and_notify()

    assert seen == [old, changed_mtime]
