"""
agents/teach_agent.py — Teach Agent（T-P1-11.5）
==================================================

职责（spec DEC-V321-③，用户决策③核心差异化 Agent）：
- Linux 运维教学讲解（贴合教学场景，深信院计算机应用专业）
- 调用 ground tool 检索知识库（Linux 命令文档 / 教学案例）
- 调用 credibility tool 评估检索结果可信度
- 通过 LLM 生成结构化教学内容：
  - 教程（步骤 + 命令 + 解释）
  - 知识卡（关键概念 + 示例 + 易错点）
  - 学习路径（前置知识 + 进阶主题）

工具集：
- ground:      知识库检索（Linux 命令文档 + 教学案例）
- credibility: 检索结果可信度评估
- confidence:  教学内容置信度评估

设计：
- 这是唯一需要 LLM 生成最终输出的子 Agent（其他 Agent 只返回工具结果）
- LLM 未配置时使用规则化教学模板（基于命令名生成基础教程）
- 重写 invoke()：在 BaseAgent.invoke() 基础上增加 LLM 教学内容生成
- 输出格式：Markdown 结构化文本（教程 + 知识卡 + 学习路径）

场景示例：
    用户输入："解释 nginx systemctl 命令"
    主 Agent 路由到 Teach Agent
    Teach Agent:
      1. plan: ["调用 ground 检索 nginx systemctl 文档", "生成结构化教程"]
      2. act: 调用 ground tool
      3. observe: 找到 5 条相关文档
      4. reflect: 调用 LLM 生成教程 + 知识卡 + 学习路径
"""

from __future__ import annotations

import json
import logging
from typing import Any

from agents.base import BaseAgent

logger = logging.getLogger("sidecar.agents.teach")


