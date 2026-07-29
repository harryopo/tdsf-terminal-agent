"""
knowledge/path_recommender.py — 学习路径推荐（T-P3-09）
=======================================================

职责：
- PathRecommender：基于知识库 + 用户历史生成个性化学习路径
- 推断当前难度（beginner / intermediate / advanced）
- 生成有序学习步骤（每步含 title/source/snippet/url）
- 通过 JSON-RPC 暴露 path.recommend 方法

设计要点：
- 不依赖外部 LLM，纯规则 + 知识库检索
- 用户历史（user_history）为字符串列表（如 ["nginx 启动失败", "docker 容器无法启动"]）
- current_topic 为当前用户问题/主题（如 "nginx 配置"）
- 路径生成策略：
  1. 当前主题检索 FTS5 + Vector → 相关知识条目
  2. 用户历史中的关键词抽取 → 推断先验知识水平
  3. 难度评估：根据已掌握主题数 / 主题相关条目的 source 分布
  4. 步骤生成：取 top-N 相关条目按 source 分组，每组 1 条作为代表步骤
  5. 步骤顺序：beginner → intermediate → advanced（按 source 优先级排序）

降级策略：
- FTS5 / Vector 不可用 → 返回 fallback 模板路径
- 用户历史为空 → 难度 beginner，路径仅基于 current_topic
- current_topic 为空 → 返回空路径

JSON-RPC 接口：
- path.recommend: {user_history: list[str], current_topic: str, limit?: int}
  → {topic: str, difficulty: str, steps: list[dict], total: int}
"""

from __future__ import annotations

import logging
import threading
from typing import Any

from knowledge.fts5 import get_global_index
from knowledge.vector import generate_embedding, get_global_vector

logger = logging.getLogger("sidecar.knowledge.path_recommender")


# ============================================================================
# 常量定义
# ============================================================================

# 难度等级枚举
_DIFFICULTY_BEGINNER: str = "beginner"
_DIFFICULTY_INTERMEDIATE: str = "intermediate"
_DIFFICULTY_ADVANCED: str = "advanced"

# 难度推断阈值（基于用户历史中已掌握主题数）
# 0-1 主题 → beginner
# 2-4 主题 → intermediate
# 5+ 主题 → advanced
_BEGINNER_MAX: int = 1
_INTERMEDIATE_MAX: int = 4

# source 优先级排序（beginner 在前，advanced 在后）
# 顺序：官方文档 → 工具 → 编程语言 → 内核/安全 → mock
_SOURCE_PRIORITY: list[str] = [
    "nginx-docs",
    "apache-docs",
    "mysql-docs",
    "redis-docs",
    "docker-docs",
    "k8s-docs",
    "systemd-docs",
    "selinux-docs",
    "iptables-docs",
    "ssh-docs",
    "bash-docs",
    "python-docs",
    "rust-docs",
    "git-docs",
    "user-note",
]

# 默认步骤数
_DEFAULT_LIMIT: int = 5

# fallback 路径模板（知识库完全为空时使用）
_FALLBACK_PATH: list[dict[str, Any]] = [
    {
        "title": "Linux 基础命令",
        "source": "builtin",
        "snippet": "学习 ls/cd/pwd/mkdir/rm 等基础命令",
        "url": "",
        "step_index": 1,
    },
    {
        "title": "文件权限与用户管理",
        "source": "builtin",
        "snippet": "理解 chmod/chown/useradd/groupadd",
        "url": "",
        "step_index": 2,
    },
    {
        "title": "进程与服务管理",
        "source": "builtin",
        "snippet": "使用 ps/top/systemctl 管理进程",
        "url": "",
        "step_index": 3,
    },
    {
        "title": "网络配置与排查",
        "source": "builtin",
        "snippet": "ip/ss/ping/netstat/ss 命令",
        "url": "",
        "step_index": 4,
    },
    {
        "title": "日志分析与故障排查",
        "source": "builtin",
        "snippet": "journalctl/dmesg/grep 日志分析",
        "url": "",
        "step_index": 5,
    },
]


# ============================================================================
# PathRecommender — 学习路径推荐器
# ============================================================================


