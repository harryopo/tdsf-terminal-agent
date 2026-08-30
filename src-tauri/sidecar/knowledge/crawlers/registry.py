"""
knowledge/crawlers/registry.py — 14 源爬虫注册表（T-P3-03）
==============================================================

聚合 14 个文档源爬虫：
1. nginx       — https://nginx.org/docs/
2. apache      — https://httpd.apache.org/docs/
3. mysql       — https://dev.mysql.com/doc/
4. redis       — https://redis.io/docs/
5. docker      — https://docs.docker.com/
6. kubernetes  — https://kubernetes.io/docs/
7. systemd     — https://systemd.io/docs/
8. selinux     — https://selinuxproject.org/page/Main_Page
9. iptables    — https://www.netfilter.org/documentation/
10. ssh        — https://www.ssh.com/docs/
11. bash       — https://www.gnu.org/software/bash/manual/
12. python     — https://docs.python.org/3/
13. rust       — https://doc.rust-lang.org/
14. git        — https://git-scm.com/docs/

通过 get_crawler(source) 获取具体爬虫实例，crawl_all() 批量抓取。
"""

from __future__ import annotations

import logging
from typing import Any

from knowledge.crawlers.base import BaseCrawler, CrawlerResult
from knowledge.crawlers.generic import GenericCrawler
from knowledge.crawlers.nginx import NginxCrawler

logger = logging.getLogger("sidecar.knowledge.crawlers.registry")


# ============================================================================
# 14 源爬虫工厂
# ============================================================================


def _make_crawlers() -> dict[str, BaseCrawler]:
    """创建 14 个爬虫实例

    受控多页参数（与 GenericCrawler/NginxCrawler 默认一致，显式写出便于
    按源调整）：max_pages=30（最多抓 30 页）、max_depth=2（BFS 深度）、
    delay=1.0（页间限速秒数）。

    Returns:
        source → crawler 实例的字典
    """
    return {
        "nginx-docs": NginxCrawler(max_pages=30, max_depth=2, delay=1.0),
        "apache-docs": GenericCrawler(
            source="apache-docs",
            base_url="https://httpd.apache.org/docs/",
            tags=["apache", "httpd"],
            max_pages=30,
            max_depth=2,
            delay=1.0,
        ),
        "mysql-docs": GenericCrawler(
            source="mysql-docs",
            base_url="https://dev.mysql.com/doc/",
            tags=["mysql", "database"],
            max_pages=30,
            max_depth=2,
            delay=1.0,
        ),
        "redis-docs": GenericCrawler(
            source="redis-docs",
            base_url="https://redis.io/docs/",
            tags=["redis", "cache"],
            max_pages=30,
            max_depth=2,
            delay=1.0,
        ),
        "docker-docs": GenericCrawler(
            source="docker-docs",
            base_url="https://docs.docker.com/",
            tags=["docker", "container"],
            max_pages=30,
            max_depth=2,
            delay=1.0,
        ),
        "kubernetes-docs": GenericCrawler(
            source="kubernetes-docs",
            base_url="https://kubernetes.io/docs/",
            tags=["kubernetes", "k8s"],
            max_pages=30,
            max_depth=2,
            delay=1.0,
        ),
        # TDSF 修复 2026-08-30: freedesktop.org 对非浏览器请求返回 418 反爬
        # ——改用 Arch Linux 官方 man 托管（静态无反爬，含 systemd 全套手册）
        "systemd-docs": GenericCrawler(
            source="systemd-docs",
            base_url="https://man.archlinux.org/",
            tags=["systemd", "service", "man"],
            max_pages=30,
            max_depth=2,
            delay=1.0,
        ),
        # TDSF 修复 2026-08-30: selinuxproject.org 站点 SSL 故障且年久失修、
        # redhat 文档站 403 反爬 ——改用 Gentoo Wiki SELinux（官方维护、可抓）
        "selinux-docs": GenericCrawler(
            source="selinux-docs",
            base_url="https://wiki.gentoo.org/wiki/SELinux",
            tags=["selinux", "security"],
            max_pages=30,
            max_depth=2,
            delay=1.0,
        ),
        "iptables-docs": GenericCrawler(
            source="iptables-docs",
            base_url="https://www.netfilter.org/documentation/",
            tags=["iptables", "firewall"],
            max_pages=30,
            max_depth=2,
            delay=1.0,
        ),
        # TDSF 修复 2026-08-30: ssh.com/docs/ 为 404 ——改用 OpenSSH 官方
        # 手册（man.openbsd.org，OpenSSH 项目自己的 man 托管，实测可抓）
        "ssh-docs": GenericCrawler(
            source="ssh-docs",
            base_url="https://man.openbsd.org/ssh",
            tags=["ssh", "remote"],
            max_pages=30,
            max_depth=2,
            delay=1.0,
        ),
        # TDSF 修复 2026-08-30: gnu.org 国内网络不可达（超时）——改用
        # Debian 官方 manpages 托管的 bash(1) 完整手册（静态无反爬）
        "bash-docs": GenericCrawler(
            source="bash-docs",
            base_url="https://manpages.debian.org/bookworm/bash/bash.1.en.html",
            tags=["bash", "shell"],
            max_pages=30,
            max_depth=2,
            delay=1.0,
        ),
        "python-docs": GenericCrawler(
            source="python-docs",
            base_url="https://docs.python.org/3/",
            tags=["python", "language"],
            max_pages=30,
            max_depth=2,
            delay=1.0,
        ),
        "rust-docs": GenericCrawler(
            source="rust-docs",
            base_url="https://doc.rust-lang.org/",
            tags=["rust", "language"],
            max_pages=30,
            max_depth=2,
            delay=1.0,
        ),
        "git-docs": GenericCrawler(
            source="git-docs",
            base_url="https://git-scm.com/docs/",
            tags=["git", "vcs"],
            max_pages=30,
            max_depth=2,
            delay=1.0,
        ),
    }


# 全局注册表（懒加载）
CRAWLER_REGISTRY: dict[str, BaseCrawler] | None = None


def _ensure_registry() -> dict[str, BaseCrawler]:
    """确保注册表已初始化"""
    global CRAWLER_REGISTRY
    if CRAWLER_REGISTRY is None:
        CRAWLER_REGISTRY = _make_crawlers()
    return CRAWLER_REGISTRY


def get_crawler(source: str) -> BaseCrawler | None:
    """获取指定 source 的爬虫实例

    Args:
        source: 来源标识（如 "nginx-docs"）

    Returns:
        BaseCrawler 实例；不存在返回 None
    """
    registry = _ensure_registry()
    return registry.get(source)


def list_crawlers() -> list[str]:
    """列出所有已注册的 source 标识"""
    registry = _ensure_registry()
    return sorted(registry.keys())


def crawl_all(offline: bool = False) -> dict[str, CrawlerResult]:
    """批量抓取所有源

    Args:
        offline: True 时仅从缓存读取

    Returns:
        source → CrawlerResult 字典
    """
    registry = _ensure_registry()
    results: dict[str, CrawlerResult] = {}
    for source, crawler in registry.items():
        try:
            result = crawler.fetch(offline=offline)
            results[source] = result
            logger.info(
                f"crawl {source}: success={result.success}, "
                f"entries={len(result.entries)}, from_cache={result.from_cache}"
            )
        except Exception as e:
            logger.exception(f"crawl {source} failed: {e}")
            results[source] = CrawlerResult(
                source=source,
                success=False,
                error=str(e),
            )
    return results


def reset_registry() -> None:
    """重置注册表（仅供测试使用）"""
    global CRAWLER_REGISTRY
    CRAWLER_REGISTRY = None
