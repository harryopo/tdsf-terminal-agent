"""
test_project_service.py — Project Service 单元测试（T-P1-03）

覆盖：
- SQLite WAL 模式初始化
- 5 表 CRUD（projects / sessions / messages / tool_calls / decisions）
- 写租约（并发写串行化）
- 事务（BEGIN / COMMIT / ROLLBACK）
- NotFoundError / WriteLeaseTimeout 异常
"""
from __future__ import annotations

import threading
import time
from pathlib import Path

import pytest

from project_service import (
    DEFAULT_DB_PATH,
    NotFoundError,
    ProjectService,
    ProjectServiceError,
    WriteLease,
    WriteLeaseTimeout,
    WRITE_LEASE_TIMEOUT,
)


# ============================================================================
# Fixtures
# ============================================================================

@pytest.fixture
def tmp_db(tmp_path: Path) -> Path:
    """临时数据库路径（每个测试独立）"""
    return tmp_path / "test_tdsf.db"


@pytest.fixture
def service(tmp_db: Path) -> ProjectService:
    """已初始化的 ProjectService（每个测试独立实例）"""
    svc = ProjectService(db_path=tmp_db)
    svc.init_db()
    yield svc
    svc.close()


# ============================================================================
# 初始化测试
# ============================================================================

class TestInit:
    def test_init_creates_db_file(self, tmp_db: Path) -> None:
        svc = ProjectService(db_path=tmp_db)
        svc.init_db()
        assert tmp_db.exists()
        svc.close()

    def test_init_creates_data_directory(self, tmp_path: Path) -> None:
        # data/ 目录不存在时应自动创建
        db_path = tmp_path / "subdir" / "tdsf.db"
        svc = ProjectService(db_path=db_path)
        svc.init_db()
        assert db_path.parent.exists()
        svc.close()

    def test_init_idempotent(self, service: ProjectService) -> None:
        # 重复 init_db 不应报错（IF NOT EXISTS 幂等）
        service.init_db()
        service.init_db()

    def test_wal_mode_enabled(self, service: ProjectService) -> None:
        cur = service.conn.cursor()
        cur.execute("PRAGMA journal_mode")
        mode = cur.fetchone()[0]
        assert mode.lower() == "wal"

    def test_conn_not_initialized_raises(self, tmp_db: Path) -> None:
        svc = ProjectService(db_path=tmp_db)
        with pytest.raises(ProjectServiceError, match="not initialized"):
            _ = svc.conn


# ============================================================================
# projects CRUD
# ============================================================================

class TestProjectsCRUD:
    def test_create_project(self, service: ProjectService) -> None:
        p = service.create_project(name="test-project", path="/tmp/test")
        assert p["name"] == "test-project"
        assert p["path"] == "/tmp/test"
        assert "id" in p
        assert "created_at" in p
        assert p["metadata"] == {}

    def test_create_project_with_metadata(self, service: ProjectService) -> None:
        p = service.create_project(
            name="test", metadata={"key": "value", "num": 42}
        )
        assert p["metadata"] == {"key": "value", "num": 42}

    def test_get_project(self, service: ProjectService) -> None:
        created = service.create_project(name="test")
        fetched = service.get_project(created["id"])
        assert fetched["id"] == created["id"]
        assert fetched["name"] == "test"

    def test_get_project_not_found(self, service: ProjectService) -> None:
        with pytest.raises(NotFoundError, match="project not found"):
            service.get_project("nonexistent-id")

    def test_list_projects(self, service: ProjectService) -> None:
        for i in range(3):
            service.create_project(name=f"project-{i}")
        projects = service.list_projects()
        assert len(projects) == 3

    def test_list_projects_pagination(self, service: ProjectService) -> None:
        for i in range(5):
            service.create_project(name=f"project-{i}")
        page1 = service.list_projects(limit=2, offset=0)
        page2 = service.list_projects(limit=2, offset=2)
        assert len(page1) == 2
        assert len(page2) == 2
        # 不同页不重复
        ids1 = {p["id"] for p in page1}
        ids2 = {p["id"] for p in page2}
        assert ids1.isdisjoint(ids2)

    def test_update_project(self, service: ProjectService) -> None:
        p = service.create_project(name="old")
        updated = service.update_project(p["id"], name="new", path="/new/path")
        assert updated["name"] == "new"
        assert updated["path"] == "/new/path"
        assert updated["id"] == p["id"]

    def test_delete_project(self, service: ProjectService) -> None:
        p = service.create_project(name="to-delete")
        assert service.delete_project(p["id"]) is True
        with pytest.raises(NotFoundError):
            service.get_project(p["id"])

    def test_delete_project_not_found(self, service: ProjectService) -> None:
        assert service.delete_project("nonexistent") is False

    def test_delete_project_cascades_sessions(self, service: ProjectService) -> None:
        p = service.create_project(name="test")
        s = service.create_session(project_id=p["id"])
        service.delete_project(p["id"])
        with pytest.raises(NotFoundError):
            service.get_session(s["id"])


