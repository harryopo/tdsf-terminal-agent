"""Provider-aware generation parameter validation and receipts.

Only verified provider/protocol/model/endpoint combinations receive advanced
reasoning fields.  This module never sees or returns API keys and never performs
network capability probes.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import math
from typing import Any


class ModelParameterError(ValueError):
    """A generation preference is malformed and must stop configuration."""


_THINKING_VALUES = {"provider_default", "on", "off"}
_EFFORT_VALUES = {"provider_default", "low", "medium", "high"}
_OPENAI_REASONING_PREFIXES = ("gpt-5", "gpt-6", "o1", "o3", "o4")
_ANTHROPIC_ADAPTIVE_PREFIXES = (
    "claude-fable-5",
    "claude-mythos-5",
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-haiku-5",
    "claude-opus-4.6",
    "claude-sonnet-4.6",
    "claude-opus-4.7",
    "claude-sonnet-4.7",
    "claude-opus-4.8",
    "claude-sonnet-4.8",
)
_ANTHROPIC_NO_OFF_PREFIXES = (
    "claude-fable-",
    "claude-mythos-",
    "claude-opus-5.5",
)
_ANTHROPIC_BETWEEN_TOOLS_PREFIXES = ("claude-sonnet-5.5",)


def _official_openai_endpoint(provider: str, base_url: str) -> bool:
    if provider != "openai":
        return False
    normalized = base_url.strip().lower().rstrip("/")
    return not normalized or normalized in {
        "https://api.openai.com/v1",
        "https://api.openai.com",
    }


def _openai_reasoning_model(model: str) -> bool:
    return model.lower().startswith(_OPENAI_REASONING_PREFIXES)


def _anthropic_style(model: str) -> str:
    lowered = model.lower()
    if lowered.startswith(_ANTHROPIC_ADAPTIVE_PREFIXES):
        return "anthropic_adaptive"
    if lowered.startswith("claude-"):
        return "anthropic_budget"
    return "unknown"


def _anthropic_adaptive_sdk_available() -> bool:
    try:
        return bool(
            importlib.util.find_spec("anthropic.types.thinking_config_adaptive_param")
            and importlib.util.find_spec("anthropic.types.output_config_param")
        )
    except ModuleNotFoundError:
        return False


def capabilities_for(provider: str, model: str, base_url: str = "") -> dict[str, Any]:
    """Return conservative, serializable generation capabilities."""
    provider = provider.strip().lower()
    reasoning_model = _openai_reasoning_model(model)
    official_openai = _official_openai_endpoint(provider, base_url)
    anthropic_style = _anthropic_style(model) if provider == "anthropic" else "unknown"
    adaptive_sdk_unsupported = (
        anthropic_style == "anthropic_adaptive"
        and not _anthropic_adaptive_sdk_available()
    )

    if official_openai and reasoning_model:
        reasoning_style = "openai_effort"
        efforts = ["low", "medium", "high"]
        supports_off = False
    elif official_openai:
        reasoning_style = "none"
        efforts = []
        supports_off = False
    elif anthropic_style != "unknown" and not adaptive_sdk_unsupported:
        reasoning_style = anthropic_style
        efforts = ["low", "medium", "high"] if anthropic_style == "anthropic_adaptive" else []
        supports_off = not model.lower().startswith(_ANTHROPIC_NO_OFF_PREFIXES)
    else:
        reasoning_style = "unknown"
        efforts = []
        supports_off = False

    supports_temperature = not reasoning_model
    if provider == "anthropic":
        supports_temperature = True
    return {
        "supports_temperature": supports_temperature,
        "supports_max_tokens": True,
        "supports_thinking_off": supports_off,
        "thinking_off_type": (
            "between_tools"
            if model.lower().startswith(_ANTHROPIC_BETWEEN_TOOLS_PREFIXES)
            else "disabled"
        ),
        "supported_efforts": efforts,
        "reasoning_parameter_style": reasoning_style,
        "output_limit_field": (
            "max_completion_tokens"
            if official_openai and reasoning_model
            else "max_tokens"
        ),
        "endpoint_type": (
            "official"
            if official_openai or provider == "anthropic"
            else "custom_or_compatible"
        ),
        "adaptive_sdk_unsupported": adaptive_sdk_unsupported,
    }


def _validate_temperature(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ModelParameterError("temperature 必须是 0 到 2 的有限数值或 null")
    number = float(value)
    if not math.isfinite(number) or not 0 <= number <= 2:
        raise ModelParameterError("temperature 必须是 0 到 2 的有限数值或 null")
    return number


def _validate_max_tokens(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ModelParameterError("max_tokens 必须是正整数或 null")
    return value


def _warning(field: str, code: str) -> dict[str, str]:
    return {"field": field, "code": code}


def resolve_model_params(
    *,
    provider: str,
    model: str,
    base_url: str = "",
    temperature: Any = 0.1,
    max_tokens: Any = None,
    thinking: str = "provider_default",
    reasoning_effort: str = "provider_default",
) -> dict[str, Any]:
    """Validate preferences and produce provider params plus an honest receipt."""
    provider = provider.strip().lower()
    model = model.strip()
    if not provider or not model:
        raise ModelParameterError("provider 和 model 不能为空")
    if thinking not in _THINKING_VALUES:
        raise ModelParameterError("thinking 必须是 provider_default/on/off")
    if reasoning_effort not in _EFFORT_VALUES:
        raise ModelParameterError("reasoning_effort 必须是 provider_default/low/medium/high")

    requested_temperature = _validate_temperature(temperature)
    if provider == "anthropic" and requested_temperature is not None and requested_temperature > 1:
        raise ModelParameterError("Anthropic temperature 必须是 0 到 1 的有限数值或 null")
    requested_max_tokens = _validate_max_tokens(max_tokens)
    capabilities = capabilities_for(provider, model, base_url)
    style = capabilities["reasoning_parameter_style"]
    params: dict[str, Any] = {}
    applied = {
        "temperature": False,
        "max_tokens": False,
        "thinking": False,
        "reasoning_effort": False,
    }
    warnings: list[dict[str, str]] = []
    sources = {"temperature": "requested", "max_tokens": "requested"}

    if requested_temperature is not None and capabilities["supports_temperature"]:
        params["temperature"] = requested_temperature
        applied["temperature"] = True
    elif requested_temperature is not None:
        warnings.append(_warning("temperature", "unsupported_temperature"))
    elif requested_temperature is None:
        sources["temperature"] = "provider_default"

    effective_max_tokens = requested_max_tokens
    if provider == "anthropic" and effective_max_tokens is None:
        effective_max_tokens = 8192
        sources["max_tokens"] = "application_default"
    if effective_max_tokens is not None:
        if provider != "anthropic":
            params[capabilities["output_limit_field"]] = effective_max_tokens
        applied["max_tokens"] = True
    else:
        sources["max_tokens"] = "provider_default"

    effective_effort = (
        None if reasoning_effort == "provider_default" else reasoning_effort
    )
    if style == "unknown":
        reason_code = (
            "sdk_unsupported"
            if capabilities["adaptive_sdk_unsupported"]
            else "unknown_reasoning_capability"
        )
        if thinking != "provider_default":
            warnings.append(_warning("thinking", reason_code))
        if reasoning_effort != "provider_default":
            warnings.append(_warning("reasoning_effort", reason_code))
    elif style == "none":
        if thinking == "off":
            warnings.append(_warning("thinking", "unsupported_thinking_off"))
        elif thinking == "on":
            warnings.append(_warning("thinking", "unsupported_thinking"))
        if reasoning_effort != "provider_default":
            warnings.append(_warning("reasoning_effort", "unsupported_reasoning_effort"))
    elif style == "openai_effort":
        if thinking == "off":
            effective_effort = None
            warnings.append(_warning("thinking", "unsupported_thinking_off"))
            if reasoning_effort != "provider_default":
                warnings.append(_warning("reasoning_effort", "thinking_off"))
        else:
            if thinking == "on":
                effective_effort = effective_effort or "medium"
            if effective_effort is not None:
                params["reasoning_effort"] = effective_effort
                applied["reasoning_effort"] = True
                applied["thinking"] = thinking == "on"
    elif style == "anthropic_budget":
        if thinking == "on":
            if effective_max_tokens <= 1024:
                raise ModelParameterError("Anthropic budget thinking 要求 max_tokens 大于 1024")
            if requested_temperature is not None:
                params.pop("temperature", None)
                applied["temperature"] = False
                warnings.append(_warning("temperature", "incompatible_with_budget_thinking"))
        if thinking in {"on", "off"}:
            params["thinking"] = (
                {"type": "enabled", "budget_tokens": min(4096, effective_max_tokens - 1)}
                if thinking == "on"
                else {"type": "disabled"}
            )
            applied["thinking"] = True
        if reasoning_effort != "provider_default":
            warnings.append(_warning("reasoning_effort", "unsupported_reasoning_effort"))
    elif style == "anthropic_adaptive":
        if thinking == "off" and not capabilities["supports_thinking_off"]:
            effective_effort = None
            warnings.append(_warning("thinking", "unsupported_thinking_off"))
            if reasoning_effort != "provider_default":
                warnings.append(_warning("reasoning_effort", "thinking_off"))
        else:
            if thinking in {"on", "off"}:
                params["thinking"] = {
                    "type": "adaptive" if thinking == "on" else capabilities["thinking_off_type"]
                }
                applied["thinking"] = True
            if thinking == "off":
                effective_effort = None
                if reasoning_effort != "provider_default":
                    warnings.append(_warning("reasoning_effort", "thinking_off"))
            if effective_effort is not None:
                params["output_config"] = {"effort": effective_effort}
                applied["reasoning_effort"] = True

    requested = {
        "temperature": requested_temperature,
        "max_tokens": requested_max_tokens,
        "thinking": thinking,
        "reasoning_effort": reasoning_effort,
    }
    effective = {
        "temperature": params.get("temperature"),
        "max_tokens": effective_max_tokens if applied["max_tokens"] else None,
        "thinking": (
            "on"
            if style == "openai_effort" and applied["thinking"]
            else params.get("thinking")
        ),
        "reasoning_effort": effective_effort if applied["reasoning_effort"] else None,
    }
    provider_config = {"model_id": model}
    if provider == "anthropic":
        provider_config["max_tokens"] = effective_max_tokens
    snapshot_body = {
        "provider": provider,
        "base_url": base_url.strip().rstrip("/"),
        "provider_config": provider_config,
        "params": params,
        "requested": requested,
        "effective": effective,
        "applied": applied,
    }
    parameter_fingerprint = hashlib.sha256(
        json.dumps(snapshot_body, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()
    turn_snapshot = {
        "configSnapshotId": parameter_fingerprint[:24],
        "provider": provider,
        "requestedModel": model,
        "resolvedModel": model,
        "requestedMaxTokens": requested_max_tokens,
        "effectiveMaxTokens": effective["max_tokens"],
        "generation": {
            "temperature": requested_temperature,
            "thinking": thinking,
            "reasoningEffort": reasoning_effort,
        },
        "applied": applied,
    }
    return {
        "provider_config": provider_config,
        "params": params,
        "requested": requested,
        "effective": effective,
        "applied": applied,
        "sources": sources,
        "warnings": warnings,
        "capabilities": capabilities,
        "parameter_fingerprint": parameter_fingerprint,
        "turn_snapshot": turn_snapshot,
    }


__all__ = ["ModelParameterError", "capabilities_for", "resolve_model_params"]
