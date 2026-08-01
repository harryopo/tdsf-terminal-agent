"""
strands_backend/adapter.py — Strands Agent 适配层
===================================================

职责：
- ``StrandsAgentAdapter`` 类：封装 Strands Agent 的创建、工具注册、invoke 调用，
  与现有 needs_you BaseAgent PAOR 架构协作（通过 feature flag 切换）。
- 与现有 ``agents/base.py`` 的 ``BaseAgent.invoke(state)`` 签名对齐（返回值
  含 observation / next_step / mood / intermediate_results），让前端
  ``sidecar-adapter.ts`` 切片流式逻辑零改动。
- 流式响应：通过 ``event_bus.emit_agent_message`` 推送中间结果（Strands
  callback_handler 事件转发），替代当前 dict 切片模拟流式。
- 错误处理：try/except 包裹 invoke 全流程，失败时 ``emit_needs_you``
  通知前端（needs_type="error"），不抛错阻塞 agent loop。
- 优雅降级：Strands 未安装 / model 未注入 / feature flag 关闭时，
  返回 degraded 状态的结构化结果（与 BaseAgent mock LLM 降级模式一致）。

设计原则：
1. Strands 是条件依赖（运行时缺失时优雅降级，不影响 sidecar 启动）。
2. 不修改现有 ``agents/base.py`` / ``event_bus.py`` / ``main.py`` 等文件，
   通过 feature flag 在 ``main.py`` 注册段注入。
3. 工具通过 ``make_all_ops_tools(ctx)`` 构造，自动绑定 ``ToolContext``。
4. callback_handler 内联实现，把 Strands 事件 → event_bus 便捷方法。

集成点（main.py:332-358，本适配层不修改该文件，仅给出推荐用法）：

    backend = os.environ.get("TDSF_AGENT_BACKEND", "langgraph").lower()
    if backend == "strands":
        try:
            from strands_backend import StrandsAgentAdapter
            from strands_backend.tools import DefaultRustBridge
            adapter = StrandsAgentAdapter(
                event_bus=event_bus.get_global_bus(),
                rust_bridge=DefaultRustBridge(),  # P2 阶段注入 send_request
                backend_enabled=True,
            )
            agents.set_backend(lambda agent_id, input, state: adapter.invoke(agent_id, input, state))
        except Exception as se:
            logger.exception(f"failed to activate Strands backend, fallback: {se}")
            agents.configure_agents(event_bus=event_bus.get_global_bus(), llm_call=llm_call)
"""
from __future__ import annotations

import logging
import re
import time
from typing import Any, Callable

from strands_backend.tools import (
    DefaultRustBridge,
    RustBridge,
    ToolContext,
    TOOL_DECORATOR_AVAILABLE,
    make_all_ops_tools,
)

logger = logging.getLogger("sidecar.strands_backend.adapter")

# Strands 条件导入
try:
    from strands import Agent as _StrandsAgent  # type: ignore[import]
    _STRANDS_AGENT_AVAILABLE = True
except ImportError:
    _STRANDS_AGENT_AVAILABLE = False
    _StrandsAgent = None  # type: ignore[assignment]

# 默认 system prompt（构造时未提供则用此）
# TDSF 修复 2026-07-31 (P4): 新增 skill_invoke 工具说明，让 LLM 知道可调用 Skill
# TDSF 修复 2026-07-31 (P4-b): 新增 suggest_command 工具说明，让 LLM 生成可执行命令
_DEFAULT_SYSTEM_PROMPT = (
    "You are TDSF Terminal Agent (Strands backend), a Linux operations assistant.\n"
    "You help users diagnose and resolve Linux server issues via SSH.\n\n"
    "Available tools:\n"
    "- ssh_command(command, ssh_session_id, explanation, timeout): 执行 SSH 命令\n"
    "- read_remote_file(path, ssh_session_id, max_size, encoding): 读远程文件\n"
    "- analyze_logs(log_path, mode, lines, pattern, ssh_session_id): 分析日志\n"
    "- inspect_processes(mode, filter_user, filter_name, pid, top_n, ssh_session_id): 进程检查\n"
    "- network_diagnose(mode, target, count, port, ssh_session_id): 网络诊断\n"
    "- skill_invoke(skill_name, input): 调用已注册的 Skill 获取领域知识或执行特定任务\n"
    "  可用 Skill: linux-ops / docker-management / selinux-baseline / "
    "ssh-troubleshoot / python-debug\n"
    "  何时使用: 用户询问特定领域知识时（如\"如何排查 nginx 502\"）、"
    "需要查阅权威操作步骤时、需要执行预定义脚本时\n"
    "- suggest_command(intent, target_os): 根据用户意图生成一条可执行的 Linux 命令及解释\n"
    "  何时使用: 用户想要执行某个操作但不知道具体命令时（如\"查看系统负载\"\"列出当前目录\"）\n"
    "  注意: 生成命令后不要自动执行，等待用户确认；前端会展示 Insert 按钮供用户一键插入终端\n\n"
    "Constraints:\n"
    "- 高危命令（rm -rf / reboot / shutdown / mkfs / dd 等）会触发 needs_you 审批，不要试图绕过。\n"
    "- 工具返回 status=unavailable 时，说明 RustBridge 未配置（P2 双向 JSON-RPC 未启用），"
    "应告知用户当前为只读模式。\n"
    "- 工具返回 status=needs_approval 时，命令已发起审批，等待用户响应，不要重复调用同一命令。\n"
    "- skill_invoke 返回 content 字段时是知识卡模式（参考内容），返回 stdout 字段时是 executor 模式（已执行）。\n"
    "- 使用 suggest_command 后，向用户说明命令作用并提示可点击 Insert 插入终端执行。\n"
    "- 回答用中文，简洁明了，给出可执行建议。\n"
)


