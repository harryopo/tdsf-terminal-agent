"""
byoa/adapters/base.py — BYOA Adapter 抽象基类（T-P4-02）
==========================================================

所有外部 CLI Agent 适配器的基类。

设计：
- 抽象方法 run(prompt) -> str：执行 prompt 并返回输出
- mock 模式可离线运行（不调用真实 CLI）
- 子类通过实现 _run_real() 和 _run_mock() 提供具体逻辑
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from typing import Any

logger = logging.getLogger("sidecar.byoa.base")


class BaseAdapter(ABC):
    """BYOA Adapter 抽象基类

    Args:
        mock: 是否启用 mock 模式（True 时不调用真实 CLI，离线测试用）
        cwd: 工作目录（可选）
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
        # 调用统计
        self._stats = {
            "invocations": 0,
            "mock_calls": 0,
            "real_calls": 0,
            "errors": 0,
        }

    @property
    @abstractmethod
    def name(self) -> str:
        """adapter 名称（如 'claude' / 'codex'）"""
        ...

    @property
    @abstractmethod
    def cli_command(self) -> str:
        """真实 CLI 命令名（如 'claude' / 'codex'）"""
        ...

    @abstractmethod
    def _run_mock(self, prompt: str) -> str:
        """mock 模式实现（不调用真实 CLI）"""
        ...

    @abstractmethod
    def _run_real(self, prompt: str) -> str:
        """真实 CLI 调用实现"""
        ...

    def run(self, prompt: str) -> str:
        """执行 prompt 并返回输出

        Args:
            prompt: 输入提示词

        Returns:
            CLI 输出文本
        """
        self._stats["invocations"] += 1
        logger.info(
            f"adapter '{self.name}' run: mock={self.mock}, "
            f"prompt_len={len(prompt)}"
        )

        try:
            if self.mock:
                self._stats["mock_calls"] += 1
                return self._run_mock(prompt)
            else:
                self._stats["real_calls"] += 1
                return self._run_real(prompt)
        except Exception as e:
            self._stats["errors"] += 1
            logger.exception(f"adapter '{self.name}' failed: {e}")
            # 真实调用失败时回退到 mock
            if not self.mock:
                logger.warning(
                    f"adapter '{self.name}' real call failed, "
                    f"falling back to mock: {e}"
                )
                return self._run_mock(prompt)
            raise

    def get_stats(self) -> dict[str, Any]:
        """获取调用统计"""
        return dict(self._stats)

    def reset_stats(self) -> None:
        """重置统计"""
        for k in self._stats:
            self._stats[k] = 0

    def __repr__(self) -> str:
        return (
            f"<{self.__class__.__name__} "
            f"name={self.name} mock={self.mock}>"
        )
