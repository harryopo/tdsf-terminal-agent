from __future__ import annotations

import math

import pytest

import strands_backend.model_params as model_params_module
from strands_backend.model_params import (
    ModelParameterError,
    capabilities_for,
    resolve_model_params,
)


def test_stable_default_is_low_temperature_and_preserves_provider_max_default() -> None:
    result = resolve_model_params(provider="openai", model="gpt-4o-mini")

    assert result["params"] == {"temperature": 0.1}
    assert result["requested"]["temperature"] == 0.1
    assert result["requested"]["max_tokens"] is None
    assert result["effective"]["max_tokens"] is None
    assert result["applied"]["temperature"] is True
    assert result["applied"]["max_tokens"] is False
    assert result["warnings"] == []


def test_zero_and_explicit_max_tokens_are_not_treated_as_missing() -> None:
    result = resolve_model_params(
        provider="openai", model="gpt-4o-mini", temperature=0, max_tokens=64
    )

    assert result["params"] == {"temperature": 0, "max_tokens": 64}
    assert result["effective"]["temperature"] == 0
    assert result["effective"]["max_tokens"] == 64


def test_null_temperature_is_omitted_and_anthropic_gets_application_max_default() -> None:
    openai = resolve_model_params(
        provider="openai", model="gpt-4o-mini", temperature=None, max_tokens=None
    )
    anthropic = resolve_model_params(
        provider="anthropic", model="claude-sonnet-4-6", max_tokens=None
    )

    assert "temperature" not in openai["params"]
    assert openai["applied"]["temperature"] is False
    assert anthropic["provider_config"]["max_tokens"] == 8192
    assert "max_tokens" not in anthropic["params"]
    assert anthropic["requested"]["max_tokens"] is None
    assert anthropic["effective"]["max_tokens"] == 8192
    assert anthropic["sources"]["max_tokens"] == "application_default"


@pytest.mark.parametrize("value", [True, -0.1, 2.1, "0.1", math.nan, math.inf])
def test_invalid_temperature_is_rejected(value: object) -> None:
    with pytest.raises(ModelParameterError, match="^temperature 必须是 0 到 2 的有限数值或 null$"):
        resolve_model_params(provider="openai", model="gpt-4o", temperature=value)


@pytest.mark.parametrize("value", [True, 0, -1, 1.5, "64"])
def test_invalid_max_tokens_is_rejected(value: object) -> None:
    with pytest.raises(ModelParameterError, match="^max_tokens 必须是正整数或 null$"):
        resolve_model_params(provider="openai", model="gpt-4o", max_tokens=value)


def test_reasoning_model_omits_unsupported_temperature_and_uses_output_limit_alias() -> None:
    result = resolve_model_params(
        provider="openai",
        model="gpt-5.6",
        temperature=0.1,
        max_tokens=128,
        reasoning_effort="high",
    )

    assert result["params"] == {"max_completion_tokens": 128, "reasoning_effort": "high"}
    assert result["applied"]["temperature"] is False
    assert result["warnings"] == [
        {"field": "temperature", "code": "unsupported_temperature"}
    ]


def test_unknown_compatible_endpoint_never_receives_advanced_reasoning() -> None:
    result = resolve_model_params(
        provider="openai-compatible",
        model="gpt-5.6",
        base_url="https://gateway.invalid/v1",
        thinking="on",
        reasoning_effort="high",
    )

    assert "reasoning_effort" not in result["params"]
    assert "thinking" not in result["params"]
    assert result["capabilities"]["reasoning_parameter_style"] == "unknown"
    assert result["warnings"] == [
        {"field": "temperature", "code": "unsupported_temperature"},
        {"field": "thinking", "code": "unknown_reasoning_capability"},
        {"field": "reasoning_effort", "code": "unknown_reasoning_capability"},
    ]


def test_anthropic_budget_and_adaptive_thinking_use_distinct_contracts(monkeypatch) -> None:
    monkeypatch.setattr(model_params_module, "_anthropic_adaptive_sdk_available", lambda: True)
    budget = resolve_model_params(
        provider="anthropic",
        model="claude-sonnet-4-5",
        max_tokens=4096,
        thinking="on",
    )
    adaptive = resolve_model_params(
        provider="anthropic",
        model="claude-sonnet-5",
        max_tokens=4096,
        thinking="on",
        reasoning_effort="high",
    )

    assert budget["params"]["thinking"] == {"type": "enabled", "budget_tokens": 4095}
    assert adaptive["params"]["thinking"] == {"type": "adaptive"}
    assert adaptive["params"]["output_config"] == {"effort": "high"}
    assert "budget_tokens" not in str(adaptive["params"])


def test_thinking_off_is_explicit_only_when_supported() -> None:
    supported = resolve_model_params(
        provider="anthropic", model="claude-sonnet-4-6", thinking="off"
    )
    unsupported = resolve_model_params(
        provider="openai", model="gpt-4o-mini", thinking="off"
    )

    assert supported["params"]["thinking"] == {"type": "disabled"}
    assert "thinking" not in unsupported["params"]
    assert unsupported["warnings"] == [
        {"field": "thinking", "code": "unsupported_thinking_off"}
    ]


