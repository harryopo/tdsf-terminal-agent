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
import os
import re
import threading
import time
from typing import Any, Callable

from strands_backend.modes import AgentMode, parse_mode
from strands_backend.tools import (
    DefaultRustBridge,
    RiskChecker,
    RustBridge,
    ToolContext,
    TOOL_DECORATOR_AVAILABLE,
    VERIFY_CLASS_TOOL_NAMES,
    WRITE_CLASS_TOOL_NAMES,
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

# A2 T9 (2026-09-01, 用户实测反馈"agent 无法完成长任务"): 模型单轮输出触顶
# （MaxTokensReachedException）时的自动续跑上限。Strands 语义：触顶时部分
# 消息已写入 agent.messages，再次调用即从中断处继续——长教学/长排障任务
# 不再整体报错失败。超过上限视为任务失败（防无限续跑烧 token）。
MAX_TOKEN_CONTINUATIONS = 3

# T9 watchdog (2026-09-01, spec 9.1): invoke 期间连续无回调事件的容忍时长
# （秒）——模型挂起（无 delta/工具事件）超过阈值即放弃本轮并上报，会话可
# 继续。轮询间隔为 worker 存活检查粒度。测试可用环境变量覆盖阈值。
INVOKE_WATCHDOG_IDLE_SECS = 600
INVOKE_WATCHDOG_POLL_SECS = 5


def _watchdog_thresholds() -> tuple[float, float]:
    """watchdog 阈值 ``(空闲容忍秒, 轮询秒)``，支持环境变量覆盖。

    下限只到 0.05s——生产默认 600s/5s 不受影响，但自动化测试能把阈值调到
    亚秒级，真正验证"有事件就续期、没事件才超时"（旧实现把下限钳在 1.0s，
    测试设 0.5s 实际跑在 1.0s 上，用例只能靠 worker 睡 2s 侥幸触发）。
    """
    raw_idle = os.environ.get("TDSF_INVOKE_WATCHDOG_IDLE_SECS", "") or ""
    raw_poll = os.environ.get("TDSF_INVOKE_WATCHDOG_POLL_SECS", "") or ""
    try:
        idle = float(raw_idle) if raw_idle else float(INVOKE_WATCHDOG_IDLE_SECS)
    except ValueError:
        idle = float(INVOKE_WATCHDOG_IDLE_SECS)
    try:
        poll = float(raw_poll) if raw_poll else float(INVOKE_WATCHDOG_POLL_SECS)
    except ValueError:
        poll = float(INVOKE_WATCHDOG_POLL_SECS)
    return max(0.05, idle), max(0.05, poll)


def _format_idle_secs(idle: float) -> str:
    """秒数 → 人读时长（≥60s 显示分钟），让超时文案跟着实际阈值走"""
    if idle >= 60:
        return f"{idle / 60:.0f} 分钟"
    return f"{idle:g} 秒"


# T9.2 (spec 9.2): LLM 传输类异常特征——命中则走"只读问答降级"友好文案
# 而非报错卡（对话不中断）。小写比对。
_LLM_TRANSPORT_ERROR_MARKERS = (
    "connection error",
    "connect error",
    "timed out",
    "timeout",
    "apiconnectionerror",
    "apitimeouterror",
    "connection refused",
    "connection reset",
    "unreachable",
    "getaddrinfo failed",
    "name or service not known",
)

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
    "- ssh_list_sessions(): 枚举已连接 SSH 会话，多主机先调用它确定 ssh_session_id\n"
    "- read_remote_file(path, ssh_session_id, max_size, encoding): 读远程文件\n"
    "- analyze_logs(log_path, mode, lines, pattern, ssh_session_id): 分析日志\n"
    "- inspect_processes(mode, filter_user, filter_name, pid, top_n, ssh_session_id): 进程检查\n"
    "- network_diagnose(mode, target, count, port, ssh_session_id): 网络诊断\n"
    "- skill_invoke(skill_name, input): 调用已注册的 Skill 获取领域知识或执行特定任务\n"
    f"  可用 Skill: {_skill_names_line()}\n"
    "  何时使用: 领域知识/权威操作步骤/预定义脚本类需求\n"
    "- suggest_command(intent, target_os): 根据用户意图生成一条可执行的 Linux 命令及解释\n"
    "  何时使用: 用户想执行某个操作但不知道具体命令时\n"
    "  注意: 生成后不自动执行，等用户确认；前端有 Insert 一键插入终端\n"
    "- knowledge_search(query, limit): 检索内置 Linux 教学知识库（中文提炼知识点，RAG 混合检索）\n"
    "  何时使用: 用户询问 Linux 概念/命令用法/运维知识时，先用知识库检索获取权威内容再回答\n"
    "- knowledge_get_doc(url): 按 url 读取知识库完整文档（检索命中后需全文/完整配置示例时用；url 取自检索结果）\n"
    # T5 (2026-08-31, spec add-agent-loop-closure): python_run PTC 工具指引
    # ——多文件交叉统计/复杂解析/批量操作一段代码一次完成
    "- python_run(code): 在本地工作区执行一段 Python 代码（受控：30s 超时、输出截断 10KB）\n"
    "  何时使用: 多文件统计/复杂解析/批量操作一次完成；仅本地工作区可用（SSH 下报 error）\n\n"
    # TDSF 2026-08-31 (用户钦定 环境感知前置): agent 回答/操作前必须先确认环境——
    # 用户实测反馈 agent 未感知环境直接回答（本地 Windows 却按 Linux 服务器话术）。
    # TDSF 2026-08-31 (问题1修复): 用户没开终端时 agent 误称"本地终端"——根因是
    # "注入了 workspace cwd（默认主目录）"被当成"本地终端已打开"。现以
    # <environment> 的 connection_mode 字段（ssh/local/none）为唯一环境口径：
    # none = 无任何终端会话，必须如实告知用户，不臆测"本地终端"。
    "Environment awareness (环境感知前置——每次回答/操作前必须先执行):\n"
    "- 先读 <environment> 注入区的 connection_mode 字段确认当前环境，再决定回答内容与命令风格：\n"
    "  ① connection_mode: ssh → 目标是远程 Linux 服务器：命令/路径/包管理按服务器发行版\n"
    "    （Debian 系 apt / RHEL 系 yum/dnf），远程操作用 ssh_command 工具执行。\n"
    "  ② connection_mode: local（本地终端已打开）→ Windows 本地环境：按 PowerShell/cmd 语法给出命令，\n"
    "    不要给 Linux 命令或声称可在远程服务器上执行。\n"
    "  ③ connection_mode: none（未打开任何终端会话）→ 明确告知用户：当前未打开终端，\n"
    "    请先新建本地终端或建立 SSH 连接，我不会假设环境；严禁自称处于\"本地终端模式\"\n"
    "    或\"本地环境\"，严禁臆测环境、严禁编造命令执行结果（<environment> 里只有默认\n"
    "    工作区路径，不代表终端已打开）。\n\n"
    "Constraints:\n"
    "- 高危命令（rm -rf / reboot / shutdown / mkfs / dd 等）会触发 needs_you 审批，不要试图绕过。\n"
    # TDSF 魔改 2026-08-28 (B1-G2 防伪造): RiskGuard 拦截/用户拒绝后 LLM 必须如实报告。
    # 参考 Chaterm: "Do NOT fabricate command output; wait for the user to run the command."
    "- 安全拦截诚实条款：若命令被 RiskGuard 拦截、needs_you 审批被拒、或工具上下文出现"
    "\"[TDSF] 最近被安全拦截的命令（未执行）\"提示，必须如实告知用户该命令未执行；"
    "严禁编造执行结果或假装命令已运行；应主动给出替代方案（更安全的拆分步骤或让用户手动执行）。\n"
    "- 工具返回 unavailable = RustBridge 未配置，告知用户当前为只读模式。\n"
    "- 未打开工作区时告知用户先创建（本地/WSL/SSH），勿声称本地诊断工具可用。\n"
    "- 工具返回 status=needs_approval 时，命令已发起审批，等待用户响应，不要重复调用同一命令。\n"
    "- skill_invoke 返回 content 字段时是知识卡模式（参考内容），返回 stdout 字段时是 executor 模式（已执行）。\n"
    "- 使用 suggest_command 后，向用户说明命令作用并提示可点击 Insert 插入终端执行。\n"
    # TDSF 2026-08-31 (问题2修复): 用户实测反馈回答含大量 emoji（👋💻🔧📚）。
    # 2026-09-01 (用户实测): 目录树/架构图被写进普通段落，等宽对齐全毁——
    # 强制 fenced code block。
    "- 格式约束：回答避免使用 emoji（用户明确要求时除外）；用纯文本或 markdown 结构化表达；"
    "目录树/架构图/流程图一律放 ``` 围栏代码块保持等宽对齐，禁止写进普通段落。\n"
    "- 回答用中文，简洁明了，给出可执行建议。\n"
    "\n"
    "Task planning:\n"
    # T3 规划-执行回环 (2026-08-31): 规划段从"建议"升格为"必须"——
    # ≥3 步任务先建清单再行动（TodoStrip 可见），完成即更新驱动执行回环；
    # 单步/澄清类明确豁免，防简单问答被清单仪式拖慢。
    # T9.3 (spec 9.3): 并行工具提示词——独立只读探查并行发起，吃 strands
    # ConcurrentToolExecutor 红利；有依赖的调用才串行。
    "- 独立的信息收集类调用（多个只读探查）应并行发起，有依赖的才串行。\n"
    "- 多步任务（≥3 步）必须先用 todo_write 工具建立任务清单再行动，让用户看到你的规划。\n"
    "- 每完成一项立即 todo_write 更新 completed 再推进。\n"
    # T6 剧本 (2026-08-31): skill_invoke 命中带 steps 剧本的技能时按剧本执行
    "- skill_invoke 返回 playbook_text 时按步骤执行，逐步验证并更新任务清单。\n"
    "- 单步问题或澄清类问题无需任务清单，直接回答。\n"
    "- 任务全部完成后简要总结结果。\n"
    "- 不确定下一步时，向用户提问而不是自行假设。\n"
    "\n"
    # T7 执行后验证回环 (2026-08-31, spec add-agent-loop-closure): 行动约束——
    # 写操作后必须只读验证才能宣告完成（配套收尾检测 _maybe_verify_followup）
    "Post-change verification:\n"
    "- 写操作（写文件/改配置/修改类命令）后必须用只读工具验证"
    "（systemctl status/cat/ls 等）才能宣告完成；未验证不得声称成功。\n"
    "\n"
    "Decision history:\n"
    "- 排障前先 search_history 检索历史案例，参考类似问题的解法。\n"
    "- 给出建议后调 assess_confidence 评估可信度，让用户了解结论的可靠程度。\n"
)


