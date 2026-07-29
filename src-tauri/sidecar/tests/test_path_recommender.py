"""
tests/test_path_recommender.py — 学习路径推荐单元测试（T-P3-09 验证）
=================================================================

验证内容：
1. PathRecommender 创建 + 默认参数
2. recommend：空历史 + 主题 → beginner + fallback 模板
3. recommend：2-4 历史 → intermediate
4. recommend：5+ 历史 → advanced
5. recommend：空主题 → 空步骤
6. recommend：FTS5 命中 → 步骤基于真实条目
7. recommend：k8s 关键词提升难度
8. _build_steps_from_entries：按 source 分组 + 优先级排序
9. get_global_recommender 单例
10. register_methods：path.recommend 注册 + 调用

运行：
    cd python-sidecar
    python -m pytest tests/test_path_recommender.py -v
"""

from __future__ import annotations

import sys
from pathlib import Path

# 确保能 import knowledge 模块
sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

from knowledge.path_recommender import (
    PathRecommender,
    get_global_recommender,
    reset_global_recommender,
    register_methods,
    _FALLBACK_PATH,
    _DIFFICULTY_BEGINNER,
    _DIFFICULTY_INTERMEDIATE,
    _DIFFICULTY_ADVANCED,
    _DEFAULT_LIMIT,
)


# ============================================================================
# Mock 对象 — 用于隔离 FTS5 / Vector 全局单例
# ============================================================================


class MockFTS5Index:
    """Mock FTS5 索引（返回预设的检索结果）"""

    def __init__(self, results: list[dict] | None = None) -> None:
        self._results: list[dict] = results or []

    def search(self, query: str, limit: int = 10, source: str | None = None) -> list[dict]:
        return self._results[:limit]


class MockVectorIndex:
    """Mock Vector 索引（返回预设的检索结果）"""

    def __init__(self, results: list[dict] | None = None) -> None:
        self._results: list[dict] = results or []

    def search(self, query_embedding: list[float], limit: int = 10, **kwargs) -> list[dict]:
        return self._results[:limit]


class MockDispatcher:
    """Mock JSON-RPC dispatcher（记录注册的方法）"""

    def __init__(self) -> None:
        self.methods: dict[str, callable] = {}

    def register(self, name: str, fn: callable) -> None:
        self.methods[name] = fn


# ============================================================================
# Fixtures
# ============================================================================


@pytest.fixture
def recommender() -> PathRecommender:
    """独立 PathRecommender 实例（不依赖全局单例）"""
    return PathRecommender()


@pytest.fixture
def fts_results() -> list[dict]:
    """FTS5 检索结果样本（3 条不同 source）"""
    return [
        {
            "id": "entry-001",
            "source": "nginx-docs",
            "title": "nginx 启动失败排查",
            "content": "nginx 启动失败的常见原因：端口被占用、配置文件语法错误、权限不足",
            "url": "https://nginx.org/docs/",
            "tags": ["nginx", "运维"],
            "score": 0.95,
        },
        {
            "id": "entry-002",
            "source": "systemd-docs",
            "title": "systemd 服务管理",
            "content": "使用 systemctl start/stop/restart 管理 nginx 等 systemd 服务",
            "url": "https://systemd.io/docs/",
            "tags": ["systemd", "服务管理"],
            "score": 0.82,
        },
        {
            "id": "entry-003",
            "source": "user-note",
            "title": "用户笔记：nginx 实战经验",
            "content": "记录实际部署 nginx 时遇到的问题和解决方案",
            "url": "",
            "tags": ["nginx", "笔记"],
            "score": 0.71,
        },
    ]


@pytest.fixture
def vec_results() -> list[dict]:
    """Vector 检索结果样本（2 条，1 条与 FTS5 重复以验证去重）"""
    return [
        {
            "id": "entry-001",  # 与 FTS5 重复 → 应被去重
            "source": "nginx-docs",
            "title": "nginx 启动失败排查",
            "content": "（重复条目）",
            "url": "https://nginx.org/docs/",
            "tags": ["nginx"],
            "score": 0.88,
        },
        {
            "id": "entry-004",
            "source": "docker-docs",
            "title": "Docker 容器中运行 nginx",
            "content": "使用 docker run -p 80:80 nginx 部署 nginx 容器",
            "url": "https://docker.com/docs/",
            "tags": ["docker", "nginx"],
            "score": 0.79,
        },
    ]


