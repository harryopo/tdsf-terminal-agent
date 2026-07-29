"""
tests/test_langfuse.py — Langfuse 可观测性客户端测试（T-P5-07）
=================================================================

验证内容：
1. LangfuseClient 初始化
   - 离线模式默认启用
   - 自定义 db_path 生效
   - 在线模式占位（不实际连接）
2. trace 上下文管理器
   - 基本 trace 创建与落盘
   - trace 嵌套 span
   - trace 嵌套 event
3. span 上下文管理器
   - 独立 span 创建
   - 嵌套子 span
4. event 记录
   - 独立 event
   - trace 内 event
   - span 内 event
5. flush 与 stats
   - auto_flush=True 自动落盘
   - auto_flush=False 手动 flush
   - stats 返回正确统计
6. 单例与重置
   - get_client 返回同一实例
   - reset_client_for_test 清空单例
7. JSON-RPC 方法注册
   - 4 个方法成功注册
8. 数据落盘正确性
   - trace/span/event 在 SQLite 中可查
   - duration_ms 计算正确

运行：
    cd python-sidecar
    python -m pytest tests/test_langfuse.py -v
"""

from __future__ import annotations

import sqlite3
import sys
import tempfile
from pathlib import Path

# 确保能 import observability 模块
sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

from observability.langfuse_client import (
    LangfuseClient,
    SpanContext,
    TraceContext,
    get_client,
    register_methods,
    reset_client_for_test,
)


# ============================================================================
# Fixture
# ============================================================================


@pytest.fixture
def temp_db_path(tmp_path: Path) -> Path:
    """每个测试独立的 SQLite 数据库路径"""
    return tmp_path / "test_langfuse.db"


@pytest.fixture
def client(temp_db_path: Path) -> LangfuseClient:
    """每个测试独立的 LangfuseClient（auto_flush=True）"""
    c = LangfuseClient(
        offline=True,
        db_path=temp_db_path,
        auto_flush=True,
    )
    yield c
    c.close()


@pytest.fixture
def manual_client(temp_db_path: Path) -> LangfuseClient:
    """auto_flush=False 的 client（用于测试缓冲行为）"""
    c = LangfuseClient(
        offline=True,
        db_path=temp_db_path,
        auto_flush=False,
    )
    yield c
    c.close()


# ============================================================================
# 1. 初始化测试
# ============================================================================


class TestInitialization:
    """LangfuseClient 初始化测试"""

    def test_default_offline_is_true(self, temp_db_path: Path) -> None:
        """默认应为离线模式"""
        c = LangfuseClient(db_path=temp_db_path)
        assert c.offline is True
        c.close()

    def test_custom_db_path_takes_effect(self, temp_db_path: Path) -> None:
        """自定义 db_path 应生效"""
        c = LangfuseClient(db_path=temp_db_path)
        assert c.db_path == temp_db_path
        c.close()

    def test_init_creates_db_file(self, temp_db_path: Path) -> None:
        """离线模式应创建 SQLite 文件"""
        assert not temp_db_path.exists()
        c = LangfuseClient(db_path=temp_db_path)
        # _init_db 应已创建文件
        assert temp_db_path.exists()
        c.close()

    def test_init_creates_tables(self, temp_db_path: Path) -> None:
        """初始化应创建 traces / spans / events 三张表"""
        c = LangfuseClient(db_path=temp_db_path)
        conn = sqlite3.connect(str(temp_db_path))
        cur = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        )
        tables = {row[0] for row in cur.fetchall()}
        conn.close()
        c.close()
        assert "traces" in tables
        assert "spans" in tables
        assert "events" in tables


# ============================================================================
# 2. trace 上下文管理器测试
# ============================================================================


class TestTraceContext:
    """trace 上下文管理器测试"""

    def test_trace_creates_record_in_db(self, client: LangfuseClient) -> None:
        """trace 退出后应在 SQLite 中留下记录"""
        with client.trace("test_trace", {"key": "value"}):
            pass
        # 查询 SQLite
        conn = sqlite3.connect(str(client.db_path))
        cur = conn.execute("SELECT name, attributes_json FROM traces")
        rows = cur.fetchall()
        conn.close()
        assert len(rows) == 1
        assert rows[0][0] == "test_trace"

    def test_trace_returns_context_with_id(self, client: LangfuseClient) -> None:
        """trace() 应返回带 trace_id 的 TraceContext"""
        with client.trace("test") as ctx:
            assert isinstance(ctx, TraceContext)
            assert len(ctx.trace_id) > 0
            assert ctx.name == "test"

    def test_trace_attributes_preserved(self, client: LangfuseClient) -> None:
        """trace 的 attributes 应完整落盘"""
        attrs = {"agent": "main", "version": "1.0", "nested": {"a": 1}}
        with client.trace("attr_test", attrs):
            pass
        conn = sqlite3.connect(str(client.db_path))
        cur = conn.execute("SELECT attributes_json FROM traces WHERE name='attr_test'")
        row = cur.fetchone()
        conn.close()
        import json
        saved_attrs = json.loads(row[0])
        assert saved_attrs["agent"] == "main"
        assert saved_attrs["version"] == "1.0"
        assert saved_attrs["nested"]["a"] == 1

    def test_trace_duration_ms_positive(self, client: LangfuseClient) -> None:
        """trace 退出后 duration_ms 应为正值"""
        import time as _time
        with client.trace("duration_test"):
            _time.sleep(0.01)  # 10ms
        conn = sqlite3.connect(str(client.db_path))
        cur = conn.execute("SELECT duration_ms FROM traces WHERE name='duration_test'")
        row = cur.fetchone()
        conn.close()
        assert row[0] > 0


