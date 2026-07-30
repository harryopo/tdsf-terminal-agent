"""
tests/test_skill_registry.py — SkillRegistry 单元测试（T-P3-05 验证）
=====================================================================

验证内容：
1. SkillRegistry 创建
2. register / get / list / invoke / unregister
3. 大小写不敏感查询
4. load_builtin 自动加载 5 内置 Skill
5. load_external_dir 加载用户自定义 Skill
6. load_mock_external 加载 65 mock Skill
7. 70+ Skill 注册总数验证
8. search 按 name/description/tags 搜索
9. JSON-RPC 兼容方法注册

运行：
    cd python-sidecar
    python -m pytest tests/test_skill_registry.py -v
"""

from __future__ import annotations

import sys
from pathlib import Path

# 确保能 import skills 模块
sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

from skills.parser import Skill
from skills.registry import (
    SkillRegistry,
    get_global_registry,
    reset_global_registry,
)


# ============================================================================
# Fixtures
# ============================================================================


@pytest.fixture
def empty_registry() -> SkillRegistry:
    """空 SkillRegistry（每次测试新建）"""
    return SkillRegistry()


@pytest.fixture
def builtin_registry() -> SkillRegistry:
    """已加载 5 内置 Skill 的 Registry"""
    registry: SkillRegistry = SkillRegistry()
    registry.load_builtin()
    return registry


@pytest.fixture
def full_registry() -> SkillRegistry:
    """已加载 5 内置 Skill 的 Registry
    TDSF 魔改 (2026-07-28): 65 mock skill 已禁用, full_registry 仅含 5 builtin
    """
    registry: SkillRegistry = SkillRegistry()
    registry.load_builtin()
    return registry


# ============================================================================
# 1. Registry 创建测试
# ============================================================================


class TestRegistryCreation:
    """Registry 创建测试"""

    def test_registry_creation(self, empty_registry: SkillRegistry):
        """空 Registry 创建成功"""
        assert empty_registry.count() == 0
        assert empty_registry.list() == []
        assert empty_registry.list_names() == []

    def test_get_global_registry_singleton(self):
        """get_global_registry 返回单例"""
        reset_global_registry()
        r1 = get_global_registry()
        r2 = get_global_registry()
        assert r1 is r2
        # TDSF 魔改: 只加载 5 个 builtin (mock 已禁用)
        assert r1.count() == 5
        reset_global_registry()


# ============================================================================
# 2. 注册 / 查询 / 注销测试
# ============================================================================


