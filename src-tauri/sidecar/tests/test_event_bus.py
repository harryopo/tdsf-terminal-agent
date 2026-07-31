"""
test_event_bus.py — EventBus 单元测试（T-P1-04）

覆盖：
- 订阅 / 取消订阅 / publish
- 事件类型过滤
- session_id 过滤
- 历史事件
- Rust notifier 推送
- 便捷发布方法（emit_mood_change / emit_agent_message 等）
- 线程安全
"""
from __future__ import annotations

import threading
import time

import pytest

from event_bus import (
    Event,
    EventBus,
    EventType,
    VALID_EVENT_TYPES,
)


# ============================================================================
# Fixtures
# ============================================================================

@pytest.fixture
def bus() -> EventBus:
    """新 EventBus 实例（每个测试独立）"""
    return EventBus(history_limit=100)


# ============================================================================
# 基础订阅 / 发布测试
# ============================================================================

class TestSubscribePublish:
    def test_subscribe_and_publish(self, bus: EventBus) -> None:
        received: list[Event] = []
        unsub = bus.subscribe(callback=lambda e: received.append(e))
        bus.publish(
            Event(
                event_type=EventType.MOOD_CHANGE.value,
                payload={"mood": "thinking"},
            )
        )
        assert len(received) == 1
        assert received[0].event_type == "mood_change"
        assert received[0].payload == {"mood": "thinking"}
        unsub()

    def test_unsubscribe(self, bus: EventBus) -> None:
        received: list[Event] = []
        unsub = bus.subscribe(callback=lambda e: received.append(e))
        bus.publish(
            Event(event_type=EventType.MOOD_CHANGE.value, payload={})
        )
        unsub()
        bus.publish(
            Event(event_type=EventType.MOOD_CHANGE.value, payload={})
        )
        assert len(received) == 1

    def test_subscribe_all_types(self, bus: EventBus) -> None:
        """event_type=None 订阅所有类型"""
        received: list[Event] = []
        bus.subscribe(callback=lambda e: received.append(e))

        for et in EventType:
            bus.publish(Event(event_type=et.value, payload={}))

        assert len(received) == len(EventType)

    def test_subscribe_invalid_event_type(self, bus: EventBus) -> None:
        with pytest.raises(ValueError, match="invalid event_type"):
            bus.subscribe(callback=lambda e: None, event_type="invalid_type")


# ============================================================================
# 过滤器测试
# ============================================================================

class TestFilters:
    def test_filter_by_event_type(self, bus: EventBus) -> None:
        mood_events: list[Event] = []
        tool_events: list[Event] = []

        bus.subscribe(
            callback=lambda e: mood_events.append(e),
            event_type="mood_change",
        )
        bus.subscribe(
            callback=lambda e: tool_events.append(e),
            event_type="tool_call",
        )

        bus.publish(Event(event_type="mood_change", payload={}))
        bus.publish(Event(event_type="tool_call", payload={}))
        bus.publish(Event(event_type="agent_message", payload={}))

        assert len(mood_events) == 1
        assert len(tool_events) == 1

    def test_filter_by_session_id(self, bus: EventBus) -> None:
        sess_a: list[Event] = []
        sess_b: list[Event] = []

        bus.subscribe(callback=lambda e: sess_a.append(e), session_id="sess-a")
        bus.subscribe(callback=lambda e: sess_b.append(e), session_id="sess-b")

        bus.publish(Event(event_type="mood_change", payload={}, session_id="sess-a"))
        bus.publish(Event(event_type="mood_change", payload={}, session_id="sess-b"))
        bus.publish(Event(event_type="mood_change", payload={}, session_id="sess-c"))

        assert len(sess_a) == 1
        assert len(sess_b) == 1

    def test_filter_combined_type_and_session(self, bus: EventBus) -> None:
        received: list[Event] = []
        bus.subscribe(
            callback=lambda e: received.append(e),
            event_type="tool_call",
            session_id="sess-a",
        )

        # 匹配
        bus.publish(
            Event(event_type="tool_call", payload={}, session_id="sess-a")
        )
        # 类型不匹配
        bus.publish(
            Event(event_type="mood_change", payload={}, session_id="sess-a")
        )
        # session 不匹配
        bus.publish(
            Event(event_type="tool_call", payload={}, session_id="sess-b")
        )

        assert len(received) == 1


