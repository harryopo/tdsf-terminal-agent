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

import logging
import re

logger = logging.getLogger("sidecar.knowledge.crawlers.clean")

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

# MediaWiki 侧栏残渣行（Vector 皮肤 "move to sidebar hide" 等，整行匹配）
_SIDEBAR_RE = re.compile(
    r"^(move to sidebar|add to sidebar|hide|unhide)( (hide|unhide|show))?$",
    re.IGNORECASE,
)

# "跳到导航/正文" 锚链接行（manpages.debian.org maincontent 顶端
# "[Scroll to navigation](#panels)"，markdownify 后成纯链接行，整行删）
_SCROLL_NAV_RE = re.compile(
    r"^\[\s*(?:scroll|jump|skip)\s+to\s+(?:navigation|top|content|main)\s*\]\([^)]*\)\s*$",
    re.IGNORECASE,
)

# 语言切换残渣：语言显示名集合（出现 ≥2 个不同语言名的短行 = 语言导航，
# 如 Arch Wiki 统计页混入的「2 languages 日本語 Magyar」）
_LANG_NAV_NAMES: tuple[str, ...] = (
    "English", "Deutsch", "Español", "Français", "Italiano", "Magyar",
    "Nederlands", "Polski", "Português", "Svenska", "Čeština", "Ελληνικά",
    "Русский", "Українська", "日本語", "한국어", "中文", "Bahasa Indonesia",
    "Bahasa Melayu", "Català", "Dansk", "Suomi", "Norsk", "Română",
    "Türkçe", "Tiếng Việt", "فارسی",
)
# 句读符号：真实叙述句（如「支持中文、日本語等多语言」）不会被误删
_LANG_NAV_PUNCT = tuple("，。、；：！？")

# 独立成行的「2 languages」/「24 languages」语言计数残渣
_LANG_COUNT_RE = re.compile(r"^\d+\s*[-~]?\s*languages?$", re.IGNORECASE)

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


def _is_lang_nav_line(s: str) -> bool:
    """判断是否语言切换残渣行（传入已 strip 的行）

    规则（TDSF 2026-08-30，针对 Arch Wiki 页混入的语言导航）：
    1. 独立语言计数行：「2 languages」「24 languages」
    2. 短行内混排 ≥2 个语言显示名（如「2 languages 日本語 Magyar」）；
       含句读符号（，。、；：）的行视为真实叙述句不删，避免误伤
       「支持中文、日本語等多语言界面」这类正文。
    """
    if _LANG_COUNT_RE.match(s):
        return True
    if len(s) > 80 or any(p in s for p in _LANG_NAV_PUNCT):
        return False
    hits = sum(1 for name in _LANG_NAV_NAMES if name in s)
    return hits >= 2


def _is_nav_line(s: str) -> bool:
    """判断是否导航残渣行（传入已 strip 的行；整行匹配）"""
    if not s:
        return False
    if s.lower() in _NAV_EXACT:
        return True
    if _NAV_LINE_RE.match(s):
        return True
    if _SIDEBAR_RE.match(s):
        return True
    if _SCROLL_NAV_RE.match(s):
        return True
    if _is_lang_nav_line(s):
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
        if _is_nav_line(s) and not (
            markdown and (re.match(r"[-*+]\s", s) or s.startswith("|"))
        ):
            # markdown 模式下列表项与表格行（含 | --- | 分隔行）是结构，
            # 不作为纯符号/导航残渣移除（TDSF 2026-08-30 GFM 表格保护）
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


# ============================================================================
# 4. 繁体检测（TDSF 2026-08-30 用户钦定：繁体内容直接丢弃，不入库）
# ============================================================================
# 背景：Debian manpages-zh 的 bash.1.zh_TW.html 等繁体手册页曾漏过语言
# 过滤入库（「Bash是一個與sh相容的命令解釋程式」）。早期方案为繁转简保留
# （opencc t2s）；2026-08-30 用户钦定改为**直接丢弃**——zh_TW 手册页与
# zh_CN 同源重复，保留价值有限，翻译管线（translate_knowledge.py）也只
# 处理英文正文，繁体内容属"无用爬取内容"。
#
# 德法西语类页面仍由 URL 语言过滤剔除；简体中文内容零命中，原样保留。