def test_capabilities_include_protocol_model_and_endpoint_type() -> None:
    official = capabilities_for("openai", "gpt-5.6", "")
    compatible = capabilities_for("openai", "gpt-5.6", "https://proxy.invalid/v1")

    assert official["reasoning_parameter_style"] == "openai_effort"
    assert compatible["reasoning_parameter_style"] == "unknown"
    assert compatible["supported_efforts"] == []


def test_receipt_has_stable_non_secret_snapshot() -> None:
    first = resolve_model_params(provider="openai", model="gpt-4o-mini", max_tokens=64)
    second = resolve_model_params(provider="openai", model="gpt-4o-mini", max_tokens=64)

    assert first["turn_snapshot"]["configSnapshotId"] == second["turn_snapshot"]["configSnapshotId"]
    assert first["turn_snapshot"]["requestedMaxTokens"] == 64
    assert first["turn_snapshot"]["effectiveMaxTokens"] == 64
    serialized = str(first)
    assert "api_key" not in serialized
    assert "base_url" not in serialized

def test_invalid_identity_and_enums_have_complete_errors() -> None:
    with pytest.raises(ModelParameterError, match="^provider 和 model 不能为空$"):
        resolve_model_params(provider="", model="gpt-4o")
    with pytest.raises(ModelParameterError, match="^thinking 必须是 provider_default/on/off$"):
        resolve_model_params(provider="openai", model="gpt-4o", thinking="auto")
    with pytest.raises(ModelParameterError, match="^reasoning_effort 必须是 provider_default/low/medium/high$"):
        resolve_model_params(provider="openai", model="gpt-4o", reasoning_effort="max")


def test_non_reasoning_model_rejects_thinking_and_effort_without_sending() -> None:
    result = resolve_model_params(
        provider="openai", model="gpt-4o", thinking="on", reasoning_effort="high"
    )
    assert "thinking" not in result["params"]
    assert "reasoning_effort" not in result["params"]
    assert result["warnings"] == [
        {"field": "thinking", "code": "unsupported_thinking"},
        {"field": "reasoning_effort", "code": "unsupported_reasoning_effort"},
    ]


def test_openai_reasoning_on_defaults_to_medium_and_off_is_not_applied() -> None:
    enabled = resolve_model_params(provider="openai", model="gpt-5.6", thinking="on")
    disabled = resolve_model_params(provider="openai", model="gpt-5.6", thinking="off")
    assert enabled["params"]["reasoning_effort"] == "medium"
    assert enabled["applied"]["thinking"] is True
    assert "reasoning_effort" not in disabled["params"]
    assert disabled["warnings"] == [
        {"field": "temperature", "code": "unsupported_temperature"},
        {"field": "thinking", "code": "unsupported_thinking_off"},
    ]


def test_anthropic_budget_rejects_non_positive_budget() -> None:
    with pytest.raises(ModelParameterError, match="^Anthropic budget thinking 要求 max_tokens 大于 1024$"):
        resolve_model_params(
            provider="anthropic", model="claude-sonnet-4-6", max_tokens=1, thinking="on"
        )


def test_anthropic_budget_effort_is_not_silently_mapped() -> None:
    result = resolve_model_params(
        provider="anthropic", model="claude-sonnet-4-6", reasoning_effort="high"
    )
    assert "output_config" not in result["params"]
    assert result["warnings"] == [
        {"field": "reasoning_effort", "code": "unsupported_reasoning_effort"}
    ]

def test_openai_off_never_leaves_explicit_effort_in_request() -> None:
    result = resolve_model_params(
        provider="openai", model="gpt-5.6", thinking="off", reasoning_effort="high"
    )
    assert "reasoning_effort" not in result["params"]
    assert result["applied"]["reasoning_effort"] is False


def test_anthropic_off_uses_model_specific_whitelist(monkeypatch) -> None:
    monkeypatch.setattr(model_params_module, "_anthropic_adaptive_sdk_available", lambda: True)
    always_on = resolve_model_params(
        provider="anthropic", model="claude-fable-5", thinking="off"
    )
    between_tools = resolve_model_params(
        provider="anthropic", model="claude-sonnet-5.5", thinking="off"
    )
    assert "thinking" not in always_on["params"]
    assert always_on["warnings"] == [
        {"field": "thinking", "code": "unsupported_thinking_off"}
    ]
    assert between_tools["params"]["thinking"] == {"type": "between_tools"}


def test_budget_thinking_omits_custom_temperature() -> None:
    result = resolve_model_params(
        provider="anthropic",
        model="claude-sonnet-4-5",
        temperature=0.1,
        max_tokens=4096,
        thinking="on",
    )
    assert "temperature" not in result["params"]
    assert result["params"]["thinking"]["budget_tokens"] == 4095
    assert result["warnings"] == [
        {"field": "temperature", "code": "incompatible_with_budget_thinking"}
    ]
