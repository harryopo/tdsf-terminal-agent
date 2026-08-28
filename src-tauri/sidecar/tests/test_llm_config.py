"""
tests/test_llm_config.py — LLM 配置层测试（TDSF 魔改 · 国产 provider 对齐 2026-08）
====================================================================================

验证内容（spec: add-domestic-first-ai-config / 任务 T3.1）：
1. ``PROVIDER_DEFAULT_BASE_URLS`` 映射：zhipu / dashscope / moonshot 三家
   的官方 OpenAI 兼容端点值与 spec 一致
2. ``_resolve_base_url`` 回退语义：
   - 显式 base_url 优先（用户自定义代理不被官方端点覆盖）
   - base_url 为空 + 已知国产 provider → 回退官方端点
   - base_url 为空 + 未收录 provider（openai/deepseek/unknown）→ 返回空串
     （默认 OpenAI 兼容行为不变，ChatOpenAI 走默认官方端点）
3. ``_make_openai_call`` 集成：最终 ChatOpenAI 构造参数里的 base_url 正确
4. ``make_llm_call`` 分发：provider="zhipu" 走 OpenAI 兼容路径（非 anthropic）

测试策略：
- fake ``langchain_openai.ChatOpenAI``（sys.modules 注入），记录构造 kwargs，
  100% 离线、不依赖 langchain-openai 是否真实安装
- 不发起任何真实网络请求

运行：
    cd src-tauri/sidecar
    python -m pytest tests/test_llm_config.py -v
"""
from __future__ import annotations

import sys
import types
from pathlib import Path

# 确保能 import core
sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

from core.llm_config import (
    PROVIDER_DEFAULT_BASE_URLS,
    LLMConfig,
    _make_openai_call,
    _resolve_base_url,
    make_llm_call,
)


# ============================================================================
# Fake langchain_openai（记录 ChatOpenAI 构造参数，不发网络请求）
# ============================================================================

class _FakeChatOpenAI:
    """Fake ChatOpenAI：记录构造 kwargs，供断言 base_url 透传

    last_init_kwargs 为类级记录（_make_openai_call 内部只构造一个实例，
    构造后即可断言）；fixture 每次重置，避免测试间残留。
    """

    last_init_kwargs: dict = {}

    def __init__(self, **kwargs: object) -> None:
        self._init_kwargs = dict(kwargs)
        _FakeChatOpenAI.last_init_kwargs = dict(kwargs)


@pytest.fixture
def fake_chat_openai(monkeypatch):
    """向 sys.modules 注入 fake langchain_openai 模块

    _make_openai_call 内部延迟导入 ``from langchain_openai import ChatOpenAI``，
    注入 sys.modules 后该导入会命中 fake 模块（无论真实包是否已安装）。
    """
    fake_module = types.ModuleType("langchain_openai")
    fake_module.ChatOpenAI = _FakeChatOpenAI  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "langchain_openai", fake_module)
    # 重置类级记录，避免测试间残留
    monkeypatch.setattr(_FakeChatOpenAI, "last_init_kwargs", {})
    return _FakeChatOpenAI


# ============================================================================
# 1. PROVIDER_DEFAULT_BASE_URLS 映射值（与 spec 端点逐字对照）
# ============================================================================

class TestProviderDefaultBaseUrls:
    """国产三家官方 OpenAI 兼容端点映射测试"""

    def test_mapping_contains_three_domestic_providers(self):
        """映射含且仅含国产三家（不含 openai/deepseek 等，避免改变既有行为）"""
        assert set(PROVIDER_DEFAULT_BASE_URLS.keys()) == {
            "zhipu",
            "dashscope",
            "moonshot",
        }

    def test_official_endpoint_values_match_spec(self):
        """三家端点值与 spec（add-domestic-first-ai-config）一致"""
        assert (
            PROVIDER_DEFAULT_BASE_URLS["zhipu"]
            == "https://open.bigmodel.cn/api/paas/v4"
        )
        assert (
            PROVIDER_DEFAULT_BASE_URLS["dashscope"]
            == "https://dashscope.aliyuncs.com/compatible-mode/v1"
        )
        assert (
            PROVIDER_DEFAULT_BASE_URLS["moonshot"]
            == "https://api.moonshot.cn/v1"
        )


# ============================================================================
# 2. _resolve_base_url 回退语义
# ============================================================================

