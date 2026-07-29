"""
agent_identity.py — Agent 身份持久化 + 会话恢复（T-P4-09）
=============================================================

实现 Agent 状态保存到 SQLite + 会话恢复：
- save_agent_state: 保存 Agent 当前状态（mood/plan/intermediate_results）
- restore_session:  恢复会话（按 session_id 查询最近状态）
- list_sessions:    列出所有会话
- 内存模式（默认）：使用 dict 存储，离线测试无需 SQLite
- SQLite 模式：通过 db_path 参数启用

使用方式：
    from agent_identity import AgentIdentity

    ident = AgentIdentity()  # 内存模式
    ident.save("coding", "sess-1", {"mood": "working", "plan": [...]})
    state = ident.restore("sess-1")
    print(state)
"""

from __future__ import annotations

import json
import logging
import sqlite3
import time
from typing import Any

logger = logging.getLogger("sidecar.agent_identity")


# ============================================================================
# AgentIdentity — Agent 身份持久化 + 会话恢复
# ============================================================================

class AgentIdentity:
    """Agent 身份持久化 + 会话恢复

    Args:
        db_path: SQLite 数据库路径，None 表示内存模式（dict 存储）
    """

    def __init__(self, db_path: str | None = None) -> None:
        self.db_path = db_path
        self._memory_store: dict[str, dict[str, Any]] = {}
        self._conn: sqlite3.Connection | None = None

        if db_path is not None:
            self._init_sqlite()

    def _init_sqlite(self) -> None:
        """初始化 SQLite 数据库"""
        assert self.db_path is not None
        self._conn = sqlite3.connect(
            self.db_path,
            check_same_thread=False,
        )
        self._conn.execute("""
            CREATE TABLE IF NOT EXISTS agent_states (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                agent_name TEXT NOT NULL,
                state_json TEXT NOT NULL,
                mood TEXT,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            )
        """)
        self._conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_session_id
            ON agent_states(session_id)
        """)
        self._conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_agent_name
            ON agent_states(agent_name)
        """)
        self._conn.commit()
        logger.info(f"AgentIdentity SQLite initialized: {self.db_path}")

    def save(
        self,
        agent_name: str,
        session_id: str,
        state: dict[str, Any],
    ) -> dict[str, Any]:
        """保存 Agent 状态

        Args:
            agent_name: Agent 名（main/coding/explore/...）
            session_id: 会话 ID
            state: Agent 状态字典（含 mood/plan/intermediate_results 等）

        Returns:
            保存结果 dict

        Raises:
            ValueError: 参数校验失败
        """
        if not agent_name:
            raise ValueError("agent_name must not be empty")
        if not session_id:
            raise ValueError("session_id must not be empty")
        if not isinstance(state, dict):
            raise ValueError(
                f"state must be dict, got {type(state).__name__}"
            )

        timestamp = time.time()
        mood = state.get("mood", "")

        if self._conn is not None:
            # SQLite 模式
            state_json = json.dumps(state, ensure_ascii=False)
            self._conn.execute(
                """
                INSERT INTO agent_states
                    (session_id, agent_name, state_json, mood, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (session_id, agent_name, state_json, mood, timestamp, timestamp),
            )
            self._conn.commit()
        else:
            # 内存模式
            key = f"{session_id}:{agent_name}"
            self._memory_store[key] = {
                "session_id": session_id,
                "agent_name": agent_name,
                "state": state,
                "mood": mood,
                "created_at": timestamp,
                "updated_at": timestamp,
            }

        logger.info(
            f"agent_identity.save: agent={agent_name}, session={session_id}, "
            f"mood={mood}"
        )

        return {
            "ok": True,
            "agent_name": agent_name,
            "session_id": session_id,
            "timestamp": timestamp,
        }

    def restore(self, session_id: str) -> dict[str, Any]:
        """恢复会话（按 session_id 查询最近状态）

        Args:
            session_id: 会话 ID

        Returns:
            {
                "ok": bool,
                "session_id": str,
                "states": dict[agent_name, state],
                "restored_count": int,
            }

        Raises:
            ValueError: 参数校验失败
        """
        if not session_id:
            raise ValueError("session_id must not be empty")

        states: dict[str, dict[str, Any]] = {}

        if self._conn is not None:
            # SQLite 模式：查询该 session 所有 Agent 的最新状态
            cursor = self._conn.execute(
                """
                SELECT agent_name, state_json, mood, updated_at
                FROM agent_states
                WHERE session_id = ?
                AND updated_at = (
                    SELECT MAX(updated_at)
                    FROM agent_states AS sub
                    WHERE sub.session_id = ? AND sub.agent_name = agent_states.agent_name
                )
                ORDER BY updated_at DESC
                """,
                (session_id, session_id),
            )
            for row in cursor.fetchall():
                agent_name, state_json, mood, updated_at = row
                state = json.loads(state_json)
                states[agent_name] = state
        else:
            # 内存模式
            for key, entry in self._memory_store.items():
                if entry["session_id"] == session_id:
                    states[entry["agent_name"]] = entry["state"]

        logger.info(
            f"agent_identity.restore: session={session_id}, "
            f"restored={len(states)} agents"
        )

        return {
            "ok": len(states) > 0,
            "session_id": session_id,
            "states": states,
            "restored_count": len(states),
        }

    def list_sessions(self) -> list[dict[str, Any]]:
        """列出所有会话

        Returns:
            会话列表 [{session_id, agent_count, last_updated}, ...]
        """
        sessions: dict[str, dict[str, Any]] = {}

        if self._conn is not None:
            cursor = self._conn.execute(
                """
                SELECT session_id, COUNT(DISTINCT agent_name) AS agent_count,
                       MAX(updated_at) AS last_updated
                FROM agent_states
                GROUP BY session_id
                ORDER BY last_updated DESC
                """
            )
            for row in cursor.fetchall():
                sid, agent_count, last_updated = row
                sessions[sid] = {
                    "session_id": sid,
                    "agent_count": agent_count,
                    "last_updated": last_updated,
                }
        else:
            for entry in self._memory_store.values():
                sid = entry["session_id"]
                if sid not in sessions:
                    sessions[sid] = {
                        "session_id": sid,
                        "agent_count": 0,
                        "last_updated": 0.0,
                    }
                sessions[sid]["agent_count"] += 1
                if entry["updated_at"] > sessions[sid]["last_updated"]:
                    sessions[sid]["last_updated"] = entry["updated_at"]

        # 按最后更新时间排序
        return sorted(
            sessions.values(),
            key=lambda x: x["last_updated"],
            reverse=True,
        )

    def delete_session(self, session_id: str) -> int:
        """删除会话（所有相关 Agent 状态）

        Args:
            session_id: 会话 ID

        Returns:
            删除的记录数
        """
        if not session_id:
            raise ValueError("session_id must not be empty")

        if self._conn is not None:
            cursor = self._conn.execute(
                "DELETE FROM agent_states WHERE session_id = ?",
                (session_id,),
            )
            self._conn.commit()
            return cursor.rowcount

        # 内存模式
        keys_to_remove = [
            key for key, entry in self._memory_store.items()
            if entry["session_id"] == session_id
        ]
        for key in keys_to_remove:
            del self._memory_store[key]
        return len(keys_to_remove)

    def close(self) -> None:
        """关闭数据库连接"""
        if self._conn is not None:
            self._conn.close()
            self._conn = None


# ============================================================================
# 模块级单例
# ============================================================================

_global_identity: AgentIdentity | None = None


def get_global_identity() -> AgentIdentity:
    """获取全局 AgentIdentity 实例（懒加载，内存模式）"""
    global _global_identity
    if _global_identity is None:
        _global_identity = AgentIdentity()
    return _global_identity


def reset_for_test() -> None:
    """重置全局状态（测试用）"""
    global _global_identity
    if _global_identity is not None:
        _global_identity.close()
    _global_identity = None
