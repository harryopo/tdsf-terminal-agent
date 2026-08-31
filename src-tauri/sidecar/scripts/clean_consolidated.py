#!/usr/bin/env python
"""
scripts/clean_consolidated.py — 合并知识库全量清洗（TDSF 2026-08-31）
========================================================================

用户钦定：「把不用的垃圾描述删去、垃圾引用、无关紧要内容删掉，方便
后续中文翻译」。直接改写 knowledge-preview/ 合并 md（27 个文件，7 分类），
章节级 + 内容级清洗，幂等可重跑。

〇、整源文件排除（2026-08-31 二期，用户拍板删 Python+Rust 源）：
    frontmatter source ∈ _EXCLUDED_SOURCES（python-docs/rust-docs，纯语言
    API 文档，与 Linux 教学定位无关，52 万字）→ --apply 时直接删除该文件，
    --scan 时报告。

一、章节级删除（整章 `## 序号. xxx` 到下一个 `##` 前）：
    1. 语言变体整章（Gentoo Wiki 翻译页漏网，之前只过滤了 _(Español)）：
       FAQ（德语）/FAQ（韩语）/FAQ（俄语）... 及外文后缀
       Deutsch/Français/日本語/Русский/한국어/...（中文翻译页保守保留）
    2. Apache 旧站 Keywords 开发向/站务页（标题以「要点 ·」开头）：
       Apache Developers' C Language Style Guide / Development Notes /
       Apache HTTP Server vulnerabilities(1.3/2.0/2.2/2.4) / Release
       Guidelines / httpd Modules / Flood / Reporting Security /
       Verifying Apache HTTP Server Releases
    3. Apache 版本索引页（标题形如「Apache 2.0 文档」「Apache 2.2 文档」）
    4. Git 官网纯导航章节（精确标题：外部链接 / Git 托管 / GUI 客户端 /
       学习——全是链接列表，零命令知识，2026-08-31 二期实测确认）
    5. 同页多变体重复章节：章节来源 URL 归一（去 .txt/.raw/.en 后缀）后
       与已保留章节撞车 → 删后者（如 intro.2 / intro.2.txt / intro.2.raw
       三变体只留首见者）

二、内容级清洗（每个保留章节内，代码围栏保护）：
    1. 单独成行的 See also / SEE ALSO / **See also**（man/导航残渣）
    2. Copyright © 20xx / Copyright 20xx / All rights reserved 单独行
    3. 返回顶部 / Back to top / Table of Contents 单独行
    4. 纯链接行（行内容全是 [text](url) 且链接数 >3，如语言切换链接墙）
    5. 模板导航行：This page is part of the ... documentation /
       Please send any comments to ...
    6. ArchWiki 页头导航残渣（2026-08-31 二期，一期只处理了 Gentoo 漏了
       Arch，实测 165 行）：From ArchWiki / (Redirected from ...) /
       Retrieved from ... 单独行；「Related articles」行及其后连续的
       相对 wiki 链接列表项（/title/... /index.php...，遇其他内容即止）
    7. 行尾空白 + 连续空行压 1（围栏保护）

三、清洗后：
    1. 章节序号重排 1..N
    2. 目录按保留章节重新生成
    3. frontmatter 的 summary_zh / sources_count / 头部说明「合并自 N 页」
       按保留内容重新统计（防止元数据失真）
    4. 清洗后为空章节直接删除

用法（在 src-tauri/sidecar 下）：
    .venv/Scripts/python.exe scripts/clean_consolidated.py --scan        # 只扫描出清单（不改文件）
    .venv/Scripts/python.exe scripts/clean_consolidated.py --dry-run     # 预览统计（不改文件）
    .venv/Scripts/python.exe scripts/clean_consolidated.py --apply       # 默认：直接改写合并文件
"""
from __future__ import annotations

import argparse
import logging
import re
import sys
from pathlib import Path

logger = logging.getLogger("sidecar.scripts.clean_consolidated")

PROJECT_ROOT = Path(__file__).resolve().parents[3]
PREVIEW_DIR = PROJECT_ROOT / "knowledge-preview"

