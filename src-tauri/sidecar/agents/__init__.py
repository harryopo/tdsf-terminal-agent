"""
agents/__init__.py — TDSF Terminal Agent 框架（T-P1-11 + T-P4-01）
=====================================================================

模块组成（P4 扩展：主调度 + 8 子 Agent）：
- base:           Agent 基类（BaseAgent，PAOR 模板方法 + 工具/事件/LLM 注入）
- main_agent:     主 Agent（PAOR 监督循环 + 路由到 8 子 Agent）
- coding_agent:   Coding Agent（代码生成 + 修改，工具：Edit/Write/Read）
- explore_agent:  Explore Agent（代码探索 + 搜索，工具：Grep/Glob/Read）
- history_agent:  History Agent（历史查询 + 上下文压缩，工具：history tool）
- teach_agent:    Teach Agent（Linux 运维教学讲解，工具：ground tool 检索知识库）
- debug_agent:    Debug Agent（故障定位 + 根因分析）— T-P4-01 新增
- refactor_agent: Refactor Agent（代码重构）— T-P4-01 新增
- test_agent:     Test Agent（测试用例生成 + 执行）— T-P4-01 新增
- deploy_agent:   Deploy Agent（部署流程编排）— T-P4-01 新增

设计原则：
1. 所有 Agent 继承 BaseAgent，统一接口：``invoke(state: AgentState) -> dict``
2. 主 Agent 是 PAOR 监督者，子 Agent 是单一职责执行器（不互相调用，避免循环）
3. Agent 不直接调用 LLM，通过 ``llm_call`` 注入（依赖反转，便于测试）
4. 工具调用通过 ``tools.invoke_tool`` 统一入口（不直接 import 具体工具模块）
5. 所有 Agent 通过 ``event_bus`` 推送 mood_change / agent_message 事件
6. system prompt 由 base + TDSF.md 后缀拼接（tdsf_loader.build_agent_system_prompt）

使用方式：
    from agents import invoke_agent, AGENT_REGISTRY
    update = invoke_agent("coding", state)

JSON-RPC 方法注册（main.py 调用）：
    from agents import register_methods
    register_methods(dispatcher)
"""

from __future__ import annotations

import logging
from typing import Any, Callable

# TDSF P1-NEW-2 修复 (2026-07-30): 模块级 logger，替代 set_backend 中的
# walrus + __import__("logging") hack 和 clear_backend 中的函数内 import。
# 统一用 sidecar.agents 命名空间，与 main.py / base.py 日志可追溯。
logger = logging.getLogger("sidecar.agents")

# === 子模块导入（按 spec 顺序）===
from agents.base import BaseAgent, AgentResult, LLMCallFunction
from agents.main_agent import MainAgent
from agents.coding_agent import CodingAgent
from agents.explore_agent import ExploreAgent
from agents.history_agent import HistoryAgent
from agents.teach_agent import TeachAgent
# T-P4-01: 新增 4 子 Agent（debug/refactor/test/deploy）
from agents.debug_agent import DebugAgent
from agents.refactor_agent import RefactorAgent
from agents.test_agent import TestAgent
from agents.deploy_agent import DeployAgent

# TDSF 魔改 2026-07-30 P0-C2 修复: Strands 后端 override 调用签名
# 与 strands_backend.adapter.StrandsAgentAdapter.invoke 对齐：
#   (agent_id: str, input: str, state: dict[str, Any]) -> dict[str, Any]
# invoke_agent() 调用时优先走 override（若已 set_backend），否则走 BaseAgent.invoke
BackendInvokeCallable = Callable[
    [str, str, dict[str, Any]], dict[str, Any]
]

__all__ = [
    # 基类
    "BaseAgent",
    "AgentResult",
    "LLMCallFunction",
    # 9 个 Agent（P4 扩展）
    "MainAgent",
    "CodingAgent",
    "ExploreAgent",
    "HistoryAgent",
    "TeachAgent",
    "DebugAgent",
    "RefactorAgent",
    "TestAgent",
    "DeployAgent",
    # 注册表与统一入口
    "AGENT_REGISTRY",
    "get_agent",
    "list_agents",
    "invoke_agent",
    # 全局配置（main.py 调用）
    "configure_agents",
    "register_methods",
    "reset_for_test",
    # TDSF 魔改 2026-07-30 P0-C2 修复: 后端切换接口（Strands 适配层注入）
    "set_backend",
    "clear_backend",
    "BackendInvokeCallable",
]


# ============================================================================
# Agent 注册表（name → class）
# ============================================================================

# 主 Agent + 8 子 Agent（P4 扩展至 9 个 Agent）
AGENT_REGISTRY: dict[str, type[BaseAgent]] = {
    "main": MainAgent,
    "coding": CodingAgent,
    "explore": ExploreAgent,
    "history": HistoryAgent,
    "teach": TeachAgent,
    # T-P4-01 新增 4 子 Agent
    "debug": DebugAgent,
    "refactor": RefactorAgent,
    "test": TestAgent,
    "deploy": DeployAgent,
}


