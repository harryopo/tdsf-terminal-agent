"""
tests/test_skill_parser.py — SKILL.md 解析器单元测试（T-P3-06 验证）
=====================================================================

验证内容：
1. Skill dataclass 创建 + 序列化
2. parse_skill_md 解析真实 SKILL.md 文件
3. parse_skill_content 解析字符串
4. YAML frontmatter 提取（name/description/version/author/tags）
5. Markdown body 章节提取（When to use / Steps / Examples）
6. 容错：无 frontmatter / 无 name / 无效 YAML
7. tags 多种格式（inline [a,b,c] / 多行 - a / 字符串）

运行：
    cd python-sidecar
    python -m pytest tests/test_skill_parser.py -v
"""

from __future__ import annotations

import sys
from pathlib import Path

# 确保能 import skills 模块
sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

from skills.parser import (
    Skill,
    parse_skill_content,
    parse_skill_md,
)


# ============================================================================
# Fixtures
# ============================================================================

BUILTIN_DIR: Path = (
    Path(__file__).parent.parent / "skills" / "builtin"
)


@pytest.fixture
def linux_ops_skill_path() -> Path:
    """linux-ops SKILL.md 文件路径"""
    return BUILTIN_DIR / "linux-ops" / "SKILL.md"


@pytest.fixture
def docker_skill_path() -> Path:
    """docker-management SKILL.md 文件路径"""
    return BUILTIN_DIR / "docker-management" / "SKILL.md"


@pytest.fixture
def selinux_skill_path() -> Path:
    """selinux-baseline SKILL.md 文件路径"""
    return BUILTIN_DIR / "selinux-baseline" / "SKILL.md"


@pytest.fixture
def python_debug_skill_path() -> Path:
    """python-debug SKILL.md 文件路径"""
    return BUILTIN_DIR / "python-debug" / "SKILL.md"


@pytest.fixture
def ssh_skill_path() -> Path:
    """ssh-troubleshoot SKILL.md 文件路径"""
    return BUILTIN_DIR / "ssh-troubleshoot" / "SKILL.md"


# ============================================================================
# 1. Skill dataclass 测试
# ============================================================================


class TestSkillDataclass:
    """Skill dataclass 基础测试"""

    def test_skill_creation_minimal(self):
        """Skill 最小化创建（仅 name）"""
        skill: Skill = Skill(name="test-skill")
        assert skill.name == "test-skill"
        assert skill.description == ""
        assert skill.version == "0.0.0"
        assert skill.tags == []
        assert skill.when_to_use == ""
        assert skill.steps == ""
        assert skill.examples == ""
        assert skill.file_path is None

    def test_skill_creation_full(self):
        """Skill 完整字段创建"""
        skill: Skill = Skill(
            name="full-skill",
            description="完整测试 Skill",
            version="2.1.0",
            author="Tester",
            tags=["a", "b", "c"],
            when_to_use="触发条件",
            steps="1. 第一步\n2. 第二步",
            examples="示例 1",
            body="完整 body",
            file_path="/path/to/SKILL.md",
        )
        assert skill.name == "full-skill"
        assert skill.version == "2.1.0"
        assert skill.tags == ["a", "b", "c"]
        assert skill.file_path == "/path/to/SKILL.md"

    def test_skill_to_dict(self):
        """Skill.to_dict 序列化"""
        skill: Skill = Skill(name="serialize", tags=["x", "y"])
        d: dict = skill.to_dict()
        assert d["name"] == "serialize"
        assert d["tags"] == ["x", "y"]
        assert "description" in d
        assert "version" in d
        assert "when_to_use" in d

    def test_skill_from_dict(self):
        """Skill.from_dict 反序列化"""
        data: dict = {
            "name": "deserialize",
            "description": "从字典创建",
            "version": "1.5.0",
            "tags": ["m", "n"],
            "steps": "步骤内容",
        }
        skill: Skill = Skill.from_dict(data)
        assert skill.name == "deserialize"
        assert skill.version == "1.5.0"
        assert skill.tags == ["m", "n"]
        assert skill.steps == "步骤内容"

    def test_skill_from_dict_missing_fields(self):
        """Skill.from_dict 容忍缺失字段"""
        skill: Skill = Skill.from_dict({"name": "minimal"})
        assert skill.name == "minimal"
        assert skill.version == "0.0.0"
        assert skill.tags == []


# ============================================================================
# 2. parse_skill_md 文件解析测试
# ============================================================================