# TDSF 2026-08-31 (问题5修复): _strip_env_block 已删除——唯一调用方是已移除的
# "开始处理: ..."invoke 调度日志。注入上下文块的剥离职责由下方
# _split_input_for_log（_CONTEXT_BLOCK_RE，agent_log 落盘用）承担。


# ============================================================================
# 会话流水日志（agent_log，2026-08-31 用户钦定调试后端）
# ============================================================================
# 注入区标签全集：前端 transport.ts（<env>/<environment>/<terminal-context>/
# <terminal-history>/<session-memory>/<recalled-memory>）+ adapter._build_prompt
# （<live_context>）。T4 (2026-08-31): <recalled-memory>（每轮召回）与
# <session-memory>（T14 首轮摘要）一并纳入——agent_log 落盘时归入 env_inject
# 而非 user_msg，排障时"用户原文"不被注入区污染。
_CONTEXT_BLOCK_RE = re.compile(
    r"<(env|environment|terminal-context|terminal-history|live_context|"
    r"session-memory|recalled-memory)>"
    r"[\s\S]*?</\1>"
)


def _split_input_for_log(input: str) -> tuple[str, str]:
    """把 invoke input 拆为 (用户文本, 注入上下文块)

    供 agent_log 落盘：user_msg 记用户原文、env_inject 记注入分区——
    排障时可直接看"agent 到底看到了什么环境信息"。
    """
    if not input:
        return "", ""
    context_part = "\n\n".join(
        m.group(0) for m in _CONTEXT_BLOCK_RE.finditer(input)
    )
    user_part = _CONTEXT_BLOCK_RE.sub("", input).strip()
    return user_part, context_part


# ============================================================================
# T7 执行后验证回环 — "写后未验证"判定（纯函数，便于单测）
# ============================================================================
# 工具调用记录来源：ToolCallLimitHook.tool_log（AfterToolCallEvent 逐次
# 记录 name + input + success，与护栏计数同生命周期，单次 invoke 口径）。
# 不选 event_bus 历史（无会话内查询接口）/ agent_log（落盘排障日志，读回
# 成本高且非结构化）——hook 流水是内存中现成的结构化真源。

def _tool_call_is_write_class(name: str, tool_input: dict[str, Any]) -> bool:
    """判定一次工具调用是否写类（修改系统/文件/运行状态）

    工具名级分类为主（WRITE_CLASS_TOOL_NAMES）；ssh_command 特例按命令
    内容细分——只读命令（status/cat/ls 等不命中 RiskChecker 写模式的命令）
    不算写，避免纯查询会话被误判（spec 钦定 "ssh_command(执行)" 指执行
    修改类命令）。
    """
    if name not in WRITE_CLASS_TOOL_NAMES:
        return False
    if name == "ssh_command":
        command = str(tool_input.get("command", "") or "")
        return bool(RiskChecker.check(command).get("write"))
    return True


def _tool_call_is_verify_class(name: str, tool_input: dict[str, Any]) -> bool:
    """判定一次工具调用是否只读验证类

    验证类工具名直接命中；ssh_command 执行只读命令（systemctl status /
    cat / ls 等）同样算验证——系统提示的 Post-change verification 段钦定
    "用只读工具验证结果（如 systemctl status / cat）"，SSH 场景下这些
    命令正是经 ssh_command 执行的。
    """
    if name in VERIFY_CLASS_TOOL_NAMES:
        return True
    if name == "ssh_command":
        command = str(tool_input.get("command", "") or "")
        return not RiskChecker.check(command).get("write")
    return False


def _needs_verify_followup(tool_log: list[dict[str, Any]]) -> bool:
    """判定是否需要追加"验证改动生效"轮（T7 收尾检测核心）

    规则：存在写类工具成功调用，且其后（含后续写类调用之后）无任何
    只读验证类调用 → True。

    Args:
        tool_log: ToolCallLimitHook.tool_log（本单次 invoke 的调用流水）

    Returns:
        True = 写后未验证，需追加一轮提示
    """
    last_write_idx = -1
    for idx, entry in enumerate(tool_log):
        if entry.get("success") and _tool_call_is_write_class(
            str(entry.get("name", "")), entry.get("input") or {}
        ):
            last_write_idx = idx
    if last_write_idx < 0:
        return False  # 无写类成功调用（纯读会话/写全失败）→ 不触发
    for entry in tool_log[last_write_idx + 1:]:
        if _tool_call_is_verify_class(
            str(entry.get("name", "")), entry.get("input") or {}
        ):
            return False  # 最后一次写类成功之后已有验证 → 不触发
    return True


# ============================================================================
# TdsfStrandsCallbackHandler — Strands 事件 → event_bus 转发
# ============================================================================

# Strands hooks 条件导入（P1-NEW-v2-3 fix-loop 保护用）
try:
    from strands.hooks.events import (  # type: ignore[import]
        AfterToolCallEvent,
        BeforeModelCallEvent,
        BeforeToolCallEvent,
    )

    _STRANDS_HOOKS_AVAILABLE = True
except ImportError:
    AfterToolCallEvent = None  # type: ignore[assignment]
    BeforeModelCallEvent = None  # type: ignore[assignment]
    BeforeToolCallEvent = None  # type: ignore[assignment]
    _STRANDS_HOOKS_AVAILABLE = False


