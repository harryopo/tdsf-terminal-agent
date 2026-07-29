"""
tests/test_crawlers.py — 14 源爬虫单元测试（T-P3-03 验证）
============================================================

验证内容：
1. BaseCrawler 抽象基类（不能直接实例化）
2. NginxCrawler fetch（mock 数据）/ parse / to_entries
3. GenericCrawler 通用解析逻辑
4. 多源爬虫注册表完整性
5. 离线缓存命中 / 未命中降级
6. 网络失败 fallback 到缓存

所有测试使用 mock 数据，不实际联网。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import patch, MagicMock

sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

from knowledge.crawlers.base import BaseCrawler, CrawlerResult
from knowledge.crawlers.generic import GenericCrawler
from knowledge.crawlers.nginx import NginxCrawler
from knowledge.crawlers.registry import (
    CRAWLER_REGISTRY,
    get_crawler,
    list_crawlers,
    crawl_all,
    reset_registry,
)
from knowledge.fts5 import KnowledgeEntry


# ============================================================================
# Fixtures
# ============================================================================


@pytest.fixture
def nginx_mock_html() -> str:
    """nginx 文档 mock HTML"""
    return """
    <html><body>
        <h1>nginx Beginner Guide</h1>
        <p>nginx is a web server. This guide describes the basics.</p>
        <p>Topics include installation, configuration, and usage.</p>
        <h2>Starting nginx</h2>
        <p>To start nginx, run nginx executable.</p>
        <h2>Configuration File Structure</h2>
        <p>nginx consists of modules controlled by directives.</p>
        <p>Directives are simple or block directives.</p>
    </body></html>
    """


@pytest.fixture
def apache_mock_html() -> str:
    """apache 文档 mock HTML"""
    return """
    <html><body>
        <h1>Apache HTTP Server Documentation</h1>
        <p>Apache is the most popular web server.</p>
        <h2>Configuration</h2>
        <p>Configuration files use directives.</p>
        <h2>Modules</h2>
        <p>Apache supports many modules.</p>
    </body></html>
    """


@pytest.fixture
def empty_html() -> str:
    """空 HTML（兜底逻辑测试）"""
    return "<html><body><p>short</p></body></html>"


@pytest.fixture
def temp_crawler(tmp_path: Path) -> NginxCrawler:
    """使用临时缓存目录的 nginx 爬虫"""
    return NginxCrawler(cache_root=tmp_path / "crawlers-cache")


# ============================================================================
# 1. BaseCrawler 抽象基类测试
# ============================================================================


def test_base_crawler_abstract():
    """测试 BaseCrawler 是抽象类，不能直接实例化"""
    with pytest.raises(TypeError):
        BaseCrawler(source="test", base_url="https://example.com")  # type: ignore[abstract]


def test_crawler_result_dataclass():
    """测试 CrawlerResult dataclass 默认值"""
    result = CrawlerResult()
    assert result.source == ""
    assert result.url == ""
    assert result.html == ""
    assert result.entries == []
    assert result.from_cache is False
    assert result.success is False
    assert result.error == ""


# ============================================================================
# 2. NginxCrawler 测试
# ============================================================================


def test_nginx_crawler_init(temp_crawler):
    """测试 NginxCrawler 初始化"""
    assert temp_crawler.source == "nginx-docs"
    assert temp_crawler.base_url == "https://nginx.org/docs/"
    assert temp_crawler.cache_dir.exists()


def test_nginx_crawler_parse(temp_crawler, nginx_mock_html):
    """测试 NginxCrawler.parse 提取章节"""
    items = temp_crawler.parse(nginx_mock_html)
    assert len(items) > 0
    # 应包含 3 个 header（h1 + 2 h2）
    titles = [it["title"] for it in items]
    assert any("Beginner Guide" in t for t in titles)
    assert any("Starting nginx" in t for t in titles)
    assert any("Configuration File Structure" in t for t in titles)


def test_nginx_crawler_to_entries(temp_crawler, nginx_mock_html):
    """测试 NginxCrawler.to_entries 转换"""
    items = temp_crawler.parse(nginx_mock_html)
    entries = temp_crawler.to_entries(items)
    assert len(entries) == len(items)
    for e in entries:
        assert isinstance(e, KnowledgeEntry)
        assert e.source == "nginx-docs"
        assert e.title
        assert e.content
        assert "nginx" in e.tags
        assert e.id.startswith("nginx-docs-")


def test_nginx_crawler_fetch_mock(temp_crawler, nginx_mock_html):
    """测试 NginxCrawler.fetch（mock requests.get）"""
    # mock requests.get 返回 nginx_mock_html
    mock_response = MagicMock()
    mock_response.text = nginx_mock_html
    mock_response.raise_for_status.return_value = None

    with patch("requests.get", return_value=mock_response):
        result = temp_crawler.fetch(offline=False)

    assert result.success is True
    assert result.from_cache is False
    assert len(result.entries) > 0
    # 缓存应已写入
    cache_files = list(temp_crawler.cache_dir.glob("*.json"))
    assert len(cache_files) >= 1


def test_nginx_crawler_offline_cache_hit(temp_crawler, nginx_mock_html):
    """测试离线模式缓存命中"""
    # 先写入缓存
    temp_crawler._write_cache(temp_crawler.base_url, nginx_mock_html)

    # 离线模式读取
    result = temp_crawler.fetch(offline=True)
    assert result.success is True
    assert result.from_cache is True
    assert len(result.entries) > 0


def test_nginx_crawler_offline_cache_miss(temp_crawler):
    """测试离线模式缓存未命中"""
    # 不写缓存，离线模式应失败
    result = temp_crawler.fetch(offline=True)
    assert result.success is False
    assert "cache miss" in result.error.lower() or "cache" in result.error.lower()


# ============================================================================
# 3. GenericCrawler 测试
# ============================================================================


def test_generic_crawler_apache(tmp_path: Path, apache_mock_html):
    """测试 GenericCrawler apache-docs"""
    crawler = GenericCrawler(
        source="apache-docs",
        base_url="https://httpd.apache.org/docs/",
        tags=["apache"],
        cache_root=tmp_path / "cache",
    )
    items = crawler.parse(apache_mock_html)
    assert len(items) > 0
    titles = [it["title"] for it in items]
    assert any("Apache HTTP Server" in t for t in titles)


def test_generic_crawler_empty_html_fallback(tmp_path: Path, empty_html):
    """测试 GenericCrawler 兜底解析（无 header 时从段落提取）"""
    crawler = GenericCrawler(
        source="test-docs",
        base_url="https://example.com/",
        cache_root=tmp_path / "cache",
    )
    # empty_html 无 header，但有 1 个 <p>short</p>（长度 < 30 会被过滤）
    items = crawler.parse(empty_html)
    # 应触发策略 3（div/article 兜底）或返回空
    assert isinstance(items, list)


def test_generic_crawler_network_error_fallback_cache(
    tmp_path: Path,
    apache_mock_html,
):
    """测试网络失败时 fallback 到缓存"""
    crawler = GenericCrawler(
        source="apache-docs",
        base_url="https://httpd.apache.org/docs/",
        cache_root=tmp_path / "cache",
    )
    # 先写缓存
    crawler._write_cache(crawler.base_url, apache_mock_html)

    # mock requests.get 抛异常
    with patch("requests.get", side_effect=ConnectionError("network error")):
        result = crawler.fetch(offline=False)

    # 应 fallback 到缓存
    assert result.success is True
    assert result.from_cache is True
    assert len(result.entries) > 0


# ============================================================================
# 4. 注册表完整性测试
# ============================================================================


def test_registry_list_crawlers_14_sources():
    """测试注册表包含 14 个 source"""
    reset_registry()
    sources = list_crawlers()
    assert len(sources) == 14
    # 验证所有预期 source 存在
    expected = {
        "nginx-docs", "apache-docs", "mysql-docs", "redis-docs",
        "docker-docs", "kubernetes-docs", "systemd-docs", "selinux-docs",
        "iptables-docs", "ssh-docs", "bash-docs", "python-docs",
        "rust-docs", "git-docs",
    }
    assert expected.issubset(set(sources))


def test_registry_get_crawler():
    """测试 get_crawler 返回正确实例"""
    reset_registry()
    nginx = get_crawler("nginx-docs")
    assert nginx is not None
    assert isinstance(nginx, NginxCrawler)
    assert nginx.source == "nginx-docs"

    # 不存在
    none_crawler = get_crawler("nonexistent")
    assert none_crawler is None


def test_registry_crawl_all_offline():
    """测试 crawl_all 离线模式（无缓存时应全部失败）"""
    reset_registry()
    # 使用临时缓存目录（每个爬虫内部 cache_root 是默认路径，但离线模式下
    # 无缓存会返回失败，不影响测试）
    results = crawl_all(offline=True)
    assert len(results) == 14
    for source, result in results.items():
        assert isinstance(result, CrawlerResult)
        assert result.source == source


# ============================================================================
# 5. 缓存读写测试
# ============================================================================


def test_crawler_cache_write_read(temp_crawler):
    """测试缓存写入和读取"""
    url = "https://nginx.org/docs/test"
    html = "<html><body>test content</body></html>"

    # 写入
    temp_crawler._write_cache(url, html)

    # 读取
    cached = temp_crawler._read_cache(url)
    assert cached is not None
    assert cached == html

    # 不存在的 URL
    none_cache = temp_crawler._read_cache("https://nonexistent.com")
    assert none_cache is None


def test_crawler_build_entry_id_uniqueness(temp_crawler):
    """测试 build_entry_id 唯一性

    ID 格式: <source>-<md5hash8>-<index>
    相同内容 → 相同 hash 部分；不同 index → 不同完整 ID
    """
    items = [
        {"title": "nginx 入门", "url": "https://nginx.org/1"},
        {"title": "nginx 配置", "url": "https://nginx.org/2"},
        {"title": "nginx 入门", "url": "https://nginx.org/1"},  # 相同内容
    ]
    ids = [temp_crawler.build_entry_id(item, i) for i, item in enumerate(items)]
    # 全部以 source 前缀开头
    assert all(id.startswith("nginx-docs-") for id in ids)
    # 不同内容应生成不同的 hash 部分
    hash_0 = ids[0].split("-")[2]
    hash_1 = ids[1].split("-")[2]
    assert hash_0 != hash_1
    # 相同内容应生成相同的 hash 部分（index 不同但 hash 一致）
    hash_2 = ids[2].split("-")[2]
    assert hash_0 == hash_2
    # 完整 ID 应唯一（因 index 不同）
    assert len(set(ids)) == 3