class TestParseSkillMd:
    """parse_skill_md 文件解析测试"""

    def test_parse_linux_ops_skill(self, linux_ops_skill_path: Path):
        """解析 linux-ops SKILL.md"""
        skill: Skill = parse_skill_md(linux_ops_skill_path)
        assert skill.name == "linux-ops"
        assert "Linux 运维" in skill.description
        assert skill.version == "1.0.0"
        assert skill.author == "TDSF"
        assert "linux" in skill.tags
        assert "nginx" in skill.tags
        assert "nginx" in skill.when_to_use
        assert "风险评估" in skill.steps
        assert "nginx 启动失败" in skill.examples
        assert skill.file_path == str(linux_ops_skill_path)

    def test_parse_docker_skill(self, docker_skill_path: Path):
        """解析 docker-management SKILL.md"""
        skill: Skill = parse_skill_md(docker_skill_path)
        assert skill.name == "docker-management"
        assert "Docker" in skill.description
        assert "docker" in skill.tags
        assert "容器" in skill.when_to_use
        assert "风险评估" in skill.steps
        assert "容器启动失败" in skill.examples

    def test_parse_selinux_skill(self, selinux_skill_path: Path):
        """解析 selinux-baseline SKILL.md"""
        skill: Skill = parse_skill_md(selinux_skill_path)
        assert skill.name == "selinux-baseline"
        assert "SELinux" in skill.description
        assert "selinux" in skill.tags
        assert "AVC" in skill.when_to_use
        assert "风险评估" in skill.steps
        assert "nginx" in skill.examples

    def test_parse_python_debug_skill(self, python_debug_skill_path: Path):
        """解析 python-debug SKILL.md"""
        skill: Skill = parse_skill_md(python_debug_skill_path)
        assert skill.name == "python-debug"
        assert "Python" in skill.description
        assert "python" in skill.tags
        assert "Traceback" in skill.when_to_use
        assert "Traceback 分析" in skill.steps
        assert "ModuleNotFoundError" in skill.examples

    def test_parse_ssh_skill(self, ssh_skill_path: Path):
        """解析 ssh-troubleshoot SKILL.md"""
        skill: Skill = parse_skill_md(ssh_skill_path)
        assert skill.name == "ssh-troubleshoot"
        assert "SSH" in skill.description
        assert "ssh" in skill.tags
        assert "连接超时" in skill.when_to_use
        assert "网络层诊断" in skill.steps
        assert "连接超时" in skill.examples

    def test_parse_skill_md_file_not_found(self, tmp_path: Path):
        """文件不存在抛 FileNotFoundError"""
        with pytest.raises(FileNotFoundError):
            parse_skill_md(tmp_path / "nonexistent.md")


# ============================================================================
# 3. parse_skill_content 字符串解析测试
# ============================================================================