@pytest.fixture
def patched_index(monkeypatch, fts_results, vec_results):
    """patch 全局 FTS5 + Vector 单例返回 mock 结果"""
    mock_fts: MockFTS5Index = MockFTS5Index(results=fts_results)
    mock_vec: MockVectorIndex = MockVectorIndex(results=vec_results)

    # path_recommender 通过 from knowledge.fts5 import get_global_index 引入
    # 需 patch 模块级引用
    import knowledge.path_recommender as pr_module

    monkeypatch.setattr(pr_module, "get_global_index", lambda: mock_fts)
    monkeypatch.setattr(pr_module, "get_global_vector", lambda: mock_vec)
    # generate_embedding 也要 patch 避免依赖 sentence-transformers
    monkeypatch.setattr(pr_module, "generate_embedding", lambda text: [0.0] * 128)
    return mock_fts, mock_vec


@pytest.fixture
def empty_patched_index(monkeypatch):
    """patch 全局 FTS5 + Vector 返回空结果（测试 fallback 路径）"""
    mock_fts: MockFTS5Index = MockFTS5Index(results=[])
    mock_vec: MockVectorIndex = MockVectorIndex(results=[])

    import knowledge.path_recommender as pr_module

    monkeypatch.setattr(pr_module, "get_global_index", lambda: mock_fts)
    monkeypatch.setattr(pr_module, "get_global_vector", lambda: mock_vec)
    monkeypatch.setattr(pr_module, "generate_embedding", lambda text: [0.0] * 128)


# ============================================================================
# 1. PathRecommender 创建 + 基础测试
# ============================================================================


class TestRecommenderCreation:
    """PathRecommender 创建测试"""

    def test_recommender_creation(self, recommender: PathRecommender):
        """PathRecommender 创建成功"""
        assert recommender is not None
        assert hasattr(recommender, "recommend")
        assert hasattr(recommender, "_assess_difficulty")
        assert hasattr(recommender, "_retrieve_knowledge")
        assert hasattr(recommender, "_build_steps_from_entries")

    def test_get_global_recommender_singleton(self):
        """get_global_recommender 返回单例"""
        reset_global_recommender()
        r1: PathRecommender = get_global_recommender()
        r2: PathRecommender = get_global_recommender()
        assert r1 is r2
        reset_global_recommender()


# ============================================================================
# 2. 难度评估测试
# ============================================================================


class TestAssessDifficulty:
    """难度评估测试"""

    def test_beginner_with_empty_history(self, recommender: PathRecommender):
        """0 历史 → beginner"""
        assert recommender._assess_difficulty(0, "linux") == _DIFFICULTY_BEGINNER

    def test_beginner_with_one_history(self, recommender: PathRecommender):
        """1 历史 → beginner"""
        assert recommender._assess_difficulty(1, "nginx") == _DIFFICULTY_BEGINNER

    def test_intermediate_with_two_history(self, recommender: PathRecommender):
        """2 历史 → intermediate"""
        assert recommender._assess_difficulty(2, "nginx") == _DIFFICULTY_INTERMEDIATE

    def test_intermediate_with_four_history(self, recommender: PathRecommender):
        """4 历史 → intermediate"""
        assert recommender._assess_difficulty(4, "nginx") == _DIFFICULTY_INTERMEDIATE

    def test_advanced_with_five_history(self, recommender: PathRecommender):
        """5+ 历史 → advanced"""
        assert recommender._assess_difficulty(5, "nginx") == _DIFFICULTY_ADVANCED
        assert recommender._assess_difficulty(10, "nginx") == _DIFFICULTY_ADVANCED

    def test_beginner_bumped_to_intermediate_by_k8s_keyword(
        self, recommender: PathRecommender
    ):
        """beginner + k8s 关键词 → 提升至 intermediate"""
        # 0 历史 + k8s 主题 → beginner 提升为 intermediate
        result: str = recommender._assess_difficulty(0, "k8s 集群部署")
        assert result == _DIFFICULTY_INTERMEDIATE

    def test_beginner_bumped_by_selinux_keyword(self, recommender: PathRecommender):
        """beginner + selinux 关键词 → 提升至 intermediate"""
        result: str = recommender._assess_difficulty(1, "SELinux 策略配置")
        assert result == _DIFFICULTY_INTERMEDIATE

    def test_intermediate_not_bumped_by_keyword(self, recommender: PathRecommender):
        """intermediate + 关键词 → 不变（只提升 beginner）"""
        # 3 历史 + k8s 主题 → intermediate（不提升为 advanced）
        result: str = recommender._assess_difficulty(3, "k8s 部署")
        assert result == _DIFFICULTY_INTERMEDIATE