# ============================================================================
# sessions CRUD
# ============================================================================

class TestSessionsCRUD:
    def test_create_session(self, service: ProjectService) -> None:
        p = service.create_project(name="test")
        s = service.create_session(project_id=p["id"], title="session-1")
        assert s["project_id"] == p["id"]
        assert s["title"] == "session-1"
        assert s["mode"] == "agent"

    def test_create_session_invalid_project(self, service: ProjectService) -> None:
        with pytest.raises(NotFoundError):
            service.create_session(project_id="nonexistent")

    def test_list_sessions_by_project(self, service: ProjectService) -> None:
        p1 = service.create_project(name="p1")
        p2 = service.create_project(name="p2")
        service.create_session(project_id=p1["id"])
        service.create_session(project_id=p1["id"])
        service.create_session(project_id=p2["id"])

        p1_sessions = service.list_sessions(project_id=p1["id"])
        p2_sessions = service.list_sessions(project_id=p2["id"])
        all_sessions = service.list_sessions()

        assert len(p1_sessions) == 2
        assert len(p2_sessions) == 1
        assert len(all_sessions) == 3

    def test_update_session(self, service: ProjectService) -> None:
        p = service.create_project(name="test")
        s = service.create_session(project_id=p["id"])
        updated = service.update_session(s["id"], title="new-title", mode="plan")
        assert updated["title"] == "new-title"
        assert updated["mode"] == "plan"


# ============================================================================
# messages CRUD
# ============================================================================

class TestMessagesCRUD:
    def test_add_message(self, service: ProjectService) -> None:
        p = service.create_project(name="test")
        s = service.create_session(project_id=p["id"])
        msg = service.add_message(
            session_id=s["id"], role="user", content="hello"
        )
        assert msg["role"] == "user"
        assert msg["content"] == "hello"

    def test_add_message_invalid_role(self, service: ProjectService) -> None:
        p = service.create_project(name="test")
        s = service.create_session(project_id=p["id"])
        with pytest.raises(ProjectServiceError, match="invalid role"):
            service.add_message(session_id=s["id"], role="invalid", content="x")

    def test_list_messages_ordered(self, service: ProjectService) -> None:
        p = service.create_project(name="test")
        s = service.create_session(project_id=p["id"])
        for i in range(5):
            service.add_message(
                session_id=s["id"], role="user", content=f"msg-{i}"
            )
            time.sleep(0.01)  # 确保时间戳不同

        msgs_asc = service.list_messages(s["id"], order="asc")
        msgs_desc = service.list_messages(s["id"], order="desc")

        assert len(msgs_asc) == 5
        assert msgs_asc[0]["content"] == "msg-0"
        assert msgs_desc[0]["content"] == "msg-4"

    def test_update_message(self, service: ProjectService) -> None:
        p = service.create_project(name="test")
        s = service.create_session(project_id=p["id"])
        msg = service.add_message(session_id=s["id"], role="user", content="old")
        updated = service.update_message(msg["id"], content="new content")
        assert updated["content"] == "new content"


# ============================================================================
# tool_calls CRUD
# ============================================================================

class TestToolCallsCRUD:
    def test_add_tool_call(self, service: ProjectService) -> None:
        p = service.create_project(name="test")
        s = service.create_session(project_id=p["id"])
        tc = service.add_tool_call(
            session_id=s["id"],
            tool_name="risk",
            params={"command": "rm -rf /"},
            result={"level": "L4"},
            risk_level="L4",
        )
        assert tc["tool_name"] == "risk"
        assert tc["params"] == {"command": "rm -rf /"}
        assert tc["result"] == {"level": "L4"}
        assert tc["risk_level"] == "L4"

    def test_list_tool_calls(self, service: ProjectService) -> None:
        p = service.create_project(name="test")
        s = service.create_session(project_id=p["id"])
        for tool in ["risk", "confidence", "ground"]:
            service.add_tool_call(session_id=s["id"], tool_name=tool)
        tcs = service.list_tool_calls(s["id"])
        assert len(tcs) == 3


# ============================================================================
# decisions CRUD
# ============================================================================

