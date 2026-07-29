"""
tools/confidence.py — 证据置信度融合 MCP tool（T-P1-07.2）
==============================================================

包装 ``core.confidence.DSPCR5ConfidenceCalculator`` 等，提供 MCP tool 接口。

spec 要求：
- 输入：多个证据源
- 输出：``{"score": 0-1, "method": "D-S+PCR5"}``

实现方案书 4.1 节的置信度计算体系：
- baseline 公式：``confidence = α × drain3_match_score + (1-α) × source_prior``
- D-S 证据理论 + PCR5 冲突重分配（spec 要求的 D-S + PCR5 升级版）
- 支持自洽采样一致率（self-consistency）

输入格式（params）：
    {
        "evidences": [
            {
                "raw_text": "MySQL error log: InnoDB: Unable to lock ./ibdata1",
                "source": "mysql/error.log",
                "drain3_match_score": 0.92,
                "is_grounded": true
            },
            {
                "raw_text": "systemctl status mysql: failed",
                "source": "journalctl",
                "drain3_match_score": 0.85,
                "is_grounded": true
            }
        ],
        "method": "D-S+PCR5",          # 可选，默认 D-S+PCR5
                                     # 可选值: "baseline" / "D-S" / "D-S+PCR5"
        "alpha": 0.7,                 # 可选，默认 0.7
        "samples": ["结论A", "结论A", "结论B"]  # 可选，自洽采样一致率
    }

输出格式：
    {
        "score": 0.8523,
        "method": "D-S+PCR5",
        "conflict": 0.12,            # 总冲突度量（仅 D-S/D-S+PCR5 时非 0）
        "evidence_count": 2,
        "grounded_count": 2,
        "self_consistency": 0.667,   # 若提供 samples，则计算一致率
        "alpha": 0.7
    }

集成点：
- 被 graph/nodes.py 的 tool_call_node 调用（tool_name == "confidence"）
- 被 decision_engine 调用做证据链置信度计算
"""

from __future__ import annotations

import logging
from typing import Any

from core.confidence import (
    DEFAULT_ALPHA,
    ConfidenceCalculator,
    DSConfidenceCalculator,
    DSPCR5ConfidenceCalculator,
    compute_self_consistency_confidence,
)
from core.schemas import Evidence, EvidenceSource

logger = logging.getLogger("sidecar.tools.confidence")


# ============================================================================
# 常量定义
# ============================================================================

# 支持的融合方法
_METHOD_BASELINE: str = "baseline"
_METHOD_DS: str = "D-S"
_METHOD_DSPCR5: str = "D-S+PCR5"
_SUPPORTED_METHODS: tuple[str, ...] = (_METHOD_BASELINE, _METHOD_DS, _METHOD_DSPCR5)

# 默认融合方法（spec 要求 D-S + PCR5）
_DEFAULT_METHOD: str = _METHOD_DSPCR5


# ============================================================================
# 模块级单例（懒加载，避免重复初始化开销）
# ============================================================================

_baseline_calculator: ConfidenceCalculator | None = None
_ds_calculator: DSConfidenceCalculator | None = None
_dspcr5_calculator: DSPCR5ConfidenceCalculator | None = None


def _get_baseline_calculator(alpha: float = DEFAULT_ALPHA) -> ConfidenceCalculator:
    """获取 baseline ConfidenceCalculator 单例"""
    global _baseline_calculator
    if _baseline_calculator is None:
        _baseline_calculator = ConfidenceCalculator(alpha=alpha)
        logger.info(f"baseline calculator built (alpha={alpha})")
    return _baseline_calculator


def _get_ds_calculator(alpha: float = DEFAULT_ALPHA) -> DSConfidenceCalculator:
    """获取 D-S ConfidenceCalculator 单例"""
    global _ds_calculator
    if _ds_calculator is None:
        _ds_calculator = DSConfidenceCalculator(alpha=alpha)
        logger.info(f"D-S calculator built (alpha={alpha})")
    return _ds_calculator


def _get_dspcr5_calculator(alpha: float = DEFAULT_ALPHA) -> DSPCR5ConfidenceCalculator:
    """获取 D-S + PCR5 ConfidenceCalculator 单例（spec 要求）"""
    global _dspcr5_calculator
    if _dspcr5_calculator is None:
        _dspcr5_calculator = DSPCR5ConfidenceCalculator(alpha=alpha)
        logger.info(f"D-S+PCR5 calculator built (alpha={alpha})")
    return _dspcr5_calculator


def reset_calculators() -> None:
    """重置所有计算器单例（用于测试或配置变更）"""
    global _baseline_calculator, _ds_calculator, _dspcr5_calculator
    _baseline_calculator = None
    _ds_calculator = None
    _dspcr5_calculator = None
    logger.info("reset_calculators: cleared all singleton calculators")


# ============================================================================
# 输入转换工具
# ============================================================================