class TestRegisterGetUnregister:
    """注册 / 查询 / 注销测试"""

    def test_register_skill(self, empty_registry: SkillRegistry):
        """注册单个 Skill"""
        skill: Skill = Skill(name="test-a", description="测试 A")
        assert empty_registry.register(skill) is True
        assert empty_registry.count() == 1

    def test_register_skill_empty_name(self, empty_registry: SkillRegistry):
        """name 为空时拒绝注册"""
        skill: Skill = Skill(name="")
        assert empty_registry.register(skill) is False
        assert empty_registry.count() == 0

    def test_register_skill_overwrite(self, empty_registry: SkillRegistry):
        """同名 Skill 覆盖注册"""
        s1: Skill = Skill(name="dup", description="v1")
        s2: Skill = Skill(name="dup", description="v2")
        empty_registry.register(s1)
        empty_registry.register(s2)  # 覆盖
        assert empty_registry.count() == 1
        got: Skill | None = empty_registry.get("dup")
        assert got is not None
        assert got.description == "v2"

    def test_get_skill_case_insensitive(self, empty_registry: SkillRegistry):
        """查询大小写不敏感"""
        empty_registry.register(Skill(name="Linux-Ops"))
        assert empty_registry.get("linux-ops") is not None
        assert empty_registry.get("LINUX-OPS") is not None
        assert empty_registry.get("Linux-Ops") is not None

    def test_get_skill_not_found(self, empty_registry: SkillRegistry):
        """查询不存在的 Skill 返回 None"""
        assert empty_registry.get("nonexistent") is None
        assert empty_registry.get("") is None

    def test_exists(self, empty_registry: SkillRegistry):
        """exists 判断"""
        empty_registry.register(Skill(name="check-me"))
        assert empty_registry.exists("check-me") is True
        assert empty_registry.exists("CHECK-ME") is True
        assert empty_registry.exists("other") is False
        assert empty_registry.exists("") is False

    def test_unregister_skill(self, empty_registry: SkillRegistry):
        """注销 Skill"""
        empty_registry.register(Skill(name="to-remove"))
        assert empty_registry.unregister("to-remove") is True
        assert empty_registry.count() == 0
        assert empty_registry.get("to-remove") is None

    def test_unregister_skill_case_insensitive(self, empty_registry: SkillRegistry):
        """注销大小写不敏感"""
        empty_registry.register(Skill(name="Remove-Me"))
        assert empty_registry.unregister("remove-me") is True
        assert empty_registry.count() == 0

    def test_unregister_skill_not_found(self, empty_registry: SkillRegistry):
        """注销不存在的 Skill 返回 False"""
        assert empty_registry.unregister("nonexistent") is False
        assert empty_registry.unregister("") is False

    def test_list_skills_sorted(self, empty_registry: SkillRegistry):
        """list 返回按 name 排序的 Skill 列表"""
        empty_registry.register(Skill(name="zeta"))
        empty_registry.register(Skill(name="alpha"))
        empty_registry.register(Skill(name="middle"))
        skills: list[Skill] = empty_registry.list()
        names: list[str] = [s.name for s in skills]
        assert names == ["alpha", "middle", "zeta"]

    def test_list_names_sorted(self, empty_registry: SkillRegistry):
        """list_names 返回按字母排序的名称列表"""
        empty_registry.register(Skill(name="charlie"))
        empty_registry.register(Skill(name="alpha"))
        empty_registry.register(Skill(name="bravo"))
        names: list[str] = empty_registry.list_names()
        assert names == ["alpha", "bravo", "charlie"]


# ============================================================================
# 3. invoke 调用测试
# ============================================================================


class TestInvokeSkill:
    """invoke 调用测试"""

    def test_invoke_builtin_skill(self, builtin_registry: SkillRegistry):
        """调用内置 Skill 返回完整内容

        TDSF 魔改 (2026-07-28 P0-2): SKILL.md 加 executor 字段后,
        invoke 返回执行结果 (duration_ms/executor/exit_code/name/source)
        而非纯内容 (content/when_to_use/steps). 测试适配两种返回结构.
        """
        result: dict = builtin_registry.invoke("linux-ops", {"task": "nginx 启动失败"})
        assert result["name"] == "linux-ops"
        assert result["source"] == "builtin"
        # 兼容两种返回结构:
        # - 旧版 (无 executor): 含 content/when_to_use/steps/examples
        # - 新版 (有 executor): 含 duration_ms/executor/exit_code
        if "executor" in result:
            # 新版执行式 Skill: 验证执行结果字段
            assert "duration_ms" in result
            assert "executor" in result
            assert "exit_code" in result
        else:
            # 旧版内容式 Skill: 验证内容字段
            assert "content" in result
            assert "when_to_use" in result
            assert "steps" in result
            assert "examples" in result
            assert "风险评估" in result["steps"]

    def test_invoke_mock_skill(self, full_registry: SkillRegistry):
        """调用 builtin Skill (TDSF 魔改: mock 已禁用, 改用 builtin 验证)"""
        # 原行为: 调用 mock 的 rust-debug, 验证 source="mock"
        # TDSF 魔改 (2026-07-28): 改用 builtin skill 验证 invoke 行为
        result: dict = full_registry.invoke("linux-ops", {})
        assert result["name"] == "linux-ops"
        assert result["source"] == "builtin"

    def test_invoke_skill_case_insensitive(self, builtin_registry: SkillRegistry):
        """调用大小写不敏感"""
        result: dict = builtin_registry.invoke("LINUX-OPS", {})
        assert result["name"] == "linux-ops"

    def test_invoke_skill_not_found(self, empty_registry: SkillRegistry):
        """调用不存在的 Skill 抛 KeyError"""
        with pytest.raises(KeyError):
            empty_registry.invoke("nonexistent", {})

    def test_invoke_skill_with_params(self, builtin_registry: SkillRegistry):
        """调用 Skill 时传入参数"""
        params: dict = {"task": "nginx 启动失败", "context": {"agent": "main"}}
        result: dict = builtin_registry.invoke("linux-ops", params)
        assert result["params"] == params


