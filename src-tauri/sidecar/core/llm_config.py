"""
core/llm_config.py — LLM 配置与调用封装（TDSF P0-3）
================================================================

职责：
- 从环境变量 / 配置文件读取 LLM provider 配置（API Key / BaseURL / Model）
- 提供 ``make_llm_call()`` 函数，返回供知识库离线脚本使用的 callable
- 支持 OpenAI 兼容接口（方便国内用户使用各种代理 / OneAPI / DeepSeek 等）
- 支持 Anthropic 原生接口
- 不可用时返回 None，由调用方显式处理

设计要点：
1. **环境变量优先**：TDSF_LLM_API_KEY / TDSF_LLM_BASE_URL / TDSF_LLM_MODEL
2. **配置文件回退**：.tdsf-data/llm_config.json（前端通过 IPC 写入）
3. **OpenAI 兼容**：默认使用 官方 openai SDK 的同步客户端，
   通过 base_url 指向任意 OpenAI 兼容端点（DeepSeek / OneAPI / 代理等）
4. **错误隔离**：LLM 调用失败时抛异常，由调用脚本决定重试或终止

llm_call 签名：
    Input:  messages: list[dict[str, Any]]  # OpenAI Chat Completions 格式
    Output: str                              # LLM 回复文本

集成点：
- 知识库蒸馏、翻译与标题生成脚本调用 ``make_llm_call()``
- ``agent_facade.configure`` 复用 ``LLMConfig``，并通过 Strands provider 热更新模型
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any, Protocol

logger = logging.getLogger("sidecar.core.llm_config")

_CLIENT_TIMEOUT_SECONDS = 300.0
# 只作用于 make_llm_call() 这条**离线单次调用**链（知识库蒸馏/翻译/标题生成）：
# 那里没有 agent 循环、也没有第二层退避，HTTP 重试是唯一主人，所以保留 2。
# Agent 链路走 strands_backend/model_adapter（P3, 2026-09-19 起 max_retries=0，
# 退避统一由 strands_backend/retry_policy.py 负责）——两边不是同一套预算，勿互相同步。
_CLIENT_MAX_RETRIES = 2


# ============================================================================
# 类型定义
# ============================================================================

class LLMCallFunction(Protocol):
    """知识库离线脚本使用的 LLM 调用函数签名。"""
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
    3. 默认空配置（is_configured=False，由调用方显式处理）
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
# OpenAI SDK 会默认打到 api.openai.com，国产 key 必然 401。
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
        base_url（可能为空串 = 走 OpenAI SDK 默认 OpenAI 官方端点）
    """
    explicit = (config.base_url or "").strip()
    if explicit:
        return explicit
    # provider 归一小写后再查映射（前端 id 均为小写，此处防御大写输入）
    return PROVIDER_DEFAULT_BASE_URLS.get(config.provider.lower(), "")


def _make_openai_call(config: LLMConfig) -> LLMCallFunction:
    """创建供离线脚本使用的同步 OpenAI 兼容调用函数。"""
    try:
        from openai import OpenAI
    except ImportError as e:
        raise RuntimeError(
            f"openai SDK 未安装，无法创建 LLM 调用: {e}。"
            "请安装 openai>=1.68,<3"
        ) from e

    client_kwargs: dict[str, Any] = {
        "api_key": config.api_key,
        "timeout": _CLIENT_TIMEOUT_SECONDS,
        "max_retries": _CLIENT_MAX_RETRIES,
    }
    resolved_base_url = _resolve_base_url(config)
    if resolved_base_url:
        client_kwargs["base_url"] = resolved_base_url

    client = OpenAI(**client_kwargs)

    def llm_call(messages: list[dict[str, Any]]) -> str:
        """调用 OpenAI Chat Completions 兼容端点。"""
        normalized_messages = [
            {
                "role": role if (role := str(msg.get("role", "user"))) in {
                    "system",
                    "assistant",
                } else "user",
                "content": str(msg.get("content", "") or ""),
            }
            for msg in messages
        ]
        request_kwargs: dict[str, Any] = {
            "model": config.model,
            "messages": normalized_messages,
            "temperature": config.temperature,
        }
        if config.max_tokens > 0:
            request_kwargs["max_tokens"] = config.max_tokens

        response = client.chat.completions.create(**request_kwargs)
        if not response.choices:
            return ""
        content = response.choices[0].message.content
        if isinstance(content, str):
            return content
        if not content:
            return ""
        return "".join(
            str(text)
            for part in content
            if (
                text := (
                    part.get("text")
                    if isinstance(part, dict)
                    else getattr(part, "text", None)
                )
            )
            is not None
        )

    return llm_call


def _make_anthropic_call(config: LLMConfig) -> LLMCallFunction:
    """创建供离线脚本使用的同步 Anthropic 调用函数。"""
    try:
        from anthropic import Anthropic
    except ImportError as e:
        raise RuntimeError(
            f"anthropic SDK 未安装，无法创建 LLM 调用: {e}。"
            "请安装 anthropic>=0.21,<1"
        ) from e

    client = Anthropic(
        api_key=config.api_key,
        timeout=_CLIENT_TIMEOUT_SECONDS,
        max_retries=_CLIENT_MAX_RETRIES,
    )

    def llm_call(messages: list[dict[str, Any]]) -> str:
        system_parts: list[str] = []
        normalized_messages: list[dict[str, str]] = []
        for msg in messages:
            role = str(msg.get("role", "user"))
            content = str(msg.get("content", "") or "")
            if role == "system":
                system_parts.append(content)
            else:
                normalized_messages.append(
                    {
                        "role": "assistant" if role == "assistant" else "user",
                        "content": content,
                    }
                )

        request_kwargs: dict[str, Any] = {
            "model": config.model,
            "messages": normalized_messages,
            "temperature": config.temperature,
            "max_tokens": config.max_tokens if config.max_tokens > 0 else 8192,
        }
        if system_parts:
            request_kwargs["system"] = "\n\n".join(system_parts)

        response = client.messages.create(**request_kwargs)
        return "".join(
            str(text)
            for block in response.content
            if getattr(block, "type", None) == "text"
            and (text := getattr(block, "text", None)) is not None
        )

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
            "LLM not configured (no API Key); model calls are unavailable. "
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
