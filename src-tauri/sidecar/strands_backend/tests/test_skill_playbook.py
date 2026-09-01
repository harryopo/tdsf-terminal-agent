"""
strands_backend/tests/test_skill_playbook.py — T6 Skill 剧本化单测
==========================================================================

spec: add-agent-loop-closure Task 6（steps 剧本解析 + 注入 + todo 同步）

覆盖：
1. playbook 解析：frontmatter steps YAML 列表（全字段/缺可选字段）/
   容错（非 list / 非 dict 项 / 缺 description）/ to_dict-from_dict 往返
2. 内置样板技能结构合法：systemd-troubleshoot 五步 / selinux-baseline 四步
   （每步有 description，知识正文保留不受影响）
3. 剧本注入：invoke_skill_tool 命中带剧本技能 → 返回体含 playbook
   （结构化）+ playbook_text（"请按以下步骤执行…每步完成后用工具验证
   成功判据"格式，含编号/建议工具/成功判据）
4. todo 同步：剧本步骤写入 per-session 镜像（每步一项 pending）；
   已有清单合并追加不覆盖；重复调用同技能不重复追加

运行：
    cd src-tauri/sidecar
    python -m pytest strands_backend/tests/test_skill_playbook.py -v
"""
from __future__ import annotations

import os
import sys
from unittest.mock import MagicMock

import pytest

_SIDECAR_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if _SIDECAR_DIR not in sys.path:
    sys.path.insert(0, _SIDECAR_DIR)

from skills.parser import Skill, parse_skill_content, parse_skill_md  # noqa: E402


# ============================================================================
# Fixtures / 辅助
# ============================================================================

BUILTIN_DIR = os.path.join(_SIDECAR_DIR, "skills", "builtin")


@pytest.fixture(autouse=True)
def _isolate_todos():
    from strands_backend.tools.todo_write import reset_session_todos

    reset_session_todos()
    yield
    reset_session_todos()


def _make_ctx(session_id="t6-s1"):
    """skill_invoke 直调所需的 ToolContext mock（无 rust_bridge/event_bus 副作用）"""
    ctx = MagicMock()
    ctx.session_id = session_id
    ctx.agent_name = "main"
    ctx.rust_bridge = None
    ctx.event_bus = None
    return ctx


def _make_fake_registry(monkeypatch, skills):
    """把全局 registry 替换为受控 fake（invoke 直调 invoke() 返回预置 dict）"""
    fake = MagicMock()
    fake.invoke = lambda name, params=None: skills[name.lower()]
    fake.list = lambda: []
    monkeypatch.setattr("skills.registry.get_global_registry", lambda: fake)
    return fake


# ============================================================================
# 1. playbook 解析（parser）
# ============================================================================