# 分类中文目录名（与 consolidate_knowledge.CATEGORY_DIR_NAMES 对齐，用于扫描分组）
CATEGORY_DIR_NAMES: list[str] = [
    "Linux哲学与命令对照",
    "基础概念",
    "命令与工具",
    "系统管理",
    "网络与远程",
    "安全加固",
    "服务部署",
]

# 整源排除（2026-08-31 二期，用户拍板）：纯语言 API 文档与 Linux 教学
# 定位无关（python 12.7 万字 34% 是版本索引导航页 / rust 39.2 万字）。
# frontmatter source 命中 → --apply 直接删文件、--scan 报告。
_EXCLUDED_SOURCES: frozenset[str] = frozenset({"python-docs", "rust-docs"})

# ============================================================================
# 章节级删除规则
# ============================================================================

# 非中文语言名（中文语名 + 外文语名；与 crawlers/generic.py
# _NON_ENGLISH_WIKI_LANGS 对齐 + 中文口语语名补全）。标题含其中任一 → 整章删。
# 中文翻译页（「中文」/简体中文/繁體中文）保守保留（不列入）。
_LANG_NAMES: tuple[str, ...] = (
    # 中文口语语名
    "德语", "法语", "日文", "日语", "韩语", "荷兰语", "匈牙利语", "意大利语",
    "波兰语", "西班牙语", "巴西葡语", "葡萄牙语", "土耳其语", "希腊语", "俄语",
    "乌克兰语", "泰语", "越南语", "印尼语", "芬兰语", "瑞典语", "丹麦语", "挪威语",
    "加泰罗尼亚语", "波斯语", "希伯来语", "罗马尼亚语", "捷克语", "斯洛伐克语",
    "斯洛文尼亚语", "克罗地亚语", "塞尔维亚语", "保加利亚语", "立陶宛语",
    "拉脱维亚语", "爱沙尼亚语", "阿拉伯语", "印地语", "孟加拉语", "马来语",
    "荷兰文", "意大利文", "西班牙文", "葡萄牙文", "俄文", "德文", "法文", "韩文",
    # wiki 翻译后缀外文显示名（_NON_ENGLISH_WIKI_LANGS 全集）
    "Deutsch", "Français", "日本語", "Español", "Italiano", "Português",
    "Polski", "Русский", "한국어", "Bahasa Indonesia", "Nederlands", "Suomi",
    "Svenska", "Català", "Українська", "فارسی", "Türkçe", "עברית", "ไทย",
    "Tiếng Việt", "Magyar", "Ελληνικά", "Dansk", "Norsk", "Română", "Čeština",
    "Slovenčina", "Slovenščina", "Hrvatski", "Srpski", "Български", "Lietuvių",
    "Latviešu", "Eesti", "العربية", "हिन्दी", "বাংলা", "Melayu", "עברית",
)

# Apache 旧站 Keywords 开发向/站务页（标题前缀「要点 ·」实锤垃圾，TDSF 2026-08-31
# 分析：均来自 httpd.apache.org 旧版站 Keywords 页：开发指南/版本漏洞通告/
# 发布流程/站务导航，教学无用）。含 75 章「要点 · Verifying Apache HTTP
# Server Releases」（同类 Keywords 页，不在用户列举模式内但性质一致）。
_APACHE_KEYWORDS_PREFIXES: tuple[str, ...] = (
    "要点 · Apache Developers'",
    "要点 · Apache Development",
    "要点 · Apache HTTP Server",
    "要点 · Apache httpd Modules",
    "要点 · Reporting Security",
    "要点 · Flood",
    "要点 · Verifying Apache",
)

# Apache 版本索引页（纯版本入口，无教学内容）
_APACHE_INDEX_RE = re.compile(r"^Apache 2\.\d 文档$")

# Git 官网纯导航章节（2026-08-31 二期实测：外部链接=教程/书籍/视频链接墙，
# Git 托管=链接文本全是 XML 解析残渣的托管站列表，GUI 客户端/学习=资源列表；
# 零命令知识，对检索纯噪音）。精确匹配防误伤（如 K8s「学习环境」是正文）。
_GIT_NAV_TITLES: frozenset[str] = frozenset(
    {"外部链接", "Git 托管", "GUI 客户端", "学习"}
)


