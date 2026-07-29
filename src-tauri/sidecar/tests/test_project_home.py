"""
tests/test_project_home.py — ProjectHome 单元测试（T-P4-10）
=================================================================

验证内容：
1. 初始化
   - 默认 mock 数据源
   - 自定义数据源
2. get_overview - 全局概览（project_id=None）
   - 返回所有项目列表
   - 汇总 stats
   - 汇总 recent_tasks（最多 10 条 + 时间倒序）
3. get_overview - 单项目（project_id 存在）
   - 返回项目详情
   - 包含 agent_states / recent_tasks / stats
4. get_overview - 单项目（project_id 不存在）
   - 返回 error 字段
5. list_projects
6. get_project
7. add_project
   - 添加成功
   - 重复添加失败
   - 缺少 project_id 失败
8. 自定义数据源
9. 全局单例 get_global_home / reset_for_test

运行：
    cd python-sidecar
    python -m pytest tests/test_project_home.py -v
"""

from __future__ import annotations

import sys
from pathlib import Path

# 确保能 import project_home 模块
sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

from project_home import (
    ProjectHome,
    get_global_home,
    reset_for_test,
)


# ============================================================================
# Fixture
# ============================================================================

@pytest.fixture
def home() -> ProjectHome:
    """默认 ProjectHome（mock 数据）"""
    return ProjectHome()


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
    """ProjectHome 初始化测试"""

    def test_default_init_has_mock_projects(self, home: ProjectHome) -> None:
        """默认初始化包含 mock 项目数据"""
        # 默认应有 2 个 mock 项目
        assert len(home._mock_projects) == 2
        assert "proj-1" in home._mock_projects
        assert "proj-2" in home._mock_projects

    def test_custom_data_source(self) -> None:
        """自定义数据源"""
        def custom_source(project_id: str | None) -> dict:
            return {
                "project_id": project_id,
                "projects": [{"project_id": "custom", "name": "Custom Project"}],
                "recent_tasks": [],
                "agent_states": [],
                "stats": {"custom": True},
            }

        home = ProjectHome(data_source=custom_source)
        result = home.get_overview("any-id")
        assert result["project_id"] == "any-id"
        assert result["stats"]["custom"] is True
        assert result["projects"][0]["name"] == "Custom Project"


# ============================================================================
# 2. get_overview - 全局概览
# ============================================================================

class TestGetOverviewGlobal:
    """get_overview(project_id=None) 全局概览"""

    def test_returns_all_projects(self, home: ProjectHome) -> None:
        """返回所有项目列表"""
        result = home.get_overview(None)
        assert result["project_id"] is None
        assert len(result["projects"]) == 2
        project_ids = [p["project_id"] for p in result["projects"]]
        assert "proj-1" in project_ids
        assert "proj-2" in project_ids

    def test_aggregates_stats(self, home: ProjectHome) -> None:
        """汇总 stats"""
        result = home.get_overview(None)
        stats = result["stats"]
        assert stats["total_projects"] == 2
        # proj-1: 42 tasks, proj-2: 15 tasks = 57
        assert stats["total_tasks"] == 42 + 15
        assert stats["completed_tasks"] == 38 + 15
        assert stats["total_tokens"] == 1250000 + 320000

    def test_aggregates_recent_tasks_sorted_desc(self, home: ProjectHome) -> None:
        """汇总 recent_tasks 并按时间倒序排序"""
        result = home.get_overview(None)
        tasks = result["recent_tasks"]
        # 最多 10 条
        assert len(tasks) <= 10
        # 应包含 proj-1 和 proj-2 的任务
        assert len(tasks) >= 2
        # 按时间倒序：第一条 created_at 应大于等于最后一条
        if len(tasks) >= 2:
            assert tasks[0]["created_at"] >= tasks[-1]["created_at"]

    def test_aggregates_agent_states(self, home: ProjectHome) -> None:
        """汇总 agent_states"""
        result = home.get_overview(None)
        agents = result["agent_states"]
        # proj-1: 3 agents, proj-2: 1 agent = 4
        assert len(agents) == 4


# ============================================================================
# 3. get_overview - 单项目（存在）
# ============================================================================

class TestGetOverviewSingle:
    """get_overview(project_id=具体值) 单项目"""

    def test_returns_single_project(self, home: ProjectHome) -> None:
        """返回指定项目详情"""
        result = home.get_overview("proj-1")
        assert result["project_id"] == "proj-1"
        assert len(result["projects"]) == 1
        assert result["projects"][0]["project_id"] == "proj-1"
        assert result["projects"][0]["name"] == "TDSF Terminal Agent"

    def test_includes_agent_states(self, home: ProjectHome) -> None:
        """包含 agent_states"""
        result = home.get_overview("proj-1")
        assert len(result["agent_states"]) == 3
        agent_names = [a["name"] for a in result["agent_states"]]
        assert "main" in agent_names
        assert "coding" in agent_names
        assert "explore" in agent_names

    def test_includes_recent_tasks(self, home: ProjectHome) -> None:
        """包含 recent_tasks"""
        result = home.get_overview("proj-1")
        assert len(result["recent_tasks"]) == 2
        # 应包含 task-1 和 task-2
        task_ids = [t["id"] for t in result["recent_tasks"]]
        assert "task-1" in task_ids
        assert "task-2" in task_ids

    def test_includes_stats(self, home: ProjectHome) -> None:
        """包含 stats"""
        result = home.get_overview("proj-1")
        stats = result["stats"]
        assert stats["total_tasks"] == 42
        assert stats["completed_tasks"] == 38
        assert stats["success_rate"] == 0.905
        assert stats["total_tokens"] == 1250000


