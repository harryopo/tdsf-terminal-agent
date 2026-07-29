"""
knowledge/crawlers/__init__.py — 14 源爬虫模块入口（T-P3-03）
================================================================

聚合 14 个文档源爬虫：nginx / apache / mysql / redis / docker / kubernetes /
systemd / selinux / iptables / ssh / bash / python / rust / git

每个爬虫继承 BaseCrawler，统一返回 List[KnowledgeEntry]。
"""

from __future__ import annotations

from knowledge.crawlers.base import BaseCrawler, CrawlerResult
from knowledge.crawlers.registry import (
    CRAWLER_REGISTRY,
    get_crawler,
    list_crawlers,
    crawl_all,
)

__all__ = [
    "BaseCrawler",
    "CrawlerResult",
    "CRAWLER_REGISTRY",
    "get_crawler",
    "list_crawlers",
    "crawl_all",
]