# ============================================================================
# 历史事件测试
# ============================================================================

class TestHistory:
    def test_history_records_all_events(self, bus: EventBus) -> None:
        for i in range(5):
            bus.publish(
                Event(event_type="mood_change", payload={"i": i})
            )
        history = bus.get_history()
        assert len(history) == 5

    def test_history_limit(self) -> None:
        bus = EventBus(history_limit=3)
        for i in range(5):
            bus.publish(Event(event_type="mood_change", payload={"i": i}))
        history = bus.get_history()
        # 只保留最近 3 条
        assert len(history) == 3
        # 倒序，最近在前
        assert history[0]["payload"]["i"] == 4

    def test_history_filter_by_type(self, bus: EventBus) -> None:
        bus.publish(Event(event_type="mood_change", payload={}))
        bus.publish(Event(event_type="tool_call", payload={}))
        bus.publish(Event(event_type="mood_change", payload={}))

        mood_history = bus.get_history(event_type="mood_change")
        tool_history = bus.get_history(event_type="tool_call")

        assert len(mood_history) == 2
        assert len(tool_history) == 1

    def test_history_filter_by_session(self, bus: EventBus) -> None:
        bus.publish(Event(event_type="mood_change", payload={}, session_id="a"))
        bus.publish(Event(event_type="mood_change", payload={}, session_id="b"))
        bus.publish(Event(event_type="mood_change", payload={}, session_id="a"))

        a_history = bus.get_history(session_id="a")
        assert len(a_history) == 2


# ============================================================================
# Rust 推送测试
# ============================================================================

class TestRustNotifier:
    def test_rust_notifier_called(self) -> None:
        pushed: list[tuple[str, dict]] = []

        def notifier(event_type: str, payload: dict) -> None:
            pushed.append((event_type, payload))

        bus = EventBus(rust_notifier=notifier)
        bus.publish(
            Event(event_type="mood_change", payload={"mood": "done"})
        )

        assert len(pushed) == 1
        assert pushed[0][0] == "mood_change"
        assert pushed[0][1]["payload"] == {"mood": "done"}
        assert pushed[0][1]["event_type"] == "mood_change"

    def test_rust_notifier_error_does_not_break_publish(self) -> None:
        def bad_notifier(event_type: str, payload: dict) -> None:
            raise RuntimeError("notifier crashed")

        bus = EventBus(rust_notifier=bad_notifier)
        received: list[Event] = []
        bus.subscribe(callback=lambda e: received.append(e))

        # 不应抛异常
        bus.publish(Event(event_type="mood_change", payload={}))

        # 本地订阅者仍应收到
        assert len(received) == 1


# ============================================================================
# 便捷发布方法测试
# ============================================================================

class TestEmitHelpers:
    def test_emit_mood_change(self, bus: EventBus) -> None:
        received: list[Event] = []
        bus.subscribe(
            callback=lambda e: received.append(e),
            event_type="mood_change",
        )
        bus.emit_mood_change(mood="working", session_id="s1", source="agent")
        assert len(received) == 1
        assert received[0].payload == {"mood": "working"}
        assert received[0].session_id == "s1"
        assert received[0].source == "agent"

    def test_emit_agent_message(self, bus: EventBus) -> None:
        received: list[Event] = []
        bus.subscribe(
            callback=lambda e: received.append(e),
            event_type="agent_message",
        )
        bus.emit_agent_message(
            content="hello", message_type="thinking", source="main_agent"
        )
        # TDSF 修复 2026-07-31 (P4): payload 字段名从 message_type 改为 type，
        # 与 agents/base.py::_emit_message 和前端 sidecar-adapter.ts 期望对齐
        assert received[0].payload == {
            "content": "hello",
            "type": "thinking",
        }

    def test_emit_tool_call_started(self, bus: EventBus) -> None:
        received: list[Event] = []
        bus.subscribe(
            callback=lambda e: received.append(e),
            event_type="tool_call",
        )
        bus.emit_tool_call(
            tool_name="risk",
            params={"command": "ls"},
            status="started",
        )
        assert received[0].payload["tool_name"] == "risk"
        assert received[0].payload["status"] == "started"
        assert "result" not in received[0].payload

    def test_emit_tool_call_completed_with_result(self, bus: EventBus) -> None:
        received: list[Event] = []
        bus.subscribe(
            callback=lambda e: received.append(e),
            event_type="tool_call",
        )
        bus.emit_tool_call(
            tool_name="risk",
            result={"level": "L3"},
            status="completed",
        )
        assert received[0].payload["result"] == {"level": "L3"}

    def test_emit_needs_you(self, bus: EventBus) -> None:
        received: list[Event] = []
        bus.subscribe(
            callback=lambda e: received.append(e),
            event_type="needs_you",
        )
        bus.emit_needs_you(
            needs_type="approval",
            title="sudo command",
            description="nginx restart",
            priority="high",
        )
        assert received[0].payload["needs_type"] == "approval"
        assert received[0].payload["priority"] == "high"


