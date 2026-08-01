"""
strands_backend/evidence.py — 会话证据追踪器（P1-2）
=====================================================

AI 结论的证据 = 会话内真实发生的工具调用记录（不依赖 LLM 输出格式）：
- 每次工具调用（started/completed）记录一条证据：工具名、命令/路径、
  状态、结果摘要、时间
- 前端证据面板展示"本次对话 AI 依据了哪些真实操作"
- 与审计链（audit_chain）的区别：审计链是防篡改落盘日志（安全视角）；
  证据表是会话级内存结构（可观测视角），按 session 隔离、可清空

API：
    tracker = get_global_tracker()
    tracker.record(session_id, {...})
    tracker.list(session_id) -> [evidence, ...]
    tracker.clear(session_id)
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Any

logger = logging.getLogger("sidecar.strands_backend.evidence")

# 每条证据的字段上限（结果摘要截断，防超大输出塞爆内存/前端）
_MAX_RESULT_LEN = 500
_MAX_EVIDENCE_PER_SESSION = 200


class EvidenceTracker:
    """会话级证据追踪器（内存，按 session 隔离）"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._by_session: dict[str, list[dict[str, Any]]] = {}

    def record(
        self,
        session_id: str,
        tool_name: str,
        status: str,
        detail: str = "",
        result: Any = None,
        agent: str = "main",
        source: str = "",
    ) -> dict[str, Any] | None:
        """记录一条工具调用证据

        Args:
            session_id: 会话 ID（空则跳过——无法归属到对话）
            tool_name: 工具名（如 ssh_command / read_remote_file / agent:teach）
            status: started / completed / error / rejected
            detail: 关键参数摘要（命令文本 / 文件路径，已脱敏）
            result: 工具结果（自动截断 + 脱敏）
            agent: 执行 agent 名
            source: 来源标记（调试用）

        Returns:
            证据 dict；session_id 为空返回 None
        """
        if not session_id:
            return None
        evidence = {
            "tool_name": tool_name,
            "status": status,
            "detail": detail[:_MAX_RESULT_LEN],
            "result": _summarize(result),
            "agent": agent,
            "timestamp": time.time(),
            "source": source,
        }
        with self._lock:
            bucket = self._by_session.setdefault(session_id, [])
            bucket.append(evidence)
            # 防单会话无限增长（长对话几十轮工具调用）
            if len(bucket) > _MAX_EVIDENCE_PER_SESSION:
                del bucket[: len(bucket) - _MAX_EVIDENCE_PER_SESSION]
        return evidence

    def list(self, session_id: str) -> list[dict[str, Any]]:
        with self._lock:
            return list(self._by_session.get(session_id, []))

    def clear(self, session_id: str) -> int:
        with self._lock:
            bucket = self._by_session.pop(session_id, [])
            return len(bucket)

    def stats(self) -> dict[str, Any]:
        with self._lock:
            total = sum(len(v) for v in self._by_session.values())
            return {
                "sessions": len(self._by_session),
                "total_evidence": total,
            }


def _summarize(result: Any) -> str:
    """结果摘要：脱敏 + 截断为单行摘要"""
    if result is None:
        return ""
    from strands_backend.tools import redact_sensitive

    try:
        if isinstance(result, dict):
            # 优先取人可读字段
            text = str(
                result.get("output")
                or result.get("message")
                or result.get("content")
                or result.get("result")
                or ""
            )
            if not text:
                text = str(result)[:200]
        elif isinstance(result, (str, bytes)):
            text = str(result)
        else:
            text = str(result)
    except Exception:
        text = str(result)
    text = redact_sensitive(text)
    text = " ".join(text.split())  # 压成单行
    return text[:_MAX_RESULT_LEN]


# ============================================================================
# 全局单例 + RPC 注册
# ============================================================================

_global_tracker: EvidenceTracker | None = None
_global_lock = threading.Lock()


def get_global_tracker() -> EvidenceTracker:
    global _global_tracker
    with _global_lock:
        if _global_tracker is None:
            _global_tracker = EvidenceTracker()
        return _global_tracker


def reset_global_tracker() -> EvidenceTracker:
    global _global_tracker
    with _global_lock:
        _global_tracker = EvidenceTracker()
        return _global_tracker


def register_methods(dispatcher: Any) -> None:
    """注册 JSON-RPC 方法：
    - evidence.list(session_id): 会话证据列表
    - evidence.clear(session_id): 清空会话证据
    - evidence.stats(): 统计
    """
    tracker = get_global_tracker()

    def _list(session_id: str) -> list[dict[str, Any]]:
        return tracker.list(session_id)

    def _clear(session_id: str) -> int:
        return tracker.clear(session_id)

    def _stats() -> dict[str, Any]:
        return tracker.stats()

    dispatcher.register("evidence.list", _list)
    dispatcher.register("evidence.clear", _clear)
    dispatcher.register("evidence.stats", _stats)


__all__ = ["EvidenceTracker", "get_global_tracker", "reset_global_tracker", "register_methods"]
