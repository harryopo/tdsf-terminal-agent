"""
tests/test_strands_model_adapter.py — Strands Model 适配工厂测试（TDSF 魔改 P0-C5）
===================================================================================

验证内容：
1. ``create_strands_model(config)`` 工厂函数
   - 未配置 API Key（is_configured=False）→ 返回 None（降级）
   - Strands 未安装（_STRANDS_MODEL_BASE is None）→ 返回 None（降级）
   - provider="openai" + 配置完整 → 返回 OpenAIModel 实例 + 正确参数
   - provider="anthropic" + 配置完整 → 返回 AnthropicModel 实例 + 正确参数
   - provider="litellm" + 配置完整 → 返回 LiteLLMModel 实例 + 正确参数
   - provider="unknown" → 兜底走 OpenAI 兼容路径
   - Model 创建异常 → 返回 None（捕获 + logger.error）
   - config=None 时自动 load_config() 加载

2. ``get_available_providers()`` / ``is_strands_models_available()``
   - 无任何 Model 类时返回空列表 / False
   - 注入 mock Model 类后返回对应 provider 列表 / True

3. ``configure_strands`` 集成（验证 P0-C5 自动注入）
   - ``strands_model=None`` + ``llm_config`` 已配置 + Strands 可用 → adapter._model_available=True
   - ``strands_model=None`` + 未配置 LLM → adapter._model_available=False（降级）
   - ``strands_model=显式传入`` → 跳过 create_strands_model 调用
   - ``create_strands_model`` 抛异常 → 不阻塞 configure_strands，strands_model 仍为 None

测试策略：
- Strands 包未安装到测试环境（条件依赖），用 monkeypatch 注入 mock Model 类
- Mock Model 类记录构造参数，便于断言 client_args/model_id/params 正确传递
- 100% 离线测试，不依赖真实 Strands / OpenAI SDK

运行：
    cd src-tauri/sidecar
    python -m pytest tests/test_strands_model_adapter.py -v
"""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock

# 确保能 import strands_backend / core
sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

from core.llm_config import LLMConfig


# ============================================================================
# Mock Strands Model 类（模拟 strands.models.openai.OpenAIModel 等）
# ============================================================================

class _MockModelBase:
    """Mock Strands Model 基类（模拟 strands.models.Model）"""

    def __init__(self, **kwargs: object) -> None:
        # 记录所有构造参数，便于断言
        self._init_kwargs = dict(kwargs)


class _MockOpenAIModel(_MockModelBase):
    """Mock OpenAIModel（模拟 strands.models.openai.OpenAIModel）"""

    def __init__(self, *, client_args: dict, model_id: str, params: dict) -> None:
        super().__init__(
            client_args=client_args, model_id=model_id, params=params
        )
        self.client_args = dict(client_args)
        self.model_id = model_id
        self.params = dict(params)


class _MockAnthropicModel(_MockModelBase):
    """Mock AnthropicModel"""

    def __init__(self, *, client_args: dict, model_id: str, params: dict) -> None:
        super().__init__(
            client_args=client_args, model_id=model_id, params=params
        )
        self.client_args = dict(client_args)
        self.model_id = model_id
        self.params = dict(params)


class _MockLiteLLMModel(_MockModelBase):
    """Mock LiteLLMModel"""

    def __init__(self, *, client_args: dict, model_id: str, params: dict) -> None:
        super().__init__(
            client_args=client_args, model_id=model_id, params=params
        )
        self.client_args = dict(client_args)
        self.model_id = model_id
        self.params = dict(params)


class _FailingMockModel:
    """Mock Model 抛异常（验证 Model 创建异常的降级路径）"""

    def __init__(self, **kwargs: object) -> None:
        raise RuntimeError("simulated model creation failure")


# ============================================================================
# Fixture
# ============================================================================

@pytest.fixture
def configured_llm_config() -> LLMConfig:
    """已配置完整 LLMConfig（OpenAI provider，含 base_url）"""
    return LLMConfig(
        provider="openai",
        api_key="sk-test-key-12345",
        base_url="https://api.deepseek.com/v1",
        model="deepseek-chat",
        temperature=0.5,
        max_tokens=1024,
    )


