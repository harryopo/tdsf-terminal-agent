"""
knowledge/tests/test_sources.py — 内容源管道测试（P2-4）
========================================================

覆盖：
1. load_builtin_corpus：内置语料入库（幂等：已有数据跳过）
2. import_docs：文档分块入库（>400 字切多块，重叠保留）
3. add_case：案例沉淀入库并可检索
4. crawl_and_index：未知爬虫返回 error 不抛错
"""
from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path

from knowledge.rag import reset_global_rag
from knowledge.sources import (
    add_case,
    crawl_and_index,
    import_docs,
    load_builtin_corpus,
)


class TestSources(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix="tdsf-sources-test-")
        self.db = Path(self._tmp) / "rag.db"
        # 全局 rag 指向临时库（conftest 也隔离，这里显式重置保险）
        self.rag = reset_global_rag(db_path=self.db)

    def tearDown(self):
        try:
            import shutil

            shutil.rmtree(self._tmp, ignore_errors=True)
        except OSError:
            pass

    def test_load_builtin_corpus_indexes_entries(self):
        """内置语料应入库（linux-core.json 12 条）"""
        added = load_builtin_corpus()
        self.assertGreater(added, 0)
        self.assertEqual(self.rag.count(), added)

    def test_load_builtin_corpus_idempotent(self):
        """已有数据时跳过（幂等，不重复索引）"""
        load_builtin_corpus()
        first = self.rag.count()
        again = load_builtin_corpus()
        self.assertEqual(again, 0)
        self.assertEqual(self.rag.count(), first)

    def test_corpus_searchable(self):
        """内置语料可检索（关键词命中）"""
        load_builtin_corpus()
        results = self.rag.hybrid_search("systemctl 服务管理")
        self.assertTrue(results)
        self.assertTrue(any("systemctl" in r["title"] for r in results))

    def test_corpus_contains_philosophy(self):
        """语料包含 Linux 哲学内容（用户要求教学解释哲学）"""
        load_builtin_corpus()
        results = self.rag.hybrid_search("一切皆文件")
        self.assertTrue(results)
        joined = " ".join(r["content"] for r in results)
        self.assertIn("哲学", joined)

    def test_import_docs_chunks_long_file(self):
        """长文档分块入库（>400 字 → 多块）"""
        long_text = "这是测试文档内容。" * 100  # ~900 字
        doc = Path(self._tmp) / "guide.md"
        doc.write_text(long_text, encoding="utf-8")
        result = import_docs(str(self._tmp))
        self.assertEqual(result["imported"], 1)
        self.assertEqual(result["errors"], 0)
        self.assertGreater(self.rag.count(), 1)  # 多块

    def test_import_docs_invalid_dir(self):
        with self.assertRaises(ValueError):
            import_docs(str(Path(self._tmp) / "nope"))

    def test_add_case_searchable(self):
        """案例沉淀后可检索（决策库雏形）"""
        case_id = add_case(
            title="502 排障：php-fpm socket 权限",
            content="现象：nginx 502。根因：php-fpm 监听 socket 属主不对，www-data 无法连接。解法：改 listen.owner 或 chown socket。",
            tags=["nginx", "排障"],
        )
        self.assertTrue(case_id.startswith("case-"))
        # 注：jieba 上下文分词（php-fpm 切分随上下文变化），用稳定词检索
        results = self.rag.hybrid_search("502 排障")
        self.assertTrue(results)
        self.assertEqual(results[0]["id"], case_id)

    def test_crawl_unknown_source_returns_error(self):
        """未知爬虫返回 error 不抛异常"""
        result = crawl_and_index("not-exist-crawler")
        self.assertIn("error", result)


if __name__ == "__main__":
    unittest.main()
