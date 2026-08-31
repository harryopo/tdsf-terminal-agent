"""
strands_backend/agent_log.py — 会话流水日志（2026-08-31，用户钦定调试后端）
=============================================================================

职责：把每个会话的 agent 流水（用户输入 / 注入的上下文分区 / agent 回答 /
推理段 / 工具调用与结果）按事件追加写 JSONL 到::

    <TDSF_DATA_DIR>/agent-logs/<session_id>.jsonl

每行结构：``{"ts": <epoch>, "type": <事件类型>, "content": <摘要≤2000字>, "meta": {...}}``

事件类型：
- user_msg:      用户输入（已剥离 <env>/<environment>/<terminal-*>/<live_context> 注入区）
- env_inject:    本轮注入的环境上下文分区（原样摘要，排障"agent 到底看到了什么"）
- assistant_msg: agent 最终回答（invoke observation 全文）
- reasoning:     深度思考段（callback_handler 聚合增量后落盘）
- tool_call:     工具调用开始（event_bus tool_call status=started）
- tool_result:   工具调用完成/失败（event_bus tool_call status=completed/error）

与既有设施的区别（防重复建设）：
- core/log_capture.py 是全局 logging ringbuffer（内存，非会话维度，进程退出即丢）
- session_memory.py 是会话总结/技能沉淀（非流水）
- audit_chain.py 是安全审计链（防篡改视角）
本模块是**会话维度、落盘、默认开启**的调试流水：用户以后"有问题的告诉你，
你查看"——无需知道 session_id 也可用 debug.agent_log_tail 列出最近会话。

设计约束：
- 默认开启（用户要看历史）；体积控制靠 content 截断（≤2000 字符）
- 轮转：单文件 >10MB 重命名为 ``.jsonl.1``（保留一代）
- 写失败静默降级（logger.debug，不刷屏；绝不影响主链路）——红线 3.5 #4：
  降级策略显式注释 + 计数器可查（debug.agent_log_tail 返回 write_errors）
- 线程安全：全局锁（写频率低，锁开销可忽略）
"""
from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger("sidecar.strands_backend.agent_log")

# content 摘要上限（任务书钦定 ≤2000 字符，控体积）
_MAX_CONTENT_LEN = 2000
# 轮转阈值：单文件 >10MB → 重命名 <name>.1（模块常量便于测试 monkeypatch）
ROTATE_BYTES = 10 * 1024 * 1024
# tail 默认行数
_DEFAULT_TAIL_LINES = 200
# tail 单行 content 上限（读侧再截一次，防历史超大行刷爆 RPC 响应）
_TAIL_CONTENT_LEN = 2000

# 全局锁（写 + 轮转 + 统计）
_lock = threading.Lock()
_stats = {"written": 0, "write_errors": 0, "rotated": 0}

# event_bus 订阅句柄（防重复订阅 + 测试隔离退订）
_bus_subscribed = False
_bus_unsub: Any = None


def logs_dir() -> Path:
    """会话日志目录：<TDSF_DATA_DIR>/agent-logs（惰性创建）"""
    data_dir = Path(os.environ.get("TDSF_DATA_DIR", "."))
    d = data_dir / "agent-logs"
    try:
        d.mkdir(parents=True, exist_ok=True)
    except Exception as e:  # noqa: BLE001 — 目录创建失败在 write 时再报
        logger.debug(f"agent-logs mkdir failed: {e}")
    return d


def sanitize_session_id(session_id: str) -> str:
    """session_id → 安全文件名（防路径穿越/非法字符；空串归 "default"）"""
    cleaned = re.sub(r"[^A-Za-z0-9_.-]", "_", str(session_id or "")).strip("._")
    return (cleaned or "default")[:80]


def _log_file(session_id: str) -> Path:
    return logs_dir() / f"{sanitize_session_id(session_id)}.jsonl"


