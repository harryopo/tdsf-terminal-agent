"""#113④（2026-09-23）：`ssh_command` 的 schema 里不许有没人读的参数。

`visible (bool)` 曾长期挂在 schema 上并写着"是否注入前端终端"，但全仓没有任何地方读
`params["visible"]` —— 走哪条通道由用户偏好 `agentExecutionChannel` 决定
（`chatRuntime.ts` 下发 → `ToolContext.execution_channel` → `execute_via_ssh` 分流）。
后果不是"多了个废字段"而已：模型会以为自己能选通道，而它选的那一路压根不存在，
排查"为什么命令没出现在终端"时会被这句话一路带偏。

按既有约定（注册/装饰/schema 这类由框架裁决的环节必须用**真** SDK registry 测），
这里钉的是模型实际看到的形状。
"""
from __future__ import annotations

import json
from unittest.mock import MagicMock

import pytest

from strands_backend.tools.ssh_command import make_ssh_command_tool

try:
    from strands.tools.registry import ToolRegistry

    _STRANDS_AVAILABLE = True
except Exception:  # pragma: no cover - 缺依赖时整文件跳过，不误报绿
    _STRANDS_AVAILABLE = False

pytestmark = pytest.mark.skipif(
    not _STRANDS_AVAILABLE, reason="strands-agents 未安装，跳过 schema 回归"
)

#: 模型实际能传的 ssh_command 参数（新增必须同时接通实现，否则本用例红）
EXPECTED_PARAMS = {"command", "ssh_session_id", "explanation", "timeout"}


def _model_visible_schema() -> dict:
    registry = ToolRegistry()
    registry.process_tools([make_ssh_command_tool(MagicMock())])
    spec = registry.registry["ssh_command"].tool_spec
    return spec["inputSchema"]["json"]


def test_ssh_command_exposes_exactly_the_parameters_the_implementation_reads():
    schema = _model_visible_schema()
    assert set(schema["properties"]) == EXPECTED_PARAMS
    assert schema["required"] == ["command"]


def test_dead_visible_parameter_is_gone_from_the_model_contract():
    """`visible` 是 #113④ 删掉的死参数；它回到 schema 就等于回到"模型能选通道"的假承诺。"""
    schema = _model_visible_schema()
    assert "visible" not in schema["properties"]
    assert "visible" not in json.dumps(schema, ensure_ascii=False)


def test_tool_description_does_not_promise_a_visibility_switch():
    """描述里也不许留"可以选可见执行"这类话说给模型。"""
    registry = ToolRegistry()
    registry.process_tools([make_ssh_command_tool(MagicMock())])
    text = registry.registry["ssh_command"].tool_spec["description"]
    assert "visible" not in text


# ============================================================================
# 用户 2026-09-24：「ssh 图标旁边不要显示命令，显示这次调用是干什么用的，
# 比如 ip a → 查看 ip；展开才看详细命令」。范围他定的是先只做 SSH。
# explanation 这个入参早就存在（今天三个会话 26/26 都填了），缺的是
# **说明书没告诉模型它是卡片标题上那句用途** —— 于是它写成整句解释或干脆不写。
# 这里钉的是模型实际看到的文本（真 registry，同上）。
# ============================================================================
def test_explanation_is_described_as_the_card_title_purpose():
    text = json.dumps(_model_visible_schema(), ensure_ascii=False)
    assert "折叠" in text and "标题" in text, (
        "explanation 的说明没告诉模型：这句会显示在工具卡折叠行的标题上"
    )
    assert "10 个字" in text, "没有长度约束 ⇒ 模型会写成整段解释，标题放不下"
    assert "查看 IP" in text, "没有例子 ⇒ 「短动词短语」这个形状说不清"


def test_explanation_stays_optional():
    """把它改成必填是另一个决定，而且是个坏决定：模型漏填会让**整次工具调用**
    在参数校验阶段失败 —— 宁可标题回落到命令原文，也不能为了界面好看弄挂执行通道。"""
    assert _model_visible_schema()["required"] == ["command"]