class TestResolveBaseUrl:
    """_resolve_base_url：显式配置优先 / 已知 provider 回退 / 未收录不变"""

    @pytest.mark.parametrize(
        ("provider", "expected"),
        [
            ("zhipu", "https://open.bigmodel.cn/api/paas/v4"),
            ("dashscope", "https://dashscope.aliyuncs.com/compatible-mode/v1"),
            ("moonshot", "https://api.moonshot.cn/v1"),
        ],
    )
    def test_domestic_provider_fallback_when_base_url_empty(
        self, provider: str, expected: str
    ):
        """base_url 为空 + 已知国产 provider → 回退官方 OpenAI 兼容端点"""
        config = LLMConfig(provider=provider, api_key="sk-test", base_url="")
        assert _resolve_base_url(config) == expected

    @pytest.mark.parametrize("provider", ["zhipu", "dashscope", "moonshot"])
    def test_blank_base_url_falls_back(self, provider: str):
        """base_url 仅含空白字符 → 视同为空，同样回退官方端点"""
        config = LLMConfig(provider=provider, api_key="sk-test", base_url="   ")
        assert _resolve_base_url(config) != ""

    def test_explicit_base_url_wins(self):
        """显式 base_url（用户自定义代理）优先，不被官方端点覆盖"""
        config = LLMConfig(
            provider="zhipu",
            api_key="sk-test",
            base_url="https://my-oneapi-proxy.example.com/v1",
        )
        assert (
            _resolve_base_url(config)
            == "https://my-oneapi-proxy.example.com/v1"
        )

    @pytest.mark.parametrize(
        "provider", ["openai", "deepseek", "ollama", "totally-unknown", ""]
    )
    def test_unlisted_provider_returns_empty(self, provider: str):
        """未收录 provider（含 openai/未知 id/空串）→ 返回空串（行为不变）"""
        config = LLMConfig(provider=provider, api_key="sk-test", base_url="")
        assert _resolve_base_url(config) == ""

    def test_provider_case_insensitive(self):
        """provider 大小写不敏感（防御非小写输入）"""
        config = LLMConfig(provider="ZhiPu", api_key="sk-test", base_url="")
        assert (
            _resolve_base_url(config) == "https://open.bigmodel.cn/api/paas/v4"
        )


# ============================================================================
# 3. _make_openai_call 集成（ChatOpenAI 构造参数验证）
# ============================================================================

class TestMakeOpenAILBaseUrl:
    """_make_openai_call：最终 ChatOpenAI kwargs 的 base_url 正确"""

    @pytest.mark.parametrize(
        ("provider", "expected"),
        [
            ("zhipu", "https://open.bigmodel.cn/api/paas/v4"),
            ("dashscope", "https://dashscope.aliyuncs.com/compatible-mode/v1"),
            ("moonshot", "https://api.moonshot.cn/v1"),
        ],
    )
    def test_chat_openai_receives_official_base_url(
        self, fake_chat_openai, provider: str, expected: str
    ):
        """国产 provider + base_url 为空 → ChatOpenAI 收到官方端点"""
        config = LLMConfig(provider=provider, api_key="sk-test", model="x")
        llm_call = _make_openai_call(config)
        assert callable(llm_call)
        # _make_openai_call 内部只构造一个 ChatOpenAI 实例
        assert fake_chat_openai.last_init_kwargs["base_url"] == expected

    def test_chat_openai_no_base_url_for_unlisted_provider(
        self, fake_chat_openai
    ):
        """未收录 provider + base_url 为空 → kwargs 不含 base_url（默认行为不变）"""
        config = LLMConfig(provider="openai", api_key="sk-test", model="gpt-4o")
        llm_call = _make_openai_call(config)
        assert callable(llm_call)
        assert "base_url" not in fake_chat_openai.last_init_kwargs

    def test_chat_openai_explicit_base_url_passthrough(self, fake_chat_openai):
        """显式 base_url 原样透传给 ChatOpenAI"""
        config = LLMConfig(
            provider="zhipu",
            api_key="sk-test",
            base_url="https://custom.example.com/v1",
            model="glm-5.3",
        )
        llm_call = _make_openai_call(config)
        assert callable(llm_call)
        assert (
            fake_chat_openai.last_init_kwargs["base_url"]
            == "https://custom.example.com/v1"
        )


# ============================================================================
# 4. make_llm_call 分发（zhipu 走 OpenAI 兼容路径）
# ============================================================================

class TestMakeLLMCallDomesticProvider:
    """make_llm_call：国产 provider 走 OpenAI 兼容工厂（非 anthropic 分支）"""

    @pytest.mark.parametrize("provider", ["zhipu", "dashscope", "moonshot"])
    def test_domestic_provider_returns_llm_call(
        self, fake_chat_openai, provider: str
    ):
        """已配置 key 的国产 provider → 返回 callable（OpenAI 兼容路径创建成功）"""
        config = LLMConfig(
            provider=provider, api_key="sk-test", model="test-model"
        )
        llm_call = make_llm_call(config)
        assert callable(llm_call)
