"""
TDSF Event Bus — 事件总线（T-P1-04）
====================================

职责：
- Python 内部 pub-sub 系统（Agent / Tool / Service 之间解耦通信）
- 通过 JSON-RPC 通知推送到 Rust 侧（Rust 再 emit Tauri event 到前端）
- 订阅过滤器（按 event_type + 按 session_id）
- 历史事件保留（可选，便于新订阅者补发）

设计：
- EventBus 是线程安全的（threading.RLock 保护订阅者列表）
- 支持同步订阅（callback）和异步推送（通过 JSON-RPC notification）
- 订阅返回 unsubscribe 函数（便于清理）
- 事件类型用 enum 定义，避免字符串拼写错误

事件类型（与前端 sidecar-bridge.ts 的 on* 函数对齐）：
- mood_change:    Agent 心情变化（thinking / working / done / error）
- agent_message:  Agent 输出消息（thinking / working / output）
- tool_call:      工具调用事件（开始 / 完成 / 错误）
- needs_you:      needs-you 协调请求（approval / error / question / handoff）
- project_update: 项目状态更新（session 创建 / message 添加等）
- sidecar_event:  Sidecar 内部事件（ready / heartbeat_lost / crashed）

JSON-RPC 方法（注册到 MethodDispatcher）：
- event.list_types:  列出所有事件类型
- event.list_subscribers: 列出当前订阅者
- event.history: 获取历史事件（按 type / session_id 过滤）
"""

from __future__ import annotations

import logging
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Deque

logger = logging.getLogger("sidecar.event_bus")


# ============================================================================
# 事件类型定义
# ============================================================================

class EventType(str, Enum):
    """事件类型枚举（继承 str 便于 JSON 序列化）"""

    MOOD_CHANGE = "mood_change"
    AGENT_MESSAGE = "agent_message"
    TOOL_CALL = "tool_call"
    NEEDS_YOU = "needs_you"
    PROJECT_UPDATE = "project_update"
    SIDECAR_EVENT = "sidecar_event"
    # v2026-07-29: 主 Agent 路由子 Agent 事件
    # main_agent 在 PAOR 循环中路由到子 Agent 时推送，前端 AgentStatusPill 实时显示
    AGENT_SWITCH = "agent_switch"
    # v2026-07-30 P1-a 修复: Mock LLM 告警事件
    # agents/base.py._publish_mock_warning 推送，前端 MockLLMWarning.tsx 实时显示红色 Pill
    # 之前因 EventType 缺失 + base.py 调用 publish 签名错误（传 3 参数而非 Event 对象）
    # 导致事件连 EventBus 都进不去，前端永远不显示告警（三重断裂）
    MOCK_LLM_ACTIVE = "mock_llm_active"
    # T2 循环护栏 (2026-08-31, spec add-agent-loop-closure): 循环进度事件
    # strands_backend/adapter.py ToolCallLimitHook 每次工具调用完成时推送
    # （轮次/工具计数/成功失败），前端 AgentStatusPill 订阅 sidecar:loop_progress
    # 实时显示"第 N 轮 · 已用工具 M"。
    LOOP_PROGRESS = "loop_progress"


# 所有合法的事件类型字符串
VALID_EVENT_TYPES = {e.value for e in EventType}


# ============================================================================
# Event 数据结构
# ============================================================================

@dataclass
class Event:
    """事件对象（不可变，所有字段只读）"""

    event_type: str
    payload: Any
    session_id: str | None = None
    timestamp: float = field(default_factory=time.time)
    source: str | None = None  # 事件来源（如 "main_agent" / "risk_tool"）

    def to_dict(self) -> dict:
        """转为 dict（用于 JSON-RPC 序列化）"""
        return {
            "event_type": self.event_type,
            "payload": self.payload,
            "session_id": self.session_id,
            "timestamp": self.timestamp,
            "source": self.source,
        }


# ============================================================================
# 订阅者类型
# ============================================================================