def log_event(
    session_id: str,
    event_type: str,
    content: Any,
    meta: dict[str, Any] | None = None,
) -> bool:
    """追加一条会话流水事件（写失败静默，绝不抛异常影响主链路）

    Args:
        session_id: 会话 ID（空串写入 default.jsonl——env 分区等仍有排查价值）
        event_type: user_msg / env_inject / assistant_msg / reasoning /
                    tool_call / tool_result
        content: 事件内容（任意类型，str() 后截断 ≤2000 字符）
        meta: 附加元数据（mode/teach/agent_id/tool_name/status 等，可选）

    Returns:
        True=写入成功；False=静默失败（计数器 +1）
    """
    entry: dict[str, Any] = {
        "ts": round(time.time(), 3),
        "type": event_type,
        "content": _clip(content),
        "meta": meta or {},
    }
    try:
        path = _log_file(session_id)
        with _lock:
            _rotate_if_needed(path)
            with open(path, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
            _stats["written"] += 1
        return True
    except Exception as e:  # noqa: BLE001 — 日志通路绝不能影响 agent 主链路
        with _lock:
            _stats["write_errors"] += 1
        # 首次失败 warning 提示，之后 debug 防刷屏（红线：不静默吞错）
        if _stats["write_errors"] == 1:
            logger.warning(f"agent_log write failed (fallback: silent, {e})")
        else:
            logger.debug(f"agent_log write failed: {e}")
        return False


def _clip(content: Any) -> str:
    """内容 → 摘要字符串（≤2000 字符）"""
    if content is None:
        return ""
    if not isinstance(content, str):
        try:
            content = json.dumps(content, ensure_ascii=False)
        except Exception:  # noqa: BLE001
            content = str(content)
    text = str(content)
    return text if len(text) <= _MAX_CONTENT_LEN else text[:_MAX_CONTENT_LEN] + "…"


def _rotate_if_needed(path: Path) -> None:
    """单文件超阈值 → 重命名 .1（覆盖旧 .1；调用方持有 _lock）"""
    try:
        if path.exists() and path.stat().st_size > ROTATE_BYTES:
            backup = path.with_name(path.name + ".1")
            if backup.exists():
                backup.unlink()
            path.rename(backup)
            _stats["rotated"] += 1
            logger.info(f"agent_log rotated: {path.name} → {backup.name}")
    except Exception as e:  # noqa: BLE001 — 轮转失败不阻塞写入
        logger.debug(f"agent_log rotate failed: {e}")


def list_sessions() -> list[dict[str, Any]]:
    """列出全部会话日志（按最近写入降序）"""
    result: list[dict[str, Any]] = []
    try:
        for p in sorted(
            logs_dir().glob("*.jsonl"),
            key=lambda f: f.stat().st_mtime,
            reverse=True,
        ):
            result.append(
                {
                    "session_id": p.stem,
                    "file": p.name,
                    "size": p.stat().st_size,
                    "mtime": p.stat().st_mtime,
                }
            )
    except Exception as e:  # noqa: BLE001
        logger.debug(f"agent_log list_sessions failed: {e}")
    return result


def tail(
    session_id: str | None = None,
    lines: int = _DEFAULT_TAIL_LINES,
    event_type: str | None = None,
) -> dict[str, Any]:
    """读最近流水（debug.agent_log_tail 实现）

    Args:
        session_id: 会话 ID；None → 返回全部会话列表 + 最新会话的 tail
        lines: 最近 N 行（默认 200）
        event_type: 按事件类型过滤（None=不过滤）

    Returns:
        session_id 给定: {ok, session_id, lines, returned, ...stats}
        session_id 缺省: {ok, files: [...], lines: <最新会话 tail>}
    """
    n = lines if lines and lines > 0 else _DEFAULT_TAIL_LINES
    if not session_id:
        files = list_sessions()
        latest = files[0]["session_id"] if files else None
        result: dict[str, Any] = {"ok": True, "files": files}
        if latest:
            result["latest_session_id"] = latest
            result.update(_tail_one(latest, n, event_type))
        else:
            result["lines"] = []
            result["returned"] = 0
        return result
    result = {"ok": True, "session_id": session_id}
    result.update(_tail_one(session_id, n, event_type))
    return result


def _tail_one(
    session_id: str, lines: int, event_type: str | None
) -> dict[str, Any]:
    """单会话 tail（从文件尾部回读 lines 行，倒序过滤后正序返回）"""
    path = _log_file(session_id)
    if not path.exists():
        return {"lines": [], "returned": 0}
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            all_lines = f.readlines()
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e), "lines": [], "returned": 0}

    picked: list[dict[str, Any]] = []
    for raw in reversed(all_lines):
        if len(picked) >= lines:
            break
        raw = raw.strip()
        if not raw:
            continue
        try:
            entry = json.loads(raw)
        except Exception:  # noqa: BLE001 — 坏行跳过（半行写入等）
            continue
        if event_type and entry.get("type") != event_type:
            continue
        if isinstance(entry.get("content"), str):
            c = entry["content"]
            if len(c) > _TAIL_CONTENT_LEN:
                entry["content"] = c[:_TAIL_CONTENT_LEN] + "…"
        picked.append(entry)
    picked.reverse()
    return {
        "lines": picked,
        "returned": len(picked),
        "total_in_file": len(all_lines),
        **{k: v for k, v in _stats_snapshot().items() if k != "written"},
    }


