"""
knowledge/crawlers/generic.py — 通用文档爬虫模板（T-P3-03，深度抓取增强）
=========================================================================

为 13 个文档源（apache/mysql/redis/docker/kubernetes/systemd/selinux/
iptables/ssh/bash/python/rust/git）提供通用实现。

受控多页抓取（BFS）：
- GenericCrawler(source, base_url, tags, max_pages=30, max_depth=2, delay=1.0)
- 从 base_url 出发广度优先抓取同域页面：<a href> 过滤（同域名、去锚点、
  去资源文件后缀、visited 去重）
- 每页产出 1 条 KnowledgeEntry（title=页面标题，content=页面正文截断
  ~4000 字；正文沿用 h1/h2/h3+段落解析逻辑合并）
- 页间 sleep(delay) 限速（离线缓存模式不 sleep）；单页失败（超时 10s/
  非 200/解析空）记 warning 跳过继续；整体 try/except 不向上抛出
- 单页缓存能力沿用 BaseCrawler._fetch_single（联网成功写缓存、失败读
  缓存、offline 仅读缓存）

parse()/to_entries() 保留单页章节拆分逻辑（向后兼容与单页解析复用）；
nginx 专用爬虫通过 crawl_site() 共享同一 BFS 实现。
"""

from __future__ import annotations

import logging
import re
import time
from collections import deque
from typing import Any
from urllib.parse import unquote, urljoin, urlparse

from bs4 import BeautifulSoup  # type: ignore[import-untyped]

from knowledge.crawlers.base import BaseCrawler, CrawlerResult
from knowledge.crawlers.clean import clean_content
from knowledge.fts5 import KnowledgeEntry

logger = logging.getLogger("sidecar.knowledge.crawlers.generic")

_PAGE_MAX_CHARS = 4000  # 单页正文截断上限

# 视为资源文件的 URL 后缀（不作为文档页抓取）
_RESOURCE_EXTS = (
    ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico",
    ".css", ".js", ".json", ".xml", ".rss",
    ".pdf", ".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar",
    ".rpm", ".deb", ".exe", ".dmg", ".iso",
    ".mp3", ".mp4", ".avi", ".mkv", ".wav",
    ".woff", ".woff2", ".ttf", ".eot",
)


class GenericCrawler(BaseCrawler):
    """通用文档爬虫（受控多页 BFS）

    适用于大多数官方文档站点（HTML 结构相似）：
    - fetch(): BFS 同域爬站，每页 1 条 entry
    - parse(): 单页 h1/h2/h3 + 后续段落拆分（兜底段落/div 提取）
    """

    def __init__(
        self,
        source: str,
        base_url: str,
        tags: list[str] | None = None,
        cache_root=None,
        max_pages: int = 30,
        max_depth: int = 2,
        delay: float = 1.0,
    ) -> None:
        super().__init__(source=source, base_url=base_url, cache_root=cache_root)
        self.default_tags: list[str] = tags or [source]
        self.max_pages = max(1, int(max_pages))
        self.max_depth = max(0, int(max_depth))
        self.delay = max(0.0, float(delay))

    def fetch(self, offline: bool = False) -> CrawlerResult:
        """受控多页抓取：从 base_url 出发 BFS 同域爬站（每页 1 条 entry）"""
        return crawl_site(
            self,
            max_pages=self.max_pages,
            max_depth=self.max_depth,
            delay=self.delay,
            offline=offline,
            default_tags=self.default_tags,
        )

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
        """转换为 KnowledgeEntry（title/content 入库前清洗）"""
        entries: list[KnowledgeEntry] = []
        for i, item in enumerate(items):
            entry_id = self.build_entry_id(item, i)
            raw_title = str(item.get("title", ""))
            title = clean_content(raw_title) or raw_title
            entries.append(KnowledgeEntry(
                id=entry_id,
                source=self.source,
                title=title,
                content=clean_content(item.get("content", "")),
                url=item.get("url", self.base_url),
                tags=item.get("tags", self.default_tags),
            ))
        return entries


# ============================================================================
# BFS 爬站（GenericCrawler / NginxCrawler 共用）
# ============================================================================


