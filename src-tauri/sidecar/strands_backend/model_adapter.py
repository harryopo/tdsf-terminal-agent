"""
strands_backend/model_adapter.py — Strands Model 适配工厂（TDSF 魔改 P0-C5）
===================================================================================

职责：
- 把现有 ``core.llm_config.LLMConfig`` 转换为 Strands 官方 Model Provider 实例
  （``OpenAIModel`` / ``AnthropicModel`` / ``LiteLLMModel``）。
- 与现有 LangGraph 路径**共享同一份配置源**（环境变量 / .tdsf-data/llm_config.json），
  保证前后端切换时 API Key / base_url / model 一致，避免双套配置导致行为分裂。
- 优雅降级：未配置 API Key / Strands 未安装 / provider 不支持时返回 None，
  由 ``StrandsAgentAdapter._check_degraded`` 走降级路径（推送 mock_llm_active 告警）。

设计原则：
1. **零造轮子**：直接复用 Strands 官方 Model Provider（OpenAIModel/AnthropicModel/LiteLLMModel），
   不实现自定义 Model 子类（避免维护 stream/async generator 协议）。
2. **OpenAI 兼容优先**：默认走 OpenAIModel，通过 ``base_url`` 支持任意 OpenAI 兼容端点
   （DeepSeek / Ollama / OneAPI / NewAPI / SiliconFlow / vLLM 等）。
3. **Anthropic 原生**：provider="anthropic" 时走 AnthropicModel（claude-3-* 系列）。
4. **LiteLLM 兜底**：未来可扩展支持 ``litellm/<model>`` 字符串模型 ID，覆盖 Bedrock/Ollama 等。
5. **配置共享**：通过 ``load_config()`` 复用 LangGraph 路径的同一份配置，
   前端 ``agent.configure`` RPC 重新配置后，下次 ``configure_strands`` 调用自动生效。

字段映射（LLMConfig → Strands Model 参数）：
+-------------------+----------------------------------------------+----------------------------------------------+
| LLMConfig 字段    | OpenAIModel 参数                              | AnthropicModel 参数                          |
+-------------------+----------------------------------------------+----------------------------------------------+
| api_key           | client_args["api_key"]                        | client_args["api_key"]                        |
| base_url          | client_args["base_url"]（支持 OpenAI 兼容端点） | (不支持自定义 base_url，固定为 Anthropic 端点) |
| model             | model_id                                      | model_id                                      |
| temperature       | params["temperature"]                         | params["temperature"]                         |
| max_tokens        | params["max_tokens"]                          | params["max_tokens"]                          |
+-------------------+----------------------------------------------+----------------------------------------------+

集成点（main.py Strands 注入段）：

    from strands_backend import configure_strands
    from core.llm_config import load_config

    adapter = configure_strands(
        event_bus=event_bus.get_global_bus(),
        rust_bridge=None,
        strands_model=None,  # 留空时 configure_strands 自动调用 create_strands_model(load_config())
    )
    agents.set_backend(lambda agent_id, input, state: adapter.invoke(agent_id, input, state))

测试用例（见 tests/test_strands_model_adapter.py）：
- provider="openai" + 配置完整 → 返回 OpenAIModel 实例
- provider="anthropic" + 配置完整 → 返回 AnthropicModel 实例
- 未配置 API Key → 返回 None（走降级）
- provider="unknown" → 返回 None（不支持）
- strands 未安装 → 返回 None（条件依赖优雅降级）
"""
from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger("sidecar.strands_backend.model_adapter")


# ============================================================================
# Strands Model Provider 条件导入
# ============================================================================
#
# Strands 是条件依赖（requirements.txt 声明 strands-agents>=1.0,<2.0），
# 安装缺失时优雅降级返回 None，让 StrandsAgentAdapter 走降级路径。
#
# 单独 try 每个 provider 的导入，允许部分 provider 可用（如 strands-agents 已安装
# 但 strands-agents-openai 扩展未装时 OpenAIModel 不可用）。
# ============================================================================

# 基础 Model 抽象类（用于类型注解）
_STRANDS_MODEL_BASE: Any = None
try:
    from strands.models import Model as _STRANDS_MODEL_BASE  # type: ignore[import]
except ImportError:
    _STRANDS_MODEL_BASE = None

# OpenAIModel（支持任意 OpenAI 兼容端点：DeepSeek/Ollama/OneAPI/SiliconFlow/vLLM 等）
_OpenAIModel: Any = None
try:
    from strands.models.openai import OpenAIModel as _OpenAIModel  # type: ignore[import]
