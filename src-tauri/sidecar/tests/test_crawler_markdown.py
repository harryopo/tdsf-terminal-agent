"""
tests/test_crawler_markdown.py — HTML→GFM 转换 + 垃圾页/垃圾标题过滤单测
=========================================================================

TDSF 2026-08-30 知识库爬虫根因修复配套测试（全本地假 HTML，不联网）：

修1（html2md + _extract_page）：
1. markdownify 转换：table→GFM 对齐表格（| --- |）、ul→- 列表、
   ol→1. 列表、pre→``` 围栏、标题→ATX #
2. 语义正文容器提取 + 噪音剥离：nav/header/footer/aside/.toc 内容不入正文
3. clean_markdown 不破坏 GFM 表格分隔行

修2（clean 过滤函数 + _dedupe_entries）：
4. clean_title：.html/.cgi 后缀剥离、空标题 URL slug 兜底
5. is_junk_title：站点 chrome 标题（Search/About/Index of ...）命中
6. is_link_farm：导航索引页（纯链接行 >60%）判定；man 页代码围栏不误伤
7. _dedupe_entries：同标题保留最长 content
8. _filter_reason 端到端：垃圾标题页 / 链接墙页被丢弃
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from bs4 import BeautifulSoup

sys.path.insert(0, str(Path(__file__).parent.parent))

from knowledge.crawlers.clean import (  # noqa: E402
    clean_markdown,
    clean_title,
    is_index_page_title,
    is_junk_title,
    is_link_farm,
    is_section_heading,
)
from knowledge.crawlers.generic import _dedupe_entries, _extract_page, _filter_reason
from knowledge.crawlers.html2md import html_to_markdown
from knowledge.fts5 import KnowledgeEntry


def _soup(html: str) -> BeautifulSoup:
    return BeautifulSoup(html, "html.parser")


# ============================================================================
# 修1.1 markdownify 结构转换
# ============================================================================

_STRUCT_HTML = """
<html><body>
<h1>FirewallD Architecture</h1>
<p>firewalld 有 D-Bus 接口与多后端。</p>
<table>
  <thead><tr><th>Backend</th><th>Direct</th></tr></thead>
  <tbody>
    <tr><td>iptables</td><td>iptables</td></tr>
    <tr><td>nftables</td><td>nft</td></tr>
  </tbody>
</table>
<ul><li>zones</li><li>services</li><li>ports</li></ul>
<ol><li>start firewalld</li><li>add rule</li></ol>
<pre>firewall-cmd --add-service=http
firewall-cmd --reload</pre>
</body></html>
"""


def test_html_to_markdown_gfm_table():
    """<table> → 标准 GFM 表格（含 | --- | 分隔行，非 | 文字墙）"""
    md = html_to_markdown(_soup(_STRUCT_HTML))
    assert "| Backend | Direct |" in md
    assert "| --- | --- |" in md
    assert "| iptables | iptables |" in md


def test_html_to_markdown_lists():
    """<ul>/<ol> → - 列表 / 1. 列表（每项独立成行，不粘连）"""
    md = html_to_markdown(_soup(_STRUCT_HTML))
    assert "- zones" in md
    assert "- services" in md
    assert "1. start firewalld" in md
    assert "2. add rule" in md


def test_html_to_markdown_code_fence():
    """<pre> → ``` 代码围栏（非无换行文字墙）"""
    md = html_to_markdown(_soup(_STRUCT_HTML))
    assert "```" in md
    assert "firewall-cmd --add-service=http" in md


def test_html_to_markdown_atx_heading():
    """<h1> → ATX # 标题"""
    md = html_to_markdown(_soup(_STRUCT_HTML))
    assert "# FirewallD Architecture" in md


# ============================================================================
# 修1.2 语义容器提取 + 噪音剥离
# ============================================================================

_NOISY_HTML = """
<html><body>
<header><nav><a href="/a">NAV-LINK-DO-NOT-INCLUDE</a></nav></header>
<div class="toc">TOC-MENU-DO-NOT-INCLUDE</div>
<aside>ASIDE-SIDEBAR-DO-NOT-INCLUDE</aside>
<main>
  <h1>Real Article</h1>
  <p>正文内容足够长，""" + "详细描述本主题的背景与用法确保通过质量门槛。" * 20 + """</p>
</main>
<footer>FOOTER-COPYRIGHT-DO-NOT-INCLUDE</footer>
</body></html>
"""


def test_strip_noise_removes_nav_footer():
    """nav/header/footer/aside/.toc 内容不入正文，main 正文保留"""
    md = html_to_markdown(_soup(_NOISY_HTML))
    assert "NAV-LINK-DO-NOT-INCLUDE" not in md
    assert "TOC-MENU-DO-NOT-INCLUDE" not in md
    assert "ASIDE-SIDEBAR-DO-NOT-INCLUDE" not in md
    assert "FOOTER-COPYRIGHT-DO-NOT-INCLUDE" not in md
    assert "Real Article" in md
    assert "详细描述本主题" in md


