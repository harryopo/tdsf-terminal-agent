"""
fix_loop.py — Fix-loop 重试计数器（T-P2-12.2 / DEC-V321-11）
==============================================================

spec 要求（DEC-V321-11 Fix-loop max_retry=3）：
1. **同一操作** max_retry=3，超限强制停手
2. 超限后通过 needs-you 通知用户（type=HANDOFF）
3. 重试计数按 (session_id, operation_key) 维度独立跟踪

设计要点：
1. **线程安全**：threading.RLock 保护 _retries 字典
2. **多维跟踪**：session_id × operation_key 二级字典
   - session_id:   会话 ID（隔离不同用户会话）
   - operation_key: 操作标识（task + tool_name 哈希，隔离同一会话不同操作）
3. **可配置 max_retry**：默认 3，可通过 configure_max_retry 动态调整
4. **自动重置**：工具调用成功时重置对应 operation_key 计数
5. **全局单例**：get_global_tracker()，与 NeedsYouService 一致风格
6. **JSON-RPC 接口**：4 个方法（stats / get / reset / is_exhausted）

集成点：
- agents/base.py 的 invoke() 末尾：工具失败 + Agent 决定 continue 时 record_retry
- agents/base.py 的 invoke() 末尾：is_exhausted 时强制 next_step="error" + 通知 needs_you
- agents/base.py 的 invoke() 末尾：工具成功时 reset 对应 operation_key

JSON-RPC 方法（注册到 MethodDispatcher）：
- fix_loop.stats:           获取统计信息（全局或按 session）
- fix_loop.get:             查询指定 (session, op) 的重试次数
- fix_loop.is_exhausted:    检查是否超限
- fix_loop.reset:           重置计数（全局 / session / 单 operation）
- fix_loop.configure:       动态配置 max_retry（管理用）
"""

from __future__ import annotations

import hashlib
import logging
import threading
import time
from typing import Any

logger = logging.getLogger("sidecar.fix_loop")


# ============================================================================
# 常量
# ============================================================================

DEFAULT_MAX_RETRY: int = 3  # spec 要求：max_retry=3
"""默认最大重试次数（spec DEC-V321-11 要求 3 次）"""

NEAR_LIMIT_THRESHOLD: int = 2
"""接近上限的预警阈值（默认 2 次，即第 2 次失败时预警）"""


# ============================================================================
# FixLoopTracker — Fix-loop 重试计数器
# ============================================================================