def crawl_site(
    crawler: BaseCrawler,
    *,
    max_pages: int,
    max_depth: int,
    delay: float,
    offline: bool,
    default_tags: list[str],
) -> CrawlerResult:
    """从 crawler.base_url 出发 BFS 抓取同域页面

    - 每页产出 1 条 KnowledgeEntry（title=页面标题，content=正文截断 4000 字）
    - 链接过滤：同域名、去锚点、去资源后缀、visited/queued 去重
    - 单页失败/解析空 → warning 跳过继续；整体 try/except 不抛出
    - 页间 sleep(delay)（仅联网模式；离线缓存重放不限速）
    """
    entries: list[KnowledgeEntry] = []
    visited: set[str] = set()
    queued: set[str] = {crawler.base_url}
    queue: deque[tuple[str, int]] = deque([(crawler.base_url, 0)])
    pages_html: list[str] = []
    last_error = ""
    any_success = False
    any_from_cache = False

    try:
        while queue and len(visited) < max_pages:
            url, depth = queue.popleft()
            if url in visited:
                continue
            visited.add(url)

            result = crawler._fetch_single(url, offline=offline)
            if result.error:
                last_error = result.error
            if result.from_cache:
                any_from_cache = True
            if not result.success or not result.html:
                logger.warning(
                    f"[{crawler.source}] page fetch failed, skip: {url} "
                    f"({result.error or 'empty response'})"
                )
                continue
            any_success = True
            pages_html.append(result.html)

            soup = BeautifulSoup(result.html, "html.parser")
            page = _extract_page(soup, url, default_tags)
            if page is None:
                logger.warning(f"[{crawler.source}] page parsed empty, skip: {url}")
            else:
                entries.append(
                    KnowledgeEntry(
                        id=crawler.build_entry_id(
                            {"title": page["title"], "url": url}, len(entries)
                        ),
                        source=crawler.source,
                        title=page["title"],
                        content=page["content"],
                        url=url,
                        tags=page["tags"],
                    )
                )

            if depth < max_depth:
                for link in _extract_links(soup, url, crawler.base_url):
                    if link not in visited and link not in queued:
                        queued.add(link)
                        queue.append((link, depth + 1))

            if queue and len(visited) < max_pages and not offline and delay > 0:
                time.sleep(delay)
    except Exception as e:
        # 整体兜底：BFS 中断也不向上抛（返回已抓到的部分结果）
        logger.exception(f"[{crawler.source}] crawl_site aborted: {e}")
        last_error = last_error or str(e)

    return CrawlerResult(
        source=crawler.source,
        url=crawler.base_url,
        html="\n".join(pages_html),
        entries=entries,
        from_cache=any_from_cache,
        success=any_success,
        error=last_error,
    )


# ============================================================================
# 语言变体 URL 过滤（TDSF 2026-08-30）
# ============================================================================
# 多语言文档站按 URL 路径协商语言（Accept-Language 头对这类站无效）：
#   kubernetes.io/es/docs/、man.archlinux.org/man/intro.1.fr、
#   manpages.debian.org/.../bash.1.es.html、wiki.archlinux.org/title/X_(Español)
# BFS 若跟进这些链接会把整页西语/法语灌进知识库（实测「Documentación」
# 「NOMBRE」文字墙）。在链接发现处剔除，从源头防污染。

# 非英文语言码（ISO 639-1）——en 不在内（英文/默认语言页保留）
_NON_ENGLISH_LANG_CODES: frozenset[str] = frozenset({
    "ar", "bg", "bn", "cs", "da", "de", "el", "es", "fa", "fi", "fr", "gu",
    "he", "hi", "hr", "hu", "id", "it", "ja", "kn", "ko", "ml", "mr", "nb",
    "nl", "pl", "pt", "ro", "ru", "sk", "sl", "sr", "sv", "ta", "te", "th",
    "tr", "uk", "ur", "vi", "zh",
})

# Arch Wiki 翻译页后缀（非英文语言显示名）——title 形如 Systemd_(Español)
_NON_ENGLISH_WIKI_LANGS: frozenset[str] = frozenset({
    "Deutsch", "Español", "Français", "Italiano", "Português", "Polski",
    "Русский", "日本語", "한국어", "中文", "Bahasa Indonesia", "Nederlands",
    "Suomi", "Svenska", "Català", "Українська", "فارسی", "Türkçe", "עברית",
    "ไทย", "Tiếng Việt",
})

# wiki 翻译后缀：末段 _(<语言名>) 或 /(<语言名>)
_WIKI_LANG_SUFFIX_RE = re.compile(r"[_/]?\(([^)]+)\)\s*$")


