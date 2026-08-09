"""
long_context.py — LongContextManager 1M Token 上下文管理（T-P5-02）
====================================================================

职责：
- 管理超长上下文（最高 1M tokens）
- chunk(text, max_tokens): 按段落/句子边界分块，每块不超过 max_tokens
- merge(chunks): 合并多个 chunk 为单文本
- summarize(text, max_tokens): 用 hash 摘要模拟（无真实 LLM 依赖，可离线运行）

设计要点：
- 全局开关：feature_flags.long_context.enabled
  - 关闭时 chunk 直接返回 [text]，summarize 返回前 N 字符
  - 启用时执行真实分块/摘要逻辑
- token 估算用 1 token ≈ 4 chars（英文）/ 1.5 chars（中文）的近似公式
- 分块策略：优先在段落边界（\\n\\n）切，其次在句子边界（。/./!/?）切

JSON-RPC 方法（main.py 注册）：
- long_context.chunk: 分块
- long_context.merge: 合并
- long_context.summarize: 摘要
- long_context.status: 查询开关状态
"""

from __future__ import annotations

import hashlib
import logging
import re
from pathlib import Path
from typing import Any

import yaml

logger = logging.getLogger("sidecar.long_context")


# ============================================================
# 常量
# ============================================================

# 默认配置文件路径
_DEFAULT_CONFIG_PATH: Path = Path(__file__).parent / "config" / "feature_flags.yaml"

# token 估算系数（1 token ≈ N chars）
# 英文：~4 chars/token；中文：~1.5 chars/token；混合取 2.5
_CHARS_PER_TOKEN: float = 2.5

# 默认每块最大 token 数
_DEFAULT_MAX_TOKENS_PER_CHUNK: int = 100_000

# 默认摘要最大 token 数
_DEFAULT_SUMMARY_MAX_TOKENS: int = 4000

# 段落分隔符（\\n\\n）
_PARAGRAPH_SEP: re.Pattern[str] = re.compile(r"\n\s*\n")

# 句子终止符（中英文）
_SENTENCE_END: re.Pattern[str] = re.compile(r"(?<=[。.!?！？])\s*")


# ============================================================
# LongContextManager 主类
# ============================================================


