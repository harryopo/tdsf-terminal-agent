"""
tools/history.py — 历史案例 CRUD + 检索 MCP tool（T-P1-07.6）
================================================================

实现方案书 4.6 节的历史案例库：
- CRUD（Create / Read / Update / Delete）
- 多维检索（按时间 / 按关键词 / 按 session_id）
- 与 DecisionEngine 集成（提供 HistoryRetrieveCallback 适配器）

spec 要求：
- CRUD 历史记录
- 检索（按时间 / 按关键词 / 按 session）
- 输出：``{"cases": [...], "total": N}``

设计要点：
1. **独立 SQLite 表**：使用 ``history_cases`` 表（与 project_service 的 decisions 表分开，
   因字段结构不同，专门为决策引擎案例库设计）
2. **FTS5 全文检索**：对 ``problem_description`` 建立 FTS5 索引，支持关键词模糊匹配
3. **多维过滤**：支持 session_id / time_range / min_success_rating / max_risk_level 多维过滤
4. **决策引擎适配**：提供 ``make_history_callback`` 函数，返回符合 DecisionEngine
   期望格式的回调

历史案例字段结构：
    {
        "case_id": "case-uuid-001",
        "session_id": "sess-001",          # 关联会话
        "problem_description": "MySQL 服务无法启动",
        "fix_commands": ["systemctl restart mysql"],
        "rollback_commands": ["systemctl stop mysql"],
        "root_cause_description": "InnoDB 锁文件冲突",
        "risk_level": "medium",            # low / medium / high / deny
        "success_rating": 1.0,             # 0.0-1.0，>= 0.8 视为可复用
        "outcome": "success",              # success / failed / partial / aborted
        "target_asset": "demo-mysql",
        "created_at": "2026-07-26T10:30:00",
        "updated_at": "2026-07-26T10:35:00",
        "metadata": {...}                  # 自定义元数据
    }

输入格式（invoke_history_tool）：
    {
        "action": "search" | "add" | "get" | "update" | "delete" | "list",
        # search 参数
        "query": "MySQL 启动失败",
        "session_id": "sess-001",
        "min_success_rating": 0.8,
        "risk_level": "medium",
        "time_from": "2026-07-01T00:00:00",
        "time_to": "2026-07-31T23:59:59",
        "limit": 10,
        # add 参数
        "case": {...}                      # 完整案例对象
    }

输出格式：
    {
        "action": "search",
        "cases": [...],
        "total": N
    }

集成点：
- 被 DecisionEngine 通过 ``make_history_callback`` 调用做历史检索
- 被 LangGraph tool_call 节点调用（tool_name == "history"）
- 被 History Agent 调用做上下文压缩
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

logger = logging.getLogger("sidecar.tools.history")


# ============================================================================
# 常量定义
# ============================================================================

# 默认数据目录（优先使用 TDSF_DATA_DIR 环境变量，避免 Tauri dev watcher 循环重启）
_DATA_DIR: Path = Path(os.environ.get("TDSF_DATA_DIR", str(Path(__file__).parent.parent / "data")))
_DB_PATH: Path = _DATA_DIR / "history.db"

# 默认检索数
_DEFAULT_LIMIT: int = 10
_MAX_LIMIT: int = 100

# 表结构 DDL
_CASES_DDL: str = """
CREATE TABLE IF NOT EXISTS history_cases (
    case_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL DEFAULT '',
    problem_description TEXT NOT NULL,
    fix_commands TEXT NOT NULL DEFAULT '[]',     -- JSON array
    rollback_commands TEXT NOT NULL DEFAULT '[]', -- JSON array
    root_cause_description TEXT NOT NULL DEFAULT '',
    risk_level TEXT NOT NULL DEFAULT 'medium',   -- low/medium/high/deny
    success_rating REAL NOT NULL DEFAULT 0.0,    -- 0.0-1.0
    outcome TEXT NOT NULL DEFAULT 'pending',     -- success/failed/partial/aborted/pending
    target_asset TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}'           -- JSON object
);
"""

# FTS5 全文索引（problem_description + root_cause_description）
_CASES_FTS_DDL: str = """
CREATE VIRTUAL TABLE IF NOT EXISTS history_cases_fts USING fts5(
    case_id UNINDEXED,
    problem_description,
    root_cause_description,
    tokenize = 'unicode61'
);
"""

# 创建索引
_CASES_INDEX_DDL: str = """
CREATE INDEX IF NOT EXISTS idx_history_cases_session ON history_cases(session_id);
CREATE INDEX IF NOT EXISTS idx_history_cases_created ON history_cases(created_at);
CREATE INDEX IF NOT EXISTS idx_history_cases_rating ON history_cases(success_rating);
CREATE INDEX IF NOT EXISTS idx_history_cases_risk ON history_cases(risk_level);
"""


# ============================================================================
# 异常类型
# ============================================================================


class HistoryToolError(Exception):
    """history tool 基础异常"""


# ============================================================================
# 模块级单例
# ============================================================================

_db: sqlite3.Connection | None = None
_db_lock = threading.Lock()


# ============================================================================
# 数据库初始化
# ============================================================================


def _get_db(db_path: Path | None = None) -> sqlite3.Connection:
    """获取 SQLite 历史案例数据库连接（懒加载，线程安全）

    Args:
        db_path: 数据库路径（None 时使用默认路径）

    Returns:
        sqlite3.Connection（表 + 索引 + FTS 已就绪）
    """
    global _db

    if _db is not None:
        return _db

    with _db_lock:
        if _db is not None:
            return _db

        path = db_path or _DB_PATH
        path.parent.mkdir(parents=True, exist_ok=True)

        conn = sqlite3.connect(
            str(path),
            check_same_thread=False,
            isolation_level=None,  # autocommit
        )
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA synchronous=NORMAL;")
        conn.execute("PRAGMA foreign_keys=ON;")
        conn.execute(_CASES_DDL)
        conn.execute(_CASES_FTS_DDL)
        # 执行多语句索引
        conn.executescript(_CASES_INDEX_DDL)
        _db = conn
        logger.info(f"history SQLite ready at {path}")

    return _db


def reset_db() -> None:
    """重置数据库连接（用于测试）"""
    global _db
    with _db_lock:
        if _db is not None:
            _db.close()
            _db = None
    logger.info("reset_db: closed history SQLite connection")


# ============================================================================
# 内部工具函数
# ============================================================================


def _now_iso() -> str:
    """当前 UTC 时间的 ISO 8601 字符串"""
    return datetime.now(timezone.utc).isoformat()


def _parse_json_array(s: str) -> list[str]:
    """解析 JSON 数组字符串，失败返回空列表"""
    if not s:
        return []
    try:
        result = json.loads(s)
        if isinstance(result, list):
            return [str(x) for x in result]
    except (json.JSONDecodeError, ValueError):
        pass
    return []


def _parse_json_object(s: str) -> dict[str, Any]:
    """解析 JSON 对象字符串，失败返回空字典"""
    if not s:
        return {}
    try:
        result = json.loads(s)
        if isinstance(result, dict):
            return result
    except (json.JSONDecodeError, ValueError):
        pass
    return {}


def _row_to_case(row: sqlite3.Row | tuple) -> dict[str, Any]:
    """将数据库行转换为案例字典

    Args:
        row: 数据库行（13 列顺序与 _CASES_DDL 一致）

    Returns:
        案例字典（含解析后的 fix_commands / rollback_commands / metadata）
    """
    (
        case_id, session_id, problem_description,
        fix_commands_json, rollback_commands_json, root_cause_description,
        risk_level, success_rating, outcome,
        target_asset, created_at, updated_at, metadata_json,
    ) = row

    return {
        "case_id": case_id,
        "session_id": session_id,
        "problem_description": problem_description,
        "fix_commands": _parse_json_array(fix_commands_json),
        "rollback_commands": _parse_json_array(rollback_commands_json),
        "root_cause_description": root_cause_description,
        "risk_level": risk_level,
        "success_rating": float(success_rating),
        "outcome": outcome,
        "target_asset": target_asset,
        "created_at": created_at,
        "updated_at": updated_at,
        "metadata": _parse_json_object(metadata_json),
    }


# ============================================================================
# CRUD 操作
# ============================================================================


def add_case(case: dict[str, Any]) -> dict[str, Any]:
    """添加历史案例

    Args:
        case: 案例字典（必含 problem_description）

    Returns:
        完整案例字典（含生成的 case_id / created_at / updated_at）

    Raises:
        ValueError: 缺少必填字段
    """
    problem = case.get("problem_description", "")
    if not problem:
        raise ValueError("problem_description is required")

    now = _now_iso()
    case_id = case.get("case_id") or str(uuid.uuid4())

    fix_commands = case.get("fix_commands", [])
    rollback_commands = case.get("rollback_commands", [])
    metadata = case.get("metadata", {})

    if not isinstance(fix_commands, list):
        raise ValueError("fix_commands must be list")
    if not isinstance(rollback_commands, list):
        raise ValueError("rollback_commands must be list")
    if not isinstance(metadata, dict):
        raise ValueError("metadata must be dict")

    session_id = case.get("session_id", "")
    root_cause = case.get("root_cause_description", "")
    risk_level = case.get("risk_level", "medium")
    success_rating = float(case.get("success_rating", 0.0))
    outcome = case.get("outcome", "pending")
    target_asset = case.get("target_asset", "")

    # 钳位 success_rating
    if not 0.0 <= success_rating <= 1.0:
        success_rating = max(0.0, min(1.0, success_rating))

    conn = _get_db()
    conn.execute(
        """INSERT INTO history_cases
           (case_id, session_id, problem_description, fix_commands,
            rollback_commands, root_cause_description, risk_level,
            success_rating, outcome, target_asset,
            created_at, updated_at, metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);""",
        (
            case_id, session_id, problem,
            json.dumps(fix_commands, ensure_ascii=False),
            json.dumps(rollback_commands, ensure_ascii=False),
            root_cause, risk_level, success_rating, outcome,
            target_asset, now, now,
            json.dumps(metadata, ensure_ascii=False),
        ),
    )

    # 同步到 FTS 表
    conn.execute(
        "INSERT INTO history_cases_fts (case_id, problem_description, root_cause_description) "
        "VALUES (?, ?, ?);",
        (case_id, problem, root_cause),
    )

    logger.info(f"add_case: case_id={case_id}, problem='{problem[:40]}'")

    return get_case(case_id) or {
        "case_id": case_id,
        "session_id": session_id,
        "problem_description": problem,
        "fix_commands": fix_commands,
        "rollback_commands": rollback_commands,
        "root_cause_description": root_cause,
        "risk_level": risk_level,
        "success_rating": success_rating,
        "outcome": outcome,
        "target_asset": target_asset,
        "created_at": now,
        "updated_at": now,
        "metadata": metadata,
    }


def get_case(case_id: str) -> dict[str, Any] | None:
    """按 case_id 获取案例

    Args:
        case_id: 案例 ID

    Returns:
        案例字典，未找到返回 None
    """
    conn = _get_db()
    cursor = conn.execute(
        "SELECT case_id, session_id, problem_description, fix_commands, "
        "rollback_commands, root_cause_description, risk_level, "
        "success_rating, outcome, target_asset, "
        "created_at, updated_at, metadata "
        "FROM history_cases WHERE case_id = ?;",
        (case_id,),
    )
    row = cursor.fetchone()
    if row is None:
        return None
    return _row_to_case(row)


def list_cases(
    session_id: str | None = None,
    limit: int = _DEFAULT_LIMIT,
    offset: int = 0,
) -> dict[str, Any]:
    """列出案例（可选按 session_id 过滤）

    Args:
        session_id: 会话 ID 过滤（None 时不过滤）
        limit: 返回数（最多 _MAX_LIMIT）
        offset: 偏移量（分页）

    Returns:
        {"cases": [...], "total": N}
    """
    if limit <= 0 or limit > _MAX_LIMIT:
        limit = _DEFAULT_LIMIT
    if offset < 0:
        offset = 0

    conn = _get_db()

    if session_id:
        cursor = conn.execute(
            "SELECT case_id, session_id, problem_description, fix_commands, "
            "rollback_commands, root_cause_description, risk_level, "
            "success_rating, outcome, target_asset, "
            "created_at, updated_at, metadata "
            "FROM history_cases WHERE session_id = ? "
            "ORDER BY created_at DESC LIMIT ? OFFSET ?;",
            (session_id, limit, offset),
        )
        count_cursor = conn.execute(
            "SELECT COUNT(*) FROM history_cases WHERE session_id = ?;",
            (session_id,),
        )
    else:
        cursor = conn.execute(
            "SELECT case_id, session_id, problem_description, fix_commands, "
            "rollback_commands, root_cause_description, risk_level, "
            "success_rating, outcome, target_asset, "
            "created_at, updated_at, metadata "
            "FROM history_cases "
            "ORDER BY created_at DESC LIMIT ? OFFSET ?;",
            (limit, offset),
        )
        count_cursor = conn.execute("SELECT COUNT(*) FROM history_cases;")

    rows = cursor.fetchall()
    total = count_cursor.fetchone()[0]

    cases = [_row_to_case(row) for row in rows]
    return {"cases": cases, "total": total}


def search_cases(
    query: str | None = None,
    session_id: str | None = None,
    min_success_rating: float | None = None,
    risk_level: str | None = None,
    time_from: str | None = None,
    time_to: str | None = None,
    limit: int = _DEFAULT_LIMIT,
    offset: int = 0,
) -> dict[str, Any]:
    """多维检索历史案例

    检索策略：
    1. 若提供 query：使用 FTS5 全文检索（在 problem_description / root_cause_description 中匹配）
    2. 否则：使用 SQL 过滤
    3. 所有过滤条件（session_id / min_success_rating / risk_level / time_range）叠加应用

    Args:
        query: 关键词（FTS5 全文匹配，可选）
        session_id: 会话 ID 过滤（可选）
        min_success_rating: 最低 success_rating（可选）
        risk_level: 风险等级过滤（low/medium/high/deny，可选）
        time_from: 起始时间（ISO 8601，可选）
        time_to: 截止时间（ISO 8601，可选）
        limit: 返回数
        offset: 偏移量

    Returns:
        {"cases": [...], "total": N}
    """
    if limit <= 0 or limit > _MAX_LIMIT:
        limit = _DEFAULT_LIMIT
    if offset < 0:
        offset = 0

    conn = _get_db()

    # 构建 SQL（FTS5 命中 case_id 集合，再用 WHERE 过滤）
    use_fts = bool(query and query.strip())
    fts_match_case_ids: set[str] | None = None

    if use_fts:
        # 转义双引号，构造 FTS5 查询
        safe_query = query.replace('"', '""')
        fts_query = f'"{safe_query}"'
        try:
            fts_cursor = conn.execute(
                "SELECT case_id FROM history_cases_fts "
                "WHERE history_cases_fts MATCH ?;",
                (fts_query,),
            )
            fts_match_case_ids = {row[0] for row in fts_cursor.fetchall()}
            if not fts_match_case_ids:
                # FTS 命中 0 条：直接返回空
                return {"cases": [], "total": 0}
        except sqlite3.OperationalError as e:
            logger.warning(f"FTS5 query failed: {e}, fallback to SQL LIKE")
            use_fts = False

    # 构建 WHERE 子句
    where_clauses: list[str] = []
    params: list[Any] = []

    if use_fts and fts_match_case_ids is not None:
        placeholders = ",".join("?" for _ in fts_match_case_ids)
        where_clauses.append(f"case_id IN ({placeholders})")
        params.extend(fts_match_case_ids)
    elif query and not use_fts:
        # LIKE 兜底
        where_clauses.append("(problem_description LIKE ? OR root_cause_description LIKE ?)")
        like_pattern = f"%{query}%"
        params.extend([like_pattern, like_pattern])

    if session_id:
        where_clauses.append("session_id = ?")
        params.append(session_id)

    if min_success_rating is not None:
        where_clauses.append("success_rating >= ?")
        params.append(float(min_success_rating))

    if risk_level:
        where_clauses.append("risk_level = ?")
        params.append(risk_level)

    if time_from:
        where_clauses.append("created_at >= ?")
        params.append(time_from)

    if time_to:
        where_clauses.append("created_at <= ?")
        params.append(time_to)

    where_sql = (" WHERE " + " AND ".join(where_clauses)) if where_clauses else ""

    # 查询数据
    cursor = conn.execute(
        "SELECT case_id, session_id, problem_description, fix_commands, "
        "rollback_commands, root_cause_description, risk_level, "
        "success_rating, outcome, target_asset, "
        "created_at, updated_at, metadata "
        f"FROM history_cases{where_sql} "
        "ORDER BY success_rating DESC, created_at DESC "
        "LIMIT ? OFFSET ?;",
        (*params, limit, offset),
    )
    rows = cursor.fetchall()

    # 查询总数
    count_cursor = conn.execute(
        f"SELECT COUNT(*) FROM history_cases{where_sql};",
        params,
    )
    total = count_cursor.fetchone()[0]

    cases = [_row_to_case(row) for row in rows]
    return {"cases": cases, "total": total}


def update_case(case_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
    """更新案例（部分字段）

    Args:
        case_id: 案例 ID
        updates: 待更新字段（仅支持以下字段：problem_description / fix_commands /
            rollback_commands / root_cause_description / risk_level /
            success_rating / outcome / target_asset / metadata / session_id）

    Returns:
        更新后的完整案例字典，未找到案例返回 None
    """
    existing = get_case(case_id)
    if existing is None:
        return None

    # 允许更新的字段白名单
    updatable_fields = {
        "session_id", "problem_description", "fix_commands",
        "rollback_commands", "root_cause_description", "risk_level",
        "success_rating", "outcome", "target_asset", "metadata",
    }

    set_clauses: list[str] = []
    params: list[Any] = []
    fts_needs_update = False

    for key, value in updates.items():
        if key not in updatable_fields:
            continue

        if key in ("fix_commands", "rollback_commands"):
            if not isinstance(value, list):
                raise ValueError(f"{key} must be list")
            set_clauses.append(f"{key} = ?")
            params.append(json.dumps(value, ensure_ascii=False))
        elif key == "metadata":
            if not isinstance(value, dict):
                raise ValueError("metadata must be dict")
            set_clauses.append("metadata = ?")
            params.append(json.dumps(value, ensure_ascii=False))
        elif key == "success_rating":
            value = max(0.0, min(1.0, float(value)))
            set_clauses.append("success_rating = ?")
            params.append(value)
        elif key in ("problem_description", "root_cause_description"):
            set_clauses.append(f"{key} = ?")
            params.append(str(value))
            fts_needs_update = True
        else:
            set_clauses.append(f"{key} = ?")
            params.append(value)

    if not set_clauses:
        return existing  # 无可更新字段

    # 更新时间戳
    now = _now_iso()
    set_clauses.append("updated_at = ?")
    params.append(now)
    params.append(case_id)

    conn = _get_db()
    conn.execute(
        f"UPDATE history_cases SET {', '.join(set_clauses)} WHERE case_id = ?;",
        params,
    )

    # 同步更新 FTS（删除 + 重新插入）
    if fts_needs_update:
        conn.execute(
            "DELETE FROM history_cases_fts WHERE case_id = ?;", (case_id,)
        )
        updated_case = get_case(case_id)
        if updated_case:
            conn.execute(
                "INSERT INTO history_cases_fts "
                "(case_id, problem_description, root_cause_description) "
                "VALUES (?, ?, ?);",
                (
                    case_id,
                    updated_case["problem_description"],
                    updated_case["root_cause_description"],
                ),
            )

    logger.info(f"update_case: case_id={case_id}, fields={list(updates.keys())}")
    return get_case(case_id)


def delete_case(case_id: str) -> bool:
    """删除案例

    Args:
        case_id: 案例 ID

    Returns:
        True 表示删除成功，False 表示案例不存在
    """
    existing = get_case(case_id)
    if existing is None:
        return False

    conn = _get_db()
    conn.execute("DELETE FROM history_cases WHERE case_id = ?;", (case_id,))
    conn.execute("DELETE FROM history_cases_fts WHERE case_id = ?;", (case_id,))

    logger.info(f"delete_case: case_id={case_id}")
    return True


# ============================================================================
# MCP tool 接口
# ============================================================================


def invoke_history_tool(params: dict[str, Any]) -> dict[str, Any]:
    """MCP tool 入口：历史案例 CRUD + 检索

    根据 ``action`` 字段路由到不同操作：
    - search: 多维检索（默认 action）
    - add: 添加案例
    - get: 按 case_id 获取
    - list: 列出案例（可选按 session_id 过滤）
    - update: 更新案例
    - delete: 删除案例

    Args:
        params: 工具参数字典

    Returns:
        操作结果字典：
            - search/list: {"action": ..., "cases": [...], "total": N}
            - add/update: {"action": ..., "case": {...}}
            - get: {"action": ..., "case": {...} | null}
            - delete: {"action": ..., "deleted": bool}

    Raises:
        ValueError: 必填参数缺失或类型错误
    """
    action = params.get("action", "search")
    supported_actions = {"search", "add", "get", "list", "update", "delete"}
    if action not in supported_actions:
        raise ValueError(
            f"action must be one of {supported_actions}, got '{action}'"
        )

    if action == "search":
        result = search_cases(
            query=params.get("query"),
            session_id=params.get("session_id"),
            min_success_rating=params.get("min_success_rating"),
            risk_level=params.get("risk_level"),
            time_from=params.get("time_from"),
            time_to=params.get("time_to"),
            limit=int(params.get("limit", _DEFAULT_LIMIT)),
            offset=int(params.get("offset", 0)),
        )
        return {"action": "search", **result}

    if action == "add":
        case = params.get("case")
        if not isinstance(case, dict):
            raise ValueError("case must be dict for action=add")
        added = add_case(case)
        return {"action": "add", "case": added}

    if action == "get":
        case_id = params.get("case_id", "")
        if not case_id:
            raise ValueError("case_id is required for action=get")
        case = get_case(case_id)
        return {"action": "get", "case": case}

    if action == "list":
        result = list_cases(
            session_id=params.get("session_id"),
            limit=int(params.get("limit", _DEFAULT_LIMIT)),
            offset=int(params.get("offset", 0)),
        )
        return {"action": "list", **result}

    if action == "update":
        case_id = params.get("case_id", "")
        if not case_id:
            raise ValueError("case_id is required for action=update")
        updates = params.get("updates", {})
        if not isinstance(updates, dict):
            raise ValueError("updates must be dict for action=update")
        updated = update_case(case_id, updates)
        return {"action": "update", "case": updated}

    if action == "delete":
        case_id = params.get("case_id", "")
        if not case_id:
            raise ValueError("case_id is required for action=delete")
        deleted = delete_case(case_id)
        return {"action": "delete", "deleted": deleted}

    # 不可达
    raise HistoryToolError(f"unhandled action: {action}")


# ============================================================================
# DecisionEngine 适配器
# ============================================================================


def make_history_callback(
    min_success_rating: float = 0.0,
    limit: int = 20,
) -> Callable[[str], list[dict[str, Any]]]:
    """创建适配 DecisionEngine 的历史检索回调

    DecisionEngine 期望 ``HistoryRetrieveCallback = Callable[[str], list[dict]]``，
    传入问题描述，返回历史案例列表。

    本函数包装 ``search_cases``，将结果转换为 DecisionEngine 期望的精简格式：
        {
            "problem_description": "...",
            "fix_commands": [...],
            "success_rating": 0.0-1.0,
            "source": "history"
        }

    Args:
        min_success_rating: 最低 success_rating 过滤（默认 0.0 不过滤）
        limit: 返回数（默认 20）

    Returns:
        HistoryRetrieveCallback 函数
    """
    def callback(problem_description: str) -> list[dict[str, Any]]:
        if not problem_description:
            return []

        try:
            result = search_cases(
                query=problem_description,
                min_success_rating=min_success_rating,
                limit=limit,
            )
        except Exception as e:
            logger.warning(f"history callback failed: {e}")
            return []

        # 转换为 DecisionEngine 期望的精简格式
        simplified: list[dict[str, Any]] = []
        for case in result["cases"]:
            simplified.append({
                "problem_description": case["problem_description"],
                "fix_commands": case["fix_commands"],
                "success_rating": case["success_rating"],
                "source": "history",
                "case_id": case["case_id"],
                "risk_level": case["risk_level"],
                "outcome": case["outcome"],
            })
        logger.info(
            f"history callback: query='{problem_description[:40]}', "
            f"returned {len(simplified)} cases"
        )
        return simplified

    return callback


# ============================================================================
# 工具元数据
# ============================================================================


TOOL_METADATA: dict[str, Any] = {
    "name": "history",
    "description": (
        "历史案例 CRUD + 多维检索（按时间/关键词/session/success_rating/risk_level），"
        "提供 DecisionEngine 适配器 make_history_callback。"
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["search", "add", "get", "list", "update", "delete"],
                "description": "操作类型（默认 search）",
            },
            "query": {"type": "string", "description": "search 时的关键词"},
            "session_id": {"type": "string", "description": "会话 ID 过滤"},
            "case_id": {"type": "string", "description": "get/update/delete 时必填"},
            "case": {"type": "object", "description": "add 时必填"},
            "updates": {"type": "object", "description": "update 时必填"},
            "min_success_rating": {"type": "number", "minimum": 0.0, "maximum": 1.0},
            "risk_level": {
                "type": "string",
                "enum": ["low", "medium", "high", "deny"],
            },
            "time_from": {"type": "string", "description": "ISO 8601 起始时间"},
            "time_to": {"type": "string", "description": "ISO 8601 截止时间"},
            "limit": {"type": "integer", "minimum": 1, "maximum": 100},
            "offset": {"type": "integer", "minimum": 0},
        },
    },
    "output_schema": {
        "type": "object",
        "properties": {
            "action": {"type": "string"},
            "cases": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "case_id": {"type": "string"},
                        "session_id": {"type": "string"},
                        "problem_description": {"type": "string"},
                        "fix_commands": {"type": "array", "items": {"type": "string"}},
                        "rollback_commands": {"type": "array", "items": {"type": "string"}},
                        "root_cause_description": {"type": "string"},
                        "risk_level": {"type": "string"},
                        "success_rating": {"type": "number"},
                        "outcome": {"type": "string"},
                        "target_asset": {"type": "string"},
                        "created_at": {"type": "string"},
                        "updated_at": {"type": "string"},
                        "metadata": {"type": "object"},
                    },
                },
            },
            "total": {"type": "integer"},
            "case": {"type": ["object", "null"]},
            "deleted": {"type": "boolean"},
        },
    },
}


def get_tool_metadata() -> dict[str, Any]:
    """获取工具元数据"""
    return TOOL_METADATA


# ============================================================================
# 集成到 LangGraph tool_call 节点
# ============================================================================


def register_to_graph_nodes() -> None:
    """将 history tool 注册到 graph/nodes.py 的 tool_call_node

    使用方式（在 graph/nodes.py 中）：
        from tools.history import invoke_history_tool

        if tool_name == "history":
            result = invoke_history_tool(params)
    """
    logger.info("register_to_graph_nodes: history tool ready for integration")