class FixLoopTracker:
    """Fix-loop 重试计数器（线程安全）

    按 (session_id, operation_key) 二级维度跟踪重试次数。

    用法：
        tracker = get_global_tracker()
        tracker.record_retry("sess-1", "nginx_restart:risk_tool", error="timeout")
        if tracker.is_exhausted("sess-1", "nginx_restart:risk_tool"):
            # 强制停手 + 通知 needs-you
            ...
        else:
            tracker.reset("sess-1", "nginx_restart:risk_tool")  # 成功后重置

    Args:
        max_retry:  最大重试次数（默认 3，spec 要求）
        event_bus:  EventBus 实例（可选，用于发布 fix_loop 事件）
    """

    def __init__(
        self,
        max_retry: int = DEFAULT_MAX_RETRY,
        event_bus: Any | None = None,
    ) -> None:
        self._max_retry: int = max_retry
        self._event_bus: Any | None = event_bus

        # 二级字典：session_id → operation_key → retry_count
        self._retries: dict[str, dict[str, int]] = {}

        # 二级字典：session_id → operation_key → last_error
        self._last_errors: dict[str, dict[str, str]] = {}

        # 二级字典：session_id → operation_key → last_record_at（时间戳）
        self._last_record_at: dict[str, dict[str, float]] = {}

        # 全局统计
        self._stats = {
            "total_records": 0,        # 累计 record_retry 调用次数
            "total_resets": 0,         # 累计 reset 调用次数
            "total_exhausted": 0,      # 累计超限次数
            "total_near_limit": 0,     # 累计接近上限次数
        }

        self._lock = threading.RLock()

        logger.debug(
            f"FixLoopTracker initialized: max_retry={max_retry}, "
            f"has_event_bus={event_bus is not None}"
        )

    # ========================================================================
    # 配置 / 生命周期
    # ========================================================================

    def set_event_bus(self, bus: Any) -> None:
        """注入 EventBus 实例（由 main.py 启动时调用）"""
        self._event_bus = bus
        logger.info("event_bus injected into fix_loop tracker")

    def set_max_retry(self, max_retry: int) -> None:
        """动态调整 max_retry

        Args:
            max_retry: 新的最大重试次数（必须 ≥ 1）

        Raises:
            ValueError: max_retry < 1
        """
        if max_retry < 1:
            raise ValueError(f"max_retry must be >= 1, got {max_retry}")
        with self._lock:
            self._max_retry = max_retry
        logger.info(f"max_retry updated: {max_retry}")

    @property
    def max_retry(self) -> int:
        """获取当前 max_retry 配置"""
        return self._max_retry

    # ========================================================================
    # 核心 API：record_retry / get_retry_count / is_exhausted / reset
    # ========================================================================

    def record_retry(
        self,
        session_id: str,
        operation_key: str,
        error: str = "",
    ) -> int:
        """记录一次重试，返回当前重试次数

        Args:
            session_id:    会话 ID
            operation_key: 操作标识（如 "nginx_restart:risk_tool"）
            error:         本次失败的错误信息（可选）

        Returns:
            当前 (session_id, operation_key) 的累计重试次数
        """
        with self._lock:
            # 初始化二级字典
            if session_id not in self._retries:
                self._retries[session_id] = {}
                self._last_errors[session_id] = {}
                self._last_record_at[session_id] = {}

            # 累加计数
            self._retries[session_id][operation_key] = (
                self._retries[session_id].get(operation_key, 0) + 1
            )
            current_count = self._retries[session_id][operation_key]

            # 记录错误信息和时间戳
            if error:
                self._last_errors[session_id][operation_key] = error
            self._last_record_at[session_id][operation_key] = time.time()

            # 更新全局统计
            self._stats["total_records"] += 1

            # 接近上限预警（第 2 次失败即预警，threshold=2）
            if current_count == NEAR_LIMIT_THRESHOLD:
                self._stats["total_near_limit"] += 1
                logger.warning(
                    f"fix-loop near limit: session={session_id}, "
                    f"op={operation_key}, retries={current_count}/{self._max_retry}"
                )
                self._emit_event(
                    event_name="near_limit",
                    session_id=session_id,
                    operation_key=operation_key,
                    retry_count=current_count,
                    max_retry=self._max_retry,
                    error=error,
                )
            elif current_count >= self._max_retry:
                self._stats["total_exhausted"] += 1
                logger.error(
                    f"fix-loop EXHAUSTED: session={session_id}, "
                    f"op={operation_key}, retries={current_count}/{self._max_retry}"
                )
                self._emit_event(
                    event_name="exhausted",
                    session_id=session_id,
                    operation_key=operation_key,
                    retry_count=current_count,
                    max_retry=self._max_retry,
                    error=error,
                )
            else:
                logger.info(
                    f"fix-loop retry recorded: session={session_id}, "
                    f"op={operation_key}, retries={current_count}/{self._max_retry}"
                )

            return current_count

    def get_retry_count(
        self,
        session_id: str,
        operation_key: str,
    ) -> int:
        """获取当前 (session_id, operation_key) 的重试次数

        Returns:
            重试次数（0 表示无失败记录）
        """
        with self._lock:
            return self._retries.get(session_id, {}).get(operation_key, 0)

    def get_last_error(
        self,
        session_id: str,
        operation_key: str,
    ) -> str:
        """获取上次错误信息"""
        with self._lock:
            return self._last_errors.get(session_id, {}).get(operation_key, "")

    def get_last_record_at(
        self,
        session_id: str,
        operation_key: str,
    ) -> float | None:
        """获取上次记录时间戳"""
        with self._lock:
            return self._last_record_at.get(session_id, {}).get(operation_key)

    def is_exhausted(
        self,
        session_id: str,
        operation_key: str,
    ) -> bool:
        """检查 (session_id, operation_key) 是否已超限

        Returns:
            True if retry_count >= max_retry
        """
        return self.get_retry_count(session_id, operation_key) >= self._max_retry

    def is_near_limit(
        self,
        session_id: str,
        operation_key: str,
        threshold: int = NEAR_LIMIT_THRESHOLD,
    ) -> bool:
        """检查是否接近上限（用于提前预警）

        Args:
            threshold: 预警阈值（默认 2）

        Returns:
            True if retry_count >= threshold
        """
        return self.get_retry_count(session_id, operation_key) >= threshold

    def reset(
        self,
        session_id: str | None = None,
        operation_key: str | None = None,
    ) -> int:
        """重置重试计数

        三种模式：
        1. session_id=None, operation_key=None: 重置所有
        2. session_id=X, operation_key=None:    重置整个 session X
        3. session_id=X, operation_key=Y:       重置特定 (X, Y)

        Args:
            session_id:    会话 ID（None 表示所有 session）
            operation_key: 操作标识（None 表示整个 session）

        Returns:
            重置的 (session, op) 条目数
        """
        with self._lock:
            # 模式 1：重置所有
            if session_id is None:
                count = sum(len(ops) for ops in self._retries.values())
                self._retries.clear()
                self._last_errors.clear()
                self._last_record_at.clear()
                self._stats["total_resets"] += count
                logger.info(f"fix-loop reset all: cleared {count} entries")
                return count

            # 模式 2/3：session 不存在
            if session_id not in self._retries:
                return 0

            # 模式 2：重置整个 session
            if operation_key is None:
                count = len(self._retries[session_id])
                del self._retries[session_id]
                self._last_errors.pop(session_id, None)
                self._last_record_at.pop(session_id, None)
                self._stats["total_resets"] += count
                logger.info(
                    f"fix-loop reset session: session={session_id}, "
                    f"cleared {count} entries"
                )
                return count

            # 模式 3：重置特定 (session, op)
            if operation_key not in self._retries[session_id]:
                return 0

            self._retries[session_id].pop(operation_key, None)
            self._last_errors[session_id].pop(operation_key, None)
            self._last_record_at[session_id].pop(operation_key, None)
            self._stats["total_resets"] += 1
            logger.info(
                f"fix-loop reset op: session={session_id}, op={operation_key}"
            )
            return 1

    # ========================================================================
    # 查询 API
    # ========================================================================

    def get_stats(self, session_id: str | None = None) -> dict[str, Any]:
        """获取统计信息

        Args:
            session_id: 会话 ID（None 表示全局统计）

        Returns:
            统计字典
        """
        with self._lock:
            # 全局统计
            if session_id is None:
                total_ops = sum(len(ops) for ops in self._retries.values())
                exhausted_ops = sum(
                    1
                    for ops in self._retries.values()
                    for count in ops.values()
                    if count >= self._max_retry
                )
                near_limit_ops = sum(
                    1
                    for ops in self._retries.values()
                    for count in ops.values()
                    if NEAR_LIMIT_THRESHOLD <= count < self._max_retry
                )
                return {
                    "max_retry": self._max_retry,
                    "near_limit_threshold": NEAR_LIMIT_THRESHOLD,
                    "total_sessions": len(self._retries),
                    "total_operations": total_ops,
                    "exhausted_operations": exhausted_ops,
                    "near_limit_operations": near_limit_ops,
                    **self._stats,
                }

            # 单 session 统计
            ops = self._retries.get(session_id, {})
            return {
                "max_retry": self._max_retry,
                "near_limit_threshold": NEAR_LIMIT_THRESHOLD,
                "session_id": session_id,
                "operations": dict(ops),
                "last_errors": dict(self._last_errors.get(session_id, {})),
                "last_record_at": dict(self._last_record_at.get(session_id, {})),
                "exhausted_operations": [
                    op for op, count in ops.items() if count >= self._max_retry
                ],
                "near_limit_operations": [
                    op
                    for op, count in ops.items()
                    if NEAR_LIMIT_THRESHOLD <= count < self._max_retry
                ],
            }

    def list_exhausted(self, session_id: str | None = None) -> list[dict[str, Any]]:
        """列出所有已超限的 (session, op) 组合

        Args:
            session_id: 限定会话（None 表示所有）

        Returns:
            [{"session_id": ..., "operation_key": ..., "retry_count": ..., "last_error": ...}]
        """
        with self._lock:
            result: list[dict[str, Any]] = []
            sessions = (
                [session_id] if session_id is not None else list(self._retries.keys())
            )
            for sid in sessions:
                ops = self._retries.get(sid, {})
                errs = self._last_errors.get(sid, {})
                for op, count in ops.items():
                    if count >= self._max_retry:
                        result.append({
                            "session_id": sid,
                            "operation_key": op,
                            "retry_count": count,
                            "last_error": errs.get(op, ""),
                        })
            return result

    # ========================================================================
    # 事件发布
    # ========================================================================

    def _emit_event(
        self,
        event_name: str,
        session_id: str,
        operation_key: str,
        retry_count: int,
        max_retry: int,
        error: str = "",
    ) -> None:
        """发布 fix_loop 事件到 event_bus

        事件 payload：
        {
            "event": "near_limit" | "exhausted",
            "session_id": ...,
            "operation_key": ...,
            "retry_count": ...,
            "max_retry": ...,
            "error": ...,
        }

        事件类型：EventType.FIX_LOOP（如已定义）或 EventType.NEEDS_YOU（兜底）
        """
        if self._event_bus is None:
            return

        payload: dict[str, Any] = {
            "event": event_name,
            "session_id": session_id,
            "operation_key": operation_key,
            "retry_count": retry_count,
            "max_retry": max_retry,
            "error": error,
            "timestamp": time.time(),
        }

        try:
            # 优先使用 FIX_LOOP 事件类型（如已定义）
            from event_bus import Event, EventType

            # 尝试获取 FIX_LOOP 事件类型（向后兼容）
            event_type = getattr(EventType, "FIX_LOOP", None)
            if event_type is None:
                # 兜底：使用 AGENT_MESSAGE（一定存在）
                event_type = EventType.AGENT_MESSAGE

            self._event_bus.publish(Event(
                event_type=event_type.value,
                payload=payload,
                session_id=session_id or None,
                source="fix_loop_tracker",
            ))
        except Exception as e:
            logger.debug(f"fix_loop event publish failed: {e}")


