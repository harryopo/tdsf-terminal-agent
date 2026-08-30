"""
knowledge/tests/test_clean.py — 爬虫/导入文本清洗管道测试（TDSF 2026-08-30）
============================================================================

覆盖：
1. clean_content：emoji 移除、导航残渣行移除、HTML 实体还原、空行压缩、
   行尾空白、页脚版权行
2. 代码块保护：围栏（```/~~~）与缩进代码块内 # 注释、示例词不误伤
3. 幂等性
4. clean_markdown：保留 # 标题 / 列表结构
5. 接入点：GenericCrawler.to_entries / _chunk_markdown 清洗生效
"""
from __future__ import annotations

import unittest

from knowledge.crawlers.clean import clean_content, clean_markdown


class TestCleanContentEmoji(unittest.TestCase):
    def test_emoji_pictographs_removed(self):
        """U+1F300–U+1FAFF 区段 emoji 移除"""
        out = clean_content("配置完成\U0001F680启动 nginx\U0001F4CC")
        self.assertEqual(out, "配置完成启动 nginx")

    def test_misc_symbols_and_presentation_removed(self):
        """U+2600–U+27BF（☀-➿）与变体选择符/ZWJ 移除"""
        out = clean_content("状态 ✅ 正常 ☀️\ufe0f 连接\U0001F468\u200d\U0001F4BB")
        self.assertNotIn("\u2705", out)  # ✅
        self.assertNotIn("\u2600", out)  # ☀
        self.assertNotIn("\ufe0f", out)
        self.assertNotIn("\u200d", out)
        self.assertIn("状态", out)
        self.assertIn("正常", out)

    def test_emoji_only_line_dropped(self):
        """纯 emoji 行清洗后为空 → 整行消失"""
        out = clean_content("正文一行\n\U0001F44D\U0001F44D\n再来一行")
        self.assertEqual(out, "正文一行\n再来一行")


class TestCleanContentNavigation(unittest.TestCase):
    def test_nav_lines_removed(self):
        """导航残渣整行移除（Previous/Next/Edit on GitHub/中文导航）"""
        text = (
            "真实正文段落内容。\n"
            "Previous\n"
            "Next page\n"
            "Edit on GitHub\n"
            "Table of Contents\n"
            "On this page\n"
            "Contents\n"
            "Index\n"
            "Search\n"
            "上一篇\n"
            "下一篇\n"
            "查看编辑历史\n"
            "菜单\n"
            "另一段真实内容在这里。\n"
        )
        out = clean_content(text)
        for nav in (
            "Previous", "Next page", "Edit on GitHub", "Table of Contents",
            "On this page", "Contents", "Index", "Search",
            "上一篇", "下一篇", "查看编辑历史", "菜单",
        ):
            self.assertNotIn(nav, out)
        self.assertIn("真实正文段落内容。", out)
        self.assertIn("另一段真实内容在这里。", out)

    def test_decorated_nav_line_removed(self):
        """带符号装饰的导航行（« Previous / Next »）也移除"""
        out = clean_content("« Previous\n正文\nNext »")
        self.assertEqual(out, "正文")

    def test_nav_word_inside_sentence_kept(self):
        """正文句子含 Next/Previous 词不误伤（整行匹配才删）"""
        text = "The Next button advances the wizard. 正文说明 previous 值。"
        out = clean_content(text)
        self.assertIn("Next button", out)
        self.assertIn("previous", out)

    def test_pure_symbol_line_removed(self):
        """纯符号装饰行移除"""
        out = clean_content("正文A\n--------\n正文B\n····\n正文C")
        self.assertNotIn("----", out)
        self.assertNotIn("····", out)
        self.assertIn("正文A", out)
        self.assertIn("正文C", out)

    def test_copyright_footer_removed(self):
        """Copyright © 单独成行的页脚移除"""
        out = clean_content("正文内容\nCopyright © 2024 nginx, Inc.\n下一段")
        self.assertNotIn("Copyright", out)
        self.assertIn("正文内容", out)
        self.assertIn("下一段", out)


class TestCleanContentEntities(unittest.TestCase):
    def test_named_entities_restored(self):
        """HTML 实体还原（&amp; &#39; &lt; &gt; &nbsp; &copy;）"""
        out = clean_content("a &amp; b &#39;q&#39; &lt;tag&gt; x&nbsp;y &copy;")
        self.assertEqual(out, "a & b 'q' <tag> x y ©")


class TestCleanContentWhitespace(unittest.TestCase):
    def test_three_plus_blanks_collapsed(self):
        """连续 3+ 空行压成 1"""
        out = clean_content("A\n\n\n\n\nB")
        self.assertEqual(out, "A\n\nB")

    def test_two_blanks_kept(self):
        """2 空行（段落分隔）原样保留"""
        out = clean_content("A\n\nB")
        self.assertEqual(out, "A\n\nB")

    def test_trailing_whitespace_stripped(self):
        """行尾空白清理"""
        out = clean_content("行一   \n行二\t")
        self.assertEqual(out, "行一\n行二")


