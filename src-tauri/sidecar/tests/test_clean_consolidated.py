"""
tests/test_clean_consolidated.py — 合并知识库清洗脚本测试（TDSF 2026-08-31）
==============================================================================

覆盖：
1. 章节级删除判定：语言变体（中文语名+外文后缀）/ Apache Keywords 页 /
   Apache 版本索引页；正常教学标题保守保留
2. 内容级垃圾行判定：See also / Copyright / All rights reserved /
   纯链接行 / 模板导航行；代码围栏内不误删
3. clean_consolidated_text：章节删除 + 序号重排 + 目录重建 + 空章节删除
   + summary_zh/sources_count 元数据更新 + 无章节文档（philosophy）
   frontmatter 不被污染
4. 幂等：二次清洗输出一致

运行：
    cd src-tauri/sidecar
    .venv/Scripts/python.exe -m pytest tests/test_clean_consolidated.py -v
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from scripts.clean_consolidated import (
    _is_junk_line,
    clean_consolidated_text,
    clean_section_lines,
    is_junk_chapter_title,
    split_document,
)

# ============================================================================
# 1. 章节级删除判定
# ============================================================================


def test_junk_title_language_variants_cn():
    """中文语名语言变体整章删除（含括号形式）"""
    for t in [
        "FAQ（德语）", "FAQ（韩语）", "FAQ（荷兰语）", "FAQ（匈牙利语）",
        "FAQ（意大利语）", "FAQ（波兰语）", "FAQ（西班牙语）", "FAQ（巴西葡语）",
        "FAQ（土耳其语）", "FAQ（希腊语）", "FAQ（俄语）", "FAQ（法文）",
    ]:
        assert is_junk_chapter_title(t), t


def test_junk_title_language_variants_native():
    """外文语名语言变体整章删除（wiki 翻译后缀）"""
    for t in [
        "FAQ (Deutsch)", "SELinux_(Français)", "Portage_(日本語)",
        "Systemd_(Русский)", "FAQ_(한국어)", "Firewall_(فارسی)",
        "FAQ（日文）", "FAQ（日语）",
    ]:
        assert is_junk_chapter_title(t), t


def test_junk_title_apache_keywords():
    """Apache 旧站 Keywords 开发向/站务页整章删除"""
    for t in [
        "要点 · Apache Developers' C Language Style Guide",
        "要点 · Apache Development Notes",
        "要点 · Apache HTTP Server 1.3 vulnerabilities",
        "要点 · Apache HTTP Server 2.4 vulnerabilities",
        "要点 · Apache HTTP Server Release Guidelines",
        "要点 · Apache httpd Modules",
        "要点 · Flood",
        "要点 · Reporting Security Problems with Apache",
        "要点 · Verifying Apache HTTP Server Releases",
    ]:
        assert is_junk_chapter_title(t), t


def test_junk_title_apache_index():
    """Apache 版本索引页整章删除"""
    assert is_junk_chapter_title("Apache 2.0 文档")
    assert is_junk_chapter_title("Apache 2.2 文档")


def test_junk_title_keeps_normal():
    """保守原则：正常教学标题全部保留"""
    for t in [
        "SELinux 常见问题",
        "Web 服务器（Nginx 与 Apache）",
        "SELinux 与强制访问控制",
        "Firefox_(core)",  # 消歧义后缀非语言
        "语言",  # 「语言」不是「（德语）」形式
        "中文环境配置",  # 中文相关保留
        "要点",  # 无 Apache 前缀的「要点」保留
        "要点 · 部署 Nginx 负载均衡",  # 非 Apache 站务的「要点 ·」保留
    ]:
        assert not is_junk_chapter_title(t), t


# ============================================================================
# 2. 内容级垃圾行判定
# ============================================================================


def test_junk_line_see_also_copyright_nav():
    assert _is_junk_line("See also")
    assert _is_junk_line("SEE ALSO")
    assert _is_junk_line("**See also**")
    assert _is_junk_line("Copyright © 2008-2025 The Apache Software Foundation.")
    assert _is_junk_line("Copyright 2024 The Rust Project Developers")
    assert _is_junk_line("All rights reserved.")
    assert _is_junk_line("Back to top")
    assert _is_junk_line("返回顶部")
    assert _is_junk_line("Table of Contents")


def test_junk_line_link_farm():
    """纯链接行（>3 个链接）删除"""
    line = "[a](/a) [b](/b) [c](/c) [d](/d) [e](/e)"
    assert _is_junk_line(line)
    # 少链接的引用行保留（防误伤正文引用）
    assert not _is_junk_line("[Handbook](/wiki/Handbook) covers make.conf")
    assert not _is_junk_line("- [Download!](/download.cgi)")


def test_junk_line_template():
    assert _is_junk_line("This page is part of the Linux System Administration documentation.")
    assert _is_junk_line("Please send any comments to docs@example.org")
    # 正文句子不误删
    assert not _is_junk_line("Please send any comments before the deadline.")


def test_junk_line_wiki_nav_residue():
    """Gentoo Wiki 页头模板导航残渣（语言切换链接墙）"""
    assert _is_junk_line("From Gentoo Wiki")
    assert _is_junk_line("Other languages:")
    assert _is_junk_line('- [Deutsch](/wiki/Ebuild/de "Ebuild (71% translated)")')
    assert _is_junk_line('- [中文（中国大陆）‎](/wiki/Ebuild/zh-cn "Ebuild (17% translated)")')
    assert _is_junk_line("- English")
    # Apache 文档站语言切换行
    assert _is_junk_line('Available Languages: [de](../de/vhosts/ "Deutsch") | [en](../vhosts/)')
    # 正常文档列表项不误删
    assert not _is_junk_line("- [emerge](/wiki/Emerge) — configuration — [ebuild]")
    # 作者名 / 书目语言标注是合法内容不误删
    assert not _is_junk_line("P. Deutsch and")
    assert not _is_junk_line("language: Deutsch (German) year: 2016")


def test_clean_section_lines_fence_protected():
    """代码围栏内 See also / 空行不处理；围栏外正常清洗"""
    lines = [
        "## 1. demo",
        "",
        "正文第一段",
        "",
        "",
        "```bash",
        "See also",
        "",
        "",
        "echo hi",
        "```",
        "",
        "See also",
        "尾部正文   ",
    ]
    out = clean_section_lines(lines)
    assert out == [
        "## 1. demo",
        "",
        "正文第一段",
        "",
        "```bash",
        "See also",
        "",
        "",
        "echo hi",
        "```",
        "",
        "尾部正文",
    ]


# ============================================================================
# 3. 整文件清洗
# ============================================================================

SAMPLE_MD = """---
source: selinux-docs
category: security
url: consolidated/security/SELinux 与强制访问控制.md
title: SELinux 与强制访问控制
zh_title: SELinux 与强制访问控制
summary_zh: 本文件合并 selinux-docs 5 页，共 5 个官方文档页、约 1000 字，按主题聚合便于 RAG 检索与人工阅读。
sources_count: 5
---

