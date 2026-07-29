"""
TDSF Project Service — 单一写入器（T-P1-03）
=============================================

职责：
- SQLite WAL 模式初始化（并发读 + 单写）
- 5 个表 CRUD：projects / sessions / messages / tool_calls / decisions
- 写租约（5s 超时，防止并发写冲突，DEC-V321-05）
- 事务支持（BEGIN / COMMIT / ROLLBACK）

设计要点：
- 单一写入器（Single Writer）：所有写操作通过 WriteLease 串行化
- WAL 模式（Write-Ahead Logging）：读不阻塞写，写不阻塞读
- 线程安全：sqlite3.Connection 配 check_same_thread=False，由 WriteLease 保证串行
- 错误码：写租约超时返回 -32002 WriteLeaseTimeout（与 main.py 错误码对齐）

JSON-RPC 方法注册（通过 register_methods 注入到 MethodDispatcher）：
- project.create / project.get / project.list / project.update / project.delete
- session.create / session.get / session.list / session.update
- message.add / message.list / message.update
- tool_call.add / tool_call.list
- decision.add / decision.list
- project.begin / project.commit / project.rollback（事务）

表结构（5 张表）：
- projects:    id, name, path, created_at, updated_at, metadata
- sessions:    id, project_id, title, mode, created_at, updated_at, metadata
- messages:    id, session_id, role, content, created_at, metadata
- tool_calls:  id, session_id, message_id, tool_name, params, result, risk_level, created_at
- decisions:   id, session_id, decision_type, content, risk_level, approved, created_at
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
from pathlib import Path
from typing import Any, Iterator

logger = logging.getLogger("sidecar.project_service")

# ============================================================================
# 常量
# ============================================================================

# 默认数据库路径（优先使用 TDSF_DATA_DIR 环境变量，避免 Tauri dev watcher 循环重启）
DEFAULT_DB_PATH = Path(os.environ.get("TDSF_DATA_DIR", str(Path(__file__).parent / "data"))) / "tdsf.db"

# 写租约超时（5s，DEC-V321-05）
WRITE_LEASE_TIMEOUT = 5.0

# JSON-RPC 错误码：写租约超时（与 main.py 对齐）
ERR_WRITE_LEASE = -32002


# ============================================================================
# 异常类型
# ============================================================================

class ProjectServiceError(Exception):
    """Project Service 基础异常"""

    def __init__(self, message: str, code: int = -32000, data: Any = None):
        self.code = code
        self.data = data
        super().__init__(message)


class WriteLeaseTimeout(ProjectServiceError):
    """写租约超时（并发写冲突）"""

    def __init__(self, timeout: float):
        super().__init__(
            f"write lease timeout after {timeout}s (concurrent write conflict)",
            code=ERR_WRITE_LEASE,
            data={"timeout": timeout, "type": "write_lease_timeout"},
        )


class NotFoundError(ProjectServiceError):
    """资源未找到"""

    def __init__(self, resource: str, id_: str):
        super().__init__(
            f"{resource} not found: {id_}",
            code=-32602,  # Invalid params
            data={"resource": resource, "id": id_},
        )


# ============================================================================
# WriteLease — 写租约（串行化所有写操作）
# ============================================================================

class WriteLease:
    """写租约：串行化所有写操作（DEC-V321-05 单一写入器）

    设计：
    - 基于 threading.Condition 实现超时等待
    - 第一个获取租约的线程立即通过
    - 后续线程等待 5s（WRITE_LEASE_TIMEOUT），超时抛 WriteLeaseTimeout
    - 实现 __enter__ / __exit__ 支持 with 语法

    用法：
        with write_lease:
            cursor.execute("INSERT INTO ...")

    性能：
    - 单写场景：立即获取（无锁竞争）
    - 并发写场景：第二个写者等待 5s 后超时
    - 读操作不获取租约（WAL 模式允许并发读）
    """

    def __init__(self, timeout: float = WRITE_LEASE_TIMEOUT):
        self._timeout = timeout
        self._condition = threading.Condition()
        self._holder: str | None = None  # 持有者标识（线程名 + 时间戳）
        self._acquired_at: float = 0.0
        self._local = threading.local()  # 每线程持有标记，支持同线程重入

    def __enter__(self) -> "WriteLease":
        """获取写租约（带超时）"""
        holder_id = f"{threading.current_thread().name}-{time.time_ns()}"
        with self._condition:
            # 同线程重入（避免单线程内嵌套 with 死锁）
            if self._holder is not None and getattr(self._local, "holds", False):
                self._local.depth = getattr(self._local, "depth", 1) + 1
                return self

            deadline = time.time() + self._timeout
            while self._holder is not None:
                remaining = deadline - time.time()
                if remaining <= 0:
                    logger.warning(
                        f"write lease timeout: holder={self._holder}, "
                        f"waited={self._timeout}s"
                    )
                    raise WriteLeaseTimeout(self._timeout)
                # 等待租约释放（带超时）
                self._condition.wait(timeout=remaining)
            self._holder = holder_id
            self._acquired_at = time.time()
            self._local.holds = True
            self._local.depth = 1
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        """释放写租约"""
        with self._condition:
            # 同线程重入：减少 depth，到 0 才真正释放
            if getattr(self._local, "depth", 0) > 1:
                self._local.depth -= 1
                return

            duration = time.time() - self._acquired_at
            self._holder = None
            self._local.holds = False
            self._local.depth = 0
            self._condition.notify_all()  # 唤醒所有等待者
            if duration > 1.0:
                logger.debug(f"write lease held for {duration:.2f}s")

    @property
    def is_held(self) -> bool:
        """当前是否被持有"""
        with self._condition:
            return self._holder is not None

    @property
    def holder(self) -> str | None:
        """当前持有者标识"""
        with self._condition:
            return self._holder


# ============================================================================
# ProjectService — 核心服务（SQLite + WAL + 5 表 CRUD）
# ============================================================================

class ProjectService:
    """Project Service：单一写入器 + WAL 模式 + 5 表 CRUD

    设计：
    - SQLite WAL 模式：读不阻塞写，写不阻塞读
    - sqlite3.Connection 配 check_same_thread=False，由 WriteLease 保证写串行
    - 表结构见模块顶部注释
    - 所有写操作通过 write_lease 串行化
    - 读操作直接执行（WAL 模式下读不阻塞）

    用法：
        service = ProjectService()  # 使用默认路径
        service.init_db()
        project = service.create_project(name="test", path="/tmp/test")
    """

    def __init__(self, db_path: Path | None = None):
        self.db_path = db_path or DEFAULT_DB_PATH
        self._conn: sqlite3.Connection | None = None
        self._write_lease = WriteLease()
        self._lock = threading.Lock()  # 保护 _conn 创建/关闭

    # ========================================================================
    # 初始化与连接管理
    # ========================================================================

    def init_db(self) -> None:
        """初始化数据库（创建目录 + 连接 + WAL + 建表 + 索引）"""
        # 1. 创建数据目录
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        logger.info(f"initializing project service db: {self.db_path}")

        # 2. 创建连接（check_same_thread=False，由 WriteLease 保证写串行）
        with self._lock:
            if self._conn is not None:
                logger.warning("db already initialized, skip")
                return
            self._conn = sqlite3.connect(
                self.db_path,
                check_same_thread=False,
                isolation_level=None,  # autocommit 模式（事务由 begin/commit 显式管理）
            )
            self._conn.row_factory = sqlite3.Row  # 行工厂，返回 dict-like 对象

        # 3. 启用 WAL 模式（Write-Ahead Logging）
        # WAL 模式优势：
        #   - 读不阻塞写，写不阻塞读
        #   - 崩溃恢复更可靠
        #   - 适合单写多读场景
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")  # 平衡性能与安全
        self._conn.execute("PRAGMA foreign_keys=ON")  # 启用外键约束
        self._conn.execute("PRAGMA busy_timeout=5000")  # 5s 忙等待

        # 4. 创建表
        self._create_tables()

        logger.info("project service initialized (WAL mode, 5 tables)")

    def _create_tables(self) -> None:
        """创建 5 张表（IF NOT EXISTS，幂等）"""
        with self._write_lease:
            cur = self._conn.cursor()
            # projects 表
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS projects (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    path TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    metadata TEXT DEFAULT '{}'
                )
                """
            )
            # sessions 表
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL,
                    title TEXT,
                    mode TEXT DEFAULT 'agent',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    metadata TEXT DEFAULT '{}',
                    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
                )
                """
            )
            # messages 表
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS messages (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
                    content TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    metadata TEXT DEFAULT '{}',
                    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
                )
                """
            )
            # tool_calls 表
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS tool_calls (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    message_id TEXT,
                    tool_name TEXT NOT NULL,
                    params TEXT DEFAULT '{}',
                    result TEXT,
                    risk_level TEXT,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
                    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE SET NULL
                )
                """
            )
            # decisions 表
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS decisions (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    decision_type TEXT NOT NULL,
                    content TEXT NOT NULL,
                    risk_level TEXT,
                    approved INTEGER,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
                )
                """
            )

            # 索引（加速查询）
            cur.execute(
                "CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id)"
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at)"
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id, created_at)"
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS idx_decisions_session ON decisions(session_id, created_at)"
            )

    def close(self) -> None:
        """关闭数据库连接"""
        with self._lock:
            if self._conn is not None:
                self._conn.close()
                self._conn = None
                logger.info("project service db closed")

    @property
    def conn(self) -> sqlite3.Connection:
        """获取数据库连接（init_db 后才能使用）"""
        if self._conn is None:
            raise ProjectServiceError(
                "db not initialized, call init_db() first",
                code=-32603,  # Internal error
            )
        return self._conn

    # ========================================================================
    # 事务支持（T-P1-03.3）
    # ========================================================================

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Cursor]:
        """事务上下文管理器（BEGIN / COMMIT / ROLLBACK）

        设计：
        - 自动获取写租约（事务期间持有，COMMIT/ROLLBACK 后释放）
        - 异常时自动 ROLLBACK
        - 正常退出时自动 COMMIT

        用法：
            with service.transaction() as cur:
                cur.execute("INSERT INTO projects ...")
                cur.execute("INSERT INTO sessions ...")
        """
        with self._write_lease:
            cur = self.conn.cursor()
            cur.execute("BEGIN")
            try:
                yield cur
                cur.execute("COMMIT")
            except Exception:
                cur.execute("ROLLBACK")
                raise

    # ========================================================================
    # projects 表 CRUD
    # ========================================================================

    def create_project(
        self,
        name: str,
        path: str | None = None,
        metadata: dict | None = None,
    ) -> dict:
        """创建项目"""
        project_id = str(uuid.uuid4())
        now = self._now_iso()
        metadata_str = json.dumps(metadata or {}, ensure_ascii=False)

        with self._write_lease:
            cur = self.conn.cursor()
            cur.execute(
                "INSERT INTO projects (id, name, path, created_at, updated_at, metadata) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (project_id, name, path, now, now, metadata_str),
            )
        logger.info(f"created project: id={project_id}, name={name}")
        return self.get_project(project_id)

    def get_project(self, project_id: str) -> dict:
        """获取项目（不存在抛 NotFoundError）"""
        cur = self.conn.cursor()
        cur.execute("SELECT * FROM projects WHERE id = ?", (project_id,))
        row = cur.fetchone()
        if row is None:
            raise NotFoundError("project", project_id)
        return self._row_to_dict(row)

    def list_projects(self, limit: int = 100, offset: int = 0) -> list[dict]:
        """列出项目（按 created_at 倒序）"""
        cur = self.conn.cursor()
        cur.execute(
            "SELECT * FROM projects ORDER BY created_at DESC LIMIT ? OFFSET ?",
            (limit, offset),
        )
        return [self._row_to_dict(row) for row in cur.fetchall()]

    def update_project(
        self,
        project_id: str,
        name: str | None = None,
        path: str | None = None,
        metadata: dict | None = None,
    ) -> dict:
        """更新项目（部分字段更新，仅传需要更新的字段）"""
        # 先检查存在
        existing = self.get_project(project_id)
        now = self._now_iso()
        new_name = name if name is not None else existing["name"]
        new_path = path if path is not None else existing.get("path")
        new_metadata = (
            json.dumps(metadata, ensure_ascii=False)
            if metadata is not None
            else existing.get("metadata_str", "{}")
        )

        with self._write_lease:
            cur = self.conn.cursor()
            cur.execute(
                "UPDATE projects SET name = ?, path = ?, updated_at = ?, metadata = ? "
                "WHERE id = ?",
                (new_name, new_path, now, new_metadata, project_id),
            )
        return self.get_project(project_id)

    def delete_project(self, project_id: str) -> bool:
        """删除项目（级联删除 sessions / messages / tool_calls / decisions）"""
        with self._write_lease:
            cur = self.conn.cursor()
            cur.execute("DELETE FROM projects WHERE id = ?", (project_id,))
            deleted = cur.rowcount > 0
        if deleted:
            logger.info(f"deleted project: {project_id}")
        return deleted

    # ========================================================================
    # sessions 表 CRUD
    # ========================================================================

    def create_session(
        self,
        project_id: str,
        title: str | None = None,
        mode: str = "agent",
        metadata: dict | None = None,
    ) -> dict:
        """创建会话"""
        # 验证 project 存在
        self.get_project(project_id)

        session_id = str(uuid.uuid4())
        now = self._now_iso()
        metadata_str = json.dumps(metadata or {}, ensure_ascii=False)

        with self._write_lease:
            cur = self.conn.cursor()
            cur.execute(
                "INSERT INTO sessions (id, project_id, title, mode, created_at, updated_at, metadata) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (session_id, project_id, title, mode, now, now, metadata_str),
            )
        logger.info(f"created session: id={session_id}, project={project_id}")
        return self.get_session(session_id)

    def get_session(self, session_id: str) -> dict:
        """获取会话"""
        cur = self.conn.cursor()
        cur.execute("SELECT * FROM sessions WHERE id = ?", (session_id,))
        row = cur.fetchone()
        if row is None:
            raise NotFoundError("session", session_id)
        return self._row_to_dict(row)

    def list_sessions(
        self,
        project_id: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[dict]:
        """列出会话（可按 project_id 过滤）"""
        cur = self.conn.cursor()
        if project_id is not None:
            cur.execute(
                "SELECT * FROM sessions WHERE project_id = ? "
                "ORDER BY created_at DESC LIMIT ? OFFSET ?",
                (project_id, limit, offset),
            )
        else:
            cur.execute(
                "SELECT * FROM sessions ORDER BY created_at DESC LIMIT ? OFFSET ?",
                (limit, offset),
            )
        return [self._row_to_dict(row) for row in cur.fetchall()]

    def update_session(
        self,
        session_id: str,
        title: str | None = None,
        mode: str | None = None,
        metadata: dict | None = None,
    ) -> dict:
        """更新会话"""
        existing = self.get_session(session_id)
        now = self._now_iso()
        new_title = title if title is not None else existing.get("title")
        new_mode = mode if mode is not None else existing.get("mode", "agent")
        new_metadata = (
            json.dumps(metadata, ensure_ascii=False)
            if metadata is not None
            else existing.get("metadata_str", "{}")
        )

        with self._write_lease:
            cur = self.conn.cursor()
            cur.execute(
                "UPDATE sessions SET title = ?, mode = ?, updated_at = ?, metadata = ? "
                "WHERE id = ?",
                (new_title, new_mode, now, new_metadata, session_id),
            )
        return self.get_session(session_id)

    # ========================================================================
    # messages 表 CRUD
    # ========================================================================

    def add_message(
        self,
        session_id: str,
        role: str,
        content: str,
        metadata: dict | None = None,
    ) -> dict:
        """添加消息

        Args:
            session_id: 会话 ID
            role: 角色（user / assistant / system / tool）
            content: 消息内容
            metadata: 附加元数据（如 thinking / tool_call_id 等）
        """
        # 验证 session 存在
        self.get_session(session_id)

        if role not in ("user", "assistant", "system", "tool"):
            raise ProjectServiceError(
                f"invalid role: {role}, must be one of user/assistant/system/tool",
                code=-32602,
            )

        message_id = str(uuid.uuid4())
        now = self._now_iso()
        metadata_str = json.dumps(metadata or {}, ensure_ascii=False)

        with self._write_lease:
            cur = self.conn.cursor()
            cur.execute(
                "INSERT INTO messages (id, session_id, role, content, created_at, metadata) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (message_id, session_id, role, content, now, metadata_str),
            )
        return self.get_message(message_id)

    def get_message(self, message_id: str) -> dict:
        """获取消息"""
        cur = self.conn.cursor()
        cur.execute("SELECT * FROM messages WHERE id = ?", (message_id,))
        row = cur.fetchone()
        if row is None:
            raise NotFoundError("message", message_id)
        return self._row_to_dict(row)

    def list_messages(
        self,
        session_id: str,
        limit: int = 100,
        offset: int = 0,
        order: str = "asc",
    ) -> list[dict]:
        """列出会话消息（按时间排序）"""
        order_clause = "ASC" if order == "asc" else "DESC"
        cur = self.conn.cursor()
        cur.execute(
            f"SELECT * FROM messages WHERE session_id = ? "
            f"ORDER BY created_at {order_clause} LIMIT ? OFFSET ?",
            (session_id, limit, offset),
        )
        return [self._row_to_dict(row) for row in cur.fetchall()]

    def update_message(
        self,
        message_id: str,
        content: str | None = None,
        metadata: dict | None = None,
    ) -> dict:
        """更新消息内容"""
        existing = self.get_message(message_id)
        new_content = content if content is not None else existing["content"]
        new_metadata = (
            json.dumps(metadata, ensure_ascii=False)
            if metadata is not None
            else existing.get("metadata_str", "{}")
        )

        with self._write_lease:
            cur = self.conn.cursor()
            cur.execute(
                "UPDATE messages SET content = ?, metadata = ? WHERE id = ?",
                (new_content, new_metadata, message_id),
            )
        return self.get_message(message_id)

    # ========================================================================
    # tool_calls 表 CRUD
    # ========================================================================

    def add_tool_call(
        self,
        session_id: str,
        tool_name: str,
        params: dict | None = None,
        result: Any | None = None,
        message_id: str | None = None,
        risk_level: str | None = None,
    ) -> dict:
        """添加工具调用记录"""
        # 验证 session 存在
        self.get_session(session_id)

        tool_call_id = str(uuid.uuid4())
        now = self._now_iso()
        params_str = json.dumps(params or {}, ensure_ascii=False)
        result_str = (
            json.dumps(result, ensure_ascii=False) if result is not None else None
        )

        with self._write_lease:
            cur = self.conn.cursor()
            cur.execute(
                "INSERT INTO tool_calls "
                "(id, session_id, message_id, tool_name, params, result, risk_level, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    tool_call_id,
                    session_id,
                    message_id,
                    tool_name,
                    params_str,
                    result_str,
                    risk_level,
                    now,
                ),
            )
        return self.get_tool_call(tool_call_id)

    def get_tool_call(self, tool_call_id: str) -> dict:
        """获取工具调用记录"""
        cur = self.conn.cursor()
        cur.execute("SELECT * FROM tool_calls WHERE id = ?", (tool_call_id,))
        row = cur.fetchone()
        if row is None:
            raise NotFoundError("tool_call", tool_call_id)
        return self._row_to_dict(row)

    def list_tool_calls(
        self,
        session_id: str,
        limit: int = 100,
        offset: int = 0,
    ) -> list[dict]:
        """列出会话的工具调用记录"""
        cur = self.conn.cursor()
        cur.execute(
            "SELECT * FROM tool_calls WHERE session_id = ? "
            "ORDER BY created_at ASC LIMIT ? OFFSET ?",
            (session_id, limit, offset),
        )
        return [self._row_to_dict(row) for row in cur.fetchall()]

    # ========================================================================
    # decisions 表 CRUD
    # ========================================================================

    def add_decision(
        self,
        session_id: str,
        decision_type: str,
        content: str,
        risk_level: str | None = None,
        approved: bool | None = None,
    ) -> dict:
        """添加决策记录

        Args:
            session_id: 会话 ID
            decision_type: 决策类型（如 "command_exec" / "file_edit" / "agent_route"）
            content: 决策内容（命令字符串 / 文件路径 / 路由目标等）
            risk_level: 风险等级（L0-L4）
            approved: 是否被用户批准（None 表示待批准）
        """
        self.get_session(session_id)

        decision_id = str(uuid.uuid4())
        now = self._now_iso()
        approved_int = int(approved) if approved is not None else None

        with self._write_lease:
            cur = self.conn.cursor()
            cur.execute(
                "INSERT INTO decisions "
                "(id, session_id, decision_type, content, risk_level, approved, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    decision_id,
                    session_id,
                    decision_type,
                    content,
                    risk_level,
                    approved_int,
                    now,
                ),
            )
        return self.get_decision(decision_id)

    def get_decision(self, decision_id: str) -> dict:
        """获取决策记录"""
        cur = self.conn.cursor()
        cur.execute("SELECT * FROM decisions WHERE id = ?", (decision_id,))
        row = cur.fetchone()
        if row is None:
            raise NotFoundError("decision", decision_id)
        return self._row_to_dict(row)

    def list_decisions(
        self,
        session_id: str,
        limit: int = 100,
        offset: int = 0,
    ) -> list[dict]:
        """列出会话的决策记录"""
        cur = self.conn.cursor()
        cur.execute(
            "SELECT * FROM decisions WHERE session_id = ? "
            "ORDER BY created_at ASC LIMIT ? OFFSET ?",
            (session_id, limit, offset),
        )
        return [self._row_to_dict(row) for row in cur.fetchall()]

    def update_decision(
        self,
        decision_id: str,
        approved: bool | None = None,
        risk_level: str | None = None,
    ) -> dict:
        """更新决策记录（如用户批准/拒绝审批）"""
        existing = self.get_decision(decision_id)
        new_approved = (
            int(approved) if approved is not None else existing.get("approved_int")
        )
        new_risk = (
            risk_level if risk_level is not None else existing.get("risk_level")
        )

        with self._write_lease:
            cur = self.conn.cursor()
            cur.execute(
                "UPDATE decisions SET approved = ?, risk_level = ? WHERE id = ?",
                (new_approved, new_risk, decision_id),
            )
        return self.get_decision(decision_id)

    # ========================================================================
    # 辅助函数
    # ========================================================================

    @staticmethod
    def _now_iso() -> str:
        """当前时间 ISO 8601 字符串（UTC）"""
        from datetime import datetime, timezone

        return datetime.now(timezone.utc).isoformat(timespec="seconds")

    @staticmethod
    def _row_to_dict(row: sqlite3.Row) -> dict:
        """sqlite3.Row 转 dict，并解析 JSON 字段"""
        d = dict(row)
        # 解析 JSON 字段（metadata / params / result）
        for key in ("metadata", "params", "result"):
            if key in d and isinstance(d[key], str):
                try:
                    d[key] = json.loads(d[key])
                except json.JSONDecodeError:
                    pass  # 保留原始字符串
        # approved 字段：int → bool
        if "approved" in d and d["approved"] is not None:
            d["approved"] = bool(d["approved"])
        return d