class LongContextManager:
    """长上下文管理器（1M Token 兼容）。

    支持分块 / 合并 / 摘要，全局 feature flag 开关。

    用法：
        # 关闭状态（默认）
        mgr = LongContextManager()
        mgr.chunk("long text")  # → ["long text"]（不分块）

        # 启用状态
        mgr = LongContextManager(enabled=True)
        chunks = mgr.chunk(long_text, max_tokens=10000)
        summary = mgr.summarize(long_text, max_tokens=4000)

    Args:
        enabled: 是否启用长上下文管理（feature flag）
        max_tokens_per_chunk: 单块最大 token 数（默认 100K）
        summary_max_tokens: 摘要最大 token 数（默认 4K）
    """

    def __init__(
        self,
        enabled: bool = False,
        max_tokens_per_chunk: int = _DEFAULT_MAX_TOKENS_PER_CHUNK,
        summary_max_tokens: int = _DEFAULT_SUMMARY_MAX_TOKENS,
    ) -> None:
        """初始化 LongContextManager。

        Args:
            enabled: 是否启用（False 时所有方法走简化路径）
            max_tokens_per_chunk: 单块最大 token 数
            summary_max_tokens: 摘要最大 token 数
        """
        self.enabled: bool = enabled
        self.max_tokens_per_chunk: int = max_tokens_per_chunk
        self.summary_max_tokens: int = summary_max_tokens
        logger.info(
            f"LongContextManager initialized: enabled={enabled}, "
            f"max_tokens_per_chunk={max_tokens_per_chunk}, "
            f"summary_max_tokens={summary_max_tokens}"
        )

    # ----------------------------------------------------------
    # token 估算
    # ----------------------------------------------------------

    @staticmethod
    def estimate_tokens(text: str) -> int:
        """估算文本的 token 数（近似公式，无 tiktoken 依赖）。

        公式：tokens ≈ chars / _CHARS_PER_TOKEN

        Args:
            text: 待估算的文本

        Returns:
            估算的 token 数（>=0）
        """
        if not text:
            return 0
        return max(1, int(len(text) / _CHARS_PER_TOKEN))

    # ----------------------------------------------------------
    # chunk — 分块
    # ----------------------------------------------------------

    def chunk(self, text: str, max_tokens: int = 0) -> list[str]:
        """将长文本分块，每块不超过 max_tokens。

        策略：
        1. disabled 或文本很短 → 返回 [text]
        2. enabled → 按段落边界切分
           - 段落 token 数 <= max_tokens → 直接加入
           - 段落 token 数 > max_tokens → 按句子边界二次切分
           - 句子仍超长 → 强制按字符切分（避免单句过长卡死）

        Args:
            text: 待分块的文本
            max_tokens: 每块最大 token 数。0 时使用 self.max_tokens_per_chunk

        Returns:
            分块列表（至少 1 块，可能为 [""] 当 text 为空时）
        """
        if not text:
            return [""]

        effective_max: int = max_tokens if max_tokens > 0 else self.max_tokens_per_chunk

        # 关闭状态或文本本身就不超长 → 不分块
        if not self.enabled or self.estimate_tokens(text) <= effective_max:
            return [text]

        # 启用状态 → 按段落切分
        chunks: list[str] = []
        current_chunk: list[str] = []
        current_tokens: int = 0

        paragraphs: list[str] = _PARAGRAPH_SEP.split(text)
        for para in paragraphs:
            para_tokens: int = self.estimate_tokens(para)

            # 当前块加入此段落会超限 → 先保存当前块
            if current_tokens + para_tokens > effective_max and current_chunk:
                chunks.append("\n\n".join(current_chunk))
                current_chunk = []
                current_tokens = 0

            # 单段落本身就超限 → 二次切分（按句子）
            if para_tokens > effective_max:
                # 先把已积累的 current_chunk 保存
                if current_chunk:
                    chunks.append("\n\n".join(current_chunk))
                    current_chunk = []
                    current_tokens = 0
                # 按句子切分该段落
                sub_chunks: list[str] = self._split_long_paragraph(para, effective_max)
                chunks.extend(sub_chunks)
            else:
                current_chunk.append(para)
                current_tokens += para_tokens

        # 保存最后一块
        if current_chunk:
            chunks.append("\n\n".join(current_chunk))

        return chunks if chunks else [text]

    def _split_long_paragraph(self, paragraph: str, max_tokens: int) -> list[str]:
        """对超长段落按句子边界二次切分。

        Args:
            paragraph: 待切分的段落（单个，但 token 数已超 max_tokens）
            max_tokens: 每块最大 token 数

        Returns:
            切分后的子块列表
        """
        sentences: list[str] = _SENTENCE_END.split(paragraph)
        chunks: list[str] = []
        current: list[str] = []
        current_tokens: int = 0

        for sent in sentences:
            if not sent:
                continue
            sent_tokens: int = self.estimate_tokens(sent)

            if current_tokens + sent_tokens > max_tokens and current:
                chunks.append("".join(current))
                current = []
                current_tokens = 0

            # 单句仍超长 → 强制按字符切分
            if sent_tokens > max_tokens:
                if current:
                    chunks.append("".join(current))
                    current = []
                    current_tokens = 0
                # 按字符切分
                char_per_chunk: int = int(max_tokens * _CHARS_PER_TOKEN)
                for i in range(0, len(sent), char_per_chunk):
                    chunks.append(sent[i : i + char_per_chunk])
            else:
                current.append(sent)
                current_tokens += sent_tokens

        if current:
            chunks.append("".join(current))

        return chunks if chunks else [paragraph]

    # ----------------------------------------------------------
    # merge — 合并
    # ----------------------------------------------------------

    @staticmethod
    def merge(chunks: list[str]) -> str:
        """合并多个 chunk 为单文本（用 \\n\\n 连接）。

        Args:
            chunks: chunk 列表

        Returns:
            合并后的文本
        """
        if not chunks:
            return ""
        return "\n\n".join(chunks)

    # ----------------------------------------------------------
    # summarize — 摘要（TDSF 魔改 2026-08-09: 真 LLM 调用 + hash 回退）
    # ----------------------------------------------------------

    def summarize(self, text: str, max_tokens: int = 0) -> str:
        """生成文本摘要（优先用 LLM，回退到 hash 截断）。

        TDSF 魔改 (2026-08-09): 从 hash 模拟重写为真 LLM 摘要。
        当 LLM 配置可用时调用模型生成摘要；不可用时回退到截断+hash。

        Args:
            text: 待摘要的文本
            max_tokens: 摘要最大 token 数。0 时使用 self.summary_max_tokens

        Returns:
            摘要文本
        """
        if not text:
            return ""

        effective_max: int = max_tokens if max_tokens > 0 else self.summary_max_tokens
        max_chars: int = int(effective_max * _CHARS_PER_TOKEN)

        # 关闭状态 → 简化路径（截断）
        if not self.enabled:
            return text[:max_chars]

        # 文本未超长 → 直接返回原文
        if len(text) <= max_chars:
            return text

        # TDSF 魔改: 尝试 LLM 摘要
        summary = self._llm_summarize(text, effective_max)
        if summary:
            return summary

        # 回退: hash 截断（离线可用）
        text_hash: str = hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]
        truncated: str = text[:max_chars]
        return f"[summary] {truncated}... [hash={text_hash}]"

    def _llm_summarize(self, text: str, max_tokens: int) -> str | None:
        """用已配置的 LLM 生成摘要（失败返回 None）。

        TDSF 魔改 (2026-08-09): 从 sidecar 的 LLMConfig 取模型，
        发一个简单摘要请求。失败时静默返回 None 让上层回退到 hash。
        """
        try:
            from core.llm_config import load_config

            config = load_config()
            if not config.is_configured:
                return None

            # 限制输入大小（取首尾各 40% 中间省略）
            input_max = int(max_tokens * _CHARS_PER_TOKEN * 4)  # 4x 摘要目标
            if len(text) > input_max:
                head = text[:int(input_max * 0.4)]
                tail = text[-int(input_max * 0.4):]
                truncated = f"{head}\n\n…[中间内容省略 {len(text) - input_max} 字符]…\n\n{tail}"
            else:
                truncated = text

            prompt = (
                f"请将以下内容压缩为 {max_tokens} tokens 以内的摘要，"
                f"保留关键信息、命令和结论，去除冗余细节：\n\n{truncated}"
            )

            # 用 httpx 直调 OpenAI 兼容接口（不依赖 openai SDK）
            import json as _json
            import urllib.request

            url = f"{config.base_url or 'https://api.openai.com/v1'}/chat/completions"
            payload = _json.dumps({
                "model": config.model,
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": max_tokens,
                "temperature": 0.3,
            }).encode("utf-8")

            req = urllib.request.Request(
                url,
                data=payload,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {config.api_key}",
                },
                method="POST",
            )

            with urllib.request.urlopen(req, timeout=30) as resp:
                result = _json.loads(resp.read().decode("utf-8"))
                content = result.get("choices", [{}])[0].get("message", {}).get("content", "")
                if content:
                    return f"[LLM 摘要] {content.strip()}"

            return None
        except Exception as e:
            logger.debug(f"LLM summarize failed, falling back to hash: {e}")
            return None

    # ----------------------------------------------------------
    # 元数据
    # ----------------------------------------------------------

    def status(self) -> dict[str, Any]:
        """返回当前状态（供 JSON-RPC long_context.status）"""
        return {
            "enabled": self.enabled,
            "max_tokens_per_chunk": self.max_tokens_per_chunk,
            "summary_max_tokens": self.summary_max_tokens,
        }


