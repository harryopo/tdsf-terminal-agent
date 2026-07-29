"""
tests/test_self_evolution.py — KEPA + SkillAutoGenerator 单元测试（T-P5-03）
=============================================================================

验证内容：
1. KEPAPropagator.propagate（误差缩放梯度）
2. KEPAPropagator.update_weights（标准梯度下降）
3. KEPAPropagator feature flag 开关
4. SkillAutoGenerator.analyze_history（高频模式识别）
5. SkillAutoGenerator.generate_skill（SKILL.md 生成）
6. SkillAutoGenerator.save_skill（磁盘持久化）
7. SkillAutoGenerator.list_auto_skills
8. JSON-RPC 注册方法

运行：
    cd python-sidecar
    python -m pytest tests/test_self_evolution.py -v
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

from self_evolution import (
    KEPAPropagator,
    SkillAutoGenerator,
    SkillPattern,
    get_kepa,
    get_skill_generator,
    reset_instances,
)


# ============================================================================
# Fixture
# ============================================================================

@pytest.fixture
def disabled_kepa() -> KEPAPropagator:
    """关闭状态的 KEPAPropagator"""
    return KEPAPropagator(enabled=False, learning_rate=0.01)


@pytest.fixture
def enabled_kepa() -> KEPAPropagator:
    """启用状态的 KEPAPropagator"""
    return KEPAPropagator(enabled=True, learning_rate=0.01)


@pytest.fixture
def disabled_gen(tmp_path: Path) -> SkillAutoGenerator:
    """关闭状态的 SkillAutoGenerator（输出到临时目录）"""
    return SkillAutoGenerator(
        enabled=False,
        min_frequency=3,
        output_dir=tmp_path / "auto-skills",
    )


@pytest.fixture
def enabled_gen(tmp_path: Path) -> SkillAutoGenerator:
    """启用状态的 SkillAutoGenerator"""
    return SkillAutoGenerator(
        enabled=True,
        min_frequency=3,
        output_dir=tmp_path / "auto-skills",
    )


@pytest.fixture
def sample_history() -> list[dict]:
    """样本历史记录：3 次 systemctl restart nginx + 2 次其他"""
    return [
        {"command": "systemctl restart nginx", "tool": "shell", "agent": "coding", "success": True},
        {"command": "systemctl restart nginx", "tool": "shell", "agent": "coding", "success": True},
        {"command": "systemctl restart nginx", "tool": "shell", "agent": "coding", "success": False, "error": "Address already in use"},
        {"command": "nginx -t", "tool": "shell", "agent": "coding", "success": True},
        {"command": "nginx -t", "tool": "shell", "agent": "coding", "success": True},
        {"command": "ls -la", "tool": "shell", "agent": "explore", "success": True},
        {"command": "systemctl restart nginx", "tool": "shell", "agent": "deploy", "success": True},
        {"error": "Address already in use"},
        {"error": "Address already in use"},
        {"error": "Address already in use"},
    ]


# ============================================================================
# 1. KEPAPropagator.propagate 测试
# ============================================================================

class TestKEPAPropagate:
    """KEPAPropagator.propagate 测试"""

    def test_propagate_scales_gradients_by_error(self, enabled_kepa: KEPAPropagator):
        """启用时 propagate 应按 error 缩放梯度"""
        grads = {"tool_a": 0.2, "tool_b": -0.1}
        updated = enabled_kepa.propagate(error=0.5, gradients=grads)
        assert updated["tool_a"] == pytest.approx(0.1)   # 0.2 * 0.5
        assert updated["tool_b"] == pytest.approx(-0.05)  # -0.1 * 0.5

    def test_propagate_zero_error_yields_zero_gradients(self, enabled_kepa: KEPAPropagator):
        """error=0 时所有梯度归零"""
        grads = {"tool_a": 0.5, "tool_b": -0.3}
        updated = enabled_kepa.propagate(error=0.0, gradients=grads)
        assert all(v == 0.0 for v in updated.values())

    def test_propagate_empty_gradients_returns_empty(self, enabled_kepa: KEPAPropagator):
        """空 gradients 返回空 dict"""
        assert enabled_kepa.propagate(error=1.0, gradients={}) == {}

    def test_propagate_disabled_returns_gradients_unchanged(self, disabled_kepa: KEPAPropagator):
        """关闭时 propagate 原样返回梯度"""
        grads = {"tool_a": 0.2, "tool_b": -0.1}
        updated = disabled_kepa.propagate(error=0.5, gradients=grads)
        assert updated == grads
        # 确认是副本而非原对象
        assert updated is not grads

    def test_propagate_negative_error_flips_gradient_sign(self, enabled_kepa: KEPAPropagator):
        """负 error 翻转梯度符号"""
        grads = {"tool_a": 0.5}
        updated = enabled_kepa.propagate(error=-1.0, gradients=grads)
        assert updated["tool_a"] == pytest.approx(-0.5)


# ============================================================================
# 2. KEPAPropagator.update_weights 测试
# ============================================================================

class TestKEPAUpdateWeights:
    """KEPAPropagator.update_weights 测试"""

    def test_update_weights_standard_gradient_descent(self, enabled_kepa: KEPAPropagator):
        """启用时 update_weights 执行标准梯度下降：w' = w - lr * grad"""
        weights = {"tool_a": 1.0, "tool_b": 0.5}
        gradients = {"tool_a": 0.2, "tool_b": -0.1}
        # lr=0.01: tool_a = 1.0 - 0.01 * 0.2 = 0.998
        #          tool_b = 0.5 - 0.01 * (-0.1) = 0.501
        updated = enabled_kepa.update_weights(weights, gradients, lr=0.01)
        assert updated["tool_a"] == pytest.approx(0.998)
        assert updated["tool_b"] == pytest.approx(0.501)

    def test_update_weights_uses_default_lr_when_zero(self, enabled_kepa: KEPAPropagator):
        """lr=0 时使用 self.learning_rate"""
        # learning_rate=0.01
        weights = {"x": 1.0}
        gradients = {"x": 1.0}
        updated = enabled_kepa.update_weights(weights, gradients, lr=0.0)
        # 1.0 - 0.01 * 1.0 = 0.99
        assert updated["x"] == pytest.approx(0.99)

    def test_update_weights_empty_weights_returns_empty(self, enabled_kepa: KEPAPropagator):
        """空 weights 返回空 dict"""
        assert enabled_kepa.update_weights({}, {"x": 1.0}) == {}

    def test_update_weights_only_updates_keys_in_both(self, enabled_kepa: KEPAPropagator):
        """仅更新同时出现在 weights 和 gradients 中的 key"""
        weights = {"a": 1.0, "b": 2.0, "c": 3.0}
        gradients = {"a": 0.5, "d": 0.1}  # d 不在 weights 中
        updated = enabled_kepa.update_weights(weights, gradients, lr=0.1)
        # a 更新：1.0 - 0.1 * 0.5 = 0.95
        # b/c 不变
        # d 忽略
        assert updated["a"] == pytest.approx(0.95)
        assert updated["b"] == 2.0
        assert updated["c"] == 3.0
        assert "d" not in updated

    def test_update_weights_disabled_returns_weights_unchanged(self, disabled_kepa: KEPAPropagator):
        """关闭时 update_weights 原样返回 weights"""
        weights = {"x": 1.0, "y": 2.0}
        updated = disabled_kepa.update_weights(weights, {"x": 100.0}, lr=0.5)
        assert updated == weights
        assert updated is not weights