# SELinux 与强制访问控制

> 合并自 5 个官方文档页（selinux-docs 5 页）。各来源章节以 `## 序号. 标题` 划分，
> 检索命中分块后按 url 聚合即本文档。

**目录**

1. SELinux
2. FAQ（德语）
3. SELinux 布尔值
4. Apache 2.0 文档

## 1. SELinux

<!-- 来源: selinux-docs | https://wiki.gentoo.org/wiki/SELinux -->

正文介绍 SELinux。

## 2. FAQ（德语）

<!-- 来源: selinux-docs | https://wiki.gentoo.org/wiki/FAQ/de -->

德语整页垃圾内容。

## 3. SELinux 布尔值

<!-- 来源: selinux-docs | https://wiki.gentoo.org/wiki/SELinux/Boolean -->

布尔值正文。

See also

## 4. Apache 2.0 文档

<!-- 来源: apache-docs | https://httpd.apache.org/docs/2.0/ -->

版本索引页。
"""


def test_clean_consolidated_text_full():
    """整文件：垃圾章节删除 + 序号重排 + 目录重建 + 说明行更新"""
    new, stats = clean_consolidated_text(SAMPLE_MD)
    assert [t for _, t in stats["removed_chapters"]] == ["FAQ（德语）", "Apache 2.0 文档"]
    meta, head, secs = split_document(new)
    # 重编号连续 1..N
    assert [s["num"] for s in secs] == [1, 2]
    assert [s["title"] for s in secs] == ["SELinux", "SELinux 布尔值"]
    # 目录重建（只含保留章节）
    toc = [ln for ln in head if ln.strip().startswith(("1. ", "2. "))]
    assert toc == ["1. SELinux", "2. SELinux 布尔值"]
    # 说明「合并自 N 页」按保留章节更新（来源页数从 `<!-- 来源 -->` 统计）
    assert "合并自 2 个官方文档页（selinux-docs 2 页）" in "\n".join(head)
    # frontmatter 元数据保留原样（防止 clean↔export 往返振荡，见脚本注释）
    assert meta["sources_count"] == "5"
    assert "5 个官方文档页" in meta["summary_zh"]
    # 内容级残渣（See also 行）已删
    assert "\nSee also\n" not in new
    assert "德语整页垃圾内容" not in new


def test_clean_consolidated_idempotent():
    new1, _ = clean_consolidated_text(SAMPLE_MD)
    new2, stats2 = clean_consolidated_text(new1)
    assert new1 == new2
    assert stats2["removed_chapters"] == []


def test_clean_consolidated_empty_chapter_removed():
    """内容级清洗后只剩标题/注释的空章节删除"""
    md = """---
