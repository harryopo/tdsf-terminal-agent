"""
knowledge/fts5.py — SQLite FTS5 全文索引（T-P3-01）
=====================================================

职责：
- 提供 KnowledgeEntry dataclass 作为知识库统一数据结构
- FTS5Index 类：基于 SQLite FTS5 虚拟表的全文索引
- 支持中文分词（jieba 优先；不可用降级空格分词）
- BM25 评分排序（FTS5 内置 bm25 函数）
- 增删查 + rebuild 全量重建

设计要点：
- SQLite FTS5 虚拟表（fts5 扩展，Python sqlite3 内置支持）
- jieba 分词预处理：将中文切分为空格分隔的 token（FTS5 unicode61 仅按空格分词）
- BM25：FTS5 内置 bm25() 函数返回负值（越小越相关），转换为 [0,1] 的 score
- 数据库路径：python-sidecar/data/knowledge.db
- 线程安全：单一 Connection + threading.Lock（FTS5 读写共用一个连接）

数据流：
    KnowledgeEntry → jieba 分词 → FTS5 INSERT
    查询字符串    → jieba 分词 → FTS5 MATCH → BM25 排序

降级策略：
- jieba 不可用 → 空格分词（中英文混合时中文按字符 token）
- FTS5 不可用 → 抛 RuntimeError（sqlite3 必须支持 FTS5，否则无法运行）
"""

from __future__ import annotations

import json
import logging
import math
import os
import sqlite3
import threading
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

logger = logging.getLogger("sidecar.knowledge.fts5")


# ============================================================================
# 常量定义
# ============================================================================

# 默认数据库路径（优先使用 TDSF_DATA_DIR 环境变量，避免 Tauri dev watcher 循环重启）
_DEFAULT_DB_PATH: Path = Path(os.environ.get("TDSF_DATA_DIR", str(Path(__file__).parent.parent / "data"))) / "knowledge.db"

# FTS5 虚拟表 DDL
# - content_tokens: 已分词的 content（jieba 切分后空格连接）
# - title_tokens:   已分词的 title
# - source/tags/url/created_at: UNINDEXED 元数据（不参与全文索引，但可读取）
_FTS5_DDL: str = """
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_entries USING fts5(
    entry_id UNINDEXED,
    content_tokens,
    title_tokens,
    source UNINDEXED,
    title UNINDEXED,
    content UNINDEXED,
    url UNINDEXED,
    tags UNINDEXED,
    created_at UNINDEXED,
    tokenize = 'unicode61'
);
"""

# jieba 全局实例（懒加载）
_jieba_available: bool | None = None
_jieba_lock = threading.Lock()


def _check_jieba() -> bool:
    """检查 jieba 是否可用（懒加载，线程安全）

    Returns:
        True 表示 jieba 可用；False 表示降级为空格分词
    """
    global _jieba_available
    if _jieba_available is not None:
        return _jieba_available
    with _jieba_lock:
        if _jieba_available is not None:
            return _jieba_available
        try:
            import jieba  # type: ignore[import-untyped]
            # 触发一次切分以初始化 jieba 内部字典
            jieba.lcut("测试")
            _jieba_available = True
            logger.info("jieba 中文分词器已加载")
        except ImportError:
            _jieba_available = False
            logger.warning("jieba 未安装，降级为空格分词")
        except Exception as e:
            _jieba_available = False
            logger.warning(f"jieba 初始化失败，降级为空格分词: {e}")
    return _jieba_available


