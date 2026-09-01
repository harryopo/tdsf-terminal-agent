"""
strands_backend/tools/registry.py — 工具三角色注册表（T2）
===========================================================

职责（方案书 v3.0 T2：工具三角色解耦）：
- 把工具的三个正交关注点拆开，统一在 TOOL_REGISTRY 注册：
  1. **实现**（factory）：Python 工厂函数（延迟导入，避免循环依赖），
     产出带 ToolContext 闭包的 @tool 函数。
  2. **Policy**（ToolPolicy）：审批级别标记（readonly / needs_approval）
     + 脱敏标记（sanitize_output）——审批策略变更只改这里，不动实现代码。
  3. **Schema**（description）：LLM 可见的一句话描述——供系统提示目录 /
     未来 MCP 工具暴露复用（工具完整签名仍由 @tool docstring 生成）。

约定：
- ToolSpec.name = @tool 装饰后的函数名（与 LLM 可见名、白名单过滤名一致）。
  注意与 OPS_TOOL_NAMES 的"注册显示名"不同（如 read_remote_file ↔ remote_file），
  兼容映射见 OPS_TOOL_ALIASES。
- factory 用 "module:attr" 点路径字符串 + importlib 延迟解析：
  工具模块反向 import strands_backend.tools（取 ToolContext/tool），
  本模块被 tools/__init__.py 加载，若顶层 import 工具模块会成环。

行为不变量（迁移自 tools/__init__.py，P1-v5-2 语义保持）：
- L1（免确认）权限下仅保留 policy.readonly=True 的工具。
- knowledge_search / knowledge_get_doc 为纯本地只读工具
  （readonly=True，2026-08-31 语义修正：L1 免确认模式可用）。
"""

from __future__ import annotations

import importlib
import logging
from dataclasses import dataclass
from typing import Any, Callable

logger = logging.getLogger("sidecar.strands_backend.tools.registry")


# ============================================================================
# Policy（审批级别 + 只读标记 + 脱敏标记）
# ============================================================================


@dataclass(frozen=True)
class ToolPolicy:
    """工具审批/安全策略（三角色之二）

    Attributes:
        readonly: 只读工具。L1（免确认）权限下仅 readonly=True 的工具保留
            在 schema 中（schema-level safety，P1-v5-2）。
        needs_approval: 该工具属于执行/写类，命令命中 RiskChecker 高危时
            需走 needs_you 审批（对齐 T3 fail-closed 门禁的判定输入）。
        sanitize_output: 返回体含不可信文本，需经 redact_sensitive 脱敏
            （当前 execute_via_ssh 已统一脱敏，此标记供独立路径工具参考）。
    """

    readonly: bool = False
    needs_approval: bool = False
    sanitize_output: bool = False


# ============================================================================
# ToolSpec（实现 + Policy + Schema 三件套）
# ============================================================================


@dataclass(frozen=True)
class ToolSpec:
    """单个工具的三角色注册项

    Attributes:
        name: @tool 函数名（LLM 可见名 + 白名单过滤名）
        factory: 工厂函数点路径（"module:attr"，延迟导入防循环依赖）
        description: LLM 可见一句话描述（Schema 角色）
        policy: 审批/安全策略（Policy 角色）
    """

    name: str
    factory: str
    description: str
    policy: ToolPolicy


def resolve_factory(spec: ToolSpec) -> Callable[..., Any]:
    """按点路径延迟解析工厂函数

    Args:
        spec: 工具注册项

    Returns:
        工厂函数（调用时传 ctx）
    """
    module_name, _, attr = spec.factory.partition(":")
    module = importlib.import_module(module_name)
    return getattr(module, attr)


# ============================================================================
# 22 工具注册表（13 运维/知识 + 6 魔改增强 + knowledge_get_doc + T5 python_run；
# tools/__init__.py + ops_extended.py + 2026-08-09 集成度补齐 6 工具收编）
# ============================================================================