def _strip_env_block(text: str) -> str:
    """剥离前端注入的 <env>...</env> 上下文块

    前端 transport.ts 会把 <env>workspace_root/active_terminal_cwd/...</env>
    前缀注入到 input，只用于 LLM 上下文提示。若直接显示给用户（如 thinking
    提示"开始处理: ..."）会泄漏内部上下文。此 helper 在展示前剥离该块。
    """
    if not text:
        return text
    stripped = text
    while True:
        start = stripped.find("<env>")
        if start == -1:
            break
        end = stripped.find("</env>", start)
        if end == -1:
            stripped = stripped[:start].rstrip()
            break
        stripped = (stripped[:start] + stripped[end + len("</env>") :]).strip()
    return stripped


# ============================================================================
# TdsfStrandsCallbackHandler — Strands 事件 → event_bus 转发
# ============================================================================

# Strands hooks 条件导入（P1-NEW-v2-3 fix-loop 保护用）
try:
    from strands.hooks.events import (  # type: ignore[import]
        AfterToolCallEvent,
        BeforeToolCallEvent,
    )

    _STRANDS_HOOKS_AVAILABLE = True
except ImportError:
    AfterToolCallEvent = None  # type: ignore[assignment]
    BeforeToolCallEvent = None  # type: ignore[assignment]
    _STRANDS_HOOKS_AVAILABLE = False


class ToolCallLimitHook:
    """Strands HookProvider：工具调用次数保护（P1-NEW-v2-3，fix-loop 近似）

    LangGraph 路径有 BaseAgent._check_fix_loop 防重试风暴；Strands override
    路径的工具调用由 Strands event loop 驱动，绕过该保护。本 hook 用
    Strands 公共 Hook API（Before/AfterToolCallEvent）实现同等语义：
    - 单次 invoke 总工具调用数超过 max_tool_calls → 取消后续调用（防死循环）
    - 同一工具连续失败 max_failures 次 → 取消该工具的后续调用
      （成功调用重置该工具失败计数，与 fix_loop 的 reset 语义一致）

    注意：LimitToolCounts 在当前 strands 版本不存在（构造处旧注释过时），
    此为自实现等价物。hook 实例按 (agent_id, session_id) 缓存于 adapter，
    跨 invoke 累计计数（与 fix_loop 跨会话保护一致）。
    """

    def __init__(
        self,
        max_tool_calls: int = 12,
        max_failures: int = 3,
        agent_name: str = "main",
    ) -> None:
        self.max_tool_calls = max_tool_calls
        self.max_failures = max_failures
        self.agent_name = agent_name
        self.total_calls = 0
        self.failures_by_tool: dict[str, int] = {}
        self.cancelled = False

    def register_hooks(self, registry: Any) -> None:
        """HookProvider 协议：注册 Before/AfterToolCallEvent 回调"""
        if not _STRANDS_HOOKS_AVAILABLE:
            return
        registry.add_callback(BeforeToolCallEvent, self._before_tool_call)
        registry.add_callback(AfterToolCallEvent, self._after_tool_call)

    def _tool_name(self, event: Any) -> str:
        tool_use = getattr(event, "tool_use", None)
        if isinstance(tool_use, dict):
            return str(tool_use.get("name", "?"))
        return str(getattr(tool_use, "get", lambda k, d=None: d)("name", "?"))

    def _before_tool_call(self, event: Any) -> None:
        if self.cancelled:
            event.cancel_tool = True
            return
        self.total_calls += 1
        if self.total_calls > self.max_tool_calls:
            self.cancelled = True
            event.cancel_tool = (
                f"工具调用次数超过上限（{self.max_tool_calls}），已终止任务"
            )
            return
        name = self._tool_name(event)
        if self.failures_by_tool.get(name, 0) >= self.max_failures:
            event.cancel_tool = (
                f"工具 {name} 连续失败 {self.max_failures} 次，已停止调用该工具"
            )

    def _after_tool_call(self, event: Any) -> None:
        name = self._tool_name(event)
        failed = getattr(event, "exception", None) is not None
        if failed:
            self.failures_by_tool[name] = self.failures_by_tool.get(name, 0) + 1
        else:
            self.failures_by_tool[name] = 0

    def reset(self) -> None:
        """重置计数（agent 缓存清理时调用）"""
        self.total_calls = 0
        self.failures_by_tool.clear()
        self.cancelled = False