# 繁体特征字/词（字形仅存在于繁体；简体文本不会出现）
_TRAD_FEATURES: tuple[str, ...] = (
    "解釋", "程式", "檔案", "軟體", "硬體", "網路", "相容", "記憶體", "硬碟",
    "伺服器", "系統", "資訊", "設定檔", "註記", "執行", "與", "這", "個",
    "們", "裡", "後", "時", "說", "讀", "寫", "學", "會", "對", "開", "關",
    "變", "圖", "點", "傳", "稱", "覽", "編譯", "環境",
)
_TRAD_MIN_HITS = 2


def looks_traditional(text: str) -> bool:
    """检测文本是否为繁体内容（繁体特征字命中 ≥ 2 处）

    调用方（generic.py to_entries/_extract_page）对命中内容**整条丢弃**
    并计入 discarded_traditional，不再做繁转简。
    """
    if not text:
        return False
    return sum(text.count(f) for f in _TRAD_FEATURES) >= _TRAD_MIN_HITS


# ============================================================================
# 5. 标题清洗与垃圾页判定（TDSF 2026-08-30 根因修复）
# ============================================================================
# 用户投诉实锤：.html/.cgi 文件名当标题（architecture.html）、空标题、
# "Search/Community/News/About" 等站点 chrome 页混入、Apache 2.0 首页几百
# 行链接墙当正文入库。以下三函数分别治理：标题清洗、垃圾标题丢弃、
# 导航索引页（链接密度过高）丢弃。

# 文件名后缀（标题里出现即剥离：architecture.html → architecture）
_TITLE_EXT_RE = re.compile(r"\.(?:html?|cgi|txt|md|php|aspx?|jsp|shtml)$", re.IGNORECASE)

# 站点 chrome / 元页面标题（归一小写后精确命中即整条丢弃；
# 用精确匹配而非子串，避免误伤 "Editing configuration" 类真实标题）
_JUNK_TITLES: frozenset[str] = frozenset({
    "search", "sign in", "sign up", "log in", "login", "logout",
    "community", "contact", "contact us", "news", "statistics",
    "contributing", "getting involved", "main page",
    "download", "downloads", "faq", "about", "about us", "sitemap",
    "edit", "view source", "view history", "history", "table of contents",
    "讨论", "贡献", "搜索", "登录", "注册", "首页", "下载", "关于",
    "社区", "新闻", "统计", "常见问题", "帮助",
})

# 目录索引页标题前缀（Apache 风格 "Index of /docs"）
_INDEX_OF_RE = re.compile(r"^index\s+of\b", re.IGNORECASE)

# 站点 chrome / 社区页标题**子串**模式（带站名前缀时精确表抓不到，
# 实测 Apache 混入：'About the Apache HTTP Server Project' /
# 'Apache Contributors' / 'Apache HTTP Server Mailing Lists' / 'Welcome!'）。
# 只收**高置信**词根（真实技术文档标题几乎不含这些词），避免误伤：
#   contribut* — contributing/contributors/contribute（社区贡献页）
#   mailing list(s) — 邮件列表页
#   ^about\b / about the — 关于页（"About the X Project"）
#   ^welcome — 站点首页欢迎页
#   documentation project — 文档项目元页
_JUNK_TITLE_PATTERNS = re.compile(
    r"\bcontribut(?:e|es|ed|ing|ion|or|ors)\b"
    r"|\bmailing\s+lists?\b"
    r"|(^|\b)about(\s+the\b|\s*$)"
    r"|(^|\b)welcome(\b|!|$)"
    r"|\bdocumentation\s+project\b",
    re.IGNORECASE,
)