# ============================================================================
# 全局实例（单例，由 main.py 注册到 MethodDispatcher）
# ============================================================================

_global_service: ProjectService | None = None


def get_global_service() -> ProjectService:
    """获取全局 ProjectService 实例（单例）"""
    global _global_service
    if _global_service is None:
        _global_service = ProjectService()
        _global_service.init_db()
    return _global_service


# ============================================================================
# JSON-RPC 方法注册（注入到 MethodDispatcher）
# ============================================================================

def register_methods(dispatcher: Any) -> None:
    """将 ProjectService 方法注册到 JSON-RPC MethodDispatcher

    注册的方法：
    - project.create / project.get / project.list / project.update / project.delete
    - session.create / session.get / session.list / session.update
    - message.add / message.list / message.update
    - tool_call.add / tool_call.list
    - decision.add / decision.list / decision.update
    """
    service = get_global_service()

    # === projects ===
    dispatcher.register("project.create", lambda **kw: service.create_project(**kw))
    dispatcher.register("project.get", lambda id: service.get_project(id))
    dispatcher.register("project.list", lambda **kw: service.list_projects(**kw))
    dispatcher.register("project.update", lambda id, **kw: service.update_project(id, **kw))
    dispatcher.register("project.delete", lambda id: service.delete_project(id))

    # === sessions ===
    dispatcher.register("session.create", lambda **kw: service.create_session(**kw))
    dispatcher.register("session.get", lambda id: service.get_session(id))
    dispatcher.register("session.list", lambda **kw: service.list_sessions(**kw))
    dispatcher.register("session.update", lambda id, **kw: service.update_session(id, **kw))

    # === messages ===
    dispatcher.register("message.add", lambda **kw: service.add_message(**kw))
    dispatcher.register("message.list", lambda **kw: service.list_messages(**kw))
    dispatcher.register("message.update", lambda id, **kw: service.update_message(id, **kw))

    # === tool_calls ===
    dispatcher.register("tool_call.add", lambda **kw: service.add_tool_call(**kw))
    dispatcher.register("tool_call.list", lambda **kw: service.list_tool_calls(**kw))

    # === decisions ===
    dispatcher.register("decision.add", lambda **kw: service.add_decision(**kw))
    dispatcher.register("decision.list", lambda **kw: service.list_decisions(**kw))
    dispatcher.register("decision.update", lambda id, **kw: service.update_decision(id, **kw))

    logger.info(
        f"registered {17} project_service methods: "
        f"project.create/get/list/update/delete, "
        f"session.create/get/list/update, "
        f"message.add/list/update, "
        f"tool_call.add/list, "
        f"decision.add/list/update"
    )
