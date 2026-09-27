"""#158-② 会话记忆沉淀：进库之前必须过脱敏（否则凭据被长期留存并每轮回灌）。

判据来源（2026-09-26 推送前安全复查的收尾项）：`session_memory.summarize_session`
把 LLM 摘要（或离线截断回退）与自动标题**原样**写进知识库，之后每轮对话按 recall
重新注入 prompt ⇒ 用户在聊天里粘过一次 API key / 密码，它就被永久存进本地库，
并在之后每一次会话里反复送到模型提供商。这与 #155 是同一个洞的剩余半边：
#155 管住"工具结果进模型"，这一条管住"聊天内容进长期记忆"。

四条判据，覆盖**两个写入点**（LLM 摘要 / 离线截断回退）与**两个字段**（正文 / 自动标题）：
1 LLM 摘要里的密钥不许进库；2 自动标题（取首条用户消息前 40 字）里的密钥不许进库；
3 LLM 不可用时的截断回退同样要过（#147 那条"两条不走 LLM 的写入点是漏的半边"的教训）；
4 接线断言 —— 构造 `KnowledgeEntry` 时必须走脱敏 helper，防止以后被"优化"掉。
每条都配**正向配对**：正常排障文本必须原样保留（脱敏不许把记忆吃掉）。
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import session_memory
from session_memory import summarize_session

# 形状合法的假凭据（与前端 redact.test.ts 同一约定）。
# 注意：AWS 那类"前缀+16位"的示例 ID 不要写成整串字面量 —— GitHub 密钥扫描会当真（#157 吃过）。
_FAKE_OPENAI_KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz012345"
_FAKE_DB_PASSWORD = "DB_PASSWORD=hunter2hunter2"


def _transcript_with_secret() -> list[dict[str, str]]:
    return [
        {"role": "user", "content": f"帮我看看配置，我的 key 是 {_FAKE_OPENAI_KEY}"},
        {"role": "assistant", "content": "先查 php-fpm：systemctl status php-fpm 发现 dead。"},
        {"role": "user", "content": f"数据库口令写在这里 {_FAKE_DB_PASSWORD}"},
        {"role": "assistant", "content": "systemctl start php-fpm 后恢复。根因是 php-fpm 未自启。"},
    ]


class TestSessionMemoryRedaction(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp(prefix="tdsf-mem-redact-"))
        from knowledge.rag import reset_global_rag

        self.rag = reset_global_rag(db_path=self._tmp / "rag.db")

    def tearDown(self) -> None:
        from knowledge.rag import reset_global_rag

        reset_global_rag()  # 不把临时库留给同进程里的其他用例

    def _stored(self, case_id: str) -> dict:
        entry = self.rag.get(case_id)
        self.assertIsNotNone(entry, f"条目没写进库：{case_id}")
        return entry

    def test_llm_summary_secret_is_not_stored(self) -> None:
        summary = (
            "## 结论\nphp-fpm 未自启导致 502。\n"
            "## 现场\n用户贴过 key：" + _FAKE_OPENAI_KEY
        )
        with patch.object(session_memory, "_llm_complete", return_value=summary):
            result = summarize_session("s-redact-1", _transcript_with_secret())

        self.assertTrue(result["ok"])
        entry = self._stored(result["case_id"])
        self.assertNotIn(_FAKE_OPENAI_KEY, entry["content"])
        self.assertIn("<REDACTED", entry["content"])
        # 正向配对：记忆本身不许被吃掉
        self.assertIn("php-fpm 未自启导致 502", entry["content"])

    def test_auto_title_secret_is_not_stored(self) -> None:
        """自动标题取"首条用户消息前 40 字"——密钥常常就在第一句里。

        这里必须用**装得进 40 字**的形状：上一版拿 40 字符长的 openai key 测，
        标题截断后整串本来就不在里面 ⇒ 断言"没出现"为真却什么也没测（假绿）。
        """
        transcript = [
            {"role": "user", "content": "口令是 DB_PASSWORD=hunter2hunter2 对吗"},
            {"role": "assistant", "content": "我不该复述它"},
        ]
        with patch.object(session_memory, "_llm_complete", return_value="摘要"):
            result = summarize_session("s-redact-2", transcript)

        entry = self._stored(result["case_id"])
        self.assertIn("hunter2hunter2", "口令是 DB_PASSWORD=hunter2hunter2 对吗"[:40])  # 前提：整串本来进得了标题
        self.assertNotIn("hunter2hunter2", entry["title"])
        self.assertIn("会话记忆：", entry["title"])  # 标题结构还在

    def test_offline_fallback_summary_is_also_redacted(self) -> None:
        """LLM 不可用 → 截断回退。这是"两条不走 LLM 的写入点"里最容易漏的那一条。"""
        with patch.object(session_memory, "_llm_complete", return_value=None):
            result = summarize_session("s-redact-3", _transcript_with_secret())

        entry = self._stored(result["case_id"])
        self.assertIn("[会话摘要·截断]", entry["content"])
        self.assertNotIn(_FAKE_OPENAI_KEY, entry["content"])
        self.assertNotIn("hunter2hunter2", entry["content"])
        self.assertIn("php-fpm", entry["content"])  # 排障主线还在

    def test_caller_supplied_title_is_redacted_too(self) -> None:
        """外部传进来的 title 同样不可信（前端会话标题可能含用户粘贴的内容）。"""
        with patch.object(session_memory, "_llm_complete", return_value="摘要"):
            result = summarize_session(
                "s-redact-4",
                _transcript_with_secret(),
                title=f"排障 {_FAKE_OPENAI_KEY}",
            )

        entry = self._stored(result["case_id"])
        self.assertNotIn(_FAKE_OPENAI_KEY, entry["title"])
        self.assertIn("排障", entry["title"])

    def test_plain_memory_text_is_left_untouched(self) -> None:
        """不许过度脱敏：正常排障文本必须一字不动（否则记忆失去价值）。"""
        plain = "## 现象\nnginx 502\n## 结论\nupstream 超时，改 php-fpm 监听后恢复"
        with patch.object(session_memory, "_llm_complete", return_value=plain):
            result = summarize_session(
                "s-redact-5",
                [
                    {"role": "user", "content": "nginx 502 了"},
                    {"role": "assistant", "content": "改 php-fpm 监听后恢复"},
                ],
            )

        entry = self._stored(result["case_id"])
        self.assertEqual(entry["content"], plain)
        self.assertEqual(entry["title"], "会话记忆：nginx 502 了")

    def test_storage_path_calls_the_redaction_helper(self) -> None:
        """接线断言：写库路径上 title 与 summary 两个字段都必须过脱敏 helper。

        只测行为不够 —— 以后有人"嫌慢"把 helper 摘掉，行为用例会红，
        但这条能在改动当下就指出"进库那一步不再脱敏"（#142/#155 同一类"实现了没接上"）。
        """
        src = Path(session_memory.__file__).read_text(encoding="utf-8")
        body = src.split("def summarize_session(", 1)[1]
        # 写库之前的那一段（到 rag.add 为止）
        region = body.split(".add(", 1)[0]
        self.assertGreaterEqual(
            region.count("_redact_for_storage("),
            2,
            "title 与 summary 必须各过一遍脱敏 helper 再进库",
        )


if __name__ == "__main__":
    unittest.main()
