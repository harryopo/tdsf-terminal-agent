"""
strands_backend/tools/skill_invoke.py — Skill 调用工具
======================================================

职责：
- 让 Strands Agent 在 agentic loop 中主动调用已注册的 Skill，增强 LLM 的
  领域知识（Linux 运维 / Docker / SELinux / SSH 排障 / Python 调试等）。
- 直接 Python 内部调用 ``SkillRegistry.invoke(name, params)``，不走 IPC，
  避免跨进程往返开销。
- 推送 ``tool_call`` 事件到 event_bus，前端 ``RenderedTool`` 实时渲染
  工具调用过程（输入参数 + 输出结果）。

TDSF 修复 2026-07-31 (P4): 新增。
之前 Strands Agent 只有 5 个运维工具（ssh_command / read_remote_file /
analyze_logs / inspect_processes / network_diagnostic），无法调用 Skill。
用户反馈"AI 对话无法调用 skill"，根因是 Strands 工具集缺少 skill 工具。

设计：
- ``invoke_skill_tool(params, ctx)``：核心实现，无 Strands 依赖，便于单测。
- ``make_skill_invoke_tool(ctx)``：工厂函数，返回带 ctx 闭包的 @tool 装饰函数，
  供 ``StrandsAgentAdapter`` 注册到 Strands Agent。
- Strands 不可用时 @tool 退化为 passthrough，工厂仍返回可调用函数。

工具签名（Strands 从 docstring + 类型标注自动生成工具描述）：
    skill_invoke(skill_name, input="") -> dict

返回结构：
    success (知识卡模式):
        {status:"success", skill_name, skill_source, content, when_to_use, ...}
    success (executor 模式):
        {status:"success", skill_name, skill_source, stdout, stderr, exit_code, ...}
    not_found:
        {status:"not_found", skill_name, message}
    error:
        {status:"error", skill_name, error}
"""
from __future__ import annotations

import logging
from typing import Any

from strands_backend.tools import ToolContext, tool

logger = logging.getLogger("sidecar.strands_backend.tools.skill_invoke")


# ============================================================================
# 核心实现（无 Strands 依赖，便于单测）
# ============================================================================

