"""
tests/test_knowledge_chunking.py — 标题边界分块策略测试（知识库升级）
=====================================================================

覆盖：
1. _chunk_markdown：标题切分 / 导语段 / h4 不作为边界 / 超长段二次切分 /
   代码块表格不硬切 / 顺序保持
2. import_docs：docs 级分块入库细节（title="文件 · 标题"、file: tag、
   id 序号连续、同 url 旧块清理、幂等）+ fail-closed 仅 .md
   （load_builtin_corpus 内置索引已于 2026-08-30 剔除，断言迁移至此）

所有测试隔离在临时 rag.db（不碰真实数据），embedding 走 patch（不加载模型）。

运行：
    cd src-tauri/sidecar
    .venv/Scripts/python.exe -m pytest tests/test_knowledge_chunking.py -v
"""

from __future__ import annotations

import sys
import uuid
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

import knowledge.sources as sources_mod
from knowledge.fts5 import KnowledgeEntry
from knowledge.sources import (
    _chunk_markdown,
    _split_long_section,
    import_docs,
)


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
# 1. _chunk_markdown 单元测试
# ============================================================================


def test_chunk_markdown_heading_split():
    """按 1-3 级标题切章节段，标题语义保留，顺序保持"""
    text = (
        "# 标题A\n\n内容A1\n\n内容A2\n\n"
        "## 标题B\n\n内容B\n\n"
        "### 标题C\n\n内容C\n"
    )
    chunks = _chunk_markdown(text)
    titles = [t for t, _ in chunks]
    assert titles == ["标题A", "标题B", "标题C"]
    assert "内容A1" in chunks[0][1] and "内容A2" in chunks[0][1]
    assert "内容B" in chunks[1][1] and "内容A" not in chunks[1][1]
    assert "内容C" in chunks[2][1] and "内容B" not in chunks[2][1]


def test_chunk_markdown_preamble():
    """文件开头无标题的内容作为导语段（标题 ""）"""
    text = "这是导语。\n\n# 标题A\n\n内容A"
    chunks = _chunk_markdown(text)
    assert chunks[0][0] == ""
    assert "导语" in chunks[0][1]
    assert chunks[1][0] == "标题A"


def test_chunk_markdown_h4_not_boundary():
    """4 级及以下标题不作为段落边界（保持章内聚合）"""
    text = "# 标题A\n\n内容A\n\n#### 四级小节\n\n仍属A的内容\n"
    chunks = _chunk_markdown(text)
    assert len(chunks) == 1
    assert chunks[0][0] == "标题A"
    assert "仍属A的内容" in chunks[0][1]


def test_chunk_markdown_code_fence_hash_not_heading():
    """代码围栏内的 # 是注释不是标题（否则 shell 注释会把段落切碎）"""
    text = (
        "# 用法\n\n说明文字\n\n"
        "```bash\n# 这是一条注释\nls -la\n# 另一条注释\ndf -h\n```\n\n"
        "## 收尾\n\n收尾内容\n"
    )
    chunks = _chunk_markdown(text)
    titles = [t for t, _ in chunks]
    assert titles == ["用法", "收尾"]
    fence_chunk = chunks[0][1]
    assert "# 这是一条注释" in fence_chunk
    assert "df -h" in fence_chunk


def test_chunk_markdown_long_section_split_order():
    """超 ~1200 字的章节按段落二次切分：多块、标题带子段语义与序号、
    顺序保持、内容无丢失（2026-08-31：块 title 追加「· 子标题 · #序」，
    修同章节 94 块同名不可区分问题）"""
    paragraphs = "\n\n".join(
        f"段落{i}开始。" + "系统管理实践细节。" * 30 for i in range(10)
    )
    text = f"# 大章\n\n{paragraphs}"
    chunks = _chunk_markdown(text)
    assert len(chunks) > 1
    # 二切块标题以原章节标题为前缀、带序号后缀（唯一可区分）
    assert all(t.startswith("大章") for t, _ in chunks)
    suffixes = [t for t, _ in chunks]
    assert len(set(suffixes)) == len(suffixes), "同章节二切块 title 必须唯一"
    joined = "\n\n".join(c for _, c in chunks)
    for i in range(10):
        assert f"段落{i}开始。" in joined


def test_split_long_section_single_oversized_paragraph_kept_whole():
    """单段自身超限（大代码块/表格）独立成块，不硬切行"""
    code_block = "```bash\n" + "x" * 2000 + "\n```"
    parts = _split_long_section(code_block)
    assert len(parts) == 1
    assert parts[0] == code_block


def test_split_long_section_greedy_fill():
    """贪心装填：多段合并至 ~1200 字上限再开新块"""
    paras = "\n\n".join("段" * 400 for _ in range(6))  # 每段 400 字，共 2400
    parts = _split_long_section(paras)
    assert len(parts) >= 2
    # 每块 ≤ 1200 + 单段余量（最后一段加入后可能略超，但不超 1200+段长）
    for p in parts:
        assert len(p) <= 1200 + 402
    # 内容无丢失
    assert sum(len(p.replace("\n\n", "")) for p in parts) == 6 * 400


def test_chunk_markdown_empty():
    """空文本/纯空行 → 空列表"""
    assert _chunk_markdown("") == []
    assert _chunk_markdown("\n\n  \n") == []


