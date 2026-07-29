"""langfuse_client.py — Langfuse 可观测性客户端（T-P5-07）
================================================================

职责：
- 提供 OpenTelemetry 兼容的 trace / span / event 上下文管理器
- 离线模式：将观测数据缓存到本地 SQLite，避免丢失
- 在线模式（占位）：通过环境变量配置后可上传到 Langfuse 服务器
  （Phase 1 仅实现离线模式，在线模式留给 Phase 2）

设计原则：
1. **零外部依赖**：不引入 langfuse / opentelemetry 包，使用 stdlib sqlite3
2. **离线优先**：默认 `offline=True`，所有数据落盘 SQLite
3. **上下文管理器**：trace/span 使用 `@contextmanager`，自动开闭
4. **线程安全**：SQLite 连接通过 `threading.Lock` 保护
5. **可测试**：提供 `reset_client_for_test` 重置单例

数据模型（SQLite schema）：
- traces(id, name, attributes_json, started_at, ended_at, duration_ms)
- spans(id, trace_id, parent_span_id, name, attributes_json,
        started_at, ended_at, duration_ms)
- events(id, trace_id, span_id, name, attributes_json, timestamp)

JSON-RPC 方法（main.py 注册）：
- langfuse.event: 记录独立事件
- langfuse.flush: 刷新缓冲到 SQLite
- langfuse.stats: 查询当前缓冲与统计
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

logger = logging.getLogger("sidecar.observability.langfuse")


# ============================================================
# 默认配置
# ============================================================

# 默认 SQLite 数据库路径（优先使用 TDSF_DATA_DIR 环境变量，避免 Tauri dev watcher 循环重启）
_DEFAULT_DB_PATH: Path = Path(os.environ.get("TDSF_DATA_DIR", str(Path(__file__).parent.parent / "data"))) / "langfuse.db"

# 离线模式默认启用（无外部依赖，开箱即用）
_DEFAULT_OFFLINE: bool = True

# 在线模式上传环境变量名（Phase 2 使用）
_ENV_PUBLIC_KEY = "LANGFUSE_PUBLIC_KEY"
_ENV_SECRET_KEY = "LANGFUSE_SECRET_KEY"
_ENV_HOST = "LANGFUSE_HOST"


# ============================================================
# 上下文对象
# ============================================================


class TraceContext:
    """trace 上下文（由 `LangfuseClient.trace()` 创建）

    生命周期：
    - `__enter__` 时记录 trace 开始时间
    - `__exit__` 时记录结束时间并写入 SQLite
    - 嵌套 `span()` 创建子 span，自动关联 trace_id

    用法：
        with client.trace("agent_invoke", {"agent": "main"}) as tctx:
            with tctx.span("llm_call", {"model": "gpt-4"}):
                ...
    """

    def __init__(
        self,
        client: "LangfuseClient",
        trace_id: str,
        name: str,
        attributes: dict[str, Any] | None,
    ) -> None:
        self._client = client
        self.trace_id = trace_id
        self.name = name
        self.attributes: dict[str, Any] = dict(attributes) if attributes else {}
        self._started_at: float = time.time()
        self._ended_at: float | None = None
        self._closed: bool = False

    def span(
        self,
        name: str,
        attributes: dict[str, Any] | None = None,
    ) -> "SpanContext":
        """在此 trace 下创建子 span（上下文管理器）"""
        return SpanContext(
            client=self._client,
            trace_id=self.trace_id,
            parent_span_id=None,
            name=name,
            attributes=attributes,
        )

    def event(
        self,
        name: str,
        attributes: dict[str, Any] | None = None,
    ) -> None:
        """在此 trace 下记录一个事件"""
        self._client._record_event(
            name=name,
            trace_id=self.trace_id,
            span_id=None,
            attributes=attributes,
        )

    def __enter__(self) -> "TraceContext":
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        if self._closed:
            return
        self._ended_at = time.time()
        self._closed = True
        self._client._finalize_trace(self)


class SpanContext:
    """span 上下文（由 `TraceContext.span()` 或 `LangfuseClient.span()` 创建）

    生命周期同 TraceContext，但额外维护 parent_span_id 用于嵌套。
    """

    def __init__(
        self,
        client: "LangfuseClient",
        trace_id: str,
        parent_span_id: str | None,
        name: str,
        attributes: dict[str, Any] | None,
    ) -> None:
        self._client = client
        self.trace_id = trace_id
        self.span_id: str = uuid.uuid4().hex
        self.parent_span_id = parent_span_id
        self.name = name
        self.attributes: dict[str, Any] = dict(attributes) if attributes else {}
        self._started_at: float = time.time()
        self._ended_at: float | None = None
        self._closed: bool = False

    def span(
        self,
        name: str,
        attributes: dict[str, Any] | None = None,
    ) -> "SpanContext":
        """在此 span 下创建嵌套子 span"""
        return SpanContext(
            client=self._client,
            trace_id=self.trace_id,
            parent_span_id=self.span_id,
            name=name,
            attributes=attributes,
        )

    def event(
        self,
        name: str,
        attributes: dict[str, Any] | None = None,
    ) -> None:
        """在此 span 下记录事件"""
        self._client._record_event(
            name=name,
            trace_id=self.trace_id,
            span_id=self.span_id,
            attributes=attributes,
        )

    def __enter__(self) -> "SpanContext":
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        if self._closed:
            return
        self._ended_at = time.time()
        self._closed = True
        self._client._finalize_span(self)


# ============================================================
# LangfuseClient
# ============================================================


class LangfuseClient:
    """Langfuse 兼容的可观测性客户端。

    Args:
        offline: 是否启用离线模式（默认 True，所有数据落盘 SQLite）
        db_path: SQLite 数据库路径（默认 data/langfuse.db）
        auto_flush: 是否在每次记录后自动落盘（默认 True）

    用法：
        client = LangfuseClient(offline=True)

        # 1. trace + 嵌套 span
        with client.trace("agent_invoke", {"agent": "main"}) as tctx:
            with tctx.span("llm_call", {"model": "gpt-4"}):
                result = call_llm()
            tctx.event("custom_event", {"key": "value"})

        # 2. 独立事件
        client.event("startup", {"version": "1.0"})

        # 3. 显式 flush（auto_flush=False 时需要）
        client.flush()

        # 4. 查询统计
        stats = client.stats()
    """

    def __init__(
        self,
        offline: bool = _DEFAULT_OFFLINE,
        db_path: Path | str = _DEFAULT_DB_PATH,
        auto_flush: bool = True,
    ) -> None:
        self.offline: bool = bool(offline)
        self.db_path: Path = Path(db_path) if not isinstance(db_path, Path) else db_path
        self.auto_flush: bool = bool(auto_flush)

        # SQLite 连接与锁（线程安全）
        self._lock = threading.RLock()
        self._conn: sqlite3.Connection | None = None

        # 缓冲区（auto_flush=False 时累积）
        self._buffer_traces: list[dict[str, Any]] = []
        self._buffer_spans: list[dict[str, Any]] = []
        self._buffer_events: list[dict[str, Any]] = []

        # 在线模式配置（Phase 2 实现）
        self._online_public_key: str | None = os.environ.get(_ENV_PUBLIC_KEY)
        self._online_secret_key: str | None = os.environ.get(_ENV_SECRET_KEY)
        self._online_host: str | None = os.environ.get(_ENV_HOST)

        if self.offline:
            self._init_db()

    # ----------------------------------------------------------
    # 上下文管理器
    # ----------------------------------------------------------

    @contextmanager
    def trace(
        self,
        name: str,
        attributes: dict[str, Any] | None = None,
    ) -> Iterator[TraceContext]:
        """创建一个 trace（顶层观测单元）

        Args:
            name: trace 名称（如 "agent_invoke"）
            attributes: 附加属性

        Yields:
            TraceContext: trace 上下文，可嵌套创建 span
        """
        trace_id = uuid.uuid4().hex
        ctx = TraceContext(self, trace_id, name, attributes)
        try:
            yield ctx
        finally:
            ctx.__exit__(None, None, None)

    @contextmanager
    def span(
        self,
        name: str,
        attributes: dict[str, Any] | None = None,
    ) -> Iterator[SpanContext]:
        """创建一个独立 span（无父 trace）

        用于无明确 trace 边界的场景，自动创建一个匿名 trace。

        Args:
            name: span 名称
            attributes: 附加属性

        Yields:
            SpanContext
        """
        trace_id = uuid.uuid4().hex
        ctx = SpanContext(self, trace_id, None, name, attributes)
        try:
            yield ctx
        finally:
            ctx.__exit__(None, None, None)

    # ----------------------------------------------------------
    # 事件记录
    # ----------------------------------------------------------

    def event(
        self,
        name: str,
        attributes: dict[str, Any] | None = None,
    ) -> None:
        """记录一个独立事件（不绑定到任何 trace/span）

        Args:
            name: 事件名称
            attributes: 附加属性
        """
        self._record_event(
            name=name,
            trace_id=None,
            span_id=None,
            attributes=attributes,
        )

    # ----------------------------------------------------------
    # flush 与统计
    # ----------------------------------------------------------

    def flush(self) -> None:
        """将缓冲区数据写入 SQLite（auto_flush=False 时使用）"""
        with self._lock:
            if not self.offline or self._conn is None:
                # 在线模式或未初始化：清空缓冲即可
                self._buffer_traces.clear()
                self._buffer_spans.clear()
                self._buffer_events.clear()
                return

            self._flush_buffers_to_db()
            self._buffer_traces.clear()
            self._buffer_spans.clear()
            self._buffer_events.clear()

    def stats(self) -> dict[str, Any]:
        """返回当前缓冲与 SQLite 统计信息

        Returns:
            {
                "offline": bool,
                "db_path": str,
                "buffer": {"traces": int, "spans": int, "events": int},
                "db": {"traces": int, "spans": int, "events": int},
                "online_configured": bool,
            }
        """
        with self._lock:
            buffer_stats = {
                "traces": len(self._buffer_traces),
                "spans": len(self._buffer_spans),
                "events": len(self._buffer_events),
            }
            db_stats = {"traces": 0, "spans": 0, "events": 0}
            if self.offline and self._conn is not None:
                try:
                    cur = self._conn.execute("SELECT COUNT(*) FROM traces")
                    db_stats["traces"] = cur.fetchone()[0]
                    cur = self._conn.execute("SELECT COUNT(*) FROM spans")
                    db_stats["spans"] = cur.fetchone()[0]
                    cur = self._conn.execute("SELECT COUNT(*) FROM events")
                    db_stats["events"] = cur.fetchone()[0]
                except sqlite3.Error as e:
                    logger.warning(f"failed to query stats: {e}")

            return {
                "offline": self.offline,
                "db_path": str(self.db_path),
                "buffer": buffer_stats,
                "db": db_stats,
                "online_configured": bool(
                    self._online_public_key and self._online_secret_key
                ),
            }

    # ----------------------------------------------------------
    # 内部实现
    # ----------------------------------------------------------

    def _init_db(self) -> None:
        """初始化 SQLite 数据库（创建表 + 索引）"""
        with self._lock:
            # 确保父目录存在
            self.db_path.parent.mkdir(parents=True, exist_ok=True)
            self._conn = sqlite3.connect(
                str(self.db_path),
                check_same_thread=False,
                isolation_level=None,  # autocommit
            )
            self._conn.row_factory = sqlite3.Row

            # 创建表（IF NOT EXISTS 保证幂等）
            self._conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS traces (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    attributes_json TEXT NOT NULL DEFAULT '{}',
                    started_at REAL NOT NULL,
                    ended_at REAL,
                    duration_ms INTEGER
                );

                CREATE TABLE IF NOT EXISTS spans (
                    id TEXT PRIMARY KEY,
                    trace_id TEXT,
                    parent_span_id TEXT,
                    name TEXT NOT NULL,
                    attributes_json TEXT NOT NULL DEFAULT '{}',
                    started_at REAL NOT NULL,
                    ended_at REAL,
                    duration_ms INTEGER,
                    FOREIGN KEY (trace_id) REFERENCES traces(id)
                );

                CREATE TABLE IF NOT EXISTS events (
                    id TEXT PRIMARY KEY,
                    trace_id TEXT,
                    span_id TEXT,
                    name TEXT NOT NULL,
                    attributes_json TEXT NOT NULL DEFAULT '{}',
                    timestamp REAL NOT NULL,
                    FOREIGN KEY (trace_id) REFERENCES traces(id),
                    FOREIGN KEY (span_id) REFERENCES spans(id)
                );

                CREATE INDEX IF NOT EXISTS idx_spans_trace_id ON spans(trace_id);
                CREATE INDEX IF NOT EXISTS idx_events_trace_id ON events(trace_id);
                CREATE INDEX IF NOT EXISTS idx_events_span_id ON events(span_id);
                """
            )
            logger.info(f"langfuse SQLite initialized at {self.db_path}")

    def _finalize_trace(self, ctx: TraceContext) -> None:
        """trace 结束时调用，记录到缓冲或直接写库"""
        duration_ms = (
            int((ctx._ended_at - ctx._started_at) * 1000)
            if ctx._ended_at is not None
            else None
        )
        record = {
            "id": ctx.trace_id,
            "name": ctx.name,
            "attributes_json": json.dumps(ctx.attributes, ensure_ascii=False),
            "started_at": ctx._started_at,
            "ended_at": ctx._ended_at,
            "duration_ms": duration_ms,
        }
        with self._lock:
            self._buffer_traces.append(record)
            if self.auto_flush:
                self._flush_buffers_to_db()
                self._buffer_traces.clear()
                self._buffer_spans.clear()
                self._buffer_events.clear()

    def _finalize_span(self, ctx: SpanContext) -> None:
        """span 结束时调用"""
        duration_ms = (
            int((ctx._ended_at - ctx._started_at) * 1000)
            if ctx._ended_at is not None
            else None
        )
        record = {
            "id": ctx.span_id,
            "trace_id": ctx.trace_id,
            "parent_span_id": ctx.parent_span_id,
            "name": ctx.name,
            "attributes_json": json.dumps(ctx.attributes, ensure_ascii=False),
            "started_at": ctx._started_at,
            "ended_at": ctx._ended_at,
            "duration_ms": duration_ms,
        }
        with self._lock:
            self._buffer_spans.append(record)
            if self.auto_flush:
                self._flush_buffers_to_db()
                self._buffer_traces.clear()
                self._buffer_spans.clear()
                self._buffer_events.clear()

    def _record_event(
        self,
        name: str,
        trace_id: str | None,
        span_id: str | None,
        attributes: dict[str, Any] | None,
    ) -> None:
        """记录事件到缓冲"""
        record = {
            "id": uuid.uuid4().hex,
            "trace_id": trace_id,
            "span_id": span_id,
            "name": name,
            "attributes_json": json.dumps(
                attributes or {}, ensure_ascii=False
            ),
            "timestamp": time.time(),
        }
        with self._lock:
            self._buffer_events.append(record)
            if self.auto_flush:
                self._flush_buffers_to_db()
                self._buffer_traces.clear()
                self._buffer_spans.clear()
                self._buffer_events.clear()

    def _flush_buffers_to_db(self) -> None:
        """将缓冲区数据批量写入 SQLite（调用者持锁）"""
        if self._conn is None:
            return

        try:
            for r in self._buffer_traces:
                self._conn.execute(
                    "INSERT OR REPLACE INTO traces "
                    "(id, name, attributes_json, started_at, ended_at, duration_ms) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (
                        r["id"],
                        r["name"],
                        r["attributes_json"],
                        r["started_at"],
                        r["ended_at"],
                        r["duration_ms"],
                    ),
                )
            for s in self._buffer_spans:
                self._conn.execute(
                    "INSERT OR REPLACE INTO spans "
                    "(id, trace_id, parent_span_id, name, attributes_json, "
                    " started_at, ended_at, duration_ms) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        s["id"],
                        s["trace_id"],
                        s["parent_span_id"],
                        s["name"],
                        s["attributes_json"],
                        s["started_at"],
                        s["ended_at"],
                        s["duration_ms"],
                    ),
                )
            for e in self._buffer_events:
                self._conn.execute(
                    "INSERT OR REPLACE INTO events "
                    "(id, trace_id, span_id, name, attributes_json, timestamp) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (
                        e["id"],
                        e["trace_id"],
                        e["span_id"],
                        e["name"],
                        e["attributes_json"],
                        e["timestamp"],
                    ),
                )
        except sqlite3.Error as e:
            logger.error(f"failed to flush buffers to SQLite: {e}")

    def close(self) -> None:
        """关闭数据库连接（用于优雅退出）"""
        with self._lock:
            if self._conn is not None:
                self.flush()
                self._conn.close()
                self._conn = None


