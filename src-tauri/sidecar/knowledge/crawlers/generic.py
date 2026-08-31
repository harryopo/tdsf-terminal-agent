"""
knowledge/crawlers/generic.py — 通用文档爬虫模板（T-P3-03，深度抓取增强）
=========================================================================

为 13 个文档源（apache/mysql/redis/docker/kubernetes/systemd/selinux/
iptables/ssh/bash/python/rust/git）提供通用实现。

受控多页抓取（BFS）：
- GenericCrawler(source, base_url, tags, max_pages=30, max_depth=2, delay=1.0)
- 从 base_url 出发广度优先抓取同域页面：<a href> 过滤（同域名、去锚点、
  去资源文件后缀、去查询串 URL、去语言变体、去 Wiki 命名空间/meta 页、
  visited 去重）
- 每页产出 1 条 KnowledgeEntry（title=页面标题，content=整页正文合并，
  截断 ~12000 字；TDSF 2026-08-30 用户钦定「一条知识库弄多一些」：
  整页合并一条而非碎片）
- 页间 sleep(delay) 限速（离线缓存模式不 sleep）；单页失败（超时 10s/
  非 200/解析空）记 warning 跳过继续；整体 try/except 不向上抛出
- 单页缓存能力沿用 BaseCrawler._fetch_single（联网成功写缓存、失败读
  缓存、offline 仅读缓存）

正文提取（TDSF 2026-08-30 根因修复，替代旧「手动拼 h1/h2/h3+段落纯文本」）：
- 旧实现丢失全部 HTML 结构：<table> 变成 | 分隔文字墙、<ul>/<ol> 列表项
  粘连无换行、<pre> 代码块无围栏、导航 <div> 混进正文 → 用户第 N 轮不满
- 新实现：html2md.html_to_markdown（语义正文容器 + 噪音剥离 + markdownify
  → 标准 GFM markdown）→ clean.clean_markdown 行级清洗（保留结构）
- 页面治理（_filter_reason 统一判定，BFS 与 to_entries 双路共用，各自计数）：
  ① 垃圾标题（Search/Community/News/About/Index of ...）整条丢弃
  ② 导航索引页（正文纯链接行占比 >60%，如 Apache 2.0 首页链接墙）丢弃
  ③ 质量门槛：正文 < 500 字（纯导航/meta 残页）丢弃
  ④ 繁体内容（zh_TW 手册页，用户钦定）丢弃
  ⑤ 同 source 内标题完全重复 → 保留最长 content 一条（"要点"×5 问题）

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
from knowledge.crawlers.clean import (
    _slug_to_title,
    clean_content,
    clean_markdown,
    clean_title,
    is_index_page_title,
    is_junk_title,
    is_link_farm,
    is_section_heading,
    looks_traditional,
    title_from_html_title,
)
from knowledge.crawlers.html2md import extract_main_container, html_to_markdown
from knowledge.fts5 import KnowledgeEntry

logger = logging.getLogger("sidecar.knowledge.crawlers.generic")

_PAGE_MAX_CHARS = 12000  # 单页正文截断上限（整页合并一条，TDSF 2026-08-30）
_PAGE_MIN_CHARS = 500  # 质量门槛：低于此长度的页面视为导航/meta 残页丢弃

# 视为资源文件的 URL 后缀（不作为文档页抓取）
_RESOURCE_EXTS = (
    ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico",
    ".css", ".js", ".json", ".xml", ".rss",
    ".pdf", ".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar",
    ".rpm", ".deb", ".exe", ".dmg", ".iso",
    ".epub", ".mobi", ".azw3", ".jar", ".war", ".bin", ".tar",
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
        """转换为 KnowledgeEntry（title/content 入库前清洗 + 页面治理）

        TDSF 2026-08-30 根因修复：治理判定统一走 _filter_reason（垃圾标题/
        链接墙/短页/繁体），标题统一走 clean_title（去 .html/.cgi 后缀、
        空标题 slug 化）；同标题去重保留最长正文。
        items 带 _md 标记（_extract_page 产出的 markdown）时跳过二次
        content 清洗（clean_markdown 已在 _extract_page 内完成）。
        """
        entries: list[KnowledgeEntry] = []
        counters: dict[str, int] = {
            "junk-title": 0, "index-page": 0, "link-farm": 0,
            "short": 0, "traditional": 0,
        }
        # category_for 延迟导入（sources → crawlers.clean 经包 __init__
        # 会触发 registry → generic 模块级循环，此处函数内导入规避）
        from knowledge.sources import category_for

        for i, item in enumerate(items):
            if item.get("_md"):
                content = str(item.get("content", ""))
            else:
                content = clean_content(item.get("content", ""))
            raw_title = str(item.get("title", ""))
            url = str(item.get("url", self.base_url))
            title = clean_title(clean_content(raw_title) or raw_title, url)
            tags = list(item.get("tags", self.default_tags))
            reason = _filter_reason({"title": title, "content": content})
            if reason is not None:
                counters[reason] += 1
                logger.info(f"[{self.source}] to_entries discard ({reason}): {title!r}")
                continue
            entry_id = self.build_entry_id({"title": title, "url": url}, i)
            entries.append(KnowledgeEntry(
                id=entry_id,
                source=self.source,
                title=title,
                content=content,
                url=url,
                tags=tags,
                category=category_for(self.source, title),
            ))
        discarded_total = sum(counters.values())
        if discarded_total:
            logger.info(
                f"[{self.source}] to_entries discarded: "
                f"{counters['junk-title']} junk-title, "
                f"{counters['index-page']} index-page, "
                f"{counters['link-farm']} link-farm, "
                f"{counters['short']} short(<{_PAGE_MIN_CHARS} chars), "
                f"{counters['traditional']} traditional"
            )
        return _dedupe_entries(entries, self.source)


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

    - 每页产出 1 条 KnowledgeEntry（title=页面标题，content=整页正文
      GFM markdown，截断 12000 字）
    - 页面治理（_filter_reason 统一判定，各类分别计数）：垃圾标题 /
      导航索引页（链接墙）/ 正文 < 500 字残页 / 繁体内容 → 丢弃
    - Wiki 命名空间标题丢弃（重定向导致 URL 干净但标题为 Help:X 等）
    - 同标题去重：保留最长 content 一条（"要点"×5 问题）
    - 链接过滤：同域名、去锚点、去资源后缀、去查询串、去语言变体、
      去 Wiki 命名空间/meta 页、visited/queued 去重
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
    counters: dict[str, int] = {
        "junk-title": 0, "index-page": 0, "link-farm": 0,
        "short": 0, "traditional": 0,
    }
    discarded_meta = 0
    is_wiki_host = urlparse(crawler.base_url).netloc.lower() in _WIKI_HOSTS

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
            keep = True
            if is_wiki_host and _is_wiki_namespace_title(page["title"]):
                # 重定向场景：URL 干净但标题为命名空间页（如 Restart→Help:Reading）
                discarded_meta += 1
                keep = False
                logger.info(
                    f"[{crawler.source}] wiki namespace title, discard: "
                    f"{page['title']!r} ({url})"
                )
            else:
                reason = _filter_reason(page)
                if reason is not None:
                    counters[reason] += 1
                    keep = False
                    logger.info(
                        f"[{crawler.source}] page discarded ({reason}): "
                        f"{page['title']!r} ({url})"
                    )
            if keep:
                # category_for 延迟导入（sources → crawlers.clean 经包 __init__
                # 会触发 registry → generic 模块级循环，此处函数内导入规避）
                from knowledge.sources import category_for

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
                        category=category_for(crawler.source, page["title"]),
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

    entries = _dedupe_entries(entries, crawler.source)

    discarded_total = sum(counters.values()) + discarded_meta
    if discarded_total:
        logger.info(
            f"[{crawler.source}] crawl_site discarded: "
            f"{counters['junk-title']} junk-title, "
            f"{counters['index-page']} index-page, "
            f"{counters['link-farm']} link-farm, "
            f"{counters['short']} short(<{_PAGE_MIN_CHARS} chars), "
            f"{counters['traditional']} traditional, "
            f"{discarded_meta} wiki-namespace"
        )

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
# 语言变体 URL 过滤 + Wiki 命名空间页过滤（TDSF 2026-08-30）
# ============================================================================
# 多语言文档站按 URL 路径协商语言（Accept-Language 头对这类站无效）：
#   kubernetes.io/es/docs/、man.archlinux.org/man/intro.1.fr、
#   manpages.debian.org/.../bash.1.es.html、wiki.archlinux.org/title/X_(Español)
# BFS 若跟进这些链接会把整页西语/法语灌进知识库（实测「Documentación」
# 「NOMBRE」文字墙）。在链接发现处剔除，从源头防污染。
#
# TDSF 2026-08-30 二次漏网补漏（bash.1.zh_TW.html 繁体入库根因实测）：
# debian manpages 的语言码在**文件名后缀**而非路径首段，且存在区域变体
# （bash.1.zh_TW.html / bash.1.zh_CN.html——zh_TW/zh_CN 带下划线，不在纯
# 语言码表内）；man 页 section 还可能带子段（readline.3readline.fr.html，
# 倒数第二段非纯数字）。补漏后统一按「文件名最后一个点段」判定语言。

# 非英文语言码（ISO 639-1/2 常用集）——en 不在内（英文/默认语言页保留）
_NON_ENGLISH_LANG_CODES: frozenset[str] = frozenset({
    "ar", "be", "bg", "bn", "bs", "ca", "cs", "cy", "da", "de", "el", "eo",
    "es", "et", "eu", "fa", "fi", "fr", "ga", "gl", "gu", "he", "hi", "hr",
    "hu", "hy", "id", "is", "it", "ja", "ka", "kk", "kn", "ko", "ky", "lt",
    "lv", "mk", "ml", "mr", "ms", "nb", "nl", "nn", "no", "oc", "pl", "pt",
    "ro", "ru", "sk", "sl", "sq", "sr", "sv", "sw", "ta", "te", "th", "tl",
    "tr", "tt", "uk", "ur", "uz", "vi", "wa", "zh",
})

# Arch Wiki 翻译页后缀（非英文语言显示名）——title 形如 Systemd_(Español)
_NON_ENGLISH_WIKI_LANGS: frozenset[str] = frozenset({
    "Deutsch", "Español", "Français", "Italiano", "Português", "Polski",
    "Русский", "日本語", "한국어", "中文", "Bahasa Indonesia", "Nederlands",
    "Suomi", "Svenska", "Català", "Українська", "فارسی", "Türkçe", "עברית",
    "ไทย", "Tiếng Việt", "Magyar", "Ελληνικά", "Dansk", "Norsk", "Română",
})

# wiki 翻译后缀：末段 _(<语言名>) 或 /(<语言名>)
_WIKI_LANG_SUFFIX_RE = re.compile(r"[_/]?\(([^)]+)\)\s*$")

# MediaWiki 类站点（Arch/Gentoo Wiki）——命名空间页/meta 页过滤
_WIKI_HOSTS: frozenset[str] = frozenset({"wiki.archlinux.org", "wiki.gentoo.org"})
# 无冒号但也非教学内容的 wiki 页（门户/社区贡献页，title 归一后匹配）
_WIKI_TITLE_BLOCKLIST: frozenset[str] = frozenset({
    "main_page", "getting_involved", "table_of_contents",
})


def _is_language_variant(url: str) -> bool:
    """判断 URL 是否为非英文语言变体页（BFS 不跟进）

    覆盖三种模式：
    1. 路径首段为语言码（kubernetes.io/es/docs/...；readthedocs /en/ 保留）
    2. man 页 locale 文件名后缀：语言码 = 文件名最后一个点段——
       bash.1.zh_TW.html / intro.1.fr / readline.3readline.fr.html；
       区域变体（zh_TW/zh_CN/pt_BR）取下划线前基础码判定
    3. Arch Wiki 翻译后缀（Systemd_(Español)；消歧义后缀如 Firefox_(core) 保留）
    """
    parsed = urlparse(url)
    segs = [s for s in parsed.path.split("/") if s]
    # 模式 1：首段语言码（en / 非语言码 / 数字段 均保留）
    if segs:
        first = segs[0].lower().split("-")[0]
        if first in _NON_ENGLISH_LANG_CODES:
            return True
    # 模式 2：man locale 后缀（name.<section>.<lang>[.<ext>]，
    # 语言码 = 文件名最后一个点段；区域变体取基础码）
    if segs:
        last = unquote(segs[-1])
        for ext in (".html", ".htm"):
            if last.lower().endswith(ext):
                last = last[: -len(ext)]
                break
        toks = last.split(".")
        if len(toks) >= 2:
            tail = toks[-1].lower().replace("-", "_")
            base = tail.split("_", 1)[0]
            if tail != "en" and base in _NON_ENGLISH_LANG_CODES:
                return True
    # 模式 3：wiki 翻译后缀 _(Lang) / (Lang)
    m = _WIKI_LANG_SUFFIX_RE.search(unquote(parsed.path))
    if m and m.group(1) in _NON_ENGLISH_WIKI_LANGS:
        return True
    return False


def _wiki_article_name(url: str) -> str | None:
    """MediaWiki 类站点 URL 的文章名（/title/<Name> 或 /wiki/<Name>）

    非文章路径（站点首页 /、/index.php 等）返回 None。
    """
    parsed = urlparse(url)
    segs = [s for s in parsed.path.split("/") if s]
    if len(segs) >= 2 and segs[0] in ("title", "wiki"):
        return unquote(segs[1])
    return None


def _is_wiki_meta_page(url: str) -> bool:
    """判断是否 MediaWiki 命名空间页/meta 页（BFS 不跟进）

    覆盖（实测混入库的垃圾页模式）：
    - 命名空间页（文章名含 ':' 一律排除，Namespace:Title 结构）：
      Special:Search / Talk:Systemd / Category:Init / ArchWiki:News /
      ArchWiki:Statistics / Help:Reading / ArchWiki talk:Requests
    - 门户/社区页（无冒号）：Main_page、Getting_involved
    - 非文章路径：站点根 /（Main page）、/index.php 等
    """
    if urlparse(url).netloc.lower() not in _WIKI_HOSTS:
        return False
    name = _wiki_article_name(url)
    if name is None:
        return True
    if ":" in name:
        return True
    norm = name.strip().lower().replace(" ", "_").replace("-", "_")
    return norm in _WIKI_TITLE_BLOCKLIST


def _is_wiki_namespace_title(title: str) -> bool:
    """页面标题是否为 MediaWiki 命名空间页（重定向场景 title 与 URL 不一致：
    实测 /title/Restart 页 h1 显示「Help:Reading」——URL 无冒号但标题有）"""
    return ":" in title


def _is_chinese_variant(url: str) -> bool:
    """语言变体 URL 是否为中文系（zh / zh_TW / zh_CN / zh-Hant）

    C1 取舍：zh 系变体**放行**跟进——zh_TW 手册页有价值，入库前由
    clean 层繁转简（tags 加「源自繁体」）；zh_CN 本身就是简体直接保留。
    其余非英文语言变体（fr/de/es/ja/...）在链接发现处剔除。
    仅覆盖路径/文件名语言码两种形态；Wiki 显示名后缀（X_(中文)）不在此列
    （Arch/Gentoo Wiki 中文翻译页多为残缺 stub，维持整站非英文过滤）。
    """
    parsed = urlparse(url)
    segs = [s for s in parsed.path.split("/") if s]
    if not segs:
        return False
    # 形态 1：路径首段语言码（/zh-cn/docs/、/zh_TW/）
    first = segs[0].lower().replace("-", "_")
    if first.split("_", 1)[0] == "zh":
        return True
    # 形态 2：man 页文件名尾段（bash.1.zh_TW.html / intro.1.zh_CN）
    last = unquote(segs[-1])
    for ext in (".html", ".htm"):
        if last.lower().endswith(ext):
            last = last[: -len(ext)]
            break
    toks = last.split(".")
    if len(toks) >= 2:
        tail = toks[-1].lower().replace("-", "_")
        if tail.split("_", 1)[0] == "zh":
            return True
    return False


def _extract_links(
    soup: BeautifulSoup, current_url: str, base_url: str
) -> list[str]:
    """提取同域文档链接（同域名、去锚点、去资源文件、去查询串、
    去语言变体、去 Wiki 命名空间/meta 页、规范化绝对 URL）"""
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
        if parsed.query:
            # 查询串 URL 一律不跟进（jump?q= 重定向、?search= 搜索等，
            # 官方文档正文页均为静态路径）
            continue
        clean = parsed._replace(fragment="").geturl()  # 去锚点
        if _is_language_variant(clean) and not _is_chinese_variant(clean):
            # 非英文语言变体剔除；zh 系放行（C1 繁转简保留，见 _is_chinese_variant）
            continue
        if _is_wiki_meta_page(clean):
            continue  # Wiki 命名空间/门户页
        if clean:
            links.append(clean)
    return links


def _extract_page(
    soup: BeautifulSoup, url: str, tags: list[str]
) -> dict[str, Any]:
    """单页解析：标题 + 整页正文（GFM Markdown），每页 1 条

    TDSF 2026-08-30 根因修复（替代旧「手动拼 h1/h2/h3+段落纯文本」）：
    - 正文 = html2md.html_to_markdown（语义容器 + 噪音剥离 + markdownify
      → GFM：表格→| --- |、列表→- /1.、代码→``` 围栏、标题→#）
      再过 clean_markdown 行级清洗（emoji/导航残渣/实体，保留结构）
    - 标题 = **正文容器内**首个非 man 章节名 h1（排除页头 chrome h1，
      如 man.openbsd.org 的「OpenBSDmanual page server」；跳过 NAME/
      SYNOPSIS 等 man 章节名，否则全站同标题被去重误杀）→ 兜底 <title>
      去站点后缀（"ssh-askpass(1) - OpenBSD manual pages" → ssh-askpass(1)）
      → 兜底 URL slug；统一 clean_content + clean_title 清洗
    - 二进制内容防护（控制字符占比 >5% → 正文置空，_filter_reason 丢弃）

    **不再在此处做质量门槛/繁体/垃圾标题/链接墙判定**——统一交给
    _filter_reason（BFS 与 to_entries 双路共用，各自计数）。

    Returns:
        {title, content, tags, url, _md: True}（content 可为空串，
        由 _filter_reason 决定去留；_md 标记 markdown 来源，to_entries
        据此跳过二次清洗）
    """
    # 正文容器（限定 h1 搜索范围，排除页头/页脚 chrome 标题）
    container = extract_main_container(soup)

    # 页面标题：容器内首个非 man 章节名 h1 → <title> 去站点后缀 → URL
    title = ""
    for h1 in container.find_all("h1"):
        t = h1.get_text(strip=True)
        if t and not is_section_heading(t):
            title = t
            break
    if not title:
        html_title = title_from_html_title(
            soup.title.get_text(strip=True) if soup.title else ""
        )
        slug = _slug_to_title(url)
        # <title> 首段是品牌级短词（git-scm.com 命令页 "Git - git-branch
        # Documentation" 首段 "Git"，全站相同）时改用 URL slug（页面级唯一），
        # 否则全站同标题被去重误杀（实测 git-docs 42→9）。man 站 <title>
        # 首段是文档名（"ssh(1)"，≥4 字符且每页不同）→ 保留 <title>。
        if slug and (len(html_title) < 4 or not html_title):
            title = slug
        elif html_title:
            title = html_title
        else:
            title = slug
    if not title:
        title = url
    title = clean_content(title) or title
    title = clean_title(title, url)

    # 正文：markdownify → GFM markdown → clean_markdown 行级清洗
    content = clean_markdown(html_to_markdown(soup))
    # 二进制内容防护：requests 对 .epub/.zip 等二进制响应解码出乱码文本，
    # 控制字符（C0，除 \n\r\t）占比过高判为非 HTML 文档，整页丢弃
    if content:
        ctrl = sum(1 for ch in content if ord(ch) < 32 and ch not in "\n\r\t")
        if ctrl and ctrl / len(content) > 0.05:
            logger.info(
                f"binary-looking content ({ctrl}/{len(content)} ctrl chars), skip: {url}"
            )
            content = ""
    if len(content) > _PAGE_MAX_CHARS:
        content = content[:_PAGE_MAX_CHARS]
    return {"title": title, "content": content, "tags": list(tags), "url": url, "_md": True}


# ============================================================================
# 页面治理统一过滤（TDSF 2026-08-30 根因修复：垃圾页/垃圾标题/链接墙/繁体）
# ============================================================================


def _filter_reason(page: dict[str, Any]) -> str | None:
    """页面治理统一判定：返回丢弃原因（junk-title/index-page/link-farm/
    short/traditional）或 None（通过）。BFS（crawl_site）与 to_entries
    双路共用，各自计数。

    调用前提：page 含 title/content 键（_extract_page 或 parse 产出均可）。
    """
    title = str(page.get("title", ""))
    content = str(page.get("content", ""))
    if is_junk_title(title):
        return "junk-title"
    if is_index_page_title(title):
        return "index-page"
    if is_link_farm(content):
        return "link-farm"
    if len(content) < _PAGE_MIN_CHARS:
        return "short"
    # 繁体检测（TDSF 2026-08-30 用户钦定）：zh_TW 手册页直接丢弃，
    # 不再繁转简（zh_CN 同源重复、翻译管线只处理英文正文）
    if looks_traditional(content) or looks_traditional(title):
        return "traditional"
    return None


def _dedupe_entries(
    entries: list[KnowledgeEntry], source: str
) -> list[KnowledgeEntry]:
    """同标题去重：保留最长 content 一条（"要点"×5 问题，TDSF 2026-08-30）

    保持首次出现顺序（被保留条目放回其标题首次出现的位置）。
    """
    by_title: dict[str, KnowledgeEntry] = {}
    order: list[str] = []
    for e in entries:
        if e.title not in by_title:
            by_title[e.title] = e
            order.append(e.title)
        elif len(e.content) > len(by_title[e.title].content):
            by_title[e.title] = e
    removed = len(entries) - len(order)
    if removed:
        logger.info(f"[{source}] dedupe removed {removed} duplicate title(s)")
    return [by_title[t] for t in order]
