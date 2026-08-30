"""
knowledge/tests/test_sources.py — 内容源管道测试（P2-4）
========================================================

覆盖：
1. import_docs：md 内容导入分块入库（fail-closed 仅 .md，非 md 拒绝）
2. add_case：案例沉淀入库并可检索
3. crawl_and_index：未知爬虫返回 error 不抛错

注：load_builtin_corpus（内置教学语料自动索引）已于 2026-08-30 剔除
（个人语料不随应用分发，改为用户手动导入），相关测试同步删除。
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from knowledge.rag import reset_global_rag
from knowledge.sources import (
    add_case,
    crawl_and_index,
    import_docs,
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

    def test_import_docs_chunks_long_file(self):
        """长文档分块入库（新策略：无标题 ~900 字合并为单块少碎片；
        超 ~1200 字的多段落文档按段落二次切分为多块）"""
        mid_content = "这是测试文档内容。" * 100  # ~900 字，无标题 → 单块
        result = import_docs(
            [{"name": "guide.md", "content": mid_content}]
        )
        self.assertEqual(result["imported"], 1)
        self.assertEqual(result["errors"], 0)
        self.assertEqual(result["rejected"], [])
        self.assertEqual(self.rag.count(), 1)  # 新策略：合并为单块（旧策略碎成 3 块）

        long_content = "\n\n".join(
            f"第{i}段运维知识讲解。" + "系统管理实践细节。" * 40 for i in range(12)
        )  # ~5000 字多段落 → 二次切分多块
        import_docs([{"name": "long.md", "content": long_content}])
        doc_entry = self.rag.get_doc("long.md")
        self.assertIsNotNone(doc_entry)
        self.assertGreater(doc_entry["chunks"], 1)  # 多块

    def test_import_docs_rejects_non_md(self):
        """fail-closed：非 .md 一律拒绝（含 .txt），不污染知识库"""
        result = import_docs(
            [
                {"name": "notes.txt", "content": "纯文本笔记内容"},
                {"name": "page.html", "content": "<p>html</p>"},
                {"name": "合法.md", "content": "# 合法\n\n内容"},
            ]
        )
        self.assertEqual(result["imported"], 1)  # 仅 md 入库
        self.assertEqual(len(result["rejected"]), 2)
        rejected_names = {r["name"] for r in result["rejected"]}
        self.assertEqual(rejected_names, {"notes.txt", "page.html"})
        # 被拒文件不入库
        self.assertIsNone(self.rag.get_doc("notes.txt"))
        self.assertIsNone(self.rag.get_doc("page.html"))

    def test_import_docs_empty_content_skipped(self):
        """空内容文件计入 skipped，不产生条目也不算失败"""
        result = import_docs(
            [
                {"name": "empty.md", "content": "   \n  "},
                {"name": "ok.md", "content": "# 标题\n\n内容"},
            ]
        )
        self.assertEqual(result["imported"], 1)
        self.assertEqual(result["skipped"], 1)
        self.assertEqual(result["errors"], 0)
        self.assertEqual(self.rag.count(), 1)

    def test_import_docs_idempotent_by_name(self):
        """同名文件重导入幂等：url=文件名，旧块清理后重入，总数不变"""
        first = import_docs(
            [{"name": "x.md", "content": "内容段落。" * 200}]
        )
        self.assertEqual(first["imported"], 1)
        count = self.rag.count()
        self.assertGreater(count, 0)
        # 同名新版本（内容不同块数不同）——旧块全清不留残留
        import_docs([{"name": "x.md", "content": "# 新版\n\n只有一段"}])
        self.assertEqual(self.rag.count(), 1)

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
