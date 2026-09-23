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