source: selinux-docs
category: security
url: consolidated/security/SELinux.md
title: SELinux
zh_title: SELinux
summary_zh: 本文件合并 selinux-docs 3 页，共 3 个官方文档页、约 1000 字，按主题聚合便于 RAG 检索与人工阅读。
---

# SELinux

> 合并自 3 个官方文档页（selinux-docs 3 页）。各来源章节以 `## 序号. 标题` 划分。

**目录**

1. SELinux
2. 空章节
3. 正常章节

## 1. SELinux

<!-- 来源: selinux-docs | https://wiki.gentoo.org/wiki/SELinux -->

正文介绍 SELinux。

## 2. 空章节

<!-- 来源: selinux-docs | https://wiki.gentoo.org/wiki/SELinux/Empty -->

See also

## 3. 正常章节

<!-- 来源: selinux-docs | https://wiki.gentoo.org/wiki/SELinux/Boolean -->

布尔值正文。
"""
    new, stats = clean_consolidated_text(md)
    _, _, secs = split_document(new)
    titles = [s["title"] for s in secs]
    assert titles == ["SELinux", "正常章节"], titles
    # 空章节计入 removed（empty_removed 标记）
    assert stats["empty_removed"] == 1
    # 重编号连续
    assert [s["num"] for s in secs] == [1, 2]


def test_clean_no_chapter_doc_meta_not_polluted():
    """无 `## N.` 章节结构的文档（philosophy 自有教学文档）frontmatter 不被污染"""
    md = """---
source: philosophy
category: linux-philosophy
url: linux_philosophy.md
title: linux_philosophy · Linux 设计哲学
---

# Linux 设计哲学——底层逻辑思维

> 理解哲学，命令不再是死记硬背。

### 哲学 1：一切皆文件

正文内容。
"""
    new, stats = clean_consolidated_text(md)
    assert stats["removed_chapters"] == []
    meta, _, secs = split_document(new)
    assert secs == []
    # 不新增 sources_count=0 / 空 summary_zh
    assert "sources_count" not in meta
    assert "summary_zh" not in meta
    assert "共 0 个官方文档页" not in new