@pytest.fixture
def unconfigured_llm_config() -> LLMConfig:
    """未配置 API Key 的 LLMConfig（is_configured=False）"""
    return LLMConfig(
        provider="openai",
        api_key="",
        base_url="",
        model="gpt-4o-mini",
    )


@pytest.fixture
def mock_event_bus():
    """Mock EventBus"""
    bus = MagicMock()
    bus.publish = MagicMock()
    return bus


@pytest.fixture
def injected_model_adapter(monkeypatch):
    """注入 mock Strands Model 类到 model_adapter 模块

    模拟 Strands 已安装场景：_STRANDS_MODEL_BASE / _OpenAIModel /
    _AnthropicModel / _LiteLLMModel 全部可用。

    Returns:
        model_adapter 模块（已注入 mock）
    """
    from strands_backend import model_adapter
    monkeypatch.setattr(model_adapter, "_STRANDS_MODEL_BASE", _MockModelBase)
    monkeypatch.setattr(model_adapter, "_OpenAIModel", _MockOpenAIModel)
    monkeypatch.setattr(model_adapter, "_AnthropicModel", _MockAnthropicModel)
    monkeypatch.setattr(model_adapter, "_LiteLLMModel", _MockLiteLLMModel)
    return model_adapter


# ============================================================================
# 1. 降级路径测试
# ============================================================================

class TestCreateStrandsModelDegradation:
    """create_strands_model 降级路径测试"""

    def test_unconfigured_api_key_returns_none(
        self, injected_model_adapter, unconfigured_llm_config
    ):
        """未配置 API Key（is_configured=False）→ 返回 None"""
        result = injected_model_adapter.create_strands_model(unconfigured_llm_config)
        assert result is None

    def test_strands_not_installed_returns_none(self, monkeypatch):
        """Strands 未安装（_STRANDS_MODEL_BASE is None）→ 返回 None"""
        from strands_backend import model_adapter
        monkeypatch.setattr(model_adapter, "_STRANDS_MODEL_BASE", None)
        config = LLMConfig(
            provider="openai", api_key="sk-test", model="gpt-4o-mini"
        )
        result = model_adapter.create_strands_model(config)
        assert result is None

    def test_model_creation_exception_returns_none(
        self, monkeypatch, configured_llm_config
    ):
        """Model 创建异常 → 捕获 + 返回 None"""
        from strands_backend import model_adapter
        monkeypatch.setattr(model_adapter, "_STRANDS_MODEL_BASE", _MockModelBase)
        # OpenAIModel 构造时抛异常
        monkeypatch.setattr(model_adapter, "_OpenAIModel", _FailingMockModel)
        monkeypatch.setattr(model_adapter, "_AnthropicModel", None)
        monkeypatch.setattr(model_adapter, "_LiteLLMModel", None)

        result = model_adapter.create_strands_model(configured_llm_config)
        assert result is None  # 异常被捕获，返回 None

    def test_none_config_triggers_load_config(
        self, injected_model_adapter, monkeypatch, unconfigured_llm_config
    ):
        """config=None 时自动调用 load_config()（默认空配置 → None）"""
        # Mock load_config 返回未配置的 LLMConfig
        def _fake_load_config():
            return unconfigured_llm_config

        # 延迟导入路径：create_strands_model 内部 `from core.llm_config import load_config`
        import core.llm_config
        monkeypatch.setattr(
            core.llm_config, "load_config", _fake_load_config
        )

        result = injected_model_adapter.create_strands_model(None)
        assert result is None  # load_config 返回未配置 → None


# ============================================================================
# 2. OpenAI Model 测试
# ============================================================================

