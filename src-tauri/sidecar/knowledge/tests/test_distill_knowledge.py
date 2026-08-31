"""
knowledge/tests/test_distill_knowledge.py — distill_knowledge.py 纯函数测试
============================================================================

覆盖（任务 2 钦定）：
1. 章节聚合 aggregate_sections：多块→章节、块序号排序正确、title 双空格
   脏数据 normalize 合并、导语块（title 段数<2）归 "" 键、tags/category
   沿用首块、section_idx 文档内稳定编号
2. slim_entry_id：稳定幂等（同 url 同序 → 同 id）
3. 切片 slice_content：短文不切、段落边界切、超长单段硬切、还原无损
4. 校验 _is_distill_ok：40% 阈值、短片照抄判定、空输出失败
5. 合批切分 _split_batch_reply：正常切回、缺失段空串、噪声丢弃
6. 合批方案 build_batches：小章合批、大章独占、条数/字符上限
7. 断点跳过 filter_sections：已有 id 跳过、force 重跑、slim_id 回填
8. mock LLM：_distill_single 校验重试 / _distill_batch 切回兜底

脚本不在包内（scripts/ 平铺文件），用 importlib 按路径加载。
"""
from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

_SCRIPT = (
    Path(__file__).resolve().parents[2] / "scripts" / "distill_knowledge.py"
)
_spec = importlib.util.spec_from_file_location("distill_knowledge", _SCRIPT)
dk = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(dk)


def _chunk(eid: str, title: str, content: str, **kw) -> dict:
    e = {
        "id": eid,
        "title": title,
        "content": content,
        "url": kw.get("url", "consolidated/cmd-tools/Demo.md"),
        "source": kw.get("source", "demo-docs"),
        "category": kw.get("category", "cmd-tools"),
        "tags": kw.get("tags", ["合并文档", "file:Demo.md"]),
    }
    return e


class TestAggregateSections(unittest.TestCase):
    def test_multi_chunk_sections_merged_in_order(self):
        """同章节多块按 id 尾序排序拼接（字符串序 "10"<"2" 不乱序）"""
        entries = [
            _chunk("consol-h-2", "Demo · B 章 · 片段 · #2", "b2"),
            _chunk("consol-h-0", "Demo", "intro"),
            _chunk("consol-h-10", "Demo · B 章 · 片段 · #10", "b10"),
            _chunk("consol-h-1", "Demo · A 章 · ## A 章 · #1", "a1"),
        ]
        sections = dk.aggregate_sections(entries)
        self.assertEqual([s["title"] for s in sections], ["Demo", "A 章", "B 章"])
        self.assertEqual(sections[0]["content"], "intro")
        self.assertEqual(sections[1]["content"], "a1")
        # 块序 2, 10（数值序而非字符串序）
        self.assertEqual(sections[2]["content"], "b2\n\nb10")
        self.assertEqual(
            [s["section_idx"] for s in sections], [0, 1, 2]
        )

    def test_double_space_title_normalized(self):
        """title 文档名/标题段双空格脏数据 → normalize 后同章节合并"""
        entries = [
            _chunk("consol-h-0", "Web 服务器（Nginx  与 Apache） · 13. 缓存指南 · #1", "c1"),
            _chunk("consol-h-1", "Web 服务器（Nginx 与 Apache） · 13. 缓存指南 · #2", "c2"),
        ]
        sections = dk.aggregate_sections(entries)
        self.assertEqual(len(sections), 1)
        self.assertEqual(sections[0]["title"], "13. 缓存指南")
        self.assertEqual(sections[0]["content"], "c1\n\nc2")

    def test_metadata_from_first_chunk(self):
        """source/category/tags 沿用章节首块"""
        entries = [
            _chunk(
                "consol-h-0",
                "Demo · A 章 · #1",
                "x",
                source="nginx-docs",
                category="services",
                tags=["合并文档", "file:Demo.md"],
            ),
        ]
        s = dk.aggregate_sections(entries)[0]
        self.assertEqual(s["source"], "nginx-docs")
        self.assertEqual(s["category"], "services")
        self.assertEqual(s["tags"], ["合并文档", "file:Demo.md"])

    def test_sections_sorted_by_url(self):
        """多文档按 url 排序输出（稳定 id 编号的前提）"""
        entries = [
            _chunk("consol-b-0", "B · x", "b", url="consolidated/b.md"),
            _chunk("consol-a-0", "A · y", "a", url="consolidated/a.md"),
        ]
        sections = dk.aggregate_sections(entries)
        self.assertEqual([s["url"] for s in sections],
                         ["consolidated/a.md", "consolidated/b.md"])


class TestSlimEntryId(unittest.TestCase):
    def test_stable_id(self):
        a = dk.slim_entry_id("consolidated/cmd-tools/Demo.md", 3)
        b = dk.slim_entry_id("consolidated/cmd-tools/Demo.md", 3)
        self.assertEqual(a, b)
        self.assertRegex(a, r"^slim-[0-9a-f]{8}-3$")
        self.assertNotEqual(
            a, dk.slim_entry_id("consolidated/cmd-tools/Demo.md", 4)
        )
        self.assertNotEqual(
            a, dk.slim_entry_id("consolidated/cmd-tools/Other.md", 3)
        )


