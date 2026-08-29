"""session_memory_tool — save_skill 工具（方案书 v3.0 T14，2026-08-28）

把会话中的经验/排障过程沉淀为 SKILL.md 技能包（落 ~/.tdsf/skills/<name>/SKILL.md），
随后热重载全局技能注册表——沉淀的技能无需重启即被 skill_invoke 调用。

底层复用 sidecar 根目录 session_memory.save_session_skill（与 memory.save_skill
JSON-RPC 同一实现，前端按钮与 agent 工具双入口共用）。
"""
from __future__ import annotations

import logging
from typing import Any

from strands_backend.tools import ToolContext, tool

logger = logging.getLogger("sidecar.strands_backend.tools.session_memory_tool")


def invoke_save_skill(
    params: dict[str, Any],
    ctx: ToolContext,
) -> dict[str, Any]:
    """沉淀技能包（供工具与单测共用）"""
    import sys
    import os

    sidecar_root = os.path.dirname(
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(__file__))))
    )
    if sidecar_root not in sys.path:
        sys.path.insert(0, sidecar_root)

    from session_memory import save_session_skill

    return save_session_skill(
        name=str(params.get("name", "")),
        description=str(params.get("description", "")),
        content=str(params.get("content", "")),
        triggers=params.get("triggers"),
        allowed_tools=params.get("allowed_tools"),
    )


def make_save_skill_tool(ctx: ToolContext):
    """构建 save_skill 工具"""

    @tool
    def save_skill(
        name: str,
        description: str,
        content: str,
        triggers: list[str] | None = None,
        allowed_tools: list[str] | None = None,
    ) -> dict:
        """把本次会话沉淀的经验/排障过程保存为可复用的技能包。

        当用户说"把这个过程记下来/沉淀为技能/下次自动这么做"时调用。
        技能包保存到用户技能目录并立即生效（无需重启），之后可通过
        skill_invoke 检索和调用。

        Args:
            name (str): 技能名，小写字母/数字/连字符（如 nginx-502-troubleshoot）。
            description (str): 一句话描述（说明这个技能做什么、什么时候用）。
            content (str): 技能正文 Markdown（步骤/命令/注意事项，命令保留原样）。
            triggers (list[str], 可选): 触发词列表，帮助未来检索命中。
            allowed_tools (list[str], 可选): 执行此技能允许使用的工具白名单。

        Returns:
            dict: {ok, skill_name, path, reloaded} 或 {ok: False, error}
        """
        return invoke_save_skill(
            {
                "name": name,
                "description": description,
                "content": content,
                "triggers": triggers,
                "allowed_tools": allowed_tools,
            },
            ctx,
        )

    save_skill.__name__ = "save_skill"
    return save_skill