class TestCreateStrandsModelOpenAI:
    """create_strands_model provider=openai 路径测试"""

    def test_openai_model_created_with_correct_params(
        self, injected_model_adapter, configured_llm_config
    ):
        """provider=openai + 配置完整 → 返回 OpenAIModel 实例 + 正确参数"""
        result = injected_model_adapter.create_strands_model(configured_llm_config)

        assert result is not None
        assert isinstance(result, _MockOpenAIModel)
        # 验证 model_id
        assert result.model_id == "deepseek-chat"
        # 验证 client_args（含 api_key + base_url）
        assert result.client_args["api_key"] == "sk-test-key-12345"
        assert result.client_args["base_url"] == "https://api.deepseek.com/v1"
        # 验证 params
        assert result.params["temperature"] == 0.5
        assert result.params["max_tokens"] == 1024

    def test_openai_model_without_base_url(
        self, injected_model_adapter
    ):
        """provider=openai + base_url 留空 → client_args 不含 base_url（走 OpenAI 默认端点）"""
        config = LLMConfig(
            provider="openai",
            api_key="sk-official",
            base_url="",  # 留空，走 OpenAI 默认端点
            model="gpt-4o-mini",
        )
        result = injected_model_adapter.create_strands_model(config)

        assert result is not None
        assert isinstance(result, _MockOpenAIModel)
        assert "base_url" not in result.client_args  # 留空时不传
        assert result.client_args["api_key"] == "sk-official"

    def test_openai_model_uses_default_temperature_when_missing(
        self, injected_model_adapter
    ):
        """LLMConfig.temperature 用默认值时仍正确传递"""
        config = LLMConfig(
            provider="openai",
            api_key="sk-test",
            model="gpt-4o",
            temperature=0.7,  # 默认值
            max_tokens=2048,
        )
        result = injected_model_adapter.create_strands_model(config)

        assert result is not None
        assert result.params["temperature"] == 0.7
        assert result.params["max_tokens"] == 2048


# ============================================================================
# 3. Anthropic Model 测试
# ============================================================================

class TestCreateStrandsModelAnthropic:
    """create_strands_model provider=anthropic 路径测试"""

    def test_anthropic_model_created_with_correct_params(
        self, injected_model_adapter
    ):
        """provider=anthropic + 配置完整 → 返回 AnthropicModel 实例"""
        config = LLMConfig(
            provider="anthropic",
            api_key="sk-ant-test",
            base_url="https://api.anthropic.com",  # Anthropic 不支持自定义 base_url，应被忽略
            model="claude-3-5-sonnet-20241022",
            temperature=0.3,
            max_tokens=4096,
        )
        result = injected_model_adapter.create_strands_model(config)

        assert result is not None
        assert isinstance(result, _MockAnthropicModel)
        assert result.model_id == "claude-3-5-sonnet-20241022"
        # Anthropic 不支持 base_url，client_args 只应有 api_key
        assert result.client_args["api_key"] == "sk-ant-test"
        assert "base_url" not in result.client_args
        assert "api_base" not in result.client_args
        # 验证 params
        assert result.params["temperature"] == 0.3
        assert result.params["max_tokens"] == 4096

    def test_anthropic_model_ignores_base_url(
        self, injected_model_adapter
    ):
        """provider=anthropic + 配置了 base_url → 仍创建成功（base_url 被忽略）"""
        config = LLMConfig(
            provider="anthropic",
            api_key="sk-ant-test",
            base_url="https://custom.anthropic.proxy.com",  # 应被忽略
            model="claude-3-opus-20240229",
        )
        result = injected_model_adapter.create_strands_model(config)

        assert result is not None
        assert isinstance(result, _MockAnthropicModel)
        # base_url 不应影响 Anthropic Model 创建
        assert "base_url" not in result.client_args


# ============================================================================
# 4. LiteLLM Model 测试
# ============================================================================

