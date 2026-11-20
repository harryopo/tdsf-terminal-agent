"""
strands_backend/evidence.py — 会话证据追踪器（P1-2）
=====================================================

会话证据 = 真实工具调用记录，不等于模型结论已验证：
- 保存工具名、命令/路径、状态、有界摘要，以及可用的调用/目标标识
- 缺失标识不补造；SDK 调用标识与工具卡标识分别保存
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
import uuid
from typing import Any

logger = logging.getLogger("sidecar.strands_backend.evidence")

# 每条证据的字段上限（结果摘要截断，防超大输出塞爆内存/前端）
_MAX_RESULT_LEN = 500
_MAX_EVIDENCE_PER_SESSION = 200

# 只有能返回外部事实的成功工具结果才可作为会话依据。计划、待办和命令
# 生成仅是模型输出的另一种形式，不能因为走过工具接口就被当作来源。
_SOURCE_TOOL_NAMES = frozenset({
    "knowledge_search",
    "knowledge_get_doc",
    "read_remote_file",
    "analyze_logs",
    "inspect_processes",
    "network_diagnose",
    "get_terminal_output",
    "config_diff",
    "ssh_command",
})


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
        *,
        tool_call_id: str | None = None,
        sdk_tool_use_id: str | None = None,
        ssh_session_id: str | None = None,
        target_endpoint: str | None = None,
        operation_id: str | None = None,
    ) -> dict[str, Any] | None:
        """记录一条工具调用证据

        Args:
            session_id: 会话 ID（空则跳过——无法归属到对话）
            tool_name: 工具名（如 ssh_command / read_remote_file / agent:teach）
            status: completed / error / blocked / rejected / cancelled / indeterminate
            detail: 关键参数摘要（命令文本 / 文件路径，入口脱敏）
            result: 工具结果（自动截断 + 脱敏）
            agent: 执行 agent 名
            source: 来源标记（调试用）
            tool_call_id: 实际工具卡标识；未知时省略，不按工具名猜配
            sdk_tool_use_id: SDK 调用标识，不能冒充工具卡标识
            ssh_session_id: 执行器解析出的目标 SSH 会话
            target_endpoint: 已取得的目标端点，不回退到当前活动主机
            operation_id: 已有操作账本标识

        Returns:
            证据 dict；session_id 为空返回 None
        """
        if not session_id:
            return None
        redacted_detail = _redact_text(detail)
        summary, summary_truncated = _summarize(result)
        evidence = {
            "evidence_id": str(uuid.uuid4()),
            "tool_name": tool_name,
            "status": status,
            "detail": redacted_detail[:_MAX_RESULT_LEN],
            "detail_truncated": len(redacted_detail) > _MAX_RESULT_LEN,
            "result": summary,
            "summary_truncated": summary_truncated,
            "agent": agent,
            "timestamp": time.time(),
            "source": source,
        }
        for key, value in (
            ("tool_call_id", tool_call_id),
            ("sdk_tool_use_id", sdk_tool_use_id),
            ("ssh_session_id", ssh_session_id),
            ("target_endpoint", target_endpoint),
            ("operation_id", operation_id),
        ):
            # 不截断或替换身份：这会把不同调用/目标变成同一个标识。
            if isinstance(value, str) and value.strip() and len(value) <= _MAX_RESULT_LEN:
                if _redact_text(value) == value:
                    evidence[key] = value
        if isinstance(result, dict):
            outcome = result.get("status")
            if isinstance(outcome, str):
                evidence["result_status"] = _redact_text(outcome)[:_MAX_RESULT_LEN]
            for key, field in (("result_ok", "ok"), ("result_available", "available")):
                if isinstance(result.get(field), bool):
                    evidence[key] = result[field]
            if result.get("success") is False:
                evidence["result_ok"] = False
            if isinstance(result.get("truncated"), bool):
                evidence["output_truncated"] = result["truncated"]
            exit_code = result.get("exit_code")
            if isinstance(exit_code, int) and not isinstance(exit_code, bool) and exit_code >= 0:
                evidence["exit_code"] = exit_code
        with self._lock:
            bucket = self._by_session.setdefault(session_id, [])
            bucket.append(evidence)
            # 防单会话无限增长（长对话几十轮工具调用）
            if len(bucket) > _MAX_EVIDENCE_PER_SESSION:
                del bucket[: len(bucket) - _MAX_EVIDENCE_PER_SESSION]
        return dict(evidence)

    def list(self, session_id: str) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(item) for item in self._by_session.get(session_id, [])]

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


def _redact_text(text: str) -> str:
    from strands_backend.tools import redact_sensitive
    from strands_backend.tools._redact import redact_sensitive_text

    return redact_sensitive_text(redact_sensitive(text))


def _summarize(result: Any) -> tuple[str, bool]:
    """返回脱敏单行摘要及本地长度裁剪标记；摘要不代表完整输出。"""
    if result is None:
        return "", False
    truncated = False
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
                text = str(result)
                truncated = len(text) > 200
                text = text[:200]
        elif isinstance(result, (str, bytes)):
            text = str(result)
        else:
            text = str(result)
    except Exception:
        text = str(result)
    text = _redact_text(text)
    text = " ".join(text.split())  # 压成单行
    return text[:_MAX_RESULT_LEN], truncated or len(text) > _MAX_RESULT_LEN


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


def assess_session_evidence(session_id: str) -> dict[str, Any]:
    """Summarize recorded tool evidence without scoring model prose.

    This is deliberately a *session evidence state*, not a probability that an
    arbitrary assistant sentence is true.  There is no response-to-citation
    binding or explicit verification conditions in the current protocol.
    A later read, even of the same target, cannot promote a session to verified.
    """
    completed = [
        item
        for item in get_global_tracker().list(session_id)
        if item.get("status") == "completed"
        and item.get("result_status") in (None, "success")
        and item.get("result_ok") is not False
        and item.get("result_available") is not False
    ]
    sources = [
        {
            "tool_name": str(item.get("tool_name") or ""),
            "source": str(item.get("source") or ""),
            "timestamp": item.get("timestamp"),
        }
        for item in completed
        if str(item.get("tool_name") or "") in _SOURCE_TOOL_NAMES
    ]

    if sources:
        tier = "grounded"
        reason = f"已记录 {len(sources)} 项可用工具结果；未绑定具体结论或验证条件。"
    else:
        tier = "unverified"
        reason = "本会话未记录可用的已完成检索或读取结果。"

    return {
        "tier": tier,
        "reason": reason,
        "evidence_count": len(sources),
        "sources": sources[:3],
        "scope": "session",
    }


def register_methods(dispatcher: Any) -> None:
    """注册 JSON-RPC 方法：
    - evidence.list(session_id): 会话证据列表
    - evidence.clear(session_id): 清空会话证据
    - evidence.stats(): 统计
    - evidence.assess(session_id): 基于真实完成事件的会话证据状态
    """
    tracker = get_global_tracker()

    def _list(session_id: str) -> list[dict[str, Any]]:
        return tracker.list(session_id)

    def _clear(session_id: str) -> int:
        return tracker.clear(session_id)

    def _stats() -> dict[str, Any]:
        return tracker.stats()

    def _assess(session_id: str) -> dict[str, Any]:
        return assess_session_evidence(session_id)

    dispatcher.register("evidence.list", _list)
    dispatcher.register("evidence.clear", _clear)
    dispatcher.register("evidence.stats", _stats)
    dispatcher.register("evidence.assess", _assess)


__all__ = [
    "EvidenceTracker",
    "assess_session_evidence",
    "get_global_tracker",
    "reset_global_tracker",
    "register_methods",
]
