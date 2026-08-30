"""
knowledge/tests/test_category.py — 知识库 6+1 分类与中文译文测试（TDSF 2026-08-30）
====================================================================================

覆盖：
1. category_for：17 官方源映射 + archwiki title 分流 + philosophy + 未知源
2. add/list/search/get/list_files 全链路带 category
3. 旧库迁移幂等：无 category/content_zh 列的旧 entries 表 + 缂 content_zh_tokens
   的旧 fts_entries 表自动补列/重建（正文回填不丢）
4. list_files(group=...) 按 category 过滤
5. update_content_zh：译文写入 entries + FTS（中文 query 命中译文）
6. load_philosophy_docs：philosophy/ 语料幂等入库（category=linux-philosophy）
7. GenericCrawler.to_entries / crawl_and_index 填充 category
"""
from __future__ import annotations

import os
import sqlite3
import tempfile
import unittest
from pathlib import Path

from knowledge.fts5 import KnowledgeEntry
from knowledge.rag import RagIndex, reset_global_rag
from knowledge.sources import (
    PHILOSOPHY_CATEGORY,
    PHILOSOPHY_SOURCE,
    add_case,
    category_for,
    load_philosophy_docs,
)


class TestCategoryFor(unittest.TestCase):
    """category_for 映射：17 官方源 + archwiki 分流 + philosophy"""

    def test_cmd_tools_sources(self):
        for s in ("bash-docs", "python-docs", "rust-docs", "git-docs", "systemd-docs"):
            self.assertEqual(category_for(s), "cmd-tools", s)

    def test_sys_admin_sources(self):
        self.assertEqual(category_for("dnf-docs"), "sys-admin")

    def test_net_remote_sources(self):
        self.assertEqual(category_for("ssh-docs"), "net-remote")

    def test_security_sources(self):
        for s in ("selinux-docs", "iptables-docs", "firewalld-docs"):
            self.assertEqual(category_for(s), "security", s)

    def test_services_sources(self):
        for s in (
            "nginx-docs", "apache-docs", "mariadb-docs", "redis-docs",
            "docker-docs", "kubernetes-docs",
        ):
            self.assertEqual(category_for(s), "services", s)

    def test_archwiki_title_routing(self):
        """archwiki 双属：title 命中系统管理关键词 → sys-admin，否则 basic-ops"""
        self.assertEqual(category_for("archwiki", "Systemd"), "sys-admin")
        self.assertEqual(category_for("archwiki", "Pacman"), "sys-admin")
        self.assertEqual(category_for("archwiki", "GRUB"), "sys-admin")
        self.assertEqual(category_for("archwiki", "Installation guide"), "sys-admin")
        self.assertEqual(category_for("archwiki", "Firefox"), "basic-ops")
        self.assertEqual(category_for("archwiki", "Bash"), "basic-ops")

    def test_philosophy(self):
        self.assertEqual(category_for("philosophy"), "linux-philosophy")

    def test_unknown_source_empty(self):
        """未知来源（imported-docs/session-case）返回空串（前端归「其他」）"""
        self.assertEqual(category_for("imported-docs"), "")
        self.assertEqual(category_for("session-case"), "")