# ============================================================
# FeatureFlags 加载器
# ============================================================


class FeatureFlags:
    """Feature Flags 加载器（从 config/feature_flags.yaml）。

    用法：
        flags = FeatureFlags()
        if flags.long_context_enabled:
            mgr = LongContextManager(enabled=True)
    """

    def __init__(self, config_path: Path | str | None = None) -> None:
        """初始化 FeatureFlags。

        Args:
            config_path: YAML 配置路径。None 时使用默认 _DEFAULT_CONFIG_PATH
        """
        path: Path = Path(config_path) if config_path else _DEFAULT_CONFIG_PATH
        self._config_path: Path = path
        self._flags: dict[str, dict[str, Any]] = {}

        if path.exists():
            with open(path, encoding="utf-8") as f:
                self._flags = yaml.safe_load(f) or {}
        else:
            logger.warning(f"feature flags config not found: {path}, using defaults")

    @property
    def long_context_enabled(self) -> bool:
        """长上下文管理是否启用"""
        return bool(self._flags.get("long_context", {}).get("enabled", False))

    @property
    def long_context_max_tokens_per_chunk(self) -> int:
        """单块最大 token 数"""
        return int(self._flags.get("long_context", {}).get("max_tokens_per_chunk", _DEFAULT_MAX_TOKENS_PER_CHUNK))

    @property
    def long_context_summary_max_tokens(self) -> int:
        """摘要最大 token 数"""
        return int(self._flags.get("long_context", {}).get("summary_max_tokens", _DEFAULT_SUMMARY_MAX_TOKENS))

    @property
    def squilla_router_enabled(self) -> bool:
        """SquillaRouter 是否启用"""
        return bool(self._flags.get("squilla_router", {}).get("enabled", True))

    @property
    def langfuse_enabled(self) -> bool:
        """Langfuse 是否启用"""
        return bool(self._flags.get("langfuse", {}).get("enabled", False))

    @property
    def langfuse_offline(self) -> bool:
        """Langfuse 是否离线模式"""
        return bool(self._flags.get("langfuse", {}).get("offline", True))

    @property
    def kepa_enabled(self) -> bool:
        """KEPA 是否启用"""
        return bool(self._flags.get("kepa", {}).get("enabled", False))

    @property
    def kepa_learning_rate(self) -> float:
        """KEPA 学习率"""
        return float(self._flags.get("kepa", {}).get("learning_rate", 0.01))

    @property
    def skill_auto_generate_enabled(self) -> bool:
        """Skill 自动生成是否启用"""
        return bool(self._flags.get("skill_auto_generate", {}).get("enabled", False))

    @property
    def skill_auto_generate_min_frequency(self) -> int:
        """Skill 自动生成最小模式频次"""
        return int(self._flags.get("skill_auto_generate", {}).get("min_pattern_frequency", 3))

    def to_dict(self) -> dict[str, Any]:
        """返回所有 flag 的字典形式"""
        return {
            "long_context": {
                "enabled": self.long_context_enabled,
                "max_tokens_per_chunk": self.long_context_max_tokens_per_chunk,
                "summary_max_tokens": self.long_context_summary_max_tokens,
            },
            "squilla_router": {"enabled": self.squilla_router_enabled},
            "langfuse": {"enabled": self.langfuse_enabled, "offline": self.langfuse_offline},
            "kepa": {"enabled": self.kepa_enabled, "learning_rate": self.kepa_learning_rate},
            "skill_auto_generate": {
                "enabled": self.skill_auto_generate_enabled,
                "min_pattern_frequency": self.skill_auto_generate_min_frequency,
            },
        }


