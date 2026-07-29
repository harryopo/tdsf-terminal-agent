"""
tests/test_agent_identity.py — AgentIdentity 单元测试（T-P4-09）
===================================================================

验证内容：
1. 初始化
   - 默认内存模式（db_path=None）
   - SQLite 模式（db_path=路径）
2. save - 参数校验
   - agent_name / session_id 必填
   - state 必须为 dict
3. save - 内存模式
   - 单条保存
   - 多条保存
   - 覆盖更新（同 session + agent 多次 save）
4. save - SQLite 模式
   - 单条保存
   - 多 agent 同 session
   - 跨 session 隔离
5. restore - 内存模式
   - 不存在的 session 返回 ok=False
   - 单 agent 恢复
   - 多 agent 恢复
6. restore - SQLite 模式
   - 同上
7. list_sessions
   - 内存模式
   - SQLite 模式
   - 按最后更新时间排序
8. delete_session
9. 全局单例 get_global_identity / reset_for_test
10. close 关闭 SQLite 连接

运行：
    cd python-sidecar
    python -m pytest tests/test_agent_identity.py -v
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

# 确保能 import agent_identity 模块
sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

from agent_identity import (
    AgentIdentity,
    get_global_identity,
    reset_for_test,
)


# ============================================================================
# Fixture
# ============================================================================

@pytest.fixture
def memory_identity() -> AgentIdentity:
    """内存模式 AgentIdentity（每个测试独立实例）"""
    return AgentIdentity(db_path=None)


@pytest.fixture
def sqlite_identity() -> AgentIdentity:
    """SQLite 模式 AgentIdentity（临时文件，测试后自动清理）"""
    tmpdir = tempfile.mkdtemp(prefix="tdsf-agent-identity-test-")
    db_path = os.path.join(tmpdir, "test_agent_states.db")
    ident = AgentIdentity(db_path=db_path)
    yield ident
    ident.close()
    # 清理临时目录
    try:
        import shutil
        shutil.rmtree(tmpdir, ignore_errors=True)
    except Exception:
        pass


@pytest.fixture(autouse=True)
def reset_global():
    """每个测试前后重置全局单例"""
    reset_for_test()
    yield
    reset_for_test()


# ============================================================================
# 1. 初始化测试
# ============================================================================

class TestInit:
    """AgentIdentity 初始化测试"""

    def test_memory_mode_default(self) -> None:
        """默认内存模式"""
        ident = AgentIdentity()
        assert ident.db_path is None
        assert ident._conn is None
        assert ident._memory_store == {}

    def test_sqlite_mode_creates_table(self) -> None:
        """SQLite 模式自动创建表"""
        tmpdir = tempfile.mkdtemp()
        db_path = os.path.join(tmpdir, "test.db")
        try:
            ident = AgentIdentity(db_path=db_path)
            assert ident.db_path == db_path
            assert ident._conn is not None
            # 验证表已创建
            cursor = ident._conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_states'"
            )
            tables = cursor.fetchall()
            assert len(tables) == 1
            assert tables[0][0] == "agent_states"
            ident.close()
        finally:
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)


# ============================================================================
# 2. save - 参数校验
# ============================================================================

class TestSaveValidation:
    """save 方法参数校验"""

    def test_empty_agent_name_raises(self, memory_identity: AgentIdentity) -> None:
        """空 agent_name 抛 ValueError"""
        with pytest.raises(ValueError, match="agent_name must not be empty"):
            memory_identity.save("", "sess-1", {"mood": "idle"})

    def test_empty_session_id_raises(self, memory_identity: AgentIdentity) -> None:
        """空 session_id 抛 ValueError"""
        with pytest.raises(ValueError, match="session_id must not be empty"):
            memory_identity.save("coding", "", {"mood": "idle"})

    def test_non_dict_state_raises(self, memory_identity: AgentIdentity) -> None:
        """非 dict state 抛 ValueError"""
        with pytest.raises(ValueError, match="state must be dict"):
            memory_identity.save("coding", "sess-1", "not a dict")  # type: ignore[arg-type]


# ============================================================================
# 3. save - 内存模式
# ============================================================================

class TestSaveMemory:
    """save 方法内存模式"""

    def test_single_save(self, memory_identity: AgentIdentity) -> None:
        """单条保存"""
        result = memory_identity.save(
            "coding", "sess-1",
            {"mood": "working", "plan": ["step1", "step2"]},
        )
        assert result["ok"] is True
        assert result["agent_name"] == "coding"
        assert result["session_id"] == "sess-1"
        assert "timestamp" in result
        # 内存存储应有 1 条
        assert len(memory_identity._memory_store) == 1

    def test_multiple_save_different_agents(self, memory_identity: AgentIdentity) -> None:
        """同 session 多 agent 保存"""
        memory_identity.save("coding", "sess-1", {"mood": "working"})
        memory_identity.save("explore", "sess-1", {"mood": "thinking"})
        memory_identity.save("teach", "sess-1", {"mood": "done"})
        # 应有 3 条
        assert len(memory_identity._memory_store) == 3

    def test_multiple_save_different_sessions(self, memory_identity: AgentIdentity) -> None:
        """同 agent 跨 session 保存"""
        memory_identity.save("coding", "sess-1", {"mood": "working"})
        memory_identity.save("coding", "sess-2", {"mood": "idle"})
        # 应有 2 条
        assert len(memory_identity._memory_store) == 2


# ============================================================================
# 4. save - SQLite 模式
# ============================================================================

class TestSaveSqlite:
    """save 方法 SQLite 模式"""

    def test_single_save_sqlite(self, sqlite_identity: AgentIdentity) -> None:
        """SQLite 单条保存"""
        result = sqlite_identity.save(
            "coding", "sess-1",
            {"mood": "working", "plan": ["step1"]},
        )
        assert result["ok"] is True
        # 验证数据库有 1 条记录
        cursor = sqlite_identity._conn.execute("SELECT COUNT(*) FROM agent_states")
        count = cursor.fetchone()[0]
        assert count == 1

    def test_multiple_save_sqlite(self, sqlite_identity: AgentIdentity) -> None:
        """SQLite 多条保存"""
        sqlite_identity.save("coding", "sess-1", {"mood": "working"})
        sqlite_identity.save("explore", "sess-1", {"mood": "thinking"})
        sqlite_identity.save("teach", "sess-2", {"mood": "done"})
        cursor = sqlite_identity._conn.execute("SELECT COUNT(*) FROM agent_states")
        count = cursor.fetchone()[0]
        assert count == 3


# ============================================================================
# 5. restore - 内存模式
# ============================================================================

class TestRestoreMemory:
    """restore 方法内存模式"""

    def test_restore_nonexistent_session(self, memory_identity: AgentIdentity) -> None:
        """不存在的 session 返回 ok=False"""
        result = memory_identity.restore("nonexistent")
        assert result["ok"] is False
        assert result["restored_count"] == 0
        assert result["states"] == {}

    def test_restore_single_agent(self, memory_identity: AgentIdentity) -> None:
        """恢复单 agent"""
        memory_identity.save(
            "coding", "sess-1",
            {"mood": "working", "plan": ["step1"]},
        )
        result = memory_identity.restore("sess-1")
        assert result["ok"] is True
        assert result["restored_count"] == 1
        assert "coding" in result["states"]
        assert result["states"]["coding"]["mood"] == "working"
        assert result["states"]["coding"]["plan"] == ["step1"]

    def test_restore_multiple_agents(self, memory_identity: AgentIdentity) -> None:
        """恢复多 agent"""
        memory_identity.save("coding", "sess-1", {"mood": "working"})
        memory_identity.save("explore", "sess-1", {"mood": "thinking"})
        memory_identity.save("teach", "sess-1", {"mood": "done"})
        result = memory_identity.restore("sess-1")
        assert result["ok"] is True
        assert result["restored_count"] == 3
        assert set(result["states"].keys()) == {"coding", "explore", "teach"}

    def test_restore_session_isolation(self, memory_identity: AgentIdentity) -> None:
        """不同 session 之间隔离"""
        memory_identity.save("coding", "sess-1", {"mood": "working"})
        memory_identity.save("coding", "sess-2", {"mood": "idle"})
        result1 = memory_identity.restore("sess-1")
        result2 = memory_identity.restore("sess-2")
        assert result1["states"]["coding"]["mood"] == "working"
        assert result2["states"]["coding"]["mood"] == "idle"

    def test_restore_empty_session_id_raises(self, memory_identity: AgentIdentity) -> None:
        """空 session_id 抛 ValueError"""
        with pytest.raises(ValueError, match="session_id must not be empty"):
            memory_identity.restore("")


# ============================================================================
# 6. restore - SQLite 模式
# ============================================================================

class TestRestoreSqlite:
    """restore 方法 SQLite 模式"""

    def test_restore_single_agent_sqlite(self, sqlite_identity: AgentIdentity) -> None:
        """SQLite 恢复单 agent"""
        sqlite_identity.save(
            "coding", "sess-1",
            {"mood": "working", "plan": ["step1"]},
        )
        result = sqlite_identity.restore("sess-1")
        assert result["ok"] is True
        assert result["restored_count"] == 1
        assert "coding" in result["states"]
        assert result["states"]["coding"]["mood"] == "working"

    def test_restore_multiple_agents_sqlite(self, sqlite_identity: AgentIdentity) -> None:
        """SQLite 恢复多 agent"""
        sqlite_identity.save("coding", "sess-1", {"mood": "working"})
        sqlite_identity.save("explore", "sess-1", {"mood": "thinking"})
        sqlite_identity.save("teach", "sess-1", {"mood": "done"})
        result = sqlite_identity.restore("sess-1")
        assert result["ok"] is True
        assert result["restored_count"] == 3

    def test_restore_nonexistent_sqlite(self, sqlite_identity: AgentIdentity) -> None:
        """SQLite 不存在的 session"""
        result = sqlite_identity.restore("nonexistent")
        assert result["ok"] is False
        assert result["restored_count"] == 0


# ============================================================================
# 7. list_sessions
# ============================================================================

class TestListSessions:
    """list_sessions 方法"""

    def test_empty_memory(self, memory_identity: AgentIdentity) -> None:
        """内存模式无数据"""
        sessions = memory_identity.list_sessions()
        assert sessions == []

    def test_memory_multiple_sessions(self, memory_identity: AgentIdentity) -> None:
        """内存模式多 session 列表"""
        memory_identity.save("coding", "sess-1", {"mood": "working"})
        memory_identity.save("explore", "sess-1", {"mood": "thinking"})
        memory_identity.save("teach", "sess-2", {"mood": "done"})
        sessions = memory_identity.list_sessions()
        assert len(sessions) == 2
        # 验证字段
        for s in sessions:
            assert "session_id" in s
            assert "agent_count" in s
            assert "last_updated" in s
        # sess-1 应有 2 个 agent
        sess1 = next(s for s in sessions if s["session_id"] == "sess-1")
        assert sess1["agent_count"] == 2

    def test_sqlite_multiple_sessions(self, sqlite_identity: AgentIdentity) -> None:
        """SQLite 模式多 session 列表"""
        sqlite_identity.save("coding", "sess-1", {"mood": "working"})
        sqlite_identity.save("explore", "sess-1", {"mood": "thinking"})
        sqlite_identity.save("teach", "sess-2", {"mood": "done"})
        sessions = sqlite_identity.list_sessions()
        assert len(sessions) == 2
        # sess-1 应有 2 个 agent
        sess1 = next(s for s in sessions if s["session_id"] == "sess-1")
        assert sess1["agent_count"] == 2

    def test_sorted_by_last_updated(self, memory_identity: AgentIdentity) -> None:
        """按最后更新时间倒序排序"""
        memory_identity.save("coding", "sess-old", {"mood": "idle"})
        memory_identity.save("coding", "sess-new", {"mood": "working"})
        sessions = memory_identity.list_sessions()
        # sess-new 应排在 sess-old 之前（last_updated 更大）
        assert sessions[0]["session_id"] == "sess-new"
        assert sessions[1]["session_id"] == "sess-old"


# ============================================================================
# 8. delete_session
# ============================================================================

class TestDeleteSession:
    """delete_session 方法"""

    def test_delete_memory(self, memory_identity: AgentIdentity) -> None:
        """内存模式删除 session"""
        memory_identity.save("coding", "sess-1", {"mood": "working"})
        memory_identity.save("explore", "sess-1", {"mood": "thinking"})
        memory_identity.save("teach", "sess-2", {"mood": "done"})
        deleted = memory_identity.delete_session("sess-1")
        assert deleted == 2
        # 验证 sess-1 已被删除
        assert memory_identity.restore("sess-1")["ok"] is False
        # sess-2 仍在
        assert memory_identity.restore("sess-2")["ok"] is True

    def test_delete_sqlite(self, sqlite_identity: AgentIdentity) -> None:
        """SQLite 模式删除 session"""
        sqlite_identity.save("coding", "sess-1", {"mood": "working"})
        sqlite_identity.save("explore", "sess-1", {"mood": "thinking"})
        sqlite_identity.save("teach", "sess-2", {"mood": "done"})
        deleted = sqlite_identity.delete_session("sess-1")
        assert deleted == 2
        assert sqlite_identity.restore("sess-1")["ok"] is False
        assert sqlite_identity.restore("sess-2")["ok"] is True

    def test_delete_nonexistent_session(self, memory_identity: AgentIdentity) -> None:
        """删除不存在的 session 返回 0"""
        deleted = memory_identity.delete_session("nonexistent")
        assert deleted == 0

    def test_delete_empty_session_id_raises(self, memory_identity: AgentIdentity) -> None:
        """空 session_id 抛 ValueError"""
        with pytest.raises(ValueError, match="session_id must not be empty"):
            memory_identity.delete_session("")


# ============================================================================
# 9. 全局单例
# ============================================================================

class TestGlobalIdentity:
    """全局单例测试"""

    def test_get_global_identity_returns_singleton(self) -> None:
        """get_global_identity 返回单例"""
        ident1 = get_global_identity()
        ident2 = get_global_identity()
        assert ident1 is ident2
        assert isinstance(ident1, AgentIdentity)

    def test_reset_for_test_clears_singleton(self) -> None:
        """reset_for_test 清空单例"""
        ident1 = get_global_identity()
        reset_for_test()
        ident2 = get_global_identity()
        assert ident1 is not ident2


# ============================================================================
# 10. close
# ============================================================================

class TestClose:
    """close 方法"""

    def test_close_sqlite_connection(self) -> None:
        """close 关闭 SQLite 连接"""
        tmpdir = tempfile.mkdtemp()
        db_path = os.path.join(tmpdir, "test.db")
        try:
            ident = AgentIdentity(db_path=db_path)
            assert ident._conn is not None
            ident.close()
            assert ident._conn is None
            # 二次 close 不报错
            ident.close()
        finally:
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_close_memory_noop(self, memory_identity: AgentIdentity) -> None:
        """close 对内存模式无操作"""
        memory_identity.close()
        # 不应报错，也不影响内存存储
        assert memory_identity._conn is None
