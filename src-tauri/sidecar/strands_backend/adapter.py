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
    "  注意: 生成命令后不要自动执行，等待用户确认；前端会展示 Insert 按钮供用户一键插入终端\n"
    "- knowledge_search(query, limit): 检索内置 Linux 教学知识库（命令/概念/哲学/排障案例）\n"
    "  何时使用: 用户询问 Linux 概念/命令用法/运维知识时，先用知识库检索获取权威内容再回答\n\n"
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
    - tool_stream（agent-as-tool 子 agent 工具流事件，P0-6 新增）
    - message 含 toolResult（子 agent 完成回填，P0-6 新增）

    转发策略：
    - data（文本增量）→ event_bus.emit_agent_message（流式推送）
    - current_tool_use → event_bus.emit_tool_call（工具调用开始）
    - start → event_bus.emit_mood_change("thinking")
    - complete → event_bus.emit_mood_change("working")
    - force_stop → event_bus.emit_mood_change("error")
    - tool_stream（子 agent）→ emit_tool_call("agent:<name>", started)
    - 子 agent data → emit_agent_message(msg_type="agent_call") + agent_switch
    - message.toolResult（子 agent 完成）→ emit_tool_call("agent:<name>", completed)

    P0-6 (2026-08-01): main agent 委派子 agent（agent-as-tool）可视化。
    子 agent 的中间事件以 tool_stream / data+agent 形式到达**main**的 handler
    （子 agent 自身用静默 handler 防文本污染），此处统一转发为前端可渲染的
    agent 调用工具行事件。

    用法：
        handler = TdsfStrandsCallbackHandler(event_bus, agent_name="main", session_id="...")
        agent = StrandsAgent(callback_handler=handler, ...)
    """

    def __init__(
        self,
        event_bus: Any,
        agent_name: str = "main",
        session_id: str = "",
        sub_agent_names: set[str] | None = None,
    ) -> None:
        self.event_bus = event_bus
        self.agent_name = agent_name
        self.session_id = session_id
        # P0-6: 子 agent 名集合（识别 agent-as-tool 中间事件）
        self.sub_agent_names = set(sub_agent_names or [])
        # 已发起 agent 调用事件（tool_use_id → agent 名），避免重复 emit
        self._agent_call_started: dict[str, str] = {}
        self._agent_switch_emitted: set[str] = set()
        # 统计（调试用）
        self._stats = {
            "events_received": 0,
            "messages_emitted": 0,
            "tool_calls_emitted": 0,
            "mood_changes_emitted": 0,
            "agent_calls_emitted": 0,
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

        P0-6 (2026-08-01)：新增 agent-as-tool 子 agent 事件转发
        （tool_stream / data+agent / message.toolResult），不涉及
        current_tool_use 的缺陷。
        """
        # --- P0-6: agent-as-tool 子 agent 事件（优先处理，避免被 data 分支吞掉）---
        if self.sub_agent_names:
            if self._handle_sub_agent_events(event):
                return

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

    # ========================================================================
    # P0-6: agent-as-tool 子 agent 事件处理
    # ========================================================================

    def _handle_sub_agent_events(self, event: dict) -> bool:
        """处理子 agent 相关事件（tool_stream / data+agent / toolResult）

        Returns:
            True = 事件已被消费（无需继续处理）；False = 非子 agent 事件
        """
        # 1. tool_stream 事件：子 agent 工具流（tool_use 含 name/input，
        #    data 内嵌子 agent 的 data 增量——子 agent 用静默 handler，
        #    其文本增量只经此包装到达 main）
        if event.get("type") == "tool_stream":
            tse = event.get("tool_stream_event") or {}
            tool_use = tse.get("tool_use") or {}
            name = tool_use.get("name", "")
            if name in self.sub_agent_names:
                self._emit_agent_call_started(name, tool_use)
                data = tse.get("data") or {}
                if isinstance(data, dict):
                    inner = data.get("data")
                    if isinstance(inner, str) and inner:
                        self._emit_agent_call_delta(name, inner)
                return True

        # 2. data + agent 对象：子 agent 文本增量（agent 是子 agent 实例）
        data = event.get("data")
        if data and isinstance(data, str):
            agent_obj = event.get("agent")
            sub_name = getattr(agent_obj, "name", "") if agent_obj else ""
            if sub_name in self.sub_agent_names:
                self._emit_agent_call_delta(sub_name, data)
                return True

        # 3. message 含 toolResult：子 agent 完成（toolUseId 回填给 main）
        msg = event.get("message")
        if isinstance(msg, dict):
            content = msg.get("content")
            if isinstance(content, list):
                for block in content:
                    tr = block.get("toolResult") if isinstance(block, dict) else None
                    if not tr:
                        continue
                    tool_use_id = tr.get("toolUseId", "")
                    name = self._agent_call_started.get(tool_use_id)
                    if name in self.sub_agent_names:
                        self._emit_agent_call_completed(name, tool_use_id, tr)
                        return True

        return False

    def _emit_agent_call_started(self, name: str, tool_use: dict) -> None:
        """子 agent 调用开始 → agent 工具行 started（按 tool_use_id 去重）"""
        tool_use_id = tool_use.get("toolUseId", "") or f"agent-{name}-{len(self._agent_call_started)}"
        if tool_use_id in self._agent_call_started:
            return
        self._agent_call_started[tool_use_id] = name
        self._emit_agent_switch(name)
        if self.event_bus is None:
            return
        try:
            self.event_bus.emit_tool_call(
                tool_name=f"agent:{name}",
                params=tool_use.get("input") or {"input": ""},
                status="started",
                session_id=self.session_id or None,
                source=f"{self.agent_name}_agent.strands.agent_as_tool",
            )
            self._stats["agent_calls_emitted"] += 1
        except Exception as e:
            logger.debug(f"emit agent call started failed: {e}")

    def _emit_agent_call_delta(self, name: str, data: str) -> None:
        """子 agent 文本增量 → agent_message(msg_type=agent_call)

        前端不把 agent_call 渲染进主输出流（子 agent 全文在 completed 的
        tool output 中展示），此事件主要供调试/日志与未来流式增强。
        """
        if not self._agent_switch_emitted:
            self._emit_agent_switch(name)
        if self.event_bus is None or not data:
            return
        try:
            self.event_bus.emit_agent_message(
                content=data,
                message_type="agent_call",
                session_id=self.session_id or None,
                source=f"{self.agent_name}_agent.strands.agent_as_tool",
            )
        except Exception as e:
            logger.debug(f"emit agent call delta failed: {e}")

    def _emit_agent_call_completed(self, name: str, tool_use_id: str, tool_result: dict) -> None:
        """子 agent 完成 → agent 工具行 completed（结果 = 子 agent 最终文本）"""
        if self.event_bus is None:
            return
        # 提取子 agent 最终文本（content[0].text）
        result_text = ""
        content = tool_result.get("content")
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("text"):
                    result_text += str(block["text"])
        status = tool_result.get("status", "success")
        try:
            self.event_bus.emit_tool_call(
                tool_name=f"agent:{name}",
                params={},
                status="completed" if status == "success" else "error",
                result=result_text or tool_result,
                session_id=self.session_id or None,
                source=f"{self.agent_name}_agent.strands.agent_as_tool",
            )
            self._stats["agent_calls_emitted"] += 1
        except Exception as e:
            logger.debug(f"emit agent call completed failed: {e}")
        # P1-2: 子 agent 委派也记录为会话证据（AI 依据了专家子 agent 的输出）
        try:
            from strands_backend.evidence import get_global_tracker

            get_global_tracker().record(
                session_id=self.session_id or "",
                tool_name=f"agent:{name}",
                status="completed" if status == "success" else "error",
                detail=f"委派 {name} Agent",
                result=result_text or str(tool_result)[:200],
                agent=self.agent_name,
                source="agent_as_tool",
            )
        except Exception as e:
            logger.debug(f"evidence record failed: {e}")

    def _emit_agent_switch(self, agent: str) -> None:
        if self.event_bus is None:
            return
        if agent in self._agent_switch_emitted:
            return
        self._agent_switch_emitted.add(agent)
        try:
            self.event_bus.emit_agent_switch(
                agent=agent,
                session_id=self.session_id or None,
                source=f"{self.agent_name}_agent.strands.agent_as_tool",
            )
        except Exception as e:
            logger.debug(f"emit_agent_switch failed: {e}")

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