def tokenize(text: str) -> str:
    """对文本进行分词，返回空格连接的 token 字符串

    Args:
        text: 原始文本（中英文混合）

    Returns:
        空格分隔的 token 字符串（如 "nginx 启动 失败" → "nginx 启动 失败"）
    """
    if not text:
        return ""
    if _check_jieba():
        try:
            import jieba  # type: ignore[import-untyped]
            tokens = jieba.lcut(text)
            # 过滤空白 token
            return " ".join(t.strip() for t in tokens if t.strip())
        except Exception as e:
            logger.warning(f"jieba 切分失败，回退空格分词: {e}")
    # 降级：按空格分词（中文字符按字符切分作为兜底）
    # 简单策略：将中文字符间插入空格后按空格切分
    chars: list[str] = []
    for ch in text:
        if "\u4e00" <= ch <= "\u9fff":
            chars.append(" " + ch + " ")
        else:
            chars.append(ch)
    blended = "".join(chars)
    return " ".join(t for t in blended.split() if t)


# ============================================================================
# KnowledgeEntry dataclass
# ============================================================================


@dataclass
class KnowledgeEntry:
    """知识库统一数据结构

    所有爬虫 / Skill / 用户笔记统一封装为 KnowledgeEntry。
    被 FTS5Index / VectorIndex / PathRecommender 共用。

    Attributes:
        id: 条目唯一 ID（不提供则自动生成 uuid4 hex）
        source: 来源标识（如 "nginx-docs" / "apache-docs" / "user-note"）
        title: 标题（用于显示和检索）
        content: 正文（用于全文索引和向量检索）
        url: 原始 URL（点击 "查看详情" 跳转）
        tags: 标签列表（用于分类和过滤）
        created_at: 创建时间（ISO 8601 字符串，不提供则取当前 UTC 时间）
    """

    id: str = field(default_factory=lambda: uuid4().hex)
    source: str = ""
    title: str = ""
    content: str = ""
    url: str = ""
    tags: list[str] = field(default_factory=list)
    created_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")
    )

    def to_dict(self) -> dict[str, Any]:
        """序列化为 JSON 兼容字典"""
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "KnowledgeEntry":
        """从字典反序列化（容忍缺失字段）"""
        return cls(
            id=data.get("id") or uuid4().hex,
            source=data.get("source", ""),
            title=data.get("title", ""),
            content=data.get("content", ""),
            url=data.get("url", ""),
            tags=list(data.get("tags", [])),
            created_at=data.get("created_at", ""),
        )


# ============================================================================
# FTS5Index — 全文索引管理器
# ============================================================================