# ============================================================================
# 工具函数
# ============================================================================


def build_operation_key(task: str, tool_name: str = "", params: dict | None = None) -> str:
    """构建 operation_key（操作标识）

    用于唯一标识一个操作，便于按操作维度跟踪重试次数。

    策略：
    1. 若 task + tool_name 都有，直接拼接（可读性好）
    2. 若内容过长（>64 字符），使用 hash 摘要

    Args:
        task:      任务描述（如 "重启 nginx"）
        tool_name: 工具名（如 "risk"）
        params:    工具参数（可选，加入 hash 提高精度）

    Returns:
        operation_key 字符串（如 "restart_nginx:risk" 或 "a1b2c3d4e5f6g7h8"）
    """
    # 标准化：去除空白 + 转小写
    task_clean = (task or "").strip().lower().replace(" ", "_")[:32]
    tool_clean = (tool_name or "").strip().lower()

    # 构建原始 key
    if tool_clean:
        raw_key = f"{task_clean}:{tool_clean}"
    else:
        raw_key = task_clean

    # 加入 params 摘要（如有）
    if params:
        params_str = str(sorted(params.items()))
        params_hash = hashlib.md5(params_str.encode("utf-8")).hexdigest()[:8]
        raw_key = f"{raw_key}:{params_hash}"

    # 若过长，使用 hash 摘要
    if len(raw_key) > 64:
        return hashlib.md5(raw_key.encode("utf-8")).hexdigest()[:16]

    return raw_key or "unknown_op"


