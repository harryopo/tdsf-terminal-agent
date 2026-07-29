"""
byoa/adapters/aider.py — Aider CLI 适配器（T-P4-02）
======================================================

适配 Aider（AI pair programming CLI）。
"""

from __future__ import annotations

import logging
import shutil
import subprocess

from byoa.adapters.base import BaseAdapter

logger = logging.getLogger("sidecar.byoa.aider")


class AiderAdapter(BaseAdapter):
    """Aider CLI 适配器"""

    @property
    def name(self) -> str:
        return "aider"

    @property
    def cli_command(self) -> str:
        return "aider"

    def _run_mock(self, prompt: str) -> str:
        return (
            f"[mock-aider] Pair-programmed prompt ({len(prompt)} chars):\n"
            f"{prompt[:200]}{'...' if len(prompt) > 200 else ''}\n"
            f"→ Edit proposal: see diff in chat."
        )

    def _run_real(self, prompt: str) -> str:
        if not shutil.which(self.cli_command):
            raise FileNotFoundError(
                f"CLI '{self.cli_command}' not found in PATH. "
                f"Install aider-chat or use mock mode."
            )
        # aider 调用：aider --message <prompt> --no-auto-commits
        result = subprocess.run(
            [self.cli_command, "--message", prompt, "--no-auto-commits"],
            capture_output=True,
            text=True,
            cwd=self.cwd,
            timeout=self.timeout,
            check=False,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"aider CLI failed (exit={result.returncode}): "
                f"{result.stderr.strip()}"
            )
        return result.stdout.strip()
