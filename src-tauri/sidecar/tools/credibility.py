"""
tools/credibility.py — 可信度评估 MCP tool（T-P1-07.5）
==========================================================

实现方案书 4.5 节的可信度评估体系：
- 来源评估（source credibility）：评估证据来源的可靠程度
- 时效评估（temporal credibility）：评估证据的新鲜度
- 一致性评估（consistency credibility）：评估证据与其他证据的一致程度

spec 要求：
- 输入：来源 + 时间戳 + 一致性数据
- 输出：``{"credibility": 0-1, "factors": {...}}``

实现要点：
1. **三维加权评估**：来源 × 时效 × 一致性 → 综合可信度
2. **来源先验表**：复用 ``core.schemas.SOURCE_PRIOR``（dmesg 0.95 / mysql 0.90 等）
3. **时效衰减**：使用指数衰减函数 ``e^(-Δt/τ)``，τ=24h（24 小时半衰期）
4. **一致性投票**：基于多数投票计算与其他证据的一致率
5. **可配置权重**：默认 source=0.4 / temporal=0.3 / consistency=0.3，可由调用方调整

输入格式（params）：
    {
        "source": "mysql/error.log",
        "timestamp": "2026-07-26T10:30:00",       # ISO 8601，可选
        "age_seconds": 3600,                       # 与 timestamp 二选一，秒数
        "consensus_count": 5,                      # 一致性：支持结论的证据数
        "dissenting_count": 1,                     # 一致性：反对结论的证据数
        "self_consistency": 0.85,                  # 自洽一致率（可选）
        "weights": {                               # 可选，权重覆盖
            "source": 0.5,
            "temporal": 0.2,
            "consistency": 0.3
        },
        "half_life_hours": 24.0                    # 可选，时效半衰期（小时）
    }

输出格式：
    {
        "credibility": 0.7823,
        "factors": {
            "source": 0.90,
            "temporal": 0.70,
            "consistency": 0.83
        },
        "weights": {
            "source": 0.4,
            "temporal": 0.3,
            "consistency": 0.3
        },
        "details": {
            "source_known": true,
            "age_seconds": 3600,
            "vote_ratio": 0.833
        }
    }

集成点：
- 被 DecisionEngine 调用评估历史案例可信度（success_rate 调整）
- 被 LangGraph tool_call 节点调用（tool_name == "credibility"）
- 输出 factors 可用于可信度归因（哪个维度拉低/拉高了综合分）
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from core.schemas import EvidenceSource, SOURCE_PRIOR

logger = logging.getLogger("sidecar.tools.credibility")


# ============================================================================
# 常量定义
# ============================================================================

# 默认权重（source / temporal / consistency 三维度）
_DEFAULT_WEIGHT_SOURCE: float = 0.4
_DEFAULT_WEIGHT_TEMPORAL: float = 0.3
_DEFAULT_WEIGHT_CONSISTENCY: float = 0.3

# 默认时效半衰期（24 小时）
_DEFAULT_HALF_LIFE_HOURS: float = 24.0

# 时效评估上限（超过 7 天视为过期，credibility 接近 0）
_MAX_AGE_HOURS: float = 168.0  # 7 * 24

# 未知来源的先验权重
_UNKNOWN_SOURCE_PRIOR: float = 0.50


# ============================================================================
# 内部计算函数
# ============================================================================


def _parse_evidence_source(source_str: str) -> EvidenceSource:
    """将字符串映射为 EvidenceSource 枚举（与 tools/confidence.py 共用逻辑）

    Args:
        source_str: 来源字符串

    Returns:
        EvidenceSource 枚举值，未知来源返回 UNKNOWN
    """
    if not source_str:
        return EvidenceSource.UNKNOWN

    try:
        return EvidenceSource(source_str)
    except ValueError:
        pass

    lower = source_str.lower()
    if "dmesg" in lower or "kernel" in lower:
        return EvidenceSource.DMESG
    if "mysql" in lower:
        return EvidenceSource.MYSQL_ERROR
    if "nginx" in lower:
        return EvidenceSource.NGINX_ERROR
    if "journalctl" in lower or "systemd" in lower:
        return EvidenceSource.JOURNALCTL
    if "syslog" in lower:
        return EvidenceSource.SYSLOG
    if "app" in lower and "log" in lower:
        return EvidenceSource.APP_LOG

    return EvidenceSource.UNKNOWN


def _evaluate_source(source_str: str) -> tuple[float, bool]:
    """来源评估

    基于 ``core.schemas.SOURCE_PRIOR`` 表返回来源先验权重。

    Args:
        source_str: 来源字符串

    Returns:
        (source_score, source_known) 元组
        - source_score: 来源可信度 [0, 1]
        - source_known: 是否为已知来源（True）或未知来源（False）
    """
    if not source_str:
        return _UNKNOWN_SOURCE_PRIOR, False

    source = _parse_evidence_source(source_str)
    if source == EvidenceSource.UNKNOWN:
        # 未知来源：根据字符串特征做启发式评估
        lower = source_str.lower()
        # 含路径分隔符或扩展名的，视为应用日志，给予中等可信度
        if "/" in source_str or "\\" in source_str or ".log" in lower:
            return 0.65, False
        return _UNKNOWN_SOURCE_PRIOR, False

    return SOURCE_PRIOR.get(source, _UNKNOWN_SOURCE_PRIOR), True


def _evaluate_temporal(
    age_seconds: float | None,
    timestamp_str: str | None,
    half_life_hours: float,
) -> tuple[float, float]:
    """时效评估

    使用指数衰减函数：``temporal_score = e^(-Δt/τ)``
    其中 ``Δt`` 是数据年龄（小时），``τ`` 是时间常数（与半衰期相关）。

    半衰期 ``T_half`` 与时间常数 ``τ`` 的关系：
    ``T_half = τ × ln(2)``，即 ``τ = T_half / ln(2)``

    Args:
        age_seconds: 数据年龄（秒），与 timestamp_str 二选一
        timestamp_str: 数据时间戳（ISO 8601），与 age_seconds 二选一
        half_life_hours: 半衰期（小时）

    Returns:
        (temporal_score, age_seconds) 元组
        - temporal_score: 时效可信度 [0, 1]
        - age_seconds: 实际计算使用的年龄（秒）
    """
    import math

    # 计算 age_seconds
    actual_age_seconds: float
    if age_seconds is not None:
        actual_age_seconds = float(age_seconds)
    elif timestamp_str is not None:
        try:
            # 解析 ISO 8601 时间戳
            ts = datetime.fromisoformat(timestamp_str.replace("Z", "+00:00"))
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            now = datetime.now(timezone.utc)
            actual_age_seconds = max(0.0, (now - ts).total_seconds())
        except (ValueError, TypeError) as e:
            logger.warning(f"_evaluate_temporal: invalid timestamp '{timestamp_str}': {e}")
            return 0.5, 0.0  # 无法解析时给中等分
    else:
        # 没有时间信息：给中等分（不惩罚也不奖励）
        return 0.5, 0.0

    # 负数年龄：视为 0（未来时间戳，可能是时钟漂移）
    if actual_age_seconds < 0:
        actual_age_seconds = 0.0

    age_hours = actual_age_seconds / 3600.0

    # 超过最大年龄：直接返回 0
    if age_hours >= _MAX_AGE_HOURS:
        return 0.0, actual_age_seconds

    # 指数衰减
    tau = half_life_hours / math.log(2)  # 时间常数
    temporal_score = math.exp(-age_hours / tau)

    # 钳位到 [0, 1]
    temporal_score = max(0.0, min(1.0, temporal_score))
    return round(temporal_score, 4), actual_age_seconds


def _evaluate_consistency(
    consensus_count: int,
    dissenting_count: int,
    self_consistency: float | None,
) -> tuple[float, float]:
    """一致性评估

    综合两个维度：
    1. **多数投票一致率**：``vote_ratio = consensus / (consensus + dissenting)``
    2. **自洽一致率**：``self_consistency``（多次采样结论一致率，可选）

    最终一致性 = 0.6 × vote_ratio + 0.4 × self_consistency
    （若未提供 self_consistency，则只用 vote_ratio）

    Args:
        consensus_count: 支持结论的证据数
        dissenting_count: 反对结论的证据数
        self_consistency: 自洽一致率（可选，[0, 1]）

    Returns:
        (consistency_score, vote_ratio) 元组
        - consistency_score: 一致性可信度 [0, 1]
        - vote_ratio: 多数投票一致率 [0, 1]
    """
    total_votes = consensus_count + dissenting_count

    if total_votes == 0:
        # 无投票数据：给中等分（不惩罚也不奖励）
        vote_ratio = 0.5
    else:
        vote_ratio = consensus_count / total_votes

    # 自洽一致率（可选）
    if self_consistency is not None:
        # 限制到 [0, 1]
        sc = max(0.0, min(1.0, float(self_consistency)))
        # 综合分：0.6 × vote_ratio + 0.4 × self_consistency
        consistency_score = 0.6 * vote_ratio + 0.4 * sc
    else:
        # 仅用 vote_ratio
        consistency_score = vote_ratio

    consistency_score = max(0.0, min(1.0, consistency_score))
    return round(consistency_score, 4), round(vote_ratio, 4)


def _normalize_weights(weights: dict[str, float] | None) -> dict[str, float]:
    """归一化权重，确保三维度权重之和为 1

    Args:
        weights: 原始权重字典 {"source": x, "temporal": y, "consistency": z}

    Returns:
        归一化后的权重字典，若输入为 None 则返回默认权重
    """
    if weights is None:
        return {
            "source": _DEFAULT_WEIGHT_SOURCE,
            "temporal": _DEFAULT_WEIGHT_TEMPORAL,
            "consistency": _DEFAULT_WEIGHT_CONSISTENCY,
        }

    # 提取并校验
    src_w = float(weights.get("source", _DEFAULT_WEIGHT_SOURCE))
    tmp_w = float(weights.get("temporal", _DEFAULT_WEIGHT_TEMPORAL))
    con_w = float(weights.get("consistency", _DEFAULT_WEIGHT_CONSISTENCY))

    # 钳位到 [0, 1]
    src_w = max(0.0, min(1.0, src_w))
    tmp_w = max(0.0, min(1.0, tmp_w))
    con_w = max(0.0, min(1.0, con_w))

    # 归一化
    total = src_w + tmp_w + con_w
    if total <= 0:
        # 全 0：回退到默认
        return {
            "source": _DEFAULT_WEIGHT_SOURCE,
            "temporal": _DEFAULT_WEIGHT_TEMPORAL,
            "consistency": _DEFAULT_WEIGHT_CONSISTENCY,
        }

    return {
        "source": round(src_w / total, 4),
        "temporal": round(tmp_w / total, 4),
        "consistency": round(con_w / total, 4),
    }


# ============================================================================
# MCP tool 接口
# ============================================================================


def invoke_credibility_tool(params: dict[str, Any]) -> dict[str, Any]:
    """MCP tool 入口：可信度评估（来源 + 时效 + 一致性 三维度）

    综合评估证据或历史案例的可信度，输出 0-1 分数 + 各维度因子。

    Args:
        params: 工具参数字典，包含：
            - source (str, 可选): 来源字符串（如 "mysql/error.log"）
            - timestamp (str, 可选): ISO 8601 时间戳
            - age_seconds (float, 可选): 数据年龄（秒），与 timestamp 二选一
            - consensus_count (int, 可选): 支持证据数
            - dissenting_count (int, 可选): 反对证据数
            - self_consistency (float, 可选): 自洽一致率 [0, 1]
            - weights (dict, 可选): 三维度权重
            - half_life_hours (float, 可选): 时效半衰期（小时，默认 24）

    Returns:
        可信度评估结果字典：
            - credibility (float): 综合可信度 [0, 1]
            - factors (dict): 各维度得分 {"source": x, "temporal": y, "consistency": z}
            - weights (dict): 实际使用的权重
            - details (dict): 详细诊断信息

    Raises:
        ValueError: 参数类型错误
    """
    # === 参数解析 ===
    source_str = params.get("source", "")
    if source_str is not None and not isinstance(source_str, str):
        raise ValueError(
            f"source must be str, got {type(source_str).__name__}"
        )

    timestamp_str = params.get("timestamp")
    if timestamp_str is not None and not isinstance(timestamp_str, str):
        raise ValueError(
            f"timestamp must be str, got {type(timestamp_str).__name__}"
        )

    age_seconds_raw = params.get("age_seconds")
    age_seconds: float | None = None
    if age_seconds_raw is not None:
        try:
            age_seconds = float(age_seconds_raw)
        except (TypeError, ValueError) as e:
            raise ValueError(f"age_seconds must be number: {e}")

    consensus_count = int(params.get("consensus_count", 0))
    dissenting_count = int(params.get("dissenting_count", 0))
    if consensus_count < 0 or dissenting_count < 0:
        raise ValueError("consensus_count and dissenting_count must be >= 0")

    self_consistency_raw = params.get("self_consistency")
    self_consistency: float | None = None
    if self_consistency_raw is not None:
        try:
            self_consistency = float(self_consistency_raw)
            if not 0.0 <= self_consistency <= 1.0:
                logger.warning(
                    f"self_consistency={self_consistency} out of [0,1], clamping"
                )
                self_consistency = max(0.0, min(1.0, self_consistency))
        except (TypeError, ValueError) as e:
            raise ValueError(f"self_consistency must be number: {e}")

    weights_raw = params.get("weights")
    if weights_raw is not None and not isinstance(weights_raw, dict):
        raise ValueError(
            f"weights must be dict, got {type(weights_raw).__name__}"
        )

    half_life_hours = float(params.get("half_life_hours", _DEFAULT_HALF_LIFE_HOURS))
    if half_life_hours <= 0:
        half_life_hours = _DEFAULT_HALF_LIFE_HOURS

    # === 三维度评估 ===
    source_score, source_known = _evaluate_source(source_str or "")
    temporal_score, actual_age = _evaluate_temporal(
        age_seconds=age_seconds,
        timestamp_str=timestamp_str,
        half_life_hours=half_life_hours,
    )
    consistency_score, vote_ratio = _evaluate_consistency(
        consensus_count=consensus_count,
        dissenting_count=dissenting_count,
        self_consistency=self_consistency,
    )

    # === 归一化权重 ===
    weights = _normalize_weights(weights_raw)

    # === 综合可信度 = Σ (weight × score) ===
    credibility = (
        weights["source"] * source_score
        + weights["temporal"] * temporal_score
        + weights["consistency"] * consistency_score
    )
    credibility = max(0.0, min(1.0, credibility))
    credibility = round(credibility, 4)

    # === 构建输出 ===
    factors = {
        "source": source_score,
        "temporal": temporal_score,
        "consistency": consistency_score,
    }

    details = {
        "source_known": source_known,
        "age_seconds": round(actual_age, 2),
        "vote_ratio": vote_ratio,
        "consensus_count": consensus_count,
        "dissenting_count": dissenting_count,
    }
    if self_consistency is not None:
        details["self_consistency"] = self_consistency
    if timestamp_str is not None:
        details["timestamp"] = timestamp_str
    if source_str:
        details["source"] = source_str

    logger.info(
        f"invoke_credibility_tool: credibility={credibility}, "
        f"source={source_score:.3f}({source_known}), "
        f"temporal={temporal_score:.3f}({actual_age:.0f}s), "
        f"consistency={consistency_score:.3f}({vote_ratio:.3f})"
    )

    return {
        "credibility": credibility,
        "factors": factors,
        "weights": weights,
        "details": details,
    }


# ============================================================================
# 工具元数据
# ============================================================================


TOOL_METADATA: dict[str, Any] = {
    "name": "credibility",
    "description": (
        "可信度评估：综合来源（source）+ 时效（temporal）+ 一致性（consistency）"
        "三维度加权，输出 0-1 综合分数 + 各维度因子。"
        "用于评估历史案例 / 证据 / 信息源的可信度。"
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "source": {
                "type": "string",
                "description": "来源字符串（如 'mysql/error.log'），可选",
            },
            "timestamp": {
                "type": "string",
                "description": "ISO 8601 时间戳，与 age_seconds 二选一",
            },
            "age_seconds": {
                "type": "number",
                "minimum": 0.0,
                "description": "数据年龄（秒），与 timestamp 二选一",
            },
            "consensus_count": {
                "type": "integer",
                "minimum": 0,
                "description": "支持结论的证据数（默认 0）",
            },
            "dissenting_count": {
                "type": "integer",
                "minimum": 0,
                "description": "反对结论的证据数（默认 0）",
            },
            "self_consistency": {
                "type": "number",
                "minimum": 0.0,
                "maximum": 1.0,
                "description": "自洽一致率（可选）",
            },
            "weights": {
                "type": "object",
                "properties": {
                    "source": {"type": "number"},
                    "temporal": {"type": "number"},
                    "consistency": {"type": "number"},
                },
                "description": "三维度权重（自动归一化，可选）",
            },
            "half_life_hours": {
                "type": "number",
                "minimum": 0.0,
                "description": "时效半衰期（小时，默认 24）",
            },
        },
    },
    "output_schema": {
        "type": "object",
        "properties": {
            "credibility": {"type": "number", "minimum": 0.0, "maximum": 1.0},
            "factors": {
                "type": "object",
                "properties": {
                    "source": {"type": "number"},
                    "temporal": {"type": "number"},
                    "consistency": {"type": "number"},
                },
            },
            "weights": {
                "type": "object",
                "properties": {
                    "source": {"type": "number"},
                    "temporal": {"type": "number"},
                    "consistency": {"type": "number"},
                },
            },
            "details": {
                "type": "object",
                "properties": {
                    "source_known": {"type": "boolean"},
                    "age_seconds": {"type": "number"},
                    "vote_ratio": {"type": "number"},
                    "consensus_count": {"type": "integer"},
                    "dissenting_count": {"type": "integer"},
                },
            },
        },
    },
}


def get_tool_metadata() -> dict[str, Any]:
    """获取工具元数据"""
    return TOOL_METADATA


# ============================================================================
# 集成到 LangGraph tool_call 节点
# ============================================================================


def register_to_graph_nodes() -> None:
    """将 credibility tool 注册到 graph/nodes.py 的 tool_call_node

    使用方式（在 graph/nodes.py 中）：
        from tools.credibility import invoke_credibility_tool

        if tool_name == "credibility":
            result = invoke_credibility_tool(params)
    """
    logger.info("register_to_graph_nodes: credibility tool ready for integration")