# ============================================================================
# 全局实例（单例）
# ============================================================================


_global_tracker: FixLoopTracker | None = None
_global_lock = threading.Lock()


def get_global_tracker() -> FixLoopTracker:
    """获取全局 FixLoopTracker 实例（单例）

    与 needs_you.get_global_service() 风格一致。

    Returns:
        全局 FixLoopTracker 实例
    """
    global _global_tracker
    if _global_tracker is None:
        with _global_lock:
            if _global_tracker is None:
                _global_tracker = FixLoopTracker()
    return _global_tracker


def set_event_bus(bus: Any) -> None:
    """注入 EventBus 到全局 FixLoopTracker（由 main.py 启动时调用）"""
    get_global_tracker().set_event_bus(bus)


def configure_max_retry(max_retry: int) -> None:
    """动态配置 max_retry（由 main.py 启动时调用，或通过 JSON-RPC）

    Args:
        max_retry: 新的最大重试次数（≥1）
    """
    get_global_tracker().set_max_retry(max_retry)


def reset_for_test() -> None:
    """重置全局 tracker（测试用）

    完全重建 tracker，确保测试隔离。
    """
    global _global_tracker
    with _global_lock:
        if _global_tracker is not None:
            _global_tracker.reset()
        # 重建新实例，确保配置和状态完全干净
        _global_tracker = FixLoopTracker()