def _is_language_variant(url: str) -> bool:
    """判断 URL 是否为非英文语言变体页（BFS 不跟进）

    覆盖三种模式：
    1. 路径首段为语言码（kubernetes.io/es/docs/...；readthedocs /en/ 保留）
    2. man 页 locale 后缀（intro.1.es、bash.1.es.html——倒数第二段为 man
       section 数字，避免误伤 name.section 形式的英文页）
    3. Arch Wiki 翻译后缀（Systemd_(Español)；消歧义后缀如 Firefox_(core) 保留）
    """
    parsed = urlparse(url)
    segs = [s for s in parsed.path.split("/") if s]
    # 模式 1：首段语言码（en / 非语言码 / 数字段 均保留）
    if segs:
        first = segs[0].lower().split("-")[0]
        if first in _NON_ENGLISH_LANG_CODES:
            return True
    # 模式 2：man locale 后缀（name.<section>.<lang>[.html]）
    if segs:
        last = unquote(segs[-1])
        for ext in (".html", ".htm"):
            if last.lower().endswith(ext):
                last = last[: -len(ext)]
                break
        toks = last.split(".")
        if len(toks) >= 3 and toks[-2].isdigit() and toks[-1].lower() in _NON_ENGLISH_LANG_CODES:
            return True
    # 模式 3：wiki 翻译后缀 _(Lang) / (Lang)
    m = _WIKI_LANG_SUFFIX_RE.search(unquote(parsed.path))
    if m and m.group(1) in _NON_ENGLISH_WIKI_LANGS:
        return True
    return False


def _extract_links(
    soup: BeautifulSoup, current_url: str, base_url: str
) -> list[str]:
    """提取同域文档链接（同域名、去锚点、去资源文件、去语言变体、规范化绝对 URL）"""
    base_netloc = urlparse(base_url).netloc
    links: list[str] = []
    for a in soup.find_all("a", href=True):
        href = str(a["href"]).strip()
        if not href or href.startswith(("#", "mailto:", "javascript:", "tel:")):
            continue
        absolute = urljoin(current_url, href)
        parsed = urlparse(absolute)
        if parsed.scheme not in ("http", "https"):
            continue
        if parsed.netloc != base_netloc:
            continue  # 外域过滤
        if parsed.path.lower().endswith(_RESOURCE_EXTS):
            continue  # 资源文件
        clean = parsed._replace(fragment="").geturl()  # 去锚点
        if clean and not _is_language_variant(clean):
            links.append(clean)
    return links


def _extract_page(
    soup: BeautifulSoup, url: str, tags: list[str]
) -> dict[str, Any] | None:
    """单页解析：页面标题 + 正文（沿用 h1/h2/h3+段落逻辑合并），每页 1 条

    Returns:
        {title, content, tags}；正文为空返回 None（调用方记 warning 跳过）
    """
    # 页面标题：h1 优先，兜底 <title>，再兜底 URL；统一清洗 emoji/实体
    h1 = soup.find("h1")
    if h1 is not None and h1.get_text(strip=True):
        title = h1.get_text(strip=True)
    elif soup.title is not None and soup.title.get_text(strip=True):
        title = soup.title.get_text(strip=True)
    else:
        title = url
    title = clean_content(title) or title

    parts: list[str] = []
    # 策略 1：h1/h2/h3 章节（标题 + 后续段落；标题行并入正文保持结构）
    for header in soup.find_all(["h1", "h2", "h3"]):
        header_title = header.get_text(strip=True)
        if not header_title or len(header_title) < 2:
            continue
        content_parts: list[str] = []
        for sibling in header.find_next_siblings():
            if sibling.name in ("h1", "h2", "h3"):
                break
            text = sibling.get_text(strip=True)
            if text:
                content_parts.append(text)
        section = (
            f"{header_title}\n" + "\n".join(content_parts)
            if content_parts
            else header_title
        )
        parts.append(section)

    # 策略 2：兜底，提取段落
    if not parts:
        for p in soup.find_all("p")[:80]:
            text = p.get_text(strip=True)
            if len(text) > 30:
                parts.append(text)

    # 策略 3：再兜底，从 div/article 提取
    if not parts:
        for div in soup.find_all(["div", "article"])[:20]:
            text = div.get_text(strip=True)
            if len(text) > 50:
                parts.append(text[:_PAGE_MAX_CHARS])

    content = clean_content("\n\n".join(parts))
    if not content:
        return None
    if len(content) > _PAGE_MAX_CHARS:
        content = content[:_PAGE_MAX_CHARS]
    return {"title": title, "content": content, "tags": list(tags)}