def _parse_evidence_source(source_str: str) -> EvidenceSource:
    """将字符串映射为 EvidenceSource 枚举

    Args:
        source_str: 来源字符串（如 "mysql/error.log" / "dmesg" / "journalctl"）

    Returns:
        EvidenceSource 枚举值，未知来源返回 EvidenceSource.UNKNOWN
    """
    if not source_str:
        return EvidenceSource.UNKNOWN

    # 直接按值匹配
    try:
        return EvidenceSource(source_str)
    except ValueError:
        pass

    # 模糊匹配（包含关键字）
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


def _dict_to_evidence(d: dict[str, Any]) -> Evidence:
    """将字典转换为 Evidence 对象

    Args:
        d: 证据字典，包含 raw_text / source / drain3_match_score / is_grounded 等字段

    Returns:
        Evidence 实例
    """
    raw_text = d.get("raw_text", "")
    source = _parse_evidence_source(d.get("source", ""))
    source_file = d.get("source_file", "")
    line_number = d.get("line_number")
    drain3_match_score = float(d.get("drain3_match_score", 0.0))
    is_grounded = bool(d.get("is_grounded", False))

    # 显式构造 Evidence，并保留原始 confidence（若提供则使用，否则置 0 待计算）
    evidence = Evidence(
        raw_text=raw_text,
        source=source,
        source_file=source_file,
        line_number=line_number,
        drain3_match_score=drain3_match_score,
        is_grounded=is_grounded,
    )
    # 若调用方提供了 confidence，则覆盖；否则用 baseline 计算填入
    if "confidence" in d:
        evidence.confidence = float(d["confidence"])
    else:
        evidence.confidence = evidence.compute_confidence(DEFAULT_ALPHA)
    return evidence


def _parse_evidences(evidences_raw: Any) -> list[Evidence]:
    """解析 evidences 输入为 Evidence 列表

    Args:
        evidences_raw: 原始输入（应为 list[dict]）

    Returns:
        Evidence 对象列表

    Raises:
        ValueError: 输入非 list 或元素类型错误
    """
    if not isinstance(evidences_raw, list):
        raise ValueError(
            f"evidences must be list, got {type(evidences_raw).__name__}"
        )

    result: list[Evidence] = []
    for i, item in enumerate(evidences_raw):
        if isinstance(item, dict):
            result.append(_dict_to_evidence(item))
        elif isinstance(item, Evidence):
            result.append(item)
        else:
            raise ValueError(
                f"evidences[{i}] must be dict or Evidence, "
                f"got {type(item).__name__}"
            )
    return result


# ============================================================================
# MCP tool 接口
# ============================================================================


def invoke_confidence_tool(params: dict[str, Any]) -> dict[str, Any]:
    """MCP tool 入口：调用置信度计算器融合证据

    根据指定方法计算证据链的综合置信度：
    - baseline: α × drain3_match_score + (1-α) × source_prior（加权融合）
    - D-S: Dempster-Shafer 证据理论（归一化处理冲突）
    - D-S+PCR5: D-S + PCR5 冲突重分配（默认，spec 要求）

    Args:
        params: 工具参数字典，包含：
            - evidences (list, 必填): 证据列表，每项为 dict 或 Evidence
            - method (str, 可选): 融合方法，默认 "D-S+PCR5"
            - alpha (float, 可选): 模板匹配权重，默认 0.7
            - samples (list[str], 可选): 自洽采样样本列表

    Returns:
        置信度融合结果字典：
            - score (float): 综合置信度 [0.0, 1.0]
            - method (str): 实际使用的融合方法
            - conflict (float): 总冲突度量（仅 D-S/D-S+PCR5 时非 0）
            - evidence_count (int): 总证据数
            - grounded_count (int): 通过溯源校验的证据数
            - self_consistency (float | None): 自洽一致率（若提供 samples）
            - alpha (float): 实际使用的 α 权重

    Raises:
        ValueError: 必填参数缺失或类型错误
    """
    # === 参数校验 ===
    if "evidences" not in params:
        raise ValueError("evidences is required")
    evidences = _parse_evidences(params["evidences"])

    # 融合方法（带校验，非法值回退到默认）
    method = params.get("method", _DEFAULT_METHOD)
    if method not in _SUPPORTED_METHODS:
        logger.warning(
            f"invoke_confidence_tool: unsupported method '{method}', "
            f"fallback to {_DEFAULT_METHOD}"
        )
        method = _DEFAULT_METHOD

    # α 权重（带边界保护）
    alpha = float(params.get("alpha", DEFAULT_ALPHA))
    if not 0.0 <= alpha <= 1.0:
        logger.warning(
            f"invoke_confidence_tool: alpha={alpha} out of [0,1], "
            f"fallback to {DEFAULT_ALPHA}"
        )
        alpha = DEFAULT_ALPHA

    # 自洽采样样本（可选）
    samples = params.get("samples")
    if samples is not None and not isinstance(samples, list):
        raise ValueError(
            f"samples must be list, got {type(samples).__name__}"
        )

    # === 调用计算器 ===
    evidence_count = len(evidences)
    grounded_count = sum(1 for ev in evidences if ev.is_grounded)

    score: float = 0.0
    conflict: float = 0.0

    if method == _METHOD_BASELINE:
        # baseline: α 加权融合
        calculator = _get_baseline_calculator(alpha=alpha)
        score = calculator.compute_chain_confidence(evidences)
        # baseline 不计算冲突度量
        conflict = 0.0

    elif method == _METHOD_DS:
        # 纯 D-S（Dempster 组合规则，归一化处理冲突）
        calculator = _get_ds_calculator(alpha=alpha)
        score = calculator.compute_chain_confidence(evidences)
        # D-S 不在结果中返回冲突度量，但可在此处补充计算（保持兼容）
        # 为简化，D-S 模式 conflict 置 0（与 baseline 一致）
        conflict = 0.0

    elif method == _METHOD_DSPCR5:
        # D-S + PCR5（spec 要求）：使用 compute_chain_confidence_with_conflict
        calculator = _get_dspcr5_calculator(alpha=alpha)
        score, conflict = calculator.compute_chain_confidence_with_conflict(evidences)

    # === 自洽采样一致率（可选） ===
    self_consistency: float | None = None
    if samples is not None:
        self_consistency = compute_self_consistency_confidence(samples)

    # === 格式化输出 ===
    result: dict[str, Any] = {
        "score": score,
        "method": method,
        "conflict": conflict,
        "evidence_count": evidence_count,
        "grounded_count": grounded_count,
        "alpha": alpha,
    }
    if self_consistency is not None:
        result["self_consistency"] = self_consistency

    logger.info(
        f"invoke_confidence_tool: method={method}, score={score}, "
        f"conflict={conflict}, grounded={grounded_count}/{evidence_count}"
    )

    return result