class TestPlaybookParsing:
    def test_full_playbook_parsed(self):
        """全字段 YAML 列表 → 每步含 description/tool_hint/success_criteria"""
        content = """---
name: playbook-full
description: 全字段剧本
steps:
  - description: "查服务状态"
    tool_hint: "ssh_command"
    success_criteria: "拿到 active/failed 与退出码"
  - description: "看日志"
    tool_hint: "analyze_logs"
    success_criteria: "读到具体报错"
---
# Test
"""
        skill = parse_skill_content(content)
        assert len(skill.playbook) == 2
        assert skill.playbook[0]["description"] == "查服务状态"
        assert skill.playbook[0]["tool_hint"] == "ssh_command"
        assert skill.playbook[0]["success_criteria"] == "拿到 active/failed 与退出码"
        assert skill.playbook[1]["description"] == "看日志"

    def test_playbook_optional_fields_missing(self):
        """缺 tool_hint/success_criteria 的步骤仍保留（只剩 description）"""
        content = """---
name: playbook-minimal
steps:
  - description: "只有描述"
---
# Test
"""
        skill = parse_skill_content(content)
        assert len(skill.playbook) == 1
        assert skill.playbook[0] == {"description": "只有描述"}

    def test_playbook_not_a_list_ignored(self):
        """steps 为字符串（非列表）→ 剧本忽略，返回空"""
        content = """---
name: playbook-str
steps: "不是列表"
---
# Test
"""
        skill = parse_skill_content(content)
        assert skill.playbook == []

    def test_playbook_non_dict_items_skipped(self):
        """列表内非 dict 项跳过，合法项保留"""
        content = """---
name: playbook-mixed
steps:
  - "纯字符串项"
  - description: "合法步骤"
---
# Test
"""
        skill = parse_skill_content(content)
        assert skill.playbook == [{"description": "合法步骤"}]

    def test_playbook_missing_description_skipped(self):
        """缺 description 的步骤跳过（必须有可执行的描述）"""
        content = """---
name: playbook-nodesc
steps:
  - tool_hint: "ssh_command"
  - description: "合法步骤"
---
# Test
"""
        skill = parse_skill_content(content)
        assert skill.playbook == [{"description": "合法步骤"}]

    def test_playbook_absent_is_empty(self):
        """无 steps 字段 → 空剧本（纯知识卡，行为不变）"""
        content = """---
name: no-playbook
description: 无剧本
---
# Test
"""
        skill = parse_skill_content(content)
        assert skill.playbook == []

    def test_playbook_roundtrip(self):
        """to_dict / from_dict 往返保留剧本"""
        original = Skill(
            name="roundtrip",
            playbook=[{"description": "s1", "tool_hint": "t"}],
        )
        restored = Skill.from_dict(original.to_dict())
        assert restored.playbook == [{"description": "s1", "tool_hint": "t"}]

    def test_playbook_coexists_with_body_steps_section(self):
        """frontmatter steps（剧本）与 body "## Steps"（知识文本）并存不互扰"""
        content = """---
name: coexist
steps:
  - description: "剧本步骤"
---
# Test

## Steps
1. 知识文本步骤

## Examples
示例
"""
        skill = parse_skill_content(content)
        assert skill.playbook == [{"description": "剧本步骤"}]
        assert "知识文本步骤" in skill.steps  # body Steps 章节原样保留


# ============================================================================
# 2. 内置样板技能结构（systemd-troubleshoot 五步 / selinux-baseline 四步）
# ============================================================================


class TestBuiltinPlaybooks:
    def test_systemd_troubleshoot_has_five_step_playbook(self):
        """systemd-troubleshoot 五步剧本：每步有 description，含验证步骤"""
        skill = parse_skill_md(
            os.path.join(BUILTIN_DIR, "systemd-troubleshoot", "SKILL.md")
        )
        assert skill.name == "systemd-troubleshoot"
        assert len(skill.playbook) == 5
        for step in skill.playbook:
            assert step.get("description"), "每个剧本步骤必须有 description"
        # 剧本主线：status → journalctl → 定位 → 修复 → 验证
        descriptions = "".join(step["description"] for step in skill.playbook)
        assert "systemctl status" in descriptions
        assert "journalctl" in descriptions
        assert "验证" in skill.playbook[-1]["description"]
        # 知识正文保留（steps 章节文本不受 frontmatter 剧本影响）
        assert "风险评估" in skill.steps
        assert skill.executor is not None  # executor 与剧本共存

    def test_selinux_baseline_has_four_step_playbook(self):
        """selinux-baseline 四步剧本：getenforce → ls -Z → 调整 → 验证"""
        skill = parse_skill_md(
            os.path.join(BUILTIN_DIR, "selinux-baseline", "SKILL.md")
        )
        assert skill.name == "selinux-baseline"
        assert len(skill.playbook) == 4
        descriptions = "".join(step["description"] for step in skill.playbook)
        assert "getenforce" in descriptions
        assert "ls -Z" in descriptions or "安全上下文" in descriptions
        assert "验证" in skill.playbook[-1]["description"]
        assert "风险评估" in skill.steps  # 知识正文保留
        assert skill.executor is not None

    def test_other_builtin_skills_playbook_empty(self):
        """其余内置技能无剧本 → playbook 为空列表（行为不变）"""
        for name in ("linux-ops", "ssh-troubleshoot", "docker-management",
                     "python-debug", "samba-setup"):
            skill = parse_skill_md(os.path.join(BUILTIN_DIR, name, "SKILL.md"))
            assert skill.playbook == [], f"{name} 不应带剧本"


# ============================================================================
# 3. skill_invoke 剧本注入
# ============================================================================