# 描述（Schema 角色）与各工具 docstring 首行对齐；改 docstring 时同步这里
TOOL_REGISTRY: dict[str, ToolSpec] = {
    # --- 基础运维 5 + Skill + 建议 + 知识库（tools/ 顶层模块）---
    "ssh_command": ToolSpec(
        name="ssh_command",
        factory="strands_backend.tools.ssh_command:make_ssh_command_tool",
        description="在远程 SSH 会话执行命令，返回 stdout/stderr/exit_code（高危命令触发审批）",
        policy=ToolPolicy(readonly=False, needs_approval=True, sanitize_output=True),
    ),
    "read_remote_file": ToolSpec(
        name="read_remote_file",
        factory="strands_backend.tools.remote_file:make_remote_file_tool",
        description="读取远程文件内容（只读）",
        policy=ToolPolicy(readonly=True, needs_approval=False, sanitize_output=True),
    ),
    "analyze_logs": ToolSpec(
        name="analyze_logs",
        factory="strands_backend.tools.log_analyzer:make_log_analyzer_tool",
        description="分析远程日志文件，提取错误/告警模式（只读）",
        policy=ToolPolicy(readonly=True, needs_approval=False, sanitize_output=True),
    ),
    "inspect_processes": ToolSpec(
        name="inspect_processes",
        factory="strands_backend.tools.process_inspector:make_process_inspector_tool",
        description="检查远程进程/资源占用（只读）",
        policy=ToolPolicy(readonly=True, needs_approval=False, sanitize_output=False),
    ),
    "network_diagnose": ToolSpec(
        name="network_diagnose",
        factory="strands_backend.tools.network_diagnostic:make_network_diagnostic_tool",
        description="诊断远程网络连通性（ping/端口/DNS，只读）",
        policy=ToolPolicy(readonly=True, needs_approval=False, sanitize_output=False),
    ),
    "skill_invoke": ToolSpec(
        name="skill_invoke",
        factory="strands_backend.tools.skill_invoke:make_skill_invoke_tool",
        description="调用已注册的 Skill，获取领域知识卡或执行预定义脚本",
        # skill_invoke 可触发 SKILL.md executor 的 shell 执行 → 非 readonly
        # （与 P1-v5-2 行为一致：L1 免确认下从 schema 移除）
        policy=ToolPolicy(readonly=False, needs_approval=False, sanitize_output=False),
    ),
    "suggest_command": ToolSpec(
        name="suggest_command",
        factory="strands_backend.tools.suggest_command:make_suggest_command_tool",
        description="根据用户意图生成可执行的 Linux 命令建议（不执行）",
        policy=ToolPolicy(readonly=True, needs_approval=False, sanitize_output=False),
    ),
    "knowledge_search": ToolSpec(
        name="knowledge_search",
        factory="strands_backend.tools.knowledge_search:make_knowledge_search_tool",
        description="检索本地知识库精简版（中文提炼知识点，RAG 混合检索）返回相关片段",
        # 2026-08-31 语义修正：纯本地只读检索（不触碰系统/远端），L1 免确认
        # 模式可用（原 P1-v5-2 白名单未含属历史遗留，非安全考量）
        policy=ToolPolicy(readonly=True, needs_approval=False, sanitize_output=False),
    ),
    "knowledge_get_doc": ToolSpec(
        name="knowledge_get_doc",
        factory="strands_backend.tools.knowledge_get_doc:make_knowledge_get_doc_tool",
        description="按 url 读取知识库完整文档（检索结果 url → 全文 markdown）",
        # 纯本地只读（同 knowledge_search，读精简库）
        policy=ToolPolicy(readonly=True, needs_approval=False, sanitize_output=False),
    ),
    # --- 扩展运维 5（ops_extended.py）---
    "service_manage": ToolSpec(
        name="service_manage",
        factory="strands_backend.tools.ops_extended:make_service_manage_tool",
        description="管理 systemd 服务（start/stop/restart/enable/status，写操作需审批）",
        policy=ToolPolicy(readonly=False, needs_approval=True, sanitize_output=False),
    ),
    "package_manage": ToolSpec(
        name="package_manage",
        factory="strands_backend.tools.ops_extended:make_package_manage_tool",
        description="管理软件包（yum/dnf install/remove 等，写操作需审批）",
        policy=ToolPolicy(readonly=False, needs_approval=True, sanitize_output=False),
    ),
    "firewall_manage": ToolSpec(
        name="firewall_manage",
        factory="strands_backend.tools.ops_extended:make_firewall_manage_tool",
        description="管理 firewalld 防火墙规则（写操作需审批）",
        policy=ToolPolicy(readonly=False, needs_approval=True, sanitize_output=False),
    ),
    "security_audit": ToolSpec(
        name="security_audit",
        factory="strands_backend.tools.ops_extended:make_security_audit_tool",
        description="安全基线审计（SELinux/登录/口令策略检查，只读）",
        policy=ToolPolicy(readonly=True, needs_approval=False, sanitize_output=False),
    ),
    "performance_analyze": ToolSpec(
        name="performance_analyze",
        factory="strands_backend.tools.ops_extended:make_performance_analyze_tool",
        description="性能分析（CPU/内存/磁盘 IO 采样，只读）",
        policy=ToolPolicy(readonly=True, needs_approval=False, sanitize_output=False),
    ),
    # --- 魔改增强 6（2026-08-09 集成度补齐；原在 adapter 逐个 try 挂载，
    #     T2 收编入注册表统一治理。注意：backup_restore 原 L1 下也挂载，
    #     收编后受 schema-level safety 管辖（L1 只保留 readonly）——fail-closed 收紧）---
    "todo_write": ToolSpec(
        name="todo_write",
        factory="strands_backend.tools.todo_write:make_todo_write_tool",
        description="更新当前任务列表（多步骤任务规划，前端任务 UI 联动，自动执行）",
        # 只写前端 todo 状态，无系统风险 → readonly（L1 下保留，与原行为一致）
        policy=ToolPolicy(readonly=True, needs_approval=False, sanitize_output=False),
    ),
    "get_terminal_output": ToolSpec(
        name="get_terminal_output",
        factory="strands_backend.tools.get_terminal_output:make_get_terminal_output_tool",
        description="获取当前终端最近 N 行输出（scrollback，SSH 时读远端终端）",
        # 终端输出可能含敏感回显 → sanitize_output=True
        policy=ToolPolicy(readonly=True, needs_approval=False, sanitize_output=True),
    ),
    "config_diff": ToolSpec(
        name="config_diff",
        factory="strands_backend.tools.config_diff:make_config_diff_tool",
        description="对比两个远程配置文件的差异（diff -u，只读）",
        # 配置文件差异可能含密码 → sanitize_output=True
        policy=ToolPolicy(readonly=True, needs_approval=False, sanitize_output=True),
    ),
    "backup_restore": ToolSpec(
        name="backup_restore",
        factory="strands_backend.tools.backup_restore:make_backup_restore_tool",
        description="备份或恢复远程配置文件（cp；restore 为写操作）",
        # restore 是远端 cp 写操作 → needs_approval；L1 下被裁剪（原行为直挂，
        # 收编后统一受 L1 readonly 过滤——schema-level safety 补口）
        policy=ToolPolicy(readonly=False, needs_approval=True, sanitize_output=True),
    ),
    "assess_confidence": ToolSpec(
        name="assess_confidence",
        factory="strands_backend.tools.confidence_tool:make_confidence_tool",
        description="评估证据链可信度（D-S 证据理论 + PCR5 冲突重分配，纯计算）",
        policy=ToolPolicy(readonly=True, needs_approval=False, sanitize_output=False),
    ),
    "search_history": ToolSpec(
        name="search_history",
        factory="strands_backend.tools.decision_history:make_decision_history_tool",
        description="检索历史排障案例库，参考类似问题的历史解决方案（只读）",
        policy=ToolPolicy(readonly=True, needs_approval=False, sanitize_output=False),
    ),
    # T14 (2026-08-28): 会话记忆沉淀 — 经验一键沉淀为 SKILL.md 技能包 + 热重载
    "save_skill": ToolSpec(
        name="save_skill",
        factory="strands_backend.tools.session_memory_tool:make_save_skill_tool",
        description="把本次会话沉淀的经验/排障过程保存为可复用技能包（写用户技能目录并立即生效）",
        # 只写 ~/.tdsf/skills/<name>/SKILL.md（name 有 slug 校验，非系统命令）→ 免审批
        policy=ToolPolicy(readonly=False, needs_approval=False, sanitize_output=False),
    ),
    # T5 (2026-08-31, spec add-agent-loop-closure): python_run PTC 工具
    # （无沙箱版）——本地 subprocess 受控执行（30s 超时 / 输出截断 10KB /
    # cwd 锁定 workspace；SSH 会话与无工作区 fail-closed 拒绝）
    "python_run": ToolSpec(
        name="python_run",
        factory="strands_backend.tools.python_run:make_python_run_tool",
        description="在本地工作区执行一段 Python 代码（受控：30s 超时、输出截断 10KB）",
        # 进程级受控（无沙箱）：本地 subprocess 执行 → 非 readonly（observe/L1
        # 模式 schema 裁剪）。needs_approval=False 对齐 save_skill/skill_invoke
        # 哲学——审批链路（RiskChecker/needs_you）针对 shell 命令，python 源码
        # 不走该链路，由三模式 schema 门禁 + 进程级受控边界管控
        policy=ToolPolicy(readonly=False, needs_approval=False, sanitize_output=False),
    ),
}

