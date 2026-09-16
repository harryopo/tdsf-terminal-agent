"""
tools/__init__.py — TDSF Terminal Agent MCP tools 模块
========================================================

模块组成（T-P1-07 实现 6 个核心 MCP tools，P4 扩展至 9 个 tools）：
- risk:        风险评估 tool（T-P1-07.1，4 层风控管道 → L0-L4 + 理由）
- confidence:  置信度融合 tool（T-P1-07.2，D-S + PCR5 证据融合 → 0-1 分数）
- ground:      知识接地 tool（T-P1-07.3，ChromaDB 向量 + FTS5 关键词双路检索）
- credibility: 可信度评估 tool（T-P1-07.5，来源 + 时效 + 一致性三维度）
- history:     历史案例 tool（T-P1-07.6，CRUD + 多维检索）
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

工具注册表：
    from tools import TOOL_REGISTRY, invoke_tool
    result = invoke_tool("risk", {"command": "..."})
"""

from __future__ import annotations

from importlib import import_module
from typing import Any, Callable

__all__ = [
    "risk",
    "confidence",
    "ground",
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

# 工具名 → 模块。包导入时保持惰性加载，避免注册 rpc_methods 时加载无关依赖。
_TOOL_MODULES: dict[str, str] = {
    "risk": "tools.risk",
    "confidence": "tools.confidence",
    "ground": "tools.ground",
    "credibility": "tools.credibility",
    "history": "tools.history",
    "worktree_fanout": "tools.worktree_fanout",
    "rlm_fanout": "tools.rlm_fanout",
    "steer_inject": "tools.steer_inject",
}


def _make_lazy_invoker(name: str) -> Callable[[dict[str, Any]], dict[str, Any]]:
    """创建保持既有公开 API 的惰性工具入口。"""

    def _invoke(params: dict[str, Any]) -> dict[str, Any]:
        module = import_module(_TOOL_MODULES[name])
        invoke = getattr(module, f"invoke_{name}_tool")
        return invoke(params)

    _invoke.__name__ = f"invoke_{name}_tool"
    return _invoke


# 保留 ``from tools import invoke_*_tool`` 与 TOOL_REGISTRY 的既有 callable 契约。
invoke_risk_tool = _make_lazy_invoker("risk")
invoke_confidence_tool = _make_lazy_invoker("confidence")
invoke_ground_tool = _make_lazy_invoker("ground")
invoke_credibility_tool = _make_lazy_invoker("credibility")
invoke_history_tool = _make_lazy_invoker("history")
invoke_worktree_fanout_tool = _make_lazy_invoker("worktree_fanout")
invoke_rlm_fanout_tool = _make_lazy_invoker("rlm_fanout")
invoke_steer_inject_tool = _make_lazy_invoker("steer_inject")


TOOL_REGISTRY: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
    "risk": invoke_risk_tool,
    "confidence": invoke_confidence_tool,
    "ground": invoke_ground_tool,
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
        name: 工具名（risk / confidence / ground / credibility / history）
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
    if name not in _TOOL_MODULES:
        raise KeyError(
            f"unknown tool: '{name}', available: {list(_TOOL_MODULES.keys())}"
        )
    module = import_module(_TOOL_MODULES[name])
    return module.get_tool_metadata()


def list_tools() -> list[str]:
    """列出所有已注册的工具名"""
    return list(TOOL_REGISTRY.keys())
