"""
project_home.py — 项目主页模式（T-P4-10）
==========================================

实现项目主页模式（workspace 概览）：
- get_overview: 返回 workspace 概览
  - 项目列表
  - 最近任务
  - Agent 状态
- 内存模式（默认）：使用 mock 数据，离线测试无需数据库
- 支持自定义数据源（通过 data_source 参数）

使用方式：
    from project_home import ProjectHome

    home = ProjectHome()
    overview = home.get_overview("proj-1")
    print(overview)
"""

from __future__ import annotations

import logging
import time
from typing import Any, Callable

logger = logging.getLogger("sidecar.project_home")


# ============================================================================
# ProjectHome — 项目主页模式
# ============================================================================

class ProjectHome:
    """项目主页模式（workspace 概览）

    Args:
        data_source: 自定义数据源函数（返回 dict），
                     None 表示使用 mock 数据
    """

    def __init__(
        self,
        data_source: Callable[[str], dict[str, Any]] | None = None,
    ) -> None:
        self.data_source = data_source
        self._mock_projects: dict[str, dict[str, Any]] = self._init_mock_projects()

    def _init_mock_projects(self) -> dict[str, dict[str, Any]]:
        """初始化 mock 项目数据"""
        now = time.time()
        return {
            "proj-1": {
                "project_id": "proj-1",
                "name": "TDSF Terminal Agent",
                "path": "/home/user/tdsf-terminal-agent",
                "description": "TDSF 终端 AI 助手",
                "created_at": now - 86400 * 30,
                "last_active": now - 3600,
                "agent_states": [
                    {"name": "main", "mood": "idle", "active": False},
                    {"name": "coding", "mood": "idle", "active": False},
                    {"name": "explore", "mood": "idle", "active": False},
                ],
                "recent_tasks": [
                    {
                        "id": "task-1",
                        "title": "修复 nginx 启动失败",
                        "status": "complete",
                        "agent": "debug",
                        "created_at": now - 7200,
                    },
                    {
                        "id": "task-2",
                        "title": "重构配置管理模块",
                        "status": "in_progress",
                        "agent": "refactor",
                        "created_at": now - 3600,
                    },
                ],
                "stats": {
                    "total_tasks": 42,
                    "completed_tasks": 38,
                    "success_rate": 0.905,
                    "total_tokens": 1250000,
                },
            },
            "proj-2": {
                "project_id": "proj-2",
                "name": "Linux 教学示例",
                "path": "/home/user/linux-teaching",
                "description": "Linux 运维教学项目",
                "created_at": now - 86400 * 60,
                "last_active": now - 86400,
                "agent_states": [
                    {"name": "teach", "mood": "done", "active": False},
                ],
                "recent_tasks": [
                    {
                        "id": "task-3",
                        "title": "讲解 SELinux 工作原理",
                        "status": "complete",
                        "agent": "teach",
                        "created_at": now - 86400,
                    },
                ],
                "stats": {
                    "total_tasks": 15,
                    "completed_tasks": 15,
                    "success_rate": 1.0,
                    "total_tokens": 320000,
                },
            },
        }

    def get_overview(self, project_id: str | None = None) -> dict[str, Any]:
        """获取项目主页概览

        Args:
            project_id: 项目 ID，None 表示返回所有项目列表概览

        Returns:
            {
                "project_id": str | None,
                "projects": list[dict],       # 项目列表
                "recent_tasks": list[dict],   # 最近任务
                "agent_states": list[dict],   # Agent 状态
                "stats": dict,                # 统计信息
            }
        """
        # 自定义数据源
        if self.data_source is not None:
            return self.data_source(project_id)

        # 单个项目详情
        if project_id is not None:
            project = self._mock_projects.get(project_id)
            if project is None:
                return {
                    "project_id": project_id,
                    "projects": [],
                    "recent_tasks": [],
                    "agent_states": [],
                    "stats": {},
                    "error": f"project not found: {project_id}",
                }
            return {
                "project_id": project_id,
                "projects": [project],
                "recent_tasks": project.get("recent_tasks", []),
                "agent_states": project.get("agent_states", []),
                "stats": project.get("stats", {}),
            }

        # 所有项目概览
        projects = list(self._mock_projects.values())
        all_recent_tasks: list[dict[str, Any]] = []
        all_agent_states: list[dict[str, Any]] = []
        total_stats = {
            "total_projects": len(projects),
            "total_tasks": sum(p.get("stats", {}).get("total_tasks", 0) for p in projects),
            "completed_tasks": sum(p.get("stats", {}).get("completed_tasks", 0) for p in projects),
            "total_tokens": sum(p.get("stats", {}).get("total_tokens", 0) for p in projects),
        }

        for project in projects:
            all_recent_tasks.extend(project.get("recent_tasks", []))
            all_agent_states.extend(project.get("agent_states", []))

        # 按时间倒序排序
        all_recent_tasks.sort(
            key=lambda t: t.get("created_at", 0),
            reverse=True,
        )
        all_recent_tasks = all_recent_tasks[:10]  # 最多 10 条

        return {
            "project_id": None,
            "projects": projects,
            "recent_tasks": all_recent_tasks,
            "agent_states": all_agent_states,
            "stats": total_stats,
        }

    def list_projects(self) -> list[dict[str, Any]]:
        """列出所有项目（简略信息）"""
        return [
            {
                "project_id": p["project_id"],
                "name": p["name"],
                "path": p["path"],
                "description": p.get("description", ""),
                "last_active": p.get("last_active", 0),
                "stats": p.get("stats", {}),
            }
            for p in self._mock_projects.values()
        ]

    def get_project(self, project_id: str) -> dict[str, Any] | None:
        """获取单个项目详情"""
        return self._mock_projects.get(project_id)

    def add_project(self, project: dict[str, Any]) -> dict[str, Any]:
        """添加项目

        Args:
            project: 项目字典，必须包含 project_id 和 name

        Returns:
            添加结果
        """
        project_id = project.get("project_id", "")
        if not project_id:
            return {"ok": False, "error": "project_id is required"}

        if project_id in self._mock_projects:
            return {"ok": False, "error": f"project already exists: {project_id}"}

        now = time.time()
        project.setdefault("created_at", now)
        project.setdefault("last_active", now)
        project.setdefault("agent_states", [])
        project.setdefault("recent_tasks", [])
        project.setdefault("stats", {
            "total_tasks": 0,
            "completed_tasks": 0,
            "success_rate": 0.0,
            "total_tokens": 0,
        })

        self._mock_projects[project_id] = project
        logger.info(f"project_home.add: {project_id}")
        return {"ok": True, "project_id": project_id}


# ============================================================================
# 模块级单例
# ============================================================================

_global_home: ProjectHome | None = None


def get_global_home() -> ProjectHome:
    """获取全局 ProjectHome 实例（懒加载）"""
    global _global_home
    if _global_home is None:
        _global_home = ProjectHome()
    return _global_home


def reset_for_test() -> None:
    """重置全局状态（测试用）"""
    global _global_home
    _global_home = None