# ============================================================================
# 4. load_builtin 测试
# ============================================================================


class TestLoadBuiltin:
    """load_builtin 加载 5 内置 Skill 测试"""

    def test_load_builtin_count(self, builtin_registry: SkillRegistry):
        """load_builtin 加载 5 个内置 Skill"""
        assert builtin_registry.count() == 5

    def test_load_builtin_skill_names(self, builtin_registry: SkillRegistry):
        """5 内置 Skill 名称正确"""
        names: list[str] = builtin_registry.list_names()
        assert "linux-ops" in names
        assert "ssh-troubleshoot" in names
        assert "docker-management" in names
        assert "selinux-baseline" in names
        assert "python-debug" in names

    def test_load_builtin_skill_content(self, builtin_registry: SkillRegistry):
        """内置 Skill 解析内容完整"""
        skill: Skill | None = builtin_registry.get("linux-ops")
        assert skill is not None
        assert skill.name == "linux-ops"
        assert "Linux 运维" in skill.description
        assert skill.version >= "1.0.0"
        assert skill.author == "TDSF"
        assert "linux" in skill.tags
        assert skill.when_to_use
        assert skill.steps
        assert skill.examples

    def test_load_builtin_idempotent(self, empty_registry: SkillRegistry):
        """重复 load_builtin 不重复加载（覆盖注册）"""
        empty_registry.load_builtin()
        first_count: int = empty_registry.count()
        empty_registry.load_builtin()
        second_count: int = empty_registry.count()
        assert first_count == second_count == 5

    def test_load_builtin_dir_not_exist(self, empty_registry: SkillRegistry):
        """builtin_dir 不存在时返回 0"""
        count: int = empty_registry.load_builtin("/nonexistent/path")
        assert count == 0
        assert empty_registry.count() == 0


# ============================================================================
# 5. load_mock_external 测试
# ============================================================================


class TestLoadMockExternal:
    """load_mock_external 加载 65 mock Skill 测试"""

    def test_load_mock_count(self, empty_registry: SkillRegistry):
        """load_mock_external 加载 65 个 mock Skill"""
        count: int = empty_registry.load_mock_external(65)
        assert count == 65
        assert empty_registry.count() == 65

    def test_load_mock_partial(self, empty_registry: SkillRegistry):
        """load_mock_external 加载部分 mock Skill"""
        count: int = empty_registry.load_mock_external(10)
        assert count == 10
        assert empty_registry.count() == 10

    def test_load_mock_exceed_max(self, empty_registry: SkillRegistry):
        """load_mock_external 超过最大值时只加载 65"""
        count: int = empty_registry.load_mock_external(100)
        assert count == 65
        assert empty_registry.count() == 65

    def test_load_mock_skill_content(self, empty_registry: SkillRegistry):
        """mock Skill 内容正确"""
        empty_registry.load_mock_external(65)
        skill: Skill | None = empty_registry.get("rust-debug")
        assert skill is not None
        assert skill.name == "rust-debug"
        assert "rust" in skill.tags
        assert "mock" in skill.description.lower()

    def test_load_mock_skill_invoke(self, empty_registry: SkillRegistry):
        """mock Skill 调用返回模板"""
        empty_registry.load_mock_external(65)
        result: dict = empty_registry.invoke("react-hooks", {"task": "useState"})
        assert result["name"] == "react-hooks"
        assert result["source"] == "mock"


# ============================================================================
# 6. 70+ Skill 集成测试
# ============================================================================


