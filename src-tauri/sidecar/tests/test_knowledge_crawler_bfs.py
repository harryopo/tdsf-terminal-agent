"""
tests/test_knowledge_crawler_bfs.py — 爬虫 BFS 深度抓取测试（知识库升级）
=========================================================================

覆盖（全部本地假 HTML，不联网）：
1. BFS 同域抓取：多页产出（每页 1 条 entry）、页面去重（互链成环）
2. 链接过滤：外域 / 资源文件后缀 / 锚点 / mailto-javascript
3. max_depth 深度限制 / max_pages 页数上限
4. 单页失败（超时）记 warning 跳过继续，整体不抛出
5. 离线缓存重放（offline 模式复用已抓缓存）
6. NginxCrawler 与 GenericCrawler 共享 BFS（max_pages 对齐）

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

# 本地假站点：home 互链 a/b；b 链回 a（环）；含外域/资源/锚点干扰链接
PAGES = {
    BASE: (
        "<html><head><title>Test Docs</title></head><body>"
        "<h1>Home</h1><p>home 页正文内容，足够长的段落文本用于解析。</p>"
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
        "<h1>Page A</h1><p>A 页正文内容，足够长的段落文本用于解析。</p>"
        '<a href="/">回首页</a>'
        '<a href="/b">去 B</a>'
        "</body></html>"
    ),
    "https://docs.test.com/b": (
        "<html><body>"
        "<h1>Page B</h1><p>B 页正文内容，足够长的段落文本用于解析。</p>"
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
    assert len(home.content) <= 4000  # 截断上限


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
        # 英文/默认语言页——必须保留
        ("https://kubernetes.io/docs/concepts/", False),
        ("https://man.archlinux.org/man/intro.1", False),
        ("https://man.archlinux.org/man/systemd.1.en", False),
        ("https://manpages.debian.org/bookworm/bash/bash.1.en.html", False),
        ("https://dnf.readthedocs.io/en/latest/cli.html", False),
        ("https://wiki.archlinux.org/title/Systemd", False),
        ("https://wiki.archlinux.org/title/Firefox_(core)", False),  # 消歧义后缀
        ("https://docs.python.org/3/library/os.html", False),
    ],
)
def test_is_language_variant(url: str, expected: bool):
    assert _is_language_variant(url) is expected


def test_bfs_skips_language_variant_links(crawler: GenericCrawler):
    """BFS 不跟进语言变体链接（/es/a 被剔除，/a 正常抓）"""
    pages = dict(PAGES)
    pages[BASE] = (
        "<html><head><title>Test Docs</title></head><body>"
        "<h1>Home</h1><p>home 页正文内容，足够长的段落文本用于解析。</p>"
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