class TestCategoryRoundtrip(unittest.TestCase):
    """category 入库/读出全链路"""

    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix="tdsf-cat-test-")
        self.db = Path(self._tmp) / "rag.db"
        self.rag = RagIndex(db_path=self.db)

    def tearDown(self):
        self.rag.close()
        try:
            os.remove(self.db)
        except OSError:
            pass

    def test_add_and_list_with_category(self):
        e = KnowledgeEntry(
            title="nginx 配置", content="server 块监听 80 端口" * 10,
            source="nginx-docs", category="services",
        )
        self.rag.add(e)
        rows = self.rag.list_entries(limit=10)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["category"], "services")

    def test_hybrid_search_returns_category(self):
        self.rag.add(KnowledgeEntry(
            title="iptables 防火墙", content="iptables -L 查看规则" * 10,
            source="iptables-docs", category="security",
        ))
        results = self.rag.hybrid_search("iptables")
        self.assertTrue(results)
        self.assertEqual(results[0]["category"], "security")

    def test_get_returns_category(self):
        e = KnowledgeEntry(
            title="t", content="内容内容内容", source="ssh-docs",
            category="net-remote",
        )
        self.rag.add(e)
        got = self.rag.get(e.id)
        self.assertEqual(got["category"], "net-remote")

    def test_list_files_group_filter(self):
        for cat, url, body in (
            ("services", "u1", "nginx 服务部署正文"),
            ("security", "u2", "防火墙安全加固正文"),
        ):
            self.rag.add(KnowledgeEntry(
                id=f"x-{url}", title="t", content=body * 20,
                url=url, source="t-docs", category=cat,
            ))
        self.assertEqual(
            {f["url"] for f in self.rag.list_files(group="services")}, {"u1"}
        )
        self.assertEqual(
            {f["url"] for f in self.rag.list_files(group="security")}, {"u2"}
        )
        # group 返回体带 category 字段
        f0 = self.rag.list_files(group="services")[0]
        self.assertEqual(f0["category"], "services")


class TestLegacyMigration(unittest.TestCase):
    """旧库迁移幂等：entries 缺 category/content_zh 列 + FTS 缺 content_zh_tokens"""

    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix="tdsf-mig-test-")
        self.db = Path(self._tmp) / "rag.db"

    def tearDown(self):
        try:
            import shutil

            shutil.rmtree(self._tmp, ignore_errors=True)
        except OSError:
            pass

    def _make_legacy_db(self) -> None:
        """构造旧版 schema 库（6+1 分类上线前的结构）并塞入一条旧数据"""
        conn = sqlite3.connect(str(self.db))
        conn.execute(
            """CREATE TABLE entries (
                id TEXT PRIMARY KEY, source TEXT NOT NULL DEFAULT '',
                title TEXT NOT NULL, content TEXT NOT NULL,
                url TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL)"""
        )
        conn.execute(
            """CREATE VIRTUAL TABLE fts_entries USING fts5(
                title, content, content_tokens, tokenize='unicode61')"""
        )
        conn.execute(
            "INSERT INTO entries (id, source, title, content, url, tags, created_at) "
            "VALUES ('legacy-1', 'nginx-docs', '旧条目', '旧正文内容', "
            "'http://e.com/1', '[]', '2026-01-01')"
        )
        conn.execute(
            "INSERT INTO fts_entries (rowid, title, content, content_tokens) "
            "VALUES (1, '旧条目', '旧正文内容', '旧 条目')"
        )
        conn.commit()
        conn.close()

    def test_legacy_db_upgrades_and_preserves_content(self):
        self._make_legacy_db()
        rag = RagIndex(db_path=self.db)
        try:
            # 列补齐
            cols = {str(r[1]) for r in sqlite3.connect(str(self.db)).execute(
                "PRAGMA table_info(entries)")}
            self.assertIn("category", cols)
            self.assertIn("content_zh", cols)
            # FTS 重建后旧正文回填不丢（rowid 对齐）
            with sqlite3.connect(str(self.db)) as conn:
                n = conn.execute(
                    "SELECT COUNT(*) FROM fts_entries WHERE rowid = 1"
                ).fetchone()[0]
            self.assertEqual(n, 1)
            # 旧条目仍可检索、category 读出为空串
            rows = rag.list_entries(limit=10)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["title"], "旧条目")
            self.assertEqual(rows[0]["category"], "")
        finally:
            rag.close()

    def test_migration_idempotent(self):
        """二次打开不重复迁移（幂等）"""
        self._make_legacy_db()
        rag = RagIndex(db_path=self.db)
        rag.close()
        rag2 = RagIndex(db_path=self.db)
        try:
            self.assertEqual(rag2.count(), 1)
        finally:
            rag2.close()