class Test70PlusSkills:
    """70+ Skill 集成测试"""

    def test_total_70_skills(self, full_registry: SkillRegistry):
        """5 内置 (TDSF 魔改: mock 已禁用, 只剩 5 builtin)"""
        # 原行为: 5 内置 + 65 mock = 70 Skill
        # TDSF 魔改 (2026-07-28): 清理 65 mock skill, 只保留 5 builtin
        assert full_registry.count() == 5

    def test_total_skills_above_70(self):
        """全局 registry 加载后总数 ≥ 5 (TDSF 魔改: mock 已禁用)"""
        reset_global_registry()
        registry: SkillRegistry = get_global_registry()
        # 原行为: >= 70 (含 65 mock)
        # TDSF 魔改 (2026-07-28): 只剩 5 个 builtin skill
        assert registry.count() >= 5
        reset_global_registry()

    def test_5_builtin_in_full_registry(self, full_registry: SkillRegistry):
        """full_registry 包含 5 内置 Skill"""
        for name in [
            "linux-ops",
            "ssh-troubleshoot",
            "docker-management",
            "selinux-baseline",
            "python-debug",
        ]:
            assert full_registry.exists(name), f"missing builtin: {name}"

    def test_65_mock_in_full_registry(self, full_registry: SkillRegistry):
        """full_registry 含 5 builtin (TDSF 魔改: mock 已禁用)

        原行为: 抽样验证 4 个 mock skill (rust-debug/react-hooks/k8s-deploy/postgres-tuning)
        TDSF 魔改 (2026-07-28): 65 mock skill 已清理, 改验证 5 个 builtin
        """
        for name in [
            "docker-management",
            "linux-ops",
            "python-debug",
            "selinux-baseline",
            "ssh-troubleshoot",
        ]:
            assert full_registry.exists(name), f"missing builtin: {name}"

    def test_to_json(self, full_registry: SkillRegistry):
        """to_json 返回所有 Skill 的 JSON 兼容列表 (TDSF 魔改: 5 个 builtin)"""
        data: list[dict] = full_registry.to_json()
        # TDSF 魔改 (2026-07-28): 65 mock 已禁用, 只剩 5 builtin
        assert len(data) == 5
        assert all(isinstance(d, dict) for d in data)
        assert all("name" in d for d in data)


# ============================================================================
# 7. search 搜索测试
# ============================================================================


class TestSearch:
    """search 搜索测试"""

    def test_search_by_name(self, full_registry: SkillRegistry):
        """按 name 搜索"""
        results: list[Skill] = full_registry.search("linux")
        names: list[str] = [r.name for r in results]
        assert "linux-ops" in names

    def test_search_by_description(self, full_registry: SkillRegistry):
        """按 description 搜索"""
        results: list[Skill] = full_registry.search("Docker")
        names: list[str] = [r.name for r in results]
        assert "docker-management" in names

    def test_search_by_tag(self, full_registry: SkillRegistry):
        """按 tags 搜索"""
        results: list[Skill] = full_registry.search("nginx")
        names: list[str] = [r.name for r in results]
        assert "linux-ops" in names

    def test_search_empty_query(self, full_registry: SkillRegistry):
        """空查询返回空列表"""
        assert full_registry.search("") == []

    def test_search_no_match(self, full_registry: SkillRegistry):
        """无匹配时返回空列表"""
        results: list[Skill] = full_registry.search("quantum-nonexistent")
        assert results == []

    def test_search_case_insensitive(self, full_registry: SkillRegistry):
        """搜索大小写不敏感"""
        lower: list[Skill] = full_registry.search("docker")
        upper: list[Skill] = full_registry.search("DOCKER")
        assert {r.name for r in lower} == {r.name for r in upper}


# ============================================================================
# 8. load_external_dir 测试
# ============================================================================


