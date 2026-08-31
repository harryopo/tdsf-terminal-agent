"""
tests/test_knowledge_consolidate.py — 知识库大整合测试（7 分类 × ≤5 合并 md）
==============================================================================

覆盖：
1. consolidate_knowledge 格式整理：标题降级（围栏保护/6 级封顶）、
   相邻空行压缩、相邻重复标题去重、来源正文开头重复标题剥离
2. build_consolidated_markdown：frontmatter/# 大标题/目录/来源章节/
   来源 url 注释/--- 分隔/标题降级落位
3. assign_doc 分组映射：整源归入、archwiki category 分流、title 列表分组、
   未知条目 fail-closed 返回 None
4. rebuild_from_consolidated.load_consolidated_dir：合并 md 分块入库
   （url=合并逻辑 id、块 title=`合并标题 · 章节标题`、consol- 前缀、
   get_doc/list_files 按 url 聚合、doc_titles_zh 重生成、幂等重跑）

所有测试隔离在临时 rag.db（不碰真实数据），embedding 走 patch（不加载模型）。

运行：
    cd src-tauri/sidecar
    .venv/Scripts/python.exe -m pytest tests/test_knowledge_consolidate.py -v
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from scripts.consolidate_knowledge import (
    assign_doc,
    build_consolidated_markdown,
    chapter_labels,
    collapse_blank_lines,
    consolidated_url,
    dedupe_adjacent_headings,
    demote_headings,
    strip_leading_duplicate_heading,
)
from scripts.rebuild_from_consolidated import load_consolidated_dir, parse_frontmatter

SAMPLE_DOC = {
    "dir": "服务部署",
    "filename": "Web 服务器（Nginx 与 Apache）.md",
    "title": "Web 服务器（Nginx 与 Apache）",
    "category": "services",
    "sources": ["nginx-docs", "apache-docs"],
}


@pytest.fixture(autouse=True)
def _isolated_rag(tmp_path):
    """全局 RAG 指向临时库 + 跳过真实 embedding 模型（hash 兜底）"""
    import knowledge.rag as rag_mod

    original = rag_mod._load_embed_model
    rag_mod._load_embed_model = lambda: None
    rag = rag_mod.reset_global_rag(db_path=str(tmp_path / "rag-test.db"))
    yield rag
    rag_mod._load_embed_model = original
    rag_mod.reset_global_rag(db_path=str(tmp_path / "rag-after.db"))


# ============================================================================
# 1. 格式整理
# ============================================================================


def test_demote_headings_off_by_three():
    """# → ####、## → #####、### → ######（降 3 级）"""
    text = "# 一级\n\n正文\n\n## 二级\n\n正文\n\n### 三级\n\n正文"
    out = demote_headings(text)
    assert out == "#### 一级\n\n正文\n\n##### 二级\n\n正文\n\n###### 三级\n\n正文"


def test_demote_headings_fence_protected_and_cap():
    """代码围栏内 # 不降级；4 级标题降级后 6 级封顶"""
    text = (
        "# 标题\n\n```bash\n# 这是注释\nls -la\n```\n\n"
        "#### 四级\n\n~~~py\n# 注释\n~~~"
    )
    out = demote_headings(text)
    lines = out.splitlines()
    assert "# 这是注释" in lines  # 围栏内原样
    assert "###### 四级" in lines  # 4+3=7 → 封顶 6 级
    fence_body = out.split("~~~py")[1]
    assert "# 注释" in fence_body


def test_collapse_blank_lines_fence_protected():
    """连续 2+ 空行压 1；围栏内空行原样"""
    text = "a\n\n\n\nb\n\n```py\nx\n\n\ny\n```\n\n\n\nc\n"
    out = collapse_blank_lines(text)
    fence_body = out.split("```py")[1].split("```")[0]
    assert "x\n\n\ny" in fence_body  # 围栏内空行不动
    assert "\n\n\n" not in out.replace(fence_body, "")  # 围栏外全部压 1


def test_dedupe_adjacent_headings():
    """相邻同文本标题只留第一个；隔了正文不算相邻"""
    text = "# A\n\n# A\n\n正文\n\n# A\n\n# A\n"
    out = dedupe_adjacent_headings(text)
    assert out.count("# A\n") == 2  # 开头一个 + 正文后一个（相邻重复去掉）
    assert "正文" in out


