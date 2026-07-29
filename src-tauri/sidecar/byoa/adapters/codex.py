"""
byoa/adapters/codex.py — Codex CLI 适配器（T-P4-02）
======================================================

适配 OpenAI Codex CLI。
"""

from __future__ import annotations

import logging
import shutil
import subprocess

from byoa.adapters.base import BaseAdapter

logger = logging.getLogger("sidecar.byoa.codex")


class CodexAdapter(BaseAdapter):
    """Codex CLI 适配器"""

    @property
    def name(self) -> str:
        return "codex"

    @property
    def cli_command(self) -> str:
        return "codex"

    def _run_mock(self, prompt: str) -> str:
        return (
            f"[mock-codex] Analyzed prompt ({len(prompt)} chars):\n"
            f"{prompt[:200]}{'...' if len(prompt) > 200 else ''}\n"
            f"→ Recommended approach: implement with tests."
        )

    def _run_real(self, prompt: str) -> str:
        if not shutil.which(self.cli_command):
            raise FileNotFoundError(
                f"CLI '{self.cli_command}' not found in PATH. "
                f"Install OpenAI Codex CLI or use mock mode."
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
                f"codex CLI failed (exit={result.returncode}): "
                f"{result.stderr.strip()}"
            )
        return result.stdout.strip()