# ============================================================================
# 3. SkillAutoGenerator.analyze_history 测试
# ============================================================================

class TestAnalyzeHistory:
    """SkillAutoGenerator.analyze_history 测试"""

    def test_analyze_empty_history(self, enabled_gen: SkillAutoGenerator):
        """空历史返回空模式"""
        result = enabled_gen.analyze_history([])
        assert result["patterns"] == []
        assert result["total_history"] == 0
        assert result["generated_count"] == 0

    def test_analyze_identifies_high_frequency_commands(
        self, enabled_gen: SkillAutoGenerator, sample_history: list[dict]
    ):
        """识别高频命令模式（systemctl restart nginx 出现 4 次 >= 3）"""
        result = enabled_gen.analyze_history(sample_history)
        patterns: list[dict] = result["patterns"]
        # systemctl restart nginx 出现 4 次（>=3）
        cmd_patterns = [p for p in patterns if p["category"] == "command"]
        assert any(p["pattern"] == "systemctl restart nginx" and p["frequency"] == 4 for p in cmd_patterns)
        # Address already in use 出现 4 次（3 次有 error 字段 + 1 次 command 字段）— 实际只统计 error 字段
        # 检查样本：3 条 record 有 error="Address already in use"
        err_patterns = [p for p in patterns if p["category"] == "error"]
        assert any(p["pattern"] == "Address already in use" and p["frequency"] >= 3 for p in err_patterns)

    def test_analyze_filters_low_frequency_commands(
        self, enabled_gen: SkillAutoGenerator, sample_history: list[dict]
    ):
        """低频命令（< min_frequency）不应出现在 patterns 中"""
        result = enabled_gen.analyze_history(sample_history)
        cmd_patterns = [p for p in result["patterns"] if p["category"] == "command"]
        # ls -la 只出现 1 次，不应在结果中
        assert not any(p["pattern"] == "ls -la" for p in cmd_patterns)
        # nginx -t 出现 2 次 (<3)，也不应在结果中
        assert not any(p["pattern"] == "nginx -t" for p in cmd_patterns)

    def test_analyze_disabled_returns_no_patterns(
        self, disabled_gen: SkillAutoGenerator, sample_history: list[dict]
    ):
        """关闭时返回空 patterns（即便有高频模式）"""
        result = disabled_gen.analyze_history(sample_history)
        assert result["patterns"] == []
        assert result["generated_count"] == 0
        # 但 total_history 仍正确统计
        assert result["total_history"] == len(sample_history)

    def test_analyze_records_examples(self, enabled_gen: SkillAutoGenerator, sample_history: list[dict]):
        """识别的模式应记录示例（最多 5 条）"""
        result = enabled_gen.analyze_history(sample_history)
        cmd_patterns = [p for p in result["patterns"] if p["category"] == "command"]
        nginx_pattern = next(p for p in cmd_patterns if p["pattern"] == "systemctl restart nginx")
        assert len(nginx_pattern["examples"]) > 0
        assert len(nginx_pattern["examples"]) <= 5
        # 示例格式应包含 tool/agent/success
        assert "tool=" in nginx_pattern["examples"][0]


