"""
knowledge/__init__.py — 知识库模块入口（T-P3-01 ~ T-P3-03 / T-P3-09）
=====================================================================

聚合 FTS5 全文索引 + ChromaDB 向量检索 + 14 源爬虫 + 学习路径推荐。

子模块：
- fts5:              SQLite FTS5 + jieba 中文分词 + BM25 评分
- vector:            ChromaDB 向量检索（sentence-transformers 不可用降级 hash 向量）
- crawlers:          14 源文档爬虫（nginx/apache/.../git）
- path_recommender:  学习路径推荐
"""

from __future__ import annotations

# 暴露 KnowledgeEntry dataclass 供外部使用
from knowledge.fts5 import KnowledgeEntry, FTS5Index

__all__ = ["KnowledgeEntry", "FTS5Index"]