except ImportError:
    pass

# AnthropicModel（claude-3-* 系列）
_AnthropicModel: Any = None
try:
    from strands.models.anthropic import AnthropicModel as _AnthropicModel  # type: ignore[import]
except ImportError:
    pass

# LiteLLMModel（万能适配器，支持 100+ provider，未来扩展用）
_LiteLLMModel: Any = None
try:
    from strands.models.litellm import LiteLLMModel as _LiteLLMModel  # type: ignore[import]
except ImportError:
    pass


# ============================================================================
# 工厂函数
# ============================================================================

# 已知 OpenAI 兼容 provider id 集合（2026-08 国产 provider 一等公民化）
# 命中此集合的 provider 直接走 OpenAIModel 分支（而非 unknown 兜底），
# 避免 "unknown provider" 误报警告。这些 provider 的请求经 base_url
# 发往各自官方 OpenAI 兼容端点（端点预填/回退逻辑在 core/llm_config.py，
# adapter 层只透传 config.base_url，保持职责单一）。
_OPENAI_COMPATIBLE_PROVIDERS: frozenset[str] = frozenset(
    {
        "openai",
        # 智谱 GLM 开放平台
        "zhipu",
        # 阿里云百炼 DashScope（compatible-mode）
        "dashscope",
        # 月之暗面 Kimi（Moonshot）
        "moonshot",
    }
)


def create_strands_model(config: Any | None = None) -> Any:
    """根据 LLMConfig 创建对应的 Strands Model 实例

    Args:
        config: LLMConfig 实例。None 时自动调用 load_config() 加载（环境变量优先，
                配置文件回退）。支持延迟导入避免循环依赖。

    Returns:
        Strands Model 实例（OpenAIModel / AnthropicModel / LiteLLMModel）；
        下列情况返回 None（让 adapter 走降级路径）：
          - config 未配置 API Key（is_configured=False）
          - Strands 未安装（_STRANDS_MODEL_BASE is None）
          - provider 不支持（非 openai/anthropic/litellm）
          - Model 创建异常（如依赖扩展未安装）

    Raises:
        无（所有异常被捕获并 logger.error，返回 None）

    使用示例：

        from strands_backend.model_adapter import create_strands_model
        from core.llm_config import load_config

        model = create_strands_model(load_config())
        if model is None:
            # 走降级路径
            ...
        else:
            agent = StrandsAgent(model=model, tools=[...])

    设计决策（P0-C5）：
    1. 不实现自定义 Model 子类：Strands 官方 OpenAIModel/AnthropicModel 已经覆盖
       OpenAI Chat Completions + Anthropic Messages 两大协议，直接复用即可。
       自定义 Model 需实现 async stream() + StreamEvent 协议，复杂度高且失去原生
       工具调用支持（tool_use 事件由 Strands 内部处理）。
    2. OpenAI 兼容优先：默认走 OpenAIModel，通过 base_url 支持任意 OpenAI 兼容端点
       （DeepSeek / Ollama / OneAPI / NewAPI / SiliconFlow / vLLM 等）。
    3. Anthropic 原生：provider="anthropic" 时走 AnthropicModel（claude-3-* 系列）。
       Anthropic 端点不支持自定义 base_url，但官方 API 已足够稳定。
    4. LiteLLM 兜底（未来扩展）：provider="litellm" 时走 LiteLLMModel，
       支持 100+ provider（Bedrock / Cohere / Mistral / Groq 等），需额外安装 litellm。
    """
    # 1. 检查 Strands 是否安装
    if _STRANDS_MODEL_BASE is None:
        logger.warning(
            "create_strands_model: strands-agents package not installed, "
            "returning None (adapter will degrade)"
        )
        return None

    # 2. 加载配置（延迟导入避免循环依赖）
    if config is None:
        try:
            from core.llm_config import load_config
            config = load_config()
        except Exception as e:
            logger.exception(
                f"create_strands_model: failed to load LLM config: {e}"
            )
            return None

    # 3. 检查配置有效性
    if not getattr(config, "is_configured", False):
        logger.info(
            "create_strands_model: LLM not configured (no API Key), "
            "returning None (adapter will degrade). "
            "Set TDSF_LLM_API_KEY env or write .tdsf-data/llm_config.json"
        )
        return None

    provider = getattr(config, "provider", "openai").lower()
    logger.info(
        f"create_strands_model: creating Strands Model for "
        f"provider={provider}, model={getattr(config, 'model', 'unknown')}, "
        f"base_url={'set' if getattr(config, 'base_url', '') else 'default'}"
    )

    # 4. 按 provider 分发到具体工厂
    # OpenAI 兼容集合含国产三家（zhipu/dashscope/moonshot），它们与 openai
    # 同走 OpenAIModel 分支；仅真正未知的 provider 才落 else 兜底并告警
    try:
        if provider in _OPENAI_COMPATIBLE_PROVIDERS:
            return _create_openai_model(config)
        elif provider == "anthropic":
            return _create_anthropic_model(config)
        elif provider == "litellm":
            return _create_litellm_model(config)
        else:
            # 兜底：未知 provider 默认走 OpenAI 兼容路径
            # 国内常见情况：DeepSeek / OneAPI / SiliconFlow 等都自称 "openai" provider
            logger.warning(
                f"create_strands_model: unknown provider='{provider}', "
                f"falling back to OpenAI-compatible path"
            )
            return _create_openai_model(config)
    except Exception as e:
        logger.exception(
            f"create_strands_model: failed to create Strands Model "
            f"(provider={provider}): {e}"
        )
        return None


