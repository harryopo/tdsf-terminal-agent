"""
core/log_capture.py — Sidecar 后端日志独立通路（T-P4-LOG-01）
====================================================================

职责：
- 通过 logging.Handler 子类把 Python sidecar 所有 logger 写入到
  内存 ringbuffer（线程安全）
- 通过 JSON-RPC 暴露给前端:
    - log.tail  (lines, level_filter)  → 拉取最近 N 行
    - log.clear ()                     → 清空
    - log.stats ()                     → 缓冲统计
    - log.subscribe ()                 → 启动 SSE-like 长轮询
- 提供 set_rust_notifier 钩子，新日志实时推送到 Rust 侧 (Tauri event)

设计要点：
- 环形缓冲默认保留 5000 行，超过自动丢弃最早行
- 每条日志带 level / logger / timestamp / message 四个字段
- 推送到前端的格式: {"ts": 1722148800.123, "level": "INFO",
  "logger": "sidecar.skills.registry", "msg": "loaded 5 skills"}
- log.tail 支持 level_filter 过滤 ("INFO"/"WARNING"/"ERROR"/"DEBUG")
- 推送到前端的 Tauri event 名: "sidecar://log"

TDSF 魔改 2026-07-28：
这是为子审查 agent 专门配置的后端日志独立通路，与开发 agent 完全隔离。
子审查 agent 只需要知道:
    log.tail({lines: 200, level_filter: "ERROR"})
返回 {ok: true, lines: [...]} 即可。
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from collections import deque
from typing import Any, Callable

logger = logging.getLogger("sidecar.core.log_capture")

# ============================================================================
# 常量
# ============================================================================

# 环形缓冲行数上限（每个 log 记录为 1 行）
RINGBUFFER_LIMIT = 5000

# 推送到前端的 Tauri event 名 (与 ipc.rs 中 sidecar.rs reader_task 路由对齐)
# 前端 listen('sidecar:log', cb) 即可接收
LOG_EVENT_NAME = "sidecar:log"

# 已知日志级别白名单（用于前端 level filter 下拉框）
LEVELS = ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL")


# ============================================================================
# 内存环形缓冲（线程安全）
# ============================================================================


class LogRingBuffer:
    """线程安全环形缓冲，保存最近 N 条 log 记录"""

    def __init__(self, limit: int = RINGBUFFER_LIMIT) -> None:
        self._buf: deque[dict[str, Any]] = deque(maxlen=limit)
        self._lock = threading.Lock()

    def append(self, record: dict[str, Any]) -> None:
        with self._lock:
            self._buf.append(record)

    def tail(self, lines: int, level_filter: str | None = None) -> list[dict[str, Any]]:
        """返回最近 lines 条记录（按时间正序）

        Args:
            lines: 返回行数（<=0 或 None 表示返回全部）
            level_filter: 级别过滤（None / "" / "ALL" 表示不过滤）

        Returns:
            log 记录列表，每条 {ts, level, logger, msg}
        """
        with self._lock:
            snapshot = list(self._buf)

        # 级别过滤
        if level_filter and level_filter.upper() != "ALL":
            target_level = level_filter.upper()
            # 支持 "WARNING+" 表示 WARNING 及以上
            if target_level.endswith("+"):
                base_level = target_level[:-1]
                if base_level in LEVELS:
                    base_idx = LEVELS.index(base_level)
                    snapshot = [
                        r for r in snapshot
                        if LEVELS.index(r.get("level", "INFO")) >= base_idx
                    ]
            else:
                snapshot = [r for r in snapshot if r.get("level") == target_level]

        # tail: 只取最后 lines 条
        if lines and lines > 0:
            snapshot = snapshot[-lines:]
        return snapshot

    def clear(self) -> int:
        """清空缓冲，返回被清空的条数"""
        with self._lock:
            count = len(self._buf)
            self._buf.clear()
            return count

    def stats(self) -> dict[str, Any]:
        """返回缓冲统计信息"""
        with self._lock:
            total = len(self._buf)
            by_level: dict[str, int] = {}
            for r in self._buf:
                lvl = r.get("level", "UNKNOWN")
                by_level[lvl] = by_level.get(lvl, 0) + 1
            return {
                "total": total,
                "limit": self._buf.maxlen,
                "by_level": by_level,
            }


# ============================================================================
# logging.Handler 子类：把日志写入 ringbuffer
# ============================================================================


class RingBufferHandler(logging.Handler):
    """logging.Handler 子类，把日志记录写入共享的 LogRingBuffer

    设计:
      - ringbuffer 始终记录所有级别（log.tail 可查全部）
      - 但 rust_notifier 默认只推送 INFO+ 级别（避免 stdout 洪水淹 JSON-RPC）
      - 通过环境变量 PUSH_LEVEL 可调整推送阈值（默认 INFO）
    """

    def __init__(self, buffer: LogRingBuffer, rust_notifier: Callable[[str, dict[str, Any]], None] | None = None) -> None:
        super().__init__(level=logging.DEBUG)
        self._buffer = buffer
        self._rust_notifier = rust_notifier
        # formatter: "2026-07-28 12:34:56 INFO sidecar.skills.registry: loaded 5 skills"
        self.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
        # 推送阈值: 缓冲仍记全,但只把 INFO+ 推给 Rust notifier
        # 避免 sidecar 启动时数百条 DEBUG 日志通过 stdout 推送,淹没 JSON-RPC 响应
        push_level_name = os.environ.get("TDSF_LOG_PUSH_LEVEL", "INFO").upper()
        self._push_level = getattr(logging, push_level_name, logging.INFO)

    def emit(self, record: logging.LogRecord) -> None:
        try:
            # timestamp: 优先用 record.created, 备选用 time.time()
            ts = getattr(record, "created", None) or time.time()
            level = record.levelname
            logger_name = record.name
            msg = self.format(record)

            entry: dict[str, Any] = {
                "ts": float(ts),
                "level": level,
                "logger": logger_name,
                "msg": msg,
            }
            self._buffer.append(entry)

            # 实时推送到 Rust 侧 (Tauri event) — 限级别,避免 stdout 洪水
            if self._rust_notifier is not None and record.levelno >= self._push_level:
                try:
                    self._rust_notifier(LOG_EVENT_NAME, entry)
                except Exception as e:
                    logger.debug(f"rust notifier failed (non-fatal): {e}")
        except Exception:
            # emit 不能抛异常，否则会破坏 logging
            self.handleError(record)


# ============================================================================
# 全局实例（单例）
# ============================================================================

_global_buffer: LogRingBuffer | None = None
_global_handler: RingBufferHandler | None = None
_global_lock = threading.Lock()


def get_global_buffer() -> LogRingBuffer:
    """获取全局 LogRingBuffer 单例（首次调用时自动创建）"""
    global _global_buffer
    if _global_buffer is None:
        with _global_lock:
            if _global_buffer is None:
                _global_buffer = LogRingBuffer()
    return _global_buffer


def install_handler(rust_notifier: Callable[[str, dict[str, Any]], None] | None = None) -> int:
    """安装 logging.Handler 到 root logger

    Args:
        rust_notifier: 实时推送回调 (event_name, payload)
                       None 表示不推送（仅写入 ringbuffer）

    Returns:
        1 表示新安装, 0 表示已安装 (幂等)
    """
    global _global_handler
    buffer = get_global_buffer()
    if _global_handler is not None:
        return 0
    with _global_lock:
        if _global_handler is not None:
            return 0
        _global_handler = RingBufferHandler(buffer, rust_notifier)
        # 安装到 root logger, 捕获所有子 logger 的输出
        root = logging.getLogger()
        root.addHandler(_global_handler)
        # 把 root level 调到 DEBUG, 保证捕获所有级别
        if root.level == logging.NOTSET or root.level > logging.DEBUG:
            root.setLevel(logging.DEBUG)
        logger.info(
            f"LogRingBuffer installed: limit={RINGBUFFER_LIMIT} "
            f"event={LOG_EVENT_NAME}"
        )
    return 1


# ============================================================================
# JSON-RPC 方法注册
# ============================================================================


def register_methods(dispatcher: Any) -> None:
    """向 JSON-RPC dispatcher 注册 log.* 方法

    注册的方法:
    - log.tail  (lines=200, level_filter=None) → 拉取最近 N 行
    - log.clear ()                             → 清空缓冲
    - log.stats ()                             → 缓冲统计
    - log.set_level (level="INFO")             → 动态调整 root logger level
    """
    def _log_tail(
        lines: int | None = 200,
        level_filter: str | None = None,
    ) -> dict[str, Any]:
        """拉取最近 N 行日志

        Args:
            lines: 返回行数（None 或 <=0 表示全部，默认 200）
            level_filter: 级别过滤（"INFO"/"WARNING"/"ERROR"/"DEBUG"/"WARNING+"）

        Returns:
            {"ok": True, "lines": [...], "total": N}
        """
        try:
            buffer = get_global_buffer()
            n = lines if lines and lines > 0 else None
            tail = buffer.tail(n, level_filter)
            stats = buffer.stats()
            return {
                "ok": True,
                "lines": tail,
                "returned": len(tail),
                "total": stats["total"],
            }
        except Exception as e:
            logger.exception(f"log.tail failed: {e}")
            return {"ok": False, "error": str(e)}

    def _log_clear() -> dict[str, Any]:
        """清空日志缓冲"""
        try:
            buffer = get_global_buffer()
            cleared = buffer.clear()
            logger.info(f"log buffer cleared ({cleared} lines)")
            return {"ok": True, "cleared": cleared}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def _log_stats() -> dict[str, Any]:
        """返回日志缓冲统计"""
        try:
            buffer = get_global_buffer()
            return {"ok": True, "stats": buffer.stats()}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def _log_set_level(level: str = "INFO") -> dict[str, Any]:
        """动态调整 root logger level

        Args:
            level: DEBUG/INFO/WARNING/ERROR/CRITICAL
        """
        try:
            level_upper = level.upper()
            numeric_level = getattr(logging, level_upper, None)
            if not isinstance(numeric_level, int):
                return {"ok": False, "error": f"invalid level: {level}"}
            logging.getLogger().setLevel(numeric_level)
            logger.info(f"root logger level set to {level_upper}")
            return {"ok": True, "level": level_upper}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def _log_levels() -> dict[str, Any]:
        """返回支持的日志级别列表（供前端下拉框使用）"""
        return {
            "ok": True,
            "levels": ["ALL", "DEBUG", "INFO", "WARNING+", "ERROR", "CRITICAL"],
        }

    dispatcher.register("log.tail", _log_tail)
    dispatcher.register("log.clear", _log_clear)
    dispatcher.register("log.stats", _log_stats)
    dispatcher.register("log.set_level", _log_set_level)
    dispatcher.register("log.levels", _log_levels)
    logger.info("log.* methods registered (5 methods: tail/clear/stats/set_level/levels)")
