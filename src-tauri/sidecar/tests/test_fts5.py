"""
tests/test_fts5.py — SQLite FTS5 全文索引单元测试（T-P3-01 验证）
=================================================================

验证内容：
1. KnowledgeEntry dataclass 默认值 + 序列化
2. FTS5Index 初始化 + 默认路径
3. add/search/delete/rebuild 全流程
4. jieba 中文分词
5. BM25 评分排序
6. limit / source 过滤
7. count / get 接口

运行：
    cd python-sidecar
    python -m pytest tests/test_fts5.py -v
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

# 确保能 import knowledge 模块
sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

from knowledge.fts5 import (
    KnowledgeEntry,
    FTS5Index,
    tokenize,
    get_global_index,
    reset_global_index,
)


# ============================================================================
# Fixtures
# ============================================================================


@pytest.fixture
def temp_index() -> FTS5Index:
    """临时 FTS5 索引（每个测试独立数据库）"""
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = Path(tmpdir) / "test_knowledge.db"
        index = FTS5Index(db_path=db_path)
        yield index
        index.close()


@pytest.fixture
def sample_entries() -> list[KnowledgeEntry]:
    """5 条样本知识条目"""
    return [
        KnowledgeEntry(
            id="entry-001",
            source="nginx-docs",
            title="nginx 启动失败排查",
            content="nginx 启动失败的常见原因：1. 端口被占用 2. 配置文件语法错误 3. 权限不足",
            url="https://nginx.org/docs/",
            tags=["nginx", "运维", "故障排查"],
        ),
        KnowledgeEntry(
            id="entry-002",
            source="systemd-docs",
            title="systemd 服务管理",
            content="systemctl start/stop/restart/enable/disable 管理系统服务",
            url="https://systemd.io/docs/",
            tags=["systemd", "service"],
        ),
        KnowledgeEntry(
            id="entry-003",
            source="docker-docs",
            title="docker 容器排查",
            content="docker logs 查看容器日志；docker exec 进入容器执行命令",
            url="https://docs.docker.com/",
            tags=["docker", "container"],
        ),
        KnowledgeEntry(
            id="entry-004",
            source="nginx-docs",
            title="nginx 配置文件结构",
            content="nginx.conf 由 main/events/http/server/location 块组成",
            url="https://nginx.org/docs/beginners_guide.html",
            tags=["nginx", "配置"],
        ),
        KnowledgeEntry(
            id="entry-005",
            source="ssh-docs",
            title="SSH 免密登录配置",
            content="ssh-keygen 生成密钥对；ssh-copy-id 将公钥上传到服务器",
            url="https://www.ssh.com/docs/",
            tags=["ssh", "认证"],
        ),
    ]


# ============================================================================
# 1. KnowledgeEntry dataclass 测试
# ============================================================================


def test_knowledge_entry_dataclass_defaults():
    """测试 KnowledgeEntry 默认值（id 自动生成、created_at 自动填充）"""
    entry = KnowledgeEntry(
        source="test",
        title="测试条目",
        content="测试内容",
    )
    assert entry.id  # 自动生成非空
    assert len(entry.id) > 0
    assert entry.source == "test"
    assert entry.title == "测试条目"
    assert entry.content == "测试内容"
    assert entry.url == ""
    assert entry.tags == []
    assert entry.created_at  # ISO 8601 时间字符串


def test_knowledge_entry_serialization():
    """测试 KnowledgeEntry to_dict / from_dict 双向序列化"""
    entry = KnowledgeEntry(
        id="custom-id",
        source="nginx-docs",
        title="nginx",
        content="web 服务器",
        url="https://nginx.org",
        tags=["web", "server"],
        created_at="2026-07-26T00:00:00+00:00",
    )
    d = entry.to_dict()
    assert d["id"] == "custom-id"
    assert d["source"] == "nginx-docs"
    assert d["tags"] == ["web", "server"]

    # 反序列化
    entry2 = KnowledgeEntry.from_dict(d)
    assert entry2.id == entry.id
    assert entry2.source == entry.source
    assert entry2.tags == entry.tags
    assert entry2.title == entry.title


# ============================================================================
# 2. FTS5Index 初始化测试
# ============================================================================


def test_fts5_index_creation(temp_index):
    """测试 FTS5Index 创建（数据库文件生成）"""
    assert temp_index.db_path.exists()
    # 空索引 count 应为 0
    assert temp_index.count() == 0


def test_fts5_index_default_path():
    """测试 FTS5Index 默认路径（python-sidecar/data/knowledge.db）"""
    with tempfile.TemporaryDirectory() as tmpdir:
        # 模拟默认路径
        db_path = Path(tmpdir) / "data" / "knowledge.db"
        index = FTS5Index(db_path=db_path)
        assert db_path.exists()
        index.close()


# ============================================================================
# 3. add / search 基本流程测试
# ============================================================================


def test_fts5_add_single_entry(temp_index):
    """测试添加单条知识"""
    entry = KnowledgeEntry(
        source="test",
        title="nginx",
        content="web 服务器",
    )
    entry_id = temp_index.add(entry)
    assert entry_id == entry.id
    assert temp_index.count() == 1


def test_fts5_add_multiple_entries(temp_index, sample_entries):
    """测试添加多条知识"""
    for entry in sample_entries:
        temp_index.add(entry)
    assert temp_index.count() == 5


def test_fts5_search_basic(temp_index, sample_entries):
    """测试基本检索：nginx 关键词"""
    for entry in sample_entries:
        temp_index.add(entry)
    results = temp_index.search("nginx")
    # 至少 2 条 nginx 相关结果（entry-001 + entry-004）
    assert len(results) >= 2
    # 所有结果应包含 nginx 关键词
    for r in results:
        assert "nginx" in r["title"].lower() or "nginx" in r["content"].lower()


def test_fts5_search_chinese(temp_index, sample_entries):
    """测试中文检索：服务管理"""
    for entry in sample_entries:
        temp_index.add(entry)
    results = temp_index.search("服务管理")
    # entry-002 systemd 服务管理 应排前
    assert len(results) > 0
    titles = [r["title"] for r in results]
    assert any("systemd" in t for t in titles) or any("服务" in t for t in titles)


# ============================================================================
# 4. search 高级功能测试
# ============================================================================


def test_fts5_search_with_limit(temp_index, sample_entries):
    """测试 limit 参数：限制返回条数"""
    for entry in sample_entries:
        temp_index.add(entry)
    results = temp_index.search("nginx", limit=1)
    assert len(results) == 1


def test_fts5_search_with_source_filter(temp_index, sample_entries):
    """测试 source 过滤：仅返回 nginx-docs 的结果"""
    for entry in sample_entries:
        temp_index.add(entry)
    results = temp_index.search("nginx", source="nginx-docs")
    assert len(results) >= 1
    for r in results:
        assert r["source"] == "nginx-docs"


def test_fts5_search_empty_query(temp_index):
    """测试空查询返回空列表"""
    results = temp_index.search("")
    assert results == []
    results2 = temp_index.search("   ")
    assert results2 == []


def test_fts5_search_no_match(temp_index, sample_entries):
    """测试无匹配结果（使用与样本完全无关的术语）"""
    for entry in sample_entries:
        temp_index.add(entry)
    # "quantum entanglement" 与运维样本完全无关
    results = temp_index.search("quantum entanglement physics")
    assert len(results) == 0


# ============================================================================
# 5. delete / rebuild 测试
# ============================================================================


def test_fts5_delete_entry(temp_index, sample_entries):
    """测试删除单条知识"""
    for entry in sample_entries:
        temp_index.add(entry)
    assert temp_index.count() == 5

    # 删除 entry-001
    deleted = temp_index.delete("entry-001")
    assert deleted is True
    assert temp_index.count() == 4

    # 再删除已删除的：应返回 False
    deleted2 = temp_index.delete("entry-001")
    assert deleted2 is False


def test_fts5_rebuild(temp_index, sample_entries):
    """测试全量重建：清空 + 重新插入"""
    for entry in sample_entries:
        temp_index.add(entry)
    assert temp_index.count() == 5

    # 重建（仅 3 条）
    new_entries = sample_entries[:3]
    count = temp_index.rebuild(new_entries)
    assert count == 3
    assert temp_index.count() == 3

    # 重建（清空）
    count2 = temp_index.rebuild([])
    assert count2 == 0


# ============================================================================
# 6. BM25 评分测试
# ============================================================================


def test_fts5_bm25_ranking(temp_index):
    """测试 BM25 评分排序：高频词的文档应排前"""
    # entry-a 包含 "nginx" 3 次
    temp_index.add(KnowledgeEntry(
        id="entry-a",
        source="test",
        title="nginx nginx nginx",
        content="nginx web server nginx",
    ))
    # entry-b 包含 "nginx" 1 次
    temp_index.add(KnowledgeEntry(
        id="entry-b",
        source="test",
        title="apache",
        content="apache vs nginx",
    ))
    results = temp_index.search("nginx")
    assert len(results) >= 2
    # entry-a 应排前（BM25 分数更高）
    assert results[0]["id"] == "entry-a"
    assert results[0]["score"] >= results[1]["score"]


# ============================================================================
# 7. jieba 分词测试
# ============================================================================


def test_fts5_jieba_tokenizer():
    """测试 tokenize 函数（jieba 不可用时降级空格分词）"""
    # 中文分词
    tokens = tokenize("nginx 启动失败")
    assert "nginx" in tokens
    # "启动" 和 "失败" 应被切分（jieba）或按字符切分（降级）
    assert "启动" in tokens or "启" in tokens
    assert "失败" in tokens or "失" in tokens

    # 空字符串
    assert tokenize("") == ""

    # 纯英文
    tokens_en = tokenize("hello world")
    assert "hello" in tokens_en
    assert "world" in tokens_en


# ============================================================================
# 8. get / 全局单例测试
# ============================================================================


def test_fts5_get_by_id(temp_index, sample_entries):
    """测试按 ID 获取单条知识"""
    for entry in sample_entries:
        temp_index.add(entry)

    result = temp_index.get("entry-001")
    assert result is not None
    assert result["id"] == "entry-001"
    assert result["title"] == "nginx 启动失败排查"
    assert result["source"] == "nginx-docs"
    assert result["score"] == 1.0  # get 接口 score 固定为 1.0

    # 不存在的 ID
    none_result = temp_index.get("nonexistent-id")
    assert none_result is None


def test_fts5_global_singleton():
    """测试全局单例：get_global_index 多次调用返回同一实例"""
    reset_global_index()
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = Path(tmpdir) / "global_knowledge.db"
        index1 = get_global_index(db_path=db_path)
        index2 = get_global_index()  # 应返回同一实例
        assert index1 is index2
        index1.close()
    reset_global_index()
