"""
tests/test_knowledge_aggregate.py — 文件级聚合 RPC 测试（知识库升级）
=====================================================================

覆盖：
1. RagIndex.list_files：多块同 url 合成一条 / chunks/total_chars 正确 /
   title0 / filename / url 空条目跳过 / source 过滤
2. RagIndex.get_doc：按块序号排序拼接（含 id 字符串序陷阱：10 vs 2）/
   url 不存在返回 None
3. JSON-RPC：knowledge.list_files / knowledge.get_doc 注册与调度，
   url 必填 fail-closed / 不存在返回明确错误

运行：
    cd src-tauri/sidecar
    .venv/Scripts/python.exe -m pytest tests/test_knowledge_aggregate.py -v
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from knowledge.fts5 import KnowledgeEntry
from knowledge.rag import RagIndex


# ============================================================================
# 1. RagIndex.list_files
# ============================================================================


@pytest.fixture
def rag(tmp_path) -> RagIndex:
    return RagIndex(db_path=tmp_path / "rag.db")


def _add_doc_chunk(
    rag: RagIndex, seq: int, content: str, url: str = "D:/docs/guide.md",
    source: str = "builtin-docs", title: str | None = None,
    id_prefix: str = "doc-abc123",
) -> None:
    rag.add(
        KnowledgeEntry(
            id=f"{id_prefix}-{seq}",
            source=source,
            title=title if title is not None else f"guide · 第{seq}节",
            content=content,
            url=url,
            tags=["教学文档"],
        )
    )


def test_list_files_groups_same_url(rag: RagIndex):
    """多块同 url 合成一条；chunks/total_chars/title0/filename 正确"""
    contents = ["内容一" * 10, "内容二" * 10, "内容三" * 10]
    for i, c in enumerate(contents):
        _add_doc_chunk(rag, i, c)
    # url 为空的条目（corpus 卡片/会话沉淀）应被跳过
    rag.add(KnowledgeEntry(id="case-xyz", source="session-case", title="案例", content="无url"))
    rag.add(KnowledgeEntry(id="corpus-001", source="builtin-corpus", title="卡片", content="无url"))

    files = rag.list_files()
    assert len(files) == 1
    f = files[0]
    assert f["url"] == "D:/docs/guide.md"
    assert f["filename"] == "guide.md"
    assert f["chunks"] == 3
    assert f["total_chars"] == sum(len(c) for c in contents)
    assert f["title0"] == "guide · 第0节"
    assert f["source"] == "builtin-docs"


def test_list_files_source_filter(rag: RagIndex):
    """source 过滤：只返回指定来源的文件"""
    _add_doc_chunk(rag, 0, "甲内容", url="D:/a.md", source="builtin-docs",
                   id_prefix="doc-src-a")
    _add_doc_chunk(rag, 0, "乙内容", url="D:/b.md", source="imported-docs",
                   id_prefix="doc-src-b")

    files_all = rag.list_files()
    assert {f["source"] for f in files_all} == {"builtin-docs", "imported-docs"}

    files_doc = rag.list_files(source="builtin-docs")
    assert len(files_doc) == 1
    assert files_doc[0]["filename"] == "a.md"

    assert rag.list_files(source="not-exist") == []


def test_list_files_http_url_filename(rag: RagIndex):
    """http URL 的 filename 取 path 末段"""
    rag.add(
        KnowledgeEntry(
            id="crawl-h-0", source="nginx-docs", title="nginx 指南",
            content="正文内容", url="https://nginx.org/en/docs/beginners_guide.html",
        )
    )
    files = rag.list_files()
    assert len(files) == 1
    assert files[0]["filename"] == "beginners_guide.html"


# ============================================================================
# 2. RagIndex.get_doc
# ============================================================================


def test_get_doc_joins_in_seq_order(rag: RagIndex):
    """按 id 尾部序号排序拼接（入库乱序也正确），块间 \\n\\n 连接"""
    _add_doc_chunk(rag, 2, "内容C")
    _add_doc_chunk(rag, 0, "内容A")
    _add_doc_chunk(rag, 1, "内容B")
    doc = rag.get_doc("D:/docs/guide.md")
    assert doc is not None
    assert doc["content"] == "内容A\n\n内容B\n\n内容C"
    assert doc["chunks"] == 3
    assert doc["title"] == "guide · 第0节"
    assert doc["total_chars"] == len("内容A") + len("内容B") + len("内容C")


def test_get_doc_seq_numeric_not_lexicographic(rag: RagIndex):
    """序号 10 排在 2 之后（数字序而非字符串序）"""
    _add_doc_chunk(rag, 10, "第十块")
    _add_doc_chunk(rag, 2, "第二块")
    doc = rag.get_doc("D:/docs/guide.md")
    assert doc is not None
    assert doc["content"] == "第二块\n\n第十块"


def test_get_doc_missing_returns_none(rag: RagIndex):
    assert rag.get_doc("D:/nope.md") is None


def test_get_doc_non_chunked_entry(rag: RagIndex):
    """无序号 id（case-<hex>）也能按单块文档返回"""
    rag.add(
        KnowledgeEntry(id="crawl-z-0", source="nginx-docs", title="页",
                       content="页面正文", url="https://x.test/p")
    )
    doc = rag.get_doc("https://x.test/p")
    assert doc is not None
    assert doc["chunks"] == 1
    assert doc["content"] == "页面正文"


def test_stats_by_source(rag: RagIndex):
    """按 source 聚合统计（files/chunks/total_chars）"""
    _add_doc_chunk(rag, 0, "甲", url="D:/a.md", source="builtin-docs")
    _add_doc_chunk(rag, 1, "乙", url="D:/a.md", source="builtin-docs")
    _add_doc_chunk(rag, 0, "丙", url="D:/c.md", source="imported-docs",
                   id_prefix="doc-src-c")
    rag.add(KnowledgeEntry(id="case-1", source="session-case", title="t", content="无url"))

    stats = {s["source"]: s for s in rag.stats_by_source()}
    assert stats["builtin-docs"]["files"] == 1
    assert stats["builtin-docs"]["chunks"] == 2
    assert stats["imported-docs"]["chunks"] == 1
    assert "session-case" in stats


# ============================================================================
# 3. JSON-RPC 注册与调度
# ============================================================================


class FakeDispatcher:
    """伪造 MethodDispatcher（命名参数调用，与 main.MethodDispatcher 一致）"""

    def __init__(self) -> None:
        self.methods: dict[str, object] = {}

    def register(self, name: str, fn) -> None:
        self.methods[name] = fn

    def dispatch(self, name: str, params: dict | None = None):
        fn = self.methods[name]
        if params is None:
            return fn()
        return fn(**params)


@pytest.fixture
def dispatcher(tmp_path, monkeypatch) -> FakeDispatcher:
    """隔离 rag + patch embedding + 注册 knowledge.* 方法"""
    import knowledge.rag as rag_mod
    from knowledge.rpc import register_methods

    original = rag_mod._load_embed_model
    rag_mod._load_embed_model = lambda: None
    monkeypatch.setattr(
        rag_mod, "_load_embed_model", lambda: None
    )
    rag = rag_mod.reset_global_rag(db_path=str(tmp_path / "rpc-rag.db"))
    try:
        d = FakeDispatcher()
        register_methods(d)
        yield d
    finally:
        rag_mod._load_embed_model = original
        rag_mod.reset_global_rag(db_path=str(tmp_path / "rpc-after.db"))


def test_rpc_list_files_dispatch(dispatcher: FakeDispatcher):
    from knowledge.rag import get_global_rag

    rag = get_global_rag()
    _add_doc_chunk(rag, 0, "内容A")
    _add_doc_chunk(rag, 1, "内容B")

    res = dispatcher.dispatch("knowledge.list_files", {})
    assert res["total"] == 1
    assert res["files"][0]["chunks"] == 2
    assert res["files"][0]["filename"] == "guide.md"

    res_filtered = dispatcher.dispatch(
        "knowledge.list_files", {"source": "imported-docs"}
    )
    assert res_filtered["total"] == 0
    assert res_filtered["files"] == []


def test_rpc_get_doc_dispatch(dispatcher: FakeDispatcher):
    from knowledge.rag import get_global_rag

    rag = get_global_rag()
    _add_doc_chunk(rag, 0, "内容A")
    _add_doc_chunk(rag, 1, "内容B")

    res = dispatcher.dispatch("knowledge.get_doc", {"url": "D:/docs/guide.md"})
    assert res["ok"] is True
    assert res["content"] == "内容A\n\n内容B"
    assert res["chunks"] == 2
    assert res["filename"] == "guide.md"


def test_rpc_get_doc_url_required(dispatcher: FakeDispatcher):
    """url 必填 fail-closed：空串/空白返回明确错误"""
    res = dispatcher.dispatch("knowledge.get_doc", {"url": ""})
    assert res["ok"] is False
    assert "url is required" in res["error"]

    res_blank = dispatcher.dispatch("knowledge.get_doc", {"url": "   "})
    assert res_blank["ok"] is False


def test_rpc_get_doc_not_found(dispatcher: FakeDispatcher):
    """url 不存在返回明确错误（不抛异常）"""
    res = dispatcher.dispatch("knowledge.get_doc", {"url": "D:/not-exist.md"})
    assert res["ok"] is False
    assert "document not found" in res["error"]
    assert "D:/not-exist.md" in res["error"]


# ============================================================================
# 4. 中文标题映射（doc_titles_zh，TDSF 2026-08-30）
# ============================================================================


def test_upsert_and_read_titles_zh(rag: RagIndex):
    """upsert 写入 + titles_zh 全量读取；空 url/空标题跳过；同 url 覆盖更新"""
    n = rag.upsert_titles_zh({
        "D:/docs/guide.md": "指南",
        "": "空url被跳过",
        "D:/docs/empty.md": "  ",
        "https://x.test/p": "页面",
    })
    assert n == 2
    titles = {t["url"]: t["zh"] for t in rag.titles_zh()}
    assert titles == {"D:/docs/guide.md": "指南", "https://x.test/p": "页面"}

    # 幂等覆盖（INSERT ... ON CONFLICT DO UPDATE）
    rag.upsert_titles_zh({"D:/docs/guide.md": "新指南"})
    titles = {t["url"]: t["zh"] for t in rag.titles_zh()}
    assert titles["D:/docs/guide.md"] == "新指南"


def test_titles_zh_source_filter(rag: RagIndex):
    """source 过滤：仅返回该源条目 url 的映射（映射表无 source 列，经 entries 关联）"""
    _add_doc_chunk(rag, 0, "甲", url="D:/a.md", source="builtin-docs")
    rag.add(KnowledgeEntry(id="crawl-b-0", source="nginx-docs", title="t",
                           content="正文", url="https://n.test/b"))
    rag.upsert_titles_zh({"D:/a.md": "甲文档", "https://n.test/b": "乙页面"})

    only_nginx = rag.titles_zh(source="nginx-docs")
    assert only_nginx == [
        {"url": "https://n.test/b", "zh": "乙页面", "summary_zh": ""}
    ]
    assert len(rag.titles_zh()) == 2


def test_rpc_titles_zh_dispatch(dispatcher: FakeDispatcher):
    """knowledge.titles_zh RPC：无参全量 / source 过滤"""
    from knowledge.rag import get_global_rag

    rag = get_global_rag()
    _add_doc_chunk(rag, 0, "内容A", url="D:/docs/guide.md")
    rag.upsert_titles_zh({"D:/docs/guide.md": "指南"})

    res = dispatcher.dispatch("knowledge.titles_zh", {})
    assert res["total"] == 1
    assert res["titles"] == [
        {"url": "D:/docs/guide.md", "zh": "指南", "summary_zh": ""}
    ]

    res_filtered = dispatcher.dispatch(
        "knowledge.titles_zh", {"source": "imported-docs"}
    )
    assert res_filtered["titles"] == []
    assert res_filtered["total"] == 0