def invoke_skill_tool(params: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    """Skill 调用工具核心实现

    Args:
        params: 工具参数 dict，支持字段：
            - skill_name (str, 必填): Skill 名称（大小写不敏感）
            - input (str, 可选): 调用参数，透传给 skill executor（部分 type 支持 ${input} 替换）
        ctx: ToolContext 运行时上下文

    Returns:
        结构化 dict（见模块 docstring 返回结构）

    Raises:
        ValueError: skill_name 参数缺失或为空
    """
    skill_name = (params.get("skill_name") or params.get("name") or "").strip()
    if not skill_name:
        raise ValueError("skill_invoke 工具必填参数缺失: skill_name")

    skill_input = params.get("input", "") or ""
    invoke_params = {"input": skill_input} if skill_input else {}

    # 推送 tool_call 事件（前端 AgentStatusPill + 工具调用面板展示）
    if ctx.event_bus is not None:
        try:
            ctx.event_bus.emit_tool_call(
                tool_name="skill_invoke",
                params={"skill_name": skill_name, "input": skill_input},
                status="started",
                session_id=ctx.session_id or None,
                source=f"{ctx.agent_name}_agent.strands_tool.skill_invoke",
            )
        except Exception as e:
            logger.debug(f"emit_tool_call started failed: {e}")

    # 直接 Python 内部调用 SkillRegistry，不走 IPC
    # 避免跨进程往返开销，且能复用已加载的 skill 缓存
    try:
        from skills.registry import get_global_registry
        registry = get_global_registry()
        result = registry.invoke(skill_name, invoke_params)
    except KeyError as e:
        # skill 不存在
        result = {
            "status": "not_found",
            "skill_name": skill_name,
            "message": f"skill not found: {skill_name}",
            "error": str(e),
        }
        logger.warning(f"skill_invoke not found: name={skill_name}")
        # 推送 tool_call error 事件
        if ctx.event_bus is not None:
            try:
                ctx.event_bus.emit_tool_call(
                    tool_name="skill_invoke",
                    params={"skill_name": skill_name, "input": skill_input},
                    result=result,
                    status="error",
                    session_id=ctx.session_id or None,
                    source=f"{ctx.agent_name}_agent.strands_tool.skill_invoke",
                )
            except Exception as e2:
                logger.debug(f"emit_tool_call error failed: {e2}")
        return result
    except Exception as e:
        # skill 调用异常
        logger.exception(
            f"skill_invoke exception: name={skill_name}, error={e}"
        )
        result = {
            "status": "error",
            "skill_name": skill_name,
            "error": f"skill invoke exception: {e}",
        }
        if ctx.event_bus is not None:
            try:
                ctx.event_bus.emit_tool_call(
                    tool_name="skill_invoke",
                    params={"skill_name": skill_name, "input": skill_input},
                    result=result,
                    status="error",
                    session_id=ctx.session_id or None,
                    source=f"{ctx.agent_name}_agent.strands_tool.skill_invoke",
                )
            except Exception as e2:
                logger.debug(f"emit_tool_call error failed: {e2}")
        return result

    # 整理返回结果，统一加 status / skill_name 字段
    # SkillRegistry.invoke 返回 dict，可能含：
    #   - 知识卡模式: {name, content, when_to_use, steps, examples, params, source}
    #   - executor 模式: {name, success, stdout, stderr, exit_code, executor, ...}
    skill_source = result.get("source", "unknown")
    has_executor = "executor" in result and result.get("executor") is not None
    is_executed = "success" in result and isinstance(
        result.get("success"), bool
    )

    if is_executed:
        # executor 模式：真正执行了 shell/python/http
        final_result = {
            "status": "success" if result.get("success") else "error",
            "skill_name": skill_name,
            "skill_source": skill_source,
            "executor_type": result.get("executor", {}).get("type", "unknown") if has_executor else "unknown",
            "stdout": result.get("stdout", ""),
            "stderr": result.get("stderr", ""),
            "exit_code": result.get("exit_code", -1),
            "duration_ms": result.get("duration_ms", 0),
            "success": result.get("success", False),
        }
        if result.get("error"):
            final_result["error"] = result["error"]
    else:
        # 知识卡模式：返回 SKILL.md 内容作为 Agent 参考
        final_result = {
            "status": "success",
            "skill_name": skill_name,
            "skill_source": skill_source,
            "content": result.get("content", ""),
            "when_to_use": result.get("when_to_use", ""),
            "steps": result.get("steps", []),
            "examples": result.get("examples", []),
            "params_schema": result.get("params", {}),
            "tags": result.get("tags", []),
        }

    # 推送 tool_call 完成事件
    if ctx.event_bus is not None:
        try:
            ctx.event_bus.emit_tool_call(
                tool_name="skill_invoke",
                params={"skill_name": skill_name, "input": skill_input},
                result=final_result,
                status="completed" if final_result.get("status") == "success" else "error",
                session_id=ctx.session_id or None,
                source=f"{ctx.agent_name}_agent.strands_tool.skill_invoke",
            )
        except Exception as e:
            logger.debug(f"emit_tool_call completed failed: {e}")

    return final_result


# ============================================================================
# Strands @tool 工厂（带 ctx 闭包）
# ============================================================================

def make_skill_invoke_tool(ctx: ToolContext):
    """构建 Skill 调用工具（带 ctx 闭包）

    Args:
        ctx: ToolContext 运行时上下文

    Returns:
        Strands @tool 装饰后的工具函数（Strands 不可用时为 passthrough 装饰）
    """
    @tool
    def skill_invoke(
        skill_name: str,
        input: str = "",
    ) -> dict:
        """调用已注册的 Skill，获取领域知识或执行特定任务。

        可用 Skill 包括：
        - linux-ops: Linux 运维基础知识（文件权限/进程管理/服务管理等）
        - docker-management: Docker 容器管理（镜像/容器/网络/数据卷）
        - selinux-baseline: SELinux 安全基线配置
        - ssh-troubleshoot: SSH 排障指南（连接失败/认证问题/配置错误）
        - python-debug: Python 调试技巧（pdb/logging/异常处理）

        Skill 行为：
        - 知识卡模式：返回 SKILL.md 内容作为参考（content/steps/examples）
        - executor 模式：真正执行 shell/python/http 脚本，返回 stdout/stderr

        何时使用：
        - 用户询问特定领域知识时（如"如何排查 nginx 502"）
        - 需要查阅权威操作步骤时（如"SELinux 基线配置"）
        - 需要执行预定义脚本时（如"检查 docker 容器状态"）

        Args:
            skill_name (str): Skill 名称（大小写不敏感，如 "linux-ops" / "docker-management"）。
            input (str): 调用参数，透传给 skill executor（部分 type 支持 ${input} 替换，可选）。

        Returns:
            dict: 结构化结果，含 status / skill_name / skill_source / content 等字段。
                status 取值: success | not_found | error
                知识卡模式额外字段: content / when_to_use / steps / examples
                executor 模式额外字段: stdout / stderr / exit_code / success
        """
        return invoke_skill_tool(
            params={
                "skill_name": skill_name,
                "input": input,
            },
            ctx=ctx,
        )

    # Strands 从 __name__ 提取工具名，保持原名
    skill_invoke.__name__ = "skill_invoke"
    return skill_invoke


__all__ = [
    "invoke_skill_tool",
    "make_skill_invoke_tool",
]