# ============================================================
# 模块级单例
# ============================================================

_client: LangfuseClient | None = None
_client_lock = threading.Lock()


def get_client() -> LangfuseClient:
    """获取全局 LangfuseClient 实例（懒加载单例）

    默认配置：
    - offline=True（除非环境变量 LANGFUSE_PUBLIC_KEY 已设置）
    - db_path=data/langfuse.db
    - auto_flush=True
    """
    global _client
    if _client is None:
        with _client_lock:
            if _client is None:
                # 若环境变量齐全，自动切到在线模式（Phase 2 才会上传）
                online_env = bool(
                    os.environ.get(_ENV_PUBLIC_KEY)
                    and os.environ.get(_ENV_SECRET_KEY)
                )
                _client = LangfuseClient(
                    offline=not online_env,
                    db_path=_DEFAULT_DB_PATH,
                    auto_flush=True,
                )
    return _client


def reset_client_for_test() -> None:
    """重置单例（仅用于测试）

    关闭现有连接并清空单例，便于下一次 get_client() 重新初始化。
    """
    global _client
    with _client_lock:
        if _client is not None:
            try:
                _client.close()
            except Exception as e:
                logger.warning(f"failed to close client during reset: {e}")
        _client = None


# ============================================================
# JSON-RPC 注册
# ============================================================


