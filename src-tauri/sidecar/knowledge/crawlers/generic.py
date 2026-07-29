"""
knowledge/crawlers/generic.py — 通用文档爬虫模板（T-P3-03）
=============================================================

为 13 个文档源（apache/mysql/redis/docker/kubernetes/systemd/selinux/
iptables/ssh/bash/python/rust/git）提供通用实现。

每个源通过 GenericCrawler(source, base_url, tags) 实例化，
parse() 使用 BeautifulSoup 提取章节标题 + 正文段落，
to_entries() 转换为 KnowledgeEntry。

这样 14 个源共享同一解析逻辑，差异化通过 source/tags/URL 体现。
"""

from __future__ import annotations

from typing import Any

from bs4 import BeautifulSoup  # type: ignore[import-untyped]

from knowledge.crawlers.base import BaseCrawler
from knowledge.fts5 import KnowledgeEntry


class GenericCrawler(BaseCrawler):
    """通用文档爬虫

    适用于大多数官方文档站点（HTML 结构相似）：
    - 提取 h1/h2/h3 + 后续段落作为条目
    - 无 header 时兜底提取段落
    """

    def __init__(
        self,
        source: str,
        base_url: str,
        tags: list[str] | None = None,
        cache_root=None,
    ) -> None:
        super().__init__(source=source, base_url=base_url, cache_root=cache_root)
        self.default_tags: list[str] = tags or [source]

    def parse(self, html: str) -> list[dict[str, Any]]:
        """通用 HTML 解析：提取章节标题 + 正文"""
        soup = BeautifulSoup(html, "html.parser")
        items: list[dict[str, Any]] = []

        # 策略 1：提取所有 h1/h2/h3 + 后续段落
        for header in soup.find_all(["h1", "h2", "h3"]):
            title = header.get_text(strip=True)
            if not title or len(title) < 2:
                continue
            content_parts: list[str] = []
            for sibling in header.find_next_siblings():
                if sibling.name in ("h1", "h2", "h3"):
                    break
                text = sibling.get_text(strip=True)
                if text:
                    content_parts.append(text)
            content = "\n".join(content_parts) if content_parts else title
            if len(content) < 10:
                continue
            items.append({
                "title": title,
                "content": content,
                "url": self.base_url,
                "tags": self.default_tags,
            })

        # 策略 2：兜底，提取所有段落
        if not items:
            for p in soup.find_all("p")[:50]:
                text = p.get_text(strip=True)
                if len(text) > 30:
                    items.append({
                        "title": text[:60],
                        "content": text,
                        "url": self.base_url,
                        "tags": self.default_tags,
                    })

        # 策略 3：再兜底，从 div/article 提取
        if not items:
            for div in soup.find_all(["div", "article"])[:20]:
                text = div.get_text(strip=True)
                if len(text) > 50:
                    items.append({
                        "title": text[:60],
                        "content": text[:500],
                        "url": self.base_url,
                        "tags": self.default_tags,
                    })

        return items

    def to_entries(self, items: list[dict[str, Any]]) -> list[KnowledgeEntry]:
        """转换为 KnowledgeEntry"""
        entries: list[KnowledgeEntry] = []
        for i, item in enumerate(items):
            entry_id = self.build_entry_id(item, i)
            entries.append(KnowledgeEntry(
                id=entry_id,
                source=self.source,
                title=item.get("title", ""),
                content=item.get("content", ""),
                url=item.get("url", self.base_url),
                tags=item.get("tags", self.default_tags),
            ))
        return entries
