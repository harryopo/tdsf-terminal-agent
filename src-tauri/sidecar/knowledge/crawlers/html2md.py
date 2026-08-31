"""
knowledge/crawlers/html2md.py — HTML 正文 → GFM Markdown 转换（TDSF 2026-08-30 根因修复）
==========================================================================================

背景（用户第 N 轮不满的根因）：旧 _extract_page 手动拼 h1/h2/h3+段落纯文本，
完全丢失 HTML 结构——<table> 变成 | 分隔文字墙、<ul>/<ol> 列表项粘连无换行、
<pre> 代码块无围栏、导航 <div> 混进正文。本模块用成熟库 markdownify 做
结构化转换，替代手写拼接。

选型实测（2026-08-30，同一含 table/ul/ol/pre 的样本页对比）：
- markdownify：表格→标准 GFM（| --- | 分隔行）、列表→- /1.、pre→``` 围栏、
  标题→ATX #。✅ 选用
- html2text：表格列不对齐（缺前导 |）、代码块是 4 空格缩进而非围栏、
  列表缩进 2 空格易被后续清洗误判。❌ 弃用

流程：
1. extract_main_container：优先语义正文容器（main / [role=main] / article /
   #mw-content-text(MediaWiki) / .document(sphinx) / .rst-content(readthedocs)
   / .markdown-body(GitHub 风格)），取文本最长者；不足 200 字回退 <body>
2. strip_noise：剥离 nav/header/footer/aside/script/style/form 等噪音标签 +
   .toc/.sphinxsidebar/#sidebar/.td-sidebar/.navbox/.printfooter/.catlinks/
   .mw-editsection 等侧栏/目录/页脚容器（在 deepcopy 上操作，不污染调用方
   的 soup——crawl_site 还要用同一 soup 提取 BFS 链接）
3. markdownify(heading ATX, bullets -, GFM tables)

输出仍交给 clean.clean_markdown 做行级清洗（emoji/导航残渣行/实体还原）。
"""
from __future__ import annotations

import logging
from copy import deepcopy

from bs4 import BeautifulSoup, Tag  # type: ignore[import-untyped]
from markdownify import MarkdownConverter  # type: ignore[import-untyped]

logger = logging.getLogger("sidecar.knowledge.crawlers.html2md")

# 正文容器候选（按优先级，全部命中候选取文本最长者）
_CONTENT_SELECTORS: tuple[str, ...] = (
    "main",
    "[role=main]",
    "article",
    "#mw-content-text",   # MediaWiki（Arch/Gentoo Wiki）
    "#content",           # manpages.debian.org（div#content）
    ".document",          # sphinx 旧主题
    ".rst-content",       # readthedocs sphinx_rtd_theme
    ".markdown-body",     # GitHub 风格（部分 KB 站）
    "#docs",              # docker 旧文档
)
# 正文容器最少文本量：低于此值视为误命中（如空 <main> 壳），回退 <body>
_MIN_CONTENT_CHARS = 200

# 噪音标签（整树剥离）
_NOISE_TAGS: tuple[str, ...] = (
    "nav", "header", "footer", "aside", "script", "style", "form",
    "noscript", "iframe", "svg", "button", "input", "dialog", "template",
)

# 噪音容器选择器（class/id 模式，覆盖实测混入的导航/侧栏/目录/页脚）
_NOISE_SELECTORS: tuple[str, ...] = (
    # 目录 / TOC
    ".toc", "#toc", "#table-of-contents", ".table-of-contents",
    ".toc-content", ".td-toc",
    # 侧栏
    ".sphinxsidebar", ".sphinxsidebarwrapper", "#sidebar", ".sidebar",
    ".md-sidebar", ".td-sidebar", ".wy-nav-side", ".rst-versions",
    "#p-navigation", ".vector-menu", ".vector-sidenav",
    # 页头 / 页脚 / 站点 chrome
    "#mw-page-base", "#mw-head", "#mw-panel", "#mw-navigation",
    "#footer", ".td-header", ".td-footer", ".td-page-meta",
    ".navbar", "#siteNotice", ".skip-link", ".mw-jump-link",
    # MediaWiki 残渣：[编辑] 链接、分类栏、导航框、"Retrieved from" 行
    ".mw-editsection", ".catlinks", "#catlinks", ".navbox",
    ".printfooter", ".language-links", "#language-links",
    # 面包屑 / 翻页 / 编辑链接
    ".breadcrumb", "#breadcrumbs", ".breadcrumbs", ".pagination",
    ".edit-link", ".edit-page-link", ".gh-contributors",
    # manpages.debian.org 侧栏（#content 内的 links/toc/otherversions/
    # otherlangs 面板，正文在兄弟 div.maincontent——不剥则混进正文头部）
    "#panels",
    # docs.docker.com 侧栏（<main> 内 Tailwind 语义 class 的 TOC 导航，
    # 含 Manuals/Get started/Guides 链接列表，正文在兄弟 div.bg-white）
    ".bg-background-toc",
)


def extract_main_container(soup: BeautifulSoup) -> Tag:
    """选取正文容器：语义候选取文本最长者，不足量回退 <body>（再回退整树）"""
    best: Tag | None = None
    best_len = 0
    for sel in _CONTENT_SELECTORS:
        try:
            nodes = soup.select(sel)
        except Exception as e:  # 非法选择器防御（bs4 版本差异）
            logger.warning(f"bad content selector {sel!r}, skip: {e}")
            continue
        for node in nodes:
            if not isinstance(node, Tag):
                continue
            tlen = len(node.get_text(strip=True))
            if tlen > best_len:
                best, best_len = node, tlen
    if best is not None and best_len >= _MIN_CONTENT_CHARS:
        return best
    body = soup.find("body")
    return body if body is not None else soup


def strip_noise(node: Tag) -> Tag:
    """在 node 的深拷贝上剥离噪音标签/容器，返回干净副本

    深拷贝原因：调用方（crawl_site）还要用原 soup 提取 BFS 链接，
    直接 decompose 会砍掉导航区里的合法文档链接（BFS 前沿）。
    """
    clean = deepcopy(node)
    for tag_name in _NOISE_TAGS:
        for n in clean.find_all(tag_name):
            n.decompose()
    for sel in _NOISE_SELECTORS:
        try:
            hits = clean.select(sel)
        except Exception as e:
            logger.warning(f"bad noise selector {sel!r}, skip: {e}")
            continue
        for n in hits:
            n.decompose()
    return clean


def html_to_markdown(soup: BeautifulSoup) -> str:
    """整页 soup → 正文 GFM Markdown（语义容器提取 + 噪音剥离 + markdownify）

    转换失败不抛出：返回 ""，调用方按解析空页处理（记 warning 跳过）。
    """
    try:
        container = extract_main_container(soup)
        clean = strip_noise(container)
        # convert_soup 直接吃已解析的 Tag（顶层 markdownify() 会对参数再
        # BeautifulSoup() 解析，传 Tag 会报错）；strip=["img"]：图片转
        # ![alt](src) 对纯文本知识库是噪音，剥离
        md = MarkdownConverter(
            heading_style="ATX", bullets="-", strip=["img"]
        ).convert_soup(clean)
    except Exception as e:
        logger.warning(f"html_to_markdown failed, fallback empty: {e}")
        return ""
    return md if isinstance(md, str) else ""


__all__ = [
    "extract_main_container",
    "strip_noise",
    "html_to_markdown",
]