# ============================================================================
# 2. import_docs 分块入库细节（原 load_builtin_corpus 集成断言迁移至此）
# ============================================================================


GUIDE_CONTENT = (
    "# 指南\n\n指南导语内容\n\n## 安装\n\n安装步骤内容\n\n## 配置\n\n配置说明内容\n"
)


def test_import_docs_chunking_detail(tmp_path):
    """按标题边界分块入库：title="文件 · 标题"、tags 含 file:、id 序号连续"""
    doc_path = tmp_path / "guide.md"
    doc_path.write_text(GUIDE_CONTENT, encoding="utf-8")

    result = import_docs([{"name": "guide.md", "content": GUIDE_CONTENT}])
    assert result["imported"] == 1
    assert result["errors"] == 0
    assert result["rejected"] == []

    rag = sources_mod.get_global_rag()
    # url = 文件名（个人导入文档的幂等 key）
    doc = rag.get_doc("guide.md")
    assert doc is not None
    assert doc["chunks"] == 3  # 指南 / 安装 / 配置 三段
    assert doc["filename"] == "guide.md"

    base = f"doc-{uuid.uuid5(uuid.NAMESPACE_URL, 'guide.md')}"
    e0 = rag.get(f"{base}-0")
    e1 = rag.get(f"{base}-1")
    e2 = rag.get(f"{base}-2")
    assert e0 is not None and e1 is not None and e2 is not None
    assert e0["title"] == "guide.md · 指南"
    assert e1["title"] == "guide.md · 安装"
    assert e2["title"] == "guide.md · 配置"
    assert e0["source"] == "imported-docs"
    assert e0["url"] == "guide.md"
    for e in (e0, e1, e2):
        assert "用户文档" in e["tags"]
        assert "file:guide.md" in e["tags"]


def test_import_docs_removes_stale_chunks(tmp_path):
    """旧策略残留块清理：同 url 旧块（序号超出新块数）被删除再入新块"""
    rag = sources_mod.get_global_rag()
    base = f"doc-{uuid.uuid5(uuid.NAMESPACE_URL, 'guide.md')}"

    # 模拟旧 ~400 字策略留下的 6 块（新策略只会有 3 块）
    for i in range(6):
        rag.add(
            KnowledgeEntry(
                id=f"{base}-{i}",
                source="imported-docs",
                title=f"guide（第 {i + 1}/6 节）",
                content=f"旧分块内容 {i} " + "x" * 380,
                url="guide.md",
                tags=["用户文档"],
            )
        )
    assert rag.count() == 6

    import_docs([{"name": "guide.md", "content": GUIDE_CONTENT}])

    # 旧 6 块被清掉，新 3 块入库
    assert rag.count() == 3
    assert rag.get(f"{base}-0")["title"] == "guide.md · 指南"
    assert rag.get(f"{base}-5") is None


def test_import_docs_idempotent():
    """重复导入幂等：同 url（文件名）删旧块再入新块，总数不变"""
    rag = sources_mod.get_global_rag()

    import_docs([{"name": "guide.md", "content": GUIDE_CONTENT}])
    first = rag.count()
    assert first == 3
    import_docs([{"name": "guide.md", "content": GUIDE_CONTENT}])
    assert rag.count() == first


def test_import_docs_rejects_non_md_only_md_indexed():
    """fail-closed：非 .md 一律拒绝（.txt 也不再接受），仅 md 入库"""
    result = import_docs(
        [
            {"name": "notes.txt", "content": "纯文本"},
            {"name": "guide.md", "content": GUIDE_CONTENT},
        ]
    )
    assert result["imported"] == 1
    assert len(result["rejected"]) == 1
    assert result["rejected"][0]["name"] == "notes.txt"
    rag = sources_mod.get_global_rag()
    assert rag.count() == 3
    assert rag.get_doc("notes.txt") is None


# ============================================================================
# 3. import_docs（分块 + file: tag + 幂等）
# ============================================================================


def test_import_docs_new_chunking_and_tags(tmp_path):
    """导入内容：无标题 ~900 字单块（少碎片）；超长多段落文档多块；tags 含 file:"""
    mid = "这是测试文档内容。" * 100  # ~900 字
    result = import_docs([{"name": "guide.md", "content": mid}])
    assert result["imported"] == 1
    assert result["errors"] == 0
    rag = sources_mod.get_global_rag()
    assert rag.count() == 1  # 新策略：合并为单块（旧策略会碎成 3 块）

    long_doc_name = "long.md"
    long_content = "\n\n".join(
        f"第{i}段运维知识讲解。" + "系统管理实践细节。" * 40 for i in range(12)
    )
    import_docs([{"name": long_doc_name, "content": long_content}])
    doc = rag.get_doc(long_doc_name)
    assert doc is not None
    assert doc["chunks"] > 1  # 超长多段落 → 多块

    rows = rag.list_files()
    names = {r["filename"] for r in rows}
    assert {"guide.md", "long.md"} <= names


def test_import_docs_idempotent_reimport(tmp_path):
    """重复导入同一文件：旧块清理后重入，总数不变"""
    content = "内容段落。" * 200
    rag = sources_mod.get_global_rag()
    import_docs([{"name": "x.md", "content": content}])
    first = rag.count()
    assert first > 0
    import_docs([{"name": "x.md", "content": content}])
    assert rag.count() == first