class TestCreateStrandsModelLiteLLM:
    """create_strands_model provider=litellm 路径测试"""

    def test_litellm_model_created_with_correct_params(
        self, injected_model_adapter
    ):
        """provider=litellm + 配置完整 → 返回 LiteLLMModel 实例"""
        config = LLMConfig(
            provider="litellm",
            api_key="sk-litellm-test",
            base_url="https://custom.litellm.proxy.com",
            model="bedrock/anthropic.claude-3-sonnet-20240229-v1:0",
            temperature=0.8,
            max_tokens=2048,
        )
        result = injected_model_adapter.create_strands_model(config)

        assert result is not None
        assert isinstance(result, _MockLiteLLMModel)
        assert result.model_id == "bedrock/anthropic.claude-3-sonnet-20240229-v1:0"
        # LiteLLM 支持 base_url（通过 api_base 参数）
        assert result.client_args["api_key"] == "sk-litellm-test"
        assert result.client_args["api_base"] == "https://custom.litellm.proxy.com"
        # 验证 params
        assert result.params["temperature"] == 0.8
        assert result.params["max_tokens"] == 2048

    def test_litellm_model_without_base_url(
        self, injected_model_adapter
    ):
        """provider=litellm + base_url 留空 → client_args 不含 api_base"""
        config = LLMConfig(
            provider="litellm",
            api_key="sk-litellm",
            base_url="",
            model="groq/llama-3.1-70b-versatile",
        )
        result = injected_model_adapter.create_strands_model(config)

        assert result is not None
        assert isinstance(result, _MockLiteLLMModel)
        assert "api_base" not in result.client_args


# ============================================================================
# 5. 未知 Provider 兜底测试
# ============================================================================

class TestCreateStrandsModelUnknownProvider:
    """create_strands_model 未知 provider 兜底测试"""

    def test_unknown_provider_falls_back_to_openai(
        self, injected_model_adapter
    ):
        """provider=unknown → 兜底走 OpenAI 兼容路径（DeepSeek/OneAPI 等都自称 openai）"""
        config = LLMConfig(
            provider="unknown_provider",
            api_key="sk-unknown",
            base_url="https://api.unknown.com/v1",
            model="unknown-model",
        )
        result = injected_model_adapter.create_strands_model(config)

        # 应该兜底走 OpenAI 路径
        assert result is not None
        assert isinstance(result, _MockOpenAIModel)
        assert result.model_id == "unknown-model"
        assert result.client_args["base_url"] == "https://api.unknown.com/v1"

    def test_empty_provider_falls_back_to_openai(
        self, injected_model_adapter
    ):
        """provider="" → 兜底走 OpenAI（LLMConfig 默认 provider=openai）"""
        config = LLMConfig(
            provider="",  # 空字符串
            api_key="sk-test",
            model="gpt-4o",
        )
        # LLMConfig.__init__ 不强制 provider 非空，getattr 默认 "openai"
        result = injected_model_adapter.create_strands_model(config)

        assert result is not None
        assert isinstance(result, _MockOpenAIModel)


# ============================================================================
# 5.5 国产 OpenAI 兼容 provider 测试（zhipu/dashscope/moonshot，2026-08）
# ============================================================================

class TestDomesticOpenAICompatibleProviders:
    """国产三家 provider（zhipu/dashscope/moonshot）直通 OpenAIModel 分支测试

    三家均走官方 OpenAI 兼容端点（spec: add-domestic-first-ai-config），
    应命中 _OPENAI_COMPATIBLE_PROVIDERS 集合直接进 OpenAIModel 分支，
    而非 unknown 兜底（不产生 "unknown provider" warning）。
    """

    @pytest.mark.parametrize(
        ("provider", "base_url"),
        [
            ("zhipu", "https://open.bigmodel.cn/api/paas/v4"),
            ("dashscope", "https://dashscope.aliyuncs.com/compatible-mode/v1"),
            ("moonshot", "https://api.moonshot.cn/v1"),
        ],
    )
    def test_domestic_provider_returns_openai_model(
        self, injected_model_adapter, provider: str, base_url: str
    ):
        """国产 provider + 官方端点 → 返回 OpenAIModel 实例 + 参数透传"""
        config = LLMConfig(
            provider=provider,
            api_key="sk-domestic-test",
            base_url=base_url,
            model="test-model",
            temperature=0.5,
            max_tokens=1024,
        )
        result = injected_model_adapter.create_strands_model(config)

        assert result is not None
        assert isinstance(result, _MockOpenAIModel)
        assert result.model_id == "test-model"
        assert result.client_args["api_key"] == "sk-domestic-test"
        assert result.client_args["base_url"] == base_url
        assert result.params["temperature"] == 0.5
        assert result.params["max_tokens"] == 1024

    @pytest.mark.parametrize("provider", ["zhipu", "dashscope", "moonshot"])
    def test_domestic_provider_no_unknown_warning(
        self, injected_model_adapter, caplog, provider: str
    ):
        """国产 provider 命中显式集合（非 unknown 兜底），不产生 unknown 告警"""
        import logging

        config = LLMConfig(
            provider=provider,
            api_key="sk-domestic-test",
            base_url="https://example.com/v1",
            model="test-model",
        )
        with caplog.at_level(
            logging.WARNING, logger="sidecar.strands_backend.model_adapter"
        ):
            result = injected_model_adapter.create_strands_model(config)

        assert isinstance(result, _MockOpenAIModel)
        assert "unknown provider" not in caplog.text

    @pytest.mark.parametrize("provider", ["zhipu", "dashscope", "moonshot"])
    def test_domestic_provider_without_base_url(
        self, injected_model_adapter, provider: str
    ):
        """国产 provider + base_url 留空 → OpenAIModel 创建成功、不传 base_url

        端点预填/回退在 core/llm_config.py 层完成，adapter 层只透传 config。
        """
        config = LLMConfig(
            provider=provider, api_key="sk-domestic-test", model="test-model"
        )
        result = injected_model_adapter.create_strands_model(config)

        assert isinstance(result, _MockOpenAIModel)
        assert "base_url" not in result.client_args


