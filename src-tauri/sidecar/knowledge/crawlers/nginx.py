"""
knowledge/crawlers/nginx.py — nginx 文档爬虫（T-P3-03）
=========================================================

抓取 nginx 官方文档：https://nginx.org/docs/
解析 beginners_guide / config / modules 等章节
"""

from __future__ import annotations

from typing import Any

from bs4 import BeautifulSoup  # type: ignore[import-untyped]

from knowledge.crawlers.base import BaseCrawler
from knowledge.fts5 import KnowledgeEntry


class NginxCrawler(BaseCrawler):
    """nginx 文档爬虫"""

    def __init__(self, cache_root=None) -> None:
        super().__init__(
            source="nginx-docs",
            base_url="https://nginx.org/docs/",
            cache_root=cache_root,
        )

    def parse(self, html: str) -> list[dict[str, Any]]:
        """解析 nginx 文档 HTML，提取章节标题和正文"""
        soup = BeautifulSoup(html, "html.parser")
        items: list[dict[str, Any]] = []

        # 提取所有 h1/h2/h3 + 后续段落
        for header in soup.find_all(["h1", "h2", "h3"]):
            title = header.get_text(strip=True)
            if not title:
                continue
            # 收集后续兄弟节点直到下一个 header
            content_parts: list[str] = []
            for sibling in header.find_next_siblings():
                if sibling.name in ("h1", "h2", "h3"):
                    break
                text = sibling.get_text(strip=True)
                if text:
                    content_parts.append(text)
            content = "\n".join(content_parts) if content_parts else title

            items.append({
                "title": title,
                "content": content,
                "url": self.base_url,
                "tags": ["nginx", "docs"],
            })

        # 兜底：若无 header，提取所有段落
        if not items:
            for p in soup.find_all("p")[:50]:
                text = p.get_text(strip=True)
                if len(text) > 30:
                    items.append({
                        "title": text[:60],
                        "content": text,
                        "url": self.base_url,
                        "tags": ["nginx", "docs"],
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
                tags=item.get("tags", ["nginx"]),
            ))
        return entries