# 订阅回调函数签名：(Event) -> None
SubscriberCallback = Callable[[Event], None]


@dataclass
class Subscriber:
    """订阅者对象"""

    callback: SubscriberCallback
    event_type: str | None  # None 表示订阅所有类型
    session_id: str | None  # None 表示订阅所有 session
    id: str  # 唯一标识（便于 unsubscribe）
    name: str | None = None  # 订阅者名称（便于调试）


# ============================================================================
# EventBus — 核心
# ============================================================================

class EventBus:
    """事件总线：Python 内部 pub-sub + Rust 侧推送

    设计：
    - 线程安全（threading.RLock 保护订阅者列表 + 历史记录）
    - 支持按 event_type / session_id 过滤订阅
    - publish 同步调用本地订阅者 + 异步推送到 Rust（通过 send_notification）
    - 历史事件保留（默认 1000 条，便于新订阅者补发）

    用法：
        bus = EventBus()
        unsub = bus.subscribe(
            event_type="tool_call",
            callback=lambda e: print(f"tool call: {e.payload}"),
            session_id="sess-123",
        )
        bus.publish(Event(
            event_type="tool_call",
            payload={"tool": "risk", "params": {...}},
            session_id="sess-123",
            source="main_agent",
        ))
        unsub()  # 取消订阅
    """

    def __init__(
        self,
        history_limit: int = 1000,
        rust_notifier: Callable[[str, Any], None] | None = None,
    ):
        self._subscribers: list[Subscriber] = []
        self._lock = threading.RLock()
        self._history: Deque[Event] = deque(maxlen=history_limit)
        self._history_limit = history_limit
        self._rust_notifier = rust_notifier  # 推送到 Rust 的函数（main.send_notification）
        self._next_sub_id = 0

        # 统计信息
        self._stats = {
            "total_published": 0,
            "total_delivered": 0,
            "by_type": {t: 0 for t in VALID_EVENT_TYPES},
        }

    # ========================================================================
    # 订阅 / 取消订阅
    # ========================================================================

    def subscribe(
        self,
        callback: SubscriberCallback,
        event_type: str | None = None,
        session_id: str | None = None,
        name: str | None = None,
    ) -> Callable[[], None]:
        """订阅事件

        Args:
            callback: 事件回调函数 (Event) -> None
            event_type: 事件类型过滤（None 表示订阅所有类型）
            session_id: 会话 ID 过滤（None 表示订阅所有 session）
            name: 订阅者名称（便于调试）

        Returns:
            unsubscribe 函数，调用后取消订阅

        Raises:
            ValueError: event_type 不在 VALID_EVENT_TYPES 中
        """
        if event_type is not None and event_type not in VALID_EVENT_TYPES:
            raise ValueError(
                f"invalid event_type: {event_type}, "
                f"must be one of {VALID_EVENT_TYPES}"
            )

        with self._lock:
            self._next_sub_id += 1
            sub_id = f"sub-{self._next_sub_id}"
            subscriber = Subscriber(
                callback=callback,
                event_type=event_type,
                session_id=session_id,
                id=sub_id,
                name=name,
            )
            self._subscribers.append(subscriber)
            logger.debug(
                f"subscriber added: id={sub_id}, name={name}, "
                f"type={event_type}, session={session_id}"
            )

        def unsubscribe() -> None:
            with self._lock:
                self._subscribers = [
                    s for s in self._subscribers if s.id != sub_id
                ]
                logger.debug(f"subscriber removed: id={sub_id}")

        return unsubscribe

    def unsubscribe_all(self) -> None:
        """清除所有订阅者（用于测试或关闭）"""
        with self._lock:
            count = len(self._subscribers)
            self._subscribers.clear()
            logger.info(f"cleared {count} subscribers")

    # ========================================================================
    # 发布事件
    # ========================================================================

    def publish(self, event: Event) -> int:
        """发布事件

        流程:
          1. 记录到历史
          2. 调用所有匹配的本地订阅者
          3. 推送到 Rust 侧（通过 _rust_notifier）

        Args:
            event: 事件对象

        Returns:
            交付给本地订阅者的数量
        """
        # 校验 event_type
        if event.event_type not in VALID_EVENT_TYPES:
            logger.warning(f"unknown event_type: {event.event_type}, skipping")
            return 0

        # 找到匹配的订阅者（snapshot，避免回调中修改列表）
        with self._lock:
            self._history.append(event)
            self._stats["total_published"] += 1
            self._stats["by_type"][event.event_type] = (
                self._stats["by_type"].get(event.event_type, 0) + 1
            )
            matched = [
                s
                for s in self._subscribers
                if self._matches(s, event)
            ]

        # 调用订阅者（不持有 lock，避免回调中再次 subscribe 死锁）
        delivered = 0
        for subscriber in matched:
            try:
                subscriber.callback(event)
                delivered += 1
            except Exception as e:
                logger.exception(
                    f"subscriber callback error: id={subscriber.id}, "
                    f"name={subscriber.name}, error={e}"
                )

        with self._lock:
            self._stats["total_delivered"] += delivered

        # 推送到 Rust 侧（通过 send_notification）
        if self._rust_notifier is not None:
            try:
                self._rust_notifier(event.event_type, event.to_dict())
            except Exception as e:
                logger.exception(f"rust notifier error: {e}")

        logger.debug(
            f"event published: type={event.event_type}, "
            f"session={event.session_id}, delivered={delivered}, "
            f"source={event.source}"
        )
        return delivered

    def _matches(self, subscriber: Subscriber, event: Event) -> bool:
        """检查订阅者是否匹配事件"""
        # 事件类型过滤
        if subscriber.event_type is not None and subscriber.event_type != event.event_type:
            return False
        # session_id 过滤
        if subscriber.session_id is not None and subscriber.session_id != event.session_id:
            return False
        return True

    # ========================================================================
    # 查询
    # ========================================================================

    def list_subscribers(self) -> list[dict]:
        """列出所有订阅者（用于调试）"""
        with self._lock:
            return [
                {
                    "id": s.id,
                    "name": s.name,
                    "event_type": s.event_type,
                    "session_id": s.session_id,
                }
                for s in self._subscribers
            ]

    def list_event_types(self) -> list[str]:
        """列出所有合法的事件类型"""
        return sorted(VALID_EVENT_TYPES)

    def get_history(
        self,
        event_type: str | None = None,
        session_id: str | None = None,
        limit: int = 100,
    ) -> list[dict]:
        """获取历史事件

        Args:
            event_type: 按类型过滤
            session_id: 按会话过滤
            limit: 最多返回数量（倒序，最近的事件在前）
        """
        with self._lock:
            events = list(self._history)

        # 过滤
        if event_type is not None:
            events = [e for e in events if e.event_type == event_type]
        if session_id is not None:
            events = [e for e in events if e.session_id == session_id]

        # 倒序，最近在前
        events.reverse()
        return [e.to_dict() for e in events[:limit]]

    def get_stats(self) -> dict:
        """获取统计信息"""
        with self._lock:
            return {
                **self._stats,
                "subscriber_count": len(self._subscribers),
                "history_count": len(self._history),
                "history_limit": self._history_limit,
            }

    # ========================================================================
    # 便捷发布方法
    # ========================================================================

    def emit_mood_change(
        self,
        mood: str,
        session_id: str | None = None,
        source: str | None = None,
        **extra: Any,
    ) -> int:
        """发布 mood_change 事件

        Args:
            mood: 心情状态（thinking / working / done / error）
            session_id: 会话 ID
            source: 来源（如 "main_agent"）
            **extra: 附加数据
        """
        payload = {"mood": mood, **extra}
        return self.publish(
            Event(
                event_type=EventType.MOOD_CHANGE.value,
                payload=payload,
                session_id=session_id,
                source=source,
            )
        )

    def emit_agent_message(
        self,
        content: str,
        message_type: str = "output",
        session_id: str | None = None,
        source: str | None = None,
    ) -> int:
        """发布 agent_message 事件

        Args:
            content: 消息内容
            message_type: 消息类型（thinking / working / output）
            session_id: 会话 ID
            source: 来源 Agent

        TDSF 修复 2026-07-31 (P4): payload 字段名从 ``message_type`` 改为 ``type``，
        与 ``agents/base.py::_emit_message`` 和前端 ``sidecar-adapter.ts`` 期望对齐。

        之前字段名不一致导致：
        - Strands 后端通过 ``emit_agent_message`` 推送的消息全部被前端误判为 output
        - 深度思考 UI（thinking）无法显示
        - LLM 文本流式输出全部走 output 通道（虽然能显示，但语义错乱）

        base.py 的 ``_emit_message`` 直接 ``publish(Event(...))`` 用 ``"type"`` 字段，
        本方法与之对齐，确保两条路径（LangGraph + Strands）的 payload 结构一致。
        """
        payload = {"content": content, "type": message_type}
        return self.publish(
            Event(
                event_type=EventType.AGENT_MESSAGE.value,
                payload=payload,
                session_id=session_id,
                source=source,
            )
        )

    def emit_tool_call(
        self,
        tool_name: str,
        params: dict | None = None,
        result: Any | None = None,
        status: str = "started",
        session_id: str | None = None,
        source: str | None = None,
    ) -> int:
        """发布 tool_call 事件

        Args:
            tool_name: 工具名称
            params: 工具参数
            result: 工具结果（status=completed 时）
            status: 状态（started / completed / error）
            session_id: 会话 ID
            source: 调用来源
        """
        payload = {
            "tool_name": tool_name,
            "params": params or {},
            "status": status,
        }
        if result is not None:
            payload["result"] = result
        return self.publish(
            Event(
                event_type=EventType.TOOL_CALL.value,
                payload=payload,
                session_id=session_id,
                source=source,
            )
        )

    def emit_loop_progress(
        self,
        round: int,
        tool_count: int,
        tool_name: str,
        status: str,
        session_id: str | None = None,
        source: str | None = None,
    ) -> int:
        """发布 loop_progress 事件（T2 循环护栏，2026-08-31）

        Args:
            round: 当前 LLM 推理轮次（第 N 轮，BeforeModelCallEvent 计数）
            tool_count: 本次 invoke 已用工具调用总数（含本次）
            tool_name: 本次调用的工具名
            status: 本次调用结果（success / failed / breaker）
            session_id: 会话 ID
            source: 来源（如 "main_agent.strands.hook"）

        前端 AgentStatusPill 订阅 sidecar:loop_progress 显示
        "第 N 轮 · 已用工具 M"；status=breaker 表示熔断（含解释文案）。
        """
        payload = {
            "round": round,
            "tool_count": tool_count,
            "tool_name": tool_name,
            "status": status,
        }
        return self.publish(
            Event(
                event_type=EventType.LOOP_PROGRESS.value,
                payload=payload,
                session_id=session_id,
                source=source,
            )
        )

    def emit_needs_you(
        self,
        needs_type: str,
        title: str,
        description: str,
        session_id: str | None = None,
        source: str | None = None,
        priority: str = "normal",
        **extra: Any,
    ) -> int:
        """发布 needs_you 事件

        Args:
            needs_type: 类型（approval / error / question / handoff）
            title: 标题
            description: 描述
            session_id: 会话 ID
            source: 来源
            priority: 优先级（high / normal / low）
        """
        payload = {
            "needs_type": needs_type,
            "title": title,
            "description": description,
            "priority": priority,
            **extra,
        }
        return self.publish(
            Event(
                event_type=EventType.NEEDS_YOU.value,
                payload=payload,
                session_id=session_id,
                source=source,
            )
        )

    def emit_agent_switch(
        self,
        agent: str,
        task: str | None = None,
        session_id: str | None = None,
        source: str | None = None,
    ) -> int:
        """发布 agent_switch 事件（v2026-07-29 新增）

        主 Agent 在 PAOR 循环中路由到子 Agent 时推送。
        前端 AgentStatusPill 订阅此事件，实时显示当前路由到的子 Agent。

        Args:
            agent: 目标子 Agent 名称（coding / explore / history / teach /
                   debug / refactor / test / deploy / main）
            task: 当前子任务描述（可选，用于 step 提示）
            session_id: 会话 ID
            source: 来源（通常是 'main_agent'）
        """
        payload = {"agent": agent}
        if task is not None:
            payload["task"] = task
        return self.publish(
            Event(
                event_type=EventType.AGENT_SWITCH.value,
                payload=payload,
                session_id=session_id,
                source=source,
            )
        )

    def emit_mock_warning(
        self,
        agent: str,
        reason: str,
        detail: str,
        session_id: str | None = None,
        source: str | None = None,
    ) -> int:
        """发布 mock_llm_active 事件（v2026-07-30 P1-a 修复新增）

        当 BaseAgent 未注入 llm_call 或 llm_call 抛异常降级到 mock 时，
        通过此方法推送告警事件，前端 MockLLMWarning.tsx 实时显示红色 Pill。

        之前因 base.py 直接调用 publish("mock_llm_active", dict, source=...) 传 3 参数，
        而 publish 签名只接受单个 Event 对象，TypeError 被静默吞掉，
        导致 mock LLM 告警事件连 EventBus 都进不去（三重断裂的第一重）。

        Args:
            agent: Agent 名称（如 "main" / "coding"）
            reason: 告警原因（"no_llm_config" / "llm_call_failed"）
            detail: 详细描述（截断到 200 字符）
            session_id: 会话 ID
            source: 来源（通常是 "{agent}_agent"）
        """
        payload = {
            "agent": agent,
            "reason": reason,
            "detail": detail[:200],
            "timestamp": time.time(),
        }
        return self.publish(
            Event(
                event_type=EventType.MOCK_LLM_ACTIVE.value,
                payload=payload,
                session_id=session_id,
                source=source,
            )
        )