class TestSliceContent(unittest.TestCase):
    def test_short_not_sliced(self):
        self.assertEqual(dk.slice_content("short", 100), ["short"])

    def test_paragraph_boundary(self):
        paras = "\n\n".join(f"p{i} " + "x" * 40 for i in range(6))
        slices = dk.slice_content(paras, 100)
        self.assertGreater(len(slices), 1)
        # 每片 ≤ max_chars 且无内容丢失
        self.assertTrue(all(len(s) <= 100 for s in slices))
        self.assertEqual(
            "".join(s.replace("\n\n", "") for s in slices),
            paras.replace("\n\n", ""),
        )

    def test_oversized_paragraph_hard_split(self):
        para = "y" * 250
        slices = dk.slice_content(para, 100)
        self.assertEqual(len(slices), 3)
        self.assertEqual("".join(slices), para)


class TestDistillCheck(unittest.TestCase):
    """校验自适应上限 min(_verify_limit(src), 0.9×src)；空输出失败

    背景（三轮实测教训 2026-08-31）：模型对"提炼 25%"执行弱（输出常
    25-55%），靠「40% 校验 + 级联压缩」兜底而非放宽校验。
    """

    def test_medium_source_40pct(self):
        """verify(1093)=437（40% 源长）：合格/超限边界"""
        self.assertTrue(dk._is_distill_ok("a" * 1093, "精" * 437))
        self.assertFalse(dk._is_distill_ok("a" * 1093, "精" * 438))

    def test_long_slice_abs_cap(self):
        """verify(7563)=950（绝对上限封顶）：src=7563 out=940 通过"""
        self.assertTrue(dk._is_distill_ok("a" * 7563, "精" * 940))
        self.assertFalse(dk._is_distill_ok("a" * 7563, "精" * 951))

    def test_copy_expand_rejected(self):
        """输出 >0.9×源长 = 照抄/扩写（含短片幻扩场景）"""
        self.assertFalse(dk._is_distill_ok("a" * 123, "精" * 1175))
        self.assertFalse(dk._is_distill_ok("a" * 100, "精" * 95))

    def test_short_source_reasonable_ok(self):
        """短源：上限 = 40%×src（100 字符 → 40 字）"""
        self.assertTrue(dk._is_distill_ok("a" * 100, "精" * 40))
        self.assertFalse(dk._is_distill_ok("a" * 100, "精" * 41))

    def test_empty_rejected(self):
        self.assertFalse(dk._is_distill_ok("a" * 100, ""))
        self.assertFalse(dk._is_distill_ok("a" * 100, "   "))

    def test_verify_limit_bounds(self):
        """校验上限：min(40% 源长, 950)"""
        self.assertEqual(dk._verify_limit("x" * 1000), 400)   # 40%
        self.assertEqual(dk._verify_limit("x" * 7563), 950)   # 绝对封顶
        self.assertEqual(dk._verify_limit("x" * 5000), 950)   # 2000 > 950

    def test_recompress_ok(self):
        """二次压缩校验：非空且 200 ≤ len ≤ 650"""
        self.assertTrue(dk._is_recompress_ok("a" * 900, "精" * 500))
        self.assertTrue(dk._is_recompress_ok("a" * 900, "精" * 650))
        self.assertFalse(dk._is_recompress_ok("a" * 900, "精" * 651))  # 超上限
        self.assertFalse(dk._is_recompress_ok("a" * 900, "精" * 150))  # 删过头
        self.assertFalse(dk._is_recompress_ok("a" * 900, ""))

    def test_cascade_compress_recovers(self):
        """级联压缩：初稿超限 → 压缩稿合格 → 返回压缩稿"""

        def llm(messages):
            body = messages[-1]["content"]
            if "压缩到不超过" in body:
                return "精" * 300  # 压缩稿合格（≤437）
            return "精" * 1200  # 初稿超限

        out = dk._distill_single(llm, "a" * 1093)
        self.assertIsNotNone(out)
        self.assertEqual(len(out), 300)

    def test_cascade_still_over_returns_none(self):
        """级联后仍超限 → 最终失败返回 None"""

        def llm(messages):
            body = messages[-1]["content"]
            if "压缩到不超过" in body:
                return "精" * 1200  # 压缩稿也超限
            return "精" * 1200

        self.assertIsNone(dk._distill_single(llm, "a" * 1093))