class TdsfStrandsCallbackHandler:
    """Strands callback_handler 协议实现：把 Strands 事件转发到 event_bus

    Strands callback_handler 协议：可调用对象，接收 **kwargs 事件。
    事件类型（来自 Strands stream_async 文档）：
    - init_event_loop / start_event_loop / start / message / complete / force_stop
    - current_tool_use（含 name + input）
    - data（文本增量）

    转发策略：
    - data（文本增量）→ event_bus.emit_agent_message（流式推送）
    - current_tool_use → event_bus.emit_tool_call（工具调用开始）
    - start → event_bus.emit_mood_change("thinking")
    - complete → event_bus.emit_mood_change("working")
    - force_stop → event_bus.emit_mood_change("error")

    用法：
        handler = TdsfStrandsCallbackHandler(event_bus, agent_name="main", session_id="...")
        agent = StrandsAgent(callback_handler=handler, ...)
    """

    def __init__(
        self,
        event_bus: Any,
        agent_name: str = "main",
        session_id: str = "",
    ) -> None:
        self.event_bus = event_bus
        self.agent_name = agent_name
        self.session_id = session_id
        # 统计（调试用）
        self._stats = {
            "events_received": 0,
            "messages_emitted": 0,
            "tool_calls_emitted": 0,
            "mood_changes_emitted": 0,
        }

    def __call__(self, **kwargs: Any) -> None:
        """Strands callback_handler 协议入口"""
        self._stats["events_received"] += 1
        try:
            self._handle_event(kwargs)
        except Exception as e:
            logger.exception(f"callback handler error: {e}")

    def _handle_event(self, event: dict) -> None:
        """处理单个 Strands 事件

        注意（2026-07-31 修复）：不在此处转发 current_tool_use 事件——
        Strands 的 current_tool_use 是**流式中途态**（streaming.py 里 input
        是逐 delta 拼接的残缺 JSON 字符串，block 结束才 json.loads），
        直接 emit 会产生 input={} 的空参数工具行（前端显示 "Input {}"）。
        工具实现内部（strands_backend/tools/*.py）会在拿到完整参数后
        自行 emit started/completed，此处转发是冗余且错误的。
        """
        # 深度思考流（模型 reasoningContent 增量）→ thinking 消息
        reasoning_text = event.get("reasoningText")
        if reasoning_text and isinstance(reasoning_text, str):
            self._emit_agent_message(reasoning_text, msg_type="thinking")

        # 文本增量 → agent_message（流式推送）
        data = event.get("data")
        if data and isinstance(data, str):
            self._emit_agent_message(data, msg_type="output")

        # 循环开始 → mood=thinking
        if event.get("start"):
            self._emit_mood("thinking")

        # 循环完成 → mood=working（仍在处理，最终 mood 由 invoke() 设 done）
        elif event.get("complete"):
            self._emit_mood("working")

        # 强制停止 → mood=error
        if event.get("force_stop"):
            self._emit_mood("error")
            logger.warning(
                f"strands force_stop: agent={self.agent_name}, "
                f"reason={event.get('force_stop_reason', 'unknown')}"
            )

    def _emit_mood(self, mood: str) -> None:
        if self.event_bus is None:
            return
        try:
            self.event_bus.emit_mood_change(
                mood=mood,
                session_id=self.session_id or None,
                source=f"{self.agent_name}_agent.strands",
            )
            self._stats["mood_changes_emitted"] += 1
        except Exception as e:
            logger.debug(f"emit_mood_change failed: {e}")

    def _emit_tool_call(self, tool_name: str, tool_input: dict) -> None:
        if self.event_bus is None:
            return
        try:
            self.event_bus.emit_tool_call(
                tool_name=tool_name,
                params=tool_input,
                status="started",
                session_id=self.session_id or None,
                source=f"{self.agent_name}_agent.strands",
            )
            self._stats["tool_calls_emitted"] += 1
        except Exception as e:
            logger.debug(f"emit_tool_call failed: {e}")

    def _emit_agent_message(self, text: str, msg_type: str = "output") -> None:
        if self.event_bus is None or not text:
            return
        try:
            self.event_bus.emit_agent_message(
                content=text,
                message_type=msg_type,
                session_id=self.session_id or None,
                source=f"{self.agent_name}_agent.strands",
            )
            self._stats["messages_emitted"] += 1
        except Exception as e:
            logger.debug(f"emit_agent_message failed: {e}")


# ============================================================================
# StrandsAgentAdapter — 适配层核心
# ============================================================================