# ============================================================================
# JSON-RPC 方法注册
# ============================================================================


def register_methods(dispatcher: Any) -> None:
    """将 FixLoopTracker 方法注册到 JSON-RPC MethodDispatcher

    注册的方法：
    - fix_loop.stats:        获取统计信息（全局或按 session）
    - fix_loop.get:          查询指定 (session, op) 的重试次数
    - fix_loop.is_exhausted: 检查是否超限
    - fix_loop.is_near_limit:检查是否接近上限
    - fix_loop.reset:        重置计数
    - fix_loop.list_exhausted: 列出所有已超限的组合
    - fix_loop.configure:    动态配置 max_retry（管理用）
    """
    tracker = get_global_tracker()

    def _stats(session_id: str | None = None) -> dict[str, Any]:
        """获取 fix-loop 统计信息

        Args:
            session_id: 会话 ID（None 表示全局统计）

        Returns:
            统计字典（含 max_retry / total_operations / exhausted_operations 等）
        """
        return tracker.get_stats(session_id)

    def _get(session_id: str, operation_key: str) -> dict[str, Any]:
        """查询指定 (session, op) 的重试详情

        Args:
            session_id:    会话 ID
            operation_key: 操作标识

        Returns:
            {"retry_count": int, "last_error": str, "last_record_at": float,
             "is_exhausted": bool, "is_near_limit": bool, "max_retry": int}
        """
        count = tracker.get_retry_count(session_id, operation_key)
        return {
            "session_id": session_id,
            "operation_key": operation_key,
            "retry_count": count,
            "last_error": tracker.get_last_error(session_id, operation_key),
            "last_record_at": tracker.get_last_record_at(session_id, operation_key),
            "is_exhausted": count >= tracker.max_retry,
            "is_near_limit": count >= NEAR_LIMIT_THRESHOLD,
            "max_retry": tracker.max_retry,
        }

    def _is_exhausted(session_id: str, operation_key: str) -> dict[str, bool]:
        """检查 (session, op) 是否已超限"""
        return {
            "session_id": session_id,
            "operation_key": operation_key,
            "is_exhausted": tracker.is_exhausted(session_id, operation_key),
            "retry_count": tracker.get_retry_count(session_id, operation_key),
            "max_retry": tracker.max_retry,
        }

    def _is_near_limit(
        session_id: str,
        operation_key: str,
        threshold: int = NEAR_LIMIT_THRESHOLD,
    ) -> dict[str, Any]:
        """检查 (session, op) 是否接近上限"""
        return {
            "session_id": session_id,
            "operation_key": operation_key,
            "is_near_limit": tracker.is_near_limit(session_id, operation_key, threshold),
            "retry_count": tracker.get_retry_count(session_id, operation_key),
            "threshold": threshold,
            "max_retry": tracker.max_retry,
        }

    def _reset(
        session_id: str | None = None,
        operation_key: str | None = None,
    ) -> dict[str, Any]:
        """重置重试计数

        三种模式：
        1. 不传参数:           重置所有
        2. 仅传 session_id:    重置整个 session
        3. 同时传 session+op:  重置特定 (session, op)

        Returns:
            {"reset_count": int, "scope": "all" | "session" | "operation"}
        """
        if session_id is None:
            count = tracker.reset()
            scope = "all"
        elif operation_key is None:
            count = tracker.reset(session_id)
            scope = "session"
        else:
            count = tracker.reset(session_id, operation_key)
            scope = "operation"
        return {"reset_count": count, "scope": scope}

    def _list_exhausted(session_id: str | None = None) -> list[dict[str, Any]]:
        """列出所有已超限的 (session, op) 组合"""
        return tracker.list_exhausted(session_id)

    def _configure(max_retry: int) -> dict[str, Any]:
        """动态配置 max_retry（管理用）

        Args:
            max_retry: 新的最大重试次数（≥1）

        Returns:
            {"ok": True, "max_retry": int}
        """
        tracker.set_max_retry(max_retry)
        return {"ok": True, "max_retry": max_retry}

    dispatcher.register("fix_loop.stats", _stats)
    dispatcher.register("fix_loop.get", _get)
    dispatcher.register("fix_loop.is_exhausted", _is_exhausted)
    dispatcher.register("fix_loop.is_near_limit", _is_near_limit)
    dispatcher.register("fix_loop.reset", _reset)
    dispatcher.register("fix_loop.list_exhausted", _list_exhausted)
    dispatcher.register("fix_loop.configure", _configure)

    logger.info(
        "registered 7 fix_loop methods: "
        "stats/get/is_exhausted/is_near_limit/reset/list_exhausted/configure"
    )