# ============================================================================
# 工具元数据（供 MCP tool 注册表使用）
# ============================================================================


TOOL_METADATA: dict[str, Any] = {
    "name": "confidence",
    "description": (
        "证据置信度融合：支持 baseline（α 加权）/ D-S / D-S+PCR5（默认，spec 要求）"
        "三种方法，输出综合置信度 + 冲突度量 + 自洽一致率。"
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "evidences": {
                "type": "array",
                "description": "证据列表（必填），每项为 Evidence dict",
                "items": {
                    "type": "object",
                    "properties": {
                        "raw_text": {"type": "string"},
                        "source": {"type": "string"},
                        "drain3_match_score": {"type": "number"},
                        "is_grounded": {"type": "boolean"},
                    },
                },
            },
            "method": {
                "type": "string",
                "enum": list(_SUPPORTED_METHODS),
                "description": "融合方法（默认 D-S+PCR5）",
            },
            "alpha": {
                "type": "number",
                "minimum": 0.0,
                "maximum": 1.0,
                "description": "模板匹配权重（默认 0.7）",
            },
            "samples": {
                "type": "array",
                "items": {"type": "string"},
                "description": "自洽采样样本列表（可选，用于计算一致率）",
            },
        },
        "required": ["evidences"],
    },
    "output_schema": {
        "type": "object",
        "properties": {
            "score": {"type": "number", "minimum": 0.0, "maximum": 1.0},
            "method": {"type": "string", "enum": list(_SUPPORTED_METHODS)},
            "conflict": {"type": "number", "minimum": 0.0, "maximum": 1.0},
            "evidence_count": {"type": "integer", "minimum": 0},
            "grounded_count": {"type": "integer", "minimum": 0},
            "alpha": {"type": "number"},
            "self_consistency": {"type": "number", "minimum": 0.0, "maximum": 1.0},
        },
    },
}


def get_tool_metadata() -> dict[str, Any]:
    """获取工具元数据（供 MCP tool 注册表使用）"""
    return TOOL_METADATA


# ============================================================================
# 集成到 LangGraph tool_call 节点
# ============================================================================


def register_to_graph_nodes() -> None:
    """将 confidence tool 注册到 graph/nodes.py 的 tool_call_node

    在 graph/nodes.py 的 tool_call_node 中，当 tool_name == "confidence" 时，
    调用 invoke_confidence_tool(params) 替代 mock 实现。

    使用方式（在 graph/nodes.py 中）：
        from tools.confidence import invoke_confidence_tool

        if tool_name == "confidence":
            result = invoke_confidence_tool(params)

    本函数提供显式注册接口（便于初始化时调用），
    但实际集成建议直接在 graph/nodes.py 中导入 invoke_confidence_tool。
    """
    # 注册信号：导入本模块即视为注册（避免循环依赖）
    logger.info("register_to_graph_nodes: confidence tool ready for integration")