# P0-1 (2026-08-01, 方案书 B 方案): 多 Agent 注册表。
# 前端显式选择 agent（main/coder/explore/history/teach，见前端
# src/modules/ai/agents/registry.ts），后端为每个 agent 创建**真实**的
# Strands Agent 实例：独立 system prompt + 按角色裁剪的工具集
# （schema-level safety：explore/teach 无 ssh_command，LLM 无法调用
# 不存在于其 schema 的执行工具）。
# 注意：工具白名单用 @tool 装饰后的函数名（见 tools/__init__.py
# _L1_READONLY_TOOL_NAMES 的说明），与 OPS_TOOL_NAMES 注册名不同。
_SUB_AGENT_SPECS: dict[str, dict[str, Any]] = {
    "main": {
        "tool_names": None,  # 全量 7 工具
        "system_prompt": None,  # 用构造时默认 prompt
    },
    "explore": {
        "tool_names": {
            "read_remote_file",
            "analyze_logs",
            "inspect_processes",
            "network_diagnose",
            "suggest_command",
            "knowledge_search",
            "security_audit",
            "performance_analyze",
        },
        "system_prompt": (
            "You are the Explore Agent of TDSF Terminal Agent, a read-only "
            "Linux system explorer.\n"
            "You locate information: read files, analyze logs, inspect "
            "processes, diagnose network, and suggest commands.\n\n"
            "Constraints:\n"
            "- 你是只读 Agent，没有执行命令的工具；需要用户执行时用 "
            "suggest_command 生成命令并说明作用，等待用户确认。\n"
            "- 回答用中文，先给结论，再给依据（文件路径/日志行/命令输出）。"
        ),
    },
    "teach": {
        "tool_names": {
            "read_remote_file",
            "analyze_logs",
            "skill_invoke",
            "suggest_command",
            "knowledge_search",
        },
        "system_prompt": (
            "You are the Teach Agent of TDSF Terminal Agent, a Linux "
            "operations instructor for beginners.\n"
            "You explain concepts, commands and troubleshooting steps in a "
            "structured teaching style.\n\n"
            "Teaching format (6 大板块，按适用度选用，使用纯文字标题，不用 emoji):\n"
            "1. 概念与原理：用生活化比喻讲清是什么、为什么（底层原理优先）。\n"
            "2. 路径拆解：涉及文件路径时逐段解剖每层目录的含义（FHS 标准）。\n"
            "3. Linux 设计哲学：讲命令/机制时点明背后的设计哲学"
            "（一切皆文件 / 组合小工具 / 权限最小化 / 机制策略分离 / KISS 等），"
            "配实例说明哲学如何体现在操作上。\n"
            "4. 操作示例：给出可执行的 Linux 命令/配置，逐条解释参数含义。\n"
            "5. 易错点与考点：列出初学者常犯错误。\n"
            "6. 练习：留 1 个练习或思考题（先想再敲：提示学生先思考再执行）。\n\n"
            "Constraints:\n"
            "- 你是教学 Agent，不执行命令；需要演示时用 suggest_command "
            "生成命令并提示用户可点击 Insert 插入终端。\n"
            "- 讲解命令/概念前，先调 knowledge_search 检索知识库"
            "（命令词源/设计哲学/FHS/90 命令档案），基于权威内容讲解，"
            "不要凭空发挥。\n"
            "- 可用 skill_invoke 查阅领域知识（linux-ops / ssh-troubleshoot 等）。\n"
            "- 回答用中文，内容分节清晰（Markdown 标题 + 列表），不使用 emoji。"
        ),
    },
    "coding": {
        "tool_names": {
            "ssh_command",
            "read_remote_file",
            "suggest_command",
            "service_manage",
            "package_manage",
            "firewall_manage",
            "security_audit",
            "performance_analyze",
        },
        "system_prompt": (
            "You are the Coding Agent of TDSF Terminal Agent, focused on "
            "locating, explaining and fixing code/config issues on the "
            "connected Linux host.\n\n"
            "Working style:\n"
            "- 先复现/定位问题（read_remote_file 读配置、ssh_command 跑只读命令），"
            "再给出修改方案。\n"
            "- 每个改动点说明原因；高危命令会触发审批，不要试图绕过。\n"
            "- 回答用中文，给出可执行建议。"
        ),
    },
    "history": {
        "tool_names": {
            "suggest_command",
            "skill_invoke",
            "knowledge_search",
        },
        "system_prompt": (
            "You are the History Agent of TDSF Terminal Agent. "
            "You answer questions about past operations, commands, and "
            "troubleshooting patterns based on the conversation context.\n\n"
            "Constraints:\n"
            "- 无历史检索工具时，基于当前会话上下文回答，并诚实说明。\n"
            "- 可用 skill_invoke 查阅领域知识卡。\n"
            "- 回答用中文。"
        ),
    },
}