class FTS5Index:
    """SQLite FTS5 全文索引管理器

    线程安全：单一 sqlite3.Connection + threading.Lock
    生命周期：长生命周期（与 Sidecar 同寿命），通过 close() 显式释放

    用法：
        index = FTS5Index()              # 使用默认路径
        index.add(entry)                 # 增加条目
        results = index.search("nginx")  # 全文检索
        index.delete(entry_id)           # 删除条目
        index.rebuild()                  # 全量重建
    """

    def __init__(self, db_path: Path | str | None = None) -> None:
        """初始化 FTS5 索引

        Args:
            db_path: SQLite 数据库路径。None 时使用默认路径
                     python-sidecar/data/knowledge.db
        """
        self.db_path: Path = Path(db_path) if db_path else _DEFAULT_DB_PATH
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

        self._lock = threading.Lock()
        self._conn: sqlite3.Connection = self._open_connection()
        logger.info(f"FTS5Index 初始化完成，db={self.db_path}")

    def _open_connection(self) -> sqlite3.Connection:
        """打开 SQLite 连接并初始化 FTS5 表

        Returns:
            sqlite3.Connection（已创建 FTS5 虚拟表）
        """
        conn = sqlite3.connect(
            str(self.db_path),
            check_same_thread=False,
            isolation_level=None,  # autocommit
        )
        # 性能 pragma
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA synchronous=NORMAL;")

        # 检查 FTS5 是否可用
        try:
            conn.execute(_FTS5_DDL)
        except sqlite3.OperationalError as e:
            if "fts5" in str(e).lower():
                raise RuntimeError(
                    f"SQLite FTS5 扩展不可用: {e}。"
                    "请使用支持 FTS5 的 SQLite 版本（Python 3.10+ 内置通常已支持）"
                ) from e
            raise

        return conn

    # ========================================================================
    # 增删查接口
    # ========================================================================

    def add(self, entry: KnowledgeEntry) -> str:
        """添加一条知识到 FTS5 索引

        Args:
            entry: 知识条目

        Returns:
            entry.id（用于后续 delete / 查询）
        """
        content_tokens = tokenize(entry.content)
        title_tokens = tokenize(entry.title)
        tags_str = json.dumps(entry.tags, ensure_ascii=False)

        with self._lock:
            self._conn.execute(
                "INSERT INTO knowledge_entries "
                "(entry_id, content_tokens, title_tokens, source, title, "
                "content, url, tags, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);",
                (
                    entry.id,
                    content_tokens,
                    title_tokens,
                    entry.source,
                    entry.title,
                    entry.content,
                    entry.url,
                    tags_str,
                    entry.created_at,
                ),
            )
        logger.debug(f"FTS5 add: id={entry.id}, title={entry.title[:40]}")
        return entry.id

    def search(
        self,
        query: str,
        limit: int = 10,
        source: str | None = None,
    ) -> list[dict[str, Any]]:
        """全文检索

        Args:
            query: 查询字符串（自动 jieba 分词）
            limit: 返回 top-K（默认 10）
            source: 可选，仅返回指定 source 的结果

        Returns:
            检索结果列表，每项含 id/source/title/content/url/tags/created_at/score
            按 BM25 score 降序排列
        """
        if not query or not query.strip():
            return []

        # 分词 + 构造 FTS5 查询表达式
        tokens = [t for t in tokenize(query).split() if t]
        if not tokens:
            return []
        # 用 OR 连接各 token（短语匹配过于严格，OR + BM25 排序更鲁棒）
        fts_query = " OR ".join(
            f'"{t.replace(chr(34), chr(34) * 2)}"' for t in tokens
        )

        sql = (
            "SELECT entry_id, source, title, content, url, tags, created_at, "
            "bm25(knowledge_entries) AS rank "
            "FROM knowledge_entries "
            "WHERE knowledge_entries MATCH ? "
        )
        params: list[Any] = [fts_query]
        if source:
            sql += "AND source = ? "
            params.append(source)
        sql += "ORDER BY rank LIMIT ?;"
        params.append(limit)

        with self._lock:
            try:
                cursor = self._conn.execute(sql, params)
                rows = cursor.fetchall()
            except sqlite3.OperationalError as e:
                logger.warning(f"FTS5 查询失败: {e}")
                return []

        results: list[dict[str, Any]] = []
        for row in rows:
            entry_id, src, title, content, url, tags_json, created_at, rank = row
            # bm25 返回负值（越小越相关），转换为 [0,1] 的 score
            try:
                rank_val = float(rank)
            except (TypeError, ValueError):
                rank_val = -1.0
            score = 1.0 / (1.0 + math.exp(rank_val)) if rank_val > -50 else 1.0
            score = round(max(0.0, min(1.0, score)), 4)

            try:
                tags = json.loads(tags_json) if tags_json else []
            except (json.JSONDecodeError, ValueError):
                tags = []

            results.append({
                "id": entry_id,
                "source": src,
                "title": title,
                "content": content,
                "url": url,
                "tags": tags,
                "created_at": created_at,
                "score": score,
            })

        logger.debug(
            f"FTS5 search: query='{query[:40]}', results={len(results)}, "
            f"top_score={results[0]['score'] if results else 0:.3f}"
        )
        return results

    def delete(self, entry_id: str) -> bool:
        """删除指定 ID 的知识条目

        Args:
            entry_id: 条目 ID

        Returns:
            True 表示删除成功；False 表示条目不存在（DELETE 影响行数为 0）
        """
        with self._lock:
            cursor = self._conn.execute(
                "DELETE FROM knowledge_entries WHERE entry_id = ?;",
                (entry_id,),
            )
            # cursor.rowcount 反映 DELETE 实际删除的行数
            # rowcount=-1 表示未知（部分驱动）；fallback 用 SELECT 二次校验
            rowcount = cursor.rowcount
            if rowcount == -1:
                cursor2 = self._conn.execute(
                    "SELECT COUNT(*) FROM knowledge_entries WHERE entry_id = ?;",
                    (entry_id,),
                )
                # 若删除后仍存在，说明删除未生效（应为 0 行）
                rowcount = 0 if cursor2.fetchone()[0] > 0 else 1
        deleted = rowcount > 0
        if deleted:
            logger.debug(f"FTS5 delete: id={entry_id} 已删除")
        else:
            logger.warning(f"FTS5 delete: id={entry_id} 不存在或删除失败")
        return deleted

    def rebuild(self, entries: list[KnowledgeEntry] | None = None) -> int:
        """全量重建索引

        Args:
            entries: 重建后要入库的条目列表。None 时仅清空索引

        Returns:
            重建后索引中的条目数
        """
        with self._lock:
            # 清空 FTS5 表（DELETE FROM 比 DROP + CREATE 更快）
            self._conn.execute("DELETE FROM knowledge_entries;")
            logger.info("FTS5 rebuild: 已清空索引")

        if entries:
            for entry in entries:
                self.add(entry)

        # 统计条目数
        with self._lock:
            cursor = self._conn.execute(
                "SELECT COUNT(*) FROM knowledge_entries;"
            )
            count = cursor.fetchone()[0]
        logger.info(f"FTS5 rebuild: 完成，共 {count} 条目")
        return count

    def count(self) -> int:
        """返回索引中的条目总数"""
        with self._lock:
            cursor = self._conn.execute(
                "SELECT COUNT(*) FROM knowledge_entries;"
            )
            return int(cursor.fetchone()[0])

    def get(self, entry_id: str) -> dict[str, Any] | None:
        """按 ID 获取单条知识（不参与 BM25 排序）

        Args:
            entry_id: 条目 ID

        Returns:
            条目字典（含 score=1.0）；不存在返回 None
        """
        with self._lock:
            cursor = self._conn.execute(
                "SELECT entry_id, source, title, content, url, tags, created_at "
                "FROM knowledge_entries WHERE entry_id = ?;",
                (entry_id,),
            )
            row = cursor.fetchone()

        if not row:
            return None
        entry_id, src, title, content, url, tags_json, created_at = row
        try:
            tags = json.loads(tags_json) if tags_json else []
        except (json.JSONDecodeError, ValueError):
            tags = []
        return {
            "id": entry_id,
            "source": src,
            "title": title,
            "content": content,
            "url": url,
            "tags": tags,
            "created_at": created_at,
            "score": 1.0,
        }

    def close(self) -> None:
        """关闭数据库连接（通常仅在测试或 Sidecar 退出时调用）"""
        with self._lock:
            try:
                self._conn.close()
            except Exception as e:
                logger.warning(f"FTS5 close 异常: {e}")
        logger.info("FTS5Index 连接已关闭")


# ============================================================================
# 模块级单例（供 main.py / graph/nodes.py 复用）
# ============================================================================

_global_index: FTS5Index | None = None
_global_index_lock = threading.Lock()


def get_global_index(db_path: Path | str | None = None) -> FTS5Index:
    """获取全局 FTS5Index 单例

    Args:
        db_path: 数据库路径（仅首次调用生效）

    Returns:
        FTS5Index 实例
    """
    global _global_index
    if _global_index is not None:
        return _global_index
    with _global_index_lock:
        if _global_index is not None:
            return _global_index
        _global_index = FTS5Index(db_path=db_path)
    return _global_index


def reset_global_index() -> None:
    """重置全局单例（仅供测试使用）"""
    global _global_index
    with _global_index_lock:
        if _global_index is not None:
            try:
                _global_index.close()
            except Exception:
                pass
        _global_index = None
