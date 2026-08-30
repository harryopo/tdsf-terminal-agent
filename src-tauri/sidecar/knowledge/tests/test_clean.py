"""
knowledge/tests/test_clean.py — 爬虫/导入文本清洗管道测试（TDSF 2026-08-30）
============================================================================

覆盖：
1. clean_content：emoji 移除、导航残渣行移除、语言切换残渣行移除、
   HTML 实体还原、空行压缩、行尾空白、页脚版权行
2. 代码块保护：围栏（```/~~~）与缩进代码块内 # 注释、示例词不误伤
3. 幂等性
4. clean_markdown：保留 # 标题 / 列表结构
5. 繁体检测（looks_traditional；to_simplified 已按用户钦定丢弃策略移除）
6. 接入点：GenericCrawler.to_entries（含质量门槛）/ _extract_page /
   _chunk_markdown 清洗生效
"""
from __future__ import annotations

import unittest

from knowledge.crawlers.clean import (
    clean_content,
    clean_markdown,
    looks_traditional,
)


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


class TestCleanContentLanguageNav(unittest.TestCase):
    """语言切换残渣行清洗（TDSF 2026-08-30，Arch Wiki Statistics 混入样本）"""

    def test_lang_nav_mixed_line_removed(self):
        """一行混排 ≥2 个语言名（「2 languages 日本語 Magyar」）整行移除"""
        out = clean_content("真实正文一行。\n2 languages 日本語 Magyar\n后续正文。")
        self.assertNotIn("Magyar", out)
        self.assertNotIn("日本語", out)
        self.assertIn("真实正文一行。", out)
        self.assertIn("后续正文。", out)

    def test_lang_count_line_removed(self):
        """独立「24 languages」语言计数行移除"""
        out = clean_content("正文A\n24 languages\n正文B")
        self.assertNotIn("24 languages", out)
        self.assertIn("正文A", out)
        self.assertIn("正文B", out)

    def test_language_sentence_kept(self):
        """含句读的真实叙述句（支持中文、日本語等多语言）不误删"""
        text = "本工具支持中文、日本語等多语言界面，可在设置中切换。"
        out = clean_content(text)
        self.assertIn("支持中文、日本語", out)

    def test_single_language_name_line_kept(self):
        """单个语言名成行（如导航里的 English）保守保留"""
        out = clean_content("Documentation in English\n正文")
        self.assertIn("English", out)

    def test_sidebar_residue_removed(self):
        """MediaWiki 侧栏残渣行（move to sidebar hide）移除"""
        out = clean_content("正文开始\nmove to sidebar hide\n正文继续")
        self.assertNotIn("move to sidebar", out)
        self.assertIn("正文开始", out)
        self.assertIn("正文继续", out)