# P0-6 (2026-08-01, main 统一入口 + 自主委派): 子 agent 工具描述
# （main agent 的 as_tool 描述，让 LLM 理解何时委派哪个专家）
_SUB_AGENT_TOOL_DESCRIPTIONS: dict[str, str] = {
    "teach": (
        "教学讲解 Agent：用户请求讲解概念/命令/排障原理时委派。"
        "输入教学主题，返回结构化教学文本（概念/示例/易错点/练习）。"
        "只读，不执行命令。"
    ),
    "coding": (
        "代码/配置修改 Agent：用户请求定位或修复代码/配置文件时委派。"
        "输入问题描述，返回修改方案与原因。"
    ),
    "explore": (
        "只读探索 Agent：需要查找文件/分析日志/检查进程/诊断网络时委派。"
        "输入探索目标，返回发现与依据。"
    ),
    "history": (
        "历史/知识 Agent：用户询问过往操作或需要领域知识卡时委派。"
        "输入问题，返回基于上下文的回答。"
    ),
}

# main agent 委派说明（追加到 main 的 system_prompt，让 LLM 知道可委派）
_MAIN_SUB_AGENT_PROMPT = (
    "\n\nSub-agents (委派专家):\n"
    "- teach(input): 用户请求教学讲解时调用（概念/示例/易错点/练习）\n"
    "- coding(input): 用户请求定位/修复代码或配置时调用\n"
    "- explore(input): 需要只读探索（文件/日志/进程/网络）时调用\n"
    "- history(input): 用户询问过往操作/领域知识时调用\n"
    "委派原则：识别用户意图后调用最合适的子 agent，把子 agent 的返回"
    "整合进你的最终回答。普通运维操作（执行命令/读文件）直接自己用工具，"
    "不需要委派。"
)