# ============================================================================
# 模块导出
# ============================================================================


__all__ = [
    # 常量
    "DEFAULT_MAX_RETRY",
    "NEAR_LIMIT_THRESHOLD",
    # 核心类
    "FixLoopTracker",
    # 工具函数
    "build_operation_key",
    # 全局实例
    "get_global_tracker",
    "set_event_bus",
    "configure_max_retry",
    "reset_for_test",
    # 注册
    "register_methods",
]


# ============================================================================
# 模块自检（python -m fix_loop 可直接验证）
# ============================================================================


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(name)s: %(message)s")

    print("=== fix_loop.py self-test ===\n")

    tracker = FixLoopTracker(max_retry=3)
    print(f"max_retry = {tracker.max_retry}")
    print()

    # 模拟 3 次失败重试
    sid = "test-session-1"
    op = build_operation_key("nginx restart", "risk")
    print(f"operation_key = {op}")

    for i in range(1, 4):
        count = tracker.record_retry(sid, op, error=f"attempt {i} failed")
        exhausted = tracker.is_exhausted(sid, op)
        print(
            f"  retry {i}: count={count}/{tracker.max_retry}, "
            f"exhausted={exhausted}"
        )

    print(f"\nStats: {tracker.get_stats(sid)}")
    print(f"Exhausted list: {tracker.list_exhausted()}")

    # 重置
    reset_count = tracker.reset(sid, op)
    print(f"\nReset ({sid}, {op}): cleared {reset_count}")

    # 全局重置
    reset_all = tracker.reset()
    print(f"Reset all: cleared {reset_all}")

    print("\n=== self-test done ===")