def is_junk_chapter_title(title: str) -> bool:
    """章节标题是否垃圾（语言变体 / Apache Keywords 页 / Apache 版本索引页 /
    Git 纯导航章节）

    保守原则：只删明确实锤模式，不确定的标题保留。
    """
    t = (title or "").strip()
    if not t:
        return False
    if t in _GIT_NAV_TITLES:
        return True
    if _APACHE_INDEX_RE.match(t):
        return True
    if any(lang in t for lang in _LANG_NAMES):
        return True
    if t.startswith("要点 ·"):
        return any(t.startswith(p) for p in _APACHE_KEYWORDS_PREFIXES)
    return False


# 章节来源注释格式：`<!-- 来源: <source> | <url> -->`
_SOURCE_COMMENT_RE = re.compile(r"^<!--\s*来源:\s*([^|]*?)\s*\|\s*(.*?)\s*-->$")
# 同一页面的格式变体后缀（爬虫重复抓取实锤：intro.2 / intro.2.txt /
# intro.2.raw 三章内容同源；.raw 是未渲染 troff 源码）。归一后撞车即重复。
_URL_VARIANT_SUFFIX_RE = re.compile(r"\.(txt|raw|en)$")


def section_source_url(section_lines: list[str]) -> str:
    """章节来源 URL（首条 `<!-- 来源 -->` 注释），无则空串"""
    for ln in section_lines:
        m = _SOURCE_COMMENT_RE.match(ln.strip())
        if m:
            return m.group(2)
        if ln.strip() and not ln.startswith(("##", "<!--", "---")):
            break  # 已进正文仍无来源注释，不再找
    return ""


def normalize_source_url(url: str) -> str:
    """URL 归一：去格式变体后缀 + 去尾斜杠（仅路径比较，保守不动 query）"""
    base, sep, query = url.partition("?")
    base = _URL_VARIANT_SUFFIX_RE.sub("", base).rstrip("/")
    return base + (sep + query if query else "")


# ============================================================================
# 内容级清洗规则（代码围栏保护）
# ============================================================================

# 单独成行的 See also 导航残渣（纯文本 + **加粗** 两种形态）
_SEE_ALSO_RE = re.compile(
    r"^\s*\*{0,2}(See also|SEE ALSO|See Also)\*{0,2}\s*$"
)
# Copyright © 20xx / Copyright 20xx / (c) 20xx 单独行
_COPYRIGHT_RE = re.compile(
    r"^\s*Copyright\s*(?:\([cC]\)|©)?\s*\d{4}(?:[-–]\d{4})?\s*.*$"
)
_ALL_RIGHTS_RE = re.compile(r"^\s*All rights reserved\.?\s*$", re.IGNORECASE)
# 返回顶部 / Back to top / Table of Contents 单独行
_NAV_LINE_RE = re.compile(
    r"^\s*(返回顶部|Back to top|Table of Contents|Contents|Jump to content)\s*$",
    re.IGNORECASE,
)
# 模板导航行（Gentoo/Arch Wiki 模板残渣）
_TEMPLATE_LINE_RES = (
    re.compile(r"^\s*This page is part of the .* documentation\.?\s*$", re.IGNORECASE),
    re.compile(r"^\s*Please send any comments to .*$", re.IGNORECASE),
    re.compile(r"^\s*Please report errors or omissions to .*$", re.IGNORECASE),
)

# 纯链接行：整行由 markdown 链接 [t](u) 构成（允许列表项前缀 - / 1.），
# 且链接数 >3（<3 个链接的引用行保留，防误伤正常文档引用）
_LINK_FARM_LINE_RE = re.compile(r"^\s*(?:[-*]|\d+\.)?\s*(?:\[[^\]]*\]\([^)]*\)\s*)+$")

# Git 文档站命令索引导航列表项（`- [cat-file](/docs/git-cat-file)`）：
# 单行 1 个链接不算（防误伤），连续 ≥_GIT_NAV_MIN_RUN 行才整段丢
_GIT_NAV_ITEM_RE = re.compile(
    r"^\s*[-*]\s*\[[^\]]+\]\(/docs/[^)]*\)\s*$"
)
_GIT_NAV_MIN_RUN = 3