def test_strip_leading_duplicate_heading():
    """来源正文开头与章节标题重复的标题行被剥离；非重复原样"""
    body = "# 初学者指南\n\n正文第一段\n\n#### 小节\n\n小节内容"
    out = strip_leading_duplicate_heading(body, "初学者指南")
    assert not out.startswith("#")
    assert out.startswith("正文第一段")
    # 不同标题不剥离
    out2 = strip_leading_duplicate_heading(body, "其他标题")
    assert out2.startswith("# 初学者指南")


# ============================================================================
# 2. 合并文件生成
# ============================================================================


def _sample_entries() -> list[dict]:
    return [
        {
            "source": "nginx-docs",
            "title": "Beginner's Guide",
            "content": "# Beginner's Guide\n\nnginx 是高性能 Web 服务器。\n\n## 安装\n\n安装步骤。",
            "url": "https://nginx.org/docs/beginners_guide.html",
        },
        {
            "source": "apache-docs",
            "title": "Access Control",
            "content": "## 访问控制\n\nApache 访问控制说明。",
            "url": "https://httpd.apache.org/docs/2.4/howto/access.html",
        },
    ]


def test_build_consolidated_markdown_structure():
    """frontmatter/# 大标题/目录/来源章节/来源注释/--- 分隔/降级落位"""
    zh_map = {"https://nginx.org/docs/beginners_guide.html": "初学者指南"}
    text = build_consolidated_markdown(SAMPLE_DOC, _sample_entries(), zh_map)
    # frontmatter
    assert text.startswith("---\n")
    assert "source: nginx-docs" in text  # 主来源（字符数最多）
    assert "category: services" in text
    assert "url: consolidated/services/Web 服务器（Nginx 与 Apache）.md" in text
    assert "zh_title: Web 服务器（Nginx 与 Apache）" in text
    assert "sources_count: 2" in text
    # 大标题 + 目录（来源章节按 title 排序：Access Control < Beginner's Guide）
    assert "# Web 服务器（Nginx 与 Apache）" in text
    assert "**目录**" in text
    assert "1. Access Control" in text
    assert "2. 初学者指南" in text  # zh_map 命中（中文标题优先）
    # 来源章节 + 注释 + 分隔
    assert "## 1. Access Control" in text
    assert "## 2. 初学者指南" in text
    assert "<!-- 来源: nginx-docs | https://nginx.org/docs/beginners_guide.html -->" in text
    assert "<!-- 来源: apache-docs | https://httpd.apache.org/docs/2.4/howto/access.html -->" in text
    # 来源正文标题降级（# → ####，## → #####），无裸一级标题冲突
    assert "#### Beginner's Guide" in text
    body_after_chapter = text.split("## 2. 初学者指南", 1)[1]
    assert "\n# " not in body_after_chapter
    # 正文原样保留（demote 只动标题行）
    assert "nginx 是高性能 Web 服务器。" in text


def test_build_consolidated_markdown_top_title_not_duplicated():
    """来源正文开头与章节标题重复时被剥离（不出现相邻重复标题）"""
    entries = [
        {
            "source": "nginx-docs",
            "title": "Beginner's Guide",
            "content": "# Beginner's Guide\n\n正文。",
            "url": "https://nginx.org/x",
        }
    ]
    text = build_consolidated_markdown(SAMPLE_DOC, entries, {})
    chapter = text.split("## 1. Beginner's Guide", 1)[1]
    # 剥离后章节标题下直接是正文（降级后的重复标题已删）
    assert "# Beginner's Guide" not in chapter


def test_consolidated_url_format():
    """合并文件逻辑 id = consolidated/<category>/<文件名>"""
    assert consolidated_url(SAMPLE_DOC) == (
        "consolidated/services/Web 服务器（Nginx 与 Apache）.md"
    )


def test_chapter_labels_disambiguate_duplicate_zh():
    """中文标题组内重复时追加英文原标题消歧（LLM 翻译撞车场景）"""
    entries = [
        {"title": "Apache Development Notes", "url": "https://a/1"},
        {"title": "Apache C Style Guide", "url": "https://a/2"},
        {"title": "Access Control", "url": "https://a/3"},
    ]
    zh_map = {"https://a/1": "要点", "https://a/2": "要点", "https://a/3": "访问控制"}
    labels = chapter_labels(entries, zh_map)
    assert labels[0] == "要点 · Apache Development Notes"
    assert labels[1] == "要点 · Apache C Style Guide"
    assert labels[2] == "访问控制"  # 唯一中文标题不消歧


