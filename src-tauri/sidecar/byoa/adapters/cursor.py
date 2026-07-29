"""
byoa/adapters/cursor.py — Cursor CLI 适配器（T-P4-02）
========================================================

适配 Cursor IDE 的 CLI Agent。
"""

from __future__ import annotations

import logging
import shutil
import subprocess

from byoa.adapters.base import BaseAdapter

logger = logging.getLogger("sidecar.byoa.cursor")


class CursorAdapter(BaseAdapter):
    """Cursor CLI 适配器"""

    @property
    def name(self) -> str:
        return "cursor"

    @property
    def cli_command(self) -> str:
        return "cursor"

    def _run_mock(self, prompt: str) -> str:
        return (
            f"[mock-cursor] Reviewed prompt ({len(prompt)} chars):\n"
            f"{prompt[:200]}{'...' if len(prompt) > 200 else ''}\n"
            f"→ Suggested edits: apply AI-suggested refactor."
        )

    def _run_real(self, prompt: str) -> str:
        if not shutil.which(self.cli_command):
            raise FileNotFoundError(
                f"CLI '{self.cli_command}' not found in PATH. "
                f"Install Cursor CLI or use mock mode."
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
                f"cursor CLI failed (exit={result.returncode}): "
                f"{result.stderr.strip()}"
            )
        return result.stdout.strip()