# Gentoo Wiki 页头模板导航残渣（TDSF 2026-08-31 实测：全库 6+ 处，
# 语言切换链接墙对中文翻译无价值）
_FROM_GENTOO_RE = re.compile(r"^\s*From Gentoo Wiki\s*$")
_OTHER_LANGS_RE = re.compile(r"^\s*Other languages:\s*$")
# Apache 文档站页头语言切换行（Available Languages: [de]... | [en]...）
_AVAILABLE_LANGS_RE = re.compile(r"^\s*Available Languages:\s*")
_LANG_SWITCH_NAMES: tuple[str, ...] = (
    "Deutsch", "English", "español", "français", "italiano", "magyar",
    "polski", "русский", "українська", "中文（中国大陆）", "中文", "日本語",
    "Português", "Türkçe", "한국어", "Nederlands", "suomi", "svenska",
    "català", "Ελληνικά", "dansk", "norsk", "română", "čeština",
    "slovenčina", "hrvatski", "עברית", "ไทย", "Tiếng Việt",
    "Bahasa Indonesia", "فارسی",
)
_LANG_SWITCH_LINE_RE = re.compile(
    r"^\s*[-*]\s+"
    r"(?:\[(?:" + "|".join(map(re.escape, _LANG_SWITCH_NAMES)) + r")[^\]]{0,3}\]\(.*"
    r"|(?:" + "|".join(map(re.escape, _LANG_SWITCH_NAMES)) + r"))\s*$"
)

# ArchWiki 页头导航残渣（2026-08-31 二期实测 6 个 Arch 合并文件 165 行；
# 一期 Gentoo 规则漏掉 Arch 形态）
_FROM_ARCHWIKI_RE = re.compile(r"^\s*From ArchWiki\s*$")
_REDIRECTED_RE = re.compile(r"^\s*\(Redirected from .*\)\s*$")
_RETRIEVED_RE = re.compile(r"^\s*Retrieved from .*$")
_RELATED_ARTICLES_RE = re.compile(r"^\s*Related articles\s*$")
# Related articles 块内的列表项：单行全由相对 wiki 链接构成
# （/title/Xxx 或 /index.php?title=...），绝对外链不算（防误伤正文引用）
_RELATED_LINK_ITEM_RE = re.compile(
    r"^\s*[-*]\s+(?:\[[^\]]*\]\((?:/title/|/index\.php)[^)]*\)\s*)+$"
)


def _count_links(line: str) -> int:
    return len(re.findall(r"\[[^\]]*\]\([^)]*\)", line))


def _is_junk_line(line: str) -> bool:
    """内容级垃圾行判定（不保护代码围栏，围栏由调用方跳过）"""
    s = line.strip()
    if not s:
        return False
    if _SEE_ALSO_RE.match(line):
        return True
    if _COPYRIGHT_RE.match(line):
        return True
    if _ALL_RIGHTS_RE.match(line):
        return True
    if _NAV_LINE_RE.match(line):
        return True
    if _FROM_GENTOO_RE.match(line):
        return True
    if _FROM_ARCHWIKI_RE.match(line):
        return True
    if _REDIRECTED_RE.match(line):
        return True
    if _RETRIEVED_RE.match(line):
        return True
    if _OTHER_LANGS_RE.match(line):
        return True
    if _AVAILABLE_LANGS_RE.match(line):
        return True
    if _LANG_SWITCH_LINE_RE.match(line):
        return True
    for pat in _TEMPLATE_LINE_RES:
        if pat.match(line):
            return True
    if _LINK_FARM_LINE_RE.match(line) and _count_links(line) > 3:
        return True
    return False


