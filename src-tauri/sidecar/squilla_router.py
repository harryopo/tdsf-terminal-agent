"""
squilla_router.py — SquillaRouter 4 档模型路由（T-P5-01, DEC-V32-01）
========================================================================

职责：
- 4 档模型路由（L1 快速 / L2 标准 / L3 推理 / L4 推理+）
- 基于任务复杂度评分（0-100）+ 上下文长度 + 用户偏好，决策使用哪档模型
- 支持 YAML 自定义模型配置（config/models.yaml）

4 档说明：
- L1 快速档：简单任务（如查询命令）→ 小模型（gpt-4o-mini）
- L2 标准档：常规任务（如解释概念）→ 中模型（gpt-4o）
- L3 推理档：复杂任务（如故障排查）→ 大模型（o1-preview）
- L4 推理+档：超复杂任务（如架构设计）→ 超大模型（o1-mini, 1M Token）

路由策略：
1. _score_complexity(task) → 0-100 评分
   - 关键词匹配（30 分）：架构设计/故障排查等关键词
   - 上下文长度（30 分）：上下文越长评分越高
   - 任务文本长度（20 分）：任务描述越长评分越高
   - 多步骤指示词（20 分）：含 "step by step" / "逐步" 等
2. 应用用户偏好偏移量（fast -15 / balanced 0 / thorough +15 / max +30）
3. _select_tier(score, ctx_len, preference) → L1/L2/L3/L4
   - 同时考虑复杂度评分 + 上下文长度（任一超过档位上限就升级）

JSON-RPC 方法（main.py 注册）：
- squilla.route: 路由决策
- squilla.list_tiers: 列出 4 档配置
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

import yaml

logger = logging.getLogger("sidecar.squilla_router")


# ============================================================
# 常量与类型
# ============================================================

# 4 档名称
Tier = Literal["L1", "L2", "L3", "L4"]

# 用户偏好
Preference = Literal["fast", "balanced", "thorough", "max"]

# 默认配置文件路径（python-sidecar/config/models.yaml）
_DEFAULT_CONFIG_PATH: Path = Path(__file__).parent / "config" / "models.yaml"

# 复杂度评分上限
_MAX_COMPLEXITY_SCORE: int = 100

# 关键词 → 复杂度评分增量（用于 _score_complexity 关键词匹配阶段）
# 高复杂度关键词（架构设计 / 故障排查 / 大规模重构 / 跨系统）
_HIGH_COMPLEXITY_KEYWORDS: list[str] = [
    "架构设计", "architecture", "design pattern", "重构", "refactor",
    "故障排查", "troubleshoot", "root cause", "根因分析", "debug",
    "性能优化", "optimize", "调优", "tuning",
    "跨系统", "分布式", "distributed", "微服务", "microservice",
]

# 中复杂度关键词（解释概念 / 配置修改 / 代码生成）
_MEDIUM_COMPLEXITY_KEYWORDS: list[str] = [
    "解释", "explain", "概念", "concept",
    "配置", "config", "修改", "modify",
    "生成", "generate", "实现", "implement",
    "分析", "analyze", "评估", "evaluate",
]

# 低复杂度关键词（查询 / 列出 / 显示）
_LOW_COMPLEXITY_KEYWORDS: list[str] = [
    "查询", "query", "list", "列出", "显示", "show",
    "查看", "view", "cat", "what is", "什么是",
]

# 多步骤指示词
_MULTI_STEP_INDICATORS: list[str] = [
    "step by step", "逐步", "多步骤", "multi-step",
    "首先", "然后", "最后", "first", "then", "finally",
    "1.", "2.", "3.",  # 编号列表
]


# ============================================================
# 数据模型
# ============================================================


@dataclass
class TierConfig:
    """单档模型配置。

    Attributes:
        model: 模型名称（如 gpt-4o-mini）
        max_tokens: 最大 token 数
        cost_per_1k_tokens: 每 1K token 成本（USD）
        description: 档位描述
        complexity_range: 复杂度评分区间 [low, high]
        context_range: 上下文长度区间 [low, high]
    """

    model: str
    max_tokens: int
    cost_per_1k_tokens: float
    description: str
    complexity_range: tuple[int, int]
    context_range: tuple[int, int]


@dataclass
class RoutingDecision:
    """路由决策结果。

    Attributes:
        tier: 档位（L1/L2/L3/L4）
        model: 选中的模型名称
        reason: 决策理由（人类可读）
        estimated_cost: 预估成本（USD，基于 max_tokens × cost_per_1k）
        estimated_tokens: 预估 token 数
        complexity_score: 任务复杂度评分（0-100）
        preference: 用户偏好
    """

    tier: Tier
    model: str
    reason: str
    estimated_cost: float
    estimated_tokens: int
    complexity_score: int
    preference: Preference = "balanced"

    def to_dict(self) -> dict[str, Any]:
        """转为 JSON 兼容 dict（供 JSON-RPC 返回）"""
        return {
            "tier": self.tier,
            "model": self.model,
            "reason": self.reason,
            "estimated_cost": round(self.estimated_cost, 6),
            "estimated_tokens": self.estimated_tokens,
            "complexity_score": self.complexity_score,
            "preference": self.preference,
        }


# ============================================================
# SquillaRouter 主类
# ============================================================


class SquillaRouter:
    """SquillaRouter 4 档模型路由器。

    基于任务复杂度评分 + 上下文长度 + 用户偏好，决策使用哪档模型。

    用法：
        router = SquillaRouter()  # 加载默认 config/models.yaml
        decision = router.route("解释一下 Kubernetes 的 Service 概念")
        print(decision.tier, decision.model)  # L2 gpt-4o

        # 带上下文与偏好
        decision = router.route(
            task="架构设计：微服务拆分",
            context={"tokens": 200000, "preference": "thorough"},
        )
        # L4 o1-mini

    Args:
        config_path: YAML 配置文件路径。None 时使用默认 _DEFAULT_CONFIG_PATH
    """

    def __init__(self, config_path: Path | str | None = None) -> None:
        """初始化 SquillaRouter，加载 YAML 配置。

        Args:
            config_path: YAML 配置路径。None 时使用默认 config/models.yaml
        """
        path: Path = Path(config_path) if config_path else _DEFAULT_CONFIG_PATH
        self._config_path: Path = path
        self._tiers: dict[str, TierConfig] = {}
        self._preference_offset: dict[str, int] = {}
        self._default_preference: Preference = "balanced"
        self._complexity_weights: dict[str, int] = {}

        self._load_config(path)
        logger.info(
            f"SquillaRouter initialized: {len(self._tiers)} tiers, "
            f"default_preference={self._default_preference}"
        )

    # ----------------------------------------------------------
    # 配置加载
    # ----------------------------------------------------------

    def _load_config(self, path: Path) -> None:
        """从 YAML 加载 4 档配置 + 偏好偏移量 + 评分权重。

        Args:
            path: YAML 配置路径

        Raises:
            FileNotFoundError: 配置文件不存在
            ValueError: 配置格式错误（缺少 tiers 等）
        """
        if not path.exists():
            raise FileNotFoundError(f"squilla config not found: {path}")

        with open(path, encoding="utf-8") as f:
            raw: dict = yaml.safe_load(f) or {}

        if "tiers" not in raw:
            raise ValueError(f"invalid squilla config: 'tiers' missing in {path}")

        # 加载 4 档配置
        for tier_name in ("L1", "L2", "L3", "L4"):
            tier_raw: dict = raw["tiers"].get(tier_name)
            if not tier_raw:
                raise ValueError(f"tier {tier_name} missing in config")
            cr = tier_raw.get("complexity_range", [0, 0])
            ctxr = tier_raw.get("context_range", [0, 0])
            self._tiers[tier_name] = TierConfig(
                model=tier_raw["model"],
                max_tokens=tier_raw["max_tokens"],
                cost_per_1k_tokens=tier_raw["cost_per_1k_tokens"],
                description=tier_raw.get("description", ""),
                complexity_range=(int(cr[0]), int(cr[1])),
                context_range=(int(ctxr[0]), int(ctxr[1])),
            )

        # 加载偏好偏移量
        self._preference_offset = {
            k: int(v) for k, v in (raw.get("preference_offset") or {}).items()
        }
        if not self._preference_offset:
            # 默认值（与 YAML 中一致）
            self._preference_offset = {
                "fast": -15,
                "balanced": 0,
                "thorough": 15,
                "max": 30,
            }

        # 默认偏好
        self._default_preference = raw.get("default_preference", "balanced")  # type: ignore

        # 复杂度评分权重
        self._complexity_weights = {
            k: int(v) for k, v in (raw.get("complexity_weights") or {}).items()
        }
        if not self._complexity_weights:
            self._complexity_weights = {
                "keyword_match": 30,
                "context_length": 30,
                "task_length": 20,
                "multi_step": 20,
            }

    # ----------------------------------------------------------
    # 核心路由入口
    # ----------------------------------------------------------

    def route(self, task: str, context: dict[str, Any] | None = None) -> RoutingDecision:
        """对任务进行路由决策。

        流程：
        1. 计算任务复杂度评分（0-100）
        2. 应用用户偏好偏移量
        3. 综合上下文长度选择档位
        4. 构建 RoutingDecision（含成本预估）

        Args:
            task: 任务文本（用户输入）
            context: 上下文信息，支持字段：
                - tokens: 上下文 token 数（int，默认 0）
                - preference: 用户偏好（fast/balanced/thorough/max，默认 default_preference）

        Returns:
            RoutingDecision 路由决策
        """
        context = context or {}
        ctx_tokens: int = int(context.get("tokens", 0) or 0)
        preference: Preference = context.get("preference", self._default_preference)  # type: ignore

        # 1. 计算复杂度评分
        raw_score: int = self._score_complexity(task, ctx_tokens)

        # 2. 应用偏好偏移量
        offset: int = self._preference_offset.get(preference, 0)
        adjusted_score: int = max(0, min(_MAX_COMPLEXITY_SCORE, raw_score + offset))

        # 3. 选择档位
        tier: Tier = self._select_tier(adjusted_score, ctx_tokens, preference)

        # 4. 构建决策
        tier_cfg: TierConfig = self._tiers[tier]
        estimated_tokens: int = min(ctx_tokens + 1024, tier_cfg.max_tokens)
        estimated_cost: float = (estimated_tokens / 1000.0) * tier_cfg.cost_per_1k_tokens

        # 决策理由
        reasons: list[str] = []
        reasons.append(f"复杂度评分={raw_score}")
        if offset != 0:
            reasons.append(f"偏好({preference})偏移={offset:+d} → 调整后={adjusted_score}")
        if ctx_tokens > 0:
            reasons.append(f"上下文={ctx_tokens} tokens")
        reasons.append(f"匹配档位={tier}({tier_cfg.description})")

        return RoutingDecision(
            tier=tier,
            model=tier_cfg.model,
            reason="; ".join(reasons),
            estimated_cost=estimated_cost,
            estimated_tokens=estimated_tokens,
            complexity_score=adjusted_score,
            preference=preference,
        )

    # ----------------------------------------------------------
    # 复杂度评分
    # ----------------------------------------------------------

    def _score_complexity(self, task: str, context_tokens: int = 0) -> int:
        """计算任务复杂度评分（0-100）。

        评分维度（与 YAML 中 complexity_weights 对应）：
        - keyword_match (30 分)：高复杂度关键词 +30，中 +20，低 +5
        - context_length (30 分)：context_tokens 越大评分越高
        - task_length (20 分)：任务文本越长评分越高
        - multi_step (20 分)：含多步骤指示词 +20

        Args:
            task: 任务文本
            context_tokens: 上下文 token 数

        Returns:
            复杂度评分（0-100）
        """
        if not task:
            return 0

        task_lower: str = task.lower()

        # 1. 关键词匹配（最多 30 分）
        kw_score: int = 0
        if any(kw in task_lower for kw in _HIGH_COMPLEXITY_KEYWORDS):
            kw_score = self._complexity_weights.get("keyword_match", 30)
        elif any(kw in task_lower for kw in _MEDIUM_COMPLEXITY_KEYWORDS):
            kw_score = int(self._complexity_weights.get("keyword_match", 30) * 0.66)  # ~20
        elif any(kw in task_lower for kw in _LOW_COMPLEXITY_KEYWORDS):
            kw_score = int(self._complexity_weights.get("keyword_match", 30) * 0.17)  # ~5

        # 2. 上下文长度（最多 30 分）
        ctx_max: int = self._complexity_weights.get("context_length", 30)
        if context_tokens <= 0:
            ctx_score: int = 0
        elif context_tokens < 4096:
            ctx_score = int(ctx_max * 0.17)  # ~5
        elif context_tokens < 32768:
            ctx_score = int(ctx_max * 0.50)  # ~15
        elif context_tokens < 131072:
            ctx_score = int(ctx_max * 0.83)  # ~25
        else:
            ctx_score = ctx_max  # 30

        # 3. 任务文本长度（最多 20 分）
        tl_max: int = self._complexity_weights.get("task_length", 20)
        task_len: int = len(task)
        if task_len < 20:
            tl_score = int(tl_max * 0.25)  # ~5
        elif task_len < 100:
            tl_score = int(tl_max * 0.50)  # ~10
        elif task_len < 500:
            tl_score = int(tl_max * 0.75)  # ~15
        else:
            tl_score = tl_max  # 20

        # 4. 多步骤指示词（最多 20 分）
        ms_max: int = self._complexity_weights.get("multi_step", 20)
        ms_score: int = ms_max if any(ind in task_lower for ind in _MULTI_STEP_INDICATORS) else 0

        total: int = kw_score + ctx_score + tl_score + ms_score
        return max(0, min(_MAX_COMPLEXITY_SCORE, total))

    # ----------------------------------------------------------
    # 档位选择
    # ----------------------------------------------------------

    def _select_tier(self, score: int, ctx_tokens: int, preference: Preference) -> Tier:
        """根据评分 + 上下文长度 + 偏好选择档位。

        规则：
        1. 找到能容纳上下文的最小档位（min_tier_for_ctx）
           - 上下文 <= 该档 context_range 上限 → 该档可容纳
           - 上下文超过所有档位 context_range 上限 → 强制 L4
        2. 根据复杂度评分找到候选档位（score_tier）
        3. 取 max(min_tier_for_ctx, score_tier) 作为最终档位
           - 上下文强制升级时，档位不能低于 min_tier_for_ctx
           - 评分匹配的档位可以高于 min_tier_for_ctx

        Args:
            score: 复杂度评分（已应用偏好偏移）
            ctx_tokens: 上下文 token 数
            preference: 用户偏好

        Returns:
            档位字符串（L1/L2/L3/L4）
        """
        tier_order: tuple[str, ...] = ("L1", "L2", "L3", "L4")

        # 1. 找到能容纳上下文的最小档位
        min_tier_for_ctx: str = "L4"  # 兜底（上下文超过所有档位）
        for tier_name in tier_order:
            cfg: TierConfig = self._tiers[tier_name]
            if ctx_tokens <= cfg.context_range[1]:
                min_tier_for_ctx = tier_name
                break

        # 2. 根据评分找到候选档位
        score_tier: str | None = None
        for tier_name in tier_order:
            cfg = self._tiers[tier_name]
            if cfg.complexity_range[0] <= score <= cfg.complexity_range[1]:
                score_tier = tier_name
                break

        # 3. 兜底（评分超出所有区间）
        if score_tier is None:
            if score >= 75:
                score_tier = "L4"
            elif score >= 50:
                score_tier = "L3"
            elif score >= 25:
                score_tier = "L2"
            else:
                score_tier = "L1"

        # 4. 取 max(min_tier_for_ctx, score_tier)
        ctx_idx: int = tier_order.index(min_tier_for_ctx)
        score_idx: int = tier_order.index(score_tier)
        return tier_order[max(ctx_idx, score_idx)]  # type: ignore

    # ----------------------------------------------------------
    # 元数据 / 查询
    # ----------------------------------------------------------

    def list_tiers(self) -> list[dict[str, Any]]:
        """列出 4 档配置（供 JSON-RPC squilla.list_tiers）"""
        result: list[dict[str, Any]] = []
        for tier_name in ("L1", "L2", "L3", "L4"):
            cfg: TierConfig = self._tiers[tier_name]
            result.append({
                "tier": tier_name,
                "model": cfg.model,
                "max_tokens": cfg.max_tokens,
                "cost_per_1k_tokens": cfg.cost_per_1k_tokens,
                "description": cfg.description,
                "complexity_range": list(cfg.complexity_range),
                "context_range": list(cfg.context_range),
            })
        return result

    def get_tier(self, tier: Tier) -> TierConfig:
        """获取指定档位配置"""
        return self._tiers[tier]


# ============================================================
# 模块级单例（懒加载）
# ============================================================

_router_instance: SquillaRouter | None = None


def get_router() -> SquillaRouter:
    """获取全局 SquillaRouter 单例（懒加载）。

    Returns:
        SquillaRouter 实例（已加载 config/models.yaml）
    """
    global _router_instance
    if _router_instance is None:
        _router_instance = SquillaRouter()
    return _router_instance


def reset_router() -> None:
    """重置全局单例（仅供测试使用）"""
    global _router_instance
    _router_instance = None


# ============================================================
# JSON-RPC 方法注册
# ============================================================


def register_methods(dispatcher: Any) -> None:
    """向 JSON-RPC dispatcher 注册 squilla.* 方法

    注册的方法：
    - squilla.route:       路由决策
    - squilla.list_tiers:  列出 4 档配置
    """
    router: SquillaRouter = get_router()

    def _squilla_route(
        task: str,
        context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """JSON-RPC: squilla.route"""
        decision: RoutingDecision = router.route(task, context)
        return decision.to_dict()

    def _squilla_list_tiers() -> dict[str, Any]:
        """JSON-RPC: squilla.list_tiers"""
        return {"tiers": router.list_tiers()}

    dispatcher.register("squilla.route", _squilla_route)
    dispatcher.register("squilla.list_tiers", _squilla_list_tiers)
    logger.info("squilla.* methods registered (2 methods)")