class TestTraditionalDetection(unittest.TestCase):
    """繁体检测（TDSF 2026-08-30 用户钦定：繁体内容直接丢弃，不再繁转简）"""

    def test_looks_traditional_positive(self):
        """繁体特征字 ≥2 处 → 判定为繁体（bash.1.zh_TW 实测样本）"""
        self.assertTrue(looks_traditional("Bash是一個與sh相容的命令解釋程式"))

    def test_looks_traditional_negative_simplified(self):
        """简体中文零繁体特征 → 不误判（防误伤 zh_CN 内容）"""
        self.assertFalse(looks_traditional("Bash是一个与sh兼容的命令解释程序，可以读取文件"))

    def test_looks_traditional_negative_english(self):
        """英文内容零命中"""
        self.assertFalse(
            looks_traditional("The bash shell is a sh-compatible command interpreter")
        )

    def test_to_simplified_removed(self):
        """to_simplified 已移除（用户钦定丢弃策略）：模块不应再导出该符号"""
        import knowledge.crawlers.clean as clean_mod

        self.assertFalse(hasattr(clean_mod, "to_simplified"))


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
            "content": "正文\U0001F44D\nPrevious\na &amp; b\n" + "足够长的正文内容。" * 100,
            "url": "https://example.com/",
            "tags": ["t"],
        }]
        entries = crawler.to_entries(items)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0].content.splitlines()[0], "正文")
        self.assertIn("a & b", entries[0].content)

    def test_generic_to_entries_discards_short_pages(self):
        """质量门槛：content < 500 字的页面（134 字 Statistics 类）直接丢弃"""
        from knowledge.crawlers.generic import GenericCrawler

        crawler = GenericCrawler(source="t-docs", base_url="https://example.com/")
        items = [
            {"title": "Statistics 残页", "content": "太短" * 10, "url": "u1", "tags": []},
            {"title": "正常文章", "content": "足够长的正文内容，覆盖完整主题。" * 100, "url": "u2", "tags": []},
        ]
        entries = crawler.to_entries(items)
        self.assertEqual([e.url for e in entries], ["u2"])

    def test_generic_to_entries_drops_traditional(self):
        """繁体页面经 to_entries 整条丢弃（用户钦定，不再繁转简）"""
        from knowledge.crawlers.generic import GenericCrawler

        crawler = GenericCrawler(source="t-docs", base_url="https://example.com/")
        trad = "Bash是一個與sh相容的命令解釋程式，可以讀取檔案並執行命令。" * 20
        items = [
            {"title": "名稱", "content": trad, "url": "u1", "tags": ["bash"]},
            {"title": "正常文章", "content": "足够长的简体正文内容。" * 100, "url": "u2", "tags": []},
        ]
        entries = crawler.to_entries(items)
        self.assertEqual([e.url for e in entries], ["u2"])  # 繁体条目被丢弃

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

    def test_extract_page_drops_traditional(self):
        """_extract_page（BFS 路径）繁体内容整页丢弃（返回 None）"""
        from knowledge.crawlers.generic import _extract_page
        from bs4 import BeautifulSoup

        html = (
            "<html><body><h1>名稱</h1>"
            "<p>" + "Bash是一個與sh相容的命令解釋程式，可以讀取檔案並執行命令。" * 8 + "</p>"
            "</body></html>"
        )
        page = _extract_page(BeautifulSoup(html, "html.parser"), "https://e.com/", ["bash"])
        self.assertIsNone(page)

    def test_extract_page_simplified_kept(self):
        """简体正文正常返回（不误判为繁体）"""
        from knowledge.crawlers.generic import _extract_page
        from bs4 import BeautifulSoup

        html = (
            "<html><body><h1>名称</h1>"
            "<p>" + "Bash是一个与sh兼容的命令解释程序，可以读取文件并执行命令。" * 8 + "</p>"
            "</body></html>"
        )
        page = _extract_page(BeautifulSoup(html, "html.parser"), "https://e.com/", ["bash"])
        self.assertIsNotNone(page)
        self.assertIn("兼容", page["content"])

    def test_extract_page_mediawiki_root_and_lead(self):
        """MediaWiki 页以 #mw-content-text 为正文根 + 导语段并入（整页合并）"""
        from knowledge.crawlers.generic import _extract_page
        from bs4 import BeautifulSoup

        lead = "本页概述 systemd 的单元类型与常用操作，面向 Linux 运维教学场景。" * 10
        body = "systemd 单元类型详解：service、timer、socket 等各类单元的用途与示例。" * 60
        html = (
            "<html><body>"
            "<div id='mw-content-text'>"
            f"<p>{lead}</p>"
            f"<h2>单元类型</h2><p>{body}</p>"
            "</div>"
            "</body></html>"
        )
        page = _extract_page(BeautifulSoup(html, "html.parser"), "https://e.com/", ["wiki"])
        self.assertIsNotNone(page)
        self.assertTrue(page["content"].startswith("本页概述"))  # 导语段并入且在最前
        self.assertIn("单元类型", page["content"])

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