# ============================================================================
# 全局实例（单例，由 main.py 注册到 MethodDispatcher）
# ============================================================================

_global_bus: EventBus | None = None


def get_global_bus() -> EventBus:
    """获取全局 EventBus 实例（单例）"""
    global _global_bus
    if _global_bus is None:
        _global_bus = EventBus()
    return _global_bus


def set_rust_notifier(notifier: Callable[[str, Any], None]) -> None:
    """设置 Rust 通知器（由 main.py 在启动时注入）

    Args:
        notifier: 函数签名 (event_type: str, payload: dict) -> None
                  内部调用 main.send_notification(event_type, payload)
    """
    bus = get_global_bus()
    bus._rust_notifier = notifier
    logger.info("rust notifier set")


# ============================================================================
# JSON-RPC 方法注册（注入到 MethodDispatcher）
# ============================================================================

def register_methods(dispatcher: Any) -> None:
    """将 EventBus 方法注册到 JSON-RPC MethodDispatcher

    注册的方法：
    - event.list_types: 列出所有事件类型
    - event.list_subscribers: 列出当前订阅者
    - event.history: 获取历史事件
    - event.stats: 获取统计信息
    """
    bus = get_global_bus()

    dispatcher.register("event.list_types", lambda: bus.list_event_types())
    dispatcher.register("event.list_subscribers", lambda: bus.list_subscribers())
    dispatcher.register(
        "event.history",
        lambda **kw: bus.get_history(**kw),
    )
    dispatcher.register("event.stats", lambda: bus.get_stats())

    logger.info(
        "registered 4 event_bus methods: "
        "event.list_types/list_subscribers/history/stats"
    )