class ToolCallLimitHook:
    """Strands HookProvider：工具调用次数保护（P1-NEW-v2-3，fix-loop 近似）

    LangGraph 路径有 BaseAgent._check_fix_loop 防重试风暴；Strands override
    路径的工具调用由 Strands event loop 驱动，绕过该保护。本 hook 用
    Strands 公共 Hook API（Before/AfterToolCallEvent）实现同等语义：
    - 单次 invoke 总工具调用数超过 max_tool_calls → 熔断（防死循环）
    - 同一工具连续失败 max_failures 次 → 熔断
      （成功调用重置该工具失败计数，与 fix_loop 的 reset 语义一致）

    T2 循环护栏 (2026-08-31, spec add-agent-loop-closure)：
    - max_tool_calls 12 → 50（放开长任务自由度，spec"单任务工具调用上限 50"）
    - 熔断语义升级为"停止整个循环"：置 cancelled 后所有后续工具调用一律
      cancel_tool，LLM 收到熔断消息后只能收尾输出（无工具可调）
    - 熔断解释双通道（不只静默停止）：
      ① event_bus.emit_agent_message(type="output") → 用户立即看到含失败
        工具名与错误摘要的解释（确定性，不依赖 LLM 转述）
      ② cancel_tool 消息作为 error tool result 返回 → LLM 下一次调用
        自带熔断上下文，可向用户解释收尾
    - 进度上报：每次工具调用完成（AfterToolCallEvent）记录
      （轮次 round / 工具计数 tool_count / 成功失败 status）：
      ① agent_log 落盘新事件类型 loop_progress（排障）
      ② event_bus.emit_loop_progress → Rust 转发 sidecar:loop_progress →
        前端 AgentStatusPill 显示"第 N 轮 · 已用工具 M"
    - round 由 BeforeModelCallEvent 计数（LLM 推理轮次；一轮可发多工具）
    - 单任务语义：adapter 在每次 invoke 开始时 reset()（计数不跨 invoke
      累计，"单任务上限 50"——旧版跨 invoke 累计会让第二次对话直接熔断）

    hook 实例按 (agent_id, session_id) 缓存于 adapter（与 Agent 实例
    (agent_id, session_id, perm) 缓存解耦——护栏只跟会话走，perm 重建
    实例不重置护栏）。
    """

    def __init__(
        self,
        max_tool_calls: int = 50,
        max_failures: int = 3,
        agent_name: str = "main",
        event_bus: Any = None,
        session_id: str = "",
    ) -> None:
        self.max_tool_calls = max_tool_calls
        self.max_failures = max_failures
        self.agent_name = agent_name
        self.event_bus = event_bus
        self.session_id = session_id
        self.total_calls = 0
        self.failures_by_tool: dict[str, int] = {}
        self.cancelled = False
        # T2: LLM 推理轮次（BeforeModelCallEvent 计数）
        self.round = 0
        # T2: 最近一次失败 (tool_name, error_summary)——熔断解释引用
        self._last_failure: tuple[str, str] | None = None
        # T2: 熔断解释只 emit 一次（cancelled 后每次工具调用都会进
        # _before_tool_call，防重复刷屏）
        self._breaker_emitted = False
        # T7 (2026-08-31, spec add-agent-loop-closure): 本轮 invoke 的工具
        # 调用流水（name + input + 成功与否）——adapter 收尾检测
        # _maybe_verify_followup 判定"写类成功调用后无验证类调用"的数据源
        # （reset 时清空，与护栏计数同生命周期：单次 invoke 口径）
        self.tool_log: list[dict[str, Any]] = []

    def register_hooks(self, registry: Any) -> None:
        """HookProvider 协议：注册 Before/AfterToolCall/BeforeModelCall 回调"""
        if not _STRANDS_HOOKS_AVAILABLE:
            return
        registry.add_callback(BeforeToolCallEvent, self._before_tool_call)
        registry.add_callback(AfterToolCallEvent, self._after_tool_call)
        registry.add_callback(BeforeModelCallEvent, self._before_model_call)

    def _before_model_call(self, event: Any) -> None:
        """LLM 调用前 → 轮次 +1（一轮推理可发多个工具调用）"""
        self.round += 1

    def _tool_name(self, event: Any) -> str:
        tool_use = getattr(event, "tool_use", None)
        if isinstance(tool_use, dict):
            return str(tool_use.get("name", "?"))
        return str(getattr(tool_use, "get", lambda k, d=None: d)("name", "?"))

    @staticmethod
    def _tool_input(event: Any) -> dict[str, Any]:
        """从 hook 事件提取工具入参（T7：ssh_command 命令级写/读细分用）"""
        tool_use = getattr(event, "tool_use", None)
        if isinstance(tool_use, dict):
            raw_input = tool_use.get("input")
            return raw_input if isinstance(raw_input, dict) else {}
        return {}

    def _before_tool_call(self, event: Any) -> None:
        if self.cancelled:
            event.cancel_tool = True
            return
        self.total_calls += 1
        if self.total_calls > self.max_tool_calls:
            self._trip_breaker(
                event,
                f"工具调用次数超过上限（{self.max_tool_calls}）",
            )
            return
        name = self._tool_name(event)
        if self.failures_by_tool.get(name, 0) >= self.max_failures:
            self._trip_breaker(
                event,
                f"工具 {name} 连续失败 {self.max_failures} 次",
            )

    def _trip_breaker(self, event: Any, reason: str) -> None:
        """熔断：取消当前工具 + 停止后续所有工具调用 + 输出解释"""
        self.cancelled = True
        message = f"{reason}，已熔断停止任务"
        event.cancel_tool = message
        self._emit_breaker_explanation(reason)

    def _emit_breaker_explanation(self, reason: str) -> None:
        """熔断解释：agent_log 落盘 + event_bus 推送（用户可见，只发一次）"""
        if self._breaker_emitted:
            return
        self._breaker_emitted = True
        detail = ""
        if self._last_failure:
            detail = f"；最近失败工具：{self._last_failure[0]}（{self._last_failure[1]}）"
        text = (
            f"[循环护栏] {reason}{detail}。"
            f"我已停止继续调用工具，避免无效重试消耗资源；"
            f"请检查环境/参数后重试，或告诉我换个思路。"
        )
        # agent_log 落盘（loop_progress 事件，meta.status=breaker 便于过滤；
        # 空 session_id 跳过——与 callback_handler._flush_reasoning 口径一致）
        if self.session_id:
            try:
                from strands_backend.agent_log import log_event

                log_event(
                    self.session_id,
                    "loop_progress",
                    text,
                    meta={
                        "agent": self.agent_name,
                        "status": "breaker",
                        "round": self.round,
                        "tool_count": self.total_calls,
                    },
                )
            except Exception as e:  # noqa: BLE001 — 流水日志失败不影响护栏
                logger.debug(f"agent_log loop_progress breaker failed: {e}")
        # 用户可见的熔断解释（type=output 流式推送）
        if self.event_bus is not None:
            try:
                self.event_bus.emit_agent_message(
                    content=text,
                    message_type="output",
                    session_id=self.session_id or None,
                    source=f"{self.agent_name}_agent.strands.hook",
                )
            except Exception as e:  # noqa: BLE001 — 事件推送失败不影响护栏
                logger.debug(f"emit breaker explanation failed: {e}")

    @staticmethod
    def _json_dict(text: Any) -> dict[str, Any] | None:
        """字符串若是 JSON 对象则解析为 dict，否则 None"""
        if isinstance(text, dict):
            return text
        if not isinstance(text, str):
            return None
        stripped = text.strip()
        if not (stripped.startswith("{") and stripped.endswith("}")):
            return None
        import json as _json

        try:
            data = _json.loads(stripped)
        except ValueError:
            return None
        return data if isinstance(data, dict) else None

    @classmethod
    def _tool_payload(cls, result: Any) -> dict[str, Any]:
        """还原工具自身返回的结构化 dict

        strands 会把没有 content 键的返回值 JSON 序列化进内容块
        （实测形状：{'status': 'success',
        'content': [{'text': '{"status": "error", ...}'}]}），
        故工具自报的 status/message 藏在块文本里，必须解析回来。
        """
        content = (
            result.get("content")
            if isinstance(result, dict)
            else getattr(result, "content", None)
        )
        for block in content if isinstance(content, list) else [content]:
            text = block.get("text") if isinstance(block, dict) else block
            data = cls._json_dict(text)
            if data is not None:
                return data
        return {}

    @classmethod
    def _result_status(cls, result: Any) -> str | None:
        """工具结果状态（无状态信号返回 None）

        ToolResult 是 TypedDict（运行时 dict），getattr 取不到键，须用下标读；
        外层被 strands 标成 success 时，还要看工具自报的内层 status。
        """
        if result is None:
            return None
        outer = result.get("status") if isinstance(result, dict) else getattr(result, "status", None)
        if isinstance(outer, str) and outer != "success":
            return outer
        inner = cls._tool_payload(result).get("status")
        return inner if isinstance(inner, str) else (outer if isinstance(outer, str) else None)

    @classmethod
    def _error_summary(cls, event: Any) -> str:
        """从 AfterToolCallEvent 提取失败摘要（exception 优先，截断 120 字）"""
        exc = getattr(event, "exception", None)
        if exc is not None:
            return str(exc)[:120]
        payload = cls._tool_payload(getattr(event, "result", None))
        parts = [
            payload[key]
            for key in ("message", "error", "reason", "explanation")
            if isinstance(payload.get(key), str) and payload.get(key)
        ]
        return (" ".join(parts) or "tool error")[:120]

    def _after_tool_call(self, event: Any) -> None:
        name = self._tool_name(event)
        # 失败判定：工具抛异常，或结果状态存在且非 success
        # （error / command_blocked / rejected / needs_approval / unavailable）
        status = self._result_status(getattr(event, "result", None))
        failed = (
            getattr(event, "exception", None) is not None
            or (status is not None and status != "success")
        )
        if failed:
            self.failures_by_tool[name] = self.failures_by_tool.get(name, 0) + 1
            self._last_failure = (name, self._error_summary(event))
        else:
            self.failures_by_tool[name] = 0
        # T7: 工具调用流水（name + input + 成功与否）——收尾验证判定数据源
        self.tool_log.append({
            "name": name,
            "input": self._tool_input(event),
            "success": not failed,
        })
        self._report_progress(name, "failed" if failed else "success")

    def _report_progress(self, tool_name: str, status: str) -> None:
        """T2 进度上报：agent_log 落盘 loop_progress + event_bus 推流"""
        payload = {
            "round": self.round,
            "tool_count": self.total_calls,
            "tool_name": tool_name,
            "status": status,
        }
        # agent_log 落盘（写失败静默——流水是排障加分项，绝不影响主链路；
        # 空 session_id 跳过——匿名调用无会话归属，写 default 无排障价值）
        if self.session_id:
            try:
                import json as _json

                from strands_backend.agent_log import log_event

                log_event(
                    self.session_id,
                    "loop_progress",
                    _json.dumps(payload, ensure_ascii=False),
                    meta={"agent": self.agent_name, **payload},
                )
            except Exception as e:  # noqa: BLE001
                logger.debug(f"agent_log loop_progress failed: {e}")
        # 前端推流（AgentStatusPill"第 N 轮 · 已用工具 M"）
        if self.event_bus is not None:
            try:
                self.event_bus.emit_loop_progress(
                    round=self.round,
                    tool_count=self.total_calls,
                    tool_name=tool_name,
                    status=status,
                    session_id=self.session_id or None,
                    source=f"{self.agent_name}_agent.strands.hook",
                )
            except Exception as e:  # noqa: BLE001
                logger.debug(f"emit_loop_progress failed: {e}")

    def reset(self) -> None:
        """重置计数（每次 invoke 开始时调用——单任务护栏语义）"""
        self.total_calls = 0
        self.failures_by_tool.clear()
        self.cancelled = False
        self.round = 0
        self._last_failure = None
        self._breaker_emitted = False
        # T7: 工具调用流水同步清空（单次 invoke 口径）
        self.tool_log.clear()


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
        # 会话流水日志：reasoning 增量聚合缓冲（正文 data 到来 / 循环边界时落盘，
        # 防止逐 token 写日志爆体积——agent_log.content 上限 2000 字符）
        self._reasoning_buf: list[str] = []
        # 统计（调试用）
        self._stats = {
            "events_received": 0,
            "messages_emitted": 0,
            "tool_calls_emitted": 0,
            "mood_changes_emitted": 0,
            "reasoning_logged": 0,
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
        # 深度思考流（模型 reasoningContent 增量）→ thinking 消息 + 流水聚合
        reasoning_text = event.get("reasoningText")
        if reasoning_text and isinstance(reasoning_text, str):
            self._emit_agent_message(reasoning_text, msg_type="thinking")
            self._reasoning_buf.append(reasoning_text)

        # 文本增量 → agent_message（流式推送）；正文开始 = 推理段结束 → 落盘
        data = event.get("data")
        if data and isinstance(data, str):
            self._flush_reasoning()
            self._emit_agent_message(data, msg_type="output")

        # 循环开始 → mood=thinking（循环边界 flush，防跨轮混合）
        if event.get("start"):
            self._flush_reasoning()
            self._emit_mood("thinking")

        # 循环完成 → mood=working（仍在处理，最终 mood 由 invoke() 设 done）
        elif event.get("complete"):
            self._flush_reasoning()
            self._emit_mood("working")

        # 强制停止 → mood=error
        if event.get("force_stop"):
            self._flush_reasoning()
            self._emit_mood("error")
            logger.warning(
                f"strands force_stop: agent={self.agent_name}, "
                f"reason={event.get('force_stop_reason', 'unknown')}"
            )

    def _flush_reasoning(self) -> None:
        """聚合缓冲的 reasoning 增量 → agent_log 落盘（一条 reasoning 事件）"""
        if not self._reasoning_buf:
            return
        text = "".join(self._reasoning_buf).strip()
        self._reasoning_buf.clear()
        if not text or not self.session_id:
            return
        try:
            from strands_backend.agent_log import log_event

            if log_event(
                self.session_id,
                "reasoning",
                text,
                meta={"agent": self.agent_name},
            ):
                self._stats["reasoning_logged"] += 1
        except Exception as e:  # noqa: BLE001 — 流水日志失败不影响事件流
            logger.debug(f"flush reasoning to agent_log failed: {e}")

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
        "- 只读观察模式：写操作与命令执行被禁止，工具集已裁剪为只读白名单——"
        "ssh_command 等执行类工具已从 schema 移除，调用会报 Unknown tool；"
        "此前轮次用过执行类工具也不例外，不要重复尝试。\n"
        "- 专注解释与教学：读文件/分析日志/检查进程/诊断网络；"
        "需要执行时用 suggest_command 生成命令并说明作用，等用户自己执行。\n"
        "- 若工具返回 command_blocked 或 Unknown tool，如实报告未执行，"
        "严禁编造结果。"
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
    "会退化为普通 markdown。代码围栏（```)必须成对闭合，未闭合会把"
    "后续板块渲染成乱码（2026-09-01 用户实测）。\n\n"
    "Constraints:\n"
    "- 讲解命令/概念前，先调 knowledge_search 检索知识库"
    "（命令词源/设计哲学/FHS/90 命令档案），基于权威内容讲解，"
    "不要凭空发挥；需要完整文档/配置示例时用 knowledge_get_doc(url) 读取全文。\n"
    "- 可用 skill_invoke 查阅领域知识（linux-ops / ssh-troubleshoot 等）。\n"
    # TDSF 2026-08-31 (问题1修复): 教学模式严禁调用 suggest_command——该工具的
    # 命令预测卡片（含"预测回显"）是终端补全链路 UI，Teach 契约由教学卡片的
    # 「操作示例」命令块承担（前端 AiChat.RenderedTool 同步过滤兜底）。
    "- 严禁调用 suggest_command 工具（教学卡片不渲染该工具的命令预测 UI）；"
    "需要演示的命令直接写入「操作示例」板块的 bash 代码块，"
    "用户可从教学卡片一键复制/插入终端。\n"
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
    携带模式（observe/confirm/auto，缺省 confirm）与教学开关（teach bool）。

    T1 上下文连续性 (2026-08-31, 方案书 v4.0): Agent 实例按 (agent_id,
    session, 权限级) 缓存——mode/teach 移出缓存 key（不再触发重建），
    其对 prompt 与工具集的影响改为每次 invoke 动态刷新
    （_refresh_agent_runtime）；messages 历史 per-session 独立存储
    （_session_messages），实例重建（perm 变化/update_model）时迁移，
    切模式/教学开关对话历史零丢失；context_manager="auto" 长对话自动压缩。

    T2 循环护栏 (2026-08-31): 每会话挂载 ToolCallLimitHook——单次
    invoke 工具调用上限 MAX_TOOL_CALLS（50）、同一工具连续失败 ≥3 熔断
    （熔断解释 emit 用户可见 + cancel 消息回传 LLM）；每次工具调用
    记录 loop_progress（agent_log 落盘 + 前端状态条推流）。

    T3 规划-执行回环 (2026-08-31): invoke 收尾校验 todo 未完成项 →
    追加一轮续做提示（限一次，_todo_followup_done 会话级 flag）。

    T7 执行后验证回环 (2026-08-31, spec add-agent-loop-closure):
    - 系统提示 Post-change verification 行动段（写后必须只读验证）。
    - invoke 收尾检测 _maybe_verify_followup：hook.tool_log 中写类工具
      成功调用后无只读验证类调用 → 追加一轮"用只读工具验证改动生效"
      （限一次，_verify_followup_done 与 T3 独立计数）。

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

    # T2: 单次 invoke 工具调用总上限（spec"单任务工具调用上限 50"——
    # 放开长任务自由度；计数每次 invoke 开始时 reset，不跨对话累计）
    MAX_TOOL_CALLS: int = 50

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
        # T1 上下文连续性 (2026-08-31, 方案书 v4.0 感知→思考断点修复):
        # key 从 (agent_id, session_id, permission_level, mode, teach) 收窄为
        # (agent_id, session_id, permission_level)——mode/teach 只影响 system
        # prompt 与工具集，两者改为每次 invoke 动态刷新（_refresh_agent_runtime），
        # 不再触发实例重建；切模式/教学开关 = 历史零丢失。perm 保留（权限影响
        # 工具集合法性，重建合理），重建时从 _session_messages 迁移历史。
        self._agent_cache: dict[tuple[str, str, int], Any] = {}

        # T1: per-session 消息历史（(agent_id, session_id) -> messages 快照）。
        # messages 与 Agent 实例解耦的单一真源：每次 invoke 后从当前实例
        # agent.messages 同步（含 conversation_manager auto 压缩后的状态）；
        # 实例重建（perm 变化 / update_model 清缓存）时装载进新 Agent 构造
        # 参数 messages，保证跨实例的对话连续性。
        self._session_messages: dict[tuple[str, str], list] = {}

        # T2 循环护栏: ToolCallLimitHook 实例按 (agent_id, session_id) 缓存
        # （与 Agent 实例缓存 (agent_id, session_id, perm) 解耦——护栏只跟
        # 会话走；perm 重建实例不重置护栏，计数由 invoke 开始时 reset 单任务化）。
        self._limit_hooks: dict[tuple[str, str], ToolCallLimitHook] = {}

        # T3 规划-执行回环: 已触发过收尾追加轮的会话（限一次，防死循环）。
        # 会话生命周期内最多追加一轮"继续执行或向用户说明原因"。
        self._todo_followup_done: set[tuple[str, str]] = set()

        # T9 watchdog (2026-09-01, spec 9.1): invoke 超时弃管后仍在后台执行的
        # 会话标记——后续 invoke 对该会话快速降级（不卡 agent_lock）；
        # worker 线程自然结束时自行解除（见 _locked_invoke.finally）。
        self._stalled_sessions: set[tuple[str, str]] = set()

        # T7 执行后验证回环: 已触发过"写后未验证"追加轮的会话（限一次，
        # 与 _todo_followup_done 独立计数——两种收尾检测互不挤占机会）。
        self._verify_followup_done: set[tuple[str, str]] = set()

        # TDSF 修复 2026-08-09: per-agent 锁——防止同一 Agent 实例被并发调用。
        # Strands Agent 有内部状态（"already processing a request"），
        # 用户停止+立即重发会导致前后请求竞态崩溃。锁确保排队等待。
        # T1: 锁 key 随缓存 key 同步收窄（mode/teach 不再是实例身份）。
        self._agent_locks: dict[tuple[str, str, int], threading.RLock] = {}

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

    def _invoke_with_token_continuation(
        self,
        strands_agent: Any,
        prompt: str,
        agent_id: str,
        session_id: str,
    ) -> Any:
        """调用 Strands Agent；max_tokens 触顶自动续跑（A2 T9, 2026-09-01）

        Strands 语义：模型达到 max_tokens 时抛 MaxTokensReachedException，
        部分输出已写入 agent.messages——再次调用 agent 即从中断处继续。
        此前该异常直接冒泡到 invoke 的 except 分支整轮报错（用户实测：
        教学模式写长文到一半整体失败），现在自动续跑最多
        ``MAX_TOKEN_CONTINUATIONS`` 轮；仍触顶则原样抛出（走既有错误链路）。

        续跑轮与主轮共享调用方重置的 limit_hook 护栏（50 上限/熔断），
        不会绕过单任务护栏。
        """
        from strands.types.exceptions import MaxTokensReachedException

        current_prompt = prompt
        attempt = 0
        while True:
            try:
                return strands_agent(current_prompt)
            except MaxTokensReachedException:
                attempt += 1
                if attempt > MAX_TOKEN_CONTINUATIONS:
                    logger.error(
                        f"[a2] max_tokens continuation exhausted "
                        f"({MAX_TOKEN_CONTINUATIONS}): agent={agent_id}, "
                        f"session={session_id}"
                    )
                    raise
                logger.warning(
                    f"[a2] max_tokens reached, auto-continue "
                    f"{attempt}/{MAX_TOKEN_CONTINUATIONS}: agent={agent_id}, "
                    f"session={session_id}"
                )
                current_prompt = (
                    "上一轮输出因达到模型 max_tokens 上限被截断（已完成的部分"
                    "已保留）。请从中断处继续完成任务，不要重复已输出内容，"
                    "直到全部完成。"
                )

    def _wait_with_watchdog(
        self,
        worker: threading.Thread,
        get_events: Callable[[], int],
        agent_id: str,
        session_id: str,
    ) -> bool:
        """watchdog 等待（T9, spec 9.1）：轮询 worker 存活 + 回调事件增量

        Args:
            worker: invoke 工作线程（daemon，锁内执行）
            get_events: 读取 callback_handler 已收到事件数（任何增量=有输出）
            agent_id / session_id: stalled 标记 key

        Returns:
            True = 超时触发（已标记 stalled 并上报，调用方应返回降级响应）；
            False = worker 正常结束
        """
        idle_threshold, poll_secs = _watchdog_thresholds()

        last_seen = get_events()
        last_active = time.time()
        while True:
            worker.join(timeout=poll_secs)
            if not worker.is_alive():
                return False
            events_now = get_events()
            if events_now != last_seen:
                # 有任何回调事件（delta/工具/循环）= 有输出，刷新活跃时钟
                last_seen = events_now
                last_active = time.time()
                continue
            if time.time() - last_active > idle_threshold:
                self._stalled_sessions.add((agent_id, session_id))
                logger.error(
                    f"[t9] watchdog: no callback events for "
                    f"{_format_idle_secs(idle_threshold)}, "
                    f"abandoning invoke: agent={agent_id}, session={session_id}"
                )
                return True

    @staticmethod
    def _is_llm_transport_error(error: Exception) -> bool:
        """T9.2 (spec 9.2): 判断异常是否为 LLM 连接/超时类传输错误"""
        text = f"{type(error).__name__}: {error}".lower()
        return any(marker in text for marker in _LLM_TRANSPORT_ERROR_MARKERS)

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

        # T9 watchdog (spec 9.1): 上轮超时弃管的 worker 仍在后台执行时，
        # 本轮快速降级返回（不卡 agent_lock——worker 结束会自动解除标记）。
        # 弃管 worker 直到跑完才释放 per-(agent, session, perm) 锁，但标记解除
        # 发生在 with agent_lock 块之后的 finally，因此不存在"标记已清、锁仍被
        # 弃管 worker 持有"的窗口；其他会话/agent 用不同的锁，不受弃管影响。
        if (agent_id, session_id) in self._stalled_sessions:
            self._emit_mood("error", agent_id, session_id)
            logger.warning(
                f"[t9] invoke skipped (previous call stalled in background): "
                f"agent={agent_id}, session={session_id}"
            )
            return {
                "observation": (
                    "上一轮调用超时后仍在后台收尾，请稍等片刻再发消息；"
                    "会话历史已保留，不影响后续使用。"
                ),
                "next_step": "done",
                "mood": "error",
                "degraded": True,
                "degraded_reason": "invoke_stalled",
                "intermediate_results": [],
                "tokens": {},
            }

        # 2. 推送 mood=thinking（前端 AgentStatusPill 显示"思考中"）
        self._emit_mood("thinking", agent_id, session_id)

        # T1: 提前初始化——异常发生在 _get_or_create_agent 之前时，
        # except 分支的 best-effort 历史同步仍可安全引用（None 直接跳过）。
        strands_agent: Any = None

        try:
            # 3. 构建工具上下文（Task 3: 传入 invoke 已解析的三模式，
            #    供执行链 decide(risk_l, mode) 消费）
            ctx = self._build_tool_context(agent_id, session_id, state, mode=mode)

            # 4. 获取或创建 Strands Agent + per-agent 锁
            strands_agent = self._get_or_create_agent(agent_id, ctx, mode=mode, teach=teach)
            # TDSF 修复 2026-08-09: 防并发崩溃——Strands Agent 有内部状态，
            # 同一实例被并发调用会抛 "already processing a request"。
            # 用 per-(agent, session, perm) RLock 确保排队等待。
            # T1: mode/teach 移出锁 key——不再是实例身份的一部分（动态刷新）。
            lock_key = (agent_id, ctx.session_id, ctx.permission_level)
            agent_lock = self._agent_locks.setdefault(lock_key, threading.RLock())

            # 5. 构建 prompt（注入 live 上下文）
            prompt = self._build_prompt(input, state)

            # 会话流水日志（agent_log，2026-08-31）：user_msg + env_inject 落盘
            # ——排障时直接看"用户问了什么 + agent 看到了什么环境注入"。
            # 写失败静默（agent_log 内部降级），绝不影响 invoke 主链路。
            try:
                from strands_backend.agent_log import log_event as _log_event

                _log_user, _log_ctx = _split_input_for_log(input)
                if _log_ctx:
                    _log_event(
                        session_id,
                        "env_inject",
                        _log_ctx,
                        meta={"agent": agent_id, "mode": mode.value, "teach": teach},
                    )
                if _log_user:
                    _log_event(
                        session_id,
                        "user_msg",
                        _log_user,
                        meta={"agent": agent_id, "mode": mode.value, "teach": teach},
                    )
            except Exception as _e:  # noqa: BLE001 — 流水日志失败不影响主链路
                logger.debug(f"agent_log user_msg/env_inject failed: {_e}")

            # P0-A1 (2026-08-29): agent_switch 事件保留 emit（agent_id 透传，
            # Pill 同步）。委派删除后仅 main 常驻；"agent:" 前缀子 agent 事件
            # 不再产生，前端兼容逻辑由 Task 2 处理。
            self._emit_agent_switch(agent_id, session_id)

            # 6. 推送 mood=working
            self._emit_mood("working", agent_id, session_id)

            # 7. 调用 Strands Agent（同步，agentic loop 内部触发 callback_handler）
            # TDSF 修复 2026-08-09: 用锁保护 agent 调用——防止并发崩溃
            #
            # T9 watchdog (2026-09-01, spec 9.1): 锁内工作挪到 daemon worker
            # 线程，调用方线程做 watchdog 等待——模型挂起（连续 10 分钟无任何
            # 回调事件）时放弃等待并上报超时报告，会话可继续（不崩进程、不占
            # RPC 线程池）。stalled 标记让后续 invoke 快速降级；worker 自然
            # 结束时自动解除标记、恢复常规链路。
            handler = getattr(strands_agent, "callback_handler", None)
            handler_stats = getattr(handler, "_stats", None) or {}
            if not isinstance(handler_stats.get("events_received"), int):
                # 活跃信号读不到（handler 结构变更 / 未挂 callback）→ watchdog
                # 会把"健康但无事件"误判为挂起。仍保留有界超时兜底（优于无限
                # 阻塞），但留一条 WARNING：将来重构掉 _stats 时能被看见。
                logger.warning(
                    f"[t9] watchdog activity signal unavailable "
                    f"(handler={type(handler).__name__}), timeout will fire on "
                    f"silence: agent={agent_id}, session={session_id}"
                )

            outcome: dict[str, Any] = {}

            def _locked_invoke() -> None:
                try:
                    with agent_lock:
                        # T2: 单任务护栏——每次 invoke 开始重置计数（总上限 50 /
                        # 连续失败 3 熔断均按"单次 invoke"口径，不跨对话累计误杀）
                        limit_hook = self._limit_hooks.get(
                            (agent_id, ctx.session_id)
                        )
                        if limit_hook is not None:
                            limit_hook.reset()

                        # A2: max_tokens 截断自动续跑（续跑轮共享护栏计数）
                        response = self._invoke_with_token_continuation(
                            strands_agent, prompt, agent_id, session_id
                        )

                        # T3 (2026-08-31): 收尾校验——todo 未完成项追加一轮
                        # 续做提示（锁内调用，限一次防死循环）
                        followup_observation = self._maybe_todo_followup(
                            strands_agent, agent_id, session_id
                        )

                        # T7 (2026-08-31): 执行后验证回环——写类调用后无只读
                        # 验证时追加一轮补验证（与 T3 追加轮独立计数）
                        verify_observation = self._maybe_verify_followup(
                            strands_agent,
                            agent_id,
                            session_id,
                            limit_hook.tool_log if limit_hook is not None else [],
                        )
                    outcome["response"] = response
                    outcome["followup"] = followup_observation
                    outcome["verify"] = verify_observation
                except Exception as e:  # noqa: BLE001 — 交给调用方统一处理
                    outcome["error"] = e
                finally:
                    # worker 自然结束（含异常）→ 解除 stalled 标记，恢复常规链路
                    self._stalled_sessions.discard((agent_id, session_id))

            worker = threading.Thread(
                target=_locked_invoke,
                name=f"tdsf-invoke-{session_id or 'x'}",
                daemon=True,
            )
            worker.start()

            watchdog_fired = self._wait_with_watchdog(
                worker,
                lambda: handler_stats.get("events_received", 0),
                agent_id,
                session_id,
            )
            if watchdog_fired:
                # 超时：不取 worker 结果（仍在后台跑）——友好降级，对话可继续
                duration = time.time() - start_time
                idle_secs, _ = _watchdog_thresholds()
                msg = (
                    f"AI 调用超时：模型超过 {_format_idle_secs(idle_secs)}"
                    "没有任何输出，本轮已中止。"
                    "请检查网络或模型服务状态后重试；会话历史已保留，可直接继续对话。"
                )
                logger.error(
                    f"[t9] invoke watchdog timeout: agent={agent_id}, "
                    f"session={session_id}, duration={duration:.1f}s"
                )
                self._emit_mood("error", agent_id, session_id)
                try:
                    from strands_backend.agent_log import log_event as _log_event

                    _log_event(
                        session_id,
                        "watchdog_timeout",
                        msg,
                        meta={"agent": agent_id, "mode": mode.value},
                    )
                except Exception as _e:  # noqa: BLE001
                    logger.debug(f"agent_log watchdog_timeout failed: {_e}")
                return {
                    "observation": msg,
                    "next_step": "done",
                    "mood": "error",
                    "degraded": True,
                    "degraded_reason": "invoke_watchdog_timeout",
                    "intermediate_results": [],
                    "tokens": {},
                }
            if "error" in outcome:
                # worker 已失败——抛给下方 except 统一处理（含 T9.2 降级分类）
                raise outcome["error"]
            response = outcome.get("response")
            followup_observation = outcome.get("followup")
            verify_observation = outcome.get("verify")

            # T1 (2026-08-31): 同步 per-session 消息历史——messages 与实例解耦的
            # 单一真源。放在锁释放后（invoke 已完成，messages 处于稳定态）。
            # 注：conversation_manager="auto" 的压缩发生在 strands_agent(prompt)
            # 内部（SummarizingConversationManager 直接改写 agent.messages），
            # 此处同步的即压缩后状态——长对话历史按压缩结果迁移，正是期望行为。
            self._sync_session_messages(agent_id, session_id, strands_agent)

            # 8. 提取最终输出（T3/T7 追加轮有输出则覆盖主轮——追加轮是主轮的
            # "继续"，其最终答复才是用户应看到的收尾结果；空输出沿用主轮。
            # T7 验证轮在 T3 续做轮之后触发，覆盖优先级最高）
            observation = self._extract_response_text(response)
            if followup_observation:
                observation = followup_observation
            if verify_observation:
                observation = verify_observation

            # 会话流水日志：assistant_msg（最终回答全文）落盘
            if observation:
                try:
                    from strands_backend.agent_log import log_event as _log_event

                    _log_event(
                        session_id,
                        "assistant_msg",
                        observation,
                        meta={"agent": agent_id, "mode": mode.value, "teach": teach},
                    )
                except Exception as _e:  # noqa: BLE001
                    logger.debug(f"agent_log assistant_msg failed: {_e}")

            # P2-4 决策库: AI 排障成功自动沉淀案例（教学复盘/历史检索）
            # 条件: 会话有工具调用证据 + 有结论输出 + 输入像排障请求
            # A1 隔离: 工作区会话的案例打 workspace 标签（state.live.scopeId）
            self._auto_sink_case(
                agent_id,
                input,
                observation,
                session_id,
                scope_id=live_state.get("scopeId") or None,
            )

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
            # T1: 异常轮次 best-effort 同步历史——用户消息/已完成的工具轮
            # 已进 agent.messages，同步后 perm 变化重建实例时仍保留本轮上下文
            # （失败同步只降级为丢本轮，不影响主流程错误上报）。
            self._sync_session_messages(agent_id, session_id, strands_agent)

            # T9.2 (spec 9.2): LLM 传输类错误（连接失败/超时）→ 只读问答降级：
            # 友好说明替代报错卡，**对话不中断**；服务恢复后自动回到正常链路。
            # 不推 needs_you 错误卡（那是流程性失败专用）。
            if self._is_llm_transport_error(e):
                return {
                    "observation": (
                        "AI 服务暂时不可用（网络连接失败或超时），本轮无法调用模型。"
                        "你可以稍后重试；服务恢复后会自动回到正常工作模式。"
                        "本轮会话历史已保留，不影响后续对话。"
                    ),
                    "next_step": "done",
                    "mood": "error",
                    "degraded": True,
                    "degraded_reason": "llm_transport_error",
                    "degraded_message": str(e),
                    "intermediate_results": [],
                    "tokens": {},
                }

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
        """获取或创建 Strands Agent 实例（按 agent_id + session + 权限级缓存）

        P0-A1 (2026-08-29, 方案书 v3.1 三模式): main 是唯一 agent——
        原 _SUB_AGENT_SPECS 角色裁剪与 agent-as-tool 委派挂载已删除。
        工具集 = TOOL_REGISTRY 全量 × 模式过滤（observe → 只读白名单
        filter_tools_readonly；confirm/auto → 全量）。system prompt =
        基础段 + 模式指令 (+ teach 教学皮肤)。

        T1 上下文连续性 (2026-08-31, 方案书 v4.0):
        - 缓存 key 收窄为 (agent_id, session_id, permission_level)——mode/teach
          移出（切模式/教学开关不再重建实例，messages 零丢失）。
        - 模式/教学对 prompt 与工具集的影响改为每次 invoke 动态刷新
          （_refresh_agent_runtime：system_prompt setter + tool_registry
          重填——SDK 侧 get_all_tools_config 每次动态生成，无缓存陷阱）。
        - perm 变化仍重建实例（权限影响工具集合法性），历史从
          _session_messages 迁移（messages 构造参数装载）。
        - context_manager="auto"：SummarizingConversationManager
          （summary_ratio=0.3, compression_threshold=0.85）+ ContextOffloader，
          长对话自动压缩不报错。

        Args:
            agent_id: Agent 标识（缓存键 + 事件 source；未知 agent_id
                使用与 main 相同的工具集/prompt，回退语义兼容旧调用方）
            ctx: ToolContext（用于构建工具）
            mode: 信任模式（observe 裁剪只读白名单；prompt 按模式拼接）
            teach: Teach 教学皮肤开关（True 时拼入教学契约）

        Returns:
            Strands Agent 实例
        """
        # T1: 缓存 key 含 permission_level（P1-v5-2：L1 只读过滤；
        # 权限变化影响工具集合法性 → 重建合理），不含 mode/teach
        cache_key = (agent_id, ctx.session_id, ctx.permission_level)
        if cache_key in self._agent_cache:
            agent = self._agent_cache[cache_key]
        else:
            # 构建 callback_handler（main 事件流转发；P0-A1 委派删除后
            # 无静默 handler 需求）
            handler = TdsfStrandsCallbackHandler(
                event_bus=self.event_bus,
                agent_name=agent_id,
                session_id=ctx.session_id,
            )

            # T1: per-session 历史迁移——实例重建（perm 变化）时把
            # _session_messages 快照装载进新 Agent（Strands Agent 构造
            # 支持 messages 参数：pre-load 进对话历史）。浅拷贝 list 防
            # 新旧实例共享同一 list 对象（旧实例后续写入会串改新实例）。
            history = self._session_messages.get((agent_id, ctx.session_id))
            migrated = list(history) if history else None
            if migrated:
                logger.info(
                    f"T1 messages migrated: agent_id={agent_id}, "
                    f"session={ctx.session_id}, msgs={len(migrated)}"
                )

            # 创建 Strands Agent
            # mypy: _StrandsAgent 在降级路径已被排除，这里必有值
            #
            # TDSF 魔改 2026-07-30 P0-E: Strands 1.50.2 API 变更
            #   Agent.__init__() 移除了 max_iterations 参数（实测装 1.50.2 后
            #   报 "Agent.__init__() got an unexpected keyword argument 'max_iterations'"）。
            #   当前移除该参数让 LLM 调用工作起来，self.max_iterations 字段保留
            #   供未来用 LimitToolCounts hook 实现总工具调用次数限制（防死循环）。
            # T2 循环护栏 (2026-08-31, spec add-agent-loop-closure): 重新挂载
            #   ToolCallLimitHook——2026-08-09 曾因"12 次上限误伤长排查任务"整体
            #   摘除；现参数调整后回归：总上限 12→50（放开长任务自由度）+
            #   连续失败 ≥3 熔断 + 熔断解释双通道（用户可见）+ loop_progress
            #   进度上报（agent_log 落盘 + 前端状态条）。计数在每次 invoke
            #   开始时 reset（单任务语义），不再跨 invoke 累计误杀。
            limit_hook = self._get_limit_hook(agent_id, ctx.session_id)
            agent = _StrandsAgent(  # type: ignore[misc]
                model=self.strands_model,
                # T1: 工具集改由 _refresh_agent_runtime 动态填充（创建路径
                # 也走刷新，保证 prompt/工具集组装逻辑单一真源）
                tools=[],
                system_prompt=self.system_prompt,
                messages=migrated,
                callback_handler=handler,
                # T1 (spec add-agent-loop-closure Task 1.3): auto 上下文管理
                # ——SDK 1.53.0 组合 SummarizingConversationManager
                # (summary_ratio=0.3, compression_threshold=0.85) +
                # ContextOffloader(max_result_tokens=1500, preview_tokens=750)，
                # 长对话在上下文窗口 85% 时主动压缩摘要（方案书 v4.0 T1）。
                context_manager="auto",
                # T2: 循环护栏（50 上限 / 连续失败 3 熔断 / 进度上报）
                hooks=[limit_hook],
                name=agent_id,
                # max_iterations=self.max_iterations,  # Strands 1.50.2 已移除
            )

            self._agent_cache[cache_key] = agent
            logger.info(
                f"Strands Agent created: agent_id={agent_id}, "
                f"session_id={ctx.session_id}, mode={mode.value}, teach={teach}, "
                f"context_manager=auto, migrated_msgs={len(migrated) if migrated else 0}"
            )

        # T1: 每次 invoke（无论新建还是缓存命中）都刷新 prompt 与工具集
        # ——mode/teach/ctx 的运行时影响在此组装，与实例生命周期解耦。
        self._refresh_agent_runtime(agent, ctx, mode=mode, teach=teach)
        return agent

    def _refresh_agent_runtime(
        self,
        agent: Any,
        ctx: ToolContext,
        mode: AgentMode = AgentMode.CONFIRM,
        teach: bool = False,
    ) -> None:
        """每次 invoke 动态刷新实例的 system prompt 与工具集（T1 解耦核心）

        Strands Agent 支持运行时更新：
        - system_prompt 是 property（setter 重解析为 content blocks）
        - tool_registry.registry 清空后 process_tools 重填；
          get_all_tools_config 每次动态生成（无缓存），event_loop 每次
          invoke 从 agent.tool_registry 取最新工具集

        模式影响：
        - system_prompt = 基础段 + 模式指令 (+ 教学皮肤)
        - observe → 工具集裁剪为只读白名单（schema 级隔离，
          extra_tools 未注册项同样被裁，fail-closed）

        顺带收益：工具闭包每次重建绑定最新 ctx（ssh_host / cwd 等
        live 字段变化即时生效，修复缓存命中路径闭包陈旧的隐患）。
        """
        # 构建运维工具（TOOL_REGISTRY 全量，带 ctx 闭包；L1 权限由
        # make_all_ops_tools 内部按 READONLY_TOOL_NAMES 过滤）
        all_tools = make_all_ops_tools(ctx) + self.extra_tools

        # P0-A1 观察模式 schema 级隔离：裁剪为只读白名单——LLM 无法调用
        # 不存在于 schema 的执行/写类工具（remove 优于 instruct+intercept）。
        if mode == AgentMode.OBSERVE:
            all_tools = filter_tools_readonly(all_tools)

        # 模式感知 prompt：基础段 + 模式指令 (+ 教学皮肤)
        agent.system_prompt = _compose_system_prompt(mode, teach, base=self.system_prompt)

        # 工具集重填（保留 ToolRegistry 对象，清空 dict 后 process_tools——
        # _ToolCaller/event_loop 均经由 agent.tool_registry 动态访问，安全）
        registry = agent.tool_registry
        registry.registry.clear()
        registry.dynamic_tools.clear()
        registry.process_tools(all_tools)

    def _sync_session_messages(
        self,
        agent_id: str,
        session_id: str,
        agent: Any,
    ) -> None:
        """T1: 把当前实例的 messages 快照同步进 per-session 存储

        invoke 完成（含异常轮 best-effort）后调用；失败静默（历史同步
        是加分项，绝不影响主链路）。session_id 为空（匿名调用）不同步。
        """
        if not session_id or agent is None:
            return
        try:
            msgs = getattr(agent, "messages", None)
            if msgs is not None:
                self._session_messages[(agent_id, session_id)] = list(msgs)
        except Exception as e:  # noqa: BLE001 — 历史同步失败不阻塞主流程
            logger.debug(f"session messages sync skipped: {e}")

    def _get_limit_hook(self, agent_id: str, session_id: str) -> ToolCallLimitHook:
        """T2: 获取或创建会话级循环护栏 hook（(agent_id, session_id) 缓存）

        hook 与 Agent 实例缓存解耦（perm 重建实例仍复用同一护栏）；
        计数在每次 invoke 开始时 reset（单任务上限语义）。
        """
        key = (agent_id, session_id)
        hook = self._limit_hooks.get(key)
        if hook is None:
            hook = ToolCallLimitHook(
                max_tool_calls=self.MAX_TOOL_CALLS,
                max_failures=3,
                agent_name=agent_id,
                event_bus=self.event_bus,
                session_id=session_id,
            )
            self._limit_hooks[key] = hook
            logger.info(
                f"T2 loop guard hook created: agent_id={agent_id}, "
                f"session={session_id}, max_tool_calls={self.MAX_TOOL_CALLS}"
            )
        return hook

    # ========================================================================
    # T3 规划-执行回环：invoke 收尾校验（todo 未完成 → 追加一轮，限一次）
    # ========================================================================

    def _maybe_todo_followup(
        self,
        strands_agent: Any,
        agent_id: str,
        session_id: str,
    ) -> str:
        """T3.2: invoke 后收尾校验——todo 有未完成项则追加一轮续做提示

        数据源：todo_write 工具维护的 per-session 镜像（tools/todo_write.py
        _session_todos）——sidecar 无法直接读前端 TodoStore，以镜像为准。

        防死循环：会话级 flag（_todo_followup_done，(agent_id, session_id)），
        触发前先置位——追加轮内即使又写新 todo 且未完成，也不再触发；
        追加轮异常同样不重试。调用方须持有 agent_lock（本方法在锁内调用，
        与主轮共享护栏计数，追加轮超 50 上限同样熔断）。

        Args:
            strands_agent: 当前会话的 Strands Agent 实例（锁内已持有）
            agent_id: Agent 标识
            session_id: 会话 ID

        Returns:
            追加轮的最终文本（未触发 / 触发但无输出时为空串，调用方沿用主轮结果）
        """
        if not session_id:
            return ""
        if (agent_id, session_id) in self._todo_followup_done:
            return ""
        try:
            from strands_backend.tools.todo_write import get_unfinished_todos

            unfinished = get_unfinished_todos(session_id)
        except Exception as e:  # noqa: BLE001 — 校验失败不阻塞返回主轮结果
            logger.debug(f"todo followup check skipped: {e}")
            return ""
        if not unfinished:
            return ""

        # 限一次：先置位再追加（防追加轮内异常/新未完成项导致重复触发）
        self._todo_followup_done.add((agent_id, session_id))

        lines = "\n".join(
            f"- [{t.get('status', 'pending')}] {t.get('title', '')}"
            for t in unfinished
        )
        followup_prompt = (
            f"[TDSF] 任务清单还有 {len(unfinished)} 项未完成：\n{lines}\n"
            f"请继续执行这些任务并逐项更新 todo_write 状态；"
            f"若确认无法继续（被拒/环境限制/依赖用户决策），"
            f"请向用户说明原因，不要静默留下未完成项。"
        )

        # 流水落盘（todo_followup 事件，排障可见追加轮的注入内容）
        try:
            from strands_backend.agent_log import log_event

            log_event(
                session_id,
                "todo_followup",
                followup_prompt,
                meta={"agent": agent_id, "unfinished": len(unfinished)},
            )
        except Exception as e:  # noqa: BLE001
            logger.debug(f"agent_log todo_followup failed: {e}")

        logger.info(
            f"T3 todo followup round: agent_id={agent_id}, "
            f"session={session_id}, unfinished={len(unfinished)}"
        )
        try:
            resp = strands_agent(followup_prompt)
            return self._extract_response_text(resp)
        except Exception as e:  # noqa: BLE001 — 追加轮失败降级用主轮结果
            logger.warning(f"todo followup round failed (fallback: main result): {e}")
            return ""

    def _maybe_verify_followup(
        self,
        strands_agent: Any,
        agent_id: str,
        session_id: str,
        tool_log: list[dict[str, Any]],
    ) -> str:
        """T7: invoke 后收尾检测——写类成功调用后无验证类调用则追加一轮

        复用 T3 _maybe_todo_followup 同款机制（系统身份追加一轮提示 +
        会话级 flag 限一次），数据源为 ToolCallLimitHook.tool_log（本单次
        invoke 的工具调用流水，见 _needs_verify_followup 判定规则）。

        防死循环：_verify_followup_done 会话级 flag 触发前先置位，与
        _todo_followup_done 独立计数（两检测各有一次追加机会）。调用方须
        持有 agent_lock（本方法在锁内调用，追加轮与主轮共享护栏计数）。

        Args:
            strands_agent: 当前会话的 Strands Agent 实例（锁内已持有）
            agent_id: Agent 标识
            session_id: 会话 ID
            tool_log: 本轮 invoke 的工具调用流水（hook.tool_log）

        Returns:
            追加轮的最终文本（未触发 / 触发但无输出时为空串，调用方沿用主轮结果）
        """
        if not session_id:
            return ""
        if (agent_id, session_id) in self._verify_followup_done:
            return ""
        if not _needs_verify_followup(tool_log):
            return ""

        # 限一次：先置位再追加（防追加轮内异常/新写后未验导致重复触发）
        self._verify_followup_done.add((agent_id, session_id))

        followup_prompt = (
            "[TDSF] 检测到你在本轮执行了修改类操作（写文件/执行修改类命令/"
            "改配置），但之后未用只读工具验证改动是否生效。"
            "请立即用只读工具验证改动结果（如 systemctl status / cat / ls / "
            "测试命令），基于验证输出确认改动生效后再收尾；"
            "若验证发现问题请继续修复。未经验证不得声称操作成功。"
        )

        # 流水落盘（verify_followup 事件，排障可见追加轮的注入内容）
        try:
            from strands_backend.agent_log import log_event

            log_event(
                session_id,
                "verify_followup",
                followup_prompt,
                meta={
                    "agent": agent_id,
                    "tool_log_len": len(tool_log),
                    "last_tools": [
                        str(e.get("name", "")) for e in tool_log[-3:]
                    ],
                },
            )
        except Exception as e:  # noqa: BLE001
            logger.debug(f"agent_log verify_followup failed: {e}")

        logger.info(
            f"T7 verify followup round: agent_id={agent_id}, "
            f"session={session_id}, tool_calls={len(tool_log)}"
        )
        try:
            resp = strands_agent(followup_prompt)
            return self._extract_response_text(resp)
        except Exception as e:  # noqa: BLE001 — 追加轮失败降级用主轮结果
            logger.warning(f"verify followup round failed (fallback: main result): {e}")
            return ""

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

        # T5 (2026-08-31, spec add-agent-loop-closure): 本地工作区路径
        # （workspaceRoot 优先，cwd 兜底）——python_run 的 subprocess cwd；
        # 空 = 不可得（python_run fail-closed 拒绝）
        workspace = str(live.get("workspaceRoot") or live.get("cwd") or "")

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
            workspace=workspace,
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
            # P2 #42: 多主机提示——其余会话不在 env 注入（省 token），
            # LLM 需要时经 ssh_list_sessions 工具按需枚举
            lines.append(
                "如需操作其他 SSH 会话（多主机），先调用 ssh_list_sessions 枚举全部会话"
            )
        # TDSF 修复 2026-08-29: 区分"本地终端在跑/WSL"与"欢迎页啥都没开"。
        # 欢迎页（无任何环境线索）时原 else 分支让 LLM 自称"本地终端模式"并幻觉
        # 本地诊断工具可直接用，故拆出无环境分支引导用户先建工作区。
        # TDSF 2026-08-31 (问题1修复): 前端新增 live.terminalSession
        # （"ssh"|"local"|"none"）作为"有无活动终端会话"的权威信号——
        # workspace cwd（默认主目录）存在不代表终端已打开。terminalSession
        # 显式给出时优先生效；缺省（旧调用方）回退原 workspace/cwd 启发式。
        elif live.get("terminalSession") == "none":
            lines.append(
                "当前未打开任何终端会话——workspace 仅为默认工作区路径（不代表终端已打开）。"
                "请告知用户：当前未打开终端，请先新建本地终端或建立 SSH 连接，我不会假设环境；"
                "严禁把自己当成已连接本地终端或远程服务器，不要声称任何工具可以直接使用。"
            )
        elif live.get("terminalSession") == "local" or (
            live.get("terminalSession") is None
            and (live.get("workspaceRoot") or live.get("cwd") or live.get("activeFile"))
        ):
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
            # A1 上下文面板 (2026-09-01): 透出缓存命中——OpenAI 兼容
            # （DeepSeek: prompt_cache_hit_tokens / OpenAI: prompt_tokens_details.
            # cached_tokens；Strands 聚合后也可能平铺为 cache_read_input_tokens）
            cached = (
                usage.get("cache_read_input_tokens", 0)
                or usage.get("prompt_cache_hit_tokens", 0)
                or (usage.get("prompt_tokens_details") or {}).get("cached_tokens", 0)
                or 0
            )
            return {
                "input_tokens": usage.get("input_tokens", 0) or usage.get("prompt_tokens", 0),
                "output_tokens": usage.get("output_tokens", 0) or usage.get("completion_tokens", 0),
                "total_tokens": usage.get("total_tokens", 0),
                "cached_input_tokens": int(cached or 0),
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

    # TDSF 2026-08-31 (问题5修复): StrandsAgentAdapter._emit_agent_message 已删除。
    # 它唯一的调用方是已移除的"开始处理: ..."thinking 消息（invoke 调度日志，
    # 混入前端 reasoning 流污染 Thinking 区展示）。模型 reasoningText/output
    # 增量由 TdsfStrandsCallbackHandler._emit_agent_message 转发，不受影响。

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
        scope_id: str | None = None,
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
                    # A1 工作区隔离: 工作区会话沉淀的案例打 workspace 标签
                    tags=[
                        "自动沉淀",
                        "排障",
                        *( [f"workspace:{scope_id}"] if scope_id else [] ),
                    ],
                )
            )
            logger.info(f"auto case sunk: {case_id} ({agent_id})")
        except Exception as e:
            logger.debug(f"auto sink case skipped: {e}")

    def clear_cache(self) -> None:
        """清空 Agent 缓存（配置变更后调用）

        T1: 只清实例缓存（agent 绑定旧 model/闭包必须重建），不清
        _session_messages——历史与实例解耦后，重建实例从历史装载，
        换模型/清缓存不再丢对话上下文（方案书 v4.0 T1 断点修复）。
        """
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
            # T1: 缓存 key 已收窄（mode/teach 移除），mode 不再是实例属性
            "cached_agents": [
                f"{agent_id}:{session_id}:L{perm}"
                for (agent_id, session_id, perm) in self._agent_cache.keys()
            ],
            # T1: per-session 历史条数（messages 解耦状态可见性）
            "session_history_entries": len(self._session_messages),
            "max_iterations": self.max_iterations,
            "extra_tools_count": len(self.extra_tools),
        }


__all__ = [
    "StrandsAgentAdapter",
    "TdsfStrandsCallbackHandler",
]