# ============================================================================
# 4. SkillAutoGenerator.generate_skill 测试
# ============================================================================

class TestGenerateSkill:
    """SkillAutoGenerator.generate_skill 测试"""

    def test_generate_skill_returns_valid_frontmatter_and_body(self, enabled_gen: SkillAutoGenerator):
        """生成的 SKILL.md 应包含 frontmatter + 3 个章节"""
        pattern = {
            "pattern": "systemctl restart nginx",
            "frequency": 5,
            "examples": ["tool=shell agent=coding success=True"],
            "category": "command",
        }
        content = enabled_gen.generate_skill(pattern)
        # frontmatter 存在
        assert content.startswith("---\n")
        # frontmatter 字段
        assert "name: systemctl-restart-nginx" in content
        assert "description:" in content
        assert "version: 0.1.0" in content
        assert "author: TDSF-AutoGen" in content
        assert "tags:" in content
        # body 章节
        assert "# systemctl-restart-nginx" in content
        assert "## When to use" in content
        assert "## Steps" in content
        assert "## Examples" in content

    def test_generate_skill_error_category_has_different_steps(self, enabled_gen: SkillAutoGenerator):
        """error 类型的 Skill 应有 '根因分析' 步骤"""
        pattern = {
            "pattern": "Address already in use",
            "frequency": 4,
            "examples": [],
            "category": "error",
        }
        content = enabled_gen.generate_skill(pattern)
        assert "根因分析" in content
        assert "复现错误" in content

    def test_generate_skill_empty_pattern_returns_minimal_md(self, enabled_gen: SkillAutoGenerator):
        """空 pattern 返回最小化 SKILL.md"""
        content = enabled_gen.generate_skill({})
        assert "unnamed-auto-skill" in content
        assert "无可用模式" in content

    def test_generate_skill_high_frequency_adds_tag(self, enabled_gen: SkillAutoGenerator):
        """frequency >= 10 添加 high-frequency tag"""
        pattern = {
            "pattern": "ls -la",
            "frequency": 15,
            "examples": [],
            "category": "command",
        }
        content = enabled_gen.generate_skill(pattern)
        assert "high-frequency" in content

    def test_generate_skill_sanitizes_name(self, enabled_gen: SkillAutoGenerator):
        """特殊字符 pattern 应被 sanitize 为合法 Skill 名"""
        pattern = {
            "pattern": "echo 'Hello World! @#$'",
            "frequency": 3,
            "examples": [],
            "category": "command",
        }
        content = enabled_gen.generate_skill(pattern)
        # 检查 frontmatter 中的 name 应仅含 a-z 0-9 - _
        # 提取 name 行
        for line in content.split("\n"):
            if line.startswith("name:"):
                name_value = line.split(":", 1)[1].strip()
                # 验证仅含合法字符
                assert all(c.isalnum() or c in "-_" for c in name_value), \
                    f"invalid char in name: {name_value}"
                break


