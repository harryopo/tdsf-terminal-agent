"""
byoa/harness.py — BYOA Harness 主入口（T-P4-02）
==================================================

统一适配外部 CLI Agent 的 Harness。

设计：
- 集中管理 5 个 adapter（claude/codex/cursor/aider/continue）
- 通过 list_adapters() 列出所有可用适配器
- 通过 invoke(name, prompt) 调用指定适配器
- mock 模式可离线运行（不依赖真实 CLI 安装）
"""

from __future__ import annotations

import logging
from typing import Any

from byoa.adapters import ADAPTER_REGISTRY, BaseAdapter

logger = logging.getLogger("sidecar.byoa.harness")


class BYOAHarness:
    """BYOA Harness — 统一适配外部 CLI Agent

    Args:
        mock: 是否启用 mock 模式（True 时不调用真实 CLI，离线测试用）
        cwd: 工作目录（可选，传给所有 adapter）
        timeout: 超时时间（秒，默认 30）
    """

    def __init__(
        self,
        mock: bool = True,
        cwd: str | None = None,
        timeout: int = 30,
    ) -> None:
        self.mock = mock
        self.cwd = cwd
        self.timeout = timeout
        # 实例化所有 adapter
        self._adapters: dict[str, BaseAdapter] = {
            name: cls(mock=mock, cwd=cwd, timeout=timeout)
            for name, cls in ADAPTER_REGISTRY.items()
        }
        logger.info(
            f"BYOAHarness initialized: mock={mock}, "
            f"adapters={list(self._adapters.keys())}"
        )

    def list_adapters(self) -> list[str]:
        """列出所有可用适配器名"""
        return list(self._adapters.keys())

    def get_adapter(self, name: str) -> BaseAdapter:
        """获取指定适配器实例

        Args:
            name: 适配器名（claude/codex/cursor/aider/continue）

        Returns:
            BaseAdapter 实例

        Raises:
            KeyError: 未知适配器名
        """
        if name not in self._adapters:
            raise KeyError(
                f"unknown adapter: '{name}', "
                f"available: {self.list_adapters()}"
            )
        return self._adapters[name]

    def invoke(self, name: str, prompt: str) -> dict[str, Any]:
        """调用指定适配器

        Args:
            name: 适配器名
            prompt: 输入提示词

        Returns:
            {
                "adapter": name,
                "output": str,
                "mock": bool,
                "stats": dict,
            }
        """
        adapter = self.get_adapter(name)
        output = adapter.run(prompt)
        return {
            "adapter": name,
            "output": output,
            "mock": self.mock,
            "stats": adapter.get_stats(),
        }

    def invoke_all(self, prompt: str) -> dict[str, Any]:
        """调用所有适配器（用于对比测试 / 离线评估）

        Args:
            prompt: 输入提示词

        Returns:
            {
                "results": {name: invoke_result},
                "mock": bool,
            }
        """
        results: dict[str, Any] = {}
        for name in self._adapters:
            try:
                results[name] = self.invoke(name, prompt)
            except Exception as e:
                logger.exception(f"adapter '{name}' failed: {e}")
                results[name] = {
                    "adapter": name,
                    "error": str(e),
                    "mock": self.mock,
                }
        return {"results": results, "mock": self.mock}

    def get_stats(self) -> dict[str, dict[str, Any]]:
        """获取所有 adapter 的统计"""
        return {
            name: adapter.get_stats()
            for name, adapter in self._adapters.items()
        }

    def reset_stats(self) -> None:
        """重置所有 adapter 的统计"""
        for adapter in self._adapters.values():
            adapter.reset_stats()

    def __repr__(self) -> str:
        return (
            f"<BYOAHarness mock={self.mock} "
            f"adapters={self.list_adapters()}>"
        )
