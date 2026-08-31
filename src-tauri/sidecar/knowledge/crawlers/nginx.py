"""
knowledge/crawlers/nginx.py — nginx 文档爬虫（T-P3-03，深度抓取增强）
=========================================================================

抓取 nginx 官方文档：https://nginx.org/docs/
解析 beginners_guide / config / modules 等章节。

受控多页抓取：与 GenericCrawler 对齐 BFS 参数（max_pages/max_depth/delay），
通过 generic.crawl_site 共享同一 BFS 实现；parse() 保留单页章节拆分。
"""

from __future__ import annotations

import logging
from typing import Any

from bs4 import BeautifulSoup  # type: ignore[import-untyped]

from knowledge.crawlers.base import BaseCrawler, CrawlerResult
from knowledge.crawlers.clean import clean_content, clean_title
from knowledge.crawlers.generic import _dedupe_entries, _filter_reason, crawl_site
from knowledge.fts5 import KnowledgeEntry

logger = logging.getLogger("sidecar.knowledge.crawlers.nginx")


class NginxCrawler(BaseCrawler):
    """nginx 文档爬虫（受控多页 BFS，参数与 GenericCrawler 对齐）"""

    def __init__(
        self,
        cache_root=None,
        max_pages: int = 30,
        max_depth: int = 2,
        delay: float = 1.0,
    ) -> None:
        super().__init__(
            source="nginx-docs",
            base_url="https://nginx.org/docs/",
            cache_root=cache_root,
        )
        self.max_pages = max(1, int(max_pages))
        self.max_depth = max(0, int(max_depth))
        self.delay = max(0.0, float(delay))

    def fetch(self, offline: bool = False) -> CrawlerResult:
        """受控多页抓取：BFS 同域爬站（复用通用 crawl_site，每页 1 条 entry）"""
        return crawl_site(
            self,
            max_pages=self.max_pages,
            max_depth=self.max_depth,
            delay=self.delay,
            offline=offline,
            default_tags=["nginx", "docs"],
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
        """转换为 KnowledgeEntry（清洗 + 页面治理，与 GenericCrawler 对齐）

        TDSF 2026-08-30 根因修复：标题走 clean_title（去 .html/.cgi 后缀、
        slug 兜底），条目统一过 _filter_reason（垃圾标题/链接墙/短页/
        繁体）+ 同标题去重。BFS 主路径经 crawl_site._extract_page 已治理，
        此处覆盖 parse() 单页拆分路径。
        """
        from knowledge.sources import category_for

        entries: list[KnowledgeEntry] = []
        discarded = 0
        for i, item in enumerate(items):
            content = clean_content(item.get("content", ""))
            raw_title = str(item.get("title", ""))
            url = str(item.get("url", self.base_url))
            title = clean_title(clean_content(raw_title) or raw_title, url)
            if _filter_reason({"title": title, "content": content}) is not None:
                discarded += 1
                continue
            entries.append(KnowledgeEntry(
                id=self.build_entry_id({"title": title, "url": url}, i),
                source=self.source,
                title=title,
                content=content,
                url=url,
                tags=item.get("tags", ["nginx"]),
                category=category_for(self.source, title),
            ))
        if discarded:
            from knowledge.crawlers.generic import _PAGE_MIN_CHARS

            logger.info(
                f"[{self.source}] to_entries discarded {discarded} page(s) "
                f"(junk-title/link-farm/short<{_PAGE_MIN_CHARS}/traditional)"
            )
        return _dedupe_entries(entries, self.source)
