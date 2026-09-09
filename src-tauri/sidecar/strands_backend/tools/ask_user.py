"""让 Agent 以结构化提问卡暂停，收到用户回答后再继续。"""
from __future__ import annotations

from typing import Any

from needs_you import NeedsYouStatus, get_global_service
from strands_backend.tools import ToolContext, tool


def invoke_ask_user_tool(params: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    question = str(params.get("question") or "").strip()
    if not question:
        raise ValueError("ask_user 工具必填参数缺失: question")

    raw_options = params.get("options") or []
    if not isinstance(raw_options, list):
        raise ValueError("ask_user options 必须是字符串数组")
    options = [str(value).strip() for value in raw_options if str(value).strip()]
    if len(options) > 4:
        raise ValueError("ask_user options 最多 4 项")

    service = get_global_service()
    request = service.request_question(
        title="Agent 需要你的回答",
        description=question,
        session_id=ctx.session_id or None,
        source=f"{ctx.agent_name}_agent.strands_tool.ask_user",
        question=question,
        options=options,
        confirm_label="确认并继续",
    )
    resolved = service.wait_for_response(request.id, timeout=None)
    if resolved is None:
        return {"status": "error", "message": "提问请求不存在或已失效"}
    if resolved.status == NeedsYouStatus.CANCELLED:
        return {"status": "cancelled", "message": "用户取消了本次提问，停止后续执行"}
    if resolved.status != NeedsYouStatus.RESOLVED:
        return {"status": "waiting", "message": "仍在等待用户回答，不得继续执行"}

    response = resolved.response
    answer = response.get("answer", "") if isinstance(response, dict) else response
    return {"status": "success", "answer": str(answer or "").strip()}


def make_ask_user_tool(ctx: ToolContext):
    @tool
    def ask_user(question: str, options: list[str] | None = None) -> dict:
        """当缺少会实质改变方案的用户决定时，弹出提问卡并暂停。

        Args:
            question (str): 一条简短、具体的问题。
            options (list[str]): 2-4 个互斥选项；需要自由输入时可留空。

        Returns:
            dict: 用户确认后的 answer；返回前不得继续调用其他工具。
        """
        return invoke_ask_user_tool(
            {"question": question, "options": options or []},
            ctx,
        )

    ask_user.__name__ = "ask_user"
    return ask_user


__all__ = ["invoke_ask_user_tool", "make_ask_user_tool"]