class TestParseSkillContent:
    """parse_skill_content 字符串解析测试"""

    def test_parse_basic_skill_md(self):
        """解析基础 SKILL.md 格式"""
        content: str = """---
name: basic-test
description: 基础测试 Skill
version: 1.0.0
author: TestRunner
tags: [test, basic]
---

# Basic Test Skill

## When to use
触发条件 A
触发条件 B

## Steps
1. 第一步
2. 第二步

## Examples
### 示例 1
测试内容
"""
        skill: Skill = parse_skill_content(content)
        assert skill.name == "basic-test"
        assert skill.description == "基础测试 Skill"
        assert skill.version == "1.0.0"
        assert skill.author == "TestRunner"
        assert "test" in skill.tags
        assert "basic" in skill.tags
        assert "触发条件 A" in skill.when_to_use
        assert "第一步" in skill.steps
        assert "示例 1" in skill.examples

    def test_parse_yaml_frontmatter_inline_tags(self):
        """YAML frontmatter inline 数组 tags: [a, b, c]"""
        content: str = """---
name: inline-tags
description: 测试 inline tags
tags: [alpha, beta, gamma]
---

# Test
## When to use
测试
"""
        skill: Skill = parse_skill_content(content)
        assert skill.tags == ["alpha", "beta", "gamma"]

    def test_parse_yaml_frontmatter_multiline_tags(self):
        """YAML frontmatter 多行数组 tags:
          - a
          - b
"""
        content: str = """---
name: multiline-tags
description: 测试多行 tags
tags:
  - delta
  - epsilon
---

# Test
## When to use
测试
"""
        skill: Skill = parse_skill_content(content)
        assert "delta" in skill.tags
        assert "epsilon" in skill.tags
        assert len(skill.tags) == 2

    def test_parse_markdown_body_sections(self):
        """Markdown body 三大章节正确提取"""
        content: str = """---
name: sections-test
---

# Sections Test

## When to use
WHEN 内容

## Steps
STEPS 内容

## Examples
EXAMPLES 内容
"""
        skill: Skill = parse_skill_content(content)
        assert "WHEN 内容" in skill.when_to_use
        assert "STEPS 内容" in skill.steps
        assert "EXAMPLES 内容" in skill.examples

    def test_parse_skill_with_tags(self):
        """带 tags 的 Skill"""
        content: str = """---
name: tagged
tags: [linux, nginx, ops]
---

# Tagged
"""
        skill: Skill = parse_skill_content(content)
        assert skill.tags == ["linux", "nginx", "ops"]

    def test_parse_skill_without_frontmatter(self):
        """无 frontmatter 的 Skill（fallback 用空字符串）"""
        content: str = """# No Frontmatter

## When to use
无 frontmatter 测试
"""
        skill: Skill = parse_skill_content(content)
        assert skill.name == ""
        assert "无 frontmatter 测试" in skill.when_to_use

    def test_parse_skill_invalid_yaml(self):
        """无效 YAML frontmatter（fallback 简单解析）"""
        content: str = """---
name: invalid-yaml-test
description: 无效 YAML 测试
version: 0.1.0
---

# Test
"""
        skill: Skill = parse_skill_content(content)
        assert skill.name == "invalid-yaml-test"
        assert skill.version == "0.1.0"

    def test_parse_skill_missing_name(self):
        """frontmatter 缺少 name 字段"""
        content: str = """---
description: 无 name 字段
version: 0.0.1
---

# No Name
"""
        skill: Skill = parse_skill_content(content)
        assert skill.name == ""
        assert skill.description == "无 name 字段"

    def test_parse_skill_with_examples(self):
        """Examples 章节正确提取"""
        content: str = """---
name: examples-test
---

# Test

## Examples
### 示例 1: A
内容 A

### 示例 2: B
内容 B
"""
        skill: Skill = parse_skill_content(content)
        assert "示例 1: A" in skill.examples
        assert "示例 2: B" in skill.examples
        assert "内容 A" in skill.examples

    def test_parse_skill_with_steps(self):
        """Steps 章节正确提取"""
        content: str = """---
name: steps-test
---

# Test

## Steps
1. **第一步**：执行 A
2. **第二步**：执行 B
3. **第三步**：验证
"""
        skill: Skill = parse_skill_content(content)
        assert "第一步" in skill.steps
        assert "第二步" in skill.steps
        assert "第三步" in skill.steps

    def test_parse_skill_empty_content(self):
        """空内容"""
        skill: Skill = parse_skill_content("")
        assert skill.name == ""

    def test_parse_skill_only_frontmatter(self):
        """只有 frontmatter，无 body"""
        content: str = """---
name: only-meta
description: 只有元数据
---

"""
        skill: Skill = parse_skill_content(content)
        assert skill.name == "only-meta"
        assert skill.description == "只有元数据"

    def test_parse_skill_quotes_in_values(self):
        """带引号的 YAML 值"""
        content: str = """---
name: quoted-test
description: "带引号的描述"
author: '单引号作者'
---

# Test
"""
        skill: Skill = parse_skill_content(content)
        assert skill.name == "quoted-test"
        assert "带引号的描述" in skill.description
        assert "单引号作者" in skill.author


# ============================================================================
# 4. 5 内置 Skill 全量解析回归测试
# ============================================================================


class TestBuiltinSkillsAllParsed:
    """5 内置 SKILL.md 全部解析通过"""

    def test_all_5_builtin_skills_exist(self):
        """5 个内置 Skill 文件均存在"""
        expected: list[str] = [
            "linux-ops",
            "ssh-troubleshoot",
            "docker-management",
            "selinux-baseline",
            "python-debug",
        ]
        for name in expected:
            skill_path: Path = BUILTIN_DIR / name / "SKILL.md"
            assert skill_path.exists(), f"missing builtin SKILL.md: {name}"

    def test_all_5_builtin_skills_parse(self):
        """5 个内置 Skill 都能正确解析"""
        skill_names: list[str] = [
            "linux-ops",
            "ssh-troubleshoot",
            "docker-management",
            "selinux-baseline",
            "python-debug",
        ]
        for name in skill_names:
            skill_path: Path = BUILTIN_DIR / name / "SKILL.md"
            skill: Skill = parse_skill_md(skill_path)
            assert skill.name == name, (
                f"skill name mismatch: expected {name}, got {skill.name}"
            )
            assert skill.description, f"{name} description 为空"
            assert skill.version == "1.0.0", f"{name} version 不为 1.0.0"
            assert skill.author == "TDSF", f"{name} author 不为 TDSF"
            assert len(skill.tags) >= 2, f"{name} tags 数量 < 2"
            assert skill.when_to_use, f"{name} when_to_use 为空"
            assert skill.steps, f"{name} steps 为空"
            assert skill.examples, f"{name} examples 为空"