def _stats_snapshot() -> dict[str, int]:
    with _lock:
        return dict(_stats)


# ============================================================================
# event_bus 桥接：tool_call 事件 → 流水（全工具单点埋点）
# ============================================================================

def _handle_bus_event(event: Any) -> None:
    """EventBus 订阅回调：tool_call 事件 → tool_call / tool_result 行

    事件 payload（event_bus.emit_tool_call）：
        {tool_name, params, status: started|completed|error, result?}
    """
    try:
        if getattr(event, "event_type", None) != "tool_call":
            return
        payload = getattr(event, "payload", None) or {}
        tool_name = str(payload.get("tool_name", "?"))
        status = str(payload.get("status", ""))
        session_id = str(getattr(event, "session_id", "") or "")
        if status == "started":
            log_event(
                session_id,
                "tool_call",
                json.dumps(payload.get("params") or {}, ensure_ascii=False),
                meta={"tool_name": tool_name, "status": status,
                      "source": getattr(event, "source", "") or ""},
            )
        else:
            log_event(
                session_id,
                "tool_result",
                payload.get("result"),
                meta={"tool_name": tool_name, "status": status,
                      "source": getattr(event, "source", "") or ""},
            )
    except Exception as e:  # noqa: BLE001 — 桥接失败静默（不影响事件总线）
        logger.debug(f"agent_log bus event handle failed: {e}")


def _subscribe_bus() -> None:
    """订阅全局 EventBus 的 tool_call 事件（幂等）"""
    global _bus_subscribed, _bus_unsub
    if _bus_subscribed:
        return
    try:
        from event_bus import get_global_bus

        _bus_unsub = get_global_bus().subscribe(
            _handle_bus_event,
            event_type="tool_call",
            name="agent_log",
        )
        _bus_subscribed = True
        logger.info("agent_log subscribed to event_bus tool_call events")
    except Exception as e:  # noqa: BLE001 — 订阅失败仅损失工具流水，不阻塞
        logger.warning(f"agent_log event_bus subscribe failed (fallback: {e})")


def reset_for_test() -> None:
    """测试隔离：清统计 + 退订 bus（目录由 TDSF_DATA_DIR fixture 隔离）"""
    global _bus_subscribed, _bus_unsub
    with _lock:
        _stats.update({"written": 0, "write_errors": 0, "rotated": 0})
    if _bus_unsub is not None:
        try:
            _bus_unsub()
        except Exception:  # noqa: BLE001
            pass
    _bus_unsub = None
    _bus_subscribed = False


# ============================================================================
# JSON-RPC 注册
# ============================================================================

def register_methods(dispatcher: Any) -> None:
    """注册 debug.* 方法 + 挂接 event_bus 工具事件订阅（main.py 调用）"""

    def _agent_log_tail(
        session_id: str | None = None,
        lines: int = _DEFAULT_TAIL_LINES,
        type: str | None = None,
    ) -> dict[str, Any]:
        """debug.agent_log_tail：读会话流水最近 N 行

        Args:
            session_id: 会话 ID；缺省 → 列出全部会话 + 最新会话流水
            lines: 最近 N 行（默认 200）
            type: 事件类型过滤（user_msg/env_inject/assistant_msg/reasoning/tool_call/tool_result）
        """
        return tail(session_id=session_id, lines=lines, event_type=type)

    dispatcher.register("debug.agent_log_tail", _agent_log_tail)
    _subscribe_bus()
    logger.info("debug.* methods registered (agent_log_tail) + tool_call 桥接")


__all__ = [
    "log_event",
    "tail",
    "list_sessions",
    "logs_dir",
    "sanitize_session_id",
    "reset_for_test",
    "register_methods",
    "ROTATE_BYTES",
]
