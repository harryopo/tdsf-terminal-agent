"""
test_event_bus_log_volume.py — 流式事件不许逐条打日志（2026-09-24 实测的日志洪水）

现场：一个 dev 会话的 rust.log 里 7288 行有 7127 行是
`event published: type=agent_message ...`，rust.log 因此 2.5 小时轮转 3 次。
而 rust.log 是我们唯一的现场取证面（#113① 的耗时读数、#120 的轮转上限都靠它）——
取证面自己被刷屏，等于没有取证面。

两条判据成对写：流式类型不许留痕（负向），生命周期类型必须照常留痕（正向）。
只写负向的那一条会有一种假绿：把所有日志都关掉也能通过。
"""
from __future__ import annotations

import logging

from event_bus import Event, EventBus, QUIET_EVENT_TYPES


def _published_records(caplog) -> list[str]:
    return [
        r.getMessage()
        for r in caplog.records
        if "event published" in r.getMessage()
    ]


def test_streaming_event_types_leave_no_per_event_log(caplog):
    bus = EventBus()
    assert "agent_message" in QUIET_EVENT_TYPES, "流式通道必须在这份安静名单里"
    with caplog.at_level(logging.DEBUG, logger="sidecar.event_bus"):
        for _ in range(50):
            bus.publish(Event(event_type="agent_message", payload={"content": "x"}))
    assert _published_records(caplog) == []


def test_lifecycle_events_still_logged(caplog):
    """正向配对：安静名单不许顺手把该看的也关掉 —— 关掉全部日志同样能过上一条。"""
    bus = EventBus()
    with caplog.at_level(logging.DEBUG, logger="sidecar.event_bus"):
        bus.publish(Event(event_type="tool_call", payload={"tool_name": "ssh_command"}))
        bus.publish(Event(event_type="needs_you", payload={}))
    records = _published_records(caplog)
    assert len(records) == 2, f"两条生命周期事件应各留一行，实际 {records}"
    assert any("tool_call" in m for m in records)
    assert any("needs_you" in m for m in records)


def test_quiet_list_is_only_the_streaming_channel():
    """安静名单只能收流式类型：tool_call / loop_progress 是排障要看的那几条。"""
    assert QUIET_EVENT_TYPES == {"agent_message"}