# ============================================================================
# 6. 可用性查询测试
# ============================================================================

class TestAvailabilityQueries:
    """get_available_providers / is_strands_models_available 测试"""

    def test_no_providers_available_when_strands_not_installed(self, monkeypatch):
        """Strands 未安装 → get_available_providers 返回空列表"""
        from strands_backend import model_adapter
        monkeypatch.setattr(model_adapter, "_STRANDS_MODEL_BASE", None)
        monkeypatch.setattr(model_adapter, "_OpenAIModel", None)
        monkeypatch.setattr(model_adapter, "_AnthropicModel", None)
        monkeypatch.setattr(model_adapter, "_LiteLLMModel", None)

        assert model_adapter.get_available_providers() == []
        assert model_adapter.is_strands_models_available() is False

    def test_all_providers_available(self, injected_model_adapter):
        """所有 Model 类都注入 → 返回 ['openai', 'anthropic', 'litellm']"""
        providers = injected_model_adapter.get_available_providers()
        assert set(providers) == {"openai", "anthropic", "litellm"}
        assert injected_model_adapter.is_strands_models_available() is True

    def test_partial_providers_available(self, monkeypatch):
        """仅 OpenAI 可用 → 返回 ['openai']"""
        from strands_backend import model_adapter
        monkeypatch.setattr(model_adapter, "_STRANDS_MODEL_BASE", _MockModelBase)
        monkeypatch.setattr(model_adapter, "_OpenAIModel", _MockOpenAIModel)
        monkeypatch.setattr(model_adapter, "_AnthropicModel", None)
        monkeypatch.setattr(model_adapter, "_LiteLLMModel", None)

        providers = model_adapter.get_available_providers()
        assert providers == ["openai"]
        assert model_adapter.is_strands_models_available() is True


# ============================================================================
# 7. configure_strands 集成测试（验证 P0-C5 自动注入）
# ============================================================================