# ============================================================================
# 全局 Agent 实例池（懒加载，configure_agents 后实例化）
# ============================================================================

# name → BaseAgent 实例
_agent_instances: dict[str, BaseAgent] = {}

# 全局依赖（通过 configure_agents 注入）
_global_event_bus = None
_global_llm_call: LLMCallFunction | None = None

# TDSF 魔改 2026-07-30 P0-C2 修复: Strands 后端 override
# - 非 None 时 invoke_agent() 走 override 路径，绕开 BaseAgent.invoke
# - 由 main.py 在 TDSF_AGENT_BACKEND=strands 时通过 set_backend(adapter.invoke) 注入
# - 与现有 BaseAgent PAOR 主路径互斥，二选一（避免双路径并发竞态）
_global_backend_override: BackendInvokeCallable | None = None


def configure_agents(
    event_bus: Any,
    llm_call: LLMCallFunction | None = None,
) -> None:
    """配置全局依赖并实例化所有 Agent（main.py 启动时调用）

    Args:
        event_bus: EventBus 实例（用于推送 mood/message 事件）
        llm_call: LLM 调用函数（messages: list[dict]) -> str
                  若为 None，则 Agent 使用 mock LLM（便于离线测试）
    """
    global _global_event_bus, _global_llm_call
    _global_event_bus = event_bus
    _global_llm_call = llm_call

    # 实例化所有 Agent
    for name, cls in AGENT_REGISTRY.items():
        _agent_instances[name] = cls(
            event_bus=event_bus,
            llm_call=llm_call,
        )


# ============================================================================
# TDSF 魔改 2026-07-30 P0-C2 修复: 后端切换接口（Strands 适配层注入）
# ============================================================================
#
# 设计原则：
# 1. set_backend(fn) 注入 Strands 适配层后，invoke_agent() 优先走 override，
#    跳过 BaseAgent.invoke（避免双路径并发，简化 event_bus 推送归属）。
# 2. override 签名与 StrandsAgentAdapter.invoke 完全对齐：
#       (agent_id: str, input: str, state: dict) -> dict
#    返回值结构与 BaseAgent.to_state_update() 对齐（observation / next_step /
#    mood / intermediate_results），让前端 sidecar-adapter.ts 切片零改动。
# 3. clear_backend() 清除 override，回退到 LangGraph BaseAgent PAOR 路径。
# 4. 同时仍走 configure_agents() 实例化所有 BaseAgent（保留 fallback 路径，
#    Strands 适配层降级时可回退；同时让前端 agent.list / agent.info JSON-RPC
#    拿到的 system_prompt / tools 元数据仍可用）。
# ============================================================================


def set_backend(backend: BackendInvokeCallable) -> None:
    """注入运行时后端 override（如 Strands 适配层）

    调用后，所有 invoke_agent(name, state) 调用走 override 路径：
        override(agent_id=name, input=state.get("input", ""), state=state)
    而非 BaseAgent.invoke(state)。

    Args:
        backend: 后端 invoke 调用可调用对象
                 签名 (agent_id: str, input: str, state: dict) -> dict
                 返回值与 BaseAgent.to_state_update() 对齐

    Raises:
        TypeError: backend 不可调用

    使用示例（main.py 启动时）：
        from strands_backend import configure_strands
        adapter = configure_strands(event_bus=bus, rust_bridge=None)
        agents.set_backend(
            lambda agent_id, input, state: adapter.invoke(agent_id, input, state)
        )
    """
    global _global_backend_override
    if not callable(backend):
        raise TypeError(
            f"set_backend expects callable, got {type(backend).__name__}"
        )
    _global_backend_override = backend
    logger.info(
        f"backend override set: {getattr(backend, '__name__', repr(backend))}"
    )


def clear_backend() -> None:
    """清除后端 override，回退到 BaseAgent PAOR 主路径

    用于运行时切换后端（如 Strands → LangGraph）或单元测试隔离。
    """
    global _global_backend_override
    if _global_backend_override is not None:
        _global_backend_override = None
        logger.info("backend override cleared")


def get_agent(name: str) -> BaseAgent:
    """获取已实例化的 Agent（需先调用 configure_agents）

    Args:
        name: Agent 名（main / coding / explore / history / teach）

    Returns:
        BaseAgent 实例

    Raises:
        KeyError: 未知 Agent 名或未调用 configure_agents
    """
    if name not in AGENT_REGISTRY:
        raise KeyError(
            f"unknown agent: '{name}', available: {list(AGENT_REGISTRY.keys())}"
        )
    if name not in _agent_instances:
        raise RuntimeError(
            f"agent '{name}' not configured, call configure_agents() first"
        )
    return _agent_instances[name]


def list_agents() -> list[str]:
    """列出所有已注册的 Agent 名"""
    return list(AGENT_REGISTRY.keys())