# 派生只读集合（替代原 _L1_READONLY_TOOL_NAMES 硬编码）
READONLY_TOOL_NAMES: frozenset[str] = frozenset(
    spec.name for spec in TOOL_REGISTRY.values() if spec.policy.readonly
)

# 需审批工具集合（T3 fail-closed 门禁的判定输入）
APPROVAL_TOOL_NAMES: frozenset[str] = frozenset(
    spec.name for spec in TOOL_REGISTRY.values() if spec.policy.needs_approval
)

# ============================================================================
# T7 (2026-08-31, spec add-agent-loop-closure): 执行后验证回环——工具分类
# ============================================================================
# 写类/验证类两清单是 adapter._needs_verify_followup 判定"写后未验证"的
# 输入（spec Task 7 钦定，对齐本项目现有工具名）：
#
# - WRITE_CLASS_TOOL_NAMES（写类）= spec 的 write_file/edit_file/ssh_command(执行)
#   /python_run/config_diff 应用 对齐到本项目：执行/修改类工具。ssh_command
#   在判定层还会按命令内容细分（只读命令如 status/cat 不算写，见 adapter）。
# - VERIFY_CLASS_TOOL_NAMES（验证类）= spec 的 read_file/list_directory/grep
#   /get_terminal_output/knowledge_search 对齐到本项目：只读查询类工具。
#
# 注意：config_diff 在本项目是只读 diff（远端 diff -u），归验证类；
# skill_invoke 主语义是获取知识卡（虽可带 executor），不入写类防误报。
WRITE_CLASS_TOOL_NAMES: frozenset[str] = frozenset({
    "ssh_command",       # 执行命令（判定层按命令细分只读/写）
    "python_run",       # 本地 Python 执行（可写文件/起进程）
    "service_manage",   # systemd 服务管理（start/stop/restart/enable）
    "package_manage",   # 软件包管理（install/remove）
    "firewall_manage",  # 防火墙规则管理
    "backup_restore",   # 备份/恢复（restore 为远端写）
    "save_skill",       # 写用户技能目录（~/.tdsf/skills/）
})

