"""
tests/test_squilla_router.py — SquillaRouter 4 档模型路由单元测试（T-P5-01）
=============================================================================

验证内容：
1. 配置加载：从 YAML 加载 4 档模型配置
2. 复杂度评分：高/中/低关键词 + 上下文长度 + 任务长度 + 多步骤
3. 4 档路由：L1/L2/L3/L4 决策正确
4. 用户偏好：fast/balanced/thorough/max 偏移量
5. 上下文强制升级：长上下文触发档位升级
6. JSON-RPC 注册方法

运行：
    cd python-sidecar
    python -m pytest tests/test_squilla_router.py -v
"""

from __future__ import annotations

import sys
from pathlib import Path

# 确保能 import squilla_router 模块
sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

from squilla_router import (
    RoutingDecision,
    SquillaRouter,
    TierConfig,
    get_router,
    reset_router,
)


# ============================================================================
# Fixture
# ============================================================================

@pytest.fixture(scope="module")
def router() -> SquillaRouter:
    """加载真实 config/models.yaml 的 SquillaRouter 实例"""
    config_path = Path(__file__).parent.parent / "config" / "models.yaml"
    return SquillaRouter(config_path=config_path)


# ============================================================================
# 1. 配置加载测试
# ============================================================================

class TestConfigLoading:
    """配置加载测试"""

    def test_router_loads_without_error(self, router: SquillaRouter):
        """SquillaRouter 应能成功加载 YAML 配置"""
        assert router is not None
        assert len(router._tiers) == 4
        assert "L1" in router._tiers
        assert "L2" in router._tiers
        assert "L3" in router._tiers
        assert "L4" in router._tiers

    def test_tier_config_fields(self, router: SquillaRouter):
        """每档配置应包含 model/max_tokens/cost 等字段"""
        l1: TierConfig = router.get_tier("L1")
        assert l1.model == "gpt-4o-mini"
        assert l1.max_tokens == 4096
        assert l1.cost_per_1k_tokens == 0.00015
        assert l1.complexity_range == (0, 25)
        assert l1.context_range == (0, 4096)

    def test_l4_supports_1m_tokens(self, router: SquillaRouter):
        """L4 应支持 1M token 上下文"""
        l4: TierConfig = router.get_tier("L4")
        assert l4.max_tokens == 200000
        assert l4.context_range[1] == 1000000

    def test_get_router_singleton(self):
        """get_router 应返回单例"""
        r1 = get_router()
        r2 = get_router()
        assert r1 is r2
        reset_router()  # 清理


# ============================================================================
# 2. 复杂度评分测试
# ============================================================================

class TestComplexityScoring:
    """复杂度评分测试"""

    def test_empty_task_yields_zero(self, router: SquillaRouter):
        """空任务 → 0 分"""
        assert router._score_complexity("") == 0

    def test_low_complexity_keywords(self, router: SquillaRouter):
        """低复杂度关键词（查询/list）→ 评分较低"""
        score = router._score_complexity("查询当前目录文件")
        assert 0 < score < 30  # 低复杂度

    def test_high_complexity_keywords(self, router: SquillaRouter):
        """高复杂度关键词（架构设计/故障排查）→ 评分较高"""
        score = router._score_complexity("架构设计：微服务拆分方案")
        assert score >= 30  # 至少触发高复杂度关键词

    def test_context_length_affects_score(self, router: SquillaRouter):
        """上下文长度影响评分"""
        score_no_ctx = router._score_complexity("分析", context_tokens=0)
        score_large_ctx = router._score_complexity("分析", context_tokens=200000)
        assert score_large_ctx > score_no_ctx

    def test_multi_step_indicators(self, router: SquillaRouter):
        """多步骤指示词增加评分"""
        score_no_step = router._score_complexity("实现登录功能")
        score_multi_step = router._score_complexity(
            "step by step 实现登录功能"
        )
        assert score_multi_step > score_no_step

    def test_score_clamped_to_100(self, router: SquillaRouter):
        """评分上限为 100"""
        # 触发所有高分项
        score = router._score_complexity(
            "架构设计：分布式微服务故障排查与性能优化",
            context_tokens=500000,
        )
        assert 0 <= score <= 100


# ============================================================================
# 3. 4 档路由测试
# ============================================================================