# ============================================================================
# 具体工厂：OpenAI 兼容
# ============================================================================

def _create_openai_model(config: Any) -> Any:
    """创建 OpenAIModel 实例（支持任意 OpenAI 兼容端点）

    支持的端点（通过 base_url 配置）：
    - OpenAI 官方：https://api.openai.com/v1（base_url 留空）
    - DeepSeek：https://api.deepseek.com/v1
    - 智谱(zhipu)：https://open.bigmodel.cn/api/paas/v4
    - 阿里百炼(dashscope)：https://dashscope.aliyuncs.com/compatible-mode/v1
    - Kimi(moonshot)：https://api.moonshot.cn/v1
    - SiliconFlow：https://api.siliconflow.cn/v1
    - OneAPI / NewAPI 代理：用户自定义
    - 本地 Ollama（OpenAI 兼容接口）：http://localhost:11434/v1
    - vLLM 自部署：http://localhost:8000/v1

    Args:
        config: LLMConfig 实例（provider 属于 _OPENAI_COMPATIBLE_PROVIDERS）

    Returns:
        OpenAIModel 实例

    Raises:
        ImportError: strands.models.openai.OpenAIModel 不可用
        Exception: 配置错误或 OpenAI SDK 内部错误
    """
    if _OpenAIModel is None:
        raise ImportError(
            "strands.models.openai.OpenAIModel not available, "
            "install strands-agents with openai extra: "
            "pip install 'strands-agents[openai]'"
        )

    # 构建 client_args（OpenAI Python SDK 的 AsyncOpenAI/OpenAI 构造参数）
    client_args: dict[str, Any] = {
        "api_key": config.api_key,
    }
    if config.base_url:
        client_args["base_url"] = config.base_url
    # T9 稳定性 (2026-09-01, spec 9.1): 此前 LLM 请求裸跑无超时——模型服务
    # 挂起时 invoke 永久阻塞。显式单请求超时（httpx 秒）+ 有限重试；
    # 读超时兜底之外，adapter 层另有 10 分钟无输出 watchdog。
    client_args["timeout"] = 300.0
    client_args["max_retries"] = 2

    # 构建 params（OpenAI Chat Completions 接口参数）
    # TDSF 魔改 (2026-08-09): max_tokens <= 0 时不传 → 模型自行决定停止（无上限）
    params: dict[str, Any] = {
        "temperature": getattr(config, "temperature", 0.7),
    }
    max_tokens = getattr(config, "max_tokens", 8192)
    if max_tokens > 0:
        params["max_tokens"] = max_tokens

    model = _OpenAIModel(
        client_args=client_args,
        model_id=config.model,
        params=params,
    )

    logger.info(
        f"OpenAIModel created: model_id={config.model}, "
        f"base_url={'custom' if config.base_url else 'default'}, "
        f"temperature={params['temperature']}, max_tokens={params.get('max_tokens', 'unlimited')}"
    )
    return model


# ============================================================================
# 具体工厂：Anthropic 原生
# ============================================================================

