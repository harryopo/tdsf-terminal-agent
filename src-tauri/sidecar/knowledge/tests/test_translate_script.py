"""
knowledge/tests/test_translate_script.py — translate_knowledge.py 纯函数测试
=============================================================================

覆盖（任务 2 钦定）：
1. 长度校验 _is_length_ok：<30% / >300% 失败，空译文失败，区间内通过
2. 合批切分 _split_batch_reply：正常切回、缺失段空串、多段截断、噪声容忍
3. 合批方案 build_batches：小条目贪心合批（3-5 条/批）、大条目独占、
   字符上限封批
4. 断点续跑：official_entries 过滤 content_zh 非空条目（RagIndex 集成）

脚本不在包内（scripts/ 平铺文件），用 importlib 按路径加载。
"""
from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path

_SCRIPT = (
    Path(__file__).resolve().parents[2] / "scripts" / "translate_knowledge.py"
)
_spec = importlib.util.spec_from_file_location("translate_knowledge", _SCRIPT)
tk = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tk)


class TestLengthCheck(unittest.TestCase):
    def test_in_range_ok(self):
        self.assertTrue(tk._is_length_ok("a" * 100, "译" * 50))  # 50%

    def test_too_short_rejected(self):
        self.assertFalse(tk._is_length_ok("a" * 100, "译" * 10))  # 10% < 30%

    def test_too_long_rejected(self):
        self.assertFalse(tk._is_length_ok("a" * 100, "译" * 400))  # 400% > 300%

    def test_empty_rejected(self):
        self.assertFalse(tk._is_length_ok("a" * 100, ""))
        self.assertFalse(tk._is_length_ok("a" * 100, "   "))

    def test_boundary_ok(self):
        self.assertTrue(tk._is_length_ok("a" * 100, "译" * 30))  # 恰 30%
        self.assertTrue(tk._is_length_ok("a" * 100, "译" * 300))  # 恰 300%


class TestSplitBatchReply(unittest.TestCase):
    def test_normal_split(self):
        reply = "===zh-sep-0===\n第一段译文\n===zh-sep-1===\n第二段译文"
        self.assertEqual(tk._split_batch_reply(reply, 2), ["第一段译文", "第二段译文"])

    def test_missing_segment_returns_empty(self):
        """LLM 漏掉第二段分隔符 → 对应段空串（调用方兜底重试）"""
        reply = "===zh-sep-0===\n第一段译文"
        self.assertEqual(tk._split_batch_reply(reply, 2), ["第一段译文", ""])

    def test_extra_segments_truncated(self):
        """LLM 多输出的段丢弃（截断到 n）"""
        reply = (
            "===zh-sep-0===\nA\n===zh-sep-1===\nB\n===zh-sep-2===\nC"
        )
        self.assertEqual(tk._split_batch_reply(reply, 2), ["A", "B"])

    def test_noise_before_first_sep_dropped(self):
        """首个分隔符之前的杂音文字丢弃"""
        reply = "好的，以下是译文：\n===zh-sep-0===\n译文正文"
        self.assertEqual(tk._split_batch_reply(reply, 1), ["译文正文"])


class TestBuildBatches(unittest.TestCase):
    def _entries(self, sizes: list[int]) -> list[dict]:
        return [{"id": str(i), "content": "x" * n} for i, n in enumerate(sizes)]

    def test_small_entries_grouped(self):
        batches = tk.build_batches(self._entries([100, 120, 110, 130]))
        self.assertEqual(batches, [[0, 1, 2, 3]])

    def test_large_entry_solo(self):
        """大条目（≥1500 字符）独占一批，不与小条目混批"""
        batches = tk.build_batches(self._entries([100, 2000, 150]))
        self.assertEqual(batches, [[0], [1], [2]])

    def test_batch_item_limit(self):
        """超过 _BATCH_MAX_ITEMS 条封批"""
        sizes = [100] * (tk._BATCH_MAX_ITEMS + 1)
        batches = tk.build_batches(self._entries(sizes))
        self.assertEqual(batches[0], list(range(tk._BATCH_MAX_ITEMS)))
        self.assertEqual(batches[1], [tk._BATCH_MAX_ITEMS])

    def test_batch_char_limit(self):
        """批内总字符超 _BATCH_MAX_CHARS 提前封批"""
        per = tk._BATCH_MAX_CHARS // 2 + 10
        batches = tk.build_batches(self._entries([per, per]))
        self.assertEqual(len(batches), 2)
        self.assertEqual(batches[0], [0])
        self.assertEqual(batches[1], [1])


class TestResumeSkip(unittest.TestCase):
    """断点续跑：content_zh 非空的条目被过滤（main 过滤逻辑的集成验证）"""

    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix="tdsf-tr-test-")
        from knowledge.rag import RagIndex

        self.rag = RagIndex(db_path=Path(self._tmp) / "rag.db")

    def tearDown(self):
        self.rag.close()
        try:
            import shutil

            shutil.rmtree(self._tmp, ignore_errors=True)
        except OSError:
            pass

    def test_official_entries_exposes_content_zh(self):
        from knowledge.fts5 import KnowledgeEntry

        e1 = KnowledgeEntry(
            title="t1", content="english body", source="nginx-docs"
        )
        e2 = KnowledgeEntry(
            title="t2", content="another body", source="nginx-docs"
        )
        self.rag.add(e1)
        self.rag.add(e2)
        self.rag.update_content_zh(e1.id, "第一条的中文译文")
        entries = self.rag.official_entries()
        by_id = {e["id"]: e for e in entries}
        self.assertTrue(by_id[e1.id]["content_zh"])
        self.assertIsNone(by_id[e2.id]["content_zh"])
        # main() 的断点过滤：非空 content_zh 跳过
        todo = [e for e in entries if not (e.get("content_zh") or "").strip()]
        self.assertEqual([e["id"] for e in todo], [e2.id])


if __name__ == "__main__":
    unittest.main()