class TestSkillInvokePlaybookInjection:
    def _knowledge_card(self, playbook):
        """知识卡模式的 registry.invoke 返回（无 executor）"""
        return {
            "name": "demo-playbook",
            "description": "演示技能",
            "content": "# 演示知识卡\n正文",
            "when_to_use": "触发条件",
            "steps": "1. 知识步骤",
            "examples": "示例",
            "tags": ["demo"],
            "triggers": [],
            "allowed_tools": [],
            "playbook": playbook,
            "params": {},
            "source": "builtin",
        }

    def test_playbook_injected_in_result(self, monkeypatch):
        """命中带剧本技能 → 返回体含 playbook + playbook_text"""
        from strands_backend.tools.skill_invoke import invoke_skill_tool

        playbook = [
            {"description": "第一步", "tool_hint": "ssh_command",
             "success_criteria": "判据A"},
            {"description": "第二步"},
        ]
        _make_fake_registry(
            monkeypatch, {"demo-playbook": self._knowledge_card(playbook)}
        )
        result = invoke_skill_tool({"skill_name": "demo-playbook"}, _make_ctx("t6-i1"))
        assert result["status"] == "success"
        assert result["playbook"] == playbook
        text = result["playbook_text"]
        assert "请按以下步骤执行，每步完成后用工具验证成功判据" in text
        assert "1. 第一步" in text
        assert "建议工具：ssh_command" in text
        assert "成功判据：判据A" in text
        assert "2. 第二步" in text
        # 第 2 行不应带可选段（无 tool_hint/success_criteria）
        second_line = text.splitlines()[2]
        assert second_line == "2. 第二步"

    def test_no_playbook_no_injection(self, monkeypatch):
        """无剧本技能 → 返回体不含 playbook 字段（行为不变）"""
        from strands_backend.tools.skill_invoke import invoke_skill_tool

        _make_fake_registry(
            monkeypatch, {"plain": self._knowledge_card([])}
        )
        result = invoke_skill_tool({"skill_name": "plain"}, _make_ctx("t6-i2"))
        assert result["status"] == "success"
        assert "playbook" not in result
        assert "playbook_text" not in result

    def test_executor_mode_also_injects_playbook(self, monkeypatch):
        """executor 模式（systemd 类）同样注入剧本（结构化 + 文本）"""
        from strands_backend.tools.skill_invoke import invoke_skill_tool

        playbook = [{"description": "验证步骤", "success_criteria": "active"}]
        _make_fake_registry(monkeypatch, {
            "exec-playbook": {
                "name": "exec-playbook",
                "executor": {"type": "shell", "command": "true"},
                "success": True,
                "exit_code": 0,
                "output": "ok",
                "stdout": "ok",
                "stderr": "",
                "duration_ms": 1,
                "params": {},
                "source": "builtin",
                "playbook": playbook,
            }
        })
        result = invoke_skill_tool({"skill_name": "exec-playbook"}, _make_ctx("t6-i3"))
        assert result["status"] == "success"
        assert result["playbook"] == playbook
        assert "请按以下步骤执行" in result["playbook_text"]
        assert "验证步骤" in result["playbook_text"]

    def test_build_playbook_text_empty(self):
        """空剧本 → 空文本"""
        from strands_backend.tools.skill_invoke import build_playbook_text

        assert build_playbook_text([]) == ""


# ============================================================================
# 4. 剧本步骤同步 todo（复用 T3 收尾校验）
# ============================================================================