class TestDecisionsCRUD:
    def test_add_decision(self, service: ProjectService) -> None:
        p = service.create_project(name="test")
        s = service.create_session(project_id=p["id"])
        d = service.add_decision(
            session_id=s["id"],
            decision_type="command_exec",
            content="sudo systemctl restart nginx",
            risk_level="L3",
            approved=None,
        )
        assert d["decision_type"] == "command_exec"
        assert d["risk_level"] == "L3"
        assert d["approved"] is None

    def test_update_decision_approved(self, service: ProjectService) -> None:
        p = service.create_project(name="test")
        s = service.create_session(project_id=p["id"])
        d = service.add_decision(
            session_id=s["id"],
            decision_type="command_exec",
            content="sudo ...",
            approved=None,
        )
        updated = service.update_decision(d["id"], approved=True)
        assert updated["approved"] is True

    def test_list_decisions(self, service: ProjectService) -> None:
        p = service.create_project(name="test")
        s = service.create_session(project_id=p["id"])
        for i in range(3):
            service.add_decision(
                session_id=s["id"],
                decision_type="command_exec",
                content=f"cmd-{i}",
            )
        ds = service.list_decisions(s["id"])
        assert len(ds) == 3


# ============================================================================
# 写租约测试
# ============================================================================

class TestWriteLease:
    def test_write_lease_serializes(self) -> None:
        """两个线程并发写，必须串行化（第二个等待第一个完成）"""
        lease = WriteLease(timeout=2.0)
        execution_order: list[str] = []

        def worker(name: str, hold_time: float) -> None:
            with lease:
                execution_order.append(f"{name}-start")
                time.sleep(hold_time)
                execution_order.append(f"{name}-end")

        t1 = threading.Thread(target=worker, args=("A", 0.1))
        t2 = threading.Thread(target=worker, args=("B", 0.1))
        t1.start()
        time.sleep(0.02)  # 确保 A 先获取
        t2.start()
        t1.join()
        t2.join()

        # 验证串行化：A-start → A-end → B-start → B-end
        assert execution_order == [
            "A-start",
            "A-end",
            "B-start",
            "B-end",
        ], f"expected serialized execution, got {execution_order}"

    def test_write_lease_timeout(self) -> None:
        """第二个写者超时抛 WriteLeaseTimeout"""
        lease = WriteLease(timeout=0.2)  # 200ms 超时
        errors: list[Exception] = []

        def slow_worker() -> None:
            with lease:
                time.sleep(1.0)  # 持有 1s

        def timeout_worker() -> None:
            try:
                with lease:
                    pass
            except WriteLeaseTimeout as e:
                errors.append(e)

        t1 = threading.Thread(target=slow_worker)
        t2 = threading.Thread(target=timeout_worker)
        t1.start()
        time.sleep(0.05)  # 确保 t1 先获取
        t2.start()
        t1.join()
        t2.join()

        assert len(errors) == 1
        assert isinstance(errors[0], WriteLeaseTimeout)
        assert errors[0].code == -32002

    def test_write_lease_release_after_exception(self) -> None:
        """异常时租约应正确释放"""
        lease = WriteLease(timeout=1.0)
        try:
            with lease:
                raise ValueError("test error")
        except ValueError:
            pass

        # 租约应已释放，可以再次获取
        with lease:
            pass


# ============================================================================
# 事务测试
# ============================================================================

class TestTransaction:
    def test_transaction_commit(self, service: ProjectService) -> None:
        with service.transaction() as cur:
            cur.execute(
                "INSERT INTO projects (id, name, path, created_at, updated_at, metadata) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                ("tx-1", "tx-test", None, "2026-01-01T00:00:00+00:00", "2026-01-01T00:00:00+00:00", "{}"),
            )
        # 提交后能查到
        p = service.get_project("tx-1")
        assert p["name"] == "tx-test"

    def test_transaction_rollback(self, service: ProjectService) -> None:
        with pytest.raises(ValueError, match="rollback test"):
            with service.transaction() as cur:
                cur.execute(
                    "INSERT INTO projects (id, name, path, created_at, updated_at, metadata) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    ("tx-rollback", "rollback", None, "2026-01-01T00:00:00+00:00", "2026-01-01T00:00:00+00:00", "{}"),
                )
                raise ValueError("rollback test")

        # 回滚后查不到
        with pytest.raises(NotFoundError):
            service.get_project("tx-rollback")

    def test_transaction_atomic_multiple_writes(self, service: ProjectService) -> None:
        """一个事务内多个写操作要么全部成功要么全部回滚"""
        with pytest.raises(RuntimeError):
            with service.transaction() as cur:
                cur.execute(
                    "INSERT INTO projects (id, name, path, created_at, updated_at, metadata) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    ("atomic-1", "atomic-1", None, "2026-01-01T00:00:00+00:00", "2026-01-01T00:00:00+00:00", "{}"),
                )
                cur.execute(
                    "INSERT INTO projects (id, name, path, created_at, updated_at, metadata) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    ("atomic-2", "atomic-2", None, "2026-01-01T00:00:00+00:00", "2026-01-01T00:00:00+00:00", "{}"),
                )
                raise RuntimeError("force rollback")

        # 两条都应该回滚
        with pytest.raises(NotFoundError):
            service.get_project("atomic-1")
        with pytest.raises(NotFoundError):
            service.get_project("atomic-2")