# ============================================================================
# 3. 分组映射（fail-closed）
# ============================================================================


def test_assign_doc_whole_source():
    """整源规则：nginx/apache 条目 → Web 服务器合并文件"""
    doc = assign_doc({"source": "nginx-docs", "title": "任意", "category": "services"})
    assert doc is not None and doc["filename"] == "Web 服务器（Nginx 与 Apache）.md"
    doc2 = assign_doc({"source": "apache-docs", "title": "任意", "category": "services"})
    assert doc2 is not None and doc2["filename"] == "Web 服务器（Nginx 与 Apache）.md"


def test_assign_doc_archwiki_category_split():
    """archwiki 按 category 分流：sys-admin 整类 vs basic-ops title 列表"""
    doc = assign_doc({"source": "archwiki", "title": "systemd", "category": "sys-admin"})
    assert doc is not None and doc["filename"] == "系统启动、内核与 systemd（Arch Wiki）.md"
    doc2 = assign_doc(
        {"source": "archwiki", "title": "NetworkManager", "category": "basic-ops"}
    )
    assert doc2 is not None and doc2["filename"] == "网络基础（Arch Wiki）.md"
    # basic-ops 未在 title 列表中的条目 fail-closed 返回 None
    assert assign_doc(
        {"source": "archwiki", "title": "不存在的页面", "category": "basic-ops"}
    ) is None


def test_assign_doc_title_list_grouping():
    """title 列表分组：ssh-docs 的 ssh(1) → OpenSSH 合并文件；未命中 → None"""
    doc = assign_doc({"source": "ssh-docs", "title": "ssh(1)", "category": "net-remote"})
    assert doc is not None and doc["filename"] == "OpenSSH 客户端与服务器.md"
    assert assign_doc(
        {"source": "ssh-docs", "title": "不存在", "category": "net-remote"}
    ) is None


def test_assign_doc_unknown_returns_none():
    """未知来源/未覆盖条目返回 None（consolidate 主流程据此 fail-closed 退出）"""
    assert assign_doc({"source": "unknown-docs", "title": "x", "category": ""}) is None
    assert assign_doc({"source": "philosophy", "title": "哲学", "category": "linux-philosophy"}) is None


def test_mapping_directory_file_limit():
    """用户钦定形态：每分类目录 ≤5 个合并文件"""
    from collections import Counter

    from scripts.consolidate_knowledge import CONSOLIDATED_DOCS

    per_dir = Counter(d["dir"] for d in CONSOLIDATED_DOCS)
    assert set(per_dir) == {
        "服务部署", "命令与工具", "安全加固", "系统管理",
        "基础概念", "网络与远程",
    }
    for d, n in per_dir.items():
        assert n <= 5, f"{d} 有 {n} 个合并文件，超出 ≤5 约束"


# ============================================================================
# 4. rebuild_from_consolidated（分块入库 + 聚合还原 + 幂等）
# ============================================================================


def _write_consolidated(tmp_dir: Path) -> Path:
    """在临时目录生成一个最小合并 md（2 个来源章节）"""
    doc_dir = tmp_dir / "服务部署"
    doc_dir.mkdir(parents=True, exist_ok=True)
    text = (
        "---\n"
        "source: nginx-docs\n"
        "category: services\n"
        "url: consolidated/services/Test 合并.md\n"
        "title: Test 合并\n"
        "zh_title: Test 合并\n"
        "summary_zh: 测试合并文档摘要。\n"
        "sources_count: 2\n"
        "---\n"
        "\n"
        "# Test 合并\n"
        "\n"
        "**目录**\n"
        "\n"
        "1. 初学者指南\n"
        "2. Access Control\n"
        "\n"
        "---\n"
        "\n"
        "## 1. 初学者指南\n"
        "\n"
        "<!-- 来源: nginx-docs | https://nginx.org/guide -->\n"
        "\n"
        "#### 初学者指南\n"
        "\n"
        "nginx 基础指南正文。\n"
        "\n"
        "##### 安装\n"
        "\n"
        "安装步骤内容。\n"
        "\n"
        "---\n"
        "\n"
        "## 2. Access Control\n"
        "\n"
        "<!-- 来源: apache-docs | https://httpd.apache.org/access -->\n"
        "\n"
        "Apache 访问控制正文。\n"
    )
    path = doc_dir / "Test 合并.md"
    path.write_text(text, encoding="utf-8")
    return path