class _SilentCallbackHandler:
    """静默 callback_handler：子 agent 用，防止其文本污染 main 输出流

    子 agent 的中间事件会以 tool_stream / data+agent 形式经 AgentAsToolStreamEvent
    到达 **main** 的 handler（TdsfStrandsCallbackHandler 统一转发），
    因此子 agent 自身的 handler 必须静默，避免同一文本被 emit 两次。
    子 agent 内部工具调用的 emit_tool_call 由工具代码直接发（不受此影响）。
    """

    def __call__(self, **kwargs: Any) -> None:
        pass


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

        # 缓存的 Strands Agent 实例
        # P1-NEW-v2-2 修复 (2026-07-30): 缓存 key 从 agent_id 改为 (agent_id, session_id)，
        # 避免 multi-session 并发时 callback_handler 和工具闭包绑定的首次 session_id
        # 导致事件路由到错误会话（needs_you 审批卡片错会话）。
        self._agent_cache: dict[tuple[str, str], Any] = {}

        # P0-6: 子 agent 工具缓存（agent-as-tool，按 (agent_id, session_id, perm)）
        self._sub_agent_cache: dict[tuple[str, str, int], Any] = {}

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

    def _emit_agent_switch(self, agent: str, session_id: str) -> None:
        if self.event_bus is None:
            return
        try:
            self.event_bus.emit_agent_switch(
                agent=agent,
                session_id=session_id or None,
                source=f"{agent}_agent.strands",
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

            # P0-1 (2026-08-01, 方案书 B 方案): 前端显式选择 agent → 真实
            # Strands Agent。不再做关键词路由模拟——Pill 显示的就是正在
            # 运行的 agent（emit agent_switch 让前端 AgentStatusPill 同步）。
            self._emit_agent_switch(agent_id, session_id)

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

            # P2-4 决策库: AI 排障成功自动沉淀案例（教学复盘/历史检索）
            # 条件: 会话有工具调用证据 + 有结论输出 + 输入像排障请求
            self._auto_sink_case(agent_id, input, observation, session_id)

            self._emit_mood("done", agent_id, session_id)
            # P0-6: main 委派结束后 Pill 归位到主 agent（委派期间显示子 agent）
            if agent_id == "main":
                self._emit_agent_switch("main", session_id)
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

            # P0-4 (2026-08-01): 运行时失败返回 degraded 标志，
            # 前端据此显示友好降级提示（而非把错误当正常输出流式显示）
            return {
                "observation": f"Strands Agent 执行出错: {e}",
                "next_step": "error",
                "mood": "error",
                "error": str(e),
                "degraded": True,
                "degraded_reason": "invoke_error",
                "degraded_message": f"Strands Agent 执行出错: {e}",
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

        P0-1 (2026-08-01, 方案书 B 方案): 按 _SUB_AGENT_SPECS 为每个
        agent_id 创建**真实** Strands Agent——独立 system prompt +
        按角色裁剪的工具集（schema-level safety）。main 用默认 prompt
        + 全量工具，其余 agent 用角色 prompt + 工具白名单。

        P0-6 (2026-08-01, main 统一入口): main 的工具集额外挂载 4 个
        子 agent 工具（Agent.as_tool）——main 识别用户意图后自主委派。
        子 agent 内部用静默 handler（防文本污染），其中间事件经
        tool_stream / data+agent 到达 main 的 handler 统一转发。

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

        spec = _SUB_AGENT_SPECS.get(agent_id) or _SUB_AGENT_SPECS["main"]
        tool_names = spec.get("tool_names")
        system_prompt = spec.get("system_prompt") or self.system_prompt

        # 构建运维工具（带 ctx 闭包 + 角色白名单过滤）
        ops_tools = make_all_ops_tools(ctx, tool_names=tool_names)
        all_tools = ops_tools + self.extra_tools

        # P0-6: main agent 挂载子 agent 工具（agent-as-tool 委派）
        sub_agent_names = set()
        if agent_id == "main" or agent_id not in _SUB_AGENT_SPECS:
            for sub_name in _SUB_AGENT_TOOL_DESCRIPTIONS:
                try:
                    all_tools.append(
                        self._create_sub_agent_tool(sub_name, ctx)
                    )
                    sub_agent_names.add(sub_name)
                except Exception as e:
                    logger.warning(
                        f"failed to create sub agent tool '{sub_name}': {e}"
                    )
            system_prompt = system_prompt + _MAIN_SUB_AGENT_PROMPT

        # P2-3: 扩展运维工具（service/package/firewall/security/performance）
        try:
            from strands_backend.tools.ops_extended import (
                AGENT_EXTENDED_TOOLS,
                EXTENDED_TOOL_FACTORIES,
            )

            for ext_name in AGENT_EXTENDED_TOOLS.get(agent_id, set()):
                if tool_names is not None and ext_name not in tool_names:
                    continue
                factory = EXTENDED_TOOL_FACTORIES.get(ext_name)
                if factory:
                    all_tools.append(factory(ctx))
                    sub_agent_names.discard(ext_name)
        except Exception as e:
            logger.warning(f"extended tools attach failed for {agent_id}: {e}")

        # 构建 callback_handler（main 转发子 agent 事件；子 agent 用静默）
        handler = (
            TdsfStrandsCallbackHandler(
                event_bus=self.event_bus,
                agent_name=agent_id,
                session_id=ctx.session_id,
                sub_agent_names=sub_agent_names,
            )
            if agent_id == "main" or agent_id not in _SUB_AGENT_SPECS
            else _SilentCallbackHandler()
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
        # TDSF 修复 2026-08-09: 移除工具调用上限（用户要求）。
        #   原 ToolCallLimitHook(max_tool_calls=12) 会强制终止超过 12 次工具调用的
        #   会话，用户反馈"本次排查已到达工具调用上限"影响教学体验。
        #   现改为不挂 hook，让 agent 自由调用工具直到任务完成。
        agent = _StrandsAgent(  # type: ignore[misc]
            model=self.strands_model,
            tools=all_tools,
            system_prompt=system_prompt,
            callback_handler=handler,
            hooks=[],
            name=agent_id,
            # max_iterations=self.max_iterations,  # Strands 1.50.2 已移除
        )

        self._agent_cache[cache_key] = agent
        logger.info(
            f"Strands Agent created: agent_id={agent_id}, session_id={ctx.session_id}, "
            f"tools={[t.__name__ if hasattr(t, '__name__') else str(t) for t in all_tools]}"
        )
        return agent

    def _create_sub_agent_tool(self, sub_agent_id: str, ctx: ToolContext) -> Any:
        """创建子 agent 并包装为 Agent 工具（agent-as-tool，P0-6）

        子 agent 按 _SUB_AGENT_SPECS 构造（独立 prompt + 工具白名单），
        缓存于 _sub_agent_cache，避免每次 main 重建时重复构造。

        Args:
            sub_agent_id: 子 agent 名（teach/coding/explore/history）
            ctx: 与 main 相同的 ToolContext（共享 session/权限/桥）

        Returns:
            Strands Agent.as_tool() 包装的工具对象
        """
        cache_key = (sub_agent_id, ctx.session_id, ctx.permission_level)
        cached = self._sub_agent_cache.get(cache_key)
        if cached is not None:
            return cached

        spec = _SUB_AGENT_SPECS.get(sub_agent_id) or _SUB_AGENT_SPECS["main"]
        tools = make_all_ops_tools(ctx, tool_names=spec.get("tool_names"))
        system_prompt = spec.get("system_prompt") or self.system_prompt

        sub_agent = _StrandsAgent(  # type: ignore[misc]
            model=self.strands_model,
            tools=tools,
            system_prompt=system_prompt,
            callback_handler=_SilentCallbackHandler(),
            hooks=[],
            name=sub_agent_id,
        )
        tool = sub_agent.as_tool(
            name=sub_agent_id,
            description=_SUB_AGENT_TOOL_DESCRIPTIONS.get(
                sub_agent_id, f"委派给 {sub_agent_id} Agent"
            ),
        )
        self._sub_agent_cache[cache_key] = tool
        logger.info(
            f"Sub-agent tool created: {sub_agent_id}, "
            f"tools={[getattr(t, '__name__', str(t)) for t in tools]}"
        )
        return tool

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
            # str() 对任意对象几乎不抛异常；若抛（罕见），继续走下方兼容字段兜底
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

    def _auto_sink_case(
        self,
        agent_id: str,
        user_input: str,
        observation: str,
        session_id: str,
    ) -> None:
        """P2-4 决策库: AI 排障成功自动沉淀案例

        条件（防噪音）：
        - 输入像排障/问题请求（含排障/查/修/怎么/why/error/502/失败 等）
        - 会话有工具调用证据（说明真执行了操作）
        - 输出有实质结论（>60 字符）
        去重：按输入 hash 生成稳定 id（同一问题只沉淀一次）。

        失败静默（沉淀是加分项，不影响主流程）。
        """
        try:
            if len(observation or "") < 60:
                return
            if len(user_input or "") < 6:
                return
            # 输入像排障请求
            probe = user_input.lower()
            if not any(
                k in probe
                for k in ("排障", "查", "修", "怎么", "为什么", "error", "502", "失败",
                          "无法", "不行", "挂了", "连不上", "启动", "重启")
            ):
                return
            # 会话有工具调用证据
            try:
                from strands_backend.evidence import get_global_tracker

                evs = get_global_tracker().list(session_id or "")
                if not evs:
                    return
            except Exception:
                return
            # 沉淀（稳定 id 去重：md5(输入)）
            import hashlib

            case_id = "case-" + hashlib.md5(user_input.encode("utf-8")).hexdigest()[:12]
            from knowledge.fts5 import KnowledgeEntry
            from knowledge.rag import get_global_rag

            rag = get_global_rag()
            detail_lines = []
            for ev in evs[-5:]:
                if ev.get("tool_name", "").startswith("agent:"):
                    detail_lines.append(f"[委派] {ev.get('detail', '')}")
                elif ev.get("tool_name"):
                    detail_lines.append(
                        f"[{ev.get('tool_name')}] {str(ev.get('detail', ''))[:80]}"
                    )
            content = (
                f"## 现象\n{user_input[:200]}\n\n"
                f"## 诊断过程\n"
                + ("\n".join(detail_lines) if detail_lines else "（无工具记录）")
                + f"\n\n## 结论\n{observation[:600]}"
            )
            rag.add(
                KnowledgeEntry(
                    id=case_id,
                    source="auto-case",
                    title=f"案例：{user_input[:50]}",
                    content=content,
                    tags=["自动沉淀", "排障"],
                )
            )
            logger.info(f"auto case sunk: {case_id} ({agent_id})")
        except Exception as e:
            logger.debug(f"auto sink case skipped: {e}")

    def clear_cache(self) -> None:
        """清空 Agent 缓存（配置变更后调用）"""
        count = len(self._agent_cache)
        self._agent_cache.clear()
        # P0-6: 子 agent 工具也绑定 model，需一并清理
        sub_count = len(self._sub_agent_cache)
        self._sub_agent_cache.clear()
        logger.info(
            f"Strands Agent cache cleared: {count} entries, "
            f"{sub_count} sub-agent tools"
        )

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