# ============================================================================
# 3. recommend 主接口测试
# ============================================================================


class TestRecommend:
    """recommend 主接口测试"""

    def test_recommend_empty_topic_returns_empty_steps(
        self,
        recommender: PathRecommender,
        empty_patched_index,
    ):
        """空主题 → 返回空步骤列表"""
        result: dict = recommender.recommend(
            user_history=[],
            current_topic="",
        )
        assert result["topic"] == ""
        assert result["difficulty"] == _DIFFICULTY_BEGINNER
        assert result["steps"] == []
        assert result["total"] == 0
        assert result["user_history_count"] == 0

    def test_recommend_with_no_knowledge_uses_fallback(
        self,
        recommender: PathRecommender,
        empty_patched_index,
    ):
        """知识库无结果 → 使用 fallback 模板"""
        result: dict = recommender.recommend(
            user_history=[],
            current_topic="linux 基础",
            limit=5,
        )
        assert result["topic"] == "linux 基础"
        assert result["difficulty"] == _DIFFICULTY_BEGINNER
        # 应使用 fallback 模板（5 条）
        assert result["total"] == 5
        assert len(result["steps"]) == 5
        # 步骤应为 fallback 模板
        for i, step in enumerate(result["steps"], start=1):
            assert step["step_index"] == i
            assert step["source"] == "builtin"
        # 验证 fallback 标题
        assert result["steps"][0]["title"] == _FALLBACK_PATH[0]["title"]

    def test_recommend_with_fts_results_builds_steps_from_entries(
        self,
        recommender: PathRecommender,
        patched_index,
    ):
        """FTS5 命中 → 步骤基于真实条目生成"""
        result: dict = recommender.recommend(
            user_history=[],
            current_topic="nginx 启动失败",
            limit=5,
        )
        assert result["topic"] == "nginx 启动失败"
        assert result["difficulty"] == _DIFFICULTY_BEGINNER  # 0 历史
        # 应有 3 条来自 mock 数据（去重后：3 FTS5 + 1 Vector = 4，但 limit=5 → 4 条）
        # 但 _build_steps_from_entries 按 source 分组，应保留 4 个不同 source
        assert result["total"] >= 3
        # 第一个步骤应为 nginx-docs（_SOURCE_PRIORITY 中最靠前）
        sources: list[str] = [s["source"] for s in result["steps"]]
        assert "nginx-docs" in sources
        # 验证步骤结构
        step: dict = result["steps"][0]
        assert "title" in step
        assert "source" in step
        assert "snippet" in step
        assert "url" in step
        assert "step_index" in step
        assert step["step_index"] == 1

    def test_recommend_intermediate_with_two_history(
        self,
        recommender: PathRecommender,
        empty_patched_index,
    ):
        """2 历史 → intermediate 难度"""
        result: dict = recommender.recommend(
            user_history=["nginx 配置", "docker 部署"],
            current_topic="k8s 入门",
        )
        assert result["difficulty"] == _DIFFICULTY_INTERMEDIATE
        assert result["user_history_count"] == 2

    def test_recommend_advanced_with_five_history(
        self,
        recommender: PathRecommender,
        empty_patched_index,
    ):
        """5 历史 → advanced 难度"""
        result: dict = recommender.recommend(
            user_history=["a", "b", "c", "d", "e"],
            current_topic="linux 性能调优",
        )
        assert result["difficulty"] == _DIFFICULTY_ADVANCED
        assert result["user_history_count"] == 5

    def test_recommend_limit_truncates_steps(
        self,
        recommender: PathRecommender,
        empty_patched_index,
    ):
        """limit 参数限制返回步骤数"""
        result: dict = recommender.recommend(
            user_history=[],
            current_topic="linux 基础",
            limit=3,
        )
        # fallback 模板有 5 条，limit=3 应只返回 3 条
        assert result["total"] == 3
        assert len(result["steps"]) == 3
        # step_index 应为 1, 2, 3
        for i, step in enumerate(result["steps"], start=1):
            assert step["step_index"] == i

    def test_recommend_strips_topic_whitespace(
        self,
        recommender: PathRecommender,
        empty_patched_index,
    ):
        """主题前后空白被 strip"""
        result: dict = recommender.recommend(
            user_history=[],
            current_topic="   nginx 配置   ",
        )
        assert result["topic"] == "nginx 配置"