# ============================================================================
# 5. SkillAutoGenerator.save_skill 测试
# ============================================================================

class TestSaveSkill:
    """SkillAutoGenerator.save_skill 测试"""

    def test_save_skill_creates_file(self, enabled_gen: SkillAutoGenerator):
        """save_skill 应创建 SKILL.md 文件"""
        content = "---\nname: test-skill\ndescription: test\n---\n\n# Test\n"
        path = enabled_gen.save_skill("test-skill", content)
        assert path.exists()
        assert path.name == "SKILL.md"
        assert path.parent.name == "test-skill"
        assert path.read_text(encoding="utf-8") == content

    def test_save_skill_overwrites_existing(self, enabled_gen: SkillAutoGenerator):
        """同名 Skill 重复保存应覆盖"""
        enabled_gen.save_skill("dup-skill", "v1")
        enabled_gen.save_skill("dup-skill", "v2")
        skills = enabled_gen.list_auto_skills()
        assert len(skills) == 1
        # 验证内容是 v2
        path = Path(skills[0]["path"])
        assert path.read_text(encoding="utf-8") == "v2"

    def test_save_skill_sanitizes_name(self, enabled_gen: SkillAutoGenerator):
        """特殊字符 name 应被 sanitize"""
        path = enabled_gen.save_skill("Hello World! @#$", "content")
        # 父目录名应仅含 a-z 0-9 - _
        dir_name = path.parent.name
        assert all(c.isalnum() or c in "-_" for c in dir_name), \
            f"invalid char in dir name: {dir_name}"

    def test_save_skill_creates_output_dir_if_missing(self, tmp_path: Path):
        """output_dir 不存在时应自动创建"""
        out_dir = tmp_path / "nonexistent" / "skills"
        gen = SkillAutoGenerator(enabled=True, output_dir=out_dir)
        path = gen.save_skill("test", "content")
        assert path.exists()
        assert out_dir.exists()


# ============================================================================
# 6. SkillAutoGenerator.list_auto_skills 测试
# ============================================================================

class TestListAutoSkills:
    """SkillAutoGenerator.list_auto_skills 测试"""

    def test_list_empty_returns_empty_list(self, enabled_gen: SkillAutoGenerator):
        """无 Skill 时返回空列表"""
        assert enabled_gen.list_auto_skills() == []

    def test_list_returns_all_saved_skills(self, enabled_gen: SkillAutoGenerator):
        """保存多个 Skill 后应能列出全部"""
        enabled_gen.save_skill("skill-a", "content-a")
        enabled_gen.save_skill("skill-b", "content-b")
        enabled_gen.save_skill("skill-c", "content-c")
        skills = enabled_gen.list_auto_skills()
        names = [s["name"] for s in skills]
        assert "skill-a" in names
        assert "skill-b" in names
        assert "skill-c" in names
        assert len(skills) == 3

    def test_list_ignores_non_skill_directories(self, enabled_gen: SkillAutoGenerator):
        """没有 SKILL.md 的目录应被忽略"""
        enabled_gen.save_skill("real-skill", "content")
        # 创建一个不含 SKILL.md 的目录
        (enabled_gen.output_dir / "fake-dir").mkdir(parents=True, exist_ok=True)
        skills = enabled_gen.list_auto_skills()
        names = [s["name"] for s in skills]
        assert "real-skill" in names
        assert "fake-dir" not in names