# ============================================================================
# 3. span 上下文管理器测试
# ============================================================================


class TestSpanContext:
    """span 上下文管理器测试"""

    def test_standalone_span_creates_record(self, client: LangfuseClient) -> None:
        """独立 span（无父 trace）也应落盘"""
        with client.span("standalone_span"):
            pass
        conn = sqlite3.connect(str(client.db_path))
        cur = conn.execute("SELECT name FROM spans")
        rows = cur.fetchall()
        conn.close()
        assert len(rows) == 1
        assert rows[0][0] == "standalone_span"

    def test_nested_span_in_trace(self, client: LangfuseClient) -> None:
        """trace 内嵌套 span 应正确关联 trace_id"""
        with client.trace("parent_trace") as tctx:
            with tctx.span("child_span"):
                pass
        conn = sqlite3.connect(str(client.db_path))
        cur = conn.execute(
            "SELECT trace_id FROM spans WHERE name='child_span'"
        )
        row = cur.fetchone()
        conn.close()
        assert row is not None
        # span.trace_id 应等于 parent_trace 的 id
        cur2 = sqlite3.connect(str(client.db_path)).execute(
            "SELECT id FROM traces WHERE name='parent_trace'"
        )
        trace_row = cur2.fetchone()
        assert row[0] == trace_row[0]

    def test_nested_child_span(self, client: LangfuseClient) -> None:
        """span 内嵌套子 span 应正确关联 parent_span_id"""
        with client.span("parent_span") as parent:
            with parent.span("child_span"):
                pass
        conn = sqlite3.connect(str(client.db_path))
        cur = conn.execute(
            "SELECT parent_span_id FROM spans WHERE name='child_span'"
        )
        child_row = cur.fetchone()
        cur = conn.execute(
            "SELECT id FROM spans WHERE name='parent_span'"
        )
        parent_row = cur.fetchone()
        conn.close()
        assert child_row[0] == parent_row[0]


# ============================================================================
# 4. event 记录测试
# ============================================================================


class TestEvent:
    """event 记录测试"""

    def test_standalone_event_creates_record(self, client: LangfuseClient) -> None:
        """独立 event 应落盘"""
        client.event("startup", {"version": "1.0"})
        conn = sqlite3.connect(str(client.db_path))
        cur = conn.execute("SELECT name FROM events")
        rows = cur.fetchall()
        conn.close()
        assert len(rows) == 1
        assert rows[0][0] == "startup"

    def test_event_in_trace(self, client: LangfuseClient) -> None:
        """trace 内 event 应关联 trace_id"""
        with client.trace("trace_with_event") as tctx:
            tctx.event("in_trace_event", {"k": "v"})
        conn = sqlite3.connect(str(client.db_path))
        cur = conn.execute(
            "SELECT trace_id FROM events WHERE name='in_trace_event'"
        )
        event_row = cur.fetchone()
        cur = conn.execute("SELECT id FROM traces WHERE name='trace_with_event'")
        trace_row = cur.fetchone()
        conn.close()
        assert event_row[0] == trace_row[0]

    def test_event_in_span(self, client: LangfuseClient) -> None:
        """span 内 event 应关联 span_id"""
        with client.span("span_with_event") as sctx:
            sctx.event("in_span_event")
        conn = sqlite3.connect(str(client.db_path))
        cur = conn.execute("SELECT span_id FROM events WHERE name='in_span_event'")
        event_row = cur.fetchone()
        cur = conn.execute("SELECT id FROM spans WHERE name='span_with_event'")
        span_row = cur.fetchone()
        conn.close()
        assert event_row[0] == span_row[0]


# ============================================================================
# 5. flush 与 stats 测试
# ============================================================================