# ============================================================================
# 4. _build_steps_from_entries 测试
# ============================================================================


class TestBuildSteps:
    """_build_steps_from_entries 步骤生成测试"""

    def test_build_steps_groups_by_source(
        self,
        recommender: PathRecommender,
        fts_results,
    ):
        """同 source 多条目 → 每组只保留 1 条（最高 score）"""
        # 复制 nginx-docs 条目，分数较低
        duplicate: dict = {
            "id": "entry-001-dup",
            "source": "nginx-docs",
            "title": "nginx 备用条目",
            "content": "低分条目",
            "url": "",
            "score": 0.50,
        }
        entries: list[dict] = fts_results + [duplicate]
        steps: list[dict] = recommender._build_steps_from_entries(entries, limit=5)
        # nginx-docs 只出现一次（保留高分 0.95 的）
        nginx_steps: list[dict] = [s for s in steps if s["source"] == "nginx-docs"]
        assert len(nginx_steps) == 1
        assert nginx_steps[0]["title"] == "nginx 启动失败排查"

    def test_build_steps_sorts_by_source_priority(
        self,
        recommender: PathRecommender,
        fts_results,
    ):
        """步骤按 _SOURCE_PRIORITY 排序（nginx-docs 在前）"""
        # 调换 fts_results 顺序（user-note 在前）
        reversed_entries: list[dict] = list(reversed(fts_results))
        steps: list[dict] = recommender._build_steps_from_entries(reversed_entries, limit=5)
        # 第一个应是 nginx-docs（_SOURCE_PRIORITY 索引 0）
        assert steps[0]["source"] == "nginx-docs"

    def test_build_steps_generates_step_index(
        self,
        recommender: PathRecommender,
        fts_results,
    ):
        """step_index 从 1 开始递增"""
        steps: list[dict] = recommender._build_steps_from_entries(fts_results, limit=5)
        for i, step in enumerate(steps, start=1):
            assert step["step_index"] == i

    def test_build_steps_truncates_by_limit(
        self,
        recommender: PathRecommender,
        fts_results,
    ):
        """limit 截断步骤数"""
        steps: list[dict] = recommender._build_steps_from_entries(fts_results, limit=2)
        assert len(steps) == 2
        assert steps[0]["step_index"] == 1
        assert steps[1]["step_index"] == 2

    def test_build_steps_snippet_truncates_long_content(
        self,
        recommender: PathRecommender,
    ):
        """content 超过 200 字符 → snippet 截断到 200"""
        long_content: str = "x" * 500
        entries: list[dict] = [
            {
                "id": "long-001",
                "source": "nginx-docs",
                "title": "长内容条目",
                "content": long_content,
                "url": "",
                "score": 0.9,
            }
        ]
        steps: list[dict] = recommender._build_steps_from_entries(entries, limit=5)
        assert len(steps) == 1
        assert len(steps[0]["snippet"]) == 200