class TestConfigureStrandsModelInjection:
    """configure_strands P0-C5 自动注入测试

    验证 ``configure_strands(strands_model=None, llm_config=...)`` 时
    自动调用 ``create_strands_model(llm_config)`` 注入 Strands Model。
    """

    def test_auto_inject_when_strands_available(
        self, monkeypatch, mock_event_bus, configured_llm_config
    ):
        """strands_model=None + Strands 可用 + LLM 已配置 → adapter._model_available=True"""
        # 注入 mock Strands Agent 类（让 is_strands_available=True）
        import strands_backend
        monkeypatch.setattr(
            strands_backend, "is_strands_available", True, raising=False
        )
        # 注入 mock Strands Agent 到 adapter 模块
        from strands_backend import adapter as adapter_module
        mock_strands_agent_cls = MagicMock()
        monkeypatch.setattr(
            adapter_module, "_STRANDS_AGENT_AVAILABLE", True
        )
        monkeypatch.setattr(
            adapter_module, "_StrandsAgent", mock_strands_agent_cls
        )
        # TOOL_DECORATOR_AVAILABLE 必须 True 才认为 Strands 可用
        from strands_backend import tools as tools_module
        monkeypatch.setattr(tools_module, "TOOL_DECORATOR_AVAILABLE", True)

        # 注入 mock Model 类到 model_adapter
        from strands_backend import model_adapter
        monkeypatch.setattr(model_adapter, "_STRANDS_MODEL_BASE", _MockModelBase)
        monkeypatch.setattr(model_adapter, "_OpenAIModel", _MockOpenAIModel)
        monkeypatch.setattr(model_adapter, "_AnthropicModel", _MockAnthropicModel)
        monkeypatch.setattr(model_adapter, "_LiteLLMModel", _MockLiteLLMModel)

        # 调用 configure_strands（strands_model=None 应自动注入）
        from strands_backend import configure_strands
        adapter = configure_strands(
            event_bus=mock_event_bus,
            rust_bridge=None,
            llm_config=configured_llm_config,
        )

        # 验证 strands_model 已自动注入
        assert adapter.strands_model is not None
        assert isinstance(adapter.strands_model, _MockOpenAIModel)
        assert adapter._model_available is True

    def test_auto_inject_returns_none_when_llm_unconfigured(
        self, monkeypatch, mock_event_bus, unconfigured_llm_config
    ):
        """strands_model=None + LLM 未配置 → create_strands_model 返回 None → 降级"""
        # 注入 mock Model 类（Strands 可用，但 LLM 未配置）
        from strands_backend import model_adapter
        monkeypatch.setattr(model_adapter, "_STRANDS_MODEL_BASE", _MockModelBase)
        monkeypatch.setattr(model_adapter, "_OpenAIModel", _MockOpenAIModel)
        monkeypatch.setattr(model_adapter, "_AnthropicModel", _MockAnthropicModel)
        monkeypatch.setattr(model_adapter, "_LiteLLMModel", _MockLiteLLMModel)

        from strands_backend import configure_strands
        adapter = configure_strands(
            event_bus=mock_event_bus,
            rust_bridge=None,
            llm_config=unconfigured_llm_config,
        )

        # strands_model 仍为 None（未配置 API Key），adapter 走降级路径
        assert adapter.strands_model is None
        assert adapter._model_available is False

    def test_explicit_strands_model_skips_auto_injection(
        self, monkeypatch, mock_event_bus
    ):
        """strands_model=显式传入 → 跳过 create_strands_model 调用"""
        # 注入 mock Model 类
        from strands_backend import model_adapter
        monkeypatch.setattr(model_adapter, "_STRANDS_MODEL_BASE", _MockModelBase)
        monkeypatch.setattr(model_adapter, "_OpenAIModel", _MockOpenAIModel)
        monkeypatch.setattr(model_adapter, "_AnthropicModel", _MockAnthropicModel)
        monkeypatch.setattr(model_adapter, "_LiteLLMModel", _MockLiteLLMModel)

        # Mock create_strands_model 验证它是否被调用
        create_called = {"count": 0}
        original_create = model_adapter.create_strands_model

        def _spy_create(config=None):
            create_called["count"] += 1
            return original_create(config)

        monkeypatch.setattr(model_adapter, "create_strands_model", _spy_create)

        # 显式传入 mock Model 对象
        explicit_model = _MockOpenAIModel(
            client_args={"api_key": "explicit"},
            model_id="explicit-model",
            params={},
        )

        from strands_backend import configure_strands
        adapter = configure_strands(
            event_bus=mock_event_bus,
            rust_bridge=None,
            strands_model=explicit_model,  # 显式传入
        )

        # 验证 create_strands_model 未被调用
        assert create_called["count"] == 0
        # 验证 adapter 用的是显式传入的 model
        assert adapter.strands_model is explicit_model
        assert adapter._model_available is True

    def test_create_strands_model_exception_does_not_block_configure(
        self, monkeypatch, mock_event_bus, configured_llm_config
    ):
        """create_strands_model 抛异常 → 不阻塞 configure_strands，strands_model=None"""
        # 注入 mock Model 类
        from strands_backend import model_adapter
        monkeypatch.setattr(model_adapter, "_STRANDS_MODEL_BASE", _MockModelBase)
        monkeypatch.setattr(model_adapter, "_OpenAIModel", _MockOpenAIModel)
        monkeypatch.setattr(model_adapter, "_AnthropicModel", _MockAnthropicModel)
        monkeypatch.setattr(model_adapter, "_LiteLLMModel", _MockLiteLLMModel)

        # Mock create_strands_model 抛异常
        def _failing_create(config=None):
            raise RuntimeError("simulated adapter failure")

        monkeypatch.setattr(model_adapter, "create_strands_model", _failing_create)

        from strands_backend import configure_strands
        # 不应抛异常（异常被捕获）
        adapter = configure_strands(
            event_bus=mock_event_bus,
            rust_bridge=None,
            llm_config=configured_llm_config,
        )

        # strands_model 仍为 None，adapter 走降级路径
        assert adapter.strands_model is None
        assert adapter._model_available is False


