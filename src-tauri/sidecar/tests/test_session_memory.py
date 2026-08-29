"""
tests/test_session_memory.py — 会话记忆沉淀单元测试（方案书 v3.0 T14）
======================================================================

验证内容：
1. summarize_session
   - LLM 可用 → 摘要写入 RAG（source=session-memory，tags 含 session:<id>）
   - LLM 不可用 → 截断回退仍写入（离线可用）
   - 幂等：同 session 两次沉淀 = 同一条目覆盖（reused=True，总数不增）
   - 空入参拒绝
2. save_session_skill
   - 正常写入 ~/.tdsf/skills/<name>/SKILL.md（frontmatter 字段齐全）+ 触发热重载
   - 非法技能名拒绝（大写/路径穿越/空）
   - 缺 description/content 拒绝
3. JSON-RPC 注册：memory.summarize_session / memory.save_skill 可 dispatch
4. agent 工具 save_skill：工厂产出 __name__=="save_skill"，invoke 走通

运行：
    cd src-tauri/sidecar
    .venv/Scripts/python.exe -m pytest tests/test_session_memory.py -v
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

# 确保能 import sidecar 根目录模块
sys.path.insert(0, str(Path(__file__).parent.parent))

import session_memory
from session_memory import (
    register_methods,
    save_session_skill,
    summarize_session,
)


# ============================================================================
# 公共 fixture
# ============================================================================

def _reset_rag_to_tmp(tmp_path: Path):
    """把全局 RAG 重定向到临时库（隔离真实 rag.db）"""
    from knowledge.rag import reset_global_rag

    return reset_global_rag(db_path=tmp_path / "test-rag.db")


_SAMPLE_TRANSCRIPT = [
    {"role": "user", "content": "nginx 502 了，网站打不开，急"},
    {"role": "assistant", "content": "先查 php-fpm：systemctl status php-fpm 发现 dead。"},
    {"role": "user", "content": "然后呢"},
    {"role": "assistant", "content": "systemctl start php-fpm 后恢复。根因是 php-fpm 未自启。"},
]


class TestSummarizeSession(unittest.TestCase):
    """summarize_session — 摘要写入决策库"""

    def setUp(self):
        import tempfile

        self._tmp = Path(tempfile.mkdtemp(prefix="tdsf-t14-"))
        self.rag = _reset_rag_to_tmp(self._tmp)

    def test_summarize_writes_case_to_rag(self):
        """LLM 可用 → 摘要写入 RAG，id/source/tags 符合约定"""
        with patch.object(
            session_memory, "_llm_complete", return_value="## 问题现象\nnginx 502"
        ):
            result = summarize_session("sess-abc-1", _SAMPLE_TRANSCRIPT)

        self.assertTrue(result["ok"])
        self.assertFalse(result["reused"])
        self.assertEqual(result["case_id"], "session-memory-sess-abc-1")

        entry = self.rag.get(result["case_id"])
        self.assertIsNotNone(entry)
        self.assertEqual(entry["source"], "session-memory")
        self.assertIn("session:sess-abc-1", entry["tags"])
        self.assertIn("会话记忆", entry["tags"])
        self.assertIn("nginx 502", entry["content"])
        self.assertIn("会话记忆：", entry["title"])  # 自动标题取首条用户消息

    def test_summarize_fallback_without_llm(self):
        """LLM 不可用 → 截断回退仍写入（离线链路可用）"""
        with patch.object(session_memory, "_llm_complete", return_value=None):
            result = summarize_session("sess-llm-down", _SAMPLE_TRANSCRIPT)

        self.assertTrue(result["ok"])
        entry = self.rag.get(result["case_id"])
        self.assertIsNotNone(entry)
        self.assertIn("[会话摘要·截断]", entry["content"])
        self.assertIn("nginx 502", entry["content"])  # 截断摘要保留首部原文

    def test_summarize_idempotent_same_session(self):
        """同 session 两次沉淀 → 同条目覆盖（总数不增，reused=True）"""
        with patch.object(session_memory, "_llm_complete", return_value="摘要V1"):
            r1 = summarize_session("sess-dup", _SAMPLE_TRANSCRIPT)
        with patch.object(session_memory, "_llm_complete", return_value="摘要V2"):
            r2 = summarize_session("sess-dup", _SAMPLE_TRANSCRIPT)

        self.assertTrue(r1["ok"])
        self.assertTrue(r2["ok"])
        self.assertTrue(r2["reused"])
        self.assertEqual(r1["case_id"], r2["case_id"])
        # 全库只有这一条 session-memory 条目（覆盖而非新增）
        memories = [
            e for e in self.rag.list_entries(limit=100)
            if e["source"] == "session-memory"
        ]
        self.assertEqual(len(memories), 1)
        self.assertIn("摘要V2", memories[0]["content"])  # 后写覆盖

    def test_summarize_rejects_empty_inputs(self):
        """空 session_id / 空 transcript → ok=False"""
        self.assertFalse(summarize_session("", _SAMPLE_TRANSCRIPT)["ok"])
        self.assertFalse(summarize_session("sess-x", [])["ok"])
        self.assertFalse(summarize_session("sess-x", [{"role": "user", "content": " "}])["ok"])


class TestSaveSessionSkill(unittest.TestCase):
    """save_session_skill — SKILL.md 沉淀 + 热重载"""

    def setUp(self):
        import tempfile

        self._tmp = Path(tempfile.mkdtemp(prefix="tdsf-t14-"))
        self._skills_dir = self._tmp / "skills"
        self._reload_called = False
        self._reload_patcher = patch(
            "skills.registry.reload_global_registry",
            side_effect=self._mark_reload,
        )
        self._reload_patcher.start()
        self._dir_patcher = patch.object(
            session_memory, "_USER_SKILLS_DIR", self._skills_dir
        )
        self._dir_patcher.start()
        self.addCleanup(self._reload_patcher.stop)
        self.addCleanup(self._dir_patcher.stop)

    def _mark_reload(self):
        self._reload_called = True
        return None

    def test_save_skill_writes_md_and_reloads(self):
        """正常沉淀 → SKILL.md 落盘（frontmatter 齐全）+ reload 被调用"""
        result = save_session_skill(
            name="nginx-502-troubleshoot",
            description="nginx 502 排障流程",
            content="## 步骤\n1. systemctl status php-fpm\n2. systemctl start php-fpm",
            triggers=["502", "nginx"],
            allowed_tools=["ssh_command"],
        )

        self.assertTrue(result["ok"])
        self.assertTrue(result["reloaded"])
        self.assertTrue(self._reload_called)

        md_path = self._skills_dir / "nginx-502-troubleshoot" / "SKILL.md"
        self.assertTrue(md_path.exists())
        text = md_path.read_text(encoding="utf-8")
        self.assertIn("name: nginx-502-troubleshoot", text)
        self.assertIn("author: tdsf-session-memory", text)
        self.assertIn("triggers: [502, nginx]", text)
        self.assertIn("allowed-tools: [ssh_command]", text)
        self.assertIn("## 步骤", text)

    def test_save_skill_rejects_bad_names(self):
        """非法技能名拒绝：大写 / 空格 / 路径穿越 / 过短"""
        for bad in ("Nginx", "has space", "../escape", "a", ""):
            result = save_session_skill(
                name=bad, description="d", content="c"
            )
            self.assertFalse(result["ok"], f"bad name should be rejected: '{bad}'")
        # 目录未被意外创建
        self.assertFalse(self._skills_dir.exists())

    def test_save_skill_rejects_missing_fields(self):
        """缺 description / content → ok=False"""
        self.assertFalse(save_session_skill(name="ok-name", description="", content="c")["ok"])
        self.assertFalse(save_session_skill(name="ok-name", description="d", content="")["ok"])

    def test_save_skill_overwrite_existing(self):
        """同名技能重复沉淀 → 覆盖写入（内容更新）"""
        save_session_skill(name="dup-skill", description="v1", content="内容一")
        save_session_skill(name="dup-skill", description="v2", content="内容二")
        md = (self._skills_dir / "dup-skill" / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn("description: v2", md)
        self.assertIn("内容二", md)
        self.assertNotIn("内容一", md)


class TestRpcRegistration(unittest.TestCase):
    """memory.* JSON-RPC 注册"""

    def test_methods_registered_and_dispatchable(self):
        """dispatcher 有 memory.summarize_session / memory.save_skill，可真实 dispatch"""
        import tempfile

        tmp = Path(tempfile.mkdtemp(prefix="tdsf-t14-"))
        _reset_rag_to_tmp(tmp)

        from main import MethodDispatcher

        d = MethodDispatcher()
        register_methods(d)

        self.assertIn("memory.summarize_session", d._methods)
        self.assertIn("memory.save_skill", d._methods)

        with patch.object(session_memory, "_llm_complete", return_value="RPC 摘要"):
            result = d.dispatch(
                "memory.summarize_session",
                {"session_id": "rpc-sess", "transcript": _SAMPLE_TRANSCRIPT},
            )
        self.assertTrue(result["ok"])

        with patch.object(
            session_memory, "_USER_SKILLS_DIR", tmp / "skills"
        ):
            skill = d.dispatch(
                "memory.save_skill",
                {
                    "name": "rpc-made-skill",
                    "description": "RPC 建的技能",
                    "content": "正文",
                },
            )
        self.assertTrue(skill["ok"])


class TestSaveSkillAgentTool(unittest.TestCase):
    """agent 工具 save_skill（registry 第 20 个工具）"""

    def test_factory_and_invoke(self):
        """工厂产出 __name__=='save_skill'；invoke 落盘走通"""
        from strands_backend.tools.session_memory_tool import (
            invoke_save_skill,
            make_save_skill_tool,
        )

        import tempfile

        tmp = Path(tempfile.mkdtemp(prefix="tdsf-t14-"))

        def _fake_ctx():
            from strands_backend.tools import ToolContext

            return ToolContext(agent_name="t", session_id="s")

        tool_fn = make_save_skill_tool(_fake_ctx())
        self.assertEqual(getattr(tool_fn, "__name__", ""), "save_skill")

        with (
            patch.object(session_memory, "_USER_SKILLS_DIR", tmp / "skills"),
            patch("skills.registry.reload_global_registry", return_value=None),
        ):
            result = invoke_save_skill(
                {
                    "name": "tool-made-skill",
                    "description": "工具建的技能",
                    "content": "正文",
                },
                _fake_ctx(),
            )
        self.assertTrue(result["ok"])
        self.assertTrue((tmp / "skills" / "tool-made-skill" / "SKILL.md").exists())


if __name__ == "__main__":
    unittest.main()