class TestPlaybookTodoSync:
    def _playbook(self):
        return [
            {"description": f"步骤{i}", "tool_hint": "ssh_command",
             "success_criteria": f"判据{i}"}
            for i in range(1, 4)
        ]

    def test_playbook_synced_to_todos(self, monkeypatch):
        """命中带剧本技能 → 步骤写入 todo 镜像（每步一项 pending）"""
        from strands_backend.tools.skill_invoke import invoke_skill_tool
        from strands_backend.tools.todo_write import get_session_todos

        card = {
            "name": "demo", "content": "知识卡", "steps": "", "examples": "",
            "when_to_use": "", "tags": [], "triggers": [], "allowed_tools": [],
            "playbook": self._playbook(), "params": {}, "source": "builtin",
        }
        _make_fake_registry(monkeypatch, {"demo": card})

        invoke_skill_tool({"skill_name": "demo"}, _make_ctx("t6-t1"))

        todos = get_session_todos("t6-t1")
        assert len(todos) == 3
        assert all(t["status"] == "pending" for t in todos)
        assert "[demo] 1/3 步骤1" in todos[0]["title"]
        assert todos[0]["description"] == "建议工具：ssh_command；成功判据：判据1"

    def test_existing_todos_merged_not_overwritten(self, monkeypatch):
        """已有清单合并追加：原任务保留在前，剧本步骤追加在后"""
        from strands_backend.tools.skill_invoke import invoke_skill_tool
        from strands_backend.tools.todo_write import (
            get_session_todos,
            invoke_todo_write_tool,
        )

        invoke_todo_write_tool(
            {"todos": [{"id": "orig", "title": "用户原有任务", "status": "in_progress"}]},
            _make_ctx("t6-t2"),
        )
        card = {
            "name": "demo", "content": "知识卡", "steps": "", "examples": "",
            "when_to_use": "", "tags": [], "triggers": [], "allowed_tools": [],
            "playbook": self._playbook(), "params": {}, "source": "builtin",
        }
        _make_fake_registry(monkeypatch, {"demo": card})

        invoke_skill_tool({"skill_name": "demo"}, _make_ctx("t6-t2"))

        todos = get_session_todos("t6-t2")
        assert len(todos) == 4
        assert todos[0]["title"] == "用户原有任务"
        assert todos[0]["status"] == "in_progress"
        assert "[demo] 1/3 步骤1" in todos[1]["title"]

    def test_repeated_invoke_no_duplicate_todos(self, monkeypatch):
        """重复调用同技能：步骤已在清单（title 去重），不重复追加"""
        from strands_backend.tools.skill_invoke import invoke_skill_tool
        from strands_backend.tools.todo_write import get_session_todos

        card = {
            "name": "demo", "content": "知识卡", "steps": "", "examples": "",
            "when_to_use": "", "tags": [], "triggers": [], "allowed_tools": [],
            "playbook": self._playbook(), "params": {}, "source": "builtin",
        }
        _make_fake_registry(monkeypatch, {"demo": card})
        ctx = _make_ctx("t6-t3")

        invoke_skill_tool({"skill_name": "demo"}, ctx)
        invoke_skill_tool({"skill_name": "demo"}, ctx)

        todos = get_session_todos("t6-t3")
        assert len(todos) == 3  # 不翻倍

    def test_unfinished_playbook_covers_t3_followup_source(self, monkeypatch):
        """剧本步骤写入后 T3 收尾校验数据源就绪：未完成步骤会被 get_unfinished_todos 捕获"""
        from strands_backend.tools.skill_invoke import invoke_skill_tool
        from strands_backend.tools.todo_write import get_unfinished_todos

        card = {
            "name": "demo", "content": "知识卡", "steps": "", "examples": "",
            "when_to_use": "", "tags": [], "triggers": [], "allowed_tools": [],
            "playbook": self._playbook(), "params": {}, "source": "builtin",
        }
        _make_fake_registry(monkeypatch, {"demo": card})

        invoke_skill_tool({"skill_name": "demo"}, _make_ctx("t6-t4"))

        unfinished = get_unfinished_todos("t6-t4")
        assert len(unfinished) == 3  # T3 _maybe_todo_followup 由此驱动

    def test_todo_sync_failure_does_not_break_skill_result(self, monkeypatch):
        """todo 同步异常 → warning 降级，skill 主返回不受影响"""
        from strands_backend.tools import skill_invoke as si
        from strands_backend.tools.skill_invoke import invoke_skill_tool

        monkeypatch.setattr(si, "_sync_playbook_to_todos",
                            MagicMock(side_effect=RuntimeError("todo exploded")))
        card = {
            "name": "demo", "content": "知识卡", "steps": "", "examples": "",
            "when_to_use": "", "tags": [], "triggers": [], "allowed_tools": [],
            "playbook": self._playbook(), "params": {}, "source": "builtin",
        }
        _make_fake_registry(monkeypatch, {"demo": card})

        result = invoke_skill_tool({"skill_name": "demo"}, _make_ctx("t6-t5"))
        assert result["status"] == "success"
        assert "playbook_text" in result  # 剧本注入不受 todo 失败影响


if __name__ == "__main__":
    import unittest

    unittest.main()