def clean_section_lines(lines: list[str]) -> list[str]:
    """内容级清洗一个章节的行列表（围栏保护 + 空行压缩 + 行尾空白）"""
    out: list[str] = []
    in_fence = False
    fence_marker = ""
    blank_run = 0
    in_related = False  # ArchWiki「Related articles」导航块跳过态
    git_nav_buf: list[str] = []  # Git 导航链接列表缓冲（凑够阈值才整段丢）
    for line in lines:
        stripped = line.lstrip()
        # 代码围栏（``` / ~~~）内一律原样保留
        if stripped.startswith("```") or stripped.startswith("~~~"):
            marker = stripped[:3]
            if not in_fence:
                in_fence = True
                fence_marker = marker
                if blank_run:  # 围栏前空行压 1
                    out.append("")
                    blank_run = 0
            elif marker == fence_marker:
                in_fence = False
            out.append(line)
            continue
        if in_fence:
            out.append(line)
            continue
        if in_related:
            # 块内：空行与相对 wiki 链接列表项继续跳；其他内容 → 退出块态
            if not stripped or _RELATED_LINK_ITEM_RE.match(line):
                continue
            in_related = False
        if _RELATED_ARTICLES_RE.match(line):
            in_related = True
            continue
        if _is_junk_line(line):
            # 垃圾行跳过但不重置空行计数：前后段落边界（如围栏后空行）
            # 在下一个非空行 flush 时保留 1 个，避免段落粘连
            continue
        # Git 文档站的纯导航链接列表段（2026-08-31 三期：restore/init 章节
        # 混入的 `- [cat-file](/docs/git-cat-file)` 命令索引列表）：
        # 连续 ≥_GIT_NAV_MIN_RUN 行相对 /docs/ 链接列表项 → 整段丢弃；
        # 不足阈值（1-2 行）视为正常引用保留。缓冲到段尾再决定。
        if _GIT_NAV_ITEM_RE.match(line):
            git_nav_buf.append(line)
            continue
        if git_nav_buf:
            if len(git_nav_buf) >= _GIT_NAV_MIN_RUN:
                pass  # 整段丢弃：直接不输出
            else:
                out.extend(git_nav_buf)  # 少量引用行回填
            git_nav_buf = []
        stripped_r = line.rstrip()
        if not stripped_r:
            blank_run += 1
            continue
        if blank_run:
            out.append("")
            blank_run = 0
        out.append(stripped_r)
    # 循环结束：未 flush 的 git 导航缓冲按同一阈值规则处理
    if git_nav_buf:
        if len(git_nav_buf) < _GIT_NAV_MIN_RUN:
            out.extend(git_nav_buf)
        git_nav_buf = []
    # 尾部连续空行压到 1 个
    while out and not out[-1]:
        out.pop()
    return out


# ============================================================================
# 文档解析：frontmatter / 头部（# 大标题+说明+目录） / 章节序列
# ============================================================================

_CHAPTER_RE = re.compile(r"^## (\d+)\. (.*)$")
_FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*\n", re.DOTALL)


def split_document(text: str):
    """把合并 md 拆成 (frontmatter_meta, head_lines, sections)

    sections: list[dict] = {num, title, lines}（lines 含章节标题行自身）
    章节边界 = `## 序号. 标题`；其间的 `---` 分隔线归 head 或上一章节尾部。
    """
    m = _FRONTMATTER_RE.match(text)
    meta: dict[str, str] = {}
    rest = text
    if m:
        for line in m.group(1).splitlines():
            if ": " in line:
                key, _, value = line.partition(": ")
                meta[key.strip()] = value.strip()
        rest = text[m.end():]

    lines = rest.splitlines()
    head: list[str] = []
    sections: list[dict] = []
    cur: dict | None = None
    for line in lines:
        cm = _CHAPTER_RE.match(line)
        if cm:
            if cur is not None:
                sections.append(cur)
            cur = {
                "num": int(cm.group(1)),
                "title": cm.group(2).strip(),
                "lines": [line],
            }
            continue
        if cur is not None:
            cur["lines"].append(line)
        else:
            head.append(line)
    if cur is not None:
        sections.append(cur)
    return meta, head, sections


# ============================================================================
# 整文件清洗
# ============================================================================


def build_frontmatter(meta: dict[str, str]) -> str:
    """frontmatter 序列化（保持键序，更新 summary_zh/sources_count）"""
    lines = ["---"]
    for key, value in meta.items():
        lines.append(f"{key}: {value}" if value else f"{key}:")
    lines.append("---")
    return "\n".join(lines)


