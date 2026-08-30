"""
tests/test_knowledge_crawler_bfs.py — 爬虫 BFS 深度抓取测试（知识库升级）
=========================================================================

覆盖（全部本地假 HTML，不联网）：
1. BFS 同域抓取：多页产出（每页 1 条 entry）、页面去重（互链成环）
2. 链接过滤：外域 / 资源文件后缀 / 锚点 / mailto-javascript / 查询串 /
   语言变体（含 zh_TW 区域变体文件名后缀）/ Wiki 命名空间页
3. max_depth 深度限制 / max_pages 页数上限
4. 质量门槛：正文 <500 字的页面丢弃（TDSF 2026-08-30）
5. Wiki 命名空间标题丢弃（重定向 title 与 URL 不一致场景）
6. 整页合并：正文截断上限 12000 字
7. 单页失败（超时）记 warning 跳过继续，整体不抛出
8. 离线缓存重放（offline 模式复用已抓缓存）
9. NginxCrawler 与 GenericCrawler 共享 BFS（max_pages 对齐）

运行：
    cd src-tauri/sidecar
    .venv/Scripts/python.exe -m pytest tests/test_knowledge_crawler_bfs.py -v
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from knowledge.crawlers.generic import GenericCrawler
from knowledge.crawlers.nginx import NginxCrawler

BASE = "https://docs.test.com/"

# 质量门槛填充段（TDSF 2026-08-30：<500 字正文页面被丢弃，测试页需达标）
_FILLER_TEXT = (
    "这是一段用于通过质量门槛的填充正文，详细描述本页主题的背景、用法"
    "与注意事项，确保页面内容足够完整，能够被知识库检索命中并正常入库。"
)
_FILLER = f"<p>{_FILLER_TEXT * 10}</p>"

# 本地假站点：home 互链 a/b；b 链回 a（环）；含外域/资源/锚点干扰链接
PAGES = {
    BASE: (
        "<html><head><title>Test Docs</title></head><body>"
        "<h1>Home</h1>"
        f"{_FILLER}"
        "<p>home 页正文内容，足够长的段落文本用于解析。</p>"
        '<a href="/a">A</a>'
        '<a href="/b">B</a>'
        '<a href="https://other.test/x">外域链接</a>'
        '<a href="/manual.pdf">资源文件</a>'
        '<a href="/a#section">锚点重复</a>'
        '<a href="mailto:x@y.z">邮件</a>'
        "</body></html>"
    ),
    "https://docs.test.com/a": (
        "<html><body>"
        "<h1>Page A</h1>"
        f"{_FILLER}"
        "<p>A 页正文内容，足够长的段落文本用于解析。</p>"
        '<a href="/">回首页</a>'
        '<a href="/b">去 B</a>'
        "</body></html>"
    ),
    "https://docs.test.com/b": (
        "<html><body>"
        "<h1>Page B</h1>"
        f"{_FILLER}"
        "<p>B 页正文内容，足够长的段落文本用于解析。</p>"
        '<a href="/a">回 A（成环）</a>'
        "</body></html>"
    ),
}


def _fake_http_get(self, url: str) -> str:
    return PAGES[url]


def _fake_http_get_b_fail(self, url: str) -> str:
    if url.endswith("/b"):
        raise TimeoutError("simulated timeout")
    return PAGES[url]


@pytest.fixture
def crawler(tmp_path: Path) -> GenericCrawler:
    return GenericCrawler(
        source="test-docs",
        base_url=BASE,
        tags=["test"],
        cache_root=tmp_path / "cache",
        delay=0,
    )


# ============================================================================
# 1. BFS 抓取 / 去重 / 过滤
# ============================================================================


def test_bfs_crawls_same_domain_with_dedupe_and_filters(crawler: GenericCrawler):
    """BFS 抓全同域 3 页（每页 1 条 entry）；外域/资源/锚点/mailto 被过滤；环不重复"""
    with patch.object(GenericCrawler, "_http_get", _fake_http_get):
        result = crawler.fetch()

    assert result.success is True
    urls = [e.url for e in result.entries]
    assert urls == [BASE, "https://docs.test.com/a", "https://docs.test.com/b"]
    assert len(urls) == len(set(urls))  # 互链成环不重复抓
    # 每页 1 条 entry，title=页面标题（h1 优先）
    assert [e.title for e in result.entries] == ["Home", "Page A", "Page B"]
    assert all(e.source == "test-docs" for e in result.entries)
    assert all("test" in e.tags for e in result.entries)


def test_bfs_page_content_contains_body(crawler: GenericCrawler):
    """页面正文沿用 h1/h2/h3+段落逻辑合并（非空且含正文文本）"""
    with patch.object(GenericCrawler, "_http_get", _fake_http_get):
        result = crawler.fetch()
    home = result.entries[0]
    assert "home 页正文内容" in home.content
    assert 500 <= len(home.content) <= 12000  # 质量门槛下限 + 整页合并上限


def test_bfs_depth_limit(tmp_path: Path):
    """max_depth=0：只抓 base_url 一页，不扩展链接"""
    crawler = GenericCrawler(
        source="test-docs", base_url=BASE, cache_root=tmp_path / "c",
        max_pages=30, max_depth=0, delay=0,
    )
    with patch.object(GenericCrawler, "_http_get", _fake_http_get):
        result = crawler.fetch()
    assert [e.url for e in result.entries] == [BASE]


def test_bfs_max_pages_limit(tmp_path: Path):
    """max_pages=2：最多抓 2 页即停"""
    crawler = GenericCrawler(
        source="test-docs", base_url=BASE, cache_root=tmp_path / "c",
        max_pages=2, max_depth=2, delay=0,
    )
    with patch.object(GenericCrawler, "_http_get", _fake_http_get):
        result = crawler.fetch()
    assert len(result.entries) == 2


def test_bfs_failed_page_skipped(tmp_path: Path):
    """单页超时失败：记 warning 跳过继续，其余页正常，整体不抛出"""
    crawler = GenericCrawler(
        source="test-docs", base_url=BASE, cache_root=tmp_path / "c",
        max_pages=30, max_depth=2, delay=0,
    )
    with patch.object(GenericCrawler, "_http_get", _fake_http_get_b_fail):
        result = crawler.fetch()  # 不应抛出

    urls = [e.url for e in result.entries]
    assert "https://docs.test.com/b" not in urls
    assert BASE in urls and "https://docs.test.com/a" in urls
    assert result.success is True  # 其他页成功
    assert result.error  # 记录了失败页的错误信息


def test_bfs_offline_cache_replay(tmp_path: Path):
    """联网抓一遍写缓存后，offline 模式从缓存重放出相同结果"""
    online = GenericCrawler(
        source="test-docs", base_url=BASE, cache_root=tmp_path / "c",
        max_pages=30, max_depth=2, delay=0,
    )
    with patch.object(GenericCrawler, "_http_get", _fake_http_get):
        online_result = online.fetch()
    assert online_result.success is True

    offline = GenericCrawler(
        source="test-docs", base_url=BASE, cache_root=tmp_path / "c",
        max_pages=30, max_depth=2, delay=0,
    )
    offline_result = offline.fetch(offline=True)
    assert offline_result.success is True
    assert offline_result.from_cache is True
    assert [e.url for e in offline_result.entries] == [
        e.url for e in online_result.entries
    ]


def test_bfs_parse_empty_page_skipped(tmp_path: Path):
    """解析为空的页面（无正文）记 warning 跳过，不影响其他页"""
    pages = dict(PAGES)
    pages["https://docs.test.com/b"] = "<html><body></body></html>"
    crawler = GenericCrawler(
        source="test-docs", base_url=BASE, cache_root=tmp_path / "c",
        max_pages=30, max_depth=2, delay=0,
    )

    def fake(self, url: str) -> str:
        return pages[url]

    with patch.object(GenericCrawler, "_http_get", fake):
        result = crawler.fetch()

    urls = [e.url for e in result.entries]
    assert "https://docs.test.com/b" not in urls
    assert len(urls) == 2
    assert result.success is True


# ============================================================================
# 2. 语言变体 URL 过滤（TDSF 2026-08-30：防西语/法语整页灌库）
# ============================================================================

from knowledge.crawlers.generic import _is_language_variant  # noqa: E402


@pytest.mark.parametrize(
    "url,expected",
    [
        # 实测残留样本（重爬前混入库的整页外语 URL）——必须剔除
        ("https://kubernetes.io/es/docs/concepts/", True),
        ("https://kubernetes.io/fr/docs/home/", True),
        ("https://man.archlinux.org/man/intro.1.fr", True),
        ("https://man.archlinux.org/man/intro.1.es", True),
        ("https://manpages.debian.org/bookworm/manpages-es/bash.1.es.html", True),
        ("https://wiki.archlinux.org/title/Systemd_(Espa%C3%B1ol)", True),
        # TDSF 2026-08-30 二次漏网样本（bash.1.zh_TW.html 繁体入库根因）：
        # 语言码在文件名后缀且带区域下划线（zh_TW/zh_CN），路径段无语言码
        ("https://manpages.debian.org/bookworm/manpages-zh/bash.1.zh_TW.html", True),
        ("https://manpages.debian.org/bookworm/manpages-zh/bash.1.zh_CN.html", True),
        ("https://man.archlinux.org/man/intro.1.zh_CN", True),
        ("https://man.archlinux.org/man/intro.1.zh_TW", True),
        # man section 带子段（倒数第二段非纯数字）的语言后缀
        ("https://manpages.debian.org/bookworm/manpages-dev/readline.3readline.fr.html", True),
        # 英文/默认语言页——必须保留
        ("https://kubernetes.io/docs/concepts/", False),
        ("https://man.archlinux.org/man/intro.1", False),
        ("https://man.archlinux.org/man/systemd.1.en", False),
        ("https://manpages.debian.org/bookworm/bash/bash.1.en.html", False),
        ("https://manpages.debian.org/bookworm/manpages-dev/readline.3readline.en.html", False),
        ("https://dnf.readthedocs.io/en/latest/cli.html", False),
        ("https://wiki.archlinux.org/title/Systemd", False),
        ("https://wiki.archlinux.org/title/Firefox_(core)", False),  # 消歧义后缀
        ("https://docs.python.org/3/library/os.html", False),
        ("https://manpages.debian.org/bookworm/bash/index.html", False),
    ],
)
def test_is_language_variant(url: str, expected: bool):
    assert _is_language_variant(url) is expected


def test_bfs_skips_language_variant_links(crawler: GenericCrawler):
    """BFS 不跟进语言变体链接（/es/a 被剔除，/a 正常抓）"""
    pages = dict(PAGES)
    pages[BASE] = (
        "<html><head><title>Test Docs</title></head><body>"
        "<h1>Home</h1>"
        f"{_FILLER}"
        "<p>home 页正文内容，足够长的段落文本用于解析。</p>"
        '<a href="/a">A</a>'
        '<a href="/es/a">西语 A</a>'
        "</body></html>"
    )

    def fake(self, url: str) -> str:
        return pages[url]

    with patch.object(GenericCrawler, "_http_get", fake):
        result = crawler.fetch()

    urls = [e.url for e in result.entries]
    assert "https://docs.test.com/a" in urls
    assert "https://docs.test.com/es/a" not in urls


def test_bfs_follows_zh_variants_with_t2s(crawler: GenericCrawler):
    """zh 系变体放行跟进（C1：zh_TW 有价值转简保留）；其余外语变体（fr）剔除

    - zh_TW：入库前繁转简 + tags 加「源自繁体」
    - zh_CN：简体原样保留，不加 tag
    - bash.1.en.html：英文正常跟进
    """
    pages = dict(PAGES)
    pages[BASE] = (
        "<html><head><title>Test Docs</title></head><body>"
        "<h1>Home</h1>"
        f"{_FILLER}"
        '<a href="/bookworm/bash/bash.1.en.html">英文 bash</a>'
        '<a href="/bookworm/manpages-zh/bash.1.zh_TW.html">繁体 bash</a>'
        '<a href="/bookworm/manpages-zh/bash.1.zh_CN.html">简体 bash</a>'
        '<a href="/bookworm/manpages-fr/bash.1.fr.html">法语 bash</a>'
        "</body></html>"
    )
    trad = "Bash是一個與sh相容的命令解釋程式，可以讀取檔案並執行命令。" * 20
    pages["https://docs.test.com/bookworm/manpages-zh/bash.1.zh_TW.html"] = (
        "<html><body><h1>NAME</h1>"
        f"<p>{trad}</p>"
        "</body></html>"
    )
    simp = "Bash是一个与sh兼容的命令解释程序，可以读取文件并执行命令。" * 20
    pages["https://docs.test.com/bookworm/manpages-zh/bash.1.zh_CN.html"] = (
        "<html><body><h1>NAME</h1>"
        f"<p>{simp}</p>"
        "</body></html>"
    )
    pages["https://docs.test.com/bookworm/bash/bash.1.en.html"] = (
        "<html><body><h1>bash(1)</h1>"
        f"{_FILLER}"
        "</body></html>"
    )

    def fake(self, url: str) -> str:
        return pages[url]

    with patch.object(GenericCrawler, "_http_get", fake):
        result = crawler.fetch()

    urls = [e.url for e in result.entries]
    assert "https://docs.test.com/bookworm/bash/bash.1.en.html" in urls
    assert "https://docs.test.com/bookworm/manpages-zh/bash.1.zh_TW.html" in urls
    assert "https://docs.test.com/bookworm/manpages-zh/bash.1.zh_CN.html" in urls
    assert "https://docs.test.com/bookworm/manpages-fr/bash.1.fr.html" not in urls

    tw = next(e for e in result.entries if e.url.endswith("bash.1.zh_TW.html"))
    assert "源自繁体" in tw.tags
    assert "解釋" not in tw.content
    assert "解释" in tw.content

    cn = next(e for e in result.entries if e.url.endswith("bash.1.zh_CN.html"))
    assert "源自繁体" not in cn.tags
    assert "兼容" in cn.content


def test_bfs_skips_query_urls(crawler: GenericCrawler):
    """BFS 不跟进查询串 URL（jump?q= 重定向 / ?search= 搜索）"""
    pages = dict(PAGES)
    pages[BASE] = (
        "<html><head><title>Test Docs</title></head><body>"
        "<h1>Home</h1>"
        f"{_FILLER}"
        '<a href="/jump?q=intro.1">跳转</a>'
        '<a href="/search?q=bash">搜索</a>'
        '<a href="/a">正文页</a>'
        "</body></html>"
    )

    def fake(self, url: str) -> str:
        return pages[url]

    with patch.object(GenericCrawler, "_http_get", fake):
        result = crawler.fetch()

    urls = [e.url for e in result.entries]
    assert "https://docs.test.com/jump?q=intro.1" not in urls
    assert "https://docs.test.com/search?q=bash" not in urls
    assert "https://docs.test.com/a" in urls


# ============================================================================
# 2.5 Wiki 命名空间页过滤（TDSF 2026-08-30：ArchWiki:* / Talk:* / Special:*）
# ============================================================================

from knowledge.crawlers.generic import (  # noqa: E402
    _is_wiki_meta_page,
    _is_wiki_namespace_title,
)


@pytest.mark.parametrize(
    "url,expected",
    [
        # 实测混入库的垃圾页 URL——必须剔除
        ("https://wiki.archlinux.org/title/Special:Search", True),
        ("https://wiki.archlinux.org/title/Special:WhatLinksHere/Systemd", True),
        ("https://wiki.archlinux.org/title/Special:Random", True),
        ("https://wiki.archlinux.org/title/Talk:Systemd", True),
        ("https://wiki.archlinux.org/title/ArchWiki_talk:Requests", True),
        ("https://wiki.archlinux.org/title/ArchWiki:News", True),
        ("https://wiki.archlinux.org/title/ArchWiki:Statistics", True),
        ("https://wiki.archlinux.org/title/Category:Init", True),
        ("https://wiki.archlinux.org/title/Help:Reading", True),
        # 无冒号门户/社区页
        ("https://wiki.archlinux.org/title/Main_page", True),
        ("https://wiki.archlinux.org/title/Getting_involved", True),
        # 站点根（Main page）/ 非文章路径
        ("https://wiki.archlinux.org/", True),
        ("https://wiki.archlinux.org/index.php?title=X", True),
        ("https://wiki.gentoo.org/wiki/Special:Log", True),
        # 正常文章页——必须保留
        ("https://wiki.archlinux.org/title/Systemd", False),
        ("https://wiki.archlinux.org/title/Systemd/User", False),  # 子页合法
        ("https://wiki.archlinux.org/title/Firefox_(core)", False),
        ("https://wiki.gentoo.org/wiki/SELinux", False),
        # 非 wiki 站不受影响
        ("https://nginx.org/docs/", False),
    ],
)
def test_is_wiki_meta_page(url: str, expected: bool):
    assert _is_wiki_meta_page(url) is expected


def test_is_wiki_namespace_title():
    """重定向场景：URL 干净但 h1 为命名空间页（Restart→Help:Reading 实测样本）"""
    assert _is_wiki_namespace_title("Help:Reading") is True
    assert _is_wiki_namespace_title("Systemd") is False


def test_bfs_discards_wiki_namespace_title(tmp_path: Path):
    """wiki 站页面标题含命名空间冒号 → 丢弃（不产出 entry）"""
    crawler = GenericCrawler(
        source="archwiki",
        base_url="https://wiki.archlinux.org/title/Systemd",
        tags=["wiki"],
        cache_root=tmp_path / "c",
        max_pages=3,
        max_depth=0,
        delay=0,
    )
    html = (
        "<html><body><h1>Help:Reading</h1>"
        f"{_FILLER}"
        "</body></html>"
    )
    with patch.object(GenericCrawler, "_http_get", lambda self, url: html):
        result = crawler.fetch()
    assert result.entries == []
    assert result.success is True  # 页面抓到了，只是被治理规则丢弃


def test_bfs_discards_short_pages(tmp_path: Path):
    """质量门槛：正文 <500 字的纯导航页被丢弃（134 字 Statistics 类残页）"""
    pages = dict(PAGES)
    pages["https://docs.test.com/b"] = (
        "<html><body><h1>Nav Only</h1>"
        "<p>仅导航文字，内容极短，不构成教学文档。</p>"
        "</body></html>"
    )
    crawler = GenericCrawler(
        source="test-docs", base_url=BASE, cache_root=tmp_path / "c",
        max_pages=30, max_depth=2, delay=0,
    )
    with patch.object(GenericCrawler, "_http_get", lambda self, url: pages[url]):
        result = crawler.fetch()

    urls = [e.url for e in result.entries]
    assert "https://docs.test.com/b" not in urls
    assert len(urls) == 2
    assert result.success is True


def test_bfs_whole_page_merge_up_to_12000(tmp_path: Path):
    """整页合并：正文上限从 4000 提高到 12000（4000+ 字的完整文章不截断丢失）"""
    long_text = "这是一段用于验证整页合并上限的长正文内容，详细描述配置步骤。" * 150  # ~7500 字
    html = (
        "<html><body><h1>Long Page</h1>"
        "<p>导语段：概述本文目标。</p>"
        "<h2>配置</h2>"
        f"<p>{long_text}</p>"
        "</body></html>"
    )
    crawler = GenericCrawler(
        source="test-docs", base_url=BASE, cache_root=tmp_path / "c",
        max_pages=1, max_depth=0, delay=0,
    )
    with patch.object(GenericCrawler, "_http_get", lambda self, url: html):
        result = crawler.fetch()

    assert len(result.entries) == 1
    content = result.entries[0].content
    assert len(content) > 4000  # 旧 4000 上限会截断的内容现完整保留
    assert len(content) <= 12000
    assert "导语段" in content  # 首 header 之前的导语段并入正文


def test_bfs_skips_binary_download_links(tmp_path: Path):
    """资源扩展名补漏（.epub 等）：二进制下载链接不跟进（python-3.14-docs.epub
    曾被当 HTML 下载解析成乱码入库）"""
    pages = dict(PAGES)
    pages[BASE] = (
        "<html><head><title>Test Docs</title></head><body>"
        "<h1>Home</h1>"
        f"{_FILLER}"
        '<a href="/archives/python-3.14-docs.epub">电子书下载</a>'
        '<a href="/a">正文页</a>'
        "</body></html>"
    )
    crawler = GenericCrawler(
        source="test-docs", base_url=BASE, cache_root=tmp_path / "c",
        max_pages=30, max_depth=2, delay=0,
    )

    def fake(self, url: str) -> str:
        return pages[url]

    with patch.object(GenericCrawler, "_http_get", fake):
        result = crawler.fetch()

    urls = [e.url for e in result.entries]
    assert "https://docs.test.com/archives/python-3.14-docs.epub" not in urls
    assert "https://docs.test.com/a" in urls


def test_bfs_discards_binary_garbage_page(tmp_path: Path):
    """二进制内容防护：控制字符占比 >5% 的乱码页整页丢弃
    （requests 对二进制响应 resp.text 解码出的乱码文本）"""
    binary_junk = "".join(chr(i) for i in range(1, 32) if i not in (10, 13, 9)) * 120
    html = (
        "<html><body><h1>download</h1>"
        f"<p>{binary_junk}</p>"
        "</body></html>"
    )
    crawler = GenericCrawler(
        source="test-docs", base_url=BASE, cache_root=tmp_path / "c",
        max_pages=1, max_depth=0, delay=0,
    )
    with patch.object(GenericCrawler, "_http_get", lambda self, url: html):
        result = crawler.fetch()

    assert result.entries == []
    assert result.success is True


# ============================================================================
# 3. NginxCrawler 对齐（共享 BFS）
# ============================================================================


def test_nginx_crawler_bfs_max_pages(tmp_path: Path):
    """NginxCrawler BFS 对齐：max_pages=1 只抓首页 1 条 entry"""
    crawler = NginxCrawler(cache_root=tmp_path / "c", max_pages=1, max_depth=2, delay=0)
    mock_response = MagicMock()
    mock_response.text = PAGES[BASE]
    mock_response.raise_for_status.return_value = None

    with patch("requests.get", return_value=mock_response):
        result = crawler.fetch(offline=False)

    assert result.success is True
    assert len(result.entries) == 1
    assert result.entries[0].title == "Home"
    assert result.entries[0].url == "https://nginx.org/docs/"


def test_nginx_crawler_bfs_multi_page(tmp_path: Path):
    """NginxCrawler BFS 默认参数：同域多页抓取（假站点镜像映射到 nginx 域）"""
    crawler = NginxCrawler(cache_root=tmp_path / "c", delay=0)
    nginx_base = "https://nginx.org/docs/"
    mirror = {
        nginx_base: PAGES[BASE],
        "https://nginx.org/a": PAGES["https://docs.test.com/a"],
        "https://nginx.org/b": PAGES["https://docs.test.com/b"],
    }

    def fake_get(url, **kwargs):
        resp = MagicMock()
        resp.text = mirror.get(url, "<html><body><p>x</p></body></html>")
        resp.raise_for_status.return_value = None
        return resp

    with patch("requests.get", side_effect=fake_get):
        result = crawler.fetch(offline=False)

    assert [e.url for e in result.entries] == [
        nginx_base, "https://nginx.org/a", "https://nginx.org/b",
    ]
    assert all(e.source == "nginx-docs" for e in result.entries)
    assert all("nginx" in e.tags for e in result.entries)