# 标题至少含一个字母数字或 CJK 字符（纯符号/装饰标题无效）
_TITLE_HAS_WORD_RE = re.compile(r"[A-Za-z0-9\u4e00-\u9fff]")


def _slug_to_title(url: str) -> str:
    """URL 末段 slug 化为标题：/docs/architecture.html → Architecture"""
    from urllib.parse import unquote, urlparse

    parsed = urlparse(url)
    segs = [s for s in parsed.path.split("/") if s]
    if not segs:
        return ""
    name = unquote(segs[-1])
    name = _TITLE_EXT_RE.sub("", name)
    name = re.sub(r"[_\-]+", " ", name).strip()
    name = re.sub(r"\s+", " ", name)
    if not name:
        return ""
    return name[0].upper() + name[1:]


def clean_title(raw: str, url: str = "") -> str:
    """标题清洗（入库前统一调用）

    ① URL 形态标题（页面无 h1/<title>，调用方塞了 URL）→ slug 兜底；
    ② 剥离 .html/.cgi/.txt/.md 等文件名后缀（architecture.html →
       Architecture，下划线转空格、文件名形态首字母大写）；
    ③ 清洗后为空/纯符号/<3 字符 → 用 URL 末段 slug 化兜底；
    ④ URL 也救不了时返回清洗后的原值（调用方再判）。
    """
    t = (raw or "").strip()
    # URL 形态标题（_extract_page 无 h1/<title> 时以 url 兜底传入）
    if re.match(r"^https?://", t, re.IGNORECASE):
        url = t
        t = ""
    modified = False
    stripped_ext = _TITLE_EXT_RE.sub("", t)
    if stripped_ext != t:
        modified = True
    t = stripped_ext
    # 仅当标题本身像文件名（含下划线词）时才转空格，
    # 正常标题里的连字符（"well-known"）不动
    if "_" in t:
        t = re.sub(r"[_]+", " ", t)
        modified = True
    t = re.sub(r"\s+", " ", t).strip(" -·|:")
    if len(t) >= 3 and _TITLE_HAS_WORD_RE.search(t):
        # 文件名清洗产物（全小写）首字母大写：read_me.md → Read me
        if modified and t == t.lower() and t[:1].isalpha():
            t = t[0].upper() + t[1:]
        return t
    slug = _slug_to_title(url) if url else ""
    if len(slug) >= 3:
        return slug
    return t or slug


def is_junk_title(title: str) -> bool:
    """标题是否命中垃圾词表（站点 chrome/元页面，整条丢弃）

    精确表（_JUNK_TITLES）+ 目录页前缀（Index of）+ 高置信子串模式
    （contribut*/mailing list/about the/welcome/documentation project，
    覆盖带站名前缀的社区页，实测 Apache 'About the ... Project' /
    'Apache Contributors' / 'Mailing Lists' / 'Welcome!'）。
    """
    norm = re.sub(r"\s+", " ", (title or "").strip()).lower().rstrip(".!？?")
    if not norm:
        return True  # 空标题也算垃圾（调用方先 clean_title 兜底后仍空）
    if norm in _JUNK_TITLES:
        return True
    if _INDEX_OF_RE.match(norm):
        return True
    return bool(_JUNK_TITLE_PATTERNS.search(norm))