def invoke_agent(name: str, state: dict[str, Any]) -> dict[str, Any]:
    """统一 Agent 调用入口（供 graph/nodes.py 的 act_node 使用）

    优先级：
        1. 若已 set_backend() 注入 override（如 Strands 适配层），走 override 路径
           override(agent_id=name, input=state.get("input", ""), state=state)
           返回值结构与 BaseAgent.to_state_update() 对齐
        2. 否则走 BaseAgent.invoke(state) PAOR 主路径

    Args:
        name: Agent 名
        state: AgentState（dict 形式）

    Returns:
        部分状态更新（与 LangGraph 节点返回值兼容）

    TDSF 魔改 2026-07-30 P0-E 修复:
        原版直接调 get_agent(name).invoke(state)，忽略 _global_backend_override，
        导致 set_backend() 注入的 Strands 适配层永远不会被调用，Strands 后端
        处于"已激活但未被调用"的"幽灵状态"。修复后优先走 override，让
        TDSF_AGENT_BACKEND=strands 真正生效。
    """
    if _global_backend_override is not None:
        return _global_backend_override(
            agent_id=name,
            input=state.get("input", ""),
            state=state,
        )
    agent = get_agent(name)
    return agent.invoke(state)


def reset_for_test() -> None:
    """重置全局状态（测试隔离用）"""
    global _global_event_bus, _global_llm_call
    _global_event_bus = None
    _global_llm_call = None
    _agent_instances.clear()


# ============================================================================
# JSON-RPC 方法注册（供 main.py 调用）
# ============================================================================

def register_methods(dispatcher: Any) -> None:
    """注册 Agent 相关 JSON-RPC 方法到 dispatcher

    注册的方法：
    - agent.invoke:        调用指定 Agent（params: {name, state}）
    - agent.list:          列出所有 Agent
    - agent.info:          获取 Agent 元数据（system prompt / tools）
    - agent.configure:     运行时重新配置（如更换 llm_call）
    """
    dispatcher.register("agent.invoke", _rpc_agent_invoke)
    dispatcher.register("agent.list", _rpc_agent_list)
    dispatcher.register("agent.info", _rpc_agent_info)
    dispatcher.register("agent.configure", _rpc_agent_configure)


def _rpc_agent_invoke(name: str, state: dict[str, Any]) -> dict[str, Any]:
    """JSON-RPC: agent.invoke"""
    return invoke_agent(name, state)


def _rpc_agent_list() -> dict[str, Any]:
    """JSON-RPC: agent.list"""
    return {
        "agents": [
            {"name": name, "class": cls.__name__}
            for name, cls in AGENT_REGISTRY.items()
        ],
        "configured": list(_agent_instances.keys()),
    }


def _rpc_agent_info(name: str) -> dict[str, Any]:
    """JSON-RPC: agent.info"""
    agent = get_agent(name)
    return {
        "name": agent.name,
        "role": agent.role,
        "description": agent.description,
        "tools": agent.tools,
        "system_prompt": agent.build_system_prompt(),
    }


def _rpc_agent_configure(
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """JSON-RPC: agent.configure（运行时重新配置 LLM）

    TDSF 魔改 P0-3: 支持通过配置字典重新配置 LLM
    （JSON-RPC 无法序列化函数，改为传配置参数）

    Args:
        config: LLM 配置字典，格式：
            {
                "provider": "openai" | "anthropic",
                "api_key": "sk-xxx",
                "base_url": "https://api.openai.com/v1",  # 可选
                "model": "gpt-4o-mini",
                "temperature": 0.7,                       # 可选
                "max_tokens": 2048                        # 可选
            }
            为 None 或缺 api_key 时仅查询当前状态

    Returns:
        {"ok": bool, "llm_call_set": bool, "message": str}
    """
    global _global_llm_call
    if config:
        try:
            from core.llm_config import LLMConfig, reconfigure
            llm_config = LLMConfig(
                provider=config.get("provider", "openai"),
                api_key=config.get("api_key", ""),
                base_url=config.get("base_url", ""),
                model=config.get("model", "gpt-4o-mini"),
                temperature=config.get("temperature", 0.7),
                max_tokens=config.get("max_tokens", 2048),
            )
            new_llm_call = reconfigure(llm_config)
            if new_llm_call is not None:
                _global_llm_call = new_llm_call
                for agent in _agent_instances.values():
                    agent.llm_call = new_llm_call
                return {
                    "ok": True,
                    "llm_call_set": True,
                    "message": f"LLM 配置已更新: {llm_config.provider}/{llm_config.model}",
                }
            return {
                "ok": False,
                "llm_call_set": False,
                "message": "LLM 配置失败，请检查 API Key 和模型名称",
            }
        except Exception as e:
            return {
                "ok": False,
                "llm_call_set": False,
                "message": f"LLM 配置异常: {e}",
            }
    return {"ok": True, "llm_call_set": _global_llm_call is not None}