VERIFY_CLASS_TOOL_NAMES: frozenset[str] = frozenset({
    "read_remote_file",   # 读远程文件（spec: read_file）
    "analyze_logs",       # 日志分析（spec: grep）
    "inspect_processes",  # 进程检查
    "network_diagnose",   # 网络诊断（ping/端口/DNS）
    "get_terminal_output",  # 终端回读（spec: get_terminal_output）
    "config_diff",        # 配置差异对比（只读 diff -u）
    "knowledge_search",  # 知识库检索（spec: knowledge_search）
    "knowledge_get_doc",  # 知识库文档读取
    "suggest_command",    # 命令建议（纯生成，不执行）
})


def get_tool_policy(name: str) -> ToolPolicy | None:
    """查询工具策略（大小写敏感，与 @tool 函数名一致）

    Args:
        name: 工具函数名

    Returns:
        ToolPolicy；未注册工具返回 None
    """
    spec = TOOL_REGISTRY.get(name)
    return spec.policy if spec else None


# ============================================================================
# 兼容层（tools/__init__.py / adapter / 测试引用的旧名称）
# ============================================================================

# 注册显示名 ↔ @tool 函数名 映射（OPS_TOOL_NAMES 派生用）
OPS_TOOL_ALIASES: dict[str, str] = {
    "read_remote_file": "remote_file",
    "analyze_logs": "log_analyzer",
    "inspect_processes": "process_inspector",
    "network_diagnose": "network_diagnostic",
}

# 工具目录文本（Schema 角色的批量出口：系统提示 / MCP 暴露可复用）
def tool_catalog_text() -> str:
    """生成全部已注册工具的 name + description 目录文本

    Returns:
        多行文本，每行 `- <name>: <description>`（按注册顺序）
    """
    return "\n".join(f"- {s.name}: {s.description}" for s in TOOL_REGISTRY.values())


__all__ = [
    "ToolPolicy",
    "ToolSpec",
    "TOOL_REGISTRY",
    "READONLY_TOOL_NAMES",
    "APPROVAL_TOOL_NAMES",
    "WRITE_CLASS_TOOL_NAMES",
    "VERIFY_CLASS_TOOL_NAMES",
    "OPS_TOOL_ALIASES",
    "resolve_factory",
    "get_tool_policy",
    "tool_catalog_text",
]
