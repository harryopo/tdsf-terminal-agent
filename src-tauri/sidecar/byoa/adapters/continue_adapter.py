"""
byoa/adapters/continue_adapter.py — Continue CLI 适配器（T-P4-02）
====================================================================

适配 Continue（开源 AI coding assistant CLI）。

注：模块名使用 continue_adapter 避免覆盖 Python 关键字 continue。
"""

from __future__ import annotations

import logging
import shutil
import subprocess

from byoa.adapters.base import BaseAdapter

logger = logging.getLogger("sidecar.byoa.continue")


class ContinueAdapter(BaseAdapter):
    """Continue CLI 适配器"""

    @property
    def name(self) -> str:
        return "continue"

    @property
    def cli_command(self) -> str:
        return "continue"

    def _run_mock(self, prompt: str) -> str:
        return (
            f"[mock-continue] Continued prompt ({len(prompt)} chars):\n"
            f"{prompt[:200]}{'...' if len(prompt) > 200 else ''}\n"
            f"→ Action plan: implement step by step."
        )

    def _run_real(self, prompt: str) -> str:
        if not shutil.which(self.cli_command):
            raise FileNotFoundError(
                f"CLI '{self.cli_command}' not found in PATH. "
                f"Install Continue CLI or use mock mode."
            )
        result = subprocess.run(
            [self.cli_command, "--prompt", prompt],
            capture_output=True,
            text=True,
            cwd=self.cwd,
            timeout=self.timeout,
            check=False,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"continue CLI failed (exit={result.returncode}): "
                f"{result.stderr.strip()}"
            )
        return result.stdout.strip()
