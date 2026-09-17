"""Tests for the provider-neutral synchronous LLM callable."""
from __future__ import annotations

import sys
import types
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

from core import llm_config
from core.llm_config import (
    LLMConfig,
    PROVIDER_DEFAULT_BASE_URLS,
    _make_anthropic_call,
    _make_openai_call,
    _resolve_base_url,
    make_llm_call,
)


class _FakeOpenAICompletions:
    def create(self, **kwargs: object) -> object:
        _FakeOpenAI.last_request_kwargs = dict(kwargs)
        if _FakeOpenAI.request_error is not None:
            raise _FakeOpenAI.request_error
        if _FakeOpenAI.empty_choices:
            return SimpleNamespace(choices=[])
        return SimpleNamespace(
            choices=[
                SimpleNamespace(
                    message=SimpleNamespace(content=_FakeOpenAI.response_content)
                )
            ]
        )


class _FakeOpenAI:
    last_init_kwargs: dict[str, object] = {}
    last_request_kwargs: dict[str, object] = {}
    response_content: object = "ok"
    request_error: Exception | None = None
    init_error: Exception | None = None
    empty_choices = False

    def __init__(self, **kwargs: object) -> None:
        if type(self).init_error is not None:
            raise type(self).init_error
        type(self).last_init_kwargs = dict(kwargs)
        self.chat = SimpleNamespace(
            completions=_FakeOpenAICompletions(),
        )


class _FakeAnthropicMessages:
    def create(self, **kwargs: object) -> object:
        _FakeAnthropic.last_request_kwargs = dict(kwargs)
        if _FakeAnthropic.request_error is not None:
            raise _FakeAnthropic.request_error
        return SimpleNamespace(content=list(_FakeAnthropic.response_blocks))


class _FakeAnthropic:
    last_init_kwargs: dict[str, object] = {}
    last_request_kwargs: dict[str, object] = {}
    response_blocks: list[object] = [
        SimpleNamespace(type="text", text="ok"),
    ]
    request_error: Exception | None = None
    init_error: Exception | None = None

    def __init__(self, **kwargs: object) -> None:
        if type(self).init_error is not None:
            raise type(self).init_error
        type(self).last_init_kwargs = dict(kwargs)
        self.messages = _FakeAnthropicMessages()


@pytest.fixture
def fake_openai(monkeypatch):
    module = types.ModuleType("openai")
    module.OpenAI = _FakeOpenAI  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "openai", module)
    monkeypatch.setattr(_FakeOpenAI, "last_init_kwargs", {})
    monkeypatch.setattr(_FakeOpenAI, "last_request_kwargs", {})
    monkeypatch.setattr(_FakeOpenAI, "response_content", "ok")
    monkeypatch.setattr(_FakeOpenAI, "request_error", None)
    monkeypatch.setattr(_FakeOpenAI, "init_error", None)
    monkeypatch.setattr(_FakeOpenAI, "empty_choices", False)
    return _FakeOpenAI


@pytest.fixture
def fake_anthropic(monkeypatch):
    module = types.ModuleType("anthropic")
    module.Anthropic = _FakeAnthropic  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "anthropic", module)
    monkeypatch.setattr(_FakeAnthropic, "last_init_kwargs", {})
    monkeypatch.setattr(_FakeAnthropic, "last_request_kwargs", {})
    monkeypatch.setattr(
        _FakeAnthropic,
        "response_blocks",
        [SimpleNamespace(type="text", text="ok")],
    )
    monkeypatch.setattr(_FakeAnthropic, "request_error", None)
    monkeypatch.setattr(_FakeAnthropic, "init_error", None)
    return _FakeAnthropic