# P1-NEW-v2-4: main_agent 关键词路由 → Strands prompt 角色指令
# （Strands override 路径无 BaseAgent PAOR，用路由意图引导回答风格）
_ROUTE_PROMPT_HINTS: dict[str, str] = {
    "teach": (
        "用户请求教学讲解。请以教学口吻输出：先讲清概念与原理，"
        "再给出可执行的 Linux 命令/配置示例，最后留一个练习或思考题。"
    ),
    "coding": (
        "用户请求代码修改。请定位问题、给出修改方案，"
        "并说明每个改动点的原因。"
    ),
    "explore": (
        "用户请求查找/定位。请先明确搜索目标，再逐步定位并说明依据。"
    ),
    "debug": (
        "用户请求排查故障。请按根因分析流程：收集现象 → 假设 → "
        "用工具验证 → 给出修复建议。"
    ),
    "history": "用户查询历史/之前的内容。请基于已有上下文回答。",
    "refactor": "用户请求重构。请说明重构动机、改动范围与验证方式。",
    "test": "用户请求测试。请给出测试用例与执行方式。",
    "deploy": "用户请求部署/发布。请给出部署步骤与验证命令。",
}


class StrandsAgentAdapter:
    """Strands Agent 适配层

    封装 Strands Agent 的创建、工具注册、invoke 调用，与现有 needs_you
    BaseAgent PAOR 架构协作。

    Args:
        event_bus: EventBus 实例（用于推送 mood_change / agent_message / tool_call / needs_you）
        rust_bridge: RustBridge 实例（工具调 Rust 后端的抽象层），None 时用 DefaultRustBridge()
        backend_enabled: 后端是否启用（feature flag），False 时直接降级
        system_prompt: 系统提示词（None 时用默认 _DEFAULT_SYSTEM_PROMPT）
        strands_model: Strands Model 对象（OpenAIModel / AnthropicModel / OllamaModel / LiteLLMModel），
                       None 时降级（不调真实 LLM）
        max_iterations: Strands Agent 最大迭代次数（防死循环），默认 10
        extra_tools: 额外工具列表（除 5 个运维工具外），默认空

    用法：
        adapter = StrandsAgentAdapter(
            event_bus=event_bus.get_global_bus(),
            rust_bridge=DefaultRustBridge(),
            backend_enabled=True,
        )
        result = adapter.invoke("main", "检查 nginx 状态", state={...})
        # result: {observation, next_step, mood, intermediate_results, ...}
    """

    def __init__(
        self,
        event_bus: Any,
        rust_bridge: RustBridge | None = None,
        backend_enabled: bool = True,
        system_prompt: str | None = None,
        strands_model: Any = None,
        max_iterations: int = 10,
        extra_tools: list | None = None,
    ) -> None:
        self.event_bus = event_bus
        self.rust_bridge = rust_bridge or DefaultRustBridge()
        self.backend_enabled = backend_enabled
        self.system_prompt = system_prompt or _DEFAULT_SYSTEM_PROMPT
        self.strands_model = strands_model
        self.max_iterations = max_iterations
        self.extra_tools = list(extra_tools) if extra_tools else []

        # Strands 可用性快照
        self._strands_available = _STRANDS_AGENT_AVAILABLE and TOOL_DECORATOR_AVAILABLE
        self._model_available = strands_model is not None

        # P1-NEW-v2-4: main_agent 路由单例缓存
        self._main_agent_singleton = None

        # 缓存的 Strands Agent 实例
        # P1-NEW-v2-2 修复 (2026-07-30): 缓存 key 从 agent_id 改为 (agent_id, session_id)，
        # 避免 multi-session 并发时 callback_handler 和工具闭包绑定的首次 session_id
        # 导致事件路由到错误会话（needs_you 审批卡片错会话）。
        self._agent_cache: dict[tuple[str, str], Any] = {}

        logger.info(
            f"StrandsAgentAdapter initialized: "
            f"backend_enabled={backend_enabled}, "
            f"strands_available={self._strands_available}, "
            f"model_available={self._model_available}, "
            f"rust_bridge={type(self.rust_bridge).__name__}"
        )

    # ========================================================================
    # 主入口：invoke
    # ========================================================================

    # P1-NEW-v2-4: 路由角色 → prompt 角色指令（Strands main 按风格回答）
    def _route_main_agent(
        self, agent_id: str, input: str, session_id: str
    ) -> str | None:
        """恢复 main_agent 关键词路由意图（Strands override 路径）

        返回路由到的子 Agent 名（teach/coding/...），未路由返回 None。
        路由结果会 emit agent_switch 事件（前端 Pill 显示）。
        """
        if agent_id != "main" or not input:
            return None
        try:
            from agents.main_agent import MainAgent  # 延迟 import 防循环

            agent = self._main_agent_instance()
            plan = agent.plan_task(input, {})
            if not plan:
                return None
            m = re.match(r"\[(\w+)\]", str(plan[0]))
            routed = m.group(1) if m else None
            if routed not in _ROUTE_PROMPT_HINTS:
                return None
            self._emit_agent_switch(routed, session_id)
            return routed
        except Exception as e:
            logger.debug(f"main agent routing unavailable: {e}")
            return None

    def _main_agent_instance(self) -> Any:
        """模块级缓存的 MainAgent 实例（plan_task 只依赖输入，构造一次即可）"""
        import agents.main_agent as _ma

        if self._main_agent_singleton is None:
            self._main_agent_singleton = _ma.MainAgent()
        return self._main_agent_singleton

    def _emit_agent_switch(self, agent: str, session_id: str) -> None:
        if self.event_bus is None:
            return
        try:
            self.event_bus.emit_agent_switch(
                agent=agent,
                session_id=session_id or None,
                source="main_agent.strands_route",
            )
        except Exception as e:
            logger.debug(f"emit_agent_switch failed: {e}")

    def invoke(
        self,
        agent_id: str,
        input: str,
        state: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Strands Agent 调用主入口

        与现有 ``BaseAgent.invoke(state)`` 返回值结构对齐：
        - observation: str, Agent 最终输出
        - next_step: str, "done" | "error"
        - mood: str, "thinking" | "working" | "done" | "error"
        - intermediate_results: list[dict], 中间步骤记录
        - (可选) degraded: bool, 是否降级
        - (可选) degraded_reason: str, 降级原因

        Args:
            agent_id: Agent 标识（如 "main" / "debug"），用于事件 source + 缓存键
            input: 用户输入文本（Agent 主提示词）
            state: Agent 状态 dict（含 session_id / live / messages 等，可选）

        Returns:
            结构化结果 dict（与 BaseAgent.invoke 返回值对齐）
        """
        state = state or {}
        session_id = state.get("session_id", "") or ""
        start_time = time.time()

        logger.info(
            f"StrandsAgentAdapter.invoke: agent_id={agent_id}, "
            f"session={session_id}, input_len={len(input)}"
        )

        # 1. 检查降级条件
        degraded_reason = self._check_degraded()
        if degraded_reason:
            return self._degraded_response(
                agent_id=agent_id,
                input=input,
                session_id=session_id,
                reason=degraded_reason,
                start_time=start_time,
            )

        # 2. 推送 mood=thinking（前端 AgentStatusPill 显示"思考中"）
        self._emit_mood("thinking", agent_id, session_id)

        try:
            # 3. 构建工具上下文
            ctx = self._build_tool_context(agent_id, session_id, state)

            # 4. 获取或创建 Strands Agent
            strands_agent = self._get_or_create_agent(agent_id, ctx)

            # 5. 构建 prompt（注入 live 上下文）
            prompt = self._build_prompt(input, state)

            # TDSF 修复 2026-08-01 (P1-NEW-v2-4): Strands 路径恢复 main_agent
            # 关键词路由的"路由意图"。Strands override 绕过 BaseAgent PAOR
            # 后 plan_task 不再执行，教学/编码等请求失去角色化处理。此处：
            #   ① 跑 plan_task 解析路由（teach/coding/...）
            #   ② emit agent_switch（前端 AgentStatusPill 显示子 Agent）
            #   ③ 把角色指令注入 prompt（Strands main 以对应风格回答）
            routed_agent = self._route_main_agent(agent_id, input, session_id)
            if routed_agent:
                role_hint = _ROUTE_PROMPT_HINTS.get(routed_agent)
                if role_hint:
                    prompt = f"{prompt}\n\n[路由到 {routed_agent}]\n{role_hint}"

            # 6. 推送 mood=working
            self._emit_mood("working", agent_id, session_id)

            # 7. 调用 Strands Agent（同步，agentic loop 内部触发 callback_handler）
            self._emit_agent_message(
                agent_id=agent_id,
                session_id=session_id,
                content=f"开始处理: {_strip_env_block(input)[:100]}",
                msg_type="thinking",
            )

            response = strands_agent(prompt)

            # 8. 提取最终输出
            observation = self._extract_response_text(response)

            self._emit_mood("done", agent_id, session_id)
            duration = time.time() - start_time

            logger.info(
                f"StrandsAgentAdapter.invoke success: agent_id={agent_id}, "
                f"duration={duration:.3f}s, output_len={len(observation)}"
            )

            return {
                "observation": observation,
                "next_step": "done",
                "mood": "done",
                "intermediate_results": [{
                    "task": input,
                    "result": {
                        "agent_id": agent_id,
                        "strands_response": str(response)[:500],
                    },
                    "observation": observation,
                    "agent": agent_id,
                    "iteration": 0,
                    "success": True,
                    "timestamp": time.time(),
                    "duration": round(duration, 3),
                }],
                "tokens": self._extract_tokens(response),
            }

        except Exception as e:
            duration = time.time() - start_time
            logger.exception(
                f"StrandsAgentAdapter.invoke error: agent_id={agent_id}, "
                f"error={e}, duration={duration:.3f}s"
            )
            self._emit_mood("error", agent_id, session_id)
            self._emit_needs_you_for_error(agent_id, session_id, input, e)

            return {
                "observation": f"Strands Agent 执行出错: {e}",
                "next_step": "error",
                "mood": "error",
                "error": str(e),
                "intermediate_results": [{
                    "task": input,
                    "result": {"error": str(e)},
                    "observation": f"Agent 执行出错: {e}",
                    "agent": agent_id,
                    "iteration": 0,
                    "success": False,
                    "error": str(e),
                    "timestamp": time.time(),
                    "duration": round(duration, 3),
                }],
            }

    # ========================================================================
    # 降级处理
    # ========================================================================

    def _check_degraded(self) -> str:
        """检查是否需要降级

        Returns:
            空字符串表示不降级；非空字符串为降级原因
        """
        if not self.backend_enabled:
            return "feature_flag_disabled"
        if not self._strands_available:
            return "strands_not_installed"
        if not self._model_available:
            return "strands_model_not_injected"
        return ""

    def _degraded_response(
        self,
        agent_id: str,
        input: str,
        session_id: str,
        reason: str,
        start_time: float,
    ) -> dict[str, Any]:
        """构建降级响应

        与 BaseAgent mock LLM 降级模式一致：返回结构化结果 + emit_needs_you 通知。
        """
        duration = time.time() - start_time
        reason_messages = {
            "feature_flag_disabled": "Strands 后端 feature flag 未启用（TDSF_AGENT_BACKEND!=strands）",
            "strands_not_installed": "strands-agents 包未安装，请 pip install strands-agents",
            "strands_model_not_injected": "Strands Model 对象未注入（需 P0 阶段实现 model_adapter.py）",
        }
        message = reason_messages.get(reason, f"未知降级原因: {reason}")

        logger.warning(
            f"StrandsAgentAdapter degraded: agent_id={agent_id}, "
            f"reason={reason}, message={message}"
        )

        observation = (
            f"[strands-backend-degraded] {message}\n"
            f"输入: {input[:200]}\n"
            f"建议: 切换回 LangGraph 后端（TDSF_AGENT_BACKEND=langgraph）或配置 Strands 依赖。"
        )

        # 推送 needs_you 事件（前端状态栏显示降级告警）
        self._emit_needs_you_for_degradation(agent_id, session_id, reason, message)

        return {
            "observation": observation,
            "next_step": "done",
            "mood": "done",
            "intermediate_results": [{
                "task": input,
                "result": {"degraded": True, "reason": reason, "message": message},
                "observation": observation,
                "agent": agent_id,
                "iteration": 0,
                "success": False,
                "degraded": True,
                "timestamp": time.time(),
                "duration": round(duration, 3),
            }],
            "degraded": True,
            "degraded_reason": reason,
            "degraded_message": message,
        }

    # ========================================================================
    # Strands Agent 创建与缓存
    # ========================================================================

    def _get_or_create_agent(self, agent_id: str, ctx: ToolContext) -> Any:
        """获取或创建 Strands Agent 实例（按 agent_id 缓存）

        Args:
            agent_id: Agent 标识
            ctx: ToolContext（用于构建工具）

        Returns:
            Strands Agent 实例
        """
        # P1-v5-2: 缓存 key 含 permission_level——工具集按级别过滤（L1 只读），
        # 级别变化后必须重建 agent（否则旧工具集残留）
        cache_key = (agent_id, ctx.session_id, ctx.permission_level)
        if cache_key in self._agent_cache:
            return self._agent_cache[cache_key]

        # 构建 5 个运维工具（带 ctx 闭包）
        ops_tools = make_all_ops_tools(ctx)
        all_tools = ops_tools + self.extra_tools

        # 构建 callback_handler
        handler = TdsfStrandsCallbackHandler(
            event_bus=self.event_bus,
            agent_name=agent_id,
            session_id=ctx.session_id,
        )

        # 创建 Strands Agent
        # mypy: _StrandsAgent 在降级路径已被排除，这里必有值
        #
        # TDSF 魔改 2026-07-30 P0-E: Strands 1.50.2 API 变更
        #   Agent.__init__() 移除了 max_iterations 参数（实测装 1.50.2 后
        #   报 "Agent.__init__() got an unexpected keyword argument 'max_iterations'"）。
        #   控制迭代次数的新方式是 hooks=[LimitToolCounts(max_tool_counts={...})]
        #   或自定义 HookProvider（见 Strands 官方文档 hooks.mdx）。
        #   当前先移除该参数让 LLM 调用工作起来，self.max_iterations 字段保留
        #   供未来用 LimitToolCounts hook 实现总工具调用次数限制（防死循环）。
        # TDSF 修复 2026-08-01 (P1-NEW-v2-3): 接入自实现 ToolCallLimitHook
        #   （LimitToolCounts 在当前 strands 版本不存在），实现工具调用次数
        #   上限 + 单工具连续失败保护（fix-loop 近似语义，绕过 BaseAgent
        #   _check_fix_loop 的 Strands override 路径从此有保护）。
        agent = _StrandsAgent(  # type: ignore[misc]
            model=self.strands_model,
            tools=all_tools,
            system_prompt=self.system_prompt,
            callback_handler=handler,
            hooks=[ToolCallLimitHook(agent_name=agent_id)],
            # max_iterations=self.max_iterations,  # Strands 1.50.2 已移除
        )

        self._agent_cache[cache_key] = agent
        logger.info(
            f"Strands Agent created: agent_id={agent_id}, session_id={ctx.session_id}, "
            f"tools={[t.__name__ if hasattr(t, '__name__') else str(t) for t in all_tools]}"
        )
        return agent

    # ========================================================================
    # 工具上下文构建
    # ========================================================================

    def _build_tool_context(
        self,
        agent_id: str,
        session_id: str,
        state: dict[str, Any],
    ) -> ToolContext:
        """构建工具运行时上下文

        从 state 中提取 live 上下文（cwd / activeFile / sshSessionId 等），
        与适配层方案 §6.2 终端上下文感知方案 A 对齐。
        """
        live = state.get("live") or {}

        # P1-v5-4: 4 级权限（1=免确认 2=仅高危 3=高危+写操作 4=全部确认）。
        # 前端 live.permissionLevel 注入（默认 2，保持原行为）；非法值夹取到 1-4。
        try:
            permission_level = int(live.get("permissionLevel", 2))
        except (TypeError, ValueError):
            permission_level = 2
        permission_level = max(1, min(4, permission_level))

        return ToolContext(
            event_bus=self.event_bus,
            rust_bridge=self.rust_bridge,
            agent_name=agent_id,
            session_id=session_id,
            user_id=state.get("user_id", "") or "",
            ssh_session_id=live.get("sshSessionId", "") or "",
            permission_level=permission_level,
        )

    # ========================================================================
    # Prompt 构建
    # ========================================================================

    def _build_prompt(self, input: str, state: dict[str, Any]) -> str:
        """构建 Agent 输入 prompt（注入 live 上下文）

        与方案 §6.2 终端上下文感知方案 A 对齐：在 input 末尾追加 <live_context> 块。

        Args:
            input: 用户原始输入
            state: Agent 状态 dict

        Returns:
            注入 live 上下文后的 prompt
        """
        live = state.get("live") or {}
        lines: list[str] = []

        if live.get("cwd"):
            lines.append(f"当前终端工作目录: {live['cwd']}")
        if live.get("activeFile"):
            lines.append(f"当前激活文件: {live['activeFile']}")
        if live.get("workspaceRoot"):
            lines.append(f"工作区根目录: {live['workspaceRoot']}")
        if live.get("terminalPrivate"):
            lines.append("当前终端处于隐私模式（内容不可见）")
        if live.get("sshSessionId"):
            lines.append(
                f"已连接 SSH 会话: {live['sshSessionId']}（可调用 ssh_command 工具执行远程命令）"
            )
        else:
            lines.append("未连接 SSH 会话（本地终端模式，ssh_command 工具将返回 unavailable）")

        if not lines:
            return input

        context_block = "<live_context>\n" + "\n".join(lines) + "\n</live_context>"
        return f"{input}\n\n{context_block}"

    # ========================================================================
    # Strands 响应解析
    # ========================================================================

    @staticmethod
    def _extract_response_text(response: Any) -> str:
        """从 Strands Agent 响应中提取最终文本

        Strands 1.x Agent 响应对象支持 str() 转最终文本，
        也可能有 .message.content / .text 等字段，这里做兼容处理。
        """
        if response is None:
            return ""
        # 优先 str(response)（Strands 推荐方式）
        try:
            text = str(response)
            if text and not text.startswith("<"):
                return text
        except Exception:
            pass

        # 兼容字段
        for attr in ("text", "content", "output"):
            val = getattr(response, attr, None)
            if isinstance(val, str) and val:
                return val

        # message.content 列表
        message = getattr(response, "message", None)
        if message is not None:
            content = getattr(message, "content", None)
            if isinstance(content, list):
                texts = [
                    block.get("text", "")
                    for block in content
                    if isinstance(block, dict) and block.get("type") == "text"
                ]
                if texts:
                    return "\n".join(texts)
            elif isinstance(content, str):
                return content

        return str(response)

    @staticmethod
    def _extract_tokens(response: Any) -> dict[str, Any]:
        """从 Strands Agent 响应中提取 token 统计

        Strands 1.x 在 response.metrics 或 response.usage 暴露 token 统计。
        """
        if response is None:
            return {}

        metrics = getattr(response, "metrics", None)
        if isinstance(metrics, dict):
            return {
                "input_tokens": metrics.get("input_tokens", 0),
                "output_tokens": metrics.get("output_tokens", 0),
                "total_tokens": metrics.get("total_tokens", 0),
            }

        usage = getattr(response, "usage", None)
        if isinstance(usage, dict):
            return {
                "input_tokens": usage.get("input_tokens", 0) or usage.get("prompt_tokens", 0),
                "output_tokens": usage.get("output_tokens", 0) or usage.get("completion_tokens", 0),
                "total_tokens": usage.get("total_tokens", 0),
            }

        return {}

    # ========================================================================
    # event_bus 事件推送辅助方法
    # ========================================================================

    def _emit_mood(self, mood: str, agent_id: str, session_id: str) -> None:
        if self.event_bus is None:
            return
        try:
            self.event_bus.emit_mood_change(
                mood=mood,
                session_id=session_id or None,
                source=f"{agent_id}_agent.strands",
            )
        except Exception as e:
            logger.debug(f"emit_mood_change failed: {e}")

    def _emit_agent_message(
        self,
        agent_id: str,
        session_id: str,
        content: str,
        msg_type: str = "output",
    ) -> None:
        if self.event_bus is None or not content:
            return
        try:
            self.event_bus.emit_agent_message(
                content=content,
                message_type=msg_type,
                session_id=session_id or None,
                source=f"{agent_id}_agent.strands",
            )
        except Exception as e:
            logger.debug(f"emit_agent_message failed: {e}")

    def _emit_needs_you_for_error(
        self,
        agent_id: str,
        session_id: str,
        input: str,
        error: Exception,
    ) -> None:
        """invoke 异常时推送 needs_you（needs_type=error）"""
        if self.event_bus is None:
            return
        try:
            self.event_bus.emit_needs_you(
                needs_type="error",
                title=f"Strands Agent 执行出错: {agent_id}",
                description=(
                    f"Agent {agent_id} 调用 Strands 后端时抛异常:\n"
                    f"  输入: {input[:200]}\n"
                    f"  错误: {str(error)[:500]}\n"
                    f"请检查 Strands 依赖 / Model 配置 / RustBridge 状态。"
                ),
                session_id=session_id or None,
                source=f"{agent_id}_agent.strands.adapter",
                priority="normal",
                agent=agent_id,
                error_type=type(error).__name__,
            )
        except Exception as e:
            logger.debug(f"emit_needs_you for error failed: {e}")

    def _emit_needs_you_for_degradation(
        self,
        agent_id: str,
        session_id: str,
        reason: str,
        message: str,
    ) -> None:
        """降级时推送 needs_you（needs_type=error, priority=normal）"""
        if self.event_bus is None:
            return
        try:
            self.event_bus.emit_needs_you(
                needs_type="error",
                title=f"Strands 后端降级: {reason}",
                description=(
                    f"Agent {agent_id} 的 Strands 后端降级运行:\n"
                    f"  原因: {reason}\n"
                    f"  详情: {message}\n"
                    f"当前 invoke 返回 degraded 状态，建议切换回 LangGraph 后端。"
                ),
                session_id=session_id or None,
                source=f"{agent_id}_agent.strands.adapter",
                priority="normal",
                agent=agent_id,
                degraded_reason=reason,
            )
        except Exception as e:
            logger.debug(f"emit_needs_you for degradation failed: {e}")

    # ========================================================================
    # 缓存管理
    # ========================================================================

    def clear_cache(self) -> None:
        """清空 Agent 缓存（配置变更后调用）"""
        count = len(self._agent_cache)
        self._agent_cache.clear()
        logger.info(f"Strands Agent cache cleared: {count} entries")

    def update_model(self, new_model: Any) -> None:
        """更新 LLM 模型并清空 Agent 缓存（agent.configure 调用时同步更新）

        P1-NEW-v3-1 修复 (2026-07-30):
        - 原版 _rpc_agent_configure 仅更新 _global_llm_call + BaseAgent.llm_call,
          Strands adapter.strands_model 和 _agent_cache 未更新, 前端误报 ok:true
        - 修复: agent.configure 在 Strands 模式下显式调用 adapter.update_model,
          更新 strands_model + 清空 _agent_cache (旧 Agent 实例绑定了旧 model)
        - 清空缓存是必须的: Strands Agent 在构造时绑定 model 闭包,
          即使 adapter.strands_model 更新, 旧 Agent 实例仍用旧 model

        Args:
            new_model: 新的 Strands Model 实例 (OpenAIModel/AnthropicModel/LiteLLMModel);
                       None 时表示降级 (走 mock_llm_active 路径)
        """
        old_available = self._model_available
        self.strands_model = new_model
        self._model_available = new_model is not None
        # 必须清缓存: 旧 Agent 实例闭包绑定旧 model, 不清会用旧 model
        self.clear_cache()
        logger.info(
            f"Strands model updated: "
            f"old_available={old_available}, "
            f"new_available={self._model_available}"
        )

    def get_stats(self) -> dict[str, Any]:
        """获取适配层状态（调试用）"""
        return {
            "backend_enabled": self.backend_enabled,
            "strands_available": self._strands_available,
            "model_available": self._model_available,
            "rust_bridge_type": type(self.rust_bridge).__name__,
            "cached_agents": [
                f"{a}:{s}" for (a, s) in self._agent_cache.keys()
            ],
            "max_iterations": self.max_iterations,
            "extra_tools_count": len(self.extra_tools),
        }


__all__ = [
    "StrandsAgentAdapter",
    "TdsfStrandsCallbackHandler",
]