def _create_anthropic_model(config: Any) -> Any:
    """创建 AnthropicModel 实例（claude-3-* 系列）

    Anthropic 端点不支持自定义 base_url（与 OpenAI 不同），固定走官方 API：
    https://api.anthropic.com

    Args:
        config: LLMConfig 实例（provider="anthropic"）

    Returns:
        AnthropicModel 实例

    Raises:
        ImportError: strands.models.anthropic.AnthropicModel 不可用
        Exception: 配置错误或 Anthropic SDK 内部错误
    """
    if _AnthropicModel is None:
        raise ImportError(
            "strands.models.anthropic.AnthropicModel not available, "
            "install strands-agents with anthropic extra: "
            "pip install 'strands-agents[anthropic]'"
        )

    # Anthropic 官方端点不支持自定义 base_url，忽略 config.base_url
    # （与 OpenAI 兼容路径不同，AnthropicModel 没有 client_args["base_url"]）
    client_args: dict[str, Any] = {
        "api_key": config.api_key,
    }

    # TDSF 魔改 (2026-08-09): Anthropic max_tokens 是必填参数（必须正整数）
    # max_tokens <= 0（无上限语义）时兜底为 8192
    params: dict[str, Any] = {
        "temperature": getattr(config, "temperature", 0.7),
        "max_tokens": max(getattr(config, "max_tokens", 8192), 1) if getattr(config, "max_tokens", 8192) > 0 else 8192,
    }

    model = _AnthropicModel(
        client_args=client_args,
        model_id=config.model,
        params=params,
    )

    logger.info(
        f"AnthropicModel created: model_id={config.model}, "
        f"temperature={params['temperature']}, max_tokens={params['max_tokens']}"
    )
    return model


# ============================================================================
# 具体工厂：LiteLLM（万能适配器，未来扩展用）
# ============================================================================

def _create_litellm_model(config: Any) -> Any:
    """创建 LiteLLMModel 实例（支持 100+ provider）

    LiteLLM 是万能 LLM 适配器，支持 Bedrock / Cohere / Mistral / Groq / Together /
    Azure OpenAI / Replicate / Fireworks 等 100+ provider。

    模型 ID 格式：``<provider>/<model>``，如：
    - ``bedrock/anthropic.claude-3-sonnet-20240229-v1:0``
    - ``groq/llama-3.1-70b-versatile``
    - ``mistral/mistral-large-latest``

    使用前需安装 litellm：``pip install litellm``

    Args:
        config: LLMConfig 实例（provider="litellm"）

    Returns:
        LiteLLMModel 实例

    Raises:
        ImportError: strands.models.litellm.LiteLLMModel 不可用
        Exception: 配置错误或 LiteLLM 内部错误
    """
    if _LiteLLMModel is None:
        raise ImportError(
            "strands.models.litellm.LiteLLMModel not available, "
            "install strands-agents with litellm extra: "
            "pip install 'strands-agents[litellm]' litellm"
        )

    client_args: dict[str, Any] = {
        "api_key": config.api_key,
    }
    # LiteLLM 支持自定义 base_url（覆盖 LiteLLM 内置 provider 路由）
    if config.base_url:
        client_args["api_base"] = config.base_url

    # TDSF 魔改 (2026-08-09): max_tokens <= 0 时不传 → 无上限（同 OpenAI 路径）
    params: dict[str, Any] = {
        "temperature": getattr(config, "temperature", 0.7),
    }
    max_tokens = getattr(config, "max_tokens", 8192)
    if max_tokens > 0:
        params["max_tokens"] = max_tokens

    model = _LiteLLMModel(
        client_args=client_args,
        model_id=config.model,
        params=params,
    )

    logger.info(
        f"LiteLLMModel created: model_id={config.model}, "
        f"api_base={'custom' if config.base_url else 'default'}, "
        f"temperature={params['temperature']}, max_tokens={params.get('max_tokens', 'unlimited')}"
    )
    return model


# ============================================================================
# 可用性查询
# ============================================================================

def get_available_providers() -> list[str]:
    """查询当前环境可用的 Strands Model Provider 列表

    用于调试和前端展示（agent.info JSON-RPC 可暴露此信息）。

    Returns:
        可用 provider 名称列表（如 ["openai", "anthropic"]）
    """
    available = []
    if _OpenAIModel is not None:
        available.append("openai")
    if _AnthropicModel is not None:
        available.append("anthropic")
    if _LiteLLMModel is not None:
        available.append("litellm")
    return available


def is_strands_models_available() -> bool:
    """检查 Strands Models 模块是否可用

    Returns:
        True 表示至少一个 Model Provider 可用
    """
    return _STRANDS_MODEL_BASE is not None and len(get_available_providers()) > 0


__all__ = [
    "create_strands_model",
    "get_available_providers",
    "is_strands_models_available",
]