# ============================================================================
# 线程安全测试
# ============================================================================

class TestThreadSafety:
    def test_concurrent_publish(self, bus: EventBus) -> None:
        """多线程并发 publish 不应丢事件"""
        received: list[Event] = []
        lock = threading.Lock()

        def callback(e: Event) -> None:
            with lock:
                received.append(e)

        bus.subscribe(callback=callback)

        def worker(thread_id: int) -> None:
            for i in range(20):
                bus.publish(
                    Event(
                        event_type="mood_change",
                        payload={"thread": thread_id, "i": i},
                    )
                )

        threads = [threading.Thread(target=worker, args=(t,)) for t in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        # 5 线程 × 20 事件 = 100
        assert len(received) == 100

    def test_concurrent_subscribe_unsubscribe(self, bus: EventBus) -> None:
        """并发订阅/取消订阅不应崩溃"""

        def subscriber(thread_id: int) -> None:
            for i in range(20):
                unsub = bus.subscribe(callback=lambda e: None)
                if i % 2 == 0:
                    unsub()

        threads = [threading.Thread(target=subscriber, args=(t,)) for t in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        # 不崩溃即通过
        assert True


# ============================================================================
# 统计信息测试
# ============================================================================

class TestStats:
    def test_stats_after_publish(self, bus: EventBus) -> None:
        bus.subscribe(callback=lambda e: None, event_type="mood_change")
        bus.publish(Event(event_type="mood_change", payload={}))
        bus.publish(Event(event_type="tool_call", payload={}))

        stats = bus.get_stats()
        assert stats["total_published"] == 2
        assert stats["total_delivered"] == 1  # 只有 mood_change 有订阅者
        assert stats["by_type"]["mood_change"] == 1
        assert stats["by_type"]["tool_call"] == 1
        assert stats["subscriber_count"] == 1
        assert stats["history_count"] == 2

    def test_stats_invalid_event_not_counted(self, bus: EventBus) -> None:
        bus.publish(Event(event_type="invalid_type", payload={}))
        stats = bus.get_stats()
        assert stats["total_published"] == 0


# ============================================================================
# 查询方法测试
# ============================================================================

class TestQueries:
    def test_list_subscribers(self, bus: EventBus) -> None:
        bus.subscribe(callback=lambda e: None, event_type="mood_change", name="A")
        bus.subscribe(callback=lambda e: None, session_id="s1", name="B")
        subs = bus.list_subscribers()
        assert len(subs) == 2
        names = {s["name"] for s in subs}
        assert names == {"A", "B"}

    def test_list_event_types(self, bus: EventBus) -> None:
        types = bus.list_event_types()
        assert "mood_change" in types
        assert "tool_call" in types
        assert "needs_you" in types
        assert "agent_message" in types
        assert len(types) == len(EventType)

    def test_unsubscribe_all(self, bus: EventBus) -> None:
        bus.subscribe(callback=lambda e: None)
        bus.subscribe(callback=lambda e: None)
        assert len(bus.list_subscribers()) == 2
        bus.unsubscribe_all()
        assert len(bus.list_subscribers()) == 0