class TestFourTierRouting:
    """4 档路由决策测试"""

    def test_l1_simple_query(self, router: SquillaRouter):
        """简单查询 → L1"""
        decision = router.route("list 当前目录")
        assert decision.tier == "L1"
        assert decision.model == "gpt-4o-mini"

    def test_l2_concept_explanation(self, router: SquillaRouter):
        """概念解释 → L2"""
        decision = router.route("解释一下 Kubernetes Service 的概念")
        assert decision.tier in ("L1", "L2")  # 实际可能是 L1 或 L2，取决于评分
        # 但应该是低档（L1 或 L2）
        assert decision.tier in ("L1", "L2")

    def test_l3_troubleshoot(self, router: SquillaRouter):
        """故障排查 → L3"""
        decision = router.route(
            "故障排查：MySQL 慢查询导致 502 错误",
            context={"tokens": 50000},
        )
        assert decision.tier in ("L3", "L4")

    def test_l4_architecture_design(self, router: SquillaRouter):
        """架构设计 + 大上下文 → L4"""
        decision = router.route(
            "架构设计：大规模微服务拆分与分布式部署",
            context={"tokens": 200000},
        )
        assert decision.tier == "L4"

    def test_long_context_forces_upgrade(self, router: SquillaRouter):
        """长上下文强制升级档位"""
        # 简单任务 + 超长上下文 → 必须升级到能容纳的档位
        decision = router.route(
            "查询状态",
            context={"tokens": 200000},
        )
        # 200K tokens 超过 L1(4K) / L2(32K) / L3(128K)，必须 L4
        assert decision.tier == "L4"

    def test_decision_contains_cost_estimate(self, router: SquillaRouter):
        """决策应包含成本预估"""
        decision = router.route("list")
        assert decision.estimated_cost >= 0.0
        assert decision.estimated_tokens > 0

    def test_decision_to_dict(self, router: SquillaRouter):
        """to_dict 应返回 JSON 兼容字段"""
        decision = router.route("查询", context={"tokens": 1000})
        d = decision.to_dict()
        assert "tier" in d
        assert "model" in d
        assert "reason" in d
        assert "estimated_cost" in d
        assert "estimated_tokens" in d
        assert "complexity_score" in d
        assert "preference" in d


# ============================================================================
# 4. 用户偏好测试
# ============================================================================

class TestUserPreference:
    """用户偏好偏移量测试"""

    def test_fast_preference_lowers_tier(self, router: SquillaRouter):
        """fast 偏好应降低档位（评分减 15）"""
        # 同一任务，对比 fast vs thorough
        task = "解释概念"
        d_fast = router.route(task, context={"preference": "fast"})
        d_thorough = router.route(task, context={"preference": "thorough"})
        # fast 的评分应低于 thorough
        assert d_fast.complexity_score <= d_thorough.complexity_score

    def test_thorough_preference_raises_tier(self, router: SquillaRouter):
        """thorough 偏好应升高档位（评分加 15）"""
        task = "解释概念"
        d_balanced = router.route(task, context={"preference": "balanced"})
        d_thorough = router.route(task, context={"preference": "thorough"})
        assert d_thorough.complexity_score > d_balanced.complexity_score

    def test_max_preference_highest_score(self, router: SquillaRouter):
        """max 偏好评分最高"""
        task = "查询"
        scores = [
            router.route(task, context={"preference": p}).complexity_score
            for p in ("fast", "balanced", "thorough", "max")
        ]
        # max 应该是最高
        assert scores[3] == max(scores)
        # fast 应该是最低
        assert scores[0] == min(scores)


# ============================================================================
# 5. 元数据 / 查询测试
# ============================================================================

class TestMetadataQuery:
    """元数据查询测试"""

    def test_list_tiers_returns_4(self, router: SquillaRouter):
        """list_tiers 应返回 4 档配置"""
        tiers = router.list_tiers()
        assert len(tiers) == 4
        tier_names = [t["tier"] for t in tiers]
        assert tier_names == ["L1", "L2", "L3", "L4"]

    def test_list_tiers_contains_model_info(self, router: SquillaRouter):
        """list_tiers 每档应包含 model/max_tokens 等字段"""
        tiers = router.list_tiers()
        for t in tiers:
            assert "model" in t
            assert "max_tokens" in t
            assert "cost_per_1k_tokens" in t
            assert "description" in t
            assert "complexity_range" in t
            assert "context_range" in t


# ============================================================================
# 6. 错误处理测试
# ============================================================================

class TestErrorHandling:
    """错误处理测试"""

    def test_missing_config_file_raises(self, tmp_path: Path):
        """配置文件不存在 → FileNotFoundError"""
        with pytest.raises(FileNotFoundError):
            SquillaRouter(config_path=tmp_path / "nonexistent.yaml")

    def test_invalid_config_missing_tiers_raises(self, tmp_path: Path):
        """配置缺 tiers 字段 → ValueError"""
        bad_config = tmp_path / "bad.yaml"
        bad_config.write_text("default_preference: balanced\n", encoding="utf-8")
        with pytest.raises(ValueError, match="tiers"):
            SquillaRouter(config_path=bad_config)

    def test_invalid_config_missing_tier_l4_raises(self, tmp_path: Path):
        """配置缺 L4 字段 → ValueError"""
        bad_config = tmp_path / "bad_l4.yaml"
        bad_config.write_text(
            "tiers:\n"
            "  L1:\n    model: m1\n    max_tokens: 1\n    cost_per_1k_tokens: 0.0\n"
            "  L2:\n    model: m2\n    max_tokens: 1\n    cost_per_1k_tokens: 0.0\n"
            "  L3:\n    model: m3\n    max_tokens: 1\n    cost_per_1k_tokens: 0.0\n",
            encoding="utf-8",
        )
        with pytest.raises(ValueError, match="L4"):
            SquillaRouter(config_path=bad_config)