class TestLoadExternalDir:
    """load_external_dir 加载用户自定义 Skill 测试"""

    def test_load_external_dir_subdir(self, tmp_path: Path, empty_registry: SkillRegistry):
        """加载 <dir>/<name>/SKILL.md 结构"""
        # 创建测试 Skill
        skill_dir: Path = tmp_path / "custom-skill"
        skill_dir.mkdir()
        (skill_dir / "SKILL.md").write_text(
            "---\nname: custom-skill\ndescription: 自定义 Skill\nversion: 1.0.0\n---\n\n# Custom\n",
            encoding="utf-8",
        )

        count: int = empty_registry.load_external_dir(tmp_path)
        assert count == 1
        assert empty_registry.exists("custom-skill")

    def test_load_external_dir_flat_md(self, tmp_path: Path, empty_registry: SkillRegistry):
        """加载 <dir>/*.md 结构"""
        (tmp_path / "flat-skill.md").write_text(
            "---\nname: flat-skill\ndescription: 扁平结构 Skill\n---\n\n# Flat\n",
            encoding="utf-8",
        )

        count: int = empty_registry.load_external_dir(tmp_path)
        assert count == 1
        assert empty_registry.exists("flat-skill")

    def test_load_external_dir_not_exist(self, empty_registry: SkillRegistry):
        """目录不存在时返回 0"""
        count: int = empty_registry.load_external_dir("/nonexistent/path")
        assert count == 0


# ============================================================================
# 9. JSON-RPC 方法注册测试
# ============================================================================


class TestRegisterMethods:
    """JSON-RPC 方法注册测试（mock dispatcher）"""

    def test_register_methods(self):
        """register_methods 注册 5 个 skill.* 方法"""
        reset_global_registry()
        registered: dict = {}

        class MockDispatcher:
            def register(self, name: str, handler) -> None:
                registered[name] = handler

        from skills.registry import register_methods
        register_methods(MockDispatcher())

        assert "skill.list" in registered
        assert "skill.get" in registered
        assert "skill.invoke" in registered
        assert "skill.search" in registered
        assert "skill.count" in registered
        reset_global_registry()

    def test_skill_list_method(self):
        """skill.list 返回 5 个 builtin Skill (TDSF 魔改: mock 已禁用)"""
        reset_global_registry()
        registered: dict = {}

        class MockDispatcher:
            def register(self, name: str, handler) -> None:
                registered[name] = handler

        from skills.registry import register_methods
        register_methods(MockDispatcher())

        result: dict = registered["skill.list"]()
        assert "skills" in result
        # TDSF 魔改 (2026-07-28): 清理 65 mock, 只剩 5 builtin
        assert result["total"] == 5
        reset_global_registry()

    def test_skill_get_method(self):
        """skill.get 返回指定 Skill 详情"""
        reset_global_registry()
        registered: dict = {}

        class MockDispatcher:
            def register(self, name: str, handler) -> None:
                registered[name] = handler

        from skills.registry import register_methods
        register_methods(MockDispatcher())

        result: dict = registered["skill.get"](name="linux-ops")
        assert result["ok"] is True
        assert result["skill"]["name"] == "linux-ops"
        reset_global_registry()

    def test_skill_invoke_method(self):
        """skill.invoke 调用 Skill"""
        reset_global_registry()
        registered: dict = {}

        class MockDispatcher:
            def register(self, name: str, handler) -> None:
                registered[name] = handler

        from skills.registry import register_methods
        register_methods(MockDispatcher())

        result: dict = registered["skill.invoke"](name="linux-ops", params={"task": "test"})
        assert result["ok"] is True
        assert "result" in result
        reset_global_registry()

    def test_skill_count_method(self):
        """skill.count 返回 Skill 总数 (TDSF 魔改: mock 已禁用)"""
        reset_global_registry()
        registered: dict = {}

        class MockDispatcher:
            def register(self, name: str, handler) -> None:
                registered[name] = handler

        from skills.registry import register_methods
        register_methods(MockDispatcher())

        result: dict = registered["skill.count"]()
        # TDSF 魔改 (2026-07-28): 清理 65 mock, 只剩 5 builtin
        assert result["count"] == 5
        reset_global_registry()