def test_parse_frontmatter(tmp_path):
    """frontmatter 解析：key: value 全提取，正文剥离围栏"""
    path = _write_consolidated(tmp_path)
    meta, body = parse_frontmatter(path.read_text(encoding="utf-8"))
    assert meta["url"] == "consolidated/services/Test 合并.md"
    assert meta["category"] == "services"
    assert meta["sources_count"] == "2"
    assert body.startswith("# Test 合并")


def test_load_consolidated_dir_chunking_and_aggregation(tmp_path):
    """合并 md 分块入库：url=合并逻辑 id、consol- 前缀、块 title、聚合还原"""
    import uuid

    path = _write_consolidated(tmp_path)
    result = load_consolidated_dir(tmp_path, reset=False)
    assert result["files"] == 1
    assert result["errors"] == 0
    assert result["chunks"] == 3  # 导语块 + 2 个来源章节块

    import knowledge.rag as rag_mod

    rag = rag_mod.get_global_rag()
    url = "consolidated/services/Test 合并.md"
    doc = rag.get_doc(url)
    assert doc is not None
    assert doc["chunks"] == 3
    assert doc["title"] == "Test 合并"
    assert doc["category"] == "services"
    assert doc["source"] == "nginx-docs"
    # 聚合还原完整正文：三个章节按序、来源注释保留
    assert "# Test 合并" in doc["content"]
    assert "## 1. 初学者指南" in doc["content"]
    assert "## 2. Access Control" in doc["content"]
    assert "<!-- 来源: apache-docs | https://httpd.apache.org/access -->" in doc["content"]
    # 块 title 语义 = 合并标题 · 章节标题
    doc_hash = uuid.uuid5(uuid.NAMESPACE_URL, url)
    blocks = [rag.get(f"consol-{doc_hash}-{i}") for i in range(3)]
    assert all(b is not None for b in blocks)
    assert blocks[0]["title"] == "Test 合并"
    assert blocks[1]["title"] == "Test 合并 · 1. 初学者指南"
    assert blocks[2]["title"] == "Test 合并 · 2. Access Control"
    # list_files 按 url 聚合为一个文件
    files = [f for f in rag.list_files(group="services") if f["url"] == url]
    assert len(files) == 1 and files[0]["chunks"] == 3
    # doc_titles_zh 重生成
    zh_rows = {t["url"]: t for t in rag.titles_zh()}
    assert zh_rows[url]["zh"] == "Test 合并"
    assert zh_rows[url]["summary_zh"] == "测试合并文档摘要。"


def test_load_consolidated_dir_idempotent(tmp_path):
    """幂等：重跑同目录，总块数不变（旧块 delete_by_url 清理）"""
    _write_consolidated(tmp_path)
    first = load_consolidated_dir(tmp_path, reset=False)
    second = load_consolidated_dir(tmp_path, reset=False)
    assert first["chunks"] == second["chunks"] == 3

    import knowledge.rag as rag_mod

    rag = rag_mod.get_global_rag()
    assert rag.count() == 3


def test_load_consolidated_dir_skips_philosophy_dir(tmp_path):
    """第 7 分类（philosophy）目录不参与合并重建（load_philosophy_docs 负责）"""
    phil_dir = tmp_path / "Linux哲学与命令对照"
    phil_dir.mkdir(parents=True)
    (phil_dir / "philosophy.md").write_text(
        "---\nurl: consolidated/philosophy/x.md\ntitle: X\n---\n\n# X\n\n内容",
        encoding="utf-8",
    )
    _write_consolidated(tmp_path)
    result = load_consolidated_dir(tmp_path, reset=False)
    assert result["files"] == 1  # 只有服务部署的合并文件

    import knowledge.rag as rag_mod

    rag = rag_mod.get_global_rag()
    assert rag.get_doc("consolidated/philosophy/x.md") is None


def test_load_consolidated_dir_missing_meta_skipped(tmp_path):
    """缺 frontmatter url/title 的文件跳过计 error（fail-closed 不静默吞）"""
    d = tmp_path / "服务部署"
    d.mkdir(parents=True)
    (d / "bad.md").write_text("没有 frontmatter 的正文", encoding="utf-8")
    result = load_consolidated_dir(tmp_path, reset=False)
    assert result["files"] == 0
    assert result["errors"] == 1
