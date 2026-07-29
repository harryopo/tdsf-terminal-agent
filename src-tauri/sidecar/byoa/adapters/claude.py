"""
byoa/adapters/claude.py — Claude CLI 适配器（T-P4-02）
========================================================

适配 Anthropic Claude CLI（claude-code）。

CLI 命令：claude
"""

from __future__ import annotations

import logging
import shutil
import subprocess
from typing import Any

from byoa.adapters.base import BaseAdapter

logger = logging.getLogger("sidecar.byoa.claude")


class ClaudeAdapter(BaseAdapter):
    """Claude CLI 适配器"""

    @property
    def name(self) -> str:
        return "claude"

    @property
    def cli_command(self) -> str:
        return "claude"

    def _run_mock(self, prompt: str) -> str:
        """mock 模式：返回模拟响应（不调用真实 CLI）"""
        return (
            f"[mock-claude] Processed prompt ({len(prompt)} chars):\n"
            f"{prompt[:200]}{'...' if len(prompt) > 200 else ''}\n"
            f"→ Suggested action: review and apply changes."
        )

    def _run_real(self, prompt: str) -> str:
        """真实 CLI 调用：claude --prompt <prompt>"""
        if not shutil.which(self.cli_command):
            raise FileNotFoundError(
                f"CLI '{self.cli_command}' not found in PATH. "
                f"Install claude-code or use mock mode."
            )
        # 调用 claude CLI（claude-code 风格）
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
                f"claude CLI failed (exit={result.returncode}): "
                f"{result.stderr.strip()}"
            )
        return result.stdout.strip()
