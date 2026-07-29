"""
agents/coding_agent.py — Coding Agent（T-P1-11.2）
====================================================

职责（spec DEC-V321-③）：
- 代码生成 + 修改（执行 Edit/Write 工具）
- 调用 risk tool 评估命令风险（避免危险操作）
- 调用 decision tool 评估代码修改决策（含历史案例）

工具集：
- risk:      评估待执行命令的风险等级
- decision:  基于历史案例 + 决策树推荐修改方案
- confidence: 评估代码修改方案的可信度（D-S + PCR5）

设计：
- 不直接调用 LLM 生成代码（避免幻觉），而是基于工具返回结果给出建议
- 实际文件操作由 Rust 侧执行（Agent 只生成指令，前端展示 diff）
- 重写 select_tool：根据 task 关键词选择 risk / decision / confidence
- 重写 plan_task：编码任务通常拆解为 2-3 步（读 → 改 → 验证）

T-P2-07 side-git 影子仓库集成（DEC-V321-02）：
- Agent 调用 Edit/Write 工具前自动 stash（通过 Rust 命令 side_git_stash）
- Agent 调用 Edit/Write 工具后自动 commit（通过 Rust 命令 side_git_commit）
- 工具失败时自动 rollback（通过 Rust 命令 side_git_rollback）
- 集成方式：本 Agent 在 select_tool 返回 Edit/Write 类任务时，
  通过 event_bus 推送 side_git.* 事件，由 main.py 转发到 Rust 侧
  （Python → Rust 仅支持 notification，无法直接 invoke Tauri 命令）
- 实际 side_git 操作由 Rust 端 Tauri 命令完成（前端可直接 invoke 调用）
"""

from __future__ import annotations

import logging
import time
from typing import Any

from agents.base import BaseAgent

logger = logging.getLogger("sidecar.agents.coding")


# ============================================================================
# T-P2-07: side-git 影子仓库 hook 触发条件
# ============================================================================

# Edit/Write 类工具名（触发 side_git hook 的工具集）
# 注：这些工具实际由 Rust 侧执行，Python 仅触发 hook 事件
SIDE_GIT_TRIGGER_TOOLS = {"edit", "write", "patch", "delete", "move"}

# side_git hook 事件类型（通过 event_bus 推送，由 main.py 转发到 Rust）
SIDE_GIT_EVENT_STASH = "side_git.stash"
SIDE_GIT_EVENT_COMMIT = "side_git.commit"
SIDE_GIT_EVENT_ROLLBACK = "side_git.rollback"