class TestProviderDefaultBaseUrls:
    def test_mapping_contains_only_supported_fallbacks(self):
        assert set(PROVIDER_DEFAULT_BASE_URLS) == {
            "zhipu",
            "dashscope",
            "moonshot",
        }

    @pytest.mark.parametrize(
        ("provider", "expected"),
        [
            ("zhipu", "https://open.bigmodel.cn/api/paas/v4"),
            ("dashscope", "https://dashscope.aliyuncs.com/compatible-mode/v1"),
            ("moonshot", "https://api.moonshot.cn/v1"),
        ],
    )
    def test_domestic_provider_fallback(
        self, provider: str, expected: str
    ) -> None:
        config = LLMConfig(provider=provider, api_key="sk-test")
        assert _resolve_base_url(config) == expected

    def test_explicit_base_url_wins(self):
        config = LLMConfig(
            provider="zhipu",
            api_key="sk-test",
            base_url="https://proxy.example/v1",
        )
        assert _resolve_base_url(config) == "https://proxy.example/v1"

    @pytest.mark.parametrize(
        "provider", ["openai", "deepseek", "ollama", "unknown", ""]
    )
    def test_unlisted_provider_keeps_sdk_default(self, provider: str):
        config = LLMConfig(provider=provider, api_key="sk-test")
        assert _resolve_base_url(config) == ""

    def test_provider_lookup_is_case_insensitive(self):
        config = LLMConfig(provider="ZhiPu", api_key="sk-test")
        assert (
            _resolve_base_url(config)
            == "https://open.bigmodel.cn/api/paas/v4"
        )


class TestOpenAICall:
    def test_client_and_request_contract(self, fake_openai):
        config = LLMConfig(
            provider="zhipu",
            api_key="sk-test",
            model="glm-test",
            temperature=0.2,
            max_tokens=321,
        )
        call = _make_openai_call(config)
        reply = call(
            [
                {"role": "system", "content": "rules"},
                {"role": "assistant", "content": "prior"},
                {"role": "tool", "content": "treated as user"},
            ]
        )

        assert reply == "ok"
        assert fake_openai.last_init_kwargs == {
            "api_key": "sk-test",
            "timeout": 300.0,
            "max_retries": 2,
            "base_url": "https://open.bigmodel.cn/api/paas/v4",
        }
        assert fake_openai.last_request_kwargs == {
            "model": "glm-test",
            "messages": [
                {"role": "system", "content": "rules"},
                {"role": "assistant", "content": "prior"},
                {"role": "user", "content": "treated as user"},
            ],
            "temperature": 0.2,
            "max_tokens": 321,
        }

    def test_explicit_base_url_passthrough(self, fake_openai):
        config = LLMConfig(
            api_key="sk-test",
            base_url="https://proxy.example/v1",
        )
        _make_openai_call(config)
        assert (
            fake_openai.last_init_kwargs["base_url"]
            == "https://proxy.example/v1"
        )

    @pytest.mark.parametrize("max_tokens", [0, -1])
    def test_non_positive_tokens_are_omitted_and_blocks_are_joined(
        self, fake_openai, monkeypatch, max_tokens: int
    ):
        monkeypatch.setattr(
            fake_openai,
            "response_content",
            [{"text": "first"}, SimpleNamespace(text=" second")],
        )
        call = _make_openai_call(
            LLMConfig(api_key="sk-test", max_tokens=max_tokens)
        )
        assert call([{"role": "user", "content": "go"}]) == "first second"
        assert "max_tokens" not in fake_openai.last_request_kwargs
        assert "base_url" not in fake_openai.last_init_kwargs

    def test_empty_choices_return_empty_text(self, fake_openai, monkeypatch):
        monkeypatch.setattr(fake_openai, "empty_choices", True)
        call = _make_openai_call(LLMConfig(api_key="sk-test"))
        assert call([{"role": "user", "content": "go"}]) == ""

    def test_request_error_propagates(self, fake_openai, monkeypatch):
        monkeypatch.setattr(
            fake_openai, "request_error", RuntimeError("network down")
        )
        call = _make_openai_call(LLMConfig(api_key="sk-test"))
        with pytest.raises(RuntimeError, match="network down"):
            call([{"role": "user", "content": "go"}])


