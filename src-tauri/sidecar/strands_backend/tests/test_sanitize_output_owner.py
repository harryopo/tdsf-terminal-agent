"""#155 安全复查：ToolPolicy.sanitize_output 必须有主人。

判据来源（2026-09-26 推送前安全复查）：`registry.py` 从写下这天起在 7 个工具上声明
`sanitize_output=True`，注释还写着"返回体含不可信文本，需经 redact_sensitive 脱敏"——
但全仓除了 `registry.py` 自己，**没有任何一处读这个字段**。于是声明了要脱敏的
`read_remote_file` 把文件内容原样交给模型（`remote_file.py` 返回 `"content": content`，
且它不走那条会脱敏的 `execute_via_ssh`），`python_run` 更狠：读文件在
`python_risk` 里算 L0 免审批，`print(open(...).read())` 不打扰任何人地跑掉，
stdout 又不过脱敏 ⇒ 本机 `~/.ssh/id_rsa` 或应用的 `llm_config.json`（里面有明文
API key）能原样进模型。

这是 #142/#114 同一类病：**实现了但没接上**，只能靠行为判据 + 接线断言一起钉。
按 #72 的教训，注册表用真 `TOOL_REGISTRY`，不用假字典。
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

ADAPTER_SRC = Path(__file__).resolve().parents[1] / "adapter.py"

SECRET = "sk-proj-abcdefghijklmnopqrstuvwxyz012345"


def _tool_result(payload: dict) -> dict:
    """复现 strands 实测形状：无 content 键的返回值被 JSON 序列化进文本块。"""
    return {
        "status": "success",
        "content": [{"text": json.dumps(payload, ensure_ascii=False)}],
    }


def _sanitize(name: str, result: dict) -> None:
    # 承载 after_tool_call 的类是 ToolCallLimitHook（loop_progress / 证据都从这里出），
    # 不是 StrandsAgentAdapter —— 名字像不代表接的是它，写错会测到一个不存在的入口。
    from strands_backend.adapter import ToolCallLimitHook

    ToolCallLimitHook._sanitize_tool_result(name, result)


def test_read_remote_file_content_is_redacted_before_the_model_sees_it() -> None:
    from strands_backend.tools.registry import TOOL_REGISTRY

    assert TOOL_REGISTRY["read_remote_file"].policy.sanitize_output is True

    result = _tool_result(
        {"status": "success", "path": "/root/.openclaw/config.json", "content": f"token: {SECRET}"}
    )
    _sanitize("read_remote_file", result)

    text = result["content"][0]["text"]
    assert SECRET not in text
    assert "<REDACTED" in text
    # 正向配对：只吃掉密钥，不吞整条结果（路径与 status 必须还在，模型要知道读了哪个文件）
    assert "/root/.openclaw/config.json" in text
    assert json.loads(text)["status"] == "success"


def test_python_run_stdout_is_redacted_and_declares_it() -> None:
    """#155 的主案发现场：python_run 读文件算 L0 免审批，输出必须过脱敏这一关。"""
    from strands_backend.tools.registry import TOOL_REGISTRY

    assert TOOL_REGISTRY["python_run"].policy.sanitize_output is True, (
        "python_run 的 stdout 是不可信文本（能 open 任何本机文件），必须声明脱敏"
    )

    result = _tool_result({"status": "success", "exit_code": 0, "stdout": f"loaded {SECRET} ok"})
    _sanitize("python_run", result)
    assert SECRET not in result["content"][0]["text"]


def test_tools_without_the_declaration_are_left_untouched() -> None:
    """负向配对：没声明 sanitize_output 的工具不许被顺手改写（判据按声明，不按猜）。"""
    from strands_backend.tools.registry import TOOL_REGISTRY

    assert TOOL_REGISTRY["ask_user"].policy.sanitize_output is False

    result = _tool_result({"status": "success", "answer": f"用户答：{SECRET}"})
    _sanitize("ask_user", result)
    assert SECRET in result["content"][0]["text"]


def test_json_blocks_are_redacted_too() -> None:
    """内容块可能是 {"json": {...}} 形态，递归也要覆盖到。"""
    result = {
        "status": "success",
        "content": [{"json": {"rows": [{"line": f"PASSWORD={SECRET}"}]}}],
    }
    _sanitize("read_remote_file", result)
    blob = json.dumps(result["content"][0]["json"])
    assert SECRET not in blob
    assert "rows" in blob


def test_the_hook_that_sanitizes_is_the_one_strands_appends_to_history() -> None:
    """接线断言：脱敏必须发生在 after_tool_call 里，且那里就是框架写进历史的那一步。

    读两侧源码：① adapter 的 `_after_tool_call` 必须调用 `_sanitize_tool_result`；
    ② strands 执行器必须把 `after_event.result`（而非 hook 之前的旧 result）
    append 进 tool_results —— 换成 `result` 这条判据就该红。
    """
    src = ADAPTER_SRC.read_text(encoding="utf-8")
    hook_body = src.split("def _after_tool_call(", 1)[1].split("\n    def ", 1)[0]
    # 只写 "_sanitize_tool_result(" 不够——传个 None 进去也算接了（真变异试过）。
    # 判据要钉住"脱敏的对象就是 event.result"。
    assert re.search(
        r"_sanitize_tool_result\(\s*name,\s*getattr\(\s*event,\s*[\"']result[\"']",
        hook_body,
    ), "_after_tool_call 必须拿 event.result 去脱敏（接错对象 = 等于没接，#142 同一课）"

    import strands.tools.executors._executor as executor

    exec_src = Path(executor.__file__).read_text(encoding="utf-8")
    assert "tool_results.append(after_event.result)" in exec_src, (
        "strands 版本变了：after_tool_call 里改的结果不再进会话历史，本判据的前提失效"
    )


def test_the_owner_uses_the_frontend_aligned_pattern_set() -> None:
    """脱敏规则只认 `_redact.redact_sensitive_text`（与前端 redact.ts 语义对齐那一套）。

    `tools/__init__.py` 里另有一套 `_SENSITIVE_PATTERNS`，它不认裸的 sk-/JWT/GitHub
    token 形状；主人若改用那一套，本判据红（三套正则漂移记 #157，收敛前先把主人钉住）。
    """
    src = ADAPTER_SRC.read_text(encoding="utf-8")
    body = src.split("def _sanitize_tool_result", 1)[1]
    assert "redact_sensitive_text" in body, "_sanitize_tool_result 必须用 _redact 那一套"
    assert "from strands_backend.tools import redact_sensitive" not in body


@pytest.mark.parametrize(
    "tool_name",
    ["ssh_command", "read_remote_file", "write_remote_file", "analyze_logs",
     "get_terminal_output", "config_diff", "backup_restore", "python_run"],
)
def test_declared_tools_stay_declared(tool_name: str) -> None:
    """把"哪些工具的输出含不可信文本"钉成一张明名单：摘掉声明本判据就红。"""
    from strands_backend.tools.registry import TOOL_REGISTRY

    assert TOOL_REGISTRY[tool_name].policy.sanitize_output is True
