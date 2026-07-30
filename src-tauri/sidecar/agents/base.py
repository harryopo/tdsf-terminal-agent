"""
agents/base.py — Agent 基类（T-P1-11.1）
==========================================

BaseAgent 设计：
- 模板方法模式（Template Method）：``invoke()`` 是模板方法，依次调用
  plan → act → observe → reflect 四个钩子
- 依赖反转（DIP）：LLM 调用通过 ``llm_call`` 注入，未配置时使用规则化 mock
- 工具调用通过 ``tools.invoke_tool`` 统一入口（不直接 import 具体工具模块）
- 事件推送通过 ``event_bus.publish``（mood_change / agent_message）
- system prompt = base + TDSF.md 后缀（tdsf_loader.build_agent_system_prompt）

子类扩展点（按需重写）：
1. ``build_system_prompt_base()``：返回角色 base prompt（不含 TDSF.md）
2. ``plan_task(user_input, state)``：规划子任务（返回 list[str]）
3. ``select_tool(task, state)``：选择工具（返回 dict {tool_name, params}）
4. ``format_observation(tool_result, state)``：格式化观察结果（返回 str）
5. ``reflect_on_result(state)``：反思（返回 dict {next_step, reflection}）

模板方法（不可重写）：
- ``invoke(state)``：执行 PAOR 单轮，返回部分状态更新
- ``build_system_prompt()``：构建完整 system prompt

调用流程（与 graph/nodes.py 的 act_node 集成）：
    agent = get_agent("coding")
    update = agent.invoke(state)
    # update 是 dict，与 LangGraph 节点返回值兼容
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol

logger = logging.getLogger("sidecar.agents.base")


# ============================================================================
# 类型定义
# ============================================================================

class LLMCallFunction(Protocol):
    """LLM 调用函数签名（依赖反转，便于测试）

    签名：(messages: list[dict]) -> str

    messages 格式（OpenAI Chat Completions 兼容）：
        [
            {"role": "system", "content": "..."},
            {"role": "user", "content": "..."},
            {"role": "assistant", "content": "..."},
            {"role": "tool", "content": "...", "tool_call_id": "..."},
        ]

    返回：LLM 生成的文本
    """
    def __call__(self, messages: list[dict[str, Any]]) -> str: ...


@dataclass
class AgentResult:
    """Agent 单次 invoke 的结果（与 LangGraph 部分状态更新对齐）

    用法：
        # 在 invoke() 内部构建
        result = AgentResult(
            observation="...",
            intermediate_results=[{...}],
            next_step="continue",
            mood="working",
        )
        return result.to_state_update()
    """

    observation: str = ""
    intermediate_results: list[dict[str, Any]] = field(default_factory=list)
    next_step: str = "continue"  # "continue" | "done" | "error"
    reflection: str = ""
    mood: str = "working"  # "thinking" / "working" / "done" / "error"
    error: str = ""
    # 可选：附加状态更新（如 selected_agent / current_task_index 等）
    extra_update: dict[str, Any] = field(default_factory=dict)

    def to_state_update(self) -> dict[str, Any]:
        """转为 LangGraph 部分状态更新 dict"""
        update: dict[str, Any] = {
            "observation": self.observation,
            "next_step": self.next_step,
            "reflection": self.reflection,
            "mood": self.mood,
        }
        if self.intermediate_results:
            update["intermediate_results"] = self.intermediate_results
        if self.error:
            update["error"] = self.error
        # 合并附加更新
        update.update(self.extra_update)
        return update


# ============================================================================
# BaseAgent — Agent 抽象基类
# ============================================================================

class BaseAgent:
    """Agent 基类（PAOR 模板方法 + 工具/事件/LLM 注入）

    子类通过重写钩子方法实现专属行为，不需要重写 invoke()。

    Args:
        name: Agent 名（main / coding / explore / history / teach）
        role: 角色描述（一句话，用于日志和元数据）
        description: 详细描述（用于 agent.info JSON-RPC）
        tools: 可用工具列表（如 ["risk", "ground"]）
        event_bus: EventBus 实例（用于推送事件，可为 None 用于离线测试）
        llm_call: LLM 调用函数（None 时使用 mock LLM）

    属性：
        name / role / description / tools / event_bus / llm_call
    """

    def __init__(
        self,
        name: str,
        role: str,
        description: str,
        tools: list[str],
        event_bus: Any = None,
        llm_call: LLMCallFunction | None = None,
    ) -> None:
        self.name = name
        self.role = role
        self.description = description
        self.tools = list(tools)
        self.event_bus = event_bus
        self.llm_call = llm_call

        # 调用统计（调试用）
        self._stats = {
            "invocations": 0,
            "tool_calls": 0,
            "llm_calls": 0,
            "errors": 0,
            "total_duration": 0.0,
        }

        # TDSF 魔改 (P2-2 修复 2026-07-28): 构造时检测 llm_call=None
        # 若未注入真实 LLM, 在第一次 invoke 时推送告警给前端
        self._mock_warning_emitted: bool = False

        logger.debug(
            f"agent initialized: name={name}, role={role}, tools={tools}, "
            f"has_event_bus={event_bus is not None}, has_llm={llm_call is not None}"
        )

        # TDSF 修复 2026-07-30 (Bug 2): 构造时立即推送 mock LLM 告警
        # 之前 _publish_mock_warning 只在 call_llm() 内触发, 而整个 sidecar
        # 只有 teach_agent.py 一处调用 call_llm(), 其余 8 个 Agent 路径
        # (main/coding/explore/history/debug/refactor/test/deploy) 永远走不到
        # 告警分支, 前端永远看不到红色 Pill。
        # 修复: 在 __init__ 构造时检测 llm_call=None, 立即推送告警,
        # 覆盖所有 Agent 路径。event_bus 已在 main.py:350 注入, 可安全调用。
        if llm_call is None and self.event_bus is not None:
            self._publish_mock_warning(
                "no_llm_config",
                f"Agent '{self.name}' 构造时未注入 llm_call, "
                f"请检查 .tdsf-data/llm_config.json 或 TDSF_LLM_API_KEY",
            )
            self._mock_warning_emitted = True

    # ========================================================================
    # 模板方法（不可重写）：invoke — 执行 PAOR 单轮
    # ========================================================================

    def invoke(self, state: dict[str, Any]) -> dict[str, Any]:
        """执行 PAOR 单轮（模板方法，子类不应重写）

        流程：
        1. emit mood=thinking
        2. plan_task() → 拆解任务（仅 iteration=0 时调用）
        3. emit mood=working
        4. select_tool() + call_tool() → 执行动作
        5. format_observation() → 观察结果
        6. reflect_on_result() → 反思并决定下一步
        7. emit mood=done/error
        8. 返回部分状态更新 dict

        Args:
            state: AgentState（dict 形式）

        Returns:
            部分状态更新（与 LangGraph 节点返回值兼容）
        """
        start_time = time.time()
        self._stats["invocations"] += 1
        session_id = state.get("session_id", "")
        iteration = state.get("iteration", 0)

        logger.info(
            f"agent.invoke: name={self.name}, iter={iteration}, "
            f"session={session_id}"
        )

        try:
            # === 1. Plan 阶段（仅首轮规划，后续轮次跳过） ===
            self._emit_mood("thinking", session_id)

            plan_update: dict[str, Any] = {}
            if iteration == 0 or not state.get("plan"):
                user_input = state.get("input", "")
                current_task = state.get("current_task", "")
                task_to_plan = current_task if current_task else user_input
                plan_tasks = self.plan_task(task_to_plan, state)
                if plan_tasks:
                    plan_update = {
                        "plan": plan_tasks,
                        "current_task_index": 0,
                        "current_task": plan_tasks[0] if plan_tasks else "",
                        "selected_agent": self.name,
                    }
                    self._emit_message(
                        f"规划完成，共 {len(plan_tasks)} 个子任务",
                        "thinking",
                        session_id,
                    )

            # === 2. Act 阶段：选择工具并调用 ===
            self._emit_mood("working", session_id)

            current_task = state.get("current_task", "") or plan_update.get("current_task", "")
            tool_selection = self.select_tool(current_task, state)

            tool_call_result: dict[str, Any] = {}
            if tool_selection and tool_selection.get("tool_name"):
                tool_name = tool_selection["tool_name"]
                tool_params = tool_selection.get("params", {})
                tool_call_result = self.call_tool(tool_name, tool_params)
                self._emit_message(
                    f"调用工具 {tool_name} 完成",
                    "tool_call",
                    session_id,
                    extra={"tool": tool_name, "params": tool_params},
                )

            # === 3. Observe 阶段：格式化观察结果 ===
            observation = self.format_observation(tool_call_result, state)

            # === 4. Reflect 阶段：反思并决定下一步 ===
            reflection_result = self.reflect_on_result(state)
            next_step = reflection_result.get("next_step", "continue")
            reflection_text = reflection_result.get("reflection", "")

            # TDSF 魔改: 保留 reflect_on_result 返回的额外字段（如 TeachAgent.teaching_content）
            # 实现：把 next_step / reflection / error 之外的字段合并到状态更新，
            # 让子 Agent（如 TeachAgent）能向前端传递结构化教学内容等富数据。
            # 见 agents/teach_agent.py TeachAgent.reflect_on_result() 的 teaching_content 字段。
            RESERVED_REFLECTION_KEYS = {"next_step", "reflection", "error"}
            reflection_extra = {
                k: v for k, v in reflection_result.items()
                if k not in RESERVED_REFLECTION_KEYS
            }

            # === 4.5 Fix-loop 检查（DEC-V321-11 / T-P2-12.2） ===
            # spec 要求：同一操作 max_retry=3，超限强制停手 + needs-you 通知
            # 集成策略：
            #   - 工具调用失败 + Agent 决定 continue（重试） → record_retry
            #   - 重试次数 ≥ max_retry → 强制 next_step="error" + 通知 needs_you
            #   - 工具调用成功 → reset 对应 operation_key（清空失败计数）
            fix_loop_info = self._check_fix_loop(
                session_id=session_id,
                current_task=current_task,
                tool_call_result=tool_call_result,
                next_step=next_step,
            )
            if fix_loop_info["exhausted"]:
                # 强制停手：next_step 改为 error
                next_step = "error"
                reflection_text = (
                    f"{reflection_text}\n"
                    f"[fix-loop] 重试超限（{fix_loop_info['retry_count']}/"
                    f"{fix_loop_info['max_retry']}），强制停手。"
                ).strip()
                logger.warning(
                    f"agent.invoke fix-loop exhausted: name={self.name}, "
                    f"op={fix_loop_info['operation_key']}, "
                    f"retries={fix_loop_info['retry_count']}/"
                    f"{fix_loop_info['max_retry']}"
                )

            # 构建中间结果（追加到 intermediate_results）
            intermediate_results = [{
                "task": current_task,
                "result": tool_call_result,
                "observation": observation,
                "agent": self.name,
                "iteration": iteration,
                "success": next_step != "error",
                "timestamp": time.time(),
                # fix-loop 状态附加到中间结果（便于调试和前端展示）
                "fix_loop": fix_loop_info,
            }]

            # === 5. 构建 AgentResult ===
            mood = "done" if next_step == "done" else (
                "error" if next_step == "error" else "working"
            )

            # fix-loop 超限时附加错误信息
            error_msg = reflection_result.get("error", "")
            if fix_loop_info["exhausted"] and not error_msg:
                error_msg = (
                    f"fix-loop exhausted: retries="
                    f"{fix_loop_info['retry_count']}/{fix_loop_info['max_retry']}"
                )

            result = AgentResult(
                observation=observation,
                intermediate_results=intermediate_results,
                next_step=next_step,
                reflection=reflection_text,
                mood=mood,
                error=error_msg,
                extra_update={
                    **plan_update,
                    "sub_agent_result": {
                        "agent": self.name,
                        "result": tool_call_result,
                        "observation": observation,
                    },
                    # fix-loop 状态附加到状态更新（便于上层 graph 节点感知）
                    "fix_loop": fix_loop_info,
                    # TDSF 魔改: 合并 reflect_on_result 返回的额外字段
                    # （如 TeachAgent.teaching_content），让前端能拿到结构化教学内容
                    **reflection_extra,
                },
            )

            # 推送 mood 事件
            self._emit_mood(mood, session_id)

            # 统计
            duration = time.time() - start_time
            self._stats["total_duration"] += duration
            logger.info(
                f"agent.invoke done: name={self.name}, duration={duration:.3f}s, "
                f"next_step={next_step}, mood={mood}"
            )

            return result.to_state_update()

        except Exception as e:
            self._stats["errors"] += 1
            duration = time.time() - start_time
            self._stats["total_duration"] += duration
            logger.exception(
                f"agent.invoke error: name={self.name}, error={e}, "
                f"duration={duration:.3f}s"
            )
            self._emit_mood("error", session_id)
            return {
                "observation": f"Agent 执行出错: {e}",
                "next_step": "error",
                "mood": "error",
                "error": str(e),
                "intermediate_results": [{
                    "task": state.get("current_task", ""),
                    "result": {},
                    "agent": self.name,
                    "iteration": iteration,
                    "success": False,
                    "error": str(e),
                    "timestamp": time.time(),
                }],
            }

    # ========================================================================
    # 钩子方法（子类按需重写）
    # ========================================================================

    def build_system_prompt_base(self) -> str:
        """返回 base system prompt（不含 TDSF.md 后缀）

        子类重写以定义角色专属 prompt。
        默认实现返回通用 prompt。
        """
        return (
            f"You are {self.name} agent. Role: {self.role}.\n"
            f"Available tools: {', '.join(self.tools)}.\n"
            "Follow the user's instructions and use tools when needed."
        )

    def plan_task(self, user_input: str, state: dict[str, Any]) -> list[str]:
        """规划子任务（钩子方法，子类按需重写）

        默认实现：单步计划（直接处理用户输入）。

        Args:
            user_input: 用户输入或当前任务
            state: AgentState

        Returns:
            子任务列表（如 ["步骤1", "步骤2", ...]）
        """
        return [user_input]

    def select_tool(
        self,
        task: str,
        state: dict[str, Any],
    ) -> dict[str, Any]:
        """选择工具并构建参数（钩子方法，子类按需重写）

        默认实现：无工具调用（返回空 dict）。
        子类应基于 task 内容选择合适的 tool。

        Args:
            task: 当前任务
            state: AgentState

        Returns:
            dict: {"tool_name": str, "params": dict} 或空 dict（不调用工具）
        """
        return {}

    def format_observation(
        self,
        tool_result: dict[str, Any],
        state: dict[str, Any],
    ) -> str:
        """格式化观察结果（钩子方法，子类按需重写）

        默认实现：将 tool_result 转为字符串描述。

        Args:
            tool_result: 工具调用结果
            state: AgentState

        Returns:
            观察结果字符串
        """
        if not tool_result:
            return "无工具调用，无观察结果"
        tool_name = tool_result.get("tool_name", "unknown")
        result = tool_result.get("result", {})
        return f"工具 {tool_name} 执行完成，结果: {result}"

    def reflect_on_result(self, state: dict[str, Any]) -> dict[str, Any]:
        """反思并决定下一步（钩子方法，子类按需重写）

        默认实现：检查 plan 是否完成。
        - 所有任务完成 → next_step=done
        - 还有任务 → next_step=continue

        Args:
            state: AgentState

        Returns:
            dict: {
                "next_step": "continue" | "done" | "error",
                "reflection": str,
                "error": str (optional),
            }
        """
        plan = state.get("plan", [])
        current_idx = state.get("current_task_index", 0)

        # 单步任务（默认 plan_task 返回单元素列表）：直接 done
        if not plan or current_idx >= len(plan) - 1:
            return {
                "next_step": "done",
                "reflection": f"任务完成（agent={self.name}）",
            }

        return {
            "next_step": "continue",
            "reflection": f"任务 {current_idx + 1}/{len(plan)} 完成，继续下一任务",
        }

    # ========================================================================
    # 模板方法（不可重写）：build_system_prompt — 构建完整 system prompt
    # ========================================================================

    def build_system_prompt(self) -> str:
        """构建完整 system prompt（base + TDSF.md 后缀）

        流程：
        1. 调用 build_system_prompt_base() 获取角色 prompt
        2. 调用 tdsf_loader.get_agent_system_prompt_suffix() 获取 TDSF.md 后缀
        3. 拼接（base + 后缀）

        Returns:
            完整 system prompt 字符串
        """
        base = self.build_system_prompt_base()

        # 延迟导入，避免循环依赖
        try:
            from tdsf_loader import get_agent_system_prompt_suffix
            suffix = get_agent_system_prompt_suffix()
        except Exception as e:
            logger.debug(f"failed to get TDSF suffix: {e}")
            suffix = ""

        return base + suffix if suffix else base

    # ========================================================================
    # 辅助方法：LLM 调用 / 工具调用 / 事件推送
    # ========================================================================

    def call_llm(self, messages: list[dict[str, Any]]) -> str:
        """调用 LLM（注入式依赖）

        若未配置 llm_call，则使用 mock LLM（基于规则返回简单文本）。

        Args:
            messages: OpenAI Chat Completions 兼容的消息列表

        Returns:
            LLM 生成的文本
        """
        self._stats["llm_calls"] += 1

        if self.llm_call is not None:
            try:
                return self.llm_call(messages)
            except Exception as e:
                logger.warning(f"llm_call failed, fallback to mock: {e}")
                # TDSF 魔改 (P2-2 修复 2026-07-28): LLM 失败降级到 mock 必须有强告警
                # 避免用户以为在用真实 LLM, 实际收到的是规则化 mock
                self._publish_mock_warning("llm_call_failed", str(e))
        else:
            # TDSF 魔改 (P2-2 修复 2026-07-28): llm_call 未注入 (None) 是最常见配置错误
            # 每个 agent 进程生命周期内只发一次告警, 避免日志洪水
            if not self._mock_warning_emitted:
                self._publish_mock_warning(
                    "no_llm_config",
                    "BaseAgent 未注入 llm_call, 请检查 .tdsf-data/llm_config.json "
                    "或环境变量 TDSF_LLM_API_KEY",
                )
                self._mock_warning_emitted = True

        # TDSF 魔改 (P2-2 修复 2026-07-28): Mock LLM 必须有强告警 + 事件通知
        # 用户配置好 API Key 后, 此分支应永不进入. 进入则说明:
        #   1. llm_call 注入失败 (启动时 load_config 错误)
        #   2. 用户删除/清空 .tdsf-data/llm_config.json
        #   3. BaseAgent 未接收 llm_call (构造时传 None)
        # 通过 event_bus.publish 推送 mock_llm_active 事件, 前端 status bar 实时显示红色告警
        return self._mock_llm(messages)

    def _publish_mock_warning(self, reason: str, detail: str) -> None:
        """TDSF 魔改 (P2-2): 推送 mock LLM 告警到 event_bus

        v2026-07-30 P1-a 修复: 之前直接调用 publish(event_type_str, dict, source=...)
        传 3 参数，但 publish 签名只接受单个 Event 对象，TypeError 被静默吞掉，
        导致事件连 EventBus 都进不去（三重断裂之一）。改用 emit_mock_warning
        便捷方法，与 emit_mood_change/emit_agent_switch 同模式。

        Args:
            reason: 告警原因 (no_llm_config / llm_call_failed)
            detail: 详细描述
        """
        logger.warning(
            f"⚠️ Mock LLM activated for agent={self.name}, reason={reason}, "
            f"detail={detail[:120]}"
        )
        if self.event_bus is not None:
            try:
                self.event_bus.emit_mock_warning(
                    agent=self.name,
                    reason=reason,
                    detail=detail,
                    source=f"{self.name}_agent",
                )
            except Exception as e:
                logger.exception(f"_publish_mock_warning: emit_mock_warning failed: {e}")

    def _mock_llm(self, messages: list[dict[str, Any]]) -> str:
        """Mock LLM（无真实 LLM 时的回退实现）

        基于规则生成响应：
        - 提取最后一条 user 消息
        - 返回 "[mock-llm] received: {content}"

        子类可重写以实现更复杂的 mock 逻辑。
        """
        last_user = ""
        for msg in reversed(messages):
            if msg.get("role") == "user":
                last_user = msg.get("content", "")
                break
        return f"[mock-llm] {self.name} received: {last_user[:200]}"

    def call_tool(self, name: str, params: dict[str, Any]) -> dict[str, Any]:
        """调用 MCP tool（通过 tools.invoke_tool 统一入口）

        Args:
            name: 工具名（risk / confidence / ground / decision / credibility / history）
            params: 工具参数

        Returns:
            工具调用结果 dict（含 tool_name / params / result / duration / success）
        """
        start_time = time.time()
        self._stats["tool_calls"] += 1

        # 校验工具是否在可用列表
        if name not in self.tools:
            logger.warning(
                f"agent {self.name} calling unauthorized tool: {name} "
                f"(allowed: {self.tools})"
            )
            # 仍允许调用，但记录警告（不强制拦截，由 permission_check 节点处理）

        try:
            # 延迟导入，避免循环依赖
            from tools import invoke_tool
            result = invoke_tool(name, params)
            duration = time.time() - start_time
            return {
                "tool_name": name,
                "params": params,
                "result": result,
                "duration": round(duration, 3),
                "success": True,
            }
        except Exception as e:
            duration = time.time() - start_time
            logger.exception(f"tool call failed: {name}, error={e}")
            return {
                "tool_name": name,
                "params": params,
                "result": {"error": str(e)},
                "duration": round(duration, 3),
                "success": False,
                "error": str(e),
            }

    def _emit_mood(self, mood: str, session_id: str = "") -> None:
        """发布 mood_change 事件到 event_bus

        Args:
            mood: thinking / working / done / error
            session_id: 会话 ID
        """
        if self.event_bus is None:
            return
        try:
            from event_bus import Event, EventType
            self.event_bus.publish(Event(
                event_type=EventType.MOOD_CHANGE.value,
                payload={
                    "mood": mood,
                    "agent": self.name,
                },
                session_id=session_id or None,
                source=f"{self.name}_agent",
            ))
        except Exception as e:
            logger.debug(f"emit_mood failed: {e}")

    def _emit_agent_switch(
        self,
        agent: str,
        task: str = "",
        session_id: str = "",
    ) -> None:
        """发布 agent_switch 事件到 event_bus（v2026-07-29 新增）

        用于主 Agent 路由到子 Agent 时通知前端更新 AgentStatusPill。
        前端通过 sidecar:agent_switch Tauri event 订阅，
        实时显示当前路由到的子 Agent（coding / teach / debug / ...）。

        Args:
            agent: 目标子 Agent 名称
            task: 当前子任务描述（可选）
            session_id: 会话 ID
        """
        if self.event_bus is None:
            return
        try:
            from event_bus import Event, EventType
            payload = {
                "agent": agent,
                "from_agent": self.name,
            }
            if task:
                payload["task"] = task
            self.event_bus.publish(Event(
                event_type=EventType.AGENT_SWITCH.value,
                payload=payload,
                session_id=session_id or None,
                source=f"{self.name}_agent",
            ))
        except Exception as e:
            logger.debug(f"emit_agent_switch failed: {e}")

    def _emit_message(
        self,
        content: str,
        message_type: str = "output",
        session_id: str = "",
        extra: dict[str, Any] | None = None,
    ) -> None:
        """发布 agent_message 事件到 event_bus

        Args:
            content: 消息内容
            message_type: 消息类型（thinking / working / output / tool_call）
            session_id: 会话 ID
            extra: 附加字段（如 tool / params）
        """
        if self.event_bus is None:
            return
        try:
            from event_bus import Event, EventType
            payload = {
                "content": content,
                "type": message_type,
                "agent": self.name,
            }
            if extra:
                payload.update(extra)
            self.event_bus.publish(Event(
                event_type=EventType.AGENT_MESSAGE.value,
                payload=payload,
                session_id=session_id or None,
                source=f"{self.name}_agent",
            ))
        except Exception as e:
            logger.debug(f"emit_message failed: {e}")

    # ========================================================================
    # Fix-loop 集成（DEC-V321-11 / T-P2-12.2）
    # ========================================================================

    def _check_fix_loop(
        self,
        session_id: str,
        current_task: str,
        tool_call_result: dict[str, Any],
        next_step: str,
    ) -> dict[str, Any]:
        """Fix-loop 重试检查（DEC-V321-11）

        集成策略：
        1. 工具调用失败（success=False）+ Agent 决定 continue（重试）
           → 调用 FixLoopTracker.record_retry 记录一次重试
        2. 重试次数 ≥ max_retry（默认 3）
           → 标记 exhausted=True，由 invoke() 强制 next_step="error"
           → 调用 NeedsYouService.notify_fix_loop_exhausted 通知用户
        3. 工具调用成功（success=True）
           → 调用 FixLoopTracker.reset 清空对应 operation_key 的失败计数
           （避免历史失败累积影响未来重试预算）

        Args:
            session_id:        会话 ID
            current_task:      当前任务描述
            tool_call_result:  工具调用结果（含 success / tool_name / error）
            next_step:         Agent reflect 决定的下一步（continue/done/error）

        Returns:
            fix_loop_info dict：
            {
                "enabled": bool,           # fix-loop 是否启用
                "operation_key": str,      # 操作标识
                "retry_count": int,        # 当前重试次数
                "max_retry": int,          # 最大重试次数
                "exhausted": bool,         # 是否已超限
                "near_limit": bool,        # 是否接近上限
                "last_error": str,         # 最后错误信息
                "notified": bool,          # 是否已通知 needs-you
            }
        """
        # 默认返回值（fix-loop 异常时降级，不阻塞 Agent 执行）
        default_info: dict[str, Any] = {
            "enabled": False,
            "operation_key": "",
            "retry_count": 0,
            "max_retry": 3,
            "exhausted": False,
            "near_limit": False,
            "last_error": "",
            "notified": False,
        }

        try:
            # 延迟导入，避免循环依赖
            from fix_loop import build_operation_key, get_global_tracker

            tracker = get_global_tracker()
            max_retry = tracker.max_retry

            # 构建 operation_key（基于 task + tool_name）
            tool_name = tool_call_result.get("tool_name", "") if tool_call_result else ""
            operation_key = build_operation_key(current_task, tool_name)

            # 工具调用是否成功
            tool_success = bool(tool_call_result.get("success", True)) if tool_call_result else True

            # 工具调用成功 → 重置对应 operation_key 的失败计数
            if tool_success:
                reset_count = tracker.reset(session_id, operation_key)
                if reset_count > 0:
                    logger.debug(
                        f"fix-loop reset on success: session={session_id}, "
                        f"op={operation_key}, cleared={reset_count}"
                    )
                return {
                    "enabled": True,
                    "operation_key": operation_key,
                    "retry_count": 0,
                    "max_retry": max_retry,
                    "exhausted": False,
                    "near_limit": False,
                    "last_error": "",
                    "notified": False,
                }

            # 工具调用失败 + Agent 决定 continue（重试） → 记录重试
            # 注意：next_step == "done" 或 "error" 时不记录（Agent 已放弃重试）
            if next_step != "continue":
                # Agent 不再重试，无需记录（但仍返回当前状态供查询）
                retry_count = tracker.get_retry_count(session_id, operation_key)
                return {
                    "enabled": True,
                    "operation_key": operation_key,
                    "retry_count": retry_count,
                    "max_retry": max_retry,
                    "exhausted": retry_count >= max_retry,
                    "near_limit": retry_count >= 2,
                    "last_error": tracker.get_last_error(session_id, operation_key),
                    "notified": False,
                }

            # 记录一次重试
            error_msg = (
                tool_call_result.get("error", "")
                or str(tool_call_result.get("result", {}).get("error", ""))
                or "tool call failed"
            )
            retry_count = tracker.record_retry(
                session_id=session_id,
                operation_key=operation_key,
                error=error_msg,
            )

            exhausted = tracker.is_exhausted(session_id, operation_key)
            near_limit = tracker.is_near_limit(session_id, operation_key)

            # 超限 → 通知 needs-you
            notified = False
            if exhausted:
                try:
                    from needs_you import get_global_service
                    needs_service = get_global_service()
                    needs_service.notify_fix_loop_exhausted(
                        session_id=session_id,
                        operation_key=operation_key,
                        retry_count=retry_count,
                        max_retry=max_retry,
                        last_error=error_msg,
                        task=current_task,
                        source=f"{self.name}_agent.fix_loop",
                    )
                    notified = True
                    logger.info(
                        f"fix-loop notified needs_you: session={session_id}, "
                        f"op={operation_key}, retries={retry_count}/{max_retry}"
                    )
                except Exception as notify_err:
                    logger.exception(
                        f"fix-loop notify needs_you failed: {notify_err}"
                    )

            return {
                "enabled": True,
                "operation_key": operation_key,
                "retry_count": retry_count,
                "max_retry": max_retry,
                "exhausted": exhausted,
                "near_limit": near_limit,
                "last_error": error_msg,
                "notified": notified,
            }

        except Exception as e:
            logger.exception(f"fix-loop check failed (degraded): {e}")
            return default_info

    # ========================================================================
    # 元数据 / 统计
    # ========================================================================

    def get_stats(self) -> dict[str, Any]:
        """获取调用统计（调试用）"""
        return {
            **self._stats,
            "avg_duration": (
                self._stats["total_duration"] / self._stats["invocations"]
                if self._stats["invocations"] > 0
                else 0.0
            ),
        }

    def __repr__(self) -> str:
        return (
            f"<{self.__class__.__name__} "
            f"name={self.name!r} role={self.role!r} "
            f"tools={self.tools}>"
        )