def clean_consolidated_text(text: str) -> tuple[str, dict]:
    """清洗一个合并 md：返回 (新文本, 统计 dict)

    统计: removed_chapters=[(num, title)], kept_chapters, removed_lines,
    chars_before/chars_after, empty_removed
    """
    meta, head, sections = split_document(text)
    stats: dict = {
        "removed_chapters": [],
        "kept_chapters": 0,
        "removed_lines": 0,
        "chars_before": len(text),
    }

    kept: list[dict] = []
    seen_urls: set[str] = set()  # 归一后来源 URL（同页多变体去重）
    for sec in sections:
        if is_junk_chapter_title(sec["title"]):
            stats["removed_chapters"].append((sec["num"], sec["title"]))
            continue
        url = section_source_url(sec["lines"])
        if url:
            key = normalize_source_url(url)
            if key in seen_urls:
                stats["removed_chapters"].append((sec["num"], sec["title"]))
                stats["duplicate_removed"] = stats.get("duplicate_removed", 0) + 1
                continue
            seen_urls.add(key)
        body = clean_section_lines(sec["lines"])
        # 章节正文 = 标题行 + 注释行 + 内容；清洗后仅剩标题/注释视为空章节删
        non_meta = [ln for ln in body if not ln.startswith("<!-- 来源:") and ln.strip()]
        if len(non_meta) <= 1:  # 只剩标题行
            stats["removed_chapters"].append((sec["num"], sec["title"]))
            stats.setdefault("empty_removed", 0)
            stats["empty_removed"] += 1
            continue
        stats["removed_lines"] += len(sec["lines"]) - len(body)
        kept.append({"num": sec["num"], "title": sec["title"], "lines": body})

    # 章节重编号 1..N（先重编号再统计字符，标题行序号位数变化计入统计）
    kept_titles = [sec["title"] for sec in kept]
    n = len(kept)
    for i, sec in enumerate(kept, 1):
        sec["lines"][0] = f"## {i}. {sec['title']}"

    # frontmatter 元数据（summary_zh/sources_count）**保留原样**：
    # 字符数统计口径（clean 直接算 vs db 内 clean_markdown 变换后）不一致，
    # 若重算会导致 clean↔export 往返振荡（实测每轮 ±429 行）；页数/字数是
    # 摘要描述，下次 consolidate_knowledge 重生成时会按新内容刷新。
    src_counts: dict[str, int] = {}
    for sec in kept:
        src = ""
        for ln in sec["lines"]:
            if ln.startswith("<!-- 来源:"):
                src = ln.split(":", 1)[1].split("|", 1)[0].strip()
                break
        if src:
            src_counts[src] = src_counts.get(src, 0) + 1
    head = _rebuild_head(head, kept_titles, src_counts)

    out_lines = []
    if meta:
        out_lines.append(build_frontmatter(meta))
        out_lines.append("")
    out_lines.extend(head)
    # 章节原样拼接（章节间分隔 `---` 保留在上一章节尾部，不主动新增，
    # 保持源格式：旧格式文件无 `---` 分隔则维持无）
    for sec in kept:
        out_lines.extend(sec["lines"])
    new_text = _collapse_head_blank(out_lines)
    stats["kept_chapters"] = n
    stats["chars_after"] = len(new_text)
    return new_text, stats