class TestAnthropicCall:
    def test_client_message_conversion_and_text_extraction(
        self, fake_anthropic, monkeypatch
    ):
        monkeypatch.setattr(
            fake_anthropic,
            "response_blocks",
            [
                SimpleNamespace(type="text", text="first"),
                SimpleNamespace(type="tool_use", text="ignored"),
                SimpleNamespace(type="text", text=" second"),
            ],
        )
        config = LLMConfig(
            provider="anthropic",
            api_key="sk-ant",
            model="claude-test",
            temperature=0.3,
            max_tokens=0,
        )
        call = _make_anthropic_call(config)
        reply = call(
            [
                {"role": "system", "content": "rule one"},
                {"role": "user", "content": "question"},
                {"role": "system", "content": "rule two"},
                {"role": "assistant", "content": "prior"},
                {"role": "tool", "content": "treated as user"},
            ]
        )

        assert reply == "first second"
        assert fake_anthropic.last_init_kwargs == {
            "api_key": "sk-ant",
            "timeout": 300.0,
            "max_retries": 2,
        }
        assert fake_anthropic.last_request_kwargs == {
            "model": "claude-test",
            "messages": [
                {"role": "user", "content": "question"},
                {"role": "assistant", "content": "prior"},
                {"role": "user", "content": "treated as user"},
            ],
            "temperature": 0.3,
            "max_tokens": 8192,
            "system": "rule one\n\nrule two",
        }

    def test_positive_max_tokens_are_preserved(self, fake_anthropic):
        call = _make_anthropic_call(
            LLMConfig(
                provider="anthropic",
                api_key="sk-ant",
                max_tokens=456,
            )
        )
        call([{"role": "user", "content": "go"}])
        assert fake_anthropic.last_request_kwargs["max_tokens"] == 456
        assert "system" not in fake_anthropic.last_request_kwargs

    @pytest.mark.parametrize("max_tokens", [0, -1])
    def test_non_positive_max_tokens_fall_back(
        self, fake_anthropic, max_tokens: int
    ):
        call = _make_anthropic_call(
            LLMConfig(
                provider="anthropic",
                api_key="sk-ant",
                max_tokens=max_tokens,
            )
        )
        call([{"role": "user", "content": "go"}])
        assert fake_anthropic.last_request_kwargs["max_tokens"] == 8192

    def test_request_error_propagates(self, fake_anthropic, monkeypatch):
        monkeypatch.setattr(
            fake_anthropic, "request_error", RuntimeError("rate limited")
        )
        call = _make_anthropic_call(
            LLMConfig(provider="anthropic", api_key="sk-ant")
        )
        with pytest.raises(RuntimeError, match="rate limited"):
            call([{"role": "user", "content": "go"}])


class TestMakeLLMCall:
    def test_unconfigured_returns_none(self):
        assert make_llm_call(LLMConfig(api_key="")) is None

    @pytest.mark.parametrize("provider", ["zhipu", "dashscope", "moonshot"])
    def test_domestic_provider_returns_callable(
        self, fake_openai, provider: str
    ):
        result = make_llm_call(
            LLMConfig(provider=provider, api_key="sk-test")
        )
        assert callable(result)

    def test_anthropic_dispatches_to_native_sdk(self, fake_anthropic):
        result = make_llm_call(
            LLMConfig(provider="anthropic", api_key="sk-ant")
        )
        assert callable(result)

    def test_openai_client_construction_failure_returns_none(
        self, fake_openai, monkeypatch, caplog
    ):
        monkeypatch.setattr(
            fake_openai, "init_error", RuntimeError("openai constructor failed")
        )
        result = make_llm_call(LLMConfig(api_key="sk-test"))
        assert result is None
        assert "openai constructor failed" in caplog.text

    def test_anthropic_client_construction_failure_returns_none(
        self, fake_anthropic, monkeypatch, caplog
    ):
        monkeypatch.setattr(
            fake_anthropic,
            "init_error",
            RuntimeError("anthropic constructor failed"),
        )
        result = make_llm_call(
            LLMConfig(provider="anthropic", api_key="sk-ant")
        )
        assert result is None
        assert "anthropic constructor failed" in caplog.text

    def test_factory_creation_failure_returns_none(self, monkeypatch, caplog):
        def fail(_config: LLMConfig):
            raise RuntimeError("constructor failed")

        monkeypatch.setattr(llm_config, "_make_openai_call", fail)
        result = make_llm_call(LLMConfig(api_key="sk-test"))
        assert result is None
        assert "constructor failed" in caplog.text