def test_mediawiki_content_container():
    """MediaWiki #mw-content-text 作为正文容器（页头语言导航不入正文）"""
    html = (
        "<html><body>"
        "<div id='mw-page-base'>MW-PAGE-BASE-NOISE</div>"
        "<div id='mw-content-text'>"
        "<h1>Systemd</h1><p>" + "systemd 单元类型详解，涵盖 service 与 timer。" * 20 + "</p>"
        "</div></body></html>"
    )
    md = html_to_markdown(_soup(html))
    assert "MW-PAGE-BASE-NOISE" not in md
    assert "systemd 单元类型详解" in md


def test_clean_markdown_preserves_gfm_table():
    """clean_markdown 不把 GFM 表格分隔行当纯符号残渣删除"""
    md = "# T\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n"
    out = clean_markdown(md)
    assert "| --- | --- |" in out
    assert "| A | B |" in out


# ============================================================================
# 修1.3 _extract_page 端到端（BFS 路径）
# ============================================================================

def test_extract_page_returns_gfm_markdown():
    """_extract_page 产出 GFM markdown（表格/围栏）+ 干净标题 + _md 标记"""
    page = _extract_page(_soup(_STRUCT_HTML), "https://e.com/arch.html", ["f"])
    assert page["_md"] is True
    assert page["title"] == "FirewallD Architecture"
    assert "| --- | --- |" in page["content"]
    assert "```" in page["content"]


def test_extract_page_title_strips_html_ext():
    """标题 architecture.html → Architecture（文件名后缀清洗）"""
    html = "<html><body><h1>architecture.html</h1><p>" + "正文内容。" * 100 + "</p></body></html>"
    page = _extract_page(_soup(html), "https://e.com/docs/architecture.html", ["t"])
    assert page["title"] == "Architecture"


def test_extract_page_empty_title_falls_back_to_slug():
    """空标题 → URL 末段 slug 化"""
    html = "<html><body><p>" + "正文内容足够长用于通过门槛。" * 40 + "</p></body></html>"
    page = _extract_page(_soup(html), "https://e.com/docs/getting_started.html", ["t"])
    assert page["title"] == "Getting started"


# ============================================================================
# 修2.1 clean_title
# ============================================================================

@pytest.mark.parametrize(
    "raw,url,expected",
    [
        ("architecture.html", "https://e.com/x", "Architecture"),
        ("index.cgi", "https://e.com/x", "Index"),
        ("notes.txt", "https://e.com/x", "Notes"),
        ("read_me.md", "https://e.com/x", "Read me"),
        ("Apache Configuration", "https://e.com/x", "Apache Configuration"),
        # 空标题 → URL slug 兜底
        ("", "https://e.com/docs/foo_bar.html", "Foo bar"),
        ("   ", "https://e.com/docs/mod_deflate.html", "Mod deflate"),
        # 纯符号标题 → URL slug 兜底
        ("---", "https://e.com/guide/intro.html", "Intro"),
    ],
)
def test_clean_title(raw: str, url: str, expected: str):
    assert clean_title(raw, url) == expected


# ============================================================================
# 修2.2 is_junk_title
# ============================================================================

@pytest.mark.parametrize(
    "title,expected",
    [
        ("Search", True),
        ("Sign in", True),
        ("Log in", True),
        ("Community", True),
        ("Contact", True),
        ("News", True),
        ("Statistics", True),
        ("Contributing", True),
        ("Getting involved", True),
        ("Main page", True),
        ("Index of /docs", True),
        ("Index of /manual", True),
        ("Download", True),
        ("FAQ", True),
        ("About", True),
        ("Sitemap", True),
        ("Edit", True),
        ("View source", True),
        ("History", True),
        ("讨论", True),
        ("贡献", True),
        ("", True),
        # 正常文档标题——必须保留
        ("Apache Configuration", False),
        ("Systemd", False),
        ("Editing files", False),  # 含 Edit 子串但非 chrome 页
        ("FirewallD Architecture", False),
        ("NAME", False),  # man 页章节
    ],
)
def test_is_junk_title(title: str, expected: bool):
    assert is_junk_title(title) is expected


# ============================================================================
# 修2.3 is_link_farm（导航索引页 vs man 页 SYNOPSIS）
# ============================================================================

def test_is_link_farm_true_for_directory_index():
    """Apache 首页式链接墙（每行纯链接）判定为导航索引页"""
    lines = [f"- [mod_{i}](/mod/mod_{i}.html)" for i in range(30)]
    md = "# Index of /modules\n\n" + "\n".join(lines)
    assert is_link_farm(md) is True


def test_is_link_farm_false_for_man_synopsis():
    """man 页 SYNOPSIS：代码围栏内的选项/路径不算链接，正常正文不误伤"""
    md = (
        "# ssh(1)\n\n"
        "## SYNOPSIS\n\n```\nssh [-46AaCfGgKkMNnqsTtVvXxYy] [-B bind_interface]\n"
        "    [-b address] user@host\n```\n\n"
        "## DESCRIPTION\n\n"
        + "ssh 是 OpenSSH 的远程登录工具，用于在不安全的网络上执行命令。" * 10
        + "\n\n详见 [手册页](/man/ssh)。\n"
    )
    assert is_link_farm(md) is False