def _rebuild_head(
    head: list[str], kept_titles: list[str], src_counts: dict[str, int]
) -> list[str]:
    """重建头部：更新说明「合并自 N 页」+ 按保留章节重生成目录

    原目录区域 = 「**目录**」行到第一个章节标题（head 中的数字列表行）之前。
    src_counts = {来源: 保留页数}（从保留章节的 `<!-- 来源 -->` 注释统计，
    保证说明行与正文实际章节数一致）。
    """
    out: list[str] = []
    in_toc = False
    replaced_toc = False
    updated_intro = False
    n = len(kept_titles)
    for line in head:
        s = line.strip()
        if s == "**目录**":
            in_toc = True
            out.append(line)
            continue
        if in_toc:
            # 目录区内空行保留（`**目录**` 与首条目之间有空行），不退出
            if not s:
                out.append(line)
                continue
            # 目录项行（1. xxx）→ 替换为保留章节；首个非目录项行结束目录区
            if re.match(r"^\d+\. ", s):
                if not replaced_toc:
                    for i, t in enumerate(kept_titles, 1):
                        out.append(f"{i}. {t}")
                    replaced_toc = True
                continue
            in_toc = False
        # 说明 blockquote「合并自 N 个官方文档页（...）。」→ 按保留章节重写
        if not updated_intro and re.match(r"^> 合并自 \d+ 个", s):
            if src_counts:
                src_desc = "、".join(
                    f"{k} {v} 页" for k, v in sorted(src_counts.items())
                )
            else:
                src_desc = f"{n} 页"
            out.append(f"> 合并自 {n} 个官方文档页（{src_desc}）。")
            updated_intro = True
            continue
        out.append(line)
    return out


def _collapse_head_blank(lines: list[str]) -> str:
    """头部空行压缩（保持与源一致的紧凑格式）"""
    out: list[str] = []
    blank_run = 0
    for line in lines:
        if not line.strip():
            blank_run += 1
            continue
        if blank_run:
            out.append("")
            blank_run = 0
        out.append(line)
    while out and not out[-1]:
        out.pop()
    return "\n".join(out) + "\n"


# ============================================================================
# 扫描（--scan）：垃圾清单 + 语言残渣
# ============================================================================

# 语言残渣特征词（正文级检测：德语/法语/日语）
_LANG_RESIDUE_PATTERNS: list[tuple[str, list[str]]] = [
    ("de", ["Der ", "Die ", "Das ", " und ", "für ", "nicht ", "Sie ", "ist "]),
    ("fr", [" le ", " la ", " les ", " des ", " et ", "pour ", "avec "]),
    ("ja", ["です", "ます", "ください", "れません"]),
]


def scan_dir(preview_dir: Path) -> dict:
    """全量扫描：返回分类统计 {file, junk_chapters, junk_lines, lang_residue, ...}"""
    report: dict = {
        "files": 0,
        "excluded_files": [],     # [(relpath, source)] 整源排除（待删文件）
        "junk_chapters": [],      # [(relpath, num, title)]
        "junk_lines": 0,
        "lang_residue": [],       # [(relpath, title, lang)]
        "see_also_lines": 0,
        "copyright_lines": 0,
        "link_farm_lines": 0,
        "template_lines": 0,
        "total_chapters": 0,
    }
    for md_path in sorted(preview_dir.rglob("*.md")):
        text = md_path.read_text(encoding="utf-8")
        meta, head, sections = split_document(text)
        report["files"] += 1
        rel = str(md_path.relative_to(preview_dir))
        if meta.get("source", "") in _EXCLUDED_SOURCES:
            report["excluded_files"].append((rel, meta.get("source", "")))
            continue
        report["total_chapters"] += len(sections)
        for sec in sections:
            if is_junk_chapter_title(sec["title"]):
                report["junk_chapters"].append((rel, sec["num"], sec["title"]))
                continue
            for line in sec["lines"]:
                s = line.strip()
                if not s or s.startswith("<!--"):
                    continue
                if _SEE_ALSO_RE.match(line):
                    report["see_also_lines"] += 1
                if _COPYRIGHT_RE.match(line) or _ALL_RIGHTS_RE.match(line):
                    report["copyright_lines"] += 1
                if _LINK_FARM_LINE_RE.match(line) and _count_links(line) > 3:
                    report["link_farm_lines"] += 1
                for pat in _TEMPLATE_LINE_RES:
                    if pat.match(line):
                        report["template_lines"] += 1
                        break
            # 语言残渣：章节正文命中非中文语言特征词
            body = "\n".join(sec["lines"])
            if _has_lang_residue(body):
                report["lang_residue"].append((rel, sec["title"], _detect_lang(body)))
    report["junk_lines"] = (
        report["see_also_lines"] + report["copyright_lines"]
        + report["link_farm_lines"] + report["template_lines"]
    )
    return report