class TestMaxOutChars(unittest.TestCase):
    def test_bounds(self):
        """25% 原文，下限 120、上限 600"""
        self.assertEqual(dk._max_out_chars("x" * 200), 120)   # 下限
        self.assertEqual(dk._max_out_chars("x" * 1093), 273)  # 25%
        self.assertEqual(dk._max_out_chars("x" * 8000), 600)  # 上限
        self.assertEqual(dk._max_out_chars("x" * 40000), 600)

    def test_prompt_contains_dynamic_limit(self):
        """prompt 里写入动态绝对字数（模型对绝对数字执行更好）"""
        src = "x" * 1093
        text = dk._PROMPT_TMPL.format(max_chars=dk._max_out_chars(src), body=src)
        self.assertIn("273", text)
        self.assertIn("只输出正文", text)


class TestSplitBatchReply(unittest.TestCase):
    def test_normal_split(self):
        reply = "===slim-sep-0===\n第一章要点\n===slim-sep-1===\n第二章要点"
        self.assertEqual(
            dk._split_batch_reply(reply, 2), ["第一章要点", "第二章要点"]
        )

    def test_missing_segment_returns_empty(self):
        reply = "===slim-sep-0===\n第一章要点"
        self.assertEqual(dk._split_batch_reply(reply, 2), ["第一章要点", ""])

    def test_noise_before_first_sep_dropped(self):
        reply = "好的，以下是提炼：\n===slim-sep-0===\n要点正文"
        self.assertEqual(dk._split_batch_reply(reply, 1), ["要点正文"])

    def test_extra_segments_truncated(self):
        reply = "===slim-sep-0===\nA\n===slim-sep-1===\nB\n===slim-sep-2===\nC"
        self.assertEqual(dk._split_batch_reply(reply, 2), ["A", "B"])


class TestBuildBatches(unittest.TestCase):
    def _sections(self, sizes: list[int]) -> list[dict]:
        return [{"content": "x" * n} for n in sizes]

    def test_small_sections_grouped(self):
        batches = dk.build_batches(self._sections([100, 120, 110, 130]))
        self.assertEqual(batches, [[0, 1, 2, 3]])

    def test_large_section_solo(self):
        batches = dk.build_batches(self._sections([100, 500, 150]))
        self.assertEqual(batches, [[0], [1], [2]])

    def test_batch_item_limit(self):
        sizes = [100] * (dk._BATCH_MAX_ITEMS + 1)
        batches = dk.build_batches(self._sections(sizes))
        self.assertEqual(batches[0], list(range(dk._BATCH_MAX_ITEMS)))

    def test_batch_char_limit(self):
        per = dk._BATCH_MAX_CHARS // 2 + 10
        batches = dk.build_batches(self._sections([per, per]))
        self.assertEqual(len(batches), 2)


class TestFilterSections(unittest.TestCase):
    def test_existing_skipped_and_slim_id_filled(self):
        sections = [
            {"url": "u1", "section_idx": 0},
            {"url": "u1", "section_idx": 1},
            {"url": "u2", "section_idx": 0},
        ]
        ids = {
            dk.slim_entry_id("u1", 0),
            dk.slim_entry_id("u2", 0),
        }
        todo = dk.filter_sections(sections, ids)
        self.assertEqual([s["section_idx"] for s in todo], [1])
        for s in sections:
            self.assertIn("slim_id", s)

    def test_force_reruns_all(self):
        sections = [{"url": "u1", "section_idx": 0}]
        ids = {dk.slim_entry_id("u1", 0)}
        todo = dk.filter_sections(sections, ids, force=True)
        self.assertEqual(len(todo), 1)


class TestMockLLM(unittest.TestCase):
    """mock LLM：校验失败重试 / 合批切回兜底"""

    def test_single_retry_until_ok(self):
        calls = {"n": 0}

        def llm(messages):
            calls["n"] += 1
            # 前两次照抄（失败），第三次给出精简版
            if calls["n"] < 3:
                return "x" * 2000
            return "核心要点：" + "精" * 100

        out = dk._distill_single(llm, "x" * 2000)
        self.assertIsNotNone(out)
        self.assertEqual(calls["n"], 3)

    def test_single_exhausted_returns_none(self):
        def llm(messages):
            return "x" * 5000  # 永远照抄

        self.assertIsNone(dk._distill_single(llm, "x" * 2000))

    def test_batch_fallback_to_single(self):
        """合批漏段 → 缺失段走单独提炼兜底"""

        def llm(messages):
            body = messages[-1]["content"]
            if "===slim-sep-1===" not in body:
                return "elsewhere"
            # 只回第一段，第二段缺失
            return "===slim-sep-0===\n" + "精" * 50

        results = dk._distill_batch(llm, ["x" * 1000, "y" * 1000])
        self.assertIsNotNone(results[0])
        self.assertIsNotNone(results[1])  # 兜底单独提炼成功

    def test_section_slice_join(self):
        """大章节切片：每片提炼成功后拼接"""
        big = "\n\n".join("x" * 900 for _ in range(12))  # ~10800 字 → 2 片
        sec = {"title": "T", "content": big}

        def llm(messages):
            return "要点" * 20  # 40 字 ≤ 40% × 900

        out = dk.distill_section(llm, sec)
        self.assertIsNotNone(out)
        self.assertIn("\n\n", out)


if __name__ == "__main__":
    unittest.main()