# ============================================================================
# 4. get_overview - 单项目（不存在）
# ============================================================================

class TestGetOverviewNotFound:
    """get_overview(project_id=不存在的值)"""

    def test_returns_error(self, home: ProjectHome) -> None:
        """返回 error 字段"""
        result = home.get_overview("nonexistent-project")
        assert result["project_id"] == "nonexistent-project"
        assert result["projects"] == []
        assert result["recent_tasks"] == []
        assert result["agent_states"] == []
        assert result["stats"] == {}
        assert "error" in result
        assert "nonexistent-project" in result["error"]


# ============================================================================
# 5. list_projects
# ============================================================================

class TestListProjects:
    """list_projects 方法"""

    def test_returns_brief_info(self, home: ProjectHome) -> None:
        """返回简略信息"""
        projects = home.list_projects()
        assert len(projects) == 2
        for p in projects:
            assert "project_id" in p
            assert "name" in p
            assert "path" in p
            assert "description" in p
            assert "last_active" in p
            assert "stats" in p

    def test_returns_both_projects(self, home: ProjectHome) -> None:
        """包含所有项目"""
        projects = home.list_projects()
        project_ids = [p["project_id"] for p in projects]
        assert "proj-1" in project_ids
        assert "proj-2" in project_ids


# ============================================================================
# 6. get_project
# ============================================================================

class TestGetProject:
    """get_project 方法"""

    def test_existing_project(self, home: ProjectHome) -> None:
        """存在的项目"""
        project = home.get_project("proj-1")
        assert project is not None
        assert project["project_id"] == "proj-1"
        assert project["name"] == "TDSF Terminal Agent"

    def test_nonexistent_project(self, home: ProjectHome) -> None:
        """不存在的项目返回 None"""
        project = home.get_project("nonexistent")
        assert project is None


# ============================================================================
# 7. add_project
# ============================================================================

class TestAddProject:
    """add_project 方法"""

    def test_add_success(self, home: ProjectHome) -> None:
        """添加成功"""
        new_project = {
            "project_id": "proj-3",
            "name": "New Test Project",
            "path": "/tmp/test-project",
        }
        result = home.add_project(new_project)
        assert result["ok"] is True
        assert result["project_id"] == "proj-3"
        # 验证能查到
        project = home.get_project("proj-3")
        assert project is not None
        assert project["name"] == "New Test Project"

    def test_add_duplicate_fails(self, home: ProjectHome) -> None:
        """重复添加失败"""
        result = home.add_project({
            "project_id": "proj-1",
            "name": "Duplicate",
        })
        assert result["ok"] is False
        assert "already exists" in result["error"]

    def test_add_missing_project_id_fails(self, home: ProjectHome) -> None:
        """缺少 project_id 失败"""
        result = home.add_project({"name": "No ID"})
        assert result["ok"] is False
        assert "project_id is required" in result["error"]

    def test_add_sets_defaults(self, home: ProjectHome) -> None:
        """添加时自动设置默认字段"""
        result = home.add_project({
            "project_id": "proj-defaults",
            "name": "Defaults Test",
        })
        assert result["ok"] is True
        project = home.get_project("proj-defaults")
        assert project is not None
        assert "created_at" in project
        assert "last_active" in project
        assert "agent_states" in project
        assert "recent_tasks" in project
        assert "stats" in project
        # stats 应有默认值
        assert project["stats"]["total_tasks"] == 0
        assert project["stats"]["completed_tasks"] == 0
        assert project["stats"]["success_rate"] == 0.0
        assert project["stats"]["total_tokens"] == 0


# ============================================================================
# 8. 全局单例
# ============================================================================

class TestGlobalHome:
    """全局单例测试"""

    def test_get_global_home_returns_singleton(self) -> None:
        """get_global_home 返回单例"""
        home1 = get_global_home()
        home2 = get_global_home()
        assert home1 is home2
        assert isinstance(home1, ProjectHome)

    def test_reset_for_test_clears_singleton(self) -> None:
        """reset_for_test 清空单例"""
        home1 = get_global_home()
        reset_for_test()
        home2 = get_global_home()
        assert home1 is not home2


# ============================================================================
# 9. 集成场景
# ============================================================================

class TestIntegration:
    """集成场景测试"""

    def test_add_then_get_overview(self, home: ProjectHome) -> None:
        """添加项目后 get_overview 应包含"""
        # 初始 2 个项目
        overview = home.get_overview(None)
        assert overview["stats"]["total_projects"] == 2
        # 添加新项目
        home.add_project({
            "project_id": "proj-new",
            "name": "New Project",
            "stats": {
                "total_tasks": 10,
                "completed_tasks": 5,
                "success_rate": 0.5,
                "total_tokens": 100000,
            },
        })
        # 应有 3 个项目
        overview = home.get_overview(None)
        assert overview["stats"]["total_projects"] == 3
        assert overview["stats"]["total_tasks"] == 42 + 15 + 10

    def test_project_data_integrity(self, home: ProjectHome) -> None:
        """项目数据完整性"""
        overview = home.get_overview("proj-1")
        project = overview["projects"][0]
        # 所有字段都应有值
        assert project["project_id"]
        assert project["name"]
        assert project["path"]
        assert "description" in project
        assert "created_at" in project
        assert "last_active" in project
        assert isinstance(project["agent_states"], list)
        assert isinstance(project["recent_tasks"], list)
        assert isinstance(project["stats"], dict)