# man 手册页章节标题（NAME/SYNOPSIS/... ）。man 站（man.openbsd.org /
# manpages.debian.org / man.archlinux.org）整页 h1 全是这些章节名，文档
# 真实标识在 <title>（"ssh-askpass(1) - ..."）与 URL 末段——提取标题时须
# 跳过，否则全站 h1 都相同 → 同标题去重误杀（实测 ssh-docs 43→1 根因）。
# 章节名穷举不完（Debian 还有 ARGUMENTS/LIBRARY/CAUTION/SETUID AND SETGID
# BITS 等），故叠加两条启发式（见 is_section_heading）：
#   ① 以 ¶ 结尾（Debian manpages 每个 h1 带 pilcrow 锚记）
#   ② 全大写 ASCII 词组（NAME / EXIT STATUS / HTTP/2 等，正常文档站
#      h1 标题极少全大写，误伤概率低；命中后标题退化到 <title> 仍合理）
_MAN_SECTIONS: frozenset[str] = frozenset({
    "NAME", "NAMES", "SYNOPSIS", "DESCRIPTION", "OPTIONS", "COMMANDS",
    "CONFIGURATION", "FILES", "SEE ALSO", "AUTHOR", "AUTHORS", "HISTORY",
    "COPYRIGHT", "COPYRIGHT AND PERMISSIONS", "BUGS", "NOTES",
    "EXIT STATUS", "ENVIRONMENT", "EXAMPLES", "RETURN VALUE",
    "RETURN VALUES", "CONFORMING TO", "AVAILABILITY", "DIAGNOSTICS",
    "ERRORS", "REPORTING BUGS", "STANDARDS", "INTRODUCTION",
    "DEVELOPMENT", "CAVEATS", "SECURITY", "VERSIONS", "SIGNALS",
    "COLOPHON", "PAGE INDEX", "OBSOLETE PAGES", "BUG REPORTS",
    "ARGUMENTS", "LIBRARY", "CAUTION", "COMPATIBILITY", "SYNOPSIS",
    "SETUP", "USAGE", "COMMAND-LINE", "OPERANDS", "EXTENDED DESCRIPTION",
})

# 全大写 ASCII 词组（至少 2 字符、含字母；允许空格与 man 章节常见标点）
_ALL_CAPS_RE = re.compile(r"^[A-Z][A-Z0-9 .,/'()&:\-]*$")


def is_section_heading(title: str) -> bool:
    """标题是否为 man 手册页章节名（精确表 + ¶ 尾符 + 全大写启发式）

    全大写判定用**原始**标题（t == t.upper()），不能先 upper() 再判——
    否则 "Home"/"Index" 等正常标题 upper 后也"全大写"被误伤（实测 nginx
    BFS 测试 'Home' 被当章节名跳过、标题退化到 <title>）。
    """
    t = (title or "").strip()
    if not t:
        return False
    if t.endswith("¶"):  # Debian manpages h1 pilcrow 锚记
        return True
    norm = re.sub(r"\s+", " ", t.rstrip("¶").upper())
    if norm in _MAN_SECTIONS:
        return True
    # 原始标题本身全大写（ASCII）：NAME / EXIT STATUS / SETUID AND SETGID BITS
    # 排除含 '(' 的标题——那是 man 页引用格式（GIT-COMMIT(1)、ssh(1)），
    # 是文档标识而非章节名（章节名永远是纯词组无 section 号括号）。
    # 否则 git-scm.com 命令页 h1（GIT-COMMIT(1) 全大写）被误判跳过、
    # 标题退化到 <title> 后全站同标题被去重误杀（实测 git-docs 42→9）。
    if (
        len(t) >= 2
        and t == t.upper()
        and "(" not in t
        and _ALL_CAPS_RE.match(norm)
        and any(c.isalpha() for c in norm)
    ):
        return True
    return False


# <title> 站点后缀分隔符：竖线、em/en dash（前后带空格）、双冒号
_TITLE_SITE_SEP_RE = re.compile(r"\s*\|\s*|\s+[—–-]\s+|\s*::\s*")


def title_from_html_title(raw: str) -> str:
    """从 <title> 提取文档标题：剥离站点后缀（"ssh-askpass(1) - OpenBSD
    manual pages" → "ssh-askpass(1)"；"Get started | Docker Docs" →
    "Get started"）。取第一段（分隔符前）。"""
    t = (raw or "").strip()
    if not t:
        return ""
    head = _TITLE_SITE_SEP_RE.split(t, maxsplit=1)[0].strip()
    return head or t