class TeachAgent(BaseAgent):
    """Teach Agent — Linux 运维教学讲解

    核心差异化 Agent，专为深信院 Linux 运维教学场景设计。
    输出结构化教学内容：教程 + 知识卡 + 学习路径。
    """

    def __init__(self, event_bus: Any = None, llm_call: Any = None) -> None:
        super().__init__(
            name="teach",
            role="Linux 运维教学讲解 Agent",
            description=(
                "负责 Linux 运维教学讲解，生成结构化教程、知识卡、学习路径。"
                "通过 ground tool 检索知识库（命令文档 + 教学案例），"
                "通过 credibility tool 评估检索结果可信度，"
                "通过 LLM 生成贴合教学场景的讲解内容。"
                "专为深信院计算机应用专业 Linux 课程设计。"
            ),
            tools=["ground", "credibility", "confidence"],
            event_bus=event_bus,
            llm_call=llm_call,
        )

    # ========================================================================
    # 钩子方法重写
    # ========================================================================

    def build_system_prompt_base(self) -> str:
        """Teach Agent 专属 system prompt（教学场景定制）"""
        return (
            "You are Teach Agent for the TDSF Terminal Assistant.\n"
            "Your responsibility is Linux operations teaching, generating structured tutorials.\n\n"
            "Target audience: sophomore students majoring in Computer Application at\n"
            "Shenzhen Institute of Information Technology (深信院).\n\n"
            "Capabilities:\n"
            "- Retrieve knowledge via `ground` tool (Linux command docs + teaching cases).\n"
            "- Evaluate retrieval credibility via `credibility` tool.\n"
            "- Generate structured teaching content via LLM:\n"
            "  * Tutorial (steps + commands + explanations)\n"
            "  * Knowledge card (key concepts + examples + common pitfalls)\n"
            "  * Learning path (prerequisites + advanced topics)\n\n"
            "Output format (Markdown):\n"
            "## 教程\n[step-by-step with commands and explanations]\n\n"
            "## 知识卡\n- 关键概念: ...\n- 示例: ...\n- 易错点: ...\n\n"
            "## 学习路径\n- 前置知识: ...\n- 进阶主题: ...\n\n"
            "Constraints:\n"
            "- Use Chinese as primary language (target audience is Chinese students).\n"
            "- Mark CET-4 vocabulary with English translation in parentheses.\n"
            "- Provide English term translation module for technical terms.\n"
            "- Include practical examples for each concept.\n"
            "- Highlight common pitfalls and exam points (考点).\n"
        )

    def plan_task(self, user_input: str, state: dict[str, Any]) -> list[str]:
        """教学任务规划：检索 → 评估 → 生成

        教学任务通常拆解为 3 步：
        1. 检索相关知识（ground tool）
        2. 评估检索结果可信度（credibility tool）
        3. 生成结构化教学内容（LLM）

        路由优先级：
        1. 命令教学（同时含"命令"和"教学"）→ 2 步
        2. 复杂教学（解释/讲解/什么是）→ 3 步
        3. 默认 → 2 步
        """
        input_lower = user_input.lower()

        # 命令教学（同时含"命令"和"教学"/"讲解"）：检索 + 生成
        has_command = "命令" in user_input or "command" in input_lower
        has_teach_kw = any(kw in user_input for kw in ["教学", "讲解", "解释", "什么是"])
        if has_command and has_teach_kw:
            return [
                f"调用 ground 检索命令文档: {user_input[:60]}",
                "生成命令教学讲解",
            ]

        # 复杂教学：检索 + 评估 + 生成
        if any(kw in user_input for kw in ["解释", "讲解", "教学", "什么是", "怎么用"]) or \
           any(kw in input_lower for kw in ["explain", "teach", "what is", "how to"]):
            return [
                f"调用 ground 检索: {user_input[:60]}",
                "评估检索结果可信度",
                "生成结构化教程 + 知识卡 + 学习路径",
            ]

        # 默认：单步检索 + 生成
        return [
            f"调用 ground 检索: {user_input}",
            "生成教学讲解",
        ]

    def select_tool(self, task: str, state: dict[str, Any]) -> dict[str, Any]:
        """根据任务关键词选择工具

        选择逻辑：
        - 任务含"可信度" / "credibility" → credibility tool
        - 任务含"可信度" / "confidence" → confidence tool
        - 默认 → ground tool（教学任务默认检索知识库）
        """
        task_lower = task.lower()

        # 提取查询关键词
        query = self._extract_query(task, state)

        if "可信度" in task or "credibility" in task_lower:
            return {
                "tool_name": "credibility",
                "params": {
                    "sources": [{"source": "teach_agent", "value": 0.8}],
                    "context": {"agent": "teach"},
                },
            }

        if "置信度" in task or "confidence" in task_lower:
            return {
                "tool_name": "confidence",
                "params": {
                    "sources": [{"source": "teach_agent", "value": 0.8}],
                    "context": {"agent": "teach"},
                },
            }

        # 默认：ground tool（教学任务默认检索知识库）
        return {
            "tool_name": "ground",
            "params": {
                "query": query,
                "top_k": 5,
                "context": {"agent": "teach"},
            },
        }

    def format_observation(
        self,
        tool_result: dict[str, Any],
        state: dict[str, Any],
    ) -> str:
        """格式化观察结果：突出知识检索结果"""
        if not tool_result or not tool_result.get("success", True):
            return f"工具调用失败: {tool_result.get('error', 'unknown error')}"

        tool_name = tool_result.get("tool_name", "unknown")
        result = tool_result.get("result", {})

        if tool_name == "ground":
            results = result.get("results", [])
            sources = result.get("sources", [])
            if not results:
                return "知识检索完成: 未找到相关文档"
            return (
                f"知识检索完成: 找到 {len(results)} 条文档, "
                f"来源: {sources}"
            )

        if tool_name == "credibility":
            credibility = result.get("credibility", 0.0)
            return f"可信度评估: {credibility:.2f}"

        if tool_name == "confidence":
            score = result.get("score", 0.0)
            return f"置信度评估: {score:.2f}"

        return f"工具 {tool_name} 完成: {result}"

    def reflect_on_result(self, state: dict[str, Any]) -> dict[str, Any]:
        """Teach Agent 反思：在最后一步生成教学内容"""
        plan = state.get("plan", [])
        current_idx = state.get("current_task_index", 0)

        # 所有任务完成
        if not plan or current_idx >= len(plan) - 1:
            # 在最后一步生成教学内容
            teaching_content = self._generate_teaching_content(state)
            return {
                "next_step": "done",
                "reflection": f"教学讲解完成（agent={self.name}）",
                "teaching_content": teaching_content,
            }

        return {
            "next_step": "continue",
            "reflection": f"任务 {current_idx + 1}/{len(plan)} 完成，继续",
        }

    # ========================================================================
    # 教学内容生成（核心差异化能力）
    # ========================================================================

    def _generate_teaching_content(self, state: dict[str, Any]) -> str:
        """生成结构化教学内容（教程 + 知识卡 + 学习路径）

        流程：
        1. 从 intermediate_results 提取 ground tool 检索结果
        2. 构建 LLM 消息（system prompt + 检索结果 + 用户输入）
        3. 调用 LLM 生成教学内容
        4. LLM 不可用时使用规则化模板

        Args:
            state: AgentState（含 intermediate_results / input）

        Returns:
            Markdown 格式的教学内容字符串
        """
        user_input = state.get("input", "")
        intermediate = state.get("intermediate_results", [])

        # 提取 ground tool 检索结果
        retrieval_context = self._extract_retrieval_context(intermediate)

        # 构建 LLM 消息
        messages = [
            {"role": "system", "content": self.build_system_prompt()},
            {"role": "user", "content": (
                f"用户问题: {user_input}\n\n"
                f"知识库检索结果:\n{retrieval_context}\n\n"
                "请生成结构化教学内容（教程 + 知识卡 + 学习路径）。"
            )},
        ]

        # 调用 LLM
        try:
            content = self.call_llm(messages)
            if content and not content.startswith("[mock-llm]"):
                return content
            # Mock LLM：使用规则化模板
            return self._mock_teaching_content(user_input, retrieval_context)
        except Exception as e:
            logger.warning(f"LLM call failed, using mock template: {e}")
            return self._mock_teaching_content(user_input, retrieval_context)

    def _extract_retrieval_context(
        self,
        intermediate_results: list[dict[str, Any]],
    ) -> str:
        """从中间结果提取 ground tool 检索结果

        Args:
            intermediate_results: PAOR 循环的中间结果列表

        Returns:
            检索结果格式化字符串（含 sources + contents）
        """
        contexts: list[str] = []
        for item in intermediate_results:
            result = item.get("result", {})
            tool_result = result.get("result", {}) if isinstance(result, dict) else {}
            if result.get("tool_name") == "ground" or "results" in tool_result:
                results = tool_result.get("results", [])
                for i, r in enumerate(results, 1):
                    content = r.get("content", "")
                    source = r.get("source", "unknown")
                    contexts.append(f"[{i}] (source: {source})\n{content}")

        if not contexts:
            return "(无知识库检索结果)"

        return "\n\n".join(contexts)

    def _mock_teaching_content(
        self,
        user_input: str,
        retrieval_context: str,
    ) -> str:
        """Mock 教学内容生成（LLM 不可用时的回退）

        基于规则生成基础教学模板：
        - 提取命令名（如 nginx / systemctl / ls / grep）
        - 生成基础教程（命令用途 + 基本语法）
        - 生成知识卡（关键概念 + 示例）
        - 生成学习路径（前置 + 进阶）
        """
        command = self._extract_command_name(user_input)

        return (
            f"## 教程\n\n"
            f"### {command} 命令讲解\n\n"
            f"**命令用途**: {self._mock_command_purpose(command)}\n\n"
            f"**基本语法**:\n"
            f"```\n{command} [选项] [参数]\n```\n\n"
            f"**常用选项**:\n"
            f"- `-h, --help`: 显示帮助 (show help)\n"
            f"- `-v, --version`: 显示版本 (show version)\n\n"
            f"**示例**:\n"
            f"```\n{command} --help\n```\n\n"
            f"## 知识卡\n\n"
            f"- **关键概念**: {command} 是 Linux 系统中的常用命令\n"
            f"- **示例**: `{command} --help` 查看帮助\n"
            f"- **易错点**: [考点] 注意命令大小写敏感\n\n"
            f"## 学习路径\n\n"
            f"- **前置知识**: Linux 基础命令行操作\n"
            f"- **进阶主题**: Shell 脚本编程、系统管理\n\n"
            f"---\n"
            f"*（注：当前为规则化教学模板，配置 LLM 后将生成更详细内容）*\n"
        )

    def _extract_command_name(self, text: str) -> str:
        """从用户输入中提取命令名"""
        # 常见 Linux 命令列表
        common_commands = [
            "nginx", "systemctl", "service", "journalctl",
            "ls", "cd", "pwd", "cp", "mv", "rm", "mkdir", "rmdir",
            "cat", "grep", "find", "awk", "sed",
            "chmod", "chown", "sudo", "su",
            "ps", "top", "kill", "killall",
            "ssh", "scp", "rsync",
            "iptables", "firewall-cmd", "setenforce", "getenforce",
            "mount", "umount", "df", "du",
        ]
        text_lower = text.lower()
        for cmd in common_commands:
            if cmd in text_lower:
                return cmd
        # 提取引号内容
        for quote_char in ['"', "'", "`"]:
            start = text.find(quote_char)
            if start != -1:
                end = text.find(quote_char, start + 1)
                if end != -1:
                    return text[start + 1:end]
        return text[:30]  # 截断作为命令名

    def _mock_command_purpose(self, command: str) -> str:
        """Mock 命令用途说明"""
        purposes = {
            "nginx": "Web 服务器，用于处理 HTTP 请求和反向代理",
            "systemctl": "系统服务管理工具，用于启动/停止/重启/查看服务状态",
            "service": "传统服务管理工具（兼容旧版系统）",
            "journalctl": "查询 systemd 日志",
            "ls": "列出目录内容 (list directory contents)",
            "cd": "切换工作目录 (change directory)",
            "grep": "文本搜索工具 (global regular expression print)",
            "find": "文件查找工具",
            "chmod": "修改文件权限 (change mode)",
            "chown": "修改文件所有者 (change owner)",
            "sudo": "以超级用户权限执行命令 (superuser do)",
            "ps": "查看进程状态 (process status)",
            "kill": "终止进程",
            "ssh": "远程登录工具 (secure shell)",
            "iptables": "防火墙规则管理工具",
            "setenforce": "设置 SELinux 模式",
        }
        return purposes.get(command, f"Linux 命令 `{command}`")

    # ========================================================================
    # 辅助方法
    # ========================================================================

    # _extract_query 已提升到 BaseAgent（2026-08-04 消除重复代码）