class PathRecommender:
    """学习路径推荐器

    基于知识库检索 + 用户历史生成个性化学习路径。

    用法：
        recommender = PathRecommender()
        path = recommender.recommend(
            user_history=["nginx", "docker"],
            current_topic="k8s 部署",
        )
        # path = {
        #     "topic": "k8s 部署",
        #     "difficulty": "intermediate",
        #     "steps": [{title, source, snippet, url, step_index}, ...],
        #     "total": 5,
        # }
    """

    def __init__(self) -> None:
        """初始化路径推荐器（无需参数，依赖全局 FTS5 + Vector 单例）"""
        self._lock = threading.Lock()

    # ========================================================================
    # 公共接口
    # ========================================================================

    def recommend(
        self,
        user_history: list[str] | None = None,
        current_topic: str = "",
        limit: int = _DEFAULT_LIMIT,
    ) -> dict[str, Any]:
        """生成学习路径

        Args:
            user_history: 用户历史问题/主题列表（如 ["nginx 启动失败"]）
            current_topic: 当前主题（如 "k8s 部署"）
            limit: 最多返回步骤数（默认 5）

        Returns:
            {
                "topic": str,            # 当前主题
                "difficulty": str,       # beginner/intermediate/advanced
                "steps": list[dict],     # 学习步骤列表
                "total": int,            # 步骤数
                "user_history_count": int,  # 用户历史数
            }
        """
        history: list[str] = list(user_history or [])
        topic: str = (current_topic or "").strip()
        history_count: int = len(history)

        # 1. 难度评估
        difficulty: str = self._assess_difficulty(history_count, topic)

        # 2. 主题为空 → 直接返回空路径（按降级策略约定）
        #    避免空主题触发 fallback 模板（fallback 仅用于"有主题但知识库无命中"场景）
        if not topic:
            return {
                "topic": "",
                "difficulty": difficulty,
                "steps": [],
                "total": 0,
                "user_history_count": history_count,
            }

        # 3. 检索相关知识
        entries: list[dict[str, Any]] = self._retrieve_knowledge(topic, limit=limit * 2)

        # 4. 生成学习步骤
        if entries:
            steps: list[dict[str, Any]] = self._build_steps_from_entries(
                entries, limit=limit
            )
        else:
            # 知识库无相关条目 → 使用 fallback 模板
            steps = list(_FALLBACK_PATH[:limit])
            logger.info(
                f"path_recommender: 知识库无结果，使用 fallback 模板 "
                f"(topic='{topic[:40]}', limit={limit})"
            )

        return {
            "topic": topic,
            "difficulty": difficulty,
            "steps": steps,
            "total": len(steps),
            "user_history_count": history_count,
        }

    # ========================================================================
    # 内部方法
    # ========================================================================

    def _assess_difficulty(
        self,
        history_count: int,
        current_topic: str,
    ) -> str:
        """根据用户历史数 + 当前主题评估难度

        Args:
            history_count: 用户历史问题数
            current_topic: 当前主题（用于推断复杂度）

        Returns:
            "beginner" / "intermediate" / "advanced"
        """
        # 基础难度按历史数推断
        if history_count <= _BEGINNER_MAX:
            base: str = _DIFFICULTY_BEGINNER
        elif history_count <= _INTERMEDIATE_MAX:
            base = _DIFFICULTY_INTERMEDIATE
        else:
            base = _DIFFICULTY_ADVANCED

        # 当前主题包含高级关键词 → 提升至 advanced
        if current_topic:
            advanced_keywords: list[str] = [
                "k8s", "kubernetes", "selinux", "iptables", "kernel",
                "systemd", "集群", "高可用", "性能调优", "源码",
            ]
            topic_lower: str = current_topic.lower()
            for kw in advanced_keywords:
                if kw.lower() in topic_lower:
                    if base == _DIFFICULTY_BEGINNER:
                        base = _DIFFICULTY_INTERMEDIATE
                    break

        return base

    def _retrieve_knowledge(
        self,
        topic: str,
        limit: int = 10,
    ) -> list[dict[str, Any]]:
        """从 FTS5 + Vector 双路检索相关知识

        Args:
            topic: 检索主题
            limit: 返回 top-K

        Returns:
            合并去重的知识条目列表
        """
        if not topic:
            return []

        # FTS5 检索
        fts_results: list[dict[str, Any]] = []
        try:
            index = get_global_index()
            fts_results = index.search(topic, limit=limit)
        except Exception as e:
            logger.warning(f"path_recommender: FTS5 检索失败: {e}")

        # Vector 检索
        vec_results: list[dict[str, Any]] = []
        try:
            vec_index = get_global_vector()
            query_emb: list[float] = generate_embedding(topic)
            vec_results = vec_index.search(query_emb, limit=limit)
        except Exception as e:
            logger.warning(f"path_recommender: Vector 检索失败: {e}")

        # 合并去重（FTS5 优先）
        merged: list[dict[str, Any]] = []
        seen_ids: set[str] = set()
        for r in fts_results:
            entry_id: str = r.get("id", "")
            if entry_id and entry_id not in seen_ids:
                seen_ids.add(entry_id)
                r["match_type"] = "fts5"
                merged.append(r)
        for r in vec_results:
            entry_id = r.get("id", "")
            if entry_id and entry_id not in seen_ids:
                seen_ids.add(entry_id)
                r["match_type"] = "vector"
                merged.append(r)

        return merged[:limit]

    def _build_steps_from_entries(
        self,
        entries: list[dict[str, Any]],
        limit: int = 5,
    ) -> list[dict[str, Any]]:
        """将检索结果转为学习步骤

        策略：
        1. 按 source 分组
        2. 每组取 score 最高的代表条目
        3. 按 _SOURCE_PRIORITY 排序（beginner 在前）
        4. 取 top-N（limit）

        Args:
            entries: 检索到的知识条目列表
            limit: 最多返回步骤数

        Returns:
            学习步骤列表，每项含 title/source/snippet/url/step_index
        """
        # 按 source 分组（保留每组最高 score 的条目）
        grouped: dict[str, dict[str, Any]] = {}
        for entry in entries:
            source: str = entry.get("source", "unknown")
            score: float = float(entry.get("score", 0.0))
            existing: dict[str, Any] | None = grouped.get(source)
            if existing is None or score > float(existing.get("score", 0.0)):
                grouped[source] = entry

        # 按 _SOURCE_PRIORITY 排序（未列出的 source 排最后）
        def _source_sort_key(item: tuple[str, dict[str, Any]]) -> tuple[int, str]:
            source_name: str = item[0]
            try:
                priority: int = _SOURCE_PRIORITY.index(source_name)
            except ValueError:
                priority = len(_SOURCE_PRIORITY)
            return (priority, source_name)

        sorted_entries: list[dict[str, Any]] = [
            entry for _, entry in sorted(grouped.items(), key=_source_sort_key)
        ]

        # 取 top-N 并生成 step_index
        steps: list[dict[str, Any]] = []
        for i, entry in enumerate(sorted_entries[:limit], start=1):
            content: str = entry.get("content", "")
            snippet: str = content[:200] if content else entry.get("title", "")
            steps.append({
                "title": entry.get("title", f"步骤 {i}"),
                "source": entry.get("source", "unknown"),
                "snippet": snippet,
                "url": entry.get("url", ""),
                "step_index": i,
                "score": entry.get("score", 0.0),
                "match_type": entry.get("match_type", "fts5"),
            })

        return steps