_MD_LINK_RE = re.compile(r"\[[^\]]*\]\([^)]+\)")
_FENCE_RE = re.compile(r"^(```|~~~)")
# 链接密度阈值：围栏外非空行中「纯链接行」占比（任务钦定 >60%）
_LINK_FARM_RATIO = 0.6
# 纯链接行判定：剥掉 [text](url) 后剩余说明文字 < 此长度
_LINK_FARM_RESIDUE_CHARS = 20
# 少于该行数不做链接密度判定（短页交给字数门槛，避免误伤）
_LINK_FARM_MIN_LINES = 20
# 纯链接行绝对数下限：护栏，避免误伤「每段带参考链接」的真实文档页。
# residue<20 判定已把散文页内联链接排除（句子残余 >20 字），farm 行只
# 来自裸链接列表项；真实文档页纯链接行通常 <20，站点级目录墙（Debian
# Contents farm=42507、Arch manual pages farm=500）动辄数百+。小目录页
# （'Manpages of X' farm=11）由 is_index_page_title 按标题兜底。
_LINK_FARM_MIN_FARM = 20


def is_link_farm(markdown: str) -> bool:
    """正文是否为导航索引页（链接墙）——纯链接行占比 >60% 且绝对数 ≥20

    判定基于 markdownify 输出的 GFM：
    - 代码围栏（```/~~~）内的行**不参与**统计（man 页 SYNOPSIS 不误伤）
    - 「纯链接行」= 含 [text](url) 且剥掉全部链接后剩余说明文字 < 20 字
      （列表项几乎全是链接、无说明文字）；普通段落里内联少量链接的文档页
      （docker/kubernetes 每段带参考链接）不会被误判
    - 占比 >60% 且纯链接行绝对数 ≥20 双条件：真实文档页纯链接行少，
      站点目录索引页（Apache 2.0 首页、netfilter 索引、Debian Contents
      墙）纯链接行动辄数百
    """
    if not markdown:
        return False
    total = 0
    farm_lines = 0
    in_fence = False
    for line in markdown.splitlines():
        stripped = line.strip()
        if _FENCE_RE.match(stripped):
            in_fence = not in_fence
            continue
        if in_fence or not stripped:
            continue
        total += 1
        if _MD_LINK_RE.search(line):
            residue = _MD_LINK_RE.sub("", line).strip(" \t-•*|>")
            if len(residue) < _LINK_FARM_RESIDUE_CHARS:
                farm_lines += 1
    if total < _LINK_FARM_MIN_LINES or farm_lines < _LINK_FARM_MIN_FARM:
        return False
    return farm_lines / total > _LINK_FARM_RATIO


# 站点级目录索引页标题模式（链接密度双条件抓不到的小目录页兜底，
# man 站实测：'Manpages of X' farm=11、'index' farm=14 均低于绝对量阈值，
# 但标题本身即目录页标志；真实文档页标题是 ssh(1)/bash(1) 不会命中）
_INDEX_PAGE_TITLE_RE = re.compile(
    r"^("
    r"manpages?\s+of\s"          # Manpages of bash in Debian bookworm
    r"|contents\s+of\s"          # Contents of Debian unstable
    r"|index$"                   # index（Debian man 站包索引）
    r"|(.*\s)?manual\s+pages?$"  # Arch manual pages / OpenBSD manual pages
    r"|table\s+of\s+contents$"
    r")",
    re.IGNORECASE,
)


def is_index_page_title(title: str) -> bool:
    """标题是否为站点级目录索引页（man 站目录墙等，链接密度抓不到时兜底）"""
    t = (title or "").strip()
    if not t or "://" in t:  # URL 形态标题不是目录页（真实 man 页标题兜底用 URL）
        return False
    return bool(_INDEX_PAGE_TITLE_RE.match(t))


__all__ = [
    "clean_content",
    "clean_markdown",
    "looks_traditional",
    "clean_title",
    "is_junk_title",
    "is_section_heading",
    "is_index_page_title",
    "title_from_html_title",
    "is_link_farm",
]