# ============================================================================
# 5. _retrieve_knowledge 测试
# ============================================================================


class TestRetrieveKnowledge:
    """_retrieve_knowledge 检索测试"""

    def test_retrieve_merges_fts_and_vector(
        self,
        recommender: PathRecommender,
        patched_index,
    ):
        """FTS5 + Vector 合并去重"""
        # mock: fts_results 3 条 + vec_results 2 条（1 条重复）
        # 合并去重后应 4 条（3 + 1）
        results: list[dict] = recommender._retrieve_knowledge("nginx", limit=10)
        ids: list[str] = [r["id"] for r in results]
        # 去重：entry-001 只出现一次
        assert ids.count("entry-001") == 1
        # 应包含 entry-004（仅 Vector）
        assert "entry-004" in ids

    def test_retrieve_empty_topic_returns_empty(
        self,
        recommender: PathRecommender,
        patched_index,
    ):
        """空主题 → 空结果"""
        results: list[dict] = recommender._retrieve_knowledge("", limit=10)
        assert results == []

    def test_retrieve_fts_failure_falls_back_to_vector(
        self,
        recommender: PathRecommender,
        monkeypatch,
        vec_results,
    ):
        """FTS5 抛异常 → 仅返回 Vector 结果（不阻塞）"""
        mock_vec: MockVectorIndex = MockVectorIndex(results=vec_results)
        import knowledge.path_recommender as pr_module

        # FTS5 抛异常
        def _raise() -> None:
            raise RuntimeError("FTS5 unavailable")

        monkeypatch.setattr(pr_module, "get_global_index", _raise)
        monkeypatch.setattr(pr_module, "get_global_vector", lambda: mock_vec)
        monkeypatch.setattr(pr_module, "generate_embedding", lambda text: [0.0] * 128)

        results: list[dict] = recommender._retrieve_knowledge("nginx", limit=10)
        # 仅 Vector 结果（2 条）
        assert len(results) == 2
        # 全部标记为 vector
        for r in results:
            assert r["match_type"] == "vector"


# ============================================================================
# 6. JSON-RPC 注册测试
# ============================================================================


class TestRegisterMethods:
    """JSON-RPC 方法注册测试"""

    def test_register_methods_registers_path_recommend(self):
        """register_methods 注册 path.recommend"""
        dispatcher: MockDispatcher = MockDispatcher()
        register_methods(dispatcher)
        assert "path.recommend" in dispatcher.methods
        assert callable(dispatcher.methods["path.recommend"])

    def test_path_recommend_rpc_returns_valid_structure(
        self,
        empty_patched_index,
    ):
        """path.recommend RPC 调用返回合法结构"""
        dispatcher: MockDispatcher = MockDispatcher()
        register_methods(dispatcher)
        result: dict = dispatcher.methods["path.recommend"](
            user_history=[],
            current_topic="linux 基础",
            limit=5,
        )
        # 验证返回结构
        assert "topic" in result
        assert "difficulty" in result
        assert "steps" in result
        assert "total" in result
        assert "user_history_count" in result
        assert result["topic"] == "linux 基础"
        assert result["difficulty"] == _DIFFICULTY_BEGINNER
        assert isinstance(result["steps"], list)

    def test_path_recommend_rpc_handles_exception(
        self,
        monkeypatch,
    ):
        """path.recommend RPC 异常时返回 fallback 结构"""
        # patch get_global_recommender 抛异常
        import knowledge.path_recommender as pr_module

        def _raise() -> None:
            raise RuntimeError("recommender unavailable")

        monkeypatch.setattr(pr_module, "get_global_recommender", _raise)

        dispatcher: MockDispatcher = MockDispatcher()
        register_methods(dispatcher)
        result: dict = dispatcher.methods["path.recommend"](
            user_history=[],
            current_topic="test",
        )
        # 异常时返回空结构 + error 字段
        assert result["topic"] == "test"
        assert result["difficulty"] == _DIFFICULTY_BEGINNER
        assert result["steps"] == []
        assert result["total"] == 0
        assert "error" in result