def test_is_link_farm_false_for_normal_doc_with_links():
    """正常文档页每段带参考链接（有说明文字）不误判"""
    md = (
        "# Docker overview\n\n"
        "Docker 容器化应用，详见 [get started](/get-started)。\n\n"
        + "镜像、容器与仓库是三大核心概念，本节详细说明其关系与用法。" * 15
        + "\n\n\n- [文档首页](/docs) 从这里开始学习\n"
        "- [API 参考](/api) 完整的接口说明\n"
    )
    assert is_link_farm(md) is False


def test_is_link_farm_short_page_not_evaluated():
    """行数 <15 的短页不做链接密度判定（交给字数门槛）"""
    md = "\n".join(f"- [x{i}](/u{i})" for i in range(5))
    assert is_link_farm(md) is False


# ============================================================================
# 修2.4 _dedupe_entries（"要点"×5 问题）
# ============================================================================

def test_dedupe_entries_keeps_longest_content():
    """同标题保留最长 content 一条，保持首现顺序"""
    entries = [
        KnowledgeEntry(id="a1", source="s", title="要点", content="短", url="u1", tags=[]),
        KnowledgeEntry(id="a2", source="s", title="安装", content="安装正文", url="u2", tags=[]),
        KnowledgeEntry(id="a3", source="s", title="要点", content="很长的要点正文内容" * 10, url="u3", tags=[]),
        KnowledgeEntry(id="a4", source="s", title="要点", content="中等要点", url="u4", tags=[]),
    ]
    out = _dedupe_entries(entries, "s")
    titles = [e.title for e in out]
    assert titles == ["要点", "安装"]  # 首现顺序
    yaodian = next(e for e in out if e.title == "要点")
    assert yaodian.id == "a3"  # 保留最长 content


# ============================================================================
# 修2.5 _filter_reason 端到端
# ============================================================================

def test_filter_reason_junk_title():
    page = {"title": "Search", "content": "x" * 1000}
    assert _filter_reason(page) == "junk-title"


def test_filter_reason_link_farm():
    lines = "\n".join(f"- [mod_{i}](/mod/{i}.html)" for i in range(30))
    page = {"title": "Modules", "content": f"# Modules\n\n{lines}"}
    assert _filter_reason(page) == "link-farm"


def test_filter_reason_short():
    page = {"title": "Real Page", "content": "太短了"}
    assert _filter_reason(page) == "short"


def test_filter_reason_pass():
    page = {"title": "Real Page", "content": "足够长的正文。" * 100}
    assert _filter_reason(page) is None


# ============================================================================
# 修2.6 man 章节名判定（git-docs 42→9 回归防护）
# ============================================================================

@pytest.mark.parametrize(
    "title,expected",
    [
        # man 手册页章节名（纯词组、无 section 号括号）——必须跳过
        ("NAME", True),
        ("SYNOPSIS", True),
        ("EXIT STATUS", True),
        ("SETUID AND SETGID BITS", True),
        ("RETURN VALUES", True),
        ("ARGUMENTS¶", True),      # Debian pilcrow 锚记
        ("CAUTION¶", True),
        # man 页引用格式（含括号）= 文档标识，不是章节名——必须保留
        # （git-scm.com 命令页 h1 全大写 GIT-COMMIT(1)，误判会导致
        #   标题退化 + 同标题去重误杀，实测 git-docs 42→9 根因）
        ("GIT-COMMIT(1)", False),
        ("GIT(1)", False),
        ("ssh(1)", False),
        # 正常文档站标题——必须保留（大小写混合，全大写启发式不命中）
        ("Home", False),
        ("Index", False),
        ("FirewallD Architecture", False),
        ("Get started with Docker", False),
    ],
)
def test_is_section_heading(title: str, expected: bool):
    assert is_section_heading(title) is expected


@pytest.mark.parametrize(
    "title,expected",
    [
        ("Manpages of bash in Debian bookworm", True),
        ("Contents of Debian unstable", True),
        ("index", True),
        ("Arch manual pages", True),
        ("OpenBSD manual pages", True),
        ("Table of contents", True),
        # 真实文档页标题不误伤
        ("ssh(1)", False),
        ("bash(1)", False),
        ("FirewallD Architecture", False),
        ("https://manpages.debian.org/x", False),  # URL 形态兜底标题
    ],
)
def test_is_index_page_title(title: str, expected: bool):
    assert is_index_page_title(title) is expected


def test_filter_reason_index_page():
    """man 站小目录页（链接密度抓不到）按标题兜底丢弃"""
    page = {"title": "Manpages of bash in Debian bookworm", "content": "x" * 1000}
    assert _filter_reason(page) == "index-page"