# ============================================================
# 模块级单例（懒加载）
# ============================================================

_manager_instance: LongContextManager | None = None
_flags_instance: FeatureFlags | None = None


def get_manager() -> LongContextManager:
    """获取全局 LongContextManager 单例（基于 feature flags 配置）。

    Returns:
        LongContextManager 实例（已根据 feature_flags 配置 enabled）
    """
    global _manager_instance
    if _manager_instance is None:
        flags: FeatureFlags = get_feature_flags()
        _manager_instance = LongContextManager(
            enabled=flags.long_context_enabled,
            max_tokens_per_chunk=flags.long_context_max_tokens_per_chunk,
            summary_max_tokens=flags.long_context_summary_max_tokens,
        )
    return _manager_instance


def get_feature_flags() -> FeatureFlags:
    """获取全局 FeatureFlags 单例（懒加载）。

    Returns:
        FeatureFlags 实例
    """
    global _flags_instance
    if _flags_instance is None:
        _flags_instance = FeatureFlags()
    return _flags_instance


def reset_manager() -> None:
    """重置全局单例（仅供测试使用）"""
    global _manager_instance, _flags_instance
    _manager_instance = None
    _flags_instance = None


# ============================================================
# JSON-RPC 方法注册
# ============================================================


def register_methods(dispatcher: Any) -> None:
    """向 JSON-RPC dispatcher 注册 long_context.* 方法

    注册的方法：
    - long_context.chunk:     分块
    - long_context.merge:     合并
    - long_context.summarize: 摘要
    - long_context.status:    查询开关状态
    """
    def _long_context_chunk(text: str, max_tokens: int = 0) -> dict[str, Any]:
        """JSON-RPC: long_context.chunk"""
        mgr: LongContextManager = get_manager()
        chunks: list[str] = mgr.chunk(text, max_tokens=max_tokens)
        return {
            "chunks": chunks,
            "total": len(chunks),
            "enabled": mgr.enabled,
        }

    def _long_context_merge(chunks: list[str]) -> dict[str, Any]:
        """JSON-RPC: long_context.merge"""
        merged: str = LongContextManager.merge(chunks)
        return {"merged": merged, "length": len(merged)}

    def _long_context_summarize(text: str, max_tokens: int = 0) -> dict[str, Any]:
        """JSON-RPC: long_context.summarize"""
        mgr = get_manager()
        summary: str = mgr.summarize(text, max_tokens=max_tokens)
        return {"summary": summary, "length": len(summary)}

    def _long_context_status() -> dict[str, Any]:
        """JSON-RPC: long_context.status"""
        mgr = get_manager()
        return mgr.status()

    dispatcher.register("long_context.chunk", _long_context_chunk)
    dispatcher.register("long_context.merge", _long_context_merge)
    dispatcher.register("long_context.summarize", _long_context_summarize)
    dispatcher.register("long_context.status", _long_context_status)
    logger.info("long_context.* methods registered (4 methods)")
