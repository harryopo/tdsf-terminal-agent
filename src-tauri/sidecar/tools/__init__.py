"""
tools/__init__.py — TDSF Terminal Agent MCP tools 模块
========================================================

模块组成（T-P1-07 实现 6 个核心 MCP tools，P4 扩展至 9 个 tools）：
- risk:        风险评估 tool（T-P1-07.1，4 层风控管道 → L0-L4 + 理由）
- confidence:  置信度融合 tool（T-P1-07.2，D-S + PCR5 证据融合 → 0-1 分数）
- ground:      知识接地 tool（T-P1-07.3，ChromaDB 向量 + FTS5 关键词双路检索）
- decision:    决策引擎 tool（T-P1-07.4，调用 LangGraph DecisionEngine）
- credibility: 可信度评估 tool（T-P1-07.5，来源 + 时效 + 一致性三维度）
- history:     历史案例 tool（T-P1-07.6，CRUD + 多维检索 + DecisionEngine 适配器）
- worktree_fanout: WorktreeFanout tool（T-P4-03，git worktree 并行任务执行）
- rlm_fanout:  RLMFanout tool（T-P4-04，1-16 路并行子任务执行 + 结果聚合）
- steer_inject: SteerInject tool（T-P4-06，运行时向 Agent 注入指令）

设计原则：
1. 每个 tool 是独立的 Python 模块
2. 统一接口：``invoke(params: dict) -> dict``
3. 输出格式与 spec 4-api-contract.md 对齐
4. 模块级单例（懒加载）+ reset 函数（测试用）

使用方式：
    from tools import invoke_risk_tool, invoke_confidence_tool
    result = invoke_risk_tool({"command": "sudo rm -rf /"})

工具注册表（供 MCP / LangGraph tool_call_node 调用）：
    from tools import TOOL_REGISTRY, invoke_tool
    result = invoke_tool("risk", {"command": "..."})
"""

from __future__ import annotations

from typing import Any, Callable

# === 子模块导入（按 spec 顺序）===
from tools.confidence import invoke_confidence_tool
from tools.credibility import invoke_credibility_tool
from tools.decision import invoke_decision_tool
from tools.ground import invoke_ground_tool
from tools.history import invoke_history_tool
from tools.risk import invoke_risk_tool
# P4 新增 tools
from tools.worktree_fanout import invoke_worktree_fanout_tool
from tools.rlm_fanout import invoke_rlm_fanout_tool
from tools.steer_inject import invoke_steer_inject_tool

__all__ = [
    "risk",
    "confidence",
    "ground",
    "decision",
    "credibility",
    "history",
    # P4 新增 tools
    "worktree_fanout",
    "rlm_fanout",
    "steer_inject",
    # 函数导出（便捷访问）
    "invoke_risk_tool",
    "invoke_confidence_tool",
    "invoke_ground_tool",
    "invoke_decision_tool",
    "invoke_credibility_tool",
    "invoke_history_tool",
    # P4 新增函数导出
    "invoke_worktree_fanout_tool",
    "invoke_rlm_fanout_tool",
    "invoke_steer_inject_tool",
    # 统一注册表
    "TOOL_REGISTRY",
    "invoke_tool",
    "get_tool_metadata",
    "list_tools",
]


# ============================================================================
# 工具注册表（统一调度入口）
# ============================================================================

# 工具名 → invoke 函数
TOOL_REGISTRY: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
    "risk": invoke_risk_tool,
    "confidence": invoke_confidence_tool,
    "ground": invoke_ground_tool,
    "decision": invoke_decision_tool,
    "credibility": invoke_credibility_tool,
    "history": invoke_history_tool,
    # P4 新增 tools
    "worktree_fanout": invoke_worktree_fanout_tool,
    "rlm_fanout": invoke_rlm_fanout_tool,
    "steer_inject": invoke_steer_inject_tool,
}


def invoke_tool(name: str, params: dict[str, Any]) -> dict[str, Any]:
    """统一工具调用入口（按 name 路由到对应 invoke 函数）

    Args:
        name: 工具名（risk / confidence / ground / decision / credibility / history）
        params: 工具参数

    Returns:
        工具返回结果

    Raises:
        KeyError: 未知工具名
        ValueError: 工具参数校验失败（由具体工具抛出）
    """
    if name not in TOOL_REGISTRY:
        raise KeyError(
            f"unknown tool: '{name}', available: {list(TOOL_REGISTRY.keys())}"
        )
    return TOOL_REGISTRY[name](params)


def get_tool_metadata(name: str) -> dict[str, Any]:
    """获取指定工具的元数据

    Args:
        name: 工具名

    Returns:
        工具元数据字典（含 name / description / input_schema / output_schema）
    """
    metadata_map = {
        "risk": "tools.risk",
        "confidence": "tools.confidence",
        "ground": "tools.ground",
        "decision": "tools.decision",
        "credibility": "tools.credibility",
        "history": "tools.history",
        # P4 新增 tools
        "worktree_fanout": "tools.worktree_fanout",
        "rlm_fanout": "tools.rlm_fanout",
        "steer_inject": "tools.steer_inject",
    }
    if name not in metadata_map:
        raise KeyError(
            f"unknown tool: '{name}', available: {list(metadata_map.keys())}"
        )

    # 延迟导入对应模块的 get_tool_metadata
    if name == "risk":
        from tools.risk import get_tool_metadata as _get
    elif name == "confidence":
        from tools.confidence import get_tool_metadata as _get
    elif name == "ground":
        from tools.ground import get_tool_metadata as _get
    elif name == "decision":
        from tools.decision import get_tool_metadata as _get
    elif name == "credibility":
        from tools.credibility import get_tool_metadata as _get
    elif name == "history":
        from tools.history import get_tool_metadata as _get
    elif name == "worktree_fanout":
        from tools.worktree_fanout import get_tool_metadata as _get
    elif name == "rlm_fanout":
        from tools.rlm_fanout import get_tool_metadata as _get
    elif name == "steer_inject":
        from tools.steer_inject import get_tool_metadata as _get
    else:
        raise KeyError(f"unknown tool: {name}")

    return _get()


def list_tools() -> list[str]:
    """列出所有已注册的工具名"""
    return list(TOOL_REGISTRY.keys())