def register_methods(dispatcher: Any) -> None:
    """向 JSON-RPC dispatcher 注册 langfuse.* 方法

    注册的方法：
    - langfuse.event:    记录独立事件
    - langfuse.flush:    刷新缓冲到 SQLite
    - langfuse.stats:    查询统计信息
    - langfuse.trace:    创建 trace（返回 trace_id）
    """
    client = get_client()

    def _langfuse_event(
        name: str,
        attributes: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """JSON-RPC: langfuse.event"""
        client.event(name, attributes)
        return {"ok": True, "name": name}

    def _langfuse_flush() -> dict[str, Any]:
        """JSON-RPC: langfuse.flush"""
        client.flush()
        return {"ok": True}

    def _langfuse_stats() -> dict[str, Any]:
        """JSON-RPC: langfuse.stats"""
        return client.stats()

    def _langfuse_trace(
        name: str,
        attributes: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """JSON-RPC: langfuse.trace

        创建并立即落盘一个 trace（不进入上下文管理器）。
        用于一次性 trace 标记，不嵌套 span。
        """
        with client.trace(name, attributes):
            pass
        return {"ok": True, "name": name}

    dispatcher.register("langfuse.event", _langfuse_event)
    dispatcher.register("langfuse.flush", _langfuse_flush)
    dispatcher.register("langfuse.stats", _langfuse_stats)
    dispatcher.register("langfuse.trace", _langfuse_trace)
    logger.info("langfuse.* methods registered (4 methods)")


# ============================================================
# 辅助函数
# ============================================================


def _now_iso() -> str:
    """当前 UTC 时间的 ISO 8601 字符串（用于日志）"""
    return datetime.now(timezone.utc).isoformat()