# ============================================================================
# 7. SkillPattern dataclass 测试
# ============================================================================

class TestSkillPattern:
    """SkillPattern dataclass 测试"""

    def test_to_dict_contains_all_fields(self):
        """to_dict 应包含所有字段"""
        p = SkillPattern(
            pattern="test",
            frequency=3,
            examples=["ex1", "ex2"],
            category="command",
        )
        d = p.to_dict()
        assert d["pattern"] == "test"
        assert d["frequency"] == 3
        assert d["examples"] == ["ex1", "ex2"]
        assert d["category"] == "command"

    def test_default_values(self):
        """默认值正确"""
        p = SkillPattern(pattern="x")
        assert p.frequency == 0
        assert p.examples == []
        assert p.category == "command"


# ============================================================================
# 8. JSON-RPC 方法注册测试
# ============================================================================

class TestJsonRpcRegistration:
    """JSON-RPC 方法注册测试"""

    def test_register_methods_registers_six_methods(self):
        """register_methods 应注册 6 个方法"""
        reset_instances()
        dispatcher = _MockDispatcher()
        from self_evolution import register_methods
        register_methods(dispatcher)
        assert "kepa.propagate" in dispatcher.methods
        assert "kepa.update_weights" in dispatcher.methods
        assert "kepa.status" in dispatcher.methods
        assert "skill.auto_generate" in dispatcher.methods
        assert "skill.list_auto" in dispatcher.methods
        assert "skill.status" in dispatcher.methods
        assert len(dispatcher.methods) == 6

    def test_kepa_status_returns_dict(self):
        """kepa.status 应返回包含 enabled + learning_rate 的 dict"""
        reset_instances()
        dispatcher = _MockDispatcher()
        from self_evolution import register_methods
        register_methods(dispatcher)
        result = dispatcher.methods["kepa.status"]()
        assert "enabled" in result
        assert "learning_rate" in result


# ============================================================================
# 9. 模块级单例测试
# ============================================================================

class TestModuleSingletons:
    """模块级单例（get_kepa / get_skill_generator）测试"""

    def test_get_kepa_returns_same_instance(self):
        """get_kepa 返回同一实例"""
        reset_instances()
        a = get_kepa()
        b = get_kepa()
        assert a is b

    def test_get_skill_generator_returns_same_instance(self):
        """get_skill_generator 返回同一实例"""
        reset_instances()
        a = get_skill_generator()
        b = get_skill_generator()
        assert a is b

    def test_reset_instances_creates_new_instances(self):
        """reset_instances 后应创建新实例"""
        reset_instances()
        a = get_kepa()
        reset_instances()
        b = get_kepa()
        assert a is not b


# ============================================================================
# 10. 端到端集成测试
# ============================================================================

class TestEndToEnd:
    """端到端：从历史到 Skill 文件全链路"""

    def test_full_pipeline_history_to_skill_file(
        self, enabled_gen: SkillAutoGenerator, sample_history: list[dict]
    ):
        """完整链路：history → analyze → generate → save → list"""
        # 1. 分析历史
        analysis = enabled_gen.analyze_history(sample_history)
        assert analysis["generated_count"] >= 1

        # 2. 对每个模式生成 + 保存 Skill
        saved_paths: list[Path] = []
        for pattern in analysis["patterns"]:
            content = enabled_gen.generate_skill(pattern)
            path = enabled_gen.save_skill(pattern["pattern"], content)
            saved_paths.append(path)
            assert path.exists()
            assert path.read_text(encoding="utf-8") == content

        # 3. list_auto_skills 应能列出全部已保存的 Skill
        skills = enabled_gen.list_auto_skills()
        assert len(skills) == len(saved_paths)

        # 4. 验证保存的 SKILL.md 能被 parser 解析
        from skills.parser import parse_skill_md
        for path in saved_paths:
            skill = parse_skill_md(path)
            assert skill.name  # 不为空


# ============================================================================
# 辅助 Mock
# ============================================================================

class _MockDispatcher:
    """模拟 JSON-RPC dispatcher（用于测试 register_methods）"""

    def __init__(self) -> None:
        self.methods: dict[str, object] = {}

    def register(self, name: str, handler: object) -> None:
        self.methods[name] = handler