class TestCleanContentCodeBlockProtection(unittest.TestCase):
    def test_fenced_block_preserved(self):
        """围栏代码块内 # 注释与导航词不误伤"""
        text = (
            "说明文字\n"
            "```\n"
            "# 这是 shell 注释\n"
            "Previous\n"
            "Next\n"
            "```\n"
            "结尾\n"
        )
        out = clean_content(text)
        self.assertIn("# 这是 shell 注释", out)
        self.assertIn("```\n# 这是 shell 注释\nPrevious\nNext\n```", out)

    def test_tilde_fence_preserved(self):
        """~~~ 围栏同样保护"""
        text = "~~~\n☀ 符号在代码块内保留\n~~~"
        out = clean_content(text)
        self.assertIn("☀", out)

    def test_indented_code_block_preserved(self):
        """缩进代码块（4 空格）内行原样保留"""
        text = "正文\n\n    # nginx 配置注释\n    server {\n\n正文2"
        out = clean_content(text)
        self.assertIn("    # nginx 配置注释", out)
        self.assertIn("    server {", out)


class TestCleanContentIdempotent(unittest.TestCase):
    def test_idempotent(self):
        """清洗幂等：二次清洗结果不变"""
        dirty = (
            "标题\U0001F680\n\n\n\n\nPrevious\n"
            "代码 &amp; 注释\n```\n# keep\n```\nCopyright © 2020\n"
        )
        once = clean_content(dirty)
        twice = clean_content(once)
        self.assertEqual(once, twice)

    def test_empty_input(self):
        self.assertEqual(clean_content(""), "")
        self.assertEqual(clean_markdown(""), "")


class TestCleanMarkdown(unittest.TestCase):
    def test_heading_and_list_preserved(self):
        """markdown 标题行与列表项保留，emoji/导航仍清除"""
        text = (
            "# 部署指南\U0001F680\n\n"
            "- 步骤一：安装\n"
            "- 步骤二：启动\n\n"
            "上一篇\n\n"
            "## 配置\n\n正文 &amp; 说明\n"
        )
        out = clean_markdown(text)
        self.assertTrue(out.startswith("# 部署指南"))
        self.assertIn("- 步骤一：安装", out)
        self.assertIn("## 配置", out)
        self.assertIn("正文 & 说明", out)
        self.assertNotIn("上一篇", out)

    def test_markdown_fence_preserved(self):
        text = "# 标题\n\n```bash\n# 注释\n```\n"
        out = clean_markdown(text)
        self.assertIn("```bash\n# 注释\n```", out)


class TestIntegrationPoints(unittest.TestCase):
    """接入点验证：爬虫 to_entries 与导入分块前清洗生效"""

    def test_generic_to_entries_cleans(self):
        from knowledge.crawlers.generic import GenericCrawler

        crawler = GenericCrawler(source="t-docs", base_url="https://example.com/")
        items = [{
            "title": "示例页",
            "content": "正文\U0001F44D\nPrevious\na &amp; b",
            "url": "https://example.com/",
            "tags": ["t"],
        }]
        entries = crawler.to_entries(items)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0].content, "正文\na & b")

    def test_nginx_to_entries_cleans(self):
        from knowledge.crawlers.nginx import NginxCrawler

        crawler = NginxCrawler(cache_root=__import__("tempfile").mkdtemp())
        items = [{"title": "t", "content": "内容\U0001F680 Next", "url": "u", "tags": []}]
        entries = crawler.to_entries(items)
        self.assertNotIn("\U0001F680", entries[0].content)

    def test_extract_page_cleans(self):
        """_extract_page（BFS 路径）清洗 emoji/导航"""
        from knowledge.crawlers.generic import _extract_page

        html = (
            "<html><body><h1>页面标题\U0001F4CC</h1>"
            "<p>这是一段足够长的正文内容，用于通过解析阈值检查。</p>"
            "<p>Previous</p></body></html>"
        )
        from bs4 import BeautifulSoup

        page = _extract_page(BeautifulSoup(html, "html.parser"), "https://e.com/", ["t"])
        self.assertIsNotNone(page)
        self.assertNotIn("\U0001F4CC", page["title"])
        self.assertNotIn("Previous", page["content"])

    def test_chunk_markdown_cleans(self):
        """_chunk_markdown 分块前清洗生效（导入路径）"""
        from knowledge.sources import _chunk_markdown

        text = "# 指南\U0001F680\n\n正文 &amp; 内容\n\n\n\n\n上一篇\n\n结尾段"
        chunks = _chunk_markdown(text)
        joined = "\n".join(c for _, c in chunks)
        self.assertNotIn("\U0001F680", joined)
        self.assertNotIn("上一篇", joined)
        self.assertIn("正文 & 内容", joined)


if __name__ == "__main__":
    unittest.main()