class CodingAgent(BaseAgent):
    """Coding Agent — 代码生成 + 修改

    场景示例：
        用户输入："修复 nginx.conf 的语法错误"
        主 Agent 路由到 Coding Agent
        Coding Agent:
          1. plan: ["定位 nginx.conf 路径", "调用 decision 评估修复方案", "生成修改指令"]
          2. act: 调用 risk tool 评估 systemctl restart 风险
          3. observe: 工具返回 L2 风险
          4. reflect: 任务完成，next_step=done

    T-P2-07 side-git 集成：
        Agent 在 select_tool 返回 Edit/Write 类工具时，自动触发 side_git hook：
        - pre_edit_hook:  推送 side_git.stash 事件（Rust 端执行 side_git_stash）
        - post_edit_hook: 推送 side_git.commit 事件（Rust 端执行 side_git_commit）
        - failed_edit_hook: 推送 side_git.rollback 事件（Rust 端执行 side_git_rollback）
    """

    def __init__(self, event_bus: Any = None, llm_call: Any = None) -> None:
        super().__init__(
            name="coding",
            role="代码生成与修改 Agent",
            description=(
                "负责代码生成、修改、修复语法错误等编码任务。"
                "通过 risk tool 评估命令风险，通过 decision tool 选择最佳修改方案，"
                "通过 confidence tool 评估方案可信度。"
                "实际文件操作由 Rust 侧执行，本 Agent 只生成修改指令。"
                "T-P2-07: Agent 修改文件前后自动触发 side-git 影子仓库 hook。"
            ),
            tools=["risk", "decision", "confidence"],
            event_bus=event_bus,
            llm_call=llm_call,
        )

    # ========================================================================
    # 钩子方法重写
    # ========================================================================

    def build_system_prompt_base(self) -> str:
        """Coding Agent 专属 system prompt"""
        return (
            "You are Coding Agent for the TDSF Terminal Assistant.\n"
            "Your responsibility is code generation, modification, and syntax error fixing.\n\n"
            "Capabilities:\n"
            "- Evaluate command risk via `risk` tool before executing any modification.\n"
            "- Select the best modification plan via `decision` tool (with historical cases).\n"
            "- Evaluate plan credibility via `confidence` tool (D-S + PCR5 evidence fusion).\n\n"
            "Constraints:\n"
            "- NEVER execute file operations directly. Generate modification instructions only.\n"
            "- ALWAYS call `risk` tool before recommending any `sudo` / `systemctl` / `rm` commands.\n"
            "- Prefer minimal-diff fixes over rewrites.\n"
            "- Output format: structured plan with risk evaluation + recommended commands.\n"
        )

    def plan_task(self, user_input: str, state: dict[str, Any]) -> list[str]:
        """编码任务规划：读 → 评估 → 修改 → 验证

        根据输入关键词识别任务复杂度，返回 2-4 步计划。
        """
        input_lower = user_input.lower()

        # 修复类任务：评估 → 修复 → 验证
        if any(kw in user_input for kw in ["修复", "改正", "fix", "修复错误"]) or \
           any(kw in input_lower for kw in ["fix", "repair", "correct"]):
            return [
                f"评估 {user_input[:60]} 的风险等级",
                "调用 decision 工具基于历史案例选择修复方案",
                "生成最小 diff 修改指令",
            ]

        # 生成类任务：评估 → 生成 → 验证
        if any(kw in user_input for kw in ["生成", "创建", "写", "实现"]) or \
           any(kw in input_lower for kw in ["generate", "create", "write", "implement"]):
            return [
                f"评估生成任务上下文: {user_input[:60]}",
                "调用 decision 工具选择实现方案",
                "生成代码 + 评估可信度",
            ]

        # 修改类任务：风险 → 修改
        if any(kw in user_input for kw in ["修改", "编辑", "更新"]) or \
           any(kw in input_lower for kw in ["modify", "edit", "update"]):
            return [
                "调用 risk 工具评估修改命令风险",
                "调用 decision 工具选择修改方案",
            ]

        # 默认：单步评估
        return [f"评估编码任务: {user_input}"]

    def select_tool(self, task: str, state: dict[str, Any]) -> dict[str, Any]:
        """根据任务关键词选择工具

        选择逻辑：
        - 任务含"风险" / "risk" → risk tool（评估 command 风险）
        - 任务含"方案" / "决策" / "decision" → decision tool（选择修改方案）
        - 任务含"可信度" / "confidence" → confidence tool（评估方案可信度）
        - 默认 → decision tool（编码任务默认调用决策）
        """
        task_lower = task.lower()

        # 提取命令（从 task 中提取引号内容或最后一段）
        command = self._extract_command(task, state)

        if "风险" in task or "risk" in task_lower:
            return {
                "tool_name": "risk",
                "params": {
                    "command": command,
                    "context": {"agent": "coding", "task": task},
                },
            }

        if "方案" in task or "决策" in task or "decision" in task_lower:
            return {
                "tool_name": "decision",
                "params": {
                    "input": task,
                    "command": command,
                    "context": {"agent": "coding"},
                },
            }

        if "可信度" in task or "confidence" in task_lower:
            return {
                "tool_name": "confidence",
                "params": {
                    "sources": [{"source": "coding_agent", "value": 0.8}],
                    "context": {"agent": "coding"},
                },
            }

        # 默认：调用 decision tool
        return {
            "tool_name": "decision",
            "params": {
                "input": task,
                "command": command,
                "context": {"agent": "coding"},
            },
        }

    def format_observation(
        self,
        tool_result: dict[str, Any],
        state: dict[str, Any],
    ) -> str:
        """格式化观察结果：突出风险等级 + 决策建议"""
        if not tool_result or not tool_result.get("success", True):
            return f"工具调用失败: {tool_result.get('error', 'unknown error')}"

        tool_name = tool_result.get("tool_name", "unknown")
        result = tool_result.get("result", {})

        if tool_name == "risk":
            level = result.get("level", "unknown")
            reason = result.get("reason", "")
            require_approval = result.get("require_approval", False)
            return (
                f"风险评估: 等级={level}, 原因={reason}, "
                f"需审批={require_approval}"
            )

        if tool_name == "decision":
            decision = result.get("decision", "unknown")
            alternatives = result.get("alternatives", [])
            reasoning = result.get("reasoning", "")
            return (
                f"决策建议: {decision}, 备选={alternatives}, "
                f"理由={reasoning}"
            )

        if tool_name == "confidence":
            score = result.get("score", 0.0)
            method = result.get("method", "")
            return f"可信度: {score:.2f} (方法={method})"

        return f"工具 {tool_name} 完成: {result}"

    # ========================================================================
    # 辅助方法
    # ========================================================================

    def _extract_command(self, task: str, state: dict[str, Any]) -> str:
        """从任务描述中提取待评估的命令

        优先级：
        1. state.tool_call_request.params.command（已有命令）
        2. task 中引号包裹的内容
        3. task 原文
        """
        # 从已有 state 提取
        existing = state.get("tool_call_request", {}).get("params", {}).get("command")
        if existing:
            return existing

        # 从 task 提取引号内容
        for quote_char in ['"', "'", "`"]:
            start = task.find(quote_char)
            if start != -1:
                end = task.find(quote_char, start + 1)
                if end != -1:
                    return task[start + 1:end]

        # 从 state.input 提取
        return state.get("input", task)

    # ========================================================================
    # T-P2-07: side-git 影子仓库 hook 方法
    # ============================================================================
    #
    # 设计说明:
    #   - 这三个 hook 方法通过 event_bus 推送 side_git.* 事件
    #   - main.py 的事件订阅器监听这些事件,通过 send_notification 转发到 Rust 侧
    #   - Rust 侧 sidecar.rs 的 reader_task 接收 notification 后,
    #     通过 Tauri event emit 到前端 (事件名: sidecar:side_git.stash 等)
    #   - 前端监听事件后,调用 invoke('side_git_stash' / 'side_git_commit' /
    #     'side_git_rollback') 执行实际 side_git 操作
    #
    #   或者更直接的集成方式:
    #   - 前端在调用 Edit/Write 工具前后,直接 invoke('side_git_stash' /
    #     'side_git_commit' / 'side_git_rollback') 调用 Rust 命令
    #   - 本 Agent 的 hook 方法仅作为通知机制,记录变更意图
    #
    # 触发时机:
    #   - pre_edit_hook:  Agent 调用 Edit/Write 工具前 (保存修改前状态)
    #   - post_edit_hook: Agent 调用 Edit/Write 工具后 (保存修改后状态)
    #   - failed_edit_hook: Agent 工具调用失败时 (回滚到修改前状态)
    # ========================================================================

    def pre_edit_hook(self, path: str, action: str = "edit") -> None:
        """Agent 修改文件前 hook: 触发 side_git stash

        通过 event_bus 推送 side_git.stash 事件,Rust 侧执行 side_git_stash 命令,
        将当前项目状态保存到影子仓库 (~/.tdsf/side-git/<hash>/)。

        Args:
            path: 项目根目录绝对路径
            action: 操作类型 (edit / write / patch / delete / move)
        """
        logger.info(
            f"[side-git] pre_edit_hook triggered: path={path}, action={action}"
        )
        self._emit_side_git_event(SIDE_GIT_EVENT_STASH, {
            "path": path,
            "action": action,
            "phase": "pre",
            "timestamp": time.time(),
        })

    def post_edit_hook(
        self,
        path: str,
        message: str,
        commit_hash: str | None = None,
    ) -> None:
        """Agent 修改文件后 hook: 触发 side_git commit

        通过 event_bus 推送 side_git.commit 事件,Rust 侧执行 side_git_commit 命令,
        将修改后状态保存到影子仓库,返回 commit hash。

        Args:
            path: 项目根目录绝对路径
            message: commit 消息 (如 "edit: nginx.conf")
            commit_hash: 实际 commit hash (由 Rust 侧填充,Python 侧仅记录)
        """
        logger.info(
            f"[side-git] post_edit_hook triggered: path={path}, "
            f"message={message}, commit={commit_hash}"
        )
        self._emit_side_git_event(SIDE_GIT_EVENT_COMMIT, {
            "path": path,
            "message": message,
            "commit": commit_hash,
            "phase": "post",
            "timestamp": time.time(),
        })

    def failed_edit_hook(self, path: str, error: str = "") -> None:
        """Agent 工具调用失败 hook: 触发 side_git rollback

        通过 event_bus 推送 side_git.rollback 事件,Rust 侧执行 side_git_rollback
        命令,将项目状态回滚到上一个 commit (修改前状态)。

        Args:
            path: 项目根目录绝对路径
            error: 失败原因 (用于日志记录)
        """
        logger.warning(
            f"[side-git] failed_edit_hook triggered: path={path}, error={error}"
        )
        self._emit_side_git_event(SIDE_GIT_EVENT_ROLLBACK, {
            "path": path,
            "error": error,
            "phase": "failed",
            "timestamp": time.time(),
        })

    def _emit_side_git_event(self, event_type: str, payload: dict[str, Any]) -> None:
        """推送 side_git 事件到 event_bus

        如果 event_bus 未配置 (如离线测试),仅记录日志,不报错。

        Args:
            event_type: 事件类型 (side_git.stash / side_git.commit / side_git.rollback)
            payload: 事件载荷 (含 path / action / message / commit 等)
        """
        if self.event_bus is None:
            logger.debug(
                f"[side-git] event_bus not configured, skip event: {event_type}"
            )
            return

        try:
            from event_bus import Event, EventType
            self.event_bus.publish(Event(
                event_type=event_type,
                payload=payload,
                source="coding_agent",
            ))
        except Exception as e:
            logger.debug(f"[side-git] emit side_git event failed: {e}")

    # ========================================================================
    # T-P2-07: 重写 call_tool 集成 side_git hook
    # ========================================================================

    def call_tool(self, name: str, params: dict[str, Any]) -> dict[str, Any]:
        """重写 call_tool: 对 Edit/Write 类工具调用集成 side_git hook

        流程:
        1. 如果工具名在 SIDE_GIT_TRIGGER_TOOLS 中:
           a. pre_edit_hook: 推送 side_git.stash 事件
           b. 调用原 call_tool (执行实际工具)
           c. 成功: post_edit_hook 推送 side_git.commit 事件
           d. 失败: failed_edit_hook 推送 side_git.rollback 事件
        2. 否则: 直接调用原 call_tool (不触发 hook)

        注: 当前 CodingAgent 的 tools 是 [risk, decision, confidence],
            不包含 Edit/Write 类工具,所以 hook 不会被触发。
            此重写为未来 P3 阶段扩展 Edit/Write 工具预留接口。
        """
        # 非 Edit/Write 类工具,直接调用父类方法
        if name.lower() not in SIDE_GIT_TRIGGER_TOOLS:
            return super().call_tool(name, params)

        # Edit/Write 类工具: 触发 side_git hook
        project_path = params.get("path") or params.get("project_path") or ""
        action = name.lower()

        # 1. pre_edit_hook: 触发 side_git stash
        if project_path:
            try:
                self.pre_edit_hook(project_path, action)
            except Exception as e:
                logger.warning(f"[side-git] pre_edit_hook failed: {e}")

        # 2. 调用原 call_tool (执行实际工具)
        result = super().call_tool(name, params)

        # 3. 根据结果触发 post_edit_hook 或 failed_edit_hook
        if project_path:
            try:
                if result.get("success", False):
                    # 成功: 触发 side_git commit
                    message = f"{action}: {params.get('file', params.get('path', 'unknown'))}"
                    self.post_edit_hook(project_path, message)
                else:
                    # 失败: 触发 side_git rollback
                    error = result.get("error", "unknown error")
                    self.failed_edit_hook(project_path, error)
            except Exception as e:
                logger.warning(f"[side-git] post/failed hook failed: {e}")

        return result
