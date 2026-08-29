"""
tests/test_knowledge_chunking.py — 标题边界分块策略测试（知识库升级）
=====================================================================

覆盖：
1. _chunk_markdown：标题切分 / 导语段 / h4 不作为边界 / 超长段二次切分 /
   代码块表格不硬切 / 顺序保持
2. load_builtin_corpus：docs 新分块入库（title="文件 · 标题"、file: tag、
   id 序号连续）+ 同 url 旧块清理（旧策略残留块删除）
3. import_docs：分块 + file: tag + 重导入幂等（旧块清理）

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
    load_builtin_corpus,
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
    """超 ~1200 字的章节按段落二次切分：多块、全部同标题、顺序保持、内容无丢失"""
    paragraphs = "\n\n".join(
        f"段落{i}开始。" + "系统管理实践细节。" * 30 for i in range(10)
    )
    text = f"# 大章\n\n{paragraphs}"
    chunks = _chunk_markdown(text)
    assert len(chunks) > 1
    assert all(t == "大章" for t, _ in chunks)
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
# 2. load_builtin_corpus 集成（新分块 + 旧块清理）
# ============================================================================


def _make_fake_corpus(tmp_path: Path) -> Path:
    """伪造 corpus 目录（docs/guide.md，无 json）"""
    corpus = tmp_path / "corpus"
    docs = corpus / "docs"
    docs.mkdir(parents=True)
    (docs / "guide.md").write_text(
        "# 指南\n\n指南导语内容\n\n## 安装\n\n安装步骤内容\n\n## 配置\n\n配置说明内容\n",
        encoding="utf-8",
    )
    return corpus


def test_load_builtin_docs_new_chunking(tmp_path, monkeypatch):
    """docs 按标题边界分块入库：title="文件 · 标题"、tags 含 file:、id 序号连续"""
    corpus = _make_fake_corpus(tmp_path)
    monkeypatch.setattr(sources_mod, "_CORPUS_DIR", corpus)
    # skills 目录隔离同理（真实 skills 不参与本测试计数）
    monkeypatch.setattr(sources_mod, "_SKILLS_DIR", tmp_path / "no-skills")
    doc_path = corpus / "docs" / "guide.md"

    added = load_builtin_corpus()
    assert added == 3  # 指南 / 安装 / 配置 三段

    doc = sources_mod.get_global_rag().get_doc(str(doc_path))
    assert doc is not None
    assert doc["chunks"] == 3
    assert doc["filename"] == "guide.md"

    base = f"doc-{uuid.uuid5(uuid.NAMESPACE_URL, str(doc_path))}"
    rag = sources_mod.get_global_rag()
    e0 = rag.get(f"{base}-0")
    e1 = rag.get(f"{base}-1")
    e2 = rag.get(f"{base}-2")
    assert e0 is not None and e1 is not None and e2 is not None
    assert e0["title"] == "guide · 指南"
    assert e1["title"] == "guide · 安装"
    assert e2["title"] == "guide · 配置"
    assert e0["source"] == "builtin-docs"
    assert e0["url"] == str(doc_path)
    for e in (e0, e1, e2):
        assert "教学文档" in e["tags"]
        assert "file:guide.md" in e["tags"]


def test_load_builtin_docs_removes_stale_chunks(tmp_path, monkeypatch):
    """旧策略残留块清理：同 url 旧块（序号超出新块数）被删除再入新块"""
    corpus = _make_fake_corpus(tmp_path)
    monkeypatch.setattr(sources_mod, "_CORPUS_DIR", corpus)
    monkeypatch.setattr(sources_mod, "_SKILLS_DIR", tmp_path / "no-skills")
    doc_path = corpus / "docs" / "guide.md"
    rag = sources_mod.get_global_rag()
    base = f"doc-{uuid.uuid5(uuid.NAMESPACE_URL, str(doc_path))}"

    # 模拟旧 ~400 字策略留下的 6 块（新策略只会有 3 块）
    for i in range(6):
        rag.add(
            KnowledgeEntry(
                id=f"{base}-{i}",
                source="builtin-docs",
                title=f"guide（第 {i + 1}/6 节）",
                content=f"旧分块内容 {i} " + "x" * 380,
                url=str(doc_path),
                tags=["教学文档"],
            )
        )
    assert rag.count() == 6

    load_builtin_corpus()

    # 旧 6 块被清掉，新 3 块入库
    assert rag.count() == 3
    assert rag.get(f"{base}-0")["title"] == "guide · 指南"
    assert rag.get(f"{base}-5") is None


def test_load_builtin_idempotent(tmp_path, monkeypatch):
    """重复 load 幂等：同 url 删旧块再入新块，总数不变"""
    corpus = _make_fake_corpus(tmp_path)
    monkeypatch.setattr(sources_mod, "_CORPUS_DIR", corpus)
    monkeypatch.setattr(sources_mod, "_SKILLS_DIR", tmp_path / "no-skills")
    rag = sources_mod.get_global_rag()

    load_builtin_corpus()
    first = rag.count()
    assert first == 3
    load_builtin_corpus()
    assert rag.count() == first


# ============================================================================
# 3. import_docs（分块 + file: tag + 幂等）
# ============================================================================


def test_import_docs_new_chunking_and_tags(tmp_path):
    """导入目录：无标题 ~900 字单块（少碎片）；超长多段落文档多块；tags 含 file:"""
    mid = tmp_path / "guide.md"
    mid.write_text("这是测试文档内容。" * 100, encoding="utf-8")  # ~900 字
    result = import_docs(str(tmp_path))
    assert result["imported"] == 1
    assert result["errors"] == 0
    rag = sources_mod.get_global_rag()
    assert rag.count() == 1  # 新策略：合并为单块（旧策略会碎成 3 块）

    long_doc = tmp_path / "long.md"
    long_doc.write_text(
        "\n\n".join(
            f"第{i}段运维知识讲解。" + "系统管理实践细节。" * 40 for i in range(12)
        ),
        encoding="utf-8",
    )
    import_docs(str(tmp_path))
    long_doc_url = str(long_doc)
    doc = rag.get_doc(long_doc_url)
    assert doc is not None
    assert doc["chunks"] > 1  # 超长多段落 → 多块

    rows = rag.list_files()
    names = {r["filename"] for r in rows}
    assert {"guide.md", "long.md"} <= names


def test_import_docs_idempotent_reimport(tmp_path):
    """重复导入同一目录：旧块清理后重入，总数不变"""
    doc = tmp_path / "x.md"
    doc.write_text("内容段落。" * 200, encoding="utf-8")
    rag = sources_mod.get_global_rag()
    import_docs(str(tmp_path))
    first = rag.count()
    assert first > 0
    import_docs(str(tmp_path))
    assert rag.count() == first