def _detect_lang(text: str) -> str:
    for lang, words in _LANG_RESIDUE_PATTERNS:
        hits = sum(1 for w in words if w in text)
        if hits >= 2:
            return lang
    return "?"


def _has_lang_residue(text: str) -> bool:
    return _detect_lang(text) != "?"


# ============================================================================
# CLI
# ============================================================================


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="合并知识库全量清洗（章节级+内容级）")
    parser.add_argument(
        "--scan", action="store_true", help="只扫描输出垃圾清单（不改文件）"
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="预览清洗统计（不改文件）"
    )
    parser.add_argument(
        "--apply", action="store_true", help="显式执行改写（默认行为，可省略）"
    )
    parser.add_argument("--preview", default=None, help="合并文件目录（默认 knowledge-preview）")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    preview_dir = Path(args.preview) if args.preview else PREVIEW_DIR
    if not preview_dir.is_dir():
        raise SystemExit(f"目录不存在：{preview_dir}")

    if args.scan:
        report = scan_dir(preview_dir)
        print(f"扫描文件数: {report['files']}  总章节: {report['total_chapters']}")
        print(f"\n== 整源排除（待删文件）: {len(report['excluded_files'])} ==")
        for rel, src in report["excluded_files"]:
            print(f"  [{src}] {rel}")
        print(f"\n== 章节级垃圾: {len(report['junk_chapters'])} ==")
        for rel, num, title in report["junk_chapters"]:
            print(f"  [{rel}] ## {num}. {title}")
        print(f"\n== 内容级垃圾行: {report['junk_lines']} ==")
        print(f"  See also: {report['see_also_lines']}  "
              f"Copyright: {report['copyright_lines']}  "
              f"纯链接行: {report['link_farm_lines']}  "
              f"模板导航行: {report['template_lines']}")
        print(f"\n== 语言残渣章节: {len(report['lang_residue'])} ==")
        for rel, title, lang in report["lang_residue"][:40]:
            print(f"  [{lang}] {rel} | {title[:60]}")
        if len(report["lang_residue"]) > 40:
            print(f"  ... 共 {len(report['lang_residue'])} 条")
        return 0

    total_removed = 0
    total_removed_lines = 0
    total_excluded = 0
    for md_path in sorted(preview_dir.rglob("*.md")):
        text = md_path.read_text(encoding="utf-8")
        fm = _FRONTMATTER_RE.match(text)
        src = ""
        if fm:
            for line in fm.group(1).splitlines():
                if line.startswith("source: "):
                    src = line.split(": ", 1)[1].strip()
                    break
        if src in _EXCLUDED_SOURCES:
            total_excluded += 1
            if not args.dry_run:
                md_path.unlink()
                print(f"excluded: {md_path.relative_to(preview_dir)} "
                      f"(整源 [{src}] 删除，用户拍板 2026-08-31)")
            else:
                print(f"[dry-run] excluded: {md_path.relative_to(preview_dir)} "
                      f"(整源 [{src}] 待删)")
            continue
        new_text, stats = clean_consolidated_text(text)
        if new_text != text:
            total_removed += len(stats["removed_chapters"])
            total_removed_lines += stats["removed_lines"]
            if not args.dry_run:
                md_path.write_text(new_text, encoding="utf-8")
                print(f"cleaned: {md_path.relative_to(preview_dir)} "
                      f"(章节 {stats['kept_chapters']} 保留, "
                      f"删 {len(stats['removed_chapters'])} 章, "
                      f"删 {stats['removed_lines']} 行, "
                      f"字符 {stats['chars_before']}→{stats['chars_after']})")
            else:
                print(f"[dry-run] {md_path.relative_to(preview_dir)} "
                      f"(删 {len(stats['removed_chapters'])} 章, "
                      f"删 {stats['removed_lines']} 行)")
        else:
            print(f"clean:   {md_path.relative_to(preview_dir)} (无变化)")
    print(f"\n总计: 删除章节 {total_removed} 个, 删除行 {total_removed_lines}, "
          f"整源删除文件 {total_excluded} 个")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