# ============================================================================
# 8. 端到端：LLMConfig → Strands Model 参数映射验证
# ============================================================================

class TestEndToEndParameterMapping:
    """端到端参数映射：LLMConfig → Strands Model 构造参数

    验证所有 LLMConfig 字段正确映射到 Strands Model 构造参数，
    保证与现有 LangGraph 路径行为一致。
    """

    def test_openai_full_config_mapping(self, injected_model_adapter):
        """OpenAI provider 全字段映射"""
        config = LLMConfig(
            provider="openai",
            api_key="sk-full-test",
            base_url="https://api.siliconflow.cn/v1",
            model="Qwen/Qwen2.5-72B-Instruct",
            temperature=0.1,
            max_tokens=8192,
        )
        result = injected_model_adapter.create_strands_model(config)

        assert isinstance(result, _MockOpenAIModel)
        # LLMConfig.api_key → client_args["api_key"]
        assert result.client_args["api_key"] == "sk-full-test"
        # LLMConfig.base_url → client_args["base_url"]
        assert result.client_args["base_url"] == "https://api.siliconflow.cn/v1"
        # LLMConfig.model → model_id
        assert result.model_id == "Qwen/Qwen2.5-72B-Instruct"
        # LLMConfig.temperature → params["temperature"]
        assert result.params["temperature"] == 0.1
        # LLMConfig.max_tokens → params["max_tokens"]
        assert result.params["max_tokens"] == 8192

    def test_anthropic_full_config_mapping(self, injected_model_adapter):
        """Anthropic provider 全字段映射（base_url 被忽略）"""
        config = LLMConfig(
            provider="anthropic",
            api_key="sk-ant-full",
            base_url="https://ignored.anthropic.proxy",  # 应被忽略
            model="claude-3-5-haiku-20241022",
            temperature=0.2,
            max_tokens=4096,
        )
        result = injected_model_adapter.create_strands_model(config)

        assert isinstance(result, _MockAnthropicModel)
        assert result.client_args["api_key"] == "sk-ant-full"
        # Anthropic 不支持 base_url
        assert "base_url" not in result.client_args
        assert result.model_id == "claude-3-5-haiku-20241022"
        assert result.params["temperature"] == 0.2
        assert result.params["max_tokens"] == 4096

    def test_litellm_full_config_mapping(self, injected_model_adapter):
        """LiteLLM provider 全字段映射（base_url → api_base）"""
        config = LLMConfig(
            provider="litellm",
            api_key="sk-litellm-full",
            base_url="https://api.custom-proxy.com",
            model="groq/llama-3.1-8b-instant",
            temperature=0.9,
            max_tokens=512,
        )
        result = injected_model_adapter.create_strands_model(config)

        assert isinstance(result, _MockLiteLLMModel)
        assert result.client_args["api_key"] == "sk-litellm-full"
        # LiteLLM 用 api_base 字段
        assert result.client_args["api_base"] == "https://api.custom-proxy.com"
        assert result.model_id == "groq/llama-3.1-8b-instant"
        assert result.params["temperature"] == 0.9
        assert result.params["max_tokens"] == 512