# ============================================================================
# 模块级单例
# ============================================================================

_global_recommender: PathRecommender | None = None
_global_recommender_lock = threading.Lock()


def get_global_recommender() -> PathRecommender:
    """获取全局 PathRecommender 单例"""
    global _global_recommender
    if _global_recommender is not None:
        return _global_recommender
    with _global_recommender_lock:
        if _global_recommender is not None:
            return _global_recommender
        _global_recommender = PathRecommender()
    return _global_recommender


def reset_global_recommender() -> None:
    """重置全局单例（仅供测试使用）"""
    global _global_recommender
    with _global_recommender_lock:
        _global_recommender = None


# ============================================================================
# JSON-RPC 方法注册
# ============================================================================


def register_methods(dispatcher: Any) -> None:
    """向 JSON-RPC dispatcher 注册 path.* 方法

    注册的方法：
    - path.recommend: 基于用户历史 + 当前主题生成学习路径
    """

    def _recommend(
        user_history: list[str] | None = None,
        current_topic: str = "",
        limit: int = _DEFAULT_LIMIT,
    ) -> dict[str, Any]:
        """生成学习路径

        Args:
            user_history: 用户历史问题/主题列表
            current_topic: 当前主题
            limit: 最多返回步骤数（默认 5）

        Returns:
            {topic, difficulty, steps, total, user_history_count}
        """
        try:
            recommender: PathRecommender = get_global_recommender()
            return recommender.recommend(
                user_history=user_history,
                current_topic=current_topic,
                limit=limit,
            )
        except Exception as e:
            logger.exception(f"path.recommend failed: {e}")
            return {
                "topic": current_topic or "",
                "difficulty": _DIFFICULTY_BEGINNER,
                "steps": [],
                "total": 0,
                "user_history_count": 0,
                "error": str(e),
            }

    dispatcher.register("path.recommend", _recommend)
    logger.info("path.* methods registered (1 method: path.recommend)")
