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

P0-A1 (2026-08-29, 方案书 v3.1 三模式信任体系)：
- **main 是唯一 agent 实例**：4 子 agent 委派机制（_SUB_AGENT_SPECS /
  Agent.as_tool / 子 agent 双缓存 / 委派 prompt）已整体删除——意图路由靠
  LLM 猜测不可控，coding/explore/history 工具集是 main 真子集，委派纯开销。
- **三模式信任**：AgentMode（observe/confirm/auto）随 invoke 传参下发
  （state.live.agentMode 或 state.mode），缺省 confirm（中间态最安全）。
  工具集 = TOOL_REGISTRY 全量 × 模式过滤（observe → 只读白名单）；
  模式 × 风险映射矩阵见 core/decision_engine.py:decide。
- **教学皮肤**：原 teach agent 的结构化教学契约迁为 _TEACH_SKIN_PROMPT，
  invoke 传参 teach=True 时拼入 main system prompt（不改变权限矩阵）。
- agent_switch 事件保留 emit（agent_id 透传），委派路径删除后不再产生
  agent:<子 agent> 前缀事件；前端 "agent:" 卡片逻辑由 Task 2 处理。

设计原则：
1. Strands 是条件依赖（运行时缺失时优雅降级，不影响 sidecar 启动）。
2. 工具通过 ``make_all_ops_tools(ctx)`` 构造，自动绑定 ``ToolContext``。
3. callback_handler 内联实现，把 Strands 事件 → event_bus 便捷方法。
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Any, Callable