class TestFlushAndStats:
    """flush 与 stats 测试"""

    def test_stats_returns_correct_counts(self, client: LangfuseClient) -> None:
        """stats 应返回正确的统计计数"""
        # 初始状态：全 0
        stats = client.stats()
        assert stats["db"]["traces"] == 0
        assert stats["db"]["spans"] == 0
        assert stats["db"]["events"] == 0

        # 写入 1 trace + 1 span + 1 event
        with client.trace("t1"):
            client.event("e1")
        with client.span("s1"):
            pass

        stats = client.stats()
        assert stats["db"]["traces"] == 1
        assert stats["db"]["spans"] == 1
        assert stats["db"]["events"] == 1

    def test_stats_returns_offline_flag(self, client: LangfuseClient) -> None:
        """stats 应返回 offline 标志"""
        stats = client.stats()
        assert stats["offline"] is True
        assert stats["db_path"] == str(client.db_path)

    def test_manual_flush_writes_buffered_data(
        self, manual_client: LangfuseClient
    ) -> None:
        """auto_flush=False 时手动 flush 应落盘"""
        # 写入 2 个 event（应进入缓冲，不落盘）
        manual_client.event("e1")
        manual_client.event("e2")
        # 缓冲应有 2 条
        assert len(manual_client._buffer_events) == 2
        # 数据库应为 0
        conn = sqlite3.connect(str(manual_client.db_path))
        cur = conn.execute("SELECT COUNT(*) FROM events")
        assert cur.fetchone()[0] == 0
        conn.close()
        # flush 后应落盘
        manual_client.flush()
        conn = sqlite3.connect(str(manual_client.db_path))
        cur = conn.execute("SELECT COUNT(*) FROM events")
        assert cur.fetchone()[0] == 2
        conn.close()
        # 缓冲应清空
        assert len(manual_client._buffer_events) == 0


# ============================================================================
# 6. 单例与重置测试
# ============================================================================


class TestSingleton:
    """get_client / reset_client_for_test 测试"""

    def test_get_client_returns_same_instance(self) -> None:
        """get_client 应返回同一实例"""
        reset_client_for_test()
        c1 = get_client()
        c2 = get_client()
        assert c1 is c2
        c1.close()
        reset_client_for_test()

    def test_reset_clears_singleton(self) -> None:
        """reset_client_for_test 应清空单例"""
        reset_client_for_test()
        c1 = get_client()
        reset_client_for_test()
        c2 = get_client()
        assert c1 is not c2
        c2.close()
        reset_client_for_test()


# ============================================================================
# 7. JSON-RPC 方法注册测试
# ============================================================================


class TestJsonRpcRegistration:
    """JSON-RPC 方法注册测试"""

    class _FakeDispatcher:
        """伪造的 dispatcher，记录注册的方法名"""

        def __init__(self) -> None:
            self.registered: dict[str, callable] = {}

        def register(self, name: str, fn: callable) -> None:
            self.registered[name] = fn

    def test_register_methods_adds_four_methods(self) -> None:
        """register_methods 应注册 4 个 langfuse.* 方法"""
        reset_client_for_test()
        dispatcher = self._FakeDispatcher()
        register_methods(dispatcher)
        assert "langfuse.event" in dispatcher.registered
        assert "langfuse.flush" in dispatcher.registered
        assert "langfuse.stats" in dispatcher.registered
        assert "langfuse.trace" in dispatcher.registered
        assert len(dispatcher.registered) == 4
        reset_client_for_test()

    def test_langfuse_stats_rpc_returns_dict(self) -> None:
        """langfuse.stats RPC 应返回字典"""
        reset_client_for_test()
        dispatcher = self._FakeDispatcher()
        register_methods(dispatcher)
        result = dispatcher.registered["langfuse.stats"]()
        assert isinstance(result, dict)
        assert "offline" in result
        assert "db" in result
        reset_client_for_test()

    def test_langfuse_event_rpc_returns_ok(self) -> None:
        """langfuse.event RPC 应返回 {ok: True}"""
        reset_client_for_test()
        dispatcher = self._FakeDispatcher()
        register_methods(dispatcher)
        result = dispatcher.registered["langfuse.event"]("test_event", {"k": "v"})
        assert result["ok"] is True
        assert result["name"] == "test_event"
        reset_client_for_test()

    def test_langfuse_flush_rpc_returns_ok(self) -> None:
        """langfuse.flush RPC 应返回 {ok: True}"""
        reset_client_for_test()
        dispatcher = self._FakeDispatcher()
        register_methods(dispatcher)
        result = dispatcher.registered["langfuse.flush"]()
        assert result["ok"] is True
        reset_client_for_test()


# ============================================================================
# 8. 边界场景测试
# ============================================================================


class TestEdgeCases:
    """边界场景测试"""

    def test_trace_with_none_attributes(self, client: LangfuseClient) -> None:
        """trace attributes=None 应正常工作"""
        with client.trace("no_attrs", None):
            pass
        conn = sqlite3.connect(str(client.db_path))
        cur = conn.execute("SELECT attributes_json FROM traces WHERE name='no_attrs'")
        row = cur.fetchone()
        conn.close()
        import json
        attrs = json.loads(row[0])
        assert attrs == {}

    def test_event_with_none_attributes(self, client: LangfuseClient) -> None:
        """event attributes=None 应正常工作"""
        client.event("no_attr_event", None)
        conn = sqlite3.connect(str(client.db_path))
        cur = conn.execute(
            "SELECT attributes_json FROM events WHERE name='no_attr_event'"
        )
        row = cur.fetchone()
        conn.close()
        import json
        attrs = json.loads(row[0])
        assert attrs == {}

    def test_close_idempotent(self, temp_db_path: Path) -> None:
        """close 多次调用应安全（不抛异常）"""
        c = LangfuseClient(db_path=temp_db_path)
        c.close()
        c.close()  # 不应抛异常