class TestUpdateContentZh(unittest.TestCase):
    """译文写入（translate_knowledge.py 用）"""

    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix="tdsf-zh-test-")
        self.db = Path(self._tmp) / "rag.db"
        self.rag = RagIndex(db_path=self.db)

    def tearDown(self):
        self.rag.close()
        try:
            os.remove(self.db)
        except OSError:
            pass

    def test_update_content_zh_and_fts_hit(self):
        e = KnowledgeEntry(
            title="nginx worker", content="nginx worker processes tuning",
            source="nginx-docs", category="services",
        )
        self.rag.add(e)
        self.assertTrue(self.rag.update_content_zh(e.id, "nginx 工作进程调优指南"))
        row = self.rag.get(e.id)
        self.assertEqual(row["content_zh"], "nginx 工作进程调优指南")
        # 中文 query 命中译文（FTS content_zh_tokens）
        results = self.rag.hybrid_search("工作进程调优")
        self.assertTrue(results, "中文查询应命中译文")
        self.assertEqual(results[0]["id"], e.id)

    def test_update_missing_entry_returns_false(self):
        self.assertFalse(self.rag.update_content_zh("no-such-id", "译文"))


class TestPhilosophyDocs(unittest.TestCase):
    """philosophy/ 教学语料入库（第 7 分类 linux-philosophy）"""

    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix="tdsf-phil-test-")
        self.rag = reset_global_rag(db_path=Path(self._tmp) / "rag.db")

    def tearDown(self):
        try:
            import shutil

            shutil.rmtree(self._tmp, ignore_errors=True)
        except OSError:
            pass

    def test_load_philosophy_docs_idempotent(self):
        result = load_philosophy_docs(self.rag)
        self.assertGreater(result["files"], 0, "philosophy/ 目录应有教学语料")
        self.assertEqual(result["errors"], 0)
        count_first = self.rag.count()
        self.assertGreater(count_first, 0)
        # 幂等：重复加载总数不变
        result2 = load_philosophy_docs(self.rag)
        self.assertEqual(result2["chunks"], result["chunks"])
        self.assertEqual(self.rag.count(), count_first)

    def test_philosophy_entries_categorized(self):
        load_philosophy_docs(self.rag)
        files = self.rag.list_files(group=PHILOSOPHY_CATEGORY)
        self.assertGreater(len(files), 0)
        for f in files:
            self.assertEqual(f["source"], PHILOSOPHY_SOURCE)
            self.assertEqual(f["category"], "linux-philosophy")

    def test_philosophy_keyword_searchable(self):
        """中文关键词可命中哲学语料（FTS + category 联动）"""
        load_philosophy_docs(self.rag)
        results = self.rag.hybrid_search("一切皆文件")
        self.assertTrue(results)
        self.assertTrue(all(r["category"] == "linux-philosophy" for r in results))


class TestCrawlCategoryFill(unittest.TestCase):
    """爬取入库链路 category 填充"""

    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix="tdsf-catfill-test-")
        # add_case 内部走 get_global_rag()，全局实例须指向测试库
        self.rag = reset_global_rag(db_path=Path(self._tmp) / "rag.db")

    def tearDown(self):
        try:
            import shutil

            shutil.rmtree(self._tmp, ignore_errors=True)
        except OSError:
            pass

    def test_to_entries_fills_category(self):
        from knowledge.crawlers.generic import GenericCrawler

        crawler = GenericCrawler(
            source="nginx-docs", base_url="https://example.com/"
        )
        items = [
            {"title": "配置指南", "content": "足够长的正文内容，覆盖完整主题。" * 100,
             "url": "u1", "tags": []},
        ]
        entries = crawler.to_entries(items)
        self.assertEqual(entries[0].category, "services")

    def test_add_case_uncategorized(self):
        """会话案例不入分类（空串 → 前端「其他」）"""
        case_id = add_case(title="t", content="c")
        try:
            row = self.rag.get(case_id)
            self.assertEqual(row["category"], "")
        finally:
            self.rag.delete(case_id)


if __name__ == "__main__":
    unittest.main()