from strands_backend.modes import AgentMode, parse_mode
from strands_backend.tools import (
    DefaultRustBridge,
    RustBridge,
    ToolContext,
    TOOL_DECORATOR_AVAILABLE,
    filter_tools_readonly,
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
# TDSF 修复 2026-08-29: skill 清单改为从 skills registry 动态生成（防新增技能包后 prompt 漂移）

# registry 不可用时的静态兜底清单（与 skills/builtin/ 的 7 个技能包保持一致）
_FALLBACK_SKILL_NAMES: tuple[str, ...] = (
    "linux-ops",
    "docker-management",
    "selinux-baseline",
    "ssh-troubleshoot",
    "python-debug",
    "systemd-troubleshoot",
    "samba-setup",
)


def _skill_names_line() -> str:
    """生成 system prompt 的"可用 Skill"清单行（动态同步 skills registry）

    主路径：全局 SkillRegistry（懒加载，自动含 builtin + 用户自定义技能），
    新增技能包无需改本文件。registry 未就绪/异常时降级为静态兜底清单。
    """
    try:
        from skills.registry import get_global_registry

        names = get_global_registry().list_names()
        if names:
            return " / ".join(names)
    except Exception as e:
        logger.warning(f"skill names dynamic lookup failed, fallback to static list: {e}")
    return " / ".join(_FALLBACK_SKILL_NAMES)


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
    f"  可用 Skill: {_skill_names_line()}\n"
    "  何时使用: 用户询问特定领域知识时（如\"如何排查 nginx 502\"）、"
    "需要查阅权威操作步骤时、需要执行预定义脚本时\n"
    "- suggest_command(intent, target_os): 根据用户意图生成一条可执行的 Linux 命令及解释\n"
    "  何时使用: 用户想要执行某个操作但不知道具体命令时（如\"查看系统负载\"\"列出当前目录\"）\n"
    "  注意: 生成命令后不要自动执行，等待用户确认；前端会展示 Insert 按钮供用户一键插入终端\n"
    "- knowledge_search(query, limit): 检索内置 Linux 教学知识库（命令/概念/哲学/排障案例）\n"
    "  何时使用: 用户询问 Linux 概念/命令用法/运维知识时，先用知识库检索获取权威内容再回答\n\n"
    "Constraints:\n"
    "- 高危命令（rm -rf / reboot / shutdown / mkfs / dd 等）会触发 needs_you 审批，不要试图绕过。\n"
    # TDSF 魔改 2026-08-28 (B1-G2 防伪造): RiskGuard 拦截/用户拒绝后 LLM 必须如实报告。
    # 参考 Chaterm: "Do NOT fabricate command output; wait for the user to run the command."
    "- 安全拦截诚实条款：若命令被 RiskGuard 拦截、needs_you 审批被拒、或工具上下文出现"
    "\"[TDSF] 最近被安全拦截的命令（未执行）\"提示，必须如实告知用户该命令未执行；"
    "严禁编造执行结果或假装命令已运行；应主动给出替代方案（更安全的拆分步骤或让用户手动执行）。\n"
    "- 工具返回 status=unavailable 时，说明 RustBridge 未配置（P2 双向 JSON-RPC 未启用），"
    "应告知用户当前为只读模式。\n"
    "- live_context 显示\"未打开任何工作区\"时，告知用户先创建工作区（本地/WSL/SSH），"
    "不要声称本地诊断工具可用。\n"
    "- 工具返回 status=needs_approval 时，命令已发起审批，等待用户响应，不要重复调用同一命令。\n"
    "- skill_invoke 返回 content 字段时是知识卡模式（参考内容），返回 stdout 字段时是 executor 模式（已执行）。\n"
    "- 使用 suggest_command 后，向用户说明命令作用并提示可点击 Insert 插入终端执行。\n"
    "- 回答用中文，简洁明了，给出可执行建议。\n"
    "\n"
    "Task planning:\n"
    "- 遇到多步骤任务（≥3 步）时，先用 todo_write 工具创建任务列表，让用户看到你的规划。\n"
    "- 开始一个步骤时标记为 in_progress，完成后标记为 completed 并推进下一个。\n"
    "- 任务全部完成后简要总结结果。\n"
    "- 不确定下一步时，向用户提问而不是自行假设。\n"
    "\n"
    "Decision history:\n"
    "- 排障前先调 search_history 检索历史案例库，参考之前类似问题的解决方案。\n"
    "- 给出建议后调 assess_confidence 评估可信度，让用户了解结论的可靠程度。\n"
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

    转发策略（main 事件流，P0-A1 委派删除后仅剩唯一 agent）：
    - data（文本增量）→ event_bus.emit_agent_message（流式推送）
    - start → event_bus.emit_mood_change("thinking")
    - complete → event_bus.emit_mood_change("working")
    - force_stop → event_bus.emit_mood_change("error")
    - reasoningText（深度思考增量）→ agent_message(msg_type="thinking")

    注意（2026-07-31 修复）：不在此处转发 current_tool_use 事件——
    Strands 的 current_tool_use 是**流式中途态**，直接 emit 会产生
    input={} 的空参数工具行。工具实现内部自行 emit started/completed。

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
        """处理单个 Strands 事件（main 事件流）"""
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

# ============================================================================
# 模式感知 prompt 资源（P0-A1, 方案书 v3.1 §4.2）
# ============================================================================
# main 是唯一 agent（P0-A1 BREAKING：原 _SUB_AGENT_SPECS 5 入口注册表、
# _SUB_AGENT_TOOL_DESCRIPTIONS、_MAIN_SUB_AGENT_PROMPT 委派段已删除）。
# main 的 system prompt = 构造注入的基础段（默认 _DEFAULT_SYSTEM_PROMPT）
# + 按模式拼接的模式指令 (+ Teach 开关 ON 时的教学皮肤)。

# 三段模式指令（方案书 §4.2：观察=只读讲解型 / 确认=先说明再动手 / 自动=高效执行）
_MODE_PROMPTS: dict[AgentMode, str] = {
    AgentMode.OBSERVE: (
        "\n\nCurrent mode: OBSERVE (read-only).\n"
        "- 你处于只读观察模式，一切写操作与命令执行被禁止"
        "（工具集已裁剪为只读白名单，LLM 无法调用不存在的执行工具）。\n"
        "- 专注解释与教学：读文件/分析日志/检查进程/诊断网络，"
        "需要执行时用 suggest_command 生成命令并说明作用，等待用户自己执行。\n"
        "- 不要尝试绕过只读限制；若工具返回 status=command_blocked，"
        "必须如实报告未执行，严禁编造结果。"
    ),
    AgentMode.CONFIRM: (
        "\n\nCurrent mode: CONFIRM.\n"
        "- 先说明再动手：每个写操作/命令执行会请求用户批准（审批卡），"
        "调用前用一两句解释你要做什么、为什么。\n"
        "- 审批被拒时如实报告（不得编造执行结果），并按用户附言给出替代方案。"
    ),
    AgentMode.AUTO: (
        "\n\nCurrent mode: AUTO.\n"
        "- 高效执行：低风险操作（L0-L2）直接执行，无需逐步请示。\n"
        "- 高危操作（L3/L4）仍会弹出审批卡等待确认，不要试图绕过。\n"
        "- 事后简要报告做了什么、结果如何。"
    ),
}

# 教学皮肤（P0-A1：原 teach agent 的结构化教学契约迁入。Teach 开关 ON 时
# 拼接，叠加在任意模式上且不改变权限矩阵；main 是唯一 agent，禁委派话术）
_TEACH_SKIN_PROMPT = (
    "\n\nTeaching skin (TEACH ON):\n"
    "以 Linux 运维教学者身份输出结构化教学内容。\n\n"
    "Teaching format (6 大板块，按适用度选用，使用纯文字标题，不用 emoji):\n"
    "1. 概念与原理：用生活化比喻讲清是什么、为什么（底层原理优先）。\n"
    "2. 路径拆解：涉及文件路径时逐段解剖每层目录的含义（FHS 标准）。\n"
    "3. Linux 设计哲学：讲命令/机制时点明背后的设计哲学"
    "（一切皆文件 / 组合小工具 / 权限最小化 / 机制策略分离 / KISS 等），"
    "配实例说明哲学如何体现在操作上。\n"
    "4. 操作示例：给出可执行的 Linux 命令/配置，逐条解释参数含义。\n"
    "5. 易错点与考点：列出初学者常犯错误。\n"
    "6. 练习：留 1 个练习或思考题（先想再敲：提示学生先思考再执行）。\n\n"
    "Output contract: 每个板块标题必须用 `## 数字. 标题` 格式，"
    "且标题含板块关键词，例如 `## 1. 概念与原理`、`## 4. 操作示例`、"
    "`## 5. 易错点与考点`——前端按此格式渲染教学卡片，缺编号或缺关键词"
    "会退化为普通 markdown。\n\n"
    "Constraints:\n"
    "- 讲解命令/概念前，先调 knowledge_search 检索知识库"
    "（命令词源/设计哲学/FHS/90 命令档案），基于权威内容讲解，"
    "不要凭空发挥。\n"
    "- 可用 skill_invoke 查阅领域知识（linux-ops / ssh-troubleshoot 等）。\n"
    "- 需要演示命令时用 suggest_command 生成并提示用户可点击 Insert "
    "插入终端；观察模式下等待用户执行，确认/自动模式按当前模式规则执行。\n"
    "- 你是唯一 agent，直接讲解；不得声称把任务委派给其他 agent。"
)


def _compose_system_prompt(mode: AgentMode, teach: bool, base: str | None = None) -> str:
    """拼接模式感知 main system prompt

    组合：基础段（默认 _DEFAULT_SYSTEM_PROMPT）+ 模式指令
    (+ 教学皮肤)。供 _get_or_create_agent 与单测复用。

    Args:
        mode: Agent 信任模式（决定拼入哪段模式指令）
        teach: Teach 教学开关（True 时拼入教学皮肤）
        base: 基础段（None 时用 _DEFAULT_SYSTEM_PROMPT）

    Returns:
        拼接后的完整 system prompt
    """
    prompt = (base if base is not None else _DEFAULT_SYSTEM_PROMPT) + _MODE_PROMPTS[mode]
    if teach:
        prompt += _TEACH_SKIN_PROMPT
    return prompt


class StrandsAgentAdapter:
    """Strands Agent 适配层

    封装 Strands Agent 的创建、工具注册、invoke 调用，与现有 needs_you
    BaseAgent PAOR 架构协作。

    P0-A1: main 是唯一 agent 实例（4 子 agent 委派已删除）。每次 invoke
    携带模式（observe/confirm/auto，缺省 confirm）与教学开关（teach bool），
    Agent 实例按 (agent_id, session, 权限级, mode, teach) 缓存——模式/开关
    变化即重建（prompt 与工具集都随模式变化）。

    Args:
        event_bus: EventBus 实例（用于推送 mood_change / agent_message / tool_call / needs_you）
        rust_bridge: RustBridge 实例（工具调 Rust 后端的抽象层），None 时用 DefaultRustBridge()
        backend_enabled: 后端是否启用（feature flag），False 时直接降级
        system_prompt: 系统提示词基础段（None 时用默认 _DEFAULT_SYSTEM_PROMPT；
                       模式指令与教学皮肤在其后按 invoke 传参拼接）
        strands_model: Strands Model 对象（OpenAIModel / AnthropicModel / OllamaModel / LiteLLMModel），
                       None 时降级（不调真实 LLM）
        max_iterations: Strands Agent 最大迭代次数（防死循环），默认 10
        extra_tools: 额外工具列表（除 TOOL_REGISTRY 全量外），默认空

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
        # P0-A1 (2026-08-29): key 扩展为 (agent_id, session_id, permission_level,
        # mode, teach)——模式/教学开关变化即重建 agent（prompt + 工具集都随模式变化）。
        self._agent_cache: dict[tuple[str, str, int, AgentMode, bool], Any] = {}

        # TDSF 修复 2026-08-09: per-agent 锁——防止同一 Agent 实例被并发调用。
        # Strands Agent 有内部状态（"already processing a request"），
        # 用户停止+立即重发会导致前后请求竞态崩溃。锁确保排队等待。
        self._agent_locks: dict[tuple[str, str, int, AgentMode, bool], threading.RLock] = {}

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
            agent_id: Agent 标识（如 "main"），用于事件 source + 缓存键。
                P0-A1 后 main 是唯一 agent；未知 agent_id 使用同一套
                main 工具集与 prompt（回退语义，兼容旧调用方）。
            input: 用户输入文本（Agent 主提示词）
            state: Agent 状态 dict（含 session_id / live / messages 等，可选）。
                P0-A1 传参：live.agentMode 或 mode（observe/confirm/auto，
                缺省 confirm）、live.teach 或 teach（教学皮肤开关）。

        Returns:
            结构化结果 dict（与 BaseAgent.invoke 返回值对齐）
        """
        state = state or {}
        session_id = state.get("session_id", "") or ""
        start_time = time.time()

        # P0-A1: 三模式信任体系传参——live.agentMode（前端模式切换器下发，
        # 与 permissionLevel 同级）或顶层 mode；缺省/非法 → confirm（中间态
        # 最安全，parse_mode 对同一原始值仅记一次降级日志）。teach 教学皮肤
        # 开关（live.teach 或顶层 teach）叠加在任意模式上，不改变权限矩阵。
        live_state = state.get("live") or {}
        mode = parse_mode(live_state.get("agentMode") or state.get("mode"))
        teach = bool(live_state.get("teach") or state.get("teach"))

        logger.info(
            f"StrandsAgentAdapter.invoke: agent_id={agent_id}, "
            f"session={session_id}, mode={mode.value}, teach={teach}, "
            f"input_len={len(input)}"
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
            # 3. 构建工具上下文（Task 3: 传入 invoke 已解析的三模式，
            #    供执行链 decide(risk_l, mode) 消费）
            ctx = self._build_tool_context(agent_id, session_id, state, mode=mode)

            # 4. 获取或创建 Strands Agent + per-agent 锁
            strands_agent = self._get_or_create_agent(agent_id, ctx, mode=mode, teach=teach)
            # TDSF 修复 2026-08-09: 防并发崩溃——Strands Agent 有内部状态，
            # 同一实例被并发调用会抛 "already processing a request"。
            # 用 per-(agent, session, perm, mode, teach) RLock 确保排队等待。
            lock_key = (agent_id, ctx.session_id, ctx.permission_level, mode, teach)
            agent_lock = self._agent_locks.setdefault(lock_key, threading.RLock())

            # 5. 构建 prompt（注入 live 上下文）
            prompt = self._build_prompt(input, state)

            # P0-A1 (2026-08-29): agent_switch 事件保留 emit（agent_id 透传，
            # Pill 同步）。委派删除后仅 main 常驻；"agent:" 前缀子 agent 事件
            # 不再产生，前端兼容逻辑由 Task 2 处理。
            self._emit_agent_switch(agent_id, session_id)

            # 6. 推送 mood=working
            self._emit_mood("working", agent_id, session_id)

            # 7. 调用 Strands Agent（同步，agentic loop 内部触发 callback_handler）
            # TDSF 修复 2026-08-09: 用锁保护 agent 调用——防止并发崩溃
            self._emit_agent_message(
                agent_id=agent_id,
                session_id=session_id,
                content=f"开始处理: {_strip_env_block(input)[:100]}",
                msg_type="thinking",
            )

            with agent_lock:
                response = strands_agent(prompt)

            # 8. 提取最终输出
            observation = self._extract_response_text(response)

            # P2-4 决策库: AI 排障成功自动沉淀案例（教学复盘/历史检索）
            # 条件: 会话有工具调用证据 + 有结论输出 + 输入像排障请求
            self._auto_sink_case(agent_id, input, observation, session_id)

            self._emit_mood("done", agent_id, session_id)
            # P0-A1: main invoke 结束后 Pill 归位（P0-6 委派期间显示子 agent
            # 的语义随委派删除而消失，保留归位 emit 保持事件序列兼容）
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

    def _get_or_create_agent(
        self,
        agent_id: str,
        ctx: ToolContext,
        mode: AgentMode = AgentMode.CONFIRM,
        teach: bool = False,
    ) -> Any:
        """获取或创建 Strands Agent 实例（按 agent_id + 模式缓存）

        P0-A1 (2026-08-29, 方案书 v3.1 三模式): main 是唯一 agent——
        原 _SUB_AGENT_SPECS 角色裁剪与 agent-as-tool 委派挂载已删除。
        工具集 = TOOL_REGISTRY 全量 × 模式过滤（observe → 只读白名单
        filter_tools_readonly；confirm/auto → 全量）。system prompt =
        基础段 + 模式指令 (+ teach 教学皮肤)。

        Args:
            agent_id: Agent 标识（缓存键 + 事件 source；未知 agent_id
                使用与 main 相同的工具集/prompt，回退语义兼容旧调用方）
            ctx: ToolContext（用于构建工具）
            mode: 信任模式（observe 裁剪只读白名单；prompt 按模式拼接）
            teach: Teach 教学皮肤开关（True 时拼入教学契约）

        Returns:
            Strands Agent 实例
        """
        # 缓存 key 含 permission_level（P1-v5-2：L1 只读过滤）+ mode/teach
        # （P0-A1：prompt 与工具集都随模式/开关变化，必须重建）
        cache_key = (agent_id, ctx.session_id, ctx.permission_level, mode, teach)
        if cache_key in self._agent_cache:
            return self._agent_cache[cache_key]

        # 构建运维工具（TOOL_REGISTRY 全量，带 ctx 闭包；L1 权限由
        # make_all_ops_tools 内部按 READONLY_TOOL_NAMES 过滤）
        all_tools = make_all_ops_tools(ctx) + self.extra_tools

        # P0-A1 观察模式 schema 级隔离：裁剪为只读白名单——LLM 无法调用
        # 不存在于 schema 的执行/写类工具（remove 优于 instruct+intercept）。
        # extra_tools 未注册项同样被裁（fail-closed）。
        if mode == AgentMode.OBSERVE:
            all_tools = filter_tools_readonly(all_tools)

        # 模式感知 prompt：基础段 + 模式指令 (+ 教学皮肤)
        system_prompt = _compose_system_prompt(mode, teach, base=self.system_prompt)

        # T2 (2026-08-28): 全部 20 工具已收编入 TOOL_REGISTRY（tools/registry.py），
        # 由 make_all_ops_tools 统一构建（含 service/package/firewall 等 5 个
        # 扩展运维工具）；原 P2-3 AGENT_EXTENDED_TOOLS 重复挂载块随委派机制
        # 一并删除（T2 后为冗余路径）。

        # 构建 callback_handler（main 事件流转发；P0-A1 委派删除后
        # 无静默 handler 需求）
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
        #   当前移除该参数让 LLM 调用工作起来，self.max_iterations 字段保留
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
            f"mode={mode.value}, teach={teach}, "
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
        mode: AgentMode | None = None,
    ) -> ToolContext:
        """构建工具运行时上下文

        从 state 中提取 live 上下文（cwd / activeFile / sshSessionId 等），
        与适配层方案 §6.2 终端上下文感知方案 A 对齐。

        Task 3 (2026-08-29): 注入三模式（mode，供执行链 decide 消费）与
        激活终端主机名（ssh_host，供 host 校验；从 live.sshConnection
        "user@host" 提取 @ 后部分，不可得时为空 → 执行链跳过校验）。

        Args:
            agent_id: Agent 标识
            session_id: 会话 ID
            state: Agent 状态 dict（live 上下文）
            mode: 三模式（None 时从 state.live.agentMode / state.mode 解析，
                缺省 confirm——与 invoke() 的解析逻辑一致）
        """
        live = state.get("live") or {}

        # P1-v5-4: 4 级权限（1=免确认 2=仅高危 3=高危+写操作 4=全部确认）。
        # 前端 live.permissionLevel 注入（默认 2，保持原行为）；非法值夹取到 1-4。
        # Task 3: 仅保留 schema 级过滤职责（L1 只读裁剪），执行链决策走 mode。
        try:
            permission_level = int(live.get("permissionLevel", 2))
        except (TypeError, ValueError):
            permission_level = 2
        permission_level = max(1, min(4, permission_level))

        # Task 3: 三模式——调用方（invoke）已解析时直接用，否则兜底解析
        if mode is None:
            mode = parse_mode(live.get("agentMode") or state.get("mode"))

        # Task 3.3 host 校验数据源：live.sshConnection = "user@host" 友好格式。
        # 取 @ 后的主机部分；无 @ 时整个串视为主机；空 = 不可得（跳过校验）。
        ssh_conn = str(live.get("sshConnection", "") or "")
        ssh_host = ssh_conn.split("@", 1)[1] if "@" in ssh_conn else ssh_conn

        return ToolContext(
            event_bus=self.event_bus,
            rust_bridge=self.rust_bridge,
            agent_name=agent_id,
            session_id=session_id,
            user_id=state.get("user_id", "") or "",
            ssh_session_id=str(live.get("sshSessionId", "") or ""),
            permission_level=permission_level,
            mode=mode,
            ssh_host=ssh_host,
            # TDSF 魔改 (2026-08-09): 终端执行模式开关
            auto_execute_in_terminal=bool(live.get("autoExecuteInTerminal", False)),
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
        # TDSF 修复 2026-08-29: 区分"本地终端在跑/WSL"与"欢迎页啥都没开"。
        # 欢迎页（无任何环境线索）时原 else 分支让 LLM 自称"本地终端模式"并幻觉
        # 本地诊断工具可直接用，故拆出无环境分支引导用户先建工作区。
        elif live.get("workspaceRoot") or live.get("cwd") or live.get("activeFile"):
            lines.append("未连接 SSH 会话（本地终端模式，ssh_command 工具将返回 unavailable）")
        else:
            lines.append(
                "当前未打开任何工作区或终端——请先新建本地、WSL 或 SSH 工作区，"
                "之后才能执行命令或运行诊断工具；当前不要声称任何工具可以直接使用。"
            )

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
        # TDSF 修复 2026-08-09: 一并清空锁字典
        self._agent_locks.clear()
        # P0-A1: 子 agent 工具缓存已随委派机制删除（原 _sub_agent_cache）
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
                f"{agent_id}:{session_id}:{mode.value}"
                f"{'+' if teach else ''}"
                for (agent_id, session_id, _perm, mode, teach) in self._agent_cache.keys()
            ],
            "max_iterations": self.max_iterations,
            "extra_tools_count": len(self.extra_tools),
        }


__all__ = [
    "StrandsAgentAdapter",
    "TdsfStrandsCallbackHandler",
]
