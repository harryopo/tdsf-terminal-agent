"""
knowledge/crawlers/clean.py — 爬虫/导入文本入库前清洗管道（TDSF 2026-08-30）
============================================================================

爬取的官方文档混入导航残渣（Previous/Next/Edit on GitHub 等）、emoji、
HTML 实体残留（bs4 get_text 对 &amp; 等字面量实体会漏出）、翻译残留与
多余空白，污染 FTS5 索引与向量嵌入。本模块在**入库前**统一清洗。

设计约束（重要）：
- **行级正则**清洗，绝不破坏多行结构：代码围栏（``` / ~~~）与缩进代码块
  内的行**原样保留**（``#`` 注释、示例里的 "Next" 等词不误伤）
- 与 sources._chunk_markdown 的围栏识别规则保持一致（strip 后判断、
  同种围栏配对关闭）
- 幂等：clean_content(clean_content(x)) == clean_content(x)

接入点：
- generic._extract_page / GenericCrawler.to_entries（BFS 与单页解析双路）
- NginxCrawler 经 crawl_site 共享 _extract_page，to_entries 显式接入
- sources._chunk_markdown（用户导入 md 分块前，经 clean_markdown）
"""
from __future__ import annotations

import re

# ============================================================================
# 1. emoji / 符号移除
# ============================================================================

# 表情区段：U+1F300–U+1FAFF（杂项符号与象形文字及扩展）、
# U+2600–U+27BF（杂项符号 ☀-⛿ + 装饰符号 ✀-➿）、变体选择符 U+FE0F、ZWJ U+200D
_EMOJI_RE = re.compile(
    "["
    "\U0001F300-\U0001FAFF"
    "\u2600-\u27BF"
    "\uFE0F"
    "\u200D"
    "]+"
)

# ============================================================================
# 2. 导航残渣行（整行匹配才删除，避免误伤正文）
# ============================================================================

_NAV_EXACT = {
    "contents",
    "index",
    "search",
    "menu",
    "navigation",
    "on this page",
    "table of contents",
    "edit on github",
    "previous",
    "next",
    "上一节",
    "下一节",
    "上一章",
    "下一章",
    "上一篇",
    "下一篇",
    "查看编辑历史",
    "菜单",
    "目录",
    "搜索",
    "索引",
}

# 带前后缀符号装饰的导航行（整行匹配）
_NAV_LINE_RE = re.compile(
    r"""^[\s«»‹›→←<>()\[\]|·•–—-]*
        (
            previous(\ page)? | next(\ page)? | edit\ on\ github
          | table\ of\ contents | on\ this\ page | contents | index
          | search | 上一篇 | 下一篇 | 上一节 | 下一节 | 查看编辑历史
        )
        [\s«»‹›→←<>()\[\]|·•–—-]*$""",
    re.IGNORECASE | re.VERBOSE,
)

# 纯符号/装饰行（模式本身不含任何字母数字/CJK 字符，匹配即残渣）
_PURE_SYMBOL_RE = re.compile(
    r"^[\s\-_=*~·•|<>«»‹›→←✔✓✗✘★☆◆◇■□▲△▽▼]+$"
)

# 页脚版权行（Copyright © 单独成行时；长段落不碰）
_COPYRIGHT_RE = re.compile(r"^(copyright|©|\(c\))[\s©\-]*\d{0,4}\b.*$", re.IGNORECASE)

# ============================================================================
# 3. HTML 实体还原（bs4 get_text 对部分字面量实体会漏出）
# ============================================================================

_ENTITIES = {
    "&amp;": "&",
    "&#39;": "'",
    "&lt;": "<",
    "&gt;": ">",
    "&nbsp;": " ",
    "&copy;": "©",
}


def _restore_entities(text: str) -> str:
    for ent, ch in _ENTITIES.items():
        text = text.replace(ent, ch)
    return text


# ============================================================================
# 清洗主逻辑
# ============================================================================


