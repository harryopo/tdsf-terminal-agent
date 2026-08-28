"""
core/llm_config.py — LLM 配置与调用封装（TDSF 魔改 P0-3）
================================================================

职责：
- 从环境变量 / 配置文件读取 LLM provider 配置（API Key / BaseURL / Model）
- 提供 ``make_llm_call()`` 函数，返回符合 BaseAgent.llm_call 签名的 callable
- 支持 OpenAI 兼容接口（方便国内用户使用各种代理 / OneAPI / DeepSeek 等）
- 支持 Anthropic 原生接口
- 不可用时返回 None，Agent 降级到 mock LLM（保持离线可用）

设计要点：
1. **环境变量优先**：TDSF_LLM_API_KEY / TDSF_LLM_BASE_URL / TDSF_LLM_MODEL
2. **配置文件回退**：.tdsf-data/llm_config.json（前端通过 IPC 写入）
3. **OpenAI 兼容**：默认使用 langchain-openai 的 ChatOpenAI，
   通过 base_url 指向任意 OpenAI 兼容端点（DeepSeek / OneAPI / 代理等）
4. **错误隔离**：LLM 调用失败时抛异常，由 BaseAgent.call_llm 捕获降级到 mock

llm_call 签名（与 BaseAgent.call_llm 一致）：
    Input:  messages: list[dict[str, Any]]  # OpenAI Chat Completions 格式
    Output: str                              # LLM 回复文本

集成点：
- main.py 启动时调用 make_llm_call() 获取 llm_call，注入 agents.configure_agents
- 前端 agent.configure JSON-RPC 方法可运行时重新配置
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any, Callable, Protocol

logger = logging.getLogger("sidecar.core.llm_config")


# ============================================================================
# 类型定义
# ============================================================================

class LLMCallFunction(Protocol):
    """LLM 调用函数签名（与 BaseAgent.llm_call 一致）"""
    def __call__(self, messages: list[dict[str, Any]]) -> str: ...


class LLMConfig:
    """LLM 配置数据类"""

    def __init__(
        self,
        provider: str = "openai",
        api_key: str = "",
        base_url: str = "",
        model: str = "gpt-4o-mini",
        temperature: float = 0.7,
        max_tokens: int = 8192,  # <=0 表示无上限（OpenAI/LiteLLM 不传该参数；Anthropic 兜底 8192）
    ) -> None:
        self.provider = provider      # "openai" / "anthropic"
        self.api_key = api_key
        self.base_url = base_url      # 留空则用 provider 默认端点
        self.model = model
        self.temperature = temperature
        self.max_tokens = max_tokens

    @property
    def is_configured(self) -> bool:
        """是否已配置有效 API Key"""
        return bool(self.api_key.strip())

    def to_dict(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "api_key": self.api_key,
            "base_url": self.base_url,
            "model": self.model,
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
        }


# ============================================================================
# 配置加载
# ============================================================================

def _get_config_path() -> Path:
    """获取 LLM 配置文件路径（.tdsf-data/llm_config.json）"""
    data_dir = Path(os.environ.get("TDSF_DATA_DIR", "."))
    return data_dir / "llm_config.json"


def load_config() -> LLMConfig:
    """加载 LLM 配置（环境变量优先，配置文件回退）

    优先级：
    1. 环境变量 TDSF_LLM_* （启动时设置，便于开发调试）
    2. 配置文件 .tdsf-data/llm_config.json（前端通过 IPC 写入）
    3. 默认空配置（is_configured=False，Agent 使用 mock LLM）
    """
    # 1. 环境变量
    env_api_key = os.environ.get("TDSF_LLM_API_KEY", "")
    env_base_url = os.environ.get("TDSF_LLM_BASE_URL", "")
    env_model = os.environ.get("TDSF_LLM_MODEL", "")
    env_provider = os.environ.get("TDSF_LLM_PROVIDER", "")

    if env_api_key:
        logger.info(
            f"LLM config loaded from env: provider={env_provider or 'openai'}, "
            f"model={env_model or 'gpt-4o-mini'}, base_url={'set' if env_base_url else 'default'}"
        )
        return LLMConfig(
            provider=env_provider or "openai",
            api_key=env_api_key,
            base_url=env_base_url,
            model=env_model or "gpt-4o-mini",
        )

    # 2. 配置文件
    config_path = _get_config_path()
    if config_path.exists():
        try:
            data = json.loads(config_path.read_text(encoding="utf-8"))
            if data.get("api_key"):
                logger.info(
                    f"LLM config loaded from file: provider={data.get('provider', 'openai')}, "
                    f"model={data.get('model', 'gpt-4o-mini')}"
                )
                return LLMConfig(
                    provider=data.get("provider", "openai"),
                    api_key=data["api_key"],
                    base_url=data.get("base_url", ""),
                    model=data.get("model", "gpt-4o-mini"),
                    temperature=data.get("temperature", 0.7),
                    max_tokens=data.get("max_tokens", 8192),
                )
        except (json.JSONDecodeError, KeyError, OSError) as e:
            logger.warning(f"Failed to load LLM config from {config_path}: {e}")

    # 3. 默认空配置
    return LLMConfig()


def save_config(config: LLMConfig) -> None:
    """保存 LLM 配置到文件（前端通过 IPC 调用）

    Args:
        config: LLM 配置
    """
    config_path = _get_config_path()
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(
        json.dumps(config.to_dict(), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    logger.info(f"LLM config saved to {config_path}")


# ============================================================================
# LLM 调用实现
# ============================================================================

# Provider → 默认 baseURL 映射（2026-08 国产 provider 官方 OpenAI 兼容端点）
# ----------------------------------------------------------------------------
# 为什么需要：base_url 理论上由前端预填写入配置，但环境变量 / 手写
# llm_config.json 两条路径可能只带 provider 不带 base_url；若不回退，
# ChatOpenAI 会默认打到 api.openai.com，国产 key 必然 401。
# 仅收录官方提供 OpenAI 兼容端点的国产三家；deepseek / ollama 等既有
# provider 由前端预填 base_url，留空时保持既有行为（OpenAI 默认端点），
# 未知 provider 同样不回退（默认 OpenAI 兼容语义不变）。
PROVIDER_DEFAULT_BASE_URLS: dict[str, str] = {
    # 智谱 GLM 开放平台（open.bigmodel.cn 的 OpenAI 兼容端点）
    "zhipu": "https://open.bigmodel.cn/api/paas/v4",
    # 阿里云百炼 DashScope（compatible-mode 即 OpenAI 兼容模式）
    "dashscope": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    # 月之暗面 Kimi（Moonshot 开放平台 OpenAI 兼容端点）
    "moonshot": "https://api.moonshot.cn/v1",
}


def _resolve_base_url(config: LLMConfig) -> str:
    """解析最终 base_url：显式配置优先，已知国产 provider 回退官方端点

    Args:
        config: LLM 配置

    Returns:
        base_url（可能为空串 = 走 ChatOpenAI 默认 OpenAI 官方端点）
    """
    explicit = (config.base_url or "").strip()
    if explicit:
        return explicit
    # provider 归一小写后再查映射（前端 id 均为小写，此处防御大写输入）
    return PROVIDER_DEFAULT_BASE_URLS.get(config.provider.lower(), "")


def _make_openai_call(config: LLMConfig) -> LLMCallFunction:
    """创建 OpenAI 兼容的 LLM 调用函数

    使用 langchain-openai 的 ChatOpenAI，通过 base_url 支持任意兼容端点：
    - OpenAI 官方: https://api.openai.com/v1
    - DeepSeek: https://api.deepseek.com/v1
    - 智谱(zhipu): https://open.bigmodel.cn/api/paas/v4
    - 阿里百炼(dashscope): https://dashscope.aliyuncs.com/compatible-mode/v1
    - Kimi(moonshot): https://api.moonshot.cn/v1
    - OneAPI / NewAPI 代理: 用户自定义
    - 本地 Ollama: http://localhost:11434/v1

    base_url 为空时：已知国产 provider（见 PROVIDER_DEFAULT_BASE_URLS）
    回退到官方 OpenAI 兼容端点；其余 provider 维持 OpenAI 默认端点不变。
    """
    try:
        from langchain_openai import ChatOpenAI
    except ImportError as e:
        raise RuntimeError(
            f"langchain-openai 未安装，无法创建 LLM 调用: {e}。"
            f"请运行: pip install langchain-openai"
        ) from e

    # 构造 ChatOpenAI 参数（base_url 解析含国产 provider 官方端点回退）
    kwargs: dict[str, Any] = {
        "model": config.model,
        "api_key": config.api_key,
        "temperature": config.temperature,
        "max_tokens": config.max_tokens,
    }
    resolved_base_url = _resolve_base_url(config)
    if resolved_base_url:
        kwargs["base_url"] = resolved_base_url

    llm = ChatOpenAI(**kwargs)

    def llm_call(messages: list[dict[str, Any]]) -> str:
        """调用 LLM（OpenAI 兼容）

        Args:
            messages: OpenAI Chat Completions 格式的消息列表
                [{"role": "system", "content": "..."},
                 {"role": "user", "content": "..."}]

        Returns:
            LLM 回复文本

        Raises:
            Exception: LLM 调用失败时抛出（由 BaseAgent.call_llm 捕获降级）
        """
        from langchain_core.messages import (
            AIMessage,
            HumanMessage,
            SystemMessage,
        )

        # 转换消息格式
        lc_messages = []
        for msg in messages:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            if role == "system":
                lc_messages.append(SystemMessage(content=content))
            elif role == "assistant":
                lc_messages.append(AIMessage(content=content))
            else:
                lc_messages.append(HumanMessage(content=content))

        # 调用 LLM
        response = llm.invoke(lc_messages)
        return response.content if hasattr(response, "content") else str(response)

    return llm_call


def _make_anthropic_call(config: LLMConfig) -> LLMCallFunction:
    """创建 Anthropic 原生 LLM 调用函数"""
    try:
        from langchain_anthropic import ChatAnthropic
    except ImportError as e:
        raise RuntimeError(
            f"langchain-anthropic 未安装: {e}。"
            f"请运行: pip install langchain-anthropic"
        ) from e

    kwargs: dict[str, Any] = {
        "model": config.model,
        "api_key": config.api_key,
        "temperature": config.temperature,
        "max_tokens": config.max_tokens,
    }

    llm = ChatAnthropic(**kwargs)

    def llm_call(messages: list[dict[str, Any]]) -> str:
        from langchain_core.messages import (
            AIMessage,
            HumanMessage,
            SystemMessage,
        )

        lc_messages = []
        for msg in messages:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            if role == "system":
                lc_messages.append(SystemMessage(content=content))
            elif role == "assistant":
                lc_messages.append(AIMessage(content=content))
            else:
                lc_messages.append(HumanMessage(content=content))

        response = llm.invoke(lc_messages)
        return response.content if hasattr(response, "content") else str(response)

    return llm_call


def make_llm_call(config: LLMConfig | None = None) -> LLMCallFunction | None:
    """创建 LLM 调用函数（工厂方法）

    Args:
        config: LLM 配置（None 时自动加载）

    Returns:
        llm_call 函数；配置无效时返回 None（Agent 降级到 mock）
    """
    if config is None:
        config = load_config()

    if not config.is_configured:
        logger.warning(
            "LLM not configured (no API Key), agents will use mock LLM. "
            "Set TDSF_LLM_API_KEY env or write .tdsf-data/llm_config.json"
        )
        return None

    try:
        if config.provider == "anthropic":
            return _make_anthropic_call(config)
        # 默认使用 OpenAI 兼容（覆盖 openai / zhipu / dashscope / moonshot /
        # deepseek / ollama / oneapi 等；国产三家 base_url 为空时回退官方端点）
        return _make_openai_call(config)
    except Exception as e:
        logger.error(f"Failed to create LLM call: {e}")
        return None


# ============================================================================
# 运行时重新配置（供 agent.configure JSON-RPC 调用）
# ============================================================================

def reconfigure(config: LLMConfig) -> LLMCallFunction | None:
    """运行时重新配置 LLM（前端通过 agent.configure 调用）

    Args:
        config: 新的 LLM 配置

    Returns:
        新的 llm_call 函数；失败返回 None
    """
    # 保存配置到文件（持久化）
    save_config(config)
    # 创建新的 llm_call
    return make_llm_call(config)
