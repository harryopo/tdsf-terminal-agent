"""The no-model degraded response should guide users to model settings."""
from __future__ import annotations

from unittest.mock import MagicMock, patch

from strands_backend.adapter import StrandsAgentAdapter


def test_missing_model_degraded_response_points_to_model_settings():
    event_bus = MagicMock()
    adapter = StrandsAgentAdapter(
        event_bus=event_bus,
        backend_enabled=True,
        strands_model=None,
    )
    adapter._strands_available = True

    with (
        patch.object(adapter, "_get_or_create_agent", wraps=adapter._get_or_create_agent) as create_agent,
        patch.object(
            adapter,
            "_invoke_with_token_continuation",
            wraps=adapter._invoke_with_token_continuation,
        ) as invoke_model,
    ):
        result = adapter.invoke("main", "hello", {"session_id": "no-model"})

    hint = "当前没有可用的 AI 模型。请在「设置 → AI 模型」中配置并连接模型；若已配置，请检查连接后重试。"
    assert result["degraded"] is True
    assert result["degraded_reason"] == "strands_model_not_injected"
    assert result["next_step"] == "done"
    assert result["mood"] == "done"
    assert result["observation"].startswith("[strands-backend-degraded] ")
    assert hint in result["observation"]
    assert result["degraded_message"] == hint
    assert "P0" not in result["observation"]
    assert "model_adapter.py" not in result["observation"]
    create_agent.assert_not_called()
    invoke_model.assert_not_called()