def _fence_marker(stripped: str) -> str | None:
    """识别围栏行，返回围栏标记（``` / ~~~）；非围栏行返回 None"""
    if stripped.startswith("```"):
        return "```"
    if stripped.startswith("~~~"):
        return "~~~"
    return None


def _is_nav_line(s: str) -> bool:
    """判断是否导航残渣行（传入已 strip 的行；整行匹配）"""
    if not s:
        return False
    if s.lower() in _NAV_EXACT:
        return True
    if _NAV_LINE_RE.match(s):
        return True
    if _PURE_SYMBOL_RE.match(s):
        return True
    # 页脚版权行：Copyright © 单独成行（短行才算页脚，长句不碰）
    if len(s) <= 80 and _COPYRIGHT_RE.match(s):
        return True
    return False


def _clean_text(text: str, markdown: bool) -> str:
    """行级清洗统一实现。

    Args:
        text: 待清洗文本
        markdown: True 时保留 markdown 结构行（# 标题、- 列表项）——
                  用户导入 md 路径；False 为爬虫纯文本路径
    """
    out: list[str] = []
    blank_run = 0  # 连续空行计数（含清洗后变空的行）
    in_fence = False
    fence_marker = ""

    def flush_blanks() -> None:
        nonlocal blank_run
        if blank_run:
            # 连续 3+ 空行压成 1；1-2 空行原样保留
            out.extend([""] * (1 if blank_run >= 3 else blank_run))
            blank_run = 0

    for line in text.splitlines():
        stripped = line.strip()
        # ---- 围栏状态机（与 sources._chunk_markdown 同规则）----
        marker = _fence_marker(stripped)
        if marker:
            if not in_fence:
                in_fence = True
                fence_marker = marker
            elif marker == fence_marker:
                in_fence = False
            flush_blanks()
            out.append(line)
            continue
        if in_fence:
            flush_blanks()
            out.append(line)  # 代码块内容原样保留
            continue
        # ---- 缩进代码块（4 空格 / tab）：整行保留，不做行级清洗 ----
        if line.startswith(("    ", "\t")):
            flush_blanks()
            out.append(line)
            continue
        # ---- 非代码区域清洗 ----
        line = _EMOJI_RE.sub("", line)
        line = _restore_entities(line)
        line = re.sub(r"[ \t]+$", "", line)  # 行尾空白
        s = line.strip()
        if not s:
            if stripped:
                # 原本有内容、清洗后变空（纯 emoji 行）→ 整行丢弃，
                # 不引入新空行（保持原文行距语义）
                continue
            blank_run += 1
            continue
        if markdown and s.startswith("#"):
            # markdown 标题行保留（emoji 移除后变空标题则连同 # 一起删）
            if not s.lstrip("#").strip():
                continue
            flush_blanks()
            out.append(line)
            continue
        if _is_nav_line(s) and not (markdown and re.match(r"[-*+]\s", s)):
            continue
        flush_blanks()
        out.append(line)
    flush_blanks()
    return "\n".join(out).strip()


def clean_content(text: str) -> str:
    """清洗爬虫提取的纯文本正文（入库前调用）。

    步骤：①去 emoji/变体选择符/ZWJ ②去导航残渣行、纯符号行、页脚版权行
    ③HTML 实体还原 ④连续 3+ 空行压成 1 ⑤行尾空白清理。
    代码围栏（```/~~~）与缩进代码块内的行**原样保留**（不误伤示例内容）。
    """
    if not text:
        return ""
    return _clean_text(text, markdown=False)


def clean_markdown(text: str) -> str:
    """清洗 markdown 文档（用户导入路径专用，分块前调用）。

    与 clean_content 的区别：``#`` 标题行与 ``- `` 列表项是 markdown
    结构，绝不作为导航残渣移除；围栏/缩进代码块同样保护。
    """
    if not text:
        return ""
    return _clean_text(text, markdown=True)


__all__ = ["clean_content", "clean_markdown"]
